import * as path from 'path';
import * as vscode from 'vscode';
import type { RepositoryNodeRef, RepositoryService, RepositoryTarget } from '../../../infra/repository/RepositoryService';
import { REPOSITORY_DUMP_OUTPUT, repositoryReportOutputName } from '../../../infra/repository/RepositoryDesignerArgs';
import type { CommandServices, NodeArg } from '../_shared';
import {
  runApplyDatabaseConfiguration,
  runDecompileExtension,
  runDecompileMainConfiguration,
  runUpdateExtension,
  runUpdateMainConfiguration,
} from '../ext/ExtensionCommandRunner';
import { runWithConfigurationOperationLock } from '../ext/configurationOperationLock';
import {
  type RepositoryCliServices,
  runRepositoryCliCommand,
  runRepositoryCommitAction,
  runRepositoryLockAction,
  runRepositoryUnlockAction,
  runRepositoryUpdateAction,
} from './RepositoryCommandRunner';
import {
  buildAddUserOperation,
  buildBindOperation,
  buildCopyUsersOperation,
  buildCreateOperation,
  buildDumpOperation,
  buildReportOperation,
  buildSetLabelOperation,
  normalizeUpdateVersion,
  reportDefaultExtension,
  sanitizeFileName,
  validateBindingForm,
} from './repositoryOperationBuilders';
import {
  askRecursiveMode,
  pickBoolean,
  pickReportFlags,
  pickReportFormat,
  pickRights,
  promptOptionalText,
  promptRequiredText,
} from './repositoryPrompts';

type RepositoryCommandNode = NodeArg & RepositoryNodeRef;

/**
 * Регистрирует команды работы с хранилищем конфигурации.
 */
export function registerRepositoryCommands(
  context: vscode.ExtensionContext,
  services: CommandServices
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('v8vscedit.repository.connect', async (node: NodeArg) => {
      const target = requireRootTarget(services, node);
      if (!target) {
        return;
      }

      const initialBinding = await services.repositoryService.loadBinding(target);
      const repoPasswordSet = await services.repositoryService.hasStoredRepoPassword(target);
      const formData = await services.repositoryConnectionViewProvider.show(
        'connect',
        target.displayName,
        initialBinding ? { ...initialBinding, repoPasswordSet } : undefined
      );
      if (!formData) {
        return;
      }

      const validation = validateBindingForm(formData);
      if (!validation.ok) {
        void vscode.window.showErrorMessage(validation.errorMessage);
        return;
      }

      // Подключение и пост-синхронизация (обновление БД + импорт) — одна секция замка:
      // иначе между ними могла бы вклиниться другая операция над той же базой.
      await runWithConfigurationOperationLock(async () => {
        const ok = await runRepositoryCliCommand({
          operation: buildBindOperation(formData),
          target,
          bindingOverride: validation.binding,
          progressTitle: `Подключение к хранилищу: ${target.displayName}`,
          progressStartMessage: 'Подключаю конфигурацию к хранилищу...',
          successMessage: `Конфигурация "${target.displayName}" подключена к хранилищу.`,
          errorTitle: `Ошибка подключения "${target.displayName}" к хранилищу.`,
          failureOperation: 'подключении к хранилищу',
          afterSuccess: async () => {
            await services.repositoryService.saveBinding(target, validation.binding);
            services.repositoryService.setConnected(target, true);
            refreshRepositoryUi(services);
          },
        }, toCliServices(services));

        if (ok) {
          await runPostRepositorySync(target, services);
        }
      });
    }),

    vscode.commands.registerCommand('v8vscedit.repository.create', async (node: NodeArg) => {
      const target = requireRootTarget(services, node);
      if (!target) {
        return;
      }

      const initialBinding = await services.repositoryService.loadBinding(target);
      const repoPasswordSet = await services.repositoryService.hasStoredRepoPassword(target);
      const formData = await services.repositoryConnectionViewProvider.show(
        'create',
        target.displayName,
        initialBinding ? { ...initialBinding, repoPasswordSet } : undefined
      );
      if (!formData) {
        return;
      }

      const validation = validateBindingForm(formData);
      if (!validation.ok) {
        void vscode.window.showErrorMessage(validation.errorMessage);
        return;
      }

      await runWithConfigurationOperationLock(async () => {
        const ok = await runRepositoryCliCommand({
          operation: buildCreateOperation(formData),
          target,
          bindingOverride: validation.binding,
          progressTitle: `Создание хранилища: ${target.displayName}`,
          progressStartMessage: 'Создаю хранилище конфигурации...',
          successMessage: `Хранилище для "${target.displayName}" создано.`,
          errorTitle: `Ошибка создания хранилища для "${target.displayName}".`,
          failureOperation: 'создании хранилища',
          afterSuccess: async () => {
            await services.repositoryService.saveBinding(target, validation.binding);
            services.repositoryService.setConnected(target, !formData.noBind);
            refreshRepositoryUi(services);
          },
        }, toCliServices(services));

        if (ok && !formData.noBind) {
          await runPostRepositorySync(target, services);
        }
      });
    }),

    vscode.commands.registerCommand('v8vscedit.repository.disconnect', async (node: NodeArg) => {
      const target = requireRootTarget(services, node);
      if (!target || !ensureConnected(services.repositoryService, target)) {
        return;
      }

      const force = await pickBoolean(
        'Отключение от хранилища',
        `Как отключить "${target.displayName}" от хранилища?`,
        'Принудительно',
        'Штатно'
      );
      if (force === undefined) {
        return;
      }

      await runWithConfigurationOperationLock(() => runRepositoryCliCommand({
        operation: { kind: 'unbind', force },
        target,
        progressTitle: `Отключение от хранилища: ${target.displayName}`,
        progressStartMessage: 'Отключаю конфигурацию от хранилища...',
        successMessage: `Конфигурация "${target.displayName}" отключена от хранилища.`,
        errorTitle: `Ошибка отключения "${target.displayName}" от хранилища.`,
        failureOperation: 'отключении от хранилища',
        afterSuccess: async () => {
          await services.repositoryService.clearBinding(target);
          refreshRepositoryUi(services);
        },
      }, toCliServices(services)));
    }),

    vscode.commands.registerCommand('v8vscedit.repository.lock', async (node: NodeArg) => {
      const repositoryNode = requireRepositoryNode(services, node);
      if (!repositoryNode) {
        return;
      }

      const recursive = await askRecursiveMode('Захват объектов', repositoryNode.label ?? 'выбранный узел');
      if (recursive === undefined) {
        return;
      }

      const ok = await runWithConfigurationOperationLock(
        () => runRepositoryLockAction(toCliServices(services), repositoryNode, recursive)
      );
      if (ok) {
        refreshRepositoryUi(services);
      }
    }),

    vscode.commands.registerCommand('v8vscedit.repository.unlock', async (node: NodeArg) => {
      const repositoryNode = requireRepositoryNode(services, node);
      if (!repositoryNode) {
        return;
      }

      const recursive = await askRecursiveMode('Освобождение объектов', repositoryNode.label ?? 'выбранный узел');
      if (recursive === undefined) {
        return;
      }
      const force = await pickBoolean(
        'Освобождение объектов',
        'Выполнять принудительное освобождение?',
        'С force',
        'Без force'
      );
      if (force === undefined) {
        return;
      }

      const ok = await runWithConfigurationOperationLock(
        () => runRepositoryUnlockAction(toCliServices(services), repositoryNode, recursive, force)
      );
      if (ok) {
        refreshRepositoryUi(services);
      }
    }),

    vscode.commands.registerCommand('v8vscedit.repository.commit', async (node: NodeArg) => {
      const repositoryNode = requireRepositoryNode(services, node);
      if (!repositoryNode) {
        return;
      }

      const target = requireTarget(services.repositoryService, repositoryNode);
      if (!target) {
        return;
      }

      // Все вопросы пользователю — ДО замка (иначе открытая форма держала бы «операция уже
      // выполняется» для всех), а «обновить БД → поместить» — одна секция замка: помещается
      // ровно то, что загружено в базу, без вклинившейся между шагами операции.
      const updateBeforeCommit = await confirmUpdateBeforeCommit(target, services);
      if (updateBeforeCommit === undefined) {
        return;
      }

      const fullName = services.repositoryService.resolveFullName(repositoryNode);
      const initiallyLocked = fullName ? services.repositoryService.isLocked(target, fullName) : false;
      const formData = await services.repositoryCommitViewProvider.show(
        repositoryNode.label ?? target.displayName,
        initiallyLocked
      );
      if (!formData) {
        return;
      }
      if (!formData.comment.trim()) {
        await vscode.window.showWarningMessage('Для помещения требуется комментарий.');
        return;
      }

      const ok = await runWithConfigurationOperationLock(async () => {
        if (updateBeforeCommit && !await updateTargetBeforeCommit(target, services)) {
          return false;
        }
        return runRepositoryCommitAction(toCliServices(services), repositoryNode, formData);
      });
      if (ok) {
        refreshRepositoryUi(services);
      }
    }),

    vscode.commands.registerCommand('v8vscedit.repository.update', async (node: NodeArg) => {
      const repositoryNode = requireRepositoryNode(services, node);
      if (!repositoryNode) {
        return;
      }

      const recursive = await askRecursiveMode('Получение из хранилища', repositoryNode.label ?? 'выбранный узел');
      if (recursive === undefined) {
        return;
      }
      const force = await pickBoolean(
        'Получение из хранилища',
        'Выполнять принудительное получение?',
        'С force',
        'Без force'
      );
      if (force === undefined) {
        return;
      }
      const version = await vscode.window.showInputBox({
        title: 'Получение из хранилища',
        prompt: 'Версия хранилища для получения. Оставьте пустым для актуальной.',
        placeHolder: 'Например: 125',
        ignoreFocusOut: true,
      });
      if (version === undefined) {
        return;
      }

      const ok = await runWithConfigurationOperationLock(() => runRepositoryUpdateAction(toCliServices(services), repositoryNode, {
        recursive,
        force,
        version: normalizeUpdateVersion(version),
      }));
      if (ok) {
        refreshRepositoryUi(services);
      }
    }),

    vscode.commands.registerCommand('v8vscedit.repository.addUser', async (node: NodeArg) => {
      const target = requireConnectedRootTarget(services, node);
      if (!target) {
        return;
      }

      const userName = await promptRequiredText('Добавление пользователя', 'Имя пользователя хранилища');
      if (!userName) {
        return;
      }
      const password = await promptRequiredText('Добавление пользователя', 'Пароль пользователя', true);
      if (!password) {
        return;
      }
      const rights = await pickRights();
      if (!rights) {
        return;
      }
      const restoreDeletedUser = await pickBoolean(
        'Добавление пользователя',
        'Восстанавливать пользователя, если он был удалён?',
        'Да, восстановить',
        'Нет'
      );
      if (restoreDeletedUser === undefined) {
        return;
      }

      await runWithConfigurationOperationLock(() => runRepositoryCliCommand({
        operation: buildAddUserOperation({ user: userName, password, rights, restoreDeletedUser }),
        target,
        progressTitle: `Пользователь хранилища: ${target.displayName}`,
        progressStartMessage: 'Добавляю пользователя в хранилище...',
        successMessage: `Пользователь "${userName}" добавлен в хранилище.`,
        errorTitle: `Ошибка добавления пользователя в хранилище "${target.displayName}".`,
        failureOperation: 'добавлении пользователя в хранилище',
      }, toCliServices(services)));
    }),

    vscode.commands.registerCommand('v8vscedit.repository.copyUsers', async (node: NodeArg) => {
      const target = requireConnectedRootTarget(services, node);
      if (!target) {
        return;
      }

      const sourcePath = await promptRequiredText('Копирование пользователей', 'Путь к исходному хранилищу или его каталогу');
      if (!sourcePath) {
        return;
      }
      const userName = await promptRequiredText('Копирование пользователей', 'Имя пользователя исходного хранилища');
      if (!userName) {
        return;
      }
      const password = await promptRequiredText('Копирование пользователей', 'Пароль пользователя исходного хранилища', true);
      if (!password) {
        return;
      }
      const restoreDeletedUser = await pickBoolean(
        'Копирование пользователей',
        'Восстанавливать удалённых пользователей?',
        'Да, восстанавливать',
        'Нет'
      );
      if (restoreDeletedUser === undefined) {
        return;
      }

      await runWithConfigurationOperationLock(() => runRepositoryCliCommand({
        operation: buildCopyUsersOperation({ path: sourcePath, user: userName, password, restoreDeletedUser }),
        target,
        progressTitle: `Копирование пользователей: ${target.displayName}`,
        progressStartMessage: 'Копирую пользователей из другого хранилища...',
        successMessage: `Пользователи для "${target.displayName}" скопированы.`,
        errorTitle: `Ошибка копирования пользователей в хранилище "${target.displayName}".`,
        failureOperation: 'копировании пользователей хранилища',
      }, toCliServices(services)));
    }),

    vscode.commands.registerCommand('v8vscedit.repository.dump', async (node: NodeArg) => {
      const target = requireConnectedRootTarget(services, node);
      if (!target) {
        return;
      }

      const fileUri = await vscode.window.showSaveDialog({
        title: 'Выгрузка версии из хранилища',
        defaultUri: vscode.Uri.file(path.join(
          services.workspaceFolder.uri.fsPath,
          '.v8vscedit',
          `${sanitizeFileName(target.displayName)}.cf`
        )),
        filters: {
          'Файл конфигурации 1С': ['cf'],
          'Все файлы': ['*'],
        },
      });
      if (!fileUri) {
        return;
      }

      const version = await vscode.window.showInputBox({
        title: 'Выгрузка версии из хранилища',
        prompt: 'Версия для выгрузки. Оставьте пустым для актуальной.',
        placeHolder: 'Например: 125',
        ignoreFocusOut: true,
      });
      if (version === undefined) {
        return;
      }

      await runWithConfigurationOperationLock(() => runRepositoryCliCommand({
        operation: buildDumpOperation(version),
        target,
        output: { name: REPOSITORY_DUMP_OUTPUT, targetPath: fileUri.fsPath },
        progressTitle: `Выгрузка версии: ${target.displayName}`,
        progressStartMessage: 'Выгружаю конфигурацию из хранилища...',
        successMessage: `Версия хранилища "${target.displayName}" выгружена в "${fileUri.fsPath}".`,
        errorTitle: `Ошибка выгрузки версии хранилища "${target.displayName}".`,
        failureOperation: 'выгрузке версии из хранилища',
      }, toCliServices(services)));
    }),

    vscode.commands.registerCommand('v8vscedit.repository.report', async (node: NodeArg) => {
      const target = requireConnectedRootTarget(services, node);
      if (!target) {
        return;
      }

      const format = await pickReportFormat();
      if (!format) {
        return;
      }
      const defaultExtension = reportDefaultExtension(format);
      const fileUri = await vscode.window.showSaveDialog({
        title: 'Отчёт по хранилищу',
        defaultUri: vscode.Uri.file(path.join(
          services.workspaceFolder.uri.fsPath,
          '.v8vscedit',
          `repository-report-${sanitizeFileName(target.displayName)}.${defaultExtension}`
        )),
        filters: {
          'Файлы отчёта': [defaultExtension],
          'Все файлы': ['*'],
        },
      });
      if (!fileUri) {
        return;
      }

      const nBegin = await promptOptionalText('Отчёт по хранилищу', 'Начальная версия');
      if (nBegin === undefined) {
        return;
      }
      const nEnd = await promptOptionalText('Отчёт по хранилищу', 'Конечная версия');
      if (nEnd === undefined) {
        return;
      }
      const dateBegin = await promptOptionalText('Отчёт по хранилищу', 'Начальная дата');
      if (dateBegin === undefined) {
        return;
      }
      const dateEnd = await promptOptionalText('Отчёт по хранилищу', 'Конечная дата');
      if (dateEnd === undefined) {
        return;
      }
      const configurationVersion = await promptOptionalText(
        'Отчёт по хранилищу',
        'Фильтр по номеру версии конфигурации'
      );
      if (configurationVersion === undefined) {
        return;
      }

      const flags = await pickReportFlags();
      if (!flags) {
        return;
      }

      const reportOperation = buildReportOperation({ nBegin, nEnd, dateBegin, dateEnd, configurationVersion, format, flags });
      await runWithConfigurationOperationLock(() => runRepositoryCliCommand({
        operation: reportOperation,
        target,
        output: { name: repositoryReportOutputName(reportOperation), targetPath: fileUri.fsPath },
        progressTitle: `Отчёт по хранилищу: ${target.displayName}`,
        progressStartMessage: 'Строю отчёт по истории хранилища...',
        successMessage: `Отчёт по хранилищу "${target.displayName}" сформирован.`,
        errorTitle: `Ошибка построения отчёта по хранилищу "${target.displayName}".`,
        failureOperation: 'построении отчёта по хранилищу',
      }, toCliServices(services)));
    }),

    vscode.commands.registerCommand('v8vscedit.repository.setLabel', async (node: NodeArg) => {
      const target = requireConnectedRootTarget(services, node);
      if (!target) {
        return;
      }

      const labelName = await promptRequiredText('Установка метки', 'Имя метки');
      if (!labelName) {
        return;
      }
      const version = await promptOptionalText('Установка метки', 'Версия. Оставьте пустым для текущей.');
      if (version === undefined) {
        return;
      }
      const comment = await promptOptionalText('Установка метки', 'Комментарий к метке');
      if (comment === undefined) {
        return;
      }

      await runWithConfigurationOperationLock(() => runRepositoryCliCommand({
        operation: buildSetLabelOperation({ name: labelName, version, comment }),
        target,
        progressTitle: `Установка метки: ${target.displayName}`,
        progressStartMessage: 'Устанавливаю метку версии в хранилище...',
        successMessage: `Метка "${labelName}" установлена для "${target.displayName}".`,
        errorTitle: `Ошибка установки метки для "${target.displayName}".`,
        failureOperation: 'установке метки хранилища',
      }, toCliServices(services)));
    })
  );
}

function toCliServices(services: CommandServices): RepositoryCliServices {
  return {
    workspaceFolder: services.workspaceFolder,
    outputChannel: services.outputChannel,
    repositoryService: services.repositoryService,
    projectSecretStorage: services.projectSecretStorage,
    createDesignerExecutor: services.createDesignerExecutor,
    designerExecutorDeps: services.designerExecutorDeps,
  };
}

function refreshRepositoryUi(services: CommandServices): void {
  services.treeProvider.refresh();
  services.refreshActionsView();
}

/**
 * Нужна ли загрузка локальных изменений в базу перед помещением: `false` — изменений нет,
 * `true` — пользователь согласился обновить, `undefined` — помещение отменено.
 */
async function confirmUpdateBeforeCommit(
  target: RepositoryTarget,
  services: CommandServices
): Promise<boolean | undefined> {
  const changed = (await services.getChangedConfigurations()).find(
    (item) => path.resolve(item.rootPath).toLowerCase() === path.resolve(target.configRoot).toLowerCase()
  );
  if (!changed) {
    return false;
  }

  const picked = await vscode.window.showQuickPick([
    {
      id: 'update',
      label: '$(sync) Обновить и продолжить',
      description: 'Сначала загрузить локальные изменения в базу, затем выполнить помещение',
      detail: `${changed.name}: изменённых файлов ${String(changed.changedFilesCount)}`,
    },
    {
      id: 'cancel',
      label: '$(close) Отменить помещение',
      description: 'Помещение без предварительного обновления запрещено',
    },
  ], {
    title: 'Перед помещением требуется обновление конфигурации',
    placeHolder: 'В конфигурации есть локальные изменения, ещё не загруженные в базу',
    ignoreFocusOut: true,
  });

  return picked?.id === 'update' ? true : undefined;
}

async function updateTargetBeforeCommit(target: RepositoryTarget, services: CommandServices): Promise<boolean> {
  const updated = target.configKind === 'cfe'
    ? await runUpdateExtension(
        target.extensionName ?? target.displayName,
        target.configRoot,
        services.workspaceFolder,
        services.outputChannel,
        false
      )
    : await runUpdateMainConfiguration(
        target.displayName,
        target.configRoot,
        services.workspaceFolder,
        services.outputChannel,
        false
      );
  if (!updated) {
    return false;
  }

  services.markConfigurationsClean([target.configRoot]);
  refreshRepositoryUi(services);
  return true;
}

async function runPostRepositorySync(target: RepositoryTarget, services: CommandServices): Promise<void> {
  try {
    const updated = await runApplyDatabaseConfiguration({
      kind: target.configKind,
      name: target.displayName,
      rootPath: target.configRoot,
      extensionName: target.extensionName,
    }, services.workspaceFolder, services.outputChannel, false);
    if (!updated) {
      return;
    }

    const imported = target.configKind === 'cfe'
      ? await runDecompileExtension(
          target.extensionName ?? target.displayName,
          target.configRoot,
          services.workspaceFolder,
          services.outputChannel
        )
      : await runDecompileMainConfiguration(
          target.displayName,
          target.configRoot,
          services.workspaceFolder,
          services.outputChannel
        );
    if (!imported) {
      return;
    }

    services.markConfigurationsClean([target.configRoot]);
    await services.reloadEntries();
    refreshRepositoryUi(services);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.outputChannel.appendLine(`[repository][post-sync][error] ${message}`);
  }
}

function requireRootTarget(services: CommandServices, node: NodeArg): RepositoryTarget | null {
  const repositoryNode = node as RepositoryCommandNode | undefined;
  if (!repositoryNode?.xmlPath || (repositoryNode.nodeKind !== 'configuration' && repositoryNode.nodeKind !== 'extension')) {
    void vscode.window.showWarningMessage('Команда хранилища доступна только для корня основной конфигурации или расширения.');
    return null;
  }

  return requireTarget(services.repositoryService, repositoryNode);
}

function requireConnectedRootTarget(services: CommandServices, node: NodeArg): RepositoryTarget | null {
  const target = requireRootTarget(services, node);
  if (!target || !ensureConnected(services.repositoryService, target)) {
    return null;
  }
  return target;
}

function requireRepositoryNode(services: CommandServices, node: NodeArg): RepositoryCommandNode | null {
  const repositoryNode = node as RepositoryCommandNode | undefined;
  if (!repositoryNode?.xmlPath) {
    void vscode.window.showWarningMessage('Команда хранилища доступна только для узлов конфигурации с XML.');
    return null;
  }

  const target = requireTarget(services.repositoryService, repositoryNode);
  if (!target || !ensureConnected(services.repositoryService, target)) {
    return null;
  }

  return repositoryNode;
}

function requireTarget(repositoryService: RepositoryService, node: RepositoryNodeRef): RepositoryTarget | null {
  if (!node.xmlPath) {
    return null;
  }
  return repositoryService.resolveTargetByXmlPath(node.xmlPath);
}

function ensureConnected(repositoryService: RepositoryService, target: RepositoryTarget): boolean {
  if (!repositoryService.hasBinding(target) || !repositoryService.isConnected(target)) {
    void vscode.window.showWarningMessage(`Для "${target.displayName}" нет активного подключения к хранилищу.`);
    return false;
  }
  return true;
}
