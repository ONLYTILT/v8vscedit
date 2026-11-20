import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  RepositoryCliError,
  RepositoryCliInterruptedError,
  executeRepositoryCliCommand,
  executeRepositoryCommitAction,
  executeRepositoryLockAction,
  executeRepositoryUnlockAction,
  executeRepositoryUpdateAction,
  runRepositoryUnlockAction,
} from '../../ui/commands/repository/RepositoryCommandRunner';
import type { RepositoryCliExecuteOptions, RepositoryCliServices } from '../../ui/commands/repository/RepositoryCommandRunner';
import {
  COMMIT_DONE, LOCK_DONE, UNLOCK_DONE, UPDATE_DONE, ROOT_LOCK_CF, createRepoProject, opLog, type RepoProject,
} from './support/repositoryMcpFixtures';

/**
 * Раннер хранилища, «бросающий» слой (Э24/Э25): `executeRepositoryCliCommand` и `execute*Action`
 * без тостов — для MCP; прежние `run*Action` остаются обёртками try/catch с тостом (их поведение
 * защищено существующими `repositoryCommandRunner.test.ts`/`repositoryCommands.test.ts`).
 * Учёт захватов — по строкам лога платформы: освобождение чужого захвата даёт exit 0 БЕЗ снятия.
 */

const FOREIGN = 'Объект захвачен для редактирования другим пользователем: ';

suite('executeRepositoryCliCommand: ошибки без тостов, dispose всегда', () => {
  let p: RepoProject;
  const services = (): RepositoryCliServices => p.services;
  // Операции в тестах сокращены до `kind`: раннеру важны заголовки и исход запуска, а не полный вектор.
  const options = (overrides: Record<string, unknown> = {}): RepositoryCliExecuteOptions => ({
    operation: { kind: 'unbind' },
    target: p.cfTarget,
    progressTitle: 'Тест',
    progressStartMessage: 'старт',
    errorTitle: 'Ошибка теста',
    ...overrides,
  }) as unknown as RepositoryCliExecuteOptions;

  setup(async () => { p = await createRepoProject(); });
  teardown(() => p.dispose());

  test('exit 0: возвращает результат запуска, тостов нет, исполнитель освобождён', async () => {
    p.setResult('лог');
    const result = await executeRepositoryCliCommand(options({ operation: { kind: 'lock' } }), services());
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.log, 'лог');
    assert.deepStrictEqual(p.toasts, []);
    assert.strictEqual(p.disposedExecutors, 1);
  });

  test('exit≠0: RepositoryCliError {title, message «Ошибка при <операция>: <причина>», log, exitCode}; без тоста; dispose', async () => {
    p.setResult('Нет доступа к хранилищу', 1);
    await assert.rejects(
      () => executeRepositoryCliCommand(options({ operation: { kind: 'lock' }, failureOperation: 'захвате объектов хранилища' }), services()),
      (error: unknown) => {
        assert.ok(error instanceof RepositoryCliError);
        assert.ok(error instanceof Error);
        assert.strictEqual(error.title, 'Ошибка теста');
        assert.strictEqual(error.message, 'Ошибка при захвате объектов хранилища: Нет доступа к хранилищу');
        assert.strictEqual(error.log, 'Нет доступа к хранилищу');
        assert.strictEqual(error.exitCode, 1);
        return true;
      }
    );
    assert.deepStrictEqual(p.toasts, []);
    assert.strictEqual(p.disposedExecutors, 1);
  });

  test('exit≠0 без failureOperation: операция в сообщении — заголовок прогресса в нижнем регистре; пустой лог → «команда завершилась с кодом N»', async () => {
    p.setResult('', 7);
    await assert.rejects(
      () => executeRepositoryCliCommand(options({ operation: { kind: 'lock' } }), services()),
      (error: Error) => error.message === 'Ошибка при тест: команда завершилась с кодом 7'
    );
  });

  test('прерывание (отмена): RepositoryCliInterruptedError с текстом исполнителя; ни тостов, ни ошибки платформы; dispose', async () => {
    p.setResult('', 0, { interrupted: 'Отменено пользователем' });
    await assert.rejects(
      () => executeRepositoryCliCommand(options({ operation: { kind: 'lock' } }), services()),
      (error: unknown) => {
        assert.ok(error instanceof RepositoryCliInterruptedError);
        assert.ok(!(error instanceof RepositoryCliError), 'прерывание — не отказ платформы');
        assert.strictEqual((error).message, 'Отменено пользователем');
        return true;
      }
    );
    assert.deepStrictEqual(p.toasts, []);
    assert.strictEqual(p.disposedExecutors, 1);
  });

  test('выходной файл: staging переносится на targetPath при успехе; нет выходного файла → RepositoryCliError', async () => {
    const staging = path.join(p.root, 'staging.cf');
    fs.writeFileSync(staging, 'бинарь');
    p.setResult('', 0, { outputs: new Map([['dump.cf', staging]]) });
    const targetPath = path.join(p.root, 'o.cf');
    await executeRepositoryCliCommand(
      options({ operation: { kind: 'dump' }, output: { name: 'dump.cf', targetPath } }), services()
    );
    assert.strictEqual(fs.readFileSync(targetPath, 'utf-8'), 'бинарь');

    p.setResult('', 0);
    await assert.rejects(
      () => executeRepositoryCliCommand(
        options({ operation: { kind: 'dump' }, output: { name: 'dump.cf', targetPath: path.join(p.root, 'o2.cf') }, failureOperation: 'выгрузке' }),
        services()
      ),
      (error: unknown) => error instanceof RepositoryCliError
        && error.message === 'Ошибка при выгрузке: конфигуратор не создал выходной файл.'
    );
    assert.strictEqual(fs.existsSync(path.join(p.root, 'o2.cf')), false);
  });

  test('ошибки конфигурации ДО запуска (нет привязки к хранилищу) — обычный Error, исполнитель не создаётся/не освобождается', async () => {
    const bare = p.addUnboundExtension('Безхранилища');
    await assert.rejects(
      () => executeRepositoryCliCommand(options({ operation: { kind: 'lock' }, target: bare.target }), services()),
      (error: Error) => error.message.includes('не настроено подключение к хранилищу') && !(error instanceof RepositoryCliError)
    );
    assert.strictEqual(p.runs.length, 0);
    assert.strictEqual(p.disposedExecutors, 0);
  });

  test('исполнитель бросил исключение: оно пробрасывается, dispose выполнен', async () => {
    const services2 = {
      ...p.services,
      createDesignerExecutor: () => ({ run: () => Promise.reject(new Error('сломан')), dispose: () => { p.disposedExecutors += 1; return Promise.resolve(); } }),
    } as unknown as RepositoryCliServices;
    await assert.rejects(
      () => executeRepositoryCliCommand(options({ operation: { kind: 'lock' } }), services2),
      /сломан/
    );
    assert.strictEqual(p.disposedExecutors, 1);
    assert.deepStrictEqual(p.toasts, []);
  });
});

suite('execute*Action: учёт захватов по логам платформы', () => {
  let p: RepoProject;
  const services = (): RepositoryCliServices => p.services;
  const T = 'Справочник.Товары';

  setup(async () => { p = await createRepoProject(); });
  teardown(() => p.dispose());

  test('захват: отмечаются объекты из лога, исход как у run*; exit≠0 — RepositoryCliError, учёт не тронут', async () => {
    p.setResult(opLog(LOCK_DONE, `Объект захвачен для редактирования: ${T}`));
    const outcome = await executeRepositoryLockAction(services(), p.refs.catalog, false, { revised: true });
    assert.deepStrictEqual(outcome, { lockedFullNames: [T], receivedFromRepository: false });
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
    assert.ok(p.args().includes('-revised'));

    p.service.setLocked(p.cfTarget, [T], false);
    p.setResult('нет доступа', 1);
    await assert.rejects(() => executeRepositoryLockAction(services(), p.refs.catalog, false, { revised: false }), RepositoryCliError);
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), false);
  });

  test('освобождение, чужой захват (Э24): exit 0, но учёт НЕ снимается; ответ — notUnlocked и lockedByOthers', async () => {
    p.lock([T]);
    p.setResult(opLog(UNLOCK_DONE, `${FOREIGN}${T} (Иванов) `));
    const outcome = await executeRepositoryUnlockAction(services(), p.refs.catalog, false, false);
    assert.deepStrictEqual(outcome, { unlocked: [], lockedByOthers: [{ name: T, user: 'Иванов' }], notUnlocked: [T] });
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
  });

  test('освобождение, частичное и вне запрошенных: снимается учёт именно названных логом объектов, остальные остаются', async () => {
    p.lock([T, 'Справочник.Другой', 'Справочник.Третий']);
    p.setResult(opLog(UNLOCK_DONE, 'Захват объекта отменен: Справочник.Другой'));
    const outcome = await executeRepositoryUnlockAction(services(), p.refs.catalog, false, false);
    assert.deepStrictEqual(outcome.unlocked, ['Справочник.Другой']);
    assert.deepStrictEqual(outcome.notUnlocked, [T]);
    assert.deepStrictEqual(outcome.lockedByOthers, []);
    assert.strictEqual(p.service.isLocked(p.cfTarget, 'Справочник.Другой'), false);
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
    assert.strictEqual(p.service.isLocked(p.cfTarget, 'Справочник.Третий'), true);
  });

  test('освобождение, лог не распознан: снимаются все запрошенные (прежнее поведение), notUnlocked пуст', async () => {
    p.lock([T]);
    p.setResult('');
    const outcome = await executeRepositoryUnlockAction(services(), p.refs.catalog, false, true);
    assert.deepStrictEqual(outcome, { unlocked: [T], lockedByOthers: [], notUnlocked: [] });
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), false);
    assert.ok(p.args().includes('-force'));
  });

  test('освобождение корня рекурсивно: служебное имя корня снимается, объекты из лога — тоже', async () => {
    p.lock([ROOT_LOCK_CF, T]);
    p.setResult(opLog(UNLOCK_DONE, `Захват объекта отменен: ${T}`));
    const outcome = await executeRepositoryUnlockAction(services(), p.refs.cfRoot, true, false);
    assert.deepStrictEqual(outcome.unlocked, [ROOT_LOCK_CF, T]);
    assert.strictEqual(p.service.isLocked(p.cfTarget, ROOT_LOCK_CF), false);
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), false);
  });

  test('освобождение, exit 1 со строкой «отменен» в логе: учёт по этим строкам применяется, затем RepositoryCliError', async () => {
    p.lock([T, 'Справочник.Склады']);
    p.setResult(opLog('Ошибка освобождения', 'Захват объекта отменен: Справочник.Склады'), 1);
    await assert.rejects(
      () => executeRepositoryUnlockAction(services(), p.refs.catalog, false, false),
      (error: unknown) => error instanceof RepositoryCliError && error.exitCode === 1
    );
    assert.strictEqual(p.service.isLocked(p.cfTarget, 'Справочник.Склады'), false, 'частично отпущенное снято');
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
  });

  test('освобождение, exit 1 и лог не распознан: учёт НЕ тронут (нечем подтвердить)', async () => {
    p.lock([T]);
    p.setResult('Ошибка платформы', 1);
    await assert.rejects(() => executeRepositoryUnlockAction(services(), p.refs.catalog, false, false), RepositoryCliError);
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
  });

  test('помещение (Э25): committedFullNames — по строкам «помещен», учёт снимается у ЗАПРОШЕННЫХ (в лог снятие не пишется)', async () => {
    p.lock([T]);
    p.setResult(opLog(COMMIT_DONE, `Объект помещен в хранилище: ${T}`));
    const outcome = await executeRepositoryCommitAction(
      services(), p.refs.catalog, { recursive: false, comment: 'Правка', keepLocked: false, force: false }
    );
    assert.deepStrictEqual(outcome, { committedFullNames: [T], referencesCleaned: false });
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), false);
  });

  test('помещение без правок (все «не был изменен»): успех, committedFullNames пуст, захват снят (exit 0 без keepLocked)', async () => {
    p.lock([T]);
    p.setResult(opLog(COMMIT_DONE, `Объект не был изменен: ${T}`));
    const outcome = await executeRepositoryCommitAction(
      services(), p.refs.catalog, { recursive: false, comment: 'к', keepLocked: false, force: false }
    );
    assert.deepStrictEqual(outcome.committedFullNames, []);
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), false);
  });

  test('помещение с keepLocked: захват сохраняется; -force и очистка ссылок → referencesCleaned=true', async () => {
    p.lock([T]);
    p.setResult(opLog(COMMIT_DONE, 'Очистка объектов от некорректных ссылок выполнена', `Объект помещен в хранилище: ${T}`));
    const outcome = await executeRepositoryCommitAction(
      services(), p.refs.catalog, { recursive: false, comment: 'Правка', keepLocked: true, force: true }
    );
    assert.strictEqual(outcome.referencesCleaned, true);
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
    const tail = p.args().filter((arg): arg is string => typeof arg === 'string');
    assert.ok(tail.includes('-keepLocked') && tail.includes('-force'));
  });

  test('помещение, лог не распознан: committedFullNames — все запрошенные, referencesCleaned=false', async () => {
    p.setResult('');
    const outcome = await executeRepositoryCommitAction(
      services(), p.refs.catalog, { recursive: false, comment: 'к', keepLocked: false, force: false }
    );
    assert.deepStrictEqual(outcome, { committedFullNames: [T], referencesCleaned: false });
  });

  test('помещение: exit≠0 → RepositoryCliError, захват остаётся', async () => {
    p.lock([T]);
    p.setResult('Объект содержит ссылки на удаленные объекты', 1);
    await assert.rejects(
      () => executeRepositoryCommitAction(services(), p.refs.catalog, { recursive: false, comment: 'к', keepLocked: false, force: false }),
      (error: Error) => error.message === 'Ошибка при помещении изменений в хранилище: Объект содержит ссылки на удаленные объекты'
    );
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
  });

  test('получение: исход по логу; exit≠0 — RepositoryCliError', async () => {
    p.setResult(opLog(UPDATE_DONE, `Объект получен из хранилища: ${T}`));
    assert.deepStrictEqual(
      await executeRepositoryUpdateAction(services(), p.refs.catalog, { recursive: false, force: false }),
      { receivedFromRepository: true }
    );
    p.setResult(opLog(UPDATE_DONE));
    assert.deepStrictEqual(
      await executeRepositoryUpdateAction(services(), p.refs.catalog, { recursive: false, force: false }),
      { receivedFromRepository: false }
    );
    p.setResult('нет доступа', 1);
    await assert.rejects(
      () => executeRepositoryUpdateAction(services(), p.refs.catalog, { recursive: false, force: false }),
      (error: Error) => error.message.startsWith('Ошибка при получении изменений из хранилища:')
    );
  });

  test('узел без xmlPath: обычный Error до запуска (как у run*)', async () => {
    await assert.rejects(
      () => executeRepositoryUnlockAction(services(), { nodeKind: 'Catalog', label: 'X' }, false, false),
      /Не удалось определить конфигурацию/
    );
    assert.strictEqual(p.runs.length, 0);
  });
});

suite('E: регресс UI-обёрток (run*Action) — фикс Э24 общим кодом', () => {
  let p: RepoProject;
  setup(async () => { p = await createRepoProject(); });
  teardown(() => p.dispose());

  /**
   * ЕДИНСТВЕННОЕ оправданное изменение прежнего поведения (Э24, docs/plans/remote-designer-plan.md §5b п.31):
   * раньше `runRepositoryUnlockAction.afterSuccess` снимал учёт у ВСЕХ запрошенных по exit 0, даже когда
   * платформа в логе сообщила о чужом захвате (захват при этом НЕ снят). Теперь учёт — по строкам лога.
   * Прежние тесты с нераспознанным логом (`log: ''`) остаются зелёными: там по-прежнему снимаются все.
   */
  test('runRepositoryUnlockAction: распознанный лог с чужим захватом — учёт остаётся (Э24); возврат boolean сохранён', async () => {
    const T = 'Справочник.Товары';
    p.lock([T]);
    p.setResult(opLog(UNLOCK_DONE, `${FOREIGN}${T} (Иванов) `));
    const ok = await runRepositoryUnlockAction(p.services, p.refs.catalog, false, false);
    assert.strictEqual(typeof ok, 'boolean');
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
  });

  test('runRepositoryUnlockAction: нераспознанный лог — снимаются все запрошенные (прежнее поведение)', async () => {
    const T = 'Справочник.Товары';
    p.lock([T]);
    p.setResult('');
    assert.strictEqual(await runRepositoryUnlockAction(p.services as unknown as RepositoryCliServices, p.refs.catalog, false, true), true);
    assert.strictEqual(p.service.isLocked(p.cfTarget, T), false);
  });
});
