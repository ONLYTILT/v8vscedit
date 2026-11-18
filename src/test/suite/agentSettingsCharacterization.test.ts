import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as runner from '../../ui/commands/ext/ExtensionCommandRunner';
import {
  disposeCachedAgentOperationServices,
  getAgentOperationServiceForInteractiveDesigner,
  getAgentServiceCacheKey,
  getCachedAgentOperationService,
  isAgentConfigurationOperationMode,
  readAgentCommandSettings,
  splitAgentModeArgs,
} from '../../ui/commands/ext/ExtensionCommandRunner';

/**
 * Characterization-тесты агентской части ExtensionCommandRunner перед выносом в
 * ui/commands/ext/agent/ (Э2). Фиксируют ТЕКУЩЕЕ поведение, а не желаемое: после
 * переноса (с реэкспортом из ExtensionCommandRunner) сьют обязан остаться зелёным
 * без правок эталонов.
 */

const AGENT_KEYS = [
  'host', 'listenAddress', 'port', 'user', 'privateKeyPath',
  'autoStart', 'visible', 'agentModeArgs', 'progressInterval', 'startupTimeoutMs', 'authWarmupMs', 'connectTimeoutMs',
  'location', 'transferConcurrency', 'archiveThresholdFiles',
] as const;

async function setAgentConfig(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration('v8vscedit.agent').update(key, value, vscode.ConfigurationTarget.Global);
}

async function resetAgentConfig(): Promise<void> {
  for (const key of AGENT_KEYS) {
    await setAgentConfig(key, undefined);
  }
  await vscode.workspace.getConfiguration('v8vscedit.configuration')
    .update('operationMode', undefined, vscode.ConfigurationTarget.Global);
}

suite('Агент: splitAgentModeArgs (characterization)', () => {
  const cases: [string, string, string[]][] = [
    ['пустая строка', '', []],
    ['только пробелы', '   \t  ', []],
    ['несколько пробелов и табов между токенами', '/A   1\t\t/B', ['/A', '1', '/B']],
    ['двойные кавычки склеивают пробелы', '/Dir "a b c"', ['/Dir', 'a b c']],
    ['одинарные кавычки склеивают пробелы', "/Dir 'a b c'", ['/Dir', 'a b c']],
    ['другой вид кавычки внутри кавычек — обычный символ', `"it's fine"`, ["it's fine"]],
    ['кавычки в середине токена склеиваются с ним', '/Dir="a b"x', ['/Dir=a bx']],
    ['пустые кавычки не порождают токен', '""', []],
    ['экранированная кавычка внутри кавычек', '"a\\"b"', ['a"b']],
    ['экранированный обратный слэш внутри кавычек', '"a\\\\b"', ['a\\b']],
    ['обратный слэш перед другим символом внутри кавычек сохраняется', '"C:\\dir\\x"', ['C:\\dir\\x']],
    ['обратный слэш вне кавычек — обычный символ', 'C:\\dir\\x /A', ['C:\\dir\\x', '/A']],
    ['обратный слэш перед кавычкой вне кавычек не экранирует её', 'a\\"b c"', ['a\\b c']],
  ];

  for (const [title, input, expected] of cases) {
    test(title, () => {
      assert.deepStrictEqual(splitAgentModeArgs(input), expected);
    });
  }

  test('незакрытая двойная кавычка — исключение', () => {
    assert.throws(() => splitAgentModeArgs('/A "abc'), /не закрыта кавычка/);
  });

  test('незакрытая одинарная кавычка — исключение', () => {
    assert.throws(() => splitAgentModeArgs("'abc"), /не закрыта кавычка/);
  });

  test('одиночный обратный слэш в конце вне кавычек остаётся символом', () => {
    assert.deepStrictEqual(splitAgentModeArgs('/A\\'), ['/A\\']);
  });

  test('обратный слэш в конце внутри незакрытой кавычки — всё равно исключение', () => {
    assert.throws(() => splitAgentModeArgs('"abc\\'), /не закрыта кавычка/);
  });
});

suite('Агент: isAgentConfigurationOperationMode (characterization)', () => {
  teardown(resetAgentConfig);

  const table: [string | undefined, boolean][] = [
    [undefined, false],
    ['batch', false],
    ['agent', true],
  ];
  for (const [value, expected] of table) {
    test(`operationMode=${String(value)} → ${String(expected)}`, async () => {
      await vscode.workspace.getConfiguration('v8vscedit.configuration')
        .update('operationMode', value, vscode.ConfigurationTarget.Global);
      assert.strictEqual(isAgentConfigurationOperationMode(), expected);
    });
  }
});

suite('Агент: readAgentCommandSettings (characterization)', () => {
  // Прямой типизированный импорт: пропажа экспорта должна ронять компиляцию тестов,
  // а не молча пропускать сьют через skip.
  const read = readAgentCommandSettings;

  setup(resetAgentConfig);
  teardown(resetAgentConfig);

  test('значения по умолчанию', () => {
    assert.deepStrictEqual(read({ userName: 'ibuser', password: 'secret' }), {
      host: 'localhost',
      listenAddress: '127.0.0.1',
      port: 1543,
      user: 'ibuser',
      password: 'secret',
      privateKeyPath: '',
      visible: false,
      autoStart: true,
      agentModeArgs: [],
      progressInterval: 0.5,
      startupTimeoutMs: 15000,
      authWarmupMs: 90000,
      connectTimeoutMs: 60000,
      idleDisconnectMinutes: 0,
      location: 'local',
      transferConcurrency: 16,
      archiveThresholdFiles: 20000,
    });
  });

  test('user: настройка > userName подключения > admin', async () => {
    assert.strictEqual(read({ userName: 'ibuser' }).user, 'ibuser');
    assert.strictEqual(read({}).user, 'admin');
    assert.strictEqual(read({ userName: '   ' }).user, 'admin');
    await setAgentConfig('user', '  cfg  ');
    assert.strictEqual(read({ userName: 'ibuser' }).user, 'cfg');
  });

  test('пробельные host/listenAddress → значения по умолчанию', async () => {
    await setAgentConfig('host', '   ');
    await setAgentConfig('listenAddress', ' ');
    const settings = read({});
    assert.strictEqual(settings.host, 'localhost');
    assert.strictEqual(settings.listenAddress, '127.0.0.1');
  });

  test('пароль берётся из connection, при отсутствии — пустая строка', () => {
    assert.strictEqual(read({ password: 'p' }).password, 'p');
    assert.strictEqual(read({}).password, '');
  });

  test('заданные значения читаются, agentModeArgs разбирается, privateKeyPath триммится', async () => {
    await setAgentConfig('host', '10.0.0.5');
    await setAgentConfig('listenAddress', '0.0.0.0');
    await setAgentConfig('port', 2000);
    await setAgentConfig('privateKeyPath', '  /k/id  ');
    await setAgentConfig('visible', true);
    await setAgentConfig('autoStart', false);
    await setAgentConfig('agentModeArgs', '/AgentBaseDir "a b"');
    await setAgentConfig('progressInterval', 2);
    await setAgentConfig('startupTimeoutMs', 99);
    await setAgentConfig('authWarmupMs', 4321);
    const settings = read({});
    assert.strictEqual(settings.host, '10.0.0.5');
    assert.strictEqual(settings.listenAddress, '0.0.0.0');
    assert.strictEqual(settings.port, 2000);
    assert.strictEqual(settings.privateKeyPath, '/k/id');
    assert.strictEqual(settings.visible, true);
    assert.strictEqual(settings.autoStart, false);
    assert.deepStrictEqual(settings.agentModeArgs, ['/AgentBaseDir', 'a b']);
    assert.strictEqual(settings.progressInterval, 2);
    assert.strictEqual(settings.startupTimeoutMs, 99);
    assert.strictEqual(settings.authWarmupMs, 4321);
  });

  test('некорректный agentModeArgs пробрасывает исключение разбора', async () => {
    await setAgentConfig('agentModeArgs', '"oops');
    assert.throws(() => read({}), /не закрыта кавычка/);
  });
});

suite('Агент: кэш сервисов (characterization)', () => {
  let tmpRoot: string;
  let folder: vscode.WorkspaceFolder;
  let logLines: string[];
  let channel: vscode.OutputChannel;
  const servers: net.Server[] = [];

  /** Реальный TCP-сервер на свободном порту: детерминированно «агент слушает». */
  async function listen(): Promise<{ server: net.Server; port: number }> {
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return { server, port: (server.address() as net.AddressInfo).port };
  }

  /** Заведомо свободный порт: занимаем и сразу освобождаем. */
  async function freePort(): Promise<number> {
    const { server, port } = await listen();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  function writeEnv(): void {
    fs.writeFileSync(
      path.join(tmpRoot, 'env.json'),
      JSON.stringify({ default: { '--ibconnection': '/F' + path.join(tmpRoot, 'base'), '--db-user': 'u', '--db-pwd': 'p' } }),
      'utf-8'
    );
  }

  setup(async () => {
    await resetAgentConfig();
    await disposeCachedAgentOperationServices();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-cache-'));
    folder = { uri: vscode.Uri.file(tmpRoot), name: 'ws', index: 0 };
    logLines = [];
    // Фейк только UI-канала вывода: настоящий OutputChannel не нужен и не наблюдаем.
    channel = { appendLine: (line: string) => { logLines.push(line); } } as unknown as vscode.OutputChannel;
    await setAgentConfig('host', '127.0.0.1');
  });

  teardown(async () => {
    await disposeCachedAgentOperationServices();
    await resetAgentConfig();
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
      s.close(() => resolve());
    })));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('getAgentServiceCacheKey: абсолютный путь в нижнем регистре, нормализованный', () => {
    const key = getAgentServiceCacheKey(path.join('A', 'B', '..', 'C'));
    assert.strictEqual(key, path.resolve(path.join('A', 'C')).toLowerCase());
    assert.strictEqual(getAgentServiceCacheKey('X:\\Dir'), path.resolve('X:\\Dir').toLowerCase());
  });

  test('синхронный геттер до создания возвращает undefined', () => {
    assert.strictEqual(getCachedAgentOperationService(folder), undefined);
  });

  test('порт закрыт → undefined, ключ не отравлен: позже открытый порт даёт сервис', async () => {
    writeEnv();
    await setAgentConfig('port', await freePort());
    assert.strictEqual(await getAgentOperationServiceForInteractiveDesigner(folder, channel), undefined);
    assert.strictEqual(getCachedAgentOperationService(folder), undefined);

    const { port } = await listen();
    await setAgentConfig('port', port);
    const created = await getAgentOperationServiceForInteractiveDesigner(folder, channel);
    assert.ok(created);
    assert.strictEqual(created.forceDisconnect, true);
  });

  test('порт открыт → сервис с forceDisconnect=true; затем кэш с forceDisconnect=false и тем же экземпляром', async () => {
    writeEnv();
    const { port } = await listen();
    await setAgentConfig('port', port);

    const first = await getAgentOperationServiceForInteractiveDesigner(folder, channel);
    assert.ok(first);
    assert.strictEqual(first.forceDisconnect, true);
    assert.strictEqual(getCachedAgentOperationService(folder), first.service);
    assert.ok(logLines.some((l) => l.includes(`127.0.0.1:${String(port)}`)));

    const second = await getAgentOperationServiceForInteractiveDesigner(folder, channel);
    assert.ok(second);
    assert.strictEqual(second.forceDisconnect, false);
    assert.strictEqual(second.service, first.service);
  });

  test('параллельные вызовы создают один экземпляр (TOCTOU)', async () => {
    writeEnv();
    const { port } = await listen();
    await setAgentConfig('port', port);

    const [a, b, c] = await Promise.all([
      getAgentOperationServiceForInteractiveDesigner(folder, channel),
      getAgentOperationServiceForInteractiveDesigner(folder, channel),
      getAgentOperationServiceForInteractiveDesigner(folder, channel),
    ]);
    assert.ok(a && b && c);
    assert.strictEqual(a.service, b.service);
    assert.strictEqual(b.service, c.service);
    assert.strictEqual(logLines.filter((l) => l.includes('Найден запущенный агент')).length, 1);
  });

  test('отказ фабрики (нет env.json) → undefined с предупреждением, повтор после появления env.json создаёт сервис', async () => {
    const { port } = await listen();
    await setAgentConfig('port', port);

    assert.strictEqual(await getAgentOperationServiceForInteractiveDesigner(folder, channel), undefined);
    assert.ok(logLines.some((l) => l.includes('[agent][warn]') && l.includes('Не найден env.json')));

    writeEnv();
    const created = await getAgentOperationServiceForInteractiveDesigner(folder, channel);
    assert.ok(created);
    assert.strictEqual(created.forceDisconnect, true);
  });

  test('dispose очищает кэш: геттер undefined, следующий вызов создаёт новый экземпляр', async () => {
    writeEnv();
    const { port } = await listen();
    await setAgentConfig('port', port);

    const first = await getAgentOperationServiceForInteractiveDesigner(folder, channel);
    assert.ok(first);
    await disposeCachedAgentOperationServices();
    assert.strictEqual(getCachedAgentOperationService(folder), undefined);

    const again = await getAgentOperationServiceForInteractiveDesigner(folder, channel);
    assert.ok(again);
    assert.strictEqual(again.forceDisconnect, true);
    assert.notStrictEqual(again.service, first.service);
  });

  test('dispose без записей в кэше не бросает и идемпотентен', async () => {
    await disposeCachedAgentOperationServices();
    await disposeCachedAgentOperationServices();
  });
});

suite('ExtensionCommandRunner: публичный API (characterization)', () => {
  // Список — то, что импортируют потребители (Container, ui/commands, ui/mcp) и тесты.
  // Перенос агентской части не должен убрать ни один символ из реэкспорта.
  const expectedFunctions = [
    'setProjectSecretStorage',
    'isAgentConfigurationOperationMode',
    'getAgentServiceCacheKey',
    'getCachedAgentOperationService',
    'disposeCachedAgentOperationServices',
    'getAgentOperationServiceForInteractiveDesigner',
    'splitAgentModeArgs',
    'extractExtensionTarget',
    'runDecompileExtension',
    'runDecompileMainConfiguration',
    'runApplyDatabaseConfiguration',
    'runCompileExtension',
    'runUpdateExtension',
    'runUpdateMainConfiguration',
    'listConnectedDatabaseExtensions',
    'createWorkspaceTempDir',
    'runInternalCliCommand',
    'setConfigurationOperationStatus',
    'beginConfigurationOperationStatus',
    'updateConfigurationOperationStatus',
    'endConfigurationOperationStatus',
    'removeTempDir',
    'resolveSettingsPath',
    'resolveProjectSettingsPath',
    'resolveConnectionFromSettings',
    'buildConnectionCliArgs',
  ];

  for (const name of expectedFunctions) {
    test(`экспортирует функцию ${name}`, () => {
      assert.strictEqual(typeof (runner as unknown as Record<string, unknown>)[name], 'function');
    });
  }
});
