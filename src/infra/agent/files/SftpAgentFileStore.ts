import { randomBytes } from 'crypto';
import * as fs from 'fs';
import type { FileEntryWithStats, Stats } from 'ssh2';
import { writeFully } from '../../fs/FileHandleWrite';
import type { DesignerAgentConnectionOptions } from '../ProcessDesignerAgentTransport';
import { toAgentPathSegments, type AgentFileEntry, type AgentFileStore, type AgentStreamOptions } from './AgentFileStore';
import {
  AgentTransferCancelledError,
  throwIfTransferCancellationRequested,
  type AgentTransferCancellation,
} from './AgentFileTransfer';
import {
  CHANGED_DURING_READ,
  IO_CHUNK,
  IO_WINDOW,
  bufferChunkSource,
  fileChunkSource,
  readRange,
  runWindowed,
  type ChunkSource,
  type SftpReadCall,
} from './SftpChunkedIo';
import {
  SFTP_FAILURE,
  SFTP_NO_SUCH_FILE,
  SFTP_OP_UNSUPPORTED,
  connectSftp,
  sftpStatusCode,
  type SftpConnection,
  type SftpConnectionDeps,
} from './SftpConnection';

/**
 * Режим записи файла:
 *  - `atomic` — временный файл в том же каталоге + RENAME в цель; без RENAME запись невозможна;
 *  - `direct` — прямая запись в цель (усечение и запись), для серверов без RENAME;
 *  - `auto` — `atomic`, пока сервер не ответит на RENAME `OP_UNSUPPORTED`; после этого — `direct`
 *    до конца жизни хранилища (план §3, риск «SFTP агента не поддерживает rename»).
 */
export type SftpWriteMode = 'auto' | 'atomic' | 'direct';

export interface SftpAgentFileStoreDeps extends SftpConnectionDeps {
  readonly writeMode?: SftpWriteMode;
}

interface ResolvedPath {
  /** Путь от корня, POSIX; у корня — пустая строка. */
  readonly rel: string;
  /** Путь в запросе к серверу: у корня — `.`, пустой путь SFTP-серверы трактуют по-разному. */
  readonly remote: string;
}

/** Одновременных листингов при рекурсивном обходе. */
const LIST_CONCURRENCY = 8;
// Окончание временных имён: не `.xml`, иначе watcher `src/**/*.xml` принял бы недописанный файл
// за изменение выгрузки (тот же принцип, что у AtomicFileWriter).
const TEMP_SUFFIX = '.v8tmp';
const BACKUP_SUFFIX = '.v8bak';

const noop = (): void => undefined;

/**
 * Хранилище в персональном корне пользователя удалённого агента конфигуратора поверх SFTP.
 *
 * Хранилище владеет своим SSH-соединением (одно соединение и одна SFTP-сессия на всю жизнь,
 * закрываются в `dispose`). Запросы не сериализуются: SFTP мультиплексирует их по одному
 * каналу, параллелизм задаёт вызывающий (AgentFileTransfer). Единственное исключение —
 * записи в ОДИН путь: замена цели (переименование в резерв + RENAME) не атомарна, и две
 * одновременные замены одного файла иначе столкнулись бы на занятом имени.
 *
 * SFTP-сервер агента ссылок не создаёт, поэтому граница корня проверяется только по сегментам
 * пути (`toAgentPathSegments`) — до любого запроса к серверу.
 */
export class SftpAgentFileStore implements AgentFileStore {
  readonly kind = 'sftp' as const;

  private direct: boolean;
  private readonly knownDirs = new Set<string>();
  private readonly creatingDirs = new Map<string, Promise<void>>();
  private readonly writeLocks = new Map<string, Promise<void>>();

  constructor(private readonly connection: SftpConnection, private readonly writeMode: SftpWriteMode = 'auto') {
    this.direct = writeMode === 'direct';
  }

  async stat(rel: string): Promise<AgentFileEntry | undefined> {
    const target = this.resolve(rel);
    try {
      const stats = await this.statOrUndefined('stat', target.remote);
      return stats && toEntry(target.rel, stats);
    } catch (error) {
      throw wrapError('получить сведения о', target, error);
    }
  }

  async readFile(rel: string): Promise<Buffer> {
    const target = this.resolve(rel);
    try {
      const handle = await this.open(target.remote, 'r');
      let data: Buffer;
      try {
        data = await this.readAll(handle);
      } catch (error) {
        await this.closeQuietly(handle);
        throw error;
      }
      await this.close(handle);
      return data;
    } catch (error) {
      throw wrapError('прочитать файл', target, error);
    }
  }

  async writeFile(rel: string, data: Uint8Array | string): Promise<void> {
    const target = this.resolve(rel);
    const bytes = typeof data === 'string'
      ? Buffer.from(data, 'utf-8')
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    await this.writeSource(target, bufferChunkSource(bytes), {});
  }

  /**
   * Локальный файл читается порциями по своим смещениям прямо в окно WRITE: в памяти — не больше
   * окна, а не весь архив выгрузки.
   */
  async uploadFromFile(localPath: string, rel: string, options: AgentStreamOptions = {}): Promise<void> {
    const target = this.resolve(rel);
    throwIfTransferCancellationRequested(options.cancellation);
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(localPath, 'r');
    } catch (error) {
      throw new Error(`Не удалось открыть локальный файл "${localPath}" для передачи агенту: ${(error as Error).message}`, { cause: error });
    }
    try {
      const { size } = await handle.stat();
      await this.writeSource(target, fileChunkSource(handle, size), options);
    } finally {
      await handle.close();
    }
  }

  /**
   * Порции READ окном пишутся в новый локальный файл позиционно, каждая из своего буфера: порядок
   * ответов не важен, память — окно порций, а не размер файла.
   */
  async downloadToFile(rel: string, localPath: string, options: AgentStreamOptions = {}): Promise<void> {
    const target = this.resolve(rel);
    throwIfTransferCancellationRequested(options.cancellation);
    let remote: Buffer | undefined;
    let local: fs.promises.FileHandle | undefined;
    let created = false;
    try {
      remote = await this.open(target.remote, 'r');
      const opened = remote;
      const stats = await this.connection.request<Stats>((sftp, done) => sftp.fstat(opened, done));
      if (stats.isDirectory()) {
        // Часть серверов открывает каталог на чтение без ошибки; пустой «файл» вместо отказа хуже.
        throw new Error('по этому пути находится каталог');
      }
      local = await fs.promises.open(localPath, 'wx');
      created = true;
      await this.downloadInto(opened, local, stats.size, options);
      const finished = local;
      local = undefined;
      await finished.close();
      remote = undefined;
      await this.close(opened);
    } catch (error) {
      if (remote) {
        await this.closeQuietly(remote);
      }
      await local?.close().catch(noop);
      if (created) {
        // Неполный файл не должен остаться похожим на скачанный архив.
        await fs.promises.unlink(localPath).catch(noop);
      }
      throw error instanceof AgentTransferCancelledError ? error : wrapError('скачать файл', target, error);
    }
  }

  async remove(rel: string, options?: { readonly recursive?: boolean }): Promise<void> {
    const target = this.resolve(rel);
    if (!target.rel) {
      throw new Error('Удаление корня хранилища агента запрещено.');
    }
    try {
      // lstat: ссылка удаляется сама по себе, её цель не затрагивается.
      const stats = await this.statOrUndefined('lstat', target.remote);
      if (stats === undefined) {
        return;
      }
      if (!stats.isDirectory()) {
        await this.unlink(target.remote);
      } else if (options?.recursive) {
        await this.removeRecursive(target.rel);
      } else {
        // RMDIR агента рекурсивен (факт пилота §5b): без этой проверки непустой каталог
        // исчез бы целиком, хотя контракт требует отказа. Поэтому RMDIR непустому не шлётся.
        if ((await this.readdir(target.remote)).length > 0) {
          throw new Error('каталог не пуст');
        }
        await this.rmdir(target.remote);
      }
    } catch (error) {
      throw wrapError('удалить', target, error);
    } finally {
      this.forgetDirs(target.rel);
    }
  }

  async list(relDir: string, options?: { readonly recursive?: boolean }): Promise<AgentFileEntry[]> {
    const target = this.resolve(relDir);
    const result: AgentFileEntry[] = [];
    try {
      await this.collect(target.rel, options?.recursive === true, result);
    } catch (error) {
      throw wrapError('прочитать каталог', target, error);
    }
    return result.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  async mkdirp(rel: string): Promise<void> {
    const target = this.resolve(rel);
    try {
      await this.ensureDir(target.rel);
    } catch (error) {
      throw wrapError('создать каталог', target, error);
    }
  }

  dispose(): Promise<void> {
    this.connection.dispose();
    return Promise.resolve();
  }

  /** Сегменты пути до любого запроса; затем — состояние соединения (закрыто/потеряно). */
  private resolve(rel: string): ResolvedPath {
    const joined = toAgentPathSegments(rel).join('/');
    this.connection.assertUsable();
    return { rel: joined, remote: joined || '.' };
  }

  // --- запись ---

  private async writeSource(target: ResolvedPath, source: ChunkSource, options: AgentStreamOptions): Promise<void> {
    await this.withWriteLock(target.rel, async () => {
      try {
        const parent = parentOf(target.rel);
        const name = target.rel.slice(target.rel.lastIndexOf('/') + 1);
        await this.ensureDir(parent);
        if (this.direct) {
          await this.writeHandle(target.remote, source, options);
        } else {
          await this.writeViaTemp(target.remote, parent, name, source, options);
        }
      } catch (error) {
        // Каталоги могли исчезнуть помимо хранилища (агент пересоздаёт выгрузку): после любого
        // отказа записи кэш больше не доверенный, следующая запись проверит путь заново.
        this.knownDirs.clear();
        throw error instanceof AgentTransferCancelledError ? error : wrapError('записать файл', target, error);
      }
    });
  }

  /**
   * Временный файл в каталоге цели и RENAME в цель. Цель до RENAME не открывается и заранее не
   * проверяется: RENAME агента перезаписывает существующий файл (факт пилота §5b п.12), и на
   * агенте перезапись — ровно один запрос без окна, когда цели нет.
   */
  private async writeViaTemp(
    remote: string,
    parent: string,
    name: string,
    source: ChunkSource,
    options: AgentStreamOptions
  ): Promise<void> {
    const tag = randomBytes(6).toString('hex');
    const temp = joinRel(parent, `.${name}.${tag}${TEMP_SUFFIX}`);
    try {
      // Отмена посреди записи оставляет цель прежней: недописан только временный файл.
      await this.writeHandle(temp, source, options);
    } catch (error) {
      await this.removeQuietly(temp);
      throw error;
    }
    try {
      await this.commitTemp(temp, remote, joinRel(parent, `.${name}.${tag}${BACKUP_SUFFIX}`));
    } catch (error) {
      await this.removeQuietly(temp);
      if (this.writeMode === 'auto' && sftpStatusCode(error) === SFTP_OP_UNSUPPORTED) {
        this.direct = true;
        await this.writeHandle(remote, source, options);
        return;
      }
      throw error;
    }
  }

  /**
   * Стандартный SFTP v3 на занятой цели отвечает FAILURE — только тогда (и только если цель —
   * существующий файл) включается запасная схема с резервом.
   */
  private async commitTemp(temp: string, remote: string, backup: string): Promise<void> {
    try {
      await this.rename(temp, remote);
      return;
    } catch (error) {
      if (sftpStatusCode(error) !== SFTP_FAILURE) {
        throw error;
      }
      const existing = await this.statOrUndefined('stat', remote);
      if (existing === undefined) {
        throw error;
      }
      if (existing.isDirectory()) {
        throw new Error('по этому пути находится каталог', { cause: error });
      }
    }
    await this.replaceViaBackup(temp, remote, backup);
  }

  /**
   * Прежний файл уходит в резервное имя и удаляется только после успешного RENAME. Удалять цель
   * ДО переименования нельзя: отказ RENAME оставил бы пользователя без прежнего содержимого.
   */
  private async replaceViaBackup(temp: string, remote: string, backup: string): Promise<void> {
    await this.rename(remote, backup);
    try {
      await this.rename(temp, remote);
    } catch (error) {
      try {
        await this.rename(backup, remote);
      } catch (restoreError) {
        // Цели нет, прежнее содержимое — под служебным именем: пользователь должен знать, где оно.
        throw new Error(
          `${(error as Error).message}; вернуть прежний файл не удалось (${(restoreError as Error).message}), ` +
          `его содержимое сохранено в "${backup}"`,
          { cause: restoreError }
        );
      }
      throw error;
    }
    // Новое содержимое уже на месте: неудача уборки резерва не делает запись неуспешной.
    await this.removeQuietly(backup);
  }

  private async writeHandle(remote: string, source: ChunkSource, options: AgentStreamOptions): Promise<void> {
    const handle = await this.open(remote, 'w');
    let written = 0;
    try {
      // Порции пишутся по своим смещениям независимо друг от друга, поэтому их можно держать в
      // полёте окном: порядок прихода ответов на результат не влияет.
      await runWindowed(Math.ceil(source.size / IO_CHUNK), IO_WINDOW, async (index) => {
        const offset = index * IO_CHUNK;
        const length = Math.min(IO_CHUNK, source.size - offset);
        const chunk = await source.read(offset, length);
        await this.connection.request<undefined>((sftp, done) =>
          sftp.write(handle, chunk, 0, length, offset, (error) => done(error, undefined)));
        written += length;
        options.onProgress?.(written, source.size);
      }, options.cancellation);
    } catch (error) {
      await this.closeQuietly(handle);
      throw error;
    }
    await this.close(handle);
  }

  private async withWriteLock(rel: string, write: () => Promise<void>): Promise<void> {
    const previous = this.writeLocks.get(rel) ?? Promise.resolve();
    const run = previous.then(write);
    const tail = run.then(noop, noop);
    this.writeLocks.set(rel, tail);
    try {
      await run;
    } finally {
      if (this.writeLocks.get(rel) === tail) {
        this.writeLocks.delete(rel);
      }
    }
  }

  // --- каталоги ---

  /**
   * Создаёт каталог с предками. Кэш известных каталогов экономит STAT на каждой записи; одна
   * незавершённая проверка на каталог — чтобы параллельные записи в новый каталог не слали
   * MKDIR наперегонки.
   */
  private ensureDir(rel: string): Promise<void> {
    if (rel === '' || this.knownDirs.has(rel)) {
      return Promise.resolve();
    }
    const inflight = this.creatingDirs.get(rel);
    if (inflight) {
      return inflight;
    }
    const created = this.createDir(rel).finally(() => this.creatingDirs.delete(rel));
    this.creatingDirs.set(rel, created);
    return created;
  }

  private async createDir(rel: string): Promise<void> {
    const stats = await this.statOrUndefined('stat', rel);
    if (stats === undefined) {
      await this.ensureDir(parentOf(rel));
      try {
        await this.connection.request<undefined>((sftp, done) => sftp.mkdir(rel, (error) => done(error, undefined)));
      } catch (error) {
        // Каталог мог создать кто-то другой (второе окно, сам агент) между STAT и MKDIR.
        const again = await this.statOrUndefined('stat', rel);
        if (again?.isDirectory() === true) {
          this.markKnownDir(rel);
          return;
        }
        throw new Error(`Не удалось создать каталог "${rel}": ${(error as Error).message}`, { cause: error });
      }
    } else if (!stats.isDirectory()) {
      throw new Error(`"${rel}" — файл, а не каталог`);
    }
    this.markKnownDir(rel);
  }

  /** Существующий каталог означает и существующих предков. */
  private markKnownDir(rel: string): void {
    const segments = rel.split('/');
    for (let length = 1; length <= segments.length; length += 1) {
      this.knownDirs.add(segments.slice(0, length).join('/'));
    }
  }

  private forgetDirs(rel: string): void {
    for (const dir of [...this.knownDirs]) {
      if (dir === rel || dir.startsWith(`${rel}/`)) {
        this.knownDirs.delete(dir);
      }
    }
  }

  // --- обход ---

  /**
   * RMDIR агента удаляет непустой каталог рекурсивно (факт пилота §5b) — на агенте это один
   * запрос. Стандартный сервер непустой каталог не удаляет; тогда — обход дерева.
   */
  private async removeRecursive(rel: string): Promise<void> {
    try {
      await this.rmdir(rel);
      return;
    } catch {
      // обычный SFTP-сервер: каталог не пуст — удаляем обходом
    }
    await this.removeTreeByWalk(rel);
  }

  private async removeTreeByWalk(rel: string): Promise<void> {
    for (const entry of await this.readdir(rel)) {
      const child = `${rel}/${entry.filename}`;
      // Ссылка — не каталог (lstat-атрибуты листинга): удаляется сама, внутрь не заходим.
      if (entry.attrs.isDirectory()) {
        await this.removeTreeByWalk(child);
      } else {
        await this.unlink(child);
      }
    }
    await this.rmdir(rel);
  }

  /**
   * Обход по уровням с ограниченным числом одновременных листингов: Promise.all по всем
   * подкаталогам выгрузки (тысячи OPENDIR) исчерпал бы дескрипторы сервера.
   */
  private async collect(rel: string, recursive: boolean, result: AgentFileEntry[]): Promise<void> {
    let level = [rel];
    while (level.length > 0) {
      const next: string[] = [];
      await forEachLimited(level, LIST_CONCURRENCY, async (dir) => {
        for (const entry of await this.readdir(dir || '.')) {
          if (entry.attrs.isSymbolicLink()) {
            // Ссылки не перечисляются и не обходятся — как у локального хранилища.
            continue;
          }
          const child = joinRel(dir, entry.filename);
          const item = toEntry(child, entry.attrs);
          result.push(item);
          if (recursive && item.type === 'dir') {
            next.push(child);
          }
        }
      });
      level = next;
    }
  }

  // --- примитивы SFTP ---

  /** `undefined` только на «нет такого файла»; права и прочие отказы пробрасываются. */
  private async statOrUndefined(kind: 'stat' | 'lstat', remote: string): Promise<Stats | undefined> {
    try {
      return await this.connection.request<Stats>((sftp, done) => sftp[kind](remote, done));
    } catch (error) {
      if (sftpStatusCode(error) === SFTP_NO_SUCH_FILE) {
        return undefined;
      }
      throw error;
    }
  }

  private open(remote: string, mode: 'r' | 'w'): Promise<Buffer> {
    return this.connection.request<Buffer>((sftp, done) => sftp.open(remote, mode, done));
  }

  private close(handle: Buffer): Promise<void> {
    return this.connection.request<undefined>((sftp, done) => sftp.close(handle, (error) => done(error, undefined)));
  }

  /**
   * Размер берётся из FSTAT, и порции читаются окном по своим смещениям (Н32); лишний READ ради
   * EOF не нужен. Файл, укороченный во время чтения, — отказ: выгрузку агент пишет temp+rename,
   * и такой исход означает чужую запись поверх, а не повод вернуть обрезанное содержимое.
   */
  private async readAll(handle: Buffer): Promise<Buffer> {
    const stats = await this.connection.request<Stats>((sftp, done) => sftp.fstat(handle, done));
    // SFTP v3 позволяет серверу не сообщать размер: тогда — последовательное чтение до EOF.
    if (!Number.isSafeInteger(stats.size)) {
      return this.readToEof(handle);
    }
    const buffer = Buffer.alloc(stats.size);
    const read = this.reader(handle);
    await runWindowed(Math.ceil(stats.size / IO_CHUNK), IO_WINDOW, async (index) => {
      const start = index * IO_CHUNK;
      const length = Math.min(IO_CHUNK, stats.size - start);
      if ((await readRange(read, buffer, start, start, length)) < length) {
        throw new Error(CHANGED_DURING_READ);
      }
    });
    return buffer;
  }

  private async readToEof(handle: Buffer): Promise<Buffer> {
    const chunks: Buffer[] = [];
    await this.streamToEof(handle, (chunk) => {
      chunks.push(chunk);
      return Promise.resolve();
    });
    return Buffer.concat(chunks);
  }

  /** Последовательные порции до EOF (сервер без размера в FSTAT); каждая — в свой буфер. */
  private async streamToEof(
    handle: Buffer,
    consume: (chunk: Buffer, position: number) => Promise<void>,
    cancellation?: AgentTransferCancellation
  ): Promise<void> {
    const read = this.reader(handle);
    let position = 0;
    for (;;) {
      throwIfTransferCancellationRequested(cancellation);
      const chunk = Buffer.alloc(IO_CHUNK);
      const count = await read(chunk, 0, IO_CHUNK, position);
      if (count === 0) {
        return;
      }
      await consume(chunk.subarray(0, count), position);
      position += count;
    }
  }

  /** Скачивание в открытый локальный файл: окном по размеру из FSTAT или до EOF без размера. */
  private async downloadInto(
    remote: Buffer,
    local: fs.promises.FileHandle,
    size: number,
    options: AgentStreamOptions
  ): Promise<void> {
    if (!Number.isSafeInteger(size)) {
      // SFTP v3 позволяет серверу не сообщать размер: тогда — последовательное чтение до EOF.
      await this.streamToEof(remote, async (chunk, position) => {
        await writeFully(local, chunk, chunk.length, position);
        options.onProgress?.(position + chunk.length, undefined);
      }, options.cancellation);
      return;
    }
    const read = this.reader(remote);
    let done = 0;
    await runWindowed(Math.ceil(size / IO_CHUNK), IO_WINDOW, async (index) => {
      const position = index * IO_CHUNK;
      const length = Math.min(IO_CHUNK, size - position);
      const chunk = Buffer.alloc(length);
      if ((await readRange(read, chunk, 0, position, length)) < length) {
        // Агент пишет выгрузку temp+rename: укороченный файл — чужая запись поверх, а не повод
        // отдать обрезанный архив.
        throw new Error(CHANGED_DURING_READ);
      }
      await writeFully(local, chunk, length, position);
      done += length;
      options.onProgress?.(done, size);
    }, options.cancellation);
  }

  private reader(handle: Buffer): SftpReadCall {
    return (target, targetOffset, length, position) => this.connection.request<number>((sftp, done) =>
      sftp.read(handle, target, targetOffset, length, position, (error, bytesRead) => done(error, bytesRead)));
  }

  private readdir(remote: string): Promise<FileEntryWithStats[]> {
    // ssh2 сам проходит OPENDIR/READDIR до EOF/CLOSE и отбрасывает «.» и «..».
    return this.connection.request<FileEntryWithStats[]>((sftp, done) => sftp.readdir(remote, done));
  }

  private unlink(remote: string): Promise<void> {
    return this.connection.request<undefined>((sftp, done) => sftp.unlink(remote, (error) => done(error, undefined)));
  }

  private rmdir(remote: string): Promise<void> {
    return this.connection.request<undefined>((sftp, done) => sftp.rmdir(remote, (error) => done(error, undefined)));
  }

  private rename(from: string, to: string): Promise<void> {
    return this.connection.request<undefined>((sftp, done) => sftp.rename(from, to, (error) => done(error, undefined)));
  }

  // Уборка после уже случившегося отказа: её собственная ошибка (чаще всего — то же потерянное
  // соединение) не должна заслонить исходную причину.
  private async closeQuietly(handle: Buffer): Promise<void> {
    try {
      await this.close(handle);
    } catch {
      // исходный отказ важнее
    }
  }

  private async removeQuietly(remote: string): Promise<void> {
    try {
      await this.unlink(remote);
    } catch {
      // временный файл мог и не появиться; исходный отказ важнее
    }
  }
}

/**
 * Хранилище поверх ОТДЕЛЬНОГО SSH-соединения к агенту (shell и SFTP агент держит на разных
 * соединениях, факт пилота §5b) по той же политике повторов Э3, что и shell-транспорт.
 */
export async function connectSftpAgentFileStore(
  options: DesignerAgentConnectionOptions,
  deps: SftpAgentFileStoreDeps = {}
): Promise<SftpAgentFileStore> {
  return new SftpAgentFileStore(await connectSftp(options, deps), deps.writeMode);
}

/** Родитель относительного пути; у пути первого уровня — корень (пустая строка). */
function parentOf(rel: string): string {
  return rel.slice(0, Math.max(rel.lastIndexOf('/'), 0));
}

/** Не более `limit` одновременных вызовов `run`; порядок запуска — порядок `items`. */
async function forEachLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function joinRel(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function toEntry(rel: string, stats: Stats): AgentFileEntry {
  return stats.isDirectory()
    ? { path: rel, type: 'dir', size: 0 }
    : { path: rel, type: 'file', size: stats.size };
}

/** Ошибка с относительным путём агента: по нему пользователь найдёт файл в персональном корне. */
function wrapError(action: string, target: ResolvedPath, error: unknown): Error {
  // Отказы ssh2 и SftpConnection всегда приходят экземплярами Error.
  return new Error(
    `Не удалось ${action} "${target.remote}" в хранилище агента (SFTP): ${(error as Error).message}`,
    { cause: error }
  );
}
