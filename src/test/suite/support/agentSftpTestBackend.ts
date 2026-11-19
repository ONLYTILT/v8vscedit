import * as fs from 'fs';
import * as path from 'path';
import { utils, type Attributes, type FileEntry, type SFTPWrapper } from 'ssh2';

/**
 * SFTP-сторона эмулятора агента конфигуратора: настоящие SFTP-обработчики ssh2.Server поверх
 * временного каталога. Внешняя система здесь — только сам агент 1С; протокол SFTP и ФС настоящие.
 *
 * Поведение, значимое для хранилища, управляется тестами: `rename` по умолчанию ПЕРЕЗАПИСЫВАЕТ
 * существующий файл-цель, как у агента (факт пилота §5b п.12, нестандартно для SFTP v3); с
 * `renameOverwrites = false` ведёт себя как стандартный SFTP v3 (занятая цель — FAILURE); может быть
 * отключён (`OP_UNSUPPORTED`); `rmdir` по умолчанию рекурсивен (факт пилота §5b); отдельные операции можно проваливать, придерживать (проверка параллелизма) и
 * обрывать вместе с соединением.
 */

export type SftpOp =
  | 'OPEN' | 'READ' | 'WRITE' | 'CLOSE' | 'FSTAT' | 'SETSTAT' | 'FSETSTAT' | 'STAT' | 'LSTAT'
  | 'MKDIR' | 'RMDIR' | 'REMOVE' | 'RENAME' | 'OPENDIR' | 'READDIR' | 'REALPATH';

export interface SftpLogEntry {
  readonly op: SftpOp;
  /** Путь запроса, как его прислал клиент (после нормализации — относительно корня, POSIX). */
  readonly path?: string;
  /** Для RENAME — новое имя. */
  readonly target?: string;
  /** Для READ — запрошенная длина, для WRITE — длина записываемой порции (проверка размера порции). */
  readonly length?: number;
}

export type SftpFailureCode = 'PERMISSION_DENIED' | 'FAILURE' | 'NO_SUCH_FILE';

export interface SftpFailureRule {
  readonly op: SftpOp;
  /** Подстрока пути запроса; не задана — любой путь. */
  readonly pathIncludes?: string;
  readonly code?: SftpFailureCode;
  /** Сколько запросов провалить; не задано — все подходящие. */
  readonly times?: number;
}

export interface SftpGate {
  /** Резолвится, когда придержано не меньше `count` запросов (одновременно, на любых соединениях). */
  waitForPending(count: number): Promise<void>;
  /** Сколько запросов придержано сейчас. */
  pendingCount(): number;
  /** Отпускает все придержанные запросы и снимает удержание. */
  release(): void;
}

/** Размер порции READDIR: меньше числа файлов в тестах, чтобы листинг требовал нескольких запросов. */
const READDIR_CHUNK = 50;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

interface OpenHandle {
  readonly kind: 'file' | 'dir';
  readonly fd?: number;
  /** Путь открытого файла: READ/WRITE попадают в журнал с ним, и отказы можно целить по имени файла. */
  readonly path?: string;
  readonly entries?: FileEntry[];
  served?: boolean;
  offset?: number;
}

interface FailureState extends SftpFailureRule {
  remaining: number;
}

interface HeldRequest {
  readonly proceed: () => void;
}

export class SftpTestBackend {
  /** SFTP-подсистема, принятая сервером (по одной на SFTP-соединение). */
  sessionCount = 0;
  readonly log: SftpLogEntry[] = [];
  /** `rename` отвечает OP_UNSUPPORTED. */
  renameUnsupported = false;
  /** `rename` перезаписывает существующий файл-цель (поведение агента); иначе — FAILURE, как SFTP v3. */
  renameOverwrites = true;
  /** `rmdir` непустого каталога рекурсивен (поведение агента); иначе — отказ, как у обычного SFTP. */
  recursiveRmdir = true;
  /** Ответ READ не длиннее этого числа байт (SFTP разрешает серверу отвечать короче запроса). */
  readResponseLimit: number | undefined;
  /** STAT/LSTAT/READDIR отвечают без времён (флаг ACMODTIME не выставлен — SFTP v3 это допускает). */
  attrsWithoutTimes = false;
  /**
   * Сдвиг ВСЕХ отдаваемых времён, секунд: модель сервера, чьё «UTC» — местное время (факт Э23: сдвиг ~1 ч
   * относительно клиента). Сдвигаются и метка, и файлы, поэтому сравнение с меткой остаётся верным, а
   * сравнение с часами клиента — нет.
   */
  mtimeShiftSec = 0;
  /** FSTAT отвечает без размера (флаг SIZE не выставлен — SFTP v3 это допускает). */
  fstatWithoutSize = false;
  /**
   * Наибольшее число одновременно «в полёте» READ/WRITE (получены и ещё не обработаны: в обычном режиме
   * обработка мгновенна, поэтому накопление видно только под `hold`). Проверка окна конвейера:
   * в полёте не больше `IO_WINDOW` порций.
   */
  readonly maxConcurrent: Record<'READ' | 'WRITE', number> = { READ: 0, WRITE: 0 };
  /** Сейчас открытых каталогов (OPENDIR без CLOSE) и их наибольшее число за время жизни сервера. */
  openDirs = 0;
  maxOpenDirs = 0;

  private readonly inFlight: Record<'READ' | 'WRITE', number> = { READ: 0, WRITE: 0 };
  private readonly failures: FailureState[] = [];
  private readonly dropRules: { op: SftpOp; pathIncludes?: string; drop: () => void }[] = [];
  private gateOp: SftpOp | undefined;
  private held: HeldRequest[] = [];
  private pendingWaiters: { count: number; resolve: () => void }[] = [];
  private nextHandle = 1;
  /** Открытые дескрипторы всех сессий: обрыв соединения оставляет их незакрытыми (см. closeAll). */
  private readonly openFds = new Set<number>();

  constructor(readonly rootDir: string) {}

  /**
   * Закрывает дескрипторы, оставшиеся после оборванных сессий: на Windows открытый файл не даёт
   * удалить временный каталог теста. Зовётся при остановке сервера.
   */
  closeAll(): void {
    for (const fd of this.openFds) {
      fs.closeSync(fd);
    }
    this.openFds.clear();
  }

  ops(op: SftpOp): SftpLogEntry[] {
    return this.log.filter((entry) => entry.op === op);
  }

  failNext(rule: SftpFailureRule): void {
    this.failures.push({ ...rule, remaining: rule.times ?? Number.POSITIVE_INFINITY });
  }

  /** При первом подходящем запросе обрывает соединение (`drop`), не отвечая на запрос. */
  dropConnectionOn(op: SftpOp, drop: () => void, pathIncludes?: string): void {
    this.dropRules.push({ op, pathIncludes, drop });
  }

  /** Придерживает ответы на запросы `op`, пока тест не вызовет `release()`. */
  hold(op: SftpOp): SftpGate {
    this.gateOp = op;
    return {
      waitForPending: (count) => new Promise<void>((resolve) => {
        if (this.held.length >= count) {
          resolve();
          return;
        }
        this.pendingWaiters.push({ count, resolve });
      }),
      pendingCount: () => this.held.length,
      release: () => {
        this.gateOp = undefined;
        const toRun = this.held.splice(0);
        for (const request of toRun) {
          request.proceed();
        }
      },
    };
  }

  attach(sftp: SFTPWrapper): void {
    this.sessionCount += 1;
    const handles = new Map<string, OpenHandle>();
    const { STATUS_CODE } = utils.sftp;

    const newHandle = (value: OpenHandle): Buffer => {
      const id = Buffer.alloc(4);
      id.writeUInt32BE(this.nextHandle, 0);
      this.nextHandle += 1;
      handles.set(id.toString('hex'), value);
      return id;
    };
    const lookup = (handle: Buffer): OpenHandle | undefined => handles.get(handle.toString('hex'));
    const status = (reqId: number, code: number): void => sftp.status(reqId, code);

    /**
     * Единая обвязка запроса: журнал, внедрённые отказы/обрывы, удержание — затем сама операция.
     * Ошибки ФС отображаются в коды SFTP: «нет пути» (в том числе файл вместо каталога) — NO_SUCH_FILE,
     * остальное — FAILURE.
     */
    const handle = (reqId: number, entry: SftpLogEntry, run: () => void): void => {
      this.log.push(entry);
      const failure = this.matchFailure(entry);
      if (failure) {
        status(reqId, STATUS_CODE[failure.code ?? 'FAILURE']);
        return;
      }
      const drop = this.matchDrop(entry);
      if (drop) {
        drop();
        return;
      }
      const counted = entry.op === 'READ' || entry.op === 'WRITE' ? entry.op : undefined;
      if (counted) {
        this.inFlight[counted] += 1;
        this.maxConcurrent[counted] = Math.max(this.maxConcurrent[counted], this.inFlight[counted]);
      }
      const execute = (): void => {
        try {
          run();
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          status(reqId, code === 'ENOENT' || code === 'ENOTDIR' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);
        } finally {
          if (counted) {
            this.inFlight[counted] -= 1;
          }
        }
      };
      if (this.gateOp === entry.op) {
        this.held.push({ proceed: execute });
        this.notifyPending();
        return;
      }
      execute();
    };

    sftp.on('OPEN', (reqId, filename, flags) => {
      const rel = this.toRel(filename);
      handle(reqId, { op: 'OPEN', path: rel }, () => {
        const mode = utils.sftp.flagsToString(flags) ?? 'r';
        const fd = fs.openSync(this.toAbs(rel), mode);
        this.openFds.add(fd);
        sftp.handle(reqId, newHandle({ kind: 'file', fd, path: rel }));
      });
    });

    sftp.on('READ', (reqId, h, offset, length) => {
      handle(reqId, { op: 'READ', path: lookup(h)?.path, length }, () => {
        const open = lookup(h);
        if (open?.fd === undefined) {
          status(reqId, STATUS_CODE.FAILURE);
          return;
        }
        const want = this.readResponseLimit === undefined ? length : Math.min(length, this.readResponseLimit);
        const buffer = Buffer.alloc(want);
        const bytes = fs.readSync(open.fd, buffer, 0, want, offset);
        if (bytes === 0) {
          status(reqId, STATUS_CODE.EOF);
          return;
        }
        sftp.data(reqId, buffer.subarray(0, bytes));
      });
    });

    sftp.on('WRITE', (reqId, h, offset, data) => {
      handle(reqId, { op: 'WRITE', path: lookup(h)?.path, length: data.length }, () => {
        const open = lookup(h);
        if (open?.fd === undefined) {
          status(reqId, STATUS_CODE.FAILURE);
          return;
        }
        fs.writeSync(open.fd, data, 0, data.length, offset);
        status(reqId, STATUS_CODE.OK);
      });
    });

    sftp.on('CLOSE', (reqId, h) => {
      handle(reqId, { op: 'CLOSE' }, () => {
        const open = lookup(h);
        if (open?.fd !== undefined) {
          fs.closeSync(open.fd);
          this.openFds.delete(open.fd);
        }
        if (open?.kind === 'dir') {
          this.openDirs -= 1;
        }
        handles.delete(h.toString('hex'));
        status(reqId, STATUS_CODE.OK);
      });
    });

    sftp.on('FSTAT', (reqId, h) => {
      handle(reqId, { op: 'FSTAT' }, () => {
        const open = lookup(h);
        if (open?.fd === undefined) {
          status(reqId, STATUS_CODE.FAILURE);
          return;
        }
        const attrs = this.attrsOf(fs.fstatSync(open.fd));
        // Тип ssh2 требует size, но кодировщик ответа выставляет флаг SIZE только для числа —
        // так эмулируется сервер, не сообщающий размер.
        sftp.attrs(reqId, this.fstatWithoutSize ? { ...attrs, size: undefined as unknown as number } : attrs);
      });
    });

    sftp.on('SETSTAT', (reqId, p) => handle(reqId, { op: 'SETSTAT', path: this.toRel(p) }, () => status(reqId, STATUS_CODE.OK)));
    sftp.on('FSETSTAT', (reqId) => handle(reqId, { op: 'FSETSTAT' }, () => status(reqId, STATUS_CODE.OK)));

    sftp.on('STAT', (reqId, p) => {
      const rel = this.toRel(p);
      handle(reqId, { op: 'STAT', path: rel }, () => sftp.attrs(reqId, this.attrsOf(fs.statSync(this.toAbs(rel)))));
    });
    sftp.on('LSTAT', (reqId, p) => {
      const rel = this.toRel(p);
      handle(reqId, { op: 'LSTAT', path: rel }, () => sftp.attrs(reqId, this.attrsOf(fs.lstatSync(this.toAbs(rel)))));
    });

    sftp.on('MKDIR', (reqId, p) => {
      const rel = this.toRel(p);
      handle(reqId, { op: 'MKDIR', path: rel }, () => {
        fs.mkdirSync(this.toAbs(rel));
        status(reqId, STATUS_CODE.OK);
      });
    });

    sftp.on('RMDIR', (reqId, p) => {
      const rel = this.toRel(p);
      handle(reqId, { op: 'RMDIR', path: rel }, () => {
        const abs = this.toAbs(rel);
        if (!fs.statSync(abs).isDirectory()) {
          status(reqId, STATUS_CODE.FAILURE);
          return;
        }
        if (this.recursiveRmdir) {
          fs.rmSync(abs, { recursive: true, force: true });
        } else {
          fs.rmdirSync(abs);
        }
        status(reqId, STATUS_CODE.OK);
      });
    });

    sftp.on('REMOVE', (reqId, p) => {
      const rel = this.toRel(p);
      handle(reqId, { op: 'REMOVE', path: rel }, () => {
        fs.unlinkSync(this.toAbs(rel));
        status(reqId, STATUS_CODE.OK);
      });
    });

    sftp.on('RENAME', (reqId, from, to) => {
      const relFrom = this.toRel(from);
      const relTo = this.toRel(to);
      handle(reqId, { op: 'RENAME', path: relFrom, target: relTo }, () => {
        if (this.renameUnsupported) {
          status(reqId, STATUS_CODE.OP_UNSUPPORTED);
          return;
        }
        // Каталог-цель не заменяется ни агентом, ни стандартным сервером; файл-цель агент
        // перезаписывает, а стандартный SFTP v3 — нет.
        const existing = fs.existsSync(this.toAbs(relTo)) ? fs.statSync(this.toAbs(relTo)) : undefined;
        if (existing && (existing.isDirectory() || !this.renameOverwrites)) {
          status(reqId, STATUS_CODE.FAILURE);
          return;
        }
        fs.renameSync(this.toAbs(relFrom), this.toAbs(relTo));
        status(reqId, STATUS_CODE.OK);
      });
    });

    sftp.on('OPENDIR', (reqId, p) => {
      const rel = this.toRel(p);
      handle(reqId, { op: 'OPENDIR', path: rel }, () => {
        const abs = this.toAbs(rel);
        if (!fs.statSync(abs).isDirectory()) {
          status(reqId, STATUS_CODE.FAILURE);
          return;
        }
        // Как у настоящих серверов: «.» и «..» в листинге есть; порядок обратный алфавитному,
        // чтобы реализация не могла полагаться на отсортированный ответ сервера.
        const names = ['.', '..', ...fs.readdirSync(abs).sort().reverse()];
        const entries: FileEntry[] = names.map((name) => ({
          filename: name,
          longname: name,
          attrs: this.attrsOf(fs.lstatSync(path.join(abs, name))),
        }));
        this.openDirs += 1;
        this.maxOpenDirs = Math.max(this.maxOpenDirs, this.openDirs);
        sftp.handle(reqId, newHandle({ kind: 'dir', entries, offset: 0 }));
      });
    });

    sftp.on('READDIR', (reqId, h) => {
      handle(reqId, { op: 'READDIR' }, () => {
        const open = lookup(h);
        if (!open?.entries || open.offset === undefined) {
          status(reqId, STATUS_CODE.FAILURE);
          return;
        }
        if (open.offset >= open.entries.length) {
          status(reqId, STATUS_CODE.EOF);
          return;
        }
        const chunk = open.entries.slice(open.offset, open.offset + READDIR_CHUNK);
        open.offset += chunk.length;
        sftp.name(reqId, chunk);
      });
    });

    sftp.on('REALPATH', (reqId, p) => {
      const rel = this.toRel(p);
      handle(reqId, { op: 'REALPATH', path: rel }, () => {
        const filename = `/${rel}`;
        sftp.name(reqId, [{ filename, longname: filename, attrs: { mode: 0, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 } }]);
      });
    });
  }

  private attrsOf(stats: fs.Stats): Attributes {
    const attrs = toAttributes(stats);
    if (this.attrsWithoutTimes) {
      // Тип ssh2 требует числа, но кодировщик выставляет ACMODTIME только для чисел.
      return { ...attrs, atime: undefined as unknown as number, mtime: undefined as unknown as number };
    }
    return { ...attrs, atime: attrs.atime + this.mtimeShiftSec, mtime: attrs.mtime + this.mtimeShiftSec };
  }

  /** Путь клиента → нормализованный относительный POSIX-путь внутри корня (выход наверх невозможен). */
  private toRel(requested: string): string {
    return path.posix.normalize(`/${requested.replace(/\\/g, '/')}`).replace(/^\/+/, '');
  }

  private toAbs(rel: string): string {
    return path.join(this.rootDir, ...rel.split('/').filter((segment) => segment !== ''));
  }

  private matchFailure(entry: SftpLogEntry): SftpFailureRule | undefined {
    const rule = this.failures.find((candidate) =>
      candidate.remaining > 0 && candidate.op === entry.op &&
      (candidate.pathIncludes === undefined || (entry.path ?? '').includes(candidate.pathIncludes)));
    if (rule) {
      rule.remaining -= 1;
    }
    return rule;
  }

  private matchDrop(entry: SftpLogEntry): (() => void) | undefined {
    const index = this.dropRules.findIndex((rule) =>
      rule.op === entry.op && (rule.pathIncludes === undefined || (entry.path ?? '').includes(rule.pathIncludes)));
    if (index < 0) {
      return undefined;
    }
    const [rule] = this.dropRules.splice(index, 1);
    return rule.drop;
  }

  private notifyPending(): void {
    const ready = this.pendingWaiters.filter((waiter) => this.held.length >= waiter.count);
    this.pendingWaiters = this.pendingWaiters.filter((waiter) => !ready.includes(waiter));
    for (const waiter of ready) {
      waiter.resolve();
    }
  }
}

function toAttributes(stats: fs.Stats): Attributes {
  let type = S_IFREG;
  if (stats.isDirectory()) {
    type = S_IFDIR;
  } else if (stats.isSymbolicLink()) {
    type = S_IFLNK;
  }
  return {
    mode: (type & S_IFMT) | (stats.mode & 0o777),
    uid: 0,
    gid: 0,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  };
}
