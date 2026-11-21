import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { showRepositoryCliFailure } from '../../ui/commands/repository/RepositoryCommandRunner';
import { registerRepositoryCommands } from '../../ui/commands/repository/RepositoryCommands';
import { describeUnlockNotDone, runCommitChain } from '../../ui/commands/repository/repositoryChains';
import { registerConfigLifecycleTools } from '../../ui/mcp/registration/McpConfigLifecycleTools';
import { registerRepositoryTools } from '../../ui/mcp/registration/McpRepositoryTools';
import { McpMutationGate } from '../../ui/mcp/registration/McpMutationGate';
import { MetadataNode } from '../../ui/tree/TreeNode';
import { COMMIT_DONE, LOCK_DONE, UNLOCK_DONE, UPDATE_DONE, createRepoProject, opLog, type RepoProject } from './support/repositoryMcpFixtures';

/**
 * Добор веток (возврат QA по coverage:changed): узлы без подписи, узел без xmlPath/вне корней,
 * чужой захват без «(user)», проброс чужой ошибки, UI-освобождение с «не снято».
 */

const T = 'Справочник.Товары';
const FOREIGN = 'Объект захвачен для редактирования другим пользователем: ';

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

const textOf = (result: CallToolResult): string => {
  const part = result.content[0];
  return part.type === 'text' ? part.text : '';
};

suite('describeUnlockNotDone: чужой захват без пользователя', () => {
  test('с пользователем — «имя (пользователь)», без пользователя — одно имя', () => {
    assert.strictEqual(
      describeUnlockNotDone([T], [{ name: T, user: 'Иванов' }]),
      `Захват не отменён: ${T}; захвачено другим пользователем: ${T} (Иванов)`
    );
    assert.strictEqual(
      describeUnlockNotDone([T], [{ name: T, user: '' }]),
      `Захват не отменён: ${T}; захвачено другим пользователем: ${T}`
    );
  });
});

suite('showRepositoryCliFailure: чужая ошибка пробрасывается', () => {
  test('не ошибка операции хранилища — исключение летит вызывающему как есть', () => {
    const foreign = new Error('чужая');
    assert.throws(() => showRepositoryCliFailure(foreign), (error: unknown) => error === foreign);
  });
});

suite('repositoryChains: узел без подписи', () => {
  let p: RepoProject;
  setup(async () => { p = await createRepoProject(); p.lock([T]); });
  teardown(() => p.dispose());

  test('помещение без правок и узел без label: предупреждение называет цель (displayName)', async () => {
    p.setResult(opLog(COMMIT_DONE, `Объект не был изменен: ${T}`));
    const node = { nodeKind: 'Catalog', xmlPath: p.refs.catalog.xmlPath };
    const result = await runCommitChain(
      p.services, p.cfTarget, node, { recursive: false, comment: 'к', keepLocked: false, force: false }, { updateDatabaseFirst: false, updateDatabaseOnLoad: false }, 'interactive'
    );
    assert.strictEqual(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes(p.cfTarget.displayName), result.warnings[0]);
  });
});

suite('MCP: узел без xmlPath и вне корней конфигураций', function () {
  this.timeout(60_000);
  let p: RepoProject;
  const tools = new Map<string, ToolHandler>();

  setup(async () => {
    p = await createRepoProject();
    tools.clear();
    const noXml = new MetadataNode({ label: 'Группа', nodeKind: 'group-type' }, vscode.TreeItemCollapsibleState.None);
    const outside = new MetadataNode(
      { label: 'Чужой', nodeKind: 'Catalog', xmlPath: path.join(os.tmpdir(), 'вне-проекта-mcp', 'Catalogs', 'Чужой.xml') },
      vscode.TreeItemCollapsibleState.None
    );
    const map: Record<string, MetadataNode> = { 'Без.Xml': noXml, 'Вне.Корней': outside };
    const deps = {
      services: p.services, xmlEditor: {}, properties: {}, mutations: {},
      paths: { resolveNode: (canonical: string) => map[canonical] },
      gate: new McpMutationGate(p.services),
    };
    registerRepositoryTools({
      registerTool: (name: string, _config: unknown, handler: ToolHandler) => { tools.set(name, handler); },
    } as never, deps as never);
  });
  teardown(() => p.dispose());

  for (const canonical of ['Без.Xml', 'Вне.Корней']) {
    for (const name of ['status', 'lock', 'update', 'unlock']) {
      test(`${name}: «${canonical}» — «Не удалось определить конфигурацию для узла», запуска нет`, async () => {
        const handler = tools.get(`v8vscedit_repository_${name}`);
        assert.ok(handler);
        const result = await handler({ path: canonical });
        assert.strictEqual(result.isError, true);
        assert.strictEqual(textOf(result), `Не удалось определить конфигурацию для узла "${canonical}".`);
        assert.strictEqual(p.runs.length, 0);
      });
    }
  }
});

suite('update_database_configuration: корень вне известных конфигураций хранилища', function () {
  this.timeout(60_000);
  let p: RepoProject;
  setup(async () => { p = await createRepoProject(); });
  teardown(() => p.dispose());

  test('нет цели хранилища для rootPath (нет Configuration.xml на диске): счётчик 0, note нет', async () => {
    const xmlPath = path.join(p.root, 'нигде', 'Configuration.xml');
    const node = new MetadataNode({ label: 'Основная', nodeKind: 'configuration', xmlPath }, vscode.TreeItemCollapsibleState.None);
    let handler: ToolHandler | undefined;
    registerConfigLifecycleTools({
      registerTool: (name: string, _c: unknown, h: ToolHandler) => {
        if (name === 'v8vscedit_update_database_configuration') {
          handler = h;
        }
      },
    } as never, {
      services: p.services, xmlEditor: {}, properties: {}, mutations: {},
      paths: { resolveNode: () => node }, gate: new McpMutationGate(p.services),
    } as never);
    assert.ok(handler);
    const result = await handler({ path: 'Конфигурация' });
    assert.ok(result.isError !== true, JSON.stringify(result));
    const data = JSON.parse(textOf(result)) as Record<string, unknown>;
    assert.strictEqual(data.unloadedChangedFilesCount, 0);
    assert.strictEqual(data.note, undefined);
  });
});

suite('UI-команды хранилища: узел без подписи, правки проекта, «не снято»', function () {
  this.timeout(60_000);
  type Handler = (node?: unknown) => Promise<void>;
  let p: RepoProject;
  let handlers: Map<string, Handler>;
  let picks: string[];
  let commitForm: unknown;
  const commandsRef = vscode.commands as unknown as { registerCommand: unknown };
  let savedRegister: unknown;
  let savedPick: unknown;
  let savedInput: unknown;
  const w = vscode.window as unknown as Record<string, unknown>;
  const bare = (): { nodeKind: string; xmlPath: string | undefined } => ({ nodeKind: 'Catalog', xmlPath: p.refs.catalog.xmlPath });

  setup(async () => {
    p = await createRepoProject();
    picks = [];
    commitForm = undefined;
    savedPick = w.showQuickPick;
    savedInput = w.showInputBox;
    w.showQuickPick = (items: readonly vscode.QuickPickItem[]) => {
      const label = picks.shift();
      return Promise.resolve(items.find((item) => item.label === label));
    };
    w.showInputBox = () => Promise.resolve('');
    (p.services as unknown as Record<string, unknown>).repositoryCommitViewProvider = { show: () => Promise.resolve(commitForm) };
    handlers = new Map();
    savedRegister = commandsRef.registerCommand;
    commandsRef.registerCommand = (id: string, callback: Handler) => { handlers.set(id, callback); return { dispose: () => undefined }; };
    try {
      registerRepositoryCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext, p.services);
    } finally {
      commandsRef.registerCommand = savedRegister;
    }
  });
  teardown(async () => {
    w.showQuickPick = savedPick;
    w.showInputBox = savedInput;
    await p.dispose();
  });

  const run = async (id: string, node: unknown): Promise<void> => {
    const handler = handlers.get(id);
    assert.ok(handler, id);
    await handler(node);
  };
  const infoWithTarget = (): boolean =>
    p.toasts.some((toast) => toast.kind === 'info' && toast.message.includes(`"${p.cfTarget.displayName}"`));

  test('освобождение: чужой захват (ничего не снято) — предупреждение «Захват не отменён», а не «освобождены»', async () => {
    p.lock([T]);
    p.setResult(opLog(UNLOCK_DONE, `${FOREIGN}${T} (Иванов) `));
    picks.push('Только выбранный объект', 'Без force');
    await run('v8vscedit.repository.unlock', p.refs.catalog);
    const expected = describeUnlockNotDone([T], [{ name: T, user: 'Иванов' }]);
    assert.ok(p.toasts.some((toast) => toast.kind === 'warning' && toast.message === expected), JSON.stringify(p.toasts));
    assert.ok(!p.toasts.some((toast) => toast.message.includes('освобождены')));
  });

  test('освобождение: узел без подписи и есть незагруженные правки — успех с именем цели и предупреждением о правках', async () => {
    p.lock([T]);
    p.changed = [{ rootPath: p.cfRoot, name: 'Основная', changedFilesCount: 2 }];
    p.setResult(opLog(UNLOCK_DONE, `Захват объекта отменен: ${T}`));
    picks.push('Только выбранный объект', 'Без force');
    await run('v8vscedit.repository.unlock', bare());
    assert.ok(infoWithTarget(), JSON.stringify(p.toasts));
    assert.ok(p.toasts.some((toast) => toast.kind === 'warning' && toast.message.includes('незагруженных изменённых файлов: 2')), JSON.stringify(p.toasts));
  });

  test('захват: узел без подписи — в сообщении успеха имя цели', async () => {
    p.setResult(opLog(LOCK_DONE, `Объект захвачен для редактирования: ${T}`));
    picks.push('Только выбранный объект');
    await run('v8vscedit.repository.lock', bare());
    assert.ok(infoWithTarget(), JSON.stringify(p.toasts));
  });

  test('получение: узел без подписи — в сообщении успеха имя цели', async () => {
    p.setResult(opLog(UPDATE_DONE));
    picks.push('Только выбранный объект', 'Без force');
    await run('v8vscedit.repository.update', bare());
    assert.ok(infoWithTarget(), JSON.stringify(p.toasts));
  });

  test('помещение: узел без подписи — в сообщении успеха имя цели', async () => {
    p.lock([T]);
    p.setResult(opLog(COMMIT_DONE, `Объект помещен в хранилище: ${T}`));
    commitForm = { recursive: false, comment: 'Правка', keepLocked: false, force: false };
    await run('v8vscedit.repository.commit', bare());
    assert.ok(infoWithTarget(), JSON.stringify(p.toasts));
  });
});
