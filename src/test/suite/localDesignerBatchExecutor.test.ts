import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encode } from 'iconv-lite';
import { describeProcessInterruption } from '../../infra/process';
import type {
  DesignerBatchRequest,
  DesignerBatchResult,
} from '../../infra/process/designer/DesignerBatchExecutor';
import { LocalDesignerBatchExecutor } from '../../infra/process/designer/LocalDesignerBatchExecutor';

/**
 * LocalDesignerBatchExecutor на РЕАЛЬНОМ процессе.
 *
 * Поддельный «1cv8» — единственное допущение теста: настоящая платформа внешняя и
 * недоступна в CI. Это НЕ `.cmd`/`.bat`: Node ≥ 18.20 отказывает `spawn(*.cmd, { shell: false })`
 * (EINVAL, CVE-2024-27980; замерено на Node 24 тест-хоста), а исполнитель обязан
 * запускать процесс без оболочки, иначе пароль в аргументе пройдёт через разбор cmd.
 * Поэтому «1cv8» — сам исполняемый файл тест-хоста в режиме Node
 * (`ELECTRON_RUN_AS_NODE=1`), а роль скрипта играет файл `DESIGNER` без расширения в
 * `cwd`: первый аргумент вектора — всегда `DESIGNER`, и Node принимает его за имя
 * главного модуля. Скрипт получает остальные аргументы ровно так, как их получил бы
 * 1cv8 (проходит реальное квотирование Windows), пишет их в файл-запись, копирует входные
 * файлы, создаёт `/Out`-лог в заданной кодировке и выходные файлы, выходит с заданным
 * кодом или «зависает» до отмены. Поведение задаёт JSON из `FAKE_1C_CONFIG`.
 *
 * Сьют не привязан к Windows: схема работает на любой платформе, где есть исполняемый
 * файл тест-хоста, а проверяемое поведение (временный каталог, подстановка путей,
 * декодирование лога) от ОС не зависит.
 */

const FAKE_SCRIPT = `
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_1C_CONFIG, 'utf8'));
const argv = process.argv.slice(2);
const valueAfter = (key) => { const i = argv.indexOf(key); return i < 0 ? undefined : argv[i + 1]; };
const record = { argv, inputs: {} };
for (const item of cfg.copyInputAfter || []) {
  const p = valueAfter(item.key);
  const existed = p !== undefined && fs.existsSync(p);
  record.inputs[item.key] = { path: p, existed };
  if (existed) fs.writeFileSync(item.dest, fs.readFileSync(p));
}
const out = valueAfter('/Out');
if (out !== undefined && cfg.logBase64 !== undefined) fs.writeFileSync(out, Buffer.from(cfg.logBase64, 'base64'));
for (const item of cfg.outputsAfter || []) {
  fs.writeFileSync(valueAfter(item.key), Buffer.from(item.contentBase64, 'base64'));
}
fs.writeFileSync(cfg.recordFile, JSON.stringify(record));
if (cfg.stdout) console.log(cfg.stdout);
if (cfg.stderr) console.error(cfg.stderr);
if (cfg.hang) { console.log('ready'); setInterval(() => {}, 1000); } else { process.exitCode = cfg.exitCode || 0; }
`;

interface FakeConfig {
  exitCode?: number;
  logBase64?: string;
  stdout?: string;
  stderr?: string;
  hang?: boolean;
  copyInputAfter?: { key: string; dest: string }[];
  outputsAfter?: { key: string; contentBase64: string }[];
}

interface FakeRecord {
  argv: string[];
  inputs: Record<string, { path: string | undefined; existed: boolean }>;
}

const OBJECTS_XML = '<Objects version="1.0">\n  <Object fullName="Справочник.Товары"/>\n</Objects>\n';
const LOG_TEXT = 'Захват объектов выполнен: Справочник.Товары';

suite('LocalDesignerBatchExecutor', () => {
  let sandbox: string;
  let fakeCwd: string;
  let tempRoot: string;
  let recordFile: string;
  let executor: LocalDesignerBatchExecutor;
  let savedElectronMode: string | undefined;
  let savedConfigEnv: string | undefined;

  suiteSetup(() => {
    savedElectronMode = process.env.ELECTRON_RUN_AS_NODE;
    savedConfigEnv = process.env.FAKE_1C_CONFIG;
    process.env.ELECTRON_RUN_AS_NODE = '1';
  });

  suiteTeardown(() => {
    restoreEnv('ELECTRON_RUN_AS_NODE', savedElectronMode);
    restoreEnv('FAKE_1C_CONFIG', savedConfigEnv);
  });

  setup(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-fake1c-'));
    fakeCwd = path.join(sandbox, 'cwd');
    tempRoot = path.join(sandbox, 'tmp');
    fs.mkdirSync(fakeCwd);
    fs.mkdirSync(tempRoot);
    fs.writeFileSync(path.join(fakeCwd, 'DESIGNER'), FAKE_SCRIPT, 'utf-8');
    recordFile = path.join(sandbox, 'record.json');
    executor = new LocalDesignerBatchExecutor(process.execPath, { cwd: fakeCwd, tempRoot });
  });

  teardown(async () => {
    await executor.dispose();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }

  function configure(config: FakeConfig): void {
    const full = { ...config, recordFile };
    const configPath = path.join(sandbox, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(full), 'utf-8');
    process.env.FAKE_1C_CONFIG = configPath;
  }

  function readRecord(): FakeRecord {
    return JSON.parse(fs.readFileSync(recordFile, 'utf-8')) as FakeRecord;
  }

  function request(args: DesignerBatchRequest['args'], extra: Partial<DesignerBatchRequest> = {}): DesignerBatchRequest {
    return { args, secrets: [], ...extra };
  }

  function b64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
  }

  function runWith(config: FakeConfig, req: DesignerBatchRequest): Promise<DesignerBatchResult> {
    configure(config);
    return executor.run(req);
  }

  function logBytes(kind: 'utf16le-bom' | 'utf8-bom' | 'cp1251' | 'cp866', text: string): Buffer {
    switch (kind) {
      case 'utf16le-bom':
        return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
      case 'utf8-bom':
        return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf-8')]);
      case 'cp1251':
        return encode(text, 'win1251');
      case 'cp866':
        return encode(text, 'cp866');
    }
  }

  suite('вектор и временный каталог', () => {
    test('входной файл подставляется путём, добавляются /Out и /DisableStartupDialogs, остальное — как есть', async () => {
      const inputCopy = path.join(sandbox, 'objects.copy');
      const result = await runWith(
        { copyInputAfter: [{ key: '-Objects', dest: inputCopy }] },
        request([
          'DESIGNER',
          '/F', 'C:\\Базы\\Тест База',
          '/ConfigurationRepositoryLock',
          '-Objects', { kind: 'inputFile', name: 'objects.xml', content: OBJECTS_XML },
          '-comment', 'Привет "мир" с пробелом',
          '-Extension', 'EVOLC',
        ])
      );

      assert.strictEqual(result.exitCode, 0);
      const record = readRecord();
      const inputPath = record.inputs['-Objects'].path;
      assert.ok(inputPath, 'путь входного файла должен быть передан процессу');
      const outIndex = record.argv.indexOf('/Out');
      assert.deepStrictEqual(record.argv, [
        '/F', 'C:\\Базы\\Тест База',
        '/ConfigurationRepositoryLock',
        '-Objects', inputPath,
        '-comment', 'Привет "мир" с пробелом',
        '-Extension', 'EVOLC',
        '/Out', record.argv[outIndex + 1],
        '/DisableStartupDialogs',
      ]);

      const workDir = path.dirname(inputPath);
      assert.strictEqual(path.basename(inputPath), 'objects.xml');
      assert.strictEqual(path.dirname(record.argv[outIndex + 1]), workDir, '/Out лежит рядом с входными файлами');
      assert.strictEqual(path.basename(record.argv[outIndex + 1]), 'out.log');
      assert.strictEqual(
        path.dirname(workDir),
        tempRoot,
        'рабочий каталог создаётся внутри заданного временного корня'
      );
    });

    test('строковое содержимое входного файла пишется как UTF-8 без BOM, кириллица байт-в-байт', async () => {
      const inputCopy = path.join(sandbox, 'objects.copy');
      await runWith(
        { copyInputAfter: [{ key: '-Objects', dest: inputCopy }] },
        request(['DESIGNER', '-Objects', { kind: 'inputFile', name: 'objects.xml', content: OBJECTS_XML }])
      );

      assert.ok(readRecord().inputs['-Objects'].existed, 'входной файл существует в момент работы процесса');
      assert.deepStrictEqual(fs.readFileSync(inputCopy), Buffer.from(OBJECTS_XML, 'utf-8'));
    });

    test('бинарное содержимое (Uint8Array) пишется байт-в-байт', async () => {
      const binary = Uint8Array.from([0xef, 0xbb, 0xbf, 0x00, 0x01, 0xff, 0xfe, 0x0d, 0x0a, 0x80]);
      const inputCopy = path.join(sandbox, 'binary.copy');
      await runWith(
        { copyInputAfter: [{ key: '-Binary', dest: inputCopy }] },
        request(['DESIGNER', '-Binary', { kind: 'inputFile', name: 'payload.bin', content: binary }])
      );

      assert.deepStrictEqual(fs.readFileSync(inputCopy), Buffer.from(binary));
    });

    test('после успешного запуска входные файлы и рабочий каталог удалены, временный корень пуст', async () => {
      await runWith(
        { copyInputAfter: [{ key: '-Objects', dest: path.join(sandbox, 'c') }] },
        request(['DESIGNER', '-Objects', { kind: 'inputFile', name: 'objects.xml', content: OBJECTS_XML }])
      );

      const inputPath = readRecord().inputs['-Objects'].path;
      assert.ok(inputPath);
      assert.strictEqual(fs.existsSync(inputPath), false);
      assert.strictEqual(fs.existsSync(path.dirname(inputPath)), false);
      assert.deepStrictEqual(fs.readdirSync(tempRoot), []);
    });

    test('вектор без входных и выходных файлов: подставлять нечего, /Out всё равно добавлен', async () => {
      await runWith({}, request(['DESIGNER', '/ConfigurationRepositoryBindCfg']));

      const record = readRecord();
      assert.strictEqual(record.argv[0], '/ConfigurationRepositoryBindCfg');
      assert.strictEqual(record.argv[1], '/Out');
      assert.strictEqual(record.argv[3], '/DisableStartupDialogs');
      assert.strictEqual(record.argv.length, 4);
    });

    test('два последовательных запуска получают разные рабочие каталоги', async () => {
      configure({ copyInputAfter: [{ key: '-Objects', dest: path.join(sandbox, 'c') }] });
      const req = request(['DESIGNER', '-Objects', { kind: 'inputFile', name: 'objects.xml', content: OBJECTS_XML }]);

      await executor.run(req);
      const first = readRecord().inputs['-Objects'].path;
      await executor.run(req);
      const second = readRecord().inputs['-Objects'].path;

      assert.ok(first && second);
      assert.notStrictEqual(path.dirname(first), path.dirname(second));
    });
  });

  suite('лог и код возврата', () => {
    const encodings: ('utf16le-bom' | 'utf8-bom' | 'cp1251' | 'cp866')[] = ['utf16le-bom', 'utf8-bom', 'cp1251', 'cp866'];
    for (const kind of encodings) {
      test(`лог /Out декодируется (${kind}) и обрезается по краям`, async () => {
        const result = await runWith(
          { logBase64: b64(logBytes(kind, `${LOG_TEXT}\r\n`)) },
          request(['DESIGNER', '/ConfigurationRepositoryLock'])
        );

        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.log, LOG_TEXT);
      });
    }

    test('если процесс не создал лог, log — пустая строка', async () => {
      const result = await runWith({}, request(['DESIGNER', '/ConfigurationRepositoryLock']));
      assert.strictEqual(result.log, '');
    });

    test('ненулевой код возврата попадает в exitCode вместе с логом, прерывания нет', async () => {
      const result = await runWith(
        { exitCode: 5, logBase64: b64(logBytes('utf16le-bom', 'Объект захвачен другим пользователем')) },
        request(['DESIGNER', '/ConfigurationRepositoryLock'])
      );

      assert.strictEqual(result.exitCode, 5);
      assert.strictEqual(result.log, 'Объект захвачен другим пользователем');
      assert.strictEqual(result.interrupted, undefined);
    });

    test('ненулевой код тоже чистит рабочий каталог', async () => {
      await runWith(
        { exitCode: 1, copyInputAfter: [{ key: '-Objects', dest: path.join(sandbox, 'c') }] },
        request(['DESIGNER', '-Objects', { kind: 'inputFile', name: 'objects.xml', content: OBJECTS_XML }])
      );

      assert.deepStrictEqual(fs.readdirSync(tempRoot), []);
    });

    test('onOutput получает строки stdout и stderr процесса', async () => {
      const lines: string[] = [];
      await runWith(
        { stdout: 'строка из stdout', stderr: 'строка из stderr' },
        request(['DESIGNER', '/ConfigurationRepositoryLock'], { onOutput: (line) => lines.push(line.trim()) })
      );

      assert.ok(lines.includes('строка из stdout'), `stdout не получен: ${JSON.stringify(lines)}`);
      assert.ok(lines.includes('строка из stderr'), `stderr не получен: ${JSON.stringify(lines)}`);
    });

    test('запуск без onOutput не падает на выводе процесса', async () => {
      const result = await runWith({ stdout: 'вывод' }, request(['DESIGNER', '/ConfigurationRepositoryLock']));
      assert.strictEqual(result.exitCode, 0);
    });
  });

  suite('выходные файлы', () => {
    const DUMP_BYTES = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0x80, 0xd0, 0x9f]);

    test('выходной файл подставляется путём в рабочем каталоге и переносится в staging, переживая run', async () => {
      const result = await runWith(
        { outputsAfter: [{ key: '/ConfigurationRepositoryDumpCfg', contentBase64: b64(DUMP_BYTES) }] },
        request(['DESIGNER', '/ConfigurationRepositoryDumpCfg', { kind: 'outputFile', name: 'dump.cf' }, '-v', '15'])
      );

      const record = readRecord();
      const processSidePath = record.argv[1];
      assert.strictEqual(path.basename(processSidePath), 'dump.cf');
      assert.strictEqual(record.argv[0], '/ConfigurationRepositoryDumpCfg');
      assert.deepStrictEqual(record.argv.slice(2, 4), ['-v', '15']);

      const staged = result.outputs.get('dump.cf');
      assert.ok(staged, 'выходной файл должен быть в outputs под своим именем');
      assert.ok(fs.existsSync(staged), 'staging-файл существует после run');
      assert.deepStrictEqual(fs.readFileSync(staged), Buffer.from(DUMP_BYTES));
      assert.strictEqual(
        fs.existsSync(processSidePath),
        false,
        'файл перенесён из рабочего каталога, который удалён'
      );
      assert.notStrictEqual(path.dirname(staged), path.dirname(processSidePath));
    });

    test('процесс не создал выходной файл: имени нет в outputs', async () => {
      const result = await runWith(
        { exitCode: 1 },
        request(['DESIGNER', '/ConfigurationRepositoryDumpCfg', { kind: 'outputFile', name: 'dump.cf' }])
      );

      assert.strictEqual(result.outputs.has('dump.cf'), false);
      assert.strictEqual(result.outputs.size, 0);
    });

    test('несколько выходных файлов возвращаются каждый под своим именем', async () => {
      const result = await runWith(
        {
          outputsAfter: [
            { key: '-First', contentBase64: b64(Buffer.from('один', 'utf-8')) },
            { key: '-Second', contentBase64: b64(Buffer.from('два', 'utf-8')) },
          ],
        },
        request([
          'DESIGNER',
          '-First', { kind: 'outputFile', name: 'first.out' },
          '-Second', { kind: 'outputFile', name: 'second.out' },
        ])
      );

      const first = result.outputs.get('first.out');
      const second = result.outputs.get('second.out');
      assert.ok(first && second);
      assert.strictEqual(fs.readFileSync(first, 'utf-8'), 'один');
      assert.strictEqual(fs.readFileSync(second, 'utf-8'), 'два');
    });

    test('dispose удаляет не забранные staging-файлы и повторно безопасен', async () => {
      const result = await runWith(
        { outputsAfter: [{ key: '/ConfigurationRepositoryDumpCfg', contentBase64: b64(DUMP_BYTES) }] },
        request(['DESIGNER', '/ConfigurationRepositoryDumpCfg', { kind: 'outputFile', name: 'dump.cf' }])
      );
      const staged = result.outputs.get('dump.cf');
      assert.ok(staged && fs.existsSync(staged));

      await executor.dispose();
      assert.strictEqual(fs.existsSync(staged), false);
      await executor.dispose();
    });

    test('вызывающий может сам забрать staging-файл до dispose: dispose не падает на отсутствующем', async () => {
      const result = await runWith(
        { outputsAfter: [{ key: '/ConfigurationRepositoryDumpCfg', contentBase64: b64(DUMP_BYTES) }] },
        request(['DESIGNER', '/ConfigurationRepositoryDumpCfg', { kind: 'outputFile', name: 'dump.cf' }])
      );
      const staged = result.outputs.get('dump.cf');
      assert.ok(staged);
      const target = path.join(sandbox, 'moved.cf');
      fs.renameSync(staged, target);

      await executor.dispose();
      assert.deepStrictEqual(fs.readFileSync(target), Buffer.from(DUMP_BYTES));
    });
  });

  suite('отмена', () => {
    function controllableToken(): {
      token: { isCancellationRequested: boolean; onCancellationRequested(listener: () => void): { dispose(): void } };
      cancel: () => void;
    } {
      let listener: (() => void) | undefined;
      const token = {
        isCancellationRequested: false,
        onCancellationRequested(next: () => void) {
          listener = next;
          return { dispose: () => { listener = undefined; } };
        },
      };
      return {
        token,
        cancel: () => {
          token.isCancellationRequested = true;
          listener?.();
        },
      };
    }

    test('отмена после старта процесса: interrupted, рабочий каталог удалён', async () => {
      const { token, cancel } = controllableToken();
      // Отмена по маркеру «ready» из stdout процесса, а не по таймеру: процесс гарантированно
      // стартовал и записал файл-запись.
      const result = await runWith(
        { hang: true, copyInputAfter: [{ key: '-Objects', dest: path.join(sandbox, 'c') }] },
        request(['DESIGNER', '-Objects', { kind: 'inputFile', name: 'objects.xml', content: OBJECTS_XML }], {
          cancellation: token,
          onOutput: (line) => {
            if (line.trim() === 'ready') {
              cancel();
            }
          },
        })
      );

      assert.strictEqual(
        result.interrupted,
        describeProcessInterruption({ exitCode: 1, lastStdout: '', lastStderr: '', canceled: true })
      );
      const inputPath = readRecord().inputs['-Objects'].path;
      assert.ok(inputPath);
      assert.strictEqual(fs.existsSync(path.dirname(inputPath)), false);
      assert.deepStrictEqual(fs.readdirSync(tempRoot), []);
    });

    test('токен отменён до запуска: процесс не стартует, interrupted выставлен, каталог чист', async () => {
      const { token, cancel } = controllableToken();
      cancel();

      const result = await runWith(
        { hang: true },
        request(['DESIGNER', '/ConfigurationRepositoryLock'], { cancellation: token })
      );

      assert.ok(result.interrupted);
      assert.strictEqual(fs.existsSync(recordFile), false, 'поддельный 1cv8 не должен был запуститься');
      assert.deepStrictEqual(fs.readdirSync(tempRoot), []);
    });

    test('неотменённый токен не мешает штатному завершению', async () => {
      const { token } = controllableToken();
      const result = await runWith(
        {},
        request(['DESIGNER', '/ConfigurationRepositoryLock'], { cancellation: token })
      );

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.interrupted, undefined);
    });
  });

  // Защита исполнителя: имя файла в запросе — только простое имя внутри рабочего
  // каталога. Иначе запрос мог бы писать/забирать файлы вне каталога запуска или
  // молча перетереть один файл другим (в т.ч. лог /Out).
  suite('недопустимые имена файлов', () => {
    const unsafeNames = ['', '.', '..', 'a/b.xml', 'a\\b.xml', '../escape.xml', '..\\escape.xml', 'C:evil.xml', '/abs.xml'];
    for (const kind of ['inputFile', 'outputFile'] as const) {
      for (const name of unsafeNames) {
        test(`${kind} с именем ${JSON.stringify(name)} отклоняется до запуска, следов нет`, async () => {
          const arg = kind === 'inputFile' ? { kind, name, content: OBJECTS_XML } : { kind, name };
          await assert.rejects(
            () => runWith({}, request(['DESIGNER', '-X', arg])),
            /Недопустимое имя файла/
          );
          assert.strictEqual(fs.existsSync(recordFile), false, 'процесс не должен был стартовать');
          assert.deepStrictEqual(fs.readdirSync(tempRoot), []);
        });
      }
    }

    const collisions: { title: string; args: DesignerBatchRequest['args'] }[] = [
      {
        title: 'два входных файла с одним именем',
        args: [
          'DESIGNER',
          '-A', { kind: 'inputFile', name: 'objects.xml', content: 'a' },
          '-B', { kind: 'inputFile', name: 'objects.xml', content: 'b' },
        ],
      },
      {
        title: 'входной и выходной файл с одним именем без учёта регистра',
        args: ['DESIGNER', '-A', { kind: 'inputFile', name: 'dump.cf', content: 'a' }, '-B', { kind: 'outputFile', name: 'DUMP.CF' }],
      },
      {
        title: 'имя совпадает с логом /Out',
        args: ['DESIGNER', '-A', { kind: 'outputFile', name: 'Out.log' }],
      },
    ];
    for (const item of collisions) {
      test(`${item.title}: отказ до запуска`, async () => {
        await assert.rejects(() => runWith({}, request(item.args)), /повторяется или занято логом/);
        assert.strictEqual(fs.existsSync(recordFile), false);
        assert.deepStrictEqual(fs.readdirSync(tempRoot), []);
      });
    }
  });

  suite('ошибки запуска', () => {
    test('несуществующий исполняемый файл: run отклоняется, временный каталог удалён', async () => {
      const broken = new LocalDesignerBatchExecutor(path.join(sandbox, 'нет-такого-1cv8.exe'), { cwd: fakeCwd, tempRoot });
      await assert.rejects(
        () => broken.run(request([
          'DESIGNER',
          '-Objects', { kind: 'inputFile', name: 'objects.xml', content: OBJECTS_XML },
          '/ConfigurationRepositoryDumpCfg', { kind: 'outputFile', name: 'dump.cf' },
        ])),
        /ENOENT|не найден/i
      );

      assert.deepStrictEqual(fs.readdirSync(tempRoot), []);
      await broken.dispose();
    });

    test('конструктор без options: системный временный каталог и cwd процесса по умолчанию', async () => {
      const defaults = new LocalDesignerBatchExecutor(path.join(sandbox, 'нет-такого-1cv8.exe'));
      await assert.rejects(() => defaults.run(request(['DESIGNER', '/ConfigurationRepositoryLock'])), /ENOENT|не найден/i);
      await defaults.dispose();
    });
  });
});
