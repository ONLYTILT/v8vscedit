import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../fs/AtomicFileWriter';
import type { AgentFileStore } from './files/AgentFileStore';
import { downloadFiles, uploadFiles } from './files/AgentFileTransfer';

/**
 * Полное зеркалирование между проектом P (локальный каталог выгрузки) и серверным зеркалом M
 * (каталог цели в персональном корне агента, доступный только через {@link AgentFileStore}).
 *
 * Алгоритм намеренно не знает, локальное хранилище или удалённое: в Э6 рядом появится
 * SFTP-реализация, а в Э7 полное зеркалирование заменит дельта-движок синхронизации.
 */

const CONFIGURATION_XML = 'Configuration.xml';

/** В M уже лежит каркас выгрузки (без него частичная загрузка конфигуратором невозможна). */
export async function hasAgentConfigurationDump(store: AgentFileStore, targetAgentDir: string): Promise<boolean> {
  return (await store.stat(`${targetAgentDir}/${CONFIGURATION_XML}`))?.type === 'file';
}

/**
 * P → M целиком: лишнее в M удаляется, все файлы P записываются. Содержимое не сравнивается —
 * так же вёл себя прежний локальный `mirrorDirectorySnapshot`.
 */
export async function mirrorProjectToAgent(store: AgentFileStore, sourceDir: string, targetAgentDir: string): Promise<void> {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Каталог источника не найден: ${sourceDir}`);
  }
  const localFiles = listLocalFiles(sourceDir);
  const keepFiles = new Set(localFiles);
  const keepDirs = collectAncestorDirs(localFiles);

  await store.mkdirp(targetAgentDir);
  for (const entry of await store.list(targetAgentDir, { recursive: true })) {
    const rel = entry.path.slice(targetAgentDir.length + 1);
    const keep = entry.type === 'dir' ? keepDirs.has(rel) : keepFiles.has(rel);
    if (!keep) {
      // Потомки уже удалённого каталога идут в листинге следом; их удаление — no-op по контракту.
      await store.remove(entry.path, { recursive: true });
    }
  }
  await uploadProjectFiles(store, sourceDir, targetAgentDir, localFiles);
}

/** Записывает выбранные файлы P в M (частичная загрузка). */
export async function uploadProjectFiles(
  store: AgentFileStore,
  sourceDir: string,
  targetAgentDir: string,
  relativeFiles: readonly string[]
): Promise<void> {
  const prefix = `${targetAgentDir}/`;
  await uploadFiles(
    store,
    relativeFiles.map((rel) => `${prefix}${rel}`),
    (agentRel) => fs.readFileSync(path.join(sourceDir, agentRel.slice(prefix.length)))
  );
}

/**
 * M → P после выгрузки базы агентом. Возвращает абсолютные пути файлов проекта, которые
 * изменились, появились или удалены; неизменённые файлы не переписываются (mtime цел,
 * watcher не дёргается). `onWillChange` вызывается ДО первой записи в проект, перед записью
 * `Configuration.xml` (если он изменён) и после последней записи.
 */
export async function mirrorAgentToProject(
  store: AgentFileStore,
  targetAgentDir: string,
  projectDir: string,
  onWillChange?: (filePaths: string[]) => void
): Promise<string[]> {
  if (!(await hasAgentConfigurationDump(store, targetAgentDir))) {
    // Пустое M зеркалом стёрло бы весь проект: такой исход выгрузки — ошибка, а не «база пуста».
    throw new Error(`Агент не выгрузил конфигурацию: в "${targetAgentDir}" нет ${CONFIGURATION_XML}.`);
  }
  const prefix = `${targetAgentDir}/`;
  const remoteFiles = (await store.list(targetAgentDir, { recursive: true }))
    .filter((entry) => entry.type === 'file')
    .map((entry) => entry.path.slice(prefix.length));
  const remoteSet = new Set(remoteFiles);
  const deleted = listLocalFiles(projectDir).filter((rel) => !remoteSet.has(rel));

  // Первый проход только сравнивает: список изменений нужен вызывающему до записи,
  // а держать в памяти всю выгрузку ради одного прохода нельзя.
  const changed: string[] = [];
  await downloadFiles(store, remoteFiles.map((rel) => `${prefix}${rel}`), (agentRel, data) => {
    const rel = agentRel.slice(prefix.length);
    if (!hasSameContent(path.join(projectDir, rel), data)) {
      changed.push(rel);
    }
  });

  const changedProjectFiles = [...changed, ...deleted].sort().map((rel) => path.join(projectDir, rel));
  // Хук открывает у вызывающего окно подавления reload, отсчитываемое от момента вызова
  // (Container.suppressConfigurationReloadForFiles). Запись асинхронная и на большой
  // конфигурации может идти дольше окна, поэтому хук зовётся трижды: до первой записи,
  // непосредственно перед Configuration.xml (его событие watcher перезагружает всё дерево,
  // поэтому он пишется последним) и после последней записи.
  onWillChange?.(changedProjectFiles);

  for (const rel of deleted) {
    fs.rmSync(path.join(projectDir, rel), { force: true });
    pruneEmptyParents(projectDir, path.dirname(path.join(projectDir, rel)));
  }
  const writeChanged = (rels: readonly string[]): Promise<unknown> =>
    downloadFiles(store, rels.map((rel) => `${prefix}${rel}`), (agentRel, data) => {
      const target = path.join(projectDir, agentRel.slice(prefix.length));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, data);
    });
  await writeChanged(changed.filter((rel) => rel !== CONFIGURATION_XML));
  if (changed.includes(CONFIGURATION_XML)) {
    onWillChange?.(changedProjectFiles);
    await writeChanged([CONFIGURATION_XML]);
  }
  onWillChange?.(changedProjectFiles);
  return changedProjectFiles;
}

/** Относительные POSIX-пути всех файлов каталога (рекурсивно); отсутствующий каталог — пуст. */
function listLocalFiles(rootDir: string): string[] {
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
  if (fs.existsSync(rootDir)) {
    walk(rootDir, '');
  }
  return result;
}

function collectAncestorDirs(files: readonly string[]): Set<string> {
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }
  return dirs;
}

function hasSameContent(filePath: string, data: Buffer): boolean {
  try {
    return fs.readFileSync(filePath).equals(data);
  } catch {
    return false; // файла в проекте нет — значит, он новый
  }
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
