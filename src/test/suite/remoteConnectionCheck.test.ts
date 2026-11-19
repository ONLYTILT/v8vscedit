/**
 * Э8: проверка подключения к удалённому агенту (infra, без vscode) на настоящем ssh2.Server.
 *
 * Контракт (infra/agent/RemoteConnectionCheck.ts, экспорт через infra/agent/index.ts):
 *
 *   checkRemoteAgentConnection(
 *     options: DesignerAgentEndpointOptions,   // host, port, user, password?, privateKeyPath?, connectTimeoutSeconds?
 *     deps?: { wrapStore?: (store: AgentFileStore) => AgentFileStore; probeToken?: () => string }
 *   ): Promise<RemoteConnectionReport>
 *   formatRemoteConnectionReport(report): string[]      // по строке на часть: `[OK]` / `[ОШИБКА]` / `[ПРОПУЩЕНО]`
 *
 *   RemoteConnectionReport = { ok: boolean; parts: RemoteCheckPart[] }  // всегда 3 части в порядке ssh, infobase, sftp
 *   RemoteCheckPart = { id: 'ssh' | 'infobase' | 'sftp'; status: 'ok' | 'failed' | 'skipped'; reason?: RemoteCheckFailureReason; message: string }
 *   RemoteCheckFailureReason = 'unreachable' | 'credentials' | 'timeout' | 'other'      // подключение (как decideAgentConnectRetry)
 *                            | 'agent-error'                                              // агент ответил ошибкой на connect-ib/disconnect-ib
 *                            | 'no-sftp-subsystem' | 'write-denied' | 'read-failed' | 'delete-failed'
 *
 * Правила:
 *  - Каждая часть — ОДНА попытка входа без повторов (диагностика, а не ожидание прогрева): политика
 *    {startupTimeoutMs: 0, authWarmupMs: 0, retryDelayMs: 0}; под логином 1С не делается серии неудачных входов.
 *  - ssh: вход по shell-каналу; не удался → infobase и sftp `skipped` (повторные входы под тем же логином
 *    не имеют смысла), ok = false.
 *  - infobase: `options set` → `common connect-ib` → `common disconnect-ib` на коротком транспорте;
 *    `DesignerAlreadyConnectedToInfoBase` на connect-ib — ok («уже подключена»), disconnect-ib НЕ шлётся (подключение
 *    чужое); `DesignerNotConnectedToInfoBase` на disconnect-ib — ok; иная ошибка агента — failed/'agent-error'
 *    с текстом агента. Транспорт закрывается БЕЗ `common shutdown`.
 *  - sftp (независим от результата infobase; выполняется, если ssh ok): ОТДЕЛЬНОЕ соединение; запись пробного файла
 *    `exchange/.v8vscedit-check-<token>.tmp`, чтение и сверка, удаление, проверка отсутствия. Пробный файл не
 *    остаётся и при отказе на середине. Не открылась подсистема SFTP → 'no-sftp-subsystem'.
 *  - Тексты на русском, содержат host:port; пароль не попадает никуда (ни в message, ни в отчёт целиком).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  checkRemoteAgentConnection,
  formatRemoteConnectionReport,
  type AgentFileStore,
  type DesignerAgentEndpointOptions,
  type RemoteConnectionReport,
} from '../../infra/agent';
import { AgentConfigEmulator } from './support/agentConfigEmulator';
import { agentError } from './support/agentInfoBaseFakes';
import { AgentSshTestServer, type AgentWireMessage } from './support/agentSshTestServer';

const PASSWORD = 'TopSecret!42-пароль';

suite('Агент Э8: checkRemoteAgentConnection', function () {
  this.timeout(60_000);
  let base: string;
  let userRoot: string;
  let server: AgentSshTestServer;
  let started = false;
  const sockets: net.Server[] = [];

  setup(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-e8-check-')));
    userRoot = path.join(base, 'user-root');
    fs.mkdirSync(userRoot, { recursive: true });
  });
  teardown(async () => {
    if (started) {
      await server.close();
      started = false;
    }
    await Promise.all(sockets.splice(0).map((s) => new Promise<void>((resolve) => { s.close(() => resolve()); })));
    fs.rmSync(base, { recursive: true, force: true });
  });

  async function start(
    options: { sftp?: boolean; respond?: (line: string) => Promise<readonly AgentWireMessage[]> | undefined } = {}
  ): Promise<void> {
    server = await AgentSshTestServer.start({ sftpRoot: options.sftp === false ? undefined : userRoot });
    started = true;
    const emulator = new AgentConfigEmulator(userRoot);
    server.setShellResponder(async (line) => {
      const custom = options.respond?.(line);
      if (custom) {
        return custom;
      }
      await emulator.execute(line);
      return [];
    });
  }

  const endpoint = (overrides: Partial<DesignerAgentEndpointOptions> = {}): DesignerAgentEndpointOptions => ({
    host: '127.0.0.1', port: server.port, user: 'admin', password: PASSWORD, connectTimeoutSeconds: 5, ...overrides,
  });

  const ids = (report: RemoteConnectionReport): string[] => report.parts.map((part) => `${part.id}:${part.status}`);
  const part = (report: RemoteConnectionReport, id: 'ssh' | 'infobase' | 'sftp') => {
    const found = report.parts.find((candidate) => candidate.id === id);
    assert.ok(found, `нет части ${id}`);
    return found;
  };
  const shellLines = (): string[] => server.shellLog.flat();
  const assertNoPassword = (report: RemoteConnectionReport): void => {
    assert.ok(!JSON.stringify(report).includes(PASSWORD), 'пароль в отчёте');
    assert.ok(!formatRemoteConnectionReport(report).join('\n').includes(PASSWORD), 'пароль в тексте отчёта');
  };

  test('всё доступно: три части ok, база подключена и отпущена, пробный файл убран, агент не остановлен', async () => {
    await start();
    const report = await checkRemoteAgentConnection(endpoint());
    assert.strictEqual(report.ok, true);
    assert.deepStrictEqual(ids(report), ['ssh:ok', 'infobase:ok', 'sftp:ok']);
    for (const p of report.parts) {
      assert.match(p.message, /[А-Яа-яЁё]/);
      assert.ok(p.message.includes(`127.0.0.1:${String(server.port)}`) || p.id === 'infobase', p.message);
    }
    const lines = shellLines();
    const connect = lines.indexOf('common connect-ib');
    const disconnect = lines.indexOf('common disconnect-ib');
    assert.ok(lines.some((line) => line.startsWith('options set')));
    assert.ok(connect >= 0 && disconnect > connect, lines.join('|'));
    assert.ok(!lines.includes('common shutdown'));

    const written = server.sftp?.ops('OPEN').map((entry) => entry.path ?? '') ?? [];
    assert.ok(written.some((p) => /exchange\/\.v8vscedit-check-[0-9a-z]+\.tmp/.test(p)), written.join('|'));
    const leftover = fs.existsSync(path.join(userRoot, 'exchange')) ? fs.readdirSync(path.join(userRoot, 'exchange')) : [];
    assert.deepStrictEqual(leftover, []);
    await server.whenClientCount(0);
    assertNoPassword(report);
    assert.ok(server.passwordsSeen.length >= 2 && server.passwordsSeen.every((p) => p === PASSWORD));
  });

  test('формат отчёта: по строке на часть с признаком статуса', async () => {
    await start();
    const ok = await checkRemoteAgentConnection(endpoint());
    const okLines = formatRemoteConnectionReport(ok);
    assert.strictEqual(okLines.length, 3);
    assert.ok(okLines.every((line) => line.startsWith('[OK]')), okLines.join('\n'));

    server.setBehavior({ mode: 'reject-all' });
    const failed = await checkRemoteAgentConnection(endpoint());
    const failedLines = formatRemoteConnectionReport(failed);
    assert.strictEqual(failedLines.length, 3);
    assert.ok(failedLines[0].startsWith('[ОШИБКА]'));
    assert.ok(failedLines[1].startsWith('[ПРОПУЩЕНО]'));
    assert.ok(failedLines[2].startsWith('[ПРОПУЩЕНО]'));
  });

  suite('SSH-вход', () => {
    test('порт закрыт: unreachable, остальное пропущено, одна попытка', async () => {
      await start();
      const dead = net.createServer();
      await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
      const { port } = dead.address() as net.AddressInfo;
      await new Promise<void>((resolve) => dead.close(() => resolve()));

      const report = await checkRemoteAgentConnection(endpoint({ port }));
      assert.strictEqual(report.ok, false);
      assert.deepStrictEqual(ids(report), ['ssh:failed', 'infobase:skipped', 'sftp:skipped']);
      assert.strictEqual(part(report, 'ssh').reason, 'unreachable');
      assert.match(part(report, 'ssh').message, /не отвечает/);
      assert.strictEqual(server.passwordAttempts, 0);
      assertNoPassword(report);
    });

    test('неверный логин или пароль: credentials, ровно одна попытка входа, SFTP не пытается входить', async () => {
      await start();
      server.setBehavior({ mode: 'reject-all' });
      const report = await checkRemoteAgentConnection(endpoint());
      assert.deepStrictEqual(ids(report), ['ssh:failed', 'infobase:skipped', 'sftp:skipped']);
      assert.strictEqual(part(report, 'ssh').reason, 'credentials');
      assert.match(part(report, 'ssh').message, /неверный логин или пароль/);
      assert.match(part(report, 'ssh').message, /admin/);
      assert.strictEqual(server.passwordAttempts, 1);
      assertNoPassword(report);
    });

    test('сервер молчит (SSH не отвечает на рукопожатие): timeout', async () => {
      await start();
      // Принятый сокет читается (resume), иначе он не увидит FIN клиента и close() сервера в teardown
      // ждал бы вечно; писать в ответ сервер по-прежнему ничего не пишет.
      const silent = net.createServer((socket) => { socket.resume(); });
      sockets.push(silent);
      await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
      const { port } = silent.address() as net.AddressInfo;
      const report = await checkRemoteAgentConnection(endpoint({ port, connectTimeoutSeconds: 1 }));
      assert.strictEqual(part(report, 'ssh').status, 'failed');
      assert.strictEqual(part(report, 'ssh').reason, 'timeout');
      assert.match(part(report, 'ssh').message, /не ответил вовремя/);
    });

    test('прочая ошибка (нет файла ключа): other, текст причины сохранён', async () => {
      await start();
      const report = await checkRemoteAgentConnection(endpoint({ privateKeyPath: path.join(base, 'нет-такого-ключа') }));
      assert.strictEqual(part(report, 'ssh').reason, 'other');
      assert.match(part(report, 'ssh').message, /ENOENT|нет-такого-ключа/);
      assert.deepStrictEqual(ids(report), ['ssh:failed', 'infobase:skipped', 'sftp:skipped']);
    });
  });

  suite('подключение информационной базы', () => {
    test('база уже подключена другим сеансом: ok с пометкой, disconnect-ib не шлётся, SFTP проверяется', async () => {
      await start({
        respond: (line) => {
          if (line === 'common connect-ib') {
            return Promise.reject(agentError('DesignerAlreadyConnectedToInfoBase', 'База уже подключена'));
          }
          return undefined;
        },
      });
      const report = await checkRemoteAgentConnection(endpoint());
      assert.deepStrictEqual(ids(report), ['ssh:ok', 'infobase:ok', 'sftp:ok']);
      assert.match(part(report, 'infobase').message, /уже подключена/);
      assert.ok(!shellLines().includes('common disconnect-ib'));
    });

    test('иная ошибка connect-ib: failed/agent-error с текстом агента, disconnect не шлётся, SFTP всё равно проверяется', async () => {
      await start({
        respond: (line) => line === 'common connect-ib'
          ? Promise.reject(agentError('ConfigFilesError', 'Не удалось подключиться к базе: файл блокировки'))
          : undefined,
      });
      const report = await checkRemoteAgentConnection(endpoint());
      assert.strictEqual(report.ok, false);
      assert.deepStrictEqual(ids(report), ['ssh:ok', 'infobase:failed', 'sftp:ok']);
      assert.strictEqual(part(report, 'infobase').reason, 'agent-error');
      assert.match(part(report, 'infobase').message, /файл блокировки/);
      assert.ok(!shellLines().includes('common disconnect-ib'));
    });

    test('агент не принял options set: failed/agent-error с отдельной подписью, connect-ib не шлётся', async () => {
      await start({
        respond: (line) => line.startsWith('options set')
          ? Promise.reject(agentError('UnknownError', 'неизвестный параметр --notify-progress'))
          : undefined,
      });
      const report = await checkRemoteAgentConnection(endpoint());
      assert.deepStrictEqual(ids(report), ['ssh:ok', 'infobase:failed', 'sftp:ok']);
      assert.strictEqual(part(report, 'infobase').reason, 'agent-error');
      assert.match(part(report, 'infobase').message, /настро[йе]к/);
      assert.match(part(report, 'infobase').message, /неизвестный параметр/);
      assert.doesNotMatch(part(report, 'infobase').message, /не подключил/);
      assert.ok(!shellLines().includes('common connect-ib'));
    });

    test('disconnect-ib: «не подключена» — ok; иная ошибка — failed/agent-error', async () => {
      await start({
        respond: (line) => line === 'common disconnect-ib'
          ? Promise.reject(agentError('DesignerNotConnectedToInfoBase', 'не подключена'))
          : undefined,
      });
      const tolerated = await checkRemoteAgentConnection(endpoint());
      assert.strictEqual(part(tolerated, 'infobase').status, 'ok');
      await server.close();

      await start({
        respond: (line) => line === 'common disconnect-ib'
          ? Promise.reject(agentError('UnknownError', 'сбой отключения'))
          : undefined,
      });
      const broken = await checkRemoteAgentConnection(endpoint());
      assert.strictEqual(part(broken, 'infobase').status, 'failed');
      assert.strictEqual(part(broken, 'infobase').reason, 'agent-error');
      assert.match(part(broken, 'infobase').message, /сбой отключения/);
      assert.strictEqual(part(broken, 'sftp').status, 'ok');
    });
  });

  suite('SFTP', () => {
    test('агент без подсистемы SFTP: no-sftp-subsystem, SSH и база в порядке', async () => {
      await start({ sftp: false });
      const report = await checkRemoteAgentConnection(endpoint());
      assert.strictEqual(report.ok, false);
      assert.deepStrictEqual(ids(report), ['ssh:ok', 'infobase:ok', 'sftp:failed']);
      assert.strictEqual(part(report, 'sftp').reason, 'no-sftp-subsystem');
      assert.match(part(report, 'sftp').message, /SFTP/);
    });

    test('вход по SFTP отклонён (отдельное соединение): credentials', async () => {
      await start({
        respond: (line) => {
          if (line === 'common disconnect-ib') {
            server.setBehavior({ mode: 'reject-all' });
          }
          return undefined;
        },
      });
      const report = await checkRemoteAgentConnection(endpoint());
      assert.deepStrictEqual(ids(report), ['ssh:ok', 'infobase:ok', 'sftp:failed']);
      assert.strictEqual(part(report, 'sftp').reason, 'credentials');
      assertNoPassword(report);
    });

    test('запись запрещена: write-denied с понятной причиной, пробный файл не остаётся', async () => {
      await start();
      assert.ok(server.sftp);
      server.sftp.failNext({ op: 'OPEN', pathIncludes: '.v8vscedit-check-fixed', code: 'PERMISSION_DENIED' });
      const report = await checkRemoteAgentConnection(endpoint(), { probeToken: () => 'fixed' });
      assert.deepStrictEqual(ids(report), ['ssh:ok', 'infobase:ok', 'sftp:failed']);
      assert.strictEqual(part(report, 'sftp').reason, 'write-denied');
      assert.match(part(report, 'sftp').message, /запис/i);
      const exchange = path.join(userRoot, 'exchange');
      assert.deepStrictEqual(fs.existsSync(exchange) ? fs.readdirSync(exchange) : [], []);
    });

    /** Хранилище-обёртка над настоящим: подменяет одну операцию, остальное — настоящее. */
    function tampered(patch: Partial<Record<'readFile' | 'remove', (inner: AgentFileStore, rel: string) => Promise<unknown>>>) {
      return (inner: AgentFileStore): AgentFileStore => ({
        kind: inner.kind,
        stat: (rel) => inner.stat(rel),
        readFile: (rel) => (patch.readFile ? patch.readFile(inner, rel) as Promise<Buffer> : inner.readFile(rel)),
        writeFile: (rel, data) => inner.writeFile(rel, data),
        downloadToFile: (rel, localPath, opts) => inner.downloadToFile(rel, localPath, opts),
        uploadFromFile: (localPath, rel, opts) => inner.uploadFromFile(localPath, rel, opts),
        remove: (rel, opts) => (patch.remove ? patch.remove(inner, rel) as Promise<void> : inner.remove(rel, opts)),
        list: (dir, opts) => inner.list(dir, opts),
        mkdirp: (rel) => inner.mkdirp(rel),
        dispose: () => inner.dispose(),
      });
    }

    test('чтение не удалось: read-failed, пробный файл всё равно удалён', async () => {
      await start();
      const report = await checkRemoteAgentConnection(endpoint(), {
        wrapStore: tampered({ readFile: () => Promise.reject(new Error('сервер отказал в чтении')) }),
      });
      assert.strictEqual(part(report, 'sftp').reason, 'read-failed');
      assert.match(part(report, 'sftp').message, /сервер отказал в чтении/);
      const exchange = path.join(userRoot, 'exchange');
      assert.deepStrictEqual(fs.existsSync(exchange) ? fs.readdirSync(exchange) : [], []);
    });

    test('чтение не удалось и уборка тоже: причина — чтение, сбой уборки её не заслоняет', async () => {
      await start();
      const report = await checkRemoteAgentConnection(endpoint(), {
        wrapStore: tampered({
          readFile: () => Promise.reject(new Error('сервер отказал в чтении')),
          remove: () => Promise.reject(new Error('удалять нельзя')),
        }),
      });
      assert.strictEqual(part(report, 'sftp').reason, 'read-failed');
      assert.match(part(report, 'sftp').message, /сервер отказал в чтении/);
      assert.ok(!part(report, 'sftp').message.includes('удалять нельзя'));
    });

    test('прочитано не то, что записано: read-failed', async () => {
      await start();
      const report = await checkRemoteAgentConnection(endpoint(), {
        wrapStore: tampered({ readFile: () => Promise.resolve(Buffer.from('чужое содержимое')) }),
      });
      assert.strictEqual(part(report, 'sftp').reason, 'read-failed');
      assert.match(part(report, 'sftp').message, /не совпад|отлич/);
    });

    test('удаление не удалось (ошибка): delete-failed', async () => {
      await start();
      const report = await checkRemoteAgentConnection(endpoint(), {
        wrapStore: tampered({ remove: () => Promise.reject(new Error('удалять нельзя')) }),
      });
      assert.strictEqual(part(report, 'sftp').reason, 'delete-failed');
      assert.match(part(report, 'sftp').message, /удалять нельзя/);
    });

    test('удаление «прошло», но файл на месте: delete-failed', async () => {
      await start();
      const report = await checkRemoteAgentConnection(endpoint(), {
        wrapStore: tampered({ remove: () => Promise.resolve() }),
      });
      assert.strictEqual(part(report, 'sftp').reason, 'delete-failed');
    });
  });
});
