/**
 * Семафор FIFO: не больше `max` одновременных задач. Нужен как общий бюджет запросов на одно
 * соединение, независимо от того, сколько вложенных пулов его делят (пул файлов × пул каталогов
 * иначе открывал бы сотни дескрипторов на сервере). Слот освобождается и при отказе задачи.
 */
export function createRequestLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`Предел одновременных запросов должен быть целым ≥ 1, получено ${String(max)}`);
  }
  let active = 0;
  const waiting: (() => void)[] = [];

  const release = (): void => {
    const next = waiting.shift();
    if (next) {
      // Слот переходит ожидающему напрямую — счётчик не опускается, чтобы новая задача не обогнала очередь.
      next();
      return;
    }
    active -= 1;
  };

  const acquire = (): Promise<void> => {
    if (active < max) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiting.push(resolve));
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}
