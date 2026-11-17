// Перенесено из ExtensionCommandRunner.ts (Э2) без изменения поведения; публичный API реэкспортируется оттуда.
import * as vscode from 'vscode';
import type { DesignerAgentInfoBaseConnection } from '../../../../infra/agent';
import { nonEmptyString, type ConnectionParams } from '../connectionSettings';

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
  /** Простой агента (минуты), после которого база отпускается сама; 0 — держать до явного release. */
  readonly idleDisconnectMinutes: number;
}

export function isAgentConfigurationOperationMode(): boolean {
  const mode = vscode.workspace
    .getConfiguration('v8vscedit.configuration')
    .get<string>('operationMode', 'batch');
  return mode === 'agent';
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
    idleDisconnectMinutes: config.get<number>('idleDisconnectMinutes', 0),
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
