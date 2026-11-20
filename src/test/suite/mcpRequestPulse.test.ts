/**
 * Тесты пульса долгих MCP-вызовов (`src/infra/mcp/McpRequestPulse.ts`, контракт плана 1.2).
 * Время — только ручной планировщик (`support/manualScheduler.ts`): ни одного реального sleep.
 */
import * as assert from 'assert';
import { ManualScheduler, deferred, flushMicrotasks } from './support/manualScheduler';
import type { OperationStage } from '../../infra/progress/OperationStageFeed';
import {
  MCP_PULSE_INTERVAL_MS,
  buildPulseNotification,
  formatElapsed,
  formatPulseText,
  realPulseScheduler,
  runWithRequestPulse,
  startRequestPulse,
  type PulseTick,
  type RequestPulseOptions,
} from '../../infra/mcp/McpRequestPulse';

const INTERVAL = 10_000;

interface Rig {
  readonly scheduler: ManualScheduler;
  readonly sent: PulseTick[];
  readonly errors: { error: unknown; tick: PulseTick }[];
  stage: OperationStage | undefined;
  options(overrides?: Partial<RequestPulseOptions>): RequestPulseOptions;
}

function rig(startTime = 0): Rig {
  const scheduler = new ManualScheduler(startTime);
  const state: Rig = {
    scheduler,
    sent: [],
    errors: [],
    stage: undefined,
    options(overrides = {}) {
      return {
        scheduler,
        intervalMs: INTERVAL,
        readStage: () => state.stage,
        send: (tick) => { state.sent.push(tick); return Promise.resolve(); },
        onSendError: (error, tick) => { state.errors.push({ error, tick }); },
        ...overrides,
      };
    },
  };
  return state;
}

suite('McpRequestPulse — пульс долгих вызовов', () => {
  suite('константы и реальный планировщик', () => {
    test('интервал пульса 20 с (запас ×15 к ~300 с, меньше 30 с «still running»)', () => {
      assert.strictEqual(MCP_PULSE_INTERVAL_MS, 20_000);
    });

    test('realPulseScheduler: now() — часы Date.now; setTimeout срабатывает; погашенный таймер не срабатывает', async () => {
      const before = Date.now();
      const now = realPulseScheduler.now();
      assert.ok(now >= before && now <= Date.now(), 'now() идёт по Date.now');

      let cancelledFired = false;
      const cancelled = realPulseScheduler.setTimeout(() => { cancelledFired = true; }, 0);
      realPulseScheduler.clearTimeout(cancelled);
      await new Promise<void>((resolve) => { realPulseScheduler.setTimeout(resolve, 5); });
      assert.strictEqual(cancelledFired, false, 'таймер срабатывает по порядку сроков: погашенный (0 мс) был бы раньше');
    });
  });

  suite('тайминг тиков', () => {
    test('короткий вызов молчит: до интервала тиков нет, ровно на интервале — первый', async () => {
      const r = rig();
      const pulse = startRequestPulse(r.options());
      assert.strictEqual(r.scheduler.pendingCount(), 1);
      r.scheduler.advance(INTERVAL - 1);
      await flushMicrotasks();
      assert.deepStrictEqual(r.sent, []);
      r.scheduler.advance(1);
      await flushMicrotasks();
      assert.strictEqual(r.sent.length, 1);
      pulse.stop();
    });

    test('первый и второй тик: sequence, progress = секунды, elapsedMs; без этапа поле stage отсутствует', async () => {
      const r = rig();
      const pulse = startRequestPulse(r.options());
      await r.scheduler.fireNext();
      await r.scheduler.fireNext();
      assert.deepStrictEqual(r.sent, [
        { sequence: 1, progress: 10, elapsedMs: 10_000 },
        { sequence: 2, progress: 20, elapsedMs: 20_000 },
      ]);
      pulse.stop();
    });

    test('без наложения: пока send не завершён, таймер не взводится; после завершения интервал отсчитывается от конца send', async () => {
      const r = rig();
      const gates = [deferred(), deferred()];
      let call = 0;
      const pulse = startRequestPulse(r.options({
        send: (tick) => { r.sent.push(tick); return gates[call++].promise; },
      }));
      await r.scheduler.fireNext();
      assert.strictEqual(r.sent.length, 1);
      assert.strictEqual(r.scheduler.pendingCount(), 0, 'пока send в полёте, следующий таймер не взведён');

      r.scheduler.advance(5_000);
      await flushMicrotasks();
      assert.strictEqual(r.scheduler.pendingCount(), 0);
      gates[0].resolve();
      await flushMicrotasks();
      assert.strictEqual(r.scheduler.pendingCount(), 1, 'после завершения send таймер взведён');

      await r.scheduler.fireNext();
      assert.strictEqual(r.sent[1].elapsedMs, 25_000, 'интервал считается от завершения предыдущего send (15 с + 10 с)');
      gates[1].resolve();
      pulse.stop();
    });
  });

  suite('остановка', () => {
    test('stop до первого тика: таймер погашен, отправок нет', async () => {
      const r = rig();
      const pulse = startRequestPulse(r.options());
      pulse.stop();
      assert.strictEqual(r.scheduler.pendingCount(), 0);
      r.scheduler.advance(10 * INTERVAL);
      await flushMicrotasks();
      assert.deepStrictEqual(r.sent, []);
    });

    test('stop идемпотентен', () => {
      const r = rig();
      const pulse = startRequestPulse(r.options());
      pulse.stop();
      assert.doesNotThrow(() => pulse.stop());
      assert.strictEqual(r.scheduler.pendingCount(), 0);
    });

    test('stop во время send: тик «в полёте» после завершения не перевзводит таймер', async () => {
      const r = rig();
      const gate = deferred();
      const pulse = startRequestPulse(r.options({
        send: (tick) => { r.sent.push(tick); return gate.promise; },
      }));
      await r.scheduler.fireNext();
      pulse.stop();
      gate.resolve();
      await flushMicrotasks();
      assert.strictEqual(r.scheduler.pendingCount(), 0);
      assert.strictEqual(r.sent.length, 1);
    });

    test('stop во время send, завершившегося ошибкой: onSendError допустим, таймер не перевзводится', async () => {
      const r = rig();
      const gate = deferred();
      const pulse = startRequestPulse(r.options({
        send: (tick) => { r.sent.push(tick); return gate.promise; },
      }));
      await r.scheduler.fireNext();
      pulse.stop();
      gate.reject(new Error('закрыто'));
      await flushMicrotasks();
      assert.strictEqual(r.scheduler.pendingCount(), 0);
    });
  });

  suite('гонка таймера и stop', () => {
    test('таймер сработал уже после stop (планировщик не отменил callback): ничего не отправляется и не перевзводится', async () => {
      const scheduled: (() => void)[] = [];
      let timers = 0;
      const stubborn = {
        now: () => 0,
        setTimeout: (callback: () => void) => { scheduled.push(callback); timers += 1; return timers; },
        clearTimeout: () => undefined,
      };
      const r = rig();
      const pulse = startRequestPulse(r.options({ scheduler: stubborn }));
      pulse.stop();
      scheduled[0]();
      await flushMicrotasks();
      assert.deepStrictEqual(r.sent, []);
      assert.strictEqual(timers, 1, 'после stop новые таймеры не взводятся');
    });
  });

  suite('signal', () => {
    test('signal уже прерван на старте: ничего не планируется и не отправляется', async () => {
      const r = rig();
      const controller = new AbortController();
      controller.abort();
      const pulse = startRequestPulse(r.options({ signal: controller.signal }));
      assert.strictEqual(r.scheduler.totalScheduled, 0);
      assert.strictEqual(r.scheduler.pendingCount(), 0);
      r.scheduler.advance(10 * INTERVAL);
      await flushMicrotasks();
      assert.deepStrictEqual(r.sent, []);
      assert.doesNotThrow(() => pulse.stop());
    });

    test('abort до первого тика: таймер погашен, отправок нет', async () => {
      const r = rig();
      const controller = new AbortController();
      startRequestPulse(r.options({ signal: controller.signal }));
      assert.strictEqual(r.scheduler.pendingCount(), 1);
      controller.abort();
      assert.strictEqual(r.scheduler.pendingCount(), 0);
      await flushMicrotasks();
      assert.deepStrictEqual(r.sent, []);
    });

    test('abort во время send: после завершения send таймер не взводится', async () => {
      const r = rig();
      const controller = new AbortController();
      const gate = deferred();
      startRequestPulse(r.options({
        signal: controller.signal,
        send: (tick) => { r.sent.push(tick); return gate.promise; },
      }));
      await r.scheduler.fireNext();
      controller.abort();
      gate.resolve();
      await flushMicrotasks();
      assert.strictEqual(r.scheduler.pendingCount(), 0);
      assert.strictEqual(r.sent.length, 1);
    });
  });

  suite('ошибки send', () => {
    test('send отклонён: onSendError получает (ошибку, тик), пульс продолжается', async () => {
      const r = rig();
      const failure = new Error('сокет закрыт');
      const pulse = startRequestPulse(r.options({
        send: (tick) => { r.sent.push(tick); return Promise.reject(failure); },
      }));
      await r.scheduler.fireNext();
      assert.strictEqual(r.errors.length, 1);
      assert.strictEqual(r.errors[0].error, failure);
      assert.strictEqual(r.errors[0].tick.sequence, 1);
      assert.strictEqual(r.scheduler.pendingCount(), 1, 'пульс продолжается');
      await r.scheduler.fireNext();
      assert.deepStrictEqual(r.sent.map((tick) => tick.sequence), [1, 2]);
      assert.strictEqual(r.errors.length, 2);
      pulse.stop();
    });

    test('send бросает синхронно: то же, что отклонённый promise', async () => {
      const r = rig();
      const pulse = startRequestPulse(r.options({
        send: () => { throw new Error('синхронный отказ'); },
      }));
      await r.scheduler.fireNext();
      assert.strictEqual(r.errors.length, 1);
      assert.strictEqual((r.errors[0].error as Error).message, 'синхронный отказ');
      assert.strictEqual(r.scheduler.pendingCount(), 1);
      pulse.stop();
    });

    test('без onSendError ошибка глотается, пульс продолжается', async () => {
      const r = rig();
      const pulse = startRequestPulse(r.options({
        onSendError: undefined,
        send: (tick) => { r.sent.push(tick); return Promise.reject(new Error('x')); },
      }));
      await r.scheduler.fireNext();
      assert.strictEqual(r.scheduler.pendingCount(), 1);
      await r.scheduler.fireNext();
      assert.strictEqual(r.sent.length, 2);
      pulse.stop();
    });
  });

  suite('progress', () => {
    test('растёт монотонно даже при стоячих часах: max(prev+1, floor(elapsed/1000))', async () => {
      const r = rig();
      const pulse = startRequestPulse(r.options());
      await r.scheduler.fireNext();
      await r.scheduler.fireNext({ holdClock: true });
      await r.scheduler.fireNext({ holdClock: true });
      assert.deepStrictEqual(r.sent.map((tick) => tick.progress), [10, 11, 12]);
      assert.deepStrictEqual(r.sent.map((tick) => tick.elapsedMs), [10_000, 10_000, 10_000]);
      pulse.stop();
    });

    test('progress — целые секунды от начала вызова (часы идут с ненулевой точки отсчёта)', async () => {
      const r = rig(1_700_000_000_000);
      const pulse = startRequestPulse(r.options({ intervalMs: 12_500 }));
      await r.scheduler.fireNext();
      assert.strictEqual(r.sent[0].elapsedMs, 12_500);
      assert.strictEqual(r.sent[0].progress, 12);
      pulse.stop();
    });
  });

  suite('этап операции в тике', () => {
    test('свежий этап (at >= старта) попадает в тик как {title, stage}; граница at === старта включена', async () => {
      const r = rig(1_000);
      r.stage = { title: 'Хранилище', stage: 'Получение объектов', phase: 'update', at: 1_000 };
      const pulse = startRequestPulse(r.options());
      await r.scheduler.fireNext();
      assert.deepStrictEqual(r.sent[0].stage, { title: 'Хранилище', stage: 'Получение объектов' });
      pulse.stop();
    });

    test('устаревший этап (at < старта вызова) отбрасывается: поля stage в тике нет', async () => {
      const r = rig(1_000);
      r.stage = { title: 'Чужая операция', stage: 'старое', phase: 'update', at: 999 };
      const pulse = startRequestPulse(r.options());
      await r.scheduler.fireNext();
      assert.ok(!('stage' in r.sent[0]) || r.sent[0].stage === undefined);
      pulse.stop();
    });

    test('этап читается на каждом тике, а не кэшируется', async () => {
      const r = rig(0);
      const pulse = startRequestPulse(r.options());
      r.stage = { title: 'Т', stage: 'первый', phase: 'update', at: 5 };
      await r.scheduler.fireNext();
      r.stage = { title: 'Т', stage: 'второй', phase: 'update', at: 15_000 };
      await r.scheduler.fireNext();
      r.stage = undefined;
      await r.scheduler.fireNext();
      assert.deepStrictEqual(r.sent.map((tick) => tick.stage?.stage), ['первый', 'второй', undefined]);
      pulse.stop();
    });
  });

  suite('runWithRequestPulse', () => {
    test('возвращает значение fn; пульс тикает, пока fn выполняется; после — ни одного таймера', async () => {
      const r = rig();
      const work = deferred<string>();
      const running = runWithRequestPulse(r.options(), () => work.promise);
      await r.scheduler.fireNext();
      assert.strictEqual(r.sent.length, 1);
      work.resolve('итог');
      assert.strictEqual(await running, 'итог');
      assert.strictEqual(r.scheduler.pendingCount(), 0);
    });

    test('fn бросает: исключение пробрасывается как есть, таймеров нет', async () => {
      const r = rig();
      const failure = new Error('отказ операции');
      await assert.rejects(
        () => runWithRequestPulse(r.options(), () => Promise.reject(failure)),
        (error: Error) => error === failure
      );
      assert.strictEqual(r.scheduler.pendingCount(), 0);
    });

    test('fn завершилась раньше первого тика: ничего не отправлено, таймер погашен', async () => {
      const r = rig();
      assert.strictEqual(await runWithRequestPulse(r.options(), () => Promise.resolve(7)), 7);
      assert.strictEqual(r.scheduler.pendingCount(), 0);
      assert.deepStrictEqual(r.sent, []);
    });

    test('signal прерван заранее: fn всё равно выполняется и отдаёт результат, пульса нет', async () => {
      const r = rig();
      const controller = new AbortController();
      controller.abort();
      const value = await runWithRequestPulse(
        r.options({ signal: controller.signal }), () => Promise.resolve('готово'));
      assert.strictEqual(value, 'готово');
      assert.strictEqual(r.scheduler.totalScheduled, 0);
    });
  });

  suite('buildPulseNotification и formatPulseText', () => {
    const tick: PulseTick = { sequence: 3, progress: 320, elapsedMs: 320_000, stage: { title: 'Хранилище', stage: 'Получение' } };
    const text = 'v8vscedit_repository_update: выполняется 5 мин 20 с — Хранилище: Получение';

    test('formatPulseText: с этапом и без него', () => {
      assert.strictEqual(formatPulseText('v8vscedit_repository_update', tick), text);
      assert.strictEqual(
        formatPulseText('v8vscedit_dump_cf', { sequence: 1, progress: 45, elapsedMs: 45_000 }),
        'v8vscedit_dump_cf: выполняется 45 с'
      );
    });

    const TOKENS: readonly { title: string; token: string | number }[] = [
      { title: 'строковый токен', token: 'abc' },
      { title: 'числовой токен', token: 7 },
      { title: 'токен 0 допустим (проверка !== undefined, а не truthy)', token: 0 },
      { title: 'пустая строка допустима', token: '' },
    ];
    for (const { title, token } of TOKENS) {
      test(`${title}: notifications/progress с message-текстом пульса`, () => {
        assert.deepStrictEqual(buildPulseNotification('v8vscedit_repository_update', tick, token), {
          method: 'notifications/progress',
          params: { progressToken: token, progress: 320, message: text },
        });
      });
    }

    test('токена нет: notifications/message уровня info, logger v8vscedit, data — текст пульса', () => {
      assert.deepStrictEqual(buildPulseNotification('v8vscedit_repository_update', tick, undefined), {
        method: 'notifications/message',
        params: { level: 'info', logger: 'v8vscedit', data: text },
      });
    });
  });

  suite('formatElapsed', () => {
    const CASES: readonly { seconds: number; text: string }[] = [
      { seconds: 0, text: '0 с' },
      { seconds: 45, text: '45 с' },
      { seconds: 59, text: '59 с' },
      { seconds: 60, text: '1 мин 0 с' },
      { seconds: 320, text: '5 мин 20 с' },
      { seconds: 3599, text: '59 мин 59 с' },
      { seconds: 3600, text: '1 ч 00 мин' },
      { seconds: 3661, text: '1 ч 01 мин' },
      { seconds: 3720, text: '1 ч 02 мин' },
    ];
    for (const { seconds, text } of CASES) {
      test(`${String(seconds)} с → «${text}»`, () => {
        assert.strictEqual(formatElapsed(seconds * 1000), text);
      });
    }

    test('миллисекунды отбрасываются вниз: 59 999 мс → «59 с»', () => {
      assert.strictEqual(formatElapsed(59_999), '59 с');
    });
  });
});
