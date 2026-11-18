/**
 * Single-flight фоновой проверки изменений выгрузки. Повторные запросы во время идущего прогона
 * схлопываются в ОДИН повтор, а не множат параллельные проходы по выгрузке. Логика вынесена из
 * Container, потому что тот исполняется в Extension Host и c8 его не инструментирует.
 */
export interface ChangeDetectionRunnerOptions<T> {
  readonly run: () => Promise<T>;
  readonly apply: (result: T) => void;
  readonly onError: (error: unknown) => void;
}

export class ChangeDetectionRunner<T> {
  private loop: Promise<void> | undefined;
  private rerunPending = false;
  private discardCurrent = false;
  private disposed = false;

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

  whenIdle(): Promise<void> {
    return this.loop ?? Promise.resolve();
  }

  dispose(): void {
    this.disposed = true;
    this.rerunPending = false;
  }

  private async runLoop(): Promise<void> {
    try {
      do {
        this.rerunPending = false;
        this.discardCurrent = false;
        try {
          const result = await this.options.run();
          if (!this.isResultDiscarded()) {
            this.options.apply(result);
          }
        } catch (error) {
          if (!this.isDisposed()) {
            this.options.onError(error);
          }
        }
      } while (this.shouldRerun());
    } finally {
      this.loop = undefined;
    }
  }

  // Флаги читаются через методы, а не напрямую: их меняют request/invalidate/dispose во время
  // `await`, а анализ потока TypeScript этого не видит и считал бы условия константными.
  private isDisposed(): boolean {
    return this.disposed;
  }

  private isResultDiscarded(): boolean {
    return this.disposed || this.discardCurrent;
  }

  private shouldRerun(): boolean {
    return this.rerunPending && !this.disposed;
  }
}
