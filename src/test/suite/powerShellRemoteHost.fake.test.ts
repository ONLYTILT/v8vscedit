/**
 * Э9: PowerShellRemoteHost — поведение TypeScript-стороны на СКРИПТУЕМОМ поддельном процессе хоста
 * (шов `spawn`; кросс-платформенно). Хост на настоящем powershell.exe — powerShellRemoteHost.local.test.ts.
 *
 * Контракт (infra/process/remote/PowerShellRemoteHost.ts, без vscode):
 *   export interface PowerShellHostConnection {
 *     computerName: string; user: string; password: string;
 *     authentication: HostAuthentication; useSsl: boolean; port: number;
 *   }
 *   export type HostSpawn = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; windowsHide: boolean })
 *     => ChildProcessWithoutNullStreams;             // по умолчанию — child_process.spawn
 *   export interface PowerShellRemoteHostOptions {
 *     connection: PowerShellHostConnection;
 *     powershellPath?: string;                       // умолчание 'powershell.exe'
 *     spawn?: HostSpawn;
 *     env?: NodeJS.ProcessEnv;                       // окружение процесса хоста; умолчание — process.env
 *     log?: (line: string) => void;                  // шум stdout, строки stderr и диагностика хоста; НИКОГДА пароль
 *     disposeGraceMs?: number;                       // сколько ждать выхода после закрытия stdin до kill; умолчание 5000
 *   }
 *   export type PowerShellHostErrorCode =
 *     'remote-error' | 'auth-failed' | 'session-broken' | 'host-exited' | 'protocol' | 'spawn-failed' | 'disposed';
 *   // auth-failed — ответ `error` с `auth: true` (сервер отклонил учётные данные при connect).
 *   export class PowerShellHostError extends Error { readonly code: PowerShellHostErrorCode }
 *   export interface HostRunRequest {
 *     exe: string; commandLine: string; logPath: string;
 *     cancellation?: CancellationLike; onStarted?: (pid: number) => void;
 *     onOutput?: (line: string, stream: 'stdout' | 'stderr') => void;
 *   }
 *   export interface HostRunResult { exitCode: number; interrupted: boolean; logBytes: Buffer; pid: number }
 *   export class PowerShellRemoteHost {
 *     constructor(options: PowerShellRemoteHostOptions);
 *     getProcessId(): number | undefined;                       // pid процесса хоста; undefined — не запущен/завершён
 *     ping(): Promise<{ pid: number }>;
 *     mktemp(): Promise<string>;
 *     put(dir: string, name: string, content: Uint8Array | string): Promise<void>;   // строка — UTF-8
 *     resolveV8(target: { v8Path?: string; v8Version?: string }): Promise<string | undefined>;
 *     run(request: HostRunRequest): Promise<HostRunResult>;
 *     fetch(remotePath: string, localPath: string): Promise<boolean>;                // false — файла на сервере нет
 *     rmtemp(dir: string): Promise<void>;
 *     dispose(): Promise<void>;
 *   }
 *
 * Н62: идемпотентные запросы (ping, resolveV8, mktemp, rmtemp, fetch) при session-broken/host-exited повторяются ОДИН
 * раз на новом процессе (сессия с IdleTimeout закрывается сервером после простоя); put и run не повторяются.
 *
 * Правила: процесс запускается лениво на первом запросе, сразу за ним — `connect` (один раз на процесс);
 * запросы идут строго по очереди, `cancel` — в обход очереди; ошибка `error` отклоняет один запрос и не
 * ломает хост; `sessionBroken`/выход процесса/ошибка протокола помечают процесс негодным, а следующий запрос
 * запускает НОВЫЙ процесс ровно один раз (без цикла перезапусков внутри запроса); `dispose` закрывает stdin
 * и больше запросов не принимает.
 */
import * as assert from 'assert';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildPowerShellHostArgs } from '../../infra/process/remote/PowerShellHostScript';
import {
  PowerShellHostError,
  PowerShellRemoteHost,
  type HostSpawn,
  type PowerShellHostConnection,
  type PowerShellHostErrorCode,
} from '../../infra/process/remote/PowerShellRemoteHost';
import { isProcessAlive as isAlive, waitUntil } from './support/fakeDesignerProcess';
import { FakeHostRig, type FakeHostSpawnScenario } from './support/fakePowerShellHost';

const PASSWORD = 'Пар"оль $x`y & 123';

const CONNECTION: PowerShellHostConnection = {
  computerName: 'srv-1c.corp',
  user: 'CORP\\admin',
  password: PASSWORD,
  authentication: 'Kerberos',
  useSsl: true,
  port: 5986,
};

const b64 = (text: string | Uint8Array): string => Buffer.from(text as Uint8Array).toString('base64');

suite('Э9: PowerShellRemoteHost — очередь, протокол и восстановление (поддельный процесс хоста)', function () {
  this.timeout(60_000);
  let sandbox: string;
  let rig: FakeHostRig;
  let host: PowerShellRemoteHost;
  let logs: string[];

  setup(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-fakehost-'));
    logs = [];
  });

  teardown(async () => {
    await host.dispose();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function create(
    scenarioSpawns?: FakeHostSpawnScenario[],
    extra: { connection?: Partial<PowerShellHostConnection>; env?: NodeJS.ProcessEnv; disposeGraceMs?: number } = {}
  ): void {
    rig = new FakeHostRig(path.join(sandbox, 'rig'), { spawns: scenarioSpawns });
    host = new PowerShellRemoteHost({
      connection: { ...CONNECTION, ...extra.connection },
      powershellPath: 'fake-powershell.exe',
      spawn: rig.spawn,
      env: extra.env,
      disposeGraceMs: extra.disposeGraceMs,
      log: (line) => logs.push(line),
    });
  }

  async function expectHostError(action: () => Promise<unknown>, code: PowerShellHostErrorCode, message?: RegExp): Promise<PowerShellHostError> {
    try {
      await action();
    } catch (error) {
      assert.ok(error instanceof PowerShellHostError, `ожидался PowerShellHostError, получено ${String(error)}`);
      assert.strictEqual(error.code, code, error.message);
      if (message) {
        assert.match(error.message, message);
      }
      return error;
    }
    return assert.fail('ожидалось исключение');
  }

  suite('запуск и connect', () => {
    test('процесс не стартует, пока нет первого запроса; getProcessId — undefined', () => {
      create();
      assert.strictEqual(rig.spawnCalls.length, 0);
      assert.strictEqual(host.getProcessId(), undefined);
    });

    test('первый запрос запускает процесс, первой строкой уходит connect, затем сам запрос', async () => {
      create();
      assert.strictEqual(await host.mktemp(), 'C:\\Temp\\v8vscedit-fake');
      assert.deepStrictEqual(rig.received().map((request) => request.op), ['connect', 'mktemp']);
      assert.strictEqual(typeof host.getProcessId(), 'number');
    });

    test('connect несёт параметры соединения; пароль — только base64 от UTF-8 в passwordB64', async () => {
      create();
      await host.ping();
      const connect = rig.received()[0];
      assert.deepStrictEqual(
        { ...connect, id: undefined },
        {
          id: undefined, op: 'connect', computerName: 'srv-1c.corp', user: 'CORP\\admin', passwordB64: b64(PASSWORD),
          authentication: 'Kerberos', useSsl: true, port: 5986,
        }
      );
    });

    const connectionTable: Partial<PowerShellHostConnection>[] = [
      { authentication: 'Default', useSsl: false, port: 0, computerName: 'a' },
      { authentication: 'Negotiate', useSsl: false, port: 5985, computerName: 'b.corp', user: 'u' },
      { authentication: 'Kerberos', useSsl: true, port: 5986, computerName: 'c' },
    ];
    for (const row of connectionTable) {
      test(`connect передаёт ${JSON.stringify(row)} без искажений`, async () => {
        create(undefined, { connection: row });
        await host.ping();
        const connect = rig.received()[0];
        for (const [key, value] of Object.entries(row)) {
          assert.strictEqual(connect[key], value, key);
        }
      });
    }

    test('connect выполняется один раз на процесс, сколько бы запросов ни было', async () => {
      create();
      await host.ping();
      await host.mktemp();
      await host.rmtemp('C:\\Temp\\v8vscedit-fake');
      assert.strictEqual(rig.received().filter((request) => request.op === 'connect').length, 1);
    });

    test('одновременные первые запросы запускают ровно один процесс', async () => {
      create();
      await Promise.all([host.ping(), host.mktemp(), host.ping()]);
      assert.strictEqual(rig.spawnCalls.length, 1);
      assert.strictEqual(rig.starts().length, 1);
    });

    test('команда запуска — powershellPath из настроек, вектор — buildPowerShellHostArgs()', async () => {
      create();
      await host.ping();
      assert.strictEqual(rig.spawnCalls[0].command, 'fake-powershell.exe');
      assert.deepStrictEqual(rig.spawnCalls[0].args, buildPowerShellHostArgs());
    });

    test('без powershellPath команда — powershell.exe', async () => {
      rig = new FakeHostRig(path.join(sandbox, 'rig'));
      host = new PowerShellRemoteHost({ connection: CONNECTION, spawn: rig.spawn });
      await host.ping();
      assert.strictEqual(rig.spawnCalls[0].command, 'powershell.exe');
    });

    test('пароль не попадает ни в вектор запуска, ни в окружение процесса, ни в журнал хоста', async () => {
      create(undefined, { env: { PATH: process.env.PATH, FAKE_MARK: 'x' } });
      await host.ping();
      const call = rig.spawnCalls[0];
      const everything = [call.command, ...call.args, ...Object.values(call.env).map(String), ...logs].join('\n');
      assert.ok(!everything.includes(PASSWORD), 'пароль открытым текстом');
      assert.ok(!everything.includes(b64(PASSWORD)), 'пароль в base64');
      const encodedScript = Buffer.from(call.args.at(-1) ?? '', 'base64').toString('utf16le');
      assert.ok(!encodedScript.includes(PASSWORD));
      assert.strictEqual(call.env.FAKE_MARK, 'x', 'env из настроек доходит до процесса');
    });

    test('пароль не попадает в сообщения ошибок хоста', async () => {
      create([{ ops: { mktemp: [[{ send: { event: 'error', message: 'сеанс отклонён' } }]] } }]);
      const error = await expectHostError(() => host.mktemp(), 'remote-error');
      assert.ok(!error.message.includes(PASSWORD));
    });
  });

  suite('операции и их запросы', () => {
    test('ping возвращает pid из ответа', async () => {
      create();
      const { pid } = await host.ping();
      assert.strictEqual(typeof pid, 'number');
    });

    test('put: строка уходит как UTF-8 в contentB64, Uint8Array — байт-в-байт, имя и каталог без изменений', async () => {
      create();
      await host.put('C:\\Temp\\v8vscedit-1', 'объекты.xml', 'Привет');
      const binary = Uint8Array.from([0xef, 0xbb, 0xbf, 0x00, 0xff, 0xfe]);
      await host.put('C:\\Temp\\v8vscedit-1', 'payload.bin', binary);
      const puts = rig.received().filter((request) => request.op === 'put');
      assert.deepStrictEqual(puts.map((request) => [request.dir, request.name, request.contentB64]), [
        ['C:\\Temp\\v8vscedit-1', 'объекты.xml', b64('Привет')],
        ['C:\\Temp\\v8vscedit-1', 'payload.bin', b64(binary)],
      ]);
    });

    test('resolveV8: путь из ответа; null → undefined; параметры уходят как заданы', async () => {
      create([{ ops: { resolveV8: [
        [{ send: { event: 'ok', path: 'C:\\1c\\1cv8.exe' } }],
        [{ send: { event: 'ok', path: null } }],
      ] } }]);
      assert.strictEqual(await host.resolveV8({ v8Path: 'C:\\1c\\1cv8.exe' }), 'C:\\1c\\1cv8.exe');
      assert.strictEqual(await host.resolveV8({ v8Version: '8.3.27.2130' }), undefined);
      const requests = rig.received().filter((request) => request.op === 'resolveV8');
      assert.strictEqual(requests[0].v8Path, 'C:\\1c\\1cv8.exe');
      assert.strictEqual(requests[1].v8Version, '8.3.27.2130');
    });

    test('fetch: exists из ответа → boolean; пути уходят как заданы', async () => {
      create([{ ops: { fetch: [
        [{ send: { event: 'ok', exists: true } }],
        [{ send: { event: 'ok', exists: false } }],
      ] } }]);
      assert.strictEqual(await host.fetch('C:\\r\\dump.cf', 'D:\\l\\dump.cf'), true);
      assert.strictEqual(await host.fetch('C:\\r\\none.cf', 'D:\\l\\none.cf'), false);
      const requests = rig.received().filter((request) => request.op === 'fetch');
      assert.deepStrictEqual([requests[0].remotePath, requests[0].localPath], ['C:\\r\\dump.cf', 'D:\\l\\dump.cf']);
    });

    test('rmtemp передаёт каталог', async () => {
      create();
      await host.rmtemp('C:\\Temp\\v8vscedit-9');
      assert.strictEqual(rig.received().find((request) => request.op === 'rmtemp')?.dir, 'C:\\Temp\\v8vscedit-9');
    });
  });

  suite('поток вывода: шум, фрагментация, очередь', () => {
    test('строки без маркера уходят в log и не мешают ответу', async () => {
      create([{ ops: { mktemp: [[
        { noise: 'ПРЕДУПРЕЖДЕНИЕ: профиль не загружен' },
        { send: { event: 'ok', dir: 'C:\\d' } },
        { noise: 'хвостовой шум' },
      ]] } }]);
      assert.strictEqual(await host.mktemp(), 'C:\\d');
      await host.ping();
      assert.ok(logs.some((line) => line.includes('ПРЕДУПРЕЖДЕНИЕ: профиль не загружен')), logs.join('|'));
      assert.ok(logs.some((line) => line.includes('хвостовой шум')));
    });

    test('ответ, разорванный на три записи посреди маркера и JSON, собирается', async () => {
      create([{ ops: { mktemp: [[{ split: 3, send: { event: 'ok', dir: 'C:\\Темп\\v8vscedit-кириллица' } }]] } }]);
      assert.strictEqual(await host.mktemp(), 'C:\\Темп\\v8vscedit-кириллица');
    });

    test('запросы строго по очереди: второй уходит в stdin только после ответа на первый', async () => {
      create([{ ops: { mktemp: [[{ wait: 200 }, { send: { event: 'ok', dir: 'C:\\first' } }]] } }]);
      const first = host.mktemp();
      const second = host.ping();
      assert.strictEqual(await first, 'C:\\first');
      await second;
      const events = rig.log().filter((entry) => entry.ev === 'recv' || entry.ev === 'replied');
      const order = events.map((entry) => `${entry.ev}:${(entry.ev === 'recv' ? entry.req?.op : entry.op) ?? ''}`);
      assert.ok(order.indexOf('recv:ping') > order.indexOf('replied:mktemp'), order.join(' '));
    });

    test('stderr хоста уходит в log с префиксом [powershell][stderr], пустые и пробельные строки отбрасываются', async () => {
      create([{ ops: { mktemp: [[{ stderr: 'Ошибка модуля\n\n   \nвторая строка' }, { wait: 100 }, { send: { event: 'ok', dir: 'C:\\d' } }]] } }]);
      await host.mktemp();
      await waitUntil(() => logs.some((line) => line.includes('вторая строка')), 'строки stderr в журнале');
      const stderrLines = logs.filter((line) => line.startsWith('[powershell][stderr]'));
      assert.deepStrictEqual(stderrLines, ['[powershell][stderr] Ошибка модуля', '[powershell][stderr] вторая строка']);
    });

    test('чужие для операции события игнорируются: started до ok у mktemp, ok до exit у run', async () => {
      create([{ ops: {
        mktemp: [[{ send: { event: 'started', pid: 1 } }, { send: { event: 'ok', dir: 'C:\\ok' } }]],
        run: [[{ send: { event: 'ok' } }, { send: { event: 'exit', code: 4, logB64: '' } }]],
      } }]);
      assert.strictEqual(await host.mktemp(), 'C:\\ok');
      const result = await host.run({ exe: 'x.exe', commandLine: '', logPath: 'C:\\l\\out.log' });
      assert.strictEqual(result.exitCode, 4);
    });

    test('id запросов уникальны и растут', async () => {
      create();
      await host.ping();
      await host.ping();
      const ids = rig.received().map((request) => request.id);
      assert.strictEqual(new Set(ids).size, ids.length);
      assert.deepStrictEqual([...ids].sort((a, b) => a - b), ids);
    });
  });

  suite('ошибки и восстановление', () => {
    test('error отклоняет ТОЛЬКО свой запрос (код remote-error, текст хоста), хост продолжает работу в том же процессе', async () => {
      create([{ ops: { rmtemp: [[{ send: { event: 'error', message: 'Каталог занят процессом' } }]] } }]);
      await expectHostError(() => host.rmtemp('C:\\d'), 'remote-error', /Каталог занят процессом/);
      await host.ping();
      assert.strictEqual(rig.starts().length, 1, 'процесс не должен перезапускаться из-за обычной ошибки операции');
    });

    test('connect отклонён с auth: true — auth-failed, процесс негоден, следующий запрос — новый процесс (без автоповтора внутри запроса)', async () => {
      create([{ ops: { connect: [[{ send: { event: 'error', message: 'Отказано в доступе', auth: true } }]] } }, {}]);
      await expectHostError(() => host.ping(), 'auth-failed', /Отказано в доступе/);
      assert.strictEqual(rig.starts().length, 1, 'повторного входа внутри запроса нет');
      await host.ping();
      assert.strictEqual(rig.starts().length, 2);
    });

    test('обычная ошибка connect без auth — remote-error', async () => {
      create([{ ops: { connect: [[{ send: { event: 'error', message: 'WinRM недоступен' } }]] } }]);
      await expectHostError(() => host.ping(), 'remote-error', /WinRM недоступен/);
    });

    // Н62: put и run НЕ повторяются (put — запись, run мог запустить 1cv8): для них разрыв — отказ запроса,
    // а новый процесс поднимает только следующий запрос.
    test('sessionBroken на put (не повторяется): запрос отклонён, следующий запускает НОВЫЙ процесс и повторяет connect', async () => {
      create([
        { ops: { put: [[{ send: { event: 'sessionBroken', message: 'Сеанс WinRM закрыт' } }]] } },
        {},
      ]);
      await expectHostError(() => host.put('C:\\d', 'a.txt', 'x'), 'session-broken', /Сеанс WinRM закрыт/);
      assert.strictEqual(rig.starts().length, 1, 'put не повторяется');
      assert.strictEqual(await host.mktemp(), 'C:\\Temp\\v8vscedit-fake');
      assert.strictEqual(rig.starts().length, 2);
      assert.deepStrictEqual(rig.received(1).map((request) => request.op), ['connect', 'mktemp']);
    });

    test('перезапуск ровно один на запрос (put): новый процесс снова ломается — запрос отклонён, цикла нет', async () => {
      create([
        { ops: { put: [[{ send: { event: 'sessionBroken', message: 'разрыв 1' } }]] } },
        { ops: { connect: [[{ send: { event: 'sessionBroken', message: 'разрыв 2' } }]] } },
        {},
      ]);
      await expectHostError(() => host.put('C:\\d', 'a.txt', 'x'), 'session-broken');
      await expectHostError(() => host.put('C:\\d', 'a.txt', 'x'), 'session-broken', /разрыв 2/);
      assert.strictEqual(rig.starts().length, 2, 'за один запрос — не более одного нового процесса');
      await host.ping();
      assert.strictEqual(rig.starts().length, 3);
    });

    test('процесс завершился посреди put: host-exited без повтора, следующий запрос — новый процесс', async () => {
      create([{ ops: { put: [[{ exit: 1 }]] } }, {}]);
      await expectHostError(() => host.put('C:\\d', 'a.txt', 'x'), 'host-exited');
      assert.strictEqual(await host.mktemp(), 'C:\\Temp\\v8vscedit-fake');
      assert.strictEqual(rig.starts().length, 2);
    });

    suite('Н62: однократный повтор безопасных запросов после разрыва', () => {
      const safe: { op: string; call: () => Promise<unknown> }[] = [
        { op: 'ping', call: () => host.ping() },
        { op: 'mktemp', call: () => host.mktemp() },
        { op: 'resolveV8', call: () => host.resolveV8({ v8Path: 'C:\\1c\\1cv8.exe' }) },
        { op: 'rmtemp', call: () => host.rmtemp('C:\\Temp\\v8vscedit-1') },
        { op: 'fetch', call: () => host.fetch('C:\\Temp\\v8vscedit-1\\dump.cf', 'D:\\l\\dump.cf') },
      ];
      for (const row of safe) {
        test(`${row.op}: sessionBroken (истёк IdleTimeout сессии) → один повтор на новом процессе с connect, успех`, async () => {
          create([{ ops: { [row.op]: [[{ send: { event: 'sessionBroken', message: 'сессия закрыта сервером' } }]] } }, {}]);
          await row.call();
          assert.strictEqual(rig.starts().length, 2);
          assert.deepStrictEqual(rig.received(1).map((request) => request.op), ['connect', row.op]);
          assert.ok(logs.some((line) => line.includes('повтор') && line.includes(row.op)), logs.join('|'));
        });
      }

      test('mktemp: процесс хоста завершился посреди запроса (host-exited) → повтор, успех', async () => {
        create([{ ops: { mktemp: [[{ exit: 1 }]] } }, {}]);
        assert.strictEqual(await host.mktemp(), 'C:\\Temp\\v8vscedit-fake');
        assert.strictEqual(rig.starts().length, 2);
      });

      test('повтор ровно один: новый процесс тоже рвётся — запрос отклонён (второй разрыв), третьего процесса нет', async () => {
        create([
          { ops: { ping: [[{ send: { event: 'sessionBroken', message: 'разрыв 1' } }]] } },
          { ops: { ping: [[{ send: { event: 'sessionBroken', message: 'разрыв 2' } }]] } },
          {},
        ]);
        await expectHostError(() => host.ping(), 'session-broken', /разрыв 2/);
        assert.strictEqual(rig.starts().length, 2);
      });

      test('обычная ошибка операции (remote-error) не повторяется', async () => {
        create([{ ops: { mktemp: [[{ send: { event: 'error', message: 'нет доступа' } }]] } }]);
        await expectHostError(() => host.mktemp(), 'remote-error', /нет доступа/);
        assert.strictEqual(rig.received().filter((request) => request.op === 'mktemp').length, 1);
      });

      test('auth-failed на connect не повторяется (риск блокировки учётки)', async () => {
        create([{ ops: { connect: [[{ send: { event: 'error', message: 'Отказано', auth: true } }]] } }, {}]);
        await expectHostError(() => host.mktemp(), 'auth-failed');
        assert.strictEqual(rig.starts().length, 1);
      });

      test('run: sessionBroken НЕ повторяется (1cv8 мог быть запущен) — ошибка, процесс один', async () => {
        create([{ ops: { run: [[{ send: { event: 'started', pid: 7 } }, { send: { event: 'sessionBroken', message: 'разрыв во время run' } }]] } }, {}]);
        await expectHostError(
          () => host.run({ exe: 'x.exe', commandLine: '', logPath: 'C:\\l\\out.log' }),
          'session-broken',
          /разрыв во время run/
        );
        assert.strictEqual(rig.starts().length, 1);
        assert.strictEqual(rig.received().filter((request) => request.op === 'run').length, 1);
      });
    });

    test('процесс завершился в простое: следующий запрос запускает новый', async () => {
      create([{ ops: { ping: [[{ send: { event: 'ok', pid: 1 } }, { wait: 50 }, { exit: 0 }]] } }, {}]);
      await host.ping();
      await waitUntil(() => host.getProcessId() === undefined, 'завершение процесса хоста');
      await host.ping();
      assert.strictEqual(rig.starts().length, 2);
    });

    test('строка с маркером и битым JSON: protocol, процесс негоден, следующий запрос — новый процесс', async () => {
      create([{ ops: { mktemp: [[{ raw: '@@V8VSC@@{"id":1,' }]] } }, {}]);
      await expectHostError(() => host.mktemp(), 'protocol');
      assert.strictEqual(await host.mktemp(), 'C:\\Temp\\v8vscedit-fake');
      assert.strictEqual(rig.starts().length, 2);
    });

    test('spawn бросает не-Error (строку): текст попадает в сообщение spawn-failed как есть', async () => {
      const throwingString: HostSpawn = () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- проверяется именно не-Error исключение
        throw 'строковая ошибка запуска';
      };
      host = new PowerShellRemoteHost({ connection: CONNECTION, powershellPath: 'ps.exe', spawn: throwingString });
      await expectHostError(() => host.ping(), 'spawn-failed', /строковая ошибка запуска/);
    });

    test('исключение в колбэке вызывающего (onOutput) делает процесс негодным (protocol), следующий запрос — новый процесс', async () => {
      create([{ ops: { run: [[
        { send: { event: 'started', pid: 5 } },
        { send: { event: 'output', stream: 'stdout', textB64: b64('строка') } },
        { send: { event: 'exit', code: 0, logB64: '' } },
      ]] } }, {}]);
      await expectHostError(
        () => host.run({ exe: 'x.exe', commandLine: '', logPath: 'C:\\l\\out.log', onOutput: () => { throw new Error('сбой колбэка'); } }),
        'protocol',
        /сбой колбэка/
      );
      await host.ping();
      assert.strictEqual(rig.starts().length, 2);
    });

    test('spawn бросает синхронно: spawn-failed с командой в сообщении, хост не ломается — следующий запрос пробует снова', async () => {
      let attempts = 0;
      const throwing: HostSpawn = () => {
        attempts += 1;
        throw new Error('EINVAL при запуске');
      };
      host = new PowerShellRemoteHost({ connection: CONNECTION, powershellPath: 'broken-ps.exe', spawn: throwing });
      await expectHostError(() => host.ping(), 'spawn-failed', /broken-ps\.exe.*EINVAL при запуске/);
      await expectHostError(() => host.mktemp(), 'spawn-failed');
      assert.strictEqual(attempts, 2);
    });

    test('powershellPath не существует: spawn-failed с путём в сообщении, без зависания; следующий запрос пробует снова', async () => {
      const missing = path.join(sandbox, 'нет-такого-powershell.exe');
      const spawnMissing: HostSpawn = (command, args, options) => childProcess.spawn(command, args, options);
      host = new PowerShellRemoteHost({ connection: CONNECTION, powershellPath: missing, spawn: spawnMissing });
      await expectHostError(() => host.ping(), 'spawn-failed', /нет-такого-powershell\.exe/);
      await expectHostError(() => host.ping(), 'spawn-failed');
    });

    test('ответ с чужим id игнорируется и не завершает чужой запрос', async () => {
      create([{ ops: { mktemp: [[
        { send: { id: 999, event: 'ok', dir: 'C:\\wrong' } },
        { send: { event: 'ok', dir: 'C:\\right' } },
      ]] } }]);
      assert.strictEqual(await host.mktemp(), 'C:\\right');
      await host.ping();
    });
  });

  suite('run: события, вывод, отмена', () => {
    const RUN = { exe: 'C:\\1c\\1cv8.exe', commandLine: 'DESIGNER /F "C:\\Тест База"', logPath: 'C:\\Temp\\v8vscedit-1\\out.log' };

    test('запрос run несёт exe, commandLine и logPath; started → onStarted(pid), output → onOutput, exit → результат', async () => {
      const logBytes = Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x0d, 0x00, 0x0a, 0x00]);
      create([{ ops: { run: [[
        { send: { event: 'started', pid: 777 } },
        { send: { event: 'output', stream: 'stdout', textB64: b64('первая строка') } },
        { send: { event: 'output', stream: 'stderr', textB64: b64('вторая «строка»') } },
        { send: { event: 'exit', code: 7, logB64: b64(logBytes) } },
      ]] } }]);
      const started: number[] = [];
      const lines: [string, string][] = [];

      const result = await host.run({ ...RUN, onStarted: (pid) => started.push(pid), onOutput: (line, stream) => lines.push([stream, line]) });

      const sent = rig.received().find((request) => request.op === 'run');
      assert.deepStrictEqual([sent?.exe, sent?.commandLine, sent?.logPath], [RUN.exe, RUN.commandLine, RUN.logPath]);
      assert.deepStrictEqual(started, [777]);
      assert.deepStrictEqual(lines, [['stdout', 'первая строка'], ['stderr', 'вторая «строка»']]);
      assert.strictEqual(result.exitCode, 7);
      assert.strictEqual(result.interrupted, false);
      assert.strictEqual(result.pid, 777);
      assert.ok(result.logBytes.equals(logBytes), 'байты лога не должны меняться');
    });

    test('exit с interrupted: результат помечен прерванным', async () => {
      create([{ ops: { run: [[
        { send: { event: 'started', pid: 5 } },
        { send: { event: 'exit', code: -1, logB64: '', interrupted: true } },
      ]] } }]);
      const result = await host.run(RUN);
      assert.strictEqual(result.interrupted, true);
      assert.strictEqual(result.logBytes.length, 0);
    });

    test('запуск без колбэков не падает на started/output', async () => {
      create([{ ops: { run: [[
        { send: { event: 'started', pid: 5 } },
        { send: { event: 'output', stream: 'stdout', textB64: b64('x') } },
        { send: { event: 'exit', code: 0, logB64: '' } },
      ]] } }]);
      assert.strictEqual((await host.run(RUN)).exitCode, 0);
    });

    function holdScenario(): FakeHostSpawnScenario[] {
      return [{ ops: { run: [[
        { send: { event: 'started', pid: 99 } },
        { holdUntilCancel: true, onCancel: [{ send: { event: 'exit', code: -1, logB64: '', interrupted: true } }] },
      ]] } }];
    }

    function controllableToken(): { token: { isCancellationRequested: boolean; onCancellationRequested(l: () => void): { dispose(): void } }; cancel: () => void } {
      let listener: (() => void) | undefined;
      const token = {
        isCancellationRequested: false,
        onCancellationRequested(next: () => void) {
          listener = next;
          return { dispose: () => { listener = undefined; } };
        },
      };
      return { token, cancel: () => { token.isCancellationRequested = true; listener?.(); } };
    }

    test('отмена: cancel{target = id run} уходит ВНЕ очереди (даже когда за run ждёт другой запрос), run завершается interrupted', async () => {
      create(holdScenario());
      const { token, cancel } = controllableToken();
      const running = host.run({ ...RUN, cancellation: token, onStarted: () => { cancel(); } });
      const queued = host.ping();

      const result = await running;
      await queued;

      assert.strictEqual(result.interrupted, true);
      const received = rig.received();
      const run = received.find((request) => request.op === 'run');
      const cancelRequest = received.find((request) => request.op === 'cancel');
      assert.ok(run && cancelRequest, 'run и cancel должны дойти до хоста');
      assert.strictEqual(cancelRequest.target, run.id);
      const order = rig.log().filter((entry) => entry.ev === 'recv' || entry.ev === 'replied')
        .map((entry) => `${entry.ev}:${(entry.ev === 'recv' ? entry.req?.op : entry.op) ?? ''}`);
      assert.ok(order.indexOf('recv:cancel') < order.indexOf('replied:run'), order.join(' '));
      assert.ok(order.indexOf('recv:ping') > order.indexOf('replied:run'), 'ping остался в очереди до конца run');
    });

    test('токен уже отменён до run: запрос run не отправляется, результат прерван', async () => {
      create();
      const { token, cancel } = controllableToken();
      cancel();
      const result = await host.run({ ...RUN, cancellation: token });
      assert.strictEqual(result.interrupted, true);
      assert.ok(!rig.received().some((request) => request.op === 'run'), 'run не должен был уйти на сервер');
    });

    test('отмена, пока run ждёт в очереди: запрос run не отправляется, результат прерван, очередь не ломается', async () => {
      create([{ ops: { mktemp: [[{ wait: 300 }, { send: { event: 'ok', dir: 'C:\\busy' } }]] } }]);
      const busy = host.mktemp();
      const { token, cancel } = controllableToken();
      const queued = host.run({ ...RUN, cancellation: token });
      cancel();
      const result = await queued;
      assert.strictEqual(await busy, 'C:\\busy');
      assert.strictEqual(result.interrupted, true);
      assert.ok(!rig.received().some((request) => request.op === 'run'), 'run не должен был уйти на сервер');
      await host.ping();
    });

    test('отмена после завершения run не шлёт cancel и не падает', async () => {
      create();
      const { token, cancel } = controllableToken();
      await host.run({ ...RUN, cancellation: token });
      cancel();
      await host.ping();
      assert.ok(!rig.received().some((request) => request.op === 'cancel'));
    });
  });

  suite('dispose', () => {
    test('хост не выходит по закрытию stdin: через disposeGraceMs процесс убивается, dispose не зависает', async () => {
      create([{ ignoreStdinEnd: true }], { disposeGraceMs: 200 });
      await host.ping();
      const pid = host.getProcessId();
      assert.ok(pid);
      const startedAt = Date.now();
      await host.dispose();
      assert.ok(Date.now() - startedAt >= 150, 'dispose обязан сначала дать хосту шанс выйти самому');
      await waitUntil(() => rig.log().some((entry) => entry.ev === 'stdin-end'), 'закрытие stdin хоста');
      await waitUntil(() => !isAlive(pid), 'принудительное завершение зависшего хоста');
    });

    test('без единого запроса: процесс не запускался, dispose завершается', async () => {
      create();
      await host.dispose();
      assert.strictEqual(rig.spawnCalls.length, 0);
    });

    test('закрывает stdin процесса (он завершается), повторный dispose безопасен', async () => {
      create();
      await host.ping();
      await host.dispose();
      await waitUntil(() => rig.log().some((entry) => entry.ev === 'stdin-end'), 'закрытие stdin хоста');
      assert.strictEqual(host.getProcessId(), undefined);
      await host.dispose();
    });

    test('после dispose запросы отклоняются (disposed), новый процесс не запускается', async () => {
      create();
      await host.ping();
      await host.dispose();
      await expectHostError(() => host.ping(), 'disposed');
      assert.strictEqual(rig.starts().length, 1);
    });

    test('dispose отклоняет ожидающий ответа запрос кодом disposed', async () => {
      create([{ ops: { mktemp: [[{ holdUntilCancel: true }]] } }]);
      const outcome = host.mktemp().then(() => undefined, (error: unknown) => error);
      await waitUntil(() => rig.received().some((request) => request.op === 'mktemp'), 'запрос дошёл до хоста');
      await host.dispose();
      const error = await outcome;
      assert.ok(error instanceof PowerShellHostError);
      assert.strictEqual(error.code, 'disposed');
    });
  });
});
