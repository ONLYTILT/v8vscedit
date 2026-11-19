import * as fs from 'fs';
import * as path from 'path';

/**
 * Удаление временного дерева тестов своим обходом `unlink`/`rmdir`, а не `fs.rmSync`.
 *
 * Почему не `rmSync`: на Windows с Node 24 (в т.ч. в Extension Host тестового
 * VS Code) `rmSync` не удаляет файлы с кириллицей в имени (CLAUDE.md, запрет №19),
 * и уборка репозитория с такими файлами падает `EPERM` на непустом каталоге —
 * воспроизводится в скрытом прогоне под SYSTEM. Git дополнительно помечает
 * объекты в `.git/objects` атрибутом «только чтение», на котором `unlink` в
 * Windows тоже даёт `EPERM`, — поэтому перед повтором атрибут снимается.
 *
 * Отсутствующий путь — не ошибка: уборка вызывается и после частично
 * выполненного `setup`.
 */
export function removeTreeSync(target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) {
      removeTreeSync(path.join(target, name));
    }
    withWritableRetry(target, () => fs.rmdirSync(target));
    return;
  }
  withWritableRetry(target, () => fs.unlinkSync(target));
}

function withWritableRetry(target: string, remove: () => void): void {
  try {
    remove();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
      throw error;
    }
    fs.chmodSync(target, 0o666);
    remove();
  }
}
