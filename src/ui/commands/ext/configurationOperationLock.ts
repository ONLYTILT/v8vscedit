/**
 * Общий взаимный замок операций над конфигурацией/расширением.
 *
 * Извлечён из `ExtensionCommands.ts`, где модульный флаг
 * `isUpdatingConfigurations` был развёрнут вручную трижды (импорт конфигураций,
 * обновление изменённых, общий `runExclusiveConfigurationOperation`). Замок
 * ОБЩИЙ (module-level singleton) сознательно: импорт из базы, обновление базы
 * и загрузка CF-файла работают с одной и той же базой и выгрузкой, поэтому
 * параллельный запуск любой пары из них повредил бы данные.
 *
 * `setContext v8vscedit.isUpdatingConfigurations` переключается здесь же —
 * это тот же ключ, что стоит в `enablement` команд `package.json`, и он не
 * должен расходиться с реальным состоянием замка.
 */
import * as vscode from 'vscode';

const BUSY_CONTEXT_KEY = 'v8vscedit.isUpdatingConfigurations';

let operationRunning = false;
// Момент взятия замка (мс epoch): длительность и свежесть этапа в `v8vscedit_repository_status`.
let operationStartedAt: number | undefined;
const idleActions: (() => void)[] = [];

/** Идёт ли сейчас эксклюзивная операция над конфигурацией. */
export function isConfigurationOperationRunning(): boolean {
  return operationRunning;
}

/**
 * Пытается занять замок. Возвращает `false`, если операция уже идёт, — тогда
 * вызывающий обязан просто выйти, НЕ освобождая чужой замок.
 */
export async function tryBeginConfigurationOperation(): Promise<boolean> {
  if (operationRunning) {
    return false;
  }
  operationRunning = true;
  operationStartedAt = Date.now();
  await vscode.commands.executeCommand('setContext', BUSY_CONTEXT_KEY, true);
  return true;
}

/** Освобождает замок. Вызывается только тем, кто его занял (обычно в `finally`). */
export async function endConfigurationOperation(): Promise<void> {
  operationRunning = false;
  operationStartedAt = undefined;
  // Синхронно, до первого await: следующая операция не успеет занять замок раньше отложенных действий.
  for (const action of idleActions.splice(0)) {
    try {
      action();
    } catch {
      // Отказ одного действия не должен отменить остальные и оставить ключ занятости выставленным;
      // сообщать о своём сбое — забота самого действия (у него есть журнал, у замка — нет).
    }
  }
  await vscode.commands.executeCommand('setContext', BUSY_CONTEXT_KEY, false);
}

/**
 * Выполняет `action` сразу, если операция не идёт, иначе — при освобождении замка. Нужен тем, кто
 * меняет общее состояние операций (сброс кэша сервисов агента при смене настроек): закрыть SSH под
 * идущей операцией значит оборвать её на середине.
 */
export function runWhenConfigurationOperationIdle(action: () => void): void {
  if (operationRunning) {
    idleActions.push(action);
    return;
  }
  action();
}

/** Момент старта идущей операции или `undefined`, если замок свободен. */
export function getConfigurationOperationStartedAt(): number | undefined {
  return operationStartedAt;
}

export const CONFIGURATION_OPERATION_BUSY_MESSAGE = 'Операция с конфигурацией уже выполняется. Дождитесь её завершения.';

/**
 * Текст «занято» для агента: у него нет статус-бара, поэтому указывается, где смотреть состояние
 * идущей операции. UI-тексты (тосты) остаются на базовом сообщении.
 */
export const MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE =
  `${CONFIGURATION_OPERATION_BUSY_MESSAGE} Состояние идущей операции — v8vscedit_repository_status (operationRunning, currentOperation, lastOperation); повторите вызов после её завершения.`;

/**
 * Выполняет `operation` под общим замком. При занятом замке — уведомление без `await`
 * (запрет №18: ожидание закрытия нотификации не должно задерживать вызывающего) и `undefined`;
 * чужой замок не снимается.
 */
export async function runWithConfigurationOperationLock<T>(operation: () => Promise<T>): Promise<T | undefined> {
  if (!await tryBeginConfigurationOperation()) {
    void vscode.window.showInformationMessage(CONFIGURATION_OPERATION_BUSY_MESSAGE);
    return undefined;
  }
  try {
    return await operation();
  } finally {
    await endConfigurationOperation();
  }
}

/**
 * Вариант для MCP: у агента нет тостов, поэтому занятый замок — исключение с
 * `MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE` (его превращает в `isError` обёртка инструмента). Чужой
 * замок не снимается; исключение операции пробрасывается как есть, замок освобождается.
 */
export async function runWithConfigurationOperationLockOrThrow<T>(operation: () => Promise<T>): Promise<T> {
  if (!await tryBeginConfigurationOperation()) {
    throw new Error(MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE);
  }
  try {
    return await operation();
  } finally {
    await endConfigurationOperation();
  }
}
