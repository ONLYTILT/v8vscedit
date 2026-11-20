// Перенесено из ExtensionCommandRunner.ts (Э2) без изменения поведения; публичный API реэкспортируется оттуда.
import * as vscode from 'vscode';
import { OperationStageFeed } from '../../../infra/progress/OperationStageFeed';

/**
 * Единственная лента этапов операций с конфигурацией и хранилищем. Публикуют в неё оба статус-бара
 * (через них уже идёт весь прогресс раннеров), читают пульс долгих MCP-вызовов и
 * `v8vscedit_repository_status` — агент видит тот же этап, что человек в статус-баре.
 */
export const operationStageFeed = new OperationStageFeed();

let statusBarItem: vscode.StatusBarItem | undefined;
let clearStatusTimer: NodeJS.Timeout | undefined;
// Счётчик активных операций: параллельные операции делят один статус-бар-синглтон,
// поэтому скрывать его по таймеру можно только когда завершилась ПОСЛЕДНЯЯ (count → 0).
let activeOperationCount = 0;

/**
 * Компат-обёртка: `running=true` трактуется как ГРАНИЦА старта операции (begin),
 * `running=false` — как терминал (end). Промежуточные обновления текста прогресса
 * должны идти через {@link updateConfigurationOperationStatus}, а НЕ сюда, иначе
 * счётчик активных операций растёт на каждом прогресс-сообщении и статус-бар
 * перестаёт скрываться (регресс M9). Тесты используют только begin/end.
 */
export function setConfigurationOperationStatus(title: string, message: string, running: boolean): void {
  if (running) {
    beginConfigurationOperationStatus(title, message);
  } else {
    endConfigurationOperationStatus(title, message);
  }
}

/** Начало операции: инкремент счётчика активных операций + спиннер-текст. */
export function beginConfigurationOperationStatus(title: string, message: string): void {
  ensureConfigurationStatusItem();
  cancelConfigurationHideTimer();
  activeOperationCount++;
  showSpinnerStatus(title, message);
  operationStageFeed.publish('begin', title, message);
}

/** Обновление текста прогресса без изменения счётчика активных операций. */
export function updateConfigurationOperationStatus(title: string, message: string): void {
  ensureConfigurationStatusItem();
  cancelConfigurationHideTimer();
  showSpinnerStatus(title, message);
  operationStageFeed.publish('update', title, message);
}

/**
 * Терминал операции: декремент счётчика; при достижении нуля — таймер скрытия.
 * Если `title`/`message` заданы — показывает финальный check-текст; без них
 * оставляет уже отображённый текст (используется финализирующим
 * `clearConfigurationProgress`, где сообщение уже выставлено предыдущим шагом).
 */
export function endConfigurationOperationStatus(title?: string, message?: string): void {
  ensureConfigurationStatusItem();
  cancelConfigurationHideTimer();
  activeOperationCount = Math.max(0, activeOperationCount - 1);

  if (statusBarItem && title !== undefined && message !== undefined) {
    const text = `${title}: ${message}`;
    statusBarItem.text = `$(check) ${trimStatusMessage(text)}`;
    statusBarItem.tooltip = text;
    statusBarItem.show();
  }
  // Без title/message этап уже выставлен предыдущим шагом — публиковать нечего.
  if (title !== undefined && message !== undefined) {
    operationStageFeed.publish('end', title, message);
  }

  // Скрываем статус только когда завершилась последняя активная операция —
  // завершение одной из параллельных операций не должно гасить статус остальных.
  if (activeOperationCount === 0) {
    clearStatusTimer = setTimeout(() => {
      statusBarItem?.hide();
      clearStatusTimer = undefined;
    }, 5_000);
  }
}

function ensureConfigurationStatusItem(): void {
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.name = '1С: операция с конфигурацией';
  }
}

function cancelConfigurationHideTimer(): void {
  if (clearStatusTimer) {
    clearTimeout(clearStatusTimer);
    clearStatusTimer = undefined;
  }
}

function showSpinnerStatus(title: string, message: string): void {
  const text = `${title}: ${message}`;
  if (statusBarItem) {
    statusBarItem.text = `$(sync~spin) ${trimStatusMessage(text)}`;
    statusBarItem.tooltip = text;
    statusBarItem.show();
  }
}

export function trimStatusMessage(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 80) {
    return oneLine;
  }
  return `${oneLine.slice(0, 77)}...`;
}

/**
 * Сброс статус-бара операций на остановке расширения: элемент создаётся лениво и не
 * попадает в context.subscriptions. Тело перенесено из disposeCachedAgentOperationServices
 * без изменений — вызывается оттуда же в прежнем порядке (до остановки сервисов агента).
 */
export function resetConfigurationOperationStatus(): void {
  if (clearStatusTimer) {
    clearTimeout(clearStatusTimer);
    clearStatusTimer = undefined;
  }
  statusBarItem?.dispose();
  statusBarItem = undefined;
  activeOperationCount = 0;
}
