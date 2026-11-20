import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { filesHaveSameContent } from '../../infra/fs/FileContentCompare';
import { removeTreeSync } from './support/tempTree';
import { patternBytes } from './support/zipFixtures';

/**
 * Побайтное сравнение двух файлов порциями (plan-large-files.md §2.4): без чтения файла целиком и без хеша.
 * Все случаи — на настоящих временных файлах; граница порции проверяется малым `chunkBytes = 7`.
 */
suite('filesHaveSameContent', () => {
  let dir: string;
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-compare-')); });
  teardown(() => { removeTreeSync(dir); });

  const put = (name: string, data: Buffer): string => {
    const target = path.join(dir, name);
    fs.writeFileSync(target, data);
    return target;
  };

  test('равное содержимое: true', async () => {
    const data = patternBytes(100_000, 3);
    assert.strictEqual(await filesHaveSameContent(put('a', data), put('b', Buffer.from(data))), true);
  });

  test('оба файла пусты: true', async () => {
    assert.strictEqual(await filesHaveSameContent(put('a', Buffer.alloc(0)), put('b', Buffer.alloc(0))), true);
  });

  test('файл сравнивается сам с собой: true', async () => {
    const file = put('a', patternBytes(50, 1));
    assert.strictEqual(await filesHaveSameContent(file, file), true);
  });

  test('разный размер: false при любом размере порции (решает размер, содержимое не читается)', async () => {
    const data = patternBytes(100, 5);
    const a = put('a', data);
    const b = put('b', Buffer.concat([data, Buffer.from([1])]));
    for (const chunk of [1, 7, 64, 1024 * 1024]) {
      assert.strictEqual(await filesHaveSameContent(a, b, chunk), false, `порция ${String(chunk)}`);
    }
  });

  test('один пустой, другой нет: false', async () => {
    assert.strictEqual(await filesHaveSameContent(put('a', Buffer.alloc(0)), put('b', Buffer.from([0]))), false);
  });

  const CHUNK = 7;
  const SIZES: readonly [string, number][] = [
    ['меньше порции', CHUNK - 1],
    ['ровно порция', CHUNK],
    ['порция + 1', CHUNK + 1],
    ['2 порции − 1', 2 * CHUNK - 1],
    ['2 порции', 2 * CHUNK],
    ['2 порции + 1', 2 * CHUNK + 1],
    ['много порций с хвостом', 10 * CHUNK + 3],
  ];
  for (const [label, size] of SIZES) {
    test(`размер ${String(size)} (${label}): равные — true; отличие в первом, последнем и каждом байте — false`, async () => {
      const data = patternBytes(size, 11);
      const a = put('a', data);
      assert.strictEqual(await filesHaveSameContent(a, put('same', Buffer.from(data)), CHUNK), true);
      for (let index = 0; index < size; index += 1) {
        const changed = Buffer.from(data);
        changed[index] ^= 0xff;
        assert.strictEqual(await filesHaveSameContent(a, put('b', changed), CHUNK), false, `байт ${String(index)}`);
      }
    });
  }

  test('порция по умолчанию (1 МиБ): равные файлы больше порции — true, отличие в последнем байте — false', async () => {
    const data = patternBytes(1024 * 1024 + 5, 17);
    const a = put('a', data);
    assert.strictEqual(await filesHaveSameContent(a, put('b', Buffer.from(data))), true);
    const changed = Buffer.from(data);
    changed[changed.length - 1] ^= 1;
    assert.strictEqual(await filesHaveSameContent(a, put('c', changed)), false);
  });

  test('первого файла нет: false, без исключения', async () => {
    assert.strictEqual(await filesHaveSameContent(path.join(dir, 'нет'), put('b', Buffer.from([1]))), false);
  });

  test('второго файла нет: false, без исключения', async () => {
    assert.strictEqual(await filesHaveSameContent(put('a', Buffer.from([1])), path.join(dir, 'нет')), false);
  });

  test('обоих файлов нет: false (отсутствие не «равно» отсутствию)', async () => {
    assert.strictEqual(await filesHaveSameContent(path.join(dir, 'x'), path.join(dir, 'y')), false);
  });

  test('после сравнения дескрипторы закрыты: файлы удаляются (на Windows открытый файл не удалить)', async () => {
    const a = put('a', patternBytes(100, 2));
    const b = put('b', patternBytes(100, 3));
    await filesHaveSameContent(a, b, CHUNK);
    fs.unlinkSync(a);
    fs.unlinkSync(b);
    assert.ok(!fs.existsSync(a) && !fs.existsSync(b));
  });
});
