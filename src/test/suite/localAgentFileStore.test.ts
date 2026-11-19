import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LocalAgentFileStore,
  createLocalAgentFileStore,
  resolveLocalAgentUserRoot,
} from '../../infra/agent/files/LocalAgentFileStore';

import { defineAgentFileStoreContract } from './support/agentFileStoreContract';

defineAgentFileStoreContract('local', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-store-'));
  const root = path.join(base, 'user-root');
  fs.mkdirSync(root);
  return Promise.resolve({
    store: new LocalAgentFileStore(root),
    root,
    parent: base,
    dispose: () => {
      fs.rmSync(base, { recursive: true, force: true });
      return Promise.resolve();
    },
  });
});

suite('LocalAgentFileStore', () => {
  test('kind = local; dispose выполняется повторно без ошибок', async () => {
    const store = new LocalAgentFileStore(os.tmpdir());
    assert.strictEqual(store.kind, 'local');
    await store.dispose();
    await store.dispose();
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
