import * as assert from 'assert';
import { ChangeDetectionRunner } from '../../infra/fs/ChangeDetectionRunner';

/**
 * Single-flight фоновой проверки изменений. Логика вынесена из Container (его c8 не
 * инструментирует), поэтому весь протокол — здесь, на управляемых промисах без таймеров:
 * тест сам решает, когда «прогон» завершается, и гонок с реальным временем нет.
 */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Дать отработать микрозадачам (продолжениям await внутри раннера). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

interface Harness {
  readonly runner: ChangeDetectionRunner<number>;
  readonly runs: Deferred<number>[];
  readonly applied: number[];
  readonly errors: unknown[];
  applyThrows?: Error;
}

function createHarness(): Harness {
  const runs: Deferred<number>[] = [];
  const applied: number[] = [];
  const errors: unknown[] = [];
  const harness: Harness = {
    runs,
    applied,
    errors,
    runner: new ChangeDetectionRunner<number>({
      run: () => {
        const d = deferred<number>();
        runs.push(d);
        return d.promise;
      },
      apply: (result) => {
        if (harness.applyThrows !== undefined) {
          throw harness.applyThrows;
        }
        applied.push(result);
      },
      onError: (error) => { errors.push(error); },
    }),
  };
  return harness;
}

suite('ChangeDetectionRunner', () => {
  test('request() в простое: один прогон, результат применён, промис резолвится после apply', async () => {
    const h = createHarness();
    let settled = false;
    const done = h.runner.request().then(() => { settled = true; });
    await flush();
    assert.strictEqual(h.runs.length, 1);
    assert.strictEqual(settled, false);
    h.runs[0].resolve(5);
    await done;
    assert.deepStrictEqual(h.applied, [5]);
    assert.strictEqual(settled, true);
    assert.deepStrictEqual(h.errors, []);
  });

  test('запросы во время прогона схлопываются в ОДИН повтор; оба результата применены по порядку', async () => {
    const h = createHarness();
    const first = h.runner.request();
    await flush();
    const second = h.runner.request();
    const third = h.runner.request();
    await flush();
    assert.strictEqual(h.runs.length, 1, 'параллельного прохода нет');

    h.runs[0].resolve(1);
    await flush();
    assert.strictEqual(h.runs.length, 2, 'ровно один повтор');
    assert.deepStrictEqual(h.applied, [1]);

    h.runs[1].resolve(2);
    await Promise.all([first, second, third]);
    assert.strictEqual(h.runs.length, 2);
    assert.deepStrictEqual(h.applied, [1, 2]);
  });

  test('промис request(), вызванного во время прогона, резолвится только после повтора', async () => {
    const h = createHarness();
    void h.runner.request();
    await flush();
    let lateSettled = false;
    const late = h.runner.request().then(() => { lateSettled = true; });
    h.runs[0].resolve(1);
    await flush();
    assert.strictEqual(lateSettled, false, 'прогон, начатый до запроса, не удовлетворяет его');
    h.runs[1].resolve(2);
    await late;
    assert.strictEqual(lateSettled, true);
  });

  test('после полного простоя новый request() запускает новый прогон', async () => {
    const h = createHarness();
    const first = h.runner.request();
    await flush();
    h.runs[0].resolve(1);
    await first;
    const second = h.runner.request();
    await flush();
    assert.strictEqual(h.runs.length, 2);
    h.runs[1].resolve(2);
    await second;
    assert.deepStrictEqual(h.applied, [1, 2]);
  });

  test('invalidate() во время прогона: его результат отброшен, применён результат повтора', async () => {
    const h = createHarness();
    const done = h.runner.request();
    await flush();
    h.runner.invalidate();
    h.runs[0].resolve(111);
    await flush();
    assert.deepStrictEqual(h.applied, [], 'устаревший результат не применяется');
    assert.strictEqual(h.runs.length, 2);
    h.runs[1].resolve(2);
    await done;
    assert.deepStrictEqual(h.applied, [2]);
  });

  test('invalidate() в простое — прогона нет', async () => {
    const h = createHarness();
    h.runner.invalidate();
    await flush();
    assert.strictEqual(h.runs.length, 0);
    assert.strictEqual(h.runner.running, false);
  });

  test('ошибка run → onError, apply не вызван, whenIdle резолвится, следующий request работает', async () => {
    const h = createHarness();
    const done = h.runner.request();
    await flush();
    const failure = new Error('сбой проверки');
    h.runs[0].reject(failure);
    await done;
    await h.runner.whenIdle();
    assert.deepStrictEqual(h.errors, [failure]);
    assert.deepStrictEqual(h.applied, []);

    const next = h.runner.request();
    await flush();
    h.runs[1].resolve(3);
    await next;
    assert.deepStrictEqual(h.applied, [3]);
  });

  test('ошибка run с ожидающим повтором → onError, повтор всё равно выполняется', async () => {
    const h = createHarness();
    const done = h.runner.request();
    await flush();
    void h.runner.request();
    h.runs[0].reject(new Error('первый'));
    await flush();
    assert.strictEqual(h.runs.length, 2);
    h.runs[1].resolve(9);
    await done;
    assert.strictEqual(h.errors.length, 1);
    assert.deepStrictEqual(h.applied, [9]);
  });

  test('ошибка в apply → onError, промис не отклоняется', async () => {
    const h = createHarness();
    const failure = new Error('apply упал');
    h.applyThrows = failure;
    const done = h.runner.request();
    await flush();
    h.runs[0].resolve(1);
    await done;
    assert.deepStrictEqual(h.errors, [failure]);
  });

  test('whenIdle(): в простое резолвится сразу; во время прогона с повтором — после повтора', async () => {
    const h = createHarness();
    await h.runner.whenIdle();

    void h.runner.request();
    await flush();
    void h.runner.request();
    let idle = false;
    const waiting = h.runner.whenIdle().then(() => { idle = true; });
    h.runs[0].resolve(1);
    await flush();
    assert.strictEqual(idle, false, 'повтор ещё идёт');
    h.runs[1].resolve(2);
    await waiting;
    assert.strictEqual(idle, true);
    assert.deepStrictEqual(h.applied, [1, 2]);
  });

  test('running: false до, true во время, false после', async () => {
    const h = createHarness();
    assert.strictEqual(h.runner.running, false);
    const done = h.runner.request();
    await flush();
    assert.strictEqual(h.runner.running, true);
    h.runs[0].resolve(1);
    await done;
    assert.strictEqual(h.runner.running, false);
  });

  test('dispose() во время прогона: результат не применён, повтор отменён, промисы резолвятся', async () => {
    const h = createHarness();
    const done = h.runner.request();
    await flush();
    void h.runner.request();
    h.runner.dispose();
    h.runs[0].resolve(1);
    await done;
    await h.runner.whenIdle();
    assert.deepStrictEqual(h.applied, []);
    assert.strictEqual(h.runs.length, 1, 'повтор после dispose не запускается');
    assert.strictEqual(h.runner.running, false);
  });

  test('dispose() во время прогона: отказ после dispose не уходит в onError', async () => {
    const h = createHarness();
    const done = h.runner.request();
    await flush();
    h.runner.dispose();
    h.runs[0].reject(new Error('после dispose'));
    await done;
    assert.deepStrictEqual(h.errors, []);
  });

  test('request() после dispose — run не вызывается, промис резолвлен; повторный dispose безопасен', async () => {
    const h = createHarness();
    h.runner.dispose();
    h.runner.dispose();
    await h.runner.request();
    h.runner.invalidate();
    await flush();
    assert.strictEqual(h.runs.length, 0);
    await h.runner.whenIdle();
  });
});
