import { Client, type SFTPWrapper } from 'ssh2';
import { AgentConnectRetryLoop } from '../AgentConnectRetry';
import {
  buildSshConnectConfig,
  type DesignerAgentConnectionOptions,
  type DesignerAgentEndpointOptions,
  type DesignerAgentSshClient,
  type DesignerAgentTransportFactoryDeps,
} from '../ProcessDesignerAgentTransport';
import { SSH_CLOSED_BEFORE_READY_CODE } from '../SshConnectErrorClassifier';

/** SSH-клиент, умеющий открыть SFTP-подсистему (ssh2 `Client` подходит как есть). */
export interface DesignerAgentSftpClient extends DesignerAgentSshClient {
  on(event: 'ready' | 'close' | 'end', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  sftp(callback: (error: Error | undefined, sftp: SFTPWrapper) => void): this;
}

export interface SftpConnectionDeps extends DesignerAgentTransportFactoryDeps {
  readonly createClient?: () => DesignerAgentSftpClient;
}

/** Код статуса SFTP v3 «общий отказ» (стандартный сервер так отвечает и на RENAME в занятую цель). */
export const SFTP_FAILURE = 4;
/** Код статуса SFTP v3 «нет такого файла». */
export const SFTP_NO_SUCH_FILE = 2;
/** Код статуса SFTP v3 «операция не поддерживается». */
export const SFTP_OP_UNSUPPORTED = 8;

/**
 * Признак «SSH вошёл, но подсистема SFTP не открылась»: по нему диагностика отличает агент без SFTP
 * от прочих отказов, не разбирая текст сообщения.
 */
export const SFTP_SUBSYSTEM_UNAVAILABLE_CODE = 'ERR_AGENT_SFTP_SUBSYSTEM_UNAVAILABLE';

/** Числовой код статуса SFTP из ошибки ssh2 (`err.code`); у прочих ошибок — `undefined`. */
export function sftpStatusCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

/**
 * Одно SSH-соединение с одной SFTP-сессией к агенту конфигуратора.
 *
 * SFTP — ОТДЕЛЬНОЕ SSH-соединение от shell-транспорта: агент даёт один канал на соединение
 * (факт пилота §5b). Соединение не реанимируется: потерянное — потеряно до dispose, хранилище
 * создаётся заново.
 *
 * Каждый запрос регистрируется в `pending` до отправки: ssh2 не отвечает на запрос, отправленный
 * в уже закрытый канал (он лишь кладёт его в очередь), и на CLOSE, который сам ssh2 шлёт после
 * сбоя READDIR при обрыве, — без принудительного отказа по событию потери такие запросы висели
 * бы вечно.
 */
export class SftpConnection {
  private readonly pending = new Set<(error: Error) => void>();
  private disposed = false;
  private lost = false;

  constructor(private readonly client: DesignerAgentSftpClient, private readonly sftp: SFTPWrapper) {
    const onLost = () => this.markLost();
    client.on('close', onLost);
    client.on('end', onLost);
    client.on('error', onLost);
    sftp.on('close', onLost);
    sftp.on('end', onLost);
    sftp.on('error', onLost);
  }

  /** Отказ, если хранилище закрыто или соединение потеряно: операция не начинается вовсе. */
  assertUsable(): void {
    const error = this.stateError();
    if (error) {
      throw error;
    }
  }

  /** Выполняет один вызов SFTPWrapper; отказ — ошибкой ssh2 (с числовым `code`) или ошибкой состояния. */
  request<T>(call: (sftp: SFTPWrapper, done: (error: Error | null | undefined, value: T) => void) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const stateError = this.stateError();
      if (stateError) {
        reject(stateError);
        return;
      }
      // Повторный resolve/reject промиса — no-op, поэтому отказ по потере соединения и поздний
      // колбэк ssh2 (cleanupRequests с «No response from server») не мешают друг другу.
      const fail = (error: Error) => reject(error);
      this.pending.add(fail);
      try {
        call(this.sftp, (error, value) => {
          this.pending.delete(fail);
          if (error) {
            reject(error);
          } else {
            resolve(value);
          }
        });
      } catch (error) {
        // ssh2 бросает синхронно на неверных аргументах: запрос не ушёл, ждать его потери незачем.
        this.pending.delete(fail);
        fail(error as Error);
      }
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.rejectPending(closedError());
    this.client.end();
  }

  private markLost(): void {
    if (this.lost) {
      return;
    }
    this.lost = true;
    this.rejectPending(lostError());
  }

  private rejectPending(error: Error): void {
    const waiting = [...this.pending];
    this.pending.clear();
    for (const fail of waiting) {
      fail(error);
    }
  }

  private stateError(): Error | undefined {
    if (this.disposed) {
      return closedError();
    }
    return this.lost ? lostError() : undefined;
  }
}

function closedError(): Error {
  return new Error('Хранилище агента (SFTP) закрыто.');
}

function lostError(): Error {
  return new Error('SFTP-соединение с агентом потеряно; нужно новое подключение хранилища.');
}

/**
 * Подключение по политике повторов Э3 (тот же цикл, что у shell-транспорта): попытка — SSH до
 * готовности плюс открытие SFTP-подсистемы; при отказе соединение попытки закрывается.
 */
export function connectSftp(options: DesignerAgentConnectionOptions, deps: SftpConnectionDeps = {}): Promise<SftpConnection> {
  const createClient = deps.createClient ?? (() => new Client());
  return new AgentConnectRetryLoop(options, deps).run(() => openSftpAttempt(options, createClient));
}

function openSftpAttempt(
  options: DesignerAgentEndpointOptions,
  createClient: () => DesignerAgentSftpClient
): Promise<SftpConnection> {
  return new Promise<SftpConnection>((resolve, reject) => {
    const client = createClient();
    let settled = false;
    const settle = (outcome: { readonly error: Error } | { readonly sftp: SFTPWrapper }) => {
      if (settled) {
        return;
      }
      settled = true;
      if ('error' in outcome) {
        client.end();
        reject(outcome.error);
        return;
      }
      resolve(new SftpConnection(client, outcome.sftp));
    };
    const fail = (error: Error) => settle({ error });
    client.on('ready', () => {
      client.sftp((error, sftp) => {
        settle(error
          ? {
            error: Object.assign(
              new Error(`Агент конфигуратора не открыл подсистему SFTP: ${error.message}`, { cause: error }),
              { code: SFTP_SUBSYSTEM_UNAVAILABLE_CODE }
            ),
          }
          : { sftp });
      });
    });
    client.on('error', fail);
    client.on('close', () => {
      // ssh2 при обрыве во время KEX/auth даёт только 'close' без 'error' — как у shell-транспорта.
      fail(Object.assign(new Error('SSH-соединение с агентом закрыто до готовности.'), {
        code: SSH_CLOSED_BEFORE_READY_CODE,
      }));
    });
    // buildSshConnectConfig бросает синхронно (нет файла ключа) — исполнитель промиса превращает это в отказ.
    try {
      client.connect(buildSshConnectConfig(options));
    } catch (error) {
      fail(error as Error);
    }
  });
}
