import * as fs from 'fs';
import * as path from 'path';

/**
 * Локальный каталог обмена операции (`<root>/<operationId>`): здесь лежит архив выгрузки на этой
 * машине, пока движок его читает или закачивает. Корень по умолчанию —
 * `<projectRoot>/.v8vscedit/agent-exchange`: тот же диск, что у проекта, и `.zip` не попадает под
 * watcher `src/**\/*.xml`.
 *
 * Удаление — свой обход `unlink`/`rmdir`, а не `fs.rmSync` (запрет №19: на Windows `rmSync` молча
 * не удаляет файлы с кириллицей). Ошибки уборки проглатываются: остаток безвреден и будет убран
 * `pruneStaleLocalExchanges` на старте следующей операции той же цели.
 */
export interface LocalExchange {
  /** Путь файла в каталоге операции; каталог создаётся при первом вызове, сам файл — нет. */
  file(name: string): Promise<string>;
  dispose(): Promise<void>;
}

export function createLocalExchange(root: string, operationId: string): LocalExchange {
  const dir = path.join(root, operationId);
  let created: Promise<void> | undefined;
  return {
    file: async (name) => {
      created ??= fs.promises.mkdir(dir, { recursive: true }).then(() => undefined);
      await created;
      return path.join(dir, name);
    },
    dispose: async () => {
      if (created === undefined) {
        return;
      }
      await removeTreeQuietly(dir);
    },
  };
}

/**
 * Остатки операций той же цели (каталоги `<operationPrefix><число>`, кроме `keep`), оставшиеся после
 * аварийного завершения процесса: на штатных путях каталог убирает `dispose`. Хвост — только цифры:
 * префикс расширения «X» (`cfe-X-`) иначе совпал бы с каталогами расширения «X-Y» (`cfe-X-Y-…`).
 */
export async function pruneStaleLocalExchanges(root: string, operationPrefix: string, keep: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (name !== keep && name.startsWith(operationPrefix) && /^\d+$/.test(name.slice(operationPrefix.length))) {
      await removeTreeQuietly(path.join(root, name));
    }
  }
}

async function removeTreeQuietly(dir: string): Promise<void> {
  try {
    await removeTree(dir);
  } catch {
    // уборка не должна заслонять результат операции
  }
}

async function removeTree(dir: string): Promise<void> {
  for (const dirent of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      await removeTree(abs);
    } else {
      await fs.promises.unlink(abs);
    }
  }
  await fs.promises.rmdir(dir);
}
