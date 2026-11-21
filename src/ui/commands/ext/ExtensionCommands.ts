import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandServices, NodeArg } from '../_shared';
import {
  type ConfigurationImportHooks,
  type ConfigurationProgressHooks,
  beginConfigurationOperationStatus,
  endConfigurationOperationStatus,
  extractExtensionTarget,
  runCompileExtension,
  runDecompileExtension,
  runDecompileMainConfiguration,
  updateConfigurationOperationStatus,
  runUpdateMainConfiguration,
  runUpdateExtension,
} from './ExtensionCommandRunner';
import { describeExtensionListFailure, listConnectedDatabaseExtensions } from './ExtensionListRunner';
import { getAgentExecutionMode } from './agent/agentSettings';
import { planExtensionChoices } from '../../../infra/environment';
import { removeTreeSync } from '../../../infra/fs/TreeRemoval';
import { endConfigurationOperation, tryBeginConfigurationOperation } from './configurationOperationLock';
import type { OperationInteraction } from './configurationOperationTypes';
import { isDirectory, type ImportTarget } from './importTargets';

interface ActionItem extends vscode.QuickPickItem {
  actionId: 'import' | 'update' | 'compileAndUpdateExt';
}

export interface RootConfigurationTarget extends ImportTarget {
  readonly extensionName?: string;
}

/** Сервисы прогресса и автономного сервера: узко, чтобы MCP (без aiMcpViewProvider) мог их передать. */
export type ConfigurationUiServices = Pick<
  CommandServices,
  'setTreeProcessingState' | 'outputChannel' | 'standaloneServerService' | 'refreshActionsView' | 'suppressConfigurationReloadForFiles'
>;

/** Регистрирует команды управления расширением 1С. */
export function registerExtensionCommands(
  context: vscode.ExtensionContext,
  services: CommandServices
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('v8vscedit.connectExtension', async () => {
      /* c8 ignore next -- строка вызова vscode-команды; не юнит-тестируется без полного харнесса CommandServices, ветвящаяся логика выбора имени — в planExtensionChoices (покрыта на 100%) */
      const normalizedExtensionName = await resolveExtensionNameToConnect(services);
      if (!normalizedExtensionName) {
        return;
      }

      const extensionRoot = path.join(services.workspaceFolder.uri.fsPath, 'src', 'cfe', normalizedExtensionName);
      if (!isPathInside(extensionRoot, path.join(services.workspaceFolder.uri.fsPath, 'src', 'cfe'))) {
        await vscode.window.showErrorMessage('Имя расширения приводит к пути вне src/cfe.');
        return;
      }
      if (fs.existsSync(extensionRoot)) {
        await vscode.window.showErrorMessage(`Каталог расширения уже существует: ${extensionRoot}`);
        return;
      }

      fs.mkdirSync(extensionRoot, { recursive: true });
      await runExclusiveConfigurationOperation(
        {
          title: `Подключение расширения ${normalizedExtensionName}`,
          startMessage: 'подготовка',
          services,
          afterSuccess: async () => {
            services.markConfigurationsClean([extensionRoot]);
            await services.reloadEntries();
            services.bslAnalyzerConfigService.updateSource(getConnectedExtensionRoots(services, extensionRoot));
          },
          afterFailure: async () => {
            // Обход unlink/rmdir, а не fs.rmSync: имя расширения бывает кириллическим (запрет №19).
            /* c8 ignore next -- ветка отказа vscode-команды подключения без полного харнесса CommandServices; само удаление покрыто treeRemoval.test.ts */
            removeTreeSync(extensionRoot);
            await services.reloadEntries();
          },
        },
        () =>
          runDecompileExtension(
            normalizedExtensionName,
            extensionRoot,
            services.workspaceFolder,
            services.outputChannel
          )
      );
    }),

    vscode.commands.registerCommand('v8vscedit.showConfigActions', async (node: NodeArg) => {
      const target = extractRootConfigurationTarget(node);
      if (!target) {
        return;
      }

      const items: ActionItem[] = [
        { actionId: 'import', label: '$(cloud-download) Импортировать из базы' },
        { actionId: 'update', label: '$(sync) Обновить в базе' },
      ];
      if (target.kind === 'cfe') {
        items.push({ actionId: 'compileAndUpdateExt', label: '$(run-all) Полное обновление расширения' });
      }
      const picked = await vscode.window.showQuickPick<ActionItem>(items, {
        title: `Команды: ${target.name}`,
        placeHolder: 'Выберите действие',
      });

      if (!picked) {
        return;
      }

      if (picked.actionId === 'import') {
        await vscode.commands.executeCommand('v8vscedit.importConfigurationFromDb', node);
      } else if (picked.actionId === 'update') {
        await vscode.commands.executeCommand('v8vscedit.updateConfigurationInDb', node);
      } else {
        await vscode.commands.executeCommand('v8vscedit.compileAndUpdateExtensionInDb', node);
      }
    }),

    vscode.commands.registerCommand('v8vscedit.importConfigurationFromDb', async (node: NodeArg) => {
      const target = extractRootConfigurationTarget(node);
      if (!target) {
        vscode.window.showWarningMessage('Команда доступна только для корневого узла конфигурации или расширения.');
        return;
      }

      await runExclusiveConfigurationOperation(
        {
          title: `Импорт ${target.name}`,
          startMessage: 'подготовка',
          cleanRootPath: target.rootPath,
          reloadEntriesAfterSuccess: true,
          services,
        },
        async () => {
          const ok = target.kind === 'cf'
            ? await runDecompileMainConfiguration(
                target.name,
                target.rootPath,
                services.workspaceFolder,
                services.outputChannel,
                createImportHooks(services, `Импорт ${target.name}`)
              )
            : await runDecompileExtension(
                target.name,
                target.rootPath,
                services.workspaceFolder,
                services.outputChannel,
                createImportHooks(services, `Импорт ${target.name}`)
              );
          return ok;
        }
      );
    }),

    vscode.commands.registerCommand('v8vscedit.updateConfigurationInDb', async (node: NodeArg) => {
      const target = extractRootConfigurationTarget(node);
      if (!target) {
        vscode.window.showWarningMessage('Команда доступна только для корневого узла конфигурации или расширения.');
        return false;
      }

      return runExclusiveConfigurationOperation(
        {
          title: `Обновление ${target.name}`,
          startMessage: 'подготовка',
          cleanRootPath: target.rootPath,
          services,
        },
        async () => {
          // Явная команда узла: загрузка всегда с UpdateDBCfg, настройка updateDatabaseAfterLoad не учитывается.
          const options = { updateDatabase: true, lag: services.databaseConfigLag };
          const ok = target.kind === 'cf'
            ? await runUpdateMainConfiguration(
                target.name,
                target.rootPath,
                services.workspaceFolder,
                services.outputChannel,
                true,
                createProgressHooks(services, `Обновление ${target.name}`),
                options
              )
            : await runUpdateExtension(
                target.name,
                target.rootPath,
                services.workspaceFolder,
                services.outputChannel,
                true,
                createProgressHooks(services, `Обновление ${target.name}`),
                options
              );
          return ok;
        }
      );
    }),

    vscode.commands.registerCommand('v8vscedit.decompileExtensionSources', async (node: NodeArg) => {
      const target = extractExtensionTarget(node);
      if (!target) {
        vscode.window.showWarningMessage('Команда доступна только для корневого узла расширения.');
        return;
      }

      await runExclusiveConfigurationOperation(
        {
          title: `Импорт расширения ${target.extensionName}`,
          startMessage: 'подготовка',
          cleanRootPath: target.extensionRoot,
          reloadEntriesAfterSuccess: true,
          services,
        },
        () =>
          runDecompileExtension(
            target.extensionName,
            target.extensionRoot,
            services.workspaceFolder,
            services.outputChannel
          )
      );
    }),

    vscode.commands.registerCommand('v8vscedit.updateExtensionInDb', async (node: NodeArg) => {
      const target = extractExtensionTarget(node);
      if (!target) {
        vscode.window.showWarningMessage('Команда доступна только для корневого узла расширения.');
        return;
      }

      await runExclusiveConfigurationOperation(
        {
          title: `Обновление расширения ${target.extensionName}`,
          startMessage: 'подготовка',
          cleanRootPath: target.extensionRoot,
          services,
        },
        () =>
          runUpdateExtension(
            target.extensionName,
            target.extensionRoot,
            services.workspaceFolder,
            services.outputChannel,
            true,
            undefined,
            { updateDatabase: true, lag: services.databaseConfigLag }
          )
      );
    }),

    vscode.commands.registerCommand('v8vscedit.compileAndUpdateExtensionInDb', async (node: NodeArg) => {
      const target = extractExtensionTarget(node);
      if (!target) {
        vscode.window.showWarningMessage('Команда доступна только для корневого узла расширения.');
        return;
      }

      await runExclusiveConfigurationOperation(
        {
          title: `Полное обновление расширения ${target.extensionName}`,
          startMessage: 'подготовка',
          cleanRootPath: target.extensionRoot,
          services,
        },
        async () => {
          const compiled = await runCompileExtension(
            target.extensionName,
            target.extensionRoot,
            services.workspaceFolder,
            services.outputChannel,
            false,
            services.databaseConfigLag
          );
          if (!compiled) {
            return false;
          }

          const updated = await runUpdateExtension(
            target.extensionName,
            target.extensionRoot,
            services.workspaceFolder,
            services.outputChannel,
            false,
            undefined,
            { updateDatabase: true, lag: services.databaseConfigLag }
          );
          if (!updated) {
            return false;
          }

          void vscode.window.showInformationMessage(
            `Загрузка и обновление расширения "${target.extensionName}" в БД успешно завершены.`
          );
          return true;
        }
      );
    })
  );
}

/**
 * Автономный сервер держит базу: на время операции он останавливается и после успеха запускается снова.
 * В unattended тосты о неудачном перезапуске не показываются — тексты уходят в `onWarning` (ответ MCP).
 */
export async function runWithStandaloneServerStopped(
  services: ConfigurationUiServices,
  operationTitle: string,
  operation: () => Promise<boolean>,
  interaction: OperationInteraction = 'interactive',
  onWarning?: (text: string) => void
): Promise<boolean> {
  const warn = (text: string, toast: (message: string) => unknown): void => {
    if (interaction === 'unattended') {
      onWarning?.(text);
    } else {
      void toast(text);
    }
  };
  const status = await services.standaloneServerService.refreshHealth();
  const shouldRestart = status.configured && (
    status.state === 'running' || status.state === 'unresponsive'
  );

  services.outputChannel.appendLine(
    `[standalone] Перед операцией "${operationTitle}": state=${status.state}, pid=${String(status.pid ?? '-')}, restart=${shouldRestart ? 'yes' : 'no'}`
  );

  if (!shouldRestart) {
    return operation();
  }

  services.outputChannel.appendLine(`[standalone] Перед операцией "${operationTitle}" автономный сервер будет остановлен.`);
  setConfigurationProgress(services, operationTitle, 'остановка автономного сервера', true);
  await services.standaloneServerService.stop();
  services.refreshActionsView();

  let ok = false;
  try {
    const result = await operation();
    ok = result;
    services.outputChannel.appendLine(`[standalone] Операция "${operationTitle}" вернула: ${String(result)}`);
    return ok;
  } finally {
    if (ok) {
      services.outputChannel.appendLine(`[standalone] Операция "${operationTitle}" завершена успешно, запускаю автономный сервер.`);
      setConfigurationProgress(services, operationTitle, 'запуск автономного сервера', true);
      try {
        const restartedStatus = await services.standaloneServerService.start();
        services.outputChannel.appendLine(
          `[standalone] После операции "${operationTitle}": state=${restartedStatus.state}, pid=${String(restartedStatus.pid ?? '-')}, url=${restartedStatus.url ?? '-'}`
        );
        if (restartedStatus.state !== 'running') {
          warn(
            `Операция "${operationTitle}" выполнена, но автономный сервер не перешёл в состояние "запущен": ${restartedStatus.message}`,
            (message) => vscode.window.showWarningMessage(message)
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        services.outputChannel.appendLine(`[standalone][error] Не удалось запустить сервер после операции "${operationTitle}": ${message}`);
        warn(
          `Операция "${operationTitle}" выполнена, но автономный сервер не запустился.\n${message}`,
          (text) => vscode.window.showErrorMessage(text)
        );
      } finally {
        setConfigurationProgress(services, operationTitle, 'завершено', false);
        services.refreshActionsView();
      }
    } else {
      services.outputChannel.appendLine(`[standalone] Операция "${operationTitle}" завершилась неуспешно, автономный сервер не запускается.`);
      setConfigurationProgress(services, operationTitle, 'остановлено', false);
      services.refreshActionsView();
      // Человек видит остановленный сервер в панели; агенту MCP об этом сообщает только ответ.
      if (interaction === 'unattended') {
        onWarning?.(`Автономный сервер остановлен и не перезапущен: операция "${operationTitle}" завершилась с ошибкой.`);
      }
    }
  }
}

function getConnectedExtensionRoots(services: CommandServices, extensionRoot: string): string[] {
  const roots = new Set(
    services.treeProvider
      .getEntries()
      .filter((entry) => entry.kind === 'cfe')
      .map((entry) => entry.rootPath)
  );
  roots.add(extensionRoot);
  return [...roots];
}

/**
 * Определяет имя расширения для подключения ТОЛЬКО из списка расширений базы,
 * полученного через `DumpDBCfgList` (уже подключённые отфильтрованы). Ручного
 * ввода нет: если список недоступен (нет подключения к базе / старая платформа),
 * в базе нет расширений или все они уже подключены — подключение невозможно, и
 * причина явно сообщается пользователю. Ветвящаяся логика выбора вынесена в
 * чистую `planExtensionChoices`; здесь — только диалоги vscode.
 */
/* c8 ignore start -- диалоги vscode (QuickPick) и чтение ФС списка подключённых расширений; не юнит-тестируется (правило CLAUDE.md №4), решающая логика — в planExtensionChoices */
async function resolveExtensionNameToConnect(services: CommandServices): Promise<string | undefined> {
  const workspaceRoot = services.workspaceFolder.uri.fsPath;
  const list = await listConnectedDatabaseExtensions(services.workspaceFolder, services.outputChannel);

  if (list.kind === 'unavailable') {
    await vscode.window.showErrorMessage(describeExtensionListFailure(getAgentExecutionMode(), list.reason));
    return undefined;
  }
  // Неприменённые заглушки в список не попадают: импорт заглушки рискует уронить агента (не проверялось).
  const dbNames = list.names;
  if (dbNames.length === 0) {
    await vscode.window.showInformationMessage('В подключённой базе нет расширений.');
    return undefined;
  }

  const connectedNames = readConnectedExtensionFolderNames(workspaceRoot);
  const plan = planExtensionChoices(dbNames, connectedNames);
  if (plan.allConnected) {
    await vscode.window.showInformationMessage('Все расширения базы уже подключены.');
    return undefined;
  }

  return vscode.window.showQuickPick(plan.selectable, {
    title: 'Подключить расширение',
    placeHolder: 'Выберите расширение из базы',
  });
}

function readConnectedExtensionFolderNames(workspaceRoot: string): string[] {
  const cfeRoot = path.join(workspaceRoot, 'src', 'cfe');
  try {
    return fs
      .readdirSync(cfeRoot)
      .filter((name) => isDirectory(path.join(cfeRoot, name)));
  } catch {
    return [];
  }
}
/* c8 ignore stop */

function isPathInside(filePath: string, rootPath: string): boolean {
  const normalizedFilePath = path.resolve(filePath).toLowerCase();
  const normalizedRootPath = path.resolve(rootPath).toLowerCase();
  const relative = path.relative(normalizedRootPath, normalizedFilePath);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function showConfigurationCommandError(
  title: string,
  error: unknown,
  services: ConfigurationUiServices
): void {
  const message = error instanceof Error ? error.message : String(error);
  services.outputChannel.appendLine(`[actions][error] ${title} ${message}`);
  void vscode.window.showErrorMessage(`${title}\n${message}`, 'Открыть журнал').then((action) => {
    if (action === 'Открыть журнал') {
      services.outputChannel.show(true);
    }
  });
}

/**
 * Начало операции с конфигурацией: единственная точка инкремента счётчика активных
 * операций статус-бара. Парная точка — {@link clearConfigurationProgress} в finally.
 */
export function beginConfigurationProgress(services: ConfigurationUiServices, title: string, message: string): void {
  beginConfigurationOperationStatus(title, message);
  services.setTreeProcessingState({ active: true, title, message });
}

/**
 * Промежуточное обновление текста прогресса. Счётчик активных операций НЕ трогается —
 * иначе он рос бы на каждом прогресс-сообщении и статус-бар переставал скрываться
 * (регресс M9). Терминальные текстовые сообщения ('завершено'/'ошибка'/…) тоже идут
 * сюда как текст; фактический декремент выполняет clearConfigurationProgress в finally.
 */
export function setConfigurationProgress(
  services: ConfigurationUiServices,
  title: string,
  message: string,
  running: boolean
): void {
  updateConfigurationOperationStatus(title, message);
  services.setTreeProcessingState(running ? { active: true, title, message } : { active: false });
}

/**
 * Завершение операции: единственная точка декремента счётчика активных операций
 * (парная к beginConfigurationProgress). Вызывается из finally каждой команды.
 */
export function clearConfigurationProgress(services: ConfigurationUiServices): void {
  endConfigurationOperationStatus();
  services.setTreeProcessingState({ active: false });
}

export function createImportHooks(
  services: ConfigurationUiServices,
  title: string,
  messagePrefix?: string
): ConfigurationImportHooks {
  return {
    ...createProgressHooks(services, title, messagePrefix),
    beforeProjectFilesChanged: (filePaths) => {
      services.suppressConfigurationReloadForFiles(filePaths);
    },
  };
}

export function createProgressHooks(
  services: ConfigurationUiServices,
  title: string,
  messagePrefix?: string
): ConfigurationProgressHooks {
  return {
    onProgressMessage: (message) => {
      const fullMessage = messagePrefix ? `${messagePrefix}: ${message}` : message;
      setConfigurationProgress(services, title, fullMessage, true);
    },
  };
}

interface ImportTargetPickItem extends vscode.QuickPickItem {
  target?: ImportTarget;
  selectAll?: boolean;
}

export async function pickImportTargets(
  targets: ImportTarget[]
): Promise<ImportTarget[] | undefined> {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<ImportTargetPickItem>();
    let resolved = false;
    const selectAllItem: ImportTargetPickItem = {
      label: '$(check-all) Все',
      description: String(targets.length),
      selectAll: true,
    };
    const targetItems = targets.map((target): ImportTargetPickItem => ({
      label: `${target.kind === 'cf' ? '$(database)' : '$(extensions)'} ${target.name}`,
      description: target.kind === 'cf' ? 'Основная конфигурация' : 'Расширение',
      detail: target.rootPath,
      target,
    }));

    let applyingSelectAll = false;
    let selectAllActive = false;
    quickPick.canSelectMany = true;
    quickPick.title = 'Что импортировать';
    quickPick.placeholder = 'Выберите конфигурации для импорта из базы';
    quickPick.items = [selectAllItem, ...targetItems];
    quickPick.selectedItems = targets.length === 1 ? targetItems : [];

    quickPick.onDidChangeSelection((selection) => {
      if (applyingSelectAll) {
        return;
      }
      const hasSelectAll = selection.some((item) => item.selectAll);
      const selectedTargets = selection.filter((item) => item.target);
      if (hasSelectAll && !selectAllActive) {
        applyingSelectAll = true;
        quickPick.selectedItems = [selectAllItem, ...targetItems];
        selectAllActive = true;
        applyingSelectAll = false;
        return;
      }
      if (hasSelectAll && selectAllActive && selectedTargets.length < targetItems.length) {
        applyingSelectAll = true;
        quickPick.selectedItems = selectedTargets;
        selectAllActive = false;
        applyingSelectAll = false;
        return;
      }
      if (!hasSelectAll && selectedTargets.length === targetItems.length) {
        applyingSelectAll = true;
        quickPick.selectedItems = [selectAllItem, ...targetItems];
        selectAllActive = true;
        applyingSelectAll = false;
        return;
      }
      selectAllActive = hasSelectAll;
    });

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems;
      const result = selected.some((item) => item.selectAll)
        ? targets
        : selected
            .map((item) => item.target)
            .filter((item): item is ImportTarget => Boolean(item));
      resolved = true;
      quickPick.hide();
      resolve(result);
    });
    quickPick.onDidHide(() => {
      quickPick.dispose();
      if (!resolved) {
        resolve(undefined);
      }
    });
    quickPick.show();
  });
}

export function extractRootConfigurationTarget(node: NodeArg): RootConfigurationTarget | null {
  const nodeKind = node.nodeKind;
  const xmlPath = node.xmlPath;
  if (!xmlPath) {
    return null;
  }

  if (nodeKind === 'configuration') {
    return {
      kind: 'cf',
      name: typeof node.label === 'string' ? node.label : node.label?.label ?? 'Основная конфигурация',
      rootPath: path.dirname(xmlPath),
    };
  }

  if (nodeKind === 'extension') {
    const extensionName = typeof node.label === 'string' ? node.label : node.label?.label ?? '';
    if (!extensionName) {
      return null;
    }
    return {
      kind: 'cfe',
      name: extensionName,
      rootPath: path.dirname(xmlPath),
      extensionName,
    };
  }

  return null;
}

export async function runExclusiveConfigurationOperation(
  options: {
    title: string;
    startMessage: string;
    cleanRootPath?: string;
    reloadEntriesAfterSuccess?: boolean;
    afterSuccess?: () => void | Promise<void>;
    afterFailure?: () => void | Promise<void>;
    services: CommandServices;
  },
  operation: () => Promise<boolean>
): Promise<boolean> {
  if (!await tryBeginConfigurationOperation()) {
    await showOperationAlreadyRunningMessage();
    return false;
  }
  beginConfigurationProgress(options.services, options.title, options.startMessage);
  await yieldToUi();
  let failureHookCalled = false;
  const runAfterFailure = async (): Promise<void> => {
    if (failureHookCalled) {
      return;
    }
    failureHookCalled = true;
    await options.afterFailure?.();
  };
  try {
    const ok = await runWithStandaloneServerStopped(options.services, options.title, operation);
    if (ok) {
      if (options.reloadEntriesAfterSuccess) {
        setConfigurationProgress(options.services, options.title, 'обновление дерева метаданных', true);
        await yieldToUi();
        await options.services.reloadEntries();
      }
      if (options.cleanRootPath) {
        options.services.markConfigurationsClean([options.cleanRootPath]);
      }
      await options.afterSuccess?.();
      setConfigurationProgress(options.services, options.title, 'завершено', false);
    } else {
      await runAfterFailure();
      setConfigurationProgress(options.services, options.title, 'остановлено', false);
    }
    return ok;
  } catch (error) {
    await runAfterFailure();
    setConfigurationProgress(options.services, options.title, 'ошибка', false);
    showConfigurationCommandError(`Ошибка операции "${options.title}".`, error, options.services);
    return false;
  } finally {
    await endConfigurationOperation();
    clearConfigurationProgress(options.services);
  }
}

export async function showOperationAlreadyRunningMessage(): Promise<void> {
  await vscode.window.showInformationMessage('Операция с конфигурацией уже выполняется. Дождитесь её завершения.');
}
