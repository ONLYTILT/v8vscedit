import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildHashSnapshot } from '../../infra/cache/HashCache';
import {
  HASH_SCAN_CONCURRENCY,
  nodeHashScanFs,
  scanCurrentHashes,
  scanHashSnapshot,
  type HashScanReport,
} from '../../infra/cache/HashScanner';
import {
  emptyHashStatMemo,
  loadHashStatMemo,
  resolveHashStatMemoPath,
  saveHashStatMemo,
} from '../../infra/cache/HashStatMemo';
import { buildSyncManifestFiles } from '../../infra/agent/sync/SyncManifest';
import { countingFs, fsError, futureNow, writeRel } from './support/hashScanFixtures';

/**
 * Быстрая проверка выгрузки: `stat` каждого отслеживаемого файла, чтение и SHA-1 — только для
 * новых и тех, у кого сменился отпечаток (mtime/ctime/size). «Изменено» по-прежнему решает хеш
 * содержимого; мемо лишь подставляет хеш, ранее посчитанный для того же отпечатка.
 *
 * Детерминизм: racy-окно управляется подменой `now` (`futureNow`), а не ожиданием; гонки ФС
 * воспроизводятся реальными действиями в хуках счётчика-обёртки над настоящей ФС.
 */
suite('HashScanner', function () {
  this.timeout(30_000);
  let projectRoot: string;
  let configDir: string;
  const SCOPE = 'cf::test';
  const sha1 = (data: string | Buffer): string => createHash('sha1').update(data).digest('hex');

  setup(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-hash-scanner-'));
    configDir = path.join(projectRoot, 'src', 'cf');
  });
  teardown(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

  /** Небольшая выгрузка: отслеживаемые и неотслеживаемые файлы, вложенность, кириллица. */
  function seedTree(): string[] {
    writeRel(configDir, 'Configuration.xml', '<Configuration/>');
    writeRel(configDir, 'ConfigDumpInfo.xml', '<ConfigDumpInfo/>');
    writeRel(configDir, 'README.md', '# не отслеживается');
    writeRel(configDir, 'Catalogs/Товары.xml', '<Catalog>Товары</Catalog>');
    writeRel(configDir, 'Catalogs/Верх.XML', '<Catalog>верхний регистр</Catalog>');
    writeRel(configDir, 'Catalogs/Товары/Ext/ObjectModule.bsl', 'Процедура А() КонецПроцедуры');
    writeRel(configDir, 'Catalogs/Товары/Ext/Picture.png', Buffer.from([1, 2, 3]));
    writeRel(configDir, 'DataProcessors/Обр/Templates/Текст/Ext/Template.txt', 'текст');
    writeRel(configDir, 'DataProcessors/Обр/Templates/Двоичный/Ext/Template.bin', Buffer.from([0, 255]));
    writeRel(configDir, 'CommonTemplates/Описание/Ext/Template/ru.html', '<html></html>');
    return [
      'Configuration.xml',
      'Catalogs/Товары.xml',
      'Catalogs/Верх.XML',
      'Catalogs/Товары/Ext/ObjectModule.bsl',
      'DataProcessors/Обр/Templates/Текст/Ext/Template.txt',
      'DataProcessors/Обр/Templates/Двоичный/Ext/Template.bin',
      'CommonTemplates/Описание/Ext/Template/ru.html',
    ].sort();
  }

  const abs = (rel: string): string => path.join(configDir, ...rel.split('/'));
  const memoFile = (): string => resolveHashStatMemoPath(projectRoot, configDir);

  /** Сдвигает mtime файла в фиксированное прошлое (ctime при этом становится «сейчас»). */
  function setMtime(rel: string, epochSeconds: number): void {
    fs.utimesSync(abs(rel), epochSeconds, epochSeconds);
  }

  suite('эквивалентность эталонному полному проходу', () => {
    test('набор и хеши совпадают с buildHashSnapshot (единый критерий отслеживаемого файла)', async () => {
      const tracked = seedTree();
      const snapshot = await scanHashSnapshot(undefined, SCOPE, configDir);
      assert.deepStrictEqual(snapshot.files, buildHashSnapshot(SCOPE, configDir).files);
      assert.deepStrictEqual(Object.keys(snapshot.files).sort(), tracked);
      assert.strictEqual(snapshot.files['Catalogs/Товары.xml'], sha1('<Catalog>Товары</Catalog>'));
      assert.ok(Object.keys(snapshot.files).every((rel) => !rel.includes('\\')));
    });

    test('форма снимка: schemaVersion 1, переданный scopeKey, generatedAt в ISO', async () => {
      seedTree();
      const snapshot = await scanHashSnapshot(undefined, SCOPE, configDir);
      assert.strictEqual(snapshot.schemaVersion, 1);
      assert.strictEqual(snapshot.scopeKey, SCOPE);
      assert.ok(!Number.isNaN(Date.parse(snapshot.generatedAt)));
      assert.strictEqual(new Date(snapshot.generatedAt).toISOString(), snapshot.generatedAt);
    });

    test(`файлов больше пула (${String(HASH_SCAN_CONCURRENCY)}) и глубокая вложенность — все учтены`, async () => {
      for (let i = 0; i < HASH_SCAN_CONCURRENCY * 3 + 1; i += 1) {
        writeRel(configDir, `Catalogs/К${String(i)}/Ext/Глубоко/Вложено/M${String(i)}.bsl`, `модуль ${String(i)}`);
      }
      const snapshot = await scanHashSnapshot(projectRoot, SCOPE, configDir, { now: futureNow });
      assert.deepStrictEqual(snapshot.files, buildHashSnapshot(SCOPE, configDir).files);
      assert.strictEqual(Object.keys(snapshot.files).length, HASH_SCAN_CONCURRENCY * 3 + 1);
    });

    test('пустой каталог выгрузки → пустой набор', async () => {
      fs.mkdirSync(configDir, { recursive: true });
      assert.deepStrictEqual((await scanHashSnapshot(projectRoot, SCOPE, configDir)).files, {});
    });

    test('каталога выгрузки нет → пустой набор без исключения, мемо не записан', async () => {
      const snapshot = await scanHashSnapshot(projectRoot, SCOPE, configDir);
      assert.deepStrictEqual(snapshot.files, {});
      assert.ok(!fs.existsSync(memoFile()));
    });

    test('без projectRoot мемо не читается и не пишется: каталог .v8vscedit не создаётся', async () => {
      seedTree();
      const counting = countingFs();
      await scanHashSnapshot(undefined, SCOPE, configDir, { fs: counting, now: futureNow });
      await scanHashSnapshot(undefined, SCOPE, configDir, { fs: counting, now: futureNow });
      assert.ok(!fs.existsSync(path.join(projectRoot, '.v8vscedit')));
      assert.strictEqual(counting.counts.readFile, 14, 'без мемо оба прохода читают все 7 файлов');
    });

    test('nodeHashScanFs — тонкая обёртка над fs.promises', async () => {
      writeRel(configDir, 'a.xml', 'abc');
      const entries = await nodeHashScanFs.readdir(configDir);
      assert.deepStrictEqual(entries.map((e) => e.name), ['a.xml']);
      assert.ok(entries[0]?.isFile());
      const fp = await nodeHashScanFs.stat(abs('a.xml'));
      const real = fs.statSync(abs('a.xml'));
      assert.deepStrictEqual(fp.size, 3);
      assert.strictEqual(fp.mtimeMs, real.mtimeMs);
      assert.strictEqual(fp.ctimeMs, real.ctimeMs);
      assert.strictEqual((await nodeHashScanFs.readFile(abs('a.xml'))).toString('utf-8'), 'abc');
    });
  });

  suite('неизменённые файлы не читаются', () => {
    test('первый проход читает все, второй — ни одного (только stat); мемо не перезаписан', async () => {
      const tracked = seedTree();
      const counting = countingFs();
      const reports: HashScanReport[] = [];
      const options = { fs: counting, now: futureNow, onReport: (r: HashScanReport) => { reports.push(r); } };

      const first = await scanHashSnapshot(projectRoot, SCOPE, configDir, options);
      assert.strictEqual(counting.counts.readFile, tracked.length);
      assert.ok(fs.existsSync(memoFile()), 'после первого прохода мемо записан');
      assert.strictEqual(reports[0]?.hashed, tracked.length);
      assert.strictEqual(reports[0]?.files, tracked.length);
      assert.strictEqual(reports[0]?.racy, 0);
      assert.strictEqual(reports[0]?.memoSaved, true);
      assert.strictEqual(reports[0]?.configDir, configDir);
      assert.ok((reports[0]?.elapsedMs ?? -1) >= 0);
      const memoBytes = fs.readFileSync(memoFile());
      const memoMtime = fs.statSync(memoFile()).mtimeMs;

      counting.reset();
      const second = await scanHashSnapshot(projectRoot, SCOPE, configDir, options);
      assert.strictEqual(counting.counts.readFile, 0, 'неизменённые файлы не читаются');
      assert.strictEqual(counting.counts.stat, tracked.length, 'только stat отслеживаемых файлов');
      assert.deepStrictEqual(second.files, first.files);
      assert.strictEqual(reports[1]?.hashed, 0);
      assert.strictEqual(reports[1]?.memoSaved, false);
      assert.strictEqual(reports[1]?.memoSaveError, undefined);
      assert.deepStrictEqual(fs.readFileSync(memoFile()), memoBytes);
      assert.strictEqual(fs.statSync(memoFile()).mtimeMs, memoMtime, 'мемо не переписывается без изменений');
    });

    test('неотслеживаемые файлы (README.md, ConfigDumpInfo.xml, png) не stat-ятся и не читаются', async () => {
      seedTree();
      const counting = countingFs();
      await scanHashSnapshot(projectRoot, SCOPE, configDir, { fs: counting, now: futureNow });
      const touched = [...counting.readPaths].map((p) => path.basename(p));
      assert.ok(!touched.includes('README.md'));
      assert.ok(!touched.includes('ConfigDumpInfo.xml'));
      assert.ok(!touched.includes('Picture.png'));
      assert.strictEqual(counting.counts.stat, 7);
    });
  });

  suite('семантика «изменено» решается хешем', () => {
    test('touch без изменения содержимого: файл перечитан, хеш прежний, отпечаток в мемо обновлён; третий проход — 0 чтений', async () => {
      seedTree();
      const counting = countingFs();
      const options = { fs: counting, now: futureNow };
      const first = await scanHashSnapshot(projectRoot, SCOPE, configDir, options);
      const memoBefore = await loadHashStatMemo(projectRoot, configDir);

      setMtime('Catalogs/Товары.xml', 1_000_000_000);
      counting.reset();
      const second = await scanHashSnapshot(projectRoot, SCOPE, configDir, options);
      assert.strictEqual(counting.counts.readFile, 1);
      assert.deepStrictEqual(counting.readPaths, [abs('Catalogs/Товары.xml')]);
      assert.deepStrictEqual(second.files, first.files, 'содержимое прежнее — изменений нет');
      const memoAfter = await loadHashStatMemo(projectRoot, configDir);
      assert.notDeepStrictEqual(memoAfter.entries['Catalogs/Товары.xml'], memoBefore.entries['Catalogs/Товары.xml']);
      assert.strictEqual(memoAfter.entries['Catalogs/Товары.xml'][0], fs.statSync(abs('Catalogs/Товары.xml')).mtimeMs);

      counting.reset();
      await scanHashSnapshot(projectRoot, SCOPE, configDir, options);
      assert.strictEqual(counting.counts.readFile, 0);
    });

    test('изменение содержимого с тем же размером обнаруживается (сменился mtime)', async () => {
      seedTree();
      setMtime('Catalogs/Товары.xml', 1_000_000_000);
      const counting = countingFs();
      const options = { fs: counting, now: futureNow };
      const first = await scanHashSnapshot(projectRoot, SCOPE, configDir, options);

      const original = fs.readFileSync(abs('Catalogs/Товары.xml'));
      const sameSize = Buffer.from(original);
      sameSize[sameSize.length - 2] = sameSize[sameSize.length - 2] === 0x67 ? 0x68 : 0x67;
      fs.writeFileSync(abs('Catalogs/Товары.xml'), sameSize);
      assert.strictEqual(fs.statSync(abs('Catalogs/Товары.xml')).size, original.length);

      counting.reset();
      const second = await scanHashSnapshot(projectRoot, SCOPE, configDir, options);
      assert.strictEqual(counting.counts.readFile, 1);
      assert.strictEqual(second.files['Catalogs/Товары.xml'], sha1(sameSize));
      assert.notStrictEqual(second.files['Catalogs/Товары.xml'], first.files['Catalogs/Товары.xml']);
    });

    test('перезапись тем же размером с ВОЗВРАТОМ mtime (robocopy /COPY:T) ловится по ctime', async function () {
      seedTree();
      setMtime('Catalogs/Товары.xml', 1_000_000_000);
      const counting = countingFs();
      const options = { fs: counting, now: futureNow };
      await scanHashSnapshot(projectRoot, SCOPE, configDir, options);
      const before = fs.statSync(abs('Catalogs/Товары.xml'));

      const sameSize = Buffer.from(fs.readFileSync(abs('Catalogs/Товары.xml')));
      sameSize[1] = sameSize[1] === 0x43 ? 0x44 : 0x43;
      // Пауза не нужна для логики; она нужна, чтобы ctime гарантированно сдвинулся на ФС с грубым ctime.
      await new Promise((resolve) => setTimeout(resolve, 20));
      fs.writeFileSync(abs('Catalogs/Товары.xml'), sameSize);
      setMtime('Catalogs/Товары.xml', 1_000_000_000);
      const after = fs.statSync(abs('Catalogs/Товары.xml'));
      assert.strictEqual(after.mtimeMs, before.mtimeMs);
      assert.strictEqual(after.size, before.size);
      if (after.ctimeMs === before.ctimeMs) {
        // ФС не ведёт ctime (или он не изменился) — сценарий на этой машине невоспроизводим.
        this.skip();
      }

      counting.reset();
      const second = await scanHashSnapshot(projectRoot, SCOPE, configDir, options);
      assert.strictEqual(counting.counts.readFile, 1);
      assert.strictEqual(second.files['Catalogs/Товары.xml'], sha1(sameSize));
    });

    test('новый файл хешируется; удалённый пропадает и из результата, и из мемо', async () => {
      seedTree();
      const counting = countingFs();
      const options = { fs: counting, now: futureNow };
      await scanHashSnapshot(projectRoot, SCOPE, configDir, options);

      writeRel(configDir, 'Documents/Новый.xml', '<Document/>');
      fs.unlinkSync(abs('Catalogs/Верх.XML'));
      counting.reset();
      const second = await scanHashSnapshot(projectRoot, SCOPE, configDir, options);
      assert.strictEqual(counting.counts.readFile, 1);
      assert.strictEqual(second.files['Documents/Новый.xml'], sha1('<Document/>'));
      assert.ok(!('Catalogs/Верх.XML' in second.files));
      const memo = await loadHashStatMemo(projectRoot, configDir);
      assert.ok(!('Catalogs/Верх.XML' in memo.entries));
      assert.ok('Documents/Новый.xml' in memo.entries);
    });
  });

  suite('racy-защита', () => {
    test('файлы, изменённые в пределах окна до старта прохода, не попадают в мемо и перечитываются', async () => {
      const tracked = seedTree();
      const counting = countingFs();
      const reports: HashScanReport[] = [];
      const options = { fs: counting, now: () => Date.now(), onReport: (r: HashScanReport) => { reports.push(r); } };

      await scanHashSnapshot(projectRoot, SCOPE, configDir, options);
      assert.strictEqual(reports[0]?.racy, tracked.length);
      assert.deepStrictEqual((await loadHashStatMemo(projectRoot, configDir)).entries, {});

      counting.reset();
      await scanHashSnapshot(projectRoot, SCOPE, configDir, options);
      assert.strictEqual(counting.counts.readFile, tracked.length, 'racy-файлы читаются снова');
    });

    test('при «часах в будущем» отпечатки доверенные и сохраняются', async () => {
      const tracked = seedTree();
      const reports: HashScanReport[] = [];
      await scanHashSnapshot(projectRoot, SCOPE, configDir, { now: futureNow, onReport: (r) => { reports.push(r); } });
      assert.strictEqual(reports[0]?.racy, 0);
      assert.deepStrictEqual(Object.keys((await loadHashStatMemo(projectRoot, configDir)).entries).sort(), tracked);
    });

    test('без опции now используется Date.now: свежие файлы — racy', async () => {
      const tracked = seedTree();
      const reports: HashScanReport[] = [];
      await scanHashSnapshot(projectRoot, SCOPE, configDir, { onReport: (r) => { reports.push(r); } });
      assert.strictEqual(reports[0]?.racy, tracked.length);
    });

    test('старые файлы (mtime и ctime давно) без подмены часов — не racy', async () => {
      writeRel(configDir, 'a.xml', 'a');
      const result = await scanCurrentHashes(configDir, emptyHashStatMemo(configDir), {
        fs: {
          ...nodeHashScanFs,
          stat: () => Promise.resolve({ mtimeMs: 1000, ctimeMs: 1000, size: 1 }),
        },
      });
      assert.strictEqual(result.racy, 0);
      assert.deepStrictEqual(result.memo.entries['a.xml'], [1000, 1000, 1, sha1('a')]);
    });
  });

  suite('scanCurrentHashes: флаг memoChanged и итоговый мемо', () => {
    test('пустой мемо + файлы → memoChanged; повтор с полученным мемо → не изменён, hashed 0', async () => {
      seedTree();
      const first = await scanCurrentHashes(configDir, emptyHashStatMemo(configDir), { now: futureNow });
      assert.strictEqual(first.memoChanged, true);
      assert.strictEqual(first.hashed, 7);
      const second = await scanCurrentHashes(configDir, first.memo, { now: futureNow });
      assert.strictEqual(second.memoChanged, false);
      assert.strictEqual(second.hashed, 0);
      assert.deepStrictEqual(second.files, first.files);
      assert.deepStrictEqual(second.memo, first.memo);
    });

    test('в прежнем мемо запись удалённого файла → memoChanged (мемо вычищается)', async () => {
      seedTree();
      const first = await scanCurrentHashes(configDir, emptyHashStatMemo(configDir), { now: futureNow });
      const stale = { ...first.memo, entries: { ...first.memo.entries, 'Удалён.xml': [1, 1, 1, 'x'] as const } };
      const second = await scanCurrentHashes(configDir, stale, { now: futureNow });
      assert.strictEqual(second.memoChanged, true);
      assert.strictEqual(second.hashed, 0);
      assert.ok(!('Удалён.xml' in second.memo.entries));
    });

    test('пустой мемо + пустая выгрузка → не изменён', async () => {
      fs.mkdirSync(configDir, { recursive: true });
      const result = await scanCurrentHashes(configDir, emptyHashStatMemo(configDir));
      assert.strictEqual(result.memoChanged, false);
      assert.deepStrictEqual(result.files, {});
    });

    test('все файлы racy при пустом мемо → мемо не изменился', async () => {
      seedTree();
      const result = await scanCurrentHashes(configDir, emptyHashStatMemo(configDir), { now: () => Date.now() });
      assert.strictEqual(result.racy, 7);
      assert.strictEqual(result.memoChanged, false);
    });

    test('без опций — реальная ФС и Date.now', async () => {
      writeRel(configDir, 'a.xml', 'x');
      const result = await scanCurrentHashes(configDir, emptyHashStatMemo(configDir));
      assert.deepStrictEqual(result.files, { 'a.xml': sha1('x') });
    });
  });

  suite('мемо: повреждения и сбои записи', () => {
    test('битый мемо → полное перехеширование, результат верный, мемо перезаписан валидным', async () => {
      const tracked = seedTree();
      fs.mkdirSync(path.dirname(memoFile()), { recursive: true });
      fs.writeFileSync(memoFile(), '{ битый');
      const counting = countingFs();
      const snapshot = await scanHashSnapshot(projectRoot, SCOPE, configDir, { fs: counting, now: futureNow });
      assert.strictEqual(counting.counts.readFile, tracked.length);
      assert.deepStrictEqual(snapshot.files, buildHashSnapshot(SCOPE, configDir).files);
      assert.deepStrictEqual(Object.keys((await loadHashStatMemo(projectRoot, configDir)).entries).sort(), tracked);
    });

    test('запись мемо не удалась (путь занят каталогом) → результат возвращён, ошибка в отчёте, без исключения', async () => {
      seedTree();
      fs.mkdirSync(path.join(memoFile(), 'занято'), { recursive: true });
      const reports: HashScanReport[] = [];
      const snapshot = await scanHashSnapshot(projectRoot, SCOPE, configDir, {
        now: futureNow,
        onReport: (r) => { reports.push(r); },
      });
      assert.deepStrictEqual(snapshot.files, buildHashSnapshot(SCOPE, configDir).files);
      assert.strictEqual(reports[0]?.memoSaved, false);
      assert.ok(typeof reports[0]?.memoSaveError === 'string' && reports[0].memoSaveError.length > 0);
    });

    test('без onReport сбой записи мемо тоже не роняет проверку', async () => {
      seedTree();
      fs.mkdirSync(path.join(memoFile(), 'занято'), { recursive: true });
      const snapshot = await scanHashSnapshot(projectRoot, SCOPE, configDir, { now: futureNow });
      assert.strictEqual(Object.keys(snapshot.files).length, 7);
    });

    test('мемо общий для областей одного каталога: после проверки области cf манифест агента (scope "") не читает файлы', async () => {
      seedTree();
      await scanHashSnapshot(projectRoot, 'cf::x', configDir, { now: futureNow });
      const counting = countingFs();
      const files = await buildSyncManifestFiles(configDir, projectRoot, { fs: counting, now: futureNow });
      assert.strictEqual(counting.counts.readFile, 0);
      assert.deepStrictEqual(files, buildHashSnapshot('', configDir).files);
    });

    test('мемо от другого каталога не используется', async () => {
      seedTree();
      const otherDir = path.join(projectRoot, 'src', 'cfe', 'Расш');
      saveHashStatMemo(projectRoot, { ...emptyHashStatMemo(otherDir), entries: { 'Configuration.xml': [1, 1, 1, 'чужой'] } });
      const snapshot = await scanHashSnapshot(projectRoot, SCOPE, configDir, { now: futureNow });
      assert.strictEqual(snapshot.files['Configuration.xml'], sha1('<Configuration/>'));
    });
  });

  suite('гонки ФС: исчезновение — это отсутствие (ENOENT/ENOTDIR)', () => {
    test('файл удалён между readdir и stat → пропущен', async () => {
      seedTree();
      const counting = countingFs();
      counting.beforeStat = (filePath) => {
        if (filePath === abs('Catalogs/Товары.xml')) {
          fs.unlinkSync(filePath);
        }
      };
      const snapshot = await scanHashSnapshot(projectRoot, SCOPE, configDir, { fs: counting, now: futureNow });
      assert.ok(!('Catalogs/Товары.xml' in snapshot.files));
      assert.strictEqual(Object.keys(snapshot.files).length, 6);
      assert.ok(!('Catalogs/Товары.xml' in (await loadHashStatMemo(projectRoot, configDir)).entries));
    });

    test('файл удалён между stat и readFile → пропущен', async () => {
      seedTree();
      const counting = countingFs();
      counting.beforeReadFile = (filePath) => {
        if (filePath === abs('Catalogs/Товары.xml')) {
          fs.unlinkSync(filePath);
        }
      };
      const snapshot = await scanHashSnapshot(projectRoot, SCOPE, configDir, { fs: counting, now: futureNow });
      assert.ok(!('Catalogs/Товары.xml' in snapshot.files));
      assert.strictEqual(Object.keys(snapshot.files).length, 6);
      assert.ok(!('Catalogs/Товары.xml' in (await loadHashStatMemo(projectRoot, configDir)).entries));
    });

    test('подкаталог удалён до его readdir → пропущен (ENOENT)', async () => {
      seedTree();
      writeRel(configDir, 'Gone/Sub/a.xml', 'a');
      const gone = path.join(configDir, 'Gone');
      const counting = countingFs();
      counting.beforeReaddir = async (dir) => {
        if (dir === gone) {
          await fs.promises.rm(gone, { recursive: true, force: true });
        }
      };
      const snapshot = await scanHashSnapshot(projectRoot, SCOPE, configDir, { fs: counting, now: futureNow });
      assert.ok(!Object.keys(snapshot.files).some((rel) => rel.startsWith('Gone/')));
      assert.strictEqual(Object.keys(snapshot.files).length, 7);
    });

    test('подкаталог заменён файлом до его readdir → пропущен (ENOTDIR)', async () => {
      seedTree();
      writeRel(configDir, 'Swap/a.xml', 'a');
      const swap = path.join(configDir, 'Swap');
      const counting = countingFs();
      counting.beforeReaddir = async (dir) => {
        if (dir === swap) {
          await fs.promises.rm(swap, { recursive: true, force: true });
          fs.writeFileSync(swap, 'теперь файл');
        }
      };
      const snapshot = await scanHashSnapshot(projectRoot, SCOPE, configDir, { fs: counting, now: futureNow });
      assert.ok(!Object.keys(snapshot.files).some((rel) => rel.startsWith('Swap')));
      assert.strictEqual(Object.keys(snapshot.files).length, 7);
    });

    test('ENOENT из readFile без реального удаления (код ошибки решает) → пропущен', async () => {
      seedTree();
      const counting = countingFs({
        ...nodeHashScanFs,
        readFile: async (filePath) => {
          if (filePath === abs('Configuration.xml')) {
            throw fsError('ENOENT');
          }
          return nodeHashScanFs.readFile(filePath);
        },
      });
      const snapshot = await scanHashSnapshot(projectRoot, SCOPE, configDir, { fs: counting, now: futureNow });
      assert.ok(!('Configuration.xml' in snapshot.files));
    });
  });

  suite('прочие ошибки ФС пробрасываются (иначе заблокированный файл стал бы «удалённым»)', () => {
    const stages = ['readdir', 'stat', 'readFile'] as const;
    for (const stage of stages) {
      test(`EBUSY в ${stage} → reject этой ошибкой`, async () => {
        seedTree();
        const counting = countingFs();
        const fail = (): void => { throw fsError('EBUSY', `busy:${stage}`); };
        if (stage === 'readdir') {
          counting.beforeReaddir = fail;
        } else if (stage === 'stat') {
          counting.beforeStat = fail;
        } else {
          counting.beforeReadFile = fail;
        }
        await assert.rejects(
          scanHashSnapshot(projectRoot, SCOPE, configDir, { fs: counting, now: futureNow }),
          (error: NodeJS.ErrnoException) => error.code === 'EBUSY' && error.message === `busy:${stage}`
        );
      });
    }

    test('ошибка без кода (не ErrnoException) тоже пробрасывается', async () => {
      seedTree();
      const counting = countingFs();
      counting.beforeStat = () => { throw new Error('без кода'); };
      await assert.rejects(scanHashSnapshot(projectRoot, SCOPE, configDir, { fs: counting }), /без кода/);
    });

    test('ошибка, брошенная не-объектом, пробрасывается как есть', async () => {
      seedTree();
      const counting = countingFs();
      counting.beforeReaddir = () => {
        // Сторонний код может бросить строку — классификатор кода ошибки не должен на ней падать.
        const thrown: unknown = 'строка';
        throw thrown;
      };
      await assert.rejects(scanHashSnapshot(projectRoot, SCOPE, configDir, { fs: counting }), (e: unknown) => e === 'строка');
    });
  });

  suite('прерывание прохода (signal)', () => {
    const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

    test('S1 уже прерванный сигнал → AbortError, ни одного readdir', async () => {
      seedTree();
      const counting = countingFs();
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        scanHashSnapshot(projectRoot, SCOPE, configDir, { fs: counting, now: futureNow, signal: controller.signal }),
        isAbort
      );

      assert.strictEqual(counting.counts.readdir, 0);
      assert.ok(!fs.existsSync(memoFile()), 'мемо не создан');
    });

    test('S2 abort посреди хеширования: AbortError, мемо побайтно прежний, onReport не вызван', async () => {
      seedTree();
      await scanHashSnapshot(projectRoot, SCOPE, configDir, { now: futureNow });
      const memoBefore = fs.readFileSync(memoFile());
      // Два изменённых файла: полный проход переписал бы мемо, прерванный — обязан не писать частичный.
      writeRel(configDir, 'Catalogs/Товары.xml', '<Catalog>другое</Catalog>');
      writeRel(configDir, 'Configuration.xml', '<Configuration>другое</Configuration>');
      const counting = countingFs();
      const controller = new AbortController();
      let statCalls = 0;
      counting.beforeStat = () => {
        statCalls += 1;
        if (statCalls === 3) {
          controller.abort();
        }
      };
      const reports: HashScanReport[] = [];

      await assert.rejects(
        scanHashSnapshot(projectRoot, SCOPE, configDir, {
          fs: counting,
          now: futureNow,
          signal: controller.signal,
          onReport: (report) => { reports.push(report); },
        }),
        isAbort
      );

      assert.ok(memoBefore.equals(fs.readFileSync(memoFile())), 'частичный мемо не записан');
      assert.deepStrictEqual(reports, []);
    });

    test('S3 abort во время обхода (readdir подкаталога) → AbortError, мемо не записан', async () => {
      seedTree();
      const counting = countingFs();
      const controller = new AbortController();
      counting.beforeReaddir = (dir) => {
        if (dir !== configDir) {
          controller.abort();
        }
      };

      await assert.rejects(
        scanHashSnapshot(projectRoot, SCOPE, configDir, { fs: counting, now: futureNow, signal: controller.signal }),
        isAbort
      );

      assert.ok(!fs.existsSync(memoFile()), 'мемо не создан прерванным проходом');
    });

    test('S4 непрерванный сигнал: результат и мемо те же, что без сигнала', async () => {
      seedTree();
      const plain = await scanHashSnapshot(projectRoot, SCOPE, configDir, { now: futureNow });
      const memoPlain = fs.readFileSync(memoFile());
      fs.unlinkSync(memoFile());

      const withSignal = await scanHashSnapshot(projectRoot, SCOPE, configDir, {
        now: futureNow,
        signal: new AbortController().signal,
      });

      assert.deepStrictEqual(withSignal.files, plain.files);
      // Порядок записей мемо — порядок завершения полос пула, он недетерминирован; сравнивается содержимое.
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(memoFile(), 'utf-8')), JSON.parse(memoPlain.toString('utf-8')), 'мемо идентично');
    });
  });
});
