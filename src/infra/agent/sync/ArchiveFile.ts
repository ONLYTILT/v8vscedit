import * as fs from 'fs';
import { writeFully } from '../../fs/FileHandleWrite';
import { ArchiveFormatError, ZipStreamWriter, assertWithinSource, type ZipByteSource } from './ZipContainer';

/**
 * Архив обмена с агентом на локальном диске: источник чтения с произвольным доступом и потоковая
 * запись. Отдельно от `ZipContainer`, чтобы раскладка байтов zip не зависела от `fs`.
 */

export interface FileByteSource extends ZipByteSource {
  /** Время изменения файла на момент открытия. */
  readonly mtimeMs: number;
  close(): Promise<void>;
}

/**
 * Каждое чтение сверяет размер и время изменения файла с моментом открытия: архив читается дважды
 * (`scan`, затем `read` изменённых), и подмена файла между проходами отдала бы в проект данные,
 * не прошедшие валидацию. `fstat` на чтение дешевле любой порции данных.
 */
export async function openFileByteSource(filePath: string): Promise<FileByteSource> {
  const handle = await fs.promises.open(filePath, 'r');
  let opened: fs.Stats;
  try {
    opened = await handle.stat();
  // fstat только что открытого дескриптора не отказывает на исправной ФС; ветка нужна, чтобы
  // дескриптор не утёк.
  /* c8 ignore start */
  } catch (error) {
    await handle.close();
    throw error;
  }
  /* c8 ignore stop */
  const { size, mtimeMs } = opened;
  return {
    size,
    mtimeMs,
    read: async (offset, length) => {
      assertWithinSource(offset, length, size);
      const now = await handle.stat();
      if (now.size !== size || now.mtimeMs !== mtimeMs) {
        throw new ArchiveFormatError(`Файл архива "${filePath}" изменился после открытия.`);
      }
      const buffer = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await handle.read(buffer, done, length - done, offset + done);
        // размер сверен fstat перед чтением; EOF раньше возможен только при
        // гонке с чужой записью между fstat и read.
        /* c8 ignore start */
        if (bytesRead === 0) {
          throw new ArchiveFormatError(`Файл архива "${filePath}" изменился во время чтения.`);
        }
        /* c8 ignore stop */
        done += bytesRead;
      }
      return buffer;
    },
    close: () => handle.close(),
  };
}

// отказ удаления только что созданного своего файла детерминированно не
// воспроизвести; исходная причина отказа важнее.
/* c8 ignore start */
const ignoreCleanupFailure = (): void => undefined;
/* c8 ignore stop */

/**
 * Архив пишется прямо в новый файл (`wx`: чужой файл не затирается); при любом отказе сборки
 * недописанный файл удаляется — архив с дырой не должен уйти в загрузку.
 */
export async function writeZipToFile(filePath: string, build: (writer: ZipStreamWriter) => Promise<void>): Promise<void> {
  const handle = await fs.promises.open(filePath, 'wx');
  try {
    let position = 0;
    const writer = new ZipStreamWriter({
      write: async (chunk) => {
        await writeFully(handle, chunk, chunk.length, position);
        position += chunk.length;
      },
    });
    await build(writer);
    await writer.finish();
  } catch (error) {
    await handle.close();
    await fs.promises.unlink(filePath).catch(ignoreCleanupFailure);
    throw error;
  }
  await handle.close();
}
