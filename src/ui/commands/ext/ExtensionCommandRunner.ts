import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { MetadataNode } from '../../tree/TreeNode';
import {
  describeProcessInterruption,
  maskSensitiveCliArgs,
  runProcess,
} from '../../../infra/process';
import {
  buildConnectionCliArgs,
  resolveConnectionFromSettings,
  resolveProjectSettingsPath,
  resolveSettingsPath,
} from './connectionSettings';
import type { ConfigurationImportHooks, ConfigurationProgressHooks } from './configurationOperationTypes';
import {
  beginConfigurationOperationStatus,
  endConfigurationOperationStatus,
  trimStatusMessage,
  updateConfigurationOperationStatus,
} from './configurationOperationStatus';
// Режим, а не булев флаг: remote без агентского режима — отказ, а не тихий откат на пакетный.
import { getAgentExecutionMode } from './agent/agentSettings';
import { notifyAgentWarnings, runAgentConfigurationOperation, runAgentOperation } from './agent/agentConfigurationOperation';
import { promptFullDump } from './agent/fullDumpPrompt';
import { promptMirrorSeed } from './agent/mirrorSeedPrompt';
import { promptOrphanRemoval } from './agent/orphanFilesPrompt';
import { releaseAgentInfoBaseForBatch } from './agent/AgentServiceRegistry';
import { decideLocalDesignerInRemote, readInfoBaseConnectionKind } from './agent/remoteLocalDesigner';
import { describeAgentLoadTexts, runAgentChangedLoad, runAgentFullLoad } from './agent/agentDatabaseLoad';
import { runBatchDatabaseLoad, type BatchLoadStepKind } from './batchDatabaseLoad';
import { hasPendingHashChanges } from '../../../infra/cache/HashScanner';
import {
  buildBatchLoadSteps,
  decideLagAfterLoad,
  describeLoadWithoutUpdateSuccess,
  settleDatabaseLag,
  type DatabaseLoadOptions,
} from './databaseLoadPlan';
import type { DatabaseConfigLagRecorder, DatabaseLagTarget } from '../../../infra/database/DatabaseConfigLag';

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
  getAgentExecutionMode,
  isAgentConfigurationOperationMode,
  readAgentCommandSettings,
  resolveAgentExecutionMode,
  splitAgentModeArgs,
} from './agent/agentSettings';
// Список расширений базы перенесён в ExtensionListRunner (агентская ветка + batch), здесь — реэкспорт.
export { listConnectedDatabaseExtensions } from './ExtensionListRunner';
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
  if (getAgentExecutionMode() === 'batch') {
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
      confirmMirrorSeed: promptMirrorSeed,
      confirmFullDump: promptFullDump,
      confirmOrphanRemoval: promptOrphanRemoval,
      cancellable: true,
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
  if (getAgentExecutionMode() === 'batch') {
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
      confirmMirrorSeed: promptMirrorSeed,
      confirmFullDump: promptFullDump,
      confirmOrphanRemoval: promptOrphanRemoval,
      cancellable: true,
    },
    async (service, operationHooks) => {
      await service.importFromDatabase(
        { kind: 'cf', name: configName, rootPath: configRoot },
        operationHooks
      );
    }
  );
}

export interface ApplyDatabaseTarget {
  kind: 'cf' | 'cfe';
  name: string;
  rootPath: string;
  extensionName?: string;
}

/** Исход применения к базе; `warnings` — предупреждения сверки агентской ветки (E11: имя взято из файла). */
export interface ApplyDatabaseOutcome {
  readonly success: boolean;
  /** Пусто в batch-режиме и при отказе. */
  readonly warnings: readonly string[];
}

export async function runApplyDatabaseConfiguration(
  target: ApplyDatabaseTarget,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  lag: DatabaseConfigLagRecorder,
  showSuccessMessage = false
): Promise<boolean> {
  return (await runApplyDatabaseConfigurationWithOutcome(target, workspaceFolder, outputChannel, lag, showSuccessMessage)).success;
}

/**
 * То же применение с исходом: MCP отдаёт предупреждения сверки агенту (`silentWarnings` — без уведомлений),
 * UI показывает их уведомлением. Успешное UpdateDBCfg снимает признак «БД отстаёт» цели; признак —
 * обязательный параметр, чтобы ни один путь применения не забыл его снять.
 */
export async function runApplyDatabaseConfigurationWithOutcome(
  target: ApplyDatabaseTarget,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  lag: DatabaseConfigLagRecorder,
  showSuccessMessage = false,
  silentWarnings = false
): Promise<ApplyDatabaseOutcome> {
  const outcome = await applyDatabaseConfiguration(target, workspaceFolder, outputChannel, showSuccessMessage, silentWarnings);
  if (outcome.success) {
    lag.markCurrent(target);
  }
  return outcome;
}

async function applyDatabaseConfiguration(
  target: ApplyDatabaseTarget,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  showSuccessMessage: boolean,
  silentWarnings: boolean
): Promise<ApplyDatabaseOutcome> {
  if (getAgentExecutionMode() === 'batch') {
    return { success: await runBatchApplyDatabaseConfiguration(target, workspaceFolder, outputChannel, showSuccessMessage), warnings: [] };
  }

  const targetLabel = target.kind === 'cfe'
    ? `расширения ${target.name}`
    : `конфигурации ${target.name}`;

  const outcome = await runAgentOperation(
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
    (service, operationHooks) => service.updateDatabaseConfiguration(target, operationHooks)
  );
  return outcome.ok ? { success: true, warnings: notifyAgentWarnings(outcome.value, silentWarnings) } : { success: false, warnings: [] };
}

/** «Полное обновление расширения»: полная загрузка и UpdateDBCfg; признак ставится до применения. */
export async function runCompileExtension(
  extensionName: string,
  extensionRoot: string,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  showSuccessMessage: boolean,
  lag: DatabaseConfigLagRecorder
): Promise<boolean> {
  const target: DatabaseLagTarget = { kind: 'cfe', name: extensionName, rootPath: extensionRoot, extensionName };
  /* c8 ignore next 3 -- пакетная ветка запускает настоящий 1cv8; порядок шагов и признак — в batchDatabaseLoad (под тестом) */
  if (getAgentExecutionMode() === 'batch') {
    return runBatchFullLoad(target, workspaceFolder, outputChannel, showSuccessMessage, lag);
  }
  return runAgentFullLoad({
    target,
    texts: {
      progressTitle: `Полное обновление расширения ${extensionName} в БД`,
      progressStartMessage: 'Загрузка исходников через агент, применение изменений...',
      successMessage: `Полное обновление расширения "${extensionName}" успешно завершено.`,
      errorTitle: `Ошибка загрузки или применения расширения "${extensionName}" в БД.`,
    },
    workspaceFolder,
    outputChannel,
    showSuccessMessage,
    options: { updateDatabase: true, lag },
  });
}

/**
 * Загрузка изменений расширения в базу; `options.updateDatabase` — обновлять ли конфигурацию БД. Параметр
 * обязательный: молчаливого умолчания нет, компилятор показывает каждый вызов.
 */
export async function runUpdateExtension(
  extensionName: string,
  extensionRoot: string,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  showSuccessMessage: boolean,
  hooks: ConfigurationProgressHooks | undefined,
  options: DatabaseLoadOptions
): Promise<boolean> {
  return runChangedLoad(
    { kind: 'cfe', name: extensionName, rootPath: extensionRoot, extensionName },
    workspaceFolder, outputChannel, showSuccessMessage, hooks, options
  );
}

/** Загрузка изменений основной конфигурации в базу; `options` — как у {@link runUpdateExtension}. */
export async function runUpdateMainConfiguration(
  configName: string,
  configRoot: string,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  showSuccessMessage: boolean,
  hooks: ConfigurationProgressHooks | undefined,
  options: DatabaseLoadOptions
): Promise<boolean> {
  return runChangedLoad(
    { kind: 'cf', name: configName, rootPath: configRoot },
    workspaceFolder, outputChannel, showSuccessMessage, hooks, options
  );
}

function runChangedLoad(
  target: DatabaseLagTarget,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  showSuccessMessage: boolean,
  hooks: ConfigurationProgressHooks | undefined,
  options: DatabaseLoadOptions
): Promise<boolean> {
  /* c8 ignore next 3 -- пакетная ветка запускает настоящий 1cv8; порядок шагов и признак — в batchDatabaseLoad (под тестом) */
  if (getAgentExecutionMode() === 'batch') {
    return runBatchChangedLoad(target, workspaceFolder, outputChannel, showSuccessMessage, hooks, options);
  }
  return runAgentChangedLoad({
    target,
    texts: describeAgentLoadTexts(target.kind, target.name, options.updateDatabase),
    workspaceFolder,
    outputChannel,
    showSuccessMessage,
    hooks,
    options,
  });
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

/* c8 ignore start -- пакетный адаптер: запускает внутренний CLI с настоящим 1cv8 и модальный диалог; векторы шагов
   (buildBatchLoadSteps) и их порядок с правилами признака отставания (runBatchDatabaseLoad) покрыты unit-тестами */
function isConfigurationIdMismatchReason(reason: string): boolean {
  return /идентификатор[\s\S]*загружаемой конфигурации[\s\S]*отличается[\s\S]*сохраненной/i.test(reason)
    || /ошибка частичной загрузки/i.test(reason);
}

async function confirmFullSyncFallback(
  targetLabel: string,
  failureReason: string,
  updateDatabase: boolean,
  outputChannel: vscode.OutputChannel
): Promise<boolean> {
  const isMismatch = isConfigurationIdMismatchReason(failureReason);
  const overwrite = updateDatabase
    ? `Полная загрузка перезапишет конфигурацию базы исходниками из ${targetLabel}.`
    : `Полная загрузка перезапишет основную конфигурацию базы исходниками из ${targetLabel}; конфигурация БД не обновляется.`;
  const detail = isMismatch
    ? `Идентификатор конфигурации в файлах не совпадает с идентификатором базы — частичная загрузка платформой запрещена. Это типично для первой синхронизации с базой или после её пересоздания.\n\n${overwrite}`
    : `Причина:\n${failureReason}\n\n${overwrite}`;

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

async function runBatchFullLoad(
  target: DatabaseLagTarget,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  showSuccessMessage: boolean,
  lag: DatabaseConfigLagRecorder
): Promise<boolean> {
  const connection = await resolveConnectionFromSettings(resolveSettingsPath(workspaceFolder.uri.fsPath, target.rootPath));
  const steps = buildBatchLoadSteps({
    projectRoot: workspaceFolder.uri.fsPath,
    kind: target.kind,
    configDir: target.rootPath,
    extensionName: target.extensionName,
    connectionArgs: buildConnectionCliArgs(connection),
    updateDatabase: true,
  });
  const ok = await runInternalCliCommand(
    {
      cliArgs: steps.fallback,
      progressTitle: `Полное обновление расширения ${target.name} в БД`,
      progressStartMessage: 'Загрузка исходников, применение изменений...',
      successMessage: `Полное обновление расширения "${target.name}" успешно завершено.`,
      errorTitle: `Ошибка загрузки или применения расширения "${target.name}" в БД.`,
      failureOperation: 'полном обновлении расширения',
      logPrefix: 'sync-configuration-full',
      showSuccessMessage,
    },
    workspaceFolder,
    outputChannel
  );
  settleDatabaseLag(lag, target, decideLagAfterLoad({
    loaded: ok, updateRequested: true, updateSucceeded: ok, ambiguousFailure: !ok,
  }), 'update-failed');
  return ok;
}

async function runBatchChangedLoad(
  target: DatabaseLagTarget,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel,
  showSuccessMessage: boolean,
  hooks: ConfigurationProgressHooks | undefined,
  options: DatabaseLoadOptions
): Promise<boolean> {
  const connection = await resolveConnectionFromSettings(resolveSettingsPath(workspaceFolder.uri.fsPath, target.rootPath));
  const steps = buildBatchLoadSteps({
    projectRoot: workspaceFolder.uri.fsPath,
    kind: target.kind,
    configDir: target.rootPath,
    extensionName: target.extensionName,
    connectionArgs: buildConnectionCliArgs(connection),
    updateDatabase: options.updateDatabase,
  });
  const what = target.kind === 'cfe' ? 'расширения' : 'конфигурации';
  const label = `${what} "${target.name}"`;
  const onProgressMessage = hooks?.onProgressMessage;
  const stepOptions = (kind: BatchLoadStepKind): Omit<RunCliOptions, 'cliArgs'> => {
    switch (kind) {
      case 'partial':
        return {
          progressTitle: `Подготовка обновления ${target.name}`,
          progressStartMessage: 'Поиск и загрузка изменённых файлов XML/BSL по хеш-кэшу...',
          successMessage: options.updateDatabase
            ? `Изменённые файлы ${label} загружены по хеш-кэшу.`
            : describeLoadWithoutUpdateSuccess(target.name),
          errorTitle: `Ошибка загрузки изменённых файлов ${label} по хеш-кэшу.`,
          failureOperation: 'быстрой загрузке изменённых файлов',
          logPrefix: 'import-git-changes',
          // Без шага применения частичная загрузка — итог операции: её успех и показывается пользователю.
          showSuccessMessage: !options.updateDatabase && showSuccessMessage,
          showErrorMessage: false,
          onProgressMessage,
        };
      case 'update':
        return {
          progressTitle: `Обновление ${what} ${target.name} в БД`,
          progressStartMessage: 'Применение загруженных изменений в базе...',
          successMessage: `Обновление ${label} в БД успешно завершено.`,
          errorTitle: `Ошибка обновления ${label} в БД.`,
          failureOperation: `обновлении ${what}`,
          logPrefix: 'update-configuration',
          showSuccessMessage,
          showErrorMessage: options.silent !== true,
          onProgressMessage,
        };
      case 'fallback':
        return {
          progressTitle: `Обновление ${what} ${target.name} (полная загрузка)`,
          progressStartMessage: options.updateDatabase
            ? 'Выполняется полная синхронизация исходников и применение в базе...'
            : 'Выполняется полная загрузка исходников в основную конфигурацию...',
          successMessage: options.updateDatabase
            ? `Обновление ${label} завершено через полную загрузку.`
            : describeLoadWithoutUpdateSuccess(target.name),
          errorTitle: `Ошибка полной загрузки ${label}.`,
          failureOperation: `полной загрузке ${what}`,
          logPrefix: options.updateDatabase ? 'sync-configuration-full' : 'import-configuration',
          showSuccessMessage,
          showErrorMessage: options.silent !== true,
          onProgressMessage,
        };
    }
  };
  const outcome = await runBatchDatabaseLoad(steps, target, options, {
    hasChanges: () => hasPendingHashChanges(workspaceFolder.uri.fsPath, target.kind, target.rootPath, target.extensionName),
    runStep: async (kind, cliArgs) => {
      let failureReason = '';
      const ok = await runInternalCliCommand(
        { ...stepOptions(kind), cliArgs, onFailureReason: (reason) => { failureReason = reason; } },
        workspaceFolder,
        outputChannel
      );
      return { ok, failureReason };
    },
    confirmFallback: (failureReason) => confirmFullSyncFallback(label, failureReason, options.updateDatabase, outputChannel),
    log: (line) => { outputChannel.appendLine(line); },
  });
  if (outcome.ok) {
    options.onOutcome?.({ databaseUpdated: outcome.databaseUpdated, warnings: [] });
  }
  if (outcome.unchanged && !steps.update && showSuccessMessage && options.silent !== true) {
    void vscode.window.showInformationMessage(`Изменений "${target.name}" для загрузки в базу нет.`);
  }
  return outcome.ok;
}
/* c8 ignore stop */

export async function runInternalCliCommand(
  options: RunCliOptions,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel
): Promise<boolean> {
  // Н51: в удалённом режиме внутренний CLI запускает ЛОКАЛЬНЫЙ 1cv8 — для файловой базы это не та
  // машина и, возможно, не та база; отказ до любых побочных эффектов (статус, release агента).
  const decision = decideLocalDesignerInRemote(
    readInfoBaseConnectionKind(resolveProjectSettingsPath(workspaceFolder.uri.fsPath)),
    'batch'
  );
  if (decision.action === 'refuse') {
    outputChannel.appendLine(`[actions][error] ${decision.reason}`);
    options.onFailureReason?.(decision.reason);
    if (options.showErrorMessage !== false) {
      void vscode.window.showErrorMessage(`${options.errorTitle}\n${decision.reason}`);
    }
    return false;
  }
  if (decision.notice) {
    outputChannel.appendLine(`[actions] ${decision.notice}`);
  }
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

