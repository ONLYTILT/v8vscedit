import * as fs from 'fs';

/** Порция сравнения: два буфера по 1 МиБ — память O(порция) при файлах в гигабайт. */
const DEFAULT_CHUNK_BYTES = 1024 * 1024;

/**
 * Побайтное сравнение двух файлов порциями из двух дескрипторов (plan-large-files.md §2.4): файл размером с
 * гигабайт нельзя читать целиком (`Array buffer allocation failed`), а прямое сравнение дешевле двух SHA-1.
 * Разные размеры решают без чтения содержимого.
 *
 * Любой отказ (файла нет, нет доступа, ошибка чтения) — «не совпадает»: вызывающий тогда скачивает или
 * записывает файл заново, то есть ошибка уходит в сторону лишней работы, а не пропуска изменения.
 */
export async function filesHaveSameContent(a: string, b: string, chunkBytes = DEFAULT_CHUNK_BYTES): Promise<boolean> {
  let first: fs.promises.FileHandle | undefined;
  let second: fs.promises.FileHandle | undefined;
  try {
    first = await fs.promises.open(a, 'r');
    second = await fs.promises.open(b, 'r');
    const [statA, statB] = await Promise.all([first.stat(), second.stat()]);
    if (statA.size !== statB.size) {
      return false;
    }
    const bufferA = Buffer.alloc(Math.min(chunkBytes, statA.size));
    const bufferB = Buffer.alloc(bufferA.length);
    for (let position = 0; position < statA.size; position += bufferA.length) {
      const length = Math.min(bufferA.length, statA.size - position);
      const [readA, readB] = await Promise.all([
        first.read(bufferA, 0, length, position),
        second.read(bufferB, 0, length, position),
      ]);
      /* c8 ignore start -- короткое чтение обычного файла бывает только при его усечении во время сравнения:
         детерминированно в тесте не воспроизвести, а исход «не совпадает» тот же, что у любого отказа. */
      if (readA.bytesRead !== length || readB.bytesRead !== length) {
        return false;
      }
      /* c8 ignore stop */
      if (!bufferA.subarray(0, length).equals(bufferB.subarray(0, length))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    await first?.close();
    await second?.close();
  }
}
