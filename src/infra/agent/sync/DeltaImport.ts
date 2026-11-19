import * as fs from 'fs';
import type { AgentFileEntry } from '../files/AgentFileStore';
import { downloadFiles, statFiles } from '../files/AgentFileTransfer';
import type { AgentImportResult } from './AgentImportFlow';
import { selectMirrorDownloads, type MirrorMarker } from './MirrorChangeWindow';
import {
  CONFIGURATION_XML,
  applyProjectChanges,
  assertConfigurationPresent,
  hasSameProjectContent,
  projectFileExists,
  projectFileSize,
} from './ProjectFiles';
import { summarizeList } from './ProjectSeed';
import { throwIfCancelled, transferOptionsOf, type SyncOperationContext } from './SyncContext';

/** Файлы точечной выгрузки: каталог обмена, откуда они берутся вместо M. */
export interface RestoreSource {
  readonly dir: string;
  readonly files: ReadonlySet<string>;
}

/** Входы дельты: план фазы 2 и всё, что нужно отбору по времени изменения (`MirrorChangeWindow`). */
export interface DeltaInput {
  /** Файлы плана (`plan.files`): изменённые владельцы, грязные, удалённые. */
  readonly files: readonly string[];
  /** Заведомо есть в M (из LIST/STAT владельцев): STAT не нужен. */
  readonly knownInMirror: ReadonlySet<string>;
  readonly deletableIfAbsent: ReadonlySet<string>;
  /** Файлы удалённых в базе владельцев: в M их нет заведомо, STAT не нужен. */
  readonly knownAbsent: ReadonlySet<string>;
  readonly restore?: RestoreSource;
  /** Записи M по `knownInMirror` (размер и время изменения из того же LIST/STAT). */
  readonly mirrorEntries: ReadonlyMap<string, AgentFileEntry> | undefined;
  readonly marker: MirrorMarker | undefined;
  /** Файлы, изменённые в P относительно базы `base`. */
  readonly dirtyFiles: ReadonlySet<string>;
  /** B (или hash(P) после посева): файл вне неё не отслеживался, его равенство P не доказано. */
  readonly base: Readonly<Record<string, string>>;
  /** В операции был `--update` по изменённым владельцам. */
  readonly expectRewrites: boolean;
  /** `rewrite` — сервер переписал M целиком (`--update --force` при FullDump): отбор бесполезен. */
  readonly updateKind: 'incremental' | 'rewrite';
}

const MEBIBYTE = 1024 * 1024;

/**
 * Предикат «путь совпадает с одним из удаляемых без учёта регистра». На Windows это один физический файл
 * (переименование объекта только регистром): удаление в `applyProjectChanges` идёт первым, и файл с равным
 * содержимым, пропущенный при записи, пропал бы из P навсегда.
 */
export function caseCollisions(deletes: readonly string[]): (rel: string) => boolean {
  const lowered = new Set(deletes.map((rel) => rel.toLowerCase()));
  return (rel) => lowered.has(rel.toLowerCase());
}

/**
 * Дельта: STAT отсутствующих в M — пулом, отбор по времени изменения, скачивание — пулом, отличающиеся от P
 * файлы — во временные файлы локального каталога обмена; в памяти только «путь → staging»: при пороге в
 * тысячи файлов буфер в памяти занял бы гигабайты, а второе скачивание ради записи удвоило бы трафик (Н25).
 * Staging убирает движок вместе с каталогом обмена.
 */
export async function importByDelta(context: SyncOperationContext, input: DeltaInput): Promise<AgentImportResult> {
  const { store, progress } = context;
  const { files, knownInMirror, knownAbsent, restore } = input;
  const prefix = `${context.workspace.targetAgentDir}/`;
  const fromRestore = (rel: string): boolean => restore?.files.has(rel) === true;
  const toStat = files.filter((rel) => !knownInMirror.has(rel) && !fromRestore(rel) && !knownAbsent.has(rel));
  const statCounter = progress.counter((done, total) => `Проверка файлов зеркала: ${String(done)} из ${String(total)}`, toStat.length);
  const stats = await statFiles(store, toStat.map((rel) => prefix + rel), {
    ...transferOptionsOf(context),
    onProgress: () => { statCounter.advance(); },
  });
  statCounter.finish();
  throwIfCancelled(context);
  const present = files.filter((rel) =>
    fromRestore(rel) || knownInMirror.has(rel) || stats.get(prefix + rel)?.type === 'file');
  const presentSet = new Set(present);
  const lost = files.filter((rel) => !presentSet.has(rel) && !input.deletableIfAbsent.has(rel));
  // План отдаёт неудаляемыми только файлы, проверенные STAT по M (правки неизменённых владельцев
  // берёт точечная выгрузка); исчезнуть из M между той проверкой и этой файл может только при чужой
  // записи в M. Без границы такая гонка молча оставила бы P неверным; M после неё недостоверен.
  if (lost.length > 0) {
    context.markMirrorMutated();
    throw new Error(`Разреженное зеркало агента не содержит файлов, нужных импорту: ${lost.join(', ')}. Повторите импорт.`);
  }

  const projectDir = context.target.rootPath;
  const deletes = files.filter((rel) => !presentSet.has(rel) && projectFileExists(projectDir, rel));
  const sameFileAsDeleted = caseCollisions(deletes);
  const entries = new Map<string, AgentFileEntry>(input.mirrorEntries);
  for (const rel of toStat) {
    const entry = stats.get(prefix + rel);
    if (entry !== undefined) {
      entries.set(rel, entry);
    }
  }
  const fromMirror = present.filter((rel) => !fromRestore(rel));
  const mustFetch = new Set(fromMirror.filter((rel) =>
    input.dirtyFiles.has(rel) || !Object.prototype.hasOwnProperty.call(input.base, rel) || sameFileAsDeleted(rel)));
  const download = new Set(chooseDownloads(context, input, fromMirror, entries, mustFetch));

  // Источник файла — каталог точечной выгрузки или M. Путь в проекте берётся из карты, а не разбором
  // префикса: префиксы двух каталогов могут вкладываться друг в друга.
  const relBySource = new Map(present
    .filter((rel) => fromRestore(rel) || download.has(rel))
    .map((rel) => [restore?.files.has(rel) === true ? `${restore.dir}/${rel}` : prefix + rel, rel]));
  const staged = new Map<string, string>();
  let stagingCount = 0;
  const downloadCounter = progress.counter((done, total, bytes) =>
    `Скачивание изменённых файлов: ${String(done)} из ${String(total)} (${String(Math.floor((done * 100) / total))}%), ` +
    `${(bytes / MEBIBYTE).toFixed(1)} МБ`, relBySource.size);
  await downloadFiles(store, [...relBySource.keys()], async (source, data) => {
    const rel = relBySource.get(source);
    /* c8 ignore start -- downloadFiles отдаёт в приёмник ровно запрошенные пути; ветка страхует от смены
       контракта хранилища, из тестов (настоящее хранилище и эмулятор агента) недостижима. */
    if (rel === undefined) {
      throw new Error(`Неожиданный файл агента в дельте импорта: ${source}`);
    }
    /* c8 ignore stop */
    downloadCounter.advance(1, data.length);
    // Совпадение с удаляемым путём без учёта регистра (переименование регистром на Windows) — тот же
    // физический файл: удаление идёт первым, поэтому запись обязательна даже при равном содержимом.
    if (!sameFileAsDeleted(rel) && hasSameProjectContent(projectDir, rel, data)) {
      return;
    }
    // Имя по номеру, а не по пути (длинные пути Windows); номер берётся до первого await. Это не файл
    // выгрузки: его читает только эта операция после успешной записи, а обрыв убирает каталог обмена
    // целиком — temp+rename здесь не нужен.
    stagingCount += 1;
    const stagingPath = await context.localExchange.file(`delta-${String(stagingCount)}`);
    await fs.promises.writeFile(stagingPath, data);
    staged.set(rel, stagingPath);
  }, transferOptionsOf(context));
  downloadCounter.finish();
  throwIfCancelled(context);

  // Configuration.xml попадает в удаляемые, только если владелец «конфигурация» исчез из M.
  assertConfigurationPresent(!deletes.includes(CONFIGURATION_XML), `"${context.workspace.targetAgentDir}"`);
  const changedProjectFiles = await applyProjectChanges({
    projectDir,
    writes: [...staged.keys()],
    deletes,
    // Запрашиваются ровно `writes` — ключи staging; читаются по одному: память — O(файл).
    read: async (_rels, sink) => {
      for (const [rel, stagingPath] of staged) {
        await sink(rel, await fs.promises.readFile(stagingPath));
      }
    },
    onWillChange: context.hooks?.onProjectFilesWillChange,
    onProgress: progress,
  });
  return { changedProjectFiles, strategy: 'delta' };
}

const MISMATCH_SHOWN = 10;

/** Отбор файлов M к скачиванию и одна строка журнала о его итоге (или причине отката). */
function chooseDownloads(
  context: SyncOperationContext,
  input: DeltaInput,
  candidates: readonly string[],
  entries: ReadonlyMap<string, AgentFileEntry>,
  mustFetch: ReadonlySet<string>
): string[] {
  const count = String(candidates.length);
  if (input.updateKind === 'rewrite') {
    context.progress.step(`Сервер переписал зеркало целиком: сравниваются все ${count} файлов изменённых объектов.`);
    return [...candidates];
  }
  const projectDir = context.target.rootPath;
  const selection = selectMirrorDownloads({
    candidates,
    entries,
    marker: input.marker,
    mustFetch,
    projectSizeOf: (rel) => projectFileSize(projectDir, rel),
    expectRewrites: input.expectRewrites,
  });
  if (selection.fallback === 'no-rewritten-files') {
    context.progress.step(
      `Время изменения файлов в зеркале не обновилось после обновления зеркала: сравниваются целиком все ${count} файлов изменённых объектов.`
    );
  } else if (selection.fallback === undefined && candidates.length > 0) {
    context.progress.step(
      `Изменено в зеркале: ${String(selection.download.length)} из ${count} файлов изменённых объектов (скачиваются только они)`
    );
    if (selection.sizeMismatch.length > 0) {
      context.progress.step(
        `Файлы, чей размер расходится с проектом без изменения в зеркале: ${String(selection.sizeMismatch.length)} ` +
        `(берутся из зеркала): ${summarizeList(selection.sizeMismatch, MISMATCH_SHOWN, ', ')}.`
      );
    }
  }
  return selection.download;
}
