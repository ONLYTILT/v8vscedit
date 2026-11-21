/**
 * Single-flight фоновой проверки изменений выгрузки. Повторные запросы во время идущего прогона
 * схлопываются в ОДИН повтор, а не множат параллельные проходы по выгрузке. Логика вынесена из
 * Container, потому что тот исполняется в Extension Host и c8 его не инструментирует.
 */
export interface ChangeDetectionRunnerOptions<T> {
  /** Прогон; сигнал прерывает его по `discard()`/`dispose()` (на каждый прогон — свой). */
  readonly run: (signal: AbortSignal) => Promise<T>;
  readonly apply: (result: T) => void;
  readonly onError: (error: unknown) => void;
}

export class ChangeDetectionRunner<T> {
  private loop: Promise<void> | undefined;
  private rerunPending = false;
  private discardCurrent = false;
  private disposed = false;
  private controller: AbortController | undefined;

  constructor(private readonly options: ChangeDetectionRunnerOptions<T>) {}

  get running(): boolean {
    return this.loop !== undefined;
  }

  /**
   * Гарантирует прогон, НАЧАТЫЙ после вызова: прогон, стартовавший раньше, мог не увидеть правку,
   * ради которой запрос сделан. Промис резолвится при полном простое и никогда не отклоняется.
   */
  request(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.loop) {
      this.rerunPending = true;
      return this.loop;
    }
    this.loop = this.runLoop();
    return this.loop;
  }

  /**
   * Результат идущего прогона устарел (например, импорт записал новую базовую линию или правка
   * пометила конфигурацию изменённой): он отбрасывается, а повтор сравнивает уже с новым состоянием.
   */
  invalidate(): void {
    if (this.disposed || !this.loop) {
      return;
    }
    this.discardCurrent = true;
    this.rerunPending = true;
  }

  /**
   * Идущий прогон больше не нужен вовсе (операция сама записала базовую линию, а авторитетный проход
   * поставит планировщик позже): прогон прерывается сигналом, его результат и отказ отбрасываются, а
   * повтор НЕ ставится — уже поставленный снимается. Отличие от `invalidate()`: тот зовётся на каждое
   * событие watcher, и прерывание с перезапуском на тысячах событий устроило бы шторм перезапусков,
   * каждый с разбором stat-мемо выгрузки.
   */
  discard(): void {
    // Контроллер есть ровно пока идёт цикл прогонов (ставится до первого await и снимается в finally).
    if (this.disposed || !this.controller) {
      return;
    }
    this.discardCurrent = true;
    this.rerunPending = false;
    this.controller.abort();
  }

  whenIdle(): Promise<void> {
    return this.loop ?? Promise.resolve();
  }

  dispose(): void {
    this.disposed = true;
    this.rerunPending = false;
    this.controller?.abort();
  }

  private async runLoop(): Promise<void> {
    try {
      do {
        this.rerunPending = false;
        this.discardCurrent = false;
        this.controller = new AbortController();
        try {
          const result = await this.options.run(this.controller.signal);
          if (!this.isResultDiscarded()) {
            this.options.apply(result);
          }
        } catch (error) {
          // Отказ отброшенного прогона (в том числе AbortError от discard/dispose) — не ошибка проверки:
          // его результат никому не нужен, а повтор, если он поставлен, сообщит о стойком сбое сам.
          if (!this.isResultDiscarded()) {
            this.options.onError(error);
          }
        }
      } while (this.shouldRerun());
    } finally {
      this.loop = undefined;
      this.controller = undefined;
    }
  }

  // Флаги читаются через методы, а не напрямую: их меняют request/invalidate/dispose во время
  // `await`, а анализ потока TypeScript этого не видит и считал бы условия константными.
  private isResultDiscarded(): boolean {
    return this.disposed || this.discardCurrent;
  }

  private shouldRerun(): boolean {
    return this.rerunPending && !this.disposed;
  }
}
