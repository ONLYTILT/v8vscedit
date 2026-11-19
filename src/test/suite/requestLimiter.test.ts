import * as assert from 'assert';
import { createRequestLimiter } from '../../infra/agent/files/RequestLimiter';

interface Gate<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function gate<T = void>(): Gate<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

suite('createRequestLimiter: семафор FIFO', () => {
  test('одновременно выполняется не больше max задач, остальные ждут (пик считается на отложенных промисах)', async () => {
    const limit = createRequestLimiter(3);
    const gates = Array.from({ length: 8 }, () => gate());
    let running = 0;
    let peak = 0;
    const tasks = gates.map((g) => limit(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await g.promise;
      running -= 1;
    }));
    await turn();
    assert.strictEqual(running, 3);
    for (const g of gates) {
      g.resolve();
      await turn();
    }
    await Promise.all(tasks);
    assert.strictEqual(peak, 3);
    assert.strictEqual(running, 0);
  });

  test('FIFO: задачи стартуют в порядке постановки', async () => {
    const limit = createRequestLimiter(2);
    const started: number[] = [];
    const gates = Array.from({ length: 6 }, () => gate());
    const tasks = gates.map((g, index) => limit(async () => { started.push(index); await g.promise; }));
    await turn();
    assert.deepStrictEqual(started, [0, 1]);
    gates[1].resolve();
    await turn();
    assert.deepStrictEqual(started, [0, 1, 2]);
    gates[0].resolve();
    await turn();
    assert.deepStrictEqual(started, [0, 1, 2, 3]);
    for (const g of gates) { g.resolve(); }
    await Promise.all(tasks);
    assert.deepStrictEqual(started, [0, 1, 2, 3, 4, 5]);
  });

  test('результат задачи возвращается вызывающему', async () => {
    const limit = createRequestLimiter(2);
    assert.strictEqual(await limit(() => Promise.resolve(42)), 42);
  });

  test('слот освобождается при отклонении задачи: ошибка пробрасывается, следующая стартует', async () => {
    const limit = createRequestLimiter(1);
    const first = gate();
    const failing = limit(async () => { await first.promise; throw new Error('сбой задачи'); });
    const next = limit(() => Promise.resolve('после сбоя'));
    await turn();
    first.resolve();
    await assert.rejects(failing, /сбой задачи/);
    assert.strictEqual(await next, 'после сбоя');
  });

  test('синхронное исключение в задаче не ломает очередь', async () => {
    const limit = createRequestLimiter(1);
    const failing = limit((): Promise<void> => { throw new Error('синхронный сбой'); });
    await assert.rejects(failing, /синхронный сбой/);
    assert.strictEqual(await limit(() => Promise.resolve(1)), 1);
  });

  test('max = 1: строгая последовательность', async () => {
    const limit = createRequestLimiter(1);
    const events: string[] = [];
    const gates = [gate(), gate(), gate()];
    const tasks = gates.map((g, index) => limit(async () => {
      events.push(`start${String(index)}`);
      await g.promise;
      events.push(`end${String(index)}`);
    }));
    for (const g of gates) {
      await turn();
      g.resolve();
    }
    await Promise.all(tasks);
    assert.deepStrictEqual(events, ['start0', 'end0', 'start1', 'end1', 'start2', 'end2']);
  });

  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`max = ${String(bad)} → RangeError`, () => {
      assert.throws(() => createRequestLimiter(bad), RangeError);
    });
  }
});
