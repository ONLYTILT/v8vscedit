import * as assert from 'assert';
import { RepositoryCliError, RepositoryCliInterruptedError } from '../../ui/commands/repository/RepositoryCommandRunner';
import { runCommitChain, runLockChain, runUnlockChain, runUpdateChain } from '../../ui/commands/repository/repositoryChains';
import { describeImportFailureAfterCommit } from '../../ui/commands/repository/repositoryCommitFlow';
import {
  describeImportFailureAfterLock,
  describeProjectBehindAfterLock,
  type RepositoryLockPlan,
} from '../../ui/commands/repository/repositoryLockFlow';
import {
  describeImportFailureAfterReceive,
  describeLoadFailureAfterReceive,
  describeProjectBehindAfterReceive,
  type RepositoryUpdatePlan,
} from '../../ui/commands/repository/repositoryUpdateFlow';
import {
  COMMIT_DONE, LOCK_DONE, ROOT_LOCK_CF, UNLOCK_DONE, UPDATE_DONE, createRepoProject, opLog, operationTail, type RepoProject,
} from './support/repositoryMcpFixtures';

/**
 * Цепочки операций хранилища (`ui/commands/repository/repositoryChains.ts`): ОДИН код для UI-команд и
 * MCP-инструментов. Решённый план → структурный результат с `warnings`; тостов нет (их показывает
 * вызывающий UI), замок берёт вызывающий. Порядок шагов UI сохраняется. Техника —
 * `repositoryUpdateCommand.test.ts`: настоящие RepositoryService/env.json, журнал `events`.
 */

const T = 'Справочник.Товары';
const RECEIVED = opLog(LOCK_DONE, `Объект захвачен для редактирования: ${T}`, `Объект получен из хранилища: ${T}`);
const NOT_RECEIVED = opLog(LOCK_DONE, `Объект захвачен для редактирования: ${T}`);

suite('repositoryChains: runLockChain', () => {
  let p: RepoProject;
  const plan = (overrides: Partial<RepositoryLockPlan> = {}): RepositoryLockPlan =>
    ({ revised: true, updateDatabaseFirst: false, updateDatabaseOnLoad: false, importAfterLock: true, ...overrides });

  setup(async () => { p = await createRepoProject(); });
  teardown(() => p.dispose());

  test('захват получил версии: захват → импорт cf; учёт, чистота проекта, перезагрузка дерева; результат и вектор', async () => {
    p.setResult(RECEIVED);
    const result = await runLockChain(p.services, p.cfTarget, p.refs.catalog, false, plan());

    assert.deepStrictEqual(p.events, ['repo:lock', 'import:cf']);
    assert.deepStrictEqual(result, {
      lockedObjects: [T], requestedObjects: [T], receivedFromRepository: true,
      databaseLoadedBefore: false, projectImported: true, projectBehind: false, warnings: [],
      databaseConfigurationUpdated: false, databaseConfigurationBehind: true,
    });
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
    assert.deepStrictEqual(p.cleaned, [[p.cfRoot]]);
    assert.strictEqual(p.reloads, 1);
    assert.deepStrictEqual(p.toasts, [], 'цепочка не показывает тостов');
    const tail = operationTail(p.args());
    assert.strictEqual(tail[0], '/ConfigurationRepositoryLock');
    assert.strictEqual(tail[1], '-Objects');
    assert.strictEqual(tail[tail.length - 1], '-revised');
  });

  test('revised=false: ключа -revised в векторе нет', async () => {
    p.setResult(NOT_RECEIVED);
    await runLockChain(p.services, p.cfTarget, p.refs.catalog, false, plan({ revised: false }));
    assert.ok(!operationTail(p.args()).includes('-revised'));
  });

  test('захват без новых версий: импорта нет, проект не отстаёт, предупреждений нет', async () => {
    p.setResult(NOT_RECEIVED);
    const result = await runLockChain(p.services, p.cfTarget, p.refs.catalog, false, plan());
    assert.deepStrictEqual(p.events, ['repo:lock']);
    assert.strictEqual(result.receivedFromRepository, false);
    assert.strictEqual(result.projectImported, false);
    assert.strictEqual(result.projectBehind, false);
    assert.deepStrictEqual(result.warnings, []);
    assert.deepStrictEqual(p.cleaned, []);
  });

  test('цель cfe: импорт расширения с его именем, вектор оканчивается -Extension <имя>', async () => {
    p.setResult(RECEIVED);
    await runLockChain(p.services, p.cfeTarget, p.refs.cfeCatalog, false, plan());
    assert.deepStrictEqual(p.events, ['repo:lock', 'import:cfe:Расш']);
    assert.deepStrictEqual(p.cleaned, [[p.cfeRoot]]);
    assert.deepStrictEqual(p.args().slice(-2), ['-Extension', 'Расш']);
  });

  test('updateDatabaseFirst: загрузка правок → захват → импорт, databaseLoadedBefore=true', async () => {
    p.setResult(RECEIVED);
    const result = await runLockChain(p.services, p.cfTarget, p.refs.catalog, false, plan({ updateDatabaseFirst: true, updateDatabaseOnLoad: true }));
    assert.deepStrictEqual(p.events, ['update:cf', 'repo:lock', 'import:cf']);
    assert.strictEqual(result.databaseLoadedBefore, true);
    assert.deepStrictEqual(p.cleaned, [[p.cfRoot], [p.cfRoot]]);
  });

  test('сбой загрузки перед захватом: ошибка с точным текстом, захват не запускался, учёт не тронут', async () => {
    p.updateResult = false;
    await assert.rejects(
      () => runLockChain(p.services, p.cfTarget, p.refs.catalog, false, plan({ updateDatabaseFirst: true, updateDatabaseOnLoad: true })),
      (error: Error) => error.message === 'Загрузка правок проекта в базу не выполнена; захват не выполнялся. Подробности — в журнале «1С Редактор».'
    );
    assert.deepStrictEqual(p.events, ['update:cf']);
    assert.strictEqual(p.runs.length, 0);
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), false);
  });

  test('importAfterLock=false (keepProjectBehind) и версии получены: импорта нет, projectBehind=true, предупреждение describeProjectBehindAfterLock', async () => {
    p.setResult(RECEIVED);
    const result = await runLockChain(
      p.services, p.cfTarget, p.refs.catalog, false, plan({ revised: false, importAfterLock: false })
    );
    assert.deepStrictEqual(p.events, ['repo:lock']);
    assert.strictEqual(result.projectBehind, true);
    assert.strictEqual(result.projectImported, false);
    assert.deepStrictEqual(result.warnings, [describeProjectBehindAfterLock('Основная')]);
  });

  test('сбой импорта: не исключение — предупреждение describeImportFailureAfterLock, projectImported=false, projectBehind=true, проект не помечен чистым', async () => {
    p.setResult(RECEIVED);
    p.importResult = false;
    const result = await runLockChain(p.services, p.cfTarget, p.refs.catalog, false, plan());
    assert.deepStrictEqual(p.events, ['repo:lock', 'import:cf']);
    assert.strictEqual(result.projectImported, false);
    assert.strictEqual(result.projectBehind, true);
    assert.deepStrictEqual(result.warnings, [describeImportFailureAfterLock('Основная')]);
    assert.deepStrictEqual(p.cleaned, []);
    assert.deepStrictEqual(p.toasts, []);
  });

  test('exit≠0: RepositoryCliError, импорта нет, учёт не тронут', async () => {
    p.setResult('нет доступа', 1);
    await assert.rejects(() => runLockChain(p.services, p.cfTarget, p.refs.catalog, false, plan()), RepositoryCliError);
    assert.deepStrictEqual(p.events, ['repo:lock']);
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), false);
  });

  test('прерывание: RepositoryCliInterruptedError пробрасывается, импорта нет', async () => {
    p.setResult('', 0, { interrupted: 'Отменено пользователем' });
    await assert.rejects(() => runLockChain(p.services, p.cfTarget, p.refs.catalog, false, plan()), RepositoryCliInterruptedError);
    assert.deepStrictEqual(p.events, ['repo:lock']);
  });

  test('рекурсивный захват корня: выборка с includeChildObjects="true", requestedObjects — служебное имя корня', async () => {
    p.setResult(opLog(LOCK_DONE));
    const result = await runLockChain(p.services, p.cfTarget, p.refs.cfRoot, true, plan());
    assert.deepStrictEqual(result.requestedObjects, [ROOT_LOCK_CF]);
    assert.deepStrictEqual(result.lockedObjects, [ROOT_LOCK_CF], 'служебное имя корня не отфильтровывается логом');
    const objects = operationTail(p.args())[2] as { content: string };
    assert.ok(objects.content.includes('includeChildObjects="true"'), objects.content);
  });
});

suite('repositoryChains: runUpdateChain', () => {
  let p: RepoProject;
  const plan = (overrides: Partial<RepositoryUpdatePlan> = {}): RepositoryUpdatePlan =>
    ({ loadChangesAfterReceive: false, updateDatabaseOnLoad: false, importAfterReceive: true, ...overrides });
  const request = { recursive: false, force: false };
  const GOT = opLog(UPDATE_DONE, `Объект получен из хранилища: ${T}`);
  const NOTHING = opLog(UPDATE_DONE);

  setup(async () => { p = await createRepoProject(); });
  teardown(() => p.dispose());

  test('получено: получение → импорт cf; результат; тостов нет; вектор без -force и -v', async () => {
    p.setResult(GOT);
    const result = await runUpdateChain(p.services, p.cfTarget, p.refs.catalog, request, plan());
    assert.deepStrictEqual(p.events, ['repo:update', 'import:cf']);
    assert.deepStrictEqual(result, {
      receivedFromRepository: true, changesLoadedAfter: false, projectImported: true, projectBehind: false, warnings: [],
      databaseConfigurationUpdated: false, databaseConfigurationBehind: true,
    });
    assert.deepStrictEqual(p.toasts, []);
    const tail = operationTail(p.args());
    assert.strictEqual(tail[0], '/ConfigurationRepositoryUpdateCfg');
    assert.ok(!tail.includes('-force') && !tail.includes('-v'));
    assert.deepStrictEqual(p.cleaned, [[p.cfRoot]]);
  });

  test('версия и force попадают в вектор в порядке -Objects, -v, -force', async () => {
    p.setResult(GOT);
    await runUpdateChain(p.services, p.cfTarget, p.refs.catalog, { recursive: false, force: true, version: '5' }, plan());
    const tail = operationTail(p.args());
    assert.deepStrictEqual([tail[0], tail[1], tail[3], tail[4], tail[5]], ['/ConfigurationRepositoryUpdateCfg', '-Objects', '-v', '5', '-force']);
  });

  test('receive-then-load: получение → загрузка правок → импорт (Э24), changesLoadedAfter=true, всё без тостов', async () => {
    p.setResult(GOT);
    const result = await runUpdateChain(p.services, p.cfTarget, p.refs.catalog, request, plan({ loadChangesAfterReceive: true, updateDatabaseOnLoad: true }));
    assert.deepStrictEqual(p.events, ['repo:update', 'update:cf', 'import:cf']);
    assert.strictEqual(result.changesLoadedAfter, true);
    assert.deepStrictEqual(result.warnings, []);
    assert.deepStrictEqual(p.cleaned, [[p.cfRoot], [p.cfRoot]]);
  });

  test('receive-then-load, цель cfe', async () => {
    p.setResult(GOT);
    await runUpdateChain(p.services, p.cfeTarget, p.refs.cfeCatalog, request, plan({ loadChangesAfterReceive: true, updateDatabaseOnLoad: true }));
    assert.deepStrictEqual(p.events, ['repo:update', 'update:cfe:Расш', 'import:cfe:Расш']);
  });

  test('сбой загрузки правок ПОСЛЕ получения — успех с предупреждением, импорта нет (перезаписал бы правки), projectBehind=true', async () => {
    p.setResult(GOT);
    p.updateResult = false;
    const result = await runUpdateChain(p.services, p.cfTarget, p.refs.catalog, request, plan({ loadChangesAfterReceive: true, updateDatabaseOnLoad: true }));
    assert.deepStrictEqual(p.events, ['repo:update', 'update:cf']);
    assert.deepStrictEqual(result, {
      receivedFromRepository: true, changesLoadedAfter: false, projectImported: false, projectBehind: true,
      warnings: [describeLoadFailureAfterReceive('Основная')],
      databaseConfigurationUpdated: false, databaseConfigurationBehind: true,
    });
    assert.deepStrictEqual(p.cleaned, []);
  });

  test('receive-without-import и версии получены: проект отстаёт, предупреждение describeProjectBehindAfterReceive', async () => {
    p.setResult(GOT);
    const result = await runUpdateChain(
      p.services, p.cfTarget, p.refs.catalog, request, plan({ importAfterReceive: false })
    );
    assert.deepStrictEqual(p.events, ['repo:update']);
    assert.strictEqual(result.projectBehind, true);
    assert.deepStrictEqual(result.warnings, [describeProjectBehindAfterReceive('Основная')]);
  });

  test('receive-without-import, ничего не получено: ни импорта, ни предупреждений, projectBehind=false', async () => {
    p.setResult(NOTHING);
    const result = await runUpdateChain(
      p.services, p.cfTarget, p.refs.catalog, request, plan({ importAfterReceive: false })
    );
    assert.deepStrictEqual(p.events, ['repo:update']);
    assert.deepStrictEqual([result.projectBehind, result.warnings], [false, []]);
  });

  test('импорт разрешён, но ничего не получено: импорта нет, receivedFromRepository=false', async () => {
    p.setResult(NOTHING);
    const result = await runUpdateChain(p.services, p.cfTarget, p.refs.catalog, request, plan());
    assert.deepStrictEqual(p.events, ['repo:update']);
    assert.deepStrictEqual(
      [result.receivedFromRepository, result.projectImported, result.projectBehind],
      [false, false, false]
    );
  });

  test('сбой импорта: предупреждение describeImportFailureAfterReceive, projectImported=false, projectBehind=true', async () => {
    p.setResult(GOT);
    p.importResult = false;
    const result = await runUpdateChain(p.services, p.cfTarget, p.refs.catalog, request, plan());
    assert.deepStrictEqual(result.warnings, [describeImportFailureAfterReceive('Основная')]);
    assert.strictEqual(result.projectImported, false);
    assert.strictEqual(result.projectBehind, true);
  });

  test('exit≠0: RepositoryCliError, загрузки и импорта нет', async () => {
    p.setResult('нет доступа', 1);
    await assert.rejects(
      () => runUpdateChain(p.services, p.cfTarget, p.refs.catalog, request, plan({ loadChangesAfterReceive: true, updateDatabaseOnLoad: true })),
      RepositoryCliError
    );
    assert.deepStrictEqual(p.events, ['repo:update']);
  });
});

suite('repositoryChains: runCommitChain', () => {
  let p: RepoProject;
  const request = { recursive: false, comment: 'Правка', keepLocked: false, force: false };
  const COMMITTED = opLog(COMMIT_DONE, `Объект помещен в хранилище: ${T}`);
  const CLEANED = opLog(COMMIT_DONE, 'Очистка объектов от некорректных ссылок выполнена', `Объект помещен в хранилище: ${T}`);

  setup(async () => { p = await createRepoProject(); p.lock([T]); });
  teardown(() => p.dispose());

  test('чистый проект: помещение, учёт снят, результат; импорта нет; вектор -Objects … -comment', async () => {
    p.setResult(COMMITTED);
    const result = await runCommitChain(p.services, p.cfTarget, p.refs.catalog, request, { updateDatabaseFirst: false, updateDatabaseOnLoad: false });
    assert.deepStrictEqual(p.events, ['repo:commit']);
    assert.deepStrictEqual(result, {
      committedObjects: [T], keptLocked: false, referencesCleaned: false,
      databaseLoadedBefore: false, projectImported: false, warnings: [],
      databaseConfigurationUpdated: false, databaseConfigurationBehind: false,
    });
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), false);
    assert.deepStrictEqual(p.toasts, []);
    const tail = operationTail(p.args());
    assert.deepStrictEqual([tail[0], tail[1], tail[3], tail[4]], ['/ConfigurationRepositoryCommit', '-Objects', '-comment', 'Правка']);
    assert.strictEqual(tail.length, 5);
  });

  test('updateDatabaseFirst: загрузка → помещение (под одним вызовом), databaseLoadedBefore=true', async () => {
    p.setResult(COMMITTED);
    const result = await runCommitChain(p.services, p.cfTarget, p.refs.catalog, request, { updateDatabaseFirst: true, updateDatabaseOnLoad: true });
    assert.deepStrictEqual(p.events, ['update:cf', 'repo:commit']);
    assert.strictEqual(result.databaseLoadedBefore, true);
  });

  test('сбой загрузки перед помещением: ошибка с точным текстом, помещение не запускалось, захват остаётся', async () => {
    p.updateResult = false;
    await assert.rejects(
      () => runCommitChain(p.services, p.cfTarget, p.refs.catalog, request, { updateDatabaseFirst: true, updateDatabaseOnLoad: true }),
      (error: Error) => error.message === 'Загрузка правок проекта в базу не выполнена; помещение не выполнялось. Подробности — в журнале «1С Редактор».'
    );
    assert.strictEqual(p.runs.length, 0);
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
  });

  test('keepLocked: захват сохраняется, keptLocked=true, -keepLocked в векторе; -force только при force', async () => {
    p.setResult(COMMITTED);
    const result = await runCommitChain(
      p.services, p.cfTarget, p.refs.catalog, { ...request, keepLocked: true, force: true }, { updateDatabaseFirst: false, updateDatabaseOnLoad: false }
    );
    assert.strictEqual(result.keptLocked, true);
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
    const tail = operationTail(p.args());
    assert.deepStrictEqual(tail.slice(-2), ['-keepLocked', '-force']);
  });

  test('очистка ссылок (-force, Э25): база помещающего изменена → ОБЯЗАТЕЛЬНЫЙ импорт cf, referencesCleaned=true, projectImported=true', async () => {
    p.setResult(CLEANED);
    const result = await runCommitChain(
      p.services, p.cfTarget, p.refs.catalog, { ...request, force: true }, { updateDatabaseFirst: false, updateDatabaseOnLoad: false }
    );
    assert.deepStrictEqual(p.events, ['repo:commit', 'import:cf']);
    assert.strictEqual(result.referencesCleaned, true);
    assert.strictEqual(result.projectImported, true);
    assert.deepStrictEqual(p.cleaned, [[p.cfRoot]]);
    assert.strictEqual(p.reloads, 1);
  });

  test('очистка ссылок, цель cfe: импорт расширения', async () => {
    p.lock([T], p.cfeTarget);
    p.setResult(CLEANED);
    await runCommitChain(p.services, p.cfeTarget, p.refs.cfeCatalog, { ...request, force: true }, { updateDatabaseFirst: false, updateDatabaseOnLoad: false });
    assert.deepStrictEqual(p.events, ['repo:commit', 'import:cfe:Расш']);
  });

  test('очистка ссылок и сбой импорта: предупреждение describeImportFailureAfterCommit, projectImported=false, помещение остаётся успешным', async () => {
    p.setResult(CLEANED);
    p.importResult = false;
    const result = await runCommitChain(
      p.services, p.cfTarget, p.refs.catalog, { ...request, force: true }, { updateDatabaseFirst: false, updateDatabaseOnLoad: false }
    );
    assert.strictEqual(result.projectImported, false);
    assert.deepStrictEqual(result.warnings, [describeImportFailureAfterCommit('Основная')]);
    assert.deepStrictEqual(result.committedObjects, [T]);
    assert.deepStrictEqual(p.cleaned, []);
  });

  test('помещение без правок (все «не был изменен»): успех, committedObjects пуст, предупреждение «нечего помещать»', async () => {
    p.setResult(opLog(COMMIT_DONE, `Объект не был изменен: ${T}`));
    const result = await runCommitChain(p.services, p.cfTarget, p.refs.catalog, request, { updateDatabaseFirst: false, updateDatabaseOnLoad: false });
    assert.deepStrictEqual(result.committedObjects, []);
    assert.strictEqual(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes('нечего помещать'), result.warnings[0]);
    assert.deepStrictEqual(p.events, ['repo:commit']);
  });

  test('лог не распознан: committedObjects — все запрошенные, предупреждения «нечего помещать» нет, импорта нет', async () => {
    p.setResult('');
    const result = await runCommitChain(p.services, p.cfTarget, p.refs.catalog, request, { updateDatabaseFirst: false, updateDatabaseOnLoad: false });
    assert.deepStrictEqual(result.committedObjects, [T]);
    assert.deepStrictEqual(result.warnings, []);
    assert.deepStrictEqual(p.events, ['repo:commit']);
  });

  test('exit≠0: RepositoryCliError, импорта нет, захват остаётся', async () => {
    p.setResult('Объект содержит ссылки на удаленные объекты', 1);
    await assert.rejects(
      () => runCommitChain(p.services, p.cfTarget, p.refs.catalog, request, { updateDatabaseFirst: false, updateDatabaseOnLoad: false }),
      RepositoryCliError
    );
    assert.deepStrictEqual(p.events, ['repo:commit']);
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
  });
});

suite('repositoryChains: runUnlockChain', () => {
  let p: RepoProject;
  const FOREIGN = 'Объект захвачен для редактирования другим пользователем: ';
  const request = { recursive: false, force: false };
  const PHRASE = 'после отмены захвата загрузить их в базу по освобождённым объектам будет нельзя';

  setup(async () => { p = await createRepoProject(); p.lock([T]); });
  teardown(() => p.dispose());

  test('освобождено: результат, учёт снят, проект чист — предупреждений нет; вектор без -force', async () => {
    p.setResult(opLog(UNLOCK_DONE, `Захват объекта отменен: ${T}`));
    const result = await runUnlockChain(p.services, p.cfTarget, p.refs.catalog, request, 0);
    assert.deepStrictEqual(result, { unlockedObjects: [T], lockedByOthers: [], notUnlocked: [], warnings: [] });
    assert.deepStrictEqual(p.events, ['repo:unlock']);
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), false);
    assert.deepStrictEqual(operationTail(p.args()).filter((arg) => arg === '-force'), []);
    assert.deepStrictEqual(p.toasts, []);
  });

  test('незагруженные правки проекта и освобождено что-то: предупреждение, что загрузить их по освобождённым объектам будет нельзя', async () => {
    p.setResult(opLog(UNLOCK_DONE, `Захват объекта отменен: ${T}`));
    const result = await runUnlockChain(p.services, p.cfTarget, p.refs.catalog, request, 3);
    assert.ok(result.warnings.some((warning) => warning.includes(PHRASE)), result.warnings.join('|'));
  });

  test('чужой захват: НЕ исключение — структура {unlockedObjects:[], lockedByOthers, notUnlocked}; учёт остаётся', async () => {
    p.setResult(opLog(UNLOCK_DONE, `${FOREIGN}${T} (Иванов) `));
    const result = await runUnlockChain(p.services, p.cfTarget, p.refs.catalog, request, 0);
    assert.deepStrictEqual(result.unlockedObjects, []);
    assert.deepStrictEqual(result.lockedByOthers, [{ name: T, user: 'Иванов' }]);
    assert.deepStrictEqual(result.notUnlocked, [T]);
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
  });

  test('force=true доходит до вектора (UI открывает force, MCP — нет)', async () => {
    p.setResult('');
    await runUnlockChain(p.services, p.cfTarget, p.refs.catalog, { recursive: false, force: true }, 0);
    assert.ok(operationTail(p.args()).includes('-force'));
  });

  test('exit≠0 со строкой «отменен»: RepositoryCliError, учёт по строкам лога всё равно применён', async () => {
    p.lock(['Справочник.Склады']);
    p.setResult(opLog('Ошибка', 'Захват объекта отменен: Справочник.Склады'), 1);
    await assert.rejects(
      () => runUnlockChain(p.services, p.cfTarget, p.refs.catalog, request, 0),
      RepositoryCliError
    );
    assert.strictEqual(p.service.isLocked(p.cfTarget, 'Справочник.Склады'), false);
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
  });
});
