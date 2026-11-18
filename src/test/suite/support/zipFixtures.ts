/**
 * Независимый от production-кода писатель и читатель zip для тестов Э7.
 *
 * Зачем свой, а не fflate: ArchiveCodec проверяется на архивах, собранных НЕ им же (иначе
 * общая ошибка в разборе флагов/кодировки имён не поймалась бы), а эмулятор агента 1С обязан
 * отдавать архив так, как его отдаёт платформа (факт пилота §5b п.7: zip, deflate, бит 11
 * выставлен). Только stdlib: zlib + собственный CRC32.
 */
import * as zlib from 'zlib';

export interface ZipFixtureEntry {
  /** Имя записи: строка (кодируется в UTF-8) либо готовые байты (например, cp866). */
  readonly name: string | Buffer;
  readonly data: Buffer;
  /** Флаг «имя в UTF-8» (бит 11). По умолчанию — выставлен, как у архивов платформы. */
  readonly utf8Flag?: boolean;
  /** 8 — deflate (по умолчанию), 0 — без сжатия. */
  readonly method?: 0 | 8;
}

export interface ReadZipEntry {
  readonly nameBytes: Buffer;
  readonly flags: number;
  readonly method: number;
  readonly data: Buffer;
}

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

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipFixtureOptions {
  /**
   * zip64 «по максимуму», как его пишут архиваторы с принудительным zip64: у КАЖДОЙ записи размеры и
   * смещение в заголовках — 0xFFFFFFFF, настоящие значения — в extra 0x0001 (перед ним — посторонний
   * extra 0x5455, чтобы читатель умел его пропускать); в конце — запись конца каталога zip64, локатор
   * и обычная запись конца со счётчиком 0xFFFF.
   */
  readonly zip64?: boolean;
  /**
   * Комментарий архива (в записи конца каталога): до 65 535 байт. С максимальным комментарием запись
   * конца zip64 оказывается ВНЕ окна хвоста, которое читает файловый источник (22 + 65 535 + 20).
   */
  readonly comment?: Buffer;
}

/** Посторонний extra (метка времени 0x5455): читатель обязан его пропускать. */
const TIMESTAMP_EXTRA = Buffer.from([0x55, 0x54, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);

function u64(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

export function buildZip(entries: readonly ZipFixtureEntry[], options: ZipFixtureOptions = {}): Buffer {
  const zip64 = options.zip64 === true;
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = typeof entry.name === 'string' ? Buffer.from(entry.name, 'utf-8') : entry.name;
    const method = entry.method ?? 8;
    const flags = (entry.utf8Flag ?? true) ? 0x0800 : 0;
    const payload = method === 8 ? zlib.deflateRawSync(entry.data) : entry.data;
    const crc = crc32(entry.data);

    const localExtra = zip64
      ? Buffer.concat([Buffer.from([0x01, 0x00, 0x10, 0x00]), u64(entry.data.length), u64(payload.length)])
      : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // время
    local.writeUInt16LE(0x21, 12); // дата 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(zip64 ? 0xffffffff : payload.length, 18);
    local.writeUInt32LE(zip64 ? 0xffffffff : entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    localParts.push(local, nameBytes, localExtra, payload);

    const centralExtra = zip64
      ? Buffer.concat([TIMESTAMP_EXTRA, Buffer.from([0x01, 0x00, 0x18, 0x00]), u64(entry.data.length), u64(payload.length), u64(offset)])
      : Buffer.alloc(0);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(zip64 ? 45 : 20, 4);
    central.writeUInt16LE(zip64 ? 45 : 20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(zip64 ? 0xffffffff : payload.length, 20);
    central.writeUInt32LE(zip64 ? 0xffffffff : entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    centralParts.push(central, nameBytes, centralExtra);

    offset += local.length + nameBytes.length + localExtra.length + payload.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const comment = options.comment ?? Buffer.alloc(0);
  const end = Buffer.alloc(22 + comment.length);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(comment.length, 20);
  comment.copy(end, 22);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : centralDirectory.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  if (!zip64) {
    return Buffer.concat([...localParts, centralDirectory, end]);
  }
  const end64 = Buffer.alloc(56);
  end64.writeUInt32LE(0x06064b50, 0);
  end64.writeBigUInt64LE(44n, 4);
  end64.writeUInt16LE(45, 12);
  end64.writeUInt16LE(45, 14);
  end64.writeBigUInt64LE(BigInt(entries.length), 24);
  end64.writeBigUInt64LE(BigInt(entries.length), 32);
  end64.writeBigUInt64LE(BigInt(centralDirectory.length), 40);
  end64.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + centralDirectory.length), 8);
  locator.writeUInt32LE(1, 16);
  return Buffer.concat([...localParts, centralDirectory, end64, locator, end]);
}

/** Читает записи zip по центральному каталогу; контрольные суммы проверяются. */
export function readZip(zip: Uint8Array): ReadZipEntry[] {
  const buffer = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) {
    end -= 1;
  }
  if (end < 0) {
    throw new Error('zip: нет записи конца центрального каталога');
  }
  let count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  // zip64: локатор прямо перед записью конца указывает на запись конца каталога zip64.
  if (end >= 20 && buffer.readUInt32LE(end - 20) === 0x07064b50) {
    const end64 = Number(buffer.readBigUInt64LE(end - 12));
    count = Number(buffer.readBigUInt64LE(end64 + 32));
    cursor = Number(buffer.readBigUInt64LE(end64 + 48));
  }
  const result: ReadZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    let compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    let localOffset = buffer.readUInt32LE(cursor + 42);
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    // zip64 «по максимуму» (buildZip({ zip64: true })): настоящие размеры и смещение — в extra 0x0001
    // (порядок: размер, сжатый размер, смещение — только поля с маркером 0xFFFFFFFF).
    const extra = buffer.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
    for (let at = 0; at + 4 <= extra.length; at += 4 + extra.readUInt16LE(at + 2)) {
      if (extra.readUInt16LE(at) !== 0x0001) {
        continue;
      }
      let field = at + 4;
      if (buffer.readUInt32LE(cursor + 24) === 0xffffffff) {
        field += 8;
      }
      if (compressedSize === 0xffffffff) {
        compressedSize = Number(extra.readBigUInt64LE(field));
        field += 8;
      }
      if (localOffset === 0xffffffff) {
        localOffset = Number(extra.readBigUInt64LE(field));
      }
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(payload) : Buffer.from(payload);
    if (crc32(data) !== crc) {
      throw new Error(`zip: неверный CRC32 записи ${nameBytes.toString('utf-8')}`);
    }
    result.push({ nameBytes: Buffer.from(nameBytes), flags, method, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

/** Имена записей, прочитанные как UTF-8 (для архивов с флагом UTF-8). */
export function readZipAsMap(zip: Uint8Array): Map<string, Buffer> {
  return new Map(readZip(zip).map((entry) => [entry.nameBytes.toString('utf-8'), entry.data]));
}

/** Детерминированные «случайные» байты. */
export function patternBytes(length: number, seed = 123456789): Buffer {
  const buffer = Buffer.alloc(length);
  let state = seed;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    buffer[i] = state >>> 24;
  }
  return buffer;
}
