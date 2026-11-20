import * as assert from 'assert';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CONFIGURATION_OPERATION_BUSY_MESSAGE, isConfigurationOperationRunning, tryBeginConfigurationOperation } from '../../ui/commands/ext/configurationOperationLock';
import { resolveConfigurationXmlByCanonical } from '../../ui/mcp/McpPathResolvers';
import { registerConfigLifecycleTools } from '../../ui/mcp/registration/McpConfigLifecycleTools';
import { McpMutationGate } from '../../ui/mcp/registration/McpMutationGate';
import type { MetadataNode } from '../../ui/tree/TreeNode';
import { createRepoProject, type RepoProject } from './support/repositoryMcpFixtures';

/**
 * `v8vscedit_update_database_configuration` (`McpConfigLifecycleTools.ts`): `/UpdateDBCfg` по корню
 * конфигурации/расширения. Цель — `resolveApplyTargetFromNode(node)` (корень из реального
 * `Configuration.xml` узла), под бросающим замком; `gate.afterMutation` НЕ вызывается — файлы проекта
 * не менялись (пометка «изменено» залила бы старые файлы поверх базы).
 */

interface Tool {
  readonly description: string;
  readonly inputSchema: unknown;
  readonly annotations?: { readonly destructiveHint?: boolean };
  readonly handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

const NOTE =
  '/UpdateDBCfg не загружает файлы проекта: правки применятся только после v8vscedit_execute_command v8vscedit.updateChangedConfigurations';

suite('v8vscedit_update_database_configuration', function () {
  this.timeout(60_000);

  let p: RepoProject;
  let tool: Tool;
  let resolved: { path: string; configuration?: string }[];
  let paths: { resolveNode: (canonical: string, configuration?: string) => MetadataNode };

  const text = (result: CallToolResult): string => {
    const part = result.content[0];
    return part.type === 'text' ? part.text : '';
  };
  const run = (args: Record<string, unknown>): Promise<CallToolResult> => tool.handler(args);

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
    const registered = tools.get('v8vscedit_update_database_configuration');
    assert.ok(registered, 'v8vscedit_update_database_configuration не зарегистрирован в registerConfigLifecycleTools');
    tool = registered;
  });
  teardown(() => p.dispose());

  test('регистрация: destructiveHint=true; схема {path, configuration?}; в description — предупреждение о реструктуризации', () => {
    assert.strictEqual(tool.annotations?.destructiveHint, true);
    const fields = (tool.inputSchema as { shape: Record<string, { def?: { type?: string } }> }).shape;
    assert.deepStrictEqual(Object.fromEntries(Object.entries(fields).map(([k, s]) => [k, s.def?.type === 'optional'])), { path: false, configuration: true });
    assert.ok(tool.description.includes('реструктуризац'), tool.description);
  });

  test('основная конфигурация: цель {kind: cf, name, rootPath из Configuration.xml узла}, под замком; ответ; afterMutation не вызывается; тостов нет', async () => {
    const result = JSON.parse(text(await run({ path: 'Конфигурация' }))) as Record<string, unknown>;
    assert.deepStrictEqual(result, {
      path: 'Конфигурация', kind: 'cf', name: 'Основная конфигурация', databaseConfigurationUpdated: true, unloadedChangedFilesCount: 0,
    });
    assert.deepStrictEqual(p.events, ['apply:cf']);
    assert.strictEqual(p.lockHeldAt['apply:cf'], true);
    const target = p.applyCalls[0][0] as { kind: string; name: string; rootPath: string; extensionName?: string };
    assert.deepStrictEqual([target.kind, target.name, target.rootPath, target.extensionName], ['cf', 'Основная конфигурация', p.cfRoot, undefined]);
    assert.deepStrictEqual(p.suppressCalls, []);
    assert.deepStrictEqual(p.markChangedCalls, []);
    assert.deepStrictEqual(p.toasts, []);
    assert.strictEqual(isConfigurationOperationRunning(), false);
  });

  test('расширение: цель {kind: cfe, name=extensionName=Расш, rootPath}; configuration проброшена резолверу пути', async () => {
    const result = JSON.parse(text(await run({ path: 'Расширение.Расш', configuration: 'Расш' }))) as Record<string, unknown>;
    assert.strictEqual(result.kind, 'cfe');
    assert.strictEqual(result.name, 'Расш');
    assert.deepStrictEqual(p.events, ['apply:cfe:Расш']);
    const target = p.applyCalls[0][0] as { kind: string; name: string; rootPath: string; extensionName?: string };
    assert.deepStrictEqual([target.kind, target.name, target.extensionName, target.rootPath], ['cfe', 'Расш', 'Расш', p.cfeRoot]);
    assert.deepStrictEqual(resolved.at(-1), { path: 'Расширение.Расш', configuration: 'Расш' });
  });

  test('есть незагруженные правки этой конфигурации: счётчик и note (точный текст); правки другой конфигурации не считаются', async () => {
    p.changed = [
      { rootPath: p.cfRoot, name: 'Основная', changedFilesCount: 4 },
      { rootPath: p.cfeRoot, name: 'Расш', changedFilesCount: 9 },
    ];
    const result = JSON.parse(text(await run({ path: 'Конфигурация' }))) as Record<string, unknown>;
    assert.strictEqual(result.unloadedChangedFilesCount, 4);
    assert.strictEqual(result.note, NOTE);
  });

  test('платформа вернула неуспех: isError с точным текстом, замок освобождён', async () => {
    p.applyResult = false;
    const result = await run({ path: 'Конфигурация' });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), 'Обновление конфигурации БД не выполнено. Подробности — в журнале «1С Редактор».');
    assert.strictEqual(isConfigurationOperationRunning(), false);
    assert.deepStrictEqual(p.markChangedCalls, []);
  });

  test('не корень (объект): ошибка с ТЕМ ЖЕ текстом, что у resolveConfigurationXmlByCanonical; apply не вызывался', async () => {
    let expected = '';
    try {
      resolveConfigurationXmlByCanonical(paths as never, 'Справочники.Товары');
    } catch (error) {
      expected = (error as Error).message;
    }
    assert.ok(expected, 'эталонное сообщение получено');
    const result = await run({ path: 'Справочники.Товары' });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), expected);
    assert.deepStrictEqual(p.events, []);
  });

  test('неизвестный путь: isError, apply не вызывался', async () => {
    const result = await run({ path: 'Catalog.Товары' });
    assert.strictEqual(result.isError, true);
    assert.deepStrictEqual(p.events, []);
  });

  test('замок занят: CONFIGURATION_OPERATION_BUSY_MESSAGE, apply не вызывался, чужой замок не снят', async () => {
    assert.strictEqual(await tryBeginConfigurationOperation(), true);
    const result = await run({ path: 'Конфигурация' });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(text(result), CONFIGURATION_OPERATION_BUSY_MESSAGE);
    assert.deepStrictEqual(p.events, []);
    assert.strictEqual(isConfigurationOperationRunning(), true);
  });
});
