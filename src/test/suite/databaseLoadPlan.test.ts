import * as assert from 'assert';
import type { ChangedConfiguration } from '../../infra/fs/ConfigurationChangeDetector';
import type { DatabaseLagEntry } from '../../infra/database/DatabaseConfigLag';
import {
  buildBatchLoadSteps,
  decideLagAfterLoad,
  describeLoadWithoutUpdateSuccess,
  planThinClientLaunch,
  planUpdateTargets,
} from '../../ui/commands/ext/databaseLoadPlan';

/**
 * Чистые решения загрузки без обновления БД (`ui/commands/ext/databaseLoadPlan.ts`, без `vscode`).
 *
 * Вектор CLI — под ТОЧНЫМ регресс-тестом (поэлементно): CLI молча принимает неизвестные ключи, поэтому
 * ошибку в наборе аргументов не поймать ни кодом возврата, ни логом. «Без обновления» в batch — это
 * пропуск шага `update-configuration` и замена запасного пути `sync-configuration-full` (который сам
 * применяет в базе) на `import-configuration -Mode Full` (`/LoadConfigFromFiles` без `/UpdateDBCfg`).
 */
suite('databaseLoadPlan: buildBatchLoadSteps', () => {
  const PROJECT = 'C:/proj';
  const CONNECTION = ['-InfoBasePath', 'C:/base', '-UserName', 'Admin', '-Password', 'p', '-V8Path', 'C:/1cv8'];

  const cases: { kind: 'cf' | 'cfe'; configDir: string; extensionName: string | undefined }[] = [
    { kind: 'cf', configDir: 'C:/proj/src/cf', extensionName: undefined },
    { kind: 'cfe', configDir: 'C:/proj/src/cfe/Расш', extensionName: 'Расш' },
  ];

  for (const { kind, configDir, extensionName } of cases) {
    const ext = extensionName === undefined ? [] : ['-Extension', extensionName];
    const prefix = (command: string): string[] => [command, '-ProjectRoot', PROJECT, '-Target', kind, '-ConfigDir', configDir];
    const input = (updateDatabase: boolean) => ({
      projectRoot: PROJECT, kind, configDir, extensionName, connectionArgs: CONNECTION, updateDatabase,
    });

    test(`${kind}, updateDatabase=true: partial, update и fallback sync-configuration-full — точные векторы`, () => {
      assert.deepStrictEqual(buildBatchLoadSteps(input(true)), {
        partial: [...prefix('import-git-changes'), ...ext, ...CONNECTION],
        update: ['update-configuration', ...ext, ...CONNECTION],
        fallback: [...prefix('sync-configuration-full'), ...ext, ...CONNECTION],
        fallbackUpdatesDatabase: true,
      });
    });

    test(`${kind}, updateDatabase=false: шага update нет; fallback — import-configuration -Mode Full (без применения в базе)`, () => {
      const steps = buildBatchLoadSteps(input(false));
      assert.deepStrictEqual(steps, {
        partial: [...prefix('import-git-changes'), ...ext, ...CONNECTION],
        fallback: [...prefix('import-configuration'), '-Mode', 'Full', ...ext, ...CONNECTION],
        fallbackUpdatesDatabase: false,
      });
      assert.strictEqual((steps as { update?: unknown }).update, undefined, 'шага update-configuration нет');
    });

    test(`${kind}: аргументы подключения — в конце вектора каждого шага; -Extension только у cfe; -Mode Full только у import-configuration`, () => {
      for (const updateDatabase of [true, false]) {
        const steps = buildBatchLoadSteps(input(updateDatabase));
        const vectors = [steps.partial, steps.fallback, ...(steps.update ? [steps.update] : [])];
        for (const vector of vectors) {
          assert.deepStrictEqual(vector.slice(-CONNECTION.length), CONNECTION);
          assert.strictEqual(vector.includes('-Extension'), kind === 'cfe');
          if (kind === 'cfe') {
            assert.strictEqual(vector[vector.indexOf('-Extension') + 1], 'Расш');
          }
        }
        assert.strictEqual(steps.fallback.includes('-Mode'), !updateDatabase);
        assert.ok(!steps.partial.includes('-Mode'));
      }
    });
  }

  test('cfe без extensionName в запросе: -Extension не добавляется (имя — обязанность вызывающего)', () => {
    const steps = buildBatchLoadSteps({ projectRoot: PROJECT, kind: 'cf', configDir: 'C:/proj/src/cf', extensionName: undefined, connectionArgs: [], updateDatabase: true });
    assert.deepStrictEqual(steps.update, ['update-configuration']);
    assert.ok(!steps.partial.includes('-Extension'));
  });

  test('вектор не мутирует входной массив подключения: повторный вызов даёт тот же результат', () => {
    const connection = ['-InfoBasePath', 'C:/base'];
    const request = { projectRoot: PROJECT, kind: 'cf' as const, configDir: 'C:/proj/src/cf', extensionName: undefined, connectionArgs: connection, updateDatabase: true };
    const first = buildBatchLoadSteps(request);
    buildBatchLoadSteps(request);
    assert.deepStrictEqual(connection, ['-InfoBasePath', 'C:/base']);
    assert.deepStrictEqual(buildBatchLoadSteps(request), first);
  });
});

suite('databaseLoadPlan: decideLagAfterLoad — единая таблица правил признака отставания', () => {
  /**
   * `ambiguousFailure` — операция упала ПОСЛЕ начала загрузки, и по коду возврата нельзя отличить, на каком
   * шаге (например `sync-configuration-full` = загрузка + применение; сбой самой загрузки — тоже сюда:
   * консервативно, лишнее напоминание безопаснее пропущенного). `loaded=false` без сбоя — загрузки не было
   * (отказ от полной загрузки, отмена): признак не трогается.
   */
  const table: {
    loaded: boolean; updateRequested: boolean; updateSucceeded: boolean; ambiguousFailure: boolean;
    expected: 'behind' | 'current' | 'unchanged'; why: string;
  }[] = [
    { loaded: true, updateRequested: false, updateSucceeded: false, ambiguousFailure: false, expected: 'behind', why: 'загрузка без обновления' },
    { loaded: true, updateRequested: false, updateSucceeded: true, ambiguousFailure: false, expected: 'behind', why: 'обновление не запрашивалось: updateSucceeded не учитывается' },
    { loaded: true, updateRequested: true, updateSucceeded: true, ambiguousFailure: false, expected: 'current', why: 'загрузка и UpdateDBCfg прошли' },
    { loaded: true, updateRequested: true, updateSucceeded: false, ambiguousFailure: false, expected: 'behind', why: 'загрузка прошла, обновление упало (update-failed)' },
    { loaded: false, updateRequested: true, updateSucceeded: false, ambiguousFailure: true, expected: 'behind', why: 'сбой sync-configuration-full: шаг не определить' },
    { loaded: false, updateRequested: false, updateSucceeded: false, ambiguousFailure: true, expected: 'behind', why: 'сбой загрузки без обновления: консервативно (атомарность не замерена)' },
    { loaded: false, updateRequested: true, updateSucceeded: false, ambiguousFailure: false, expected: 'unchanged', why: 'загрузки не было — признак не трогаем' },
    { loaded: false, updateRequested: false, updateSucceeded: false, ambiguousFailure: false, expected: 'unchanged', why: 'загрузки не было — признак не трогаем' },
  ];
  for (const row of table) {
    test(`loaded=${String(row.loaded)}, updateRequested=${String(row.updateRequested)}, updateSucceeded=${String(row.updateSucceeded)}, ambiguousFailure=${String(row.ambiguousFailure)} → ${row.expected} (${row.why})`, () => {
      assert.strictEqual(decideLagAfterLoad(row), row.expected);
    });
  }
});

suite('databaseLoadPlan: planUpdateTargets', () => {
  const changed = (kind: 'cf' | 'cfe', name: string, rootPath: string): ChangedConfiguration =>
    ({ kind, name, rootPath, changedFilesCount: 2 });
  const behind = (kind: 'cf' | 'cfe', name: string, rootPath: string): DatabaseLagEntry => ({
    kind, name, rootPath, extensionName: kind === 'cfe' ? name : undefined, since: '2026-01-01T00:00:00.000Z', source: 'load-without-update',
  });
  const brief = (items: ReturnType<typeof planUpdateTargets>): string[] =>
    items.map((item) => `${item.action}:${item.target.kind}:${item.target.name}`);

  const CF = 'C:/p/src/cf';
  const A = 'C:/p/src/cfe/А';
  const B = 'C:/p/src/cfe/Б';

  test('нет изменённых и нет отстающих: пусто при обеих настройках', () => {
    assert.deepStrictEqual(planUpdateTargets([], [], true), []);
    assert.deepStrictEqual(planUpdateTargets([], [], false), []);
  });

  test('updateDatabase=true: изменённые — load-and-update; отстающие без изменений — update-only', () => {
    const plan = planUpdateTargets([changed('cf', 'Основная', CF)], [behind('cfe', 'А', A)], true);
    assert.deepStrictEqual(brief(plan), ['load-and-update:cf:Основная', 'update-only:cfe:А']);
  });

  test('updateDatabase=false: изменённые — load; отстающие без изменений не попадают в план', () => {
    const plan = planUpdateTargets([changed('cfe', 'А', A)], [behind('cf', 'Основная', CF), behind('cfe', 'Б', B)], false);
    assert.deepStrictEqual(brief(plan), ['load:cfe:А']);
  });

  test('updateDatabase=false, изменений нет, есть отстающие: план пуст', () => {
    assert.deepStrictEqual(planUpdateTargets([], [behind('cf', 'Основная', CF)], false), []);
  });

  test('цель и изменена, и отстаёт: ОДИН элемент load-and-update (дедупликация по rootPath), не два', () => {
    const plan = planUpdateTargets([changed('cfe', 'А', A)], [behind('cfe', 'А', A)], true);
    assert.deepStrictEqual(brief(plan), ['load-and-update:cfe:А']);
  });

  test('дедупликация по rootPath без учёта регистра и без учёта разделителей регистра диска', () => {
    const plan = planUpdateTargets([changed('cf', 'Основная', 'C:/P/SRC/CF')], [behind('cf', 'Основная', 'c:/p/src/cf')], true);
    assert.strictEqual(plan.length, 1);
    assert.strictEqual(plan[0].action, 'load-and-update');
  });

  test('порядок: cf первым, затем cfe по имени; update-only участвует в том же порядке', () => {
    const plan = planUpdateTargets(
      [changed('cfe', 'Б', B), changed('cfe', 'А', A)],
      [behind('cf', 'Основная', CF)],
      true
    );
    assert.deepStrictEqual(brief(plan), ['update-only:cf:Основная', 'load-and-update:cfe:А', 'load-and-update:cfe:Б']);
  });

  test('цель в плане несёт kind, name и rootPath (для раннера)', () => {
    const [item] = planUpdateTargets([], [behind('cfe', 'А', A)], true);
    assert.deepStrictEqual([item.target.kind, item.target.name, item.target.rootPath], ['cfe', 'А', A]);
  });

  test('входные массивы не мутируются', () => {
    const c = [changed('cfe', 'Б', B), changed('cfe', 'А', A)];
    const b = [behind('cf', 'Основная', CF)];
    planUpdateTargets(c, b, true);
    assert.deepStrictEqual(c.map((item) => item.name), ['Б', 'А']);
    assert.strictEqual(b.length, 1);
  });
});

suite('databaseLoadPlan: planThinClientLaunch и тексты', () => {
  const ids = (changedCount: number, behindCount: number): string[] =>
    planThinClientLaunch({ changedCount, behindCount }).map((item) => item.id);

  test('нет изменений и нет отставания: вопроса нет (пустой набор)', () => {
    assert.deepStrictEqual(ids(0, 0), []);
  });

  test('есть изменения, отставания нет: «Обновить и запустить» / «Запустить без обновления»', () => {
    assert.deepStrictEqual(ids(2, 0), ['update', 'run']);
  });

  test('изменений нет, есть отстающие: «Обновить конфигурацию БД и запустить» / «Запустить без обновления»', () => {
    assert.deepStrictEqual(ids(0, 1), ['update-database', 'run']);
    const items = planThinClientLaunch({ changedCount: 0, behindCount: 1 });
    assert.ok(items[0].label.includes('Обновить конфигурацию БД и запустить'), items[0].label);
    assert.ok(items[1].label.includes('Запустить без обновления'), items[1].label);
  });

  test('есть и изменения, и отстающие: загрузка с обновлением покрывает оба — пункт «update»', () => {
    assert.deepStrictEqual(ids(3, 2), ['update', 'run']);
  });

  test('describeLoadWithoutUpdateSuccess: точный текст с именем', () => {
    assert.strictEqual(
      describeLoadWithoutUpdateSuccess('Основная'),
      'Изменения "Основная" загружены в основную конфигурацию. Конфигурация БД не обновлена — ' +
      'выполните «Обновить конфигурацию БД» перед запуском Предприятия.'
    );
  });
});
