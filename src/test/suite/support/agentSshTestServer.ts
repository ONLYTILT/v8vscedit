import { Server, utils, type Connection } from 'ssh2';
import { SftpTestBackend } from './agentSftpTestBackend';

/**
 * Эмулятор SSH-стороны агента конфигуратора 1С (in-process ssh2.Server).
 *
 * Агент 1С (`1cv8 DESIGNER /AgentMode`) — внешняя система, в CI её нет, поэтому реальный SSH-слой
 * проверяется против настоящего ssh2-сервера на 127.0.0.1. Эмулятор намеренно минимален: парольная
 * аутентификация с управляемым поведением и shell-канал, который просто открывается. Эмуляция
 * протокола команд агента (JSON-сообщения) понадобится с Э4 и добавляется сюда же.
 */

export type AgentAuthBehavior =
  | { readonly mode: 'accept' }
  | { readonly mode: 'reject-first'; readonly count: number }
  | { readonly mode: 'reject-all' };

export interface AgentSshTestServerOptions {
  /** 0 или не задан — свободный порт; конкретный номер нужен сценариям «порт сначала закрыт». */
  readonly port?: number;
  readonly behavior?: AgentAuthBehavior;
  /** Э6: корневой каталог настоящего SFTP; не задан — подсистема `sftp` отклоняется, как агентом без SFTP. */
  readonly sftpRoot?: string;
}

/** Сообщение агента в проводном формате (`type`, `message`, `error-type`, …). */
export type AgentWireMessage = Readonly<Record<string, unknown>>;
export type ShellResponder = (line: string) => Promise<readonly AgentWireMessage[]>;

async function respondWith(
  responder: ShellResponder,
  line: string,
  stream: { write(data: string): unknown }
): Promise<void> {
  let messages: readonly AgentWireMessage[];
  try {
    const answered = await responder(line);
    messages = answered.length > 0 ? answered : [{ type: 'success' }];
  } catch (error) {
    const finalMessage = (error as { finalMessage?: AgentWireMessage }).finalMessage;
    messages = [finalMessage ?? { type: 'error', message: (error as Error).message }];
  }
  stream.write(`${JSON.stringify(messages)}\n`);
}

export class AgentSshTestServer {
  private passwordAttemptCount = 0;
  private rejectedSoFar = 0;
  private behavior: AgentAuthBehavior;
  private readonly clients = new Set<Connection>();

  /** Э6: SFTP-сторона (журнал операций, управление поведением); `undefined`, если `sftpRoot` не задан. */
  readonly sftp: SftpTestBackend | undefined;
  private clientCountWaiters: { count: number; resolve: () => void }[] = [];

  private constructor(
    private readonly server: Server,
    readonly port: number,
    behavior: AgentAuthBehavior,
    sftpRoot: string | undefined
  ) {
    this.behavior = behavior;
    this.sftp = sftpRoot === undefined ? undefined : new SftpTestBackend(sftpRoot);
  }

  /** Число открытых SSH-соединений (shell и SFTP — разные соединения, факт пилота §5b). */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Резолвится, когда число открытых SSH-соединений стало равно `count` (в т.ч. сразу, если уже равно). */
  whenClientCount(count: number): Promise<void> {
    if (this.clients.size === count) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.clientCountWaiters.push({ count, resolve }));
  }

  private notifyClientCount(): void {
    const ready = this.clientCountWaiters.filter((waiter) => waiter.count === this.clients.size);
    this.clientCountWaiters = this.clientCountWaiters.filter((waiter) => !ready.includes(waiter));
    for (const waiter of ready) {
      waiter.resolve();
    }
  }

  static async start(options: AgentSshTestServerOptions = {}): Promise<AgentSshTestServer> {
    const hostKey = getHostKey();
    const holder: { instance?: AgentSshTestServer } = {};
    const server = new Server({ hostKeys: [hostKey] }, (client) => holder.instance?.handleClient(client));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    // listen на TCP всегда даёт объект с портом; строка бывает только у unix-сокета.
    const port = typeof address === 'object' && address ? address.port : 0;
    holder.instance = new AgentSshTestServer(server, port, options.behavior ?? { mode: 'accept' }, options.sftpRoot);
    return holder.instance;
  }

  private readonly inputWaiters: ((text: string) => void)[] = [];
  private jsonReplies = false;
  private shellResponder: ShellResponder | undefined;
  /** Пароли всех парольных попыток входа, в порядке прихода: так проверяется, ЧТО именно клиент отправил агенту. */
  readonly passwordsSeen: string[] = [];
  /** Строки команд, принятые каждым shell-каналом (по каналу на SSH-сессию), в порядке прихода. */
  readonly shellLog: string[][] = [];

  /**
   * Э4: эмуляция протокола агента — на каждую строку команды ответ `[{"type":"success"}]`.
   * Достаточно, чтобы транспорт и менеджер сессий прошли полный цикл команды.
   */
  enableJsonReplies(): void {
    this.jsonReplies = true;
  }

  /**
   * Э8: ответы агента на строки команд даёт обработчик (например, эмулятор команд конфигуратора).
   * Он возвращает сообщения агента; отклонённый промис превращается в `error`-сообщение
   * (у ошибки с `finalMessage` — оно само). Ответы идут строго по очереди, как у однопоточного агента.
   */
  setShellResponder(responder: ShellResponder): void {
    this.shellResponder = responder;
  }

  /** Неожиданный обрыв со стороны агента: сервер закрывает все SSH-соединения, сам продолжая слушать порт. */
  dropClients(): void {
    for (const client of this.clients) {
      client.end();
    }
  }

  /** Резолвится текстом следующего ввода клиента в shell-канал (строка команды агента). */
  nextShellInput(): Promise<string> {
    return new Promise((resolve) => this.inputWaiters.push(resolve));
  }

  /** Число попыток именно парольной аутентификации (метод `none` клиент ssh2 шлёт всегда — не считаем). */
  get passwordAttempts(): number {
    return this.passwordAttemptCount;
  }

  setBehavior(behavior: AgentAuthBehavior): void {
    this.behavior = behavior;
    this.rejectedSoFar = 0;
  }

  resetAttempts(): void {
    this.passwordAttemptCount = 0;
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    this.sftp?.closeAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private shouldReject(): boolean {
    if (this.behavior.mode === 'accept') {
      return false;
    }
    if (this.behavior.mode === 'reject-all') {
      return true;
    }
    if (this.rejectedSoFar < this.behavior.count) {
      this.rejectedSoFar += 1;
      return true;
    }
    return false;
  }

  private handleClient(client: Connection): void {
    this.clients.add(client);
    this.notifyClientCount();
    client.on('error', () => undefined);
    client.on('close', () => {
      this.clients.delete(client);
      this.notifyClientCount();
    });
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'password') {
        ctx.reject(['password']);
        return;
      }
      this.passwordAttemptCount += 1;
      this.passwordsSeen.push(ctx.password);
      if (this.shouldReject()) {
        ctx.reject(['password']);
        return;
      }
      ctx.accept();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp, rejectSftp) => {
          if (this.sftp) {
            this.sftp.attach(acceptSftp());
          } else {
            rejectSftp();
          }
        });
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          const log: string[] = [];
          this.shellLog.push(log);
          let pending = '';
          let replyQueue: Promise<void> = Promise.resolve();
          // Строки команд транспорта: тесты ждут их, чтобы действовать в момент «команда ушла, ответа нет».
          stream.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf-8');
            const waiter = this.inputWaiters.shift();
            if (waiter) {
              waiter(text);
            }
            pending += text;
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            for (const line of lines) {
              log.push(line);
              const responder = this.shellResponder;
              if (responder) {
                replyQueue = replyQueue.then(() => respondWith(responder, line, stream));
              } else if (this.jsonReplies) {
                stream.write(`${JSON.stringify([{ type: 'success', message: line }])}\n`);
              }
            }
          });
        });
      });
    });
  }
}

let cachedHostKey: string | undefined;

/**
 * Ключ хоста один на прогон: генерация на каждый сервер медленна, а ssh2 изредка выдаёт ed25519-ключ,
 * который сам же не может разобрать («Malformed OpenSSH private key») — при десятках серверов на прогон
 * это давало случайные падения. Поэтому ключ проверяется разбором и при браке генерируется заново.
 */
function getHostKey(): string {
  while (cachedHostKey === undefined) {
    const candidate = utils.generateKeyPairSync('ed25519').private;
    if (!(utils.parseKey(candidate) instanceof Error)) {
      cachedHostKey = candidate;
    }
  }
  return cachedHostKey;
}
