/**
 * Э8: AgentOperationService над SFTP-хранилищем и закрытие SSH без остановки удалённого агента (infra).
 *
 * Контракт:
 *  - `AgentOperationFilesOptions.sftp?: DesignerAgentConnectionOptions` — если задан, хранилище файлов
 *    создаётся через `connectSftpAgentFileStore(sftp)` (отдельное SSH-соединение, своя политика повторов),
 *    `agentBaseDir` не нужен и не читается; без `sftp` — локальное хранилище, как раньше.
 *  - `new AgentOperationService(projectRoot, transportFactory, sessionOptions, filesOptions, syncOptions?)`;
 *    `syncOptions: { archiveThresholdFiles?, transferConcurrency? }` уходит в `AgentSyncEngine`.
 *  - Неудавшееся подключение SFTP не кэшируется: следующая операция пробует заново.
 *  - `DesignerAgentEndpointOptions.shutdownOnDispose?: boolean` (умолчание — `true`): при `false`
 *    `ProcessDesignerAgentTransport.dispose()` закрывает канал и SSH, но НЕ пишет `common shutdown`.
 *  - `AgentOperationService.dispose()` закрывает SFTP-соединение (shell закрывает владелец фабрики).
 */
import * as assert from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ClientChannel } from 'ssh2';
import type { AgentConnectPolicyOptions } from '../../domain/agent';
import {
  AgentOperationService,
  DesignerAgentSessionManager,
  ProcessDesignerAgentTransport,
  ProcessDesignerAgentTransportFactory,
  type DesignerAgentConnectionOptions,
  type DesignerAgentSshClient,
} from '../../infra/agent';
import { AgentConfigEmulator } from './support/agentConfigEmulator';
import { AgentSshTestServer } from './support/agentSshTestServer';
import { STANDARD_DB, dbAsText } from './support/agentSyncHarness';

const POLICY: AgentConnectPolicyOptions = { startupTimeoutMs: 5_000, authWarmupMs: 90_000, retryDelayMs: 10 };

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly writes: string[] = [];
  write(text: string): boolean { this.writes.push(text); return true; }
  end(): this { return this; }
}

class FakeSshClient extends EventEmitter implements DesignerAgentSshClient {
  readonly channel = new FakeChannel();
  ended = false;
  connect(): void { queueMicrotask(() => this.emit('ready')); }
  shell(_windows: false, callback: (error: Error | undefined, channel: ClientChannel) => void): void {
    callback(undefined, this.channel as unknown as ClientChannel);
  }
  end(): void { this.ended = true; }
}

suite('Агент Э8: shutdownOnDispose транспорта', () => {
  const endpoint = { host: 'h', port: 1, user: 'u', password: 'p' };

  const table: [boolean | undefined, boolean][] = [[undefined, true], [true, true], [false, false]];
  for (const [flag, expectShutdown] of table) {
    test(`shutdownOnDispose=${String(flag)}: dispose ${expectShutdown ? 'пишет' : 'не пишет'} common shutdown, SSH закрывается`, async () => {
      const fake = new FakeSshClient();
      const transport = new ProcessDesignerAgentTransport({ ...endpoint, shutdownOnDispose: flag }, () => fake);
      await transport.connect();
      await transport.dispose();
      assert.strictEqual(fake.channel.writes.includes('common shutdown\n'), expectShutdown);
      assert.strictEqual(fake.ended, true);
      assert.strictEqual(transport.isClosed(), true);
    });
  }
});

suite('Агент Э8: AgentOperationService поверх SFTP-хранилища', function () {
  this.timeout(120_000);
  let base: string;
  let projectRoot: string;
  let cfRoot: string;
  let userRoot: string;
  let server: AgentSshTestServer | undefined;
  let emulator: AgentConfigEmulator;
  let sessions: DesignerAgentSessionManager | undefined;
  let service: AgentOperationService | undefined;

  const target = () => ({ kind: 'cf' as const, name: 'Основная', rootPath: cfRoot });

  function options(): DesignerAgentConnectionOptions {
    assert.ok(server);
    return { host: '127.0.0.1', port: server.port, user: 'admin', password: 'secret', connectTimeoutSeconds: 5, policy: POLICY };
  }

  async function startServer(sftp = true): Promise<AgentSshTestServer> {
    server = await AgentSshTestServer.start({ sftpRoot: sftp ? userRoot : undefined });
    server.setShellResponder(async (line) => { await emulator.execute(line); return []; });
    return server;
  }

  function createService(syncOptions?: { archiveThresholdFiles?: number; transferConcurrency?: number }): AgentOperationService {
    const connection = options();
    sessions = new DesignerAgentSessionManager(
      new ProcessDesignerAgentTransportFactory({ ...connection, shutdownOnDispose: false })
    );
    service = new AgentOperationService(projectRoot, sessions, {}, { userName: 'admin', sftp: connection }, syncOptions);
    return service;
  }

  function seedDb(files: Record<string, Record<string, string>> = STANDARD_DB): void {
    for (const [fullName, objectFiles] of Object.entries(files)) {
      emulator.setObject(fullName, objectFiles);
    }
  }

  function readTree(dir: string, rel = ''): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        Object.assign(out, readTree(path.join(dir, entry.name), childRel));
      } else {
        out[childRel] = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
      }
    }
    return out;
  }

  setup(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-e8-svc-')));
    projectRoot = path.join(base, 'project');
    cfRoot = path.join(projectRoot, 'src', 'cf');
    userRoot = path.join(base, 'user-root');
    fs.mkdirSync(cfRoot, { recursive: true });
    fs.mkdirSync(userRoot, { recursive: true });
    emulator = new AgentConfigEmulator(userRoot);
  });
  teardown(async () => {
    await service?.dispose();
    await sessions?.disposeAll();
    await server?.close();
    server = undefined;
    service = undefined;
    sessions = undefined;
    fs.rmSync(base, { recursive: true, force: true });
  });

  test('импорт идёт по SFTP без agentBaseDir и без каталога .v8vscedit/agent', async () => {
    const srv = await startServer();
    seedDb();
    await createService().importFromDatabase(target());
    assert.deepStrictEqual(readTree(cfRoot), dbAsText(emulator.dbFiles()));
    assert.ok((srv.sftp?.ops('OPEN').length ?? 0) > 0);
    assert.strictEqual(fs.existsSync(path.join(projectRoot, '.v8vscedit', 'agent')), false);
    assert.strictEqual(fs.existsSync(path.join(userRoot, 'agentbasedir.json')), false);
  });

  test('dispose сервиса закрывает SFTP-соединение (остаётся только shell)', async () => {
    const srv = await startServer();
    seedDb();
    const svc = createService();
    await svc.importFromDatabase(target());
    assert.strictEqual(srv.clientCount, 2);
    await svc.dispose();
    await srv.whenClientCount(1);
  });

  test('агент без подсистемы SFTP: понятная ошибка операции, соединение не кэшируется', async () => {
    const srv = await startServer(false);
    seedDb();
    const svc = createService();
    // `\w` в JS-регулярке не совпадает с кириллицей: «подсистему» по `\w*` не находилась бы никогда.
    await assert.rejects(svc.importFromDatabase(target()), /подсистем[а-яё]* SFTP/);
    await srv.whenClientCount(1);
  });

  test('отказ входа SFTP: одна попытка без опорной точки; следующая операция подключается заново', async () => {
    const srv = await startServer();
    seedDb();
    const svc = createService();
    await svc.reconnectInfoBase();
    srv.setBehavior({ mode: 'reject-all' });
    srv.resetAttempts();
    await assert.rejects(svc.importFromDatabase(target()), /неверный логин или пароль/);
    assert.strictEqual(srv.passwordAttempts, 1);

    srv.setBehavior({ mode: 'accept' });
    await svc.importFromDatabase(target());
    assert.deepStrictEqual(readTree(cfRoot), dbAsText(emulator.dbFiles()));
  });

  const thresholdTable: [number, 'delta' | 'archive'][] = [[1, 'archive'], [2, 'delta'], [300, 'delta']];
  for (const [threshold, expected] of thresholdTable) {
    test(`archiveThresholdFiles=${String(threshold)}: владелец с 2 изменёнными файлами → ${expected}`, async () => {
      await startServer();
      seedDb();
      const svc = createService({ archiveThresholdFiles: threshold });
      await svc.importFromDatabase(target());
      const before = emulator.dumps().length;
      emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
      await svc.importFromDatabase(target());

      const second = emulator.dumps().slice(before);
      assert.ok(second.length > 0);
      if (expected === 'archive') {
        // `--get-changes` идёт при любом исходе: по этому списку движок и выбирает дельту или архив.
        assert.ok(second.some((command) => 'archive' in command.options), 'ожидалась выгрузка архивом');
      } else {
        assert.ok(second.some((command) => 'get-changes' in command.options), 'ожидалась дельта по --get-changes');
        assert.ok(!second.some((command) => 'archive' in command.options));
      }
      assert.strictEqual(fs.readFileSync(path.join(cfRoot, 'Catalogs', 'Товары.xml'), 'utf-8'), '<Catalog>Товары v2</Catalog>');
    });
  }

  suite('transferConcurrency ограничивает число параллельных записей по SFTP', () => {
    const MODULES = Array.from({ length: 6 }, (_unused, index) => `Модуль${String(index + 1)}`);

    function bigDb(): Record<string, Record<string, string>> {
      const db: Record<string, Record<string, string>> = { 'Configuration.Конфигурация': STANDARD_DB['Configuration.Конфигурация'] };
      for (const name of MODULES) {
        db[`CommonModule.${name}`] = {
          [`CommonModules/${name}.xml`]: `<CommonModule>${name}</CommonModule>`,
          [`CommonModules/${name}/Ext/Module.bsl`]: `Процедура ${name}() КонецПроцедуры`,
        };
      }
      return db;
    }

    async function prepareChangedLoad(concurrency: number): Promise<{ svc: AgentOperationService; srv: AgentSshTestServer }> {
      const srv = await startServer();
      seedDb(bigDb());
      const svc = createService({ transferConcurrency: concurrency });
      await svc.importFromDatabase(target());
      for (const name of MODULES) {
        fs.appendFileSync(path.join(cfRoot, 'CommonModules', name, 'Ext', 'Module.bsl'), '\n// правка');
      }
      return { svc, srv };
    }

    test('concurrency=2: одновременно в полёте не больше двух записей', async () => {
      const { svc, srv } = await prepareChangedLoad(2);
      assert.ok(srv.sftp);
      const gate = srv.sftp.hold('WRITE');
      const loading = svc.loadChangedAndUpdate(target());
      await gate.waitForPending(2);
      // Оба исполнителя пула заблокированы на WRITE, третьему стартовать некому: число детерминировано.
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(gate.pendingCount(), 2);
      gate.release();
      await loading;
      assert.strictEqual(emulator.loads.at(-1)?.mode, 'partial');
    });

    test('concurrency=16: записи идут шире двух', async () => {
      const { svc, srv } = await prepareChangedLoad(16);
      assert.ok(srv.sftp);
      const gate = srv.sftp.hold('WRITE');
      const loading = svc.loadChangedAndUpdate(target());
      await gate.waitForPending(3);
      assert.ok(gate.pendingCount() >= 3);
      gate.release();
      await loading;
    });
  });

  test('локальные filesOptions без sftp не трогают SFTP: хранилище локальное, индекса нет → понятная ошибка', async () => {
    const srv = await startServer();
    const connection = options();
    sessions = new DesignerAgentSessionManager(new ProcessDesignerAgentTransportFactory(connection));
    service = new AgentOperationService(
      projectRoot, sessions, {}, { userName: 'admin', agentBaseDir: path.join(base, 'no-agent-dir') }
    );
    await assert.rejects(service.importFromDatabase(target()), /agentbasedir\.json/);
    assert.strictEqual(srv.sftp?.sessionCount, 0);
  });
});
