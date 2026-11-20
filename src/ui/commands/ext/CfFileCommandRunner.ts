/**
 * Тонкая обёртка выгрузки/загрузки CF/CFE.
 *
 * Своей логики процесса не содержит: в batch-режиме подключение к базе и запуск CLI берутся из уже
 * существующего `ExtensionCommandRunner` (тот же путь, что у импорта/обновления конфигураций); в агентском
 * режиме (`operationMode = agent`, при любом `location`) операция идёт командами агента конфигуратора, файлы —
 * через хранилище агента (локально — его каталог, удалённо — SFTP), без внутреннего CLI и без release ИБ агента
 * (plan-remote-extensions §2.1, T4/T5). Валидация — из `infra/cfFile` (те же guard'ы и те же тексты ошибок,
 * что в CLI и MCP).
 *
 * Валидация выполняется ПЕРВОЙ — раньше обращения к рабочей папке и настройкам
 * подключения: платформа при сбое всё равно оставляет побочные эффекты
 * (создаёт файл-мусор при выгрузке, создаёт расширение в базе при загрузке),
 * поэтому операцию нужно останавливать до любых приготовлений.
 */
import type * as vscode from 'vscode';
import { validateCfFileRequest } from '../../../infra/cfFile';
import { runAgentCfFileDump, runAgentCfFileLoad } from './agent/agentCfFileOperations';
import { getAgentExecutionMode } from './agent/agentSettings';
import {
  buildConnectionCliArgs,
  resolveConnectionFromSettings,
  resolveProjectSettingsPath,
  runInternalCliCommand,
  type RunCliOptions,
} from './ExtensionCommandRunner';

interface CfFileRunnerContext {
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly outputChannel: vscode.OutputChannel;
  /** Имя расширения; пустое значение означает основную конфигурацию. */
  readonly extensionName?: string;
  /** MCP-вызовы подавляют popup-уведомления: результат возвращается вызывающему агенту. */
  readonly silent?: boolean;
}

export interface DumpCfFileOptions extends CfFileRunnerContext {
  readonly outputFile: string;
  readonly overwrite?: boolean;
}

export interface LoadCfFileOptions extends CfFileRunnerContext {
  readonly inputFile: string;
}

/** Исход операции; поля применения и сверки — только у агентской ветки. */
export interface CfFileRunOutcome {
  readonly success: boolean;
  /** Причина отказа дословно (MCP отдаёт её агенту, а не «смотрите журнал»). */
  readonly failureReason?: string;
  readonly createdInDatabase?: boolean;
  /** Новое расширение применено к базе в той же операции (агентская ветка, Э28). */
  readonly appliedToDatabase?: boolean;
  /** Имя расширения в базе, если оно взято из файла (ФАКТ Э29, П4). */
  readonly extensionNameInDatabase?: string;
  readonly warnings?: readonly string[];
}

/** Выгружает конфигурацию/расширение базы в бинарный файл: агентом либо через CLI `dump-cf`. */
export async function runDumpConfigurationToCf(options: DumpCfFileOptions): Promise<CfFileRunOutcome> {
  const extensionName = (options.extensionName ?? '').trim();
  const isExtension = extensionName.length > 0;
  const overwrite = options.overwrite === true;
  validateCfFileRequest({ operation: 'dump', filePath: options.outputFile, isExtension, overwrite });
  if (getAgentExecutionMode() === 'agent') {
    const outcome = await runAgentCfFileDump(options, { outputFile: options.outputFile, extensionName, overwrite });
    return outcome.ok ? { success: true } : { success: false, failureReason: outcome.reason };
  }

  const cliArgs = [
    'dump-cf',
    '-OutputFile',
    options.outputFile,
    ...(isExtension ? ['-Extension', extensionName] : []),
    ...(overwrite ? ['-Overwrite'] : []),
    ...await resolveConnectionArgs(options.workspaceFolder),
  ];

  const targetLabel = isExtension ? `расширения "${extensionName}"` : 'основной конфигурации';
  return runCli(
    {
      cliArgs,
      progressTitle: 'Выгрузка в файл',
      progressStartMessage: `Выгрузка ${targetLabel} в файл...`,
      successMessage: `Выгрузка завершена: ${options.outputFile}`,
      errorTitle: 'Не удалось выгрузить конфигурацию в файл.',
      failureOperation: 'выгрузке конфигурации в файл',
      logPrefix: 'dump-cf',
      showSuccessMessage: options.silent !== true,
      showErrorMessage: options.silent !== true,
    },
    options.workspaceFolder,
    options.outputChannel
  );
}

/**
 * Загружает конфигурацию/расширение из бинарного файла: агентом либо через CLI `load-cf`.
 * Конфигурацию БАЗЫ не обновляет: `/LoadCfg` меняет только основную
 * конфигурацию (замерено на 8.3.27.1989), применение — отдельный шаг. Исключение — агентская загрузка
 * НОВОГО расширения: оно применяется сразу, иначе в базе остаётся неприменённая заглушка (Э28).
 */
export async function runLoadConfigurationFromCf(options: LoadCfFileOptions): Promise<CfFileRunOutcome> {
  const extensionName = (options.extensionName ?? '').trim();
  const isExtension = extensionName.length > 0;
  validateCfFileRequest({ operation: 'load', filePath: options.inputFile, isExtension });
  if (getAgentExecutionMode() === 'agent') {
    const outcome = await runAgentCfFileLoad(options, { inputFile: options.inputFile, extensionName });
    if (!outcome.ok) {
      return { success: false, failureReason: outcome.reason };
    }
    const result = outcome.value;
    return {
      success: true,
      createdInDatabase: result.createdInDatabase,
      appliedToDatabase: result.appliedToDatabase,
      extensionNameInDatabase: result.extensionNameInDatabase,
      warnings: result.warnings,
    };
  }

  const cliArgs = [
    'load-cf',
    '-InputFile',
    options.inputFile,
    ...(isExtension ? ['-Extension', extensionName] : []),
    ...await resolveConnectionArgs(options.workspaceFolder),
  ];

  const targetLabel = isExtension ? `расширения "${extensionName}"` : 'основной конфигурации';
  return runCli(
    {
      cliArgs,
      progressTitle: 'Загрузка из файла',
      progressStartMessage: `Загрузка ${targetLabel} из файла...`,
      successMessage: 'Загрузка завершена. Конфигурация базы ещё НЕ обновлена — выполните применение к базе.',
      errorTitle: 'Не удалось загрузить конфигурацию из файла. Часть изменений могла быть применена — проверьте состояние базы.',
      failureOperation: 'загрузке конфигурации из файла',
      logPrefix: 'load-cf',
      showSuccessMessage: options.silent !== true,
      showErrorMessage: options.silent !== true,
    },
    options.workspaceFolder,
    options.outputChannel
  );
}

/**
 * Batch-ветка: внутренний CLI. Причину отказа CLI пишет в журнал и показывает сам; `failureReason` здесь не
 * заполняется — потребители (MCP) сохраняют прежний текст batch-режима.
 */
async function runCli(
  options: RunCliOptions,
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel
): Promise<CfFileRunOutcome> {
  return { success: await runInternalCliCommand(options, workspaceFolder, outputChannel) };
}

/** Параметры подключения к базе проекта — тем же путём, что `listConnectedDatabaseExtensions`. */
async function resolveConnectionArgs(workspaceFolder: vscode.WorkspaceFolder): Promise<string[]> {
  const settingsPath = resolveProjectSettingsPath(workspaceFolder.uri.fsPath);
  return buildConnectionCliArgs(await resolveConnectionFromSettings(settingsPath));
}
