import * as vscode from 'vscode';
import type { CommandServices } from '../../_shared';
import { runWithConfigurationOperationLock } from '../configurationOperationLock';
import { resetRemotePassword } from '../designerExecutorRegistry';

export const RESET_REMOTE_PASSWORD_COMMAND_ID = 'v8vscedit.remote.resetPassword';

/**
 * «Сбросить пароль удалённого сервера»: стирает пароль PSSession из SecretStorage и освобождает хост
 * PowerShell проекта — следующая удалённая операция спросит пароль заново. Явный выход из ситуации,
 * когда сохранён неверный или устаревший пароль. Под общим замком: хост нельзя закрывать посреди
 * идущей операции хранилища.
 */
export function registerResetRemotePasswordCommand(context: vscode.ExtensionContext, services: CommandServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(RESET_REMOTE_PASSWORD_COMMAND_ID, async () => {
      await runWithConfigurationOperationLock(async () => {
        await resetRemotePassword({
          workspaceFolder: services.workspaceFolder,
          outputChannel: services.outputChannel,
          secrets: services.projectSecretStorage,
        });
        // Внутри критической секции — без await (запрет №18).
        void vscode.window.showInformationMessage(
          'Пароль PowerShell-сессии с сервером 1С удалён: он будет запрошен при следующей удалённой операции.'
        );
      });
    })
  );
}
