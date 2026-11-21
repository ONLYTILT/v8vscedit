/**
 * Добор покрытия импорта конфигураций реальными сценариями: исключения не-Error в общем раннере, исходы
 * `summarizeImportRun` без причины и без `requiresUserAction`, отмена и сбой агентского импорта (cf и cfe),
 * успешный пакетный импорт с заменой выгрузки и хуками (afterSuccess).
 *
 * Единственная подмена в пакетном сценарии — «1cv8»: крошечная программа-заглушка (внешняя недоступная
 * система), которая пишет файлы выгрузки по `/DumpConfigToFiles` и завершается с кодом 0. На Windows она
 * собирается штатным csc.exe, на прочих ОС — shell-скрипт; нет компилятора — тест пропускается.
 */
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentSyncCancelledError } from '../../infra/agent/sync/SyncContext';
import { disposeCachedAgentOperationServices } from '../../ui/commands/ext/agent/AgentServiceRegistry';
import * as extensionRunner from '../../ui/commands/ext/ExtensionCommandRunner';
import { runDecompileExtension, runDecompileMainConfiguration } from '../../ui/commands/ext/ExtensionCommandRunner';
import type { ConfigurationImportOutcome } from '../../ui/commands/ext/configurationOperationTypes';
import { runImportTargets } from '../../ui/commands/ext/importConfigurationsRunner';
import { collectImportTargets, summarizeImportRun, type ImportTarget } from '../../ui/commands/ext/importTargets';
import { createImportHarness, type ImportHarness } from './support/importHarness';
import { removeTreeSync } from './support/tempTree';

const REAL_DECOMPILE = {
  main: extensionRunner.runDecompileMainConfiguration,
  ext: extensionRunner.runDecompileExtension,
};

suite('runImportTargets: исключения не-Error', function () {
  this.timeout(60_000);
  let h: ImportHarness;
  const all = (): ImportTarget[] => collectImportTargets(h.p.entries, h.p.root);
  setup(async () => { h = await createImportHarness(); });
  teardown(async () => {
    const ref = extensionRunner as unknown as Record<string, unknown>;
    ref.runDecompileMainConfiguration = REAL_DECOMPILE.main;
    ref.runDecompileExtension = REAL_DECOMPILE.ext;
    await h.dispose();
  });

  for (const interaction of ['interactive', 'unattended'] as const) {
    test(`[${interaction}] ошибка вне цели (refreshHealth отклоняется строкой): result.error — эта строка`, async () => {
      if (interaction === 'unattended') { h.forbidWindows(); }
      h.standalone.refreshError = 'сервер упал' as unknown as Error;
      const result = await runImportTargets(h.p.services, all(), interaction);
      assert.strictEqual(result.error, 'сервер упал');
      assert.deepStrictEqual(h.violations, []);
    });

    test(`[${interaction}] раннер цели отклоняется строкой: цель failed с этой причиной, остальные skipped`, async () => {
      if (interaction === 'unattended') { h.forbidWindows(); }
      // Намеренно не-Error: проверяется ветка String(caught).
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      (extensionRunner as unknown as Record<string, unknown>).runDecompileMainConfiguration = () => Promise.reject('строковый сбой');
      const result = await runImportTargets(h.p.services, all(), interaction);
      assert.deepStrictEqual(result.results.map((r) => [r.status, r.reason]), [
        ['failed', 'строковый сбой'],
        ['skipped', 'Не выполнялся: импорт остановлен на «Основная».'],
      ]);
      assert.deepStrictEqual(h.violations, []);
    });
  }
});

suite('summarizeImportRun: исходы отказа без деталей', () => {
  const targets: ImportTarget[] = [
    { kind: 'cf', name: 'Основная', rootPath: 'C:\\ws\\src\\cf' },
    { kind: 'cfe', name: 'Расш', rootPath: 'C:\\ws\\src\\cfe\\Расш' },
  ];

  test('отказ без причины и без requiresUserAction: ключей reason/requiresUserAction нет', () => {
    const [first] = summarizeImportRun(targets, [{ success: false, warnings: [] }]);
    assert.strictEqual(first.status, 'failed');
    assert.strictEqual('reason' in first, false);
    assert.strictEqual('requiresUserAction' in first, false);
  });

  test('отказ с причиной, но без requiresUserAction; следующая цель — skipped', () => {
    const results = summarizeImportRun(targets, [{ success: false, reason: 'сбой', warnings: ['w'] }]);
    assert.strictEqual(results[0].reason, 'сбой');
    assert.strictEqual('requiresUserAction' in results[0], false);
    assert.deepStrictEqual(results[0].warnings, ['w']);
    assert.strictEqual(results[1].status, 'skipped');
  });

  test('отказ с requiresUserAction: true и без причины', () => {
    const [first] = summarizeImportRun(targets, [{ success: false, requiresUserAction: true, warnings: [] }]);
    assert.strictEqual(first.requiresUserAction, true);
    assert.strictEqual('reason' in first, false);
  });

  test('исходов нет: причина — «прерван до запуска цели»', () => {
    const results = summarizeImportRun(targets, []);
    assert.deepStrictEqual(
      results.map((r) => r.reason),
      ['Не выполнялся: импорт прерван до запуска цели.', 'Не выполнялся: импорт прерван до запуска цели.']
    );
  });
});

for (const kind of ['cf', 'cfe'] as const) {
  suite(`runDecompile* [agent, ${kind}]: отмена и сбой агента → onOutcome`, function () {
    this.timeout(60_000);
    let h: ImportHarness;
    const NAME = kind === 'cf' ? 'Основная' : 'Расш';
    const run = (onOutcome: (o: ConfigurationImportOutcome) => void): Promise<boolean> => {
      const root = kind === 'cf' ? h.p.cfRoot : h.p.cfeRoot;
      const options = { interaction: 'unattended' as const, onOutcome };
      return kind === 'cf'
        ? runDecompileMainConfiguration(NAME, root, h.p.services.workspaceFolder, h.p.services.outputChannel, undefined, options)
        : runDecompileExtension(NAME, root, h.p.services.workspaceFolder, h.p.services.outputChannel, undefined, options);
    };
    setup(async () => { h = await createImportHarness(); h.forbidWindows(); });
    teardown(async () => { await h.dispose(); });

    test('AgentSyncCancelledError: cancelled: true без requiresUserAction', async () => {
      h.behavior.set(NAME, () => Promise.reject(new AgentSyncCancelledError()));
      const outcomes: ConfigurationImportOutcome[] = [];
      assert.strictEqual(await run((o) => { outcomes.push(o); }), false);
      assert.strictEqual(outcomes.length, 1);
      assert.strictEqual(outcomes[0].success, false);
      assert.strictEqual(outcomes[0].cancelled, true);
      assert.strictEqual('requiresUserAction' in outcomes[0], false);
    });

    test('прочий сбой: ни cancelled, ни requiresUserAction', async () => {
      h.behavior.set(NAME, () => Promise.reject(new Error('сбой агента')));
      const outcomes: ConfigurationImportOutcome[] = [];
      assert.strictEqual(await run((o) => { outcomes.push(o); }), false);
      assert.deepStrictEqual(outcomes, [{ success: false, reason: 'сбой агента', warnings: [] }]);
    });
  });
}

/** Собирает заглушку «1cv8»; `undefined` — собрать нечем. */
function buildDesignerStub(dir: string): string | undefined {
  if (process.platform !== 'win32') {
    const script = path.join(dir, '1cv8');
    fs.writeFileSync(script, [
      '#!/bin/sh',
      'while [ $# -gt 0 ]; do',
      '  if [ "$1" = "/DumpConfigToFiles" ]; then mkdir -p "$2/Catalogs"; echo "<MetaDataObject/>" > "$2/Configuration.xml"; echo "<Catalog/>" > "$2/Catalogs/Items.xml"; fi',
      '  shift',
      'done',
      'exit 0',
    ].join('\n') + '\n', { mode: 0o755 });
    return script;
  }
  const windir = process.env.SystemRoot ?? 'C:\\Windows';
  const csc = path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!fs.existsSync(csc)) {
    return undefined;
  }
  const source = path.join(dir, 'stub.cs');
  fs.writeFileSync(source, [
    'using System.IO;',
    'class P { static int Main(string[] a) {',
    '  for (int i = 0; i < a.Length - 1; i++) { if (a[i] == "/DumpConfigToFiles") {',
    '    Directory.CreateDirectory(Path.Combine(a[i + 1], "Catalogs"));',
    '    File.WriteAllText(Path.Combine(a[i + 1], "Configuration.xml"), "<MetaDataObject/>");',
    '    File.WriteAllText(Path.Combine(a[i + 1], "Catalogs", "Items.xml"), "<Catalog/>");',
    '  } }',
    '  return 0; } }',
  ].join('\r\n'));
  const exe = path.join(dir, '1cv8.exe');
  execFileSync(csc, ['/nologo', `/out:${exe}`, source], { stdio: 'ignore' });
  return exe;
}

for (const kind of ['cf', 'cfe'] as const) {
  suite(`runDecompile* [batch, ${kind}]: успешный импорт`, function () {
    this.timeout(180_000);
    let h: ImportHarness;
    let stubDir: string;
    const NAME = kind === 'cf' ? 'Основная' : 'Расш';

    setup(async () => {
      h = await createImportHarness();
      stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-designer-stub-'));
    });
    teardown(async () => {
      removeTreeSync(stubDir);
      await h.dispose();
    });

    for (const interaction of ['interactive', 'unattended'] as const) {
      test(`[${interaction}] выгрузка заменяет файлы цели, хуки прогресса и beforeProjectFilesChanged вызваны, onOutcome — успех`, async function () {
        const stub = buildDesignerStub(stubDir);
        if (!stub) { this.skip(); }
        // Пакетный режим не использует агента: фейковый сервис стенда не должен подхватываться при освобождении ИБ.
        await disposeCachedAgentOperationServices();
        await vscode.workspace.getConfiguration('v8vscedit.configuration').update('operationMode', 'batch', vscode.ConfigurationTarget.Global);
        fs.writeFileSync(path.join(h.p.root, 'env.json'), JSON.stringify({
          default: { '--ibconnection': `/F${path.join(h.p.root, 'base')}`, '--path': stub },
        }), 'utf-8');
        if (interaction === 'unattended') { h.forbidWindows(); }
        const root = kind === 'cf' ? h.p.cfRoot : h.p.cfeRoot;
        const progress: string[] = [];
        const beforeChange: string[][] = [];
        const outcomes: ConfigurationImportOutcome[] = [];
        const hooks = {
          onProgressMessage: (message: string) => { progress.push(message); },
          beforeProjectFilesChanged: (files: string[]) => { beforeChange.push(files); },
        };
        const options = { interaction, onOutcome: (o: ConfigurationImportOutcome) => { outcomes.push(o); } };
        const services = h.p.services;
        const lines: string[] = [];
        const channel = { appendLine: (line: string) => { lines.push(line); }, show: () => undefined } as unknown as vscode.OutputChannel;

        const ok = kind === 'cf'
          ? await runDecompileMainConfiguration(NAME, root, services.workspaceFolder, channel, hooks, options)
          : await runDecompileExtension(NAME, root, services.workspaceFolder, channel, hooks, options);

        assert.strictEqual(ok, true, progress.concat(lines).join(' | '));
        assert.deepStrictEqual(outcomes, [{ success: true, warnings: [] }]);
        assert.ok(fs.existsSync(path.join(root, 'Catalogs', 'Items.xml')), 'файл выгрузки заменил содержимое цели');
        assert.ok(progress.some((m) => m.startsWith('замена файлов выгрузки:')), progress.join(' | '));
        assert.ok(progress.includes('обновление кэша метаданных'), progress.join(' | '));
        assert.strictEqual(beforeChange.length, 2, 'хук вызывается до и после замены');
        assert.deepStrictEqual(h.violations, []);
      });
    }
  });
}
