import * as assert from 'assert';
import * as path from 'path';
import { importEsmModule } from './support/importEsm';

interface Decision { action: 'wait' | 'done' | 'fail'; exitCode?: number; reason?: string }
interface Facts {
  taskState: string | undefined;
  result: { id?: unknown; exitCode?: unknown } | undefined;
  expectedId: string;
  elapsedMs: number;
  startGraceMs: number;
  notRunningPolls: number;
}
interface HiddenRunStateModule {
  decideHiddenRunState(facts: Facts): Decision;
  HIDDEN_ALLOWED_SCRIPTS: readonly string[];
  NOT_RUNNING_POLLS_TO_FAIL: number;
}

const MODULE_PATH = path.resolve(__dirname, '../../../scripts/hidden-tests/hiddenRunState.mjs');

// Решение наблюдателя скрытого прогона — единственная логика test-hidden.mjs, от которой зависит,
// не повиснет ли агент навсегда, не примет ли чужой результат и не объявит ли живой прогон упавшим.
suite('hiddenRunState — решение наблюдателя скрытого прогона', () => {
  let mod: HiddenRunStateModule;
  suiteSetup(async () => {
    mod = await importEsmModule<HiddenRunStateModule>(MODULE_PATH);
  });

  const base: Facts = { taskState: undefined, result: undefined, expectedId: 'req-1', elapsedMs: 0, startGraceMs: 15_000, notRunningPolls: 2 };
  const cases: { name: string; facts: Partial<Facts>; expected: Decision; reason?: RegExp }[] = [
    { name: 'свой результат с кодом 0 → done 0', facts: { result: { id: 'req-1', exitCode: 0 }, taskState: 'Ready', elapsedMs: 1 }, expected: { action: 'done', exitCode: 0 } },
    { name: 'свой результат с ненулевым кодом → done с этим кодом', facts: { result: { id: 'req-1', exitCode: 3 }, elapsedMs: 99_999 }, expected: { action: 'done', exitCode: 3 } },
    { name: 'свой результат с отрицательным кодом → done как есть', facts: { result: { id: 'req-1', exitCode: -1 } }, expected: { action: 'done', exitCode: -1 } },
    { name: 'свой результат с большим кодом → done как есть', facts: { result: { id: 'req-1', exitCode: 3221225477 } }, expected: { action: 'done', exitCode: 3221225477 } },
    { name: 'код выхода строкой → fail 4', facts: { result: { id: 'req-1', exitCode: '0' } }, expected: { action: 'fail', exitCode: 4 }, reason: /код выхода/ },
    { name: 'свой результат без кода → fail 4', facts: { result: { id: 'req-1' } }, expected: { action: 'fail', exitCode: 4 }, reason: /код выхода/ },
    { name: 'чужой результат (гонка) → fail 4', facts: { result: { id: 'other', exitCode: 0 } }, expected: { action: 'fail', exitCode: 4 }, reason: /другому запросу/ },
    { name: 'чужой результат при Running — результат важнее состояния', facts: { result: { id: 'other', exitCode: 0 }, taskState: 'Running' }, expected: { action: 'fail', exitCode: 4 }, reason: /другому запросу/ },
    { name: 'результат без id (устаревший исполнитель) → fail 4 с подсказкой', facts: { result: { exitCode: 0 } }, expected: { action: 'fail', exitCode: 4 }, reason: /без id.*register\.ps1/ },
    { name: 'результат с пустым id → fail 4 с подсказкой', facts: { result: { id: '', exitCode: 0 } }, expected: { action: 'fail', exitCode: 4 }, reason: /без id/ },
    { name: 'нет результата, задача Running → wait (даже долго после окна)', facts: { taskState: 'Running', elapsedMs: 3_600_000 }, expected: { action: 'wait' } },
    { name: 'нет результата, задача Queued после окна → wait (отложенный старт)', facts: { taskState: 'Queued', elapsedMs: 60_000 }, expected: { action: 'wait' } },
    { name: 'нет результата, Ready внутри окна старта → wait', facts: { taskState: 'Ready', elapsedMs: 14_999 }, expected: { action: 'wait' } },
    { name: 'нет результата, Ready на границе окна, два опроса → fail 4', facts: { taskState: 'Ready', elapsedMs: 15_000 }, expected: { action: 'fail', exitCode: 4 }, reason: /Ready/ },
    { name: 'один неудачный опрос после окна → ещё wait', facts: { taskState: undefined, elapsedMs: 60_000, notRunningPolls: 1 }, expected: { action: 'wait' } },
    { name: 'состояние неизвестно, два опроса после окна → fail 4', facts: { taskState: undefined, elapsedMs: 60_000 }, expected: { action: 'fail', exitCode: 4 }, reason: /неизвестно/ },
    { name: 'Disabled, два опроса после окна → fail 4 с состоянием', facts: { taskState: 'Disabled', elapsedMs: 60_000 }, expected: { action: 'fail', exitCode: 4 }, reason: /Disabled/ },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const decision = mod.decideHiddenRunState({ ...base, ...c.facts });
      assert.strictEqual(decision.action, c.expected.action);
      if (c.expected.exitCode !== undefined) {
        assert.strictEqual(decision.exitCode, c.expected.exitCode);
      }
      if (c.reason) {
        assert.match(decision.reason ?? '', c.reason);
      }
    });
  }

  test('порог подтверждения отказа — два опроса', () => {
    assert.strictEqual(mod.NOT_RUNNING_POLLS_TO_FAIL, 2);
  });

  test('белый список скриптов совпадает с runner.ps1', () => {
    assert.deepStrictEqual([...mod.HIDDEN_ALLOWED_SCRIPTS], ['test', 'test:fast', 'coverage:changed']);
  });
});
