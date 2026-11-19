import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { CancellationLike } from '../ProcessRunner';
import { buildPowerShellHostArgs } from './PowerShellHostScript';
import {
  HostOutputParser,
  encodeHostRequest,
  type HostAuthentication,
  type HostEvent,
  type HostLine,
  type HostRequestBody,
} from './PowerShellHostProtocol';

export interface PowerShellHostConnection {
  readonly computerName: string;
  readonly user: string;
  readonly password: string;
  readonly authentication: HostAuthentication;
  readonly useSsl: boolean;
  readonly port: number;
}

export type HostSpawn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; windowsHide: boolean }
) => ChildProcessWithoutNullStreams;

export interface PowerShellRemoteHostOptions {
  readonly connection: PowerShellHostConnection;
  /** Исполняемый файл PowerShell; по умолчанию `powershell.exe` (Windows PowerShell 5.1). */
  readonly powershellPath?: string;
  readonly spawn?: HostSpawn;
  /** Окружение процесса хоста; по умолчанию — окружение текущего процесса. */
  readonly env?: NodeJS.ProcessEnv;
  /** Шум stdout, строки stderr и диагностика хоста; пароль сюда не попадает никогда. */
  readonly log?: (line: string) => void;
  /** Сколько ждать выхода хоста после закрытия stdin, прежде чем убить его; по умолчанию 5000 мс. */
  readonly disposeGraceMs?: number;
}

export type PowerShellHostErrorCode =
  | 'remote-error'
  /** Сервер отклонил учётные данные при `connect`: повторять вход автоматически нельзя (блокировка учётки). */
  | 'auth-failed'
  | 'session-broken'
  | 'host-exited'
  | 'protocol'
  | 'spawn-failed'
  | 'disposed';

export class PowerShellHostError extends Error {
  constructor(message: string, readonly code: PowerShellHostErrorCode) {
    super(message);
    this.name = 'PowerShellHostError';
  }
}

export interface HostRunRequest {
  readonly exe: string;
  readonly commandLine: string;
  readonly logPath: string;
  readonly cancellation?: CancellationLike;
  readonly onStarted?: (pid: number) => void;
  readonly onOutput?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface HostRunResult {
  readonly exitCode: number;
  readonly interrupted: boolean;
  readonly logBytes: Buffer;
  readonly pid: number;
}

type OkEvent = Extract<HostEvent, { event: 'ok' }>;

interface PendingRequest {
  readonly onEvent: (event: HostEvent) => boolean;
  readonly reject: (error: PowerShellHostError) => void;
}

/** Живой процесс хоста и всё, что к нему относится; после смерти не переиспользуется. */
interface HostProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pending: Map<number, PendingRequest>;
  dead: boolean;
}

/** Сколько ждать хвост stdout после выхода процесса: внук 1cv8 мог унаследовать канал и держать его открытым. */
const EXIT_DRAIN_MS = 300;
/** Сколько ждать штатного завершения хоста после закрытия stdin, прежде чем убить его. */
const DISPOSE_GRACE_MS = 5_000;

/** Запросы без побочного эффекта или с безвредным повтором (`fetch` перезаписывает, `rmtemp` идемпотентен). */
const RETRY_SAFE_OPS: ReadonlySet<HostRequestBody['op']> = new Set(['ping', 'resolveV8', 'mktemp', 'rmtemp', 'fetch']);
const RETRIABLE_CODES: ReadonlySet<PowerShellHostErrorCode> = new Set(['session-broken', 'host-exited']);

const INTERRUPTED_BEFORE_START: HostRunResult = { exitCode: -1, interrupted: true, logBytes: Buffer.alloc(0), pid: 0 };

/**
 * Долгоживущий процесс хоста PowerShell с последовательной очередью запросов.
 *
 * Процесс запускается лениво и сразу получает `connect` (один раз на процесс). Обычная ошибка
 * операции (`error`) отклоняет только свой запрос; разрыв сессии, выход процесса и нарушение
 * протокола делают процесс негодным — следующий запрос поднимет новый ровно один раз (без цикла
 * перезапусков внутри запроса, чтобы неверная учётка не долбила сервер входами). `cancel` идёт
 * мимо очереди: он должен дойти, пока в очереди висит сам `run`.
 */
export class PowerShellRemoteHost {
  private current: HostProcess | undefined;
  /** Процессы хоста, чей выход ещё не обработан (текущий и убитые как негодные). */
  private readonly living = new Set<HostProcess>();
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private disposed = false;

  constructor(private readonly options: PowerShellRemoteHostOptions) {}

  getProcessId(): number | undefined {
    return this.current && !this.current.dead ? this.current.child.pid : undefined;
  }

  async ping(): Promise<{ pid: number }> {
    const event = await this.call({ op: 'ping' });
    return { pid: Number(event.pid) };
  }

  async mktemp(): Promise<string> {
    const event = await this.call({ op: 'mktemp' });
    return String(event.dir);
  }

  async put(dir: string, name: string, content: Uint8Array | string): Promise<void> {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
    await this.call({ op: 'put', dir, name, contentB64: bytes.toString('base64') });
  }

  async resolveV8(target: { v8Path?: string; v8Version?: string }): Promise<string | undefined> {
    const event = await this.call({ op: 'resolveV8', ...target });
    return typeof event.path === 'string' && event.path ? event.path : undefined;
  }

  async fetch(remotePath: string, localPath: string): Promise<boolean> {
    const event = await this.call({ op: 'fetch', remotePath, localPath });
    return event.exists === true;
  }

  async rmtemp(dir: string): Promise<void> {
    await this.call({ op: 'rmtemp', dir });
  }

  run(request: HostRunRequest): Promise<HostRunResult> {
    if (request.cancellation?.isCancellationRequested) {
      return Promise.resolve(INTERRUPTED_BEFORE_START);
    }
    return this.serialize(async () => {
      // Отмена могла прийти, пока запрос ждал очереди: процесс тогда не запускается вовсе.
      if (request.cancellation?.isCancellationRequested) {
        return INTERRUPTED_BEFORE_START;
      }
      const proc = await this.ensureProcess();
      const id = this.nextId++;
      let pid = 0;
      const result = this.send<HostRunResult>(proc, id, { op: 'run', exe: request.exe, commandLine: request.commandLine, logPath: request.logPath }, (event, resolve) => {
        if (event.event === 'started') {
          pid = event.pid;
          request.onStarted?.(pid);
          return false;
        }
        if (event.event === 'output') {
          request.onOutput?.(Buffer.from(event.textB64, 'base64').toString('utf-8'), event.stream);
          return false;
        }
        if (event.event === 'exit') {
          resolve({ exitCode: event.code, interrupted: event.interrupted === true, logBytes: Buffer.from(event.logB64, 'base64'), pid });
          return true;
        }
        return false;
      });
      // Подписка снимается по завершении run, поэтому поздняя отмена cancel не шлёт; запись в stdin
      // уже умершего процесса безвредна (ошибки потока гасятся, запрос отклонит событие `exit`).
      const subscription = request.cancellation?.onCancellationRequested(() => {
        this.write(proc, encodeHostRequest(this.nextId++, { op: 'cancel', target: id }));
      });
      try {
        return await result;
      } finally {
        subscription?.dispose();
      }
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const proc = this.current;
    this.current = undefined;
    if (proc) {
      this.markDead(proc, new PowerShellHostError('Хост PowerShell закрыт.', 'disposed'));
      // Закрытие stdin — штатный сигнал скрипту: он закрывает PSSession и выходит сам.
      proc.child.stdin.end();
    }
    // Ждём ВСЕ ещё живые процессы, включая уже убитые как негодные: после dispose ни один процесс
    // хоста не должен пережить вызывающего (держать файлы, каталоги или сессию на сервере).
    await Promise.all([...this.living].map((item) => this.waitForExit(item)));
  }

  private waitForExit(proc: HostProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.child.kill();
        resolve();
      }, this.options.disposeGraceMs ?? DISPOSE_GRACE_MS);
      proc.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Н62: идемпотентные запросы повторяются ОДИН раз на новом процессе при разрыве сессии или выходе
   * хоста. Сессия открывается с IdleTimeout (Н61), и после простоя сервер её закрывает — без повтора
   * первая операция после паузы падала бы. Повтор ровно один (без цикла: неверная сеть/учётка не
   * должна долбить сервер входами); `run` и `put` не повторяются никогда — `run` мог запустить 1cv8.
   * Отдельный ping перед `run` не нужен: исполнитель всегда начинает с `mktemp`, который и
   * переподнимает сессию.
   */
  private call(body: HostRequestBody): Promise<OkEvent> {
    return this.serialize(async () => {
      try {
        return await this.attempt(body);
      } catch (error) {
        // Отклонения хоста — всегда PowerShellHostError (см. send/start/markDead).
        const code = (error as PowerShellHostError).code;
        if (!RETRY_SAFE_OPS.has(body.op) || !RETRIABLE_CODES.has(code)) {
          throw error;
        }
        this.options.log?.(`[powershell] повтор «${body.op}» на новом процессе хоста после разрыва (${code}).`);
        return this.attempt(body);
      }
    });
  }

  private async attempt(body: HostRequestBody): Promise<OkEvent> {
    const proc = await this.ensureProcess();
    return this.request(proc, body);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => {
      if (this.disposed) {
        throw new PowerShellHostError('Хост PowerShell закрыт.', 'disposed');
      }
      return work();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private request(proc: HostProcess, body: HostRequestBody): Promise<OkEvent> {
    return this.send<OkEvent>(proc, this.nextId++, body, (event, resolve) => {
      if (event.event === 'ok') {
        resolve(event);
        return true;
      }
      return false;
    });
  }

  /**
   * Отправляет запрос и ждёт его завершающее событие. `handle` разбирает события своей операции
   * (возвращает `true`, когда операция завершена); `error`/`sessionBroken` обрабатываются здесь.
   */
  private send<T>(
    proc: HostProcess,
    id: number,
    body: HostRequestBody,
    handle: (event: HostEvent, resolve: (value: T) => void) => boolean
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Отправка идёт в том же синхронном участке, что и проверка живости в ensureProcess: событие
      // `exit` между ними обработаться не может, поэтому отдельной проверки `proc.dead` здесь нет.
      proc.pending.set(id, {
        reject,
        onEvent: (event) => {
          if (event.event === 'error') {
            reject(new PowerShellHostError(event.message, event.auth === true ? 'auth-failed' : 'remote-error'));
            return true;
          }
          if (event.event === 'sessionBroken') {
            reject(new PowerShellHostError(event.message, 'session-broken'));
            this.markDead(proc, undefined);
            return true;
          }
          return handle(event, resolve);
        },
      });
      this.write(proc, encodeHostRequest(id, body));
    });
  }

  private write(proc: HostProcess, line: string): void {
    proc.child.stdin.write(line);
  }

  private async ensureProcess(): Promise<HostProcess> {
    const existing = this.current;
    if (existing && isAlive(existing.child)) {
      return existing;
    }
    if (existing) {
      // Процесс умер в простое, а событие `exit` ещё не обработано: запрос в мёртвый stdin
      // отклонился бы `host-exited`, хотя сервер его не видел. Такой процесс заменяется сразу.
      this.markDead(existing, new PowerShellHostError('Процесс хоста PowerShell завершился.', 'host-exited'));
    }
    const proc = this.start();
    this.current = proc;
    const { connection } = this.options;
    await this.request(proc, {
      op: 'connect',
      computerName: connection.computerName,
      user: connection.user,
      passwordB64: Buffer.from(connection.password, 'utf-8').toString('base64'),
      authentication: connection.authentication,
      useSsl: connection.useSsl,
      port: connection.port,
    }).catch((error: unknown) => {
      // Неподключённый процесс не годится для следующих запросов: следующий запрос начнёт заново.
      this.markDead(proc, undefined);
      throw error;
    });
    return proc;
  }

  private start(): HostProcess {
    const command = this.options.powershellPath ?? 'powershell.exe';
    const spawnHost = this.options.spawn ?? defaultSpawn;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnHost(command, buildPowerShellHostArgs(), { env: this.options.env ?? process.env, windowsHide: true });
    } catch (error) {
      throw new PowerShellHostError(`Не удалось запустить PowerShell «${command}»: ${describeHostError(error)}`, 'spawn-failed');
    }
    const proc: HostProcess = { child, pending: new Map(), dead: false };
    this.living.add(proc);
    const parser = new HostOutputParser();
    let spawned = false;
    let exitHandled = false;

    const consume = (lines: () => HostLine[]): void => {
      try {
        for (const line of lines()) {
          this.dispatch(proc, line);
        }
      } catch (error) {
        // HostProtocolError или исключение колбэка вызывающего — в обоих случаях поток событий этого
        // процесса дальше не разобрать надёжно.
        this.markDead(proc, new PowerShellHostError(describeHostError(error), 'protocol'));
      }
    };

    child.on('spawn', () => { spawned = true; });
    child.stdout.on('data', (chunk: Buffer) => consume(() => parser.push(chunk)));
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf-8').split(/\r?\n/)) {
        if (line.trim()) {
          this.options.log?.(`[powershell][stderr] ${line}`);
        }
      }
    });
    // Ошибки записи в stdin умершего процесса придут событием `exit`; здесь они только гасятся,
    // иначе необработанный 'error' потока уронил бы процесс расширения.
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      /* c8 ignore start -- после успешного запуска Node выдаёт 'error' только при сбое kill/IPC процесса:
         детерминированно не воспроизводится; ветка сбоя запуска покрыта тестом с несуществующим powershellPath. */
      if (spawned) {
        this.markDead(proc, new PowerShellHostError(`Ошибка процесса хоста PowerShell: ${error.message}`, 'host-exited'));
        return;
      }
      /* c8 ignore stop */
      // Незапустившийся процесс события `exit` не даёт — ждать его выхода в dispose нечего.
      this.living.delete(proc);
      this.markDead(proc, new PowerShellHostError(`Не удалось запустить PowerShell «${command}»: ${error.message}`, 'spawn-failed'));
    });
    child.on('exit', (code) => {
      this.living.delete(proc);
      // Процесс негоден сразу (следующий запрос поднимет новый), а ожидающие запросы отклоняются
      // после дочитывания хвоста stdout: их ответ мог успеть уйти до выхода.
      this.markDead(proc, undefined);
      const fail = (): void => {
        if (exitHandled) {
          return;
        }
        exitHandled = true;
        clearTimeout(exitTimer);
        consume(() => parser.flush());
        this.markDead(proc, new PowerShellHostError(
          `Процесс хоста PowerShell завершился (код ${String(code)}) до ответа на запрос.`,
          'host-exited'
        ));
      };
      // Хвост stdout ещё может быть в пути: ждём конца потока, но не дольше EXIT_DRAIN_MS.
      const exitTimer = setTimeout(fail, EXIT_DRAIN_MS);
      if (child.stdout.readableEnded) {
        fail();
        return;
      }
      child.stdout.once('end', fail);
    });
    return proc;
  }

  private dispatch(proc: HostProcess, line: HostLine): void {
    if (line.kind === 'noise') {
      this.options.log?.(`[powershell] ${line.text}`);
      return;
    }
    const pending = proc.pending.get(line.event.id);
    if (pending?.onEvent(line.event)) {
      proc.pending.delete(line.event.id);
    }
  }

  /** Процесс больше не используется; ожидающие запросы отклоняются `error` (если задана). */
  private markDead(proc: HostProcess, error: PowerShellHostError | undefined): void {
    if (!proc.dead) {
      proc.dead = true;
      if (this.current === proc) {
        this.current = undefined;
      }
      // При закрытии хоста процесс завершается сам по закрытию stdin (скрипт успевает закрыть
      // PSSession); kill уже завершённого процесса безвреден.
      if (!this.disposed) {
        proc.child.kill();
      }
    }
    if (error) {
      const pending = [...proc.pending.values()];
      proc.pending.clear();
      for (const item of pending) {
        item.reject(error);
      }
    }
  }
}

/** Жив ли процесс сейчас: `exitCode` выставляется только после обработки события `exit`, это поздно. */
function isAlive(child: ChildProcessWithoutNullStreams): boolean {
  // Процесс с обработанным `exit` или без pid (сбой запуска) в `current` не задерживается — markDead
  // снимает его сразу, — поэтому достаточно сигнала 0: умерший, но ещё не обработанный, его не примет.
  try {
    process.kill(Number(child.pid), 0);
    return true;
  } catch {
    return false;
  }
}

const defaultSpawn: HostSpawn = (command, args, options) => nodeSpawn(command, args, options);

/** Текст ошибки для сообщений хоста и его потребителей: не-Error (строка, объект) — `String(error)`. */
export function describeHostError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
