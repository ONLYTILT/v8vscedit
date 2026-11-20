/**
 * Пульс долгого MCP-вызова: периодические уведомления, пока инструмент работает.
 *
 * Зачем: клиент MCP рвёт молчащий поток по тайм-ауту (журнал Claude Code — обрывы ровно раз в 6 мин,
 * `TimeoutError`), а тайм-аут запроса SDK клиента (60 с) сбрасывается по `notifications/progress`
 * (`resetTimeoutOnProgress`). Подробности — docs/plans/mcp-long-running-plan.md.
 *
 * Чистая механика без SDK и vscode: доставку (`send`) и источник этапа (`readStage`) передаёт
 * вызывающий (`ui/mcp/registration/McpMutationGate.wrapLongRunning`), время — `PulseScheduler`
 * (в тестах — ручной).
 */
import type { OperationStage } from '../progress/OperationStageFeed';

/**
 * 20 с: запас ×15 к наблюдаемому обрыву (~300 с), меньше 30 с порога «still running» клиентов и
 * три пульса на окно 60 с тайм-аута запроса SDK.
 */
export const MCP_PULSE_INTERVAL_MS = 20_000;

export interface PulseScheduler {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realPulseScheduler: PulseScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface PulseTick {
  readonly sequence: number;
  readonly progress: number;
  readonly elapsedMs: number;
  readonly stage?: { title: string; stage: string };
}

export interface RequestPulseOptions {
  readonly scheduler: PulseScheduler;
  readonly intervalMs: number;
  /** Этап с `at` раньше старта вызова отбрасывается: это остаток чужой операции. */
  readonly readStage: () => OperationStage | undefined;
  readonly send: (tick: PulseTick) => Promise<void>;
  readonly onSendError?: (error: unknown, tick: PulseTick) => void;
  readonly signal?: AbortSignal;
}

export interface RequestPulse {
  /** Идемпотентен. */
  stop(): void;
}

export function startRequestPulse(options: RequestPulseOptions): RequestPulse {
  const { scheduler, signal } = options;
  const startedAt = scheduler.now();
  let stopped = false;
  let handle: unknown;
  let armed = false;
  let sequence = 0;
  let progress = 0;

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (armed) {
      armed = false;
      scheduler.clearTimeout(handle);
    }
    signal?.removeEventListener('abort', stop);
  };

  const deliver = async (tick: PulseTick): Promise<void> => {
    try {
      await options.send(tick);
    } catch (error) {
      // Отказ доставки (поток закрыт, клиент ушёл) не должен ронять вызов: пульс — вспомогательный канал.
      options.onSendError?.(error, tick);
    }
  };

  const arm = (): void => {
    if (stopped) {
      return;
    }
    armed = true;
    handle = scheduler.setTimeout(fire, options.intervalMs);
  };

  function fire(): void {
    armed = false;
    if (stopped) {
      return;
    }
    const elapsedMs = scheduler.now() - startedAt;
    sequence += 1;
    // Монотонный рост обязателен: клиент SDK игнорирует progress, не превышающий предыдущий.
    progress = Math.max(progress + 1, Math.floor(elapsedMs / 1000));
    const stage = options.readStage();
    const tick: PulseTick = stage && stage.at >= startedAt
      ? { sequence, progress, elapsedMs, stage: { title: stage.title, stage: stage.stage } }
      : { sequence, progress, elapsedMs };
    // Следующий таймер — только после завершения отправки: медленный поток не копит наложенные тики.
    void deliver(tick).then(arm);
  }

  if (signal?.aborted) {
    stopped = true;
    return { stop };
  }
  signal?.addEventListener('abort', stop, { once: true });
  arm();
  return { stop };
}

export async function runWithRequestPulse<T>(options: RequestPulseOptions, fn: () => Promise<T>): Promise<T> {
  const pulse = startRequestPulse(options);
  try {
    return await fn();
  } finally {
    pulse.stop();
  }
}

export type McpPulseNotification =
  | { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; message: string } }
  | { method: 'notifications/message'; params: { level: 'info'; logger: 'v8vscedit'; data: string } };

/**
 * Уведомление пульса для потока вызова: при токене прогресса — `notifications/progress` (сбрасывает
 * тайм-аут запроса клиента), без него — `notifications/message` (держит поток живым). Уровень `info`
 * фиксирован: `logging/setLevel` клиента SDK сервера учесть не даёт (`isMessageIgnored` приватный).
 */
export function buildPulseNotification(
  toolName: string,
  tick: PulseTick,
  progressToken: string | number | undefined
): McpPulseNotification {
  const text = formatPulseText(toolName, tick);
  // Токен 0 и пустая строка допустимы: проверка именно на undefined.
  if (progressToken !== undefined) {
    return { method: 'notifications/progress', params: { progressToken, progress: tick.progress, message: text } };
  }
  return { method: 'notifications/message', params: { level: 'info', logger: 'v8vscedit', data: text } };
}

export function formatPulseText(toolName: string, tick: PulseTick): string {
  const base = `${toolName}: выполняется ${formatElapsed(tick.elapsedMs)}`;
  return tick.stage ? `${base} — ${tick.stage.title}: ${tick.stage.stage}` : base;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${String(totalSeconds)} с`;
  }
  if (totalSeconds < 3600) {
    return `${String(Math.floor(totalSeconds / 60))} мин ${String(totalSeconds % 60)} с`;
  }
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${String(Math.floor(totalSeconds / 3600))} ч ${String(minutes).padStart(2, '0')} мин`;
}
