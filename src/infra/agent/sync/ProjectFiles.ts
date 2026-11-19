import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../../fs/AtomicFileWriter';

/**
 * Запись результата синхронизации в выгрузку проекта P. Единая точка для всех стратегий импорта
 * (полное сравнение, дельта, архив), чтобы инварианты Э5 держались в одном месте:
 *  - хук `onWillChange` открывает у вызывающего окно подавления reload, отсчитываемое от момента
 *    вызова (`Container.suppressConfigurationReloadForFiles`); запись может идти дольше окна, поэтому
 *    хук зовётся до первой записи, непосредственно перед Configuration.xml и после последней записи;
 *  - Configuration.xml пишется последним: его событие watcher перезагружает всё дерево;
 *  - файлы пишутся только через writeFileAtomic — обрыв не оставляет обрезанный XML.
 */

export const CONFIGURATION_XML = 'Configuration.xml';
export const CONFIG_DUMP_INFO_XML = 'ConfigDumpInfo.xml';

/** Отдаёт содержимое перечисленных файлов (в любом порядке, каждый ровно один раз). */
export type ProjectDataReader = (
  rels: readonly string[],
  sink: (rel: string, data: Uint8Array) => void | Promise<void>
) => Promise<unknown>;

export interface ProjectChanges {
  readonly projectDir: string;
  readonly writes: readonly string[];
  readonly deletes: readonly string[];
  readonly read: ProjectDataReader;
  readonly onWillChange?: (filePaths: string[]) => void;
}

/** Применяет изменения к P и возвращает абсолютные пути изменённых, новых и удалённых файлов. */
export async function applyProjectChanges(changes: ProjectChanges): Promise<string[]> {
  const { projectDir, writes, deletes } = changes;
  const changedProjectFiles = [...new Set([...writes, ...deletes])]
    .sort()
    .map((rel) => toProjectPath(projectDir, rel));
  if (changedProjectFiles.length === 0) {
    return changedProjectFiles;
  }
  changes.onWillChange?.(changedProjectFiles);

  for (const rel of deletes) {
    const target = toProjectPath(projectDir, rel);
    // unlink, а не fs.rmSync: на Windows rmSync системного Node 24 молча не удаляет файл с
    // кириллицей в имени (проверено 2026-11-17).
    fs.unlinkSync(target);
    pruneEmptyParents(projectDir, path.dirname(target));
  }

  let configuration: Uint8Array | undefined;
  await changes.read(writes, (rel, data) => {
    if (rel === CONFIGURATION_XML) {
      configuration = data;
      return;
    }
    writeProjectFile(projectDir, rel, data);
  });
  if (configuration !== undefined) {
    changes.onWillChange?.(changedProjectFiles);
    writeProjectFile(projectDir, CONFIGURATION_XML, configuration);
  }
  changes.onWillChange?.(changedProjectFiles);
  return changedProjectFiles;
}

/** Результат без Configuration.xml стёр бы корень конфигурации: это сбой выгрузки, а не «база пуста». */
export function assertConfigurationPresent(present: boolean, source: string): void {
  if (!present) {
    throw new Error(`Агент не выгрузил конфигурацию: в ${source} нет ${CONFIGURATION_XML}. Проект не изменён.`);
  }
}

/** Относительные POSIX-пути всех файлов каталога (рекурсивно); отсутствующий каталог — пуст. */
export function listProjectFiles(rootDir: string, relDir = ''): string[] {
  const result: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), childRel);
      } else {
        result.push(childRel);
      }
    }
  };
  const start = toProjectPath(rootDir, relDir);
  if (fs.existsSync(start)) {
    walk(start, relDir);
  }
  return result;
}

export function projectFileExists(projectDir: string, rel: string): boolean {
  return fs.existsSync(toProjectPath(projectDir, rel));
}

/** Совпадает ли файл проекта с данными; отсутствующий файл — не совпадает. */
export function hasSameProjectContent(projectDir: string, rel: string, data: Uint8Array): boolean {
  try {
    return fs.readFileSync(toProjectPath(projectDir, rel)).equals(data);
  } catch {
    return false;
  }
}

export function toProjectPath(projectDir: string, rel: string): string {
  return path.join(projectDir, ...rel.split('/').filter((segment) => segment !== ''));
}

function writeProjectFile(projectDir: string, rel: string, data: Uint8Array): void {
  const target = toProjectPath(projectDir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeFileAtomic(target, data);
}

/** Убирает каталоги, опустевшие после удаления файлов, — как прежнее зеркалирование каталогом целиком. */
function pruneEmptyParents(rootDir: string, startDir: string): void {
  // Сравнение нормализованных путей: с хвостовым или «чужим» слэшем в rootDir равенство
  // не наступило бы, и цикл ушёл бы выше корня проекта.
  const root = path.resolve(rootDir);
  let dir = path.resolve(startDir);
  while (dir !== root && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}
