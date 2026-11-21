/**
 * Пакетные операции Конфигуратора без участия человека: запасная полная загрузка (`confirmFallback` внутри
 * `c8 ignore`-блока раннера — гейт её не видит, поэтому поведение проверяется здесь), прерывание процесса
 * (отмена/таймаут) и пустая причина отказа агентской загрузки.
 *
 * «1cv8» не запускается: собственный внутренний CLI детерминированно падает на несуществующем `--path` до
 * спавна Конфигуратора. Базовой линии хеш-кэша нет, поэтому изменения «есть» и идёт частичный шаг.
 * Единственная подмена в сценарии прерывания — `withProgress` (кнопка «Отмена» уведомления): токен уже
 * отменён, и `runProcess` честно возвращает `canceled`.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { disposeCachedAgentOperationServices } from '../../ui/commands/ext/agent/AgentServiceRegistry';
import {
  runDecompileExtension,
  runDecompileMainConfiguration,
  runUpdateExtension,
  runUpdateMainConfiguration,
} from '../../ui/commands/ext/ExtensionCommandRunner';
import type { ConfigurationImportOutcome } from '../../ui/commands/ext/configurationOperationTypes';
import { describeUnattendedFullLoadRefusal } from '../../ui/commands/ext/databaseLoadPlan';
import { createImportHarness, type ImportHarness } from './support/importHarness';

type Fn = (...args: never[]) => unknown;
const win = vscode.window as unknown as Record<string, Fn>;

async function useBatchMode(h: ImportHarness): Promise<void> {
  // Пакетный режим не использует агента: фейковый сервис стенда не должен подхватываться при освобождении ИБ.
  await disposeCachedAgentOperationServices();
  await vscode.workspace.getConfiguration('v8vscedit.configuration').update('operationMode', 'batch', vscode.ConfigurationTarget.Global);
  fs.writeFileSync(path.join(h.p.root, 'env.json'), JSON.stringify({
    default: {
      '--ibconnection': `/F${path.join(h.p.root, 'base')}`,
      '--path': path.join(h.p.root, 'нет', 'такого', '1cv8'),
    },
  }), 'utf-8');
}

for (const kind of ['cf', 'cfe'] as const) {
  suite(`Пакетная загрузка: запасная полная загрузка [${kind}]`, function () {
    this.timeout(180_000);
    let h: ImportHarness;
    const NAME = kind === 'cf' ? 'Основная' : 'Расш';
    const label = kind === 'cf' ? `конфигурации "${NAME}"` : `расширения "${NAME}"`;
    const root = (): string => (kind === 'cf' ? h.p.cfRoot : h.p.cfeRoot);
    const load = (updateDatabase: boolean, interaction: 'interactive' | 'unattended', onFailure: (reason: string) => void): Promise<boolean> => {
      const options = { updateDatabase, lag: h.p.lag, interaction, onFailure };
      const services = h.p.services;
      return kind === 'cf'
        ? runUpdateMainConfiguration(NAME, root(), services.workspaceFolder, services.outputChannel, false, undefined, options)
        : runUpdateExtension(NAME, root(), services.workspaceFolder, services.outputChannel, false, undefined, options);
    };

    setup(async () => {
      h = await createImportHarness();
      await useBatchMode(h);
    });
    teardown(async () => { await h.dispose(); });

    for (const updateDatabase of [false, true]) {
      test(`unattended, updateDatabase=${String(updateDatabase)}: модалки нет, false, onFailure с текстом отказа от полной загрузки`, async () => {
        h.forbidWindows();
        const failures: string[] = [];

        assert.strictEqual(await load(updateDatabase, 'unattended', (reason) => { failures.push(reason); }), false);

        assert.deepStrictEqual(h.violations, []);
        assert.strictEqual(failures.length, 1, failures.join(' | '));
        const prefix = `Быстрая загрузка изменений ${label} не выполнена: `;
        const suffix = describeUnattendedFullLoadRefusal(label, '').replace(`Быстрая загрузка изменений ${label} не выполнена`, '');
        assert.ok(failures[0].startsWith(prefix), failures[0]);
        assert.ok(failures[0].endsWith(suffix), failures[0]);
        assert.ok(failures[0].length > prefix.length + suffix.length, 'между префиксом и хвостом — причина сбоя частичной загрузки');
      });
    }

    test('interactive (регресс): модалка confirmFullSyncFallback показана, ответ «Отмена» → false, onFailure не вызван', async () => {
      const dialogs: unknown[][] = [];
      win.showWarningMessage = (...args: unknown[]) => { dialogs.push(args); return Promise.resolve('Отмена'); };
      const failures: string[] = [];

      assert.strictEqual(await load(false, 'interactive', (reason) => { failures.push(reason); }), false);

      assert.strictEqual(dialogs.length, 1);
      assert.ok(String(dialogs[0][0]).includes(`Не удалось выполнить быструю загрузку изменений ${label}`), String(dialogs[0][0]));
      assert.strictEqual((dialogs[0][1] as { modal?: boolean }).modal, true);
      assert.deepStrictEqual(failures, []);
    });

    test('interactive: согласие на полную загрузку → запасной шаг идёт и падает на несуществующем --path; причина уходит в onFailure', async () => {
      win.showWarningMessage = () => Promise.resolve('Выполнить полную загрузку');
      const failures: string[] = [];

      assert.strictEqual(await load(false, 'interactive', (reason) => { failures.push(reason); }), false);

      assert.strictEqual(failures.length, 1, failures.join(' | '));
      assert.ok(failures[0].length > 0);
    });
  });
}

for (const kind of ['cf', 'cfe'] as const) {
  for (const interaction of ['interactive', 'unattended'] as const) {
    suite(`runInternalCliCommand: прерывание процесса [${kind}, ${interaction}]`, function () {
      this.timeout(120_000);
      let h: ImportHarness;
      const NAME = kind === 'cf' ? 'Основная' : 'Расш';
      const title = kind === 'cf'
        ? `Выгрузка основной конфигурации ${NAME} во внутренний XML`
        : `Выгрузка расширения ${NAME} во внутренний XML`;
      const original = vscode.window.withProgress;
      const infos: string[] = [];

      setup(async () => {
        h = await createImportHarness();
        await useBatchMode(h);
        infos.length = 0;
        if (interaction === 'unattended') {
          h.forbidWindows();
        } else {
          win.showInformationMessage = (message: string) => { infos.push(message); return Promise.resolve(undefined); };
        }
        // Кнопка «Отмена» уведомления уже нажата: токен отменён до старта процесса.
        (vscode.window as unknown as { withProgress: unknown }).withProgress = (
          _options: unknown,
          task: (progress: { report(): void }, token: vscode.CancellationToken) => Thenable<unknown>
        ) => {
          const source = new vscode.CancellationTokenSource();
          source.cancel();
          return task({ report: () => undefined }, source.token);
        };
      });
      teardown(async () => {
        (vscode.window as unknown as { withProgress: unknown }).withProgress = original;
        await h.dispose();
      });

      test('onFailureReason получает «<заголовок>: <текст прерывания>»; тост — только в interactive', async () => {
        const outcomes: ConfigurationImportOutcome[] = [];
        const services = h.p.services;
        const options = { interaction, onOutcome: (o: ConfigurationImportOutcome) => { outcomes.push(o); } };

        const ok = kind === 'cf'
          ? await runDecompileMainConfiguration(NAME, h.p.cfRoot, services.workspaceFolder, services.outputChannel, undefined, options)
          : await runDecompileExtension(NAME, h.p.cfeRoot, services.workspaceFolder, services.outputChannel, undefined, options);

        assert.strictEqual(ok, false);
        const reason = `${title}: Операция отменена пользователем.`;
        assert.deepStrictEqual(outcomes, [{ success: false, reason, warnings: [] }]);
        assert.deepStrictEqual(infos, interaction === 'interactive' ? [reason] : []);
        assert.deepStrictEqual(h.violations, []);
      });
    });
  }
}

suite('Агентская загрузка: пустая причина отказа не публикуется', function () {
  this.timeout(60_000);
  let h: ImportHarness;
  setup(async () => { h = await createImportHarness(); h.forbidWindows(); });
  teardown(async () => { await h.dispose(); });

  test('агент отказал с пустым текстом ошибки → false, onFailure не вызван', async () => {
    h.loadBehavior = () => Promise.reject(new Error(''));
    const failures: string[] = [];
    const services = h.p.services;

    const ok = await runUpdateMainConfiguration('Основная', h.p.cfRoot, services.workspaceFolder, services.outputChannel, false, undefined, {
      updateDatabase: false, lag: h.p.lag, interaction: 'unattended', onFailure: (reason: string) => { failures.push(reason); },
    });

    assert.strictEqual(ok, false);
    assert.deepStrictEqual(failures, []);
    assert.deepStrictEqual(h.violations, []);
  });
});
