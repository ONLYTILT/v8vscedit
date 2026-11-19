import * as assert from 'assert';
import * as fs from 'fs';
import { encode } from 'iconv-lite';
import * as os from 'os';
import * as path from 'path';
import {
  ArchiveFormatError,
  extractArchive,
  packArchive,
  packDirectoryFilesToFile,
  type ArchiveEntry,
} from '../../infra/agent/sync/ArchiveCodec';
import { EXAMPLE_GENERATIONS, skipWithoutCorpus } from './support/corpus';
import { buildZip, patternBytes, readZip, readZipAsMap } from './support/zipFixtures';

/**
 * Э7: ArchiveCodec — упаковка каталога в zip и распаковка в приёмник. Архивы платформы (факт
 * пилота §5b п.7): стандартный zip, deflate, бит 11 (UTF-8) выставлен у всех записей, кириллица в
 * именах, внутри есть ConfigDumpInfo.xml. Без бита 11 имена — cp866 (через iconv-lite). Архив сначала
 * ПОЛНОСТЬЮ валидируется (инфляция + CRC каждой записи), и только потом приёмнику отдаётся первая
 * запись: повреждённый архив не должен оставить приёмник с частью файлов (движок пишет в проект из
 * приёмника).
 */

/**
 * Упаковка каталога потоком в файл и чтение его обратно: прежний `packDirectoryFiles` (архив целиком в
 * памяти) удалён планом потокового архива, а его проверки (ровно перечисленные файлы, имена POSIX,
 * отказ на отсутствующем файле) переносятся на `packDirectoryFilesToFile` без изменения ожиданий.
 */
async function packDirectoryFiles(rootDir: string, rels: readonly string[]): Promise<Uint8Array> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-archive-out-'));
  try {
    const outFile = path.join(outDir, 'out.zip');
    await packDirectoryFilesToFile(rootDir, rels, outFile);
    return fs.readFileSync(outFile);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

async function collect(zip: Uint8Array): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  await extractArchive(zip, (entry) => { result.set(entry.path, Buffer.from(entry.data)); });
  return result;
}

suite('ArchiveCodec.extractArchive (Э7)', () => {
  test('zip платформы: deflate, флаг UTF-8, кириллица в путях, вложенные каталоги; возвращает число файлов', async () => {
    const zip = buildZip([
      { name: 'ConfigDumpInfo.xml', data: Buffer.from('<ConfigDumpInfo/>') },
      { name: 'Catalogs/Товары.xml', data: Buffer.from('<Catalog>Товары</Catalog>') },
      { name: 'Catalogs/Товары/Ext/ObjectModule.bsl', data: Buffer.from('Процедура А() КонецПроцедуры') },
    ]);
    const seen: string[] = [];
    const count = await extractArchive(zip, (entry) => { seen.push(entry.path); });
    assert.strictEqual(count, 3);
    assert.deepStrictEqual(seen, ['ConfigDumpInfo.xml', 'Catalogs/Товары.xml', 'Catalogs/Товары/Ext/ObjectModule.bsl']);
    const files = await collect(zip);
    assert.strictEqual(files.get('Catalogs/Товары.xml')?.toString('utf-8'), '<Catalog>Товары</Catalog>');
  });

  test('имена БЕЗ флага UTF-8 — cp866 (кириллица читается, а не превращается в «╨ЄтЁ»)', async () => {
    const name = 'Справочники/Товары.xml';
    const zip = buildZip([
      { name: encode(name, 'cp866'), data: Buffer.from('1'), utf8Flag: false },
      { name: encode('Документы/Заказ/Ext/ObjectModule.bsl', 'cp866'), data: Buffer.from('2'), utf8Flag: false },
    ]);
    const files = await collect(zip);
    assert.deepStrictEqual([...files.keys()], [name, 'Документы/Заказ/Ext/ObjectModule.bsl']);
  });

  test('флаг UTF-8 выставлен только у части записей: каждая запись декодируется по СВОЕМУ флагу', async () => {
    const zip = buildZip([
      { name: 'Каталоги/А.xml', data: Buffer.from('1'), utf8Flag: true },
      { name: encode('Каталоги/Б.xml', 'cp866'), data: Buffer.from('2'), utf8Flag: false },
    ]);
    assert.deepStrictEqual([...(await collect(zip)).keys()], ['Каталоги/А.xml', 'Каталоги/Б.xml']);
  });

  test('ASCII-имена без флага не искажаются', async () => {
    const zip = buildZip([{ name: Buffer.from('Configuration.xml'), data: Buffer.from('x'), utf8Flag: false }]);
    assert.deepStrictEqual([...(await collect(zip)).keys()], ['Configuration.xml']);
  });

  test('метод хранения (без сжатия) и пустые файлы', async () => {
    const zip = buildZip([
      { name: 'a.bin', data: Buffer.from([1, 2, 3]), method: 0 },
      { name: 'empty.txt', data: Buffer.alloc(0) },
      { name: 'empty-stored.txt', data: Buffer.alloc(0), method: 0 },
    ]);
    const files = await collect(zip);
    assert.deepStrictEqual([...files.get('a.bin') ?? []], [1, 2, 3]);
    assert.strictEqual(files.get('empty.txt')?.length, 0);
    assert.strictEqual(files.get('empty-stored.txt')?.length, 0);
  });

  test('бинарные данные байт-в-байт: все значения 0..255, BOM, CRLF, не-UTF-8', async () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<a/>\r\n<b/>\r\n')]);
    const files = await collect(buildZip([{ name: 'all.bin', data: all }, { name: 'bom.xml', data: bom }]));
    assert.deepStrictEqual([...(files.get('all.bin') ?? [])], [...all]);
    assert.deepStrictEqual([...(files.get('bom.xml') ?? [])], [...bom]);
  });

  test('большой файл (20 МБ: несжимаемая часть + сжимаемая) распаковывается байт-в-байт', async function () {
    this.timeout(60_000);
    const big = Buffer.concat([patternBytes(8 * 1024 * 1024), Buffer.alloc(12 * 1024 * 1024, 0x41)]);
    const files = await collect(buildZip([{ name: 'Ext/Big.bin', data: big }]));
    assert.ok(big.equals(files.get('Ext/Big.bin') ?? Buffer.alloc(0)));
  });

  test('записи-каталоги (имя с / на конце) приёмнику не отдаются', async () => {
    const zip = buildZip([
      { name: 'Catalogs/', data: Buffer.alloc(0), method: 0 },
      { name: 'Catalogs/Товары.xml', data: Buffer.from('x') },
    ]);
    assert.deepStrictEqual([...(await collect(zip)).keys()], ['Catalogs/Товары.xml']);
  });

  test('разделитель \\ в имени записи приводится к /', async () => {
    const zip = buildZip([{ name: 'Catalogs\\Товары.xml', data: Buffer.from('x') }]);
    assert.deepStrictEqual([...(await collect(zip)).keys()], ['Catalogs/Товары.xml']);
  });

  test('пустой архив (ни одной записи) — 0 файлов, без ошибки', async () => {
    assert.strictEqual(await extractArchive(buildZip([]), () => { throw new Error('не должно вызываться'); }), 0);
  });

  test('приёмник вызывается строго последовательно и в порядке центрального каталога (await между записями)', async () => {
    const zip = buildZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${String(i)}.txt`, data: Buffer.from(String(i)) })));
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    await extractArchive(zip, async (entry) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      order.push(entry.path);
      active -= 1;
    });
    assert.strictEqual(maxActive, 1);
    assert.deepStrictEqual(order, ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt']);
  });

  test('ошибка приёмника пробрасывается как есть, следующие записи не отдаются', async () => {
    const zip = buildZip([{ name: 'a', data: Buffer.from('1') }, { name: 'b', data: Buffer.from('2') }]);
    const seen: string[] = [];
    await assert.rejects(
      extractArchive(zip, (entry) => { seen.push(entry.path); throw new Error('диск полон'); }),
      /диск полон/
    );
    assert.deepStrictEqual(seen, ['a']);
  });

  suite('повреждённые и небезопасные архивы: ошибка ДО первого обращения к приёмнику', () => {
    async function assertRejectsBeforeSink(zip: Uint8Array, pattern?: RegExp): Promise<void> {
      let sinkCalls = 0;
      await assert.rejects(
        extractArchive(zip, () => { sinkCalls += 1; }),
        (error: unknown) => error instanceof ArchiveFormatError && (pattern ? pattern.test(error.message) : true)
      );
      assert.strictEqual(sinkCalls, 0, 'приёмник не должен был получить ни одной записи');
    }

    test('не zip: произвольные байты, пустой буфер, обрезанный в середине архив', async () => {
      await assertRejectsBeforeSink(Buffer.from('это не архив, а просто текст'));
      await assertRejectsBeforeSink(Buffer.alloc(0));
      const zip = buildZip([{ name: 'a.txt', data: patternBytes(2000) }, { name: 'b.txt', data: patternBytes(2000, 7) }]);
      await assertRejectsBeforeSink(zip.subarray(0, Math.floor(zip.length / 2)));
    });

    test('испорчено сжатое тело ПОСЛЕДНЕЙ записи: первые записи корректны, но не отдаются (всё или ничего)', async () => {
      const zip = Buffer.from(buildZip([
        { name: 'first.bin', data: patternBytes(500) },
        { name: 'last.bin', data: patternBytes(5000, 3), method: 0 },
      ]));
      // Тело последней записи без сжатия: портим один байт — CRC32 не сойдётся.
      const entries = readZip(zip);
      const marker = entries[1].data.subarray(100, 108);
      const at = zip.indexOf(marker);
      assert.ok(at > 0);
      zip[at + 3] ^= 0xff;
      await assertRejectsBeforeSink(zip, /CRC|контрольн|повреж/i);
    });

    test('испорчен deflate-поток (не распаковывается)', async () => {
      const zip = Buffer.from(buildZip([{ name: 'x.txt', data: Buffer.alloc(5000, 0x42) }]));
      const dataStart = 30 + 'x.txt'.length;
      zip.fill(0xff, dataStart, dataStart + 8);
      await assertRejectsBeforeSink(zip);
    });

    for (const bad of ['../evil.xml', 'a/../../evil.xml', '/abs/evil.xml', 'C:/evil.xml', 'C:\\evil.xml', 'a/./../../x']) {
      test(`zip-slip: запись «${bad}» отвергается целиком`, async () => {
        const zip = buildZip([
          { name: 'Catalogs/ok.xml', data: Buffer.from('1') },
          { name: bad, data: Buffer.from('x') },
        ]);
        await assertRejectsBeforeSink(zip, /путь|выход|небезопас/i);
      });
    }

    test('имя записи пустое → отказ', async () => {
      await assertRejectsBeforeSink(buildZip([{ name: '', data: Buffer.from('x') }]));
    });
  });
});

suite('ArchiveCodec.packArchive / packDirectoryFiles (Э7)', () => {
  test('архив — стандартный zip: флаг UTF-8 у каждой записи, deflate у сжимаемых, имена и данные читаются независимым разбором', () => {
    const entries: ArchiveEntry[] = [
      { path: 'Configuration.xml', data: Buffer.from('<Configuration>'.repeat(200)) },
      { path: 'Catalogs/Товары/Ext/ObjectModule.bsl', data: Buffer.from('Процедура А() КонецПроцедуры') },
      { path: 'CommonPictures/Лого/Ext/Picture/Picture.png', data: patternBytes(3000) },
      { path: 'Пусто.txt', data: Buffer.alloc(0) },
    ];
    const zip = packArchive(entries);
    const parsed = readZip(zip);
    assert.strictEqual(parsed.length, entries.length);
    for (const [index, entry] of parsed.entries()) {
      assert.ok((entry.flags & 0x0800) !== 0, `флаг UTF-8 у записи ${String(index)}`);
      assert.strictEqual(entry.nameBytes.toString('utf-8'), entries[index].path);
      assert.ok(Buffer.from(entries[index].data).equals(entry.data), entries[index].path);
    }
    assert.strictEqual(parsed[0].method, 8, 'сжимаемый XML упакован deflate');
  });

  test('round trip: pack → extract возвращает те же пути и байты (кириллица, пробелы, бинарные)', async () => {
    const entries: ArchiveEntry[] = [
      { path: 'Каталог с пробелом/Файл (копия) #2.txt', data: Buffer.from('содержимое') },
      { path: 'bin/all.bin', data: Buffer.from(Array.from({ length: 256 }, (_, i) => i)) },
      { path: 'bom.xml', data: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<a/>\r\n')]) },
    ];
    const files = await collect(packArchive(entries));
    assert.deepStrictEqual([...files.keys()], entries.map((e) => e.path));
    for (const entry of entries) {
      assert.ok(Buffer.from(entry.data).equals(files.get(entry.path) ?? Buffer.alloc(0)), entry.path);
    }
  });

  test('большой файл 20 МБ: pack → extract байт-в-байт', async function () {
    this.timeout(60_000);
    const big = Buffer.concat([patternBytes(6 * 1024 * 1024, 5), Buffer.alloc(14 * 1024 * 1024, 0x20)]);
    const zip = packArchive([{ path: 'Ext/Big.bin', data: big }]);
    assert.ok(zip.length < big.length, 'сжимаемая часть реально сжата');
    const files = await collect(zip);
    assert.ok(big.equals(files.get('Ext/Big.bin') ?? Buffer.alloc(0)));
  });

  test('пустой набор записей → валидный пустой zip', async () => {
    assert.strictEqual(await extractArchive(packArchive([]), () => undefined), 0);
    assert.strictEqual(readZip(packArchive([])).length, 0);
  });

  test('небезопасный путь при упаковке (.., абсолютный) → ArchiveFormatError', () => {
    for (const bad of ['../x', '/abs', 'C:/x']) {
      assert.throws(() => packArchive([{ path: bad, data: Buffer.from('1') }]), ArchiveFormatError, bad);
    }
  });

  suite('packDirectoryFiles', () => {
    let tempRoot: string;
    setup(() => { tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-archive-dir-')); });
    teardown(() => { fs.rmSync(tempRoot, { recursive: true, force: true }); });

    function put(rel: string, data: Buffer | string): void {
      const abs = path.join(tempRoot, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
    }

    test('пакует ровно перечисленные файлы каталога, имена — POSIX от корня каталога', async () => {
      put('Configuration.xml', '<c/>');
      put('Catalogs/Товары.xml', '<t/>');
      put('Catalogs/Товары/Ext/ObjectModule.bsl', 'Процедура А() КонецПроцедуры');
      put('Лишний.xml', '<no/>');
      const map = readZipAsMap(await packDirectoryFiles(tempRoot, ['Configuration.xml', 'Catalogs/Товары.xml', 'Catalogs/Товары/Ext/ObjectModule.bsl']));
      assert.deepStrictEqual([...map.keys()], ['Configuration.xml', 'Catalogs/Товары.xml', 'Catalogs/Товары/Ext/ObjectModule.bsl']);
      assert.strictEqual(map.get('Catalogs/Товары.xml')?.toString('utf-8'), '<t/>');
    });

    test('файла нет → ошибка с именем файла (архив с дырой в загрузку не уйдёт)', async () => {
      put('a.xml', '1');
      await assert.rejects(packDirectoryFiles(tempRoot, ['a.xml', 'Catalogs/Нет.xml']), /Нет\.xml/);
    });

    test('пустой список → пустой архив', async () => {
      assert.strictEqual(readZip(await packDirectoryFiles(tempRoot, [])).length, 0);
    });
  });

  suite('на реальном корпусе example/2.20 (только чтение, пишем во временный каталог)', () => {
    setup(function () { skipWithoutCorpus(this, EXAMPLE_GENERATIONS.cf20); });

    test('упаковка кусочка корпуса (XML, BSL, формы, картинки) и распаковка во временный каталог — байт-в-байт', async function () {
      this.timeout(120_000);
      const root = EXAMPLE_GENERATIONS.cf20;
      const rels: string[] = ['Configuration.xml'];
      const walk = (dirRel: string, budget: { left: number }): void => {
        const abs = path.join(root, ...dirRel.split('/'));
        if (!fs.existsSync(abs)) {
          return;
        }
        for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (budget.left <= 0) {
            return;
          }
          const rel = `${dirRel}/${entry.name}`;
          if (entry.isDirectory()) {
            walk(rel, budget);
          } else {
            rels.push(rel);
            budget.left -= 1;
          }
        }
      };
      for (const folder of ['Catalogs', 'Documents', 'CommonModules', 'CommonPictures', 'Roles']) {
        walk(folder, { left: 60 });
      }
      assert.ok(rels.length > 100, `файлов в выборке: ${String(rels.length)}`);

      const zip = await packDirectoryFiles(root, rels);
      const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-archive-corpus-'));
      try {
        const count = await extractArchive(zip, (entry) => {
          const target = path.join(outRoot, ...entry.path.split('/'));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, entry.data);
        });
        assert.strictEqual(count, rels.length);
        for (const rel of rels) {
          const original = fs.readFileSync(path.join(root, ...rel.split('/')));
          const copy = fs.readFileSync(path.join(outRoot, ...rel.split('/')));
          assert.ok(original.equals(copy), rel);
        }
      } finally {
        fs.rmSync(outRoot, { recursive: true, force: true });
      }
    });
  });
});

/**
 * Защитные ветки разбора контейнера (Н39): архив приходит с сервера, и каждое поле заголовка,
 * указывающее за пределы буфера или на неподдерживаемое, обязано дать ArchiveFormatError ДО
 * приёмника, а не исключение Node о выходе за границу буфера и не частичную распаковку.
 */
suite('ArchiveCodec: повреждённые заголовки zip (Н39)', () => {
  const END = 22;
  /** Архив из одной записи и смещения его структур. */
  function sample(method: 0 | 8 = 0): { zip: Buffer; central: number; end: number } {
    const zip = Buffer.from(buildZip([{ name: 'a.txt', data: Buffer.from('содержимое'), method }]));
    const end = zip.length - END;
    return { zip, central: zip.readUInt32LE(end + 16), end };
  }
  async function rejectsFormat(zip: Uint8Array, pattern: RegExp): Promise<void> {
    let sinkCalls = 0;
    await assert.rejects(
      extractArchive(zip, () => { sinkCalls += 1; }),
      (error: unknown) => error instanceof ArchiveFormatError && pattern.test(error.message)
    );
    assert.strictEqual(sinkCalls, 0);
  }

  test('центральный каталог вне архива: смещение за концом и маркер zip64', async () => {
    const beyond = sample();
    beyond.zip.writeUInt32LE(beyond.zip.length, beyond.end + 16);
    await rejectsFormat(beyond.zip, /центральный каталог/);
    const zip64 = sample();
    zip64.zip.writeUInt32LE(0xffffffff, zip64.end + 16);
    await rejectsFormat(zip64.zip, /zip64/);
  });

  test('битая запись центрального каталога: чужая сигнатура и записей меньше заявленного', async () => {
    const signature = sample();
    signature.zip.writeUInt32LE(0x12345678, signature.central);
    await rejectsFormat(signature.zip, /запись центрального каталога №1/);
    const count = sample();
    count.zip.writeUInt16LE(2, count.end + 10);
    await rejectsFormat(count.zip, /запись центрального каталога №2/);
  });

  test('битый локальный заголовок: чужая сигнатура и смещение за концом архива', async () => {
    const signature = sample();
    signature.zip.writeUInt32LE(0x12345678, 0);
    await rejectsFormat(signature.zip, /локальный заголовок записи "a\.txt"/);
    const offset = sample();
    offset.zip.writeUInt32LE(offset.zip.length, offset.central + 42);
    await rejectsFormat(offset.zip, /локальный заголовок/);
  });

  test('данные записи за пределами архива: размер больше буфера и маркер zip64', async () => {
    const big = sample();
    // Запись без сжатия: оба размера сдвинуты согласованно (иначе отказ раньше — «размеры не совпадают»),
    // чтобы проверялась именно граница данных записи.
    big.zip.writeUInt32LE(big.zip.length, big.central + 20);
    big.zip.writeUInt32LE(big.zip.length, big.central + 24);
    await rejectsFormat(big.zip, /за пределами архива/);
    const zip64 = sample();
    zip64.zip.writeUInt32LE(0xffffffff, zip64.central + 20);
    await rejectsFormat(zip64.zip, /нет поля zip64/);
  });

  test('неподдерживаемый метод сжатия (например, 12 — bzip2)', async () => {
    const { zip, central } = sample();
    zip.writeUInt16LE(12, central + 10);
    await rejectsFormat(zip, /Метод сжатия 12/);
  });

  test('размер распакованных данных не совпадает с заголовком (запись без сжатия)', async () => {
    const { zip, central } = sample();
    zip.writeUInt32LE(zip.readUInt32LE(central + 24) + 1, central + 24);
    // У записи без сжатия размеры обязаны совпадать — расхождение ловится уже при разборе каталога.
    await rejectsFormat(zip, /размеры не совпадают/);
  });

  test('длинный буфер без записи конца каталога: поиск ограничен окном комментария и даёт отказ', async () => {
    await rejectsFormat(patternBytes(70_000, 99), /Не zip-архив/);
  });
});

/**
 * zip64 и целостность центрального каталога (возврат ревью Э7, Б3): выгрузка реальной конфигурации —
 * больше 65 535 файлов; при усечённом счётчике читалась бы часть записей, и импорт удалил бы из
 * проекта «отсутствующие» файлы.
 */
suite('ArchiveCodec: zip64 и целостность каталога (Б3)', () => {
  async function rejectsFormat(zip: Uint8Array, pattern: RegExp): Promise<void> {
    let sinkCalls = 0;
    await assert.rejects(
      extractArchive(zip, () => { sinkCalls += 1; }),
      (error: unknown) => error instanceof ArchiveFormatError && pattern.test(error.message)
    );
    assert.strictEqual(sinkCalls, 0);
  }
  const ENTRIES = [
    { name: 'Configuration.xml', data: Buffer.from('<Configuration/>') },
    { name: 'Catalogs/Товары.xml', data: Buffer.from('<Catalog>Товары</Catalog>'.repeat(50)) },
    { name: 'Catalogs/Товары/Ext/Picture.bin', data: patternBytes(5000, 31), method: 0 as const },
  ];

  test('архив в стиле zip64 НЕЗАВИСИМОГО сборщика (extra 0x0001 у каждой записи, EOCD64 + локатор) читается байт-в-байт', async () => {
    const files = await collect(buildZip(ENTRIES, { zip64: true }));
    assert.deepStrictEqual([...files.keys()], ENTRIES.map((e) => e.name));
    for (const entry of ENTRIES) {
      assert.ok(entry.data.equals(files.get(entry.name) ?? Buffer.alloc(0)), entry.name);
    }
  });

  test('больше 65 535 записей: pack пишет zip64 (счётчик 0xFFFF + EOCD64), extract и независимый разбор видят все записи', async function () {
    this.timeout(180_000);
    const count = 70_000;
    const entries: ArchiveEntry[] = Array.from({ length: count }, (_, i) => ({
      path: `Catalogs/О${String(i)}.xml`,
      data: Buffer.from(`<Catalog n="${String(i)}"/>`),
    }));
    const zip = Buffer.from(packArchive(entries));
    assert.strictEqual(zip.readUInt16LE(zip.length - 22 + 10), 0xffff, 'счётчик обычной записи конца — маркер zip64');
    assert.strictEqual(zip.readUInt32LE(zip.length - 22 - 20), 0x07064b50, 'локатор zip64 перед записью конца');
    assert.strictEqual(readZip(zip).length, count);
    let seen = 0;
    let last = '';
    const extracted = await extractArchive(zip, (entry) => { seen += 1; last = Buffer.from(entry.data).toString('utf-8'); });
    assert.strictEqual(extracted, count);
    assert.strictEqual(seen, count);
    assert.strictEqual(last, `<Catalog n="${String(count - 1)}"/>`);
  });

  test('малый архив — обычный формат: без локатора zip64, счётчик записей настоящий', () => {
    const small = Buffer.from(packArchive([{ path: 'a.txt', data: Buffer.from('1') }]));
    assert.notStrictEqual(small.readUInt32LE(Math.max(0, small.length - 42)), 0x07064b50);
    assert.strictEqual(small.readUInt16LE(small.length - 22 + 10), 1);
  });

  test('усечённый счётчик записей (каталог прочитан не целиком) → отказ до приёмника', async () => {
    const zip = buildZip(ENTRIES);
    zip.writeUInt16LE(2, zip.length - 22 + 8);
    zip.writeUInt16LE(2, zip.length - 22 + 10);
    await rejectsFormat(zip, /прочитан не целиком/);
  });

  test('усечённый счётчик в EOCD64 → отказ; счётчик вне безопасного диапазона → отказ', async () => {
    const truncated = buildZip(ENTRIES, { zip64: true });
    const end64 = Number(truncated.readBigUInt64LE(truncated.length - 22 - 20 + 8));
    truncated.writeBigUInt64LE(2n, end64 + 32);
    await rejectsFormat(truncated, /прочитан не целиком/);
    const huge = buildZip(ENTRIES, { zip64: true });
    huge.writeBigUInt64LE(2n ** 60n, end64 + 32);
    await rejectsFormat(huge, /вне допустимого диапазона/);
  });

  test('локатор zip64 указывает не на запись конца каталога zip64 → отказ', async () => {
    const zip = buildZip(ENTRIES, { zip64: true });
    zip.writeBigUInt64LE(0n, zip.length - 22 - 20 + 8);
    await rejectsFormat(zip, /конца центрального каталога zip64/);
    const beyond = buildZip(ENTRIES, { zip64: true });
    beyond.writeBigUInt64LE(BigInt(beyond.length - 30), beyond.length - 22 - 20 + 8);
    await rejectsFormat(beyond, /конца центрального каталога zip64/);
  });

  test('поля zip64 в обычной записи конца без локатора → отказ', async () => {
    const zip = buildZip(ENTRIES);
    zip.writeUInt16LE(0xffff, zip.length - 22 + 10);
    await rejectsFormat(zip, /без записи конца каталога zip64/);
  });

  test('маркер 0xFFFFFFFF в записи, а extra 0x0001 короче нужного или выходит за extra → отказ', async () => {
    const short = buildZip([ENTRIES[0]], { zip64: true });
    const shortAt = short.indexOf(Buffer.from([0x01, 0x00, 0x18, 0x00]));
    short.writeUInt16LE(0x08, shortAt + 2);
    await rejectsFormat(short, /нет поля zip64/);
    const long = buildZip([ENTRIES[0]], { zip64: true });
    const longAt = long.indexOf(Buffer.from([0x01, 0x00, 0x18, 0x00]));
    long.writeUInt16LE(0x40, longAt + 2);
    await rejectsFormat(long, /нет поля zip64/);
  });

  suite('zip-бомба и альтернативные потоки NTFS', () => {
    test('заявленный размер записи больше предела — отказ по заголовку, без выделения памяти', async () => {
      const zip = buildZip([{ name: 'big.bin', data: Buffer.from('x'), method: 0 }]);
      const central = zip.readUInt32LE(zip.length - 22 + 16);
      zip.writeUInt32LE(0x50000000, central + 24);
      await rejectsFormat(zip, /больше допустимого размера/);
    });

    test('крупная запись со сверхсильным сжатием (20 МБ нулей) — отказ как подозрение на zip-бомбу', async function () {
      this.timeout(60_000);
      await rejectsFormat(buildZip([{ name: 'zeros.bin', data: Buffer.alloc(20 * 1024 * 1024) }]), /zip-бомба/);
    });

    test('двоеточие в сегменте пути (NTFS ADS) отвергается и при распаковке, и при упаковке', async () => {
      await rejectsFormat(buildZip([{ name: 'Catalogs/Товары.xml:поток', data: Buffer.from('x') }]), /двоеточие/);
      assert.throws(() => packArchive([{ path: 'Ext/a:b.bsl', data: Buffer.from('1') }]), ArchiveFormatError);
    });
  });
});

