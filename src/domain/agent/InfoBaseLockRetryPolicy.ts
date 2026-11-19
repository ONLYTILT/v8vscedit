/**
 * Политика повтора `connect-ib`, когда ИБ держит другой Конфигуратор (`DesignerAlreadyStarted`).
 * Повтор делается всегда, а не только после своей пакетной операции: сессия агента не знает о
 * внешних держателях (пакетный 1cv8 через PSSession, другое окно VS Code, CLI).
 *
 * 15 с — запас на порядок больше ожидаемого освобождения (файловая база — десятки мс, кластер —
 * доли секунды при штатном выходе 1cv8, секунды при обрыве). Первый повтор быстрый, дальше реже,
 * чтобы не нагружать агента: каждая попытка — команда агенту и попытка блокировки ИБ.
 */
export interface InfoBaseLockRetryOptions {
  /** Окно от ПЕРВОГО отказа; попытка, которая началась бы на границе окна или позже, не делается. */
  readonly windowMs: number;
  /** Задержка перед повтором N (1-based); дальше — последняя. */
  readonly delaysMs: readonly number[];
}

export const DEFAULT_INFO_BASE_LOCK_RETRY: InfoBaseLockRetryOptions = {
  windowMs: 15_000,
  delaysMs: [500, 1_000, 2_000],
};

export type InfoBaseLockRetryDecision =
  | { readonly action: 'retry'; readonly delayMs: number }
  | { readonly action: 'fail' };

export function decideInfoBaseLockRetry(
  ctx: { readonly failures: number; readonly elapsedMs: number },
  opts: InfoBaseLockRetryOptions
): InfoBaseLockRetryDecision {
  if (ctx.failures < 1) {
    throw new RangeError(`Число отказов должно быть ≥ 1, получено ${String(ctx.failures)}`);
  }
  if (opts.delaysMs.length === 0) {
    throw new RangeError('Список задержек повтора connect-ib пуст');
  }
  const delayMs = opts.delaysMs[Math.min(ctx.failures - 1, opts.delaysMs.length - 1)];
  return ctx.elapsedMs + delayMs < opts.windowMs ? { action: 'retry', delayMs } : { action: 'fail' };
}
