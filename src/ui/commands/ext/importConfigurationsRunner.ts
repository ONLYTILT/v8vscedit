import * as vscode from 'vscode';
import type { CommandServices } from '../_shared';
import type {
  ConfigurationImportHooks,
  ConfigurationImportOutcome,
  OperationInteraction,
} from './configurationOperationTypes';
import { runDecompileExtension, runDecompileMainConfiguration } from './ExtensionCommandRunner';
import {
  beginConfigurationProgress,
  clearConfigurationProgress,
  createImportHooks,
  runWithStandaloneServerStopped,
  setConfigurationProgress,
  showConfigurationCommandError,
  yieldToUi,
} from './ExtensionCommands';
import { orderImportTargets, summarizeImportRun, type ImportTarget, type ImportTargetResult } from './importTargets';

/**
 * Общий раннер импорта конфигураций из базы: один код для команды UI, MCP-инструмента
 * `v8vscedit_import_configurations` и моста `execute_command`. Отличается только `interaction`: в
 * unattended ни окон, ни тостов — исходы целей и предупреждения возвращаются вызывающему.
 */

export type ImportRunnerServices = Pick<
  CommandServices,
  | 'workspaceFolder'
  | 'outputChannel'
  | 'reloadEntries'
  | 'markConfigurationsClean'
  | 'suppressConfigurationReloadForFiles'
  | 'setTreeProcessingState'
  | 'standaloneServerService'
  | 'refreshActionsView'
>;

export interface ImportRunResult {
  readonly results: readonly ImportTargetResult[];
  /** Предупреждения вне целей (перезапуск автономного сервера). */
  readonly warnings: readonly string[];
  /** Непредвиденная ошибка вне импорта цели (например, проверка автономного сервера). */
  readonly error?: string;
}

const TITLE = 'Импорт конфигураций';
const TARGET_ERROR_TITLE = 'Ошибка импорта конфигураций.';

/**
 * Импорт целей по порядку с остановкой на первой неудаче. Замок операции берёт ВЫЗЫВАЮЩИЙ (UI —
 * `tryBegin` с сообщением, MCP — бросающий вариант). Дерево перезагружается, если импортирована хотя бы
 * одна цель: иначе при частичном отказе оно показывало бы уже заменённую выгрузку.
 */
export async function runImportTargets(
  services: ImportRunnerServices,
  targets: readonly ImportTarget[],
  interaction: OperationInteraction
): Promise<ImportRunResult> {
  const ordered = orderImportTargets(targets);
  const outcomes: ConfigurationImportOutcome[] = [];
  const warnings: string[] = [];
  const importedRoots: string[] = [];
  let error: string | undefined;
  beginConfigurationProgress(services, TITLE, 'подготовка');
  await yieldToUi();
  try {
    await runWithStandaloneServerStopped(services, TITLE, async () => {
      let stoppedAt: string | undefined;
      for (let index = 0; index < ordered.length && stoppedAt === undefined; index += 1) {
        const target = ordered[index];
        const prefix = `${String(index + 1)}/${String(ordered.length)}: ${target.name}`;
        setConfigurationProgress(services, TITLE, prefix, true);
        const outcome = await importTarget(services, target, createImportHooks(services, TITLE, prefix), interaction);
        outcomes.push(outcome);
        if (outcome.success) {
          importedRoots.push(target.rootPath);
        } else {
          stoppedAt = target.name;
          setConfigurationProgress(services, TITLE, `остановлено на "${target.name}"`, false);
        }
      }
      if (importedRoots.length > 0) {
        setConfigurationProgress(services, TITLE, 'обновление дерева метаданных', true);
        await yieldToUi();
        await services.reloadEntries();
      }
      if (stoppedAt !== undefined) {
        setConfigurationProgress(services, TITLE, `остановлено на "${stoppedAt}"`, false);
        return false;
      }
      if (interaction === 'interactive' && ordered.length > 1) {
        void vscode.window.showInformationMessage(`Импортировано конфигураций: ${String(ordered.length)}.`);
      }
      setConfigurationProgress(services, TITLE, 'завершено', false);
      return true;
    }, interaction, (warning) => { warnings.push(warning); });
  } catch (caught) {
    setConfigurationProgress(services, TITLE, 'ошибка', false);
    error = caught instanceof Error ? caught.message : String(caught);
    if (interaction === 'interactive') {
      showConfigurationCommandError(TARGET_ERROR_TITLE, caught, services);
    } else {
      services.outputChannel.appendLine(`[actions][error] ${TARGET_ERROR_TITLE} ${error}`);
    }
  } finally {
    services.markConfigurationsClean(importedRoots);
    services.refreshActionsView();
    clearConfigurationProgress(services);
  }
  return {
    results: summarizeImportRun(ordered, outcomes),
    warnings,
    ...(error === undefined ? {} : { error }),
  };
}

/** Импорт одной цели; исключение раннера (например, нет env.json) — отказ цели, а не всего прогона. */
async function importTarget(
  services: ImportRunnerServices,
  target: ImportTarget,
  hooks: ConfigurationImportHooks,
  interaction: OperationInteraction
): Promise<ConfigurationImportOutcome> {
  // Контракт раннеров: `onOutcome` вызывается ровно один раз, если нет исключения. Умолчание — отказ, чтобы
  // нарушение контракта не превратилось в ложный «imported».
  let outcome: ConfigurationImportOutcome = { success: false, warnings: [] };
  const options = { interaction, onOutcome: (value: ConfigurationImportOutcome) => { outcome = value; } };
  try {
    await (target.kind === 'cf'
      ? runDecompileMainConfiguration(target.name, target.rootPath, services.workspaceFolder, services.outputChannel, hooks, options)
      : runDecompileExtension(target.name, target.rootPath, services.workspaceFolder, services.outputChannel, hooks, options));
    return outcome;
  } catch (caught) {
    if (interaction === 'interactive') {
      showConfigurationCommandError(TARGET_ERROR_TITLE, caught, services);
    }
    return { success: false, reason: caught instanceof Error ? caught.message : String(caught), warnings: [] };
  }
}
