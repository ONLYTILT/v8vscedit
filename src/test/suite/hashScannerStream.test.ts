import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildHashSnapshot, hashContent } from '../../infra/cache/HashCache';
import {
  HASH_STREAM_THRESHOLD_BYTES,
  nodeHashScanFs,
  scanCurrentHashes,
  scanHashSnapshot,
} from '../../infra/cache/HashScanner';
import { emptyHashStatMemo } from '../../infra/cache/HashStatMemo';
import { countingFs, fsError, futureNow, writeRel } from './support/hashScanFixtures';
import { removeTreeSync } from './support/tempTree';
import { patternBytes } from './support/zipFixtures';

/**
 * Потоковый хеш больших файлов базовой линии (plan-large-files.md §2.6): большой отслеживаемый файл (.xml/.bsl/макет) проход
 * не читает его одним буфером. Результат обязан совпадать с `hashContent` (SHA-1 hex); порядок «stat до чтения»,
 * stat-мемо, racy-защита и `rethrowUnlessGone` те же, что у буферного пути. Порог — параметр опций, как в тестах плана.
 */
suite('HashScanner: потоковый хеш больших файлов', function () {
  this.timeout(60_000);
  let projectRoot: string;
  let configDir: string;
  const SCOPE = 'cf::stream';
  const sha1 = (data: Buffer): string => createHash('sha1').update(data).digest('hex');
  const THRESHOLD = 100;

  setup(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-hash-stream-'));
    configDir = path.join(projectRoot, 'src', 'cf');
  });
  teardown(() => { removeTreeSync(projectRoot); });

  test('порог по умолчанию — 16 МиБ', () => {
    assert.strictEqual(HASH_STREAM_THRESHOLD_BYTES, 16 * 1024 * 1024);
  });

  test('файл больше порога хешируется потоком (hashFile), readFile не зовётся; хеш = hashContent', async () => {
    const big = patternBytes(THRESHOLD * 50 + 3, 9);
    writeRel(configDir, 'Ext/Данные.bsl', big);
    const counting = countingFs();

    const result = await scanCurrentHashes(configDir, emptyHashStatMemo(configDir), { fs: counting, streamThresholdBytes: THRESHOLD });

    assert.strictEqual(result.files['Ext/Данные.bsl'], hashContent(big));
    assert.strictEqual(result.files['Ext/Данные.bsl'], sha1(big));
    assert.strictEqual(counting.counts.readFile, 0);
    assert.strictEqual(counting.counts.hashFile, 1);
    assert.strictEqual(result.hashed, 1);
  });

  test('граница: размер ровно равен порогу — поток; на байт меньше — буфер', async () => {
    writeRel(configDir, 'Ext/Равный.bsl', patternBytes(THRESHOLD, 1));
    writeRel(configDir, 'Ext/Меньше.bsl', patternBytes(THRESHOLD - 1, 2));
    const counting = countingFs();

    await scanCurrentHashes(configDir, emptyHashStatMemo(configDir), { fs: counting, streamThresholdBytes: THRESHOLD });

    assert.deepStrictEqual(counting.hashPaths.map((file) => path.basename(file)), ['Равный.bsl']);
    assert.deepStrictEqual(counting.readPaths.map((file) => path.basename(file)), ['Меньше.bsl']);
  });

  test('смесь малых и больших: хеши всех файлов совпадают с эталонным buildHashSnapshot', async () => {
    writeRel(configDir, 'Configuration.xml', '<Configuration/>');
    writeRel(configDir, 'Catalogs/Товары.xml', '<Catalog>Товары</Catalog>');
    writeRel(configDir, 'Ext/Крупный.bsl', patternBytes(THRESHOLD * 40, 4));
    writeRel(configDir, 'Ext/Средний.bsl', patternBytes(THRESHOLD * 3, 5));

    const snapshot = await scanHashSnapshot(undefined, SCOPE, configDir, { streamThresholdBytes: THRESHOLD });

    assert.deepStrictEqual(snapshot.files, buildHashSnapshot(SCOPE, configDir).files);
  });

  test('порог по умолчанию: файл 16 МиБ — потоком, файл на байт меньше — буфером; хеши точны', async () => {
    const atThreshold = Buffer.alloc(HASH_STREAM_THRESHOLD_BYTES, 7);
    const below = Buffer.alloc(HASH_STREAM_THRESHOLD_BYTES - 1, 7);
    writeRel(configDir, 'Ext/Порог.bsl', atThreshold);
    writeRel(configDir, 'Ext/Ниже.bsl', below);
    const counting = countingFs();

    const result = await scanCurrentHashes(configDir, emptyHashStatMemo(configDir), { fs: counting });

    assert.deepStrictEqual(counting.hashPaths.map((file) => path.basename(file)), ['Порог.bsl']);
    assert.deepStrictEqual(counting.readPaths.map((file) => path.basename(file)), ['Ниже.bsl']);
    assert.strictEqual(result.files['Ext/Порог.bsl'], sha1(atThreshold));
    assert.strictEqual(result.files['Ext/Ниже.bsl'], sha1(below));
  });

  test('stat-мемо работает и для потокового пути: неизменённый большой файл второй проход не хеширует', async () => {
    writeRel(configDir, 'Ext/Данные.bsl', patternBytes(THRESHOLD * 20, 6));
    const first = await scanCurrentHashes(configDir, emptyHashStatMemo(configDir), { streamThresholdBytes: THRESHOLD, now: futureNow });
    assert.strictEqual(first.hashed, 1);
    const counting = countingFs();

    const second = await scanCurrentHashes(configDir, first.memo, { fs: counting, streamThresholdBytes: THRESHOLD, now: futureNow });

    assert.strictEqual(counting.counts.hashFile, 0);
    assert.strictEqual(counting.counts.readFile, 0);
    assert.strictEqual(second.hashed, 0);
    assert.deepStrictEqual(second.files, first.files);
  });

  test('изменённый большой файл (новый размер) — хешируется заново потоком, хеш новый', async () => {
    const abs = writeRel(configDir, 'Ext/Данные.bsl', patternBytes(THRESHOLD * 20, 6));
    const first = await scanCurrentHashes(configDir, emptyHashStatMemo(configDir), { streamThresholdBytes: THRESHOLD, now: futureNow });
    const changed = patternBytes(THRESHOLD * 21, 7);
    fs.writeFileSync(abs, changed);
    const counting = countingFs();

    const second = await scanCurrentHashes(configDir, first.memo, { fs: counting, streamThresholdBytes: THRESHOLD, now: futureNow });

    assert.strictEqual(counting.counts.hashFile, 1);
    assert.strictEqual(second.files['Ext/Данные.bsl'], sha1(changed));
  });

  test('racy: свежий большой файл хешируется, но его отпечаток в мемо не попадает', async () => {
    writeRel(configDir, 'Ext/Данные.bsl', patternBytes(THRESHOLD * 20, 8));

    const result = await scanCurrentHashes(configDir, emptyHashStatMemo(configDir), { streamThresholdBytes: THRESHOLD, now: Date.now });

    assert.strictEqual(result.racy, 1);
    assert.strictEqual(result.hashed, 1);
    assert.deepStrictEqual(Object.keys(result.memo.entries), []);
  });

  test('не racy: отпечаток потокового хеша попадает в мемо', async () => {
    writeRel(configDir, 'Ext/Данные.bsl', patternBytes(THRESHOLD * 20, 8));

    const result = await scanCurrentHashes(configDir, emptyHashStatMemo(configDir), { streamThresholdBytes: THRESHOLD, now: futureNow });

    assert.strictEqual(result.racy, 0);
    assert.deepStrictEqual(Object.keys(result.memo.entries), ['Ext/Данные.bsl']);
  });

  test('файл исчез между stat и потоком (ENOENT): его просто нет в результате, без ошибки', async () => {
    const abs = writeRel(configDir, 'Ext/Данные.bsl', patternBytes(THRESHOLD * 20, 8));
    writeRel(configDir, 'Configuration.xml', '<Configuration/>');
    const counting = countingFs();
    counting.beforeHashFile = (filePath) => { fs.unlinkSync(filePath); };

    const result = await scanCurrentHashes(configDir, emptyHashStatMemo(configDir), { fs: counting, streamThresholdBytes: THRESHOLD });

    assert.ok(!fs.existsSync(abs));
    assert.deepStrictEqual(Object.keys(result.files), ['Configuration.xml']);
  });

  test('заблокированный большой файл (EBUSY) не пропускается молча: ошибка пробрасывается', async () => {
    writeRel(configDir, 'Ext/Данные.bsl', patternBytes(THRESHOLD * 20, 8));
    const counting = countingFs();
    counting.beforeHashFile = () => { throw fsError('EBUSY'); };

    await assert.rejects(
      scanCurrentHashes(configDir, emptyHashStatMemo(configDir), { fs: counting, streamThresholdBytes: THRESHOLD }),
      (error: NodeJS.ErrnoException) => error.code === 'EBUSY'
    );
  });
});

suite('HashScanner: nodeHashScanFs.hashFile', function () {
  this.timeout(30_000);
  let dir: string;
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-hash-file-')); });
  teardown(() => { removeTreeSync(dir); });

  test('SHA-1 hex содержимого, совпадает с hashContent (в т.ч. пустой файл и многопорционный)', async () => {
    for (const size of [0, 1, 65_536, 65_537, 300_000]) {
      const data = patternBytes(size, size + 1);
      const file = path.join(dir, `f${String(size)}.bin`);
      fs.writeFileSync(file, data);
      assert.strictEqual(await nodeHashScanFs.hashFile(file), hashContent(data), `размер ${String(size)}`);
    }
  });

  test('отсутствующий файл: отказ ENOENT (дальше решает rethrowUnlessGone сканера)', async () => {
    await assert.rejects(
      nodeHashScanFs.hashFile(path.join(dir, 'нет.bin')),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT'
    );
  });

  test('после хеширования дескриптор закрыт: файл удаляется', async () => {
    const file = path.join(dir, 'a.bin');
    fs.writeFileSync(file, patternBytes(200_000, 3));
    await nodeHashScanFs.hashFile(file);
    fs.unlinkSync(file);
    assert.ok(!fs.existsSync(file));
  });
});
