/**
 * Э9: PowerShellRemoteHost + host-скрипт на НАСТОЯЩЕМ powershell.exe без удалённой сессии
 * (`computerName: ''` — скрипт-блоки исполняются в процессе хоста). Контракт класса — в шапке
 * powerShellRemoteHost.fake.test.ts. Поддельный «1cv8» — Node-скрипт (fakeDesignerProcess.ts), плюс один
 * `.cmd` для проверки запуска батника через Process.Start.
 *
 * Только Windows (powershell.exe 5.1, Process.Start, taskkill, %TEMP%); на остальных платформах сьют
 * пропускается с обоснованием. Прогон от SYSTEM безопасен: %TEMP%/%TMP% хоста переопределены каталогом
 * песочницы (реальный %TEMP% не засоряется), хост обязан запускаться с -NoProfile -ExecutionPolicy Bypass.
 *
 * Требования к host-скрипту, закрепляемые здесь:
 *  - `mktemp` создаёт `<TEMP>\v8vscedit-<guid>`; `connect` удаляет «осиротевшие» `v8vscedit-*` старше суток
 *    и только их (свежие и чужие имена остаются);
 *  - хост пишет (`put`), читает (`fetch`) и удаляет (`rmtemp`) ТОЛЬКО внутри каталогов `v8vscedit-*` во
 *    временном каталоге: любой другой путь, имя с разделителем или `..` — ошибка `remote-error`, файлы не
 *    затрагиваются;
 *  - `put`/`fetch` бинарно-безопасны (BOM-подобные байты, нули, большие файлы — не через base64 ответа);
 *  - `run`: процесс запускается с готовой командной строкой, вывод стримится событиями, по завершении
 *    возвращается код и байты `logPath`; `cancel` убивает ДЕРЕВО процессов (в том числе внуков) и даёт
 *    `exit` с interrupted; ненайденный exe — `remote-error`, хост остаётся рабочим;
 *  - падение процесса хоста: следующий запрос поднимает новый; `dispose` завершает процесс.
 */
import * as assert from 'assert';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildWindowsCommandLine } from '../../infra/process/WindowsCommandLine';
import {
  PowerShellHostError,
  PowerShellRemoteHost,
  type HostSpawn,
  type PowerShellHostConnection,
} from '../../infra/process/remote/PowerShellRemoteHost';
import {
  FakeDesigner,
  isProcessAlive,
  killQuietly,
  toBase64,
  waitUntil,
  type FakeDesignerConfig,
} from './support/fakeDesignerProcess';
import {
  IN_PROCESS_CONNECTION,
  WINDOWS_POWERSHELL_SKIP_REASON,
  listHostWorkDirs,
  sandboxedHostEnv,
  windowsPowerShellAvailable,
} from './support/powerShellTestEnv';

const DAY_MS = 24 * 60 * 60 * 1000;

suite('Э9: PowerShellRemoteHost на настоящем powershell.exe (без удалённой сессии)', function () {
  this.timeout(180_000);
  let sandbox: string;
  let tempDir: string;
  let fake: FakeDesigner;
  let host: PowerShellRemoteHost;
  let started = false;
  const logs: string[] = [];
  const leakedPids: number[] = [];

  suiteSetup(function () {
    if (!windowsPowerShellAvailable()) {
      // WINDOWS_POWERSHELL_SKIP_REASON: хост PowerShell — Windows-специфика, проверять нечего.
      this.skip();
    }
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-pshost-')));
    fake = new FakeDesigner(path.join(sandbox, 'fake'));
    started = true;
  });

  suiteTeardown(() => {
    if (started) {
      fake.restoreEnv();
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  setup(() => {
    tempDir = path.join(sandbox, `temp-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`);
    logs.length = 0;
    host = createHost();
  });

  teardown(async () => {
    await host.dispose();
    for (const pid of leakedPids.splice(0)) {
      killQuietly(pid);
    }
  });

  function createHost(overrides: { connection?: Partial<PowerShellHostConnection>; spawn?: HostSpawn } = {}): PowerShellRemoteHost {
    return new PowerShellRemoteHost({
      connection: { ...IN_PROCESS_CONNECTION, ...overrides.connection },
      env: sandboxedHostEnv(tempDir),
      spawn: overrides.spawn,
      log: (line) => logs.push(line),
    });
  }

  function configure(config: FakeDesignerConfig): void {
    fake.configure(config);
  }

  /** Командная строка: путь к скрипту поддельного 1cv8 и аргументы. */
  const commandLine = (...rest: string[]): string => buildWindowsCommandLine([fake.scriptPath, ...rest]);

  async function expectRemoteError(action: () => Promise<unknown>): Promise<PowerShellHostError> {
    try {
      await action();
    } catch (error) {
      assert.ok(error instanceof PowerShellHostError, String(error));
      assert.strictEqual(error.code, 'remote-error', error.message);
      return error;
    }
    return assert.fail('ожидалось исключение');
  }

  suite('запуск, пинг, временные каталоги', () => {
    test('ping: хост запущен без профиля и интерактива; pid ответа — pid процесса powershell', async () => {
      const { pid } = await host.ping();
      assert.strictEqual(pid, host.getProcessId());
      assert.ok(isProcessAlive(pid));
    });

    test('mktemp создаёт <TEMP>\\v8vscedit-<guid> (TEMP — из окружения хоста); rmtemp убирает со всем содержимым', async () => {
      const dir = await host.mktemp();
      assert.strictEqual(path.dirname(dir).toLowerCase(), tempDir.toLowerCase());
      assert.match(path.basename(dir), /^v8vscedit-[0-9a-f-]{8,}$/i);
      assert.ok(fs.statSync(dir).isDirectory());
      await host.put(dir, 'a.txt', 'данные');
      await host.rmtemp(dir);
      assert.strictEqual(fs.existsSync(dir), false);
    });

    test('rmtemp несуществующего каталога v8vscedit-* идемпотентен', async () => {
      const dir = await host.mktemp();
      await host.rmtemp(dir);
      await host.rmtemp(dir);
    });

    test('два mktemp дают разные каталоги', async () => {
      const first = await host.mktemp();
      const second = await host.mktemp();
      assert.notStrictEqual(first, second);
      assert.strictEqual(listHostWorkDirs(tempDir).length, 2);
    });

    test('connect удаляет осиротевшие v8vscedit-* старше суток и ТОЛЬКО их', async () => {
      fs.mkdirSync(tempDir, { recursive: true });
      const old = path.join(tempDir, 'v8vscedit-00000000-old');
      const fresh = path.join(tempDir, 'v8vscedit-00000000-fresh');
      const foreignOld = path.join(tempDir, 'other-tool-old');
      for (const dir of [old, fresh, foreignOld]) {
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'file.bin'), 'x');
      }
      const longAgo = new Date(Date.now() - 2 * DAY_MS);
      fs.utimesSync(old, longAgo, longAgo);
      fs.utimesSync(foreignOld, longAgo, longAgo);

      await host.ping();

      assert.strictEqual(fs.existsSync(old), false, 'старый v8vscedit-* должен быть убран');
      assert.strictEqual(fs.existsSync(fresh), true, 'свежий каталог (возможно, другого запуска) трогать нельзя');
      assert.strictEqual(fs.existsSync(foreignOld), true, 'чужие каталоги трогать нельзя');
    });
  });

  suite('put, fetch и границы доступа хоста', () => {
    test('put: кириллица в имени, UTF-8 строка и бинарное содержимое байт-в-байт (BOM-подобные байты, нули)', async () => {
      const dir = await host.mktemp();
      const binary = Uint8Array.from([0xef, 0xbb, 0xbf, 0x00, 0x01, 0xff, 0xfe, 0x0d, 0x0a, 0x80, 0x00, 0x00]);
      await host.put(dir, 'объекты и данные.xml', 'Справочник.Товары');
      await host.put(dir, 'payload.bin', binary);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'объекты и данные.xml'), 'utf-8'), 'Справочник.Товары');
      assert.ok(fs.readFileSync(path.join(dir, 'объекты и данные.xml')).subarray(0, 3).toString('hex') !== 'efbbbf', 'строка — без BOM');
      assert.ok(fs.readFileSync(path.join(dir, 'payload.bin')).equals(Buffer.from(binary)));
    });

    test('put перезаписывает существующий файл', async () => {
      const dir = await host.mktemp();
      await host.put(dir, 'a.txt', 'one');
      await host.put(dir, 'a.txt', 'two');
      assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf-8'), 'two');
    });

    test('fetch: файл сервера копируется в локальный путь байт-в-байт (3 МБ, не через ответ протокола), результат true', async () => {
      const dir = await host.mktemp();
      const big = Buffer.alloc(3 * 1024 * 1024);
      for (let index = 0; index < big.length; index += 1) {
        big[index] = (index * 31 + (index >> 8)) & 0xff;
      }
      fs.writeFileSync(path.join(dir, 'dump.cf'), big);
      const local = path.join(sandbox, 'fetched-dump.cf');

      assert.strictEqual(await host.fetch(path.join(dir, 'dump.cf'), local), true);
      assert.ok(fs.readFileSync(local).equals(big));
    });

    test('fetch несуществующего файла внутри рабочего каталога: false, локальный файл не создаётся', async () => {
      const dir = await host.mktemp();
      const local = path.join(sandbox, 'absent.cf');
      assert.strictEqual(await host.fetch(path.join(dir, 'нет.cf'), local), false);
      assert.strictEqual(fs.existsSync(local), false);
    });

    test('put с именем-путём (разделитель, ..) отклоняется, ничего не пишется вне каталога', async () => {
      const dir = await host.mktemp();
      for (const name of ['..\\evil.txt', '../evil.txt', 'a\\b.txt', 'a/b.txt', '', '..']) {
        await expectRemoteError(() => host.put(dir, name, 'x'));
      }
      assert.strictEqual(fs.existsSync(path.join(path.dirname(dir), 'evil.txt')), false);
    });

    test('put в каталог вне v8vscedit-* отклоняется', async () => {
      await host.ping();
      const outside = path.join(sandbox, 'outside');
      fs.mkdirSync(outside, { recursive: true });
      await expectRemoteError(() => host.put(outside, 'x.txt', 'x'));
      assert.deepStrictEqual(fs.readdirSync(outside), []);
    });

    test('rmtemp каталога вне v8vscedit-* (чужой каталог, сам TEMP, обход через ..) отклоняется, данные целы', async () => {
      const dir = await host.mktemp();
      const outside = path.join(sandbox, 'precious');
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, 'keep.txt'), 'важное');
      const traversal = `${dir}\\..\\..\\precious`;

      for (const target of [outside, tempDir, traversal, path.join(tempDir, 'not-ours')]) {
        await expectRemoteError(() => host.rmtemp(target));
      }
      assert.strictEqual(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf-8'), 'важное');
      assert.ok(fs.existsSync(dir));
    });

    test('fetch файла вне v8vscedit-* отклоняется', async () => {
      await host.ping();
      const secret = path.join(sandbox, 'secret.txt');
      fs.writeFileSync(secret, 'секрет');
      const local = path.join(sandbox, 'stolen.txt');
      await expectRemoteError(() => host.fetch(secret, local));
      assert.strictEqual(fs.existsSync(local), false);
    });
  });

  suite('resolveV8', () => {
    test('существующий файл: возвращается путь; несуществующий и каталог → undefined', async () => {
      const exe = path.join(sandbox, 'bin', '1cv8.exe');
      fs.mkdirSync(path.dirname(exe), { recursive: true });
      fs.writeFileSync(exe, '');
      assert.strictEqual((await host.resolveV8({ v8Path: exe }))?.toLowerCase(), exe.toLowerCase());
      assert.strictEqual(await host.resolveV8({ v8Path: path.join(sandbox, 'bin', 'нет.exe') }), undefined);
      assert.strictEqual(await host.resolveV8({ v8Path: path.dirname(exe) }), undefined);
    });

    test('по версии платформы: несуществующая версия → undefined (путь выводится из стандартного каталога установки)', async () => {
      assert.strictEqual(await host.resolveV8({ v8Version: '0.0.0.1' }), undefined);
    });
  });

  suite('run', () => {
    async function runFake(config: FakeDesignerConfig, rest: string[], extra: { onOutput?: (line: string) => void } = {}) {
      configure(config);
      const dir = await host.mktemp();
      const logPath = path.join(dir, 'out.log');
      const result = await host.run({
        exe: process.execPath,
        commandLine: commandLine(...rest, '/Out', logPath, '/DisableStartupDialogs'),
        logPath,
        onOutput: extra.onOutput,
      });
      return { result, dir, logPath };
    }

    test('код 0, лог UTF-16LE с BOM возвращается байтами; вывод процесса стримится; pid процесса известен', async () => {
      const logBytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Захват выполнен\r\n', 'utf16le')]);
      const lines: string[] = [];
      const { result } = await runFake(
        { logBase64: toBase64(logBytes), stdout: 'вывод из stdout', stderr: 'вывод из stderr' },
        ['/ConfigurationRepositoryLock'],
        { onOutput: (line) => lines.push(line.trim()) }
      );
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.interrupted, false);
      assert.ok(result.logBytes.equals(logBytes), 'байты лога искажены');
      assert.ok(lines.includes('вывод из stdout'), JSON.stringify(lines));
      assert.ok(lines.includes('вывод из stderr'), JSON.stringify(lines));
      assert.strictEqual(result.pid, fake.readRecord().pid);
    });

    test('лог в cp1251 возвращается теми же байтами (декодирование — забота вызывающего, не хоста)', async () => {
      const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0d, 0x0a]);
      const { result } = await runFake({ logBase64: toBase64(cp1251) }, ['/X']);
      assert.ok(result.logBytes.equals(cp1251));
    });

    test('ненулевой код возврата', async () => {
      const { result } = await runFake({ exitCode: 7 }, ['/X']);
      assert.strictEqual(result.exitCode, 7);
      assert.strictEqual(result.interrupted, false);
    });

    test('процесс не создал лог: logBytes пуст', async () => {
      const { result } = await runFake({}, ['/X']);
      assert.strictEqual(result.logBytes.length, 0);
    });

    test('аргументы с кавычками, пробелами, обратной косой и кириллицей доходят до процесса неизменными', async () => {
      const tricky = ['', 'a b', 'a"b', 'a\\"b', 'путь с пробелом\\', '/Pпа"роль', 'C:\\Тест Папка\\'];
      await runFake({}, ['/First', ...tricky, '/Last']);
      assert.deepStrictEqual(fake.readRecord().argv.slice(0, tricky.length + 2), ['/First', ...tricky, '/Last']);
    });

    test('выходной файл, созданный процессом, забирается fetch', async () => {
      const bytes = Buffer.from([0x1f, 0x8b, 0x00, 0xff, 0x80]);
      configure({ outputsAfter: [{ key: '-File', contentBase64: toBase64(bytes) }] });
      const dir = await host.mktemp();
      const out = path.join(dir, 'dump.cf');
      const result = await host.run({ exe: process.execPath, commandLine: commandLine('-File', out), logPath: path.join(dir, 'out.log') });
      assert.strictEqual(result.exitCode, 0);
      const local = path.join(sandbox, 'result-dump.cf');
      assert.strictEqual(await host.fetch(out, local), true);
      assert.ok(fs.readFileSync(local).equals(bytes));
    });

    test('ненайденный исполняемый файл: remote-error, хост остаётся рабочим', async () => {
      const dir = await host.mktemp();
      await expectRemoteError(() => host.run({
        exe: path.join(sandbox, 'нет-такого-1cv8.exe'),
        commandLine: 'DESIGNER',
        logPath: path.join(dir, 'out.log'),
      }));
      await host.ping();
    });

    test('.cmd запускается через Process.Start: аргументы видны батнику, код выхода передаётся', async () => {
      const cmd = path.join(sandbox, 'fake 1cv8.cmd');
      const argsFile = path.join(sandbox, 'cmd-args.txt');
      fs.writeFileSync(cmd, `@echo off\r\necho %*> "${argsFile}"\r\nexit /b 3\r\n`, 'ascii');
      const dir = await host.mktemp();
      const result = await host.run({
        exe: cmd,
        commandLine: buildWindowsCommandLine(['DESIGNER', '/F', 'C:\\base dir', '/Out', path.join(dir, 'out.log')]),
        logPath: path.join(dir, 'out.log'),
      });
      assert.strictEqual(result.exitCode, 3);
      assert.match(fs.readFileSync(argsFile, 'utf-8'), /DESIGNER \/F "C:\\base dir" \/Out /);
    });

    test('отмена: процесс убит ВМЕСТЕ с дочерним (дерево), exit с interrupted, хост рабочий', async () => {
      configure({ hang: true, spawnChild: true });
      const dir = await host.mktemp();
      let cancelNow: (() => void) | undefined;
      const token = {
        isCancellationRequested: false,
        onCancellationRequested(listener: () => void) {
          cancelNow = () => { token.isCancellationRequested = true; listener(); };
          return { dispose: () => { cancelNow = undefined; } };
        },
      };
      const result = await host.run({
        exe: process.execPath,
        commandLine: commandLine('/X'),
        logPath: path.join(dir, 'out.log'),
        cancellation: token,
        // «ready» печатается после записи record: процесс и его дочерний гарантированно стартовали.
        onOutput: (line) => { if (line.trim() === 'ready') { cancelNow?.(); } },
      });

      const record = fake.readRecord();
      assert.ok(record.childPid, 'поддельный 1cv8 должен был породить дочерний процесс');
      leakedPids.push(record.pid, record.childPid);
      assert.strictEqual(result.interrupted, true);
      await waitUntil(() => !isProcessAlive(record.pid), 'завершение процесса 1cv8');
      const childPid = record.childPid;
      await waitUntil(() => !isProcessAlive(childPid), 'завершение дочернего процесса (kill дерева)');
      await host.ping();
    });
  });

  suite('устойчивость процесса хоста', () => {
    test('процесс убит снаружи в простое: следующий запрос поднимает новый процесс', async () => {
      const first = (await host.ping()).pid;
      process.kill(first);
      await waitUntil(() => !isProcessAlive(first), 'завершение хоста');
      const second = (await host.ping()).pid;
      assert.notStrictEqual(second, first);
    });

    test('процесс убит снаружи посреди run: запрос отклонён host-exited, следующий работает', async () => {
      configure({ hang: true });
      const dir = await host.mktemp();
      const hostPid = host.getProcessId();
      assert.ok(hostPid);
      const outcome = host.run({
        exe: process.execPath,
        commandLine: commandLine('/X'),
        logPath: path.join(dir, 'out.log'),
        onOutput: (line) => {
          if (line.trim() === 'ready') {
            process.kill(hostPid);
          }
        },
      }).then(() => undefined, (error: unknown) => error);

      const error = await outcome;
      if (fake.hasRecord()) {
        leakedPids.push(fake.readRecord().pid);
      }
      assert.ok(error instanceof PowerShellHostError);
      assert.strictEqual(error.code, 'host-exited');
      assert.notStrictEqual((await host.ping()).pid, hostPid);
    });

    test('dispose завершает процесс хоста, повторный безопасен, после него запросы отклоняются', async () => {
      const { pid } = await host.ping();
      await host.dispose();
      await waitUntil(() => !isProcessAlive(pid), 'завершение хоста после dispose');
      await host.dispose();
      await assert.rejects(() => host.ping(), (error: unknown) => error instanceof PowerShellHostError && error.code === 'disposed');
    });
  });

  suite('секреты', () => {
    test('пароль и пользователь передаются в connect по stdin: в векторе запуска и окружении powershell их нет, при пустом computerName они не мешают', async () => {
      const password = 'Секрет"$x`y & 12 3';
      const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
      const spawnRecording: HostSpawn = (command, args, options) => {
        calls.push({ command, args: [...args], env: options.env });
        return childProcess.spawn(command, args, options);
      };
      const secretHost = createHost({ connection: { user: 'CORP\\админ', password }, spawn: spawnRecording });
      try {
        await secretHost.ping();
      } finally {
        await secretHost.dispose();
      }
      assert.strictEqual(calls.length, 1);
      const surface = [calls[0].command, ...calls[0].args, ...Object.entries(calls[0].env).map(([key, value]) => `${key}=${String(value)}`), ...logs].join('\n');
      assert.ok(!surface.includes(password), 'пароль открытым текстом');
      assert.ok(!surface.includes(Buffer.from(password, 'utf-8').toString('base64')), 'пароль в base64');
      const encoded = Buffer.from(calls[0].args.at(-1) ?? '', 'base64').toString('utf16le');
      assert.ok(!encoded.includes(password));
    });
  });
});

// Платформенное обоснование пропуска вынесено в константу, чтобы отчёт о пропуске был понятен читателю лога.
void WINDOWS_POWERSHELL_SKIP_REASON;
