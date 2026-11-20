import * as vscode from 'vscode';

/**
 * Статус-бар операций хранилища: общий для всех операций, скрывается по таймеру после последней.
 * Вынесен из RepositoryCommandRunner — у статуса своё состояние, не связанное с запуском операции.
 */

let statusBarItem: vscode.StatusBarItem | undefined;
let clearStatusTimer: NodeJS.Timeout | undefined;
// Счётчик активных операций хранилища: параллельные операции делят один статус-бар,
// поэтому скрывать его по таймеру можно только когда завершилась последняя (count → 0).
let activeOperationCount = 0;

export function trimStatusMessage(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 80) {
    return oneLine;
  }
  return `${oneLine.slice(0, 77)}...`;
}

/**
 * Компат-обёртка: `running=true` — граница старта операции (begin), `running=false` —
 * терминал (end). Промежуточные обновления текста прогресса должны идти через
 * {@link updateRepositoryOperationStatus}, иначе счётчик активных операций растёт на
 * каждом прогресс-сообщении и статус-бар перестаёт скрываться (регресс M9).
 */
export function setRepositoryOperationStatus(title: string, message: string, running: boolean): void {
  if (running) {
    beginRepositoryOperationStatus(title, message);
  } else {
    endRepositoryOperationStatus(title, message);
  }
}

/** Начало операции хранилища: инкремент счётчика + спиннер-текст. */
export function beginRepositoryOperationStatus(title: string, message: string): void {
  ensureRepositoryStatusItem();
  cancelRepositoryHideTimer();
  activeOperationCount++;
  showRepositorySpinnerStatus(title, message);
}

/** Обновление текста прогресса без изменения счётчика активных операций. */
export function updateRepositoryOperationStatus(title: string, message: string): void {
  ensureRepositoryStatusItem();
  cancelRepositoryHideTimer();
  showRepositorySpinnerStatus(title, message);
}

/** Терминал операции хранилища: декремент счётчика; при нуле — таймер скрытия. */
export function endRepositoryOperationStatus(title: string, message: string): void {
  ensureRepositoryStatusItem();
  cancelRepositoryHideTimer();
  activeOperationCount = Math.max(0, activeOperationCount - 1);

  const text = `${title}: ${message}`;
  if (statusBarItem) {
    statusBarItem.text = `$(check) ${trimStatusMessage(text)}`;
    statusBarItem.tooltip = text;
    statusBarItem.show();
  }

  // Скрываем статус только когда завершилась последняя активная операция хранилища.
  if (activeOperationCount === 0) {
    clearStatusTimer = setTimeout(() => {
      statusBarItem?.hide();
      clearStatusTimer = undefined;
    }, 5_000);
  }
}

function ensureRepositoryStatusItem(): void {
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
    statusBarItem.name = '1С: хранилище конфигурации';
  }
}

function cancelRepositoryHideTimer(): void {
  if (clearStatusTimer) {
    clearTimeout(clearStatusTimer);
    clearStatusTimer = undefined;
  }
}

function showRepositorySpinnerStatus(title: string, message: string): void {
  const text = `${title}: ${message}`;
  if (statusBarItem) {
    statusBarItem.text = `$(sync~spin) ${trimStatusMessage(text)}`;
    statusBarItem.tooltip = text;
    statusBarItem.show();
  }
}

/**
 * Освобождает лениво созданный статус-бар хранилища на остановке расширения.
 * Статус-бар не попадает в context.subscriptions, поэтому его нужно диспозить явно
 * (симметрично disposeCachedAgentOperationServices для ExtensionCommandRunner).
 */
export function disposeRepositoryCommandStatusBar(): void {
  if (clearStatusTimer) {
    clearTimeout(clearStatusTimer);
    clearStatusTimer = undefined;
  }
  statusBarItem?.dispose();
  statusBarItem = undefined;
  activeOperationCount = 0;
}
