import * as vscode from 'vscode';
import type { AgentOperationHooks, AgentOperationResult, AgentOperationService } from '../../../../infra/agent';
import type { DatabaseLagTarget } from '../../../../infra/database/DatabaseConfigLag';
import type { ConfigurationProgressHooks } from '../configurationOperationTypes';
import {
  decideLagAfterLoad,
  describeLoadWithoutUpdateSuccess,
  lagSourceFor,
  settleDatabaseLag,
  type DatabaseLoadOptions,
} from '../databaseLoadPlan';
import { promptFullDump } from './fullDumpPrompt';
import { notifyAgentWarnings, runAgentOperation, type AgentOperationUiHooks } from './agentConfigurationOperation';

/**
 * Агентская загрузка в базу с признаком «БД отстаёт»: тонкий адаптер между `AgentOperationService` и
 * уведомлениями. Решение о признаке — `decideLagAfterLoad`, общий с пакетной веткой; отметка ставится ещё
 * и хуком `onConfigurationLoaded` ДО `update-db-cfg` — если VS Code закроется на реструктуризации, признак
 * уже записан на диск.
 */

export interface AgentDatabaseLoadTexts {
  readonly progressTitle: string;
  readonly progressStartMessage: string;
  readonly successMessage: string;
  readonly errorTitle: string;
}

interface AgentDatabaseLoadRequest {
  readonly target: DatabaseLagTarget;
  readonly texts: AgentDatabaseLoadTexts;
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly outputChannel: vscode.OutputChannel;
  readonly showSuccessMessage: boolean;
  readonly hooks?: ConfigurationProgressHooks;
  readonly options: DatabaseLoadOptions;
}

type LoadOperation = (
  service: AgentOperationService,
  hooks: AgentOperationHooks
) => Promise<AgentOperationResult>;

/** Выполнено ли `update-db-cfg` по результату операции (у полной загрузки — всегда при успехе). */
type DatabaseUpdatedOf = (result: AgentOperationResult) => boolean;

/** Тексты загрузки изменений по режиму (§6 плана): без обновления БД — честно «загружены в основную». */
export function describeAgentLoadTexts(kind: 'cf' | 'cfe', name: string, updateDatabase: boolean): AgentDatabaseLoadTexts {
  const what = kind === 'cfe' ? 'расширения' : 'конфигурации';
  if (!updateDatabase) {
    return {
      progressTitle: `Загрузка изменений ${what} ${name} в базу`,
      progressStartMessage: 'Поиск и загрузка изменённых файлов…',
      successMessage: describeLoadWithoutUpdateSuccess(name),
      errorTitle: `Ошибка загрузки изменений "${name}" в базу.`,
    };
  }
  return {
    progressTitle: `Обновление ${what} ${name} в БД`,
    progressStartMessage: 'Поиск и загрузка изменённых файлов через агент...',
    successMessage: `Обновление ${what} "${name}" в БД успешно завершено.`,
    errorTitle: `Ошибка обновления ${what} "${name}" в БД.`,
  };
}

/** Загрузка изменённых файлов (`loadChanged`); при отстающей цели и `updateDatabase` — обновление без изменений. */
export function runAgentChangedLoad(request: AgentDatabaseLoadRequest): Promise<boolean> {
  const { target, options } = request;
  return runAgentDatabaseLoad(request, (service, hooks) => service.loadChanged(
    { kind: target.kind, name: target.name, rootPath: target.rootPath, extensionName: target.extensionName },
    { updateDatabase: options.updateDatabase, updateWhenUnchanged: options.lag.isBehind(target) },
    hooks
  ), (result) => result.databaseUpdated === true);
}

/** «Полное обновление расширения»: полная загрузка всегда с обновлением БД. */
export function runAgentFullLoad(request: AgentDatabaseLoadRequest): Promise<boolean> {
  const { target } = request;
  return runAgentDatabaseLoad(request, (service, hooks) => service.loadFullAndUpdate(
    { kind: target.kind, name: target.name, rootPath: target.rootPath, extensionName: target.extensionName },
    hooks
  ), () => true);
}

async function runAgentDatabaseLoad(
  request: AgentDatabaseLoadRequest,
  load: LoadOperation,
  databaseUpdatedOf: DatabaseUpdatedOf
): Promise<boolean> {
  const { target, texts, options } = request;
  const source = lagSourceFor(options.updateDatabase);
  // Объект, а не let: флаги меняют колбэки хуков, и анализ потока TypeScript иначе считал бы их константами.
  const progress = { loadStarted: false, loaded: false };
  const outcome = await runAgentOperation(
    {
      ...texts,
      // Успех показывается ниже: его текст зависит от того, была ли загрузка (а не только от режима).
      showSuccessMessage: false,
      showErrorMessage: options.silent !== true,
      onProgressMessage: request.hooks?.onProgressMessage,
      workspaceFolder: request.workspaceFolder,
      outputChannel: request.outputChannel,
      rootPath: target.rootPath,
      // Пустое зеркало агента на загрузке требует полной выгрузки на сервере — с согласия пользователя.
      confirmFullDump: promptFullDump,
    },
    (service, uiHooks: AgentOperationUiHooks) => load(service, {
      ...uiHooks,
      onConfigurationLoadStarting: () => { progress.loadStarted = true; },
      onConfigurationLoaded: () => {
        progress.loaded = true;
        options.lag.markBehind(target, source);
      },
    })
  );
  const databaseUpdated = outcome.ok && databaseUpdatedOf(outcome.value);
  settleDatabaseLag(options.lag, target, decideLagAfterLoad({
    loaded: progress.loaded || databaseUpdated,
    updateRequested: options.updateDatabase,
    updateSucceeded: databaseUpdated,
    // Отмена пользователем (отказ от подготовки зеркала, кнопка «Отмена») срабатывает до изменения базы.
    ambiguousFailure: !outcome.ok && outcome.cancelled !== true && progress.loadStarted && !progress.loaded,
  }), source);
  if (!outcome.ok) {
    return false;
  }
  const warnings = notifyAgentWarnings(outcome.value, options.silent === true);
  options.onOutcome?.({ databaseUpdated, warnings });
  if (request.showSuccessMessage) {
    // Без обновления и без изменений «загружены в основную конфигурацию» было бы неправдой.
    void vscode.window.showInformationMessage(
      options.updateDatabase || progress.loaded ? texts.successMessage : `Изменений "${target.name}" для загрузки в базу нет.`
    );
  }
  return true;
}
