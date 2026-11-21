/**
 * Раннеры загрузки в агентском режиме (`ExtensionCommandRunner`): `runUpdateMainConfiguration`,
 * `runUpdateExtension`, `runCompileExtension`, `runApplyDatabaseConfiguration` + признак «БД отстаёт».
 * Параметризация `location ∈ {local, remote}` × `kind ∈ {cf, cfe}` × `updateDatabase ∈ {true, false}`;
 * агент 1С — эмулятор, файлы и SFTP — настоящие.
 *
 * Правила признака (plan §2 + решения оркестратора):
 *  - загрузка без обновления прошла → `markBehind('load-without-update')`;
 *  - загрузка с обновлением: хук `onConfigurationLoaded` ставит `update-failed` ДО `update-db-cfg`, успешный
 *    `update-db-cfg` снимает отметку (`markCurrent`);
 *  - сбой самой загрузки — тоже отметка (консервативно: атомарность частичной загрузки не замерена);
 *  - skipped (изменений нет) признак не трогает, КРОМЕ отстающей цели при `updateDatabase=true` — тогда БД
 *    обновляется (иначе «Обновить в базе» молча говорило бы «изменений нет», а применить отставание нечем);
 *  - cfe без расширения в базе: отказ ДО загрузки, признак не меняется.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  runApplyDatabaseConfiguration,
  runCompileExtension,
  runUpdateExtension,
  runUpdateMainConfiguration,
} from '../../ui/commands/ext/ExtensionCommandRunner';
import { describeLoadWithoutUpdateSuccess } from '../../ui/commands/ext/databaseLoadPlan';
import { emulatedFailure } from './support/agentExtensionsEmulator';
import { openLocal, openRemote, type UiStand } from './support/agentUiStands';
import { FakeLagRecorder } from './support/databaseLagFakes';

type Kind = 'cf' | 'cfe';

for (const location of ['local', 'remote'] as const) {
  for (const kind of ['cf', 'cfe'] as Kind[]) {
    suite(`Раннеры загрузки и признак отставания БД [${location}, ${kind}]`, function () {
      this.timeout(120_000);
      let ui: UiStand;
      let lag: FakeLagRecorder;
      let root: string;
      const NAME = kind === 'cf' ? 'Основная' : 'Расш';
      const target = () => (kind === 'cf'
        ? { kind: 'cf' as const, name: NAME, rootPath: root }
        : { kind: 'cfe' as const, name: NAME, rootPath: root, extensionName: NAME });
      const run = (updateDatabase: boolean, showSuccess = true): Promise<boolean> => (kind === 'cf'
        ? runUpdateMainConfiguration(NAME, root, ui.folder, ui.channel, showSuccess, undefined, { updateDatabase, lag })
        : runUpdateExtension(NAME, root, ui.folder, ui.channel, showSuccess, undefined, { updateDatabase, lag }));
      const verbs = (): string[] => ui.commandLog().map((line) => line.split(' --')[0]);
      const updates = (): string[] => verbs().filter((verb) => verb === 'config update-db-cfg');
      const edit = (version: string): void => {
        fs.writeFileSync(path.join(root, 'Catalogs', 'Товары.xml'), `<Catalog>${version}</Catalog>`, 'utf-8');
      };

      setup(async () => {
        ui = location === 'remote' ? await openRemote() : await openLocal();
        lag = new FakeLagRecorder();
        root = path.join(ui.folder.uri.fsPath, 'src', ...(kind === 'cf' ? ['cf'] : ['cfe', NAME]));
        fs.mkdirSync(path.join(root, 'Catalogs'), { recursive: true });
        fs.writeFileSync(path.join(root, 'Configuration.xml'), '<MetaDataObject/>', 'utf-8');
        edit('v1');
        if (kind === 'cfe') {
          ui.emulator.extensions.addExtension(NAME);
        }
      });
      teardown(async () => { await ui.dispose(); });

      test('updateDatabase=false: загрузка без update-db-cfg, отметка load-without-update, итоговое сообщение про необновлённую БД', async () => {
        assert.strictEqual(await run(false), true);

        assert.deepStrictEqual(updates(), []);
        assert.ok(verbs().includes('config load-config-from-files'));
        assert.strictEqual(lag.sourceOf(target()), 'load-without-update');
        assert.ok(ui.everythingShown().includes(describeLoadWithoutUpdateSuccess(NAME)), ui.everythingShown());
      });

      test('updateDatabase=true: загрузка и update-db-cfg, отметка снята; сообщения про необновлённую БД нет', async () => {
        lag.markBehind(target(), 'load-without-update');

        assert.strictEqual(await run(true), true);

        assert.strictEqual(updates().length, 1);
        assert.strictEqual(lag.isBehind(target()), false);
        assert.ok(!ui.everythingShown().includes('Конфигурация БД не обновлена'), ui.everythingShown());
      });

      test('updateDatabase=true: отметка update-failed ставится ДО update-db-cfg (хук), поэтому сбой реструктуризации оставляет её', async () => {
        ui.emulator.extensions.failOn((command) => command.command === 'config update-db-cfg', emulatedFailure('UnknownError', 'Реструктуризация прервана'));

        assert.strictEqual(await run(true), false);

        assert.strictEqual(lag.sourceOf(target()), 'update-failed');
        assert.ok(ui.errors.length > 0, 'ошибка показана пользователю');
      });

      test('updateDatabase=true: обрыв соединения на update-db-cfg → отметка update-failed остаётся', async () => {
        ui.emulator.extensions.crashOn((command) => command.command === 'config update-db-cfg', 'drop');

        assert.strictEqual(await run(true), false);

        assert.strictEqual(lag.sourceOf(target()), 'update-failed');
      });

      for (const updateDatabase of [true, false]) {
        test(`сбой самой загрузки (updateDatabase=${String(updateDatabase)}): консервативно — отметка стоит, update-db-cfg не отправлен`, async () => {
          ui.emulator.failWhen = (command) => (command.command === 'config load-config-from-files' ? new Error('Ошибка загрузки файлов') : undefined);

          assert.strictEqual(await run(updateDatabase), false);

          assert.strictEqual(lag.isBehind(target()), true);
          assert.deepStrictEqual(updates(), []);
        });
      }

      test('изменений нет, цель не отстаёт: ни update-db-cfg, ни отметки (updateDatabase=true и false)', async () => {
        assert.strictEqual(await run(true), true);
        lag.markCurrent(target());
        lag.calls.length = 0;
        const before = ui.commandLog().length;

        assert.strictEqual(await run(true), true);
        assert.strictEqual(await run(false), true);

        const added = ui.commandLog().slice(before).map((line) => line.split(' --')[0]);
        assert.ok(!added.includes('config update-db-cfg') && !added.includes('config load-config-from-files'), added.join('|'));
        assert.deepStrictEqual(lag.calls.filter((call) => call.op === 'behind'), []);
      });

      test('изменений нет, цель ОТСТАЁТ, updateDatabase=true: БД обновляется (update-only), отметка снята', async () => {
        assert.strictEqual(await run(true), true);
        lag.markBehind(target(), 'load-without-update');
        const updatesBefore = updates().length;

        assert.strictEqual(await run(true), true);

        assert.strictEqual(updates().length, updatesBefore + 1);
        assert.strictEqual(lag.isBehind(target()), false);
      });

      test('изменений нет, цель отстаёт, updateDatabase=false: ничего не отправляется, отметка остаётся', async () => {
        assert.strictEqual(await run(true), true);
        lag.markBehind(target(), 'load-without-update');
        const before = ui.commandLog().length;

        assert.strictEqual(await run(false), true);

        const added = ui.commandLog().slice(before).map((line) => line.split(' --')[0]);
        assert.ok(!added.includes('config update-db-cfg') && !added.includes('config load-config-from-files'), added.join('|'));
        assert.strictEqual(lag.isBehind(target()), true);
      });

      test('правка после первой загрузки (частичная загрузка): те же правила, что у полной', async () => {
        assert.strictEqual(await run(true), true);
        edit('v2');
        lag.calls.length = 0;
        // Удалённому агенту после полной загрузки архивом частичной нужно зеркало на сервере: соглашаемся на его
        // подготовку (кнопка вопроса promptLoadMirrorDump), локальный агент вопроса не задаёт.
        const windowRef = vscode.window as unknown as Record<string, unknown>;
        const harnessWarning = windowRef.showWarningMessage;
        windowRef.showWarningMessage = (_message: string, ...items: unknown[]) =>
          Promise.resolve(items.find((item) => item === 'Выгрузить на сервере'));
        try {
          assert.strictEqual(await run(false), true);
        } finally {
          windowRef.showWarningMessage = harnessWarning;
        }

        assert.strictEqual(lag.sourceOf(target()), 'load-without-update');
        assert.strictEqual(updates().length, 1, 'update-db-cfg был только у первой загрузки');
      });

      test('отказ от подготовки зеркала агента перед частичной загрузкой: отмена до изменения базы — признак не ставится', async () => {
        if (location !== 'remote') {
          return; // локальный агент зеркало на сервере не готовит — вопроса нет
        }
        assert.strictEqual(await run(true), true);
        edit('v2');
        lag.calls.length = 0;

        // Вопрос о выгрузке на сервере закрыт без ответа (обвязка стенда отвечает undefined) — отмена.
        assert.strictEqual(await run(false), false);

        assert.deepStrictEqual(lag.calls, []);
        assert.ok(ui.everythingShown().includes('Загрузка отменена'), ui.everythingShown());
      });

      test('runApplyDatabaseConfiguration: успех снимает отметку, отказ платформы — оставляет', async () => {
        lag.markBehind(target(), 'load-without-update');
        ui.emulator.extensions.failOn((command) => command.command === 'config update-db-cfg', emulatedFailure('UnknownError', 'Отказ применения'));
        assert.strictEqual(await runApplyDatabaseConfiguration(target(), ui.folder, ui.channel, lag), false);
        assert.strictEqual(lag.isBehind(target()), true);

        assert.strictEqual(await runApplyDatabaseConfiguration(target(), ui.folder, ui.channel, lag), true);
        assert.strictEqual(lag.isBehind(target()), false);
      });
    });
  }

  suite(`Раннеры загрузки cfe: расширения нет в базе [${location}]`, function () {
    this.timeout(120_000);
    let ui: UiStand;
    let lag: FakeLagRecorder;
    let root: string;
    const lagTarget = () => ({ kind: 'cfe' as const, name: 'Расш', rootPath: root, extensionName: 'Расш' });

    setup(async () => {
      ui = location === 'remote' ? await openRemote() : await openLocal();
      lag = new FakeLagRecorder();
      root = path.join(ui.folder.uri.fsPath, 'src', 'cfe', 'Расш');
      fs.mkdirSync(path.join(root, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(root, 'Configuration.xml'), '<MetaDataObject/>', 'utf-8');
      fs.writeFileSync(path.join(root, 'Catalogs', 'Товары.xml'), '<Catalog/>', 'utf-8');
    });
    teardown(async () => { await ui.dispose(); });

    for (const updateDatabase of [true, false]) {
      test(`runUpdateExtension, updateDatabase=${String(updateDatabase)}: отказ ДО загрузки, load-config-from-files не отправлен, заглушки нет, признак не меняется`, async () => {
        const ok = await runUpdateExtension('Расш', root, ui.folder, ui.channel, true, undefined, { updateDatabase, lag });

        assert.strictEqual(ok, false);
        assert.ok(!ui.commandLog().some((line) => line.startsWith('config load-config-from-files')), ui.commandLog().join('\n'));
        assert.strictEqual(ui.emulator.extensions.has('Расш'), false);
        assert.deepStrictEqual(lag.calls, []);
        assert.ok(ui.errors.length > 0);
      });
    }

    test('runApplyDatabaseConfiguration (E6): расширения нет → false, отметка отстающей цели остаётся', async () => {
      lag.markBehind(lagTarget(), 'cf-file-load');
      assert.strictEqual(await runApplyDatabaseConfiguration(lagTarget(), ui.folder, ui.channel, lag), false);
      assert.strictEqual(lag.isBehind(lagTarget()), true);
    });

    test('runCompileExtension: расширение есть, update-db-cfg упал → update-failed; успех — отметка снята', async () => {
      ui.emulator.extensions.addExtension('Расш');
      ui.emulator.extensions.failOn((command) => command.command === 'config update-db-cfg', emulatedFailure('UnknownError', 'Сбой'));
      assert.strictEqual(await runCompileExtension('Расш', root, ui.folder, ui.channel, false, lag), false);
      assert.strictEqual(lag.sourceOf(lagTarget()), 'update-failed');

      assert.strictEqual(await runCompileExtension('Расш', root, ui.folder, ui.channel, false, lag), true);
      assert.strictEqual(lag.isBehind(lagTarget()), false);
    });
  });
}
