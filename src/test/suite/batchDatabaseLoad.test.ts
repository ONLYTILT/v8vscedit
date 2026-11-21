import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildScopeKey, saveHashCache } from '../../infra/cache/HashCache';
import { hasPendingHashChanges, scanHashSnapshot } from '../../infra/cache/HashScanner';
import type { DatabaseLagTarget } from '../../infra/database/DatabaseConfigLag';
import { runBatchDatabaseLoad, type BatchLoadStepKind } from '../../ui/commands/ext/batchDatabaseLoad';
import {
  buildBatchLoadSteps,
  settleCfFileLoadLag,
  settleCfeBatchLoadLag,
  settleDatabaseLag,
} from '../../ui/commands/ext/databaseLoadPlan';
import { FakeLagRecorder, lagKeyOf } from './support/databaseLagFakes';
import { removeTreeSync } from './support/tempTree';

/**
 * Порядок шагов пакетной загрузки (`runBatchDatabaseLoad`) и правила признака «БД отстаёт» для пакетного
 * режима и загрузки CF/CFE-файлов. Внешняя система — внутренний CLI с настоящим 1cv8: шаги исполняет
 * подставной `runStep`, который отвечает заданным исходом и ведёт журнал (вектор каждого шага — точный, из
 * `buildBatchLoadSteps`, уже под регресс-тестом в databaseLoadPlan.test.ts).
 */
suite('batchDatabaseLoad: runBatchDatabaseLoad', () => {
  const target: DatabaseLagTarget = { kind: 'cfe', name: 'Расш', rootPath: 'C:/p/src/cfe/Расш', extensionName: 'Расш' };
  let lag: FakeLagRecorder;
  let journal: string[];
  let logs: string[];

  const stepsOf = (updateDatabase: boolean) => buildBatchLoadSteps({
    projectRoot: 'C:/p', kind: 'cfe', configDir: target.rootPath, extensionName: 'Расш', connectionArgs: ['-InfoBasePath', 'C:/b'], updateDatabase,
  });

  /** `answers` — исход каждого вида шага; `confirm` — ответ на вопрос о полной загрузке. */
  const deps = (answers: Partial<Record<BatchLoadStepKind, boolean>>, confirm = true, changes = true) => ({
    hasChanges: () => {
      journal.push('check');
      return Promise.resolve(changes);
    },
    runStep: (kind: BatchLoadStepKind, args: string[]) => {
      journal.push(`${kind}:${args[0]}`);
      const ok = answers[kind] ?? true;
      return Promise.resolve(ok ? { ok } : { ok, failureReason: `сбой ${kind}` });
    },
    confirmFallback: (reason: string) => {
      journal.push(`confirm:${reason}`);
      return Promise.resolve(confirm);
    },
    log: (line: string) => { logs.push(line); },
  });

  setup(() => {
    lag = new FakeLagRecorder();
    journal = [];
    logs = [];
  });

  test('с обновлением, всё успешно: partial → update; отметка ставится ДО применения и снимается после', async () => {
    const { ok } = await runBatchDatabaseLoad(stepsOf(true), target, { updateDatabase: true, lag }, deps({}));

    assert.strictEqual(ok, true);
    assert.deepStrictEqual(journal, ['check', 'partial:import-git-changes', 'update:update-configuration']);
    assert.deepStrictEqual(lag.calls, [
      { op: 'behind', key: lagKeyOf(target), source: 'update-failed' },
      { op: 'current', key: lagKeyOf(target) },
    ]);
  });

  test('с обновлением, применение упало: false, отметка update-failed остаётся', async () => {
    const { ok } = await runBatchDatabaseLoad(stepsOf(true), target, { updateDatabase: true, lag }, deps({ update: false }));

    assert.strictEqual(ok, false);
    assert.strictEqual(lag.sourceOf(target), 'update-failed');
  });

  test('без обновления: только partial, шага update нет, отметка load-without-update', async () => {
    lag.markBehind(target, 'cf-file-load');
    lag.calls.length = 0;

    const { ok } = await runBatchDatabaseLoad(stepsOf(false), target, { updateDatabase: false, lag }, deps({}));

    assert.strictEqual(ok, true);
    assert.deepStrictEqual(journal, ['check', 'partial:import-git-changes']);
    assert.strictEqual(lag.sourceOf(target), 'load-without-update');
  });

  for (const updateDatabase of [true, false]) {
    const fallbackCommand = updateDatabase ? 'sync-configuration-full' : 'import-configuration';

    test(`updateDatabase=${String(updateDatabase)}: отказ частичной → вопрос с причиной → ${fallbackCommand}; успех запасного пути ${updateDatabase ? 'снимает' : 'ставит'} отметку`, async () => {
      const { ok } = await runBatchDatabaseLoad(stepsOf(updateDatabase), target, { updateDatabase, lag }, deps({ partial: false }));

      assert.strictEqual(ok, true);
      assert.deepStrictEqual(journal, ['check', 'partial:import-git-changes', 'confirm:сбой partial', `fallback:${fallbackCommand}`]);
      assert.strictEqual(lag.isBehind(target), !updateDatabase);
      assert.ok(logs[0].includes('Частичная загрузка по хеш-кэшу недоступна'), logs.join('|'));
    });

    test(`updateDatabase=${String(updateDatabase)}: запасной путь упал — false, отметка стоит (шаг сбоя не определить)`, async () => {
      const { ok } = await runBatchDatabaseLoad(stepsOf(updateDatabase), target, { updateDatabase, lag }, deps({ partial: false, fallback: false }));

      assert.strictEqual(ok, false);
      assert.strictEqual(lag.sourceOf(target), updateDatabase ? 'update-failed' : 'load-without-update');
    });

    test(`updateDatabase=${String(updateDatabase)}: отказ частичной и отказ от полной загрузки — false, запасной путь не запускается, отметка консервативно стоит`, async () => {
      const { ok } = await runBatchDatabaseLoad(stepsOf(updateDatabase), target, { updateDatabase, lag }, deps({ partial: false }, false));

      assert.strictEqual(ok, false);
      assert.deepStrictEqual(journal, ['check', 'partial:import-git-changes', 'confirm:сбой partial']);
      assert.strictEqual(lag.isBehind(target), true);
      assert.ok(logs.some((line) => line.includes('Полная загрузка отклонена пользователем')), logs.join('|'));
    });
  }

  test('причины сбоя частичной нет — вопрос получает пустую строку', async () => {
    const steps = stepsOf(true);
    await runBatchDatabaseLoad(steps, target, { updateDatabase: true, lag }, {
      hasChanges: () => Promise.resolve(true),
      runStep: (kind) => Promise.resolve({ ok: kind !== 'partial' }),
      confirmFallback: (reason) => {
        journal.push(`confirm:[${reason}]`);
        return Promise.resolve(false);
      },
      log: () => undefined,
    });
    assert.deepStrictEqual(journal, ['confirm:[]']);
  });

  test('исход: databaseUpdated — только при успешном применении (шаг update или запасной путь с применением)', async () => {
    assert.deepStrictEqual(
      await runBatchDatabaseLoad(stepsOf(true), target, { updateDatabase: true, lag }, deps({})),
      { ok: true, databaseUpdated: true, unchanged: false }
    );
    assert.deepStrictEqual(
      await runBatchDatabaseLoad(stepsOf(false), target, { updateDatabase: false, lag }, deps({})),
      { ok: true, databaseUpdated: false, unchanged: false }
    );
    assert.deepStrictEqual(
      await runBatchDatabaseLoad(stepsOf(true), target, { updateDatabase: true, lag }, deps({ partial: false })),
      { ok: true, databaseUpdated: true, unchanged: false }
    );
    assert.deepStrictEqual(
      await runBatchDatabaseLoad(stepsOf(false), target, { updateDatabase: false, lag }, deps({ partial: false })),
      { ok: true, databaseUpdated: false, unchanged: false }
    );
  });

  suite('изменений нет (import-git-changes на это отвечает кодом 0 — без предпроверки неотличимо от загрузки)', () => {
    test('без обновления: ни одного шага, признак не трогается, unchanged', async () => {
      const outcome = await runBatchDatabaseLoad(stepsOf(false), target, { updateDatabase: false, lag }, deps({}, true, false));

      assert.deepStrictEqual(outcome, { ok: true, databaseUpdated: false, unchanged: true });
      assert.deepStrictEqual(journal, ['check']);
      assert.deepStrictEqual(lag.calls, []);
      assert.ok(logs.some((line) => line.includes('Изменений для загрузки нет')), logs.join('|'));
    });

    test('с обновлением: только update-configuration (явное «Обновить в базе» снимает отставание), отметка снята', async () => {
      lag.markBehind(target, 'load-without-update');

      const outcome = await runBatchDatabaseLoad(stepsOf(true), target, { updateDatabase: true, lag }, deps({}, true, false));

      assert.deepStrictEqual(outcome, { ok: true, databaseUpdated: true, unchanged: true });
      assert.deepStrictEqual(journal, ['check', 'update:update-configuration']);
      assert.strictEqual(lag.isBehind(target), false);
    });

    test('с обновлением, применение упало: false, прежний признак не меняется', async () => {
      lag.markBehind(target, 'cf-file-load');
      lag.calls.length = 0;

      const outcome = await runBatchDatabaseLoad(stepsOf(true), target, { updateDatabase: true, lag }, deps({ update: false }, true, false));

      assert.deepStrictEqual(outcome, { ok: false, databaseUpdated: false, unchanged: true });
      assert.deepStrictEqual(lag.calls, []);
      assert.strictEqual(lag.sourceOf(target), 'cf-file-load');
    });
  });
});

suite('databaseLoadPlan: settleDatabaseLag, settleCfFileLoadLag, settleCfeBatchLoadLag', () => {
  const cfe = (name: string): DatabaseLagTarget => ({ kind: 'cfe', name, rootPath: `C:/p/src/cfe/${name}`, extensionName: name });
  let lag: FakeLagRecorder;
  setup(() => { lag = new FakeLagRecorder(); });

  test('settleDatabaseLag: behind — отметка с источником, current — снятие, unchanged — ничего', () => {
    settleDatabaseLag(lag, cfe('А'), 'behind', 'load-without-update');
    assert.strictEqual(lag.sourceOf(cfe('А')), 'load-without-update');
    settleDatabaseLag(lag, cfe('А'), 'unchanged', 'update-failed');
    assert.strictEqual(lag.sourceOf(cfe('А')), 'load-without-update');
    settleDatabaseLag(lag, cfe('А'), 'current', 'update-failed');
    assert.strictEqual(lag.isBehind(cfe('А')), false);
  });

  test('settleCfFileLoadLag: применено агентом — снятие, иначе cf-file-load', () => {
    settleCfFileLoadLag(lag, cfe('А'), false);
    assert.strictEqual(lag.sourceOf(cfe('А')), 'cf-file-load');
    settleCfFileLoadLag(lag, cfe('А'), true);
    assert.strictEqual(lag.isBehind(cfe('А')), false);
  });

  test('settleCfeBatchLoadLag: ok без применения — отметка, ok с применением — снятие, не ok — без изменений, сбойное — отметка', () => {
    lag.markBehind(cfe('Новое'), 'load-without-update');
    settleCfeBatchLoadLag(lag, {
      items: [
        { status: 'ok', extensionName: 'Старое' },
        { status: 'ok', extensionName: 'Новое', appliedToDatabase: true },
        { status: 'skipped', extensionName: 'Пропущено' },
      ],
      failedAt: { extensionName: 'Сбойное' },
    }, cfe);

    assert.strictEqual(lag.sourceOf(cfe('Старое')), 'cf-file-load');
    assert.strictEqual(lag.isBehind(cfe('Новое')), false);
    assert.strictEqual(lag.isBehind(cfe('Пропущено')), false);
    assert.strictEqual(lag.sourceOf(cfe('Сбойное')), 'cf-file-load');
  });

  test('settleCfeBatchLoadLag: отчёта нет (операция не дошла до записи) — признак не трогается', () => {
    settleCfeBatchLoadLag(lag, undefined, cfe);
    assert.deepStrictEqual(lag.calls, []);
  });
});

suite('HashScanner: hasPendingHashChanges (предпроверка пакетной загрузки)', () => {
  let root: string;
  let configDir: string;
  setup(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-pending-changes-')));
    configDir = path.join(root, 'src', 'cfe', 'Расш');
    fs.mkdirSync(path.join(configDir, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'Configuration.xml'), '<MetaDataObject/>', 'utf-8');
    fs.writeFileSync(path.join(configDir, 'Catalogs', 'Товары.xml'), '<Catalog>v1</Catalog>', 'utf-8');
  });
  teardown(() => { removeTreeSync(root); });

  const saveBaseline = async (): Promise<void> => {
    const scopeKey = buildScopeKey('cfe', configDir, 'Расш');
    saveHashCache(root, await scanHashSnapshot(root, scopeKey, configDir));
  };

  test('базовой линии нет — все файлы новые: изменения есть (как у import-git-changes)', async () => {
    assert.strictEqual(await hasPendingHashChanges(root, 'cfe', configDir, 'Расш'), true);
  });

  test('проект совпадает с базовой линией: изменений нет', async () => {
    await saveBaseline();
    assert.strictEqual(await hasPendingHashChanges(root, 'cfe', configDir, 'Расш'), false);
  });

  test('правка и удаление файла после базовой линии: изменения есть', async () => {
    await saveBaseline();
    fs.writeFileSync(path.join(configDir, 'Catalogs', 'Товары.xml'), '<Catalog>v2-длиннее</Catalog>', 'utf-8');
    assert.strictEqual(await hasPendingHashChanges(root, 'cfe', configDir, 'Расш'), true);

    await saveBaseline();
    fs.unlinkSync(path.join(configDir, 'Catalogs', 'Товары.xml'));
    assert.strictEqual(await hasPendingHashChanges(root, 'cfe', configDir, 'Расш'), true);
  });

  test('основная конфигурация: имя расширения по умолчанию пустое', async () => {
    const cfDir = path.join(root, 'src', 'cf');
    fs.mkdirSync(cfDir, { recursive: true });
    fs.writeFileSync(path.join(cfDir, 'Configuration.xml'), '<MetaDataObject/>', 'utf-8');
    const scopeKey = buildScopeKey('cf', cfDir);
    saveHashCache(root, await scanHashSnapshot(root, scopeKey, cfDir));
    assert.strictEqual(await hasPendingHashChanges(root, 'cf', cfDir), false);
  });
});
