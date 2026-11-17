import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { MetadataNode } from '../../tree/TreeNode';
import {
  describeProcessInterruption,
  maskSensitiveCliArgs,
  runProcess,
} from '../../../infra/process';
import { readExtensionListFromDumpFile } from '../../../infra/environment';
import {
  buildConnectionCliArgs,
  resolveConnectionFromSettings,
  resolveProjectSettingsPath,
  resolveSettingsPath,
  type ConnectionParams,
} from './connectionSettings';
import type { ConfigurationImportHooks, ConfigurationProgressHooks } from './configurationOperationTypes';
import {
  beginConfigurationOperationStatus,
  endConfigurationOperationStatus,
  trimStatusMessage,
  updateConfigurationOperationStatus,
} from './configurationOperationStatus';
import { isAgentConfigurationOperationMode } from './agent/agentSettings';
import { runAgentConfigurationOperation } from './agent/agentConfigurationOperation';
import { releaseAgentInfoBaseForBatch } from './agent/AgentServiceRegistry';

// Прежний публичный API модуля сохраняется реэкспортом: потребители (Container, команды, тесты)
// импортируют из ExtensionCommandRunner, а реализация живёт в соседних модулях (Э2).
export {
  buildConnectionCliArgs,
  resolveConnectionFromSettings,
  resolveProjectSettingsPath,
  resolveSettingsPath,
  setProjectSecretStorage,
  type ConnectionParams,
} from './connectionSettings';
export type { ConfigurationImportHooks, ConfigurationProgressHooks } from './configurationOperationTypes';
export {
  beginConfigurationOperationStatus,
  endConfigurationOperationStatus,
  setConfigurationOperationStatus,
  updateConfigurationOperationStatus,
} from './configurationOperationStatus';
export {
  isAgentConfigurationOperationMode,
  readAgentCommandSettings,
  splitAgentModeArgs,
} from './agent/agentSettings';
export {
  disposeCachedAgentOperationServices,
  getAgentOperationServiceForInteractiveDesigner,
  getAgentServiceCacheKey,
  getCachedAgentOperationService,
  type InteractiveDesignerAgentService,
} from './agent/AgentServiceRegistry';

type NodeArg = MetadataNode | { xmlPath?: string; nodeKind?: string; label?: string };

export interface RunCliOptions {
  cliArgs: string[];
  progressTitle: string;
  progressStartMessage: string;
  successMessage: string;
  errorTitle: string;
  /** Человекочитаемое описание операции для текста причины ошибки */
  failureOperation?: string;
  logPrefix: string;
  showSuccessMessage?: boolean;
  /** Если false — popup с ошибкой не показывается, ответственность за UX-обработку у вызывающей стороны. */
  showErrorMessage?: boolean;
  /** Колбэк получает извлечённую причину при сбое. Вызывается до показа popup'а (если он включён). */
  onFailureReason?: (reason: string) => void;
  afterSuccess?: () => Promise<void>;
  onProgressMessage?: (message: string) => void;
}

export function extractExtensionTarget(node: NodeArg): { extensionName: string; extensionRoot: string } | null {
  const nodeKind = node.nodeKind;
  const xmlPath = node.xmlPath;
  const rawLabel = (node as MetadataNode).label;
  const extensionName = typeof rawLabel === 'string' ? rawLabel : rawLabel?.label ?? '';
  if (nodeKind !== 'extension' || !xmlPath || !extensionName) {
    return null;
  }
  return {
    extensionName,
    extensionRoot: path.dirname(xmlPath),
  };
}

export async function runDecompileExtension(
  extensionName: string,
  extensionRoot: string,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  hooks?: ConfigurationImportHooks
): Promise<boolean> {
  if (!isAgentConfigurationOperationMode()) {
    return runBatchDecompileExtension(extensionName, extensionRoot, workspaceFolder, outputChannel, hooks);
  }

  return runAgentConfigurationOperation(
    {
      progressTitle: `Выгрузка расширения ${extensionName} во внутренний XML`,
      progressStartMessage: 'Импорт расширения через агент...',
      successMessage: `Импорт расширения "${extensionName}" успешно завершен.`,
      errorTitle: `Ошибка импорта расширения "${extensionName}".`,
      showSuccessMessage: false,
      workspaceFolder,
      outputChannel,
      hooks,
      rootPath: extensionRoot,
    },
    async (service, operationHooks) => {
      await service.importFromDatabase(
        { kind: 'cfe', name: extensionName, rootPath: extensionRoot, extensionName },
        operationHooks
      );
    }
  );
}

export async function runDecompileMainConfiguration(
  configName: string,
  configRoot: string,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  hooks?: ConfigurationImportHooks
): Promise<boolean> {
  if (!isAgentConfigurationOperationMode()) {
    return runBatchDecompileMainConfiguration(configName, configRoot, workspaceFolder, outputChannel, hooks);
  }

  return runAgentConfigurationOperation(
    {
      progressTitle: `Выгрузка основной конфигурации ${configName} во внутренний XML`,
      progressStartMessage: 'Импорт основной конфигурации через агент...',
      successMessage: `Импорт основной конфигурации "${configName}" успешно завершён.`,
      errorTitle: `Ошибка импорта основной конфигурации "${configName}".`,
      showSuccessMessage: false,
      workspaceFolder,
      outputChannel,
      hooks,
      rootPath: configRoot,
    },
    async (service, operationHooks) => {
      await service.importFromDatabase(
        { kind: 'cf', name: configName, rootPath: configRoot },
        operationHooks
      );
    }
  );
}

export async function runApplyDatabaseConfiguration(
  target: {
    kind: 'cf' | 'cfe';
    name: string;
    rootPath: string;
    extensionName?: string;
  },
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  showSuccessMessage = false
): Promise<boolean> {
  if (!isAgentConfigurationOperationMode()) {
    return runBatchApplyDatabaseConfiguration(target, workspaceFolder, outputChannel, showSuccessMessage);
  }

  const targetLabel = target.kind === 'cfe'
    ? `расширения ${target.name}`
    : `конфигурации ${target.name}`;

  return runAgentConfigurationOperation(
    {
      progressTitle: `Обновление ${targetLabel} в БД`,
      progressStartMessage: 'Применение изменений конфигурации через агент...',
      successMessage: `Обновление ${targetLabel} в БД успешно завершено.`,
      errorTitle: `Ошибка обновления ${targetLabel} в БД.`,
      showSuccessMessage,
      workspaceFolder,
      outputChannel,
      rootPath: target.rootPath,
    },
    async (service, operationHooks) => {
      await service.updateDatabaseConfiguration(target, operationHooks);
    }
  );
}

export async function runCompileExtension(
  extensionName: string,
  extensionRoot: string,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  showSuccessMessage = true
): Promise<boolean> {
  if (!isAgentConfigurationOperationMode()) {
    return runBatchCompileExtension(extensionName, extensionRoot, workspaceFolder, outputChannel, showSuccessMessage);
  }

  return runAgentConfigurationOperation(
    {
      progressTitle: `Полное обновление расширения ${extensionName} в БД`,
      progressStartMessage: 'Загрузка исходников через агент, применение изменений...',
      successMessage: `Полное обновление расширения "${extensionName}" успешно завершено.`,
      errorTitle: `Ошибка загрузки или применения расширения "${extensionName}" в БД.`,
      showSuccessMessage,
      workspaceFolder,
      outputChannel,
      rootPath: extensionRoot,
    },
    async (service, operationHooks) => {
      await service.loadFullAndUpdate(
        { kind: 'cfe', name: extensionName, rootPath: extensionRoot, extensionName },
        operationHooks
      );
    }
  );
}

export async function runUpdateExtension(
  extensionName: string,
  extensionRoot: string,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  showSuccessMessage = true,
  hooks?: ConfigurationProgressHooks
): Promise<boolean> {
  if (!isAgentConfigurationOperationMode()) {
    return runBatchUpdateExtension(extensionName, extensionRoot, workspaceFolder, outputChannel, showSuccessMessage, hooks);
  }

  return runAgentConfigurationOperation(
    {
      progressTitle: `Обновление расширения ${extensionName} в БД`,
      progressStartMessage: 'Поиск и загрузка изменённых файлов через агент...',
      successMessage: `Обновление расширения "${extensionName}" в БД успешно завершено.`,
      errorTitle: `Ошибка обновления расширения "${extensionName}" в БД.`,
      showSuccessMessage,
      onProgressMessage: hooks?.onProgressMessage,
      workspaceFolder,
      outputChannel,
      rootPath: extensionRoot,
    },
    async (service, operationHooks) => {
      await service.loadChangedAndUpdate(
        { kind: 'cfe', name: extensionName, rootPath: extensionRoot, extensionName },
        operationHooks
      );
    }
  );
}

export async function runUpdateMainConfiguration(
  configName: string,
  configRoot: string,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  showSuccessMessage = true,
  hooks?: ConfigurationProgressHooks
): Promise<boolean> {
  if (!isAgentConfigurationOperationMode()) {
    return runBatchUpdateMainConfiguration(configName, configRoot, workspaceFolder, outputChannel, showSuccessMessage, hooks);
  }

  return runAgentConfigurationOperation(
    {
      progressTitle: `Обновление конфигурации ${configName} в БД`,
      progressStartMessage: 'Поиск и загрузка изменённых файлов через агент...',
      successMessage: `Обновление конфигурации "${configName}" в БД успешно завершено.`,
      errorTitle: `Ошибка обновления конфигурации "${configName}" в БД.`,
      showSuccessMessage,
      onProgressMessage: hooks?.onProgressMessage,
      workspaceFolder,
      outputChannel,
      rootPath: configRoot,
    },
    async (service, operationHooks) => {
      await service.loadChangedAndUpdate(
        { kind: 'cf', name: configName, rootPath: configRoot },
        operationHooks
      );
    }
  );
}

async function runBatchDecompileExtension(
  extensionName: string,
  extensionRoot: string,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  hooks?: ConfigurationImportHooks
): Promise<boolean> {
  const settingsPath = resolveSettingsPath(workspaceFolder.uri.fsPath, extensionRoot);
  const connection = await resolveConnectionFromSettings(settingsPath);
  const tempRoot = createWorkspaceTempDir(workspaceFolder.uri.fsPath, 'import-ext-');
  const tempConfigDir = path.join(tempRoot, 'cfe', extensionName);
  fs.mkdirSync(tempConfigDir, { recursive: true });
  const cliArgs = [
    'export-configuration',
    '-ProjectRoot',
    workspaceFolder.uri.fsPath,
    '-Target',
    'cfe',
    '-ConfigDir',
    tempConfigDir,
    '-Mode',
    'Full',
    '-Extension',
    extensionName,
    ...buildConnectionCliArgs(connection),
  ];
  try {
    return await runInternalCliCommand(
      {
        cliArgs,
        progressTitle: `Выгрузка расширения ${extensionName} во внутренний XML`,
        progressStartMessage: 'Импорт расширения: выгрузка во временный каталог...',
        successMessage: `Импорт расширения "${extensionName}" успешно завершен.`,
        errorTitle: `Ошибка импорта расширения "${extensionName}".`,
        failureOperation: 'импорте расширения',
        logPrefix: 'export-configuration',
        onProgressMessage: hooks?.onProgressMessage,
        afterSuccess: async () => {
          const changedProjectFiles = collectSnapshotProjectFiles(tempConfigDir, extensionRoot);
          hooks?.onProgressMessage?.(`замена файлов выгрузки: ${String(changedProjectFiles.length)}`);
          hooks?.beforeProjectFilesChanged?.(changedProjectFiles);
          await yieldToUi();
          syncDirectorySnapshot(tempConfigDir, extensionRoot);
          hooks?.beforeProjectFilesChanged?.(changedProjectFiles);
          hooks?.onProgressMessage?.('обновление кэша метаданных');
          await refreshConfigurationHashCache('cfe', extensionName, extensionRoot, workspaceFolder, outputChannel, hooks?.onProgressMessage);
        },
      },
      workspaceFolder,
      outputChannel
    );
  } finally {
    removeTempDir(tempRoot, outputChannel);
  }
}

/**
 * Возвращает список имён расширений, подключённых к базе проекта, через
 * внутренний CLI (`list-db-extensions` → Конфигуратор). Если подключение к базе
 * не настроено (нет env.json/`--ibconnection`) или CLI завершился ошибкой —
 * возвращает `undefined`, чтобы вызывающая сторона откатилась на ручной ввод.
 */
/* c8 ignore start -- спавн node-CLI и реального Конфигуратора не юнит-тестируется в CI (правило CLAUDE.md №4); тестируемая логика разбора списка вынесена в infra/environment/ExtensionListParser */
export async function listConnectedDatabaseExtensions(
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel
): Promise<string[] | undefined> {
  const settingsPath = resolveProjectSettingsPath(workspaceFolder.uri.fsPath);
  let connection: ConnectionParams;
  try {
    connection = await resolveConnectionFromSettings(settingsPath);
  } catch {
    return undefined;
  }

  const tempRoot = createWorkspaceTempDir(workspaceFolder.uri.fsPath, 'list-ext-');
  const resultFile = path.join(tempRoot, 'extensions.txt');
  try {
    const cliArgs = [
      'list-db-extensions',
      '-ProjectRoot',
      workspaceFolder.uri.fsPath,
      '-ResultFile',
      resultFile,
      ...buildConnectionCliArgs(connection),
    ];
    const ok = await runInternalCliCommand(
      {
        cliArgs,
        progressTitle: 'Получение списка расширений базы',
        progressStartMessage: 'Запрос списка расширений из базы...',
        successMessage: 'Список расширений базы получен.',
        errorTitle: 'Не удалось получить список расширений базы.',
        failureOperation: 'получении списка расширений базы',
        logPrefix: 'list-db-extensions',
        showSuccessMessage: false,
        showErrorMessage: false,
      },
      workspaceFolder,
      outputChannel
    );
    if (!ok) {
      return undefined;
    }
    return readExtensionListFromDumpFile(resultFile);
  } finally {
    removeTempDir(tempRoot, outputChannel);
  }
}
/* c8 ignore stop */

async function runBatchDecompileMainConfiguration(
  configName: string,
  configRoot: string,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  hooks?: ConfigurationImportHooks
): Promise<boolean> {
  const settingsPath = resolveSettingsPath(workspaceFolder.uri.fsPath, configRoot);
  const connection = await resolveConnectionFromSettings(settingsPath);
  const tempRoot = createWorkspaceTempDir(workspaceFolder.uri.fsPath, 'import-cf-');
  const tempConfigDir = path.join(tempRoot, 'cf');
  fs.mkdirSync(tempConfigDir, { recursive: true });
  const cliArgs = [
    'export-configuration',
    '-ProjectRoot',
    workspaceFolder.uri.fsPath,
    '-Target',
    'cf',
    '-ConfigDir',
    tempConfigDir,
    '-Mode',
    'Full',
    ...buildConnectionCliArgs(connection),
  ];
  try {
    return await runInternalCliCommand(
      {
        cliArgs,
        progressTitle: `Выгрузка основной конфигурации ${configName} во внутренний XML`,
        progressStartMessage: 'Импорт основной конфигурации: выгрузка во временный каталог...',
        successMessage: `Импорт основной конфигурации "${configName}" успешно завершён.`,
        errorTitle: `Ошибка импорта основной конфигурации "${configName}".`,
        failureOperation: 'импорте основной конфигурации',
        logPrefix: 'export-configuration',
        onProgressMessage: hooks?.onProgressMessage,
        afterSuccess: async () => {
          const changedProjectFiles = collectSnapshotProjectFiles(tempConfigDir, configRoot);
          hooks?.onProgressMessage?.(`замена файлов выгрузки: ${String(changedProjectFiles.length)}`);
          hooks?.beforeProjectFilesChanged?.(changedProjectFiles);
          await yieldToUi();
          syncDirectorySnapshot(tempConfigDir, configRoot);
          hooks?.beforeProjectFilesChanged?.(changedProjectFiles);
          hooks?.onProgressMessage?.('обновление кэша метаданных');
          await refreshConfigurationHashCache('cf', '', configRoot, workspaceFolder, outputChannel, hooks?.onProgressMessage);
        },
      },
      workspaceFolder,
      outputChannel
    );
  } finally {
    removeTempDir(tempRoot, outputChannel);
  }
}

async function runBatchApplyDatabaseConfiguration(
  target: {
    kind: 'cf' | 'cfe';
    name: string;
    rootPath: string;
    extensionName?: string;
  },
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  showSuccessMessage: boolean
): Promise<boolean> {
  const settingsPath = resolveSettingsPath(workspaceFolder.uri.fsPath, target.rootPath);
  const connection = await resolveConnectionFromSettings(settingsPath);
  const cliArgs = [
    'update-configuration',
    ...(target.kind === 'cfe' && target.extensionName ? ['-Extension', target.extensionName] : []),
    ...buildConnectionCliArgs(connection),
  ];

  const targetLabel = target.kind === 'cfe'
    ? `расширения ${target.name}`
    : `конфигурации ${target.name}`;

  return runInternalCliCommand(
    {
      cliArgs,
      progressTitle: `Обновление ${targetLabel} в БД`,
      progressStartMessage: 'Применение изменений конфигурации в базе...',
      successMessage: `Обновление ${targetLabel} в БД успешно завершено.`,
      errorTitle: `Ошибка обновления ${targetLabel} в БД.`,
      failureOperation: `обновлении ${targetLabel} в базе`,
      logPrefix: 'update-configuration',
      showSuccessMessage,
    },
    workspaceFolder,
    outputChannel
  );
}

/**
 * Временный каталог внутри проекта (не в системном temp): файлы прогона должны
 * лежать на том же томе, что и выгрузка, и убираться вместе с проектом.
 * Экспортируется для переиспользования пакетными операциями CFE — заводить
 * вторую реализацию того же каталога нельзя.
 */
export function createWorkspaceTempDir(workspaceRoot: string, prefix: string): string {
  const tempParent = path.join(workspaceRoot, '.v8vscedit', 'import-temp');
  fs.mkdirSync(tempParent, { recursive: true });
  return fs.mkdtempSync(path.join(tempParent, prefix));
}

const FULL_SYNC_CONFIRM_BUTTON = 'Выполнить полную загрузку';

function isConfigurationIdMismatchReason(reason: string): boolean {
  return /идентификатор[\s\S]*загружаемой конфигурации[\s\S]*отличается[\s\S]*сохраненной/i.test(reason)
    || /ошибка частичной загрузки/i.test(reason);
}

async function confirmFullSyncFallback(
  targetLabel: string,
  failureReason: string,
  outputChannel: vscode.OutputChannel
): Promise<boolean> {
  const isMismatch = isConfigurationIdMismatchReason(failureReason);
  const detail = isMismatch
    ? `Идентификатор конфигурации в файлах не совпадает с идентификатором базы — частичная загрузка платформой запрещена. Это типично для первой синхронизации с базой или после её пересоздания.\n\nПолная загрузка перезапишет конфигурацию базы исходниками из ${targetLabel}.`
    : `Причина:\n${failureReason}\n\nПолная загрузка перезапишет конфигурацию базы исходниками из ${targetLabel}.`;

  const choice = await vscode.window.showWarningMessage(
    `Не удалось выполнить быструю загрузку изменений ${targetLabel}. Выполнить полную загрузку?`,
    {
      modal: true,
      detail,
    },
    FULL_SYNC_CONFIRM_BUTTON,
    'Открыть журнал'
  );

  if (choice === 'Открыть журнал') {
    outputChannel.show(true);
    return false;
  }
  return choice === FULL_SYNC_CONFIRM_BUTTON;
}

async function runBatchCompileExtension(
  extensionName: string,
  extensionRoot: string,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  showSuccessMessage: boolean
): Promise<boolean> {
  const settingsPath = resolveSettingsPath(workspaceFolder.uri.fsPath, extensionRoot);
  const connection = await resolveConnectionFromSettings(settingsPath);
  const cliArgs = [
    'sync-configuration-full',
    '-ProjectRoot',
    workspaceFolder.uri.fsPath,
    '-Target',
    'cfe',
    '-ConfigDir',
    extensionRoot,
    '-Extension',
    extensionName,
    ...buildConnectionCliArgs(connection),
  ];
  return runInternalCliCommand(
    {
      cliArgs,
      progressTitle: `Полное обновление расширения ${extensionName} в БД`,
      progressStartMessage: 'Загрузка исходников, применение изменений...',
      successMessage: `Полное обновление расширения "${extensionName}" успешно завершено.`,
      errorTitle: `Ошибка загрузки или применения расширения "${extensionName}" в БД.`,
      failureOperation: 'полном обновлении расширения',
      logPrefix: 'sync-configuration-full',
      showSuccessMessage,
    },
    workspaceFolder,
    outputChannel
  );
}

async function runBatchUpdateExtension(
  extensionName: string,
  extensionRoot: string,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  showSuccessMessage: boolean,
  hooks?: ConfigurationProgressHooks
): Promise<boolean> {
  const settingsPath = resolveSettingsPath(workspaceFolder.uri.fsPath, extensionRoot);
  const connection = await resolveConnectionFromSettings(settingsPath);
  const importChangedFilesArgs = [
    'import-git-changes',
    '-ProjectRoot',
    workspaceFolder.uri.fsPath,
    '-Target',
    'cfe',
    '-ConfigDir',
    extensionRoot,
    '-Extension',
    extensionName,
    ...buildConnectionCliArgs(connection),
  ];
  let importFailureReason = '';
  const imported = await runInternalCliCommand(
    {
      cliArgs: importChangedFilesArgs,
      progressTitle: `Подготовка обновления ${extensionName}`,
      progressStartMessage: 'Поиск и загрузка изменённых файлов XML/BSL по хеш-кэшу...',
      successMessage: `Изменённые файлы расширения "${extensionName}" загружены по хеш-кэшу.`,
      errorTitle: `Ошибка загрузки изменённых файлов расширения "${extensionName}" по хеш-кэшу.`,
      failureOperation: 'быстрой загрузке изменённых файлов',
      logPrefix: 'import-git-changes',
      showSuccessMessage: false,
      showErrorMessage: false,
      onFailureReason: (reason) => { importFailureReason = reason; },
      onProgressMessage: hooks?.onProgressMessage,
    },
    workspaceFolder,
    outputChannel
  );
  if (!imported) {
    outputChannel.appendLine(
      '[update-configuration] Частичная загрузка по хеш-кэшу недоступна, запрашиваю подтверждение полной загрузки.'
    );
    const confirmed = await confirmFullSyncFallback(
      `расширения "${extensionName}"`,
      importFailureReason,
      outputChannel
    );
    if (!confirmed) {
      outputChannel.appendLine('[update-configuration] Полная загрузка отклонена пользователем.');
      return false;
    }
    const fallbackArgs = [
      'sync-configuration-full',
      '-ProjectRoot',
      workspaceFolder.uri.fsPath,
      '-Target',
      'cfe',
      '-ConfigDir',
      extensionRoot,
      '-Extension',
      extensionName,
      ...buildConnectionCliArgs(connection),
    ];
    return runInternalCliCommand(
      {
        cliArgs: fallbackArgs,
        progressTitle: `Обновление расширения ${extensionName} (полная загрузка)`,
        progressStartMessage: 'Выполняется полная синхронизация исходников и применение в базе...',
        successMessage: `Обновление расширения "${extensionName}" завершено через полную загрузку.`,
        errorTitle: `Ошибка полной загрузки расширения "${extensionName}".`,
        failureOperation: 'полной загрузке расширения',
        logPrefix: 'sync-configuration-full',
        showSuccessMessage,
        onProgressMessage: hooks?.onProgressMessage,
      },
      workspaceFolder,
      outputChannel
    );
  }

  const updateArgs = [
    'update-configuration',
    '-Extension',
    extensionName,
    ...buildConnectionCliArgs(connection),
  ];
  return runInternalCliCommand(
    {
      cliArgs: updateArgs,
      progressTitle: `Обновление расширения ${extensionName} в БД`,
      progressStartMessage: 'Применение загруженных изменений в базе...',
      successMessage: `Обновление расширения "${extensionName}" в БД успешно завершено.`,
      errorTitle: `Ошибка обновления расширения "${extensionName}" в БД.`,
      failureOperation: 'обновлении расширения',
      logPrefix: 'update-configuration',
      showSuccessMessage,
      onProgressMessage: hooks?.onProgressMessage,
    },
    workspaceFolder,
    outputChannel
  );
}

async function runBatchUpdateMainConfiguration(
  configName: string,
  configRoot: string,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  showSuccessMessage: boolean,
  hooks?: ConfigurationProgressHooks
): Promise<boolean> {
  const settingsPath = resolveSettingsPath(workspaceFolder.uri.fsPath, configRoot);
  const connection = await resolveConnectionFromSettings(settingsPath);
  const importChangedFilesArgs = [
    'import-git-changes',
    '-ProjectRoot',
    workspaceFolder.uri.fsPath,
    '-Target',
    'cf',
    '-ConfigDir',
    configRoot,
    ...buildConnectionCliArgs(connection),
  ];
  let importFailureReason = '';
  const imported = await runInternalCliCommand(
    {
      cliArgs: importChangedFilesArgs,
      progressTitle: `Подготовка обновления ${configName}`,
      progressStartMessage: 'Поиск и загрузка изменённых файлов XML/BSL по хеш-кэшу...',
      successMessage: `Изменённые файлы конфигурации "${configName}" загружены по хеш-кэшу.`,
      errorTitle: `Ошибка загрузки изменённых файлов конфигурации "${configName}" по хеш-кэшу.`,
      failureOperation: 'быстрой загрузке изменённых файлов',
      logPrefix: 'import-git-changes',
      showSuccessMessage: false,
      showErrorMessage: false,
      onFailureReason: (reason) => { importFailureReason = reason; },
      onProgressMessage: hooks?.onProgressMessage,
    },
    workspaceFolder,
    outputChannel
  );
  if (!imported) {
    outputChannel.appendLine(
      '[update-configuration] Частичная загрузка основной конфигурации недоступна, запрашиваю подтверждение полной загрузки.'
    );
    const confirmed = await confirmFullSyncFallback(
      `конфигурации "${configName}"`,
      importFailureReason,
      outputChannel
    );
    if (!confirmed) {
      outputChannel.appendLine('[update-configuration] Полная загрузка отклонена пользователем.');
      return false;
    }
    const fallbackArgs = [
      'sync-configuration-full',
      '-ProjectRoot',
      workspaceFolder.uri.fsPath,
      '-Target',
      'cf',
      '-ConfigDir',
      configRoot,
      ...buildConnectionCliArgs(connection),
    ];
    return runInternalCliCommand(
      {
        cliArgs: fallbackArgs,
        progressTitle: `Обновление конфигурации ${configName} (полная загрузка)`,
        progressStartMessage: 'Выполняется полная синхронизация исходников и применение в базе...',
        successMessage: `Обновление конфигурации "${configName}" завершено через полную загрузку.`,
        errorTitle: `Ошибка полной загрузки конфигурации "${configName}".`,
        failureOperation: 'полной загрузке конфигурации',
        logPrefix: 'sync-configuration-full',
        showSuccessMessage,
        onProgressMessage: hooks?.onProgressMessage,
      },
      workspaceFolder,
      outputChannel
    );
  }

  const updateArgs = [
    'update-configuration',
    ...buildConnectionCliArgs(connection),
  ];
  return runInternalCliCommand(
    {
      cliArgs: updateArgs,
      progressTitle: `Обновление конфигурации ${configName} в БД`,
      progressStartMessage: 'Применение загруженных изменений в базе...',
      successMessage: `Обновление конфигурации "${configName}" в БД успешно завершено.`,
      errorTitle: `Ошибка обновления конфигурации "${configName}" в БД.`,
      failureOperation: 'обновлении конфигурации',
      logPrefix: 'update-configuration',
      showSuccessMessage,
      onProgressMessage: hooks?.onProgressMessage,
    },
    workspaceFolder,
    outputChannel
  );
}

export async function runInternalCliCommand(
  options: RunCliOptions,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel
): Promise<boolean> {
  const cliPath = resolveInternalCliPath(workspaceFolder.uri.fsPath);
  const processArgs = [cliPath, ...options.cliArgs];
  // В журнал пишем МАСКИРОВАННЫЙ вектор: buildConnectionCliArgs кладёт в
  // аргументы `-Password <пароль базы>`, и без маскирования он попадал бы в
  // OutputChannel открытым текстом. В процесс уходит исходный processArgs.
  const commandAsText = `node ${maskSensitiveCliArgs(processArgs).join(' ')}`;
  outputChannel.appendLine(`[actions] Старт: ${commandAsText}`);
  beginConfigurationOperationStatus(options.progressTitle, options.progressStartMessage);
  options.onProgressMessage?.(options.progressStartMessage);

  try {
    // Пакетный Конфигуратор упрётся в блокировку базы, пока её держит агент (connect-ib
    // живёт между операциями) — отпускаем ДО спавна; сбой отключения = отказ операции.
    await releaseAgentInfoBaseForBatch(workspaceFolder, outputChannel);

    let lastStdout = '';
    let lastStderr = '';
    const outputTail: string[] = [];

    // Оборачиваем операцию в прогресс-нотификацию с кнопкой отмены, чтобы
    // пользователь мог прервать зависший CLI/конфигуратор. Статус-бар не трогаем.
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: options.progressTitle,
        cancellable: true,
      },
      (_progress, token) => runProcess({
        command: process.execPath,
        args: processArgs,
        cwd: workspaceFolder.uri.fsPath,
        shell: false,
        cancellationToken: token,
        onStdout: (text) => {
          const line = text.trim();
          if (line.length > 0) {
            lastStdout = line;
            appendOutputTail(outputTail, line);
            outputChannel.appendLine(`[${options.logPrefix}] ${line}`);
            const statusMessage = trimStatusMessage(line);
            updateConfigurationOperationStatus(options.progressTitle, statusMessage);
            options.onProgressMessage?.(statusMessage);
          }
        },
        onStderr: (text) => {
          const line = text.trim();
          if (line.length > 0) {
            lastStderr = line;
            appendOutputTail(outputTail, line);
            outputChannel.appendLine(`[${options.logPrefix}][stderr] ${line}`);
            const statusMessage = trimStatusMessage(`stderr: ${line}`);
            updateConfigurationOperationStatus(options.progressTitle, statusMessage);
            options.onProgressMessage?.(statusMessage);
          }
        },
      })
    );

    // Штатная отмена/таймаут — не ошибка: показываем нейтральное сообщение.
    const interruption = describeProcessInterruption(result);
    if (interruption) {
      outputChannel.appendLine(`[actions] ${interruption}`);
      endConfigurationOperationStatus(options.progressTitle, 'прервано');
      options.onProgressMessage?.(interruption);
      void vscode.window.showInformationMessage(`${options.progressTitle}: ${interruption}`);
      return false;
    }

    if (result.exitCode !== 0) {
      const details = outputTail.length > 0
        ? outputTail
        : [lastStderr || result.lastStderr, lastStdout || result.lastStdout].filter(Boolean);
      const reason = extractFailureReason(details, result.exitCode);
      const operation = options.failureOperation ?? options.progressTitle.toLowerCase();
      throw new Error(`Ошибка при ${operation} по причине: ${reason}`);
    }

    outputChannel.appendLine(`[actions] Завершено: ${commandAsText}`);
    if (options.afterSuccess) {
      await options.afterSuccess();
    }
    endConfigurationOperationStatus(options.progressTitle, 'завершено');
    if (options.showSuccessMessage !== false) {
      void vscode.window.showInformationMessage(options.successMessage);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[actions][error] ${message}`);
    endConfigurationOperationStatus(options.progressTitle, 'ошибка');
    options.onFailureReason?.(message);
    if (options.showErrorMessage !== false) {
      void vscode.window.showErrorMessage(
        `${options.errorTitle}\n${message}`,
        'Открыть журнал'
      ).then((action) => {
        if (action === 'Открыть журнал') {
          outputChannel.show(true);
        }
      });
    }
    return false;
  }
}

function syncDirectorySnapshot(sourceDir: string, targetDir: string): void {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Временный каталог выгрузки не найден: ${sourceDir}`);
  }

  if (replaceDirectorySnapshot(sourceDir, targetDir)) {
    return;
  }

  fs.mkdirSync(targetDir, { recursive: true });
  deleteMissingEntries(sourceDir, targetDir);
  copyAllEntries(sourceDir, targetDir);
}

function replaceDirectorySnapshot(sourceDir: string, targetDir: string): boolean {
  const targetParent = path.dirname(targetDir);
  fs.mkdirSync(targetParent, { recursive: true });

  const backupDir = path.join(
    targetParent,
    `.${path.basename(targetDir)}.v8vscedit-backup-${String(process.pid)}-${String(Date.now())}`
  );
  let targetMoved = false;

  try {
    if (fs.existsSync(targetDir)) {
      fs.renameSync(targetDir, backupDir);
      targetMoved = true;
    }

    fs.renameSync(sourceDir, targetDir);
    if (targetMoved) {
      removeDirectoryInBackground(backupDir);
    }
    return true;
  } catch (error) {
    if (targetMoved && !fs.existsSync(targetDir) && fs.existsSync(backupDir)) {
      try {
        fs.renameSync(backupDir, targetDir);
      } catch {
        // если откат не удался — это редкий случай Windows-блокировок,
        // оставим резервную копию и пробросим исходную ошибку
      }
    }

    if (isRenameFallbackError(error)) {
      return false;
    }

    throw error;
  }
}

function removeDirectoryInBackground(directoryPath: string): void {
  fs.rm(directoryPath, { recursive: true, force: true }, () => undefined);
}

function isRenameFallbackError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  // EXDEV — rename между томами; EPERM/EACCES/EBUSY — типичная ошибка Windows,
  // когда внутри каталога удерживается дескриптор (file watcher, антивирус).
  const code = (error as { code?: unknown }).code;
  return code === 'EXDEV' || code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

function collectSnapshotProjectFiles(sourceDir: string, targetDir: string): string[] {
  const result = new Set<string>();
  collectSourceProjectFiles(sourceDir, targetDir, result);
  collectDeletedProjectFiles(sourceDir, targetDir, result);
  return [...result];
}

function collectSourceProjectFiles(sourceDir: string, targetDir: string, result: Set<string>): void {
  if (!fs.existsSync(sourceDir)) {
    return;
  }

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      collectSourceProjectFiles(sourcePath, targetPath, result);
      continue;
    }

    addSuppressedProjectFile(targetPath, result);
  }
}

function collectDeletedProjectFiles(sourceDir: string, targetDir: string, result: Set<string>): void {
  if (!fs.existsSync(targetDir)) {
    return;
  }

  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    const targetPath = path.join(targetDir, entry.name);
    const sourcePath = path.join(sourceDir, entry.name);
    if (!fs.existsSync(sourcePath)) {
      collectExistingFilePaths(targetPath, result);
      continue;
    }

    if (entry.isDirectory()) {
      collectDeletedProjectFiles(sourcePath, targetPath, result);
    }
  }
}

function collectExistingFilePaths(filePath: string, result: Set<string>): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const stat = fs.statSync(filePath);
  if (!stat.isDirectory()) {
    addSuppressedProjectFile(filePath, result);
    return;
  }

  for (const entry of fs.readdirSync(filePath, { withFileTypes: true })) {
    collectExistingFilePaths(path.join(filePath, entry.name), result);
  }
}

function addSuppressedProjectFile(filePath: string, result: Set<string>): void {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (
    normalized.endsWith('.xml') ||
    normalized.endsWith('.bsl') ||
    normalized.endsWith('/ext/template.txt') ||
    normalized.endsWith('/ext/template.bin') ||
    /\/ext\/template\/.+\.html$/.test(normalized)
  ) {
    result.add(filePath);
  }
}

function deleteMissingEntries(sourceDir: string, targetDir: string): void {
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    const targetPath = path.join(targetDir, entry.name);
    const sourcePath = path.join(sourceDir, entry.name);
    if (!fs.existsSync(sourcePath)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) {
      deleteMissingEntries(sourcePath, targetPath);
    }
  }
}

function copyAllEntries(sourceDir: string, targetDir: string): void {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(targetPath, { recursive: true });
      copyAllEntries(sourcePath, targetPath);
      continue;
    }
    fs.copyFileSync(sourcePath, targetPath);
  }
}

export function removeTempDir(tempRoot: string, outputChannel: vscode.OutputChannel): void {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[actions][warn] Не удалось удалить временный каталог ${tempRoot}: ${message}`);
  }
}

function resolveInternalCliPath(workspaceRoot: string): string {
  const candidates = collectCliCandidates(workspaceRoot);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Не найден внутренний CLI раннер. Ожидался один из путей: ${candidates.join(', ')}`
  );
}

function collectCliCandidates(workspaceRoot: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  // Основной путь: CLI из пакета самого расширения (dist/cli/onec-tools.js).
  // В рантайме __dirname указывает на dist/ui/commands/ext.
  addCandidate(result, seen, path.join(__dirname, '..', '..', '..', 'cli', 'onec-tools.js'));
  addCandidate(result, seen, path.join(__dirname, '..', '..', '..', '..', 'cli', 'onec-tools.js'));

  // Резерв: dev-режим/нестандартный запуск из workspace.
  addCandidate(result, seen, path.join(workspaceRoot, 'dist', 'cli', 'onec-tools.js'));
  addCandidate(result, seen, path.join(workspaceRoot, 'out', 'cli', 'onec-tools.js'));

  // Дополнительный fallback: подъём по родительским каталогам workspace.
  let current = path.resolve(workspaceRoot);
  for (let depth = 0; depth < 8; depth += 1) {
    addCandidate(result, seen, path.join(current, 'dist', 'cli', 'onec-tools.js'));
    addCandidate(result, seen, path.join(current, 'out', 'cli', 'onec-tools.js'));

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  addCandidate(result, seen, path.join(__dirname, 'cli', 'onec-tools.js'));
  addCandidate(result, seen, path.join(__dirname, '..', 'cli', 'onec-tools.js'));
  addCandidate(result, seen, path.join(__dirname, '..', '..', 'cli', 'onec-tools.js'));

  return result;
}

function addCandidate(target: string[], seen: Set<string>, candidatePath: string): void {
  const normalized = path.resolve(candidatePath);
  if (seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function appendOutputTail(outputTail: string[], text: string): void {
  outputTail.push(text);
  if (outputTail.length > 40) {
    outputTail.splice(0, outputTail.length - 40);
  }
}

function extractFailureReason(details: string[], exitCode: number): string {
  const merged = details
    .map((item) => item.replace(/\r/g, '').trim())
    .filter(Boolean);
  if (merged.length === 0) {
    return `команда завершилась с кодом ${String(exitCode)}`;
  }

  const lines = merged
    .flatMap((block) => block.split('\n'))
    .map((line) => line.trim())
    .filter(Boolean);

  const meaningfulLines = lines.filter((line) =>
    !isDiagnosticNoise(line, exitCode)
  );
  const errorIndex = findLastIndex(meaningfulLines, (line) => isErrorLine(line));
  if (errorIndex >= 0) {
    const start = errorIndex > 0 && shouldIncludePreviousErrorLine(meaningfulLines[errorIndex - 1])
      ? errorIndex - 1
      : errorIndex;
    const end = meaningfulLines[errorIndex].endsWith(':')
      ? Math.min(meaningfulLines.length, errorIndex + 5)
      : errorIndex + 1;
    return meaningfulLines.slice(start, end).join('\n');
  }

  return meaningfulLines.at(-1) ?? lines.at(-1) ?? `команда завершилась с кодом ${String(exitCode)}`;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      return index;
    }
  }
  return -1;
}

function isErrorLine(line: string): boolean {
  return /(ошиб|error|failed|exception|не удалось|not found|denied|отказ|конфликт|заблок|недостаточно)/i.test(line);
}

function shouldIncludePreviousErrorLine(line: string | undefined): boolean {
  return Boolean(line && /(ошиб|error|failed|exception)/i.test(line));
}

function isDiagnosticNoise(line: string, exitCode: number): boolean {
  const normalized = line.trim();
  if (!normalized || normalized === '--- Log ---' || normalized === '--- End ---') {
    return true;
  }
  if (new RegExp(`\\(code:\\s*${String(exitCode)}\\)`, 'i').test(normalized)) {
    return true;
  }
  return /^(\[INFO\]|\[WARN\]|Getting |Git changes detected|Hash changes detected|Files for loading|Executing |Created output directory:|Выгрузка исходников|Загрузка исходников|Применение изменений)$/i.test(normalized);
}

async function refreshConfigurationHashCache(
  target: 'cf' | 'cfe',
  extensionName: string,
  configRoot: string,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  onProgressMessage?: (message: string) => void
): Promise<void> {
  const isExtension = target === 'cfe';
  const name = isExtension ? extensionName : 'основная конфигурация';
  const refreshed = await runInternalCliCommand(
    {
      cliArgs: [
        'refresh-hash-cache',
        '-ProjectRoot',
        workspaceFolder.uri.fsPath,
        '-Target',
        target,
        '-ConfigDir',
        configRoot,
        ...(isExtension ? ['-Extension', extensionName] : []),
      ],
      progressTitle: `Актуализация хеш-кэша ${name}`,
      progressStartMessage: 'Обновляю локальный хеш-кэш...',
      successMessage: `Хеш-кэш "${name}" успешно обновлён.`,
      errorTitle: `Ошибка актуализации хеш-кэша "${name}".`,
      failureOperation: 'актуализации хеш-кэша',
      logPrefix: 'refresh-hash-cache',
      showSuccessMessage: false,
      onProgressMessage,
    },
    workspaceFolder,
    outputChannel
  );
  if (!refreshed) {
    outputChannel.appendLine(`[refresh-hash-cache] Не удалось обновить кэш после импорта: ${name}.`);
  }
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

