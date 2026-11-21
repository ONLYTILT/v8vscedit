import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { ChangeDetectionRunner } from '../../infra/fs/ChangeDetectionRunner';
import { ChangeDetectionScheduler, type DetectionRunnerPort } from '../../infra/fs/ChangeDetectionScheduler';
import { ConfigurationCleanWindow } from '../../infra/fs/ConfigurationCleanWindow';
import { deferred, flushMicrotasks, ManualScheduler, type Deferred } from './support/manualScheduler';

/**
 * Планировщик фоновой проверки: окно тишины + один авторитетный проход settle + отложенные запросы.
 * Время двигает `ManualScheduler`, без реальных таймеров. Порт раннера — фейк со счётчиками; связка с
 * настоящим `ChangeDetectionRunner` (C10) проверяет итог: после операции применяется РОВНО один проход.
 */
suite('ChangeDetectionScheduler', function () {
  const SETTLE = ChangeDetectionScheduler.defaultSettleDelayMs;
  const ROOT = path.join(os.tmpdir(), 'v8-scheduler-root');
  const inside = (name: string): string => path.join(ROOT, 'Catalogs', name);
  const OUTSIDE = path.join(os.tmpdir(), 'v8-scheduler-other', 'x.xml');

  interface FakeRunner extends DetectionRunnerPort {
    requests: number;
    discards: number;
    idles: number;
    /** Промисы, возвращённые `request()`: тест резолвит их сам. */
    readonly pending: Deferred<void>[];
  }

  function fakeRunner(): FakeRunner {
    const runner: FakeRunner = {
      requests: 0,
      discards: 0,
      idles: 0,
      pending: [],
      request: () => {
        runner.requests += 1;
        const d = deferred();
        runner.pending.push(d);
        return d.promise;
      },
      discard: () => { runner.discards += 1; },
      whenIdle: () => { runner.idles += 1; return Promise.resolve(); },
    };
    return runner;
  }

  function create(options: { windowMs?: number; settleDelayMs?: number } = {}): {
    timers: ManualScheduler;
    runner: FakeRunner;
    scheduler: ChangeDetectionScheduler;
  } {
    const timers = new ManualScheduler(1_000);
    const runner = fakeRunner();
    return { timers, runner, scheduler: new ChangeDetectionScheduler(runner, { timers, ...options }) };
  }

  test('defaultSettleDelayMs = окно тишины + 1 с (16 000 мс)', () => {
    assert.strictEqual(SETTLE, ConfigurationCleanWindow.defaultDurationMs + 1_000);
    assert.strictEqual(SETTLE, 16_000);
  });

  test('C1 request() без ожидающего settle → runner.request вызван сразу', () => {
    const { runner, scheduler } = create();
    scheduler.request();
    assert.strictEqual(runner.requests, 1);
    assert.strictEqual(scheduler.settlePending, false);
  });

  test('C2 markClean([root]): окно тишины по корню, discard один раз, таймер settle на 16 000 мс', () => {
    const { timers, runner, scheduler } = create();

    scheduler.markClean([ROOT]);

    assert.strictEqual(scheduler.isSilenced(inside('a.xml')), true);
    assert.strictEqual(scheduler.isSilenced(OUTSIDE), false);
    assert.strictEqual(runner.discards, 1);
    assert.strictEqual(runner.requests, 0);
    assert.strictEqual(timers.pendingCount(), 1);
    assert.strictEqual(scheduler.settlePending, true);
    timers.advance(SETTLE - 1);
    assert.strictEqual(runner.requests, 0, 'раньше срока settle не срабатывает');
    timers.advance(1);
    assert.strictEqual(runner.requests, 1);
    assert.strictEqual(scheduler.settlePending, false);
  });

  test('C3 request() при ожидающем settle не доходит до раннера; срабатывание таймера — ровно один runner.request', () => {
    const { timers, runner, scheduler } = create();
    scheduler.markClean([ROOT]);

    scheduler.request();
    scheduler.request();
    assert.strictEqual(runner.requests, 0, 'запрос запомнен, а не выполнен');

    timers.advance(SETTLE);
    assert.strictEqual(runner.requests, 1, 'один проход покрывает все отложенные запросы');
  });

  test('C4 повторный markClean перевзводит таймер (отсчёт от последнего вызова); итог — один runner.request', () => {
    const { timers, runner, scheduler } = create();
    scheduler.markClean([ROOT]);
    timers.advance(5_000);

    scheduler.markClean([ROOT]);

    assert.strictEqual(timers.totalCleared, 1);
    assert.strictEqual(timers.pendingCount(), 1);
    assert.strictEqual(runner.discards, 2);
    timers.advance(SETTLE - 1);
    assert.strictEqual(runner.requests, 0, 'старый срок (16 000 от первого вызова) уже прошёл, а проход не начат');
    timers.advance(1);
    assert.strictEqual(runner.requests, 1);
  });

  test('C5 flush() при ожидающем settle запускает проход сейчас и ждёт его; таймер потом даёт ещё один запрос', async () => {
    const { timers, runner, scheduler } = create();
    scheduler.markClean([ROOT]);
    scheduler.request();
    let flushed = false;

    const done = scheduler.flush().then(() => { flushed = true; });
    await flushMicrotasks();

    assert.strictEqual(runner.requests, 1);
    assert.strictEqual(flushed, false, 'ждёт завершения прохода');
    assert.strictEqual(runner.idles, 0);
    runner.pending[0].resolve();
    await done;
    assert.strictEqual(flushed, true);
    assert.strictEqual(scheduler.settlePending, true, 'таймер settle не снят');

    timers.advance(SETTLE);
    assert.strictEqual(runner.requests, 2, 'авторитетный проход всё равно выполняется');
  });

  test('C5б flush() после срабатывания settle (ожидания уже нет) → только whenIdle, без нового запроса', async () => {
    const { timers, runner, scheduler } = create();
    scheduler.markClean([ROOT]);
    timers.advance(SETTLE);
    runner.pending[0].resolve();

    await scheduler.flush();

    assert.strictEqual(runner.requests, 1);
    assert.strictEqual(runner.idles, 1);
  });

  test('C5в markClean во время flush() → ожидающий дожидается ПОВТОРНОГО прохода (прерванный discard результат не годится)', async () => {
    const { runner, scheduler } = create();
    scheduler.markClean([ROOT]);
    let flushed = false;

    const done = scheduler.flush().then(() => { flushed = true; });
    await flushMicrotasks();
    assert.strictEqual(runner.requests, 1);

    scheduler.markClean([ROOT]);
    runner.pending[0].resolve();
    await flushMicrotasks();

    assert.strictEqual(runner.requests, 2, 'проход запрошен заново');
    assert.strictEqual(flushed, false, 'ждёт свежий проход');
    runner.pending[1].resolve();
    await done;
    assert.strictEqual(flushed, true);
  });

  test('C6 flush() без settle и без отложенного запроса → только whenIdle', async () => {
    const { runner, scheduler } = create();

    await scheduler.flush();

    assert.strictEqual(runner.requests, 0);
    assert.strictEqual(runner.idles, 1);
  });

  test('C7 markClean([]) — no-op: ни discard, ни таймера, ни окна', () => {
    const { timers, runner, scheduler } = create();

    scheduler.markClean([]);

    assert.strictEqual(runner.discards, 0);
    assert.strictEqual(timers.pendingCount(), 0);
    assert.strictEqual(timers.totalScheduled, 0);
    assert.strictEqual(scheduler.settlePending, false);
    assert.strictEqual(scheduler.isSilenced(inside('a.xml')), false);
  });

  test('C8 окно тишины истекает по часам таймеров независимо от settle (settle позже окна)', () => {
    const { timers, runner, scheduler } = create({ settleDelayMs: 30_000 });
    scheduler.markClean([ROOT]);

    timers.advance(ConfigurationCleanWindow.defaultDurationMs);
    assert.strictEqual(scheduler.isSilenced(inside('a.xml')), true, 'на границе окно ещё открыто');
    timers.advance(1);

    assert.strictEqual(scheduler.isSilenced(inside('a.xml')), false);
    assert.strictEqual(runner.requests, 0, 'settle ещё не сработал');
  });

  test('C8б пользовательские windowMs и settleDelayMs уважаются', () => {
    const { timers, runner, scheduler } = create({ windowMs: 100, settleDelayMs: 250 });
    scheduler.markClean([ROOT]);

    timers.advance(101);
    assert.strictEqual(scheduler.isSilenced(inside('a.xml')), false);
    timers.advance(148);
    assert.strictEqual(runner.requests, 0);
    timers.advance(1);
    assert.strictEqual(runner.requests, 1);
  });

  test('C9 dispose() снимает таймер; дальнейшие request и время к runner.request не приводят; повторный dispose безопасен', () => {
    const { timers, runner, scheduler } = create();
    scheduler.markClean([ROOT]);

    scheduler.dispose();
    scheduler.dispose();
    scheduler.request();
    timers.advance(SETTLE * 2);

    assert.strictEqual(timers.pendingCount(), 0);
    assert.strictEqual(timers.totalCleared, 1);
    assert.strictEqual(runner.requests, 0);
  });

  test('C9б dispose() без ожидающего таймера не падает; request после него игнорируется', () => {
    const { runner, scheduler } = create();
    scheduler.dispose();
    scheduler.request();
    assert.strictEqual(runner.requests, 0);
  });

  test('таймеры по умолчанию (как в Container): окно по реальным часам, dispose снимает реальный таймер settle', () => {
    const runner = fakeRunner();
    const scheduler = new ChangeDetectionScheduler(runner);

    scheduler.markClean([ROOT]);
    assert.strictEqual(scheduler.isSilenced(inside('a.xml')), true);
    assert.strictEqual(scheduler.settlePending, true);

    // Срабатывания не ждём: реальный таймер снимается сразу, и процесс тестов не держит висящий таймер.
    scheduler.dispose();
    assert.strictEqual(scheduler.settlePending, false);
    assert.strictEqual(runner.requests, 0);
  });

  suite('C10 связка с настоящим ChangeDetectionRunner', () => {
    interface Pass { readonly signal: AbortSignal; readonly value: number; resolve(): void }

    function wire(): {
      timers: ManualScheduler;
      scheduler: ChangeDetectionScheduler;
      passes: Pass[];
      applied: number[];
    } {
      const timers = new ManualScheduler(0);
      const passes: Pass[] = [];
      const applied: number[] = [];
      const runner = new ChangeDetectionRunner<number>({
        run: (signal) => new Promise<number>((resolve) => {
          const value = passes.length + 1;
          passes.push({ signal, value, resolve: () => { resolve(value); } });
        }),
        apply: (result) => { applied.push(result); },
        onError: (error) => { throw error instanceof Error ? error : new Error(String(error)); },
      });
      return { timers, scheduler: new ChangeDetectionScheduler(runner, { timers }), passes, applied };
    }

    test('сценарий БП: request (проход стартовал) → markClean → срабатывание settle: применён ровно один результат, прерванный проход не применён', async () => {
      const { timers, scheduler, passes, applied } = wire();

      scheduler.request();
      await flushMicrotasks();
      assert.strictEqual(passes.length, 1);

      scheduler.markClean([ROOT]);
      assert.strictEqual(passes[0].signal.aborted, true, 'проход A прерван discard()');
      passes[0].resolve();
      await flushMicrotasks();
      assert.strictEqual(passes.length, 1, 'повтора после discard нет');

      timers.advance(SETTLE);
      await flushMicrotasks();
      assert.strictEqual(passes.length, 2, 'проход settle');
      passes[1].resolve();
      await flushMicrotasks();

      assert.deepStrictEqual(applied, [2]);
    });

    test('сценарий хранилища: markClean → request → срабатывание: ровно один проход, начатый после markClean', async () => {
      const { timers, scheduler, passes, applied } = wire();

      scheduler.markClean([ROOT]);
      scheduler.request();
      await flushMicrotasks();
      assert.strictEqual(passes.length, 0, 'запрос отложен до settle');

      timers.advance(SETTLE);
      await flushMicrotasks();
      assert.strictEqual(passes.length, 1);
      assert.strictEqual(passes[0].signal.aborted, false);
      passes[0].resolve();
      await flushMicrotasks();

      assert.deepStrictEqual(applied, [1]);
      assert.strictEqual(passes.length, 1);
    });

    test('markClean во время flush() (ожидание идущего прохода): ожидающий получает результат свежего прохода, а не прерванного', async () => {
      const { scheduler, passes, applied } = wire();
      scheduler.request();
      await flushMicrotasks();
      let appliedAtFlush: number[] | undefined;
      const done = scheduler.flush().then(() => { appliedAtFlush = [...applied]; });

      scheduler.markClean([ROOT]);
      assert.strictEqual(passes[0].signal.aborted, true);
      passes[0].resolve();
      await flushMicrotasks();
      assert.strictEqual(passes.length, 2, 'flush запросил новый проход');
      assert.strictEqual(appliedAtFlush, undefined, 'ожидающий ещё не отпущен');

      passes[1].resolve();
      await done;
      assert.deepStrictEqual(appliedAtFlush, [2]);
      scheduler.dispose();
    });

    test('settle раньше возврата прерванного прохода: один повтор (single-flight раннера), применён только он', async () => {
      const { timers, scheduler, passes, applied } = wire();
      scheduler.request();
      await flushMicrotasks();
      scheduler.markClean([ROOT]);
      // Проход A прерван, но ещё не вернулся; settle срабатывает раньше его завершения.
      timers.advance(SETTLE);
      passes[0].resolve();
      await flushMicrotasks();
      assert.strictEqual(passes.length, 2);
      passes[1].resolve();
      await flushMicrotasks();
      assert.deepStrictEqual(applied, [2]);
    });
  });
});
