import * as vscode from 'vscode';
import { checkRemoteAgentConnection, describeError, formatRemoteConnectionReport } from '../../../../infra/agent';
import {
  checkRemotePowerShell,
  formatRemotePowerShellReport,
  type RemotePowerShellReport,
} from '../../../../infra/process/remote/RemotePowerShellCheck';
import type { CommandServices } from '../../_shared';
import { resolveConnectionFromSettings, resolveSettingsPath, type ConnectionParams } from '../connectionSettings';
import { runWithConfigurationOperationLock } from '../configurationOperationLock';
import { acquireRemotePowerShellHost, readRemoteDesignerSettings } from '../designerExecutorRegistry';
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
 * параметрами, что у операций (пароль — пароль ИБ из SecretStorage), затем PowerShell-сессия и путь
 * к 1cv8 на сервере (пакетные операции хранилища). PowerShell проверяется независимо от исхода SSH:
 * другой транспорт и другая учётка. Под общим замком: проверка делает `connect-ib`/`disconnect-ib`
 * и иначе вклинилась бы в идущую агентскую операцию.
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
  const read = await readRemoteSettings(workspaceFolder.uri.fsPath, outputChannel);
  if (!read) {
    return;
  }
  const { settings, connection } = read;

  outputChannel.appendLine(`${LOG_PREFIX} Проверка подключения к агенту конфигуратора ${settings.host}:${String(settings.port)}.`);
  const report = await checkRemoteAgentConnection(toAgentEndpointOptions(settings));
  for (const line of formatRemoteConnectionReport(report)) {
    outputChannel.appendLine(`${LOG_PREFIX} ${line}`);
  }
  const psReport = await checkPowerShellPart(services, connection);
  for (const line of formatRemotePowerShellReport(psReport)) {
    outputChannel.appendLine(`${LOG_PREFIX} ${line}`);
  }
  const firstFailure = [...report.parts, ...psReport.parts].find((part) => part.status === 'failed');
  if (firstFailure) {
    void vscode.window.showErrorMessage(firstFailure.message);
    return;
  }
  void vscode.window.showInformationMessage(
    'Подключение к серверу 1С проверено успешно: SSH, информационная база, SFTP, PowerShell и 1cv8 доступны.'
  );
}

/** Нет учётки или пароля PowerShell — это отказ части powershell, а не исключение команды. */
async function checkPowerShellPart(services: CommandServices, connection: ConnectionParams): Promise<RemotePowerShellReport> {
  const remote = readRemoteDesignerSettings();
  services.outputChannel.appendLine(`${LOG_PREFIX} Проверка PowerShell-сессии с сервером ${remote.computerName}.`);
  try {
    const host = await acquireRemotePowerShellHost({
      workspaceFolder: services.workspaceFolder,
      outputChannel: services.outputChannel,
      secrets: services.projectSecretStorage,
    }, services.designerExecutorDeps);
    return await checkRemotePowerShell(host, {
      computerName: remote.computerName,
      v8Path: remote.v8Path,
      v8Version: connection.v8Version,
    });
  } catch (error) {
    return {
      ok: false,
      parts: [
        { id: 'powershell', status: 'failed', reason: 'session', message: describeError(error) },
        { id: 'v8', status: 'skipped', message: 'Путь к 1cv8 не проверялся: нет PowerShell-сессии с сервером.' },
      ],
    };
  }
}

/** Параметры — как у реестра сервисов агента; env.json нет или он битый — сообщение и `undefined`. */
async function readRemoteSettings(
  workspaceRoot: string,
  outputChannel: vscode.OutputChannel
): Promise<{ settings: AgentCommandSettings; connection: ConnectionParams } | undefined> {
  try {
    const connection = await resolveConnectionFromSettings(resolveSettingsPath(workspaceRoot, workspaceRoot));
    return { settings: readAgentCommandSettings(connection), connection };
  } catch (error) {
    const message = `Проверка подключения к серверу 1С: не удалось прочитать параметры подключения (env.json): ${describeError(error)}`;
    outputChannel.appendLine(`${LOG_PREFIX} ${message}`);
    void vscode.window.showErrorMessage(message);
    return undefined;
  }
}
