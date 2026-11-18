import type * as fs from 'fs';

/**
 * Позиционная запись всего буфера: `FileHandle.write` вправе записать меньше запрошенного, и
 * одиночный вызов тогда оставил бы в файле дыру из нулей — архив с такой дырой не распознать.
 */
export async function writeFully(
  handle: fs.promises.FileHandle,
  data: Uint8Array,
  length: number,
  position: number
): Promise<void> {
  let done = 0;
  while (done < length) {
    const { bytesWritten } = await handle.write(data, done, length - done, position + done);
    // Ноль байт без ошибки на исправной ФС не возникает; без границы цикл стал бы бесконечным.
    /* c8 ignore start */
    if (bytesWritten === 0) {
      throw new Error('запись в файл не продвигается (записано 0 байт)');
    }
    /* c8 ignore stop */
    done += bytesWritten;
  }
}
