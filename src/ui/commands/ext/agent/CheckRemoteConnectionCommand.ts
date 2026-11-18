import * as vscode from 'vscode';
import { checkRemoteAgentConnection, describeError, formatRemoteConnectionReport } from '../../../../infra/agent';
import type { CommandServices } from '../../_shared';
import { resolveConnectionFromSettings, resolveSettingsPath } from '../connectionSettings';
import { runWithConfigurationOperationLock } from '../configurationOperationLock';
import {
  readAgentCommandSettings,
  readAgentLocation,
  toAgentEndpointOptions,
  type AgentCommandSettings,
} from './agentSettings';

export const CHECK_REMOTE_CONNECTION_COMMAND_ID = 'v8vscedit.remote.checkConnection';

const LOG_PREFIX = '[remote-check]';

/**
 * «Проверить подключение к серверу 1С»: SSH-вход, подключение базы и SFTP удалённого агента с теми же
 * параметрами, что у операций (пароль — пароль ИБ из SecretStorage). Под общим замком: проверка
 * делает `connect-ib`/`disconnect-ib` и иначе вклинилась бы в идущую агентскую операцию.
 */
export function registerCheckRemoteConnectionCommand(context: vscode.ExtensionContext, services: CommandServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CHECK_REMOTE_CONNECTION_COMMAND_ID, async () => {
      await runWithConfigurationOperationLock(() => checkRemoteConnection(services));
    })
  );
}

// Внутри критической секции все уведомления — без await (запрет №18).
async function checkRemoteConnection(services: CommandServices): Promise<void> {
  if (readAgentLocation() !== 'remote') {
    void vscode.window.showWarningMessage(
      'Проверка подключения к серверу 1С доступна только для удалённого агента: задайте v8vscedit.agent.location = "remote".'
    );
    return;
  }
  const { outputChannel, workspaceFolder } = services;
  const settings = await readRemoteSettings(workspaceFolder.uri.fsPath, outputChannel);
  if (!settings) {
    return;
  }

  outputChannel.appendLine(`${LOG_PREFIX} Проверка подключения к агенту конфигуратора ${settings.host}:${String(settings.port)}.`);
  const report = await checkRemoteAgentConnection(toAgentEndpointOptions(settings));
  for (const line of formatRemoteConnectionReport(report)) {
    outputChannel.appendLine(`${LOG_PREFIX} ${line}`);
  }
  const firstFailure = report.parts.find((part) => part.status === 'failed');
  if (firstFailure) {
    void vscode.window.showErrorMessage(firstFailure.message);
    return;
  }
  void vscode.window.showInformationMessage('Подключение к серверу 1С проверено успешно: SSH, информационная база и SFTP доступны.');
}

/** Параметры — как у реестра сервисов агента; env.json нет или он битый — сообщение и `undefined`. */
async function readRemoteSettings(
  workspaceRoot: string,
  outputChannel: vscode.OutputChannel
): Promise<AgentCommandSettings | undefined> {
  try {
    const connection = await resolveConnectionFromSettings(resolveSettingsPath(workspaceRoot, workspaceRoot));
    return readAgentCommandSettings(connection);
  } catch (error) {
    const message = `Проверка подключения к серверу 1С: не удалось прочитать параметры подключения (env.json): ${describeError(error)}`;
    outputChannel.appendLine(`${LOG_PREFIX} ${message}`);
    void vscode.window.showErrorMessage(message);
    return undefined;
  }
}
