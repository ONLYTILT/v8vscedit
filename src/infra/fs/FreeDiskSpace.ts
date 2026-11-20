import * as fs from 'fs';

/**
 * Свободное место тома, на котором лежит каталог, в байтах; `undefined` — узнать нельзя (нет `fs.statfs` в
 * этой версии Node или отказ ФС). Неизвестность — не запрет: проверку места тогда пропускают, а не роняют
 * операцию.
 */
export async function freeDiskSpaceOf(dir: string): Promise<number | undefined> {
  /* c8 ignore next 3 -- statfs есть с Node 18.15; ветка для старого Extension Host, в тестовом Electron недостижима. */
  if (typeof fs.promises.statfs !== 'function') {
    return undefined;
  }
  try {
    const stats = await fs.promises.statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return undefined;
  }
}
