import { ConfigurationCleanWindow } from './ConfigurationCleanWindow';

/**
 * Планировщик фоновой проверки изменений поверх `ChangeDetectionRunner`: окно тишины по корням после
 * операции с базой, ОДИН авторитетный проход по его окончании (settle) и отложенные запросы.
 *
 * Зачем: после импорта `reloadEntries` запускал проход сразу, а `markConfigurationsClean` тут же его
 * отбрасывал и ставил повтор, и через 16 с таймер давал ещё один — два-три полных прохода по выгрузке
 * подряд, из которых нужен только последний. Теперь идущий проход прерывается (`discard`), запросы до
 * settle только запоминаются (их покроет settle — он начнётся позже запроса), и порядок вызовов
 * `reloadEntries`/`markConfigurationsClean` в командах на итог не влияет.
 *
 * Проход settle не убирается: только он ловит правку пользователя, чьи события погасило окно, и правку,
 * чью оптимистичную пометку снял `markConfigurationsClean`. Без `vscode` — Container только подключает.
 */
export interface DetectionRunnerPort {
  request(): Promise<void>;
  discard(): void;
  whenIdle(): Promise<void>;
}

/** Таймеры и часы окна; структурно совместимы с тестовым `ManualScheduler`. */
export interface SettleTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface ChangeDetectionSchedulerOptions {
  readonly timers?: SettleTimers;
  readonly windowMs?: number;
  readonly settleDelayMs?: number;
}

const realTimers: SettleTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => { clearTimeout(handle as NodeJS.Timeout); },
  now: () => Date.now(),
};

export class ChangeDetectionScheduler {
  /** Окно тишины плюс запас: проход settle начинается, когда хвост событий watcher уже погашен. */
  static readonly defaultSettleDelayMs = ConfigurationCleanWindow.defaultDurationMs + 1_000;

  private readonly timers: SettleTimers;
  private readonly settleDelayMs: number;
  private readonly cleanWindow: ConfigurationCleanWindow;
  private settleHandle: unknown;
  private settleArmed = false;
  /** Счётчик `markClean`: по нему `flush` узнаёт, что за время ожидания результат прохода отброшен. */
  private cleanGeneration = 0;
  private disposed = false;

  constructor(private readonly runner: DetectionRunnerPort, options: ChangeDetectionSchedulerOptions = {}) {
    this.timers = options.timers ?? realTimers;
    this.settleDelayMs = options.settleDelayMs ?? ChangeDetectionScheduler.defaultSettleDelayMs;
    this.cleanWindow = new ConfigurationCleanWindow(
      options.windowMs ?? ConfigurationCleanWindow.defaultDurationMs,
      () => this.timers.now()
    );
  }

  get settlePending(): boolean {
    return this.settleArmed;
  }

  /**
   * Нет ожидающего settle — прогон сразу. Есть — запрос не нужен: settle поставит проход по всем
   * конфигурациям, начатый позже запроса, то есть контракт «прогон после запроса» сохраняется с
   * задержкой до `settleDelayMs` (`flush` эту задержку снимает для тех, кому ответ нужен сейчас).
   */
  request(): void {
    if (this.disposed || this.settleArmed) {
      return;
    }
    void this.runner.request();
  }

  /**
   * Операция с базой записала базовую линию для этих корней: события по ним гасятся окном, идущий
   * проход прерывается без повтора (его результат сравнивал бы со старым состоянием), settle
   * перевзводится — отсчёт от последней операции.
   */
  markClean(rootPaths: readonly string[]): void {
    if (rootPaths.length === 0 || this.disposed) {
      return;
    }
    this.cleanWindow.open(rootPaths);
    this.cleanGeneration += 1;
    this.runner.discard();
    this.clearSettle();
    this.settleArmed = true;
    this.settleHandle = this.timers.setTimeout(() => { this.fireSettle(); }, this.settleDelayMs);
  }

  /** Событие по файлу корня с открытым окном гасится целиком (см. `ConfigurationCleanWindow`). */
  isSilenced(filePath: string): boolean {
    return this.cleanWindow.isOpenFor(filePath);
  }

  /**
   * Ответ нужен сейчас («Обновить конфигурации» сразу после импорта): при ожидающем settle проход
   * запускается немедленно и дожидается; иначе — ожидание простоя. Таймер settle не снимается: события,
   * которые погасит окно после этого прохода, поймает только он.
   *
   * `markClean` во время ожидания прерывает проход без повтора (`discard`), и ожидающий получил бы
   * состояние до операции — например ложное «изменений нет» по другому корню. Поэтому при новом
   * `markClean` за время ожидания проход запрашивается и дожидается заново. Цикл конечен без лимита
   * витков: ожидающий держит замок операции, а `markClean` бывает только по её завершении, так что
   * новый виток возможен лишь в узком окне «снятие замка → markConfigurationsClean».
   */
  async flush(): Promise<void> {
    for (;;) {
      const generation = this.cleanGeneration;
      await (this.settleArmed ? this.runner.request() : this.runner.whenIdle());
      if (generation === this.cleanGeneration) {
        return;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearSettle();
  }

  private fireSettle(): void {
    this.settleArmed = false;
    this.settleHandle = undefined;
    void this.runner.request();
  }

  private clearSettle(): void {
    if (this.settleArmed) {
      this.timers.clearTimeout(this.settleHandle);
      this.settleArmed = false;
      this.settleHandle = undefined;
    }
  }
}
