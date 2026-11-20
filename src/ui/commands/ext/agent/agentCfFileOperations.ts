/**
 * Адаптеры UI над `runAgentOperation` для CF/CFE-файлов, пакетов расширений и списка расширений базы в
 * агентском режиме (plan-remote-extensions §3.4). Логики нет: тексты уведомлений здесь, работа — в
 * `AgentOperationService` → `infra/agent/extensions/*`.
 */
import type * as vscode from 'vscode';
import type { AgentExtensionInfo } from '../../../../domain/agent';
import type {
  AgentCfFileDumpRequest,
  AgentCfFileDumpResult,
  AgentCfFileLoadRequest,
  AgentCfFileLoadResult,
} from '../../../../infra/agent/extensions/AgentCfFileExchange';
import type { AgentCfeDumpAllRequest, AgentCfeLoadAllRequest } from '../../../../infra/agent/extensions/AgentCfeBatch';
import type { CfeBatchReport } from '../../../../infra/cfFile';
import { runAgentOperation, type AgentOperationOutcome, type RunAgentOptions } from './agentConfigurationOperation';

export interface AgentCfFileUiContext {
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly outputChannel: vscode.OutputChannel;
  /** MCP: без всплывающих окон, причина отказа возвращается вызывающему. */
  readonly silent?: boolean;
}

type Texts = Pick<RunAgentOptions, 'progressTitle' | 'progressStartMessage' | 'successMessage' | 'errorTitle'>;

function optionsOf(context: AgentCfFileUiContext, texts: Texts, cancellable: boolean): RunAgentOptions {
  return {
    ...texts,
    showSuccessMessage: context.silent !== true,
    showErrorMessage: context.silent !== true,
    workspaceFolder: context.workspaceFolder,
    outputChannel: context.outputChannel,
    rootPath: context.workspaceFolder.uri.fsPath,
    cancellable,
  };
}

/** Список расширений базы. Отказ показывает диалог-потребитель своим текстом — тоста здесь нет. */
export function runAgentExtensionList(context: AgentCfFileUiContext): Promise<AgentOperationOutcome<AgentExtensionInfo[]>> {
  return runAgentOperation(
    {
      ...optionsOf(context, {
        progressTitle: 'Получение списка расширений базы',
        progressStartMessage: 'Получение списка расширений базы…',
        successMessage: 'Список расширений базы получен.',
        errorTitle: 'Не удалось получить список расширений базы.',
      }, false),
      showSuccessMessage: false,
      showErrorMessage: false,
    },
    (service, hooks) => service.listDatabaseExtensions(hooks)
  );
}

export function runAgentCfFileDump(
  context: AgentCfFileUiContext,
  request: AgentCfFileDumpRequest
): Promise<AgentOperationOutcome<AgentCfFileDumpResult>> {
  const subject = request.extensionName ? `расширения «${request.extensionName}»` : 'основной конфигурации';
  return runAgentOperation(
    optionsOf(context, {
      progressTitle: 'Выгрузка в файл',
      progressStartMessage: `Выгрузка ${subject} в файл через агента…`,
      successMessage: `Выгрузка завершена: ${request.outputFile}`,
      errorTitle: 'Не удалось выгрузить конфигурацию в файл.',
    }, true),
    (service, hooks) => service.dumpCfFile(request, hooks)
  );
}

export function runAgentCfFileLoad(
  context: AgentCfFileUiContext,
  request: AgentCfFileLoadRequest
): Promise<AgentOperationOutcome<AgentCfFileLoadResult>> {
  const subject = request.extensionName ? `расширения «${request.extensionName}»` : 'основной конфигурации';
  return runAgentOperation(
    optionsOf(context, {
      progressTitle: 'Загрузка из файла',
      progressStartMessage: `Загрузка ${subject} из файла через агента…`,
      successMessage: 'Загрузка из файла завершена.',
      errorTitle: 'Не удалось загрузить конфигурацию из файла.',
    }, true),
    (service, hooks) => service.loadCfFile(request, hooks)
  );
}

export function runAgentCfeBatchDump(
  context: AgentCfFileUiContext,
  request: AgentCfeDumpAllRequest
): Promise<AgentOperationOutcome<CfeBatchReport>> {
  return runAgentOperation(
    optionsOf(context, {
      progressTitle: 'Выгрузка всех расширений в файлы',
      progressStartMessage: 'Выгрузка расширений базы в CFE-файлы через агента…',
      successMessage: `Выгрузка расширений завершена: ${request.outputDir}`,
      errorTitle: 'Не удалось выгрузить расширения базы в файлы.',
    }, true),
    (service, hooks) => service.dumpAllExtensionsToCfe(request, hooks)
  );
}

export function runAgentCfeBatchLoad(
  context: AgentCfFileUiContext,
  request: AgentCfeLoadAllRequest
): Promise<AgentOperationOutcome<CfeBatchReport>> {
  return runAgentOperation(
    optionsOf(context, {
      progressTitle: 'Загрузка всех расширений из файлов',
      progressStartMessage: 'Загрузка расширений в базу из CFE-файлов через агента…',
      successMessage: 'Загрузка расширений завершена.',
      errorTitle: 'Не удалось загрузить расширения в базу. Часть расширений могла быть загружена — проверьте состояние базы.',
    }, true),
    (service, hooks) => service.loadAllExtensionsFromCfe(request, hooks)
  );
}
