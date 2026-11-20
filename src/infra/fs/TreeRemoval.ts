import * as fs from 'fs';
import * as path from 'path';

/**
 * Рекурсивное удаление файла или каталога обходом `unlink`/`rmdir`. `fs.rmSync` на Windows с системным
 * Node 24 молча не удаляет файл с кириллицей в имени (запрет №19), а имена выгрузки 1С (каталоги расширений,
 * файлы объектов) кириллические. Отсутствующий путь — не ошибка; ссылка удаляется сама, без обхода цели.
 */
export function removeTreeSync(target: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(target);
  } catch {
    return;
  }
  if (!stats.isDirectory()) {
    fs.unlinkSync(target);
    return;
  }
  for (const name of fs.readdirSync(target)) {
    removeTreeSync(path.join(target, name));
  }
  fs.rmdirSync(target);
}
