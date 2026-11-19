import * as fs from 'fs';
import * as path from 'path';
import { parseAgentBaseDirIndex, resolveAgentUserDir } from '../../../domain/agent/AgentBaseDirIndex';
import { writeFileAtomic, writeFileAtomicWith } from '../../fs/AtomicFileWriter';
import { writeFully } from '../../fs/FileHandleWrite';
import { toAgentPathSegments, type AgentFileEntry, type AgentFileStore, type AgentStreamOptions } from './AgentFileStore';
import { AgentTransferCancelledError, throwIfTransferCancellationRequested } from './AgentFileTransfer';

const INDEX_FILE_NAME = 'agentbasedir.json';
/** Порция локального копирования: память — O(порция), отмена и прогресс — между порциями. */
const COPY_CHUNK = 256 * 1024;

// вызывается, только если откажет уборка после уже случившегося отказа
// (close/unlink своего же файла); такой отказ детерминированно не воспроизвести.
/* c8 ignore start */
const noop = (): void => undefined;
/* c8 ignore stop */

interface ResolvedPath {
  readonly rel: string;
  readonly abs: string;
}

/**
 * Хранилище в персональном корне агента, запущенного на этой же машине: корень —
 * обычный локальный каталог `<AgentBaseDir>/<dir>`.
 *
 * Защита в глубину от ссылок (symlink/junction) внутри корня: проверки сегментов пути мало,
 * если `workspace` или его родитель — ссылка наружу. Поэтому реальное расположение пути (после
 * разрешения ссылок) сверяется с реальным корнем, `list` по ссылкам не ходит, а `remove`
 * удаляет саму ссылку, не трогая её цель.
 */
export class LocalAgentFileStore implements AgentFileStore {
  readonly kind = 'local' as const;

  constructor(private readonly rootDir: string) {}

  async stat(rel: string): Promise<AgentFileEntry | undefined> {
    const target = this.resolve(rel);
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(target.abs);
    } catch (error) {
      // Только «пути нет» превращается в undefined; иные отказы (права, недопустимое имя)
      // скрывать нельзя — вызывающий принял бы их за отсутствие файла и пошёл бы его создавать.
      if (isMissingPathError(error)) {
        return undefined;
      }
      throw error;
    }
    // Существующий путь, ведущий через ссылку наружу, — отказ, а не сведения о чужом файле.
    await this.assertInside(target);
    return toEntry(target.rel, stats);
  }

  async readFile(rel: string): Promise<Buffer> {
    const target = await this.resolveChecked(rel);
    try {
      return await fs.promises.readFile(target.abs);
    } catch (error) {
      throw wrapError('прочитать файл', target.rel, error);
    }
  }

  async writeFile(rel: string, data: Uint8Array | string): Promise<void> {
    const target = await this.resolveChecked(rel);
    await fs.promises.mkdir(path.dirname(target.abs), { recursive: true });
    writeFileAtomic(target.abs, data);
  }

  async downloadToFile(rel: string, localPath: string, options: AgentStreamOptions = {}): Promise<void> {
    const target = await this.resolveChecked(rel);
    throwIfTransferCancellationRequested(options.cancellation);
    let source: fs.promises.FileHandle | undefined;
    let local: fs.promises.FileHandle | undefined;
    let created = false;
    try {
      source = await fs.promises.open(target.abs, 'r');
      const stats = await source.stat();
      if (!stats.isFile()) {
        throw new Error('по этому пути находится не файл');
      }
      local = await fs.promises.open(localPath, 'wx');
      created = true;
      await copyChunks(source, local, stats.size, options);
      const finished = local;
      local = undefined;
      await finished.close();
    } catch (error) {
      await local?.close().catch(noop);
      if (created) {
        // Неполный файл не должен остаться похожим на скачанный архив.
        await fs.promises.unlink(localPath).catch(noop);
      }
      throw error instanceof AgentTransferCancelledError ? error : wrapError('скачать файл', target.rel, error);
    } finally {
      await source?.close().catch(noop);
    }
  }

  async uploadFromFile(localPath: string, rel: string, options: AgentStreamOptions = {}): Promise<void> {
    const target = await this.resolveChecked(rel);
    throwIfTransferCancellationRequested(options.cancellation);
    let source: fs.promises.FileHandle;
    try {
      source = await fs.promises.open(localPath, 'r');
    } catch (error) {
      throw new Error(`Не удалось открыть локальный файл "${localPath}" для передачи агенту: ${(error as Error).message}`, { cause: error });
    }
    try {
      const { size } = await source.stat();
      await fs.promises.mkdir(path.dirname(target.abs), { recursive: true });
      // Та же подмена temp+rename, что у writeFile: отмена посреди копирования цель не портит.
      await writeFileAtomicWith(target.abs, async (tempPath) => {
        const temp = await fs.promises.open(tempPath, 'wx');
        try {
          await copyChunks(source, temp, size, options);
        } finally {
          await temp.close();
        }
      });
    } catch (error) {
      throw error instanceof AgentTransferCancelledError ? error : wrapError('записать файл', target.rel, error);
    } finally {
      await source.close();
    }
  }

  async remove(rel: string, options?: { readonly recursive?: boolean }): Promise<void> {
    const target = this.resolve(rel);
    if (!target.rel) {
      throw new Error('Удаление корня хранилища агента запрещено.');
    }
    let stats: fs.Stats;
    try {
      stats = await fs.promises.lstat(target.abs);
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }
      throw error;
    }
    // Ссылку удаляем саму по себе, поэтому внутри корня обязан лежать её РОДИТЕЛЬ, а не цель.
    await this.assertInside(target, { parentOnly: true });
    try {
      if (!stats.isDirectory()) {
        // Файл или ссылка (в том числе junction на каталог): unlink не следует по ссылке.
        await fs.promises.unlink(target.abs);
      } else if (options?.recursive) {
        await removeTree(target.abs);
      } else {
        // rmdir локальной ФС сам отказывает на непустом каталоге — то, что контракт
        // требует явной проверкой от SFTP-реализации.
        await fs.promises.rmdir(target.abs);
      }
    } catch (error) {
      throw wrapError('удалить', target.rel, error);
    }
  }

  async list(relDir: string, options?: { readonly recursive?: boolean }): Promise<AgentFileEntry[]> {
    const target = await this.resolveChecked(relDir);
    const result: AgentFileEntry[] = [];
    try {
      await this.collect(target.abs, target.rel, options?.recursive === true, result);
    } catch (error) {
      throw wrapError('прочитать каталог', target.rel, error);
    }
    return result.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  async mkdirp(rel: string): Promise<void> {
    const target = await this.resolveChecked(rel);
    await fs.promises.mkdir(target.abs, { recursive: true });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  /** Синтаксическая проверка (сегменты) и проверка реального расположения. */
  private async resolveChecked(rel: string): Promise<ResolvedPath> {
    const target = this.resolve(rel);
    await this.assertInside(target);
    return target;
  }

  private resolve(rel: string): ResolvedPath {
    const segments = toAgentPathSegments(rel);
    return { rel: segments.join('/'), abs: path.join(this.rootDir, ...segments) };
  }

  /**
   * Реальное расположение пути — или, при `parentOnly`, его родителя — после разрешения
   * ссылок обязано остаться внутри реального корня. Несуществующий хвост пути проверяется по
   * ближайшему существующему предку.
   */
  private async assertInside(target: ResolvedPath, options: { readonly parentOnly?: boolean } = {}): Promise<void> {
    const realRoot = await realpathOfExisting(this.rootDir);
    const realTarget = await realpathOfExisting(options.parentOnly ? path.dirname(target.abs) : target.abs);
    const relative = path.relative(realRoot, realTarget);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Путь агента выходит за пределы корня агента через ссылку: ${target.rel}`);
    }
  }

  private async collect(absDir: string, relDir: string, recursive: boolean, result: AgentFileEntry[]): Promise<void> {
    for (const dirent of await fs.promises.readdir(absDir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
      const abs = path.join(absDir, dirent.name);
      const stats = await fs.promises.lstat(abs);
      if (stats.isSymbolicLink()) {
        // Ссылки не перечисляются и не обходятся: их цель может лежать вне корня, а зеркалу
        // выгрузки ссылки не нужны — агент их не создаёт.
        continue;
      }
      const entry = toEntry(rel, stats);
      result.push(entry);
      if (recursive && entry.type === 'dir') {
        await this.collect(abs, rel, recursive, result);
      }
    }
  }
}

/**
 * Реальный путь с разрешёнными ссылками; для несуществующего хвоста — реальный путь
 * ближайшего существующего предка плюс оставшиеся сегменты как есть.
 */
async function realpathOfExisting(target: string): Promise<string> {
  try {
    return await fs.promises.realpath(target);
  } catch (error) {
    const parent = path.dirname(target);
    if (!isMissingPathError(error) || parent === target) {
      throw error;
    }
    return path.join(await realpathOfExisting(parent), path.basename(target));
  }
}

/**
 * Персональный корень пользователя локального агента: `<agentBaseDir>/<dir>`, где `dir`
 * берётся из `agentbasedir.json`. Индекс агент дописывает при ПЕРВОМ входе пользователя по
 * SSH, поэтому вызывать — после успешного подключения, а не при создании сервиса.
 */
export async function resolveLocalAgentUserRoot(agentBaseDir: string, userName: string): Promise<string> {
  const indexFile = path.join(agentBaseDir, INDEX_FILE_NAME);
  let text: string;
  try {
    text = await fs.promises.readFile(indexFile, 'utf-8');
  } catch (error) {
    throw new Error(
      `Не удалось прочитать индекс пользователей агента конфигуратора ${indexFile}: ${(error as Error).message}. ` +
      'Агент создаёт его при первом входе пользователя по SSH. ' +
      // Частая причина (Н24): агент запущен вне расширения со своим каталогом — тогда индекс лежит не здесь.
      'Если агент запущен вручную с другим каталогом, укажите его ключом /AgentBaseDir ' +
      'в настройке v8vscedit.agent.agentModeArgs.',
      { cause: error }
    );
  }
  const dir = resolveAgentUserDir(parseAgentBaseDirIndex(text), userName);
  if (dir === undefined) {
    throw new Error(`Пользователь агента конфигуратора "${userName}" не найден в ${indexFile}.`);
  }
  return path.join(agentBaseDir, dir);
}

export async function createLocalAgentFileStore(agentBaseDir: string, userName: string): Promise<LocalAgentFileStore> {
  return new LocalAgentFileStore(await resolveLocalAgentUserRoot(agentBaseDir, userName));
}

/**
 * Рекурсивное удаление своим обходом через unlink/rmdir, а не `fs.rm`: на Windows `fs.rmSync`
 * системного Node 24 молча (без исключения) не удаляет файлы с кириллицей в имени (проверено
 * 2026-11-17), а у выгрузки 1С кириллица — в каждом втором пути. Ссылки удаляются сами по себе.
 */
async function removeTree(dir: string): Promise<void> {
  for (const dirent of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      await removeTree(abs);
    } else {
      await fs.promises.unlink(abs);
    }
  }
  await fs.promises.rmdir(dir);
}

/** Копирует `size` байт порциями; отмена проверяется перед каждой порцией. */
async function copyChunks(
  source: fs.promises.FileHandle,
  target: fs.promises.FileHandle,
  size: number,
  options: AgentStreamOptions
): Promise<void> {
  const buffer = Buffer.alloc(Math.min(COPY_CHUNK, Math.max(size, 1)));
  let position = 0;
  while (position < size) {
    throwIfTransferCancellationRequested(options.cancellation);
    const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, size - position), position);
    // укоротить файл между stat и чтением детерминированно в тесте нечем; без
    // границы недочитанный хвост молча остался бы нулями.
    /* c8 ignore start */
    if (bytesRead === 0) {
      throw new Error('файл изменился во время чтения (EOF раньше размера)');
    }
    /* c8 ignore stop */
    await writeFully(target, buffer, bytesRead, position);
    position += bytesRead;
    options.onProgress?.(position, size);
  }
}

function toEntry(rel: string, stats: fs.Stats): AgentFileEntry {
  return stats.isDirectory()
    ? { path: rel, type: 'dir', size: 0, mtimeMs: stats.mtimeMs }
    : { path: rel, type: 'file', size: stats.size, mtimeMs: stats.mtimeMs };
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Ошибка ФС с относительным путём агента: абсолютный путь локального корня ничего не скажет об удалённом. */
function wrapError(action: string, rel: string, error: unknown): Error {
  // Отказы fs всегда приходят экземплярами Error.
  return new Error(`Не удалось ${action} "${rel}" в хранилище агента: ${(error as Error).message}`, { cause: error });
}
