// Перенесено из ExtensionCommandRunner.ts (Э2) без изменения поведения; публичный API реэкспортируется оттуда.
import * as vscode from 'vscode';
import type { AgentMessage } from '../../../../domain/agent';
import { AgentCommandError, type AgentOperationHooks, type AgentOperationService } from '../../../../infra/agent';
import { AgentFullDumpDeclinedError, AgentSyncCancelledError } from '../../../../infra/agent/sync/SyncContext';
import type { ConfigurationImportHooks, ConfigurationProgressHooks } from '../configurationOperationTypes';
import {
  beginConfigurationOperationStatus,
  endConfigurationOperationStatus,
  trimStatusMessage,
  updateConfigurationOperationStatus,
} from '../configurationOperationStatus';
import { getAgentOperationService, logAgentDiagnostics } from './AgentServiceRegistry';

export interface RunAgentOptions {
  readonly progressTitle: string;
  readonly progressStartMessage: string;
  readonly successMessage: string;
  readonly errorTitle: string;
  readonly showSuccessMessage?: boolean;
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly outputChannel: vscode.OutputChannel;
  readonly rootPath: string;
  readonly hooks?: ConfigurationImportHooks | ConfigurationProgressHooks;
  readonly onProgressMessage?: (message: string) => void;
  /** Вопрос о посеве пустого зеркала агента; без него импорт идёт без диалога (полная выгрузка). */
  readonly confirmMirrorSeed?: AgentOperationHooks['confirmMirrorSeed'];
  /** Вопрос перед полной серверной выгрузкой импорта; без него — выгрузка без вопроса. */
  readonly confirmFullDump?: AgentOperationHooks['confirmFullDump'];
  /** Вопрос об удалении «осиротевших» файлов выгрузки проекта; без него — только сообщение. */
  readonly confirmOrphanRemoval?: AgentOperationHooks['confirmOrphanRemoval'];
}

export async function runAgentConfigurationOperation(
  options: RunAgentOptions,
  operation: (
    service: AgentOperationService,
    hooks: {
      onMessage: (message: string) => void;
      onProjectFilesWillChange?: (filePaths: string[]) => void;
      onQuestion: (message: AgentMessage) => Promise<string | undefined>;
      confirmMirrorSeed?: AgentOperationHooks['confirmMirrorSeed'];
      confirmFullDump?: AgentOperationHooks['confirmFullDump'];
      confirmOrphanRemoval?: AgentOperationHooks['confirmOrphanRemoval'];
    }
  ) => Promise<void>
): Promise<boolean> {
  options.outputChannel.appendLine(`[agent] Старт: ${options.progressTitle}`);
  beginConfigurationOperationStatus(options.progressTitle, options.progressStartMessage);
  options.hooks?.onProgressMessage?.(options.progressStartMessage);
  options.onProgressMessage?.(options.progressStartMessage);

  const importHooks = isImportHooks(options.hooks) ? options.hooks : undefined;
  const buildOperationHooks = () => ({
    onMessage: (message: string) => {
      options.outputChannel.appendLine(`[agent] ${message}`);
      const statusMessage = getAgentStatusMessage(message);
      if (statusMessage) {
        updateConfigurationOperationStatus(options.progressTitle, statusMessage);
        options.hooks?.onProgressMessage?.(statusMessage);
        options.onProgressMessage?.(statusMessage);
      }
    },
    onProjectFilesWillChange: importHooks
      ? (filePaths: string[]) => importHooks.beforeProjectFilesChanged?.(filePaths)
      : undefined,
    onQuestion: showAgentQuestion,
    confirmMirrorSeed: options.confirmMirrorSeed,
    confirmFullDump: options.confirmFullDump,
    confirmOrphanRemoval: options.confirmOrphanRemoval,
  });

  try {
    const service = await getAgentOperationService(options.workspaceFolder, options.rootPath, options.outputChannel);
    await operation(service, buildOperationHooks());

    endConfigurationOperationStatus(options.progressTitle, 'завершено');
    options.outputChannel.appendLine(`[agent] Завершено: ${options.progressTitle}`);
    if (options.showSuccessMessage !== false) {
      void vscode.window.showInformationMessage(options.successMessage);
    }
    return true;
  } catch (error) {
    if (error instanceof AgentFullDumpDeclinedError) {
      // Отказ от полной выгрузки — решение пользователя, а не сбой: текст ошибки — инструкция по контексту
      // отказа (импорт, импорт после посева, загрузка), её и показываем (до общей ветки отмены: это её подкласс).
      options.outputChannel.appendLine(`[agent] ${error.message}`);
      endConfigurationOperationStatus(options.progressTitle, 'отменено');
      void vscode.window.showInformationMessage(error.message);
      return false;
    }
    if (error instanceof AgentSyncCancelledError) {
      // Отмена пользователем (Esc в вопросе о посеве, кнопка отмены прогресса) — не ошибка: без тоста
      // «Ошибка импорта…» и без диагностики агента, только запись в журнал и сообщение.
      options.outputChannel.appendLine(`[agent] Отменено: ${options.progressTitle}`);
      endConfigurationOperationStatus(options.progressTitle, 'отменено');
      void vscode.window.showInformationMessage(`${options.progressTitle}: операция отменена.`);
      return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    options.outputChannel.appendLine(`[agent][error] ${message}`);
    if (error instanceof AgentCommandError) {
      options.outputChannel.appendLine(`[agent][error] Команда: ${error.command}`);
    }
    logAgentDiagnostics(options.workspaceFolder, options.outputChannel);
    endConfigurationOperationStatus(options.progressTitle, 'ошибка');
    void vscode.window.showErrorMessage(
      `${options.errorTitle}\n${message}`,
      'Открыть журнал'
    ).then((action) => {
      if (action === 'Открыть журнал') {
        options.outputChannel.show(true);
      }
    });
    return false;
  }
}

export async function showAgentQuestion(message: AgentMessage): Promise<string | undefined> {
  const text = typeof message.message === 'string' && message.message.trim()
    ? message.message.trim()
    : typeof message.body === 'string'
      ? message.body
      : JSON.stringify(message.body ?? message);
  if (/(парол|password)/i.test(text)) {
    return vscode.window.showInputBox({
      title: 'Пароль информационной базы',
      prompt: text,
      password: true,
      ignoreFocusOut: true,
    });
  }
  if (/(пользователь|логин|user|login)/i.test(text)) {
    return vscode.window.showInputBox({
      title: 'Пользователь информационной базы',
      prompt: text,
      ignoreFocusOut: true,
    });
  }
  const action = await vscode.window.showWarningMessage(
    text,
    { modal: true },
    'Да',
    'Нет',
    'Отмена'
  );
  if (action === 'Да') {
    return 'yes';
  }
  if (action === 'Нет') {
    return 'no';
  }
  return 'cancel';
}

export function isImportHooks(hooks: ConfigurationImportHooks | ConfigurationProgressHooks | undefined): hooks is ConfigurationImportHooks {
  return Boolean(hooks && 'beforeProjectFilesChanged' in hooks);
}

export function getAgentStatusMessage(message: string): string | undefined {
  const text = trimStatusMessage(message);
  if (isRawAgentCommandMessage(text)) {
    return undefined;
  }
  return text;
}

export function isRawAgentCommandMessage(message: string): boolean {
  const normalized = message.replace(/\s+/g, ' ').trim().toLowerCase();
  return /^(common|config|options|infobase-tools)\s+/.test(normalized) ||
    /^выполнено:\s*(common|config|options|infobase-tools)\s+/.test(normalized) ||
    /^the operation is completed:\s*(common|config|options|infobase-tools)\s+/.test(normalized);
}
