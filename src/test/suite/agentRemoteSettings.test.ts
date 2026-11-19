/**
 * Э8: настройки удалённого режима агента и их чтение (UI-слой, Extension Host).
 *
 * Контракт (ui/commands/ext/agent/agentSettings.ts):
 *  - `AgentCommandSettings` получает поля `location: 'local' | 'remote'`, `transferConcurrency: number`,
 *    `archiveThresholdFiles: number` (рядом с `idleDisconnectMinutes`; `AgentLocation` экспортируется).
 *  - `v8vscedit.agent.location`: enum `local|remote`, умолчание `local`; незнакомое значение → `local`.
 *  - `v8vscedit.agent.transferConcurrency`: целое, умолчание 16, minimum 1, maximum 64; нечисло, NaN, <1 → 16,
 *    дробное округляется вниз, больше 64 → 64.
 *  - `v8vscedit.agent.archiveThresholdFiles`: целое, умолчание 20000, minimum 1; нечисло, <1 → 20000, дробное вниз.
 *  - `resolveAgentExecutionMode(location, operationMode): 'batch' | 'agent'` — чистая таблица; remote + не-agent
 *    (batch/не задан/мусор) — `Error` с упоминанием `v8vscedit.agent.location` и `v8vscedit.configuration.operationMode`,
 *    молчаливого отката на локальный режим нет. `getAgentExecutionMode()` читает обе настройки из vscode.
 *  - Реэкспорт из ExtensionCommandRunner: `getAgentExecutionMode`, `resolveAgentExecutionMode`.
 *  - Входы агентских операций ExtensionCommandRunner (runDecompile*, runLoad*, …) вместо булевой
 *    `isAgentConfigurationOperationMode()` берут `getAgentExecutionMode()`: remote + batch → отказ (reject).
 *  - `isAgentConfigurationOperationMode()` остаётся булевой и прежней (только `operationMode === 'agent'`).
 *  - Н24: сообщение `resolveLocalAgentUserRoot` об отсутствии agentbasedir.json подсказывает
 *    настройку `v8vscedit.agent.agentModeArgs` и ключ `/AgentBaseDir` (внешний агент с другим каталогом).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveLocalAgentUserRoot } from '../../infra/agent';
import * as runner from '../../ui/commands/ext/ExtensionCommandRunner';
import { getCachedAgentOperationService } from '../../ui/commands/ext/agent/AgentServiceRegistry';
import {
  getAgentExecutionMode,
  isAgentConfigurationOperationMode,
  readAgentCommandSettings,
  resolveAgentExecutionMode,
  type AgentLocation,
} from '../../ui/commands/ext/agent/agentSettings';
import { resetAgentSettings, setAgentSetting } from './support/agentRemoteHarness';

const ROOT = path.resolve(__dirname, '../../..');

interface ManifestProperty {
  type?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  enumDescriptions?: string[];
  description?: string;
}

function manifestProperty(key: string): ManifestProperty {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
    contributes: { configuration: { properties: Record<string, ManifestProperty> } };
  };
  const property = manifest.contributes.configuration.properties[key];
  assert.ok(property, `нет ${key} в contributes.configuration`);
  return property;
}

suite('Агент Э8: package.json — объявление настроек', () => {
  test('v8vscedit.agent.location: string-enum local|remote, умолчание local, описания на русском', () => {
    const property = manifestProperty('v8vscedit.agent.location');
    assert.strictEqual(property.type, 'string');
    assert.deepStrictEqual(property.enum, ['local', 'remote']);
    assert.strictEqual(property.default, 'local');
    assert.strictEqual(property.enumDescriptions?.length, 2);
    for (const text of [...(property.enumDescriptions ?? []), property.description ?? '']) {
      assert.match(text, /[А-Яа-яЁё]/);
    }
  });

  test('v8vscedit.agent.transferConcurrency: number, 16, minimum 1, maximum 64, русское описание', () => {
    const property = manifestProperty('v8vscedit.agent.transferConcurrency');
    assert.strictEqual(property.type, 'number');
    assert.strictEqual(property.default, 16);
    assert.strictEqual(property.minimum, 1);
    assert.strictEqual(property.maximum, 64);
    assert.match(property.description ?? '', /[А-Яа-яЁё]/);
  });

  test('v8vscedit.agent.archiveThresholdFiles: number, 20000 (было 300 — полная выгрузка при любой «средней» правке), minimum 1, русское описание «только удалённый агент»', () => {
    const property = manifestProperty('v8vscedit.agent.archiveThresholdFiles');
    assert.strictEqual(property.type, 'number');
    assert.strictEqual(property.default, 20000);
    assert.strictEqual(property.minimum, 1);
    assert.match(property.description ?? '', /[А-Яа-яЁё]/);
    // Порог читают только удалённые ветки движка (локальный агент сравнивает M и P целиком).
    assert.match(property.description ?? '', /Только удалённый агент/);
  });

  test('описание autoStart предупреждает, что в удалённом режиме настройка игнорируется', () => {
    assert.match(manifestProperty('v8vscedit.agent.autoStart').description ?? '', /удал[её]нн/i);
  });
});

suite('Агент Э8: чтение настроек удалённого режима', () => {
  setup(resetAgentSettings);
  teardown(resetAgentSettings);

  const locations: AgentLocation[] = ['local', 'remote'];
  for (const location of locations) {
    test(`location=${location} читается как есть`, async () => {
      await setAgentSetting('location', location);
      assert.strictEqual(readAgentCommandSettings({}).location, location);
    });
  }

  test('умолчания: local, 16, 20000', () => {
    const settings = readAgentCommandSettings({});
    assert.strictEqual(settings.location, 'local');
    assert.strictEqual(settings.transferConcurrency, 16);
    assert.strictEqual(settings.archiveThresholdFiles, 20000);
  });

  for (const bad of ['Remote', 'ssh', '', 5, null]) {
    test(`location=${JSON.stringify(bad)} (не из enum) → local`, async () => {
      await setAgentSetting('location', bad);
      assert.strictEqual(readAgentCommandSettings({}).location, 'local');
    });
  }

  const concurrencyTable: [unknown, number][] = [
    [1, 1], [2, 2], [16, 16], [64, 64],
    [65, 64], [1000, 64],
    [2.7, 2], [0.5, 16],
    [0, 16], [-5, 16], ['abc', 16], [null, 16],
  ];
  for (const [raw, expected] of concurrencyTable) {
    test(`transferConcurrency=${JSON.stringify(raw)} → ${String(expected)}`, async () => {
      await setAgentSetting('transferConcurrency', raw);
      assert.strictEqual(readAgentCommandSettings({}).transferConcurrency, expected);
    });
  }

  const thresholdTable: [unknown, number][] = [
    [1, 1], [50, 50], [300, 300], [100000, 100000],
    [7.9, 7], [0.4, 20000],
    [0, 20000], [-1, 20000], ['много', 20000], [null, 20000],
  ];
  for (const [raw, expected] of thresholdTable) {
    test(`archiveThresholdFiles=${JSON.stringify(raw)} → ${String(expected)}`, async () => {
      await setAgentSetting('archiveThresholdFiles', raw);
      assert.strictEqual(readAgentCommandSettings({}).archiveThresholdFiles, expected);
    });
  }
});

suite('Агент Э8: режим выполнения (location × operationMode)', () => {
  const table: { location: AgentLocation; operationMode: string | undefined; expected: 'batch' | 'agent' | 'error' }[] = [
    { location: 'local', operationMode: 'batch', expected: 'batch' },
    { location: 'local', operationMode: undefined, expected: 'batch' },
    { location: 'local', operationMode: 'мусор', expected: 'batch' },
    { location: 'local', operationMode: 'agent', expected: 'agent' },
    { location: 'remote', operationMode: 'agent', expected: 'agent' },
    { location: 'remote', operationMode: 'batch', expected: 'error' },
    { location: 'remote', operationMode: undefined, expected: 'error' },
    { location: 'remote', operationMode: 'мусор', expected: 'error' },
  ];
  for (const { location, operationMode, expected } of table) {
    test(`resolveAgentExecutionMode(${location}, ${String(operationMode)}) → ${expected}`, () => {
      if (expected === 'error') {
        assert.throws(
          () => resolveAgentExecutionMode(location, operationMode),
          (error: Error) => error.message.includes('v8vscedit.agent.location')
            && error.message.includes('v8vscedit.configuration.operationMode')
        );
      } else {
        assert.strictEqual(resolveAgentExecutionMode(location, operationMode), expected);
      }
    });
  }

  suite('чтение из настроек vscode', () => {
    setup(resetAgentSettings);
    teardown(resetAgentSettings);

    async function setOperationMode(value: string | undefined): Promise<void> {
      await vscode.workspace.getConfiguration('v8vscedit.configuration')
        .update('operationMode', value, vscode.ConfigurationTarget.Global);
    }

    test('умолчания (local, batch) → batch; isAgentConfigurationOperationMode остаётся false', () => {
      assert.strictEqual(getAgentExecutionMode(), 'batch');
      assert.strictEqual(isAgentConfigurationOperationMode(), false);
    });

    test('remote + agent → agent', async () => {
      await setAgentSetting('location', 'remote');
      await setOperationMode('agent');
      assert.strictEqual(getAgentExecutionMode(), 'agent');
      assert.strictEqual(isAgentConfigurationOperationMode(), true);
    });

    test('remote + batch → ошибка конфигурации, isAgentConfigurationOperationMode не бросает', async () => {
      await setAgentSetting('location', 'remote');
      await setOperationMode('batch');
      assert.throws(() => getAgentExecutionMode(), /v8vscedit\.agent\.location/);
      assert.strictEqual(isAgentConfigurationOperationMode(), false);
    });

    test('реэкспорт из ExtensionCommandRunner', () => {
      assert.strictEqual(runner.getAgentExecutionMode, getAgentExecutionMode);
      assert.strictEqual(runner.resolveAgentExecutionMode, resolveAgentExecutionMode);
    });

    // Все шесть агентских точек входа: ни одна не уходит молча в локальный пакетный Конфигуратор.
    const entryPoints: [string, (folder: vscode.WorkspaceFolder, channel: vscode.OutputChannel) => Promise<boolean>][] = [
      ['runDecompileMainConfiguration', (f, c) => runner.runDecompileMainConfiguration('Основная', path.join(os.tmpdir(), 'cf'), f, c)],
      ['runDecompileExtension', (f, c) => runner.runDecompileExtension('Расш', path.join(os.tmpdir(), 'cfe'), f, c)],
      ['runApplyDatabaseConfiguration', (f, c) => runner.runApplyDatabaseConfiguration(
        { kind: 'cf', name: 'Основная', rootPath: path.join(os.tmpdir(), 'cf') }, f, c
      )],
      ['runCompileExtension', (f, c) => runner.runCompileExtension('Расш', path.join(os.tmpdir(), 'cfe'), f, c)],
      ['runUpdateExtension', (f, c) => runner.runUpdateExtension('Расш', path.join(os.tmpdir(), 'cfe'), f, c)],
      ['runUpdateMainConfiguration', (f, c) => runner.runUpdateMainConfiguration('Основная', path.join(os.tmpdir(), 'cf'), f, c)],
    ];
    // Обратная сторона: в local + batch все шесть точек уходят в пакетную ветку. Признак — её первый
    // шаг: чтение env.json, которого во временном каталоге нет, отклоняет промис. Агентская ветка
    // ошибку перехватывает и показывает сама (промис не отклоняется), а запись агента в кэше не появляется.
    const batchRoot = path.join(os.tmpdir(), 'v8-e8-batch', 'project');
    const batchEntryPoints: [string, (folder: vscode.WorkspaceFolder, channel: vscode.OutputChannel) => Promise<boolean>][] = [
      ['runDecompileMainConfiguration', (f, c) => runner.runDecompileMainConfiguration('Основная', path.join(batchRoot, 'src', 'cf'), f, c)],
      ['runDecompileExtension', (f, c) => runner.runDecompileExtension('Расш', path.join(batchRoot, 'src', 'cfe', 'Расш'), f, c)],
      ['runApplyDatabaseConfiguration', (f, c) => runner.runApplyDatabaseConfiguration(
        { kind: 'cf', name: 'Основная', rootPath: path.join(batchRoot, 'src', 'cf') }, f, c
      )],
      ['runCompileExtension', (f, c) => runner.runCompileExtension('Расш', path.join(batchRoot, 'src', 'cfe', 'Расш'), f, c)],
      ['runUpdateExtension', (f, c) => runner.runUpdateExtension('Расш', path.join(batchRoot, 'src', 'cfe', 'Расш'), f, c)],
      ['runUpdateMainConfiguration', (f, c) => runner.runUpdateMainConfiguration('Основная', path.join(batchRoot, 'src', 'cf'), f, c)],
    ];
    for (const [name, run] of batchEntryPoints) {
      test(`local + batch: ${name} идёт в пакетную ветку (первый шаг — env.json), агент не создаётся`, async () => {
        fs.mkdirSync(batchRoot, { recursive: true });
        const folder = { uri: vscode.Uri.file(batchRoot), name: 'batch', index: 0 };
        const channel = { appendLine: () => undefined } as unknown as vscode.OutputChannel;
        try {
          await assert.rejects(run(folder, channel), /Не найден env\.json для подключения к базе/);
          assert.strictEqual(getCachedAgentOperationService(folder), undefined);
        } finally {
          fs.rmSync(path.dirname(batchRoot), { recursive: true, force: true });
        }
      });
    }

    for (const [name, run] of entryPoints) {
      test(`remote + batch: ${name} отказывает явной ошибкой, а не уходит в пакетный режим`, async () => {
        await setAgentSetting('location', 'remote');
        await setOperationMode('batch');
        const folder = { uri: vscode.Uri.file(os.tmpdir()), name: 'x', index: 0 };
        const lines: string[] = [];
        const channel = { appendLine: (line: string) => { lines.push(line); } } as unknown as vscode.OutputChannel;
        await assert.rejects(
          run(folder, channel),
          (error: Error) => error.message.includes('v8vscedit.agent.location')
            && error.message.includes('v8vscedit.configuration.operationMode')
        );
        assert.deepStrictEqual(lines, [], 'пакетный Конфигуратор не запускался');
      });
    }
  });
});

suite('Агент Э8 (Н24): подсказка про каталог внешнего агента', () => {
  test('нет agentbasedir.json → сообщение называет agentModeArgs и /AgentBaseDir, путь индекса сохранён', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-e8-n24-'));
    try {
      await assert.rejects(
        resolveLocalAgentUserRoot(base, 'user'),
        (error: Error) => error.message.includes(path.join(base, 'agentbasedir.json'))
          && error.message.includes('v8vscedit.agent.agentModeArgs')
          && error.message.includes('/AgentBaseDir')
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
