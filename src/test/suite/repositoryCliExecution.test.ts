import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as repositoryCommands from '../../cli/commands/repositoryCommands';
import {
  executeRepositoryCommand,
  finishRepositoryCliRun,
  REPOSITORY_CLI_MESSAGES,
  type RepositoryCliCommand,
  type RepositoryCliFinishContext,
} from '../../cli/commands/repositoryCommands';
import { captureConsole as startConsoleCapture, type ConsoleCapture } from './support/consoleCapture';
import type { CliArgs } from '../../cli/core/types';
import type {
  DesignerBatchExecutor,
  DesignerBatchRequest,
  DesignerBatchResult,
} from '../../infra/process/designer/DesignerBatchExecutor';

/**
 * Исполнение CLI-команд хранилища. Поддельный `DesignerBatchExecutor` — единственная
 * подмена: платформа 1С — внешняя недоступная система (настоящий исполнитель покрыт
 * отдельно в localDesignerBatchExecutor.test.ts). Всё остальное — настоящий код и
 * настоящие временные файлы. console.log/error перехватываются и восстанавливаются.
 */

let out: string[];
let err: string[];
let capture: ConsoleCapture | undefined;

function captureConsole(): void {
  capture = startConsoleCapture();
  out = capture.log;
  err = capture.error;
}

function restoreConsole(): void {
  capture?.restore();
}

function result(partial: Partial<DesignerBatchResult>): DesignerBatchResult {
  return { exitCode: 0, log: '', outputs: new Map(), ...partial };
}

function baseCtx(extra: Partial<RepositoryCliFinishContext> = {}): RepositoryCliFinishContext {
  return {
    verbose: false,
    successMessage: 'OK',
    errorMessage: 'Error X',
    outputLines: [],
    ...extra,
  };
}

suite('finishRepositoryCliRun', () => {
  setup(captureConsole);
  teardown(restoreConsole);

  test('exit 0 без выходного файла: успех', () => {
    assert.strictEqual(finishRepositoryCliRun(result({}), baseCtx()), 0);
    assert.deepStrictEqual(out, ['OK']);
    assert.deepStrictEqual(err, []);
  });

  test('exit 0, файл объявлен, но платформа его не создала: код 1', () => {
    const code = finishRepositoryCliRun(result({}), baseCtx({ outputName: 'dump.cf', targetFile: 'x' }));
    assert.strictEqual(code, 1);
    assert.deepStrictEqual(err, ['Error X: платформа не создала выходной файл']);
    assert.deepStrictEqual(out, []);
  });

  test('exit 0, файл создан: переносится на targetFile', () => {
    const moves: [string, string][] = [];
    const code = finishRepositoryCliRun(
      result({ outputs: new Map([['dump.cf', 'S']]) }),
      baseCtx({ outputName: 'dump.cf', targetFile: 'T', moveOutput: (s, t) => { moves.push([s, t]); } })
    );
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(moves, [['S', 'T']]);
    assert.deepStrictEqual(out, ['OK']);
  });

  test('exit 0, файл создан, targetFile не задан: исключение', () => {
    assert.throws(
      () => finishRepositoryCliRun(
        result({ outputs: new Map([['dump.cf', 'S']]) }),
        baseCtx({ outputName: 'dump.cf' })
      ),
      /-File/
    );
  });

  test('exit 0, файл создан: перенос по умолчанию — реальный moveStagingToTarget', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-finish-'));
    try {
      const staging = path.join(dir, 's.bin');
      const target = path.join(dir, 't.bin');
      fs.writeFileSync(staging, 'data');
      const code = finishRepositoryCliRun(
        result({ outputs: new Map([['dump.cf', staging]]) }),
        baseCtx({ outputName: 'dump.cf', targetFile: target })
      );
      assert.strictEqual(code, 0);
      assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'data');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('exit != 0, не verbose: лог, детали, код ошибки', () => {
    const code = finishRepositoryCliRun(
      result({ exitCode: 3, log: 'лог платформы' }),
      baseCtx({ outputLines: ['строка 1', 'строка 2'] })
    );
    assert.strictEqual(code, 3);
    assert.deepStrictEqual(out, ['--- Log ---', 'лог платформы', '--- End ---']);
    assert.deepStrictEqual(err, ['строка 1\nстрока 2', 'Error X (code: 3)']);
  });

  test('exit != 0, пустые детали и лог: только код ошибки', () => {
    const code = finishRepositoryCliRun(result({ exitCode: 2 }), baseCtx({ outputLines: ['  ', ''] }));
    assert.strictEqual(code, 2);
    assert.deepStrictEqual(out, []);
    assert.deepStrictEqual(err, ['Error X (code: 2)']);
  });

  test('exit != 0, verbose: лог печатается один раз, в конце', () => {
    const code = finishRepositoryCliRun(
      result({ exitCode: 1, log: 'L' }),
      baseCtx({ verbose: true, outputLines: ['d'] })
    );
    assert.strictEqual(code, 1);
    assert.deepStrictEqual(out, ['--- Log ---', 'L', '--- End ---']);
    assert.deepStrictEqual(err, ['d', 'Error X (code: 1)']);
  });

  test('exit 0, verbose: лог после сообщения об успехе', () => {
    finishRepositoryCliRun(result({ log: 'L' }), baseCtx({ verbose: true }));
    assert.deepStrictEqual(out, ['OK', '--- Log ---', 'L', '--- End ---']);
  });
});

const WRAPPERS: readonly [RepositoryCliCommand, keyof typeof repositoryCommands][] = [
  ['repository-create', 'createRepository'],
  ['repository-bind', 'bindRepositoryConfiguration'],
  ['repository-unbind', 'unbindRepositoryConfiguration'],
  ['repository-lock', 'lockRepositoryObjects'],
  ['repository-unlock', 'unlockRepositoryObjects'],
  ['repository-commit', 'commitRepositoryObjects'],
  ['repository-update', 'updateRepositoryConfiguration'],
  ['repository-add-user', 'addRepositoryUser'],
  ['repository-copy-users', 'copyRepositoryUsers'],
  ['repository-dump', 'dumpRepositoryConfiguration'],
  ['repository-report', 'reportRepository'],
  ['repository-set-label', 'setRepositoryLabel'],
];

suite('executeRepositoryCommand', () => {
  let dir: string;
  let v8Path: string;
  let args: CliArgs;

  setup(() => {
    captureConsole();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-repo-cli-'));
    v8Path = path.join(dir, process.platform === 'win32' ? '1cv8.exe' : '1cv8');
    fs.writeFileSync(v8Path, '');
    args = { InfoBasePath: path.join(dir, 'base'), V8Path: v8Path, RepoPath: 'repo', RepoUser: 'u' };
  });

  teardown(() => {
    restoreConsole();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  interface Fake {
    factory: (p: string) => DesignerBatchExecutor;
    requests: DesignerBatchRequest[];
    v8Paths: string[];
    disposed: number;
  }

  function fake(behavior: (request: DesignerBatchRequest) => Promise<DesignerBatchResult>): Fake {
    const state: Fake = {
      requests: [], v8Paths: [], disposed: 0,
      factory: (p) => {
        state.v8Paths.push(p);
        return {
          run: (request) => { state.requests.push(request); return behavior(request); },
          dispose: () => { state.disposed += 1; return Promise.resolve(); },
        };
      },
    };
    return state;
  }

  test('успех: фабрика получает v8Path, запрос содержит вектор, исполнитель освобождается', async () => {
    const f = fake(() => Promise.resolve(result({})));
    const code = await executeRepositoryCommand('repository-bind', { ...args, ForceReplaceCfg: true }, f.factory);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(f.v8Paths, [v8Path]);
    assert.ok(f.requests[0].args.includes('/ConfigurationRepositoryBindCfg'));
    assert.ok(f.requests[0].args.includes('-forceReplaceCfg'));
    assert.strictEqual(f.disposed, 1);
    assert.deepStrictEqual(out, [REPOSITORY_CLI_MESSAGES['repository-bind'].success]);
  });

  test('onOutput собирает детали ошибки, исполнитель освобождается', async () => {
    const f = fake((request) => {
      request.onOutput?.('деталь A');
      request.onOutput?.('деталь B');
      return Promise.resolve(result({ exitCode: 5 }));
    });
    const code = await executeRepositoryCommand('repository-unbind', args, f.factory);
    assert.strictEqual(code, 5);
    assert.deepStrictEqual(err, ['деталь A\nдеталь B', `${REPOSITORY_CLI_MESSAGES['repository-unbind'].error} (code: 5)`]);
    assert.strictEqual(f.disposed, 1);
  });

  test('-Verbose печатает лог даже при успехе', async () => {
    const f = fake(() => Promise.resolve(result({ log: 'L' })));
    await executeRepositoryCommand('repository-lock', { ...args, Verbose: true }, f.factory);
    assert.deepStrictEqual(out.slice(-3), ['--- Log ---', 'L', '--- End ---']);
  });

  test('исключение из run: dispose выполняется, ошибка пробрасывается', async () => {
    const f = fake(() => Promise.reject(new Error('сбой запуска')));
    await assert.rejects(() => executeRepositoryCommand('repository-lock', args, f.factory), /сбой запуска/);
    assert.strictEqual(f.disposed, 1);
  });

  test('dump: файл переносится на -File', async () => {
    const staging = path.join(dir, 'staging.cf');
    fs.writeFileSync(staging, 'cf');
    const target = path.join(dir, 'out.cf');
    const f = fake(() => Promise.resolve(result({ outputs: new Map([['dump.cf', staging]]) })));
    const code = await executeRepositoryCommand('repository-dump', { ...args, File: target }, f.factory);
    assert.strictEqual(code, 0);
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'cf');
  });

  // Имя staging-файла — только по ReportFormat, расширение -File не влияет. Случай
  // «без формата при -File .txt → report.mxl» закрепляет замер 8.3.27.2130: без ключа
  // платформа всегда пишет MXL, расширение файла игнорирует.
  const reportCases: { title: string; extra: CliArgs; file: string; staged: string }[] = [
    { title: 'ReportFormat mxl', extra: { ReportFormat: 'mxl' }, file: 'отчёт.mxl', staged: 'report.mxl' },
    { title: 'ReportFormat txt при -File .mxl', extra: { ReportFormat: 'txt' }, file: 'отчёт.mxl', staged: 'report.txt' },
    { title: 'без ReportFormat, -File .mxl', extra: {}, file: 'отчёт.mxl', staged: 'report.mxl' },
    { title: 'без ReportFormat, -File .txt — всё равно MXL', extra: {}, file: 'отчёт.txt', staged: 'report.mxl' },
  ];
  for (const item of reportCases) {
    test(`report (${item.title}): staging ${item.staged} переносится на -File`, async () => {
      const staging = path.join(dir, `staging-${item.staged}`);
      fs.writeFileSync(staging, 'rep');
      const target = path.join(dir, item.file);
      const f = fake(() => Promise.resolve(result({ outputs: new Map([[item.staged, staging]]) })));
      const code = await executeRepositoryCommand('repository-report', { ...args, ...item.extra, File: target }, f.factory);
      assert.strictEqual(code, 0);
      assert.ok(
        f.requests[0].args.some((arg) => typeof arg !== 'string' && arg.kind === 'outputFile' && arg.name === item.staged),
        'имя outputFile в векторе совпадает с ключом переноса'
      );
      assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'rep');
    });
  }

  test('без фабрики используется локальный исполнитель: пустой файл вместо 1cv8 не запускается', async () => {
    // Настоящая платформа не нужна: важно, что по умолчанию создаётся LocalDesignerBatchExecutor,
    // а сбой запуска не оставляет процесс CLI с кодом 0.
    let code: number | undefined;
    try {
      code = await executeRepositoryCommand('repository-unbind', args);
    } catch {
      code = undefined;
    }
    assert.notStrictEqual(code, 0);
  });

  test('dump без -File: фабрика не вызывается, промис отклонён', async () => {
    const f = fake(() => Promise.resolve(result({})));
    await assert.rejects(() => executeRepositoryCommand('repository-dump', args, f.factory), /-File/);
    assert.deepStrictEqual(f.v8Paths, []);
  });

  for (const [command, wrapper] of WRAPPERS) {
    test(`обёртка ${wrapper} (${command}): неполные аргументы отклоняют промис`, async () => {
      const fn = repositoryCommands[wrapper] as (a: CliArgs) => Promise<number>;
      // Без подключения resolveConnection бросает раньше создания настоящего исполнителя.
      await assert.rejects(() => fn({}));
    });
  }
});
