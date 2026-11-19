import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentFileStore } from '../../../infra/agent/files/AgentFileStore';
import { AgentTransferCancelledError } from '../../../infra/agent/files/AgentFileTransfer';
import { IO_CHUNK, IO_WINDOW } from '../../../infra/agent/files/SftpChunkedIo';
import { patternBytes } from './zipFixtures';

/**
 * Контрактный набор AgentFileStore: один и тот же код проверяет локальную и SFTP-реализацию, чтобы
 * их семантика (stat/remove/list/ошибки/границы корня) не разошлась. Набор смотрит на результат
 * глазами настоящей ФС: `root` — каталог, который реально лежит под хранилищем (у SFTP — корень
 * SFTP-сервера), `parent` — его родитель (проверка «ничего не создано снаружи корня»).
 */
export interface AgentFileStoreFixture {
  readonly store: AgentFileStore;
  /** Реальный каталог под хранилищем. */
  readonly root: string;
  /** Родитель `root`; в нём не должно появляться ничего, кроме самого `root`. */
  readonly parent: string;
  /** Журнал запросов к серверу (SFTP): граничные проверки обязаны отвергать путь ДО обращения. */
  readonly requestCount?: () => number;
  dispose(): Promise<void>;
}

export function defineAgentFileStoreContract(label: string, create: () => Promise<AgentFileStoreFixture>): void {
  suite(`AgentFileStore: контракт (${label})`, () => {
    let fixture: AgentFileStoreFixture;
    let store: AgentFileStore;
    let root: string;

    setup(async () => {
      fixture = await create();
      store = fixture.store;
      root = fixture.root;
    });
    teardown(async () => { await fixture.dispose(); });

    suite('writeFile / readFile', () => {
      test('строка пишется как UTF-8 без BOM; промежуточные каталоги создаются', async () => {
        await store.writeFile('a/b/Файл.txt', 'Привет');
        assert.deepStrictEqual([...fs.readFileSync(path.join(root, 'a', 'b', 'Файл.txt'))], [...Buffer.from('Привет', 'utf-8')]);
        assert.strictEqual((await store.readFile('a/b/Файл.txt')).toString('utf-8'), 'Привет');
      });

      test('Uint8Array пишется байт-в-байт (включая нули и BOM)', async () => {
        const data = new Uint8Array([0xef, 0xbb, 0xbf, 0, 1, 255, 10, 13]);
        await store.writeFile('bin/data.bin', data);
        assert.deepStrictEqual([...await store.readFile('bin/data.bin')], [...data]);
      });

      test('пустой файл: пишется, читается пустым, stat.size = 0', async () => {
        await store.writeFile('e/empty.txt', '');
        assert.strictEqual((await store.readFile('e/empty.txt')).length, 0);
        assert.deepStrictEqual(await store.stat('e/empty.txt'), { path: 'e/empty.txt', type: 'file', size: 0 });
        await store.writeFile('e/empty.bin', new Uint8Array(0));
        assert.strictEqual((await store.readFile('e/empty.bin')).length, 0);
      });

      test('кириллица, пробелы и спецсимволы в именах каталогов и файлов', async () => {
        const rel = 'Каталог с пробелом/Подкаталог №1/Файл (копия) #2 & 3.txt';
        await store.writeFile(rel, 'содержимое');
        assert.strictEqual(fs.readFileSync(path.join(root, ...rel.split('/')), 'utf-8'), 'содержимое');
        assert.strictEqual((await store.readFile(rel)).toString('utf-8'), 'содержимое');
        assert.deepStrictEqual(await store.stat(rel), { path: rel, type: 'file', size: Buffer.byteLength('содержимое') });
      });

      test('перезапись существующего файла заменяет содержимое и не оставляет временных файлов', async () => {
        await store.writeFile('x/f.txt', 'длинное старое содержимое');
        await store.writeFile('x/f.txt', 'new');
        assert.strictEqual((await store.readFile('x/f.txt')).toString('utf-8'), 'new');
        assert.deepStrictEqual(fs.readdirSync(path.join(root, 'x')), ['f.txt']);
      });

      test('readFile несуществующего файла → отказ с относительным путём в сообщении', async () => {
        await assert.rejects(store.readFile('no/such.txt'), /no\/such\.txt/);
      });

      test('writeFile поверх существующего каталога и под файлом-«каталогом» → отказ с путём', async () => {
        await store.mkdirp('dirhere');
        await assert.rejects(store.writeFile('dirhere', 'x'), /dirhere/);
        await store.writeFile('plain', '1');
        await assert.rejects(store.writeFile('plain/child.txt', 'x'), /plain/);
        assert.strictEqual(fs.readFileSync(path.join(root, 'plain'), 'utf-8'), '1');
      });

      test('обратные слэши в относительном пути нормализуются', async () => {
        await store.writeFile('d1\\d2\\f.txt', '1');
        assert.strictEqual(fs.readFileSync(path.join(root, 'd1', 'd2', 'f.txt'), 'utf-8'), '1');
      });
    });

    suite('stat', () => {
      test('файл: type=file, size в байтах, path как передан (POSIX)', async () => {
        await store.writeFile('d/Файл.txt', 'абв');
        assert.deepStrictEqual(await store.stat('d/Файл.txt'), { path: 'd/Файл.txt', type: 'file', size: 6 });
      });

      test('каталог: type=dir; хвостовой слэш не мешает', async () => {
        await store.mkdirp('d/e');
        const entry = await store.stat('d/e/');
        assert.strictEqual(entry?.type, 'dir');
        assert.strictEqual(entry.path, 'd/e');
        assert.strictEqual(entry.size, 0);
      });

      test('корень ("" и ".") — каталог с пустым путём', async () => {
        assert.deepStrictEqual(await store.stat(''), { path: '', type: 'dir', size: 0 });
        assert.strictEqual((await store.stat('.'))?.type, 'dir');
      });

      test('несуществующий путь → undefined (не исключение)', async () => {
        assert.strictEqual(await store.stat('nope'), undefined);
        assert.strictEqual(await store.stat('nope/deeper/file.txt'), undefined);
      });

      test('отказ, не означающий «нет пути» (NUL в имени), пробрасывается, а не превращается в undefined', async () => {
        await assert.rejects(store.stat('a\u0000b'));
      });

      test('файл как промежуточный каталог → undefined', async () => {
        await store.writeFile('f.txt', '1');
        assert.strictEqual(await store.stat('f.txt/child'), undefined);
      });
    });

    suite('mkdirp', () => {
      test('создаёт вложенные каталоги и идемпотентен', async () => {
        await store.mkdirp('a/b/c');
        await store.mkdirp('a/b/c');
        assert.ok(fs.statSync(path.join(root, 'a', 'b', 'c')).isDirectory());
      });

      test('кириллица в каталогах', async () => {
        await store.mkdirp('Конфигурация/Справочники');
        assert.ok(fs.statSync(path.join(root, 'Конфигурация', 'Справочники')).isDirectory());
      });

      test('корень ("" и ".") — не ошибка', async () => {
        await store.mkdirp('');
        await store.mkdirp('.');
      });

      test('поверх существующего файла (и под файлом) → отказ с путём', async () => {
        await store.writeFile('f', '1');
        await assert.rejects(store.mkdirp('f'), /f/);
        await assert.rejects(store.mkdirp('f/sub'), /f/);
      });
    });

    suite('remove', () => {
      test('файл удаляется; удаление отсутствующего пути — не ошибка', async () => {
        await store.writeFile('f.txt', '1');
        await store.remove('f.txt');
        assert.strictEqual(fs.existsSync(path.join(root, 'f.txt')), false);
        await store.remove('f.txt');
        await store.remove('no/such/dir', { recursive: true });
      });

      test('пустой каталог удаляется без recursive', async () => {
        await store.mkdirp('empty');
        await store.remove('empty');
        assert.strictEqual(fs.existsSync(path.join(root, 'empty')), false);
      });

      test('непустой каталог без recursive → отказ, содержимое цело (в отличие от rmdir агента)', async () => {
        await store.writeFile('dir/sub/f.txt', '1');
        await assert.rejects(store.remove('dir'), /dir/);
        await assert.rejects(store.remove('dir', { recursive: false }), /dir/);
        assert.ok(fs.existsSync(path.join(root, 'dir', 'sub', 'f.txt')));
      });

      test('recursive удаляет дерево целиком (с кириллицей), соседей не трогает', async () => {
        await store.writeFile('dir/sub/f.txt', '1');
        await store.writeFile('dir/Каталог/Файл.txt', '2');
        await store.writeFile('dir2/keep.txt', '2');
        await store.remove('dir', { recursive: true });
        assert.strictEqual(fs.existsSync(path.join(root, 'dir')), false);
        assert.ok(fs.existsSync(path.join(root, 'dir2', 'keep.txt')));
      });

      test('recursive по файлу удаляет файл', async () => {
        await store.writeFile('only.txt', '1');
        await store.remove('only.txt', { recursive: true });
        assert.strictEqual(fs.existsSync(path.join(root, 'only.txt')), false);
      });

      test('корень удалить нельзя ("" и ".")', async () => {
        await assert.rejects(store.remove('', { recursive: true }), /корн/);
        await assert.rejects(store.remove('.', { recursive: true }), /корн/);
        assert.ok(fs.existsSync(root));
      });

      test('после удаления каталога запись в тот же путь снова работает (кэш созданных каталогов не залипает)', async () => {
        await store.writeFile('cache/deep/one.txt', '1');
        await store.remove('cache', { recursive: true });
        await store.writeFile('cache/deep/two.txt', '2');
        assert.strictEqual(fs.readFileSync(path.join(root, 'cache', 'deep', 'two.txt'), 'utf-8'), '2');
      });
    });

    suite('list', () => {
      setup(async () => {
        await store.writeFile('w/b.txt', '1');
        await store.writeFile('w/a.txt', '22');
        await store.writeFile('w/sub/deep/c.txt', '333');
        await store.writeFile('other/z.txt', '4');
      });

      test('нерекурсивный: прямые дети, пути от корня хранилища, сортировка по пути', async () => {
        assert.deepStrictEqual(await store.list('w'), [
          { path: 'w/a.txt', type: 'file', size: 2 },
          { path: 'w/b.txt', type: 'file', size: 1 },
          { path: 'w/sub', type: 'dir', size: 0 },
        ]);
      });

      test('рекурсивный: все потомки (файлы и каталоги), отсортированы', async () => {
        const result = await store.list('w', { recursive: true });
        assert.deepStrictEqual(result.map((e) => `${e.type}:${e.path}`), [
          'file:w/a.txt',
          'file:w/b.txt',
          'dir:w/sub',
          'dir:w/sub/deep',
          'file:w/sub/deep/c.txt',
        ]);
        assert.strictEqual(result.find((e) => e.path === 'w/sub/deep/c.txt')?.size, 3);
      });

      test('корень ("") и "." листятся как каталог; "." и ".." в результат не попадают', async () => {
        assert.deepStrictEqual((await store.list('')).map((e) => e.path), ['other', 'w']);
        assert.deepStrictEqual((await store.list('.')).map((e) => e.path), ['other', 'w']);
      });

      test('пустой каталог → []', async () => {
        await store.mkdirp('empty');
        assert.deepStrictEqual(await store.list('empty', { recursive: true }), []);
      });

      test('большой каталог (несколько порций листинга): ни одного пропуска, порядок по пути', async () => {
        const names = Array.from({ length: 130 }, (_, index) => `f${String(index).padStart(3, '0')}.txt`);
        for (const name of names) {
          fs.writeFileSync(path.join(root, 'w', name), '');
        }
        const listed = (await store.list('w')).map((e) => e.path);
        const expected = ['w/a.txt', 'w/b.txt', ...names.map((n) => `w/${n}`), 'w/sub'].sort((a, b) => (a < b ? -1 : 1));
        assert.deepStrictEqual(listed, expected);
      });

      test('кириллица в именах', async () => {
        await store.writeFile('Рус/Файл.txt', '1');
        assert.deepStrictEqual((await store.list('Рус')).map((e) => e.path), ['Рус/Файл.txt']);
      });

      test('несуществующий каталог и файл вместо каталога → отказ с путём', async () => {
        await assert.rejects(store.list('missing'), /missing/);
        await assert.rejects(store.list('w/a.txt'), /w\/a\.txt/);
      });
    });

    suite('границы корня', () => {
      const escaping = ['..', '../x.txt', 'a/../../x.txt', 'a/..', '..\\x.txt'];
      const absolute = ['/etc/passwd', '\\windows\\x', 'C:/x.txt', 'C:\\x.txt', 'c:x.txt'];

      test('выход за корень через ".." отвергается всеми методами и ничего не пишет', async () => {
        const before = fixture.requestCount?.() ?? 0;
        for (const rel of escaping) {
          await assert.rejects(store.readFile(rel), /за пределы корня агента/, rel);
          await assert.rejects(store.writeFile(rel, 'x'), /за пределы корня агента/, rel);
          await assert.rejects(store.stat(rel), /за пределы корня агента/, rel);
          await assert.rejects(store.mkdirp(rel), /за пределы корня агента/, rel);
          await assert.rejects(store.remove(rel, { recursive: true }), /за пределы корня агента/, rel);
          await assert.rejects(store.list(rel), /за пределы корня агента/, rel);
        }
        assert.strictEqual(fixture.requestCount?.() ?? 0, before, 'путь обязан отвергаться ДО обращения к серверу');
        assert.deepStrictEqual(fs.readdirSync(fixture.parent), [path.basename(root)]);
        assert.deepStrictEqual(fs.readdirSync(root), []);
      });

      test('абсолютные пути (POSIX, диск Windows) отвергаются всеми методами', async () => {
        const before = fixture.requestCount?.() ?? 0;
        for (const rel of absolute) {
          await assert.rejects(store.readFile(rel), /относительным/, rel);
          await assert.rejects(store.writeFile(rel, 'x'), /относительным/, rel);
          await assert.rejects(store.stat(rel), /относительным/, rel);
          await assert.rejects(store.mkdirp(rel), /относительным/, rel);
          await assert.rejects(store.remove(rel), /относительным/, rel);
          await assert.rejects(store.list(rel), /относительным/, rel);
        }
        assert.strictEqual(fixture.requestCount?.() ?? 0, before, 'путь обязан отвергаться ДО обращения к серверу');
      });

      test('".." внутри имени (не сегмент) допустим', async () => {
        await store.writeFile('a..b/c..txt', '1');
        assert.strictEqual((await store.stat('a..b/c..txt'))?.type, 'file');
      });

      test('сегменты "." и пустые схлопываются', async () => {
        await store.writeFile('./a//b/./f.txt', '1');
        assert.ok(fs.existsSync(path.join(root, 'a', 'b', 'f.txt')));
      });
    });

    suite('потоковые downloadToFile / uploadFromFile', function () {
      this.timeout(120_000);
      let localDir: string;

      setup(() => { localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-store-stream-')); });
      teardown(() => { fs.rmSync(localDir, { recursive: true, force: true }); });

      const local = (name: string): string => path.join(localDir, name);
      const bytesOf = (length: number, seed = 1): Buffer => patternBytes(length, seed);
      /** Границы порции и окна: пустой, 1 байт, вокруг IO_CHUNK, окно целиком, многопорционный с нечётным хвостом. */
      const SIZES = [0, 1, IO_CHUNK - 1, IO_CHUNK, IO_CHUNK + 1, IO_CHUNK * IO_WINDOW, 2 * 1024 * 1024 + 7];
      const MULTI = 2 * 1024 * 1024 + 7;
      const requests = (): number => fixture.requestCount?.() ?? 0;

      suite('downloadToFile', () => {
        for (const size of SIZES) {
          test(`${String(size)} байт: локальный файл байт-в-байт; прогресс монотонен и доходит до размера`, async () => {
            const data = bytesOf(size, size + 3);
            fs.writeFileSync(path.join(root, 'src.bin'), data);
            const progress: [number, number | undefined][] = [];

            await store.downloadToFile('src.bin', local('dst.bin'), { onProgress: (done, total) => { progress.push([done, total]); } });

            assert.ok(data.equals(fs.readFileSync(local('dst.bin'))));
            for (let i = 1; i < progress.length; i += 1) {
              assert.ok(progress[i][0] >= progress[i - 1][0], 'прогресс не убывает');
            }
            if (size > 0) {
              assert.strictEqual(progress.at(-1)?.[0], size);
              assert.ok(progress.every(([, total]) => total === size), 'размер известен и не меняется');
            }
          });
        }

        test('кириллица и пробелы в удалённом и локальном путях', async () => {
          await store.writeFile('Каталог с пробелом/Выгрузка №1.zip', 'содержимое');
          const target = local('Локальный каталог');
          fs.mkdirSync(target);
          await store.downloadToFile('Каталог с пробелом/Выгрузка №1.zip', path.join(target, 'Архив (копия).zip'));
          assert.strictEqual(fs.readFileSync(path.join(target, 'Архив (копия).zip'), 'utf-8'), 'содержимое');
        });

        test('отсутствующий источник → отказ с путём, локального файла нет', async () => {
          await assert.rejects(store.downloadToFile('no/such.bin', local('dst.bin')), /no\/such\.bin/);
          assert.strictEqual(fs.existsSync(local('dst.bin')), false);
        });

        test('каталог вместо файла-источника → отказ, локального файла нет', async () => {
          await store.mkdirp('dir');
          await assert.rejects(store.downloadToFile('dir', local('dst.bin')), /dir/);
          assert.strictEqual(fs.existsSync(local('dst.bin')), false);
        });

        test('локальный файл уже существует → отказ (открытие wx), прежнее содержимое не тронуто', async () => {
          await store.writeFile('src.bin', 'новое');
          fs.writeFileSync(local('dst.bin'), 'прежнее');
          await assert.rejects(store.downloadToFile('src.bin', local('dst.bin')));
          assert.strictEqual(fs.readFileSync(local('dst.bin'), 'utf-8'), 'прежнее');
        });

        test('отмена до старта: AgentTransferCancelledError, локального файла нет', async () => {
          await store.writeFile('src.bin', bytesOf(100_000));
          await assert.rejects(
            store.downloadToFile('src.bin', local('dst.bin'), { cancellation: { isCancellationRequested: true } }),
            AgentTransferCancelledError
          );
          assert.strictEqual(fs.existsSync(local('dst.bin')), false);
        });

        test('отмена посреди передачи (после первой порции): AgentTransferCancelledError, неполного локального файла нет', async () => {
          fs.writeFileSync(path.join(root, 'big.bin'), bytesOf(MULTI));
          const cancellation = { isCancellationRequested: false };
          await assert.rejects(
            store.downloadToFile('big.bin', local('dst.bin'), {
              cancellation,
              onProgress: () => { cancellation.isCancellationRequested = true; },
            }),
            AgentTransferCancelledError
          );
          assert.strictEqual(fs.existsSync(local('dst.bin')), false);
          assert.deepStrictEqual(fs.readdirSync(localDir), []);
        });

        test('".." и абсолютный путь отвергаются ДО обращения к серверу; локальный файл не создаётся', async () => {
          const before = requests();
          for (const rel of ['..', '../x.bin', 'a/../../x.bin']) {
            await assert.rejects(store.downloadToFile(rel, local('dst.bin')), /за пределы корня агента/, rel);
          }
          for (const rel of ['/etc/passwd', 'C:/x.bin', 'C:\\x.bin']) {
            await assert.rejects(store.downloadToFile(rel, local('dst.bin')), /относительным/, rel);
          }
          assert.strictEqual(requests(), before);
          assert.strictEqual(fs.existsSync(local('dst.bin')), false);
        });
      });

      suite('uploadFromFile', () => {
        for (const size of SIZES) {
          test(`${String(size)} байт: файл хранилища байт-в-байт, остатков временных файлов нет`, async () => {
            const data = bytesOf(size, size + 5);
            fs.writeFileSync(local('src.bin'), data);

            await store.uploadFromFile(local('src.bin'), 'up/dst.bin');

            assert.ok(data.equals(fs.readFileSync(path.join(root, 'up', 'dst.bin'))));
            assert.deepStrictEqual(fs.readdirSync(path.join(root, 'up')), ['dst.bin']);
            assert.ok(data.equals(fs.readFileSync(local('src.bin'))), 'локальный источник не изменён');
          });
        }

        test('прогресс монотонен и доходит до размера файла', async () => {
          fs.writeFileSync(local('src.bin'), bytesOf(MULTI));
          const progress: number[] = [];
          await store.uploadFromFile(local('src.bin'), 'dst.bin', { onProgress: (done) => { progress.push(done); } });
          for (let i = 1; i < progress.length; i += 1) {
            assert.ok(progress[i] >= progress[i - 1]);
          }
          assert.strictEqual(progress.at(-1), MULTI);
        });

        test('перезапись существующего файла: цель заменена целиком, остатков нет', async () => {
          await store.writeFile('x/f.bin', 'длинное старое содержимое');
          fs.writeFileSync(local('src.bin'), 'new');
          await store.uploadFromFile(local('src.bin'), 'x/f.bin');
          assert.strictEqual(fs.readFileSync(path.join(root, 'x', 'f.bin'), 'utf-8'), 'new');
          assert.deepStrictEqual(fs.readdirSync(path.join(root, 'x')), ['f.bin']);
        });

        test('промежуточные каталоги создаются; кириллица в путях', async () => {
          fs.writeFileSync(local('Файл (копия).zip'), 'данные');
          await store.uploadFromFile(local('Файл (копия).zip'), 'Каталог с пробелом/Вложенный/Архив №1.zip');
          assert.strictEqual(fs.readFileSync(path.join(root, 'Каталог с пробелом', 'Вложенный', 'Архив №1.zip'), 'utf-8'), 'данные');
        });

        test('локального файла нет → отказ, цель не создана, остатков нет', async () => {
          await assert.rejects(store.uploadFromFile(local('нет.bin'), 'dst/f.bin'), /нет\.bin/);
          assert.strictEqual(fs.existsSync(path.join(root, 'dst', 'f.bin')), false);
          assert.deepStrictEqual(fs.existsSync(path.join(root, 'dst')) ? fs.readdirSync(path.join(root, 'dst')) : [], []);
        });

        test('отмена до старта: AgentTransferCancelledError, прежняя цель цела, остатков нет', async () => {
          await store.writeFile('keep/f.bin', 'прежнее');
          fs.writeFileSync(local('src.bin'), bytesOf(100_000));
          await assert.rejects(
            store.uploadFromFile(local('src.bin'), 'keep/f.bin', { cancellation: { isCancellationRequested: true } }),
            AgentTransferCancelledError
          );
          assert.strictEqual(fs.readFileSync(path.join(root, 'keep', 'f.bin'), 'utf-8'), 'прежнее');
          assert.deepStrictEqual(fs.readdirSync(path.join(root, 'keep')), ['f.bin']);
        });

        test('отмена посреди передачи: прежняя цель цела (атомарность), временный файл удалён', async () => {
          await store.writeFile('keep/f.bin', 'прежнее');
          fs.writeFileSync(local('src.bin'), bytesOf(MULTI));
          const cancellation = { isCancellationRequested: false };
          await assert.rejects(
            store.uploadFromFile(local('src.bin'), 'keep/f.bin', {
              cancellation,
              onProgress: () => { cancellation.isCancellationRequested = true; },
            }),
            AgentTransferCancelledError
          );
          assert.strictEqual(fs.readFileSync(path.join(root, 'keep', 'f.bin'), 'utf-8'), 'прежнее');
          assert.deepStrictEqual(fs.readdirSync(path.join(root, 'keep')), ['f.bin']);
        });

        test('цель — каталог или под файлом-«каталогом» → отказ с путём', async () => {
          await store.mkdirp('dirhere');
          await store.writeFile('plain', '1');
          fs.writeFileSync(local('src.bin'), 'x');
          await assert.rejects(store.uploadFromFile(local('src.bin'), 'dirhere'), /dirhere/);
          await assert.rejects(store.uploadFromFile(local('src.bin'), 'plain/child.bin'), /plain/);
          assert.strictEqual(fs.readFileSync(path.join(root, 'plain'), 'utf-8'), '1');
        });

        test('".." и абсолютный путь отвергаются ДО обращения к серверу; ничего не создаётся', async () => {
          fs.writeFileSync(local('src.bin'), 'x');
          const before = requests();
          for (const rel of ['..', '../x.bin', 'a/../../x.bin']) {
            await assert.rejects(store.uploadFromFile(local('src.bin'), rel), /за пределы корня агента/, rel);
          }
          for (const rel of ['/etc/x.bin', 'C:/x.bin', 'C:\\x.bin']) {
            await assert.rejects(store.uploadFromFile(local('src.bin'), rel), /относительным/, rel);
          }
          assert.strictEqual(requests(), before);
          assert.deepStrictEqual(fs.readdirSync(fixture.parent), [path.basename(root)]);
          assert.deepStrictEqual(fs.readdirSync(root), []);
        });
      });
    });
  });
}
