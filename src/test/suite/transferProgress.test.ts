import * as assert from 'assert';
import type { AgentOperationHooks } from '../../infra/agent/AgentOperationService';
import {
  createSyncProgress,
  DEFAULT_SYNC_PROGRESS_POLICY,
  type AgentProgressEvent,
  type SyncProgressPolicy,
} from '../../infra/agent/sync/SyncProgress';
import { MIN_RATE_SPAN_MS, RATE_WINDOW_MS, type TransferCounter, type TransferState } from '../../infra/agent/sync/TransferProgress';

/**
 * Счётчик передачи по весу (plan-large-files.md §3.1): журнал — вехи по байтам (при нулевом весе — по файлам) и
 * «не реже интервала», UI — не чаще интервала плюс всё журнальное; скорость — скользящее окно, ETA — остаток / скорость.
 * Часы внедряются: тест подаёт время вручную, реального времени нет.
 */

interface Rig {
  readonly journal: string[];
  readonly ui: AgentProgressEvent[];
  readonly states: TransferState[];
  readonly hooks: AgentOperationHooks;
  at(ms: number): void;
  counter(totals: { files: number; bytes: number }, policy?: SyncProgressPolicy): TransferCounter;
}

function rig(): Rig {
  const journal: string[] = [];
  const ui: AgentProgressEvent[] = [];
  const states: TransferState[] = [];
  let ms = 0;
  const hooks: AgentOperationHooks = {
    onMessage: (message) => { journal.push(message); },
    onProgress: (event) => { ui.push(event); },
  };
  return {
    journal,
    ui,
    states,
    hooks,
    at: (value) => { ms = value; },
    counter: (totals, policy) => createSyncProgress(hooks, () => ms, policy).transfer((state) => {
      states.push(state);
      return `f${String(state.doneFiles)}/${String(state.totalFiles)} b${String(state.doneBytes)}/${String(state.totalBytes)}`;
    }, totals),
  };
}

/** Каждый вызов — в UI: состояние на каждом шаге попадает в `states`. */
const UI_ALWAYS: SyncProgressPolicy = { ...DEFAULT_SYNC_PROGRESS_POLICY, uiIntervalMs: 0 };

const closeTo = (actual: number | undefined, expected: number): void => {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-6, `ожидалось ${String(expected)}, получено ${String(actual)}`);
};

suite('TransferProgress', () => {
  test('константы окна скорости: окно 10 с, минимальный разброс выборок 1 с', () => {
    assert.strictEqual(RATE_WINDOW_MS, 10_000);
    assert.strictEqual(MIN_RATE_SPAN_MS, 1_000);
  });

  test('старт: нулевое состояние уходит в журнал и в UI одним текстом; скорости и ETA ещё нет', () => {
    const r = rig();
    r.counter({ files: 3, bytes: 1000 });
    assert.deepStrictEqual(r.journal, ['f0/3 b0/1000']);
    assert.deepStrictEqual(r.ui.map((event) => event.text), r.journal);
    assert.strictEqual(r.states[0].bytesPerSec, undefined);
    assert.strictEqual(r.states[0].etaSec, undefined);
  });

  test('total 0/0: молчит целиком — ни старта, ни вехи, ни итога; форматтер не зовётся', () => {
    const r = rig();
    const counter = r.counter({ files: 0, bytes: 0 });
    counter.addBytes(10);
    counter.fileDone(5);
    counter.finish();
    assert.deepStrictEqual(r.journal, []);
    assert.deepStrictEqual(r.ui, []);
    assert.deepStrictEqual(r.states, []);
  });

  suite('журнал: вехи по байтам', () => {
    test('шаг 10 % от байтов: ниже шага — тишина, пересечение — одна строка, прыжок через несколько шагов — тоже одна', () => {
      const r = rig();
      const counter = r.counter({ files: 3, bytes: 1000 });
      counter.addBytes(99);
      assert.strictEqual(r.journal.length, 1);
      counter.addBytes(1);
      assert.deepStrictEqual(r.journal.at(-1), 'f0/3 b100/1000');
      assert.strictEqual(r.journal.length, 2);
      counter.addBytes(100);
      assert.strictEqual(r.journal.at(-1), 'f0/3 b200/1000');
      counter.addBytes(500);
      assert.strictEqual(r.journal.at(-1), 'f0/3 b700/1000');
      assert.strictEqual(r.journal.length, 4);
    });

    test('завершение файла без движения байтов веху журнала не форсирует', () => {
      const r = rig();
      const counter = r.counter({ files: 3, bytes: 1000 });
      counter.addBytes(100);
      const before = r.journal.length;
      counter.fileDone();
      counter.fileDone();
      assert.strictEqual(r.journal.length, before);
    });

    test('интервал 15 с без пересечения шага: за миг до границы — тишина, на границе — строка', () => {
      const r = rig();
      const counter = r.counter({ files: 1, bytes: 1_000_000 });
      r.at(DEFAULT_SYNC_PROGRESS_POLICY.journalIntervalMs - 1);
      counter.addBytes(1);
      assert.strictEqual(r.journal.length, 1, 'до интервала журнал молчит');
      r.at(DEFAULT_SYNC_PROGRESS_POLICY.journalIntervalMs);
      counter.addBytes(1);
      assert.strictEqual(r.journal.length, 2);
      assert.strictEqual(r.journal.at(-1), 'f0/1 b2/1000000');
    });

    test('нулевой вес (totalBytes = 0): шаги считаются по ФАЙЛАМ — 20 файлов, веха на каждом втором', () => {
      const r = rig();
      const counter = r.counter({ files: 20, bytes: 0 });
      counter.fileDone();
      assert.strictEqual(r.journal.length, 1, 'после первого файла из 20 шага ещё нет');
      counter.fileDone();
      assert.strictEqual(r.journal.length, 2);
      for (let i = 0; i < 18; i += 1) {
        counter.fileDone();
      }
      assert.strictEqual(r.journal.length, 11, 'старт + 10 вех (2, 4, … 20)');
      counter.finish();
      assert.strictEqual(r.journal.length, 11, 'итог уже в журнале');
      assert.strictEqual(r.journal.at(-1), 'f20/20 b0/0');
    });
  });

  suite('UI: не чаще интервала, плюс всё журнальное', () => {
    test('до 500 мс без шага — UI молчит; на 500 мс — одна строка, журнал не растёт', () => {
      const r = rig();
      const counter = r.counter({ files: 1, bytes: 1_000_000 });
      r.at(DEFAULT_SYNC_PROGRESS_POLICY.uiIntervalMs - 1);
      counter.addBytes(1);
      assert.strictEqual(r.ui.length, 1);
      r.at(DEFAULT_SYNC_PROGRESS_POLICY.uiIntervalMs);
      counter.addBytes(1);
      assert.strictEqual(r.ui.length, 2);
      assert.strictEqual(r.journal.length, 1);
    });

    test('веха журнала уходит и в UI тем же текстом', () => {
      const r = rig();
      const counter = r.counter({ files: 1, bytes: 1000 });
      counter.addBytes(100);
      assert.deepStrictEqual(r.ui.map((event) => event.text), r.journal);
    });

    test('done/total события UI — байты; при нулевом весе — файлы', () => {
      const bytes = rig();
      bytes.counter({ files: 2, bytes: 1000 }).addBytes(250);
      assert.deepStrictEqual({ done: bytes.ui.at(-1)?.done, total: bytes.ui.at(-1)?.total }, { done: 250, total: 1000 });
      const files = rig();
      const counter = files.counter({ files: 4, bytes: 0 });
      counter.fileDone();
      counter.fileDone();
      assert.deepStrictEqual({ done: files.ui.at(-1)?.done, total: files.ui.at(-1)?.total }, { done: 2, total: 4 });
    });
  });

  suite('учёт файлов и байтов', () => {
    test('addBytes двигает doneBytes внутри файла; fileDone двигает doneFiles', () => {
      const r = rig();
      const counter = r.counter({ files: 2, bytes: 1000 }, UI_ALWAYS);
      counter.addBytes(300);
      counter.addBytes(200);
      counter.fileDone();
      const last = r.states.at(-1);
      assert.deepStrictEqual({ f: last?.doneFiles, b: last?.doneBytes, tf: last?.totalFiles, tb: last?.totalBytes }, { f: 1, b: 500, tf: 2, tb: 1000 });
    });

    test('fileDone(bytes) для файла с неизвестным заранее размером добавляется и в done, и в total', () => {
      const r = rig();
      const counter = r.counter({ files: 2, bytes: 100 }, UI_ALWAYS);
      counter.addBytes(50);
      counter.fileDone();
      counter.fileDone(30);
      const last = r.states.at(-1);
      assert.deepStrictEqual({ f: last?.doneFiles, b: last?.doneBytes, tf: last?.totalFiles, tb: last?.totalBytes }, { f: 2, b: 80, tf: 2, tb: 130 });
    });

    test('fileDone() без аргумента вес не меняет', () => {
      const r = rig();
      const counter = r.counter({ files: 1, bytes: 100 }, UI_ALWAYS);
      counter.fileDone();
      assert.strictEqual(r.states.at(-1)?.doneBytes, 0);
      assert.strictEqual(r.states.at(-1)?.totalBytes, 100);
    });
  });

  suite('скорость и оставшееся время', () => {
    test('до 1 с от первой выборки скорости нет; на 1 с — скорость окна и ETA по остатку', () => {
      const r = rig();
      const counter = r.counter({ files: 1, bytes: 20_000 }, UI_ALWAYS);
      r.at(MIN_RATE_SPAN_MS / 2);
      counter.addBytes(1000);
      assert.strictEqual(r.states.at(-1)?.bytesPerSec, undefined);
      assert.strictEqual(r.states.at(-1)?.etaSec, undefined);
      r.at(MIN_RATE_SPAN_MS);
      counter.addBytes(1000);
      closeTo(r.states.at(-1)?.bytesPerSec, 2000);
      closeTo(r.states.at(-1)?.etaSec, 9);
    });

    test('окно 10 с: выборки старше окна отбрасываются — скорость считается по последним 10 с, а не по всей истории', () => {
      const r = rig();
      const counter = r.counter({ files: 1, bytes: 100_000 }, UI_ALWAYS);
      r.at(1000);
      counter.addBytes(1000);
      r.at(5000);
      counter.addBytes(1000);
      closeTo(r.states.at(-1)?.bytesPerSec, 400);
      r.at(14_000);
      counter.addBytes(9000);
      // Окно [4000, 14000]: выборки (0,0) и (1000,1000) вне окна; остались (5000,2000) и (14000,11000).
      closeTo(r.states.at(-1)?.bytesPerSec, 1000);
      closeTo(r.states.at(-1)?.etaSec, 89);
    });

    test('байты не двигались: ETA нет (деление на нулевую скорость не даёт Infinity)', () => {
      const r = rig();
      const counter = r.counter({ files: 1, bytes: 1000 }, UI_ALWAYS);
      r.at(2000);
      counter.fileDone();
      assert.strictEqual(r.states.at(-1)?.etaSec, undefined);
      assert.ok(r.states.every((state) => state.etaSec === undefined || Number.isFinite(state.etaSec)));
    });

    test('передача завершена: остаток нулевой — ETA 0', () => {
      const r = rig();
      const counter = r.counter({ files: 1, bytes: 2000 }, UI_ALWAYS);
      r.at(1000);
      counter.addBytes(1000);
      r.at(2000);
      counter.addBytes(1000);
      closeTo(r.states.at(-1)?.etaSec, 0);
    });
  });

  suite('finish', () => {
    test('досылает итог в оба канала, если ни один не показал последнее значение; повторный вызов молчит', () => {
      const r = rig();
      const counter = r.counter({ files: 1, bytes: 1000 });
      counter.addBytes(50);
      assert.strictEqual(r.journal.length, 1);
      counter.finish();
      assert.deepStrictEqual(r.journal, ['f0/1 b0/1000', 'f0/1 b50/1000']);
      assert.deepStrictEqual(r.ui.map((event) => event.text), r.journal);
      counter.finish();
      assert.strictEqual(r.journal.length, 2);
      assert.strictEqual(r.ui.length, 2);
    });

    test('досылает только недостающему каналу: UI уже показал последнее, журнал — нет', () => {
      const r = rig();
      const counter = r.counter({ files: 1, bytes: 1000 });
      counter.addBytes(100);
      r.at(DEFAULT_SYNC_PROGRESS_POLICY.uiIntervalMs);
      counter.addBytes(1);
      assert.strictEqual(r.journal.length, 2, 'веха 10 % в журнале');
      assert.strictEqual(r.ui.length, 3, 'в UI ещё и промежуточное значение');
      counter.finish();
      assert.strictEqual(r.journal.length, 3);
      assert.strictEqual(r.journal.at(-1), 'f0/1 b101/1000');
      assert.strictEqual(r.ui.length, 3, 'UI уже показал последнее значение');
    });

    test('ничего не изменилось с последней строки — итога нет', () => {
      const r = rig();
      const counter = r.counter({ files: 1, bytes: 1000 });
      counter.finish();
      assert.strictEqual(r.journal.length, 1);
      assert.strictEqual(r.ui.length, 1);
    });
  });

  test('без хуков передача не падает: каналы необязательны', () => {
    const counter = createSyncProgress(undefined, () => 0).transfer(() => 'x', { files: 1, bytes: 10 });
    counter.addBytes(10);
    counter.fileDone();
    counter.finish();
  });
});
