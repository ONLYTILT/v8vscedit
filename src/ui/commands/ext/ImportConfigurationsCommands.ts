import * as vscode from 'vscode';
import type { CommandServices } from '../_shared';
import {
  endConfigurationOperation,
  isConfigurationOperationRunning,
  tryBeginConfigurationOperation,
} from './configurationOperationLock';
import { pickImportTargets, showOperationAlreadyRunningMessage } from './ExtensionCommands';
import { runImportTargets, type ImportRunResult } from './importConfigurationsRunner';
import {
  NO_IMPORT_TARGETS,
  collectImportTargets,
  parseImportConfigurationsArgs,
  selectImportTargets,
  type ImportTarget,
} from './importTargets';

/**
 * Команда «Импортировать конфигурации из базы». Аргумент `{ targets: 'all' | string[] }` заменяет окно
 * выбора (автоматизация, сочетания клавиш); любой другой аргумент — прежнее окно.
 */
export function registerImportConfigurationsCommand(context: vscode.ExtensionContext, services: CommandServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('v8vscedit.importConfigurations', (arg: unknown) =>
      runImportConfigurationsCommand(services, arg, pickImportTargets))
  );
}

/**
 * Тело команды; окно выбора внедряется, чтобы тест не открывал QuickPick. Неверный аргумент — исключение
 * (вызывающий `executeCommand` получает отказ) до замка и до любых побочных эффектов.
 */
export async function runImportConfigurationsCommand(
  services: CommandServices,
  arg: unknown,
  pickTargets: (targets: ImportTarget[]) => Promise<ImportTarget[] | undefined>
): Promise<ImportRunResult | undefined> {
  if (isConfigurationOperationRunning()) {
    await showOperationAlreadyRunningMessage();
    return undefined;
  }
  const request = parseImportConfigurationsArgs(arg);
  const available = collectImportTargets(services.treeProvider.getEntries(), services.workspaceFolder.uri.fsPath);
  if (available.length === 0) {
    await vscode.window.showWarningMessage(NO_IMPORT_TARGETS);
    return undefined;
  }
  const selected = request ? selectImportTargets(available, request) : await pickTargets(available);
  if (!selected || selected.length === 0) {
    return undefined;
  }
  // Окно выбора ждёт человека: за это время операцию мог начать кто-то другой.
  if (!await tryBeginConfigurationOperation()) {
    await showOperationAlreadyRunningMessage();
    return undefined;
  }
  try {
    return await runImportTargets(services, selected, 'interactive');
  } finally {
    await endConfigurationOperation();
  }
}
