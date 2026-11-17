import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentFileStore } from '../../../infra/agent/files/AgentFileStore';

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
  });
}
