import * as assert from 'assert';
import { RepositoryCliError, RepositoryCliInterruptedError } from '../../ui/commands/repository/RepositoryCommandRunner';
import {
  describeLockNotComplete,
  describeUnlockBlockedByChanges,
  describeUnlockNotDone,
  runCommitChain,
  runLockChain,
  runUnlockChain,
  runUpdateChain,
} from '../../ui/commands/repository/repositoryChains';
import { describeNothingToCommit } from '../../ui/commands/repository/repositoryCommitFlow';
import { describeLoadFailureAfterReceive } from '../../ui/commands/repository/repositoryUpdateFlow';
import { ROOT_LOCK_CF, createRepoProject, type RepoProject } from './support/repositoryMcpFixtures';
import {
  C1, C3, D1,
  COMMIT_DONE, E33_1_LOG, E33_1_RECEIVED_LOG, E33_3_LOG, LOCK_DONE, UNLOCK_DONE, UPDATE_DONE,
  addListObjects, cancelledLine, changedLine, committedLine, foreignLine, lockedLine, opLog, receivedLine, unchangedLine,
  type ListObjects,
} from './support/repositoryListFixtures';

/**
 * Цепочки операций хранилища со списком узлов (docs/plans/mcp-repository-paths-plan.md §1.5-1.6, тесты §4.D):
 * несколько узлов — один запуск Конфигуратора, одна загрузка до/после, один импорт; новые поля результатов
 * (`notLocked`, `lockedByOthers`, `lockedOverwritten`, `requestedObjects`, `notCommitted`) и предупреждения.
 * Техника — `repositoryChains.test.ts`: настоящие RepositoryService/env.json, журнал `events`.
 */

const FORCE_UNLOCK_NOT_USED = { recursive: false, force: false };

suite('repositoryChains (список): runLockChain', () => {
  let p: RepoProject;
  let o: ListObjects;
  const plan = (overrides: Record<string, unknown> = {}) =>
    ({ revised: false, updateDatabaseFirst: false, updateDatabaseOnLoad: false, importAfterLock: true, ...overrides });

  setup(async () => {
    p = await createRepoProject();
    o = addListObjects(p);
  });
  teardown(() => p.dispose());

  test('два узла: одна загрузка до, ОДИН захват, один импорт; новые поля результата', async () => {
    p.setResult(opLog(LOCK_DONE, lockedLine(C1), lockedLine(C3), receivedLine(C1)));
    const result = await runLockChain(
      p.services, p.cfTarget, [o.catalog1.ref, o.catalog3.ref], false,
      plan({ updateDatabaseFirst: true, updateDatabaseOnLoad: true }), 'unattended'
    );
    assert.deepStrictEqual(p.events, ['update:cf', 'repo:lock', 'import:cf']);
    assert.strictEqual(p.runs.length, 1);
    assert.strictEqual(p.updateCalls.length, 1);
    assert.strictEqual(p.importCalls.length, 1);
    assert.deepStrictEqual(result.lockedObjects, [C1, C3]);
    assert.deepStrictEqual(result.requestedObjects, [C1, C3]);
    assert.deepStrictEqual(result.notLocked, []);
    assert.deepStrictEqual(result.lockedByOthers, []);
    assert.strictEqual(result.receivedFromRepository, true);
    assert.strictEqual(result.databaseLoadedBefore, true);
    assert.strictEqual(result.projectImported, true);
    assert.strictEqual(result.projectBehind, false);
    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(result.databaseConfigurationUpdated, true);
    assert.strictEqual(typeof result.databaseConfigurationBehind, 'boolean');
    assert.deepStrictEqual(p.toasts, []);
  });

  test('Э33.(а): X уже захвачен этим пользователем, строки о нём нет — в lockedObjects, notLocked пуст', async () => {
    p.lock([C1]);
    p.setResult(opLog(LOCK_DONE, lockedLine(C3)));
    const result = await runLockChain(p.services, p.cfTarget, [o.catalog1.ref, o.catalog3.ref], false, plan(), 'unattended');
    assert.deepStrictEqual(result.lockedObjects, [C1, C3]);
    assert.deepStrictEqual(result.notLocked, []);
    assert.deepStrictEqual(result.warnings, []);
  });

  test('Э33.1, exit 1, версии получены: частичный исход — импорт ВЫПОЛНЕН, предупреждения (неполный захват + отказ платформы), без исключения', async () => {
    p.setResult(E33_1_RECEIVED_LOG, 1);
    const result = await runLockChain(
      p.services, p.cfTarget, [o.catalog1.ref, o.catalog3.ref, o.document1.ref], false, plan(), 'unattended'
    );
    assert.deepStrictEqual(p.events, ['repo:lock', 'import:cf']);
    assert.deepStrictEqual(result.lockedObjects, [C1, C3]);
    assert.deepStrictEqual(result.requestedObjects, [C1, C3, D1]);
    assert.deepStrictEqual(result.notLocked, [D1]);
    assert.deepStrictEqual(result.lockedByOthers, [{ name: D1, user: 'UserB' }]);
    assert.strictEqual(result.receivedFromRepository, true);
    assert.strictEqual(result.projectImported, true);
    assert.strictEqual(result.projectBehind, false);
    assert.strictEqual(result.warnings.length, 2);
    assert.ok(result.warnings.includes(describeLockNotComplete([D1], [{ name: D1, user: 'UserB' }])), result.warnings.join(' | '));
    assert.ok(result.warnings.some((w) => w.startsWith('Ошибка при захвате объектов хранилища:')), result.warnings.join(' | '));
    assert.strictEqual(p.service.isLocked(p.cfTarget, C1), true);
    assert.strictEqual(p.service.isLocked(p.cfTarget, D1), false);
    assert.deepStrictEqual(p.cleaned, [[p.cfRoot]]);
    assert.strictEqual(result.databaseConfigurationBehind, true, 'версии получены — конфигурация БД отстаёт');
    assert.deepStrictEqual(p.toasts, []);
  });

  test('Э33.1, exit 1, версий нет: импорта нет, два предупреждения, учёт записан', async () => {
    p.setResult(E33_1_LOG, 1);
    const result = await runLockChain(
      p.services, p.cfTarget, [o.catalog1.ref, o.catalog3.ref, o.document1.ref], false, plan(), 'unattended'
    );
    assert.deepStrictEqual(p.events, ['repo:lock']);
    assert.strictEqual(result.receivedFromRepository, false);
    assert.strictEqual(result.projectImported, false);
    assert.strictEqual(result.warnings.length, 2);
    assert.deepStrictEqual(result.lockedObjects, [C1, C3]);
  });

  test('частичный захват при exit 0 (отсутствующий объект): успех с предупреждением «Захвачены не все объекты: …»', async () => {
    p.setResult(opLog(LOCK_DONE, lockedLine(C1), `Объекты, отсутствующие в обеих конфигурациях: ${D1}`));
    const result = await runLockChain(p.services, p.cfTarget, [o.catalog1.ref, o.document1.ref], false, plan(), 'unattended');
    assert.deepStrictEqual(result.lockedObjects, [C1]);
    assert.deepStrictEqual(result.notLocked, [D1]);
    assert.deepStrictEqual(result.lockedByOthers, []);
    assert.deepStrictEqual(result.warnings, ['Захвачены не все объекты: Документ.Документ1.']);
  });

  test('exit 1 и по логу ничего не захвачено: исключение, импорта нет, учёт не тронут', async () => {
    p.setResult(opLog('Захват объектов не выполнен', foreignLine(D1, 'UserB')), 1);
    await assert.rejects(
      () => runLockChain(p.services, p.cfTarget, [o.document1.ref, o.catalog3.ref], false, plan(), 'unattended'),
      RepositoryCliError
    );
    assert.deepStrictEqual(p.events, ['repo:lock']);
    assert.deepStrictEqual(p.service.listLockedFullNames(p.cfTarget), []);
  });

  test('корень в списке: служебное имя корня не попадает в notLocked, остаётся в lockedObjects/requestedObjects', async () => {
    p.setResult(opLog(LOCK_DONE, lockedLine(C1)));
    const result = await runLockChain(p.services, p.cfTarget, [o.catalog1.ref, p.refs.cfRoot], false, plan(), 'unattended');
    assert.deepStrictEqual(result.requestedObjects, [ROOT_LOCK_CF, C1]);
    assert.deepStrictEqual(result.lockedObjects, [ROOT_LOCK_CF, C1]);
    assert.deepStrictEqual(result.notLocked, []);
  });

  test('цель cfe: два узла расширения — один захват и один импорт расширения', async () => {
    p.setResult(opLog(LOCK_DONE, lockedLine('Справочник.Э33_X'), lockedLine('Справочник.Э33_Y'), receivedLine('Справочник.Э33_X')));
    await runLockChain(p.services, p.cfeTarget, [o.extX.ref, o.extY.ref], false, plan(), 'unattended');
    assert.deepStrictEqual(p.events, ['repo:lock', 'import:cfe:Расш']);
    assert.strictEqual(p.runs.length, 1);
  });

  suite('describeLockNotComplete', () => {
    test('без чужих захватов: имена через запятую, точка в конце', () => {
      assert.strictEqual(describeLockNotComplete([C3, D1], []), 'Захвачены не все объекты: Справочник.Справочник3, Документ.Документ1.');
    });

    test('с чужим захватом: «; захвачено другим пользователем: X (User)»', () => {
      assert.strictEqual(
        describeLockNotComplete([D1], [{ name: D1, user: 'UserB' }]),
        'Захвачены не все объекты: Документ.Документ1; захвачено другим пользователем: Документ.Документ1 (UserB).'
      );
    });

    test('чужой захват без имени пользователя — только имя объекта', () => {
      assert.strictEqual(
        describeLockNotComplete([D1], [{ name: D1, user: '' }]),
        'Захвачены не все объекты: Документ.Документ1; захвачено другим пользователем: Документ.Документ1.'
      );
    });
  });
});

suite('repositoryChains (список): runUpdateChain', () => {
  let p: RepoProject;
  let o: ListObjects;
  const plan = (overrides: Record<string, unknown> = {}) =>
    ({ loadChangesAfterReceive: false, updateDatabaseOnLoad: false, importAfterReceive: true, ...overrides });
  const request = { recursive: false, force: false };

  setup(async () => {
    p = await createRepoProject();
    o = addListObjects(p);
  });
  teardown(() => p.dispose());

  test('два узла: ОДНО получение, одна загрузка после, один импорт; lockedOverwritten и requestedObjects', async () => {
    p.lock([C1]);
    p.setResult(opLog(UPDATE_DONE, receivedLine(C1)));
    const result = await runUpdateChain(
      p.services, p.cfTarget, [o.catalog1.ref, o.catalog3.ref], request,
      plan({ loadChangesAfterReceive: true, updateDatabaseOnLoad: true }), 'unattended'
    );
    assert.deepStrictEqual(p.events, ['repo:update', 'update:cf', 'import:cf']);
    assert.strictEqual(p.runs.length, 1);
    assert.strictEqual(p.updateCalls.length, 1);
    assert.strictEqual(p.importCalls.length, 1);
    assert.strictEqual(result.receivedFromRepository, true);
    assert.strictEqual(result.changesLoadedAfter, true);
    assert.strictEqual(result.projectImported, true);
    assert.deepStrictEqual(result.lockedOverwritten, [C1]);
    assert.deepStrictEqual(result.requestedObjects, [C1, C3]);
    assert.deepStrictEqual(result.warnings, []);
    assert.deepStrictEqual(p.toasts, []);
  });

  test('ничего не получено: lockedOverwritten=[], импорта нет', async () => {
    p.lock([C1, C3]);
    p.setResult(opLog(UPDATE_DONE));
    const result = await runUpdateChain(p.services, p.cfTarget, [o.catalog1.ref, o.catalog3.ref], request, plan(), 'unattended');
    assert.deepStrictEqual(p.events, ['repo:update']);
    assert.strictEqual(result.receivedFromRepository, false);
    assert.deepStrictEqual(result.lockedOverwritten, []);
    assert.deepStrictEqual(result.requestedObjects, [C1, C3]);
  });

  test('сбой загрузки правок после получения: возвращаемый результат тоже несёт lockedOverwritten и requestedObjects', async () => {
    p.lock([C1, C3]);
    p.setResult(opLog(UPDATE_DONE, receivedLine(C1)));
    p.updateResult = false;
    const result = await runUpdateChain(
      p.services, p.cfTarget, [o.catalog1.ref, o.catalog3.ref], request,
      plan({ loadChangesAfterReceive: true, updateDatabaseOnLoad: true }), 'unattended'
    );
    assert.deepStrictEqual(p.events, ['repo:update', 'update:cf']);
    assert.strictEqual(result.changesLoadedAfter, false);
    assert.strictEqual(result.projectImported, false);
    assert.deepStrictEqual(result.lockedOverwritten, [C1]);
    assert.deepStrictEqual(result.requestedObjects, [C1, C3]);
    assert.deepStrictEqual(result.warnings, [describeLoadFailureAfterReceive('Основная')]);
  });

  test('цель cfe: два узла — один импорт расширения', async () => {
    p.setResult(opLog(UPDATE_DONE, receivedLine('Справочник.Э33_X')));
    await runUpdateChain(p.services, p.cfeTarget, [o.extX.ref, o.extY.ref], request, plan(), 'unattended');
    assert.deepStrictEqual(p.events, ['repo:update', 'import:cfe:Расш']);
  });
});

suite('repositoryChains (список): runCommitChain', () => {
  let p: RepoProject;
  let o: ListObjects;
  const plan = (overrides: Record<string, unknown> = {}) => ({ updateDatabaseFirst: false, updateDatabaseOnLoad: false, ...overrides });
  const request = { recursive: false, comment: 'Правка', keepLocked: false, force: false };

  setup(async () => {
    p = await createRepoProject();
    o = addListObjects(p);
  });
  teardown(() => p.dispose());

  test('два узла: одна загрузка до, ОДНО помещение; requestedObjects, notCommitted=[]', async () => {
    p.lock([C1, C3]);
    p.setResult(opLog(COMMIT_DONE, committedLine(C1), unchangedLine(C3)));
    const result = await runCommitChain(
      p.services, p.cfTarget, [o.catalog1.ref, o.catalog3.ref], request,
      plan({ updateDatabaseFirst: true, updateDatabaseOnLoad: true }), 'unattended'
    );
    assert.deepStrictEqual(p.events, ['update:cf', 'repo:commit']);
    assert.strictEqual(p.runs.length, 1);
    assert.strictEqual(p.updateCalls.length, 1);
    assert.deepStrictEqual(result.committedObjects, [C1]);
    assert.deepStrictEqual(result.requestedObjects, [C1, C3]);
    assert.deepStrictEqual(result.notCommitted, []);
    assert.strictEqual(result.databaseLoadedBefore, true);
    assert.strictEqual(result.projectImported, false);
    assert.deepStrictEqual(result.warnings, []);
  });

  test('Э33.4б: Д1 не помещён (платформа молчит) — предупреждение «Не помещены: …», «нечего помещать» нет', async () => {
    p.lock([C1, D1]);
    p.setResult(opLog(COMMIT_DONE, committedLine(C1)));
    const result = await runCommitChain(p.services, p.cfTarget, [o.catalog1.ref, o.document1.ref], request, plan(), 'unattended');
    assert.deepStrictEqual(result.committedObjects, [C1]);
    assert.deepStrictEqual(result.notCommitted, [D1]);
    assert.deepStrictEqual(result.warnings, [
      'Не помещены: Документ.Документ1 — не захвачены вами или захвачены другим пользователем (платформа пропускает такие объекты без ошибки).',
    ]);
  });

  test('ничего не помещено, но есть notCommitted: «нечего помещать» не добавляется (причина уже названа)', async () => {
    p.setResult(opLog(COMMIT_DONE));
    const result = await runCommitChain(p.services, p.cfTarget, [o.document1.ref], request, plan(), 'unattended');
    assert.deepStrictEqual(result.committedObjects, []);
    assert.deepStrictEqual(result.notCommitted, [D1]);
    assert.strictEqual(result.warnings.length, 1);
    assert.ok(result.warnings[0].startsWith('Не помещены: Документ.Документ1'), result.warnings[0]);
  });

  test('только «не был изменен»: прежнее предупреждение «нечего помещать», notCommitted пуст', async () => {
    p.lock([C1]);
    p.setResult(opLog(COMMIT_DONE, unchangedLine(C1)));
    const result = await runCommitChain(p.services, p.cfTarget, o.catalog1.ref, request, plan(), 'unattended');
    assert.deepStrictEqual(result.committedObjects, []);
    assert.deepStrictEqual(result.notCommitted, []);
    assert.deepStrictEqual(result.warnings, [describeNothingToCommit('Справочник1')]);

    p.setResult(opLog(COMMIT_DONE, unchangedLine(C1), unchangedLine(C3)));
    const list = await runCommitChain(p.services, p.cfTarget, [o.catalog1.ref, o.catalog3.ref], request, plan(), 'unattended');
    assert.deepStrictEqual(list.notCommitted, []);
    assert.strictEqual(list.warnings.length, 1);
    assert.ok(list.warnings[0].startsWith('Помещение "') && list.warnings[0].includes('нечего помещать'), list.warnings[0]);
  });

  test('очистка ссылок (force) по-прежнему даёт импорт один раз', async () => {
    p.lock([C1, C3]);
    p.setResult(opLog(COMMIT_DONE, 'Очистка объектов от некорректных ссылок выполнена', committedLine(C1), committedLine(C3)));
    const result = await runCommitChain(
      p.services, p.cfTarget, [o.catalog1.ref, o.catalog3.ref], { ...request, force: true }, plan(), 'unattended'
    );
    assert.deepStrictEqual(p.events, ['repo:commit', 'import:cf']);
    assert.strictEqual(result.referencesCleaned, true);
    assert.strictEqual(result.projectImported, true);
    assert.deepStrictEqual(result.notCommitted, []);
  });
});

suite('repositoryChains (список): runUnlockChain', () => {
  let p: RepoProject;
  let o: ListObjects;

  setup(async () => {
    p = await createRepoProject();
    o = addListObjects(p);
  });
  teardown(() => p.dispose());

  test('два узла: ОДИН запуск; результат', async () => {
    p.lock([C1, C3]);
    p.setResult(opLog(UNLOCK_DONE, cancelledLine(C1), cancelledLine(C3)));
    const result = await runUnlockChain(p.services, p.cfTarget, [o.catalog1.ref, o.catalog3.ref], FORCE_UNLOCK_NOT_USED, 0, 'unattended');
    assert.deepStrictEqual(p.events, ['repo:unlock']);
    assert.strictEqual(p.runs.length, 1);
    assert.deepStrictEqual(result, { unlockedObjects: [C1, C3], lockedByOthers: [], notUnlocked: [], warnings: [] });
  });

  test('незагруженные правки и освобождено: предупреждение о невозможности загрузки по освобождённым', async () => {
    p.lock([C1, C3]);
    p.setResult(opLog(UNLOCK_DONE, cancelledLine(C1), cancelledLine(C3)));
    const result = await runUnlockChain(p.services, p.cfTarget, [o.catalog1.ref, o.catalog3.ref], FORCE_UNLOCK_NOT_USED, 4, 'unattended');
    assert.strictEqual(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes('незагруженных изменённых файлов: 4'), result.warnings[0]);
  });

  test('Э33.3 (несколько объектов): атомарный отказ — RepositoryCliError с текстом describeUnlockBlockedByChanges и прежними title/log/exitCode', async () => {
    p.lock([C1, C3]);
    p.setResult(E33_3_LOG, 1);
    await assert.rejects(
      () => runUnlockChain(p.services, p.cfTarget, [o.catalog1.ref, o.catalog3.ref], FORCE_UNLOCK_NOT_USED, 0, 'unattended'),
      (error: unknown) => {
        assert.ok(error instanceof RepositoryCliError);
        assert.strictEqual(
          error.message,
          'Захват не отменён ни у одного объекта: платформа отменяет захват списка целиком, а изменены в базе: Справочник.Справочник1.'
        );
        assert.strictEqual(error.message, describeUnlockBlockedByChanges([C1], 2));
        assert.strictEqual(error.title, 'Ошибка освобождения объектов "Справочник1 и ещё 1".');
        assert.strictEqual(error.log, E33_3_LOG);
        assert.strictEqual(error.exitCode, 1);
        return true;
      }
    );
    assert.strictEqual(p.service.isLocked(p.cfTarget, C1), true);
    assert.strictEqual(p.service.isLocked(p.cfTarget, C3), true);
  });

  test('Э33.3: несколько изменённых объектов — имена через запятую', async () => {
    p.lock([C1, C3]);
    p.setResult(opLog('Отмена захвата не выполнена', changedLine(C1), changedLine(C3)), 1);
    await assert.rejects(
      () => runUnlockChain(p.services, p.cfTarget, [o.catalog1.ref, o.catalog3.ref], FORCE_UNLOCK_NOT_USED, 0, 'unattended'),
      (error: Error) => error.message ===
        'Захват не отменён ни у одного объекта: платформа отменяет захват списка целиком, а изменены в базе: Справочник.Справочник1, Справочник.Справочник3.'
    );
  });

  test('Э33.3 для одного объекта: «Захват не отменён: объект X изменён в базе.»', async () => {
    p.lock([C1]);
    p.setResult(E33_3_LOG, 1);
    await assert.rejects(
      () => runUnlockChain(p.services, p.cfTarget, o.catalog1.ref, FORCE_UNLOCK_NOT_USED, 0, 'unattended'),
      (error: unknown) => error instanceof RepositoryCliError
        && error.message === 'Захват не отменён: объект Справочник.Справочник1 изменён в базе.'
        && error.exitCode === 1
        && error.log === E33_3_LOG
    );
  });

  test('describeUnlockBlockedByChanges: один запрошенный / несколько запрошенных', () => {
    assert.strictEqual(describeUnlockBlockedByChanges([C1], 1), 'Захват не отменён: объект Справочник.Справочник1 изменён в базе.');
    assert.strictEqual(
      describeUnlockBlockedByChanges([C1], 2),
      'Захват не отменён ни у одного объекта: платформа отменяет захват списка целиком, а изменены в базе: Справочник.Справочник1.'
    );
    assert.strictEqual(
      describeUnlockBlockedByChanges([C1, C3], 3),
      'Захват не отменён ни у одного объекта: платформа отменяет захват списка целиком, а изменены в базе: Справочник.Справочник1, Справочник.Справочник3.'
    );
  });

  test('exit 1 без строк «был изменен»: прежний RepositoryCliError платформы, текст не подменяется', async () => {
    p.lock([C1, C3]);
    p.setResult(opLog('Ошибка освобождения', cancelledLine(C3)), 1);
    await assert.rejects(
      () => runUnlockChain(p.services, p.cfTarget, [o.catalog1.ref, o.catalog3.ref], FORCE_UNLOCK_NOT_USED, 0, 'unattended'),
      (error: unknown) => error instanceof RepositoryCliError
        && error.message.startsWith('Ошибка при освобождении объектов хранилища:')
        && error.exitCode === 1
    );
    assert.strictEqual(p.service.isLocked(p.cfTarget, C3), false, 'частично отпущенное снято по строке «отменен»');
  });

  test('отказ без лога (исполнитель бросил исключение, RepositoryCliError без log): проходит без переписывания', async () => {
    p.lock([C1, C3]);
    const failing = {
      ...p.services,
      createDesignerExecutor: () => ({ run: () => Promise.reject(new Error('сломан')), dispose: () => Promise.resolve() }),
    } as unknown as typeof p.services;
    await assert.rejects(
      () => runUnlockChain(failing, p.cfTarget, [o.catalog1.ref, o.catalog3.ref], FORCE_UNLOCK_NOT_USED, 0, 'unattended'),
      (error: unknown) => error instanceof RepositoryCliError && error.message === 'сломан' && error.log === undefined
    );
    assert.strictEqual(p.service.isLocked(p.cfTarget, C1), true);
  });

  test('прерывание (не RepositoryCliError): пробрасывается как есть', async () => {
    p.lock([C1]);
    p.setResult('', 0, { interrupted: 'Отменено пользователем' });
    await assert.rejects(
      () => runUnlockChain(p.services, p.cfTarget, o.catalog1.ref, FORCE_UNLOCK_NOT_USED, 0, 'unattended'),
      (error: unknown) => error instanceof RepositoryCliInterruptedError && error.message === 'Отменено пользователем'
    );
  });

  test('частичное освобождение (С1 освобождён, Д1 чужой): предупреждение describeUnlockNotDone', async () => {
    p.lock([C1, D1]);
    p.setResult(opLog(UNLOCK_DONE, cancelledLine(C1), foreignLine(D1, 'UserB')));
    const result = await runUnlockChain(p.services, p.cfTarget, [o.catalog1.ref, o.document1.ref], FORCE_UNLOCK_NOT_USED, 0, 'unattended');
    assert.deepStrictEqual(result.unlockedObjects, [C1]);
    assert.deepStrictEqual(result.notUnlocked, [D1]);
    assert.deepStrictEqual(result.lockedByOthers, [{ name: D1, user: 'UserB' }]);
    assert.deepStrictEqual(result.warnings, [describeUnlockNotDone([D1], [{ name: D1, user: 'UserB' }])]);
    assert.strictEqual(result.warnings[0], 'Захват не отменён: Документ.Документ1; захвачено другим пользователем: Документ.Документ1 (UserB)');
  });

  test('частичное освобождение и незагруженные правки: оба предупреждения', async () => {
    p.lock([C1, D1]);
    p.setResult(opLog(UNLOCK_DONE, cancelledLine(C1), foreignLine(D1, 'UserB')));
    const result = await runUnlockChain(p.services, p.cfTarget, [o.catalog1.ref, o.document1.ref], FORCE_UNLOCK_NOT_USED, 2, 'unattended');
    assert.strictEqual(result.warnings.length, 2);
    assert.ok(result.warnings.includes(describeUnlockNotDone([D1], [{ name: D1, user: 'UserB' }])));
    assert.ok(result.warnings.some((w) => w.includes('незагруженных изменённых файлов: 2')));
  });

  test('ничего не освобождено (чужой захват): результат без предупреждения (ошибку «Захват не отменён» формирует вызывающий)', async () => {
    p.lock([D1]);
    p.setResult(opLog(UNLOCK_DONE, foreignLine(D1, 'UserB')));
    const result = await runUnlockChain(p.services, p.cfTarget, [o.document1.ref], FORCE_UNLOCK_NOT_USED, 0, 'unattended');
    assert.deepStrictEqual(result.unlockedObjects, []);
    assert.deepStrictEqual(result.notUnlocked, [D1]);
    assert.deepStrictEqual(result.warnings, []);
  });
});
