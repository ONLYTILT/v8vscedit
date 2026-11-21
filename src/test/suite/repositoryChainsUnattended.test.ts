import * as assert from 'assert';
import {
  RepositoryStepFailedError,
  describeChainStepFailure,
  runCommitChain,
  runLockChain,
  runUpdateChain,
} from '../../ui/commands/repository/repositoryChains';
import { describeImportFailureAfterCommit } from '../../ui/commands/repository/repositoryCommitFlow';
import { describeImportFailureAfterLock, type RepositoryLockPlan } from '../../ui/commands/repository/repositoryLockFlow';
import { importTargetFromDatabase, runPostRepositorySync } from '../../ui/commands/repository/repositoryPostSync';
import {
  describeImportFailureAfterReceive,
  describeLoadFailureAfterReceive,
  type RepositoryUpdatePlan,
} from '../../ui/commands/repository/repositoryUpdateFlow';
import type { OperationInteraction } from '../../ui/commands/ext/configurationOperationTypes';
import {
  COMMIT_DONE, LOCK_DONE, UPDATE_DONE, createRepoProject, opLog, type RepoProject,
} from './support/repositoryMcpFixtures';

/**
 * Режим `interaction` цепочек хранилища (`repositoryChains.ts`): обязательный последний параметр
 * `runLockChain`/`runUpdateChain`/`runCommitChain` доходит до раннеров загрузки и импорта; в unattended
 * причина отказа раннера дописывается к тексту шага (` Причина: …`), в interactive тексты прежние
 * байт-в-байт (причину уже показал раннер). Раннеры загрузки/импорта — заглушки `createRepoProject`, которые
 * повторяют контракт `onFailure`/`onOutcome`; сквозная проверка через агента — `mcpImportConfigurations.test.ts`.
 */

const T = 'Справочник.Товары';
const RECEIVED = opLog(LOCK_DONE, `Объект захвачен для редактирования: ${T}`, `Объект получен из хранилища: ${T}`);
const GOT = opLog(UPDATE_DONE, `Объект получен из хранилища: ${T}`);
const CLEANED = opLog(COMMIT_DONE, 'Очистка объектов от некорректных ссылок выполнена', `Объект помещен в хранилище: ${T}`);
const REASON = 'Импорт «Основная» требует полной выгрузки конфигурации на сервере. Проект не изменён.';

const LOAD_BEFORE_LOCK = 'Загрузка правок проекта в базу не выполнена; захват не выполнялся. Подробности — в журнале «1С Редактор».';
const LOAD_BEFORE_COMMIT = 'Загрузка правок проекта в базу не выполнена; помещение не выполнялось. Подробности — в журнале «1С Редактор».';

suite('describeChainStepFailure', () => {
  test('interactive + причина → base (причину уже показал раннер)', () => {
    assert.strictEqual(describeChainStepFailure('Базовый текст.', 'Причина X', 'interactive'), 'Базовый текст.');
  });

  test('unattended без причины → base', () => {
    assert.strictEqual(describeChainStepFailure('Базовый текст.', undefined, 'unattended'), 'Базовый текст.');
    assert.strictEqual(describeChainStepFailure('Базовый текст.', '', 'unattended'), 'Базовый текст.');
  });

  test('unattended + причина → «base Причина: …»', () => {
    assert.strictEqual(describeChainStepFailure('Базовый текст.', 'Причина X', 'unattended'), 'Базовый текст. Причина: Причина X');
  });

  test('interactive без причины → base', () => {
    assert.strictEqual(describeChainStepFailure('Базовый текст.', undefined, 'interactive'), 'Базовый текст.');
  });
});

for (const interaction of ['interactive', 'unattended'] as OperationInteraction[]) {
  const unattended = interaction === 'unattended';
  const withReason = (base: string): string => (unattended ? `${base} Причина: ${REASON}` : base);

  suite(`repositoryChains × interaction=${interaction}`, function () {
    this.timeout(60_000);
    let p: RepoProject;
    const lockPlan = (overrides: Partial<RepositoryLockPlan> = {}): RepositoryLockPlan =>
      ({ revised: true, updateDatabaseFirst: false, updateDatabaseOnLoad: false, importAfterLock: true, ...overrides });
    const updatePlan = (overrides: Partial<RepositoryUpdatePlan> = {}): RepositoryUpdatePlan =>
      ({ loadChangesAfterReceive: false, updateDatabaseOnLoad: false, importAfterReceive: true, ...overrides });

    setup(async () => { p = await createRepoProject(); });
    teardown(() => p.dispose());

    test('lock: interaction доходит до раннера загрузки и импорта', async () => {
      p.setResult(RECEIVED);
      await runLockChain(p.services, p.cfTarget, p.refs.catalog, false, lockPlan({ updateDatabaseFirst: true, updateDatabaseOnLoad: true }), interaction);
      assert.deepStrictEqual(p.events, ['update:cf', 'repo:lock', 'import:cf']);
      assert.strictEqual(p.updateOptions().interaction, interaction);
      assert.strictEqual(p.importOptions()?.interaction, interaction);
    });

    test('update: interaction доходит до раннера загрузки (после получения) и импорта', async () => {
      p.setResult(GOT);
      await runUpdateChain(p.services, p.cfTarget, p.refs.catalog, { recursive: false, force: false },
        updatePlan({ loadChangesAfterReceive: true, updateDatabaseOnLoad: true }), interaction);
      assert.deepStrictEqual(p.events, ['repo:update', 'update:cf', 'import:cf']);
      assert.strictEqual(p.updateOptions().interaction, interaction);
      assert.strictEqual(p.importOptions()?.interaction, interaction);
    });

    test('commit: interaction доходит до раннера загрузки и импорта (очистка ссылок)', async () => {
      p.lock([T]);
      p.setResult(CLEANED);
      await runCommitChain(p.services, p.cfTarget, p.refs.catalog,
        { recursive: false, comment: 'Правка', keepLocked: false, force: true },
        { updateDatabaseFirst: true, updateDatabaseOnLoad: false }, interaction);
      assert.strictEqual(p.updateOptions().interaction, interaction);
      assert.strictEqual(p.importOptions()?.interaction, interaction);
    });

    test('lock: отказ загрузки → RepositoryStepFailedError; причина — только в unattended', async () => {
      p.updateResult = false;
      p.loadFailureReason = REASON;
      await assert.rejects(
        () => runLockChain(p.services, p.cfTarget, p.refs.catalog, false, lockPlan({ updateDatabaseFirst: true }), interaction),
        (error: Error) => error instanceof RepositoryStepFailedError && error.message === withReason(LOAD_BEFORE_LOCK)
      );
      assert.strictEqual(p.runs.length, 0, 'захват не запускался');
    });

    test('commit: отказ загрузки → RepositoryStepFailedError; причина — только в unattended', async () => {
      p.lock([T]);
      p.updateResult = false;
      p.loadFailureReason = REASON;
      await assert.rejects(
        () => runCommitChain(p.services, p.cfTarget, p.refs.catalog,
          { recursive: false, comment: 'Правка', keepLocked: false, force: false },
          { updateDatabaseFirst: true, updateDatabaseOnLoad: false }, interaction),
        (error: Error) => error instanceof RepositoryStepFailedError && error.message === withReason(LOAD_BEFORE_COMMIT)
      );
      assert.strictEqual(p.runs.length, 0, 'помещение не запускалось');
    });

    test('update: отказ загрузки после получения → предупреждение; причина — только в unattended; projectBehind=true', async () => {
      p.updateResult = false;
      p.loadFailureReason = REASON;
      p.setResult(GOT);
      const result = await runUpdateChain(p.services, p.cfTarget, p.refs.catalog, { recursive: false, force: false },
        updatePlan({ loadChangesAfterReceive: true }), interaction);
      assert.strictEqual(result.projectBehind, true);
      assert.deepStrictEqual(result.warnings, [withReason(describeLoadFailureAfterReceive(p.cfTarget.displayName))]);
    });

    test('update: отказ импорта после получения → предупреждение; причина — только в unattended; projectBehind=true', async () => {
      p.importResult = false;
      p.importFailureReason = REASON;
      p.setResult(GOT);
      const result = await runUpdateChain(p.services, p.cfTarget, p.refs.catalog, { recursive: false, force: false }, updatePlan(), interaction);
      assert.strictEqual(result.projectBehind, true);
      assert.deepStrictEqual(result.warnings, [withReason(describeImportFailureAfterReceive(p.cfTarget.displayName))]);
    });

    test('lock: отказ импорта после захвата → предупреждение; причина — только в unattended; projectBehind=true', async () => {
      p.importResult = false;
      p.importFailureReason = REASON;
      p.setResult(RECEIVED);
      const result = await runLockChain(p.services, p.cfTarget, p.refs.catalog, false, lockPlan(), interaction);
      assert.strictEqual(result.projectBehind, true);
      assert.deepStrictEqual(result.warnings, [withReason(describeImportFailureAfterLock(p.cfTarget.displayName))]);
    });

    test('commit: отказ импорта после очистки ссылок → предупреждение; причина — только в unattended', async () => {
      p.lock([T]);
      p.importResult = false;
      p.importFailureReason = REASON;
      p.setResult(CLEANED);
      const result = await runCommitChain(p.services, p.cfTarget, p.refs.catalog,
        { recursive: false, comment: 'Правка', keepLocked: false, force: true },
        { updateDatabaseFirst: false, updateDatabaseOnLoad: false }, interaction);
      assert.deepStrictEqual(result.warnings, [withReason(describeImportFailureAfterCommit(p.cfTarget.displayName))]);
    });

    test('отказ без причины от раннера: тексты прежние даже в unattended', async () => {
      p.importResult = false;
      p.importFailureReason = undefined;
      p.setResult(GOT);
      const result = await runUpdateChain(p.services, p.cfTarget, p.refs.catalog, { recursive: false, force: false }, updatePlan(), interaction);
      assert.deepStrictEqual(result.warnings, [describeImportFailureAfterReceive(p.cfTarget.displayName)]);
    });
  });
}

suite('importTargetFromDatabase: причина отказа', function () {
  this.timeout(60_000);
  let p: RepoProject;
  setup(async () => { p = await createRepoProject(); });
  teardown(() => p.dispose());

  for (const [title, reason, expected] of [['пустая причина не публикуется', '', []], ['непустая публикуется', 'причина', ['причина']]] as const) {
    test(title, async () => {
      p.importResult = false;
      p.importFailureReason = reason;
      const failures: string[] = [];
      const ok = await importTargetFromDatabase(p.cfTarget, p.services, { interaction: 'unattended', onFailure: (r) => { failures.push(r); } });
      assert.strictEqual(ok, false);
      assert.deepStrictEqual(failures, expected);
    });
  }
});

suite('runPostRepositorySync: импорт после подключения хранилища идёт в interactive', function () {
  this.timeout(60_000);
  let p: RepoProject;
  setup(async () => { p = await createRepoProject(); });
  teardown(() => p.dispose());

  test('импорт получает { interaction: interactive }', async () => {
    await runPostRepositorySync(p.cfTarget, p.services);
    assert.deepStrictEqual(p.events, ['apply:cf', 'import:cf']);
    assert.strictEqual(p.importOptions()?.interaction, 'interactive');
  });
});
