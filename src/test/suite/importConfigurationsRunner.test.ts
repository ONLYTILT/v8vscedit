/**
 * Общий раннер импорта `runImportTargets` (`ui/commands/ext/importConfigurationsRunner.ts`): порядок целей,
 * остановка на первой неудаче, перезагрузка дерева, пометка «чисто», тосты только в interactive, прогресс
 * статус-бара, автономный сервер. Стенд — `support/importHarness.ts`: настоящие раннеры импорта и общий
 * раннер, подменён только агент 1С (шов реестра); окна в unattended запрещены.
 */
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { SERVER_DUMP_POLICY } from '../../infra/agent/sync/SyncPlanner';
import { describeUnattendedFullDumpRefusal } from '../../ui/commands/ext/agent/unattendedAgentHooks';
import { collectImportTargets } from '../../ui/commands/ext/importTargets';
import { runImportTargets } from '../../ui/commands/ext/importConfigurationsRunner';
import { createImportHarness, type ImportHarness } from './support/importHarness';
import { removeTreeSync } from './support/tempTree';

const refusalText = (name: string, rootPath: string, kind: 'cf' | 'cfe'): string => describeUnattendedFullDumpRefusal({
  targetKind: kind, targetName: name, projectDir: rootPath, operation: 'import', reason: 'mirror-empty',
  reasonText: SERVER_DUMP_POLICY['mirror-empty'].text, download: SERVER_DUMP_POLICY['mirror-empty'].download,
});

for (const interaction of ['interactive', 'unattended'] as const) {
  suite(`runImportTargets [${interaction}]`, function () {
    this.timeout(60_000);
    let h: ImportHarness;

    const all = () => collectImportTargets(h.p.entries, h.p.root);
    const toasts = (): string[] => h.p.toasts.map((t) => `${t.kind}: ${t.message}`);
    const infoToasts = (): string[] => h.p.toasts.filter((t) => t.kind === 'info').map((t) => t.message);

    setup(async () => {
      h = await createImportHarness();
      if (interaction === 'unattended') {
        h.forbidWindows();
      }
    });
    teardown(async () => { await h.dispose(); });

    test('две цели успешны: порядок cf → cfe, один reloadEntries, обе помечены чистыми, хуки гасят перезагрузку по файлам; тост «Импортировано» только в interactive', async () => {
      const changed = path.join(h.p.cfRoot, 'Catalogs', 'Товары.xml');
      h.behavior.set('Основная', () => Promise.resolve([changed]));

      // Вход намеренно в обратном порядке: раннер сам упорядочивает.
      const result = await runImportTargets(h.p.services, [...all()].reverse(), interaction);

      assert.deepStrictEqual(result.results.map((r) => [r.name, r.status]), [['Основная', 'imported'], ['Расш', 'imported']]);
      assert.strictEqual(result.error, undefined);
      assert.deepStrictEqual(h.calls.map((c) => c.target.name), ['Основная', 'Расш']);
      assert.strictEqual(h.p.reloads, 1);
      assert.deepStrictEqual(h.p.cleaned.flat().sort(), [h.p.cfRoot, h.p.cfeRoot].sort());
      assert.deepStrictEqual(h.p.suppressCalls, [[changed]]);
      assert.deepStrictEqual(infoToasts(), interaction === 'interactive' ? ['Импортировано конфигураций: 2.'] : []);
      assert.deepStrictEqual(h.violations, []);
      assert.deepStrictEqual(h.p.processing.at(-1), { active: false });
    });

    test('одна цель успешна: тоста «Импортировано» нет (N = 1)', async () => {
      const result = await runImportTargets(h.p.services, all().filter((t) => t.kind === 'cf'), interaction);
      assert.deepStrictEqual(result.results.map((r) => r.status), ['imported']);
      assert.deepStrictEqual(infoToasts(), []);
      assert.strictEqual(h.p.reloads, 1);
    });

    test('дубликаты целей во входе → импорт один раз', async () => {
      const cfTarget = all().find((t) => t.kind === 'cf');
      assert.ok(cfTarget);
      const result = await runImportTargets(h.p.services, [cfTarget, cfTarget], interaction);
      assert.strictEqual(h.calls.length, 1);
      assert.strictEqual(result.results.length, 1);
    });

    test('исключение цели (batch без env.json): цель failed с текстом; тост «Ошибка импорта конфигураций.» только в interactive', async () => {
      await vscodeSetOperationMode('batch');
      removeTreeSync(path.join(h.p.root, 'env.json'));

      const result = await runImportTargets(h.p.services, all().filter((t) => t.kind === 'cf'), interaction);

      assert.strictEqual(result.results[0].status, 'failed');
      assert.ok((result.results[0].reason ?? '').length > 0);
      assert.strictEqual(h.p.reloads, 0);
      const errors = h.p.toasts.filter((t) => t.kind === 'error');
      if (interaction === 'interactive') {
        assert.strictEqual(errors.length, 1, toasts().join(' | '));
        assert.ok(errors[0].message.includes('Ошибка импорта конфигураций.'), errors[0].message);
      } else {
        assert.deepStrictEqual(h.violations, []);
      }
      assert.deepStrictEqual(h.p.processing.at(-1), { active: false });
    });

    test('ошибка вне цели (refreshHealth бросает): result.error; interactive — тост ошибки; прогресс погашен', async () => {
      h.standalone.refreshError = new Error('сервер недоступен');

      const result = await runImportTargets(h.p.services, all(), interaction);

      assert.ok((result.error ?? '').includes('сервер недоступен'), String(result.error));
      assert.strictEqual(h.calls.length, 0);
      if (interaction === 'interactive') {
        assert.strictEqual(h.p.toasts.filter((t) => t.kind === 'error').length, 1, toasts().join(' | '));
      } else {
        assert.deepStrictEqual(h.violations, []);
      }
      assert.deepStrictEqual(h.p.processing.at(-1), { active: false });
    });

    test('автономный сервер запущен: останавливается, после полного успеха запускается; не поднялся — предупреждение в result.warnings (unattended)', async () => {
      h.standalone.configured = true;
      h.standalone.state = 'running';
      h.standalone.startState = 'stopped';

      const result = await runImportTargets(h.p.services, all(), interaction);

      assert.strictEqual(h.standalone.stops.length, 1);
      assert.strictEqual(h.standalone.starts.length, 1);
      if (interaction === 'unattended') {
        assert.strictEqual(result.warnings.length, 1);
        assert.ok(result.warnings[0].includes('сервер не поднялся'), result.warnings[0]);
        assert.deepStrictEqual(h.violations, []);
      } else {
        assert.deepStrictEqual(result.warnings, []);
        assert.strictEqual(h.p.toasts.filter((t) => t.kind === 'warning').length, 1, toasts().join(' | '));
      }
    });
  });
}

suite('runImportTargets: отказ unattended (полная выгрузка)', function () {
  this.timeout(60_000);
  let h: ImportHarness;
  const all = () => collectImportTargets(h.p.entries, h.p.root);

  setup(async () => {
    h = await createImportHarness();
    h.forbidWindows();
  });
  teardown(async () => { await h.dispose(); });

  test('cf отказ → cf failed (requiresUserAction, текст), cfe skipped; reloadEntries не вызван; корни не помечены; автономный сервер не перезапускается', async () => {
    h.standalone.configured = true;
    h.standalone.state = 'running';
    h.behavior.set('Основная', h.askFullDump('mirror-empty'));

    const result = await runImportTargets(h.p.services, all(), 'unattended');

    assert.deepStrictEqual(result.results.map((r) => r.status), ['failed', 'skipped']);
    assert.strictEqual(result.results[0].requiresUserAction, true);
    assert.strictEqual(result.results[0].reason, refusalText('Основная', h.p.cfRoot, 'cf'));
    assert.strictEqual(result.results[1].reason, 'Не выполнялся: импорт остановлен на «Основная».');
    assert.strictEqual(h.calls.length, 1, 'вторая цель не запускалась');
    assert.strictEqual(h.p.reloads, 0);
    assert.deepStrictEqual(h.p.cleaned.flat(), []);
    assert.strictEqual(h.standalone.stops.length, 1);
    assert.strictEqual(h.standalone.starts.length, 0);
    assert.deepStrictEqual(h.violations, []);
  });

  test('cf успех, cfe отказ → reloadEntries вызван (хотя бы одна цель импортирована), помечен только cf', async () => {
    h.behavior.set('Расш', h.askFullDump('mirror-empty'));

    const result = await runImportTargets(h.p.services, all(), 'unattended');

    assert.deepStrictEqual(result.results.map((r) => r.status), ['imported', 'failed']);
    assert.strictEqual(result.results[1].reason, refusalText('Расш', h.p.cfeRoot, 'cfe'));
    assert.strictEqual(h.p.reloads, 1);
    assert.deepStrictEqual(h.p.cleaned.flat(), [h.p.cfRoot]);
    assert.deepStrictEqual(h.violations, []);
  });
});

async function vscodeSetOperationMode(value: string): Promise<void> {
  await vscode.workspace.getConfiguration('v8vscedit.configuration').update('operationMode', value, vscode.ConfigurationTarget.Global);
}
