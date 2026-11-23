import * as assert from 'assert';
import type { RepositoryNodeSelection } from '../../infra/repository/RepositoryObjectsSelection';
import type { RepositoryNodeRef } from '../../infra/repository/RepositoryService';
import {
  RepositoryCliError,
  RepositoryCliInterruptedError,
  executeRepositoryCommitAction,
  executeRepositoryLockAction,
  executeRepositoryUnlockAction,
  executeRepositoryUpdateAction,
} from '../../ui/commands/repository/RepositoryCommandRunner';
import type { RepositoryCliServices } from '../../ui/commands/repository/RepositoryCommandRunner';
import { createRepoProject, type RepoProject, ROOT_LOCK_CF } from './support/repositoryMcpFixtures';
import {
  C1, C3, D1, EXT_X, EXT_Y,
  COMMIT_DONE, E33_1_LOG, E33_1_RECEIVED_LOG, E33_3_LOG, LOCK_DONE, UNLOCK_DONE, UPDATE_DONE,
  addListObjects, cancelledLine, committedLine, foreignLine, lockedLine, notLockedLine, opLog, receivedLine, unchangedLine,
  type ListObjects,
} from './support/repositoryListFixtures';

/**
 * Раннер хранилища со списком узлов (docs/plans/mcp-repository-paths-plan.md §1.5, тесты §4.C): параметр `node`
 * `execute*Action` принимает `RepositoryNodeSelection` (узел или список) — несколько узлов дают ОДИН запуск
 * Конфигуратора с единым `objects.xml`. Логи фейкового исполнителя 1cv8 — дословно из Э33 (§2 плана).
 * Подменяется только исполнитель (шов `createDesignerExecutor` из `createRepoProject`).
 */

const NS = 'http://v8.1c.ru/8.3/config/objects';
const listXml = (...fullNames: string[]): string => [
  `<Objects xmlns="${NS}" version="1.0">`,
  ...fullNames.flatMap((name) => [`  <Object fullName="${name}" includeChildObjects="false">`, '  </Object>']),
  '</Objects>',
  '',
].join('\n');

type Invoke = (services: RepositoryCliServices, selection: RepositoryNodeSelection) => Promise<unknown>;

interface KindCase {
  readonly kind: 'lock' | 'unlock' | 'commit' | 'update';
  readonly operationMarker: string;
  readonly done: string;
  readonly errorTitle: (label: string) => string;
  readonly invoke: Invoke;
  /** Аргументы вектора после `-Objects <файл>` (без `-Extension`). */
  readonly rest: readonly string[];
}

const KINDS: readonly KindCase[] = [
  {
    kind: 'lock', operationMarker: '/ConfigurationRepositoryLock', done: LOCK_DONE,
    errorTitle: (label) => `Ошибка захвата объектов "${label}".`,
    invoke: (services, selection) => executeRepositoryLockAction(services, selection, false, { revised: false }),
    rest: [],
  },
  {
    kind: 'unlock', operationMarker: '/ConfigurationRepositoryUnLock', done: UNLOCK_DONE,
    errorTitle: (label) => `Ошибка освобождения объектов "${label}".`,
    invoke: (services, selection) => executeRepositoryUnlockAction(services, selection, false, false),
    rest: [],
  },
  {
    kind: 'commit', operationMarker: '/ConfigurationRepositoryCommit', done: COMMIT_DONE,
    errorTitle: (label) => `Ошибка помещения "${label}" в хранилище.`,
    invoke: (services, selection) =>
      executeRepositoryCommitAction(services, selection, { recursive: false, comment: 'Правка', keepLocked: false, force: false }),
    rest: ['-comment', 'Правка'],
  },
  {
    kind: 'update', operationMarker: '/ConfigurationRepositoryUpdateCfg', done: UPDATE_DONE,
    errorTitle: (label) => `Ошибка получения "${label}" из хранилища.`,
    invoke: (services, selection) => executeRepositoryUpdateAction(services, selection, { recursive: false, force: false }),
    rest: [],
  },
];

function tailOf(args: readonly unknown[], marker: string): unknown[] {
  const index = args.indexOf(marker);
  assert.ok(index >= 0, `в векторе нет ${marker}`);
  return args.slice(index);
}

suite('execute*Action со списком узлов: один запуск, единый objects.xml', () => {
  let p: RepoProject;
  let o: ListObjects;
  const services = (): RepositoryCliServices => p.services;

  setup(async () => {
    p = await createRepoProject();
    o = addListObjects(p);
  });
  teardown(() => p.dispose());

  for (const k of KINDS) {
    suite(k.kind, () => {
      test('два узла дают ОДИН запуск; вектор поэлементно как у одиночного, -Objects — эталон списка', async () => {
        p.setResult(opLog(k.done));
        await k.invoke(services(), o.catalog1.ref);
        await k.invoke(services(), [o.catalog1.ref, o.catalog3.ref]);

        assert.strictEqual(p.runs.length, 2, 'каждый вызов — один запуск (а не по запуску на узел)');
        const single = tailOf(p.runs[0].args, k.operationMarker);
        const list = tailOf(p.runs[1].args, k.operationMarker);
        assert.deepStrictEqual(single.slice(0, 2), [k.operationMarker, '-Objects']);
        assert.deepStrictEqual(list.slice(0, 2), [k.operationMarker, '-Objects']);
        assert.deepStrictEqual(list.slice(3), single.slice(3), 'остальной вектор не зависит от числа узлов');
        assert.deepStrictEqual(list.slice(3), k.rest);
        assert.deepStrictEqual(list[2], { kind: 'inputFile', name: 'objects.xml', content: listXml(C1, C3) });
        assert.deepStrictEqual(single[2], { kind: 'inputFile', name: 'objects.xml', content: listXml(C1) });
      });

      test('реквизит и его владелец в списке — один объект в выборке', async () => {
        p.setResult(opLog(k.done));
        await k.invoke(services(), [o.catalog1Child.ref, o.catalog1.ref]);
        assert.deepStrictEqual(tailOf(p.runs[0].args, k.operationMarker)[2], {
          kind: 'inputFile', name: 'objects.xml', content: listXml(C1),
        });
      });

      test('подпись в errorTitle: один узел — прежняя (подпись узла), узел без подписи — имя цели', async () => {
        p.setResult('Нет доступа', 1);
        await assert.rejects(
          () => k.invoke(services(), o.catalog1.ref),
          (error: unknown) => error instanceof RepositoryCliError && error.title === k.errorTitle('Справочник1')
        );
        const unlabeled: RepositoryNodeRef = { nodeKind: o.catalog1.ref.nodeKind, xmlPath: o.catalog1.ref.xmlPath };
        await assert.rejects(
          () => k.invoke(services(), unlabeled),
          (error: unknown) => error instanceof RepositoryCliError && error.title === k.errorTitle(p.cfTarget.displayName)
        );
      });

      test('подпись в errorTitle: несколько узлов — «<подпись первого> и ещё N»', async () => {
        p.setResult('Нет доступа', 1);
        await assert.rejects(
          () => k.invoke(services(), [o.catalog1.ref, o.catalog3.ref]),
          (error: unknown) => error instanceof RepositoryCliError && error.title === k.errorTitle('Справочник1 и ещё 1')
        );
        await assert.rejects(
          () => k.invoke(services(), [o.catalog3.ref, o.catalog1.ref, o.document1.ref]),
          (error: unknown) => error instanceof RepositoryCliError && error.title === k.errorTitle('Справочник3 и ещё 2')
        );
      });

      test('узлы разных конфигураций (cf + cfe): отказ до запуска', async () => {
        await assert.rejects(
          () => k.invoke(services(), [o.catalog1.ref, o.extX.ref]),
          /разным конфигурациям хранилища/
        );
        assert.strictEqual(p.runs.length, 0);
        assert.strictEqual(p.disposedExecutors, 0);
      });

      test('цель cfe: два узла расширения — один запуск, вектор оканчивается -Extension Расш', async () => {
        p.setResult(opLog(k.done));
        await k.invoke(services(), [o.extX.ref, o.extY.ref]);
        assert.strictEqual(p.runs.length, 1);
        const tail = tailOf(p.runs[0].args, k.operationMarker);
        assert.deepStrictEqual(tail.slice(-2), ['-Extension', 'Расш']);
        assert.deepStrictEqual((tail[2] as { content: string }).content, listXml(EXT_X, EXT_Y));
      });
    });
  }
});

suite('executeRepositoryLockAction: список, частичный захват (Э33.1, Э33.(а))', () => {
  let p: RepoProject;
  let o: ListObjects;
  const services = (): RepositoryCliServices => p.services;
  const lock = (selection: RepositoryNodeSelection) => executeRepositoryLockAction(services(), selection, false, { revised: false });

  setup(async () => {
    p = await createRepoProject();
    o = addListObjects(p);
  });
  teardown(() => p.dispose());

  test('Э33.(а), exit 0: X уже захвачен этим пользователем, строки о нём нет — не теряется в учёте', async () => {
    p.lock([C1]);
    p.setResult(opLog(LOCK_DONE, lockedLine(C3)));
    const outcome = await lock([o.catalog1.ref, o.catalog3.ref]);
    assert.deepStrictEqual(outcome.lockedFullNames, [C1, C3]);
    assert.deepStrictEqual(outcome.lockedByOthers, []);
    assert.strictEqual(outcome.receivedFromRepository, false);
    assert.strictEqual(outcome.platformFailure, undefined);
    assert.strictEqual(p.service.isLocked(p.cfTarget, C1), true);
    assert.strictEqual(p.service.isLocked(p.cfTarget, C3), true);
  });

  test('exit 0: чужой захват без исключения попадает в lockedByOthers, объект не отмечен', async () => {
    p.setResult(opLog(LOCK_DONE, lockedLine(C1), foreignLine(D1, 'UserB')));
    const outcome = await lock([o.catalog1.ref, o.document1.ref]);
    assert.deepStrictEqual(outcome.lockedFullNames, [C1]);
    assert.deepStrictEqual(outcome.lockedByOthers, [{ name: D1, user: 'UserB' }]);
    assert.strictEqual(p.service.isLocked(p.cfTarget, D1), false);
  });

  test('Э33.1, exit 1 с логом С1/С3 захвачены, Д1 у UserB: частичный исход с platformFailure, учёт записан, исключения нет', async () => {
    p.setResult(E33_1_LOG, 1);
    const outcome = await lock([o.catalog1.ref, o.catalog3.ref, o.document1.ref]);
    assert.deepStrictEqual(outcome.lockedFullNames, [C1, C3]);
    assert.deepStrictEqual(outcome.lockedByOthers, [{ name: D1, user: 'UserB' }]);
    assert.strictEqual(typeof outcome.platformFailure, 'string');
    assert.ok(outcome.platformFailure?.startsWith('Ошибка при захвате объектов хранилища:'), outcome.platformFailure);
    assert.strictEqual(outcome.receivedFromRepository, false, 'в логе нет строк «получен» — версий нет');
    assert.strictEqual(p.service.isLocked(p.cfTarget, C1), true);
    assert.strictEqual(p.service.isLocked(p.cfTarget, C3), true);
    assert.strictEqual(p.service.isLocked(p.cfTarget, D1), false);
    assert.deepStrictEqual(p.toasts, []);
    assert.strictEqual(p.disposedExecutors, 1);
  });

  test('Э33.1, корень в выборке и его НЕ было в учёте: при отказе корень не отмечается захваченным, объекты по логу — отмечены', async () => {
    p.setResult(E33_1_LOG, 1);
    const outcome = await lock([p.refs.cfRoot, o.catalog1.ref, o.catalog3.ref, o.document1.ref]);
    assert.deepStrictEqual(outcome.lockedFullNames, [C1, C3]);
    assert.ok(outcome.platformFailure);
    assert.strictEqual(p.service.isLocked(p.cfTarget, ROOT_LOCK_CF), false);
    assert.strictEqual(p.service.isLocked(p.cfTarget, C1), true);
    assert.strictEqual(p.service.isLocked(p.cfTarget, C3), true);
  });

  test('Э33.1, корень в выборке и УЖЕ был в учёте: остаётся захваченным', async () => {
    p.lock([ROOT_LOCK_CF]);
    p.setResult(E33_1_LOG, 1);
    const outcome = await lock([p.refs.cfRoot, o.catalog1.ref, o.catalog3.ref, o.document1.ref]);
    assert.deepStrictEqual(outcome.lockedFullNames, [ROOT_LOCK_CF, C1, C3]);
    assert.ok(outcome.platformFailure);
    assert.strictEqual(p.service.isLocked(p.cfTarget, ROOT_LOCK_CF), true);
    assert.strictEqual(p.service.isLocked(p.cfTarget, C1), true);
  });

  test('Э33.1 с полученными версиями: receivedFromRepository=true по тому же логу (проект иначе молча отстал бы)', async () => {
    p.setResult(E33_1_RECEIVED_LOG, 1);
    const outcome = await lock([o.catalog1.ref, o.catalog3.ref, o.document1.ref]);
    assert.strictEqual(outcome.receivedFromRepository, true);
    assert.deepStrictEqual(outcome.lockedFullNames, [C1, C3]);
    assert.ok(outcome.platformFailure);
  });

  test('exit 1, по логу ничего НОВОГО не захвачено (уже захваченный не считается): исключение, учёт не тронут', async () => {
    p.lock([C1]);
    p.setResult(opLog('Захват объектов не выполнен', foreignLine(D1, 'UserB')), 1);
    await assert.rejects(
      () => lock([o.catalog1.ref, o.document1.ref]),
      (error: unknown) => error instanceof RepositoryCliError && error.exitCode === 1
    );
    assert.strictEqual(p.service.isLocked(p.cfTarget, C1), true, 'прежний захват остался');
    assert.strictEqual(p.service.isLocked(p.cfTarget, D1), false);
  });

  test('exit 1, лог не распознан: исключение, учёт не тронут', async () => {
    p.setResult('нет доступа к хранилищу', 1);
    await assert.rejects(() => lock([o.catalog1.ref, o.catalog3.ref]), RepositoryCliError);
    assert.deepStrictEqual(p.service.listLockedFullNames(p.cfTarget), []);
  });

  test('прерывание: RepositoryCliInterruptedError, учёт не тронут', async () => {
    p.setResult('', 0, { interrupted: 'Отменено пользователем' });
    await assert.rejects(() => lock([o.catalog1.ref, o.catalog3.ref]), RepositoryCliInterruptedError);
    assert.deepStrictEqual(p.service.listLockedFullNames(p.cfTarget), []);
  });

  test('Э33.7 (расширение): X уже у этого пользователя, Y у UserB — учёт цели cfe по логу', async () => {
    p.lock([EXT_X], p.cfeTarget);
    p.setResult(opLog(LOCK_DONE, foreignLine(EXT_Y, 'UserB')));
    const outcome = await lock([o.extX.ref, o.extY.ref]);
    assert.deepStrictEqual(outcome.lockedFullNames, [EXT_X]);
    assert.deepStrictEqual(outcome.lockedByOthers, [{ name: EXT_Y, user: 'UserB' }]);
    assert.strictEqual(p.service.isLocked(p.cfeTarget, EXT_X), true);
    assert.strictEqual(p.service.isLocked(p.cfeTarget, EXT_Y), false);
  });
});

suite('executeRepositoryUpdateAction: lockedOverwritten по журналу (Э33.6)', () => {
  let p: RepoProject;
  let o: ListObjects;
  const services = (): RepositoryCliServices => p.services;
  const update = (selection: RepositoryNodeSelection, recursive = false) =>
    executeRepositoryUpdateAction(services(), selection, { recursive, force: false });

  setup(async () => {
    p = await createRepoProject();
    o = addListObjects(p);
  });
  teardown(() => p.dispose());

  test('Э33.6: С1 захвачен и назван — перезаписан; Д1 назван, не захвачен; С3 захвачен и не назван — не затронут', async () => {
    p.lock([C1, C3]);
    p.setResult(opLog(UPDATE_DONE, receivedLine(C1), receivedLine(D1)));
    const outcome = await update([o.catalog1.ref, o.document1.ref, o.catalog3.ref]);
    assert.strictEqual(outcome.receivedFromRepository, true);
    assert.deepStrictEqual(outcome.lockedOverwritten, [C1]);
    assert.strictEqual(p.service.isLocked(p.cfTarget, C1), true, 'учёт захвата остаётся');
    assert.strictEqual(p.service.isLocked(p.cfTarget, C3), true);
  });

  test('Э33.6б: «получен» и без новой версии в хранилище — захваченный объект всё равно перезаписан', async () => {
    p.lock([C1]);
    p.setResult(opLog(UPDATE_DONE, receivedLine(C1)));
    const outcome = await update([o.catalog1.ref, o.catalog3.ref]);
    assert.deepStrictEqual(outcome.lockedOverwritten, [C1]);
  });

  test('Э33.6в: нет строк — receivedFromRepository=false и lockedOverwritten=[]', async () => {
    p.lock([C1, C3]);
    p.setResult(opLog(UPDATE_DONE));
    const outcome = await update([o.catalog1.ref, o.catalog3.ref]);
    assert.strictEqual(outcome.receivedFromRepository, false);
    assert.deepStrictEqual(outcome.lockedOverwritten, []);
  });

  test('в выборке нет захваченных: lockedOverwritten=[] даже при полученных версиях', async () => {
    p.lock(['Справочник.Другой']);
    p.setResult(opLog(UPDATE_DONE, receivedLine(C1)));
    const outcome = await update([o.catalog1.ref, o.catalog3.ref]);
    assert.strictEqual(outcome.receivedFromRepository, true);
    assert.deepStrictEqual(outcome.lockedOverwritten, []);
  });

  test('лог без маркера начала операции: консервативно все захваченные в выборке', async () => {
    p.lock([C1, 'Справочник.Другой']);
    p.setResult('');
    const outcome = await update([o.catalog1.ref, o.catalog3.ref]);
    assert.strictEqual(outcome.receivedFromRepository, true);
    assert.deepStrictEqual(outcome.lockedOverwritten, [C1]);
  });

  test('рекурсивный корень: учитываются все захваты цели, а перезаписанные — по журналу', async () => {
    p.lock([C1, C3, ROOT_LOCK_CF]);
    p.setResult(opLog(UPDATE_DONE, receivedLine(C1)));
    const outcome = await update(p.refs.cfRoot, true);
    assert.deepStrictEqual([...outcome.lockedOverwritten].sort(), [C1, ROOT_LOCK_CF].sort());
  });

  test('подсистема в списке (нерекурсивно): состав не разрешается — захваты цели, перезаписанные — по журналу', async () => {
    p.lock([C1, C3]);
    p.setResult(opLog(UPDATE_DONE, receivedLine(C3)));
    const outcome = await update([o.subsystem.ref, o.document1.ref]);
    assert.deepStrictEqual(outcome.lockedOverwritten, [C3]);
  });

  test('exit≠0: RepositoryCliError', async () => {
    p.lock([C1]);
    p.setResult('нет доступа', 1);
    await assert.rejects(() => update([o.catalog1.ref, o.catalog3.ref]), RepositoryCliError);
  });
});

suite('executeRepositoryCommitAction: notCommitted (Э33.4)', () => {
  let p: RepoProject;
  let o: ListObjects;
  const services = (): RepositoryCliServices => p.services;
  const commit = (selection: RepositoryNodeSelection, keepLocked = false) =>
    executeRepositoryCommitAction(services(), selection, { recursive: false, comment: 'Правка', keepLocked, force: false });

  setup(async () => {
    p = await createRepoProject();
    o = addListObjects(p);
  });
  teardown(() => p.dispose());

  test('Э33.4б/в: Д1 не захвачен/чужой — платформа молчит (exit 0): notCommitted=[Д1]; учёт снят у ВСЕХ запрошенных', async () => {
    p.lock([C1, D1]);
    p.setResult(opLog(COMMIT_DONE, committedLine(C1)));
    const outcome = await commit([o.catalog1.ref, o.document1.ref]);
    assert.deepStrictEqual(outcome.committedFullNames, [C1]);
    assert.deepStrictEqual(outcome.notCommitted, [D1]);
    assert.strictEqual(outcome.referencesCleaned, false);
    assert.strictEqual(p.service.isLocked(p.cfTarget, C1), false);
    assert.strictEqual(p.service.isLocked(p.cfTarget, D1), false, 'устаревшая запись учёта снимается');
  });

  test('Э33.4а: «помещен» + «не был изменен» — не помещённых нет, оба освобождены', async () => {
    p.lock([C1, C3]);
    p.setResult(opLog(COMMIT_DONE, committedLine(C1), unchangedLine(C3)));
    const outcome = await commit([o.catalog1.ref, o.catalog3.ref]);
    assert.deepStrictEqual(outcome.committedFullNames, [C1]);
    assert.deepStrictEqual(outcome.notCommitted, []);
    assert.deepStrictEqual(p.service.listLockedFullNames(p.cfTarget), []);
  });

  test('keepLocked: учёт сохраняется, notCommitted считается как обычно', async () => {
    p.lock([C1, D1]);
    p.setResult(opLog(COMMIT_DONE, committedLine(C1)));
    const outcome = await commit([o.catalog1.ref, o.document1.ref], true);
    assert.deepStrictEqual(outcome.notCommitted, [D1]);
    assert.strictEqual(p.service.isLocked(p.cfTarget, C1), true);
    assert.strictEqual(p.service.isLocked(p.cfTarget, D1), true);
  });

  test('лог не распознан: committedFullNames — все запрошенные, notCommitted=[]', async () => {
    p.setResult('');
    const outcome = await commit([o.catalog1.ref, o.catalog3.ref]);
    assert.deepStrictEqual(outcome.committedFullNames, [C1, C3]);
    assert.deepStrictEqual(outcome.notCommitted, []);
  });

  test('exit≠0: RepositoryCliError, захват остаётся', async () => {
    p.lock([C1]);
    p.setResult('Объект содержит ссылки на удаленные объекты', 1);
    await assert.rejects(() => commit([o.catalog1.ref, o.catalog3.ref]), RepositoryCliError);
    assert.strictEqual(p.service.isLocked(p.cfTarget, C1), true);
  });
});

suite('executeRepositoryUnlockAction: список, рекурсия корня, атомарный отказ (Э33.3, Э33.7, Э33.(б))', () => {
  let p: RepoProject;
  let o: ListObjects;
  const services = (): RepositoryCliServices => p.services;
  const unlock = (selection: RepositoryNodeSelection, recursive = false, force = false) =>
    executeRepositoryUnlockAction(services(), selection, recursive, force);

  setup(async () => {
    p = await createRepoProject();
    o = addListObjects(p);
  });
  teardown(() => p.dispose());

  test('Э33.(б): рекурсивный UnLock корня -force — освобождено «отменен» − «не захвачен» − «чужой»; чужой захват в учёте остаётся', async () => {
    p.lock([ROOT_LOCK_CF, C1, C3, D1]);
    p.setResult(opLog(
      UNLOCK_DONE,
      cancelledLine(C1), cancelledLine(C3), cancelledLine(D1),
      notLockedLine(C3),
      foreignLine(D1, 'UserB')
    ));
    const outcome = await unlock(p.refs.cfRoot, true, true);
    assert.deepStrictEqual(outcome.unlocked, [ROOT_LOCK_CF, C1]);
    assert.deepStrictEqual(outcome.lockedByOthers, [{ name: D1, user: 'UserB' }]);
    assert.deepStrictEqual(outcome.notUnlocked, []);
    assert.ok(p.args().includes('-force'));
    assert.strictEqual(p.service.isLocked(p.cfTarget, ROOT_LOCK_CF), false);
    assert.strictEqual(p.service.isLocked(p.cfTarget, C1), false);
    assert.strictEqual(p.service.isLocked(p.cfTarget, C3), false, '«не захвачен вами» в учёте — устаревшая запись, снятие верно');
    assert.strictEqual(p.service.isLocked(p.cfTarget, D1), true, 'чужой захват не снимается');
  });

  test('список: «отменен» С1, «не захвачен» С3 — notUnlocked без «не захвачен вами»', async () => {
    p.lock([C1]);
    p.setResult(opLog(UNLOCK_DONE, cancelledLine(C1), notLockedLine(C3)));
    const outcome = await unlock([o.catalog1.ref, o.catalog3.ref]);
    assert.deepStrictEqual(outcome.unlocked, [C1]);
    assert.deepStrictEqual(outcome.notUnlocked, []);
    assert.deepStrictEqual(outcome.lockedByOthers, []);
    assert.strictEqual(p.service.isLocked(p.cfTarget, C1), false);
  });

  test('список: Д1 чужой — notUnlocked=[Д1] и lockedByOthers; учёт Д1 остаётся', async () => {
    p.lock([C1, D1]);
    p.setResult(opLog(UNLOCK_DONE, cancelledLine(C1), foreignLine(D1, 'UserB')));
    const outcome = await unlock([o.catalog1.ref, o.document1.ref]);
    assert.deepStrictEqual(outcome.unlocked, [C1]);
    assert.deepStrictEqual(outcome.notUnlocked, [D1]);
    assert.deepStrictEqual(outcome.lockedByOthers, [{ name: D1, user: 'UserB' }]);
    assert.strictEqual(p.service.isLocked(p.cfTarget, C1), false);
    assert.strictEqual(p.service.isLocked(p.cfTarget, D1), true);
  });

  test('Э33.3: без -force изменённый объект — exit 1, не освобождён никто; учёт НЕ тронут; RepositoryCliError несёт лог и код', async () => {
    p.lock([C1, C3]);
    p.setResult(E33_3_LOG, 1);
    await assert.rejects(
      () => unlock([o.catalog1.ref, o.catalog3.ref]),
      (error: unknown) => error instanceof RepositoryCliError
        && error.exitCode === 1
        && error.log === E33_3_LOG
        && error.title === 'Ошибка освобождения объектов "Справочник1 и ещё 1".'
    );
    assert.strictEqual(p.service.isLocked(p.cfTarget, C1), true);
    assert.strictEqual(p.service.isLocked(p.cfTarget, C3), true);
    assert.ok(!p.args().includes('-force'));
  });

  test('Э33.7 (расширение): «отменен» по обоим — оба освобождены в учёте цели cfe', async () => {
    p.lock([EXT_X, EXT_Y], p.cfeTarget);
    p.setResult(opLog(UNLOCK_DONE, cancelledLine(EXT_X), cancelledLine(EXT_Y)));
    const outcome = await unlock([o.extX.ref, o.extY.ref]);
    assert.deepStrictEqual(outcome.unlocked, [EXT_X, EXT_Y]);
    assert.deepStrictEqual(outcome.notUnlocked, []);
    assert.deepStrictEqual(p.service.listLockedFullNames(p.cfeTarget), []);
  });

  test('лог не распознан: снимаются все запрошенные (прежнее поведение), notUnlocked пуст', async () => {
    p.lock([C1, C3]);
    p.setResult('');
    const outcome = await unlock([o.catalog1.ref, o.catalog3.ref]);
    assert.deepStrictEqual(outcome.unlocked, [C1, C3]);
    assert.deepStrictEqual(outcome.notUnlocked, []);
  });
});
