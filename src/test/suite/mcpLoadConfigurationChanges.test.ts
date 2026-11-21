import * as assert from 'assert';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE,
  isConfigurationOperationRunning,
  tryBeginConfigurationOperation,
} from '../../ui/commands/ext/configurationOperationLock';
import { EXTENSION_MCP_TOOLS } from '../../infra/ai/AiMcpToolCatalog';
import { resolveConfigurationXmlByCanonical } from '../../ui/mcp/McpPathResolvers';
import { registerConfigLifecycleTools } from '../../ui/mcp/registration/McpConfigLifecycleTools';
import { McpMutationGate } from '../../ui/mcp/registration/McpMutationGate';
import type { MetadataNode } from '../../ui/tree/TreeNode';
import { fakeExtra } from './support/mcpFakeExtra';
import { createRepoProject, type RepoProject } from './support/repositoryMcpFixtures';

/**
 * `v8vscedit_load_configuration_changes` (`McpConfigLifecycleTools.ts`): загрузка изменённых файлов корня в
 * основную конфигурацию с ЯВНЫМ выбором обновления БД. `updateDatabase` ОБЯЗАТЕЛЕН (без значения по
 * умолчанию): решение о минутах реструктуризации агент принимает сам. Цель — `resolveApplyTargetFromNode`;
 * зовёт ТЕ ЖЕ раннеры, что команда UI; замок бросающий; после успеха `markConfigurationsClean([корень])` и
 * `refreshActionsView`, а `gate.afterMutation` НЕ вызывается (файлы проекта не менялись — пометка «изменено»
 * залила бы старые файлы поверх базы).
 */
interface Tool {
  readonly description: string;
  readonly inputSchema: { safeParse(value: unknown): { success: boolean }; shape: Record<string, { def?: { type?: string } }> };
  readonly handler: (args: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult>;
}

suite('v8vscedit_load_configuration_changes', function () {
  this.timeout(60_000);

  let p: RepoProject;
  let tool: Tool;
  let resolved: { path: string; configuration?: string }[];
  let paths: { resolveNode: (canonical: string, configuration?: string) => MetadataNode };

  const text = (result: CallToolResult): string => {
    const part = result.content[0];
    return part.type === 'text' ? part.text : '';
  };
  const run = (args: Record<string, unknown>): Promise<CallToolResult> => Promise.resolve(tool.handler(args, fakeExtra()));
  const parse = (result: CallToolResult): Record<string, unknown> => {
    assert.ok(result.isError !== true, `ожидался успех: ${text(result)}`);
    return JSON.parse(text(result)) as Record<string, unknown>;
  };

  setup(async () => {
    p = await createRepoProject();
    resolved = [];
    const map: Record<string, MetadataNode> = {
      Конфигурация: p.nodes.cfRoot,
      'Расширение.Расш': p.nodes.cfeRoot,
      'Справочники.Товары': p.nodes.catalog,
    };
    paths = {
      resolveNode: (canonical, configuration) => {
        resolved.push({ path: canonical, configuration });
        if (!Object.prototype.hasOwnProperty.call(map, canonical)) {
          throw new Error(`Метаданные по пути "${canonical}" не найдены.`);
        }
        return map[canonical];
      },
    };
    const tools = new Map<string, Tool>();
    registerConfigLifecycleTools({
      registerTool: (name: string, config: Omit<Tool, 'handler'>, handler: Tool['handler']) => { tools.set(name, { ...config, handler }); },
    } as never, {
      services: p.services, xmlEditor: {}, paths, properties: {}, mutations: {}, gate: new McpMutationGate(p.services),
    } as never);
    const registered = tools.get('v8vscedit_load_configuration_changes');
    assert.ok(registered, 'v8vscedit_load_configuration_changes не зарегистрирован в registerConfigLifecycleTools');
    tool = registered;
  });
  teardown(() => p.dispose());

  test('схема: path и updateDatabase обязательны, configuration необязателен; без updateDatabase — ошибка схемы', () => {
    const optional = Object.fromEntries(Object.entries(tool.inputSchema.shape).map(([key, schema]) => [key, schema.def?.type === 'optional']));
    assert.deepStrictEqual(optional, { path: false, configuration: true, updateDatabase: false });
    assert.strictEqual(tool.inputSchema.safeParse({ path: 'Конфигурация' }).success, false, 'без updateDatabase');
    assert.strictEqual(tool.inputSchema.safeParse({ path: 'Конфигурация', updateDatabase: 'yes' }).success, false, 'не boolean');
    assert.strictEqual(tool.inputSchema.safeParse({ path: 'Конфигурация', updateDatabase: false }).success, true);
    assert.strictEqual(tool.inputSchema.safeParse({ path: 'Конфигурация', configuration: 'Расш', updateDatabase: true }).success, true);
  });

  test('описание: про явный выбор обновления БД и отличие от execute_command', () => {
    assert.ok(tool.description.includes('updateDatabase'), tool.description);
    assert.ok(tool.description.includes('реструктуризац'), tool.description);
  });

  for (const updateDatabase of [true, false]) {
    test(`основная конфигурация, updateDatabase=${String(updateDatabase)}: раннер с { updateDatabase, lag }, под замком; поля ответа; проект помечен чистым; afterMutation не вызван`, async () => {
      const result = parse(await run({ path: 'Конфигурация', updateDatabase }));

      assert.deepStrictEqual(result, {
        path: 'Конфигурация', kind: 'cf', name: 'Основная конфигурация', updateDatabase,
        databaseConfigurationUpdated: updateDatabase, databaseConfigurationBehind: !updateDatabase,
      });
      assert.deepStrictEqual(p.events, ['update:cf']);
      assert.strictEqual(p.lockHeldAt['update:cf'], true);
      assert.strictEqual(p.updateCalls[0][0], 'Основная конфигурация');
      assert.strictEqual(p.updateCalls[0][1], p.cfRoot);
      assert.strictEqual(p.updateOptions().updateDatabase, updateDatabase);
      assert.strictEqual(p.updateOptions().lag, p.services.databaseConfigLag);
      assert.deepStrictEqual(p.cleaned, [[p.cfRoot]]);
      assert.ok(p.actionViewRefreshes > 0, 'refreshActionsView');
      assert.deepStrictEqual(p.suppressCalls, []);
      assert.deepStrictEqual(p.markChangedCalls, []);
      assert.deepStrictEqual(p.toasts, []);
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });

    test(`расширение, updateDatabase=${String(updateDatabase)}: раннер расширения, configuration проброшена резолверу пути`, async () => {
      const result = parse(await run({ path: 'Расширение.Расш', configuration: 'Расш', updateDatabase }));

      assert.strictEqual(result.kind, 'cfe');
      assert.strictEqual(result.name, 'Расш');
      assert.strictEqual(result.updateDatabase, updateDatabase);
      assert.strictEqual(result.databaseConfigurationUpdated, updateDatabase);
      assert.deepStrictEqual(p.events, ['update:cfe:Расш']);
      assert.strictEqual(p.updateCalls[0][1], p.cfeRoot);
      assert.strictEqual(p.updateOptions().updateDatabase, updateDatabase);
      assert.deepStrictEqual(p.cleaned, [[p.cfeRoot]]);
      assert.deepStrictEqual(resolved.at(-1), { path: 'Расширение.Расш', configuration: 'Расш' });
    });
  }

  test('цель уже отстаёт и updateDatabase=true: загрузка с обновлением снимает отметку, databaseConfigurationBehind=false', async () => {
    p.lag.markBehind({ kind: 'cf', name: 'Основная конфигурация', rootPath: p.cfRoot }, 'load-without-update');
    const result = parse(await run({ path: 'Конфигурация', updateDatabase: true }));
    assert.strictEqual(result.databaseConfigurationBehind, false);
  });

  test('databaseConfigurationUpdated — фактическое из раннера: без изменений и без отставания UpdateDBCfg не выполнялся', async () => {
    p.loadDatabaseUpdated = false;
    const result = parse(await run({ path: 'Конфигурация', updateDatabase: true }));
    assert.strictEqual(result.updateDatabase, true);
    assert.strictEqual(result.databaseConfigurationUpdated, false);
  });

  test('silent: раннер вызывается без уведомлений, предупреждения сверки (E11) — в ответе', async () => {
    p.loadWarnings = ['Имя расширения в базе взято из файла: «Расш2»'];
    const result = parse(await run({ path: 'Расширение.Расш', configuration: 'Расш', updateDatabase: true }));
    assert.strictEqual((p.updateOptions() as { silent?: boolean }).silent, true);
    assert.deepStrictEqual(result.warnings, ['Имя расширения в базе взято из файла: «Расш2»']);
    assert.deepStrictEqual(p.toasts, []);
  });

  test('платформа вернула неуспех: isError со ссылкой на журнал, проект не помечен чистым, замок освобождён', async () => {
    p.updateResult = false;

    const result = await run({ path: 'Конфигурация', updateDatabase: true });

    assert.strictEqual(result.isError, true);
    assert.ok(text(result).includes('Подробности — в журнале «1С Редактор»'), text(result));
    assert.deepStrictEqual(p.cleaned, []);
    assert.strictEqual(isConfigurationOperationRunning(), false);
  });

  test('не корень (объект): ошибка с ТЕМ ЖЕ текстом, что у resolveConfigurationXmlByCanonical; раннер не вызывался', async () => {
    let expected = '';
    try {
      resolveConfigurationXmlByCanonical(paths as never, 'Справочники.Товары');
    } catch (error) {
      expected = (error as Error).message;
    }
    assert.ok(expected);

    const result = await run({ path: 'Справочники.Товары', updateDatabase: true });

    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), expected);
    assert.deepStrictEqual(p.events, []);
  });

  test('неизвестный путь: isError, раннер не вызывался', async () => {
    const result = await run({ path: 'Catalog.Товары', updateDatabase: false });
    assert.strictEqual(result.isError, true);
    assert.deepStrictEqual(p.events, []);
  });

  test('замок занят: MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE, раннер не вызывался, чужой замок не снят', async () => {
    assert.strictEqual(await tryBeginConfigurationOperation(), true);

    const result = await run({ path: 'Конфигурация', updateDatabase: false });

    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE);
    assert.deepStrictEqual(p.events, []);
    assert.strictEqual(isConfigurationOperationRunning(), true);
  });
});

suite('EXTENSION_MCP_TOOLS: каталог инструментов для ИИ-агентов и загрузка без обновления БД', () => {
  const entry = (name: string) => EXTENSION_MCP_TOOLS.find((tool) => tool.name === name);

  test('v8vscedit_load_configuration_changes описан: профиль extension, описание про updateDatabase и реструктуризацию, требование', () => {
    const item = entry('v8vscedit_load_configuration_changes');
    assert.ok(item, 'инструмент не внесён в EXTENSION_MCP_TOOLS');
    assert.strictEqual(item.profile, 'extension');
    assert.ok(item.description.includes('updateDatabase'), item.description);
    assert.ok(item.description.includes('реструктуризац'), item.description);
    assert.ok(item.requirement.trim().length > 0);
  });

  test('описание execute_command: updateChangedConfigurations следует настройке updateDatabaseAfterLoad, явный выбор — новым инструментом', () => {
    const description = entry('v8vscedit_execute_command')?.description ?? '';
    assert.ok(description.includes('updateDatabaseAfterLoad'), description);
    assert.ok(description.includes('v8vscedit_load_configuration_changes'), description);
  });

  test('описание update_database_configuration ссылается на новый инструмент для загрузки файлов', () => {
    const description = entry('v8vscedit_update_database_configuration')?.description ?? '';
    assert.ok(description.includes('v8vscedit_load_configuration_changes'), description);
  });

  test('имена в каталоге уникальны (новый инструмент не задвоен)', () => {
    const names = EXTENSION_MCP_TOOLS.map((tool) => tool.name);
    assert.strictEqual(new Set(names).size, names.length);
  });
});
