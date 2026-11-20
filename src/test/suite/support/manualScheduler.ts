/**
 * Ручной планировщик для тестов пульса долгих MCP-вызовов: время и таймеры двигает ТЕСТ, а не стена
 * часов. Структурно совместим с `PulseScheduler` (`infra/mcp/McpRequestPulse.ts`).
 *
 * Ожидания «когда таймер взведён/погашен» выражены промисами (`whenPendingCount`), а не опросом по
 * времени: интеграционные тесты по реальному HTTP ждут события, а не угадывают задержки.
 */

interface ManualTimer {
  readonly at: number;
  readonly order: number;
  readonly callback: () => void;
}

export interface FireNextOptions {
  /** Не двигать часы к сроку таймера: имитирует «часы стоят» (ручная проверка роста progress). */
  readonly holdClock?: boolean;
}

/** Выпускает макро-задачу: к её началу все накопленные микрозадачи (цепочки promise) выполнены. */
export function flushMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

export class ManualScheduler {
  /** Сколько таймеров было взведено за всё время (в том числе уже сработавших и погашенных). */
  totalScheduled = 0;
  /** Сколько раз вызван `clearTimeout` с живым таймером. */
  totalCleared = 0;

  private time: number;
  private nextHandle = 1;
  private readonly timers = new Map<number, ManualTimer>();
  private readonly waiters: { readonly count: number; readonly resolve: () => void }[] = [];

  constructor(startTime = 0) {
    this.time = startTime;
  }

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): number {
    const handle = this.nextHandle++;
    this.totalScheduled += 1;
    this.timers.set(handle, { at: this.time + ms, order: handle, callback });
    this.notify();
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number' && this.timers.delete(handle)) {
      this.totalCleared += 1;
      this.notify();
    }
  }

  pendingCount(): number {
    return this.timers.size;
  }

  /** Двигает часы на `ms`, по пути синхронно запуская все срочные таймеры в порядке сроков. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const next = this.earliest();
      if (!next || next[1].at > target) {
        break;
      }
      this.run(next[0], next[1], false);
    }
    this.time = target;
  }

  /**
   * Запускает ближайший таймер (часы переходят к его сроку, если не задан `holdClock`) и отдаёт
   * управление, пока все микрозадачи (завершение `send`, перевзвод таймера) не выполнятся.
   */
  async fireNext(options: FireNextOptions = {}): Promise<void> {
    const next = this.earliest();
    if (!next) {
      throw new Error('fireNext: нет взведённых таймеров');
    }
    this.run(next[0], next[1], options.holdClock === true);
    await flushMicrotasks();
  }

  /** Резолвится, когда число взведённых таймеров станет равно `count` (сразу, если уже равно). */
  whenPendingCount(count: number): Promise<void> {
    if (this.timers.size === count) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push({ count, resolve }));
  }

  private earliest(): [number, ManualTimer] | undefined {
    let best: [number, ManualTimer] | undefined;
    for (const entry of this.timers) {
      if (!best || entry[1].at < best[1].at || (entry[1].at === best[1].at && entry[1].order < best[1].order)) {
        best = entry;
      }
    }
    return best;
  }

  private run(handle: number, timer: ManualTimer, holdClock: boolean): void {
    this.timers.delete(handle);
    if (!holdClock && timer.at > this.time) {
      this.time = timer.at;
    }
    this.notify();
    timer.callback();
  }

  private notify(): void {
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      if (this.waiters[index].count === this.timers.size) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }
}

/** Отложенный промис: резолв/реджект снаружи (замена таймингам в интеграционных тестах). */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
