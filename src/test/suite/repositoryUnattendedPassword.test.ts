/**
 * `toCliServices(services, interaction)` (`repositoryNodeTargets.ts`): в unattended окно ввода пароля
 * PowerShell-сессии удалённого сервера подменяется отказом `UNATTENDED_REMOTE_PASSWORD_MISSING`; в interactive
 * остаётся прежний prompt. Сквозная проверка — цепочки lock/update/commit/unlock в удалённом режиме без
 * сохранённого пароля: ни одного `showInputBox`, хост PowerShell не создаётся.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { RepositoryService, type RepositoryNodeRef } from '../../infra/repository/RepositoryService';
import { disposeCachedAgentOperationServices } from '../../ui/commands/ext/agent/AgentServiceRegistry';
import { endConfigurationOperation } from '../../ui/commands/ext/configurationOperationLock';
import { disposeCachedDesignerExecutors, type DesignerExecutorDeps } from '../../ui/commands/ext/designerExecutorRegistry';
import { disposeRepositoryCommandStatusBar, resolveRepositoryTarget } from '../../ui/commands/repository/RepositoryCommandRunner';
import { runCommitChain, runLockChain, runUnlockChain, runUpdateChain } from '../../ui/commands/repository/repositoryChains';
import { UNATTENDED_REMOTE_PASSWORD_MISSING, toCliServices } from '../../ui/commands/repository/repositoryNodeTargets';
import type { RepositoryChainServices } from '../../ui/commands/repository/repositoryPostSync';
import { resetAgentSettings, setAgentSetting } from './support/agentRemoteHarness';
import { resetRemoteSettings, setRemoteSetting } from './support/remoteDesignerSettings';
import { removeTreeSync } from './support/tempTree';

const T = 'Справочник.Товары';
const CONFIGURATION_XML =
  '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Configuration uuid="11111111-1111-1111-1111-111111111111"><Properties><Name>Основная</Name></Properties></Configuration></MetaDataObject>';
const CATALOG_XML =
  '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Catalog uuid="33333333-3333-3333-3333-333333333333"><Properties><Name>Товары</Name></Properties></Catalog></MetaDataObject>';

function memoryStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

suite('toCliServices: пароль удалённого сервера без человека', function () {
  this.timeout(60_000);
  const windowRef = vscode.window as unknown as Record<string, unknown>;
  let originalInputBox: unknown;
  let root: string;
  let service: RepositoryService;
  let node: RepositoryNodeRef;
  let services: RepositoryChainServices;
  let prompts: number;
  let hostsCreated: number;
  let inputBoxCalls: number;

  setup(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-unattended-pw-')));
    const cfRoot = path.join(root, 'src', 'cf');
    fs.mkdirSync(path.join(cfRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(cfRoot, 'Configuration.xml'), CONFIGURATION_XML);
    const catalogPath = path.join(cfRoot, 'Catalogs', 'Товары.xml');
    fs.writeFileSync(catalogPath, CATALOG_XML);
    node = { nodeKind: 'Catalog', label: 'Товары', xmlPath: catalogPath };
    fs.writeFileSync(path.join(root, 'env.json'), JSON.stringify({
      default: {
        '--ibconnection': `/F${path.join(root, 'base')}`,
        '--path': 'D:\\нет-такого\\1cv8.exe',
        '--repo-path': 'C:\\repo-storage',
        '--repo-user': 'repo-user',
      },
    }), 'utf-8');

    // Пароля PSSession в хранилище секретов НЕТ — именно этот случай раньше открывал окно из MCP.
    const secrets = new ProjectSecretStorage(memoryStore(), root);
    service = new RepositoryService(root, secrets);
    const target = resolveRepositoryTarget(service, node);
    assert.ok(target);
    await service.saveBinding(target, { repoPath: 'C:\\repo-storage', repoUser: 'repo-user', repoPassword: 'repo-pw' });
    service.setLocked(target, [T], true);

    prompts = 0;
    hostsCreated = 0;
    inputBoxCalls = 0;
    originalInputBox = windowRef.showInputBox;
    windowRef.showInputBox = () => { inputBoxCalls += 1; return Promise.resolve(undefined); };

    await disposeCachedAgentOperationServices();
    await disposeCachedDesignerExecutors();
    await resetAgentSettings();
    await resetRemoteSettings();
    await setAgentSetting('location', 'remote');
    await setAgentSetting('host', 'srv-1c.corp');
    await vscode.workspace.getConfiguration('v8vscedit.configuration').update('operationMode', 'agent', vscode.ConfigurationTarget.Global);
    await setRemoteSetting('user', 'CORP\\svc');
    await setRemoteSetting('v8Path', 'C:\\1c\\1cv8.exe');

    const deps: DesignerExecutorDeps = {
      createHost: () => { hostsCreated += 1; throw new Error('хост создаваться не должен'); },
      promptRemotePassword: () => { prompts += 1; return Promise.resolve(undefined); },
    };
    services = {
      workspaceFolder: { uri: vscode.Uri.file(root), name: 'ws', index: 0 },
      outputChannel: { appendLine: () => undefined } as unknown as vscode.OutputChannel,
      repositoryService: service,
      projectSecretStorage: secrets,
      designerExecutorDeps: deps,
    } as unknown as RepositoryChainServices;
  });

  teardown(async () => {
    windowRef.showInputBox = originalInputBox;
    await endConfigurationOperation();
    await disposeCachedAgentOperationServices();
    await disposeCachedDesignerExecutors();
    await resetAgentSettings();
    await resetRemoteSettings();
    await vscode.workspace.getConfiguration('v8vscedit.configuration').update('operationMode', undefined, vscode.ConfigurationTarget.Global);
    disposeRepositoryCommandStatusBar();
    removeTreeSync(root);
  });

  test('unit: unattended подменяет prompt отказом, interactive оставляет прежние deps', async () => {
    const unattended = toCliServices(services, 'unattended');
    await assert.rejects(
      () => Promise.resolve(unattended.designerExecutorDeps?.promptRemotePassword?.()),
      (error: Error) => error.message === UNATTENDED_REMOTE_PASSWORD_MISSING
    );
    assert.strictEqual(prompts, 0);
    assert.strictEqual(toCliServices(services, 'interactive').designerExecutorDeps, services.designerExecutorDeps);
    assert.strictEqual(toCliServices(services).designerExecutorDeps, services.designerExecutorDeps);
  });

  const target = (): NonNullable<ReturnType<typeof resolveRepositoryTarget>> => {
    const resolved = resolveRepositoryTarget(service, node);
    assert.ok(resolved);
    return resolved;
  };
  const chains: [string, (interaction: 'interactive' | 'unattended') => Promise<unknown>][] = [
    ['lock', (i) => runLockChain(services, target(), node, false,
      { revised: false, updateDatabaseFirst: false, updateDatabaseOnLoad: false, importAfterLock: false }, i)],
    ['update', (i) => runUpdateChain(services, target(), node, { recursive: false, force: false },
      { loadChangesAfterReceive: false, updateDatabaseOnLoad: false, importAfterReceive: false }, i)],
    ['commit', (i) => runCommitChain(services, target(), node,
      { recursive: false, comment: 'Правка', keepLocked: false, force: false },
      { updateDatabaseFirst: false, updateDatabaseOnLoad: false }, i)],
    ['unlock', (i) => runUnlockChain(services, target(), node, { recursive: false, force: false }, 0, i)],
  ];
  for (const [name, run] of chains) {
    test(`${name}: unattended без сохранённого пароля → ошибка с текстом отказа, окна нет, prompt и хост не задействованы`, async () => {
      await assert.rejects(() => run('unattended'), (error: Error) => error.message.includes(UNATTENDED_REMOTE_PASSWORD_MISSING));
      assert.strictEqual(inputBoxCalls, 0);
      assert.strictEqual(prompts, 0);
      assert.strictEqual(hostsCreated, 0);
    });

    test(`${name}: interactive — прежний prompt вызван, отказа unattended нет`, async () => {
      await assert.rejects(() => run('interactive'), (error: Error) => !error.message.includes(UNATTENDED_REMOTE_PASSWORD_MISSING));
      assert.strictEqual(prompts, 1);
      assert.strictEqual(hostsCreated, 0);
    });
  }
});
