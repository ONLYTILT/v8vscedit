/**
 * Список расширений базы для диалогов (ui/commands/ext/ExtensionListRunner.ts, перенос из ExtensionCommandRunner.ts):
 * `listConnectedDatabaseExtensions` → `ExtensionListResult`, `describeExtensionListFailure(mode, reason)`.
 *
 *  - agent: список запрашивает агент (`properties get --all-extensions`), заглушки не попадают в `names`, а
 *    собираются в `skippedStubs` с строкой журнала; отказ — `unavailable` БЕЗ собственного тоста (диалог покажет текст сам);
 *  - batch: прежний путь через внутренний CLI; без env.json — `unavailable`;
 *  - тексты отказа диалога — точные: batch — прежний (про env.json и 8.3.11), agent — причина агента.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  describeExtensionListFailure,
  listConnectedDatabaseExtensions,
} from '../../ui/commands/ext/ExtensionListRunner';
import { listConnectedDatabaseExtensions as reexported } from '../../ui/commands/ext/ExtensionCommandRunner';
import { RemoteHarness, resetAgentSettings, setAgentSetting } from './support/agentRemoteHarness';
import { removeTreeSync } from './support/tempTree';

async function setOperationMode(value: string | undefined): Promise<void> {
  await vscode.workspace.getConfiguration('v8vscedit.configuration').update('operationMode', value, vscode.ConfigurationTarget.Global);
}

suite('describeExtensionListFailure: точные тексты отказа диалога по режиму', () => {
  test('agent: причина агента после фиксированного префикса', () => {
    assert.strictEqual(
      describeExtensionListFailure('agent', 'Агент не ответил'),
      'Не удалось получить список расширений базы через агента конфигуратора: Агент не ответил'
    );
  });

  test('batch: прежний текст про env.json и версию платформы 8.3.11; причина агента в него не подмешивается', () => {
    const text = describeExtensionListFailure('batch', 'любая причина');
    assert.ok(text.includes('env.json') && text.includes('8.3.11'), text);
    assert.ok(!text.includes('любая причина'), text);
  });
});

suite('ExtensionListRunner: реэкспорт из ExtensionCommandRunner', () => {
  test('ExtensionCommandRunner реэкспортирует ту же функцию (второй копии нет)', () => {
    assert.strictEqual(reexported, listConnectedDatabaseExtensions);
  });
});

suite('listConnectedDatabaseExtensions: agent-режим (удалённый агент, эмулятор)', function () {
  this.timeout(120_000);
  const h = new RemoteHarness();

  setup(async () => { await h.start(); });
  teardown(async () => { await h.dispose(); });

  test('применённые — в names (отсортированы), заглушка — в skippedStubs; строка журнала про заглушку; тоста нет', async () => {
    h.emulator.extensions.addExtension('Б');
    h.emulator.extensions.addExtension('А');
    h.emulator.extensions.addStub('Заглушка');

    const result = await listConnectedDatabaseExtensions(h.folder, h.channel);

    assert.deepStrictEqual(result, { kind: 'ok', names: ['А', 'Б'], skippedStubs: ['Заглушка'] });
    assert.ok(
      h.lines.includes('[agent] Расширение «Заглушка» в базе не применено (заглушка прерванной загрузки) — пропущено'),
      h.lines.join('\n')
    );
    assert.deepStrictEqual(h.errors, []);
    assert.ok(!h.lines.some((line) => line.startsWith('[actions] Старт')), 'внутренний CLI не запускался');
  });

  test('пустая база → ok с пустыми списками', async () => {
    assert.deepStrictEqual(await listConnectedDatabaseExtensions(h.folder, h.channel), { kind: 'ok', names: [], skippedStubs: [] });
  });

  test('отказ агента (пустой UnknownError + log) → unavailable с причиной из log, без тоста', async () => {
    h.emulator.extensions.emptyUnknownErrorOn((command) => command.command === 'config extensions', 'Нет доступа к базе');

    const result = await listConnectedDatabaseExtensions(h.folder, h.channel);

    assert.strictEqual(result.kind, 'unavailable');
    assert.ok(result.reason.includes('Нет доступа к базе'), JSON.stringify(result));
    assert.deepStrictEqual(h.errors, [], 'второго тоста нет: текст покажет диалог');
  });

  test('обрыв агента → unavailable с причиной про потерю соединения', async () => {
    h.emulator.extensions.crashOn((command) => command.command === 'config extensions', 'drop');
    const result = await listConnectedDatabaseExtensions(h.folder, h.channel);
    assert.strictEqual(result.kind, 'unavailable');
    assert.ok(result.reason.includes('Соединение с агентом конфигуратора потеряно'), JSON.stringify(result));
  });
});

suite('listConnectedDatabaseExtensions: batch-режим — прежний путь', function () {
  this.timeout(30_000);
  let root: string;

  setup(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-extlist-batch-')));
    await resetAgentSettings();
    await setAgentSetting('location', 'local');
    await setOperationMode('batch');
  });
  teardown(async () => {
    await resetAgentSettings();
    await setOperationMode(undefined);
    removeTreeSync(root);
  });

  test('нет env.json → unavailable (а не исключение и не пустой список)', async () => {
    const folder = { uri: vscode.Uri.file(root), name: 'batch', index: 0 };
    const channel = { appendLine: () => undefined } as unknown as vscode.OutputChannel;

    const result = await listConnectedDatabaseExtensions(folder, channel);

    assert.strictEqual(result.kind, 'unavailable');
    assert.strictEqual(typeof result.reason, 'string');
  });
});
