import * as assert from 'assert';
import type { AgentOperationHooks } from '../../infra/agent/AgentOperationService';
import {
  createSyncProgress,
  DEFAULT_SYNC_PROGRESS_POLICY,
  type AgentProgressEvent,
} from '../../infra/agent/sync/SyncProgress';

/**
 * SyncProgress: единственный источник сообщений о ходе операции. Один текст уходит в журнал (`onMessage`) и в
 * UI (`onProgress`), частота каналов разная. Часы внедряются: тест не ждёт реального времени.
 */

interface Rig {
  readonly journal: string[];
  readonly ui: AgentProgressEvent[];
  readonly hooks: AgentOperationHooks;
  at(ms: number): void;
}

/** Стенд с часами: `now` читает то, что тест выставил через `at`. */
function rigWithClock(): { rig: Rig; now: () => number } {
  const journal: string[] = [];
  const ui: AgentProgressEvent[] = [];
  let ms = 0;
  const rig: Rig = {
    journal,
    ui,
    hooks: {
      onMessage: (message) => { journal.push(message); },
      onProgress: (event) => { ui.push(event); },
    },
    at: (value) => { ms = value; },
  };
  return { rig, now: () => ms };
}

const fmt = (done: number, total: number): string => `${String(done)}/${String(total)}`;

suite('SyncProgress', () => {
  test('политика по умолчанию: журнал — шаг 10 % и 15 с, UI — 500 мс', () => {
    assert.deepStrictEqual({ ...DEFAULT_SYNC_PROGRESS_POLICY }, {
      journalStepPercent: 10,
      journalIntervalMs: 15_000,
      uiIntervalMs: 500,
    });
  });

  suite('step', () => {
    test('этап уходит в оба канала одной и той же строкой; в UI — без счётчиков; троттлинга у этапов нет', () => {
      const { rig, now } = rigWithClock();
      const progress = createSyncProgress(rig.hooks, now);
      progress.step('Запрос списка изменений базы у агента…');
      progress.step('Обновление зеркала агента на сервере…');
      assert.deepStrictEqual(rig.journal, ['Запрос списка изменений базы у агента…', 'Обновление зеркала агента на сервере…']);
      assert.deepStrictEqual(rig.ui.map((event) => event.text), rig.journal);
      for (const event of rig.ui) {
        assert.strictEqual(event.done, undefined);
        assert.strictEqual(event.total, undefined);
      }
    });
  });

  suite('counter', () => {
    test('старт, шаги и финиш: каждое значение один раз, последнее — полное; текст строит format и он один для обоих каналов', () => {
      const { rig, now } = rigWithClock();
      const progress = createSyncProgress(rig.hooks, now);
      const counter = progress.counter(fmt, 3);
      counter.advance();
      counter.advance();
      counter.advance();
      counter.finish();
      assert.deepStrictEqual(rig.journal, ['0/3', '1/3', '2/3', '3/3']);
      assert.deepStrictEqual(rig.ui.map((event) => event.text), rig.journal);
      assert.deepStrictEqual(rig.ui.map((event) => [event.done, event.total]), [[0, 3], [1, 3], [2, 3], [3, 3]]);
    });

    test('шаги журнала по 10 % при total 25: сообщение только при пересечении очередного десятка процентов', () => {
      const { rig, now } = rigWithClock();
      const counter = createSyncProgress(rig.hooks, now).counter(fmt, 25);
      for (let index = 0; index < 25; index += 1) {
        counter.advance();
      }
      counter.finish();
      // 3/25 = 12 % (первый десяток), 5 = 20 %, 8 = 32 %, 10 = 40 %, 13 = 52 %, 15 = 60 %, 18 = 72 %, 20 = 80 %, 23 = 92 %, 25 = 100 %.
      assert.deepStrictEqual(rig.journal, ['0/25', '3/25', '5/25', '8/25', '10/25', '13/25', '15/25', '18/25', '20/25', '23/25', '25/25']);
    });

    test('медленный счётчик: журнал не реже раза в 15 с (граница включительно), между ними тишина', () => {
      const { rig, now } = rigWithClock();
      const counter = createSyncProgress(rig.hooks, now).counter(fmt, 1000);
      rig.at(14_999);
      counter.advance();
      assert.deepStrictEqual(rig.journal, ['0/1000'], 'за 14,999 с журнал молчит');
      rig.at(15_000);
      counter.advance();
      assert.deepStrictEqual(rig.journal, ['0/1000', '2/1000']);
      rig.at(29_999);
      counter.advance();
      assert.strictEqual(rig.journal.length, 2);
      rig.at(30_000);
      counter.advance();
      assert.deepStrictEqual(rig.journal, ['0/1000', '2/1000', '4/1000']);
    });

    test('UI чаще журнала: раз в 500 мс (граница включительно), журнал за это время молчит', () => {
      const { rig, now } = rigWithClock();
      const counter = createSyncProgress(rig.hooks, now).counter(fmt, 1000);
      rig.at(499);
      counter.advance();
      assert.deepStrictEqual(rig.ui.map((event) => event.text), ['0/1000']);
      rig.at(500);
      counter.advance();
      assert.deepStrictEqual(rig.ui.map((event) => event.text), ['0/1000', '2/1000']);
      rig.at(999);
      counter.advance();
      rig.at(1000);
      counter.advance();
      assert.deepStrictEqual(rig.ui.map((event) => event.text), ['0/1000', '2/1000', '4/1000']);
      assert.deepStrictEqual(rig.journal, ['0/1000'], 'журнал: только старт');
    });

    test('шаг по процентам попадает в UI вне интервала (часы стоят)', () => {
      const { rig, now } = rigWithClock();
      const counter = createSyncProgress(rig.hooks, now).counter(fmt, 10);
      for (let index = 0; index < 10; index += 1) {
        counter.advance();
      }
      assert.deepStrictEqual(rig.ui.map((event) => event.text), ['0/10', '1/10', '2/10', '3/10', '4/10', '5/10', '6/10', '7/10', '8/10', '9/10', '10/10']);
    });

    test('total 0: ни старта, ни продвижения, ни финиша; format не вызывается', () => {
      const { rig, now } = rigWithClock();
      let formatCalls = 0;
      const counter = createSyncProgress(rig.hooks, now).counter(() => { formatCalls += 1; return 'x'; }, 0);
      counter.advance();
      counter.advance(5, 100);
      counter.finish();
      assert.deepStrictEqual(rig.journal, []);
      assert.deepStrictEqual(rig.ui, []);
      assert.strictEqual(formatCalls, 0);
    });

    test('finish идемпотентен: повторный вызов ничего не пишет', () => {
      const { rig, now } = rigWithClock();
      const counter = createSyncProgress(rig.hooks, now).counter(fmt, 2);
      counter.advance(2);
      counter.finish();
      const journal = [...rig.journal];
      const ui = [...rig.ui];
      counter.finish();
      counter.finish();
      assert.deepStrictEqual(rig.journal, journal);
      assert.deepStrictEqual(rig.ui, ui);
      assert.strictEqual(rig.journal.at(-1), '2/2');
    });

    test('finish недобравшего счётчика пишет итоговое значение (операция закончилась раньше total)', () => {
      const { rig, now } = rigWithClock();
      const counter = createSyncProgress(rig.hooks, now).counter(fmt, 10);
      counter.advance();
      counter.finish();
      assert.strictEqual(rig.journal.at(-1), '1/10');
      assert.strictEqual(rig.ui.at(-1)?.text, '1/10');
    });

    test('finish после молчавшего advance дописывает итог в оба канала', () => {
      const { rig, now } = rigWithClock();
      const counter = createSyncProgress(rig.hooks, now).counter(fmt, 1000);
      counter.advance();
      assert.deepStrictEqual(rig.journal, ['0/1000'], 'шаг и интервалы не пересечены');
      counter.finish();
      assert.deepStrictEqual(rig.journal, ['0/1000', '1/1000']);
      assert.deepStrictEqual(rig.ui.map((event) => event.text), ['0/1000', '1/1000']);
    });

    test('finish, когда UI уже показал итог, а журнал нет: строка уходит только в журнал', () => {
      const { rig, now } = rigWithClock();
      const counter = createSyncProgress(rig.hooks, now).counter(fmt, 1000);
      rig.at(500);
      counter.advance();
      assert.deepStrictEqual(rig.ui.map((event) => event.text), ['0/1000', '1/1000']);
      counter.finish();
      assert.deepStrictEqual(rig.journal, ['0/1000', '1/1000']);
      assert.deepStrictEqual(rig.ui.map((event) => event.text), ['0/1000', '1/1000'], 'UI без дубля');
    });

    test('advance(count) двигает на count; байты накапливаются и передаются в format третьим аргументом', () => {
      const { rig, now } = rigWithClock();
      const seen: [number, number, number][] = [];
      const counter = createSyncProgress(rig.hooks, now).counter((done, total, bytes) => {
        seen.push([done, total, bytes]);
        return `${String(done)}/${String(total)}:${String(bytes)}`;
      }, 4);
      counter.advance(1, 1_048_576);
      counter.advance(2, 524_288);
      counter.finish();
      assert.deepStrictEqual(seen[0], [0, 4, 0], 'старт');
      assert.deepStrictEqual(seen.find(([done]) => done === 1), [1, 4, 1_048_576]);
      assert.deepStrictEqual(seen.find(([done]) => done === 3), [3, 4, 1_572_864]);
    });

    test('свои пороги политики: шаг 50 %, журнал 1 с, UI 100 мс', () => {
      const { rig, now } = rigWithClock();
      const counter = createSyncProgress(rig.hooks, now, { journalStepPercent: 50, journalIntervalMs: 1000, uiIntervalMs: 100 })
        .counter(fmt, 4);
      counter.advance();
      assert.deepStrictEqual(rig.journal, ['0/4'], '25 % — меньше шага');
      counter.advance();
      assert.deepStrictEqual(rig.journal, ['0/4', '2/4'], '50 % — шаг');
      rig.at(1000);
      counter.advance();
      assert.deepStrictEqual(rig.journal, ['0/4', '2/4', '3/4'], 'интервал 1 с');
      rig.at(1100);
      counter.advance();
      assert.strictEqual(rig.ui.at(-1)?.text, '4/4');
    });
  });

  suite('хуки без каналов', () => {
    for (const [label, hooks] of [
      ['хуков нет вовсе', undefined],
      ['пустые хуки', {}],
      ['только отмена', { cancellation: { isCancellationRequested: false } }],
    ] as const) {
      test(`${label}: step и счётчик не бросают`, () => {
        const progress = createSyncProgress(hooks, () => 0);
        progress.step('этап');
        const counter = progress.counter(fmt, 3);
        counter.advance(3);
        counter.finish();
      });
    }

    test('только onMessage: журнал получает сообщения, UI-канала нет', () => {
      const journal: string[] = [];
      const progress = createSyncProgress({ onMessage: (message) => { journal.push(message); } }, () => 0);
      progress.step('этап');
      const counter = progress.counter(fmt, 1);
      counter.advance();
      counter.finish();
      assert.deepStrictEqual(journal, ['этап', '0/1', '1/1']);
    });

    test('только onProgress: UI получает события, журнала нет', () => {
      const ui: AgentProgressEvent[] = [];
      const progress = createSyncProgress({ onProgress: (event) => { ui.push(event); } }, () => 0);
      progress.step('этап');
      const counter = progress.counter(fmt, 1);
      counter.advance();
      counter.finish();
      assert.deepStrictEqual(ui.map((event) => event.text), ['этап', '0/1', '1/1']);
    });
  });
});

suite('SyncProgress.transfer (plan-large-files.md §3.1)', () => {
  /** Те же правила троттлинга, что у `counter`: одинаковая последовательность часов даёт одинаковые журнал и UI. */
  test('transfer по файлам и counter при одинаковых часах пишут в журнал и UI в одни и те же моменты', () => {
    const clock = [0, 100, 600, 700, 15_700, 15_800];
    const run = (kind: 'counter' | 'transfer'): { journal: string[]; ui: string[] } => {
      const { rig, now } = rigWithClock();
      const progress = createSyncProgress(rig.hooks, now);
      const advance = kind === 'counter'
        ? ((): (() => void) => { const c = progress.counter((done, total) => `${String(done)}/${String(total)}`, 100); return () => { c.advance(); }; })()
        : ((): (() => void) => { const t = progress.transfer((s) => `${String(s.doneFiles)}/${String(s.totalFiles)}`, { files: 100, bytes: 0 }); return () => { t.fileDone(); }; })();
      for (const at of clock) {
        rig.at(at);
        advance();
      }
      return { journal: rig.journal, ui: rig.ui.map((event) => event.text) };
    };
    const counter = run('counter');
    const transfer = run('transfer');
    assert.deepStrictEqual(transfer.journal, counter.journal);
    assert.deepStrictEqual(transfer.ui, counter.ui);
    assert.ok(transfer.ui.length > transfer.journal.length, 'UI чаще журнала: троттлинг каналов разный');
  });

  test('transfer пишет в оба канала одним текстом; step и transfer соседствуют в одной операции', () => {
    const { rig, now } = rigWithClock();
    const progress = createSyncProgress(rig.hooks, now);
    progress.step('Этап');
    const counter = progress.transfer((state) => `байт ${String(state.doneBytes)} из ${String(state.totalBytes)}`, { files: 1, bytes: 10 });
    counter.addBytes(10);
    counter.fileDone();
    counter.finish();
    assert.deepStrictEqual(rig.journal, ['Этап', 'байт 0 из 10', 'байт 10 из 10']);
    assert.deepStrictEqual(rig.ui.map((event) => event.text), rig.journal);
  });

  test('transfer с total 0/0 молчит, как counter с total 0', () => {
    const { rig, now } = rigWithClock();
    const progress = createSyncProgress(rig.hooks, now);
    const counter = progress.transfer(() => 'x', { files: 0, bytes: 0 });
    counter.fileDone();
    counter.finish();
    assert.deepStrictEqual(rig.journal, []);
    assert.deepStrictEqual(rig.ui, []);
  });
});
