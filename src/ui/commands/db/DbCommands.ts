import * as vscode from 'vscode';
import type { CommandServices } from '../_shared';
import { planThinClientLaunch } from '../ext/databaseLoadPlan';
import { runDbClientFromWorkspace } from './DbRunCommandRunner';

/** Регистрирует команды запуска 1С из настроек рабочей области. */
export function registerDbCommands(
  context: vscode.ExtensionContext,
  services: CommandServices
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('v8vscedit.configureEnvironment', () => {
      void services.projectEnvironmentViewProvider.show();
    }),

    vscode.commands.registerCommand('v8vscedit.runThinClient', async () => {
      const shouldContinue = await confirmUpdateBeforeThinClient(services);
      if (!shouldContinue) {
        return;
      }

      await runDbClientFromWorkspace(services.workspaceFolder, services.outputChannel, services.projectSecretStorage, { mode: 'ENTERPRISE' });
    }),

    vscode.commands.registerCommand('v8vscedit.runConfigurator', async () => {
      await runDbClientFromWorkspace(services.workspaceFolder, services.outputChannel, services.projectSecretStorage, { mode: 'DESIGNER' });
    })
  );
}

/**
 * Запуску Предприятия нужна КОНФИГУРАЦИЯ БД, поэтому загрузка перед запуском — всегда с обновлением
 * (`{ updateDatabase: true }`, настройка updateDatabaseAfterLoad не учитывается). Та же команда применяет и
 * отстающие цели без изменений (`planUpdateTargets` → update-only), поэтому вопрос задаётся и тогда, когда
 * изменений нет, а конфигурация БД отстаёт.
 */
export async function confirmUpdateBeforeThinClient(services: CommandServices): Promise<boolean> {
  const changed = await services.getChangedConfigurations();
  const items = planThinClientLaunch({ changedCount: changed.length, behindCount: services.databaseConfigLag.list().length });
  if (items.length === 0) {
    return true;
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Перед запуском тонкого клиента',
    placeHolder: changed.length > 0
      ? 'Есть изменения, которые ещё не загружены в базу'
      : 'Конфигурация БД не обновлена после загрузки изменений',
  });

  if (picked?.id === 'run') {
    return true;
  }
  if (picked === undefined) {
    return false;
  }

  const updated = await vscode.commands.executeCommand<boolean>('v8vscedit.updateChangedConfigurations', { updateDatabase: true });
  return updated;
}
