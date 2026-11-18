import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentMessage } from '../../domain/agent';
import { AgentCommandError, DesignerAgentProcess } from '../../infra/agent';
import { ProjectSecretStorage } from '../../infra/environment';
import {
  appendAgentProcessOutput,
  buildAgentStartLogArgs,
  createAgentOperationServiceEntry,
  disposeCachedAgentOperationServices,
  getAgentOperationService,
  getAgentOperationServiceForInteractiveDesigner,
  logAgentDiagnostics,
  startAgentOperationService,
} from '../../ui/commands/ext/agent/AgentServiceRegistry';
import {
  getAgentStatusMessage,
  isImportHooks,
  isRawAgentCommandMessage,
  runAgentConfigurationOperation,
  showAgentQuestion,
  type RunAgentOptions,
} from '../../ui/commands/ext/agent/agentConfigurationOperation';
import {
  readAgentCommandSettings,
  toDesignerAgentConnection,
  type AgentCommandSettings,
} from '../../ui/commands/ext/agent/agentSettings';
import {
  beginConfigurationOperationStatus,
  endConfigurationOperationStatus,
  resetConfigurationOperationStatus,
  setConfigurationOperationStatus,
  trimStatusMessage,
  updateConfigurationOperationStatus,
} from '../../ui/commands/ext/configurationOperationStatus';
import {
  buildConnectionCliArgs,
  resolveConnectionFromSettings,
  resolveProjectSettingsPath,
  resolveSettingsPath,
  setProjectSecretStorage,
} from '../../ui/commands/ext/connectionSettings';

/**
 * Покрытие модулей, вынесенных из ExtensionCommandRunner (Э2): agent/*, connectionSettings,
 * configurationOperationStatus. Эти функции меняются в Э3/Э4 (готовность SSH, жизненный
 * цикл подключения ИБ), поэтому тесты фиксируют наблюдаемое поведение: строки журнала,
 * вектор запуска процесса, состав кэша, тексты диалогов.
 *
 * Допущения: (1) процесс 1С — внешняя система, подменён исполняемым файлом тест-хоста в
 * режиме Node (приём из localDesignerBatchExecutor.test.ts), который реально открывает
 * TCP-порт из `/AgentPort`; (2) диалоги VS Code подменяются присваиванием (`await show*`
 * в тестовом хосте висит); (3) OutputChannel — фейк, т.к. настоящий не наблюдаем.
 */

const FAKE_AGENT_SCRIPT = `
const fs = require('fs');
const net = require('net');
const argv = process.argv.slice(2);
const i = argv.indexOf('/AgentPort');
fs.writeFileSync(process.env.FAKE_AGENT_RECORD, JSON.stringify({ argv, cwd: process.cwd() }));
console.log('agent-out-line');
console.error('agent-err-line');
if (process.env.FAKE_AGENT_EXIT === '1') { process.exit(3); }
const server = net.createServer((s) => s.destroy());
server.listen(Number(argv[i + 1]), '127.0.0.1');
setInterval(() => {}, 1000);
`;

type Fn = (...args: never[]) => unknown;
const win = vscode.window as unknown as Record<string, Fn>;

/** Регистр буквы диска зависит от источника пути (Uri.fsPath даёт строчную), поэтому сравнение нечувствительно к нему. */
function samePath(a: string | undefined, b: string): boolean {
  return a !== undefined && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function stubWindow(name: string, impl: (...args: unknown[]) => unknown): () => void {
  const original = win[name];
  win[name] = impl;
  return () => { win[name] = original; };
}

async function setAgentConfig(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration('v8vscedit.agent').update(key, value, vscode.ConfigurationTarget.Global);
}

const AGENT_KEYS = ['host', 'listenAddress', 'port', 'user', 'privateKeyPath', 'autoStart', 'visible',
  'agentModeArgs', 'progressInterval', 'startupTimeoutMs', 'authWarmupMs'];

function settings(overrides: Partial<AgentCommandSettings> = {}): AgentCommandSettings {
  return {
    host: '127.0.0.1', listenAddress: '127.0.0.1', port: 1543, user: 'u', password: 'p', privateKeyPath: '',
    visible: false, autoStart: false, agentModeArgs: [], progressInterval: 0.5, startupTimeoutMs: 15000, authWarmupMs: 90000, idleDisconnectMinutes: 0,
    location: 'local', transferConcurrency: 16, archiveThresholdFiles: 300,
    ...overrides,
  };
}

suite('Агент: connectionSettings', () => {
  let tmp: string;

  setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-conn-')); });
  teardown(() => {
    // Нейтральное хранилище: пустой SecretStore даёт legacy-значение, как и отсутствие хранилища.
    setProjectSecretStorage(new ProjectSecretStorage(memorySecrets(new Map()), 'neutral'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function memorySecrets(map: Map<string, string>) {
    return {
      get: (k: string) => Promise.resolve(map.get(k)),
      store: (k: string, v: string) => { map.set(k, v); return Promise.resolve(); },
      delete: (k: string) => { map.delete(k); return Promise.resolve(); },
    };
  }

  function writeEnv(defaults: Record<string, unknown>): string {
    const p = path.join(tmp, 'env.json');
    fs.writeFileSync(p, JSON.stringify({ default: defaults }), 'utf-8');
    return p;
  }

  test('resolveProjectSettingsPath: env.json в корне рабочей папки', () => {
    const p = writeEnv({});
    assert.strictEqual(resolveProjectSettingsPath(tmp), p);
  });

  test('resolveSettingsPath: без файлов возвращает первого кандидата, example/env.json — запасной', () => {
    assert.strictEqual(resolveSettingsPath(tmp, tmp), path.join(tmp, 'env.json'));
    fs.mkdirSync(path.join(tmp, 'example'));
    const ex = path.join(tmp, 'example', 'env.json');
    fs.writeFileSync(ex, '{}');
    assert.strictEqual(resolveSettingsPath(tmp, path.join(tmp, 'a', 'b', 'c')), ex);
  });

  test('resolveConnectionFromSettings: /F, пароль из legacy env.json без хранилища и путь платформы', async () => {
    // Без сброса здесь работало бы хранилище, внедрённое teardown'ом предыдущего теста,
    // и ветка «хранилище не внедрено» фактически не проверялась бы.
    setProjectSecretStorage(undefined);
    const p = writeEnv({ '--ibconnection': '"/F' + path.join(tmp, 'base') + '"', '--db-user': 'adm', '--db-pwd': 'legacy', '--path': 'X:/v8' });
    const c = await resolveConnectionFromSettings(p);
    assert.strictEqual(c.infoBasePath, path.join(tmp, 'base'));
    assert.strictEqual(c.userName, 'adm');
    assert.strictEqual(c.password, 'legacy');
    assert.strictEqual(c.v8Path, 'X:/v8');
  });

  test('resolveConnectionFromSettings: /S → сервер и ссылка; пароль из SecretStorage приоритетнее env.json', async () => {
    const map = new Map<string, string>();
    const secrets = new ProjectSecretStorage(memorySecrets(map), tmp);
    await secrets.setDbPassword('from-secret');
    setProjectSecretStorage(secrets);
    const p = writeEnv({ '--ibconnection': '/Ssrv:1541/my/ref', '--db-pwd': 'legacy' });
    const c = await resolveConnectionFromSettings(p);
    assert.strictEqual(c.infoBaseServer, 'srv:1541');
    assert.strictEqual(c.infoBaseRef, 'my/ref');
    assert.strictEqual(c.password, 'from-secret');
    assert.strictEqual(c.userName, '');
    assert.strictEqual(c.v8Path, '');
  });

  test('resolveConnectionFromSettings: хранилище без пароля → fallback на legacy', async () => {
    setProjectSecretStorage(new ProjectSecretStorage(memorySecrets(new Map()), tmp));
    const p = writeEnv({ '--ibconnection': '/Fx', '--db-pwd': 'legacy' });
    assert.strictEqual((await resolveConnectionFromSettings(p)).password, 'legacy');
  });

  test('resolveConnectionFromSettings: версия платформы превращается в подсказку пути', async () => {
    const p = writeEnv({ '--ibconnection': '/Fx', '--v8version': '8.3.99.1' });
    assert.ok((await resolveConnectionFromSettings(p)).v8Path?.includes('8.3.99.1'));
  });

  test('resolveConnectionFromSettings: ошибки — нет файла, нет ключа, неразбираемое значение, /S без ссылки', async () => {
    await assert.rejects(resolveConnectionFromSettings(path.join(tmp, 'nope.json')), /Не найден env\.json/);
    await assert.rejects(resolveConnectionFromSettings(writeEnv({})), /отсутствует "--ibconnection"/);
    await assert.rejects(resolveConnectionFromSettings(writeEnv({ '--ibconnection': 'garbage' })), /Не удалось разобрать/);
    await assert.rejects(resolveConnectionFromSettings(writeEnv({ '--ibconnection': '/Sserveronly' })), /Не удалось разобрать/);
  });

  test('resolveConnectionFromSettings: env.json без секции default → нет --ibconnection', async () => {
    const p = path.join(tmp, 'env.json');
    fs.writeFileSync(p, '{}');
    await assert.rejects(resolveConnectionFromSettings(p), /отсутствует "--ibconnection"/);
  });

  test('buildConnectionCliArgs: файловая база со всеми полями', () => {
    assert.deepStrictEqual(
      buildConnectionCliArgs({ infoBasePath: 'C:/b', userName: 'u', password: 'p', v8Path: 'V' }),
      ['-InfoBasePath', 'C:/b', '-UserName', 'u', '-Password', 'p', '-V8Path', 'V']
    );
  });

  test('buildConnectionCliArgs: серверная база без необязательных полей', () => {
    assert.deepStrictEqual(
      buildConnectionCliArgs({ infoBaseServer: 's', infoBaseRef: 'r' }),
      ['-InfoBaseServer', 's', '-InfoBaseRef', 'r']
    );
  });

  test('buildConnectionCliArgs: недостаточно параметров', () => {
    assert.throws(() => buildConnectionCliArgs({}), /Недостаточно параметров/);
    assert.throws(() => buildConnectionCliArgs({ infoBaseServer: 's' }), /Недостаточно параметров/);
  });
});

suite('Агент: agentSettings.toDesignerAgentConnection', () => {
  test('серверная база: infoBasePath пустой, ссылка и сервер сохранены', () => {
    assert.deepStrictEqual(
      toDesignerAgentConnection({ infoBaseServer: 's', infoBaseRef: 'r', infoBasePath: 'ignored', v8Path: 'V' }),
      { infoBasePath: '', infoBaseServer: 's', infoBaseRef: 'r', v8Path: 'V' }
    );
  });

  test('файловая база; v8Path по умолчанию — пустая строка', () => {
    assert.deepStrictEqual(toDesignerAgentConnection({ infoBasePath: 'C:/b' }), { infoBasePath: 'C:/b', v8Path: '' });
  });

  test('сервер без ссылки и без пути → исключение', () => {
    assert.throws(() => toDesignerAgentConnection({ infoBaseServer: 's' }), /Недостаточно параметров/);
    assert.throws(() => toDesignerAgentConnection({}), /Недостаточно параметров/);
  });
});

suite('Агент: configurationOperationStatus', () => {
  teardown(() => resetConfigurationOperationStatus());

  test('trimStatusMessage: схлопывает пробелы и обрезает до 80 символов с многоточием', () => {
    assert.strictEqual(trimStatusMessage('  a \n  b\t c '), 'a b c');
    assert.strictEqual(trimStatusMessage('x'.repeat(80)), 'x'.repeat(80));
    assert.strictEqual(trimStatusMessage('x'.repeat(81)), `${'x'.repeat(77)}...`);
  });

  test('жизненный цикл: begin/update/end, параллельные операции и компат-обёртка не бросают', () => {
    setConfigurationOperationStatus('T', 'старт', true);
    beginConfigurationOperationStatus('T2', 'параллельная');
    updateConfigurationOperationStatus('T', 'идёт');
    endConfigurationOperationStatus('T', 'готово');
    // Вторая завершается последней: ставит таймер скрытия, а следующий begin его отменяет.
    setConfigurationOperationStatus('T2', 'готово', false);
    beginConfigurationOperationStatus('T3', 'снова');
    // Терминал без текста (финализирующий clearConfigurationProgress) и лишний end ниже нуля.
    endConfigurationOperationStatus();
    endConfigurationOperationStatus();
  });

  test('таймер скрытия: по истечении 5 с статус-бар скрывается и таймер сбрасывается', () => {
    // Реальное ожидание 5 с недетерминировано и медленно: перехватываем именно этот таймер и вызываем его сами.
    const realSetTimeout = global.setTimeout;
    const captured: { delay?: number; run?: () => void } = {};
    global.setTimeout = ((fn: () => void, delay?: number) => {
      captured.delay = delay;
      captured.run = fn;
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;
    try {
      beginConfigurationOperationStatus('T', 'm');
      endConfigurationOperationStatus('T', 'ok');
    } finally {
      global.setTimeout = realSetTimeout;
    }
    assert.strictEqual(captured.delay, 5000);
    captured.run?.();
    // После срабатывания таймера следующий begin/end работает как с чистого листа.
    beginConfigurationOperationStatus('T', 'снова');
    endConfigurationOperationStatus('T', 'ok');
  });

  test('reset при ожидающем таймере скрытия и повторный reset без элемента', () => {
    beginConfigurationOperationStatus('T', 'm');
    endConfigurationOperationStatus('T', 'ok');
    resetConfigurationOperationStatus();
    resetConfigurationOperationStatus();
    beginConfigurationOperationStatus('T', 'после сброса');
  });
});

suite('Агент: чистые функции agentConfigurationOperation', () => {
  test('isRawAgentCommandMessage: сырые команды платформы на трёх языках', () => {
    const raw = ['common connect-ib', 'CONFIG  dump', 'options x', 'infobase-tools y',
      'Выполнено: common connect', 'The operation is completed: config load'];
    for (const m of raw) {
      assert.strictEqual(isRawAgentCommandMessage(m), true, m);
    }
    assert.strictEqual(isRawAgentCommandMessage('Загрузка объектов'), false);
    assert.strictEqual(isRawAgentCommandMessage('commonly used'), false);
  });

  test('getAgentStatusMessage: сырая команда скрывается, обычный текст усекается', () => {
    assert.strictEqual(getAgentStatusMessage('common connect-ib x'), undefined);
    assert.strictEqual(getAgentStatusMessage('  Обработка   объектов '), 'Обработка объектов');
  });

  test('isImportHooks: по наличию beforeProjectFilesChanged', () => {
    assert.strictEqual(isImportHooks(undefined), false);
    assert.strictEqual(isImportHooks({ onProgressMessage: () => undefined }), false);
    assert.strictEqual(isImportHooks({ beforeProjectFilesChanged: () => undefined }), true);
  });
});

suite('Агент: showAgentQuestion', () => {
  const restores: (() => void)[] = [];
  teardown(() => { restores.splice(0).forEach((r) => r()); });

  test('вопрос про пароль → поле ввода с маскировкой', async () => {
    const calls: vscode.InputBoxOptions[] = [];
    restores.push(stubWindow('showInputBox', (o) => { calls.push(o as vscode.InputBoxOptions); return Promise.resolve('secret'); }));
    const r = await showAgentQuestion({ type: 'question', message: '  Введите Password  ' });
    assert.strictEqual(r, 'secret');
    assert.strictEqual(calls[0]?.password, true);
    assert.strictEqual(calls[0]?.prompt, 'Введите Password');
    assert.strictEqual(calls[0]?.title, 'Пароль информационной базы');
  });

  test('вопрос про пользователя → поле ввода без маскировки; текст из body-строки', async () => {
    const calls: vscode.InputBoxOptions[] = [];
    restores.push(stubWindow('showInputBox', (o) => { calls.push(o as vscode.InputBoxOptions); return Promise.resolve('adm'); }));
    const r = await showAgentQuestion({ type: 'question', message: '   ', body: 'Укажите login' });
    assert.strictEqual(r, 'adm');
    assert.strictEqual(calls[0]?.password, undefined);
    assert.strictEqual(calls[0]?.title, 'Пользователь информационной базы');
  });

  const choices: [string | undefined, string][] = [['Да', 'yes'], ['Нет', 'no'], ['Отмена', 'cancel'], [undefined, 'cancel']];
  for (const [action, expected] of choices) {
    test(`модальный вопрос: ${String(action)} → ${expected}`, async () => {
      let args: unknown[] = [];
      restores.push(stubWindow('showWarningMessage', (...a) => { args = a; return Promise.resolve(action); }));
      const r = await showAgentQuestion({ type: 'question', message: 'Продолжить?' });
      assert.strictEqual(r, expected);
      assert.deepStrictEqual(args, ['Продолжить?', { modal: true }, 'Да', 'Нет', 'Отмена']);
    });
  }

  test('без message и строкового body: текст — JSON тела либо всего сообщения', async () => {
    const texts: unknown[] = [];
    restores.push(stubWindow('showWarningMessage', (t) => { texts.push(t); return Promise.resolve('Да'); }));
    await showAgentQuestion({ type: 'question', body: { a: 1 } });
    const bare: AgentMessage = { type: 'question' };
    await showAgentQuestion(bare);
    assert.deepStrictEqual(texts, ['{"a":1}', JSON.stringify(bare)]);
  });
});

suite('Агент: AgentServiceRegistry и runAgentConfigurationOperation', function () {
  // Старт поддельного процесса и ожидание порта под нагрузкой (задача планировщика, параллельные
  // прогоны) не укладываются в 2 с по умолчанию; таймаут распространяется и на setup/teardown.
  this.timeout(60_000);
  let tmp: string;
  let folder: vscode.WorkspaceFolder;
  let log: string[];
  let channel: vscode.OutputChannel;
  let shown: boolean[];
  let waiters: { re: RegExp; resolve: () => void }[];
  const restores: (() => void)[] = [];
  let fakeBinDir: string;
  let fakeV8Path: string;

  function waitForLog(re: RegExp): Promise<void> {
    if (log.some((l) => re.test(l))) {
      return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push({ re, resolve }));
  }

  async function freePort(): Promise<number> {
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));
    return port;
  }

  function writeEnv(ib: string, extra: Record<string, unknown> = {}): void {
    fs.writeFileSync(path.join(tmp, 'env.json'),
      JSON.stringify({ default: { '--ibconnection': ib, '--db-user': 'u', '--db-pwd': 'p', ...extra } }), 'utf-8');
  }

  function installFakeAgent(): string {
    const baseDir = path.join(tmp, '.v8vscedit', 'agent');
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'DESIGNER'), FAKE_AGENT_SCRIPT, 'utf-8');
    process.env.FAKE_AGENT_RECORD = path.join(tmp, 'record.json');
    return baseDir;
  }

  function options(extra: Partial<RunAgentOptions> = {}): RunAgentOptions {
    return {
      progressTitle: 'Импорт', progressStartMessage: 'старт', successMessage: 'Готово!', errorTitle: 'Сбой импорта',
      workspaceFolder: folder, outputChannel: channel, rootPath: tmp, ...extra,
    };
  }

  // Резолвер пути 1С принимает только файл с именем 1cv8(.exe), а исполняемый файл тест-хоста
  // (Electron) не самодостаточен при переименовании. Поэтому «1cv8» — копия системного node,
  // который есть везде, где запускаются тесты (npm); роль скрипта играет файл DESIGNER в cwd.
  suiteSetup(() => {
    const exeName = process.platform === 'win32' ? 'node.exe' : 'node';
    const nodePath = (process.env.PATH ?? '').split(path.delimiter)
      .map((dir) => path.join(dir, exeName))
      .find((candidate) => fs.existsSync(candidate));
    assert.ok(nodePath, 'node не найден в PATH: нужен для подмены 1cv8');
    fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-fake-1cv8-'));
    fakeV8Path = path.join(fakeBinDir, process.platform === 'win32' ? '1cv8.exe' : '1cv8');
    fs.copyFileSync(nodePath, fakeV8Path);
    fs.chmodSync(fakeV8Path, 0o755);
  });

  suiteTeardown(() => { fs.rmSync(fakeBinDir, { recursive: true, force: true }); });

  setup(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-mod-'));
    folder = { uri: vscode.Uri.file(tmp), name: 'ws', index: 0 };
    log = [];
    waiters = [];
    shown = [];
    channel = {
      appendLine: (line: string) => {
        log.push(line);
        waiters = waiters.filter((w) => {
          if (w.re.test(line)) { w.resolve(); return false; }
          return true;
        });
      },
      show: () => { shown.push(true); },
    } as unknown as vscode.OutputChannel;
    await disposeCachedAgentOperationServices();
    await setAgentConfig('host', '127.0.0.1');
    await setAgentConfig('listenAddress', '127.0.0.1');
  });

  teardown(async () => {
    restores.splice(0).forEach((r) => r());
    await disposeCachedAgentOperationServices();
    for (const key of AGENT_KEYS) { await setAgentConfig(key, undefined); }
    Reflect.deleteProperty(process.env, 'FAKE_AGENT_RECORD');
    Reflect.deleteProperty(process.env, 'FAKE_AGENT_EXIT');
    // dispose выше дожидается выхода процесса; повторы — на случай, когда Windows ещё не отпустила
    // дескрипторы каталога (антивирус/индексатор), а не подавление ошибки.
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test('logAgentDiagnostics: пишет каталог агента', () => {
    logAgentDiagnostics(folder, channel);
    assert.deepStrictEqual(log, [`[agent][diag] Каталог агента: ${path.join(folder.uri.fsPath, '.v8vscedit', 'agent')}`]);
  });

  test('appendAgentProcessOutput: построчно с меткой потока, пустые строки пропускаются', () => {
    appendAgentProcessOutput(channel, 'stderr', ' a \r\n\r\n b\n');
    appendAgentProcessOutput(channel, 'stdout', '');
    assert.deepStrictEqual(log, ['[agent][process][stderr] a', '[agent][process][stderr] b']);
  });

  test('buildAgentStartLogArgs: файловая и серверная база, /Visible, порт и пользовательские параметры', () => {
    const file = buildAgentStartLogArgs({ infoBasePath: 'C:/b', v8Path: '' },
      settings({ port: 1600, visible: true, agentModeArgs: ['/AgentSSHHostKey', 'k'] }), 'D');
    assert.deepStrictEqual(file, ['1cv8', 'DESIGNER', '/F', 'C:/b', '/AgentMode',
      '/AgentPort', '1600', '/AgentListenAddress', '127.0.0.1', '/AgentBaseDir', 'D', '/AgentSSHHostKey', 'k', '/Visible']);
    const server = buildAgentStartLogArgs({ infoBasePath: '', infoBaseServer: 's', infoBaseRef: 'r', v8Path: '' }, settings(), 'D');
    assert.deepStrictEqual(server.slice(0, 4), ['1cv8', 'DESIGNER', '/S', 's/r']);
    assert.ok(server.includes('/AgentSSHHostKeyAuto'));
    assert.ok(!server.includes('/Visible'));
  });

  test('createAgentOperationServiceEntry: сервис и сессии без процесса; процесс пробрасывается', () => {
    const entry = createAgentOperationServiceEntry(tmp, settings({ privateKeyPath: '  ' }));
    assert.ok(entry.service);
    assert.ok(entry.sessions);
    assert.strictEqual(entry.process, undefined);
    const proc = new DesignerAgentProcess();
    assert.strictEqual(createAgentOperationServiceEntry(tmp, settings({ privateKeyPath: 'k.pem' }), proc).process, proc);
  });

  test('startAgentOperationService autoStart=false: процесс не запускается, лог запуска пуст', async () => {
    writeEnv('/F' + path.join(tmp, 'base'));
    await setAgentConfig('autoStart', false);
    const entry = await startAgentOperationService(tmp, tmp, channel);
    assert.strictEqual(entry.process, undefined);
    assert.deepStrictEqual(log, []);
  });

  test('startAgentOperationService autoStart=true: вектор запуска, cwd, порт дождан, вывод процесса в журнале, остановка в dispose', async () => {
    const baseDir = installFakeAgent();
    const port = await freePort();
    writeEnv('/Ssrv/ref', { '--path': fakeV8Path });
    await setAgentConfig('autoStart', true);
    await setAgentConfig('port', port);
    await setAgentConfig('startupTimeoutMs', 20000);
    await setAgentConfig('agentModeArgs', '/AgentSSHHostKeyAuto');

    const service = await getAgentOperationService(folder, tmp, channel);
    // Повторный запрос с тем же ключом — тот же экземпляр, процесс второй раз не стартует.
    assert.strictEqual(await getAgentOperationService(folder, tmp, channel), service);

    await waitForLog(/\[agent\]\[process\]\[stdout\] agent-out-line/);
    await waitForLog(/\[agent\]\[process\]\[stderr\] agent-err-line/);
    assert.ok(log.some((l) => l === `[agent] Конфигуратор запущен в режиме агента.`));
    assert.ok(log.some((l) => l === `[agent] SSH-порт 127.0.0.1:${String(port)} открыт.`));
    assert.ok(log.some((l) => l.startsWith('[agent] Запуск конфигуратора: 1cv8 DESIGNER /S srv/ref /AgentMode /AgentPort')));
    assert.ok(log.some((l) => l.includes(`до 20000 мс`)));
    assert.ok(!log.some((l) => l.includes('-Password')), 'пароль не должен попадать в журнал запуска');

    const record = JSON.parse(fs.readFileSync(path.join(tmp, 'record.json'), 'utf-8')) as { argv: string[]; cwd: string };
    assert.deepStrictEqual(record.argv.slice(0, 3), ['/S', 'srv/ref', '/AgentMode']);
    assert.strictEqual(record.argv[record.argv.indexOf('/AgentPort') + 1], String(port));
    assert.strictEqual(samePath(record.argv[record.argv.indexOf('/AgentBaseDir') + 1], baseDir), true);
    assert.strictEqual(record.argv.filter((a) => a === '/AgentSSHHostKeyAuto').length, 1);
    assert.strictEqual(samePath(record.cwd, baseDir), true);

    await disposeCachedAgentOperationServices();
    await waitForLog(/\[agent\]\[process\] Конфигуратор в режиме агента завершился: код=/);
  });

  test('startAgentOperationService: процесс завершился, не открыв порт → ошибка с состоянием процесса, ключ не отравлен', async () => {
    installFakeAgent();
    process.env.FAKE_AGENT_EXIT = '1';
    writeEnv('/F' + path.join(tmp, 'base'), { '--path': fakeV8Path });
    await setAgentConfig('autoStart', true);
    await setAgentConfig('port', await freePort());
    await setAgentConfig('visible', true);

    await assert.rejects(
      getAgentOperationService(folder, tmp, channel),
      /не открыл SSH-порт 127\.0\.0\.1:\d+\. Состояние процесса: код=3/
    );
    await waitForLog(/завершился: код=3/);
    assert.ok(log.some((l) => l.includes('/F') && l.endsWith('/Visible')));
    // Неудачный старт удалил ключ: следующая попытка стартует заново (а не отдаёт отравленный промис).
    Reflect.deleteProperty(process.env, 'FAKE_AGENT_EXIT');
    await setAgentConfig('port', await freePort());
    const service = await getAgentOperationService(folder, tmp, channel);
    assert.ok(service);
  });

  test('startAgentOperationService: исполняемый файл 1С не найден → исключение из резолвера пути', async () => {
    writeEnv('/F' + path.join(tmp, 'base'), { '--path': path.join(tmp, 'нет-такого-1cv8.exe') });
    await setAgentConfig('autoStart', true);
    await assert.rejects(startAgentOperationService(tmp, tmp, channel), /Не найден исполняемый файл 1С/);
  });

  test('runAgentConfigurationOperation: успех — журнал, hooks прогресса, сообщение об успехе, проброс importHooks', async () => {
    writeEnv('/F' + path.join(tmp, 'base'));
    await setAgentConfig('autoStart', false);
    const infos: unknown[] = [];
    restores.push(stubWindow('showInformationMessage', (m) => { infos.push(m); return Promise.resolve(undefined); }));
    const progress: string[] = [];
    const own: string[] = [];
    const changed: string[][] = [];
    let serviceSeen = false;

    const ok = await runAgentConfigurationOperation(
      options({
        hooks: { onProgressMessage: (m) => progress.push(m), beforeProjectFilesChanged: (f) => changed.push(f) },
        onProgressMessage: (m) => own.push(m),
      }),
      (service, hooks) => {
        serviceSeen = Boolean(service);
        hooks.onMessage('common connect-ib');
        hooks.onMessage('Загрузка  файлов');
        hooks.onProjectFilesWillChange?.(['a.xml']);
        return Promise.resolve();
      }
    );

    assert.strictEqual(ok, true);
    assert.ok(serviceSeen);
    assert.deepStrictEqual(progress, ['старт', 'Загрузка файлов']);
    assert.deepStrictEqual(own, ['старт', 'Загрузка файлов']);
    assert.deepStrictEqual(changed, [['a.xml']]);
    assert.deepStrictEqual(infos, ['Готово!']);
    assert.deepStrictEqual(log, [
      '[agent] Старт: Импорт',
      '[agent] common connect-ib',
      '[agent] Загрузка  файлов',
      '[agent] Завершено: Импорт',
    ]);
  });

  test('runAgentConfigurationOperation: showSuccessMessage=false и hooks без importHooks', async () => {
    writeEnv('/F' + path.join(tmp, 'base'));
    await setAgentConfig('autoStart', false);
    const infos: unknown[] = [];
    restores.push(stubWindow('showInformationMessage', (m) => { infos.push(m); return Promise.resolve(undefined); }));
    let willChange: unknown = 'unset';

    const ok = await runAgentConfigurationOperation(
      options({ showSuccessMessage: false, hooks: { onProgressMessage: () => undefined } }),
      (_s, hooks) => { willChange = hooks.onProjectFilesWillChange; return Promise.resolve(); }
    );

    assert.strictEqual(ok, true);
    assert.strictEqual(willChange, undefined);
    assert.deepStrictEqual(infos, []);
  });

  test('runAgentConfigurationOperation: importHooks без beforeProjectFilesChanged-значения не падает при вызове', async () => {
    writeEnv('/F' + path.join(tmp, 'base'));
    await setAgentConfig('autoStart', false);
    restores.push(stubWindow('showInformationMessage', () => Promise.resolve(undefined)));
    const ok = await runAgentConfigurationOperation(
      options({ hooks: { beforeProjectFilesChanged: undefined } }),
      (_s, hooks) => { hooks.onProjectFilesWillChange?.(['x']); return Promise.resolve(); }
    );
    assert.strictEqual(ok, true);
  });

  test('runAgentConfigurationOperation: AgentCommandError — команда в журнале, «Открыть журнал» показывает канал', async () => {
    writeEnv('/F' + path.join(tmp, 'base'));
    await setAgentConfig('autoStart', false);
    const errors: unknown[][] = [];
    const clicked = new Promise<void>((resolve) => {
      restores.push(stubWindow('showErrorMessage', (...a) => {
        errors.push(a);
        queueMicrotask(resolve);
        return Promise.resolve('Открыть журнал');
      }));
    });

    const ok = await runAgentConfigurationOperation(options(), () => {
      throw new AgentCommandError('сломалось', 'config load-cfg');
    });
    await clicked;
    await new Promise<void>((r) => setImmediate(r));

    assert.strictEqual(ok, false);
    assert.deepStrictEqual(errors, [['Сбой импорта\nсломалось', 'Открыть журнал']]);
    assert.ok(log.includes('[agent][error] сломалось'));
    assert.ok(log.includes('[agent][error] Команда: config load-cfg'));
    assert.ok(log.some((l) => l.startsWith('[agent][diag] Каталог агента:')));
    assert.ok(!log.some((l) => l.startsWith('[agent] Завершено')));
    assert.strictEqual(shown.length, 1);
  });

  test('runAgentConfigurationOperation: обычная ошибка и не-Error; без выбора журнал не показывается', async () => {
    writeEnv('/F' + path.join(tmp, 'base'));
    await setAgentConfig('autoStart', false);
    const messages: unknown[] = [];
    restores.push(stubWindow('showErrorMessage', (m) => { messages.push(m); return Promise.resolve(undefined); }));

    assert.strictEqual(await runAgentConfigurationOperation(options(), () => Promise.reject(new Error('обычная'))), false);
    assert.strictEqual(await runAgentConfigurationOperation(options(), () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- проверяется ветка «брошено не Error»
      throw 'строка';
    }), false);
    await new Promise<void>((r) => setImmediate(r));

    assert.deepStrictEqual(messages, ['Сбой импорта\nобычная', 'Сбой импорта\nстрока']);
    assert.ok(log.includes('[agent][error] строка'));
    assert.ok(!log.some((l) => l.includes('Команда:')));
    assert.strictEqual(shown.length, 0);
  });

  test('runAgentConfigurationOperation: сбой создания сервиса (нет env.json) — ошибка, операция не вызывается', async () => {
    const messages: unknown[] = [];
    restores.push(stubWindow('showErrorMessage', (m) => { messages.push(m); return Promise.resolve(undefined); }));
    let called = false;
    const ok = await runAgentConfigurationOperation(options(), () => { called = true; return Promise.resolve(); });
    assert.strictEqual(ok, false);
    assert.strictEqual(called, false);
    assert.ok(log.some((l) => l.startsWith('[agent][error] Не найден env.json')));
  });

  test('dispose во время неудачного старта: отвергнутый промис в кэше не роняет остановку', async () => {
    // env.json нет → фабрика отвергается; dispose вызывается до того, как getOrCreate снимет ключ.
    const pending = getAgentOperationService(folder, tmp, channel);
    await disposeCachedAgentOperationServices();
    await assert.rejects(pending, /Не найден env\.json/);
  });

  test('getAgentOperationServiceForInteractiveDesigner: не-Error из чтения настроек → предупреждение в журнале, undefined', async () => {
    writeEnv('/F' + path.join(tmp, 'base'));
    const workspace = vscode.workspace as unknown as { getConfiguration: (section?: string) => unknown };
    const original = workspace.getConfiguration;
    workspace.getConfiguration = () => ({
      get: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- ветка «брошено не Error»
        throw 'сбой настроек';
      },
    });
    try {
      assert.strictEqual(await getAgentOperationServiceForInteractiveDesigner(folder, channel), undefined);
    } finally {
      workspace.getConfiguration = original;
    }
    assert.deepStrictEqual(log, ['[agent][warn] Не удалось проверить запущенный агент конфигуратора: сбой настроек']);
  });

  test('readAgentCommandSettings согласован с запуском: user из подключения, пароль из connection', () => {
    const s = readAgentCommandSettings({ userName: 'conn', password: 'pw' });
    assert.strictEqual(s.user, 'conn');
    assert.strictEqual(s.password, 'pw');
  });
});
