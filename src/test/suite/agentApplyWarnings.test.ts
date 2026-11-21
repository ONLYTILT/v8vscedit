/**
 * Агентские точки входа применения расширения к базе (ExtensionCommandRunner): исход применения несёт
 * предупреждения сверки (E11), отказ — `success: false` без предупреждений; полное и частичное обновление
 * расширения передают предупреждения сервиса в UI. Удалённый агент — эмулятор поверх настоящего ssh2.
 */
import * as assert from 'assert';
import * as path from 'path';
import {
  runApplyDatabaseConfigurationWithOutcome,
  runCompileExtension,
  runUpdateExtension,
} from '../../ui/commands/ext/ExtensionCommandRunner';
import * as fs from 'fs';
import { runLoadConfigurationFromCf } from '../../ui/commands/ext/CfFileCommandRunner';
import { cfeFile } from './support/agentExtensionsEmulator';
import { RemoteHarness } from './support/agentRemoteHarness';
import { FakeLagRecorder } from './support/databaseLagFakes';

suite('Агентское применение расширения: исход с предупреждениями', function () {
  this.timeout(120_000);
  const h = new RemoteHarness();

  setup(async () => { await h.start(); });
  teardown(async () => { await h.dispose(); });

  test('применение отсутствующего расширения → success=false (E6), предупреждений нет, update-db-cfg не отправлен', async () => {
    const outcome = await runApplyDatabaseConfigurationWithOutcome(
      { kind: 'cfe', name: 'Нет', extensionName: 'Нет', rootPath: path.join(h.root, 'src', 'cfe', 'Нет') },
      h.folder,
      h.channel,
      new FakeLagRecorder()
    );

    assert.deepStrictEqual(outcome, { success: false, warnings: [] });
    assert.ok(h.errors.some((message) => message.includes('применять нечего')), h.errors.join('|'));
    assert.ok(!h.server.shellLog.flat().some((line) => line.startsWith('config update-db-cfg')));
  });

  test('применение существующего → success=true, предупреждений нет', async () => {
    h.emulator.extensions.addExtension('Расш');
    const outcome = await runApplyDatabaseConfigurationWithOutcome(
      { kind: 'cfe', name: 'Расш', extensionName: 'Расш', rootPath: path.join(h.root, 'src', 'cfe', 'Расш') },
      h.folder,
      h.channel,
      new FakeLagRecorder()
    );
    assert.deepStrictEqual(outcome, { success: true, warnings: [] });
  });

  test('применение существующего, загруженного файлом с другим внутренним именем → E11: в исходе и уведомлением (не silent)', async () => {
    h.emulator.extensions.addExtension('Расш', 'старое');
    const inputFile = path.join(h.base, 'Z.cfe');
    fs.writeFileSync(inputFile, cfeFile('Другое', 'новое'));
    const loaded = await runLoadConfigurationFromCf({ workspaceFolder: h.folder, outputChannel: h.channel, inputFile, extensionName: 'Расш', silent: true });
    assert.strictEqual(loaded.success, true, loaded.failureReason);

    const target = { kind: 'cfe' as const, name: 'Расш', extensionName: 'Расш', rootPath: path.join(h.root, 'src', 'cfe', 'Расш') };
    const outcome = await runApplyDatabaseConfigurationWithOutcome(target, h.folder, h.channel, new FakeLagRecorder());

    assert.strictEqual(outcome.success, true);
    assert.ok(outcome.warnings.some((warning) => warning.includes('«Другое»') && warning.includes('«Расш»')), outcome.warnings.join('|'));
    assert.ok(h.warnings.some((warning) => warning.includes('«Другое»')), 'UI показывает E11 уведомлением');
  });

  const updates: [string, (root: string) => Promise<boolean>][] = [
    ['runCompileExtension (полная загрузка)', (root) => runCompileExtension('Расш', root, h.folder, h.channel, false, new FakeLagRecorder())],
    ['runUpdateExtension (изменённые файлы)', (root) => runUpdateExtension('Расш', root, h.folder, h.channel, false, undefined, { updateDatabase: true, lag: new FakeLagRecorder() })],
  ];
  for (const [title, run] of updates) {
    test(`${title}: агентская операция исполняется (каталога расширения нет → отказ с тостом, без исключения)`, async () => {
      const ok = await run(path.join(h.root, 'src', 'cfe', 'Расш'));
      assert.strictEqual(ok, false);
      assert.ok(h.errors.length > 0, 'отказ показан пользователю');
    });
  }
});
