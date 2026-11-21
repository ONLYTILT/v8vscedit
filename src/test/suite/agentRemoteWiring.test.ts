/**
 * Э8: проводка удалённого режима агента в реестр сервисов (UI-слой, Extension Host).
 *
 * Контракт (ui/commands/ext/agent/AgentServiceRegistry.ts, agentSettingsWatcher.ts):
 *  - `CachedAgentService` получает публичное поле `sync: { archiveThresholdFiles, transferConcurrency }`
 *    (из настроек, для обоих режимов); `AgentOperationService` принимает его пятым аргументом конструктора.
 *  - `createAgentOperationServiceEntry(workspaceRoot, settings, process?)` при `settings.location === 'remote'`:
 *      * `process` игнорируется (записи процесса нет, `agentStartedAt` не задан — политика Э3);
 *      * `files = { userName, sftp: transportOptions }` — БЕЗ `agentBaseDir`: корень SFTP уже персональный,
 *        agentbasedir.json на сервере не нужен (Н24);
 *      * `transportOptions.shutdownOnDispose === false`: закрытие SSH расширением не должно командой
 *        `common shutdown` гасить агент, который запущен пользователем на сервере;
 *    при `local` — прежнее (`files = { userName, agentBaseDir }`, shutdownOnDispose не `false`).
 *  - `startAgentOperationService` при remote: DesignerAgentProcess не создаётся, `autoStart` и ожидание порта
 *    пропускаются (повторы refused — дело политики подключения), каталог `.v8vscedit/agent` не создаётся.
 *  - Пароль SSH агента — пароль ИБ из SecretStorage (как у локального режима; отдельного SSH-пароля нет),
 *    пользователь — `v8vscedit.agent.user` либо `--db-user`; пароль не попадает в журнал и сообщения.
 *  - Любая запись реестра (в т.ч. найденная `releaseAgentInfoBaseForBatch`) строится по настройкам:
 *    в remote release работает так же, как в local.
 *  - `registerAgentSettingsWatcher(context, outputChannel)` + `affectsAgentServices(event)`: изменение
 *    `v8vscedit.agent.*`/`v8vscedit.remote.*` вызывает `disposeCachedAgentOperationServices()`.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { DesignerAgentProcess } from '../../infra/agent';
import { buildAgentProjectId } from '../../infra/agent/AgentWorkspaceService';
import {
  createAgentOperationServiceEntry,
  disposeCachedAgentOperationServices,
  getAgentOperationService,
  getCachedAgentOperationService,
  releaseAgentInfoBaseForBatch,
  startAgentOperationService,
} from '../../ui/commands/ext/agent/AgentServiceRegistry';
import { affectsAgentServices, registerAgentSettingsWatcher } from '../../ui/commands/ext/agent/agentSettingsWatcher';
import type { AgentCommandSettings } from '../../ui/commands/ext/agent/agentSettings';
import { STANDARD_DB, dbAsText } from './support/agentSyncHarness';
import {
  REMOTE_DB_PASSWORD,
  RemoteHarness,
  assertNoSecrets,
  setAgentSetting,
} from './support/agentRemoteHarness';

function settings(overrides: Partial<AgentCommandSettings> = {}): AgentCommandSettings {
  return {
    host: 'srv.example', listenAddress: '127.0.0.1', port: 1543, user: 'u', password: 'p', privateKeyPath: '',
    visible: false, autoStart: true, agentModeArgs: [], progressInterval: 0.5,
    startupTimeoutMs: 21000, authWarmupMs: 45000, connectTimeoutMs: 60000, idleDisconnectMinutes: 0,
    location: 'local', transferConcurrency: 16, archiveThresholdFiles: 300,
    ...overrides,
  };
}

function readTree(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(out, readTree(path.join(dir, entry.name), childRel));
    } else {
      out[childRel] = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
    }
  }
  return out;
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

suite('Агент Э8: createAgentOperationServiceEntry — режим записи реестра', () => {
  const tmpRoot = os.tmpdir();

  test('remote: процесс игнорируется, agentStartedAt не задан, SFTP-хранилище на тех же host/port/user, shutdown выключен', () => {
    const proc = new DesignerAgentProcess();
    proc.getStartedAt = () => 1_700_000_000_000;
    const entry = createAgentOperationServiceEntry(tmpRoot, settings({ location: 'remote', host: 'srv.example', port: 2222, user: 'adm' }), proc);
    assert.strictEqual(entry.process, undefined);
    assert.strictEqual(entry.transportOptions.agentStartedAt, undefined);
    assert.strictEqual(entry.transportOptions.shutdownOnDispose, false);
    assert.deepStrictEqual(entry.files, { userName: 'adm', sftp: entry.transportOptions });
    assert.strictEqual(entry.transportOptions.host, 'srv.example');
    assert.strictEqual(entry.transportOptions.port, 2222);
    assert.strictEqual(entry.transportOptions.password, 'p');
    assert.deepStrictEqual(entry.transportOptions.policy, { startupTimeoutMs: 21000, authWarmupMs: 45000, retryDelayMs: 1000 });
  });

  test('local: прежняя форма (agentBaseDir, без sftp), процесс и agentStartedAt сохраняются, shutdown не выключен', () => {
    const proc = new DesignerAgentProcess();
    proc.getStartedAt = () => 42;
    const entry = createAgentOperationServiceEntry(tmpRoot, settings({ location: 'local', user: 'adm' }), proc);
    assert.strictEqual(entry.process, proc);
    assert.strictEqual(entry.transportOptions.agentStartedAt, 42);
    assert.notStrictEqual(entry.transportOptions.shutdownOnDispose, false);
    assert.deepStrictEqual(entry.files, { userName: 'adm', agentBaseDir: path.join(tmpRoot, '.v8vscedit', 'agent') });
  });

  const syncTable: [AgentCommandSettings['location'], number, number][] = [
    ['local', 16, 300], ['local', 4, 7], ['remote', 16, 300], ['remote', 32, 1000],
  ];
  for (const [location, concurrency, threshold] of syncTable) {
    test(`sync из настроек (${location}, ${String(concurrency)}, ${String(threshold)})`, () => {
      const entry = createAgentOperationServiceEntry(
        tmpRoot,
        settings({ location, transferConcurrency: concurrency, archiveThresholdFiles: threshold })
      );
      assert.deepStrictEqual(entry.sync, { archiveThresholdFiles: threshold, transferConcurrency: concurrency });
    });
  }
});

suite('Агент Э8: удалённый агент через реестр (настоящие ssh2.Server и SFTP, эмулятор агента)', function () {
  this.timeout(120_000);
  const h = new RemoteHarness();
  const target = () => ({ kind: 'cf' as const, name: 'Основная', rootPath: h.cfRoot });

  setup(async () => { await h.start(); });
  teardown(async () => { await h.dispose(); });

  function seedDb(): void {
    for (const [fullName, files] of Object.entries(STANDARD_DB)) {
      h.emulator.setObject(fullName, files);
    }
  }

  const allShellLines = (): string[] => h.server.shellLog.flat();

  test('startAgentOperationService (remote, autoStart=true): процесс не стартует, каталог агента не создаётся, параметры из настроек и SecretStorage', async () => {
    const entry = await startAgentOperationService(h.root, h.cfRoot, h.channel);
    assert.strictEqual(entry.process, undefined);
    assert.strictEqual(entry.transportOptions.agentStartedAt, undefined);
    assert.strictEqual(entry.transportOptions.host, '127.0.0.1');
    assert.strictEqual(entry.transportOptions.port, h.server.port);
    assert.strictEqual(entry.transportOptions.user, 'ibuser');
    assert.strictEqual(entry.transportOptions.password, REMOTE_DB_PASSWORD);
    assert.strictEqual(entry.files.sftp, entry.transportOptions);
    assert.strictEqual(fs.existsSync(path.join(h.root, '.v8vscedit', 'agent')), false);
    assert.ok(!h.lines.some((line) => line.includes('Запуск конфигуратора')), h.lines.join('\n'));
    assert.strictEqual(h.server.passwordAttempts, 0, 'сам старт записи не должен подключаться');
    await entry.service.dispose();
  });

  test('agent.user из настроек перекрывает --db-user и для SFTP', async () => {
    await setAgentSetting('user', 'agentUser');
    const entry = await startAgentOperationService(h.root, h.cfRoot, h.channel);
    assert.strictEqual(entry.transportOptions.user, 'agentUser');
    assert.strictEqual(entry.files.userName, 'agentUser');
    await entry.service.dispose();
  });

  test('импорт: файлы приходят по SFTP в P, зеркало лежит в персональном корне, agentbasedir.json не нужен, пароль — из SecretStorage и нигде не светится', async () => {
    seedDb();
    const service = await getAgentOperationService(h.folder, h.cfRoot, h.channel);
    const result = await service.importFromDatabase(target());

    assert.deepStrictEqual(readTree(h.cfRoot), dbAsText(h.emulator.dbFiles()));
    assert.ok(result.changedProjectFiles.length > 0);
    assert.ok(h.server.sftp, 'SFTP-сторона эмулятора должна существовать');
    assert.ok(h.server.sftp.ops('OPEN').length > 0, 'передача файлов обязана идти по SFTP');
    assert.strictEqual(h.server.clientCount, 2, 'shell и SFTP — два разных SSH-соединения');
    assert.ok(fs.existsSync(path.join(h.userRoot, 'workspace', buildAgentProjectId(h.root), 'cf', 'Configuration.xml')));
    assert.strictEqual(fs.existsSync(path.join(h.userRoot, 'agentbasedir.json')), false);

    assert.ok(h.server.passwordsSeen.length >= 2, 'вход и по shell, и по SFTP');
    assert.ok(h.server.passwordsSeen.every((password) => password === REMOTE_DB_PASSWORD), h.server.passwordsSeen.join('|'));
    assertNoSecrets(h.everythingShown());
  });

  function seedProject(): void {
    for (const files of Object.values(STANDARD_DB)) {
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(h.cfRoot, ...rel.split('/'));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
    }
  }

  test('склонировал → правлю → обновляю БД (без импорта, Н47): полная архивом, затем частичная после одной выгрузки M', async () => {
    seedProject();
    const service = await getAgentOperationService(h.folder, h.cfRoot, h.channel);
    const mirrorDir = `workspace/${buildAgentProjectId(h.root)}/cf`;

    await service.loadFullAndUpdate(target());
    assert.strictEqual(h.emulator.loads.at(-1)?.mode, 'archive');
    const loadsAfterFull = h.emulator.loads.length;

    fs.writeFileSync(path.join(h.cfRoot, 'Catalogs', 'Клиенты.xml'), '<Catalog>Клиенты v2</Catalog>');
    await service.loadChanged(target(), { updateDatabase: true });

    assert.deepStrictEqual(h.emulator.loads.slice(loadsAfterFull).map((load) => load.mode), ['partial'], 'второго архива нет');
    assert.strictEqual(h.emulator.updateDbCalls, 2);
    const mirrorDumps = allShellLines().filter((line) => line.startsWith('config dump-config-to-files') && line.includes(`--dir=${mirrorDir} `));
    assert.strictEqual(mirrorDumps.length, 1, allShellLines().join('|'));
    assert.ok(!mirrorDumps[0].includes('--update') && !mirrorDumps[0].includes('--archive'), mirrorDumps[0]);
    assert.strictEqual(allShellLines().filter((line) => line === 'common connect-ib').length, 1);
  });

  test('импорт → полная загрузка → частичная: частичная после dump --update без скачивания', async () => {
    seedDb();
    const service = await getAgentOperationService(h.folder, h.cfRoot, h.channel);
    await service.importFromDatabase(target());

    await service.loadFullAndUpdate(target());
    assert.strictEqual(h.emulator.loads.at(-1)?.mode, 'archive');
    assert.strictEqual(h.emulator.updateDbCalls, 1);

    fs.writeFileSync(path.join(h.cfRoot, 'Catalogs', 'Клиенты.xml'), '<Catalog>Клиенты v2</Catalog>');
    await service.loadChanged(target(), { updateDatabase: true });
    assert.strictEqual(h.emulator.loads.at(-1)?.mode, 'partial');
    assert.strictEqual(h.emulator.updateDbCalls, 2);

    assert.strictEqual(allShellLines().filter((line) => line === 'common connect-ib').length, 1);
    assert.strictEqual(allShellLines().filter((line) => line === 'common disconnect-ib').length, 0);
  });

  test('auth-отказ без опорной точки (agentStartedAt неизвестен): ровно одна попытка входа и понятная ошибка без пароля', async () => {
    h.server.setBehavior({ mode: 'reject-all' });
    const service = await getAgentOperationService(h.folder, h.cfRoot, h.channel);
    await assert.rejects(
      service.updateDatabaseConfiguration(target()),
      (error: Error) => error.message.includes('неверный логин или пароль') && !error.message.includes(REMOTE_DB_PASSWORD)
    );
    assert.strictEqual(h.server.passwordAttempts, 1);
  });

  test('release в remote: отключает базу на удалённом агенте, запись кладётся в кэш и берёт SFTP-режим', async () => {
    assert.strictEqual(await releaseAgentInfoBaseForBatch(h.folder, h.channel), true);
    assert.ok(allShellLines().includes('common disconnect-ib'), allShellLines().join('|'));
    const cached = getCachedAgentOperationService(h.folder);
    assert.ok(cached, 'найденный агент остаётся в кэше');
    assert.strictEqual(h.server.clientCount, 1, 'для отключения SFTP не нужен');
    assert.strictEqual(await releaseAgentInfoBaseForBatch(h.folder, h.channel), false, 'повторное отключение — уже нечего');
    assertNoSecrets(h.everythingShown());
  });

  test('release в remote с недоступным агентом: не бросает, пакетная операция может стартовать', async () => {
    await setAgentSetting('port', await freePort());
    assert.strictEqual(await releaseAgentInfoBaseForBatch(h.folder, h.channel), false);
  });

  test('dispose реестра закрывает и shell, и SFTP, но не гасит удалённый агент командой shutdown', async () => {
    seedDb();
    const service = await getAgentOperationService(h.folder, h.cfRoot, h.channel);
    await service.importFromDatabase(target());
    assert.strictEqual(h.server.clientCount, 2);

    await disposeCachedAgentOperationServices();
    await h.server.whenClientCount(0);
    assert.ok(!allShellLines().includes('common shutdown'), allShellLines().join('|'));
  });

  async function freePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  suite('смена настроек агента', () => {
    test('affectsAgentServices: agent.* и remote.* — да; чужие разделы — нет', () => {
      const event = (...changed: string[]) => ({
        affectsConfiguration: (section: string) => changed.some((key) => key === section || key.startsWith(`${section}.`)),
      });
      assert.strictEqual(affectsAgentServices(event('v8vscedit.agent.location')), true);
      assert.strictEqual(affectsAgentServices(event('v8vscedit.agent.transferConcurrency')), true);
      assert.strictEqual(affectsAgentServices(event('v8vscedit.remote.user')), true);
      assert.strictEqual(affectsAgentServices(event('v8vscedit.mcp.enabled')), false);
      assert.strictEqual(affectsAgentServices(event('editor.fontSize')), false);
    });

    test('изменение agent.* сбрасывает кэш: старый сервис освобождён (SSH и SFTP закрыты), новая запись строится по новым настройкам', async () => {
      seedDb();
      const context = { subscriptions: [] as { dispose(): unknown }[] } as unknown as vscode.ExtensionContext;
      registerAgentSettingsWatcher(context, h.channel);
      assert.strictEqual(context.subscriptions.length, 1, 'подписка отдаётся владельцу контекста');

      const first = await getAgentOperationService(h.folder, h.cfRoot, h.channel);
      await first.importFromDatabase(target());
      assert.strictEqual(h.server.clientCount, 2);

      await setAgentSetting('transferConcurrency', 4);
      await eventually(() => getCachedAgentOperationService(h.folder) === undefined, 'сброс кэша реестра');
      await h.server.whenClientCount(0);

      const entry = await startAgentOperationService(h.root, h.cfRoot, h.channel);
      assert.strictEqual(entry.sync.transferConcurrency, 4);
      assert.notStrictEqual(entry.service, first);
      await entry.service.dispose();
      for (const subscription of context.subscriptions) {
        subscription.dispose();
      }
    });
  });
});
