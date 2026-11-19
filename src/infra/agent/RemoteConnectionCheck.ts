import { randomBytes } from 'crypto';
import type { AgentConnectPolicyOptions } from '../../domain/agent';
import type { AgentConnectFailedError, AgentConnectFailureReason } from './AgentConnectRetry';
import {
  AGENT_CONNECT_IB_COMMAND,
  AGENT_DISCONNECT_IB_COMMAND,
  describeError,
  isInfoBaseAlreadyConnectedError,
  isInfoBaseNotConnectedError,
} from './AgentInfoBaseSession';
import type { DesignerAgentTransport } from './AgentTransport';
import { buildAgentSessionOptionsCommand } from './DesignerAgentSessionManager';
import type { AgentFileStore } from './files/AgentFileStore';
import { connectSftpAgentFileStore } from './files/SftpAgentFileStore';
import { SFTP_SUBSYSTEM_UNAVAILABLE_CODE } from './files/SftpConnection';
import {
  ProcessDesignerAgentTransportFactory,
  type DesignerAgentConnectionOptions,
  type DesignerAgentEndpointOptions,
} from './ProcessDesignerAgentTransport';

export type RemoteCheckPartId = 'ssh' | 'infobase' | 'sftp';
export type RemoteCheckStatus = 'ok' | 'failed' | 'skipped';
export type RemoteCheckFailureReason =
  | AgentConnectFailureReason
  | 'agent-error'
  | 'no-sftp-subsystem'
  | 'write-denied'
  | 'read-failed'
  | 'delete-failed';

export interface RemoteCheckPart {
  readonly id: RemoteCheckPartId;
  readonly status: RemoteCheckStatus;
  readonly reason?: RemoteCheckFailureReason;
  readonly message: string;
}

export interface RemoteConnectionReport {
  readonly ok: boolean;
  /** Всегда три части в порядке ssh, infobase, sftp. */
  readonly parts: readonly RemoteCheckPart[];
}

export interface RemoteConnectionCheckDeps {
  /** Шов под тест: обёртка над настоящим SFTP-хранилищем (подмена одной операции). */
  readonly wrapStore?: (store: AgentFileStore) => AgentFileStore;
  /** Уникальная часть имени пробного файла; по умолчанию — случайная. */
  readonly probeToken?: () => string;
}

/**
 * Диагностика — одна попытка на часть, без ожидания прогрева: проверка отвечает «что сейчас не так»,
 * а серия неудачных входов под логином 1С может заблокировать пользователя.
 */
const CHECK_POLICY: AgentConnectPolicyOptions = { startupTimeoutMs: 0, authWarmupMs: 0, retryDelayMs: 0 };

const PART_TITLES: Readonly<Record<RemoteCheckPartId, string>> = {
  ssh: 'SSH',
  infobase: 'Информационная база',
  sftp: 'SFTP',
};

const STATUS_MARKS: Readonly<Record<RemoteCheckStatus, string>> = {
  ok: '[OK]',
  failed: '[ОШИБКА]',
  skipped: '[ПРОПУЩЕНО]',
};

/**
 * Проверка подключения к удалённому агенту конфигуратора: SSH-вход, подключение/отключение
 * информационной базы и обмен файлами по SFTP. Агент не останавливается (транспорт закрывается
 * без `common shutdown`), пробный файл не остаётся на сервере. Пароль в отчёт не попадает: тексты
 * отказов подключения строит `describeConnectFailure`, который знает только хост, порт и логин.
 */
export async function checkRemoteAgentConnection(
  options: DesignerAgentEndpointOptions,
  deps: RemoteConnectionCheckDeps = {}
): Promise<RemoteConnectionReport> {
  const endpoint = `${options.host}:${String(options.port)}`;
  // agentStartedAt сброшен явно: без опорной точки auth-отказ — сразу «неверный пароль», без повторов.
  const connection: DesignerAgentConnectionOptions = {
    ...options,
    policy: CHECK_POLICY,
    agentStartedAt: undefined,
    shutdownOnDispose: false,
  };

  let transport: DesignerAgentTransport;
  try {
    transport = await new ProcessDesignerAgentTransportFactory(connection).create();
  } catch (error) {
    // Повторные входы под тем же логином ничего не добавят к диагнозу, а риск блокировки увеличат.
    const skippedMessage = 'Пропущено: SSH-вход к агенту не выполнен.';
    return buildReport([
      failed('ssh', connectFailureReason(error), describeError(error)),
      { id: 'infobase', status: 'skipped', message: skippedMessage },
      { id: 'sftp', status: 'skipped', message: skippedMessage },
    ]);
  }

  const ssh: RemoteCheckPart = {
    id: 'ssh',
    status: 'ok',
    message: `SSH-вход к агенту конфигуратора на ${endpoint} под пользователем «${options.user}» выполнен.`,
  };
  let infobase: RemoteCheckPart;
  try {
    infobase = await checkInfoBase(transport);
  } finally {
    // shutdownOnDispose: false — закрывается только SSH, агент продолжает работать.
    await transport.dispose();
  }
  const sftp = await checkSftp(connection, endpoint, deps);
  return buildReport([ssh, infobase, sftp]);
}

/** По строке на часть: `[OK] SSH: …`, `[ОШИБКА] SFTP: …`, `[ПРОПУЩЕНО] …`. */
export function formatRemoteConnectionReport(report: RemoteConnectionReport): string[] {
  return report.parts.map((part) => `${STATUS_MARKS[part.status]} ${PART_TITLES[part.id]}: ${part.message}`);
}

function buildReport(parts: RemoteCheckPart[]): RemoteConnectionReport {
  return { ok: parts.every((part) => part.status === 'ok'), parts };
}

function failed(id: RemoteCheckPartId, reason: RemoteCheckFailureReason, message: string): RemoteCheckPart {
  return { id, status: 'failed', reason, message };
}

// Цикл подключения отказывает только AgentConnectFailedError (AgentConnectRetryLoop.run).
function connectFailureReason(error: unknown): AgentConnectFailureReason {
  return (error as AgentConnectFailedError).reason;
}

async function checkInfoBase(transport: DesignerAgentTransport): Promise<RemoteCheckPart> {
  try {
    await transport.execute(buildAgentSessionOptionsCommand(0.5));
  } catch (error) {
    // До connect-ib: агент отверг настройки сессии (другая версия платформы), база тут ни при чём.
    return failed('infobase', 'agent-error', `Агент не принял настройки сессии (options set): ${describeError(error)}`);
  }
  try {
    await transport.execute(AGENT_CONNECT_IB_COMMAND);
  } catch (error) {
    if (isInfoBaseAlreadyConnectedError(error)) {
      // Подключение принадлежит другому сеансу (например, идущей операции): отключать его нельзя.
      return { id: 'infobase', status: 'ok', message: 'Информационная база уже подключена к агенту; подключение не тронуто.' };
    }
    return failed('infobase', 'agent-error', `Агент не подключил информационную базу: ${describeError(error)}`);
  }
  try {
    await transport.execute(AGENT_DISCONNECT_IB_COMMAND);
  } catch (error) {
    if (!isInfoBaseNotConnectedError(error)) {
      return failed('infobase', 'agent-error', `Агент не отключил информационную базу: ${describeError(error)}`);
    }
  }
  return { id: 'infobase', status: 'ok', message: 'Информационная база подключается и отключается агентом.' };
}

async function checkSftp(
  connection: DesignerAgentConnectionOptions,
  endpoint: string,
  deps: RemoteConnectionCheckDeps
): Promise<RemoteCheckPart> {
  let store: AgentFileStore;
  try {
    const opened = await connectSftpAgentFileStore(connection);
    store = deps.wrapStore ? deps.wrapStore(opened) : opened;
  } catch (error) {
    // Причина отказа подключения — исходная ошибка попытки (всегда Error, см. openSftpAttempt).
    const cause = (error as Error).cause as { readonly code?: unknown };
    if (cause.code === SFTP_SUBSYSTEM_UNAVAILABLE_CODE) {
      return failed(
        'sftp',
        'no-sftp-subsystem',
        `Агент конфигуратора на ${endpoint} не открыл подсистему SFTP: обмен файлами с удалённым агентом невозможен.`
      );
    }
    return failed('sftp', connectFailureReason(error), describeError(error));
  }
  try {
    return await probeStore(store, endpoint, deps.probeToken ?? randomToken);
  } finally {
    await store.dispose();
  }
}

/** Пробный файл в каталоге обмена: запись, чтение со сверкой, удаление и проверка отсутствия. */
async function probeStore(store: AgentFileStore, endpoint: string, token: () => string): Promise<RemoteCheckPart> {
  const rel = `exchange/.v8vscedit-check-${token()}.tmp`;
  const payload = Buffer.from(`v8vscedit: проверка обмена файлами ${rel}`, 'utf-8');
  const where = `«${rel}» на ${endpoint}`;

  try {
    await store.writeFile(rel, payload);
  } catch (error) {
    await removeQuietly(store, rel);
    return failed('sftp', 'write-denied', `Не удалось записать пробный файл ${where}: ${describeError(error)}`);
  }

  let readFailure: string | undefined;
  try {
    const back = await store.readFile(rel);
    if (!back.equals(payload)) {
      readFailure = `Прочитанный пробный файл ${where} не совпадает с записанным.`;
    }
  } catch (error) {
    readFailure = `Не удалось прочитать пробный файл ${where}: ${describeError(error)}`;
  }
  if (readFailure !== undefined) {
    await removeQuietly(store, rel);
    return failed('sftp', 'read-failed', readFailure);
  }

  let leftover: boolean;
  try {
    await store.remove(rel);
    leftover = await store.stat(rel) !== undefined;
  } catch (error) {
    return failed('sftp', 'delete-failed', `Не удалось удалить пробный файл ${where}: ${describeError(error)}`);
  }
  if (leftover) {
    return failed('sftp', 'delete-failed', `Пробный файл ${where} остался после удаления.`);
  }
  return { id: 'sftp', status: 'ok', message: `Обмен файлами по SFTP на ${endpoint} работает: запись, чтение и удаление.` };
}

/** Уборка пробного файла после отказа: исход проверки определяет исходная ошибка, а не уборка. */
async function removeQuietly(store: AgentFileStore, rel: string): Promise<void> {
  try {
    await store.remove(rel);
  } catch {
    // остаток пробного файла безвреден: имя уникально, следующая проверка возьмёт другое
  }
}

function randomToken(): string {
  return randomBytes(6).toString('hex');
}
