import { deflateSync, inflateSync } from 'fflate';
import * as fs from 'fs';
import { decode } from 'iconv-lite';
import * as path from 'path';
import {
  ArchiveFormatError,
  crc32,
  localDataStart,
  readCentralRecords,
  writeZip,
  type ZipCentralRecord,
} from './ZipContainer';

export { ArchiveFormatError } from './ZipContainer';

/**
 * Zip-обмен с агентом конфигуратора (`dump --archive` / `load --archive`).
 *
 * Контейнер zip разбирается и собирается здесь, а fflate отвечает только за deflate: высокоуровневые
 * `zipSync`/`unzipSync` fflate не отдают флаг UTF-8 записи (а без него имя — cp866, которое fflate
 * прочёл бы как latin1) и не дают выставить флаг всем записям, как это делает платформа (пилот §5b п.7).
 *
 * Распаковка — «всё или ничего»: сначала каждая запись инфлируется и сверяется по CRC32, и только
 * потом приёмнику отдаётся первая. Движок пишет из приёмника прямо в проект, и повреждённый архив
 * иначе оставил бы выгрузку с частью новых файлов. Повторная инфляция на втором проходе дешевле,
 * чем держать в памяти всю распакованную выгрузку.
 */

export interface ArchiveEntry {
  /** POSIX-путь записи от корня архива. */
  readonly path: string;
  readonly data: Uint8Array;
}

export type ArchiveSink = (entry: ArchiveEntry) => void | Promise<void>;

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
  readonly dataStart: number;
}

export async function extractArchive(zip: Uint8Array, sink: ArchiveSink): Promise<number> {
  const buffer = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const records = readCentralRecords(buffer).map((central): ArchiveRecord => {
    const rawName = (central.flags & UTF8_FLAG) !== 0 ? central.nameBytes.toString('utf-8') : decode(central.nameBytes, 'cp866');
    assertSafeSize(central, rawName);
    return {
      path: normalizeEntryPath(rawName),
      isDirectory: /[/\\]$/.test(rawName),
      central,
      dataStart: localDataStart(buffer, central, rawName),
    };
  });
  for (const record of records) {
    inflateRecord(buffer, record);
  }
  let count = 0;
  for (const record of records) {
    if (record.isDirectory) {
      continue;
    }
    await sink({ path: record.path, data: inflateRecord(buffer, record) });
    count += 1;
  }
  return count;
}

export function packArchive(entries: readonly ArchiveEntry[]): Uint8Array {
  return writeZip(entries.map((entry) => {
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
  }));
}

/** Архив из перечисленных файлов каталога; отсутствующий файл — отказ (архив с дырой не загружается). */
export function packDirectoryFiles(rootDir: string, relativePaths: readonly string[]): Uint8Array {
  const entries = relativePaths.map((rel) => {
    try {
      return { path: rel, data: fs.readFileSync(path.join(rootDir, ...rel.split('/'))) };
    } catch (error) {
      throw new Error(`Не удалось прочитать файл "${rel}" для архива: ${(error as Error).message}`, { cause: error });
    }
  });
  return packArchive(entries);
}

function assertSafeSize(central: ZipCentralRecord, name: string): void {
  if (central.size > MAX_ENTRY_SIZE) {
    throw new ArchiveFormatError(`Запись архива "${name}" больше допустимого размера (${String(central.size)} байт).`);
  }
  if (central.size > RATIO_CHECK_FROM && central.size > central.compressedSize * MAX_COMPRESSION_RATIO) {
    throw new ArchiveFormatError(`Запись архива "${name}" сжата подозрительно сильно (zip-бомба?).`);
  }
}

function inflateRecord(buffer: Buffer, record: ArchiveRecord): Uint8Array {
  const { central } = record;
  const payload = buffer.subarray(record.dataStart, record.dataStart + central.compressedSize);
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
