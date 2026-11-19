/**
 * Э4: согласование агента конфигуратора с пакетными операциями (UI-слой, Extension Host).
 *
 * Ожидаемый контракт:
 *  - ui/commands/ext/agent/AgentServiceRegistry.ts:
 *      releaseAgentInfoBaseForBatch(
 *        workspaceFolder: vscode.WorkspaceFolder,
 *        outputChannel: vscode.OutputChannel,
 *        deps?: { createEntry?: (workspaceRoot: string, settings: AgentCommandSettings) => CachedAgentService }
 *      ): Promise<void>
 *    - сервис закэширован → disconnectInfoBase() (только если подключено);
 *    - не закэширован, режим operationMode='agent' и порт агента открыт (внешний агент) → создаётся запись
 *      (deps.createEntry, по умолчанию createAgentOperationServiceEntry), кладётся в кэш, disconnectInfoBase({force:true});
 *    - иначе (режим batch / порт закрыт / env.json не найден) — ничего, не бросает (при сбое поиска — строка
 *      `[agent][warn]` в журнале);
 *    - ошибка disconnect пробрасывается: пакетная операция не должна стартовать.
 *    Реэкспортируется из ExtensionCommandRunner.
 *  - CachedAgentService получает публичные поля transportOptions и idleDisconnectMs (см. agentConnectWiring.test.ts).
 *  - runInternalCliCommand зовёт releaseAgentInfoBaseForBatch ДО спавна CLI; сбой release → возвращает false,
 *    CLI не запускается, причина уходит в onFailureReason.
 *  - runDbClientFromWorkspace: режим DESIGNER + operationMode='agent' + идёт операция с конфигурацией
 *    (isConfigurationOperationRunning) → сообщение «…уже выполняется…» и отказ, агент не трогается.
 *  - команда v8vscedit.agent.releaseInfoBase (регистрируется в CommandRegistry.registerCommands, объявлена в package.json).
 *
 * Подмены: только внешний агент 1С (ScriptedFactory — фейковый транспорт), UI-диалоги vscode.window и
 * OutputChannel (приёмник строк). Реальные TCP-порты и временные каталоги — настоящие.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { InteractiveDesignerProcess } from '../../infra/agent';
import type { ProjectSecretStorage } from '../../infra/environment';
import { registerCommands } from '../../ui/commands/CommandRegistry';
import type { CommandServices } from '../../ui/commands/_shared';
import { runDbClientFromWorkspace } from '../../ui/commands/db/DbRunCommandRunner';
import {
  disposeCachedAgentOperationServices,
  getCachedAgentOperationService,
  releaseAgentInfoBaseForBatch,
} from '../../ui/commands/ext/agent/AgentServiceRegistry';
import { runInternalCliCommand } from '../../ui/commands/ext/ExtensionCommandRunner';
import { endConfigurationOperation, tryBeginConfigurationOperation } from '../../ui/commands/ext/configurationOperationLock';
import { agentError } from './support/agentInfoBaseFakes';
import { makeAgentEntry, seedCachedAgentService } from './support/agentRegistrySeed';

const ROOT = path.resolve(__dirname, '../../..');
const DISCONNECT = 'common disconnect-ib';
const CONNECT = 'common connect-ib';

type WindowRef = Record<string, unknown>;
const windowRef = vscode.window as unknown as WindowRef;

async function setConfig(section: string, key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
}

class Harness {
  root = '';
  folder!: vscode.WorkspaceFolder;
  lines: string[] = [];
  channel!: vscode.OutputChannel;
  errors: string[] = [];
  infos: string[] = [];
  warnings: string[] = [];
  private saved: Record<string, unknown> = {};
  private readonly servers: net.Server[] = [];

  async setup(prefix: string): Promise<void> {
    this.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    this.folder = { uri: vscode.Uri.file(this.root), name: 'e4', index: 0 };
    this.lines = [];
    this.errors = [];
    this.infos = [];
    this.warnings = [];
    this.channel = { appendLine: (line: string) => { this.lines.push(line); } } as unknown as vscode.OutputChannel;
    for (const key of ['showErrorMessage', 'showInformationMessage', 'showWarningMessage']) {
      this.saved[key] = windowRef[key];
    }
    windowRef.showErrorMessage = (m: string) => { this.errors.push(m); return Promise.resolve(undefined); };
    windowRef.showInformationMessage = (m: string) => { this.infos.push(m); return Promise.resolve(undefined); };
    windowRef.showWarningMessage = (m: string) => { this.warnings.push(m); return Promise.resolve(undefined); };
    await disposeCachedAgentOperationServices();
    await setConfig('v8vscedit.configuration', 'operationMode', undefined);
    await setConfig('v8vscedit.agent', 'host', '127.0.0.1');
  }

  async teardown(): Promise<void> {
    for (const key of Object.keys(this.saved)) {
      windowRef[key] = this.saved[key];
    }
    await disposeCachedAgentOperationServices();
    await setConfig('v8vscedit.configuration', 'operationMode', undefined);
    await setConfig('v8vscedit.agent', 'host', undefined);
    await setConfig('v8vscedit.agent', 'port', undefined);
    await Promise.all(this.servers.splice(0).map((s) => new Promise<void>((resolve) => { s.close(() => resolve()); })));
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  writeEnv(): void {
    fs.writeFileSync(
      path.join(this.root, 'env.json'),
      JSON.stringify({ default: { '--ibconnection': `/F${path.join(this.root, 'base')}`, '--db-user': 'u', '--db-pwd': 'p' } }),
      'utf-8'
    );
  }

  async listen(): Promise<number> {
    const server = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.servers.push(server);
    return (server.address() as net.AddressInfo).port;
  }

  async freePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }
}

suite('Агент Э4: releaseAgentInfoBaseForBatch', () => {
  const h = new Harness();
  setup(() => h.setup('v8-e4-release-'));
  teardown(() => h.teardown());

  test('сервис закэширован и подключён: disconnect-ib, состояние сброшено', async () => {
    const seeded = await seedCachedAgentService(h.root, { connected: true });
    await releaseAgentInfoBaseForBatch(h.folder, h.channel);
    assert.deepStrictEqual(seeded.factory.log, [DISCONNECT]);
    assert.strictEqual(seeded.service.isInfoBaseConnected(), false);
  });

  test('сервис закэширован, но не подключён: команд нет', async () => {
    const seeded = await seedCachedAgentService(h.root, { connected: false });
    await releaseAgentInfoBaseForBatch(h.folder, h.channel);
    assert.deepStrictEqual(seeded.factory.log, []);
    assert.strictEqual(seeded.factory.createCount, 0);
  });

  test('закэширован: ошибка disconnect пробрасывается (пакетная операция не стартует)', async () => {
    await seedCachedAgentService(h.root, {
      connected: true,
      behavior: (command) => command === DISCONNECT ? new Error('канал мёртв') : undefined,
    });
    await assert.rejects(releaseAgentInfoBaseForBatch(h.folder, h.channel), /канал мёртв/);
  });

  test('не закэширован, режим batch (умолчание): ничего не делает, запись в кэш не попадает', async () => {
    h.writeEnv();
    await setConfig('v8vscedit.agent', 'port', await h.listen());
    let created = 0;
    await releaseAgentInfoBaseForBatch(h.folder, h.channel, {
      createEntry: () => { created += 1; throw new Error('не должно вызываться'); },
    });
    assert.strictEqual(created, 0);
    assert.strictEqual(getCachedAgentOperationService(h.folder), undefined);
  });

  test('не закэширован, режим agent, порт агента закрыт: ничего не создаётся, не бросает', async () => {
    h.writeEnv();
    await setConfig('v8vscedit.configuration', 'operationMode', 'agent');
    await setConfig('v8vscedit.agent', 'port', await h.freePort());
    let created = 0;
    await releaseAgentInfoBaseForBatch(h.folder, h.channel, {
      createEntry: () => { created += 1; throw new Error('не должно вызываться'); },
    });
    assert.strictEqual(created, 0);
    assert.strictEqual(getCachedAgentOperationService(h.folder), undefined);
  });

  test('не закэширован, режим agent, внешний агент слушает порт: запись создаётся, кэшируется, disconnect-ib с force', async () => {
    h.writeEnv();
    await setConfig('v8vscedit.configuration', 'operationMode', 'agent');
    const port = await h.listen();
    await setConfig('v8vscedit.agent', 'port', port);
    const seen: { root: string; port: number }[] = [];
    const seeded = await makeAgentEntry(h.root, { connected: false });

    await releaseAgentInfoBaseForBatch(h.folder, h.channel, {
      createEntry: (root, settings) => { seen.push({ root, port: settings.port }); return seeded.entry; },
    });

    // Корень — как его отдаёт VS Code (Uri.fsPath, буква диска в нижнем регистре на Windows).
    assert.deepStrictEqual(seen, [{ root: h.folder.uri.fsPath, port }]);
    // Состояние «подключено» неизвестно после перезапуска VS Code — отключаем принудительно.
    assert.deepStrictEqual(seeded.factory.log, [DISCONNECT]);
    assert.strictEqual(getCachedAgentOperationService(h.folder), seeded.service);
    assert.ok(h.lines.some((l) => l.includes(`127.0.0.1:${String(port)}`)));
  });

  test('параллельные release создают запись один раз', async () => {
    h.writeEnv();
    await setConfig('v8vscedit.configuration', 'operationMode', 'agent');
    await setConfig('v8vscedit.agent', 'port', await h.listen());
    const seeded = await makeAgentEntry(h.root, { connected: false });
    let created = 0;
    const deps = { createEntry: () => { created += 1; return seeded.entry; } };
    await Promise.all([
      releaseAgentInfoBaseForBatch(h.folder, h.channel, deps),
      releaseAgentInfoBaseForBatch(h.folder, h.channel, deps),
      releaseAgentInfoBaseForBatch(h.folder, h.channel, deps),
    ]);
    assert.strictEqual(created, 1);
  });

  test('режим agent, порт открыт, но env.json нет: не бросает, предупреждение в журнале', async () => {
    await setConfig('v8vscedit.configuration', 'operationMode', 'agent');
    await setConfig('v8vscedit.agent', 'port', await h.listen());
    await releaseAgentInfoBaseForBatch(h.folder, h.channel);
    assert.ok(h.lines.some((l) => l.includes('[agent][warn]')));
    assert.strictEqual(getCachedAgentOperationService(h.folder), undefined);
  });
});

suite('Агент Э4: runInternalCliCommand освобождает базу перед спавном', function () {
  this.timeout(60_000);
  const h = new Harness();
  setup(() => h.setup('v8-e4-cli-'));
  teardown(() => h.teardown());

  const cliOptions = (overrides: Record<string, unknown> = {}) => ({
    cliArgs: ['e4-unknown-command'],
    progressTitle: 'Тест Э4',
    progressStartMessage: 'старт',
    successMessage: 'ok',
    errorTitle: 'Ошибка Э4',
    logPrefix: 'e4-test',
    ...overrides,
  });

  test('подключённая база отпускается ДО запуска процесса CLI', async () => {
    const events: string[] = [];
    h.channel = { appendLine: (line: string) => { events.push(line); } } as unknown as vscode.OutputChannel;
    await seedCachedAgentService(h.root, {
      connected: true,
      behavior: (command) => { if (command === DISCONNECT) { events.push('<disconnect-ib>'); } return undefined; },
    });

    await runInternalCliCommand(cliOptions(), h.folder, h.channel);

    const disconnectAt = events.indexOf('<disconnect-ib>');
    assert.ok(disconnectAt >= 0, 'disconnect-ib не отправлен');
    const processAt = events.findIndex((e) => e.startsWith('[e4-test]') || e.startsWith('[actions][error]') || e.startsWith('[actions] Завершено'));
    assert.ok(processAt > disconnectAt, `вывод процесса/итог (${String(processAt)}) раньше disconnect-ib (${String(disconnectAt)})`);
  });

  test('сбой release: CLI не запускается, результат false, причина уходит в onFailureReason', async () => {
    await seedCachedAgentService(h.root, {
      connected: true,
      behavior: (command) => command === DISCONNECT ? agentError('UnknownError', 'агент не отвечает') : undefined,
    });
    const reasons: string[] = [];
    const result = await runInternalCliCommand(cliOptions({ onFailureReason: (r: string) => reasons.push(r) }), h.folder, h.channel);
    assert.strictEqual(result, false);
    assert.ok(reasons.some((r) => r.includes('агент не отвечает')), reasons.join('|'));
    assert.ok(!h.lines.some((l) => l.startsWith('[e4-test]')), 'процесс CLI не должен был стартовать');
    assert.ok(!h.lines.some((l) => l.startsWith('[actions] Завершено')));
  });

  test('без агента (batch, кэш пуст): release — пустая операция, CLI запускается как раньше', async () => {
    const result = await runInternalCliCommand(cliOptions(), h.folder, h.channel);
    assert.strictEqual(result, false, 'неизвестная команда CLI завершается ошибкой');
    assert.ok(h.lines.some((l) => l.startsWith('[actions] Старт')));
    assert.ok(h.lines.some((l) => l.startsWith('[e4-test]') || l.startsWith('[actions][error]')));
  });

  test('подключённая база, но CLI упал: release всё равно был выполнен ровно один раз', async () => {
    const seeded = await seedCachedAgentService(h.root, { connected: true });
    await runInternalCliCommand(cliOptions(), h.folder, h.channel);
    assert.strictEqual(seeded.factory.count(DISCONNECT), 1);
    // Переподключение ленивое — после пакетной операции connect-ib не шлётся.
    assert.strictEqual(seeded.factory.count(CONNECT), 0);
  });
});

suite('Агент Э4: DbRunCommandRunner не отключает агента посреди операции', () => {
  const h = new Harness();
  setup(() => h.setup('v8-e4-dbrun-'));
  teardown(async () => {
    await endConfigurationOperation();
    await h.teardown();
  });

  const secrets = {} as unknown as ProjectSecretStorage;

  test('DESIGNER + режим agent + идёт операция: отказ с сообщением, агент не тронут, запуск не начат', async () => {
    await setConfig('v8vscedit.configuration', 'operationMode', 'agent');
    const seeded = await seedCachedAgentService(h.root, { connected: true });
    assert.strictEqual(await tryBeginConfigurationOperation(), true);

    await runDbClientFromWorkspace(h.folder, h.channel, secrets, { mode: 'DESIGNER' });

    const shown = [...h.infos, ...h.warnings];
    assert.ok(shown.some((m) => m.includes('уже выполняется')), `ожидалось сообщение про выполняющуюся операцию: ${shown.join('|')}`);
    assert.deepStrictEqual(seeded.factory.log, [], 'агент не должен получать команд');
    assert.strictEqual(seeded.service.isInfoBaseConnected(), true);
    assert.deepStrictEqual(h.errors, [], 'запуск не должен был начинаться (иначе была бы ошибка env.json)');
  });

  test('контроль: замок свободен — запуск начинается (ошибка об отсутствии env.json, а не отказ)', async () => {
    await setConfig('v8vscedit.configuration', 'operationMode', 'agent');
    await runDbClientFromWorkspace(h.folder, h.channel, secrets, { mode: 'DESIGNER' });
    assert.ok(h.errors.some((m) => m.includes('Не удалось запустить 1С')));
    assert.ok(![...h.infos, ...h.warnings].some((m) => m.includes('уже выполняется')));
  });

  test('ENTERPRISE при идущей операции не отказывается (агент не затрагивается)', async () => {
    await setConfig('v8vscedit.configuration', 'operationMode', 'agent');
    assert.strictEqual(await tryBeginConfigurationOperation(), true);
    await runDbClientFromWorkspace(h.folder, h.channel, secrets, { mode: 'ENTERPRISE' });
    assert.ok(h.errors.some((m) => m.includes('Не удалось запустить 1С')));
    assert.ok(![...h.infos, ...h.warnings].some((m) => m.includes('уже выполняется')));
  });

  // Платформа 1С недоступна: исполняемый файл — пустая заглушка, запуск процесса подменён
  // штатным швом `spawnClient`; агент — фейковый транспорт, реестр сервисов — настоящий.
  class FakeClientProcess implements InteractiveDesignerProcess {
    private exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
    once(event: 'error', listener: (error: Error) => void): this;
    once(event: 'exit' | 'error', listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)): this {
      if (event === 'exit') {
        this.exitListener = listener as (code: number | null, signal: NodeJS.Signals | null) => void;
      }
      return this;
    }
    exit(): void {
      this.exitListener?.(0, null);
    }
  }

  function writeLaunchableEnv(): string {
    const v8Path = path.join(h.root, process.platform === 'win32' ? '1cv8.exe' : '1cv8');
    fs.writeFileSync(v8Path, '');
    fs.writeFileSync(
      path.join(h.root, 'env.json'),
      JSON.stringify({ default: { '--ibconnection': `/F${path.join(h.root, 'base')}`, '--path': v8Path } }),
      'utf-8'
    );
    return v8Path;
  }

  const launchSecrets = { getDbPassword: () => Promise.resolve(undefined) } as unknown as ProjectSecretStorage;

  test('DESIGNER + режим agent, замок свободен: база отпускается у агента ДО запуска Конфигуратора', async () => {
    await setConfig('v8vscedit.configuration', 'operationMode', 'agent');
    const v8Path = writeLaunchableEnv();
    const events: string[] = [];
    const seeded = await seedCachedAgentService(h.root, {
      connected: true,
      behavior: (command) => { events.push(`agent:${command}`); return undefined; },
    });
    events.length = 0;
    const client = new FakeClientProcess();

    await runDbClientFromWorkspace(h.folder, h.channel, launchSecrets, { mode: 'DESIGNER' }, {
      spawnClient: (command, args) => { events.push(`spawn:${command}:${args[0]}`); return client; },
    });

    assert.deepStrictEqual(events, [`agent:${DISCONNECT}`, `spawn:${v8Path}:DESIGNER`]);
    assert.strictEqual(seeded.service.isInfoBaseConnected(), false);
    assert.deepStrictEqual(h.errors, []);
    assert.ok(h.infos.some((m) => m.includes('Запущен конфигуратор')));

    // После закрытия Конфигуратора база возвращается агенту (поведение лаунчера сохранено).
    client.exit();
    await seeded.service.reconnectInfoBase();
    assert.strictEqual(seeded.factory.count(CONNECT), 1);
    assert.strictEqual(seeded.service.isInfoBaseConnected(), true);
  });

  test('DESIGNER в пакетном режиме: агент не трогается, Конфигуратор запускается', async () => {
    const v8Path = writeLaunchableEnv();
    const seeded = await seedCachedAgentService(h.root, { connected: true });
    const spawned: string[] = [];
    await runDbClientFromWorkspace(h.folder, h.channel, launchSecrets, { mode: 'DESIGNER' }, {
      spawnClient: (command) => { spawned.push(command); return new FakeClientProcess(); },
    });
    assert.deepStrictEqual(spawned, [v8Path]);
    assert.deepStrictEqual(seeded.factory.log, []);
    assert.strictEqual(seeded.service.isInfoBaseConnected(), true);
  });
});

suite('Агент Э4: команда v8vscedit.agent.releaseInfoBase', () => {
  const COMMAND = 'v8vscedit.agent.releaseInfoBase';
  const h = new Harness();
  const commandsRef = vscode.commands as unknown as { registerCommand: unknown };
  let handler: (() => Promise<void>) | undefined;
  let originalRegister: unknown;

  setup(async () => {
    await h.setup('v8-e4-cmd-');
    originalRegister = commandsRef.registerCommand;
    const handlers = new Map<string, () => Promise<void>>();
    commandsRef.registerCommand = (id: string, callback: () => Promise<void>) => {
      handlers.set(id, callback);
      return { dispose: () => undefined };
    };
    try {
      registerCommands(
        { subscriptions: [] } as unknown as vscode.ExtensionContext,
        { workspaceFolder: h.folder, outputChannel: h.channel } as unknown as CommandServices
      );
    } finally {
      commandsRef.registerCommand = originalRegister;
    }
    handler = handlers.get(COMMAND);
  });
  teardown(async () => {
    await endConfigurationOperation();
    await h.teardown();
  });

  function run(): Promise<void> {
    assert.ok(handler, `${COMMAND} не зарегистрирована в CommandRegistry.registerCommands`);
    return handler();
  }

  test('package.json: команда объявлена, title на русском', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
      contributes: { commands: { command: string; title?: string }[] };
    };
    const entry = manifest.contributes.commands.find((c) => c.command === COMMAND);
    assert.ok(entry, `${COMMAND} не объявлена в contributes.commands`);
    assert.match(entry.title ?? '', /[А-Яа-яЁё]/);
  });

  test('команда подключена в CommandRegistry (обработчик зарегистрирован)', () => {
    assert.ok(handler);
  });

  test('подключённая база отключается; пользователь получает сообщение об отключении', async () => {
    const seeded = await seedCachedAgentService(h.root, { connected: true });
    await run();
    assert.deepStrictEqual(seeded.factory.log, [DISCONNECT]);
    assert.strictEqual(seeded.service.isInfoBaseConnected(), false);
    assert.ok(h.infos.some((m) => /отключ/i.test(m)), h.infos.join('|'));
  });

  test('идёт операция с конфигурацией: отказ с сообщением, агент не трогается', async () => {
    const seeded = await seedCachedAgentService(h.root, { connected: true });
    assert.strictEqual(await tryBeginConfigurationOperation(), true);
    await run();
    assert.deepStrictEqual(seeded.factory.log, []);
    assert.ok([...h.infos, ...h.warnings].some((m) => m.includes('уже выполняется')));
  });

  test('агента нет (кэш пуст, режим batch): информирует и не бросает', async () => {
    await run();
    assert.strictEqual(h.infos.length + h.warnings.length >= 1, true);
    assert.deepStrictEqual(h.errors, []);
  });

  test('сбой отключения: сообщение об ошибке с причиной, команда не бросает', async () => {
    await seedCachedAgentService(h.root, {
      connected: true,
      behavior: (command) => command === DISCONNECT ? new Error('канал мёртв') : undefined,
    });
    await run();
    assert.ok(h.errors.some((m) => m.includes('канал мёртв')), h.errors.join('|'));
  });
});
