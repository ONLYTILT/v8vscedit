/**
 * `runAgentOperation` (ui/commands/ext/agent/agentConfigurationOperation.ts): обобщение обёртки агентской операции —
 * результат `AgentOperationOutcome<T>` вместо boolean; `runAgentConfigurationOperation` остаётся тонкой обёрткой.
 *
 *  - успех → `{ok:true, value}` (+ итоговый тост, если не отключён);
 *  - ошибка → `{ok:false, reason}`, тост — если не `showErrorMessage:false` (MCP `silent`); текст — через
 *    `describeAgentCommandFailure` (пустой UnknownError → текст последней log-строки);
 *  - отмена пользователя → `{ok:false, cancelled:true}`, без тоста ошибки;
 *  - `AgentConnectionLostError` → текст E1 (обрыв) / E2 (нет ответа за срок) в тосте, причине и журнале.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentCommandError, AgentConnectionLostError } from '../../infra/agent';
import { AgentFullDumpDeclinedError, AgentSyncCancelledError } from '../../infra/agent/sync/SyncContext';
import {
  runAgentConfigurationOperation,
  runAgentOperation,
  type RunAgentOptions,
} from '../../ui/commands/ext/agent/agentConfigurationOperation';
import {
  disposeCachedAgentOperationServices,
  ensureAgentService,
  getCachedAgentOperationService,
  type CachedAgentService,
} from '../../ui/commands/ext/agent/AgentServiceRegistry';
import { resetAgentSettings } from './support/agentRemoteHarness';
import { makeAgentEntry, seedCachedAgentService } from './support/agentRegistrySeed';
import { removeTreeSync } from './support/tempTree';

type WindowRef = Record<string, unknown>;
const windowRef = vscode.window as unknown as WindowRef;

suite('runAgentOperation: исход агентской операции и тосты', function () {
  this.timeout(60_000);
  let root: string;
  let lines: string[];
  let errors: string[];
  let infos: string[];
  let options: RunAgentOptions;
  const saved: Record<string, unknown> = {};

  setup(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-run-agent-op-')));
    lines = [];
    errors = [];
    infos = [];
    for (const key of ['showErrorMessage', 'showInformationMessage']) {
      saved[key] = windowRef[key];
    }
    windowRef.showErrorMessage = (message: string) => { errors.push(message); return Promise.resolve(undefined); };
    windowRef.showInformationMessage = (message: string) => { infos.push(message); return Promise.resolve(undefined); };
    await disposeCachedAgentOperationServices();
    await seedCachedAgentService(root, { connected: false });
    options = {
      progressTitle: 'Тестовая операция',
      progressStartMessage: 'старт',
      successMessage: 'Готово.',
      errorTitle: 'Не удалось выполнить тестовую операцию.',
      workspaceFolder: { uri: vscode.Uri.file(root), name: 'run-op', index: 0 },
      outputChannel: { appendLine: (line: string) => { lines.push(line); } } as unknown as vscode.OutputChannel,
      rootPath: root,
    };
  });

  teardown(async () => {
    for (const key of Object.keys(saved)) {
      windowRef[key] = saved[key];
    }
    await disposeCachedAgentOperationServices();
    removeTreeSync(root);
  });

  test('успех: {ok:true, value}, итоговый тост показан', async () => {
    const outcome = await runAgentOperation(options, () => Promise.resolve(42));
    assert.deepStrictEqual(outcome, { ok: true, value: 42 });
    assert.deepStrictEqual(infos, ['Готово.']);
    assert.deepStrictEqual(errors, []);
  });

  test('успех с showSuccessMessage:false — без итогового тоста', async () => {
    const outcome = await runAgentOperation({ ...options, showSuccessMessage: false }, () => Promise.resolve('x'));
    assert.strictEqual(outcome.ok, true);
    assert.deepStrictEqual(infos, []);
  });

  test('ошибка: {ok:false, reason}, тост с заголовком и текстом; журнал — [agent][error]', async () => {
    const outcome = await runAgentOperation(options, () => Promise.reject(new Error('что-то сломалось')));
    assert.deepStrictEqual(outcome, { ok: false, reason: 'что-то сломалось' });
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].startsWith('Не удалось выполнить тестовую операцию.') && errors[0].includes('что-то сломалось'), errors[0]);
    assert.ok(lines.includes('[agent][error] что-то сломалось'), lines.join('\n'));
  });

  test('ошибка с showErrorMessage:false: всплывающего окна нет, причина возвращена', async () => {
    const outcome = await runAgentOperation({ ...options, showErrorMessage: false }, () => Promise.reject(new Error('тихий отказ')));
    assert.deepStrictEqual(outcome, { ok: false, reason: 'тихий отказ' });
    assert.deepStrictEqual(errors, []);
    assert.ok(lines.includes('[agent][error] тихий отказ'), 'в журнал ошибка пишется всегда');
  });

  test('пустой UnknownError + log-строка → причина и тост содержат текст log, а не «пустой ответ»', async () => {
    const final = { type: 'error' as const, 'error-type': 'UnknownError', message: '', body: [] };
    const error = new AgentCommandError('Ошибка агента: пустой ответ (UnknownError)', 'config load-cfg', final, [
      { type: 'log', message: 'Каталог не обнаружен' },
      final,
    ]);

    const outcome = await runAgentOperation(options, () => Promise.reject(error));

    assert.deepStrictEqual(outcome, { ok: false, reason: 'Каталог не обнаружен' });
    assert.ok(errors[0].includes('Каталог не обнаружен') && !errors[0].includes('пустой ответ'), errors[0]);
  });

  test('отмена пользователя: {ok:false, cancelled:true}, тоста ошибки нет, информационное сообщение об отмене есть', async () => {
    const outcome = await runAgentOperation(options, () => { throw new AgentSyncCancelledError(); });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.cancelled, true);
    assert.deepStrictEqual(errors, []);
    assert.ok(infos.some((message) => message.includes('операция отменена')), infos.join('|'));
  });

  test('отказ от полной выгрузки (подкласс отмены) — не ошибка: без тоста ошибки', async () => {
    const outcome = await runAgentOperation(options, () => { throw new AgentFullDumpDeclinedError('import', 'Полная выгрузка отклонена'); });
    assert.strictEqual(outcome.ok, false);
    assert.deepStrictEqual(errors, []);
  });

  test('обрыв канала (AgentConnectionLostError closed): текст E1 в причине, тосте и журнале', async () => {
    const outcome = await runAgentOperation(options, () => Promise.reject(new AgentConnectionLostError('config dump-cfg', 'closed')));

    assert.strictEqual(outcome.ok, false);
    const reason = outcome.reason;
    assert.ok(reason.includes('Агент конфигуратора аварийно завершился') && reason.includes('«config dump-cfg»'), reason);
    assert.ok(/перезапустите агента/i.test(reason), reason);
    assert.ok(errors[0].includes('аварийно завершился'), errors[0]);
    assert.ok(lines.some((line) => line.startsWith('[agent][error]') && line.includes('аварийно завершился')), lines.join('\n'));
  });

  test('нет ответа за срок (no-response): текст E2 — не ответил, глагол команды, перезапуск агента', async () => {
    const outcome = await runAgentOperation(
      options,
      () => Promise.reject(new AgentConnectionLostError('config extensions properties get', 'no-response'))
    );

    const reason = !outcome.ok ? outcome.reason : '';
    assert.ok(reason.includes('не ответил') && reason.includes('«config extensions properties get»'), reason);
    assert.ok(/перезапустите агента/i.test(reason), reason);
    assert.ok(errors[0].includes('не ответил'), errors[0]);
  });

  test('runAgentConfigurationOperation — тонкая обёртка: ok → true, отказ → false', async () => {
    assert.strictEqual(await runAgentConfigurationOperation(options, () => Promise.resolve()), true);
    assert.strictEqual(await runAgentConfigurationOperation(options, () => Promise.reject(new Error('x'))), false);
  });
  /** Запись реестра с «своим» процессом агента (автозапуск): процесс 1cv8 здесь — наблюдаемая заглушка. */
  async function seedOwnedAgent(stop: () => Promise<void>): Promise<{ stops: number }> {
    await disposeCachedAgentOperationServices();
    await resetAgentSettings();
    const state = { stops: 0 };
    const { entry } = await makeAgentEntry(root, { connected: false });
    const owned = { ...entry, process: { stop: async () => { state.stops += 1; await stop(); } } } as unknown as CachedAgentService;
    await ensureAgentService(root, () => Promise.resolve(owned));
    return state;
  }

  test('зависание своего локального агента (no-response): процесс остановлен, запись убрана из кэша, повтора нет', async () => {
    const state = await seedOwnedAgent(() => Promise.resolve());
    let calls = 0;

    const outcome = await runAgentOperation(options, () => {
      calls += 1;
      return Promise.reject(new AgentConnectionLostError('config extensions properties get', 'no-response', undefined, { deadlineMs: 30_000 }));
    });

    const reason = !outcome.ok ? outcome.reason : '';
    assert.ok(reason.includes('запущен заново') && reason.includes('«config extensions properties get»'), reason);
    assert.strictEqual(calls, 1, 'команда по сроку не повторяется');
    assert.strictEqual(state.stops, 1, 'свой процесс агента остановлен для перезапуска');
    assert.strictEqual(getCachedAgentOperationService(options.workspaceFolder), undefined, 'следующая операция запустит агента заново');
    assert.ok(lines.some((line) => line.includes('процесс останавливается для перезапуска')), lines.join(' | '));
  });

  test('зависание своего агента и отказ остановки процесса: причина операции прежняя, отказ остановки — в журнале', async () => {
    await seedOwnedAgent(() => Promise.reject(new Error('процесс не остановился')));

    const outcome = await runAgentOperation(options, () =>
      Promise.reject(new AgentConnectionLostError('config extensions properties get', 'no-response')));

    assert.ok(!outcome.ok && outcome.reason.includes('запущен заново'));
    assert.ok(lines.some((line) => line.startsWith('[agent][warn]') && line.includes('процесс не остановился')), lines.join(' | '));
  });
});
