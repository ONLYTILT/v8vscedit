import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildSshConnectConfig, describeConnectFailure } from '../../infra/agent';
import { createAgentOperationServiceEntry } from '../../ui/commands/ext/agent/AgentServiceRegistry';
import {
  readAgentCommandSettings,
  toAgentEndpointOptions,
  type AgentCommandSettings,
} from '../../ui/commands/ext/agent/agentSettings';

/**
 * Настройка v8vscedit.agent.connectTimeoutMs — предел одной попытки SSH к агенту (TCP + обмен
 * ключами + вход, readyTimeout ssh2). Прежде он был зашит как 10 с, и вход в удалённого агента
 * (проверка пароля обращением к клиент-серверной базе) на стенде пилота в него не укладывался.
 */

const ROOT = path.resolve(__dirname, '../../..');

function settings(overrides: Partial<AgentCommandSettings> = {}): AgentCommandSettings {
  return {
    host: 'srv.example', listenAddress: '127.0.0.1', port: 1543, user: 'u', password: 'p', privateKeyPath: '',
    visible: false, autoStart: false, agentModeArgs: [], progressInterval: 0.5,
    startupTimeoutMs: 15000, authWarmupMs: 90000, connectTimeoutMs: 60000, idleDisconnectMinutes: 0,
    location: 'local', transferConcurrency: 16, archiveThresholdFiles: 300,
    ...overrides,
  };
}

suite('Агент: настройка connectTimeoutMs', () => {
  async function setConnectTimeout(value: unknown): Promise<void> {
    await vscode.workspace.getConfiguration('v8vscedit.agent')
      .update('connectTimeoutMs', value, vscode.ConfigurationTarget.Global);
  }
  teardown(() => setConnectTimeout(undefined));

  test('package.json: ключ объявлен, number, умолчание 60000, минимум 1000, описание на русском', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
      contributes: { configuration: { properties: Record<string, { type?: string; default?: unknown; minimum?: number; description?: string }> } };
    };
    const property = manifest.contributes.configuration.properties['v8vscedit.agent.connectTimeoutMs'];
    assert.ok(property, 'нет v8vscedit.agent.connectTimeoutMs');
    assert.strictEqual(property.type, 'number');
    assert.strictEqual(property.default, 60000);
    assert.strictEqual(property.minimum, 1000);
    assert.match(property.description ?? '', /[А-Яа-яЁё]/);
  });

  test('умолчание — 60000 мс', () => {
    assert.strictEqual(readAgentCommandSettings({}).connectTimeoutMs, 60000);
  });

  test('заданное значение читается; дробное округляется вниз', async () => {
    await setConnectTimeout(120000);
    assert.strictEqual(readAgentCommandSettings({}).connectTimeoutMs, 120000);
    await setConnectTimeout(1500.9);
    assert.strictEqual(readAgentCommandSettings({}).connectTimeoutMs, 1500);
  });

  // Ноль/отрицательное/нечисло дали бы мгновенный отказ любого подключения — берётся умолчание.
  for (const [title, value] of [['ноль', 0], ['отрицательное', -5], ['строка', 'abc'], ['NaN', Number.NaN]] as const) {
    test(`некорректное значение (${title}) → умолчание 60000`, async () => {
      await setConnectTimeout(value);
      assert.strictEqual(readAgentCommandSettings({}).connectTimeoutMs, 60000);
    });
  }
});

suite('Агент: connectTimeoutMs доходит до readyTimeout SSH', () => {
  test('toAgentEndpointOptions: миллисекунды → секунды транспорта', () => {
    assert.strictEqual(toAgentEndpointOptions(settings()).connectTimeoutSeconds, 60);
    assert.strictEqual(toAgentEndpointOptions(settings({ connectTimeoutMs: 30000 })).connectTimeoutSeconds, 30);
  });

  test('неполная секунда округляется вверх: предел не урезается', () => {
    assert.strictEqual(toAgentEndpointOptions(settings({ connectTimeoutMs: 1500 })).connectTimeoutSeconds, 2);
    assert.strictEqual(toAgentEndpointOptions(settings({ connectTimeoutMs: 1 })).connectTimeoutSeconds, 1);
  });

  test('сквозная проводка: настройки → конфиг ssh2 с readyTimeout 60000 (было 10000)', () => {
    assert.strictEqual(buildSshConnectConfig(toAgentEndpointOptions(settings())).readyTimeout, 60000);
  });

  for (const location of ['local', 'remote'] as const) {
    test(`createAgentOperationServiceEntry (${location}): транспорт получает предел из настроек`, () => {
      const entry = createAgentOperationServiceEntry(os.tmpdir(), settings({ location, connectTimeoutMs: 45000 }));
      assert.strictEqual(entry.transportOptions.connectTimeoutSeconds, 45);
    });
  }
});

suite('Агент: текст отказа по таймауту подключения', () => {
  test('timeout: сохраняет исходную причину и подсказывает настройку connectTimeoutMs', () => {
    const message = describeConnectFailure(
      'timeout',
      { host: '1cDev', port: 1543, user: 'Администратор' },
      new Error('Timed out while waiting for handshake')
    );
    assert.match(message, /1cDev:1543 не ответил вовремя \(Timed out while waiting for handshake\)/);
    assert.match(message, /v8vscedit\.agent\.connectTimeoutMs/);
  });
});
