import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DesignerAgentProcess } from '../../infra/agent';
import { createAgentOperationServiceEntry } from '../../ui/commands/ext/agent/AgentServiceRegistry';
import { readAgentCommandSettings, type AgentCommandSettings } from '../../ui/commands/ext/agent/agentSettings';

/**
 * Э3: сквозная проводка настроек и момента старта агента до политики подключения.
 *  - DesignerAgentProcess.getStartedAt();
 *  - настройка v8vscedit.agent.authWarmupMs (манифест + чтение);
 *  - createAgentOperationServiceEntry передаёт в транспорт policy и agentStartedAt.
 */

const ROOT = path.resolve(__dirname, '../../..');

suite('Агент Э3: DesignerAgentProcess.getStartedAt', function () {
  // Ждём реального выхода дочернего процесса: под нагрузкой это дольше 2 с по умолчанию.
  this.timeout(60_000);
  let fakeBinDir: string;
  let fakeV8Path: string;
  let tmp: string;

  // Приём из agentModulesCoverage.test.ts: «1cv8» — копия node (резолвер принимает только имя 1cv8).
  // Скрипта DESIGNER в cwd нет, поэтому процесс штатно завершается — для проверки момента старта достаточно.
  suiteSetup(() => {
    const exeName = process.platform === 'win32' ? 'node.exe' : 'node';
    const nodePath = (process.env.PATH ?? '').split(path.delimiter)
      .map((dir) => path.join(dir, exeName))
      .find((candidate) => fs.existsSync(candidate));
    assert.ok(nodePath, 'node не найден в PATH: нужен для подмены 1cv8');
    fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-fake-1cv8-started-'));
    fakeV8Path = path.join(fakeBinDir, process.platform === 'win32' ? '1cv8.exe' : '1cv8');
    fs.copyFileSync(nodePath, fakeV8Path);
    fs.chmodSync(fakeV8Path, 0o755);
  });
  suiteTeardown(() => { fs.rmSync(fakeBinDir, { recursive: true, force: true }); });
  setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-started-')); });
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  test('до start() — undefined; после — момент внутри [до, после] вызова start()', async () => {
    const proc = new DesignerAgentProcess();
    assert.strictEqual(proc.getStartedAt(), undefined);

    const exited = new Promise<void>((resolve) => {
      const before = Date.now();
      proc.start({
        connection: { infoBasePath: tmp, v8Path: fakeV8Path },
        agentPort: 1543,
        agentListenAddress: '127.0.0.1',
        agentBaseDir: tmp,
        cwd: tmp,
        onExit: () => resolve(),
      });
      const after = Date.now();
      const startedAt = proc.getStartedAt();
      assert.ok(startedAt !== undefined, 'момент старта должен быть задан сразу после start()');
      assert.ok(startedAt >= before && startedAt <= after, `ожидался диапазон [${String(before)}, ${String(after)}], получено ${String(startedAt)}`);
    });
    await exited;
    await proc.stop();
  });
});

suite('Агент Э3: настройка authWarmupMs', () => {
  async function setAgentConfig(key: string, value: unknown): Promise<void> {
    await vscode.workspace.getConfiguration('v8vscedit.agent').update(key, value, vscode.ConfigurationTarget.Global);
  }
  teardown(() => setAgentConfig('authWarmupMs', undefined));

  test('package.json: ключ объявлен, number, умолчание 90000, описание на русском', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
      contributes: { configuration: { properties: Record<string, { type?: string; default?: unknown; description?: string }> } };
    };
    const property = manifest.contributes.configuration.properties['v8vscedit.agent.authWarmupMs'];
    assert.ok(property, 'нет v8vscedit.agent.authWarmupMs');
    assert.strictEqual(property.type, 'number');
    assert.strictEqual(property.default, 90000);
    assert.match(property.description ?? '', /[А-Яа-яЁё]/);
  });

  test('readAgentCommandSettings: умолчание 90000 и заданное значение', async () => {
    assert.strictEqual(readAgentCommandSettings({}).authWarmupMs, 90000);
    await setAgentConfig('authWarmupMs', 1234);
    assert.strictEqual(readAgentCommandSettings({}).authWarmupMs, 1234);
  });
});

suite('Агент Э3: createAgentOperationServiceEntry пробрасывает policy и agentStartedAt', () => {
  function settings(overrides: Partial<AgentCommandSettings> = {}): AgentCommandSettings {
    return {
      host: '127.0.0.1', listenAddress: '127.0.0.1', port: 1543, user: 'u', password: 'p', privateKeyPath: '',
      visible: false, autoStart: false, agentModeArgs: [], progressInterval: 0.5,
      startupTimeoutMs: 21000, authWarmupMs: 45000,
      ...overrides,
    };
  }

  // Шов: опции транспорта лежат в приватных полях innerFactory (менеджер сессий) -> options (фабрика).
  // Публичного геттера нет; если developer его добавит — заменить доступ здесь, имена полей не менять молча.
  function transportOptions(entry: ReturnType<typeof createAgentOperationServiceEntry>): Record<string, unknown> {
    const manager = entry.sessions as unknown as { innerFactory: { options: Record<string, unknown> } };
    return manager.innerFactory.options;
  }

  const tmpRoot = os.tmpdir();

  test('внешний агент (процесса нет): policy из настроек, agentStartedAt отсутствует', () => {
    const options = transportOptions(createAgentOperationServiceEntry(tmpRoot, settings()));
    assert.deepStrictEqual(options.policy, { startupTimeoutMs: 21000, authWarmupMs: 45000, retryDelayMs: 1000 });
    assert.strictEqual(options.agentStartedAt, undefined);
    assert.strictEqual('connectAttempts' in options, false);
    assert.strictEqual('connectRetryDelayMs' in options, false);
  });

  test('autoStart: agentStartedAt берётся из DesignerAgentProcess.getStartedAt()', () => {
    const proc = new DesignerAgentProcess();
    proc.getStartedAt = () => 1_700_000_000_000;
    const options = transportOptions(createAgentOperationServiceEntry(tmpRoot, settings({ autoStart: true }), proc));
    assert.strictEqual(options.agentStartedAt, 1_700_000_000_000);
    assert.deepStrictEqual(options.policy, { startupTimeoutMs: 21000, authWarmupMs: 45000, retryDelayMs: 1000 });
  });

  test('процесс ещё не стартовал (getStartedAt() === undefined): agentStartedAt не задан', () => {
    const options = transportOptions(createAgentOperationServiceEntry(tmpRoot, settings(), new DesignerAgentProcess()));
    assert.strictEqual(options.agentStartedAt, undefined);
  });
});
