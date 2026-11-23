/**
 * Э9: команды хранилища конфигурации при `v8vscedit.agent.location = "remote"` идут через УДАЛЁННЫЙ исполнитель.
 *
 * Контракт:
 *  - `RepositoryCliServices` и `CommandServices` получают необязательное поле `designerExecutorDeps?: DesignerExecutorDeps`
 *    (шов под тест: подмена хоста PowerShell; в продукте не задаётся); `RegistryHost` — см. designerExecutorRegistry.test.ts.
 *  - `runRepositoryCliCommand` БЕЗ `createDesignerExecutor`: исполнитель и путь к 1cv8 берёт `acquireDesignerBatchExecutor(...)`
 *    (local — как раньше, remote — RemoteDesignerBatchExecutor поверх закэшированного хоста). Локальный `resolveV8ExecutablePath`
 *    в remote НЕ вызывается (на машине пользователя платформы может не быть); `--ibconnection` заменяется
 *    `lease.ibConnectionOverride` (v8vscedit.remote.ibConnection). С `createDesignerExecutor` — прежний (приоритетный) путь.
 *  - Ошибки конфигурации удалённого режима (remote при operationMode≠agent, нет remote.user, нет пароля) бросаются раннером ДО
 *    начала операции (как ошибки env.json): статус-бар не включается, хост не создаётся.
 *  - Перед запуском на сервере база отпускается у агента (releaseAgentInfoBaseForBatch) — как в локальном режиме.
 *  - `dump`/`report`: выходной файл забирается с сервера в локальный staging и переносится на выбранный путь ТОЛЬКО при коде 0;
 *    при ненулевом коде или если процесс файл не создал — целевой файл не появляется.
 *  - Хост общий: после операции исполнитель освобождается (staging убран), хост не закрывается; сервер убран (rmtemp).
 *  - В журнал/сообщения не попадают пароли БД, хранилища и PSSession (командная строка в журнале маскируется ЗНАЧЕНИЯМИ).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { OnecStarterExecutableError } from '../../infra/process/V8ExecutableGuard';
import type { HostRunRequest, HostRunResult } from '../../infra/process/remote/PowerShellRemoteHost';
import { RepositoryService, type RepositoryNodeRef } from '../../infra/repository/RepositoryService';
import type { CommandServices } from '../../ui/commands/_shared';
import { disposeCachedAgentOperationServices } from '../../ui/commands/ext/agent/AgentServiceRegistry';
import {
  disposeCachedDesignerExecutors,
  type DesignerExecutorDeps,
  type RegistryHost,
} from '../../ui/commands/ext/designerExecutorRegistry';
import { endConfigurationOperation } from '../../ui/commands/ext/configurationOperationLock';
import {
  disposeRepositoryCommandStatusBar,
  resolveRepositoryTarget,
  runRepositoryCliCommand,
  runRepositoryLockAction,
  type RepositoryCliServices,
} from '../../ui/commands/repository/RepositoryCommandRunner';
import { registerRepositoryCommands } from '../../ui/commands/repository/RepositoryCommands';
import { agentError } from './support/agentInfoBaseFakes';
import { seedCachedAgentService } from './support/agentRegistrySeed';
import { resetAgentSettings, setAgentSetting } from './support/agentRemoteHarness';
import { resetRemoteSettings, setRemoteSetting } from './support/remoteDesignerSettings';

const DB_PASSWORD = 'db-secret-пароль';
const REPO_PASSWORD = 'repo-secret-пароль';
const PS_PASSWORD = 'ps-secret-пароль';
const SERVER_V8 = 'C:\\1c\\1cv8.exe';
const SERVER_DIR = 'C:\\Temp\\v8vscedit-e9';

function fakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

const CONFIGURATION_XML =
  '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Configuration uuid="11111111-1111-1111-1111-111111111111"><Properties><Name>Основная</Name></Properties></Configuration></MetaDataObject>';
const CATALOG_XML =
  '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Catalog uuid="33333333-3333-3333-3333-333333333333"><Properties><Name>Товары</Name></Properties></Catalog></MetaDataObject>';

/** Хост «сервера»: записывает обращения, `fetch` отдаёт файлы из `serverFiles`. */
class ServerHost implements RegistryHost {
  readonly calls: { op: string; args: unknown[] }[] = [];
  readonly serverFiles = new Map<string, Uint8Array>();
  runResult: HostRunResult = { exitCode: 0, interrupted: false, logBytes: Buffer.alloc(0), pid: 1 };
  disposed = 0;
  onRun?: (request: HostRunRequest) => void;

  ops(): string[] { return this.calls.map((call) => call.op); }
  runRequest(): HostRunRequest {
    const call = this.calls.find((item) => item.op === 'run');
    assert.ok(call, 'run не вызывался');
    return call.args[0] as HostRunRequest;
  }

  ping(): Promise<{ pid: number }> { return Promise.resolve({ pid: 1 }); }
  mktemp(): Promise<string> { this.calls.push({ op: 'mktemp', args: [] }); return Promise.resolve(SERVER_DIR); }
  put(dir: string, name: string, content: Uint8Array | string): Promise<void> {
    this.calls.push({ op: 'put', args: [dir, name, content] });
    return Promise.resolve();
  }
  run(request: HostRunRequest): Promise<HostRunResult> {
    this.calls.push({ op: 'run', args: [request] });
    this.onRun?.(request);
    return Promise.resolve(this.runResult);
  }
  fetch(remotePath: string, localPath: string): Promise<boolean> {
    this.calls.push({ op: 'fetch', args: [remotePath, localPath] });
    const bytes = this.serverFiles.get(remotePath);
    if (!bytes) {
      return Promise.resolve(false);
    }
    fs.writeFileSync(localPath, bytes);
    return Promise.resolve(true);
  }
  rmtemp(dir: string): Promise<void> { this.calls.push({ op: 'rmtemp', args: [dir] }); return Promise.resolve(); }
  resolveV8(target: { v8Path?: string; v8Version?: string }): Promise<string | undefined> {
    return Promise.resolve(target.v8Path === SERVER_V8 ? SERVER_V8 : undefined);
  }
  dispose(): Promise<void> { this.disposed += 1; return Promise.resolve(); }
}

suite('Э9: хранилище конфигурации в удалённом режиме — через удалённый исполнитель', function () {
  this.timeout(60_000);
  type WindowRef = Record<string, unknown>;
  const windowRef = vscode.window as unknown as WindowRef;
  const commandsRef = vscode.commands as unknown as { registerCommand: unknown };
  const saved: Record<string, unknown> = {};

  let root: string;
  let service: RepositoryService;
  let secrets: ProjectSecretStorage;
  let services: RepositoryCliServices;
  let host: ServerHost;
  let hostsCreated: number;
  let prompts: number;
  let promptAnswer: string | undefined;
  let lines: string[];
  let errors: string[];
  let infos: string[];
  let catalogNode: RepositoryNodeRef;
  let target: NonNullable<ReturnType<typeof resolveRepositoryTarget>>;

  const deps = (): DesignerExecutorDeps => ({
    createHost: () => { hostsCreated += 1; return host; },
    promptRemotePassword: () => { prompts += 1; return Promise.resolve(promptAnswer); },
  });

  function writeEnv(extra: Record<string, unknown> = {}): void {
    fs.writeFileSync(path.join(root, 'env.json'), JSON.stringify({
      default: {
        '--ibconnection': `/F${path.join(root, 'base')}`,
        '--db-user': 'dbuser',
        '--db-pwd': DB_PASSWORD,
        // Локальной платформы нет: в remote путь обязан браться с сервера, а не из этой настройки.
        '--path': 'D:\\только-локально\\нет-такого\\1cv8.exe',
        '--repo-path': 'C:\\repo-storage',
        '--repo-user': 'repo-user',
        ...extra,
      },
    }), 'utf-8');
  }

  async function configureRemote(): Promise<void> {
    await setAgentSetting('location', 'remote');
    await setAgentSetting('host', 'srv-1c.corp');
    await vscode.workspace.getConfiguration('v8vscedit.configuration').update('operationMode', 'agent', vscode.ConfigurationTarget.Global);
    await setRemoteSetting('user', 'CORP\\svc');
    await setRemoteSetting('v8Path', SERVER_V8);
    await secrets.setRemotePassword(PS_PASSWORD);
  }

  setup(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-e9-repo-')));
    const cfRoot = path.join(root, 'src', 'cf');
    fs.mkdirSync(path.join(cfRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(cfRoot, 'Configuration.xml'), CONFIGURATION_XML);
    const catalogPath = path.join(cfRoot, 'Catalogs', 'Товары.xml');
    fs.writeFileSync(catalogPath, CATALOG_XML);
    catalogNode = { nodeKind: 'Catalog', label: 'Товары', xmlPath: catalogPath };

    secrets = new ProjectSecretStorage(fakeSecretStore(), root);
    service = new RepositoryService(root, secrets);
    const resolved = resolveRepositoryTarget(service, catalogNode);
    assert.ok(resolved);
    target = resolved;
    await service.saveBinding(target, { repoPath: 'C:\\repo-storage', repoUser: 'repo-user', repoPassword: REPO_PASSWORD });
    writeEnv();

    host = new ServerHost();
    hostsCreated = 0;
    prompts = 0;
    promptAnswer = PS_PASSWORD;
    lines = [];
    errors = [];
    infos = [];
    for (const key of ['showErrorMessage', 'showInformationMessage']) {
      saved[key] = windowRef[key];
    }
    windowRef.showErrorMessage = (message: string) => { errors.push(message); return Promise.resolve(undefined); };
    windowRef.showInformationMessage = (message: string) => { infos.push(message); return Promise.resolve(undefined); };

    await disposeCachedAgentOperationServices();
    await disposeCachedDesignerExecutors();
    await resetAgentSettings();
    await resetRemoteSettings();
    await configureRemote();

    services = {
      workspaceFolder: { uri: vscode.Uri.file(root), name: 'e9-repo', index: 0 },
      outputChannel: { appendLine: (line: string) => { lines.push(line); } } as unknown as vscode.OutputChannel,
      repositoryService: service,
      projectSecretStorage: secrets,
      designerExecutorDeps: deps(),
    };
  });

  teardown(async () => {
    for (const key of Object.keys(saved)) {
      windowRef[key] = saved[key];
    }
    await endConfigurationOperation();
    await disposeCachedAgentOperationServices();
    await disposeCachedDesignerExecutors();
    await resetAgentSettings();
    await resetRemoteSettings();
    await vscode.workspace.getConfiguration('v8vscedit.configuration').update('operationMode', undefined, vscode.ConfigurationTarget.Global);
    disposeRepositoryCommandStatusBar();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const runOptions = (overrides: Partial<Parameters<typeof runRepositoryCliCommand>[0]> = {}): Parameters<typeof runRepositoryCliCommand>[0] => ({
    operation: { kind: 'unbind' },
    target,
    progressTitle: 'Тест',
    progressStartMessage: 'старт',
    successMessage: 'Готово',
    errorTitle: 'Ошибка теста',
    ...overrides,
  });

  suite('запуск на сервере', () => {
    test('захват: объекты уходят на сервер входным файлом, 1cv8 — по пути сервера, отметка о захвате поставлена', async () => {
      assert.deepStrictEqual(await runRepositoryLockAction(services, catalogNode, false, { revised: false }), { lockedFullNames: ['Справочник.Товары'], receivedFromRepository: true, lockedByOthers: [] });

      assert.deepStrictEqual(host.ops(), ['mktemp', 'put', 'run', 'rmtemp']);
      const put = host.calls[1].args;
      assert.deepStrictEqual([put[0], put[1]], [SERVER_DIR, 'objects.xml']);
      assert.ok(String(put[2]).includes('Справочник.Товары'));
      const run = host.runRequest();
      assert.strictEqual(run.exe, SERVER_V8);
      assert.match(run.commandLine, /\/ConfigurationRepositoryLock/);
      assert.ok(run.commandLine.includes(`${SERVER_DIR}\\objects.xml`));
      assert.strictEqual(run.logPath, `${SERVER_DIR}\\out.log`);
      assert.strictEqual(service.isLocked(target, 'Справочник.Товары'), true);
      assert.deepStrictEqual(errors, []);
    });

    test('локальный путь к 1cv8 из env.json (--path) в remote не используется и не проверяется', async () => {
      assert.strictEqual(await runRepositoryCliCommand(runOptions(), services), true);
      assert.strictEqual(host.runRequest().exe, SERVER_V8);
    });

    test('remote.ibConnection заменяет --ibconnection из env.json: сервер получает серверную базу, а не локальный путь', async () => {
      await setRemoteSetting('ibConnection', '/Ssrv-1c/prod');
      await runRepositoryCliCommand(runOptions(), services);
      const commandLine = host.runRequest().commandLine;
      assert.match(commandLine, /\/S srv-1c\/prod|\/S "srv-1c\/prod"/);
      assert.ok(!commandLine.includes(path.join(root, 'base')), 'локальный путь базы не должен уйти на сервер');
    });

    test('без remote.ibConnection вектор подключения берётся из env.json как есть', async () => {
      writeEnv({ '--ibconnection': '/Ssrv-1c/from-env' });
      await runRepositoryCliCommand(runOptions(), services);
      assert.match(host.runRequest().commandLine, /\/S srv-1c\/from-env/);
    });

    test('база отпускается у агента ДО запуска на сервере', async () => {
      const events: string[] = [];
      host.onRun = () => { events.push('<run>'); };
      await seedCachedAgentService(root, {
        connected: true,
        behavior: (command) => { events.push(`agent:${command}`); return undefined; },
      });
      events.length = 0;
      await runRepositoryCliCommand(runOptions(), services);
      assert.deepStrictEqual(events, ['agent:common disconnect-ib', '<run>']);
    });

    test('сбой отключения базы у агента: операция отказывает, на сервер ничего не уходит', async () => {
      await seedCachedAgentService(root, {
        connected: true,
        behavior: (command) => command === 'common disconnect-ib' ? agentError('UnknownError', 'агент не отвечает') : undefined,
      });
      assert.strictEqual(await runRepositoryCliCommand(runOptions(), services), false);
      assert.deepStrictEqual(host.ops(), []);
      assert.ok(errors.some((message) => message.includes('агент не отвечает')), errors.join('|'));
    });

    test('хост общий: после операции не закрыт, повторная операция берёт тот же, сервер каждый раз убран', async () => {
      await runRepositoryCliCommand(runOptions(), services);
      await runRepositoryCliCommand(runOptions(), services);
      assert.strictEqual(hostsCreated, 1);
      assert.strictEqual(host.disposed, 0);
      assert.deepStrictEqual(host.ops().filter((op) => op === 'rmtemp').length, 2);
    });

    test('ненулевой код: операция отказывает с причиной из лога, сервер убран', async () => {
      host.runResult = {
        exitCode: 1, interrupted: false, pid: 1,
        logBytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Объект захвачен другим пользователем', 'utf16le')]),
      };
      assert.strictEqual(await runRepositoryCliCommand(runOptions(), services), false);
      assert.ok(errors.some((message) => message.includes('Объект захвачен другим пользователем')), errors.join('|'));
      assert.strictEqual(host.ops().at(-1), 'rmtemp');
    });

    test('приоритетный шов createDesignerExecutor работает и в remote: хост не создаётся', async () => {
      let created = 0;
      const seam: RepositoryCliServices = {
        ...services,
        createDesignerExecutor: () => {
          created += 1;
          return { run: () => Promise.resolve({ exitCode: 0, log: '', outputs: new Map() }), dispose: () => Promise.resolve() };
        },
      };
      // шов получает путь, вычисленный локально: для него нужен существующий файл
      const fakeExe = path.join(root, process.platform === 'win32' ? '1cv8.exe' : '1cv8');
      fs.writeFileSync(fakeExe, '');
      writeEnv({ '--path': fakeExe });
      assert.strictEqual(await runRepositoryCliCommand(runOptions(), seam), true);
      assert.strictEqual(created, 1);
      assert.strictEqual(hostsCreated, 0);
    });
  });

  suite('ошибки конфигурации удалённого режима — ДО начала операции', () => {
    test('remote при operationMode=batch: исключение про v8vscedit.agent.location, хост не создан', async () => {
      await vscode.workspace.getConfiguration('v8vscedit.configuration').update('operationMode', 'batch', vscode.ConfigurationTarget.Global);
      await assert.rejects(() => runRepositoryCliCommand(runOptions(), services), /v8vscedit\.agent\.location/);
      assert.strictEqual(hostsCreated, 0);
      assert.deepStrictEqual(host.ops(), []);
    });

    test('нет remote.user: исключение про v8vscedit.remote.user', async () => {
      await setRemoteSetting('user', '');
      await assert.rejects(() => runRepositoryCliCommand(runOptions(), services), /v8vscedit\.remote\.user/);
      assert.strictEqual(hostsCreated, 0);
    });

    test('нет пароля и пользователь отказался его ввести: исключение про пароль, хост не создан', async () => {
      await secrets.setRemotePassword('');
      promptAnswer = undefined;
      await assert.rejects(() => runRepositoryCliCommand(runOptions(), services), /парол/i);
      assert.strictEqual(hostsCreated, 0);
      assert.strictEqual(prompts, 1);
    });

    test('1cv8 по remote.v8Path нет на сервере: исключение называет путь', async () => {
      await setRemoteSetting('v8Path', 'C:\\нет\\1cv8.exe');
      await assert.rejects(() => runRepositoryCliCommand(runOptions(), services), /C:\\нет\\1cv8\.exe/);
    });

    for (const starter of ['C:\\Program Files\\1cv8\\common\\1cestart.exe', 'C:/Program Files/1cv8/common/1CEStart.EXE']) {
      test(`remote.v8Path = стартер (${starter}): отказ до статуса и до запуска на сервере`, async () => {
        await setRemoteSetting('v8Path', starter);
        let statusBars = 0;
        const original = windowRef.createStatusBarItem;
        windowRef.createStatusBarItem = (...args: unknown[]) => {
          statusBars += 1;
          return (original as (...a: unknown[]) => unknown)(...args);
        };
        try {
          await assert.rejects(() => runRepositoryCliCommand(runOptions(), services), OnecStarterExecutableError);
        } finally {
          windowRef.createStatusBarItem = original;
        }
        assert.strictEqual(statusBars, 0, 'статус операции не должен включаться');
        assert.deepStrictEqual(host.ops(), [], 'на сервер ничего не уходит');
      });
    }
  });

  suite('выходные файлы dump/report (staging)', () => {
    const DUMP = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x80]);

    test('код 0: файл забирается с сервера и переносится на целевой путь', async () => {
      host.serverFiles.set(`${SERVER_DIR}\\dump.cf`, DUMP);
      const targetPath = path.join(root, 'выгрузка.cf');
      const ok = await runRepositoryCliCommand(
        runOptions({ operation: { kind: 'dump' }, output: { name: 'dump.cf', targetPath } }),
        services
      );
      assert.strictEqual(ok, true);
      assert.ok(fs.readFileSync(targetPath).equals(Buffer.from(DUMP)));
      assert.ok(host.runRequest().commandLine.includes(`${SERVER_DIR}\\dump.cf`));
    });

    test('ненулевой код: целевой файл не создаётся, даже если сервер успел оставить частичный', async () => {
      host.serverFiles.set(`${SERVER_DIR}\\dump.cf`, DUMP);
      host.runResult = { exitCode: 1, interrupted: false, logBytes: Buffer.from('ошибка', 'utf-8'), pid: 1 };
      const targetPath = path.join(root, 'не-должен-появиться.cf');
      const ok = await runRepositoryCliCommand(
        runOptions({ operation: { kind: 'dump' }, output: { name: 'dump.cf', targetPath } }),
        services
      );
      assert.strictEqual(ok, false);
      assert.strictEqual(fs.existsSync(targetPath), false);
    });

    test('код 0, но платформа файл не создала: ошибка, целевой файл не появляется', async () => {
      const targetPath = path.join(root, 'пусто.cf');
      const ok = await runRepositoryCliCommand(
        runOptions({ operation: { kind: 'dump' }, output: { name: 'dump.cf', targetPath } }),
        services
      );
      assert.strictEqual(ok, false);
      assert.strictEqual(fs.existsSync(targetPath), false);
      assert.ok(errors.some((message) => message.includes('не создал выходной файл')), errors.join('|'));
    });

    test('существующий целевой файл при неудаче остаётся нетронутым', async () => {
      const targetPath = path.join(root, 'старый.cf');
      fs.writeFileSync(targetPath, 'старое содержимое');
      host.runResult = { exitCode: 2, interrupted: false, logBytes: Buffer.alloc(0), pid: 1 };
      await runRepositoryCliCommand(runOptions({ operation: { kind: 'dump' }, output: { name: 'dump.cf', targetPath } }), services);
      assert.strictEqual(fs.readFileSync(targetPath, 'utf-8'), 'старое содержимое');
    });
  });

  suite('секреты', () => {
    test('в журнале и сообщениях нет паролей БД, хранилища и PSSession (на сервер они уходят только в командной строке процесса)', async () => {
      await runRepositoryCliCommand(runOptions({ operation: { kind: 'unbind' } }), services);
      host.runResult = { exitCode: 1, interrupted: false, logBytes: Buffer.from('сбой', 'utf-8'), pid: 1 };
      await runRepositoryCliCommand(runOptions(), services);
      const shown = [...lines, ...errors, ...infos].join('\n');
      for (const secret of [DB_PASSWORD, REPO_PASSWORD, PS_PASSWORD]) {
        assert.ok(!shown.includes(secret), `секрет «${secret}» виден пользователю`);
      }
      assert.ok(host.runRequest().commandLine.includes(DB_PASSWORD), 'сервер пароль БД получает (иначе 1cv8 не войдёт в базу)');
    });
  });

  suite('обработчик команды v8vscedit.repository.dump (RepositoryCommands)', () => {
    test('шов designerExecutorDeps доходит до раннера: выгрузка идёт на сервере и переносится на выбранный путь', async () => {
      host.serverFiles.set(`${SERVER_DIR}\\dump.cf`, Uint8Array.from([1, 2, 3]));
      const targetPath = path.join(root, 'из-хранилища.cf');
      const handlers = new Map<string, (node?: unknown) => Promise<void>>();
      const w = vscode.window as unknown as Record<string, unknown>;
      const originalRegister = commandsRef.registerCommand;
      commandsRef.registerCommand = (id: string, callback: (node?: unknown) => Promise<void>) => {
        handlers.set(id, callback);
        return { dispose: () => undefined };
      };
      try {
        registerRepositoryCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
          workspaceFolder: services.workspaceFolder,
          outputChannel: services.outputChannel,
          repositoryService: service,
          projectSecretStorage: secrets,
          treeProvider: { refresh: () => undefined },
          refreshActionsView: () => undefined,
          getChangedConfigurations: () => Promise.resolve([]),
          designerExecutorDeps: deps(),
        } as unknown as CommandServices);
      } finally {
        commandsRef.registerCommand = originalRegister;
      }

      const originalSave = w.showSaveDialog;
      const originalInput = w.showInputBox;
      w.showSaveDialog = () => Promise.resolve(vscode.Uri.file(targetPath));
      w.showInputBox = () => Promise.resolve('');
      try {
        const handler = handlers.get('v8vscedit.repository.dump');
        assert.ok(handler, 'команда не зарегистрирована');
        await handler({ nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(root, 'src', 'cf', 'Configuration.xml') });
      } finally {
        w.showSaveDialog = originalSave;
        w.showInputBox = originalInput;
      }
      assert.strictEqual(hostsCreated, 1);
      assert.deepStrictEqual([...fs.readFileSync(targetPath)], [1, 2, 3]);
    });
  });
});
