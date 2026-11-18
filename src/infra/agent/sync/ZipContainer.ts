/**
 * Структура контейнера zip: заголовки, центральный каталог, zip64. Сжатие и проверки содержимого —
 * в ArchiveCodec; здесь только раскладка байтов.
 *
 * zip64 обязателен на чтение и на запись: выгрузка реальной конфигурации — больше 65 535 файлов
 * (корпус example/2.20 — 104 238), а 16-битный счётчик записей обычного zip на ней переполняется.
 * Пишется zip64 только когда без него нельзя, иначе — обычный формат.
 */

export class ArchiveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveFormatError';
  }
}

/** Запись центрального каталога после разбора (размеры и смещение — уже с учётом zip64). */
export interface ZipCentralRecord {
  readonly nameBytes: Buffer;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

/** Готовая к записи запись: данные уже сжаты (или нет) вызывающим. */
export interface ZipWriteRecord {
  readonly nameBytes: Buffer;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly size: number;
  readonly payload: Uint8Array;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const END64_SIGNATURE = 0x06064b50;
const LOCATOR64_SIGNATURE = 0x07064b50;
const END_RECORD_SIZE = 22;
const END64_RECORD_SIZE = 56;
const LOCATOR64_SIZE = 20;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const MAX_COMMENT = 0xffff;
const ZIP64_EXTRA_ID = 0x0001;
const MARKER32 = 0xffffffff;
const MARKER16 = 0xffff;
/** Дата DOS 1980-01-01: архив детерминирован, а время записей агент не использует. */
const DOS_DATE = 0x21;
const VERSION = 20;
const VERSION_ZIP64 = 45;

// --- чтение ------------------------------------------------------------------------------

export function readCentralRecords(buffer: Buffer): ZipCentralRecord[] {
  const directory = locateCentralDirectory(buffer);
  const records: ZipCentralRecord[] = [];
  let cursor = directory.offset;
  const end = directory.offset + directory.size;
  for (let index = 0; index < directory.count; index += 1) {
    if (cursor + CENTRAL_HEADER_SIZE > end || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ArchiveFormatError(`Повреждённый zip: запись центрального каталога №${String(index + 1)}.`);
    }
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const nameBytes = buffer.subarray(cursor + CENTRAL_HEADER_SIZE, cursor + CENTRAL_HEADER_SIZE + nameLength);
    const extra = buffer.subarray(cursor + CENTRAL_HEADER_SIZE + nameLength, cursor + CENTRAL_HEADER_SIZE + nameLength + extraLength);
    const wide = readZip64Fields(extra, {
      size: buffer.readUInt32LE(cursor + 24),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      localOffset: buffer.readUInt32LE(cursor + 42),
    }, index);
    records.push({
      nameBytes,
      flags: buffer.readUInt16LE(cursor + 8),
      method: buffer.readUInt16LE(cursor + 10),
      crc: buffer.readUInt32LE(cursor + 16),
      ...wide,
    });
    cursor += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
  }
  // Заявленный счётчик и фактический размер каталога обязаны сойтись: иначе (усечённый 16-битный
  // счётчик, zip64 без локатора) прочиталась бы часть записей, и импорт удалил бы из проекта
  // «отсутствующие» файлы.
  if (cursor !== end) {
    throw new ArchiveFormatError(
      `Повреждённый zip: центральный каталог прочитан не целиком (записей ${String(directory.count)}, ` +
      `прочитано ${String(cursor - directory.offset)} из ${String(directory.size)} байт).`
    );
  }
  return records;
}

/** Начало данных записи: локальный заголовок может нести свои name/extra, отличные от центральных. */
export function localDataStart(buffer: Buffer, record: ZipCentralRecord, name: string): number {
  const { localOffset, compressedSize } = record;
  if (localOffset + LOCAL_HEADER_SIZE > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
    throw new ArchiveFormatError(`Повреждённый zip: локальный заголовок записи "${name}".`);
  }
  const start = localOffset + LOCAL_HEADER_SIZE + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
  if (start + compressedSize > buffer.length) {
    throw new ArchiveFormatError(`Повреждённый zip: данные записи "${name}" за пределами архива.`);
  }
  return start;
}

interface DirectoryLocation {
  readonly count: number;
  readonly size: number;
  readonly offset: number;
}

function locateCentralDirectory(buffer: Buffer): DirectoryLocation {
  const end = findEndRecord(buffer);
  const locator = end - LOCATOR64_SIZE;
  let location: DirectoryLocation;
  let limit: number;
  if (locator >= 0 && buffer.readUInt32LE(locator) === LOCATOR64_SIGNATURE) {
    const end64 = readUInt64(buffer, locator + 8, 'смещение записи конца каталога zip64');
    if (end64 + END64_RECORD_SIZE > locator || buffer.readUInt32LE(end64) !== END64_SIGNATURE) {
      throw new ArchiveFormatError('Повреждённый zip: запись конца центрального каталога zip64.');
    }
    location = {
      count: readUInt64(buffer, end64 + 32, 'число записей'),
      size: readUInt64(buffer, end64 + 40, 'размер центрального каталога'),
      offset: readUInt64(buffer, end64 + 48, 'смещение центрального каталога'),
    };
    limit = end64;
  } else {
    location = {
      count: buffer.readUInt16LE(end + 10),
      size: buffer.readUInt32LE(end + 12),
      offset: buffer.readUInt32LE(end + 16),
    };
    if (location.count === MARKER16 || location.size === MARKER32 || location.offset === MARKER32) {
      throw new ArchiveFormatError('Повреждённый zip: поля zip64 без записи конца каталога zip64.');
    }
    limit = end;
  }
  if (location.offset + location.size > limit) {
    throw new ArchiveFormatError('Повреждённый zip: центральный каталог вне архива.');
  }
  return location;
}

function findEndRecord(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - END_RECORD_SIZE - MAX_COMMENT);
  for (let at = buffer.length - END_RECORD_SIZE; at >= lowest; at -= 1) {
    if (buffer.readUInt32LE(at) === END_SIGNATURE) {
      return at;
    }
  }
  throw new ArchiveFormatError('Не zip-архив: нет записи конца центрального каталога.');
}

/**
 * Поля, равные 0xFFFFFFFF, берутся из extra 0x0001 в порядке спецификации: размер, сжатый размер,
 * смещение локального заголовка (только присутствующие).
 */
function readZip64Fields(
  extra: Buffer,
  narrow: { size: number; compressedSize: number; localOffset: number },
  index: number
): { size: number; compressedSize: number; localOffset: number } {
  const order = ['size', 'compressedSize', 'localOffset'] as const;
  const wanted = order.filter((field) => narrow[field] === MARKER32);
  if (wanted.length === 0) {
    return narrow;
  }
  const result = { ...narrow };
  for (let at = 0; at + 4 <= extra.length;) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (id === ZIP64_EXTRA_ID && length >= wanted.length * 8 && at + 4 + length <= extra.length) {
      wanted.forEach((field, position) => {
        result[field] = readUInt64(extra, at + 4 + position * 8, 'поле zip64 записи');
      });
      return result;
    }
    at += 4 + length;
  }
  throw new ArchiveFormatError(`Повреждённый zip: у записи №${String(index + 1)} нет поля zip64 для размеров/смещения.`);
}

function readUInt64(buffer: Buffer, at: number, what: string): number {
  const value = buffer.readBigUInt64LE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArchiveFormatError(`Повреждённый zip: ${what} вне допустимого диапазона.`);
  }
  return Number(value);
}

// --- запись ------------------------------------------------------------------------------

/**
 * Архив из подготовленных записей. Отдельные записи и смещения больше 4 ГБ не поддерживаются:
 * архив целиком собирается в памяти, и такой размер упрётся в память раньше, чем в формат.
 */
export function writeZip(records: readonly ZipWriteRecord[]): Buffer {
  const localParts: Uint8Array[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const record of records) {
    const local = Buffer.alloc(LOCAL_HEADER_SIZE);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(record.flags, 6);
    local.writeUInt16LE(record.method, 8);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(record.crc, 14);
    local.writeUInt32LE(record.payload.length, 18);
    local.writeUInt32LE(record.size, 22);
    local.writeUInt16LE(record.nameBytes.length, 26);
    localParts.push(local, record.nameBytes, record.payload);

    const central = Buffer.alloc(CENTRAL_HEADER_SIZE);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(record.flags, 8);
    central.writeUInt16LE(record.method, 10);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(record.crc, 16);
    central.writeUInt32LE(record.payload.length, 20);
    central.writeUInt32LE(record.size, 24);
    central.writeUInt16LE(record.nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, record.nameBytes);

    offset += LOCAL_HEADER_SIZE + record.nameBytes.length + record.payload.length;
    assertBelow4GiB(offset);
  }
  const centralDirectory = Buffer.concat(centralParts);
  assertBelow4GiB(offset + centralDirectory.length);
  const tail = records.length > MARKER16 - 1
    ? [writeEnd64(records.length, centralDirectory.length, offset), writeEnd(MARKER16, centralDirectory.length, offset)]
    : [writeEnd(records.length, centralDirectory.length, offset)];
  return Buffer.concat([...localParts, centralDirectory, ...tail]);
}

function writeEnd(count: number, centralSize: number, centralOffset: number): Buffer {
  const end = Buffer.alloc(END_RECORD_SIZE);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return end;
}

/** Запись конца каталога zip64 и её локатор; счётчик в обычной записи конца — 0xFFFF. */
function writeEnd64(count: number, centralSize: number, centralOffset: number): Buffer {
  const end64Offset = centralOffset + centralSize;
  const record = Buffer.alloc(END64_RECORD_SIZE + LOCATOR64_SIZE);
  record.writeUInt32LE(END64_SIGNATURE, 0);
  record.writeBigUInt64LE(BigInt(END64_RECORD_SIZE - 12), 4);
  record.writeUInt16LE(VERSION_ZIP64, 12);
  record.writeUInt16LE(VERSION_ZIP64, 14);
  record.writeBigUInt64LE(BigInt(count), 24);
  record.writeBigUInt64LE(BigInt(count), 32);
  record.writeBigUInt64LE(BigInt(centralSize), 40);
  record.writeBigUInt64LE(BigInt(centralOffset), 48);
  record.writeUInt32LE(LOCATOR64_SIGNATURE, END64_RECORD_SIZE);
  record.writeBigUInt64LE(BigInt(end64Offset), END64_RECORD_SIZE + 8);
  record.writeUInt32LE(1, END64_RECORD_SIZE + 16);
  return record;
}

/* c8 ignore start -- честная проверка требует архива больше 4 ГБ в памяти теста; граница нужна,
   чтобы смещения не переполнили 32-битные поля заголовков молча. */
function assertBelow4GiB(position: number): void {
  if (position > MARKER32) {
    throw new ArchiveFormatError('Архив больше 4 ГБ не поддерживается.');
  }
}
/* c8 ignore stop */

// --- CRC32 -------------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC32 zip: fflate его не экспортирует. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
