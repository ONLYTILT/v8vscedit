/**
 * Общий контрактный набор для ВСЕХ реализаций `DesignerBatchExecutor` (по образцу
 * `agentFileStoreContract`): локальная и удалённая обязаны вести себя одинаково с точки
 * зрения вызывающего — вектор аргументов доходит до процесса байт-в-байт, входные файлы
 * материализуются, лог `/Out` декодируется, выходные файлы попадают в ЛОКАЛЬНЫЙ staging,
 * отмена и ошибки не оставляют следов. Различия реализаций (kill дерева процессов,
 * серверные каталоги) проверяются отдельными тестами рядом с реализацией.
 *
 * Исполняемый файл — `process.execPath` в режиме Node; роль «1cv8» играет скрипт, путь к
 * которому — первый элемент вектора (см. fakeDesignerProcess.ts).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encode } from 'iconv-lite';
import { describeProcessInterruption } from '../../../infra/process';
import type {
  DesignerBatchExecutor,
  DesignerBatchRequest,
  DesignerBatchResult,
} from '../../../infra/process/designer/DesignerBatchExecutor';
import { FakeDesigner, toBase64, type FakeDesignerConfig } from './fakeDesignerProcess';

export interface ContractFixture {
  readonly executor: DesignerBatchExecutor;
  /**
   * Всё, что исполнитель оставил после `run` без выходных файлов: рабочие каталоги
   * (локальные или серверные) и не забранный staging. Ожидается пустой список.
   */
  leftovers(): string[];
  /** Освобождает ресурсы фикстуры теста (не общие для набора). */
  teardown(): Promise<void>;
}

export interface ContractProvider {
  /** Общая подготовка набора (например, запуск хоста PowerShell); вызывается один раз. */
  start(env: { sandbox: string; fake: FakeDesigner }): Promise<void>;
  stop(): Promise<void>;
  /** Исполнитель для одного теста; `exePath` — настоящий файл (поддельный 1cv8). */
  create(testSandbox: string): ContractFixture;
  /** Исполнитель с заведомо несуществующим исполняемым файлом. */
  createWithMissingExe(testSandbox: string): ContractFixture;
}

const OBJECTS_XML = '<Objects version="1.0">\n  <Object fullName="Справочник.Товары"/>\n</Objects>\n';
const LOG_TEXT = 'Захват объектов выполнен: Справочник.Товары';
const DUMP_BYTES = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0x80, 0xd0, 0x9f, 0x0d, 0x0a]);

type LogKind = 'utf16le-bom' | 'utf8-bom' | 'cp1251' | 'cp866';

function logBytes(kind: LogKind, text: string): Buffer {
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

export function describeDesignerExecutorContract(title: string, provider: ContractProvider): void {
  suite(`Контракт DesignerBatchExecutor: ${title}`, function () {
    this.timeout(120_000);
    let sandbox: string;
    let fake: FakeDesigner;
    let fixture: ContractFixture;
    let testIndex = 0;
    let skipped = false;

    suiteSetup(async function () {
      sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-contract-')));
      fake = new FakeDesigner(path.join(sandbox, 'fake'));
      try {
        await provider.start({ sandbox, fake });
      } catch (error) {
        if (error instanceof Error && error.name === 'ContractSkip') {
          skipped = true;
          this.skip();
        }
        throw error;
      }
    });

    suiteTeardown(async () => {
      if (!skipped) {
        await provider.stop();
      }
      fake.restoreEnv();
      fs.rmSync(sandbox, { recursive: true, force: true });
    });

    setup(() => {
      testIndex += 1;
      const testSandbox = path.join(sandbox, `t${String(testIndex)}`);
      fs.mkdirSync(testSandbox, { recursive: true });
      fixture = provider.create(testSandbox);
    });

    teardown(async () => {
      await fixture.teardown();
    });

    /** Вектор запроса: первым идёт путь к скрипту поддельного 1cv8. */
    function request(rest: DesignerBatchRequest['args'], extra: Partial<DesignerBatchRequest> = {}): DesignerBatchRequest {
      return { args: [fake.scriptPath, ...rest], secrets: [], ...extra };
    }

    function runWith(config: FakeDesignerConfig, req: DesignerBatchRequest): Promise<DesignerBatchResult> {
      fake.configure(config);
      return fixture.executor.run(req);
    }

    suite('вектор и рабочий каталог', () => {
      test('входной файл подставляется путём, добавляются /Out и /DisableStartupDialogs, прочие аргументы доходят как есть', async () => {
        const inputCopy = path.join(sandbox, `objects-${String(testIndex)}.copy`);
        const result = await runWith(
          { copyInputAfter: [{ key: '-Objects', dest: inputCopy }] },
          request([
            '/F', 'C:\\Базы\\Тест База',
            '/ConfigurationRepositoryLock',
            '-Objects', { kind: 'inputFile', name: 'objects.xml', content: OBJECTS_XML },
            '-comment', 'Привет "мир" с пробелом',
            '-Extension', 'EVOLC',
          ])
        );

        assert.strictEqual(result.exitCode, 0);
        const record = fake.readRecord();
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
        const logFile = record.argv[outIndex + 1];
        assert.strictEqual(path.basename(inputPath), 'objects.xml');
        assert.strictEqual(path.basename(logFile), 'out.log');
        assert.strictEqual(path.dirname(logFile), path.dirname(inputPath), '/Out лежит рядом с входными файлами');
      });

      // Один алгоритм квотирования локально и удалённо: аргументы с кавычками, обратной
      // косой чертой, пустые и кириллические доходят до процесса неизменными.
      const trickyArgs = [
        '', 'a b', 'a"b', 'a\\"b', 'путь с пробелом\\', 'C:\\Тест Папка\\', '/Pпа"роль', '-x=y z', '\\\\srv\\share dir\\', '"',
      ];
      for (const [index, tricky] of trickyArgs.entries()) {
        test(`аргумент №${String(index + 1)} ${JSON.stringify(tricky)} доходит до процесса неизменным`, async () => {
          await runWith({}, request(['/First', tricky, '/Last']));
          assert.deepStrictEqual(fake.readRecord().argv.slice(0, 3), ['/First', tricky, '/Last']);
        });
      }

      test('строковое содержимое входного файла — UTF-8 без BOM, кириллица байт-в-байт', async () => {
        const inputCopy = path.join(sandbox, `objects-utf8-${String(testIndex)}.copy`);
        await runWith(
          { copyInputAfter: [{ key: '-Objects', dest: inputCopy }] },
          request(['-Objects', { kind: 'inputFile', name: 'objects.xml', content: OBJECTS_XML }])
        );
        assert.ok(fake.readRecord().inputs['-Objects'].existed, 'файл существует в момент работы процесса');
        assert.deepStrictEqual(fs.readFileSync(inputCopy), Buffer.from(OBJECTS_XML, 'utf-8'));
      });

      test('бинарное содержимое (Uint8Array, включая BOM-подобные байты и нули) — байт-в-байт', async () => {
        const binary = Uint8Array.from([0xef, 0xbb, 0xbf, 0x00, 0x01, 0xff, 0xfe, 0x0d, 0x0a, 0x80]);
        const inputCopy = path.join(sandbox, `binary-${String(testIndex)}.copy`);
        await runWith(
          { copyInputAfter: [{ key: '-Binary', dest: inputCopy }] },
          request(['-Binary', { kind: 'inputFile', name: 'payload.bin', content: binary }])
        );
        assert.deepStrictEqual(fs.readFileSync(inputCopy), Buffer.from(binary));
      });

      test('входной файл с кириллицей в имени создаётся и виден процессу', async () => {
        const inputCopy = path.join(sandbox, `cyr-${String(testIndex)}.copy`);
        await runWith(
          { copyInputAfter: [{ key: '-Objects', dest: inputCopy }] },
          request(['-Objects', { kind: 'inputFile', name: 'объекты.xml', content: OBJECTS_XML }])
        );
        const inputPath = fake.readRecord().inputs['-Objects'].path;
        assert.ok(inputPath);
        assert.strictEqual(path.basename(inputPath), 'объекты.xml');
        assert.deepStrictEqual(fs.readFileSync(inputCopy), Buffer.from(OBJECTS_XML, 'utf-8'));
      });

      test('после успешного запуска входные файлы и рабочий каталог удалены, следов нет', async () => {
        await runWith(
          { copyInputAfter: [{ key: '-Objects', dest: path.join(sandbox, `c-${String(testIndex)}`) }] },
          request(['-Objects', { kind: 'inputFile', name: 'objects.xml', content: OBJECTS_XML }])
        );
        const inputPath = fake.readRecord().inputs['-Objects'].path;
        assert.ok(inputPath);
        assert.strictEqual(fs.existsSync(inputPath), false);
        assert.deepStrictEqual(fixture.leftovers(), []);
      });

      test('вектор без файлов: подставлять нечего, /Out и /DisableStartupDialogs всё равно добавлены', async () => {
        await runWith({}, request(['/ConfigurationRepositoryBindCfg']));
        const argv = fake.readRecord().argv;
        assert.strictEqual(argv[0], '/ConfigurationRepositoryBindCfg');
        assert.strictEqual(argv[1], '/Out');
        assert.strictEqual(argv[3], '/DisableStartupDialogs');
        assert.strictEqual(argv.length, 4);
      });

      test('два запуска подряд получают разные рабочие каталоги', async () => {
        const req = request(['-Objects', { kind: 'inputFile', name: 'objects.xml', content: OBJECTS_XML }]);
        const dest = path.join(sandbox, `c2-${String(testIndex)}`);
        fake.configure({ copyInputAfter: [{ key: '-Objects', dest }] });
        await fixture.executor.run(req);
        const first = fake.readRecord().inputs['-Objects'].path;
        fake.configure({ copyInputAfter: [{ key: '-Objects', dest }] });
        await fixture.executor.run(req);
        const second = fake.readRecord().inputs['-Objects'].path;
        assert.ok(first && second);
        assert.notStrictEqual(path.dirname(first), path.dirname(second));
      });
    });

    suite('лог и код возврата', () => {
      const kinds: LogKind[] = ['utf16le-bom', 'utf8-bom', 'cp1251', 'cp866'];
      for (const kind of kinds) {
        test(`лог /Out декодируется (${kind}) и обрезается по краям`, async () => {
          const result = await runWith(
            { logBase64: toBase64(logBytes(kind, `${LOG_TEXT}\r\n`)) },
            request(['/ConfigurationRepositoryLock'])
          );
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.log, LOG_TEXT);
        });
      }

      test('процесс не создал лог: log — пустая строка', async () => {
        const result = await runWith({}, request(['/ConfigurationRepositoryLock']));
        assert.strictEqual(result.log, '');
      });

      test('ненулевой код возврата попадает в exitCode вместе с логом, прерывания нет', async () => {
        const result = await runWith(
          { exitCode: 5, logBase64: toBase64(logBytes('utf16le-bom', 'Объект захвачен другим пользователем')) },
          request(['/ConfigurationRepositoryLock'])
        );
        assert.strictEqual(result.exitCode, 5);
        assert.strictEqual(result.log, 'Объект захвачен другим пользователем');
        assert.strictEqual(result.interrupted, undefined);
      });

      test('ненулевой код тоже убирает рабочий каталог', async () => {
        await runWith(
          { exitCode: 1, copyInputAfter: [{ key: '-Objects', dest: path.join(sandbox, `c3-${String(testIndex)}`) }] },
          request(['-Objects', { kind: 'inputFile', name: 'objects.xml', content: OBJECTS_XML }])
        );
        assert.deepStrictEqual(fixture.leftovers(), []);
      });

      test('onOutput получает строки stdout и stderr процесса', async () => {
        const lines: string[] = [];
        await runWith(
          { stdout: 'строка из stdout', stderr: 'строка из stderr' },
          request(['/ConfigurationRepositoryLock'], { onOutput: (line) => lines.push(line.trim()) })
        );
        assert.ok(lines.includes('строка из stdout'), `stdout не получен: ${JSON.stringify(lines)}`);
        assert.ok(lines.includes('строка из stderr'), `stderr не получен: ${JSON.stringify(lines)}`);
      });

      test('запуск без onOutput не падает на выводе процесса', async () => {
        const result = await runWith({ stdout: 'вывод' }, request(['/ConfigurationRepositoryLock']));
        assert.strictEqual(result.exitCode, 0);
      });
    });

    suite('выходные файлы', () => {
      test('выходной файл подставляется путём и переносится в ЛОКАЛЬНЫЙ staging, переживая run', async () => {
        const result = await runWith(
          { outputsAfter: [{ key: '/ConfigurationRepositoryDumpCfg', contentBase64: toBase64(DUMP_BYTES) }] },
          request(['/ConfigurationRepositoryDumpCfg', { kind: 'outputFile', name: 'dump.cf' }, '-v', '15'])
        );
        const record = fake.readRecord();
        assert.strictEqual(path.basename(record.argv[1]), 'dump.cf');
        assert.deepStrictEqual(record.argv.slice(2, 4), ['-v', '15']);

        const staged = result.outputs.get('dump.cf');
        assert.ok(staged, 'выходной файл должен быть в outputs под своим именем');
        assert.ok(fs.existsSync(staged), 'staging-файл существует после run (локально)');
        assert.deepStrictEqual(fs.readFileSync(staged), Buffer.from(DUMP_BYTES));
        assert.notStrictEqual(path.dirname(staged), path.dirname(record.argv[1]), 'staging — не рабочий каталог процесса');
      });

      test('большой выходной файл (3 МБ случайных байт) приходит без искажений', async () => {
        const big = Buffer.alloc(3 * 1024 * 1024);
        let seed = 12345;
        for (let index = 0; index < big.length; index += 1) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          big[index] = seed & 0xff;
        }
        const result = await runWith(
          { outputsAfter: [{ key: '/ConfigurationRepositoryDumpCfg', contentBase64: toBase64(big) }] },
          request(['/ConfigurationRepositoryDumpCfg', { kind: 'outputFile', name: 'dump.cf' }])
        );
        const staged = result.outputs.get('dump.cf');
        assert.ok(staged);
        assert.ok(fs.readFileSync(staged).equals(big), 'содержимое отличается от выданного процессом');
      });

      test('процесс не создал выходной файл: имени нет в outputs', async () => {
        const result = await runWith(
          { exitCode: 1 },
          request(['/ConfigurationRepositoryDumpCfg', { kind: 'outputFile', name: 'dump.cf' }])
        );
        assert.strictEqual(result.outputs.has('dump.cf'), false);
        assert.strictEqual(result.outputs.size, 0);
      });

      test('несколько выходных файлов возвращаются каждый под своим именем', async () => {
        const result = await runWith(
          {
            outputsAfter: [
              { key: '-First', contentBase64: toBase64(Buffer.from('один', 'utf-8')) },
              { key: '-Second', contentBase64: toBase64(Buffer.from('два', 'utf-8')) },
            ],
          },
          request(['-First', { kind: 'outputFile', name: 'first.out' }, '-Second', { kind: 'outputFile', name: 'second.out' }])
        );
        const first = result.outputs.get('first.out');
        const second = result.outputs.get('second.out');
        assert.ok(first && second);
        assert.strictEqual(fs.readFileSync(first, 'utf-8'), 'один');
        assert.strictEqual(fs.readFileSync(second, 'utf-8'), 'два');
      });

      test('dispose удаляет не забранные staging-файлы и повторно безопасен', async () => {
        const result = await runWith(
          { outputsAfter: [{ key: '/ConfigurationRepositoryDumpCfg', contentBase64: toBase64(DUMP_BYTES) }] },
          request(['/ConfigurationRepositoryDumpCfg', { kind: 'outputFile', name: 'dump.cf' }])
        );
        const staged = result.outputs.get('dump.cf');
        assert.ok(staged && fs.existsSync(staged));
        await fixture.executor.dispose();
        assert.strictEqual(fs.existsSync(staged), false);
        await fixture.executor.dispose();
      });

      test('вызывающий может забрать staging-файл до dispose: dispose не падает на отсутствующем', async () => {
        const result = await runWith(
          { outputsAfter: [{ key: '/ConfigurationRepositoryDumpCfg', contentBase64: toBase64(DUMP_BYTES) }] },
          request(['/ConfigurationRepositoryDumpCfg', { kind: 'outputFile', name: 'dump.cf' }])
        );
        const staged = result.outputs.get('dump.cf');
        assert.ok(staged);
        const target = path.join(sandbox, `moved-${String(testIndex)}.cf`);
        fs.renameSync(staged, target);
        await fixture.executor.dispose();
        assert.deepStrictEqual(fs.readFileSync(target), Buffer.from(DUMP_BYTES));
      });
    });

    suite('отмена', () => {
      test('отмена после старта процесса: interrupted, рабочий каталог убран', async () => {
        const { token, cancel } = controllableToken();
        // Отмена по маркеру «ready» из stdout, а не по таймеру: процесс гарантированно стартовал.
        const result = await runWith(
          { hang: true, copyInputAfter: [{ key: '-Objects', dest: path.join(sandbox, `c4-${String(testIndex)}`) }] },
          request(['-Objects', { kind: 'inputFile', name: 'objects.xml', content: OBJECTS_XML }], {
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
        assert.deepStrictEqual(fixture.leftovers(), []);
      });

      test('токен отменён до запуска: процесс не стартует, interrupted выставлен, следов нет', async () => {
        const { token, cancel } = controllableToken();
        cancel();
        const result = await runWith({ hang: true }, request(['/ConfigurationRepositoryLock'], { cancellation: token }));
        assert.ok(result.interrupted);
        assert.strictEqual(fake.hasRecord(), false, 'поддельный 1cv8 не должен был запуститься');
        assert.deepStrictEqual(fixture.leftovers(), []);
      });

      test('неотменённый токен не мешает штатному завершению', async () => {
        const { token } = controllableToken();
        const result = await runWith({}, request(['/ConfigurationRepositoryLock'], { cancellation: token }));
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.interrupted, undefined);
      });
    });

    // Имя файла в запросе — простое имя внутри рабочего каталога. Реализации обязаны отбивать
    // небезопасные имена ДО запуска и до создания каталога: иначе запрос писал бы файлы вне
    // каталога запуска или молча перетирал бы лог /Out.
    suite('недопустимые имена файлов', () => {
      const unsafeNames = ['', '.', '..', 'a/b.xml', 'a\\b.xml', '../escape.xml', '..\\escape.xml', 'C:evil.xml', '/abs.xml'];
      for (const kind of ['inputFile', 'outputFile'] as const) {
        for (const name of unsafeNames) {
          test(`${kind} с именем ${JSON.stringify(name)} отклоняется до запуска, следов нет`, async () => {
            const arg = kind === 'inputFile' ? { kind, name, content: OBJECTS_XML } : { kind, name };
            await assert.rejects(() => runWith({}, request(['-X', arg])), /Недопустимое имя файла/);
            assert.strictEqual(fake.hasRecord(), false, 'процесс не должен был стартовать');
            assert.deepStrictEqual(fixture.leftovers(), []);
          });
        }
      }

      const collisions: { title: string; args: DesignerBatchRequest['args'] }[] = [
        {
          title: 'два входных файла с одним именем',
          args: ['-A', { kind: 'inputFile', name: 'objects.xml', content: 'a' }, '-B', { kind: 'inputFile', name: 'objects.xml', content: 'b' }],
        },
        {
          title: 'входной и выходной файл с одним именем без учёта регистра',
          args: ['-A', { kind: 'inputFile', name: 'dump.cf', content: 'a' }, '-B', { kind: 'outputFile', name: 'DUMP.CF' }],
        },
        { title: 'имя совпадает с логом /Out', args: ['-A', { kind: 'outputFile', name: 'Out.log' }] },
      ];
      for (const item of collisions) {
        test(`${item.title}: отказ до запуска`, async () => {
          await assert.rejects(() => runWith({}, request(item.args)), /повторяется или занято логом/);
          assert.strictEqual(fake.hasRecord(), false);
          assert.deepStrictEqual(fixture.leftovers(), []);
        });
      }
    });

    suite('ошибки запуска', () => {
      test('несуществующий исполняемый файл: run отклоняется, следов нет', async () => {
        const broken = provider.createWithMissingExe(path.join(sandbox, `broken-${String(testIndex)}`));
        try {
          await assert.rejects(() => broken.executor.run(request([
            '-Objects', { kind: 'inputFile', name: 'objects.xml', content: OBJECTS_XML },
            '/ConfigurationRepositoryDumpCfg', { kind: 'outputFile', name: 'dump.cf' },
          ])));
          assert.deepStrictEqual(broken.leftovers(), []);
        } finally {
          await broken.teardown();
        }
      });
    });
  });
}
