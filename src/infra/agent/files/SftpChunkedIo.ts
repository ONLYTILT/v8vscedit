import type * as fs from 'fs';
import { AgentTransferCancelledError, type AgentTransferCancellation } from './AgentFileTransfer';

/**
 * Порционный обмен SFTP-хранилища агента: размер порции, окно конвейера и источники данных записи.
 * Вынесено из `SftpAgentFileStore`, чтобы буферная (`writeFile`/`readFile`) и потоковая
 * (`uploadFromFile`/`downloadToFile`) передача шли одним механизмом и не расходились в деталях.
 */

/**
 * Порция одного запроса READ/WRITE: укладывается в один пакет SFTP у любого сервера. ssh2 у сервера
 * не-OpenSSH (агент конфигуратора — такой) режет данные запроса по 34 000 − 2 048 = 31 952 байта:
 * порция в 32 КБ уходила бы двумя запросами, и в полёте оказывалось бы вдвое больше окна.
 */
export const IO_CHUNK = 31 * 1024;
/**
 * Порций одного файла в полёте одновременно (Н32). Последовательный обмен упирается в задержку:
 * при 80 мс это ≈400 КБ/с, и архив выгрузки так не передать; окно в 16 порций снимает это
 * ограничение (тот же приём, что у `fastGet`/`fastPut` ssh2), не переполняя очередь сервера.
 */
export const IO_WINDOW = 16;

/** Данные для записи с произвольным доступом: буфер в памяти или локальный файл. */
export interface ChunkSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

export function bufferChunkSource(buffer: Buffer): ChunkSource {
  return { size: buffer.length, read: (offset, length) => Promise.resolve(buffer.subarray(offset, offset + length)) };
}

/**
 * Локальный файл как источник: каждая порция читается позиционно в свой буфер, поэтому порции
 * окна независимы, а в памяти держится не больше окна.
 */
export function fileChunkSource(handle: fs.promises.FileHandle, size: number): ChunkSource {
  return {
    size,
    read: async (offset, length) => {
      const buffer = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await handle.read(buffer, done, length - done, offset + done);
        // источник — локальный архив операции, который никто, кроме движка, не
        // пишет; укоротить его посреди передачи детерминированно в тесте нечем. Граница защищает от
        // молчаливой записи нулей вместо данных.
        /* c8 ignore start */
        if (bytesRead === 0) {
          throw new Error('локальный файл изменился во время чтения (EOF раньше размера)');
        }
        /* c8 ignore stop */
        done += bytesRead;
      }
      return buffer;
    },
  };
}

/**
 * Задачи `0…count-1`, не более `window` одновременно. После первого отказа или отмены новые не
 * стартуют, но уже начатые дожидаются: дескриптор файла закрывается только когда по нему не
 * осталось запросов.
 */
export async function runWindowed(
  count: number,
  window: number,
  run: (index: number) => Promise<unknown>,
  cancellation?: AgentTransferCancellation
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (next < count && failure === undefined) {
      if (cancellation?.isCancellationRequested) {
        failure = { error: new AgentTransferCancelledError() };
        return;
      }
      const index = next;
      next += 1;
      try {
        await run(index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(window, count) }, worker));
  if (failure !== undefined) {
    throw failure.error;
  }
}

/** Один SFTP READ: в `target` с `targetOffset` до `length` байт файла с позиции `position`; 0 — EOF. */
export type SftpReadCall = (target: Buffer, targetOffset: number, length: number, position: number) => Promise<number>;

/**
 * Читает до `length` байт файла с позиции `position` в `target` с `targetOffset`; сервер вправе
 * ответить короче запрошенного, тогда остаток дочитывается. Меньше `length` — только при EOF.
 */
export async function readRange(
  read: SftpReadCall,
  target: Buffer,
  targetOffset: number,
  position: number,
  length: number
): Promise<number> {
  let done = 0;
  while (done < length) {
    const count = await read(target, targetOffset + done, length - done, position + done);
    // ssh2 отдаёт EOF как прочитанные 0 байт.
    if (count === 0) {
      break;
    }
    done += count;
  }
  return done;
}

export const CHANGED_DURING_READ = 'файл изменился во время чтения (EOF раньше размера из FSTAT)';
