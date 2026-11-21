import * as assert from 'assert';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as vscode from 'vscode';
import { operationStageFeed } from '../../ui/commands/ext/configurationOperationStatus';
import { McpOperationOutcomeRegistry } from '../../infra/mcp/McpOperationOutcome';
import { McpMutationGate } from '../../ui/mcp/registration/McpMutationGate';
import { registerRepositoryTools } from '../../ui/mcp/registration/McpRepositoryTools';
import type { MetadataNode } from '../../ui/tree/TreeNode';
import { ManualScheduler } from './support/manualScheduler';
import {
  COMMIT_DONE, LOCK_DONE, UPDATE_DONE, createRepoProject, opLog, type RepoProject,
} from './support/repositoryMcpFixtures';

/**
 * MCP-инструменты хранилища и признак «БД отстаёт»: необязательный `updateDatabase` (lock/update/commit;
 * нет значения — настройка `updateDatabaseAfterLoad`), поля `databaseConfigurationUpdated` /
 * `databaseConfigurationBehind` в результатах и `databaseConfigurationBehind: { since, source } | null`
 * в `v8vscedit_repository_status`.
 */
const T = 'Справочник.Товары';

interface RegisteredTool {
  readonly handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
  readonly inputSchema: { safeParse(value: unknown): { success: boolean } };
}

const text = (result: CallToolResult): string => {
  const part = result.content[0];
  return part.type === 'text' ? part.text : '';
};
const data = (result: CallToolResult): Record<string, unknown> => {
  assert.ok(result.isError !== true, `ожидался успех: ${text(result)}`);
  return JSON.parse(text(result)) as Record<string, unknown>;
};

suite('MCP-инструменты хранилища: updateDatabase и признак отставания БД', function () {
  this.timeout(60_000);
  let p: RepoProject;
  let tools: Map<string, RegisteredTool>;

  const call = (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    const tool = tools.get(`v8vscedit_repository_${name}`);
    assert.ok(tool, `v8vscedit_repository_${name} не зарегистрирован`);
    return tool.handler(args);
  };
  const dirty = (): void => { p.changed = [{ rootPath: p.cfRoot, name: 'Основная', changedFilesCount: 3 }]; };
  const setSetting = (value: boolean | undefined): Thenable<void> =>
    vscode.workspace.getConfiguration('v8vscedit.configuration').update('updateDatabaseAfterLoad', value, vscode.ConfigurationTarget.Global);
  const cfLag = () => ({ kind: 'cf' as const, name: 'Основная', rootPath: p.cfRoot });

  setup(async () => {
    p = await createRepoProject();
    tools = new Map();
    const map: Record<string, MetadataNode> = { 'Справочники.Товары': p.nodes.catalog };
    const paths = {
      resolveNode: (canonical: string) => {
        if (!Object.prototype.hasOwnProperty.call(map, canonical)) {
          throw new Error(`Метаданные по пути "${canonical}" не найдены.`);
        }
        return map[canonical];
      },
    };
    const server = {
      registerTool: (name: string, config: { inputSchema: RegisteredTool['inputSchema'] }, handler: RegisteredTool['handler']) => {
        tools.set(name, { handler, inputSchema: config.inputSchema });
      },
    };
    const gate = new McpMutationGate(
      p.services,
      { scheduler: new ManualScheduler(), intervalMs: 20_000, readStage: () => operationStageFeed.current() },
      new McpOperationOutcomeRegistry()
    );
    registerRepositoryTools(server as never, { services: p.services, xmlEditor: {}, paths, properties: {}, mutations: {}, gate } as never);
    await setSetting(undefined);
  });
  teardown(async () => {
    await setSetting(undefined);
    await p.dispose();
  });

  test('схема: updateDatabase — необязательный boolean у lock/update/commit; строка отвергается', () => {
    const base: Record<string, Record<string, unknown>> = {
      lock: { path: 'Справочники.Товары' },
      update: { path: 'Справочники.Товары' },
      commit: { path: 'Справочники.Товары', comment: 'Правка', confirm: true },
    };
    for (const [name, args] of Object.entries(base)) {
      const tool = tools.get(`v8vscedit_repository_${name}`);
      assert.ok(tool);
      assert.strictEqual(tool.inputSchema.safeParse(args).success, true, `${name}: без updateDatabase допустимо`);
      assert.strictEqual(tool.inputSchema.safeParse({ ...args, updateDatabase: true }).success, true);
      assert.strictEqual(tool.inputSchema.safeParse({ ...args, updateDatabase: false }).success, true);
      assert.strictEqual(tool.inputSchema.safeParse({ ...args, updateDatabase: 'да' }).success, false, `${name}: не boolean`);
    }
  });

  const MATRIX: readonly { updateDatabase: boolean | undefined; setting: boolean | undefined; effective: boolean }[] = [
    { updateDatabase: undefined, setting: undefined, effective: true },
    { updateDatabase: undefined, setting: true, effective: true },
    { updateDatabase: undefined, setting: false, effective: false },
    { updateDatabase: true, setting: false, effective: true },
    { updateDatabase: false, setting: true, effective: false },
  ];

  for (const row of MATRIX) {
    const tag = `updateDatabase=${String(row.updateDatabase)}, настройка=${String(row.setting)} → ${String(row.effective)}`;
    const extra = row.updateDatabase === undefined ? {} : { updateDatabase: row.updateDatabase };

    test(`lock (loadFirst): ${tag}`, async () => {
      await setSetting(row.setting);
      dirty();
      p.setResult(opLog(LOCK_DONE, `Объект захвачен для редактирования: ${T}`, `Объект получен из хранилища: ${T}`));

      const result = data(await call('lock', { path: 'Справочники.Товары', localChanges: 'loadFirst', ...extra }));

      assert.strictEqual(p.updateOptions().updateDatabase, row.effective);
      assert.strictEqual(result.databaseConfigurationUpdated, row.effective);
      // Версии получены ПОСЛЕ загрузки — БД отстаёт при любом режиме загрузки.
      assert.strictEqual(result.databaseConfigurationBehind, true);
      assert.strictEqual(p.lag.sourceOf(cfLag()), 'repository-receive');
    });

    test(`update (loadAfter): ${tag}`, async () => {
      await setSetting(row.setting);
      dirty();
      p.setResult(opLog(UPDATE_DONE, `Объект получен из хранилища: ${T}`));

      const result = data(await call('update', { path: 'Справочники.Товары', localChanges: 'loadAfter', ...extra }));

      assert.strictEqual(p.updateOptions().updateDatabase, row.effective);
      assert.strictEqual(result.databaseConfigurationUpdated, row.effective);
      assert.strictEqual(result.databaseConfigurationBehind, !row.effective);
    });

    test(`commit (loadFirst): ${tag}`, async () => {
      await setSetting(row.setting);
      dirty();
      p.lock([T]);
      p.setResult(opLog(COMMIT_DONE, `Объект помещен в хранилище: ${T}`));

      const result = data(await call('commit', { path: 'Справочники.Товары', comment: 'Правка', confirm: true, localChanges: 'loadFirst', ...extra }));

      assert.strictEqual(p.updateOptions().updateDatabase, row.effective);
      assert.strictEqual(result.databaseConfigurationUpdated, row.effective);
      assert.strictEqual(result.databaseConfigurationBehind, !row.effective);
    });
  }

  test('lock без шага загрузки (проект чист): updateDatabase не влияет — раннер не вызывается, databaseConfigurationUpdated=false', async () => {
    p.setResult(opLog(LOCK_DONE, `Объект захвачен для редактирования: ${T}`));
    const result = data(await call('lock', { path: 'Справочники.Товары', updateDatabase: true }));
    assert.deepStrictEqual(p.updateCalls, []);
    assert.strictEqual(result.databaseConfigurationUpdated, false);
    assert.strictEqual(result.databaseConfigurationBehind, false);
  });

  suite('v8vscedit_repository_status: databaseConfigurationBehind', () => {
    test('цель не отстаёт → null', async () => {
      const result = data(await call('status', { path: 'Справочники.Товары' }));
      assert.strictEqual(result.databaseConfigurationBehind, null);
    });

    test('цель отстаёт → { since, source } из признака', async () => {
      p.lag.markBehind(cfLag(), 'load-without-update');
      const result = data(await call('status', { path: 'Справочники.Товары' }));
      assert.deepStrictEqual(result.databaseConfigurationBehind, { since: '2026-01-01T00:00:00.000Z', source: 'load-without-update' });
    });

    test('отстаёт ДРУГАЯ цель (cfe) — у cf по-прежнему null', async () => {
      p.lag.markBehind({ kind: 'cfe', name: 'Расш', rootPath: p.cfeRoot, extensionName: 'Расш' }, 'update-failed');
      const result = data(await call('status', { path: 'Справочники.Товары' }));
      assert.strictEqual(result.databaseConfigurationBehind, null);
    });

    test('статус не меняет признак и не вызывает платформу', async () => {
      p.lag.markBehind(cfLag(), 'cf-file-load');
      await call('status', { path: 'Справочники.Товары' });
      assert.strictEqual(p.lag.isBehind(cfLag()), true);
      assert.deepStrictEqual(p.runs, []);
    });
  });
});
