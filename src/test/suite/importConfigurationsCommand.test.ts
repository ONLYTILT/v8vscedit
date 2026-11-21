/**
 * Команда `v8vscedit.importConfigurations` (`ui/commands/ext/ImportConfigurationsCommands.ts`): аргумент
 * `{ targets }` вместо окна выбора, посторонний аргумент (узел дерева, Uri) — прежнее окно, отказ при
 * неверной форме/неизвестном имени без побочных эффектов, замок, регистрация. QuickPick внедряется
 * (`pickTargets`), чтобы не тянуть окно в тест; агент 1С подменён швом реестра (`support/importHarness.ts`).
 */
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  isConfigurationOperationRunning,
  tryBeginConfigurationOperation,
} from '../../ui/commands/ext/configurationOperationLock';
import {
  registerImportConfigurationsCommand,
  runImportConfigurationsCommand,
} from '../../ui/commands/ext/ImportConfigurationsCommands';
import { IMPORT_ARGS_INVALID, NO_IMPORT_TARGETS, type ImportTarget } from '../../ui/commands/ext/importTargets';
import { createImportHarness, type ImportHarness } from './support/importHarness';
import { removeTreeSync } from './support/tempTree';

suite('runImportConfigurationsCommand', function () {
  this.timeout(60_000);
  let h: ImportHarness;
  let picked: ImportTarget[][];
  let pickAnswer: (targets: ImportTarget[]) => Promise<ImportTarget[] | undefined>;

  const pick = (targets: ImportTarget[]): Promise<ImportTarget[] | undefined> => {
    picked.push(targets);
    return pickAnswer(targets);
  };
  const run = (arg: unknown) => runImportConfigurationsCommand(h.p.services, arg, pick);
  const toastMessages = (kind: string): string[] => h.p.toasts.filter((t) => t.kind === kind).map((t) => t.message);

  setup(async () => {
    h = await createImportHarness();
    picked = [];
    pickAnswer = () => Promise.resolve(undefined);
  });
  teardown(async () => { await h.dispose(); });

  test('без аргумента: показан picker со всеми целями; undefined от picker → без импорта, undefined, замок свободен', async () => {
    assert.strictEqual(await run(undefined), undefined);
    assert.strictEqual(picked.length, 1);
    assert.deepStrictEqual(picked[0].map((t) => t.name), ['Основная', 'Расш']);
    assert.strictEqual(h.calls.length, 0);
    assert.strictEqual(isConfigurationOperationRunning(), false);
  });

  test('пустой выбор в picker → без импорта, undefined, замок свободен', async () => {
    pickAnswer = () => Promise.resolve([]);
    assert.strictEqual(await run(undefined), undefined);
    assert.strictEqual(h.calls.length, 0);
    assert.strictEqual(isConfigurationOperationRunning(), false);
  });

  test('picker вернул цель → импорт именно её, результат возвращён, замок снят', async () => {
    pickAnswer = (targets) => Promise.resolve(targets.filter((t) => t.kind === 'cfe'));
    const result = await run(undefined);
    assert.deepStrictEqual(result?.results.map((r) => [r.name, r.status]), [['Расш', 'imported']]);
    assert.strictEqual(isConfigurationOperationRunning(), false);
  });

  const foreign: [string, () => unknown][] = [
    ['узел дерева', () => ({ nodeKind: 'configuration', xmlPath: path.join(h.p.cfRoot, 'Configuration.xml'), label: 'Основная' })],
    ['vscode.Uri', () => vscode.Uri.file(h.p.root)],
    ['пустой объект', () => ({})],
  ];
  for (const [title, make] of foreign) {
    test(`посторонний аргумент (${title}) → picker вызван, прежнее поведение`, async () => {
      await run(make());
      assert.strictEqual(picked.length, 1);
      assert.strictEqual(h.calls.length, 0);
    });
  }

  test("{ targets: 'all' } → picker НЕ вызван, импортируются все, результат возвращён", async () => {
    const result = await run({ targets: 'all' });
    assert.strictEqual(picked.length, 0);
    assert.deepStrictEqual(h.calls.map((c) => c.target.name), ['Основная', 'Расш']);
    assert.deepStrictEqual(result?.results.map((r) => r.status), ['imported', 'imported']);
    assert.strictEqual(isConfigurationOperationRunning(), false);
  });

  for (const name of ['Расш', 'расш']) {
    test(`{ targets: ['${name}'] } → только расширение (регистр не важен)`, async () => {
      const result = await run({ targets: [name] });
      assert.strictEqual(picked.length, 0);
      assert.deepStrictEqual(h.calls.map((c) => c.target.name), ['Расш']);
      assert.deepStrictEqual(result?.results.map((r) => r.name), ['Расш']);
    });
  }

  test("{ targets: ['Нет'] } → reject с перечнем неизвестных и доступных; picker не вызван, замок не взят, импорта нет", async () => {
    await assert.rejects(
      () => run({ targets: ['Нет'] }),
      (error: Error) => error.message === 'Неизвестные цели импорта: «Нет». Доступны: Основная, Расш.'
    );
    assert.strictEqual(picked.length, 0);
    assert.strictEqual(h.calls.length, 0);
    assert.strictEqual(isConfigurationOperationRunning(), false);
  });

  test('{ targets: [] } → reject IMPORT_ARGS_INVALID', async () => {
    await assert.rejects(() => run({ targets: [] }), (error: Error) => error.message === IMPORT_ARGS_INVALID);
    assert.strictEqual(h.calls.length, 0);
  });

  test('замок занят до вызова → сообщение «уже выполняется», undefined, чужой замок не снят, picker не вызван', async () => {
    assert.strictEqual(await tryBeginConfigurationOperation(), true);
    assert.strictEqual(await run({ targets: 'all' }), undefined);
    assert.ok(toastMessages('info').some((m) => m.includes('уже выполняется')), JSON.stringify(h.p.toasts));
    assert.strictEqual(picked.length, 0);
    assert.strictEqual(h.calls.length, 0);
    assert.strictEqual(isConfigurationOperationRunning(), true);
  });

  test('замок занят между выбором и стартом (picker берёт замок) → то же сообщение, импорта нет, замок не снят', async () => {
    pickAnswer = async (targets) => {
      assert.strictEqual(await tryBeginConfigurationOperation(), true);
      return targets;
    };
    assert.strictEqual(await run(undefined), undefined);
    assert.ok(toastMessages('info').some((m) => m.includes('уже выполняется')), JSON.stringify(h.p.toasts));
    assert.strictEqual(h.calls.length, 0);
    assert.strictEqual(isConfigurationOperationRunning(), true);
  });

  test('нет целей (нет записей и каталога src/cf) → предупреждение NO_IMPORT_TARGETS, undefined', async () => {
    h.p.entries = [];
    removeTreeSync(h.p.cfRoot);
    assert.strictEqual(await run({ targets: 'all' }), undefined);
    assert.deepStrictEqual(toastMessages('warning'), [NO_IMPORT_TARGETS]);
    assert.strictEqual(h.calls.length, 0);
  });

  test('импорт идёт в режиме interactive: в хуки операции пришли обёртки prompt-хуков', async () => {
    await run({ targets: 'all' });
    for (const call of h.calls) {
      const hooks = call.hooks as unknown as Record<string, unknown>;
      assert.strictEqual(typeof hooks.confirmMirrorSeed, 'function');
      assert.strictEqual(typeof hooks.confirmFullDump, 'function');
      assert.strictEqual(typeof hooks.confirmOrphanRemoval, 'function');
    }
  });
});

suite('registerImportConfigurationsCommand', function () {
  this.timeout(60_000);
  let h: ImportHarness;
  let context: vscode.ExtensionContext;

  setup(async () => {
    h = await createImportHarness();
    // Расширение в тестовом хосте не активируется (нет рабочей папки), поэтому повторной регистрации нет.
    context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
  });
  teardown(async () => {
    for (const disposable of context.subscriptions) { disposable.dispose(); }
    await h.dispose();
  });

  test('команда v8vscedit.importConfigurations зарегистрирована', async () => {
    registerImportConfigurationsCommand(context, h.p.services);
    assert.ok((await vscode.commands.getCommands(true)).includes('v8vscedit.importConfigurations'));
  });

  test("executeCommand с { targets: ['Нет'] } → rejection с причиной; импорта нет", async () => {
    registerImportConfigurationsCommand(context, h.p.services);
    await assert.rejects(
      () => Promise.resolve(vscode.commands.executeCommand('v8vscedit.importConfigurations', { targets: ['Нет'] })),
      /Неизвестные цели импорта: «Нет»/
    );
    assert.strictEqual(h.calls.length, 0);
  });

  test("executeCommand с { targets: ['Расш'] } → импорт расширения без окна выбора", async () => {
    registerImportConfigurationsCommand(context, h.p.services);
    await vscode.commands.executeCommand('v8vscedit.importConfigurations', { targets: ['Расш'] });
    assert.deepStrictEqual(h.calls.map((c) => c.target.name), ['Расш']);
  });
});
