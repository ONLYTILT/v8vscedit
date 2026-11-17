import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LocalAgentFileStore,
  createLocalAgentFileStore,
  resolveLocalAgentUserRoot,
} from '../../infra/agent/files/LocalAgentFileStore';

suite('LocalAgentFileStore', () => {
  let base: string;
  let root: string;
  let store: LocalAgentFileStore;

  setup(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-store-'));
    root = path.join(base, 'user-root');
    fs.mkdirSync(root);
    store = new LocalAgentFileStore(root);
  });
  teardown(() => { fs.rmSync(base, { recursive: true, force: true }); });

  test('kind = local; dispose выполняется повторно без ошибок', async () => {
    assert.strictEqual(store.kind, 'local');
    await store.dispose();
    await store.dispose();
  });

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

    test('перезапись существующего файла заменяет содержимое и не оставляет временных файлов', async () => {
      await store.writeFile('x/f.txt', 'длинное старое содержимое');
      await store.writeFile('x/f.txt', 'new');
      assert.strictEqual((await store.readFile('x/f.txt')).toString('utf-8'), 'new');
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'x')), ['f.txt']);
    });

    test('readFile несуществующего файла → отказ с относительным путём в сообщении', async () => {
      await assert.rejects(store.readFile('no/such.txt'), /no\/such\.txt/);
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
    });

    test('корень ("" и ".") — каталог с пустым путём', async () => {
      assert.deepStrictEqual(await store.stat(''), { path: '', type: 'dir', size: 0 });
      assert.strictEqual((await store.stat('.'))?.type, 'dir');
    });

    test('несуществующий путь → undefined (не исключение)', async () => {
      assert.strictEqual(await store.stat('nope'), undefined);
      assert.strictEqual(await store.stat('nope/deeper/file.txt'), undefined);
    });

    test('ошибка ФС, не означающая «нет пути» (NUL в имени), пробрасывается, а не превращается в undefined', async () => {
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

    test('поверх существующего файла → отказ', async () => {
      await store.writeFile('f', '1');
      await assert.rejects(store.mkdirp('f'));
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

    test('recursive удаляет дерево целиком, соседей не трогает', async () => {
      await store.writeFile('dir/sub/f.txt', '1');
      await store.writeFile('dir2/keep.txt', '2');
      await store.remove('dir', { recursive: true });
      assert.strictEqual(fs.existsSync(path.join(root, 'dir')), false);
      assert.ok(fs.existsSync(path.join(root, 'dir2', 'keep.txt')));
    });

    test('корень удалить нельзя ("" и ".")', async () => {
      await assert.rejects(store.remove('', { recursive: true }), /корн/);
      await assert.rejects(store.remove('.', { recursive: true }), /корн/);
      assert.ok(fs.existsSync(root));
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

    test('корень ("") листится как каталог', async () => {
      assert.deepStrictEqual((await store.list('')).map((e) => e.path), ['other', 'w']);
    });

    test('пустой каталог → []', async () => {
      await store.mkdirp('empty');
      assert.deepStrictEqual(await store.list('empty', { recursive: true }), []);
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
      for (const rel of escaping) {
        await assert.rejects(store.readFile(rel), /за пределы корня агента/, rel);
        await assert.rejects(store.writeFile(rel, 'x'), /за пределы корня агента/, rel);
        await assert.rejects(store.stat(rel), /за пределы корня агента/, rel);
        await assert.rejects(store.mkdirp(rel), /за пределы корня агента/, rel);
        await assert.rejects(store.remove(rel, { recursive: true }), /за пределы корня агента/, rel);
        await assert.rejects(store.list(rel), /за пределы корня агента/, rel);
      }
      assert.deepStrictEqual(fs.readdirSync(base), ['user-root']);
      assert.deepStrictEqual(fs.readdirSync(root), []);
    });

    test('абсолютные пути (POSIX, диск Windows) отвергаются всеми методами', async () => {
      for (const rel of absolute) {
        await assert.rejects(store.readFile(rel), /относительным/, rel);
        await assert.rejects(store.writeFile(rel, 'x'), /относительным/, rel);
        await assert.rejects(store.stat(rel), /относительным/, rel);
        await assert.rejects(store.mkdirp(rel), /относительным/, rel);
        await assert.rejects(store.remove(rel), /относительным/, rel);
        await assert.rejects(store.list(rel), /относительным/, rel);
      }
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

suite('LocalAgentFileStore: ссылки (symlink/junction) — защита в глубину', () => {
  let base: string;
  let root: string;
  let outside: string;
  let store: LocalAgentFileStore;

  /** junction на Windows создаётся без прав администратора, в отличие от symlink. */
  function linkDir(target: string, link: string): void {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }

  setup(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-links-'));
    root = path.join(base, 'user-root');
    outside = path.join(base, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'секрет', 'utf-8');
    linkDir(outside, path.join(root, 'link'));
    store = new LocalAgentFileStore(root);
  });
  teardown(() => { fs.rmSync(base, { recursive: true, force: true }); });

  test('путь через ссылку наружу отвергается чтением, записью, stat, mkdirp и list; снаружи ничего не создано', async () => {
    await assert.rejects(store.readFile('link/secret.txt'), /за пределы корня агента/);
    await assert.rejects(store.writeFile('link/new.txt', 'x'), /за пределы корня агента/);
    await assert.rejects(store.writeFile('link/deep/new.txt', 'x'), /за пределы корня агента/);
    await assert.rejects(store.stat('link/secret.txt'), /за пределы корня агента/);
    await assert.rejects(store.stat('link'), /за пределы корня агента/);
    await assert.rejects(store.mkdirp('link/sub'), /за пределы корня агента/);
    await assert.rejects(store.list('link'), /за пределы корня агента/);
    assert.deepStrictEqual(fs.readdirSync(outside), ['secret.txt']);
  });

  test('отсутствующий путь за ссылкой: stat → undefined (о чужом каталоге ничего не сообщается)', async () => {
    assert.strictEqual(await store.stat('link/nope.txt'), undefined);
  });

  test('list не перечисляет ссылки и не заходит в них (рекурсивно тоже)', async () => {
    await store.writeFile('w/a.txt', '1');
    linkDir(outside, path.join(root, 'w', 'inner-link'));
    assert.deepStrictEqual((await store.list('')).map((e) => e.path), ['w']);
    assert.deepStrictEqual((await store.list('', { recursive: true })).map((e) => e.path), ['w', 'w/a.txt']);
  });

  test('remove удаляет саму ссылку, цель цела; удаление через ссылку — отказ', async () => {
    await assert.rejects(store.remove('link/secret.txt'), /за пределы корня агента/);
    await store.remove('link');
    assert.strictEqual(fs.existsSync(path.join(root, 'link')), false);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf-8'), 'секрет');
  });

  test('ссылка внутрь корня прозрачна', async () => {
    await store.writeFile('real/f.txt', 'внутри');
    linkDir(path.join(root, 'real'), path.join(root, 'alias'));
    assert.strictEqual((await store.readFile('alias/f.txt')).toString('utf-8'), 'внутри');
    assert.strictEqual((await store.stat('alias/f.txt'))?.type, 'file');
  });

  test('корень хранилища сам может быть ссылкой: работа внутри него разрешена', async () => {
    const linkedRoot = path.join(base, 'linked-root');
    linkDir(root, linkedRoot);
    const viaLink = new LocalAgentFileStore(linkedRoot);
    await viaLink.writeFile('x/y.txt', '1');
    assert.strictEqual(fs.readFileSync(path.join(root, 'x', 'y.txt'), 'utf-8'), '1');
  });

  test('недопустимое имя (NUL): отказ ФС пробрасывается из readFile и remove, а не маскируется', async () => {
    await assert.rejects(store.readFile('a\u0000b'), (error: Error) => !error.message.includes('за пределы корня'));
    await assert.rejects(store.remove('a\u0000b'), (error: Error) => !error.message.includes('за пределы корня'));
  });
});

suite('resolveLocalAgentUserRoot / createLocalAgentFileStore', () => {
  let base: string;
  setup(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-userroot-')); });
  teardown(() => { fs.rmSync(base, { recursive: true, force: true }); });

  function writeIndex(users: { name: string; dir: string }[], bom = false): string {
    const file = path.join(base, 'agentbasedir.json');
    fs.writeFileSync(file, `${bom ? '\uFEFF' : ''}${JSON.stringify({ usersInfo: users })}`, 'utf-8');
    return file;
  }

  test('корень пользователя = <agentBaseDir>/<dir из agentbasedir.json>, регистр имени не важен, BOM допустим', async () => {
    writeIndex([{ name: 'КытмановА', dir: '7' }], true);
    assert.strictEqual(await resolveLocalAgentUserRoot(base, 'кытмановА'), path.join(base, '7'));
  });

  test('файла нет → ошибка с путём к agentbasedir.json', async () => {
    await assert.rejects(
      resolveLocalAgentUserRoot(base, 'u'),
      (error: Error) => error.message.includes(path.join(base, 'agentbasedir.json'))
    );
  });

  test('пользователь не найден → ошибка с путём к файлу и логином', async () => {
    const file = writeIndex([{ name: 'other', dir: '0' }]);
    await assert.rejects(
      resolveLocalAgentUserRoot(base, 'ghost'),
      (error: Error) => error.message.includes(file) && error.message.includes('ghost')
    );
  });

  test('битый файл → ошибка разбора (agentbasedir.json)', async () => {
    fs.writeFileSync(path.join(base, 'agentbasedir.json'), '{oops', 'utf-8');
    await assert.rejects(resolveLocalAgentUserRoot(base, 'u'), /agentbasedir\.json/);
  });

  test('createLocalAgentFileStore: хранилище работает в каталоге пользователя; каталог создаётся при записи', async () => {
    writeIndex([{ name: 'u', dir: '7' }]);
    const store = await createLocalAgentFileStore(base, 'u');
    assert.strictEqual(store.kind, 'local');
    await store.writeFile('lists/op.txt', 'x');
    assert.ok(fs.existsSync(path.join(base, '7', 'lists', 'op.txt')));
  });

  test('createLocalAgentFileStore пробрасывает ошибку «пользователь не найден»', async () => {
    writeIndex([]);
    await assert.rejects(createLocalAgentFileStore(base, 'u'), /u/);
  });
});
