import * as assert from 'assert';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as vscode from 'vscode';
import { EXTENSION_MCP_TOOLS } from '../../infra/ai/AiMcpToolCatalog';
import { McpOperationOutcomeRegistry } from '../../infra/mcp/McpOperationOutcome';
import { SERVER_DUMP_POLICY } from '../../infra/agent/sync/SyncPlanner';
import { describeUnattendedFullDumpRefusal, describeUnattendedQuestion } from '../../ui/commands/ext/agent/unattendedAgentHooks';
import {
  MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE,
  isConfigurationOperationRunning,
  tryBeginConfigurationOperation,
} from '../../ui/commands/ext/configurationOperationLock';
import { NO_IMPORT_TARGETS } from '../../ui/commands/ext/importTargets';
import { resolveConfigurationXmlByCanonical } from '../../ui/mcp/McpPathResolvers';
import { registerConfigLifecycleTools } from '../../ui/mcp/registration/McpConfigLifecycleTools';
import { MCP_IMPORT_TARGETS_SCHEMA, registerImportTools } from '../../ui/mcp/registration/McpImportTools';
import { McpMutationGate } from '../../ui/mcp/registration/McpMutationGate';
import type { MetadataNode } from '../../ui/tree/TreeNode';
import { fakeExtra } from './support/mcpFakeExtra';
import { createImportHarness, type ImportHarness } from './support/importHarness';
import { removeTreeSync } from './support/tempTree';

/**
 * `v8vscedit_import_configurations` и мост `execute_command importConfigurations`
 * (`ui/mcp/registration/McpImportTools.ts`, `McpConfigLifecycleTools.ts`): `targets` обязателен и без
 * умолчания, импорт идёт общим раннером в режиме unattended (ни окон, ни тостов), на первой неудаче
 * остановка со статусами imported/failed/skipped, `gate.afterMutation` НЕ вызывается (файлы проекта равны
 * базе), `databaseConfigurationBehind` — в каждой цели. Стенд — `support/importHarness.ts`: настоящие
 * раннеры, подменён только агент 1С; окна запрещены.
 */
interface Tool {
  readonly description: string;
  readonly annotations?: { readonly destructiveHint?: boolean };
  readonly inputSchema: { safeParse(value: unknown): { success: boolean }; shape: Record<string, { def?: { type?: string } }> };
  readonly handler: (args: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult>;
}

const text = (result: CallToolResult): string => {
  const part = result.content[0];
  return part.type === 'text' ? part.text : '';
};

suite('v8vscedit_import_configurations', function () {
  this.timeout(60_000);

  let h: ImportHarness;
  let tools: Map<string, Tool>;
  let resolved: { path: string; configuration?: string }[];
  let outcomes: McpOperationOutcomeRegistry;
  let gate: McpMutationGate;
  let afterMutationCalls: number;
  let paths: { resolveNode: (canonical: string, configuration?: string) => MetadataNode };
  let executed: string[];
  const originalExecuteCommand = vscode.commands.executeCommand;

  const run = (args: Record<string, unknown>, extra = fakeExtra()): Promise<CallToolResult> => {
    const tool = tools.get('v8vscedit_import_configurations');
    assert.ok(tool, 'v8vscedit_import_configurations не зарегистрирован в registerImportTools');
    return Promise.resolve(tool.handler(args, extra));
  };
  const bridge = (command: string): Promise<CallToolResult> => {
    const tool = tools.get('v8vscedit_execute_command');
    assert.ok(tool);
    return Promise.resolve(tool.handler({ command }, fakeExtra()));
  };
  const parse = (result: CallToolResult): Record<string, unknown> => {
    assert.ok(result.isError !== true, `ожидался успех: ${text(result)}`);
    return JSON.parse(text(result)) as Record<string, unknown>;
  };
  const refusal = (name: string, rootPath: string, kind: 'cf' | 'cfe'): string => describeUnattendedFullDumpRefusal({
    targetKind: kind, targetName: name, projectDir: rootPath, operation: 'import', reason: 'mirror-empty',
    reasonText: SERVER_DUMP_POLICY['mirror-empty'].text, download: SERVER_DUMP_POLICY['mirror-empty'].download,
  });

  setup(async () => {
    h = await createImportHarness();
    h.forbidWindows();
    resolved = [];
    outcomes = new McpOperationOutcomeRegistry();
    gate = new McpMutationGate(h.p.services, undefined, outcomes);
    afterMutationCalls = 0;
    const originalAfterMutation = gate.afterMutation.bind(gate);
    gate.afterMutation = (...args: Parameters<McpMutationGate['afterMutation']>) => {
      afterMutationCalls += 1;
      originalAfterMutation(...args);
    };

    paths = {
      resolveNode: (canonical, configuration) => {
        resolved.push({ path: canonical, configuration });
        if (canonical === 'Конфигурация') { return h.p.nodes.cfRoot; }
        if (canonical === 'Расширение') {
          if (configuration === undefined) { throw new Error('Укажите configuration: в проекте несколько конфигураций.'); }
          if (configuration !== 'Расш') { throw new Error(`Конфигурация "${configuration}" не найдена.`); }
          return h.p.nodes.cfeRoot;
        }
        if (canonical === 'Справочники.Товары') { return h.p.nodes.catalog; }
        throw new Error(`Метаданные по пути "${canonical}" не найдены.`);
      },
    };
    tools = new Map();
    const server = {
      registerTool: (name: string, config: Omit<Tool, 'handler'>, handler: Tool['handler']) => { tools.set(name, { ...config, handler }); },
    };
    const deps = { services: h.p.services, xmlEditor: {}, paths, properties: {}, mutations: {}, gate } as never;
    registerImportTools(server as never, deps);
    registerConfigLifecycleTools(server as never, deps);

    executed = [];
    (vscode.commands as unknown as { executeCommand: unknown }).executeCommand = (command: string, ...rest: unknown[]) => {
      if (typeof command === 'string' && command.startsWith('v8vscedit.')) {
        executed.push(command);
        return Promise.resolve(undefined);
      }
      return (originalExecuteCommand as (...args: unknown[]) => Thenable<unknown>).call(vscode.commands, command, ...rest);
    };
  });
  teardown(async () => {
    (vscode.commands as unknown as { executeCommand: unknown }).executeCommand = originalExecuteCommand;
    await h.dispose();
  });

  test('схема: targets обязателен без умолчания; all и непустой массив корней — допустимы; пустой массив, All, имя-строка, элемент без path — ошибка', () => {
    const tool = tools.get('v8vscedit_import_configurations');
    assert.ok(tool);
    assert.deepStrictEqual(
      Object.fromEntries(Object.entries(tool.inputSchema.shape).map(([key, schema]) => [key, schema.def?.type === 'optional'])),
      { targets: false }
    );
    const ok = (value: unknown): boolean => tool.inputSchema.safeParse(value).success;
    assert.strictEqual(ok({}), false, 'без targets');
    assert.strictEqual(ok({ targets: 'all' }), true);
    assert.strictEqual(ok({ targets: [] }), false);
    assert.strictEqual(ok({ targets: [{ path: 'Конфигурация' }] }), true);
    assert.strictEqual(ok({ targets: [{ path: 'Расширение', configuration: 'Расш' }] }), true);
    assert.strictEqual(ok({ targets: [{ configuration: 'X' }] }), false);
    assert.strictEqual(ok({ targets: 'ALL' }), false);
    assert.strictEqual(ok({ targets: 'Расш' }), false);
    assert.strictEqual(MCP_IMPORT_TARGETS_SCHEMA.safeParse('all').success, true);
    assert.strictEqual(MCP_IMPORT_TARGETS_SCHEMA.safeParse([]).success, false);
    assert.strictEqual(tool.annotations?.destructiveHint, true);
  });

  test("'all': cf и cfe импортируются в unattended; структурный ответ; databaseConfigurationBehind по цели; warnings нет", async () => {
    h.p.lag.markBehind({ kind: 'cf', name: 'Основная', rootPath: h.p.cfRoot }, 'repository-receive');

    const result = parse(await run({ targets: 'all' }));

    assert.deepStrictEqual(result, {
      requested: 'all',
      completed: true,
      imported: 2,
      failed: 0,
      skipped: 0,
      targets: [
        { path: 'Конфигурация', configuration: 'Основная', kind: 'cf', name: 'Основная', status: 'imported', databaseConfigurationBehind: true },
        { path: 'Расширение', configuration: 'Расш', kind: 'cfe', name: 'Расш', status: 'imported', databaseConfigurationBehind: false },
      ],
    });
    assert.deepStrictEqual(h.calls.map((c) => c.target.name), ['Основная', 'Расш']);
    assert.strictEqual(isConfigurationOperationRunning(), false);
    assert.deepStrictEqual(h.violations, []);
    assert.deepStrictEqual(h.p.toasts, []);
  });

  test('[{ path: Расширение, configuration }] → только расширение; configuration проброшена резолверу; requested — эхо массива', async () => {
    const targets = [{ path: 'Расширение', configuration: 'Расш' }];

    const result = parse(await run({ targets }));

    assert.deepStrictEqual(h.calls.map((c) => c.target.name), ['Расш']);
    assert.deepStrictEqual(result.requested, targets);
    assert.strictEqual(result.imported, 1);
    assert.deepStrictEqual(resolved.at(-1), { path: 'Расширение', configuration: 'Расш' });
  });

  test('путь не корень (Справочники.Товары): isError с текстом резолвера корня, импорта нет', async () => {
    let expected = '';
    try {
      resolveConfigurationXmlByCanonical(paths as never, 'Справочники.Товары');
    } catch (error) {
      expected = (error as Error).message;
    }
    assert.ok(expected);

    const result = await run({ targets: [{ path: 'Справочники.Товары' }] });

    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), expected);
    assert.strictEqual(h.calls.length, 0);
    assert.strictEqual(isConfigurationOperationRunning(), false);
  });

  test('неизвестный путь и расширение без configuration: isError резолвера, импорта нет', async () => {
    const unknown = await run({ targets: [{ path: 'Catalog.Товары' }] });
    assert.strictEqual(unknown.isError, true);
    const noConfiguration = await run({ targets: [{ path: 'Расширение' }] });
    assert.strictEqual(noConfiguration.isError, true);
    assert.ok(text(noConfiguration).includes('configuration'), text(noConfiguration));
    assert.strictEqual(h.calls.length, 0);
  });

  test('замок занят: isError MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE, импорта нет, чужой замок не снят', async () => {
    assert.strictEqual(await tryBeginConfigurationOperation(), true);
    const result = await run({ targets: 'all' });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE);
    assert.strictEqual(h.calls.length, 0);
    assert.strictEqual(isConfigurationOperationRunning(), true);
  });

  test('отказ unattended на cf (полная выгрузка): НЕ isError; completed=false; cf failed + requiresUserAction + текст, cfe skipped; окон и тостов нет', async () => {
    h.behavior.set('Основная', h.askFullDump('mirror-empty'));

    const result = parse(await run({ targets: 'all' }));

    assert.deepStrictEqual(result, {
      requested: 'all',
      completed: false,
      imported: 0,
      failed: 1,
      skipped: 1,
      targets: [
        {
          path: 'Конфигурация', configuration: 'Основная', kind: 'cf', name: 'Основная', status: 'failed',
          reason: refusal('Основная', h.p.cfRoot, 'cf'), requiresUserAction: true, databaseConfigurationBehind: false,
        },
        {
          path: 'Расширение', configuration: 'Расш', kind: 'cfe', name: 'Расш', status: 'skipped',
          reason: 'Не выполнялся: импорт остановлен на «Основная».', databaseConfigurationBehind: false,
        },
      ],
    });
    assert.deepStrictEqual(h.violations, []);
    assert.deepStrictEqual(h.p.toasts, []);
    assert.strictEqual(isConfigurationOperationRunning(), false);
  });

  test('частичный отказ: cf imported, cfe failed — ответ структурный, сводка 1/1/0', async () => {
    h.behavior.set('Расш', h.askFullDump('mirror-empty'));
    const result = parse(await run({ targets: 'all' }));
    assert.deepStrictEqual([result.completed, result.imported, result.failed, result.skipped], [false, 1, 1, 0]);
    const targets = result.targets as { status: string }[];
    assert.deepStrictEqual(targets.map((t) => t.status), ['imported', 'failed']);
  });

  test('агент задал вопрос и завершился успехом → цель imported с warnings; общий warnings отсутствует', async () => {
    h.behavior.set('Основная', async (call) => {
      await call.hooks.onQuestion?.({ type: 'question', message: 'Продолжить?' });
    });

    const result = parse(await run({ targets: [{ path: 'Конфигурация' }] }));

    assert.strictEqual(result.completed, true);
    const targets = result.targets as { status: string; warnings?: string[] }[];
    assert.deepStrictEqual(targets[0].warnings, [describeUnattendedQuestion('Продолжить?')]);
    assert.strictEqual(result.warnings, undefined);
  });

  test('предупреждение перезапуска автономного сервера попадает в общий warnings ответа', async () => {
    h.standalone.configured = true;
    h.standalone.state = 'running';
    h.standalone.startState = 'stopped';
    const result = parse(await run({ targets: 'all' }));
    assert.strictEqual((result.warnings as string[]).length, 1);
    assert.ok((result.warnings as string[])[0].includes('сервер не поднялся'));
  });

  test('автономный сервер остановлен, импорт неуспешен: предупреждение «не перезапущен» попадает в warnings ответа', async () => {
    h.standalone.configured = true;
    h.standalone.state = 'running';
    h.behavior.set('Основная', h.askFullDump('mirror-empty'));
    const result = parse(await run({ targets: 'all' }));
    assert.deepStrictEqual(result.warnings, [
      'Автономный сервер остановлен и не перезапущен: операция "Импорт конфигураций" завершилась с ошибкой.',
    ]);
    assert.strictEqual(h.standalone.starts.length, 0);
  });

  test('result.error (refreshHealth бросает) → isError', async () => {
    h.standalone.refreshError = new Error('сервер недоступен');
    const result = await run({ targets: 'all' });
    assert.strictEqual(result.isError, true);
    assert.ok(text(result).includes('сервер недоступен'), text(result));
  });

  test('нет целей (пустые записи, нет src/cf) → isError NO_IMPORT_TARGETS', async () => {
    h.p.entries = [];
    removeTreeSync(h.p.cfRoot);
    const result = await run({ targets: 'all' });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), NO_IMPORT_TARGETS);
  });

  test('gate.afterMutation НЕ вызывается; markConfigurationsClean, reloadEntries и refreshActionsView — вызваны', async () => {
    parse(await run({ targets: 'all' }));
    assert.strictEqual(afterMutationCalls, 0);
    assert.deepStrictEqual(h.p.markChangedCalls, []);
    assert.deepStrictEqual(h.p.cleaned.flat().sort(), [h.p.cfRoot, h.p.cfeRoot].sort());
    assert.strictEqual(h.p.reloads, 1);
    assert.ok(h.p.actionViewRefreshes > 0, 'refreshActionsView');
  });

  test('lastOperation записан с tool = v8vscedit_import_configurations', async () => {
    parse(await run({ targets: 'all' }, fakeExtra('t')));
    assert.strictEqual(outcomes.last()?.tool, 'v8vscedit_import_configurations');
    assert.strictEqual(outcomes.last()?.isError, false);
  });

  suite('мост execute_command importConfigurations', () => {
    test('UI-команда не вызывается; ответ — { command, result: ответ §3.3 для all }', async () => {
      const result = parse(await bridge('v8vscedit.importConfigurations'));
      assert.deepStrictEqual(executed, []);
      assert.strictEqual(result.command, 'v8vscedit.importConfigurations');
      const inner = result.result as Record<string, unknown>;
      assert.strictEqual(inner.requested, 'all');
      assert.strictEqual(inner.completed, true);
      assert.strictEqual(inner.imported, 2);
      assert.deepStrictEqual(h.violations, []);
    });

    test('замок занят → isError BUSY, импорта нет', async () => {
      assert.strictEqual(await tryBeginConfigurationOperation(), true);
      const result = await bridge('v8vscedit.importConfigurations');
      assert.strictEqual(result.isError, true);
      assert.strictEqual(text(result), MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE);
      assert.strictEqual(h.calls.length, 0);
      assert.deepStrictEqual(executed, []);
    });

    test('регресс: refresh и updateChangedConfigurations по-прежнему выполняются командой UI', async () => {
      assert.deepStrictEqual(parse(await bridge('v8vscedit.refresh')), { command: 'v8vscedit.refresh', result: null });
      assert.deepStrictEqual(
        parse(await bridge('v8vscedit.updateChangedConfigurations')),
        { command: 'v8vscedit.updateChangedConfigurations', result: null }
      );
      assert.deepStrictEqual(executed, ['v8vscedit.refresh', 'v8vscedit.updateChangedConfigurations']);
    });
  });

  suite('load_configuration_changes: отказ unattended несёт причину', () => {
    test('пустое зеркало на загрузке (полная выгрузка) → isError с текстом load-отказа, а не «Подробности — в журнале»; окон нет', async () => {
      h.loadBehavior = h.askFullDump('mirror-empty', 'load');
      const tool = tools.get('v8vscedit_load_configuration_changes');
      assert.ok(tool);

      const result = await tool.handler({ path: 'Конфигурация', updateDatabase: false }, fakeExtra());

      assert.strictEqual(result.isError, true);
      const expected = describeUnattendedFullDumpRefusal({
        targetKind: 'cf', targetName: 'Основная конфигурация', projectDir: h.p.cfRoot, operation: 'load',
        reason: 'mirror-empty', reasonText: SERVER_DUMP_POLICY['mirror-empty'].text, download: true,
      });
      assert.strictEqual(text(result), expected);
      assert.ok(!text(result).includes('Подробности — в журнале'), text(result));
      assert.deepStrictEqual(h.violations, []);
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });
  });
});

suite('EXTENSION_MCP_TOOLS: v8vscedit_import_configurations', () => {
  const entry = (name: string) => EXTENSION_MCP_TOOLS.find((tool) => tool.name === name);

  test('инструмент описан: профиль extension, targets и unattended-контракт в описании, требование задано', () => {
    const item = entry('v8vscedit_import_configurations');
    assert.ok(item, 'инструмент не внесён в EXTENSION_MCP_TOOLS');
    assert.strictEqual(item.profile, 'extension');
    assert.ok(item.description.includes('targets'), item.description);
    assert.ok(item.description.includes('"all"'), item.description);
    assert.ok(item.description.includes('интерфейса VS Code'), item.description);
    assert.ok(item.requirement.includes('env.json'), item.requirement);
  });

  test('запись стоит после v8vscedit_load_configuration_changes и не задвоена', () => {
    const names = EXTENSION_MCP_TOOLS.map((tool) => tool.name);
    assert.strictEqual(names.filter((name) => name === 'v8vscedit_import_configurations').length, 1);
    assert.strictEqual(names.indexOf('v8vscedit_import_configurations'), names.indexOf('v8vscedit_load_configuration_changes') + 1);
  });

  test('описание execute_command: importConfigurations импортирует всё без окна, выбор целей — через новый инструмент', () => {
    const description = entry('v8vscedit_execute_command')?.description ?? '';
    assert.ok(description.includes('v8vscedit_import_configurations'), description);
    assert.ok(description.includes('без окна'), description);
  });
});
