/**
 * Тесты `McpMutationGate.wrapLongRunning` и подключения обёртки к 10 долгим MCP-инструментам
 * (план mcp-long-running, разделы 1.4–1.6, 1.8): пульс в поток вызова и (опционально) в GET-поток сессии,
 * `lastOperation`, MCP-текст «занято», проверка `execute_command` при занятом замке.
 *
 * Время — ручной планировщик, ожидания — promise. Инструменты — реальные `registerRepositoryTools` /
 * `registerConfigLifecycleTools` на настоящих RepositoryService/env.json/выгрузках
 * (`support/repositoryMcpFixtures.ts`); подменены только исполнитель Конфигуратора и шаги платформы.
 */
import * as assert from 'assert';
import * as path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as vscode from 'vscode';
import * as extensionRunner from '../../ui/commands/ext/ExtensionCommandRunner';
import {
  endConfigurationOperation,
  isConfigurationOperationRunning,
  tryBeginConfigurationOperation,
} from '../../ui/commands/ext/configurationOperationLock';
import { registerConfigLifecycleTools } from '../../ui/mcp/registration/McpConfigLifecycleTools';
import { registerRepositoryTools } from '../../ui/mcp/registration/McpRepositoryTools';
import type { MetadataNode } from '../../ui/tree/TreeNode';
import { ManualScheduler, deferred } from './support/manualScheduler';
import type { OperationStage } from '../../infra/progress/OperationStageFeed';
import { McpOperationOutcomeRegistry } from '../../infra/mcp/McpOperationOutcome';
import { MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE } from '../../ui/commands/ext/configurationOperationLock';
import { operationStageFeed } from '../../ui/commands/ext/configurationOperationStatus';
import { McpMutationGate } from '../../ui/mcp/registration/McpMutationGate';
import { fakeExtra, waitForNextMillisecond } from './support/mcpFakeExtra';
import { LOCK_DONE, createRepoProject, opLog, type RepoProject } from './support/repositoryMcpFixtures';

const INTERVAL = 20_000;
const TOOL = 'v8vscedit_test_tool';
const PULSE_20S = `${TOOL}: выполняется 20 с`;

const text = (result: CallToolResult): string => {
  const part = result.content[0];
  return part.type === 'text' ? part.text : '';
};

// ─── Часть 1: wrapLongRunning сам по себе ─────────────────────────────────────────────────────────

suite('McpMutationGate.wrapLongRunning — пульс, исход, отказоустойчивость', () => {
  let scheduler: ManualScheduler;
  let outcomes: McpOperationOutcomeRegistry;
  let lines: string[];
  let stage: OperationStage | undefined;
  let sessionPulses: string[];
  let sessionFailure: Error | undefined;
  let gate: McpMutationGate;

  function build(withOutputChannel = true, withSession = true): McpMutationGate {
    return new McpMutationGate(
      (withOutputChannel ? { outputChannel: { appendLine: (line: string) => { lines.push(line); } } } : {}) as never,
      {
        scheduler, intervalMs: INTERVAL, readStage: () => stage,
        sendSessionPulse: withSession
          ? (pulse) => {
            sessionPulses.push(pulse);
            return sessionFailure ? Promise.reject(sessionFailure) : Promise.resolve();
          }
          : undefined,
      },
      outcomes
    );
  }

  setup(() => {
    scheduler = new ManualScheduler();
    outcomes = new McpOperationOutcomeRegistry();
    lines = [];
    stage = undefined;
    sessionPulses = [];
    sessionFailure = undefined;
    gate = build();
  });

  const wrap = (extra: ReturnType<typeof fakeExtra> | undefined, fn: () => Promise<unknown>) =>
    gate.wrapLongRunning(TOOL, extra, fn);

  suite('extra не передан: ровно wrapAsync', () => {
    test('успех: тот же результат, что у wrapAsync; ни таймеров, ни записи исхода', async () => {
      const data = { path: 'Справочники.Товары', done: true };
      const long = await wrap(undefined, () => Promise.resolve(data));
      assert.deepStrictEqual(long, await gate.wrapAsync(() => Promise.resolve(data)));
      assert.strictEqual(scheduler.totalScheduled, 0);
      assert.strictEqual(outcomes.last() ?? null, null);
    });

    test('ошибка: тот же toolError, что у wrapAsync', async () => {
      const long = await wrap(undefined, () => Promise.reject(new Error('отказ')));
      assert.deepStrictEqual(long, await gate.wrapAsync(() => Promise.reject(new Error('отказ'))));
      assert.strictEqual(long.isError, true);
      assert.strictEqual(scheduler.totalScheduled, 0);
      assert.strictEqual(outcomes.last() ?? null, null);
    });
  });

  suite('пульс в поток вызова', () => {
    test('есть progressToken: notifications/progress с токеном, секундами и текстом пульса; результат — как у wrapAsync', async () => {
      const extra = fakeExtra('tok-1');
      const work = deferred<unknown>();
      const running = wrap(extra, () => work.promise);
      assert.strictEqual(scheduler.pendingCount(), 1, 'пульс взведён на старте вызова');
      await scheduler.fireNext();
      assert.deepStrictEqual(extra.notifications, [
        { method: 'notifications/progress', params: { progressToken: 'tok-1', progress: 20, message: PULSE_20S } },
      ]);
      work.resolve({ done: true });
      const result = await running;
      assert.strictEqual(text(result), JSON.stringify({ done: true }, null, 2));
      assert.strictEqual(scheduler.pendingCount(), 0);
    });

    test('progressToken = 0 допустим (проверка !== undefined)', async () => {
      const extra = fakeExtra(0);
      const work = deferred<unknown>();
      const running = wrap(extra, () => work.promise);
      await scheduler.fireNext();
      assert.strictEqual(extra.notifications[0].method, 'notifications/progress');
      work.resolve(1);
      await running;
    });

    test('токена нет: notifications/message (info, logger v8vscedit) с текстом пульса', async () => {
      const extra = fakeExtra();
      const work = deferred<unknown>();
      const running = wrap(extra, () => work.promise);
      await scheduler.fireNext();
      assert.deepStrictEqual(extra.notifications, [
        { method: 'notifications/message', params: { level: 'info', logger: 'v8vscedit', data: PULSE_20S } },
      ]);
      work.resolve(1);
      await running;
    });

    test('свежий этап операции добавляется в текст: «… — <заголовок>: <этап>»', async () => {
      stage = { title: 'Получение из хранилища', stage: 'Объект Товары', phase: 'update', at: 0 };
      const extra = fakeExtra('t');
      const work = deferred<unknown>();
      const running = wrap(extra, () => work.promise);
      await scheduler.fireNext();
      const params = extra.notifications[0].params as { message: string };
      assert.strictEqual(params.message, `${PULSE_20S} — Получение из хранилища: Объект Товары`);
      work.resolve(1);
      await running;
    });

    test('длинный вызов: пульс тикает каждые 20 с, после результата таймеров не остаётся', async () => {
      const extra = fakeExtra('t');
      const work = deferred<unknown>();
      const running = wrap(extra, () => work.promise);
      await scheduler.fireNext();
      await scheduler.fireNext();
      await scheduler.fireNext();
      assert.deepStrictEqual(
        extra.notifications.map((n) => (n.params as { progress: number }).progress), [20, 40, 60]);
      work.resolve(1);
      await running;
      assert.strictEqual(scheduler.pendingCount(), 0);
    });
  });

  suite('пульс в GET-поток сессии (sendSessionPulse)', () => {
    test('вызывается с тем же текстом, что и пульс вызова', async () => {
      const extra = fakeExtra('t');
      const work = deferred<unknown>();
      const running = wrap(extra, () => work.promise);
      await scheduler.fireNext();
      const callPulse = (extra.notifications[0].params as { message: string }).message;
      assert.deepStrictEqual(sessionPulses, [callPulse]);
      work.resolve(1);
      await running;
    });

    test('сессионного пульса нет (deps без sendSessionPulse): пульс вызова работает', async () => {
      gate = build(true, false);
      const extra = fakeExtra('t');
      const work = deferred<unknown>();
      const running = wrap(extra, () => work.promise);
      await scheduler.fireNext();
      assert.strictEqual(extra.notifications.length, 1);
      work.resolve(1);
      await running;
    });

    test('отказ сессионного пульса («нет GET-потока» — норма) не мешает пульсу вызова и не множит записи журнала', async () => {
      sessionFailure = new Error('нет GET-потока');
      const extra = fakeExtra('t');
      const work = deferred<unknown>();
      const running = wrap(extra, () => work.promise);
      await scheduler.fireNext();
      await scheduler.fireNext();
      assert.strictEqual(extra.notifications.length, 2, 'пульс вызова дошёл оба раза');
      assert.strictEqual(sessionPulses.length, 2, 'сессионный пульс пробовали оба раза');
      assert.ok(lines.length <= 1, `журнал: ${JSON.stringify(lines)}`);
      work.resolve({ ok: 1 });
      const result = await running;
      assert.strictEqual((result).isError, undefined);
    });
  });

  suite('ошибки и отказы отправки', () => {
    test('fn бросает: isError с текстом ошибки, таймеров нет, исход записан как ошибка', async () => {
      const extra = fakeExtra('t');
      const result = await wrap(extra, () => Promise.reject(new Error('Платформа отказала')));
      assert.strictEqual(result.isError, true);
      assert.strictEqual(text(result), 'Платформа отказала');
      assert.strictEqual(scheduler.pendingCount(), 0);
      assert.strictEqual(outcomes.last()?.isError, true);
    });

    test('три отказа отправки подряд: вызов завершается успехом, в журнале ровно одна строка «[mcp][pulse] <инструмент>: …»', async () => {
      const extra = fakeExtra('t');
      extra.failSends = true;
      const work = deferred<unknown>();
      const running = wrap(extra, () => work.promise);
      await scheduler.fireNext();
      await scheduler.fireNext();
      await scheduler.fireNext();
      assert.strictEqual(scheduler.pendingCount(), 1, 'пульс продолжается несмотря на отказы');
      work.resolve({ done: true });
      const result = await running;
      assert.strictEqual(result.isError, undefined);
      assert.strictEqual(lines.length, 1, JSON.stringify(lines));
      assert.ok(lines[0].startsWith(`[mcp][pulse] ${TOOL}: `), lines[0]);
      assert.ok(lines[0].includes('socket closed'), lines[0]);
    });

    test('отказ отправки не объектом Error (транспорт отклоняет строкой): в журнал попадает сама строка, вызов успешен', async () => {
      const extra = fakeExtra('t');
      // Транспорт и сторонний код вправе отклонять промис не Error — ровно этот случай и проверяется.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      extra.sendNotification = () => Promise.reject('поток закрыт клиентом');
      const work = deferred<unknown>();
      const running = wrap(extra, () => work.promise);
      await scheduler.fireNext();
      work.resolve({ done: true });
      const result = await running;
      assert.strictEqual(result.isError, undefined);
      assert.deepStrictEqual(lines, [`[mcp][pulse] ${TOOL}: поток закрыт клиентом`]);
    });

    test('журнал пульса — один раз за вызов, а не за каждый вызов инструмента: новый вызов пишет свою строку', async () => {
      for (let call = 0; call < 2; call += 1) {
        const extra = fakeExtra('t');
        extra.failSends = true;
        const work = deferred<unknown>();
        const running = wrap(extra, () => work.promise);
        await scheduler.fireNext();
        await scheduler.fireNext();
        work.resolve(1);
        await running;
      }
      assert.strictEqual(lines.length, 2);
    });

    test('сервисы без outputChannel: отказ отправки не ломает вызов (журнал через ?.)', async () => {
      gate = build(false);
      const extra = fakeExtra('t');
      extra.failSends = true;
      const work = deferred<unknown>();
      const running = wrap(extra, () => work.promise);
      await scheduler.fireNext();
      work.resolve({ done: true });
      const result = await running;
      assert.strictEqual(result.isError, undefined);
    });
  });

  suite('abort', () => {
    test('abort во время вызова: таймер погашен сразу; когда fn завершится — исход «прервано» (isError)', async () => {
      const extra = fakeExtra('t');
      const work = deferred<unknown>();
      const running = wrap(extra, () => work.promise);
      assert.strictEqual(scheduler.pendingCount(), 1);
      extra.controller.abort();
      assert.strictEqual(scheduler.pendingCount(), 0);
      work.resolve({ done: true });
      await running;
      assert.strictEqual(scheduler.pendingCount(), 0);
      const last = outcomes.last();
      assert.strictEqual(last?.isError, true);
      assert.ok(last.summary.includes('прервано'), last.summary);
      assert.strictEqual(last.tool, TOOL);
    });

    test('signal прерван заранее: пульс не планируется, fn выполняется, исход «прервано»', async () => {
      const extra = fakeExtra('t');
      extra.controller.abort();
      let ran = false;
      await wrap(extra, () => { ran = true; return Promise.resolve(1); });
      assert.strictEqual(ran, true);
      assert.strictEqual(scheduler.totalScheduled, 0);
      assert.strictEqual(outcomes.last()?.isError, true);
      assert.ok(outcomes.last()?.summary.includes('прервано'));
    });
  });

  suite('итог операции в summary (describeOutcome)', () => {
    test('abort И ошибка fn: «прервано…; итог операции — ошибка: <первая строка>»', async () => {
      const extra = fakeExtra('t');
      const work = deferred<unknown>();
      const running = wrap(extra, () => work.promise);
      extra.controller.abort();
      work.reject(new Error('Платформа отказала\nвторая строка'));
      await running;
      const last = outcomes.last();
      assert.strictEqual(last?.isError, true);
      assert.ok(last.summary.startsWith('прервано'), last.summary);
      assert.ok(last.summary.endsWith('итог операции — ошибка: Платформа отказала'), last.summary);
    });

    test('abort и успех fn: итог операции — компактный JSON результата', async () => {
      const extra = fakeExtra('t');
      const work = deferred<unknown>();
      const running = wrap(extra, () => work.promise);
      extra.controller.abort();
      work.resolve({ done: true });
      await running;
      assert.ok(outcomes.last()?.summary.endsWith('итог операции — {"done":true}'), outcomes.last()?.summary);
    });

    test('fn без результата (undefined): summary «выполнено», не строка «undefined»', async () => {
      await wrap(fakeExtra('t'), () => Promise.resolve(undefined));
      assert.strictEqual(outcomes.last()?.isError, false);
      assert.strictEqual(outcomes.last()?.summary, 'выполнено');
    });
  });

  suite('lastOperation: исход фиксируется в finally обёртки', () => {
    test('успех: tool, startedAt <= finishedAt, isError=false, summary — строка до 300 символов', async () => {
      await wrap(fakeExtra('t'), () => Promise.resolve({ path: 'Справочники.Товары', done: true }));
      const last = outcomes.last();
      assert.ok(last);
      assert.strictEqual(last.tool, TOOL);
      assert.strictEqual(last.isError, false);
      assert.ok(Number.isFinite(last.startedAt) && Number.isFinite(last.finishedAt) && last.startedAt <= last.finishedAt);
      assert.strictEqual(typeof last.summary, 'string');
      assert.ok(last.summary.length <= 300);
    });

    test('ошибка: summary — ПЕРВАЯ строка текста ошибки', async () => {
      await wrap(fakeExtra('t'), () => Promise.reject(new Error('Первая строка\nВторая строка\nТретья')));
      assert.strictEqual(outcomes.last()?.isError, true);
      assert.strictEqual(outcomes.last()?.summary, 'Первая строка');
    });

    test('ошибка не-Error (строка): summary — её текст', async () => {
      // Не-Error причина отказа: обёртка обязана уметь строку (toolError делает String(error)).
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      await wrap(fakeExtra('t'), () => Promise.reject('строка вместо Error'));
      assert.strictEqual(outcomes.last()?.isError, true);
      assert.strictEqual(outcomes.last()?.summary, 'строка вместо Error');
    });

    test('очень длинная первая строка ошибки укладывается в 300 символов', async () => {
      await wrap(fakeExtra('t'), () => Promise.reject(new Error('я'.repeat(2_000))));
      assert.ok((outcomes.last()?.summary.length ?? 9_999) <= 300);
    });

    test('последний исход заменяет предыдущий', async () => {
      await wrap(fakeExtra('t'), () => Promise.reject(new Error('первый')));
      await gate.wrapLongRunning('v8vscedit_other', fakeExtra('t'), () => Promise.resolve(1));
      assert.strictEqual(outcomes.last()?.tool, 'v8vscedit_other');
      assert.strictEqual(outcomes.last()?.isError, false);
    });
  });
});

// ─── Часть 2: обёртка на реальных инструментах ────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult>;

suite('Долгие MCP-инструменты: wrapLongRunning, MCP-текст «занято», execute_command, сквозной путь', function () {
  this.timeout(60_000);

  let p: RepoProject;
  let scheduler: ManualScheduler;
  let outcomes: McpOperationOutcomeRegistry;
  let gate: McpMutationGate;
  let tools: Map<string, Handler>;
  let executed: string[];
  // Оригинал фиксируется до любых setup: сбой setup не должен оставить в teardown затёртый executeCommand.
  const originalExecuteCommand = vscode.commands.executeCommand;

  interface ToolCase {
    readonly name: string;
    readonly args: () => Record<string, unknown>;
  }
  /** Все десять инструментов контракта 1.5. `confirm: true` — у load-ов и commit. */
  const CASES: readonly ToolCase[] = [
    { name: 'v8vscedit_repository_lock', args: () => ({ path: 'Справочники.Товары' }) },
    { name: 'v8vscedit_repository_update', args: () => ({ path: 'Справочники.Товары' }) },
    { name: 'v8vscedit_repository_commit', args: () => ({ path: 'Справочники.Товары', comment: 'Правка', confirm: true }) },
    { name: 'v8vscedit_repository_unlock', args: () => ({ path: 'Справочники.Товары' }) },
    { name: 'v8vscedit_update_database_configuration', args: () => ({ path: 'Конфигурация' }) },
    { name: 'v8vscedit_dump_cf', args: () => ({ outputFile: path.join(p.root, 'out.cf') }) },
    { name: 'v8vscedit_load_cf', args: () => ({ inputFile: path.join(p.root, 'in.cf'), confirm: true }) },
    { name: 'v8vscedit_dump_all_cfe', args: () => ({ outputDir: p.root }) },
    { name: 'v8vscedit_load_all_cfe', args: () => ({ inputDir: p.root, confirm: true }) },
    { name: 'v8vscedit_execute_command', args: () => ({ command: 'v8vscedit.importConfigurations' }) },
  ];

  setup(async () => {
    p = await createRepoProject();
    // Лента этапов общая (синглтон): этапы прошлых тестов обязаны быть строго старше момента старта вызова,
    // поэтому ручные часы стартуют с реального времени ПОСЛЕ следующей миллисекунды.
    waitForNextMillisecond();
    scheduler = new ManualScheduler(Date.now());
    outcomes = new McpOperationOutcomeRegistry();
    tools = new Map();
    executed = [];
    gate = new McpMutationGate(
      p.services,
      { scheduler, intervalMs: INTERVAL, readStage: () => operationStageFeed.current() },
      outcomes
    );
    const map: Record<string, MetadataNode> = {
      'Справочники.Товары': p.nodes.catalog,
      Конфигурация: p.nodes.cfRoot,
      'Расширение.Расш': p.nodes.cfeRoot,
    };
    const paths = {
      resolveNode: (canonical: string) => {
        if (!Object.prototype.hasOwnProperty.call(map, canonical)) {
          throw new Error(`Метаданные по пути "${canonical}" не найдены.`);
        }
        return map[canonical];
      },
    };
    const server = { registerTool: (name: string, _config: unknown, handler: Handler) => { tools.set(name, handler); } };
    const deps = { services: p.services, xmlEditor: {}, paths, properties: {}, mutations: {}, gate } as never;
    registerRepositoryTools(server as never, deps);
    registerConfigLifecycleTools(server as never, deps);

    // Команды расширения не исполняются по-настоящему: фиксируется только факт вызова `v8vscedit.*`.
    const commands = vscode.commands as unknown as { executeCommand: unknown };
    commands.executeCommand = (command: string, ...rest: unknown[]) => {
      if (typeof command === 'string' && command.startsWith('v8vscedit.')) {
        executed.push(command);
        return Promise.resolve(undefined);
      }
      return (originalExecuteCommand as (...args: unknown[]) => Thenable<unknown>).call(vscode.commands, command, ...rest);
    };
  });

  teardown(async () => {
    (vscode.commands as unknown as { executeCommand: unknown }).executeCommand = originalExecuteCommand;
    if (isConfigurationOperationRunning()) {
      await endConfigurationOperation();
    }
    await p.dispose();
  });

  const handler = (name: string): Handler => {
    const found = tools.get(name);
    assert.ok(found, `${name} не зарегистрирован`);
    return found;
  };

  suite('замок занят: MCP-текст, пульс взведён и погашен (все 10 инструментов)', () => {
    for (const { name, args } of CASES) {
      test(`${name}: isError с MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE, чужой замок цел, платформа не вызвана`, async () => {
        assert.strictEqual(await tryBeginConfigurationOperation(), true);
        const result = await handler(name)(args(), fakeExtra('t'));
        assert.strictEqual(result.isError, true, text(result));
        assert.strictEqual(text(result), MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE);
        assert.strictEqual(scheduler.totalScheduled, 1, 'обёртка вокруг инструмента: пульс взведён');
        assert.strictEqual(scheduler.pendingCount(), 0, 'и погашен');
        assert.strictEqual(isConfigurationOperationRunning(), true, 'чужой замок не снят');
        assert.deepStrictEqual(p.runs, []);
        assert.deepStrictEqual(p.events, []);
        assert.deepStrictEqual(executed, []);
        assert.strictEqual(outcomes.last()?.tool, name);
        assert.strictEqual(outcomes.last()?.isError, true);
        assert.deepStrictEqual(p.toasts, []);
      });
    }
  });

  suite('confirm не передан или false: обёртка и замок не задействованы', () => {
    const GUARDED: readonly { name: string; title: string; args: () => Record<string, unknown> }[] = [
      { name: 'v8vscedit_load_cf', title: 'confirm не передан', args: () => ({ inputFile: path.join(p.root, 'in.cf') }) },
      { name: 'v8vscedit_load_cf', title: 'confirm=false', args: () => ({ inputFile: path.join(p.root, 'in.cf'), confirm: false }) },
      { name: 'v8vscedit_load_all_cfe', title: 'confirm не передан', args: () => ({ inputDir: p.root }) },
      { name: 'v8vscedit_load_all_cfe', title: 'confirm=false', args: () => ({ inputDir: p.root, confirm: false }) },
    ];
    for (const { name, title, args } of GUARDED) {
      test(`${name}, ${title}: отказ по confirm до обёртки (пульс не взводится), исхода нет`, async () => {
        const result = await handler(name)(args(), fakeExtra('t'));
        assert.strictEqual(result.isError, true);
        assert.ok(text(result).includes('confirm: true'), text(result));
        assert.strictEqual(scheduler.totalScheduled, 0);
        assert.strictEqual(outcomes.last() ?? null, null);
        assert.strictEqual(isConfigurationOperationRunning(), false);
      });
    }
  });

  suite('execute_command при занятом замке (закрывает висящий диалог UI и ложный «успех»)', () => {
    const BLOCKED = ['v8vscedit.importConfigurations', 'v8vscedit.updateChangedConfigurations'] as const;
    for (const command of BLOCKED) {
      test(`${command}: замок занят — сразу MCP-текст «занято», команда UI не вызывается`, async () => {
        assert.strictEqual(await tryBeginConfigurationOperation(), true);
        const result = await handler('v8vscedit_execute_command')({ command }, fakeExtra('t'));
        assert.strictEqual(result.isError, true);
        assert.strictEqual(text(result), MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE);
        assert.deepStrictEqual(executed, []);
        assert.strictEqual(isConfigurationOperationRunning(), true);
      });

      test(`${command}: замок свободен — команда выполняется как прежде; MCP замок не занимает (его берёт сама команда)`, async () => {
        const result = await handler('v8vscedit_execute_command')({ command }, fakeExtra('t'));
        assert.strictEqual(result.isError, undefined, text(result));
        assert.deepStrictEqual(JSON.parse(text(result)), { command, result: null });
        assert.deepStrictEqual(executed, [command]);
        assert.strictEqual(isConfigurationOperationRunning(), false);
      });
    }

    test('refresh не блокируется занятым замком', async () => {
      assert.strictEqual(await tryBeginConfigurationOperation(), true);
      const result = await handler('v8vscedit_execute_command')({ command: 'v8vscedit.refresh' }, fakeExtra('t'));
      assert.strictEqual(result.isError, undefined, text(result));
      assert.deepStrictEqual(executed, ['v8vscedit.refresh']);
    });

    test('без extra (старые тесты с фейковым сервером): та же проверка замка, пульса нет', async () => {
      assert.strictEqual(await tryBeginConfigurationOperation(), true);
      const result = await handler('v8vscedit_execute_command')({ command: 'v8vscedit.importConfigurations' });
      assert.strictEqual(text(result), MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE);
      assert.strictEqual(scheduler.totalScheduled, 0);
    });
  });

  suite('пульс на реальном инструменте', () => {
    test('update_database_configuration: пока операция идёт, пульс приходит с токеном; после результата — таймеров нет, исход записан', async () => {
      const entered = deferred();
      const release = deferred<boolean>();
      (extensionRunner as unknown as Record<string, unknown>).runApplyDatabaseConfiguration = () => {
        entered.resolve();
        return release.promise;
      };
      const extra = fakeExtra('tool-token');
      const running = handler('v8vscedit_update_database_configuration')({ path: 'Конфигурация' }, extra);
      await entered.promise;
      await scheduler.fireNext();
      assert.deepStrictEqual(extra.notifications, [
        {
          method: 'notifications/progress',
          params: {
            progressToken: 'tool-token', progress: 20,
            message: 'v8vscedit_update_database_configuration: выполняется 20 с',
          },
        },
      ]);
      release.resolve(true);
      const result = await running;
      assert.strictEqual(result.isError, undefined, text(result));
      assert.strictEqual(scheduler.pendingCount(), 0);
      assert.strictEqual(outcomes.last()?.tool, 'v8vscedit_update_database_configuration');
      assert.strictEqual(outcomes.last()?.isError, false);
    });
  });

  suite('сквозной путь: onOutput раннера хранилища → статус-бар → лента → текст пульса', () => {
    test('строка вывода Конфигуратора при захвате попадает в «— <заголовок>: <этап>» пульса', async () => {
      p.setResult(opLog(LOCK_DONE, 'Объект захвачен для редактирования: Справочник.Товары'));
      const started = deferred();
      const release = deferred();
      const executor = {
        run: async (request: { onOutput?: (line: string) => void }) => {
          request.onOutput?.('  Захват   объектов   Товары \r\n');
          started.resolve();
          await release.promise;
          return p.result;
        },
        dispose: () => Promise.resolve(),
      };
      (p.services as unknown as { createDesignerExecutor: unknown }).createDesignerExecutor = () => executor;

      const extra = fakeExtra();
      const running = handler('v8vscedit_repository_lock')({ path: 'Справочники.Товары' }, extra);
      await started.promise;
      await scheduler.fireNext();

      assert.strictEqual(extra.notifications.length, 1);
      const pulse = extra.notifications[0].params as { data: string };
      assert.ok(pulse.data.startsWith('v8vscedit_repository_lock: выполняется 20 с — '), pulse.data);
      assert.ok(pulse.data.endsWith(': Захват объектов Товары'), `этап — строка вывода без лишних пробелов: ${pulse.data}`);

      release.resolve();
      const result = await running;
      assert.strictEqual(result.isError, undefined, text(result));
      assert.strictEqual(scheduler.pendingCount(), 0);
    });
  });
});
