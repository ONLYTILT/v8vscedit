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
import { agentQuestionText, isSecretQuestion, withQuestionJournal } from './agentQuestionJournal';

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
  /**
   * Кнопка «Отмена» в уведомлении и токен в хуках операции. Только у импорта: его отмена проверяется в
   * безопасных точках и не оставляет P наполовину записанным; загрузка без аудита отмены (бэклог Б3).
   */
  readonly cancellable?: boolean;
}

/** Хуки, которые операция получает от обёртки: журнал, вопросы, прогресс и (у отменяемых) токен отмены. */
export interface AgentOperationUiHooks {
  readonly onMessage: (message: string) => void;
  readonly onProgress?: AgentOperationHooks['onProgress'];
  readonly onProjectFilesWillChange?: (filePaths: string[]) => void;
  readonly onQuestion: (message: AgentMessage) => Promise<string | undefined>;
  readonly cancellation?: vscode.CancellationToken;
  readonly confirmMirrorSeed?: AgentOperationHooks['confirmMirrorSeed'];
  readonly confirmFullDump?: AgentOperationHooks['confirmFullDump'];
  readonly confirmOrphanRemoval?: AgentOperationHooks['confirmOrphanRemoval'];
}

const CANCEL_REQUESTED_MESSAGE =
  'Запрошена отмена: операция остановится в ближайшей безопасной точке; начатая команда агента и запись в проект доводятся до конца';

/**
 * Операция идёт внутри уведомления `withProgress`: этап и счётчики из infra (`hooks.onProgress`) — его
 * текст. Полоса `increment` не используется: она монотонна на всё уведомление, а у этапов независимые
 * total — процент стоит в тексте. Модальные вопросы ожидаются намеренно (без ответа операции некуда
 * идти), а итоговые тосты — без `await` (запрет №18): `withProgress` и есть сама операция.
 */
export async function runAgentConfigurationOperation(
  options: RunAgentOptions,
  operation: (service: AgentOperationService, hooks: AgentOperationUiHooks) => Promise<void>
): Promise<boolean> {
  options.outputChannel.appendLine(`[agent] Старт: ${options.progressTitle}`);
  beginConfigurationOperationStatus(options.progressTitle, options.progressStartMessage);
  options.hooks?.onProgressMessage?.(options.progressStartMessage);
  options.onProgressMessage?.(options.progressStartMessage);

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: options.progressTitle, cancellable: options.cancellable === true },
    (progress, token) => runInProgress(options, operation, progress, options.cancellable === true ? token : undefined)
  );
}

async function runInProgress(
  options: RunAgentOptions,
  operation: (service: AgentOperationService, hooks: AgentOperationUiHooks) => Promise<void>,
  progress: vscode.Progress<{ message?: string }>,
  cancellation: vscode.CancellationToken | undefined
): Promise<boolean> {
  const importHooks = isImportHooks(options.hooks) ? options.hooks : undefined;
  const showStatus = (statusMessage: string): void => {
    updateConfigurationOperationStatus(options.progressTitle, statusMessage);
    options.hooks?.onProgressMessage?.(statusMessage);
    options.onProgressMessage?.(statusMessage);
  };
  // `SyncProgress` шлёт веху в оба канала (журнал и UI), а итог счётчика UI мог показать раньше журнала: тот
  // же текст второй раз в уведомление и статус не повторяем — сравнение с последним показанным.
  let lastShown: string | undefined;
  const onMessage = (message: string): void => {
    options.outputChannel.appendLine(`[agent] ${message}`);
    const statusMessage = getAgentStatusMessage(message);
    if (statusMessage && message !== lastShown) {
      lastShown = message;
      showStatus(statusMessage);
      progress.report({ message: statusMessage });
    }
  };
  const buildOperationHooks = (): AgentOperationUiHooks => withQuestionJournal({
    onMessage,
    // Журнал пишет только onMessage: здесь — живой UI для промежуточных значений счётчиков.
    onProgress: (event) => {
      if (event.text === lastShown) {
        return;
      }
      lastShown = event.text;
      showStatus(trimStatusMessage(event.text));
      progress.report({ message: event.text });
    },
    onProjectFilesWillChange: importHooks
      ? (filePaths: string[]) => importHooks.beforeProjectFilesChanged?.(filePaths)
      : undefined,
    onQuestion: showAgentQuestion,
    cancellation,
    confirmMirrorSeed: options.confirmMirrorSeed,
    confirmFullDump: options.confirmFullDump,
    confirmOrphanRemoval: options.confirmOrphanRemoval,
  }, onMessage);
  const cancelSubscription = cancellation?.onCancellationRequested(() => { onMessage(CANCEL_REQUESTED_MESSAGE); });

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
  } finally {
    cancelSubscription?.dispose();
  }
}

export async function showAgentQuestion(message: AgentMessage): Promise<string | undefined> {
  const text = agentQuestionText(message);
  if (isSecretQuestion(text)) {
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
