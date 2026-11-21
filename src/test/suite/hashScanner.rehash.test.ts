import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hashTrackedFiles, scanHashSnapshot } from '../../infra/cache/HashScanner';
import { resolveHashStatMemoPath } from '../../infra/cache/HashStatMemo';
import { countingFs, fsError, futureNow, writeRel } from './support/hashScanFixtures';
import { removeTreeSync } from './support/tempTree';

/**
 * Точечное перехеширование известных путей (`hashTrackedFiles`): после записи операцией импорта хеш
 * снимается только у записанных файлов. Критерий отслеживаемости и сам хеш — те же, что у полного прохода
 * (`scanHashSnapshot`); существование и регистр проверяются по `readdir` предков, а не по `stat` (на
 * регистронезависимой ФС `stat('A.xml')` нашёл бы `a.xml`). Все обращения к ФС идут через настоящую ФС с
 * счётчиком; гонки воспроизводятся реальными действиями в хуках.
 */
suite('HashScanner: hashTrackedFiles (точечное перехеширование)', function () {
  this.timeout(30_000);
  let projectRoot: string;
  let configDir: string;

  const TRACKED = [
    'Configuration.xml',
    'Catalogs/Товары.xml',
    'Catalogs/Товары/Ext/ObjectModule.bsl',
    'DataProcessors/Обр/Templates/Текст/Ext/Template.txt',
    'DataProcessors/Обр/Templates/Двоичный/Ext/Template.bin',
    'CommonTemplates/Описание/Ext/Template/ru.html',
  ];

  setup(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-hash-rehash-'));
    configDir = path.join(projectRoot, 'src', 'cf');
  });
  teardown(() => { removeTreeSync(projectRoot); });

  function seed(): void {
    for (const rel of TRACKED) {
      writeRel(configDir, rel, `содержимое ${rel}`);
    }
    writeRel(configDir, 'ConfigDumpInfo.xml', '<ConfigDumpInfo/>');
    writeRel(configDir, 'README.md', '# не отслеживается');
  }

  test('H1 хеши равны полному проходу для тех же путей (буфер: readFile; поток: hashFile)', async () => {
    for (const [label, threshold] of [['буфер', undefined], ['поток', 1]] as const) {
      seed();
      const counting = countingFs();
      const full = (await scanHashSnapshot(undefined, '', configDir)).files;

      const result = await hashTrackedFiles(configDir, TRACKED, {
        fs: counting,
        ...(threshold === undefined ? {} : { streamThresholdBytes: threshold }),
      });

      assert.deepStrictEqual(result.hashes, Object.fromEntries(TRACKED.map((rel) => [rel, full[rel]])), label);
      assert.deepStrictEqual(result.missing, [], label);
      assert.deepStrictEqual(result.caseMismatch, [], label);
      assert.strictEqual(result.hashed, TRACKED.length, label);
      assert.strictEqual(counting.counts.readFile, threshold === undefined ? TRACKED.length : 0, `${label}: readFile`);
      assert.strictEqual(counting.counts.hashFile, threshold === undefined ? 0 : TRACKED.length, `${label}: hashFile`);
    }
  });

  test('H2 неотслеживаемые пути отбрасываются без обращений к ФС; шаблоны Ext/Template.* отслеживаются', async () => {
    seed();
    const counting = countingFs();
    const untracked = [
      'ConfigDumpInfo.xml',
      'README.md',
      'Catalogs/x.tmp',
      'Ext/ParentConfigurations.bin',
      'Catalogs/Товары/Ext/Picture.png',
    ];

    const none = await hashTrackedFiles(configDir, untracked, { fs: counting });

    assert.deepStrictEqual(none, { hashes: {}, missing: [], caseMismatch: [], hashed: 0 });
    assert.deepStrictEqual(counting.counts, { readdir: 0, stat: 0, readFile: 0, hashFile: 0 });

    const templates = TRACKED.filter((rel) => rel.includes('Template'));
    const withTemplates = await hashTrackedFiles(configDir, [...untracked, ...templates], { fs: counting });
    assert.deepStrictEqual(Object.keys(withTemplates.hashes).sort(), [...templates].sort());
  });

  test('H3 нет файла, нет каталога-предка, предок — файл (ENOTDIR) → missing', async () => {
    seed();
    writeRel(configDir, 'Documents', 'это файл, а не каталог');

    const result = await hashTrackedFiles(configDir, [
      'Catalogs/Нет.xml',
      'Нет/Совсем/x.xml',
      'Documents/x.xml',
      'Configuration.xml',
    ]);

    assert.deepStrictEqual([...result.missing].sort(), ['Catalogs/Нет.xml', 'Documents/x.xml', 'Нет/Совсем/x.xml'].sort());
    assert.deepStrictEqual(Object.keys(result.hashes), ['Configuration.xml']);
    assert.deepStrictEqual(result.caseMismatch, []);
    assert.strictEqual(result.hashed, 1);
  });

  test('H3б каталога выгрузки нет вовсе → все пути missing, без исключения', async () => {
    const result = await hashTrackedFiles(configDir, ['Configuration.xml', 'Catalogs/А.xml']);
    assert.deepStrictEqual([...result.missing].sort(), ['Catalogs/А.xml', 'Configuration.xml']);
    assert.deepStrictEqual(result.hashes, {});
  });

  test('H4 регистр листа: на диске Foo/a.xml, запрошен Foo/A.xml → caseMismatch, хеша в результате нет', async () => {
    writeRel(configDir, 'Foo/a.xml', '<a/>');

    const result = await hashTrackedFiles(configDir, ['Foo/A.xml']);

    assert.deepStrictEqual(result.caseMismatch, ['Foo/A.xml']);
    assert.deepStrictEqual(result.hashes, {});
    assert.deepStrictEqual(result.missing, []);
    assert.strictEqual(result.hashed, 0);
  });

  test('H5 регистр промежуточного каталога: на диске Foo/x.xml, запрошен foo/x.xml → caseMismatch', async () => {
    writeRel(configDir, 'Foo/x.xml', '<x/>');
    writeRel(configDir, 'Foo/Bar/y.xml', '<y/>');

    const result = await hashTrackedFiles(configDir, ['foo/x.xml', 'Foo/bar/y.xml', 'Foo/Bar/y.xml']);

    assert.deepStrictEqual([...result.caseMismatch].sort(), ['Foo/bar/y.xml', 'foo/x.xml']);
    assert.deepStrictEqual(Object.keys(result.hashes), ['Foo/Bar/y.xml'], 'точное совпадение регистра хешируется');
  });

  test('H6 readdir каждого предка кэшируется на вызов: три файла одного каталога — читается глубина, а не тройная', async () => {
    for (const name of ['a', 'b', 'c']) {
      writeRel(configDir, `One/Two/${name}.xml`, `<${name}/>`);
    }
    const counting = countingFs();

    const result = await hashTrackedFiles(configDir, ['One/Two/a.xml', 'One/Two/b.xml', 'One/Two/c.xml'], { fs: counting });

    assert.strictEqual(result.hashed, 3);
    // Регистр каждого сегмента проверяется по readdir его родителя: configDir, One, One/Two.
    assert.strictEqual(counting.counts.readdir, 3);
  });

  test('H7 stat-мемо не читается и не пишется: stat — по одному на файл (размер), файл мемо побайтно прежний; без мемо каталог hash-stat не создаётся', async () => {
    seed();
    const memoFile = resolveHashStatMemoPath(projectRoot, configDir);
    const counting = countingFs();

    await hashTrackedFiles(configDir, TRACKED, { fs: counting });
    // stat — только у найденного файла ради размера (буфер/поток), по одному на файл: регистр и существование
    // решает readdir, а мемо не участвует (это доказывают проверки файла мемо ниже).
    assert.strictEqual(counting.counts.stat, TRACKED.length);
    assert.ok(!fs.existsSync(memoFile), 'мемо не создан');
    assert.ok(!fs.existsSync(path.dirname(memoFile)), 'каталога мемо нет');

    await scanHashSnapshot(projectRoot, '', configDir, { now: futureNow });
    const before = fs.readFileSync(memoFile);
    writeRel(configDir, 'Catalogs/Товары.xml', 'другое содержимое');
    counting.reset();

    await hashTrackedFiles(configDir, TRACKED, { fs: counting });

    assert.strictEqual(counting.counts.stat, TRACKED.length);
    assert.ok(before.equals(fs.readFileSync(memoFile)), 'мемо побайтно прежний');
  });

  test('H8 ошибка, отличная от ENOENT/ENOTDIR, пробрасывается (EBUSY при чтении, EACCES при readdir)', async () => {
    seed();
    const busy = countingFs();
    busy.beforeReadFile = () => { throw fsError('EBUSY'); };
    await assert.rejects(hashTrackedFiles(configDir, ['Configuration.xml'], { fs: busy }), { code: 'EBUSY' });

    const denied = countingFs();
    denied.beforeReaddir = () => { throw fsError('EACCES'); };
    await assert.rejects(hashTrackedFiles(configDir, ['Configuration.xml'], { fs: denied }), { code: 'EACCES' });

    const busyStream = countingFs();
    busyStream.beforeHashFile = () => { throw fsError('EBUSY'); };
    await assert.rejects(
      hashTrackedFiles(configDir, ['Configuration.xml'], { fs: busyStream, streamThresholdBytes: 1 }),
      { code: 'EBUSY' }
    );
  });

  test('H9 файл исчез между readdir и чтением → missing (буфер и поток)', async () => {
    for (const threshold of [undefined, 1]) {
      seed();
      const counting = countingFs();
      const vanish = (file: string): void => { fs.unlinkSync(file); };
      counting.beforeReadFile = vanish;
      counting.beforeHashFile = vanish;

      const result = await hashTrackedFiles(configDir, ['Configuration.xml', 'Catalogs/Товары.xml'], {
        fs: counting,
        ...(threshold === undefined ? {} : { streamThresholdBytes: threshold }),
      });

      assert.deepStrictEqual([...result.missing].sort(), ['Catalogs/Товары.xml', 'Configuration.xml'].sort(), String(threshold));
      assert.deepStrictEqual(result.hashes, {});
      assert.strictEqual(result.hashed, 0);
    }
  });

  test('H10 повторные пути считаются один раз; пустой вход — ноль обращений к ФС', async () => {
    seed();
    const counting = countingFs();

    const twice = await hashTrackedFiles(configDir, ['Configuration.xml', 'Configuration.xml'], { fs: counting });
    assert.strictEqual(twice.hashed, 1);
    assert.strictEqual(counting.counts.readFile, 1);

    counting.reset();
    const empty = await hashTrackedFiles(configDir, [], { fs: counting });
    assert.deepStrictEqual(empty, { hashes: {}, missing: [], caseMismatch: [], hashed: 0 });
    assert.deepStrictEqual(counting.counts, { readdir: 0, stat: 0, readFile: 0, hashFile: 0 });
  });

  test('без опций: реальная ФС (шов fs и порог потока по умолчанию)', async () => {
    seed();
    const result = await hashTrackedFiles(configDir, ['Configuration.xml']);
    assert.strictEqual(result.hashed, 1);
    assert.strictEqual(Object.keys(result.hashes).length, 1);
  });
});
