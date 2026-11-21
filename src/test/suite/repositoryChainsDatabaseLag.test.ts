import * as assert from 'assert';
import { RepositoryCliError } from '../../ui/commands/repository/RepositoryCommandRunner';
import { runCommitChain, runLockChain, runUpdateChain } from '../../ui/commands/repository/repositoryChains';
import { loadTargetChangesIntoDatabase, runPostRepositorySync } from '../../ui/commands/repository/repositoryPostSync';
import type { RepositoryLockPlan } from '../../ui/commands/repository/repositoryLockFlow';
import type { RepositoryUpdatePlan } from '../../ui/commands/repository/repositoryUpdateFlow';
import {
  COMMIT_DONE, LOCK_DONE, UPDATE_DONE, createRepoProject, opLog, type RepoProject,
} from './support/repositoryMcpFixtures';

/**
 * Шаг загрузки правок в цепочках хранилища берёт режим из плана (`updateDatabaseOnLoad` — настройка
 * `updateDatabaseAfterLoad` или параметр MCP), а признак «БД отстаёт» ставится и операциями хранилища,
 * менявшими ОСНОВНУЮ конфигурацию без UpdateDBCfg (решение оркестратора №1): получение версий при захвате,
 * «Получить», помещение с очисткой ссылок. Заглушка раннера в фикстуре повторяет его контракт по признаку:
 * загрузка «с обновлением» снимает отметку цели, «без обновления» — ставит.
 *
 * Поля результатов: `databaseConfigurationUpdated` — цепочка выполнила шаг загрузки С обновлением БД;
 * `databaseConfigurationBehind` — итог `lag.isBehind(цель)` в конце цепочки (оба могут быть true: UpdateDBCfg
 * до захвата не покрывает версии, полученные захватом позже).
 */
const T = 'Справочник.Товары';

suite('repositoryChains: updateDatabaseOnLoad и признак отставания БД', () => {
  let p: RepoProject;
  const T_RECEIVED = opLog(LOCK_DONE, `Объект захвачен для редактирования: ${T}`, `Объект получен из хранилища: ${T}`);
  const T_GOT = opLog(UPDATE_DONE, `Объект получен из хранилища: ${T}`);
  const T_NOTHING = opLog(UPDATE_DONE);
  const COMMITTED = opLog(COMMIT_DONE, `Объект помещен в хранилище: ${T}`);
  const CLEANED = opLog(COMMIT_DONE, 'Очистка объектов от некорректных ссылок выполнена', `Объект помещен в хранилище: ${T}`);
  const lockPlan = (overrides: Partial<RepositoryLockPlan> = {}): RepositoryLockPlan =>
    ({ revised: true, updateDatabaseFirst: false, updateDatabaseOnLoad: false, importAfterLock: true, ...overrides });
  const updatePlan = (overrides: Partial<RepositoryUpdatePlan> = {}): RepositoryUpdatePlan =>
    ({ loadChangesAfterReceive: false, updateDatabaseOnLoad: false, importAfterReceive: true, ...overrides });
  const updateRequest = { recursive: false, force: false };
  const commitRequest = { recursive: false, comment: 'Правка', keepLocked: false, force: false };
  const cfLag = () => ({ kind: 'cf' as const, name: 'Основная', rootPath: p.cfRoot });
  const cfeLag = () => ({ kind: 'cfe' as const, name: 'Расш', rootPath: p.cfeRoot, extensionName: 'Расш' });

  setup(async () => { p = await createRepoProject(); p.lock([T]); });
  teardown(() => p.dispose());

  for (const updateDatabaseOnLoad of [true, false]) {
    for (const target of ['cf', 'cfe'] as const) {
      const tag = `${target}, updateDatabaseOnLoad=${String(updateDatabaseOnLoad)}`;
      const getTarget = () => (target === 'cf' ? p.cfTarget : p.cfeTarget);
      const getRef = () => (target === 'cf' ? p.refs.catalog : p.refs.cfeCatalog);
      const lagTarget = () => (target === 'cf' ? cfLag() : cfeLag());

      test(`захват с загрузкой до него, ${tag}: раннер получает { updateDatabase: updateDatabaseOnLoad, lag: services.databaseConfigLag }`, async () => {
        p.lock([T], getTarget());
        p.setResult(T_RECEIVED);
        await runLockChain(p.services, getTarget(), getRef(), false, lockPlan({ updateDatabaseFirst: true, updateDatabaseOnLoad }));

        assert.strictEqual(p.updateCalls.length, 1);
        assert.strictEqual(p.updateOptions().updateDatabase, updateDatabaseOnLoad);
        assert.strictEqual(p.updateOptions().lag, p.services.databaseConfigLag, 'тот же признак, что у остальных путей');
      });

      test(`получение с загрузкой после него, ${tag}: раннер получает updateDatabase = updateDatabaseOnLoad`, async () => {
        p.setResult(T_GOT);
        const result = await runUpdateChain(
          p.services, getTarget(), getRef(), updateRequest, updatePlan({ loadChangesAfterReceive: true, updateDatabaseOnLoad })
        );

        assert.strictEqual(p.updateOptions().updateDatabase, updateDatabaseOnLoad);
        assert.strictEqual(result.databaseConfigurationUpdated, updateDatabaseOnLoad);
        // Версии получены, а UpdateDBCfg после них был только при updateDatabaseOnLoad — иначе БД отстаёт.
        assert.strictEqual(result.databaseConfigurationBehind, !updateDatabaseOnLoad);
        assert.strictEqual(p.lag.isBehind(lagTarget()), !updateDatabaseOnLoad);
      });

      test(`помещение с загрузкой до него, ${tag}: раннер получает updateDatabase = updateDatabaseOnLoad`, async () => {
        p.lock([T], getTarget());
        p.setResult(COMMITTED);
        const result = await runCommitChain(
          p.services, getTarget(), getRef(), commitRequest, { updateDatabaseFirst: true, updateDatabaseOnLoad }
        );

        assert.strictEqual(p.updateOptions().updateDatabase, updateDatabaseOnLoad);
        assert.strictEqual(result.databaseConfigurationUpdated, updateDatabaseOnLoad);
        // Отметку «загрузка без обновления» ставит раннер (в фикстуре — заглушка с тем же контрактом), не цепочка.
        assert.strictEqual(result.databaseConfigurationBehind, !updateDatabaseOnLoad);
      });
    }
  }

  test('захват БЕЗ шага загрузки: раннер не вызывался, databaseConfigurationUpdated=false', async () => {
    p.setResult(T_RECEIVED);
    const result = await runLockChain(p.services, p.cfTarget, p.refs.catalog, false, lockPlan());
    assert.deepStrictEqual(p.updateCalls, []);
    assert.strictEqual(result.databaseConfigurationUpdated, false);
  });

  test('помещение БЕЗ шага загрузки: раннер не вызывался, оба поля false', async () => {
    p.setResult(COMMITTED);
    const result = await runCommitChain(p.services, p.cfTarget, p.refs.catalog, commitRequest, { updateDatabaseFirst: false, updateDatabaseOnLoad: false });
    assert.deepStrictEqual(p.updateCalls, []);
    assert.deepStrictEqual([result.databaseConfigurationUpdated, result.databaseConfigurationBehind], [false, false]);
  });

  suite('markBehind(repository-receive): получение версий меняет основную конфигурацию без UpdateDBCfg', () => {
    test('захват получил версии (даже при загрузке С обновлением ДО захвата — она была раньше получения): repository-receive', async () => {
      p.setResult(T_RECEIVED);
      const result = await runLockChain(p.services, p.cfTarget, p.refs.catalog, false, lockPlan({ updateDatabaseFirst: true, updateDatabaseOnLoad: true }));
      assert.strictEqual(p.lag.sourceOf(cfLag()), 'repository-receive');
      assert.strictEqual(result.databaseConfigurationBehind, true);
      assert.strictEqual(result.databaseConfigurationUpdated, true, 'UpdateDBCfg до захвата выполнен');
    });

    test('захват без получения версий: отметки нет', async () => {
      p.setResult(opLog(LOCK_DONE, `Объект захвачен для редактирования: ${T}`));
      const result = await runLockChain(p.services, p.cfTarget, p.refs.catalog, false, lockPlan());
      assert.strictEqual(p.lag.isBehind(cfLag()), false);
      assert.strictEqual(result.databaseConfigurationBehind, false);
    });

    test('захват получил версии, сбой импорта в проект: отметка всё равно стоит (основная конфигурация изменена)', async () => {
      p.setResult(T_RECEIVED);
      p.importResult = false;
      await runLockChain(p.services, p.cfTarget, p.refs.catalog, false, lockPlan());
      assert.strictEqual(p.lag.sourceOf(cfLag()), 'repository-receive');
    });

    test('захват получил версии, проект «оставить отстающим» (importAfterLock=false): отметка стоит', async () => {
      p.setResult(T_RECEIVED);
      await runLockChain(p.services, p.cfTarget, p.refs.catalog, false, lockPlan({ revised: false, importAfterLock: false }));
      assert.strictEqual(p.lag.sourceOf(cfLag()), 'repository-receive');
    });

    test('получение ничего не получило: отметки нет', async () => {
      p.setResult(T_NOTHING);
      const result = await runUpdateChain(p.services, p.cfTarget, p.refs.catalog, updateRequest, updatePlan());
      assert.strictEqual(p.lag.isBehind(cfLag()), false);
      assert.strictEqual(result.databaseConfigurationBehind, false);
    });

    test('получение получило версии без загрузки правок: repository-receive', async () => {
      p.setResult(T_GOT);
      await runUpdateChain(p.services, p.cfTarget, p.refs.catalog, updateRequest, updatePlan());
      assert.strictEqual(p.lag.sourceOf(cfLag()), 'repository-receive');
    });

    test('получение с загрузкой правок С обновлением БД после него: БД актуальна, прежняя отметка снята', async () => {
      p.lag.markBehind(cfLag(), 'update-failed');
      p.setResult(T_GOT);
      const result = await runUpdateChain(
        p.services, p.cfTarget, p.refs.catalog, updateRequest, updatePlan({ loadChangesAfterReceive: true, updateDatabaseOnLoad: true })
      );
      assert.strictEqual(p.lag.isBehind(cfLag()), false);
      assert.strictEqual(result.databaseConfigurationBehind, false);
    });

    test('получение, загрузка правок после него упала: версии получены — repository-receive', async () => {
      p.setResult(T_GOT);
      p.updateResult = false;
      await runUpdateChain(
        p.services, p.cfTarget, p.refs.catalog, updateRequest, updatePlan({ loadChangesAfterReceive: true, updateDatabaseOnLoad: true })
      );
      assert.strictEqual(p.lag.sourceOf(cfLag()), 'repository-receive');
    });

    test('помещение с очисткой ссылок (referencesCleaned): repository-receive; обычное помещение отметку не ставит', async () => {
      p.setResult(CLEANED);
      const cleaned = await runCommitChain(
        p.services, p.cfTarget, p.refs.catalog, { ...commitRequest, force: true }, { updateDatabaseFirst: false, updateDatabaseOnLoad: false }
      );
      assert.strictEqual(p.lag.sourceOf(cfLag()), 'repository-receive');
      assert.strictEqual(cleaned.databaseConfigurationBehind, true);

      p.lag.markCurrent(cfLag());
      p.lock([T]);
      p.setResult(COMMITTED);
      const plain = await runCommitChain(
        p.services, p.cfTarget, p.refs.catalog, commitRequest, { updateDatabaseFirst: false, updateDatabaseOnLoad: false }
      );
      assert.strictEqual(p.lag.isBehind(cfLag()), false);
      assert.strictEqual(plain.databaseConfigurationBehind, false);
    });

    test('отметка по цели cfe — отдельный ключ: cf остаётся актуальным', async () => {
      p.lock([T], p.cfeTarget);
      p.setResult(T_RECEIVED);
      await runLockChain(p.services, p.cfeTarget, p.refs.cfeCatalog, false, lockPlan());
      assert.strictEqual(p.lag.isBehind(cfeLag()), true);
      assert.strictEqual(p.lag.isBehind(cfLag()), false);
    });

    test('отказ операции хранилища (exit≠0): отметка не ставится', async () => {
      p.setResult('нет доступа', 1);
      await assert.rejects(() => runLockChain(p.services, p.cfTarget, p.refs.catalog, false, lockPlan()), RepositoryCliError);
      assert.strictEqual(p.lag.isBehind(cfLag()), false);
    });
  });

  test('цель уже отстаёт ДО цепочки: databaseConfigurationBehind отражает признак даже без получения версий', async () => {
    p.lag.markBehind(cfLag(), 'load-without-update');
    p.setResult(opLog(LOCK_DONE, `Объект захвачен для редактирования: ${T}`));
    const result = await runLockChain(p.services, p.cfTarget, p.refs.catalog, false, lockPlan());
    assert.strictEqual(result.databaseConfigurationBehind, true);
  });
});

suite('repositoryPostSync: loadTargetChangesIntoDatabase и runPostRepositorySync', () => {
  let p: RepoProject;
  setup(async () => { p = await createRepoProject(); });
  teardown(() => p.dispose());

  for (const updateDatabase of [true, false]) {
    for (const target of ['cf', 'cfe'] as const) {
      test(`loadTargetChangesIntoDatabase(${target}, updateDatabase=${String(updateDatabase)}): раннер получает режим и признак; успех помечает проект чистым и обновляет UI`, async () => {
        const repoTarget = target === 'cf' ? p.cfTarget : p.cfeTarget;

        const ok = await loadTargetChangesIntoDatabase(repoTarget, p.services, { updateDatabase });

        assert.strictEqual(ok, true);
        assert.deepStrictEqual(p.events, [target === 'cf' ? 'update:cf' : 'update:cfe:Расш']);
        assert.strictEqual(p.updateOptions().updateDatabase, updateDatabase);
        assert.strictEqual(p.updateOptions().lag, p.lag);
        assert.deepStrictEqual(p.cleaned, [[repoTarget.configRoot]]);
        assert.ok(p.refreshes > 0 && p.actionViewRefreshes > 0);
      });
    }
  }

  test('loadTargetChangesIntoDatabase: сбой раннера → false, проект не помечен чистым', async () => {
    p.updateResult = false;
    assert.strictEqual(await loadTargetChangesIntoDatabase(p.cfTarget, p.services, { updateDatabase: false }), false);
    assert.deepStrictEqual(p.cleaned, []);
  });

  test('runPostRepositorySync: применение к БД получает services.databaseConfigLag (снимает отметку), затем импорт', async () => {
    p.lag.markBehind({ kind: 'cf', name: 'Основная', rootPath: p.cfRoot }, 'load-without-update');

    await runPostRepositorySync(p.cfTarget, p.services);

    assert.deepStrictEqual(p.events, ['apply:cf', 'import:cf']);
    assert.strictEqual(p.applyCalls[0][3], p.lag);
    assert.strictEqual(p.lag.isBehind({ kind: 'cf', name: 'Основная', rootPath: p.cfRoot }), false);
  });
});
