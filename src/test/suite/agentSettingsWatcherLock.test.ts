/**
 * Э8: смена настроек агента во время идущей операции не закрывает SSH/SFTP под ней.
 *
 * Контракт (ui/commands/ext/agent/agentSettingsWatcher.ts + configurationOperationLock.ts):
 *  - замок операций занят → сброс кэша сервисов агента откладывается до `endConfigurationOperation()`;
 *  - несколько изменений за одну операцию дают ОДИН сброс;
 *  - `runWhenConfigurationOperationIdle` при свободном замке выполняет действие сразу.
 * Стенд — настоящий ssh2.Server с SFTP и эмулятором агента (support/agentRemoteHarness).
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  getAgentOperationService,
  getCachedAgentOperationService,
} from '../../ui/commands/ext/agent/AgentServiceRegistry';
import { registerAgentSettingsWatcher } from '../../ui/commands/ext/agent/agentSettingsWatcher';
import {
  endConfigurationOperation,
  isConfigurationOperationRunning,
  runWhenConfigurationOperationIdle,
  tryBeginConfigurationOperation,
} from '../../ui/commands/ext/configurationOperationLock';
import { STANDARD_DB } from './support/agentSyncHarness';
import { RemoteHarness, setAgentSetting } from './support/agentRemoteHarness';

const RESET_LOG = 'Настройки агента конфигуратора изменены';

/** Обещание события об изменении ключа: слушатель регистрируется после наблюдателя, значит срабатывает позже него. */
function nextChangeOf(section: string): Promise<void> {
  return new Promise((resolve) => {
    const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(section)) {
        subscription.dispose();
        resolve();
      }
    });
  });
}

async function eventually(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`не дождались: ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

suite('Агент Э8: смена настроек агента во время операции', function () {
  this.timeout(120_000);
  const h = new RemoteHarness();
  const context = { subscriptions: [] as { dispose(): unknown }[] } as unknown as vscode.ExtensionContext;
  const target = () => ({ kind: 'cf' as const, name: 'Основная', rootPath: h.cfRoot });

  setup(async () => { await h.start(); });
  teardown(async () => {
    for (const subscription of context.subscriptions.splice(0)) {
      subscription.dispose();
    }
    await endConfigurationOperation();
    await h.dispose();
  });

  test('замок занят: соединения живы до конца операции, затем один сброс на два изменения', async () => {
    for (const [fullName, files] of Object.entries(STANDARD_DB)) {
      h.emulator.setObject(fullName, files);
    }
    registerAgentSettingsWatcher(context, h.channel);
    const service = await getAgentOperationService(h.folder, h.cfRoot, h.channel);
    await service.importFromDatabase(target());
    assert.strictEqual(h.server.clientCount, 2);

    // Чужой раздел настроек кэш не трогает (и вне операции).
    const foreignChange = nextChangeOf('editor.fontSize');
    await vscode.workspace.getConfiguration('editor').update('fontSize', 17, vscode.ConfigurationTarget.Global);
    await foreignChange;
    await vscode.workspace.getConfiguration('editor').update('fontSize', undefined, vscode.ConfigurationTarget.Global);
    assert.strictEqual(getCachedAgentOperationService(h.folder), service);
    assert.ok(!h.lines.some((line) => line.includes(RESET_LOG)), h.lines.join('\n'));

    assert.strictEqual(await tryBeginConfigurationOperation(), true);
    const firstChange = nextChangeOf('v8vscedit.agent.transferConcurrency');
    await setAgentSetting('transferConcurrency', 4);
    await firstChange;
    const secondChange = nextChangeOf('v8vscedit.agent.archiveThresholdFiles');
    await setAgentSetting('archiveThresholdFiles', 50);
    await secondChange;

    assert.strictEqual(getCachedAgentOperationService(h.folder), service, 'кэш не сброшен под идущей операцией');
    assert.strictEqual(h.server.clientCount, 2, 'SSH и SFTP под операцией не закрыты');
    assert.ok(!h.lines.some((line) => line.includes(RESET_LOG)), h.lines.join('\n'));
    // Соединения под «операцией» рабочие: следующая команда того же сервиса проходит.
    await service.importFromDatabase(target());

    await endConfigurationOperation();
    await eventually(() => getCachedAgentOperationService(h.folder) === undefined, 'отложенный сброс кэша');
    await h.server.whenClientCount(0);
    assert.strictEqual(h.lines.filter((line) => line.includes(RESET_LOG)).length, 1, h.lines.join('\n'));
  });

  test('runWhenConfigurationOperationIdle: при свободном замке — сразу, при занятом — по освобождении', async () => {
    const calls: string[] = [];
    runWhenConfigurationOperationIdle(() => calls.push('сразу'));
    assert.deepStrictEqual(calls, ['сразу']);

    assert.strictEqual(await tryBeginConfigurationOperation(), true);
    runWhenConfigurationOperationIdle(() => calls.push('отложено'));
    assert.deepStrictEqual(calls, ['сразу']);
    await endConfigurationOperation();
    assert.deepStrictEqual(calls, ['сразу', 'отложено']);
    await endConfigurationOperation();
    assert.deepStrictEqual(calls, ['сразу', 'отложено'], 'отложенное действие выполняется один раз');
  });

  test('отказ одного отложенного действия не теряет остальные и не оставляет замок занятым', async () => {
    const calls: string[] = [];
    assert.strictEqual(await tryBeginConfigurationOperation(), true);
    runWhenConfigurationOperationIdle(() => { calls.push('первое'); });
    runWhenConfigurationOperationIdle(() => { throw new Error('сбой отложенного действия'); });
    runWhenConfigurationOperationIdle(() => { calls.push('третье'); });

    await endConfigurationOperation();

    assert.deepStrictEqual(calls, ['первое', 'третье']);
    assert.strictEqual(isConfigurationOperationRunning(), false);
    assert.strictEqual(await tryBeginConfigurationOperation(), true, 'замок снова можно занять');
  });
});
