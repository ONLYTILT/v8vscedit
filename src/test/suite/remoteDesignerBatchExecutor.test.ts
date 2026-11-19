/**
 * Э9: RemoteDesignerBatchExecutor (infra/process/remote/RemoteDesignerBatchExecutor.ts, без vscode).
 *
 * Контракт:
 *   export interface RemoteDesignerHost {                      // подмножество PowerShellRemoteHost
 *     mktemp(): Promise<string>;
 *     put(dir: string, name: string, content: Uint8Array | string): Promise<void>;
 *     run(request: HostRunRequest): Promise<HostRunResult>;
 *     fetch(remotePath: string, localPath: string): Promise<boolean>;
 *     rmtemp(dir: string): Promise<void>;
 *   }
 *   export interface RemoteDesignerBatchExecutorOptions {
 *     tempRoot?: string;                       // ЛОКАЛЬНЫЙ корень staging выходных файлов; умолчание — os.tmpdir()
 *     log?: (line: string) => void;            // диагностика (сбой уборки сервера и т.п.); секретов не содержит
 *   }
 *   export class RemoteDesignerBatchExecutor implements DesignerBatchExecutor {
 *     constructor(host: RemoteDesignerHost, exePath: string /* путь к 1cv8 НА СЕРВЕРЕ *\/, options?: RemoteDesignerBatchExecutorOptions);
 *   }
 *   dispose() убирает локальный staging и НЕ закрывает хост: хост общий, им владеет реестр исполнителей.
 *
 * Последовательность run: проверка имён файлов (до любых обращений к хосту; те же правила и сообщения,
 * что у LocalDesignerBatchExecutor) → mktemp → put входных файлов → подстановка серверных путей
 * `<dir>\<имя>` вместо inputFile/outputFile и `/Out <dir>\out.log /DisableStartupDialogs` → командная строка
 * `buildWindowsCommandLine(args)` (тот же алгоритм квотирования, что у локального spawn) → host.run → fetch
 * каждого объявленного выходного файла в локальный staging (даже при ненулевом коде — как у локального
 * исполнителя; отсутствие файла на сервере — просто нет записи в outputs) → rmtemp в finally.
 * Лог декодируется `decodeDesignerLogBytes`, прерывание описывается тем же текстом, что у локального.
 * Сбой rmtemp не ломает успешную операцию (диагностика в log) и не подменяет исходную ошибку.
 * Секреты запроса (`request.secrets`) маскируются в тексте любых ошибок исполнителя.
 *
 * Здесь же — общий контрактный набор для ЛОКАЛЬНОЙ реализации и УДАЛЁННОЙ на настоящем powershell.exe
 * (без удалённой сессии); поддельный 1cv8 — Node-скрипт.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describeProcessInterruption } from '../../infra/process';
import type { DesignerBatchRequest } from '../../infra/process/designer/DesignerBatchExecutor';
import { LocalDesignerBatchExecutor } from '../../infra/process/designer/LocalDesignerBatchExecutor';
import { buildWindowsCommandLine } from '../../infra/process/WindowsCommandLine';
import {
  PowerShellRemoteHost,
} from '../../infra/process/remote/PowerShellRemoteHost';
import type { HostRunRequest, HostRunResult } from '../../infra/process/remote/PowerShellRemoteHost';
import {
  RemoteDesignerBatchExecutor,
  type RemoteDesignerHost,
} from '../../infra/process/remote/RemoteDesignerBatchExecutor';
import { describeDesignerExecutorContract, type ContractFixture } from './support/designerExecutorContract';
import {
  IN_PROCESS_CONNECTION,
  listHostWorkDirs,
  sandboxedHostEnv,
  windowsPowerShellAvailable,
} from './support/powerShellTestEnv';

// ---------------------------------------------------------------------------------------------------------
// Общий контракт: локальный исполнитель
// ---------------------------------------------------------------------------------------------------------
describeDesignerExecutorContract('LocalDesignerBatchExecutor', {
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  create: (testSandbox): ContractFixture => localFixture(testSandbox, process.execPath),
  createWithMissingExe: (testSandbox): ContractFixture => localFixture(testSandbox, path.join(testSandbox, 'нет-такого-1cv8.exe')),
});

function localFixture(testSandbox: string, exe: string): ContractFixture {
  const tempRoot = path.join(testSandbox, 'tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const executor = new LocalDesignerBatchExecutor(exe, { cwd: testSandbox, tempRoot });
  return {
    executor,
    leftovers: () => fs.readdirSync(tempRoot),
    teardown: () => executor.dispose(),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Общий контракт: удалённый исполнитель поверх настоящего хоста PowerShell (computerName = '')
// ---------------------------------------------------------------------------------------------------------
let remoteHost: PowerShellRemoteHost | undefined;
let remoteTemp = '';

describeDesignerExecutorContract('RemoteDesignerBatchExecutor + хост на настоящем powershell.exe', {
  start: ({ sandbox }) => {
    if (!windowsPowerShellAvailable()) {
      // Обоснование пропуска: хост PowerShell — Windows-специфика (powershell.exe 5.1, Process.Start, taskkill).
      const skip = new Error('Нет Windows PowerShell: удалённый исполнитель проверяется только на Windows.');
      skip.name = 'ContractSkip';
      throw skip;
    }
    remoteTemp = path.join(sandbox, 'remote-temp');
    // env хоста наследует ELECTRON_RUN_AS_NODE и FAKE_1C_CONFIG, выставленные FakeDesigner до запуска.
    remoteHost = new PowerShellRemoteHost({ connection: IN_PROCESS_CONNECTION, env: sandboxedHostEnv(remoteTemp) });
    return Promise.resolve();
  },
  stop: async () => {
    await remoteHost?.dispose();
    remoteHost = undefined;
  },
  create: (testSandbox): ContractFixture => remoteFixture(testSandbox, process.execPath),
  createWithMissingExe: (testSandbox): ContractFixture => remoteFixture(testSandbox, path.join(testSandbox, 'нет-такого-1cv8.exe')),
});

function remoteFixture(testSandbox: string, exe: string): ContractFixture {
  const host = remoteHost;
  assert.ok(host, 'хост не запущен');
  const localTemp = path.join(testSandbox, 'local-temp');
  fs.mkdirSync(localTemp, { recursive: true });
  const executor = new RemoteDesignerBatchExecutor(host, exe, { tempRoot: localTemp });
  return {
    executor,
    leftovers: () => [...listHostWorkDirs(remoteTemp), ...fs.readdirSync(localTemp)],
    teardown: () => executor.dispose(),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Удалённый исполнитель: последовательность обращений к хосту (записывающий поддельный хост)
// ---------------------------------------------------------------------------------------------------------
const SERVER_EXE = 'C:\\Program Files\\1cv8\\8.3.27.2130\\bin\\1cv8.exe';
const SERVER_DIR = 'C:\\Users\\svc\\AppData\\Local\\Temp\\v8vscedit-1111';
const OBJECTS_XML = '<Objects version="1.0">\n  <Object fullName="Справочник.Товары"/>\n</Objects>\n';

interface RecordedCall {
  readonly op: 'mktemp' | 'put' | 'run' | 'fetch' | 'rmtemp';
  readonly args: unknown[];
}

class RecordingHost implements RemoteDesignerHost {
  readonly calls: RecordedCall[] = [];
  /** Файлы «сервера», доступные fetch: имя файла → содержимое. */
  readonly serverFiles = new Map<string, Uint8Array>();
  runResult: HostRunResult = { exitCode: 0, interrupted: false, logBytes: Buffer.alloc(0), pid: 1 };
  failOn: Partial<Record<RecordedCall['op'], Error>> = {};
  onRun?: (request: HostRunRequest) => void;

  private record(op: RecordedCall['op'], ...args: unknown[]): void {
    this.calls.push({ op, args });
  }

  ops(): string[] {
    return this.calls.map((call) => call.op);
  }

  mktemp(): Promise<string> {
    this.record('mktemp');
    return this.failOn.mktemp ? Promise.reject(this.failOn.mktemp) : Promise.resolve(SERVER_DIR);
  }

  put(dir: string, name: string, content: Uint8Array | string): Promise<void> {
    this.record('put', dir, name, content);
    return this.failOn.put ? Promise.reject(this.failOn.put) : Promise.resolve();
  }

  run(request: HostRunRequest): Promise<HostRunResult> {
    this.record('run', request);
    this.onRun?.(request);
    return this.failOn.run ? Promise.reject(this.failOn.run) : Promise.resolve(this.runResult);
  }

  fetch(remotePath: string, localPath: string): Promise<boolean> {
    this.record('fetch', remotePath, localPath);
    if (this.failOn.fetch) {
      return Promise.reject(this.failOn.fetch);
    }
    const bytes = this.serverFiles.get(remotePath);
    if (!bytes) {
      return Promise.resolve(false);
    }
    fs.writeFileSync(localPath, bytes);
    return Promise.resolve(true);
  }

  rmtemp(dir: string): Promise<void> {
    this.record('rmtemp', dir);
    return this.failOn.rmtemp ? Promise.reject(this.failOn.rmtemp) : Promise.resolve();
  }
}

suite('Э9: RemoteDesignerBatchExecutor — последовательность обращений к хосту', () => {
  let sandbox: string;
  let tempRoot: string;
  let host: RecordingHost;
  let executor: RemoteDesignerBatchExecutor;
  let logs: string[];

  setup(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-remote-exec-'));
    tempRoot = path.join(sandbox, 'staging');
    fs.mkdirSync(tempRoot);
    host = new RecordingHost();
    logs = [];
    executor = new RemoteDesignerBatchExecutor(host, SERVER_EXE, { tempRoot, log: (line) => logs.push(line) });
  });

  teardown(async () => {
    await executor.dispose();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const request = (args: DesignerBatchRequest['args'], extra: Partial<DesignerBatchRequest> = {}): DesignerBatchRequest => ({
    args, secrets: [], ...extra,
  });

  function sentRun(): HostRunRequest {
    const call = host.calls.find((item) => item.op === 'run');
    assert.ok(call, 'run не вызывался');
    return call.args[0] as HostRunRequest;
  }

  test('успех со входным и выходным файлом: mktemp → put → run → fetch → rmtemp, серверные пути подставлены', async () => {
    host.serverFiles.set(`${SERVER_DIR}\\dump.cf`, Uint8Array.from([1, 2, 3, 0xff]));
    const result = await executor.run(request([
      'DESIGNER', '/F', 'C:\\Базы\\Тест База', '/ConfigurationRepositoryDumpCfg',
      { kind: 'outputFile', name: 'dump.cf' },
      '-Objects', { kind: 'inputFile', name: 'objects.xml', content: OBJECTS_XML },
      '-comment', 'Привет "мир" с пробелом',
    ]));

    assert.deepStrictEqual(host.ops(), ['mktemp', 'put', 'run', 'fetch', 'rmtemp']);
    assert.deepStrictEqual(host.calls[1].args, [SERVER_DIR, 'objects.xml', OBJECTS_XML]);
    const run = sentRun();
    const logPath = `${SERVER_DIR}\\out.log`;
    assert.strictEqual(run.exe, SERVER_EXE);
    assert.strictEqual(run.logPath, logPath);
    assert.strictEqual(
      run.commandLine,
      buildWindowsCommandLine([
        'DESIGNER', '/F', 'C:\\Базы\\Тест База', '/ConfigurationRepositoryDumpCfg', `${SERVER_DIR}\\dump.cf`,
        '-Objects', `${SERVER_DIR}\\objects.xml`, '-comment', 'Привет "мир" с пробелом',
        '/Out', logPath, '/DisableStartupDialogs',
      ])
    );
    assert.deepStrictEqual(host.calls[3].args.slice(0, 1), [`${SERVER_DIR}\\dump.cf`]);
    assert.deepStrictEqual(host.calls[4].args, [SERVER_DIR]);

    assert.strictEqual(result.exitCode, 0);
    const staged = result.outputs.get('dump.cf');
    assert.ok(staged, 'выходной файл должен быть в outputs');
    assert.ok(staged.startsWith(tempRoot), 'staging — локальный, внутри tempRoot');
    assert.deepStrictEqual(fs.readFileSync(staged), Buffer.from([1, 2, 3, 0xff]));
  });

  test('двоичное содержимое входного файла передаётся хосту как есть (Uint8Array)', async () => {
    const binary = Uint8Array.from([0xef, 0xbb, 0xbf, 0x00, 0xff]);
    await executor.run(request(['DESIGNER', '-B', { kind: 'inputFile', name: 'payload.bin', content: binary }]));
    assert.deepStrictEqual(host.calls[1].args, [SERVER_DIR, 'payload.bin', binary]);
  });

  test('несколько входных файлов отправляются в порядке вектора; без файлов put/fetch не вызываются', async () => {
    await executor.run(request([
      'DESIGNER', '-A', { kind: 'inputFile', name: 'a.xml', content: 'a' }, '-B', { kind: 'inputFile', name: 'b.xml', content: 'b' },
    ]));
    assert.deepStrictEqual(host.ops(), ['mktemp', 'put', 'put', 'run', 'rmtemp']);
    host.calls.length = 0;
    await executor.run(request(['DESIGNER', '/ConfigurationRepositoryBindCfg']));
    assert.deepStrictEqual(host.ops(), ['mktemp', 'run', 'rmtemp']);
  });

  test('лог декодируется (UTF-16LE с BOM) и обрезается; пустой лог — пустая строка', async () => {
    host.runResult = {
      exitCode: 0, interrupted: false, pid: 1,
      logBytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Захват выполнен\r\n', 'utf16le')]),
    };
    assert.strictEqual((await executor.run(request(['DESIGNER']))).log, 'Захват выполнен');
    host.runResult = { exitCode: 0, interrupted: false, pid: 1, logBytes: Buffer.alloc(0) };
    assert.strictEqual((await executor.run(request(['DESIGNER']))).log, '');
  });

  test('ненулевой код: exitCode передан, объявленный выходной файл всё равно забирается, если процесс его создал', async () => {
    host.runResult = { exitCode: 3, interrupted: false, pid: 1, logBytes: Buffer.alloc(0) };
    host.serverFiles.set(`${SERVER_DIR}\\dump.cf`, Uint8Array.from([9]));
    const result = await executor.run(request(['DESIGNER', '/Dump', { kind: 'outputFile', name: 'dump.cf' }]));
    assert.strictEqual(result.exitCode, 3);
    assert.strictEqual(result.interrupted, undefined);
    assert.ok(result.outputs.has('dump.cf'));
  });

  test('файла на сервере нет: записи в outputs нет, ошибки нет', async () => {
    const result = await executor.run(request(['DESIGNER', '/Dump', { kind: 'outputFile', name: 'dump.cf' }]));
    assert.strictEqual(result.outputs.size, 0);
  });

  test('прерывание: interrupted описан тем же текстом, что у локального; выходные файлы не забираются; сервер убран', async () => {
    host.runResult = { exitCode: -1, interrupted: true, pid: 1, logBytes: Buffer.alloc(0) };
    host.serverFiles.set(`${SERVER_DIR}\\dump.cf`, Uint8Array.from([9]));
    const result = await executor.run(request(['DESIGNER', '/Dump', { kind: 'outputFile', name: 'dump.cf' }]));
    assert.strictEqual(
      result.interrupted,
      describeProcessInterruption({ exitCode: 1, lastStdout: '', lastStderr: '', canceled: true })
    );
    assert.strictEqual(result.outputs.size, 0);
    assert.ok(!host.ops().includes('fetch'));
    assert.strictEqual(host.ops().at(-1), 'rmtemp');
  });

  test('токен отмены и onOutput пробрасываются в host.run как есть', async () => {
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };
    const seen: string[] = [];
    host.onRun = (run) => {
      run.onOutput?.('строка из процесса', 'stdout');
      run.onOutput?.('строка из stderr', 'stderr');
    };
    await executor.run(request(['DESIGNER'], { cancellation: token, onOutput: (line) => seen.push(line) }));
    assert.strictEqual(sentRun().cancellation, token);
    assert.deepStrictEqual(seen, ['строка из процесса', 'строка из stderr']);
  });

  test('запуск без onOutput не падает на выводе процесса', async () => {
    host.onRun = (run) => run.onOutput?.('x', 'stdout');
    await executor.run(request(['DESIGNER']));
  });

  suite('сервер убирается и при ошибках', () => {
    test('ошибка run: исходная ошибка пробрасывается, rmtemp выполнен, staging пуст', async () => {
      host.failOn.run = new Error('Хост: сеанс закрыт');
      await assert.rejects(() => executor.run(request(['DESIGNER'])), /Хост: сеанс закрыт/);
      assert.deepStrictEqual(host.ops(), ['mktemp', 'run', 'rmtemp']);
      assert.deepStrictEqual(fs.readdirSync(tempRoot), []);
    });

    test('ошибка put: run не вызывается, rmtemp выполнен', async () => {
      host.failOn.put = new Error('диск полон');
      await assert.rejects(
        () => executor.run(request(['DESIGNER', '-O', { kind: 'inputFile', name: 'objects.xml', content: 'x' }])),
        /диск полон/
      );
      assert.deepStrictEqual(host.ops(), ['mktemp', 'put', 'rmtemp']);
    });

    test('ошибка fetch: операция отклонена, сервер убран, локальный staging не остаётся', async () => {
      host.failOn.fetch = new Error('копирование прервано');
      host.serverFiles.set(`${SERVER_DIR}\\dump.cf`, Uint8Array.from([9]));
      await assert.rejects(
        () => executor.run(request(['DESIGNER', '/Dump', { kind: 'outputFile', name: 'dump.cf' }])),
        /копирование прервано/
      );
      assert.strictEqual(host.ops().at(-1), 'rmtemp');
      assert.deepStrictEqual(fs.readdirSync(tempRoot), []);
    });

    test('ошибка mktemp: убирать нечего — rmtemp не вызывается', async () => {
      host.failOn.mktemp = new Error('нет доступа к TEMP');
      await assert.rejects(() => executor.run(request(['DESIGNER'])), /нет доступа к TEMP/);
      assert.deepStrictEqual(host.ops(), ['mktemp']);
    });

    test('сбой rmtemp после успешной операции не ломает результат и попадает в log без секретов', async () => {
      host.failOn.rmtemp = new Error('каталог занят');
      const result = await executor.run(request(['DESIGNER'], { secrets: ['сек-рет'] }));
      assert.strictEqual(result.exitCode, 0);
      assert.ok(logs.some((line) => line.includes(SERVER_DIR)), logs.join('|'));
      assert.ok(logs.every((line) => !line.includes('сек-рет')));
    });

    test('не-Error исключения хоста (строки) превращаются в Error с тем же текстом, секреты маскируются; сбой уборки строкой — в log', async () => {
      const secret = 'тайна-1';
      host.failOn.run = `сбой: /P${secret}` as unknown as Error;
      host.failOn.rmtemp = 'каталог занят строкой' as unknown as Error;
      await assert.rejects(
        () => executor.run(request(['DESIGNER'], { secrets: [secret] })),
        (error: unknown) => error instanceof Error && error.message.includes('сбой:') && !error.message.includes(secret)
      );
      assert.ok(logs.some((line) => line.includes('каталог занят строкой')), logs.join('|'));
    });

    test('сбой rmtemp после ошибки операции не подменяет исходную ошибку', async () => {
      host.failOn.run = new Error('исходная ошибка запуска');
      host.failOn.rmtemp = new Error('вторичный сбой уборки');
      await assert.rejects(() => executor.run(request(['DESIGNER'])), /исходная ошибка запуска/);
    });
  });

  suite('имена файлов и секреты', () => {
    test('недопустимое имя отклоняется ДО обращений к хосту (сервер не трогается)', async () => {
      for (const name of ['', '..', 'a/b', 'a\\b', 'C:x']) {
        await assert.rejects(
          () => executor.run(request(['DESIGNER', '-X', { kind: 'inputFile', name, content: 'x' }])),
          /Недопустимое имя файла/
        );
      }
      await assert.rejects(
        () => executor.run(request(['DESIGNER', '-A', { kind: 'outputFile', name: 'out.LOG' }])),
        /повторяется или занято логом/
      );
      assert.deepStrictEqual(host.calls, []);
    });

    test('секреты запроса маскируются в тексте ошибок исполнителя (хост мог процитировать командную строку)', async () => {
      const secret = 'п@ss"w ord';
      host.failOn.run = new Error(`Не удалось запустить процесс: DESIGNER /N"adm" /P"${secret}"`);
      try {
        await executor.run(request(['DESIGNER', `/P${secret}`], { secrets: [secret] }));
        assert.fail('ожидалось исключение');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(!message.includes(secret), `секрет в тексте ошибки: ${message}`);
        assert.ok(message.includes('********'), message);
      }
    });
  });

  suite('dispose', () => {
    test('убирает локальный staging, повторный безопасен (хостом исполнитель не владеет)', async () => {
      host.serverFiles.set(`${SERVER_DIR}\\dump.cf`, Uint8Array.from([9]));
      const result = await executor.run(request(['DESIGNER', '/Dump', { kind: 'outputFile', name: 'dump.cf' }]));
      const staged = result.outputs.get('dump.cf');
      assert.ok(staged && fs.existsSync(staged));
      await executor.dispose();
      assert.strictEqual(fs.existsSync(staged), false);
      await executor.dispose();
    });
  });

  test('конструктор без options: staging в системном временном каталоге (smoke)', async () => {
    const defaults = new RemoteDesignerBatchExecutor(host, SERVER_EXE);
    host.serverFiles.set(`${SERVER_DIR}\\dump.cf`, Uint8Array.from([9]));
    const result = await defaults.run(request(['DESIGNER', '/Dump', { kind: 'outputFile', name: 'dump.cf' }]));
    const staged = result.outputs.get('dump.cf');
    assert.ok(staged?.startsWith(os.tmpdir()));
    await defaults.dispose();
    assert.ok(staged && !fs.existsSync(staged));
  });
});
