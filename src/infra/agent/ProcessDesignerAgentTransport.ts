import { EventEmitter } from 'events';
import * as fs from 'fs';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import type { AgentConnectPolicyOptions, AgentMessage } from '../../domain/agent';
import { getAgentMessageText, isTerminalAgentMessage } from '../../domain/agent';
import { SSH_CLOSED_BEFORE_READY_CODE } from './SshConnectErrorClassifier';
import { AgentConnectRetryLoop, type AgentConnectRetryDeps } from './AgentConnectRetry';
import { DesignerAgentJsonReader } from './DesignerAgentJsonReader';
import type { AgentCommandHooks, AgentCommandResult, DesignerAgentTransport, DesignerAgentTransportFactory } from './AgentTransport';
import { AgentCommandError } from './AgentTransport';

export interface DesignerAgentSshClient {
  on(event: 'ready' | 'close', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  shell(windows: false, callback: (error: Error | undefined, channel: ClientChannel) => void): void;
  connect(config: ConnectConfig): void;
  end(): void;
}

/** Параметры одного SSH-подключения: всё, что нужно транспорту для единственной попытки. */
export interface DesignerAgentEndpointOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password?: string;
  readonly privateKeyPath?: string;
  readonly connectTimeoutSeconds?: number;
  /**
   * `false` — `dispose()` закрывает канал и SSH, не отправляя `common shutdown`. Нужно для агента,
   * которого запустил не расширение (удалённый сервер): смена настроек или выход из VS Code не
   * должны гасить чужой процесс. По умолчанию `true` — свой локальный агент останавливается.
   */
  readonly shutdownOnDispose?: boolean;
}

/** Параметры фабрики: конечная точка плюс политика повторов — повторы решает только фабрика. */
export interface DesignerAgentConnectionOptions extends DesignerAgentEndpointOptions {
  readonly policy: AgentConnectPolicyOptions;
  /** Момент старта локально запущенного агента: открывает окно прогрева для auth-отказов. */
  readonly agentStartedAt?: number;
}

export interface DesignerAgentTransportFactoryDeps extends AgentConnectRetryDeps {
  readonly createClient?: () => DesignerAgentSshClient;
}

export class ProcessDesignerAgentTransportFactory implements DesignerAgentTransportFactory {
  // Цикл повторов живёт столько же, сколько фабрика: состояние конечной точки (lastRefusedAt)
  // переносится между вызовами create().
  private readonly retry: AgentConnectRetryLoop;
  private readonly createClient: () => DesignerAgentSshClient;

  constructor(private readonly options: DesignerAgentConnectionOptions, deps: DesignerAgentTransportFactoryDeps = {}) {
    this.retry = new AgentConnectRetryLoop(options, deps);
    this.createClient = deps.createClient ?? (() => new Client());
  }

  create(): Promise<DesignerAgentTransport> {
    return this.retry.run(async () => {
      const transport = new ProcessDesignerAgentTransport(this.options, this.createClient);
      try {
        await transport.connect();
        return transport;
      } catch (error) {
        await transport.reset();
        throw error;
      }
    });
  }
}

export class ProcessDesignerAgentTransport implements DesignerAgentTransport {
  private client: DesignerAgentSshClient | undefined;
  private channel: ClientChannel | undefined;
  private connectPromise: Promise<void> | undefined;
  private readonly output = new EventEmitter();
  private readonly reader = new DesignerAgentJsonReader();
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private closeEmitted = false;
  // Соединение, однажды поднятое и потерянное (close/error SSH-клиента), не реанимируется
  // внутри этого объекта: новый SSH требует заново `options set` (его шлёт менеджер сессий)
  // и `connect-ib` (подключение ИБ не переживает закрытие SSH-сессии, план §5b п.1).
  private lost = false;

  constructor(
    private readonly options: DesignerAgentEndpointOptions,
    private readonly createClient: () => DesignerAgentSshClient = () => new Client()
  ) {}

  async connect(): Promise<void> {
    if (this.channel) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    // disposed не сбрасываем здесь: после reset()/dispose() сессия считается
    // выброшенной, и команда из очереди не должна реанимировать её через connect().
    this.assertUsable();

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const client = this.createClient();
      this.client = client;
      let settled = false;

      const settle = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };

      client.on('ready', () => {
        client.shell(false, (error, channel) => {
          if (error) {
            settle(error);
            return;
          }
          this.closeEmitted = false;
          this.channel = channel;
          channel.on('data', (chunk: Buffer) => this.handleStdout(chunk));
          channel.stderr.on('data', (chunk: Buffer) => this.output.emit('stderr', chunk.toString('utf-8')));
          channel.on('close', () => this.handleClose());
          settle();
        });
      });
      client.on('error', (error) => {
        // Ошибка ПОСЛЕ готовности — соединение потеряно уже сейчас, не дожидаясь 'close' (Н13):
        // команда, пришедшая между 'error' и 'close', иначе ушла бы в мёртвый канал.
        if (settled) {
          this.lost = true;
        }
        // Сначала отказ connect(): на этапе подключения у output нет слушателей 'error', и
        // EventEmitter бросил бы прямо отсюда — промис connect() так и не отклонился бы.
        settle(error);
        // Слушатель есть только у выполняющейся команды; вне её ошибку сообщит последующий 'close'.
        if (this.output.listenerCount('error') > 0) {
          this.output.emit('error', error);
        }
      });
      client.on('close', () => {
        // ssh2 при обрыве во время KEX/auth (и при DISCONNECT BY_APPLICATION) даёт только 'close'
        // без 'error' и снимает readyTimeout: без отказа здесь connect() не завершился бы никогда.
        // После готовности settle — no-op.
        settle(Object.assign(new Error('SSH-соединение с агентом закрыто до готовности.'), {
          code: SSH_CLOSED_BEFORE_READY_CODE,
        }));
        this.handleClose();
      });
      client.connect(buildSshConnectConfig(this.options));
    });

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  async execute(command: string, hooks?: AgentCommandHooks): Promise<AgentCommandResult> {
    this.queue = this.queue
      .catch(() => undefined)
      .then(() => this.executeQueued(command, hooks));
    return this.queue as Promise<AgentCommandResult>;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    if (!this.client) {
      return Promise.resolve();
    }
    if (this.options.shutdownOnDispose !== false) {
      this.channel?.write('common shutdown\n');
    }
    this.channel?.end();
    this.client.end();
    this.channel = undefined;
    this.client = undefined;
    return Promise.resolve();
  }

  reset(): Promise<void> {
    if (!this.client) {
      return Promise.resolve();
    }
    this.disposed = true;
    this.reader.reset();
    this.channel?.end();
    this.client.end();
    this.channel = undefined;
    this.client = undefined;
    return Promise.resolve();
  }

  /** Транспорт выброшен (reset/dispose) или его SSH-соединение потеряно — нужен новый экземпляр. */
  isClosed(): boolean {
    return this.disposed || this.lost;
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new Error('Сессия агента уже закрыта.');
    }
    if (this.lost) {
      throw new Error('SSH-соединение с агентом потеряно; команда не отправлена, нужна новая сессия.');
    }
  }

  private async executeQueued(command: string, hooks?: AgentCommandHooks): Promise<AgentCommandResult> {
    this.assertUsable();
    await this.connect();
    const channel = this.requireChannel();
    const messages: AgentMessage[] = [];

    return new Promise<AgentCommandResult>((resolve, reject) => {
      const cleanup = () => {
        this.output.off('messages', onMessages);
        this.output.off('stderr', onStderr);
        this.output.off('error', onError);
        this.output.off('close', onClose);
      };

      const onMessages = (batch: AgentMessage[]) => {
        void this.handleMessages(batch, messages, hooks)
          .then((terminal) => {
            if (!terminal) {
              return;
            }
            cleanup();
            const last = messages.at(-1);
            if (last?.type === 'error' || last?.type === 'canceled') {
              reject(new AgentCommandError(getAgentMessageText(last), command, last));
              return;
            }
            resolve({ messages });
          })
          .catch((error: unknown) => {
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      };

      const onStderr = (text: string) => {
        if (text.trim()) {
          hooks?.onMessage?.({ type: 'log', message: text.trim() });
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = (code: number) => {
        cleanup();
        reject(new Error(`SSH-соединение с агентом закрыто с кодом ${String(code)}.`));
      };

      this.output.on('messages', onMessages);
      this.output.on('stderr', onStderr);
      this.output.on('error', onError);
      this.output.on('close', onClose);
      channel.write(`${command}\n`);
    });
  }

  private async handleMessages(
    batch: AgentMessage[],
    target: AgentMessage[],
    hooks?: AgentCommandHooks
  ): Promise<boolean> {
    let terminal = false;
    for (const message of batch) {
      target.push(message);
      hooks?.onMessage?.(message);
      if (message.type === 'question') {
        const answer = await hooks?.onQuestion?.(message);
        if (answer !== undefined) {
          this.requireChannel().write(`${answer}\n`);
        }
      }
      terminal = isTerminalAgentMessage(message) || terminal;
    }
    return terminal;
  }

  private handleStdout(chunk: Buffer): void {
    for (const batch of this.reader.push(chunk)) {
      this.output.emit('messages', batch);
    }
  }

  private handleClose(): void {
    this.lost = true;
    this.channel = undefined;
    this.client = undefined;
    if (!this.disposed && !this.closeEmitted) {
      this.closeEmitted = true;
      this.output.emit('close', 255);
    }
  }

  private requireChannel(): ClientChannel {
    if (!this.channel) {
      throw new Error('SSH-соединение с агентом не установлено.');
    }
    return this.channel;
  }
}

/**
 * Keepalive SSH. Долгая команда агента (полная выгрузка БП — десятки минут) идёт без единого байта по
 * соединению, и промежуточное оборудование (межсетевой экран, VPN, NAT) закрывает простаивающее
 * TCP-соединение: ответ агента не доходит, а клиент без keepalive ждёт его вечно (стенд пользователя:
 * агент закончил перезапись зеркала, расширение висело). Пакеты раз в 15 с держат соединение живым.
 *
 * Допуск пропусков — практически бесконечный (12 ч): агент 1С (libssh) НЕ отвечает на keepalive, пока
 * выполняет команду (эксперимент 22: при допуске 3 соединение рвалось через 4 с долгой загрузки; при
 * огромном допуске 25 мин долгой команды и ~1500 запросов без ответа — соединение цело). Малый допуск
 * обрывал бы любую команду длиннее минуты. Обнаружение мёртвого соединения keepalive здесь не даёт —
 * это задача таймаута команды по отсутствию прогресса (бэклог).
 */
export const SSH_KEEPALIVE_INTERVAL_MS = 15_000;
export const SSH_KEEPALIVE_COUNT_MAX = 2_880;

export function buildSshConnectConfig(options: DesignerAgentEndpointOptions): ConnectConfig {
  const config: ConnectConfig = {
    host: options.host,
    port: options.port,
    username: options.user,
    password: options.password ?? '',
    readyTimeout: (options.connectTimeoutSeconds ?? 10) * 1000,
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
  };
  if (options.privateKeyPath) {
    config.privateKey = fs.readFileSync(options.privateKeyPath, 'utf-8');
  }
  return config;
}
