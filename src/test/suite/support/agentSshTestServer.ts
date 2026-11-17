import { Server, utils, type Connection } from 'ssh2';

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
}

export class AgentSshTestServer {
  private passwordAttemptCount = 0;
  private rejectedSoFar = 0;
  private behavior: AgentAuthBehavior;
  private readonly clients = new Set<Connection>();

  private constructor(private readonly server: Server, readonly port: number, behavior: AgentAuthBehavior) {
    this.behavior = behavior;
  }

  static async start(options: AgentSshTestServerOptions = {}): Promise<AgentSshTestServer> {
    const hostKey = utils.generateKeyPairSync('ed25519').private;
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
    holder.instance = new AgentSshTestServer(server, port, options.behavior ?? { mode: 'accept' });
    return holder.instance;
  }

  private readonly inputWaiters: ((text: string) => void)[] = [];
  private jsonReplies = false;
  /** Строки команд, принятые каждым shell-каналом (по каналу на SSH-сессию), в порядке прихода. */
  readonly shellLog: string[][] = [];

  /**
   * Э4: эмуляция протокола агента — на каждую строку команды ответ `[{"type":"success"}]`.
   * Достаточно, чтобы транспорт и менеджер сессий прошли полный цикл команды.
   */
  enableJsonReplies(): void {
    this.jsonReplies = true;
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
    client.on('error', () => undefined);
    client.on('close', () => this.clients.delete(client));
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'password') {
        ctx.reject(['password']);
        return;
      }
      this.passwordAttemptCount += 1;
      if (this.shouldReject()) {
        ctx.reject(['password']);
        return;
      }
      ctx.accept();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          const log: string[] = [];
          this.shellLog.push(log);
          let pending = '';
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
              if (this.jsonReplies) {
                stream.write(`${JSON.stringify([{ type: 'success', message: line }])}\n`);
              }
            }
          });
        });
      });
    });
  }
}
