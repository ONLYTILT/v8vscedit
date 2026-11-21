import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type {
  AgentFullDumpRequest,
  AgentMirrorSeedRequest,
  AgentOrphanFilesRequest,
} from '../../infra/agent/AgentOperationService';
import { AgentSyncCancelledError } from '../../infra/agent/sync/SyncContext';
import { createSyncProgress } from '../../infra/agent/sync/SyncProgress';
import {
  disposeCachedAgentOperationServices,
  ensureAgentService,
  type CachedAgentService,
} from '../../ui/commands/ext/agent/AgentServiceRegistry';
import { runAgentConfigurationOperation, type RunAgentOptions } from '../../ui/commands/ext/agent/agentConfigurationOperation';
import {
  runApplyDatabaseConfiguration,
  runDecompileExtension,
  runDecompileMainConfiguration,
} from '../../ui/commands/ext/ExtensionCommandRunner';
import { resetConfigurationOperationStatus } from '../../ui/commands/ext/configurationOperationStatus';
import { FakeLagRecorder } from './support/databaseLagFakes';
import { removeTreeSync } from './support/tempTree';

/**
 * Уведомление агентской операции (plan-delta-progress.md §3, тесты 21–24): `withProgress` с кнопкой «Отмена»
 * у импорта, пробрасывание этапов и счётчиков из infra в уведомление, строки «Ожидание ответа пользователя…»
 * вокруг каждого из четырёх вопросов, отмена токена. Подменяются только окна VS Code (`withProgress`, диалоги):
 * модальный UI в тестовом хосте недоступен; агент 1С — фейковый сервис реестра (внешняя система).
 */

type Fn = (...args: never[]) => unknown;
const win = vscode.window as unknown as Record<string, Fn>;

function stubWindow(name: string, impl: (...args: unknown[]) => unknown): () => void {
  const original = win[name];
  win[name] = impl;
  return () => { win[name] = original; };
}

interface ProgressRig {
  readonly optionsSeen: vscode.ProgressOptions[];
  readonly reports: { message?: string; increment?: number }[];
  readonly tokenSource: vscode.CancellationTokenSource;
  tokenSeen: vscode.CancellationToken | undefined;
}

const SEED_REQUEST: AgentMirrorSeedRequest = {
  reason: 'mirror-empty',
  targetKind: 'cf',
  targetName: 'Основная',
  projectDir: path.join(os.tmpdir(), 'project', 'src', 'cf'),
  formatVersion: '2.20',
  dumpInfoModifiedAt: new Date(2024, 4, 17, 10, 30),
  dumpInfoSize: 33_000_000,
  localEditsSinceBaseline: undefined,
};

const FULL_DUMP_REQUEST: AgentFullDumpRequest = {
  targetKind: 'cf',
  targetName: 'Основная',
  projectDir: path.join(os.tmpdir(), 'project', 'src', 'cf'),
  operation: 'import',
  reason: 'full-dump',
  reasonText: 'в базе удалены объекты',
  download: true,
};

const ORPHANS_REQUEST: AgentOrphanFilesRequest = {
  targetName: 'Основная',
  owners: ['Catalog.А', 'Catalog.Б'],
  files: ['Catalogs/А.xml', 'Catalogs/Б.xml', 'Catalogs/Б/Ext/ObjectModule.bsl'],
};

suite('Агентская операция: уведомление, отмена и ожидание ответа', function () {
  this.timeout(60_000);
  let tmp: string;
  let folder: vscode.WorkspaceFolder;
  let rig: ProgressRig;
  /** Единый журнал событий: строки журнала `[agent] …`, `report:` уведомления и `hook:` вызовы пользовательских хуков. */
  let events: string[];
  let channel: vscode.OutputChannel;
  const restores: (() => void)[] = [];
  const infos: unknown[][] = [];
  const errors: unknown[][] = [];
  const fakeCalls: { method: string; hooks: Record<string, unknown> }[] = [];

  async function setOperationMode(value: string | undefined): Promise<void> {
    await vscode.workspace.getConfiguration('v8vscedit.configuration').update('operationMode', value, vscode.ConfigurationTarget.Global);
  }

  setup(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-progress-'));
    folder = { uri: vscode.Uri.file(tmp), name: 'ws', index: 0 };
    events = [];
    infos.length = 0;
    errors.length = 0;
    fakeCalls.length = 0;
    channel = { appendLine: (line: string) => { events.push(line); }, show: () => undefined } as unknown as vscode.OutputChannel;
    rig = { optionsSeen: [], reports: [], tokenSource: new vscode.CancellationTokenSource(), tokenSeen: undefined };
    restores.push(stubWindow('withProgress', (options, task) => {
      rig.optionsSeen.push(options as vscode.ProgressOptions);
      rig.tokenSeen = rig.tokenSource.token;
      const progress = {
        report: (value: { message?: string; increment?: number }) => {
          rig.reports.push(value);
          if (value.message !== undefined) {
            events.push(`report:${value.message}`);
          }
        },
      };
      return (task as (p: unknown, t: vscode.CancellationToken) => Promise<unknown>)(progress, rig.tokenSource.token);
    }));
    restores.push(stubWindow('showInformationMessage', (...args) => { infos.push(args); return Promise.resolve(undefined); }));
    restores.push(stubWindow('showErrorMessage', (...args) => { errors.push(args); return Promise.resolve(undefined); }));
    await disposeCachedAgentOperationServices();
    await setOperationMode('agent');
    const entry = {
      service: {
        importFromDatabase: (_target: unknown, hooks: Record<string, unknown>) => {
          fakeCalls.push({ method: 'importFromDatabase', hooks });
          return Promise.resolve({ changedProjectFiles: [] });
        },
        updateDatabaseConfiguration: (_target: unknown, hooks: Record<string, unknown>) => {
          fakeCalls.push({ method: 'updateDatabaseConfiguration', hooks });
          return Promise.resolve({ changedProjectFiles: [] });
        },
        dispose: () => Promise.resolve(),
      },
      sessions: { disposeAll: () => Promise.resolve() },
    } as unknown as CachedAgentService;
    await ensureAgentService(tmp, () => Promise.resolve(entry));
  });

  teardown(async () => {
    restores.splice(0).forEach((restore) => restore());
    rig.tokenSource.dispose();
    resetConfigurationOperationStatus();
    await disposeCachedAgentOperationServices();
    await setOperationMode(undefined);
    removeTreeSync(tmp);
  });

  const base = (): RunAgentOptions => ({
    progressTitle: 'Импорт тест',
    progressStartMessage: 'старт',
    successMessage: 'Готово',
    errorTitle: 'Сбой',
    showSuccessMessage: false,
    workspaceFolder: folder,
    outputChannel: channel,
    rootPath: tmp,
  });

  type OperationHooks = Parameters<Parameters<typeof runAgentConfigurationOperation>[1]>[1];
  const run = (options: RunAgentOptions, body: (hooks: OperationHooks) => Promise<void>): Promise<boolean> =>
    runAgentConfigurationOperation(options, (_service, hooks) => body(hooks));

  // ── 21. withProgress и cancellable ──────────────────────────────────────────────────────────────

  suite('21. withProgress и кнопка «Отмена»', () => {
    test('cancellable: true → уведомление (Notification) с заголовком операции и кнопкой отмены; токен уходит в хуки операции', async () => {
      let received: unknown;
      const ok = await run({ ...base(), cancellable: true }, (hooks) => {
        received = (hooks as unknown as { cancellation?: unknown }).cancellation;
        return Promise.resolve();
      });
      assert.strictEqual(ok, true);
      assert.strictEqual(rig.optionsSeen.length, 1);
      assert.strictEqual(rig.optionsSeen[0].location, vscode.ProgressLocation.Notification);
      assert.strictEqual(rig.optionsSeen[0].title, 'Импорт тест');
      assert.strictEqual(rig.optionsSeen[0].cancellable, true);
      assert.strictEqual(received, rig.tokenSeen, 'в хуки передан тот же токен, что даёт withProgress');
    });

    test('без cancellable: кнопки отмены нет, токен в хуки не передаётся', async () => {
      let received: unknown = 'не задано';
      await run(base(), (hooks) => {
        received = (hooks as unknown as { cancellation?: unknown }).cancellation;
        return Promise.resolve();
      });
      assert.strictEqual(rig.optionsSeen.length, 1);
      assert.notStrictEqual(rig.optionsSeen[0].cancellable, true);
      assert.strictEqual(received, undefined);
    });

    test('импорт основной конфигурации и расширения — с кнопкой отмены; загрузка (обновление БД) — без неё', async () => {
      assert.strictEqual(await runDecompileMainConfiguration('Основная', path.join(tmp, 'src', 'cf'), folder, channel), true);
      assert.strictEqual(await runDecompileExtension('Расш', path.join(tmp, 'src', 'cfe', 'Расш'), folder, channel), true);
      const target = { kind: 'cf' as const, name: 'Основная', rootPath: path.join(tmp, 'src', 'cf') };
      assert.strictEqual(await runApplyDatabaseConfiguration(target, folder, channel, new FakeLagRecorder()), true);

      assert.strictEqual(rig.optionsSeen.length, 3);
      assert.strictEqual(rig.optionsSeen[0].cancellable, true, 'импорт конфигурации');
      assert.strictEqual(rig.optionsSeen[1].cancellable, true, 'импорт расширения');
      assert.notStrictEqual(rig.optionsSeen[2].cancellable, true, 'загрузка: отмены нет (бэклог Б3)');
      assert.deepStrictEqual(fakeCalls.map((call) => call.method), ['importFromDatabase', 'importFromDatabase', 'updateDatabaseConfiguration']);
      assert.ok(fakeCalls[0].hooks.cancellation !== undefined, 'импорт получил токен отмены');
      assert.strictEqual(fakeCalls[2].hooks.cancellation, undefined, 'загрузка токена не получает');
    });
  });

  // ── 22. onProgress → уведомление ────────────────────────────────────────────────────────────────

  suite('22. прогресс в уведомлении', () => {
    test('onProgress → progress.report({ message }) без increment; тот же текст идёт в статус и дерево', async () => {
      const treeMessages: string[] = [];
      await run({ ...base(), onProgressMessage: (message) => { treeMessages.push(message); } }, (hooks) => {
        hooks.onProgress?.({ text: 'Скачивание изменённых файлов: 1 из 4 (25%), 0.1 МБ', done: 1, total: 4 });
        hooks.onProgress?.({ text: 'Запись в проект: изменено 1, удалено 0' });
        return Promise.resolve();
      });
      assert.deepStrictEqual(rig.reports, [
        { message: 'Скачивание изменённых файлов: 1 из 4 (25%), 0.1 МБ' },
        { message: 'Запись в проект: изменено 1, удалено 0' },
      ]);
      assert.ok(rig.reports.every((report) => !('increment' in report)), 'полосы increment нет: неопределённая');
      assert.ok(treeMessages.includes('Скачивание изменённых файлов: 1 из 4 (25%), 0.1 МБ'), treeMessages.join(' | '));
    });

    test('настоящий SyncProgress поверх хуков операции: этап и вехи счётчика — ровно одна запись в уведомлении, промежуточные — только в UI', async () => {
      let clock = 0;
      await run(base(), (hooks) => {
        const progress = createSyncProgress(hooks, () => clock);
        progress.step('X');
        const counter = progress.counter((done, total) => `C ${String(done)}/${String(total)}`, 1000);
        clock = 500;
        counter.advance();
        counter.finish();
        return Promise.resolve();
      });
      assert.deepStrictEqual(rig.reports, [{ message: 'X' }, { message: 'C 0/1000' }, { message: 'C 1/1000' }]);
      assert.deepStrictEqual(events.filter((line) => line.startsWith('[agent] X') || line.startsWith('[agent] C ')), [
        '[agent] X', '[agent] C 0/1000', '[agent] C 1/1000',
      ]);
    });

    test('обычное сообщение журнала попадает и в журнал, и в уведомление; сырая команда агента — только в журнал', async () => {
      await run(base(), (hooks) => {
        hooks.onMessage('Подготовка частичной загрузки: 2 файл(ов).');
        hooks.onMessage('config dump-config-to-files --dir=exchange/x');
        hooks.onMessage('Выполнено: common connect-ib');
        return Promise.resolve();
      });
      assert.ok(events.includes('[agent] Подготовка частичной загрузки: 2 файл(ов).'));
      assert.ok(events.includes('[agent] config dump-config-to-files --dir=exchange/x'), 'в журнале сырая команда остаётся');
      const reported = rig.reports.map((report) => report.message);
      assert.ok(reported.includes('Подготовка частичной загрузки: 2 файл(ов).'));
      assert.ok(!reported.some((message) => /dump-config-to-files|connect-ib/.test(message ?? '')), reported.join(' | '));
    });
  });

  // ── 23. ожидание ответа пользователя ───────────────────────────────────────────────────────────

  suite('23. «Ожидание ответа пользователя» / «Ответ пользователя»', () => {
    const WAIT = '[agent] Ожидание ответа пользователя: ';
    const ANSWER = '[agent] Ответ пользователя: ';

    function indexOfLine(prefix: string): number {
      return events.findIndex((line) => line.startsWith(prefix));
    }

    test('посев: строка ожидания до хука, строка ответа после; значение проходит без изменений; то же — в уведомление', async () => {
      let result: unknown;
      await run({
        ...base(),
        confirmMirrorSeed: () => { events.push('hook:seed'); return Promise.resolve('seed'); },
      }, async (hooks) => {
        result = await hooks.confirmMirrorSeed?.(SEED_REQUEST);
      });
      assert.strictEqual(result, 'seed');
      const wait = events.indexOf(`${WAIT}подготовка зеркала агента`);
      const hook = events.indexOf('hook:seed');
      const answer = indexOfLine(ANSWER);
      assert.ok(wait >= 0 && hook > wait && answer > hook, events.join(' | '));
      assert.ok(events[answer].includes('seed'));
      assert.ok(events.includes('report:Ожидание ответа пользователя: подготовка зеркала агента'), 'и в уведомление');
    });

    test('полная выгрузка: тема — причина из запроса; ответ dump', async () => {
      let result: unknown;
      await run({
        ...base(),
        confirmFullDump: () => { events.push('hook:fullDump'); return Promise.resolve('dump'); },
      }, async (hooks) => {
        result = await hooks.confirmFullDump?.(FULL_DUMP_REQUEST);
      });
      assert.strictEqual(result, 'dump');
      const wait = events.indexOf(`${WAIT}полная выгрузка на сервере (в базе удалены объекты)`);
      const hook = events.indexOf('hook:fullDump');
      const answer = indexOfLine(ANSWER);
      assert.ok(wait >= 0 && hook > wait && answer > hook, events.join(' | '));
      assert.ok(events[answer].includes('dump'));
    });

    for (const decision of [true, false]) {
      test(`сироты: тема — число файлов (${String(ORPHANS_REQUEST.files.length)}); ответ ${String(decision)} проходит без изменений`, async () => {
        let result: unknown;
        await run({
          ...base(),
          confirmOrphanRemoval: () => { events.push('hook:orphans'); return Promise.resolve(decision); },
        }, async (hooks) => {
          result = await hooks.confirmOrphanRemoval?.(ORPHANS_REQUEST);
        });
        assert.strictEqual(result, decision);
        const wait = events.indexOf(`${WAIT}удаление осиротевших файлов (3)`);
        const hook = events.indexOf('hook:orphans');
        const answer = indexOfLine(ANSWER);
        assert.ok(wait >= 0 && hook > wait && answer > hook, events.join(' | '));
      });
    }

    test('вопрос агента (onQuestion): тема — первая строка текста; ответ записывается; дальше ответ пользователя доходит до агента', async () => {
      restores.push(stubWindow('showWarningMessage', () => Promise.resolve('Да')));
      let result: unknown;
      await run(base(), async (hooks) => {
        result = await hooks.onQuestion({ type: 'question', message: 'Продолжить операцию?\nПодробности во второй строке' });
      });
      assert.strictEqual(result, 'yes');
      const wait = events.indexOf(`${WAIT}Продолжить операцию?`);
      const answer = indexOfLine(ANSWER);
      assert.ok(wait >= 0 && answer > wait, events.join(' | '));
      assert.ok(events[answer].includes('yes'));
      assert.ok(!events.some((line) => line.includes('Подробности во второй строке')), 'вторая строка в тему не попадает');
    });

    test('вопрос агента без ответа (Esc в поле ввода): ответ записывается как «нет ответа», до агента доходит undefined', async () => {
      restores.push(stubWindow('showInputBox', () => Promise.resolve(undefined)));
      let result: unknown = 'не вызван';
      await run(base(), async (hooks) => {
        result = await hooks.onQuestion({ type: 'question', message: 'Введите логин информационной базы' });
      });
      assert.strictEqual(result, undefined);
      assert.ok(events.includes(`${WAIT}Введите логин информационной базы`), events.join(' | '));
      assert.ok(events.includes(`${ANSWER}нет ответа`), events.join(' | '));
    });

    test('вопрос про пароль: ответ доходит до агента, но в журнал и уведомление не попадает', async () => {
      restores.push(stubWindow('showInputBox', () => Promise.resolve('S3cret!Пароль')));
      let result: unknown;
      await run(base(), async (hooks) => {
        result = await hooks.onQuestion({ type: 'question', message: 'Введите пароль информационной базы' });
      });
      assert.strictEqual(result, 'S3cret!Пароль');
      assert.ok(events.every((line) => !line.includes('S3cret!Пароль')), events.join(' | '));
    });

    test('отказ хука (исключение) не проглатывается обёрткой: операция падает с тем же текстом ошибки', async () => {
      const ok = await run({
        ...base(),
        confirmFullDump: () => Promise.reject(new Error('диалог сломался')),
      }, async (hooks) => {
        await hooks.confirmFullDump?.(FULL_DUMP_REQUEST);
      });
      assert.strictEqual(ok, false);
      assert.strictEqual(errors.length, 1);
      assert.match(String(errors[0][0]), /диалог сломался/);
    });

    test('хуков из опций нет — обёртки нет: confirm-хуки остаются undefined', async () => {
      const seen: Record<string, unknown> = {};
      await run(base(), (hooks) => {
        Object.assign(seen, {
          seed: hooks.confirmMirrorSeed,
          fullDump: hooks.confirmFullDump,
          orphans: hooks.confirmOrphanRemoval,
        });
        return Promise.resolve();
      });
      assert.deepStrictEqual(seen, { seed: undefined, fullDump: undefined, orphans: undefined });
    });
  });

  // ── 24. отмена токена ──────────────────────────────────────────────────────────────────────────

  suite('24. отмена пользователем', () => {
    test('запрос отмены токеном → строка журнала о безопасной точке; AgentSyncCancelledError → информационное сообщение, без тоста ошибки, результат false', async () => {
      const statusMessages: string[] = [];
      const ok = await run({ ...base(), cancellable: true, onProgressMessage: (message) => { statusMessages.push(message); } }, () => {
        rig.tokenSource.cancel();
        return Promise.reject(new AgentSyncCancelledError());
      });
      assert.strictEqual(ok, false);
      assert.ok(
        events.some((line) => line.includes('Запрошена отмена: операция остановится в ближайшей безопасной точке; начатая команда агента и запись в проект доводятся до конца')),
        events.join(' | ')
      );
      assert.ok(statusMessages.some((message) => message.startsWith('Запрошена отмена')), statusMessages.join(' | '));
      assert.deepStrictEqual(errors, []);
      assert.strictEqual(infos.length, 1);
      assert.match(String(infos[0][0]), /отменена/);
      assert.ok(events.some((line) => line.includes('Отменено')), events.join(' | '));
      assert.ok(!events.some((line) => line.includes('[agent][error]')));
    });

    test('без отмены токена строки «Запрошена отмена» нет', async () => {
      await run({ ...base(), cancellable: true }, () => Promise.resolve());
      assert.ok(!events.some((line) => line.includes('Запрошена отмена')));
    });
  });
});
