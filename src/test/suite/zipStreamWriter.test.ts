import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentTransferCancelledError } from '../../infra/agent/files/AgentFileTransfer';
import { packArchive, packDirectoryFilesToFile, type ArchiveEntry } from '../../infra/agent/sync/ArchiveCodec';
import { writeZipToFile } from '../../infra/agent/sync/ArchiveFile';
import {
  ZipStreamWriter,
  bufferByteSource,
  readCentralRecords,
  type ZipByteSink,
  type ZipWriteRecord,
} from '../../infra/agent/sync/ZipContainer';
import { buildZip, crc32, patternBytes, readZip, readZipAsMap } from './support/zipFixtures';

/**
 * Потоковая запись zip: `ZipStreamWriter` отдаёт локальный заголовок и данные записи в приёмник СРАЗУ
 * (в памяти остаются только записи центрального каталога), а `packDirectoryFilesToFile` собирает архив
 * по одному файлу (чтение → сжатие → запись). Эталон байтов — `packArchive(entries)` (прежняя
 * буферная упаковка) и независимый сборщик `buildZip`: выход файла обязан совпадать с ними побайтно, в том
 * числе с zip64-хвостом (≥ 65 535 записей) и на пустом наборе.
 */

class RecordingSink implements ZipByteSink {
  readonly chunks: Buffer[] = [];
  /** Нужна ли асинхронная пауза перед приёмом (проверка, что писатель дожидается приёмника). */
  constructor(private readonly delay = false) {}
  async write(chunk: Uint8Array): Promise<void> {
    if (this.delay) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.chunks.push(Buffer.from(chunk));
  }
  get total(): number { return this.chunks.reduce((sum, chunk) => sum + chunk.length, 0); }
  get maxChunk(): number { return Math.max(0, ...this.chunks.map((chunk) => chunk.length)); }
  bytes(): Buffer { return Buffer.concat(this.chunks); }
}

function storedRecord(name: string, data: Buffer): ZipWriteRecord {
  return { nameBytes: Buffer.from(name, 'utf-8'), flags: 0x0800, method: 0, crc: crc32(data), size: data.length, payload: data };
}

suite('ZipStreamWriter и packDirectoryFilesToFile', function () {
  this.timeout(300_000);
  let tmp: string;
  setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-zip-writer-')); });
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  suite('ZipStreamWriter', () => {
    const items = (): { name: string; data: Buffer }[] => [
      { name: 'Configuration.xml', data: Buffer.from('<c/>') },
      { name: 'Catalogs/Товары.xml', data: Buffer.from('<Catalog>Товары</Catalog>') },
      { name: 'Ext/Picture.bin', data: patternBytes(10_000, 3) },
    ];

    test('байты совпадают с независимым сборщиком buildZip (записи без сжатия)', async () => {
      const sink = new RecordingSink();
      const writer = new ZipStreamWriter(sink);
      for (const item of items()) {
        await writer.add(storedRecord(item.name, item.data));
      }
      await writer.finish();
      const golden = buildZip(items().map((item) => ({ name: item.name, data: item.data, method: 0 as const })));
      assert.ok(golden.equals(sink.bytes()), 'выход писателя ≡ эталон побайтно');
    });

    test('асинхронный приёмник: писатель дожидается каждой записи, порядок байт не нарушается', async () => {
      const sink = new RecordingSink(true);
      const writer = new ZipStreamWriter(sink);
      for (const item of items()) {
        await writer.add(storedRecord(item.name, item.data));
      }
      await writer.finish();
      const golden = buildZip(items().map((item) => ({ name: item.name, data: item.data, method: 0 as const })));
      assert.ok(golden.equals(sink.bytes()));
    });

    test('потоковость: после add заголовок и данные записи уже в приёмнике, центрального каталога ещё нет; единичная запись не больше payload + заголовка', async () => {
      const payload = patternBytes(1_000_000, 7);
      const sink = new RecordingSink();
      const writer = new ZipStreamWriter(sink);
      await writer.add(storedRecord('big1.bin', payload));
      assert.ok(sink.total >= payload.length, 'данные первой записи уже отданы');
      assert.ok(sink.total < payload.length + 1_024, 'ничего сверх локального заголовка и данных (центральный каталог — в finish)');
      const afterFirst = sink.total;
      await writer.add(storedRecord('big2.bin', payload));
      assert.ok(sink.total >= afterFirst + payload.length);
      await writer.finish();
      assert.ok(sink.maxChunk <= payload.length + 1_024, `самая большая запись в приёмник: ${String(sink.maxChunk)}`);
      assert.strictEqual(readZip(sink.bytes()).length, 2);
    });

    test('пустой набор → валидный пустой zip, равный buildZip([])', async () => {
      const sink = new RecordingSink();
      await new ZipStreamWriter(sink).finish();
      assert.ok(buildZip([]).equals(sink.bytes()));
      assert.strictEqual(readZip(sink.bytes()).length, 0);
    });

    test('65 536 записей: zip64-хвост (счётчик 0xFFFF в обычной записи конца, EOCD64 и локатор); независимый разбор и readCentralRecords видят все записи', async () => {
      const sink = new RecordingSink();
      const writer = new ZipStreamWriter(sink);
      const total = 65_536;
      for (let i = 0; i < total; i += 1) {
        await writer.add(storedRecord(`d${String(i % 256)}/f${String(i)}.xml`, Buffer.from('x')));
      }
      await writer.finish();
      const out = sink.bytes();
      const end = out.length - 22;
      assert.strictEqual(out.readUInt32LE(end), 0x06054b50);
      assert.strictEqual(out.readUInt16LE(end + 10), 0xffff, 'счётчик в обычной записи конца — маркер zip64');
      assert.strictEqual(out.readUInt32LE(end - 20), 0x07064b50, 'локатор EOCD64 прямо перед записью конца');
      const parsed = readZip(out);
      assert.strictEqual(parsed.length, total);
      assert.strictEqual(parsed[total - 1].nameBytes.toString('utf-8'), `d${String((total - 1) % 256)}/f${String(total - 1)}.xml`);
      const records = await readCentralRecords(bufferByteSource(out));
      assert.strictEqual(records.length, total);
    });

    test('ровно 65 534 записи — ещё обычный формат (без локатора zip64)', async () => {
      const sink = new RecordingSink();
      const writer = new ZipStreamWriter(sink);
      for (let i = 0; i < 65_534; i += 1) {
        await writer.add(storedRecord(`f${String(i)}`, Buffer.alloc(0)));
      }
      await writer.finish();
      const out = sink.bytes();
      assert.strictEqual(out.readUInt16LE(out.length - 22 + 10), 65_534);
      assert.notStrictEqual(out.readUInt32LE(out.length - 22 - 20), 0x07064b50);
    });
  });

  suite('packDirectoryFilesToFile', () => {
    let root: string;
    setup(() => { root = path.join(tmp, 'project'); fs.mkdirSync(root, { recursive: true }); });

    function put(rel: string, data: Buffer | string): void {
      const abs = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
    }
    const out = (): string => path.join(tmp, 'out.zip');

    function putStandard(): string[] {
      put('Configuration.xml', '<c/>');
      put('Catalogs/Товары.xml', '<Catalog>Товары</Catalog>');
      put('Catalogs/Товары/Ext/ObjectModule.bsl', 'Процедура А() КонецПроцедуры\r\n'.repeat(200));
      put('CommonPictures/Лого/Ext/Picture/Picture.png', patternBytes(30_000, 4));
      put('Пустой файл.xml', '');
      put('Лишний.xml', '<не попадает/>');
      return ['Configuration.xml', 'Catalogs/Товары.xml', 'Catalogs/Товары/Ext/ObjectModule.bsl', 'CommonPictures/Лого/Ext/Picture/Picture.png', 'Пустой файл.xml'];
    }

    const entriesOf = (rels: readonly string[]): ArchiveEntry[] =>
      rels.map((rel) => ({ path: rel, data: fs.readFileSync(path.join(root, ...rel.split('/'))) }));

    test('golden: байты файла === packArchive(entries) (кириллица, сжимаемые и несжимаемые, пустой файл)', async () => {
      const rels = putStandard();
      await packDirectoryFilesToFile(root, rels, out());
      assert.ok(Buffer.from(packArchive(entriesOf(rels))).equals(fs.readFileSync(out())));
      const map = readZipAsMap(fs.readFileSync(out()));
      assert.deepStrictEqual([...map.keys()], rels, 'ровно перечисленные файлы, POSIX-имена от корня');
    });

    test('пустой набор → файл равен packArchive([]) (пустой zip)', async () => {
      await packDirectoryFilesToFile(root, [], out());
      assert.ok(Buffer.from(packArchive([])).equals(fs.readFileSync(out())));
    });

    test('65 536 записей (zip64-хвост): файл === packArchive; читается независимым разбором', async () => {
      const rels: string[] = [];
      for (let i = 0; i < 64; i += 1) {
        put(`d/f${String(i)}.xml`, `<f>${String(i)}</f>`);
      }
      for (let i = 0; i < 65_536; i += 1) {
        rels.push(`d/f${String(i % 64)}.xml`);
      }
      await packDirectoryFilesToFile(root, rels, out());
      const bytes = fs.readFileSync(out());
      assert.ok(Buffer.from(packArchive(entriesOf(rels))).equals(bytes));
      assert.strictEqual(readZip(bytes).length, 65_536);
    });

    test('отсутствующий файл → ошибка с именем файла; выходной файл удалён (архив с дырой не остаётся)', async () => {
      put('a.xml', '1');
      await assert.rejects(packDirectoryFilesToFile(root, ['a.xml', 'Catalogs/Нет.xml'], out()), /Нет\.xml/);
      assert.strictEqual(fs.existsSync(out()), false);
    });

    test('отмена между файлами: AgentTransferCancelledError, выходного файла нет', async () => {
      const rels = putStandard();
      let checks = 0;
      const cancellation = { get isCancellationRequested(): boolean { checks += 1; return checks > 2; } };
      await assert.rejects(packDirectoryFilesToFile(root, rels, out(), cancellation), AgentTransferCancelledError);
      assert.strictEqual(fs.existsSync(out()), false);
    });

    test('отмена до старта: ни одного файла не прочитано, выходного файла нет', async () => {
      const rels = putStandard();
      await assert.rejects(packDirectoryFilesToFile(root, rels, out(), { isCancellationRequested: true }), AgentTransferCancelledError);
      assert.strictEqual(fs.existsSync(out()), false);
    });

    test('выходной файл уже существует → отказ (открытие wx), прежний файл не затёрт', async () => {
      const rels = putStandard();
      fs.writeFileSync(out(), 'прежнее');
      await assert.rejects(packDirectoryFilesToFile(root, rels, out()));
      assert.strictEqual(fs.readFileSync(out(), 'utf-8'), 'прежнее');
    });
  });

  suite('writeZipToFile', () => {
    test('успех: файл создан, содержит записи, добавленные в писатель', async () => {
      const file = path.join(tmp, 'w.zip');
      const data = Buffer.from('содержимое записи');
      await writeZipToFile(file, async (writer) => { await writer.add(storedRecord('a.txt', data)); });
      assert.strictEqual(fs.readFileSync(file).readUInt32LE(0), 0x04034b50);
      assert.ok(fs.statSync(file).size > data.length);
    });

    test('ошибка сборки: файл удалён, исходная ошибка пробрасывается', async () => {
      const file = path.join(tmp, 'broken.zip');
      await assert.rejects(writeZipToFile(file, async (writer) => {
        await writer.add(storedRecord('a.txt', Buffer.from('1')));
        throw new Error('сбой сборки');
      }), /сбой сборки/);
      assert.strictEqual(fs.existsSync(file), false);
    });

    test('цель уже существует → отказ без перезаписи', async () => {
      const file = path.join(tmp, 'exists.zip');
      fs.writeFileSync(file, 'прежнее');
      await assert.rejects(writeZipToFile(file, () => Promise.resolve()));
      assert.strictEqual(fs.readFileSync(file, 'utf-8'), 'прежнее');
    });
  });
});
