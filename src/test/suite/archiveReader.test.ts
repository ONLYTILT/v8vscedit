import * as assert from 'assert';
import * as fs from 'fs';
import { encode } from 'iconv-lite';
import * as os from 'os';
import * as path from 'path';
import { AgentTransferCancelledError } from '../../infra/agent/files/AgentFileTransfer';
import { ArchiveFormatError, openArchive, type ArchiveReader } from '../../infra/agent/sync/ArchiveCodec';
import { openFileByteSource } from '../../infra/agent/sync/ArchiveFile';
import { bufferByteSource, localDataStart, readCentralRecords, type ZipByteSource } from '../../infra/agent/sync/ZipContainer';
import { buildZip, patternBytes } from './support/zipFixtures';

/**
 * `openArchive(source)`: чтение архива с диска без загрузки его в память целиком. Центральный каталог
 * читается один раз; `scan` — ЕДИНСТВЕННЫЙ валидирующий проход (inflate + CRC каждой записи) до первой записи
 * в проект; `read` отдаёт только перечисленные записи (CRC перепроверяется), а перед первой проверяет,
 * что файл не менялся с открытия (size + mtimeMs). Страж памяти считает ЧТЕНИЯ источника, а не память
 * процесса: детерминированно и не зависит от сборщика мусора.
 */

type FileSource = Awaited<ReturnType<typeof openFileByteSource>>;

/** Источник-обёртка: журнал чтений; `size`/`mtimeMs`/`close` пробрасываются, чтобы читатель видел файловый источник. */
class CountingByteSource implements ZipByteSource {
  readonly reads: { offset: number; length: number }[] = [];
  constructor(private readonly inner: FileSource) {}
  get size(): number { return this.inner.size; }
  get mtimeMs(): number { return this.inner.mtimeMs; }
  close(): Promise<void> { return this.inner.close(); }
  read(offset: number, length: number): Promise<Buffer> {
    this.reads.push({ offset, length });
    return this.inner.read(offset, length);
  }
}

/** Искажает ровно один байт внутри заданного диапазона данных, пока `armed` (после `scan`). */
class TamperingSource implements ZipByteSource {
  armed = false;
  private readonly inner: ZipByteSource;
  constructor(zip: Buffer, private readonly dataStart: number, private readonly dataLength: number) { this.inner = bufferByteSource(zip); }
  get size(): number { return this.inner.size; }
  async read(offset: number, length: number): Promise<Buffer> {
    const data = Buffer.from(await this.inner.read(offset, length));
    const middle = this.dataStart + Math.floor(this.dataLength / 2);
    if (this.armed && middle >= offset && middle < offset + length) {
      data[middle - offset] ^= 0xff;
    }
    return data;
  }
}

suite('ArchiveReader (openArchive): scan / read над файловым источником', function () {
  this.timeout(180_000);
  let tmp: string;
  let counter = 0;
  const closers: (() => Promise<void>)[] = [];

  setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-archive-reader-')); });
  teardown(async () => {
    for (const close of closers.splice(0)) {
      await close();
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeArchive(zip: Buffer): string {
    counter += 1;
    const file = path.join(tmp, `a-${String(counter)}.zip`);
    fs.writeFileSync(file, zip);
    return file;
  }

  async function openFile(zip: Buffer): Promise<{ reader: ArchiveReader; file: string; source: FileSource }> {
    const file = writeArchive(zip);
    const source = await openFileByteSource(file);
    closers.push(() => source.close());
    return { reader: await openArchive(source), file, source };
  }

  const entries = (): { name: string; data: Buffer; method?: 0 | 8 }[] => [
    { name: 'ConfigDumpInfo.xml', data: Buffer.from('<ConfigDumpInfo/>') },
    { name: 'Catalogs/Товары.xml', data: Buffer.from('<Catalog>Товары</Catalog>') },
    { name: 'Catalogs/Товары/Ext/ObjectModule.bsl', data: Buffer.from('Процедура А() КонецПроцедуры'), method: 0 },
    { name: 'Roles/Админ.xml', data: patternBytes(5_000, 9), method: 0 },
  ];

  const collectScan = async (reader: ArchiveReader): Promise<Map<string, Buffer>> => {
    const seen = new Map<string, Buffer>();
    await reader.scan((entry) => { seen.set(entry.path, Buffer.from(entry.data)); });
    return seen;
  };

  suite('paths и scan', () => {
    test('paths — только файлы (записи-каталоги не входят), имена декодированы (UTF-8 и cp866), порядок каталога', async () => {
      const { reader } = await openFile(buildZip([
        { name: 'Catalogs/', data: Buffer.alloc(0), method: 0 },
        { name: 'Catalogs/Товары.xml', data: Buffer.from('1') },
        { name: encode('Документы/Заказ.xml', 'cp866'), data: Buffer.from('2'), utf8Flag: false },
      ]));
      assert.deepStrictEqual([...reader.paths], ['Catalogs/Товары.xml', 'Документы/Заказ.xml']);
    });

    test('scan: все файлы с данными в порядке каталога; возвращает число файлов; каталоги пропускаются', async () => {
      const list = entries();
      const { reader } = await openFile(buildZip([{ name: 'Catalogs/', data: Buffer.alloc(0), method: 0 }, ...list]));
      const order: string[] = [];
      const count = await reader.scan((entry) => { order.push(entry.path); });
      assert.strictEqual(count, list.length);
      assert.deepStrictEqual(order, list.map((e) => e.name));
      const seen = await collectScan(reader);
      for (const item of list) {
        assert.ok(item.data.equals(seen.get(item.name) ?? Buffer.alloc(0)), item.name);
      }
    });

    test('scan пустого архива: 0 файлов, приёмник не вызывается', async () => {
      const { reader } = await openFile(buildZip([]));
      assert.deepStrictEqual([...reader.paths], []);
      assert.strictEqual(await reader.scan(() => { throw new Error('не должно вызываться'); }), 0);
    });

    test('ошибка CRC ПОСЛЕДНЕЙ записи → ArchiveFormatError', async () => {
      const marker = Buffer.from('УНИКАЛЬНЫЙ-МАРКЕР-ПОСЛЕДНЕЙ-ЗАПИСИ');
      const zip = Buffer.from(buildZip([
        { name: 'a.txt', data: Buffer.from('первая'), method: 0 },
        { name: 'b.txt', data: marker, method: 0 },
      ]));
      zip[zip.indexOf(marker) + 3] ^= 0xff;
      const { reader } = await openFile(zip);
      await assert.rejects(reader.scan(() => undefined), (error: unknown) => error instanceof ArchiveFormatError && error.message.includes('CRC32'));
    });

    test('испорченный deflate-поток → ArchiveFormatError', async () => {
      const zip = Buffer.from(buildZip([{ name: 'a.txt', data: Buffer.alloc(2_000, 0x41) }]));
      const dataStart = 30 + Buffer.byteLength('a.txt');
      zip.fill(0xff, dataStart, dataStart + 4);
      const { reader } = await openFile(zip);
      await assert.rejects(reader.scan(() => undefined), ArchiveFormatError);
    });

    test('небезопасный путь записи (zip-slip, абсолютный, двоеточие) → ArchiveFormatError при открытии или scan, приёмник не вызван', async () => {
      for (const bad of ['../evil.xml', '/abs.xml', 'C:/x.xml', 'a/b:поток.xml']) {
        const file = writeArchive(buildZip([{ name: 'ok.xml', data: Buffer.from('1') }, { name: bad, data: Buffer.from('2') }]));
        const source = await openFileByteSource(file);
        closers.push(() => source.close());
        let calls = 0;
        await assert.rejects(async () => {
          const reader = await openArchive(source);
          await reader.scan(() => { calls += 1; });
        }, ArchiveFormatError, bad);
        assert.strictEqual(calls, 0, `${bad}: приёмник не должен получить записи`);
      }
    });

    test('сжатые данные записи больше предела (битый compressedSize) → ArchiveFormatError при открытии, данные не читаются', async () => {
      const zip = Buffer.from(buildZip([{ name: 'a.txt', data: Buffer.from('данные') }]));
      const central = zip.readUInt32LE(zip.length - 22 + 16);
      zip.writeUInt32LE(0x50000000, central + 20);
      const file = writeArchive(zip);
      const counting = new CountingByteSource(await openFileByteSource(file));
      closers.push(() => counting.close());
      await assert.rejects(openArchive(counting), (e: unknown) => e instanceof ArchiveFormatError && e.message.includes('Сжатые данные'));
      assert.ok(counting.reads.every((r) => r.length < 0x50000000));
    });

    test('запись без сжатия с compressedSize ≠ size → ArchiveFormatError при открытии', async () => {
      const zip = Buffer.from(buildZip([{ name: 'a.bin', data: patternBytes(100, 3), method: 0 }]));
      const central = zip.readUInt32LE(zip.length - 22 + 16);
      zip.writeUInt32LE(101, central + 20);
      const source = await openFileByteSource(writeArchive(zip));
      closers.push(() => source.close());
      await assert.rejects(openArchive(source), (e: unknown) => e instanceof ArchiveFormatError && e.message.includes('размеры не совпадают'));
    });

    test('отмена до старта и между записями: AgentTransferCancelledError, дальше записи не отдаются', async () => {
      const { reader } = await openFile(buildZip(entries()));
      const before = { isCancellationRequested: true };
      let calls = 0;
      await assert.rejects(reader.scan(() => { calls += 1; }, before), AgentTransferCancelledError);
      assert.strictEqual(calls, 0);

      const cancel = { isCancellationRequested: false };
      const seen: string[] = [];
      await assert.rejects(reader.scan((entry) => { seen.push(entry.path); cancel.isCancellationRequested = true; }, cancel), AgentTransferCancelledError);
      assert.deepStrictEqual(seen, ['ConfigDumpInfo.xml']);
    });

    test('приёмник вызывается строго последовательно (await между записями); его ошибка пробрасывается как есть', async () => {
      const { reader } = await openFile(buildZip(entries()));
      let active = 0;
      let maxActive = 0;
      await reader.scan(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
      });
      assert.strictEqual(maxActive, 1);
      await assert.rejects(reader.scan(() => { throw new Error('диск полон'); }), /диск полон/);
    });
  });

  suite('read', () => {
    test('отдаёт только запрошенные записи (в порядке каталога); незапрошенные не читаются', async () => {
      const { reader } = await openFile(buildZip(entries()));
      const got = new Map<string, Buffer>();
      await reader.read(new Set(['Roles/Админ.xml', 'ConfigDumpInfo.xml']), (entry) => { got.set(entry.path, Buffer.from(entry.data)); });
      assert.deepStrictEqual([...got.keys()], ['ConfigDumpInfo.xml', 'Roles/Админ.xml']);
      assert.strictEqual(got.get('ConfigDumpInfo.xml')?.toString('utf-8'), '<ConfigDumpInfo/>');
    });

    test('пустой набор — приёмник не вызывается; read можно вызывать повторно и без предшествующего scan', async () => {
      const { reader } = await openFile(buildZip(entries()));
      await reader.read(new Set(), () => { throw new Error('не должно вызываться'); });
      const first: string[] = [];
      await reader.read(new Set(['Catalogs/Товары.xml']), (e) => { first.push(e.path); });
      await reader.read(new Set(['Catalogs/Товары.xml']), (e) => { first.push(e.path); });
      assert.deepStrictEqual(first, ['Catalogs/Товары.xml', 'Catalogs/Товары.xml']);
    });

    test('несуществующий путь → ошибка с именем пути, приёмник не получает ничего', async () => {
      const { reader } = await openFile(buildZip(entries()));
      let calls = 0;
      await assert.rejects(reader.read(new Set(['Catalogs/Нет.xml']), () => { calls += 1; }), /Нет\.xml/);
      assert.strictEqual(calls, 0);
    });

    test('CRC перепроверяется при read: байты запрошенной записи изменились после scan → ArchiveFormatError', async () => {
      const zip = buildZip([
        { name: 'a.bin', data: patternBytes(3_000, 1), method: 0 },
        { name: 'b.bin', data: patternBytes(3_000, 2), method: 0 },
      ]);
      const plain = bufferByteSource(zip);
      const records = await readCentralRecords(plain);
      const start = await localDataStart(plain, records[1], 'b.bin');
      const source = new TamperingSource(zip, start, records[1].compressedSize);
      const reader = await openArchive(source);
      await reader.scan(() => undefined);
      source.armed = true;
      let calls = 0;
      await assert.rejects(reader.read(new Set(['b.bin']), () => { calls += 1; }), (e: unknown) => e instanceof ArchiveFormatError && e.message.includes('CRC32'));
      assert.strictEqual(calls, 0);
      await reader.read(new Set(['a.bin']), () => { calls += 1; });
      assert.strictEqual(calls, 1, 'неизменённая запись читается');
    });

    test('файл архива изменился после открытия: размер → ArchiveFormatError ДО приёмника', async () => {
      const { reader, file } = await openFile(buildZip(entries()));
      await reader.scan(() => undefined);
      fs.appendFileSync(file, Buffer.from([1, 2, 3]));
      let calls = 0;
      await assert.rejects(reader.read(new Set(['ConfigDumpInfo.xml']), () => { calls += 1; }), ArchiveFormatError);
      assert.strictEqual(calls, 0);
    });

    test('файл архива изменился после открытия: тот же размер, другое время изменения → ArchiveFormatError ДО приёмника', async () => {
      const zip = buildZip(entries());
      const { reader, file, source } = await openFile(zip);
      await reader.scan(() => undefined);
      const later = new Date(source.mtimeMs + 60_000);
      fs.utimesSync(file, later, later);
      let calls = 0;
      await assert.rejects(reader.read(new Set(['ConfigDumpInfo.xml']), () => { calls += 1; }), ArchiveFormatError);
      assert.strictEqual(calls, 0);
    });
  });

  suite('страж памяти: архив ≥ 64 МБ читается по записям, а не целиком', () => {
    test('scan + read половины записей: единичное чтение ≤ max(сжатая запись, каталог, окно хвоста), ни одно ≥ size/2, суммарно ≤ 2×size', async function () {
      const count = 45;
      const payloadSize = 1_500_000;
      const items = Array.from({ length: count }, (_, i) => ({ name: `Ext/Picture${String(i)}.bin`, data: patternBytes(payloadSize, i + 1), method: 0 as const }));
      const zip = buildZip(items);
      assert.ok(zip.length >= 64 * 1024 * 1024, `архив ${String(zip.length)} байт`);
      const file = writeArchive(zip);
      const counting = new CountingByteSource(await openFileByteSource(file));
      closers.push(() => counting.close());
      const size = counting.size;
      const centralSize = zip.readUInt32LE(zip.length - 22 + 12);
      const tailWindow = 22 + 65_535 + 20;
      const slack = 1_024; // заголовок записи, читаемый вместе с данными
      const bound = Math.max(payloadSize, centralSize, tailWindow) + slack;

      const reader = await openArchive(counting);
      const visited: string[] = [];
      await reader.scan((entry) => { visited.push(entry.path); });
      const afterScan = counting.reads.reduce((sum, r) => sum + r.length, 0);
      assert.strictEqual(visited.length, count);
      assert.ok(afterScan <= size + tailWindow + centralSize + count * slack, `scan прочитал ${String(afterScan)} из ${String(size)}: каждая запись один раз`);

      const half = new Set(items.filter((_, i) => i % 2 === 0).map((item) => item.name));
      const got: string[] = [];
      await reader.read(half, (entry) => { got.push(entry.path); });
      assert.strictEqual(got.length, half.size);

      const lengths = counting.reads.map((r) => r.length);
      assert.ok(Math.max(...lengths) <= bound, `самое большое чтение: ${String(Math.max(...lengths))}, предел ${String(bound)}`);
      assert.ok(lengths.every((length) => length < size / 2), 'ни одно чтение не сопоставимо с размером архива');
      const total = lengths.reduce((sum, length) => sum + length, 0);
      assert.ok(total <= 2 * size, `суммарно прочитано ${String(total)} при размере ${String(size)}`);
    });
  });
});
