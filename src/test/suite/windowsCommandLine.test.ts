/**
 * Э9: квотирование командной строки Windows (infra/process/WindowsCommandLine.ts, чистый модуль).
 *
 * Контракт:
 *   quoteWindowsCommandLineArg(arg: string): string   — алгоритм libuv `quote_cmd_arg` (тот же, что применяет
 *                                                        Node `spawn`), поэтому удалённый 1cv8 получает ту же
 *                                                        командную строку, что локальный;
 *   buildWindowsCommandLine(args: readonly string[]): string — аргументы, каждый квотирован, через один пробел
 *                                                        (без исполняемого файла).
 *
 * Правила libuv: пустая строка → `""`; нет пробела/табуляции/кавычки → как есть (обратные косые без кавычки
 * не трогаются); иначе аргумент оборачивается в кавычки, `"` экранируется как `\"`, ряд `\` перед `"` или
 * перед закрывающей кавычкой удваивается.
 *
 * Вторая половина — не таблица, а РЕАЛЬНЫЙ разбор: собранная строка передаётся процессу как есть
 * (`windowsVerbatimArguments`), процесс печатает свой argv — он обязан совпасть с исходными аргументами.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildWindowsCommandLine, quoteWindowsCommandLineArg } from '../../infra/process/WindowsCommandLine';

const TABLE: readonly { title: string; arg: string; quoted: string }[] = [
  { title: 'пустая строка', arg: '', quoted: '""' },
  { title: 'простое слово', arg: 'abc', quoted: 'abc' },
  { title: 'кириллица без пробелов', arg: 'путь', quoted: 'путь' },
  { title: 'ключ платформы', arg: '/ConfigurationRepositoryLock', quoted: '/ConfigurationRepositoryLock' },
  { title: 'пробел', arg: 'a b', quoted: '"a b"' },
  { title: 'табуляция', arg: 'a\tb', quoted: '"a\tb"' },
  { title: 'кириллица с пробелом', arg: 'Тест База', quoted: '"Тест База"' },
  { title: 'кавычка внутри', arg: 'a"b', quoted: '"a\\"b"' },
  { title: 'одна кавычка', arg: '"', quoted: '"\\""' },
  { title: 'обратная косая без пробелов и кавычек — как есть', arg: 'a\\b', quoted: 'a\\b' },
  { title: 'путь без пробелов — как есть', arg: 'C:\\Базы\\Тест', quoted: 'C:\\Базы\\Тест' },
  { title: 'обратная косая перед пробелом — не удваивается', arg: 'a\\ b', quoted: '"a\\ b"' },
  { title: 'хвостовая обратная косая при пробеле — удваивается', arg: 'a b\\', quoted: '"a b\\\\"' },
  { title: 'две хвостовые обратные косые при пробеле — четыре', arg: 'a b\\\\', quoted: '"a b\\\\\\\\"' },
  { title: 'обратная косая перед кавычкой — удваивается и кавычка экранируется', arg: 'a\\"b', quoted: '"a\\\\\\"b"' },
  { title: 'обратная косая и кавычка в конце', arg: '\\"', quoted: '"\\\\\\""' },
  { title: 'путь с кириллицей, пробелом и хвостовым слэшем', arg: 'C:\\Тест Папка\\', quoted: '"C:\\Тест Папка\\\\"' },
  { title: 'UNC-путь с пробелом: ведущие косые не трогаются', arg: '\\\\srv\\share dir\\', quoted: '"\\\\srv\\share dir\\\\"' },
  { title: '/P с кавычкой в пароле', arg: '/Pпа"роль', quoted: '"/Pпа\\"роль"' },
  { title: 'пароль со спецсимволами оболочки без пробелов — как есть', arg: 'p&a|s^s%', quoted: 'p&a|s^s%' },
];

suite('Э9: WindowsCommandLine — квотирование аргументов (libuv quote_cmd_arg)', () => {
  for (const row of TABLE) {
    test(`${row.title}: ${JSON.stringify(row.arg)} → ${row.quoted}`, () => {
      assert.strictEqual(quoteWindowsCommandLineArg(row.arg), row.quoted);
    });
  }

  test('buildWindowsCommandLine: аргументы через пробел, каждый квотирован отдельно, исполняемого файла нет', () => {
    assert.strictEqual(
      buildWindowsCommandLine(['DESIGNER', '/F', 'C:\\Тест База', '-p', '', 'a"b']),
      'DESIGNER /F "C:\\Тест База" -p "" "a\\"b"'
    );
  });

  test('buildWindowsCommandLine: пустой список — пустая строка', () => {
    assert.strictEqual(buildWindowsCommandLine([]), '');
  });

  test('квотирование не меняет вход (чистая функция) и детерминировано', () => {
    const input = ['a b', 'c"d'];
    const copy = [...input];
    const first = buildWindowsCommandLine(input);
    assert.deepStrictEqual(input, copy);
    assert.strictEqual(buildWindowsCommandLine(input), first);
  });
});

suite('Э9: WindowsCommandLine — реальный разбор командной строки процессом', function () {
  this.timeout(60_000);
  let sandbox: string;
  let script: string;
  let savedElectronMode: string | undefined;

  suiteSetup(function () {
    if (process.platform !== 'win32') {
      // Разбор командной строки через CRT — поведение Windows; на POSIX argv передаётся массивом, а не строкой.
      this.skip();
    }
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-cmdline-'));
    script = path.join(sandbox, 'print argv.js');
    fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));', 'utf-8');
    savedElectronMode = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = '1';
  });

  suiteTeardown(() => {
    if (sandbox) {
      if (savedElectronMode === undefined) {
        Reflect.deleteProperty(process.env, 'ELECTRON_RUN_AS_NODE');
      } else {
        process.env.ELECTRON_RUN_AS_NODE = savedElectronMode;
      }
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  function argvOf(args: readonly string[]): string[] {
    const commandLine = `${quoteWindowsCommandLineArg(script)} ${buildWindowsCommandLine(args)}`;
    const result = spawnSync(process.execPath, [commandLine], {
      windowsVerbatimArguments: true,
      encoding: 'utf-8',
    });
    assert.strictEqual(result.status, 0, `процесс завершился с ошибкой: ${result.stderr}`);
    return JSON.parse(result.stdout) as string[];
  }

  for (const row of TABLE) {
    test(`процесс получает ${JSON.stringify(row.arg)} неизменным (${row.title})`, () => {
      assert.deepStrictEqual(argvOf([row.arg]), [row.arg]);
    });
  }

  test('смесь аргументов одной строкой: порядок и число сохраняются', () => {
    const args = ['/F', 'C:\\Тест База\\', '/N', 'Иван "Админ"', '/P', 'p"a\\ss w', '', '-x\\', 'end'];
    assert.deepStrictEqual(argvOf(args), args);
  });

  test('результат совпадает с тем, что даёт сам Node при обычном spawn с массивом аргументов', () => {
    const args = ['/Pпа"роль', 'a b\\', '', 'C:\\Тест Папка\\'];
    const viaNode = spawnSync(process.execPath, [script, ...args], { encoding: 'utf-8' });
    assert.strictEqual(viaNode.status, 0);
    assert.deepStrictEqual(argvOf(args), JSON.parse(viaNode.stdout) as string[]);
  });
});
