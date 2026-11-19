// Перенесено из ExtensionCommandRunner.ts (Э2) без изменения поведения; публичный API реэкспортируется оттуда.
import * as vscode from 'vscode';
import type { DesignerAgentEndpointOptions, DesignerAgentInfoBaseConnection } from '../../../../infra/agent';
import { DEFAULT_ARCHIVE_THRESHOLD_FILES } from '../../../../infra/agent/sync/AgentSyncEngine';
import { nonEmptyString, type ConnectionParams } from '../connectionSettings';

/** Где работает агент: `local` — запускает расширение на этой машине, `remote` — уже запущен на сервере. */
export type AgentLocation = 'local' | 'remote';

/** Как выполняются операции с конфигурацией: пакетным Конфигуратором или через агент. */
export type AgentExecutionMode = 'batch' | 'agent';

const DEFAULT_TRANSFER_CONCURRENCY = 16;
const MAX_TRANSFER_CONCURRENCY = 64;
// Удалённый агент проверяет логин/пароль обращением к клиент-серверной базе: на стенде пилота вход
// стабильно дольше 10 с (прежний зашитый readyTimeout), при обмене ключами за 0,7 с.
const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;

export interface AgentCommandSettings {
  readonly host: string;
  readonly listenAddress: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly privateKeyPath: string;
  readonly visible: boolean;
  readonly autoStart: boolean;
  readonly agentModeArgs: readonly string[];
  readonly progressInterval: number;
  readonly startupTimeoutMs: number;
  readonly authWarmupMs: number;
  /** Предел одной попытки SSH: TCP + обмен ключами + вход (readyTimeout ssh2), мс. */
  readonly connectTimeoutMs: number;
  /** Простой агента (минуты), после которого база отпускается сама; 0 — держать до явного release. */
  readonly idleDisconnectMinutes: number;
  readonly location: AgentLocation;
  /** Одновременных передач файлов по SFTP/локально (1…64). */
  readonly transferConcurrency: number;
  /** Число изменённых файлов, начиная с которого объекты передаются архивом, а не дельтой. */
  readonly archiveThresholdFiles: number;
}

export function isAgentConfigurationOperationMode(): boolean {
  const mode = vscode.workspace
    .getConfiguration('v8vscedit.configuration')
    .get<string>('operationMode', 'batch');
  return mode === 'agent';
}

/**
 * Режим выполнения по месту агента и `v8vscedit.configuration.operationMode`. Удалённый агент без
 * агентского режима — противоречие настроек: молча уйти в локальный пакетный Конфигуратор значило бы
 * выполнить операцию не с той базой и не на той машине, поэтому — явная ошибка.
 */
export function resolveAgentExecutionMode(location: AgentLocation, operationMode: string | undefined): AgentExecutionMode {
  if (operationMode === 'agent') {
    return 'agent';
  }
  if (location === 'remote') {
    throw new Error(
      'Удалённый агент конфигуратора (v8vscedit.agent.location = "remote") работает только в агентском режиме: ' +
      'задайте v8vscedit.configuration.operationMode = "agent" или верните v8vscedit.agent.location = "local".'
    );
  }
  return 'batch';
}

export function getAgentExecutionMode(): AgentExecutionMode {
  const operationMode = vscode.workspace
    .getConfiguration('v8vscedit.configuration')
    .get<string>('operationMode', 'batch');
  return resolveAgentExecutionMode(readAgentLocation(), operationMode);
}

export function readAgentLocation(): AgentLocation {
  const raw = vscode.workspace.getConfiguration('v8vscedit.agent').get<unknown>('location', 'local');
  return raw === 'remote' ? 'remote' : 'local';
}

/** Целое ≥ 1 (дробное — вниз); нечисло и меньше единицы — умолчание, выше `max` — `max`. */
function readPositiveInteger(raw: unknown, fallback: number, max = Number.POSITIVE_INFINITY): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return fallback;
  }
  const value = Math.floor(raw);
  return value < 1 ? fallback : Math.min(value, max);
}

export function readAgentCommandSettings(connection: ConnectionParams): AgentCommandSettings {
  const config = vscode.workspace.getConfiguration('v8vscedit.agent');
  const rawModeArgs = config.get<string>('agentModeArgs', '');
  const configuredUser = config.get<string>('user', '').trim();
  return {
    host: nonEmptyString(config.get<string>('host', 'localhost')) ?? 'localhost',
    listenAddress: nonEmptyString(config.get<string>('listenAddress', '127.0.0.1')) ?? '127.0.0.1',
    port: config.get<number>('port', 1543),
    user: configuredUser ? configuredUser : (nonEmptyString(connection.userName) ?? 'admin'),
    password: connection.password ?? '',
    privateKeyPath: config.get<string>('privateKeyPath', '').trim(),
    visible: config.get<boolean>('visible', false),
    autoStart: config.get<boolean>('autoStart', true),
    agentModeArgs: splitAgentModeArgs(rawModeArgs),
    progressInterval: config.get<number>('progressInterval', 0.5),
    startupTimeoutMs: config.get<number>('startupTimeoutMs', 15000),
    authWarmupMs: config.get<number>('authWarmupMs', 90000),
    connectTimeoutMs: readPositiveInteger(
      config.get<unknown>('connectTimeoutMs', DEFAULT_CONNECT_TIMEOUT_MS),
      DEFAULT_CONNECT_TIMEOUT_MS
    ),
    idleDisconnectMinutes: config.get<number>('idleDisconnectMinutes', 0),
    location: readAgentLocation(),
    transferConcurrency: readPositiveInteger(
      config.get<unknown>('transferConcurrency', DEFAULT_TRANSFER_CONCURRENCY),
      DEFAULT_TRANSFER_CONCURRENCY,
      MAX_TRANSFER_CONCURRENCY
    ),
    archiveThresholdFiles: readPositiveInteger(
      config.get<unknown>('archiveThresholdFiles', DEFAULT_ARCHIVE_THRESHOLD_FILES),
      DEFAULT_ARCHIVE_THRESHOLD_FILES
    ),
  };
}

/**
 * Конечная точка SSH агента по настройкам — одна для операций (реестр сервисов) и для проверки
 * подключения: проверка обязана стучаться ровно туда и с теми же учётными данными, что и операции.
 */
export function toAgentEndpointOptions(settings: AgentCommandSettings): DesignerAgentEndpointOptions {
  return {
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
    privateKeyPath: nonEmptyString(settings.privateKeyPath),
    // Транспорт принимает секунды; округление вверх не даёт урезать заданный предел.
    connectTimeoutSeconds: Math.ceil(settings.connectTimeoutMs / 1000),
  };
}

export function splitAgentModeArgs(rawValue: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: '"' | '\'' | undefined;
  let escaped = false;

  for (let index = 0; index < rawValue.length; index += 1) {
    const char = rawValue.charAt(index);
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote) {
      const next = rawValue[index + 1];
      if (next === quote || next === '\\') {
        escaped = true;
      } else {
        current += char;
      }
      continue;
    }
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? undefined : char;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        result.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (quote) {
    throw new Error('Некорректные дополнительные параметры /AgentMode: не закрыта кавычка.');
  }
  if (current) {
    result.push(current);
  }
  return result;
}

export function toDesignerAgentConnection(connection: ConnectionParams): DesignerAgentInfoBaseConnection {
  const v8Path = connection.v8Path ?? '';
  if (connection.infoBaseServer && connection.infoBaseRef) {
    return {
      infoBasePath: '',
      infoBaseServer: connection.infoBaseServer,
      infoBaseRef: connection.infoBaseRef,
      v8Path,
    };
  }
  if (connection.infoBasePath) {
    return {
      infoBasePath: connection.infoBasePath,
      v8Path,
    };
  }
  throw new Error('Недостаточно параметров подключения к базе из env.json.');
}
