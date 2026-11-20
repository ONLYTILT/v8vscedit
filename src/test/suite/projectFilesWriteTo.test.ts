import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyProjectChanges, type ProjectFileContent } from '../../infra/agent/sync/ProjectFiles';
import { createSyncProgress } from '../../infra/agent/sync/SyncProgress';
import { removeTreeSync } from './support/tempTree';
import { patternBytes } from './support/zipFixtures';

/**
 * Приёмник записи в P с потоковым содержимым (plan-large-files.md §2.4): вместо `Uint8Array` — `{ writeTo(temp) }`.
 * Запись идёт через `writeFileAtomicWith` (temp+rename, единственная реализация): отказ внутри `writeTo` оставляет
 * цель прежней и убирает временный файл. Порядок `Configuration.xml` последним и точки `onWillChange` не меняются.
 */
suite('applyProjectChanges: потоковое содержимое writeTo', function () {
  this.timeout(30_000);
  let dir: string;
  let staging: string;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-apply-writeto-'));
    staging = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-apply-staging-'));
  });
  teardown(() => { removeTreeSync(dir); removeTreeSync(staging); });

  const abs = (rel: string): string => path.join(dir, ...rel.split('/'));

  /** `writeTo`, копирующий готовый staging-файл во временный файл записи, как это делает дельта импорта. */
  function copyOf(source: string): ProjectFileContent {
    return { writeTo: (tempPath) => fs.promises.copyFile(source, tempPath) };
  }

  function stage(name: string, data: Buffer): string {
    const file = path.join(staging, name);
    fs.writeFileSync(file, data);
    return file;
  }

  function leftovers(): string[] {
    const out: string[] = [];
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(path.join(current, entry.name));
        } else if (entry.name.endsWith('.tmp')) {
          out.push(entry.name);
        }
      }
    };
    walk(dir);
    return out;
  }

  test('новый файл: создаётся с каталогами, содержимое побайтно, временных файлов нет', async () => {
    const data = patternBytes(300_000, 5);
    const source = stage('a.bin', data);

    const changed = await applyProjectChanges({
      projectDir: dir,
      writes: ['Ext/ParentConfigurations/Поставщик.cf'],
      deletes: [],
      read: async (_rels, sink) => { await sink('Ext/ParentConfigurations/Поставщик.cf', copyOf(source)); },
    });

    assert.deepStrictEqual(changed, [abs('Ext/ParentConfigurations/Поставщик.cf')]);
    assert.ok(fs.readFileSync(abs('Ext/ParentConfigurations/Поставщик.cf')).equals(data));
    assert.deepStrictEqual(leftovers(), []);
  });

  test('существующий файл подменяется целиком; права цели сохраняются (механика writeFileAtomicWith)', async () => {
    fs.mkdirSync(abs('Ext'), { recursive: true });
    fs.writeFileSync(abs('Ext/Данные.bin'), 'старое содержимое, длиннее нового');
    const data = Buffer.from([1, 2, 3]);

    await applyProjectChanges({
      projectDir: dir,
      writes: ['Ext/Данные.bin'],
      deletes: [],
      read: async (_rels, sink) => { await sink('Ext/Данные.bin', copyOf(stage('n.bin', data))); },
    });

    assert.ok(fs.readFileSync(abs('Ext/Данные.bin')).equals(data));
    assert.deepStrictEqual(leftovers(), []);
  });

  test('отказ внутри writeTo: цель прежняя, временный файл убран, ошибка пробрасывается', async () => {
    fs.mkdirSync(abs('Ext'), { recursive: true });
    fs.writeFileSync(abs('Ext/Данные.bin'), 'прежнее');
    const failing: ProjectFileContent = {
      writeTo: async (tempPath) => {
        await fs.promises.writeFile(tempPath, 'половина');
        throw new Error('диск отказал');
      },
    };

    await assert.rejects(
      applyProjectChanges({
        projectDir: dir,
        writes: ['Ext/Данные.bin'],
        deletes: [],
        read: async (_rels, sink) => { await sink('Ext/Данные.bin', failing); },
      }),
      /диск отказал/
    );

    assert.strictEqual(fs.readFileSync(abs('Ext/Данные.bin'), 'utf-8'), 'прежнее');
    assert.deepStrictEqual(leftovers(), []);
  });

  test('отказ внутри writeTo нового файла: цели нет, мусора нет', async () => {
    await assert.rejects(
      applyProjectChanges({
        projectDir: dir,
        writes: ['Новый/Файл.bin'],
        deletes: [],
        read: async (_rels, sink) => { await sink('Новый/Файл.bin', { writeTo: () => Promise.reject(new Error('обрыв')) }); },
      }),
      /обрыв/
    );
    assert.ok(!fs.existsSync(abs('Новый/Файл.bin')));
    assert.deepStrictEqual(leftovers(), []);
  });

  test('Configuration.xml с содержимым writeTo пишется ПОСЛЕДНИМ; onWillChange — до записей, перед корнем и после всех', async () => {
    const order: string[] = [];
    const seenAtHook: { configuration: string | undefined; module: string | undefined }[] = [];
    const wrap = (name: string, text: string): ProjectFileContent => ({
      writeTo: async (tempPath) => { order.push(name); await fs.promises.writeFile(tempPath, text); },
    });
    const contents: Record<string, ProjectFileContent> = {
      'Configuration.xml': wrap('Configuration.xml', '<Configuration v="2"/>'),
      'Catalogs/А.xml': wrap('Catalogs/А.xml', '<А/>'),
      'Ext/Модуль.bsl': wrap('Ext/Модуль.bsl', 'новый модуль'),
    };
    fs.mkdirSync(abs('Ext'), { recursive: true });
    fs.writeFileSync(abs('Configuration.xml'), '<Configuration v="1"/>');
    fs.writeFileSync(abs('Ext/Модуль.bsl'), 'старый модуль');

    await applyProjectChanges({
      projectDir: dir,
      writes: ['Configuration.xml', 'Catalogs/А.xml', 'Ext/Модуль.bsl'],
      deletes: [],
      read: async (rels, sink) => { for (const rel of rels) { await sink(rel, contents[rel]); } },
      onWillChange: () => {
        seenAtHook.push({
          configuration: fs.readFileSync(abs('Configuration.xml'), 'utf-8'),
          module: fs.readFileSync(abs('Ext/Модуль.bsl'), 'utf-8'),
        });
      },
    });

    assert.deepStrictEqual(order, ['Catalogs/А.xml', 'Ext/Модуль.bsl', 'Configuration.xml']);
    assert.strictEqual(seenAtHook.length, 3);
    assert.deepStrictEqual(seenAtHook[0], { configuration: '<Configuration v="1"/>', module: 'старый модуль' }, 'до первой записи');
    assert.deepStrictEqual(seenAtHook[1], { configuration: '<Configuration v="1"/>', module: 'новый модуль' }, 'перед корнем: прочее уже записано');
    assert.deepStrictEqual(seenAtHook[2], { configuration: '<Configuration v="2"/>', module: 'новый модуль' }, 'после всех записей');
  });

  test('смесь Uint8Array и writeTo в одной операции; удаления выполняются', async () => {
    fs.mkdirSync(abs('Catalogs'), { recursive: true });
    fs.writeFileSync(abs('Catalogs/Удалить.xml'), 'x');
    const big = patternBytes(100_000, 8);
    const source = stage('big.bin', big);

    const changed = await applyProjectChanges({
      projectDir: dir,
      writes: ['Catalogs/Малый.xml', 'Catalogs/Большой.bsl'],
      deletes: ['Catalogs/Удалить.xml'],
      read: async (_rels, sink) => {
        await sink('Catalogs/Малый.xml', Buffer.from('<М/>'));
        await sink('Catalogs/Большой.bsl', copyOf(source));
      },
    });

    assert.strictEqual(changed.length, 3);
    assert.strictEqual(fs.readFileSync(abs('Catalogs/Малый.xml'), 'utf-8'), '<М/>');
    assert.ok(fs.readFileSync(abs('Catalogs/Большой.bsl')).equals(big));
    assert.ok(!fs.existsSync(abs('Catalogs/Удалить.xml')));
  });

  test('символьная ссылка-цель: пишется файл, на который она указывает; сама ссылка остаётся ссылкой', async function () {
    const realFile = path.join(staging, 'real.bin');
    fs.writeFileSync(realFile, 'до');
    fs.mkdirSync(abs('Ext'), { recursive: true });
    try {
      fs.symlinkSync(realFile, abs('Ext/Ссылка.bin'));
    } catch {
      this.skip(); // Windows без права на символьные ссылки
    }
    const data = Buffer.from('после записи через ссылку');

    await applyProjectChanges({
      projectDir: dir,
      writes: ['Ext/Ссылка.bin'],
      deletes: [],
      read: async (_rels, sink) => { await sink('Ext/Ссылка.bin', copyOf(stage('n.bin', data))); },
    });

    assert.ok(fs.lstatSync(abs('Ext/Ссылка.bin')).isSymbolicLink(), 'ссылка не заменена обычным файлом');
    assert.ok(fs.readFileSync(realFile).equals(data));
  });

  test('onProgress: счётчик записи считает и потоковые файлы', async () => {
    const messages: string[] = [];
    const progress = createSyncProgress({ onMessage: (message) => { messages.push(message); } }, () => 0);

    await applyProjectChanges({
      projectDir: dir,
      writes: ['Ext/А.bsl'],
      deletes: [],
      read: async (_rels, sink) => { await sink('Ext/А.bsl', copyOf(stage('a.bin', Buffer.from('1')))); },
      onProgress: progress,
    });

    assert.strictEqual(messages.at(-1), 'Запись в проект: 1 из 1 файлов');
  });
});
