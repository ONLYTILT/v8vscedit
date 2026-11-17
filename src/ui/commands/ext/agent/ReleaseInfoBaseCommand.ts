import * as vscode from 'vscode';
import { describeError } from '../../../../infra/agent';
import type { CommandServices } from '../../_shared';
import { runWithConfigurationOperationLock } from '../configurationOperationLock';
import { releaseAgentInfoBaseForBatch } from './AgentServiceRegistry';

export const RELEASE_INFO_BASE_COMMAND_ID = 'v8vscedit.agent.releaseInfoBase';

/**
 * Явная точка «отпустить базу»: подключение ИБ к агенту держится между операциями и
 * блокирует базу для коллег и интерактивного Конфигуратора. Под общим замком — иначе
 * `disconnect-ib` вклинился бы между командами идущей агентской операции.
 */
export function registerReleaseInfoBaseCommand(context: vscode.ExtensionContext, services: CommandServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(RELEASE_INFO_BASE_COMMAND_ID, async () => {
      await runWithConfigurationOperationLock(async () => {
        try {
          const released = await releaseAgentInfoBaseForBatch(services.workspaceFolder, services.outputChannel);
          // Внутри критической секции — без await (запрет №18).
          void vscode.window.showInformationMessage(released
            ? 'Информационная база отключена от агента конфигуратора.'
            : 'Агент конфигуратора не держит информационную базу — отключать нечего.');
        } catch (error) {
          const message = describeError(error);
          services.outputChannel.appendLine(`[agent][error] ${message}`);
          void vscode.window.showErrorMessage(message);
        }
      });
    })
  );
}
