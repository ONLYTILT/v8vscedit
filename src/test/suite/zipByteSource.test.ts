import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openFileByteSource } from '../../infra/agent/sync/ArchiveFile';
import {
  ArchiveFormatError,
  bufferByteSource,
  localDataStart,
  readCentralRecords,
  type ZipByteSource,
} from '../../infra/agent/sync/ZipContainer';
import { buildZip, patternBytes, readZip } from './support/zipFixtures';

/**
 * Потоковое чтение контейнера zip: `readCentralRecords`/`localDataStart` работают поверх `ZipByteSource`
 * (случайный доступ `read(offset, length)`), а не поверх буфера всего архива. Два источника — буферный
 * (`bufferByteSource`, обёртка для `extractArchive`) и файловый (`openFileByteSource`, настоящий файл на
 * диске) — обязаны давать ОДИН результат на любых формах архива: обычном, zip64, с комментарием
 * максимальной длины (запись конца каталога zip64 оказывается вне окна хвоста), меньше окна хвоста и пустом.
 */

const MAX_COMMENT = 65_535;

interface OpenedSource {
  readonly source: ZipByteSource;
  close(): Promise<void>;
}

suite('ZipContainer: ZipByteSource и файловый источник', function () {
  this.timeout(120_000);
  let tmp: string;
  let counter = 0;

  setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-zip-source-')); });
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const kinds = ['buffer', 'file'] as const;

  async function open(kind: (typeof kinds)[number], zip: Buffer): Promise<OpenedSource> {
    if (kind === 'buffer') {
      return { source: bufferByteSource(zip), close: () => Promise.resolve() };
    }
    counter += 1;
    const file = path.join(tmp, `archive-${String(counter)}.zip`);
    fs.writeFileSync(file, zip);
    const opened = await openFileByteSource(file);
    return { source: opened, close: () => opened.close() };
  }

  async function withSource<T>(kind: (typeof kinds)[number], zip: Buffer, run: (source: ZipByteSource) => Promise<T>): Promise<T> {
    const opened = await open(kind, zip);
    try {
      return await run(opened.source);
    } finally {
      await opened.close();
    }
  }

  const tiny = (count: number, method: 0 | 8 = 8): { name: string; data: Buffer; method: 0 | 8 }[] =>
    Array.from({ length: count }, (_, i) => ({ name: `Каталог/Файл ${String(i)}.xml`, data: Buffer.from(`<f>${String(i)}</f>`), method }));

  suite('паритет буферного и файлового источника', () => {
    const cases: { label: string; build: () => Buffer }[] = [
      { label: 'обычный zip', build: () => buildZip(tiny(5)) },
      { label: 'пустой архив (только запись конца)', build: () => buildZip([]) },
      { label: 'архив меньше окна хвоста', build: () => buildZip(tiny(1, 0)) },
      { label: 'комментарий архива максимальной длины 65 535 байт', build: () => buildZip(tiny(4), { comment: Buffer.alloc(MAX_COMMENT, 0x41) }) },
      { label: 'zip64 по максимуму (extra 0x0001 у каждой записи, EOCD64 + локатор)', build: () => buildZip(tiny(6), { zip64: true }) },
      {
        label: 'zip64 + комментарий 65 535 байт: запись конца zip64 вне окна хвоста (отдельное чтение)',
        build: () => buildZip(tiny(6), { zip64: true, comment: Buffer.alloc(MAX_COMMENT, 0x41) }),
      },
      { label: 'zip64, 65 600 записей (больше 16-битного счётчика)', build: () => buildZip(tiny(65_600, 0), { zip64: true }) },
    ];

    for (const { label, build } of cases) {
      test(label, async () => {
        const zip = build();
        const expectedNames = readZip(zip).map((entry) => entry.nameBytes.toString('utf-8'));
        const results = new Map<string, Awaited<ReturnType<typeof readCentralRecords>>>();
        for (const kind of kinds) {
          results.set(kind, await withSource(kind, zip, (source) => readCentralRecords(source)));
        }
        const fromBuffer = results.get('buffer') ?? [];
        const fromFile = results.get('file') ?? [];
        assert.deepStrictEqual(fromBuffer.map((r) => r.nameBytes.toString('utf-8')), expectedNames);
        assert.deepStrictEqual(fromFile, fromBuffer, 'файловый источник даёт те же записи, что и буферный');
      });
    }

    test('данные записей читаются тем же смещением из обоих источников (localDataStart)', async () => {
      // Без сжатия: байты по смещению данных обязаны быть самими данными записи.
      const zip = buildZip(tiny(3, 0), { zip64: true });
      const expected = readZip(zip);
      for (const kind of kinds) {
        await withSource(kind, zip, async (source) => {
          const records = await readCentralRecords(source);
          for (const [index, record] of records.entries()) {
            const name = record.nameBytes.toString('utf-8');
            const start = await localDataStart(source, record, name);
            const payload = await source.read(start, record.compressedSize);
            assert.strictEqual(payload.length, record.compressedSize);
            assert.strictEqual(expected[index].nameBytes.toString('utf-8'), name);
            assert.ok(expected[index].data.equals(payload), name);
          }
        });
      }
    });
  });

  suite('отказы формата: ArchiveFormatError, а не исключение чтения за границей', () => {
    const sample = (): Buffer => buildZip(tiny(3, 0));
    const isFormatError = (error: unknown): boolean => error instanceof ArchiveFormatError;

    for (const kind of kinds) {
      test(`[${kind}] усечённый файл: нет записи конца каталога`, async () => {
        const zip = sample();
        await withSource(kind, zip.subarray(0, zip.length - 40), (source) =>
          assert.rejects(readCentralRecords(source), isFormatError));
      });

      test(`[${kind}] пустой источник и источник короче записи конца`, async () => {
        await withSource(kind, Buffer.alloc(0), (source) => assert.rejects(readCentralRecords(source), isFormatError));
        await withSource(kind, Buffer.from('PK'), (source) => assert.rejects(readCentralRecords(source), isFormatError));
      });

      test(`[${kind}] центральный каталог вне файла: смещение в записи конца больше размера`, async () => {
        const zip = Buffer.from(sample());
        zip.writeUInt32LE(zip.length + 1_000, zip.length - 22 + 16);
        await withSource(kind, zip, (source) => assert.rejects(readCentralRecords(source), isFormatError));
      });

      test(`[${kind}] расхождение счётчика записей: меньше и больше фактического`, async () => {
        for (const delta of [-1, 1]) {
          const zip = Buffer.from(sample());
          const end = zip.length - 22;
          zip.writeUInt16LE(zip.readUInt16LE(end + 10) + delta, end + 8);
          zip.writeUInt16LE(zip.readUInt16LE(end + 10) + delta, end + 10);
          await withSource(kind, zip, (source) => assert.rejects(readCentralRecords(source), isFormatError, `delta ${String(delta)}`));
        }
      });

      test(`[${kind}] localDataStart: локальный заголовок за пределами, чужая сигнатура, данные за пределами`, async () => {
        const zip = sample();
        await withSource(kind, zip, async (source) => {
          const [record] = await readCentralRecords(source);
          const name = record.nameBytes.toString('utf-8');
          await assert.rejects(localDataStart(source, { ...record, localOffset: zip.length - 5 }, name), isFormatError);
          // Смещение на середину данных: там нет сигнатуры локального заголовка.
          await assert.rejects(localDataStart(source, { ...record, localOffset: 40 }, name), isFormatError);
          await assert.rejects(localDataStart(source, { ...record, compressedSize: zip.length * 2 }, name), isFormatError);
          assert.ok((await localDataStart(source, record, name)) > 0);
        });
      });

      test(`[${kind}] чтение за пределами источника → ArchiveFormatError`, async () => {
        const zip = sample();
        await withSource(kind, zip, async (source) => {
          assert.strictEqual(source.size, zip.length);
          await assert.rejects(source.read(zip.length - 1, 2), isFormatError);
          await assert.rejects(source.read(zip.length, 1), isFormatError);
          assert.strictEqual((await source.read(0, 4)).readUInt32LE(0), 0x04034b50);
        });
      });
    }

    test('размер центрального каталога больше MAX_CENTRAL_DIRECTORY → отказ ДО его чтения (память не выделяется под него)', async () => {
      // Источник «3 ГиБ» без выделения: содержимое нулевое, а в хвосте — запись конца каталога, которая
      // заявляет каталог в 2 ГиБ. Любой разумный предел защитной проверки ниже этого значения.
      const hugeSize = 3 * 1024 * 1024 * 1024;
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(1, 8);
      end.writeUInt16LE(1, 10);
      end.writeUInt32LE(0x80000000, 12);
      end.writeUInt32LE(0, 16);
      const reads: { offset: number; length: number }[] = [];
      const source: ZipByteSource = {
        size: hugeSize,
        read: (offset, length) => {
          reads.push({ offset, length });
          if (offset < 0 || offset + length > hugeSize) {
            return Promise.reject(new ArchiveFormatError('чтение за пределами источника'));
          }
          const data = Buffer.alloc(length);
          const endStart = hugeSize - end.length;
          for (let i = 0; i < length; i += 1) {
            if (offset + i >= endStart) {
              data[i] = end[offset + i - endStart];
            }
          }
          return Promise.resolve(data);
        },
      };

      await assert.rejects(readCentralRecords(source), isFormatError);
      assert.ok(reads.every((r) => r.length <= 1024 * 1024), `самое большое чтение: ${String(Math.max(...reads.map((r) => r.length)))} байт`);
    });
  });

  suite('хвост и экономия чтений', () => {
    test('найти запись конца в большом файле: хвост читается одним запросом, не всем файлом', async () => {
      const zip = buildZip(tiny(3, 0), { comment: Buffer.alloc(1_000, 0x41) });
      const reads: number[] = [];
      const inner = bufferByteSource(zip);
      const source: ZipByteSource = {
        size: inner.size,
        read: (offset, length) => { reads.push(length); return inner.read(offset, length); },
      };
      await readCentralRecords(source);
      assert.ok(reads.length <= 3, `число чтений: ${String(reads.length)}`);
      assert.ok(Math.max(...reads) <= zip.length);
    });

    test('случайный доступ не зависит от размера данных: каталог на 200 записей в 8 МБ читается чтениями, меньшими файла', async () => {
      const zip = buildZip(Array.from({ length: 200 }, (_, i) => ({ name: `f${String(i)}.bin`, data: patternBytes(40_000, i + 1), method: 0 as const })));
      const reads: number[] = [];
      const inner = bufferByteSource(zip);
      await readCentralRecords({ size: inner.size, read: (o, l) => { reads.push(l); return inner.read(o, l); } });
      assert.ok(Math.max(...reads) < zip.length / 4, 'данные записей не читаются при разборе каталога');
    });
  });

  suite('openFileByteSource', () => {
    test('size и mtimeMs совпадают с файловой системой; чтение с произвольного смещения', async () => {
      const file = path.join(tmp, 'plain.bin');
      const data = patternBytes(100_000, 5);
      fs.writeFileSync(file, data);
      const opened = await openFileByteSource(file);
      try {
        assert.strictEqual(opened.size, data.length);
        assert.strictEqual(opened.mtimeMs, fs.statSync(file).mtimeMs);
        assert.ok(data.subarray(70_000, 70_100).equals(await opened.read(70_000, 100)));
        assert.strictEqual((await opened.read(0, 0)).length, 0);
      } finally {
        await opened.close();
      }
    });

    test('close освобождает дескриптор: файл можно удалить (на Windows открытый файл не удаляется)', async () => {
      const file = path.join(tmp, 'to-delete.bin');
      fs.writeFileSync(file, 'x');
      const opened = await openFileByteSource(file);
      await opened.close();
      fs.unlinkSync(file);
      assert.strictEqual(fs.existsSync(file), false);
    });

    test('отсутствующий файл → отказ', async () => {
      await assert.rejects(openFileByteSource(path.join(tmp, 'нет.zip')), /нет\.zip/);
    });
  });
});
