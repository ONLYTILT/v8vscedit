import { deflateSync, inflateSync } from 'fflate';
import * as fs from 'fs';
import { decode } from 'iconv-lite';
import * as path from 'path';
import { throwIfTransferCancellationRequested, type AgentTransferCancellation } from '../files/AgentFileTransfer';
import { writeZipToFile } from './ArchiveFile';
import {
  ArchiveFormatError,
  bufferByteSource,
  crc32,
  localDataStart,
  readCentralRecords,
  writeZip,
  type ZipByteSource,
  type ZipCentralRecord,
  type ZipWriteRecord,
} from './ZipContainer';

export { ArchiveFormatError } from './ZipContainer';

/**
 * Zip-обмен с агентом конфигуратора (`dump --archive` / `load --archive`).
 *
 * Контейнер zip разбирается и собирается здесь, а fflate отвечает только за deflate: высокоуровневые
 * `zipSync`/`unzipSync` fflate не отдают флаг UTF-8 записи (а без него имя — cp866, которое fflate
 * прочёл бы как latin1) и не дают выставить флаг всем записям, как это делает платформа (пилот §5b п.7).
 *
 * Архив читается с произвольным доступом ({@link openArchive}) и пишется потоком
 * ({@link packDirectoryFilesToFile}): в памяти — одна запись (сжатая и распакованная) и центральный
 * каталог, а не весь архив. Запись в проект — «всё или ничего»: `scan` инфлирует и сверяет по CRC32
 * каждую запись до первой записи в проект, а `read` отдаёт только нужные, перепроверяя CRC.
 */

export interface ArchiveEntry {
  /** POSIX-путь записи от корня архива. */
  readonly path: string;
  readonly data: Uint8Array;
}

export type ArchiveSink = (entry: ArchiveEntry) => void | Promise<void>;

export interface ArchiveReader {
  /** Файлы архива в порядке центрального каталога (без записей-каталогов). */
  readonly paths: readonly string[];
  /**
   * Один валидирующий проход (inflate + CRC каждой записи); `visitor` получает путь и данные каждого
   * файла. Писать в проект отсюда нельзя: валидность всего архива известна только после прохода.
   */
  scan(visitor: ArchiveSink, cancellation?: AgentTransferCancellation): Promise<number>;
  /** Только перечисленные записи (в порядке каталога), CRC перепроверяется; неизвестный путь — отказ до приёмника. */
  read(paths: ReadonlySet<string>, sink: ArchiveSink): Promise<void>;
}

const UTF8_FLAG = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/**
 * Предел размера одной записи (из заголовка, до выделения памяти). Самые большие файлы выгрузки —
 * двоичные макеты и картинки в десятки мегабайт; гигабайт — заведомо не выгрузка, а порча или
 * zip-бомба, которая иначе заставила бы выделить буфер заявленного размера.
 */
const MAX_ENTRY_SIZE = 1024 * 1024 * 1024;
/**
 * Предел коэффициента сжатия для записей крупнее {@link RATIO_CHECK_FROM}: deflate теоретически
 * даёт до ~1032:1, XML выгрузки — порядка 10–30:1. Мелкие записи не проверяются — у пустых и
 * однородных файлов коэффициент велик, но вреда нет.
 */
const MAX_COMPRESSION_RATIO = 500;
const RATIO_CHECK_FROM = 16 * 1024 * 1024;

interface ArchiveRecord {
  readonly path: string;
  readonly isDirectory: boolean;
  readonly central: ZipCentralRecord;
}

/**
 * Читатель архива поверх источника: центральный каталог читается и проверяется сразу (имена,
 * размеры, zip-slip), данные записей — по требованию.
 */
export async function openArchive(source: ZipByteSource): Promise<ArchiveReader> {
  const records = (await readCentralRecords(source)).map((central): ArchiveRecord => {
    const rawName = (central.flags & UTF8_FLAG) !== 0 ? central.nameBytes.toString('utf-8') : decode(central.nameBytes, 'cp866');
    assertSafeSize(central, rawName);
    return { path: normalizeEntryPath(rawName), isDirectory: /[/\\]$/.test(rawName), central };
  });
  return new SourceArchiveReader(source, records);
}

class SourceArchiveReader implements ArchiveReader {
  readonly paths: readonly string[];

  constructor(private readonly source: ZipByteSource, private readonly records: readonly ArchiveRecord[]) {
    this.paths = records.filter((record) => !record.isDirectory).map((record) => record.path);
  }

  async scan(visitor: ArchiveSink, cancellation?: AgentTransferCancellation): Promise<number> {
    let count = 0;
    for (const record of this.records) {
      throwIfTransferCancellationRequested(cancellation);
      // Записи-каталоги тоже проверяются: битая запись любого вида означает испорченный архив.
      const data = await this.inflate(record);
      if (record.isDirectory) {
        continue;
      }
      await visitor({ path: record.path, data });
      count += 1;
    }
    return count;
  }

  async read(paths: ReadonlySet<string>, sink: ArchiveSink): Promise<void> {
    const known = new Set(this.paths);
    const missing = [...paths].filter((rel) => !known.has(rel));
    if (missing.length > 0) {
      throw new ArchiveFormatError(`В архиве нет запрошенных записей: ${missing.join(', ')}.`);
    }
    for (const record of this.records) {
      if (!record.isDirectory && paths.has(record.path)) {
        await sink({ path: record.path, data: await this.inflate(record) });
      }
    }
  }

  private async inflate(record: ArchiveRecord): Promise<Uint8Array> {
    const { central } = record;
    const start = await localDataStart(this.source, central, record.path);
    return decodeRecord(record, await this.source.read(start, central.compressedSize));
  }
}

/** Архив в памяти целиком (небольшие архивы, тесты): прежняя семантика «всё или ничего». */
export async function extractArchive(zip: Uint8Array, sink: ArchiveSink): Promise<number> {
  const reader = await openArchive(bufferByteSource(Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength)));
  await reader.scan(() => undefined);
  let count = 0;
  await reader.read(new Set(reader.paths), async (entry) => {
    count += 1;
    await sink(entry);
  });
  return count;
}

export function packArchive(entries: readonly ArchiveEntry[]): Uint8Array {
  return writeZip(entries.map(toWriteRecord));
}

/**
 * Архив из перечисленных файлов каталога прямо в новый файл, по одному файлу (чтение → сжатие →
 * запись). Отсутствующий файл или отмена — отказ, недописанный архив удаляется: архив с дырой не
 * должен уйти в загрузку. Байты те же, что у {@link packArchive}.
 */
export async function packDirectoryFilesToFile(
  rootDir: string,
  relativePaths: readonly string[],
  outFile: string,
  cancellation?: AgentTransferCancellation
): Promise<void> {
  throwIfTransferCancellationRequested(cancellation);
  await writeZipToFile(outFile, async (writer) => {
    for (const rel of relativePaths) {
      throwIfTransferCancellationRequested(cancellation);
      let data: Buffer;
      try {
        data = await fs.promises.readFile(path.join(rootDir, ...rel.split('/')));
      } catch (error) {
        throw new Error(`Не удалось прочитать файл "${rel}" для архива: ${(error as Error).message}`, { cause: error });
      }
      await writer.add(toWriteRecord({ path: rel, data }));
    }
  });
}

function toWriteRecord(entry: ArchiveEntry): ZipWriteRecord {
  const deflated = deflateSync(entry.data);
  const method = deflated.length < entry.data.length ? METHOD_DEFLATE : METHOD_STORE;
  return {
    nameBytes: Buffer.from(normalizeEntryPath(entry.path), 'utf-8'),
    flags: UTF8_FLAG,
    method,
    crc: crc32(entry.data),
    size: entry.data.length,
    payload: method === METHOD_DEFLATE ? deflated : entry.data,
  };
}

function assertSafeSize(central: ZipCentralRecord, name: string): void {
  if (central.size > MAX_ENTRY_SIZE) {
    throw new ArchiveFormatError(`Запись архива "${name}" больше допустимого размера (${String(central.size)} байт).`);
  }
  // Сжатые данные читаются в память целиком: без предела битый заголовок заставил бы выделить
  // буфер размером с архив.
  if (central.compressedSize > MAX_ENTRY_SIZE) {
    throw new ArchiveFormatError(`Сжатые данные записи архива "${name}" больше допустимого размера (${String(central.compressedSize)} байт).`);
  }
  if (central.method === METHOD_STORE && central.compressedSize !== central.size) {
    throw new ArchiveFormatError(`Повреждённый zip: у записи без сжатия "${name}" размеры не совпадают.`);
  }
  if (central.size > RATIO_CHECK_FROM && central.size > central.compressedSize * MAX_COMPRESSION_RATIO) {
    throw new ArchiveFormatError(`Запись архива "${name}" сжата подозрительно сильно (zip-бомба?).`);
  }
}

function decodeRecord(record: ArchiveRecord, payload: Uint8Array): Uint8Array {
  const { central } = record;
  let data: Uint8Array;
  if (central.method === METHOD_STORE) {
    data = payload;
  } else if (central.method === METHOD_DEFLATE) {
    try {
      data = inflateSync(payload, { out: new Uint8Array(central.size) });
    } catch (error) {
      throw new ArchiveFormatError(`Повреждённый zip: не распаковывается запись "${record.path}": ${(error as Error).message}`);
    }
  } else {
    throw new ArchiveFormatError(`Метод сжатия ${String(central.method)} записи "${record.path}" не поддерживается.`);
  }
  if (data.length !== central.size || crc32(data) !== central.crc) {
    throw new ArchiveFormatError(`Повреждённый zip: не сходится контрольная сумма (CRC32) записи "${record.path}".`);
  }
  return data;
}

/**
 * Путь записи — только относительный и внутри корня (zip-slip): архив приходит с сервера, и
 * `../` в имени записи иначе адресовал бы файл вне выгрузки проекта. Двоеточие в сегменте
 * запрещено: на NTFS `файл:поток` пишет в альтернативный поток данных, а не в файл.
 */
function normalizeEntryPath(name: string): string {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new ArchiveFormatError(`Небезопасный путь записи архива (абсолютный): "${name}".`);
  }
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    throw new ArchiveFormatError(`Небезопасный путь записи архива (выход за корень): "${name}".`);
  }
  if (segments.some((segment) => segment.includes(':'))) {
    throw new ArchiveFormatError(`Небезопасный путь записи архива (двоеточие в имени): "${name}".`);
  }
  if (segments.length === 0) {
    throw new ArchiveFormatError(`Пустой путь записи архива: "${name}".`);
  }
  return segments.join('/');
}
