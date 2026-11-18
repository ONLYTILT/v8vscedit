import * as fs from 'fs';
import { buildDumpConfigToFilesCommand } from '../../../domain/agent/AgentCommand';
import { parseDumpChanges, type DumpChangeSet } from '../../../domain/agent/DumpChangesParser';
import { downloadFiles, statFiles, type AgentTransferOptions } from '../files/AgentFileTransfer';
import { confirmFullDumpOrThrow, importByArchive } from './ArchiveImport';
import { collectOwnerFiles, resolveChangedOwners, type ChangedOwner } from './ChangedObjectFiles';
import { isProjectDumpReplaced } from './ProjectDumpInfo';
import {
  CONFIG_DUMP_INFO_XML,
  CONFIGURATION_XML,
  applyProjectChanges,
  assertConfigurationPresent,
  hasSameProjectContent,
  listProjectFiles,
  projectFileExists,
} from './ProjectFiles';
import { handleOrphans, seedFromProject, type OrphanFilesOutcome } from './ProjectSeed';
import { restoreFromDatabase } from './SparseRestore';
import {
  exchangeDirOf,
  throwIfCancelled,
  withTransferCancellation,
  type SyncOperationContext,
} from './SyncContext';
import {
  buildSyncManifestFiles,
  diffSyncFiles,
  type SyncMirrorCoverage,
  type SyncMirrorState,
} from './SyncManifest';
import { planBeforeUpdate, planRemoteImport, type ImportArchiveReason } from './SyncPlanner';

/**
 * Импорт БД → P (таблица плана §1.1). Локальное хранилище — полное сравнение M и P; удалённое —
 * список изменений `--get-changes`, дельта по владельцам и архив там, где списку верить нельзя.
 * Всё, что приходит от агента, сначала целиком оказывается у нас (staging на диске или архив), и
 * только потом пишется в проект: отмена и сбой передачи не оставляют P наполовину обновлённым.
 *
 * Пустой удалённый M засевается без полной выгрузки в него: из выгрузки проекта (с согласия
 * пользователя) или из архива первого импорта. Такой M разреженный, и правила дельты для него
 * строже: отсутствие файла в M не означает его удаления в базе, а правки файлов, которых в M нет,
 * берёт из базы точечная выгрузка (`SparseRestore`), а не архив.
 *
 * Решения — в две фазы (plan-archive-avoid.md §3.1): до `--update` (`planBeforeUpdate`) и после
 * (`planRemoteImport`); политика причин полной выгрузки — `ARCHIVE_REASON_POLICY`.
 */

export interface AgentImportResult {
  readonly changedProjectFiles: string[];
  readonly strategy: 'compare' | 'delta' | 'archive';
  readonly reason?: ImportArchiveReason;
  /** Из чего засеян пустой M в этой операции. */
  readonly seededFrom?: 'project' | 'archive';
  /** Сколько локально изменённых файлов взято из базы точечной выгрузкой. */
  readonly restoredFromDatabase?: number;
  /** «Осиротевшие» файлы выгрузки проекта после посева из неё (их владельцев нет в базе). */
  readonly orphans?: { readonly owners: string[]; readonly files: string[]; readonly removed: boolean };
}

export interface AgentImportOutcome {
  readonly result: AgentImportResult;
  /** Полнота M после операции — пишется в манифест вместе с B. */
  readonly mirrorCoverage: SyncMirrorCoverage;
}

export async function runImport(context: SyncOperationContext): Promise<AgentImportOutcome> {
  const result = context.store.kind === 'local' ? await importByCompare(context) : await importRemote(context);
  return { result, mirrorCoverage: context.mirror.coverage };
}

// --- локальное хранилище: полное сравнение ---------------------------------------------------

async function importByCompare(context: SyncOperationContext): Promise<AgentImportResult> {
  const { store, workspace } = context;
  const mirror = workspace.targetAgentDir;
  const hasDumpInfo = (await store.stat(`${mirror}/${CONFIG_DUMP_INFO_XML}`)) !== undefined;
  context.markMirrorMutated();
  await context.exec.execute(buildDumpConfigToFilesCommand(mirror, {
    extensionName: context.extensionName,
    update: hasDumpInfo,
    force: true,
  }));
  throwIfCancelled(context);

  const prefix = `${mirror}/`;
  const mirrorFiles = (await store.list(mirror, { recursive: true }))
    .filter((entry) => entry.type === 'file')
    .map((entry) => entry.path.slice(prefix.length));
  assertConfigurationPresent(mirrorFiles.includes(CONFIGURATION_XML), `"${mirror}"`);

  // Первый проход только сравнивает: список изменений нужен до первой записи, а держать в
  // памяти всю выгрузку ради одного прохода нельзя (локально второе чтение дёшево).
  const changed: string[] = [];
  const projectDir = context.target.rootPath;
  await downloadFiles(store, mirrorFiles.map((rel) => prefix + rel), (agentRel, data) => {
    const rel = agentRel.slice(prefix.length);
    if (!hasSameProjectContent(projectDir, rel, data)) {
      changed.push(rel);
    }
  }, transferOptions(context));
  throwIfCancelled(context);

  const inMirror = new Set(mirrorFiles);
  const changedProjectFiles = await applyProjectChanges({
    projectDir,
    writes: changed,
    deletes: listProjectFiles(projectDir).filter((rel) => !inMirror.has(rel)),
    // Второй проход без отмены: запись в проект, начавшись, доводится до конца.
    read: (rels, sink) => downloadFiles(store, rels.map((rel) => prefix + rel), (agentRel, data) =>
      sink(agentRel.slice(prefix.length), data), { concurrency: context.transferConcurrency }),
    onWillChange: context.hooks?.onProjectFilesWillChange,
  });
  return { changedProjectFiles, strategy: 'compare' };
}

// --- удалённое хранилище: список изменений, дельта, архив --------------------------------------

/** Результат фазы 2 вместе с владельцами списка изменений — их знает поиск сирот после посева. */
interface ChangesOutcome {
  readonly result: AgentImportResult;
  readonly changedOwners: ReadonlySet<string>;
}

async function importRemote(context: SyncOperationContext): Promise<AgentImportResult> {
  const mirrorState = await effectiveMirrorState(context);
  if (mirrorState !== 'empty') {
    // Ручная замена выгрузки проекта (новый файл версий): та же развилка посева, что у пустого M.
    if (await isProjectDumpReplaced(context.target.rootPath, context.manifest.projectDumpInfo)) {
      const seed = await seedFromProject(context, 'project-replaced');
      if (seed.kind === 'seeded') {
        return importSeeded(context, seed.base);
      }
    }
    return (await importChanges(context, mirrorState, undefined)).result;
  }
  const seed = await seedFromProject(context, 'mirror-empty');
  if (seed.kind === 'seeded') {
    return importSeeded(context, seed.base);
  }
  // Первый раз (или M потерян/недостоверен) без посева из проекта: ОДНА серверная выгрузка
  // архивом, M засевается из него же. Вопрос — ДО очистки M (отказ не должен мутировать M), кроме
  // случая, когда пользователь уже выбрал «Полная выгрузка» в вопросе о посеве. Недостоверный M
  // очищается заранее: его остаток не должен пережить операцию, даже если до посева дело не дойдёт.
  if (seed.kind !== 'full') {
    await confirmFullDumpOrThrow(context, 'mirror-empty');
  }
  context.markMirrorMutated();
  await context.store.remove(context.workspace.targetAgentDir, { recursive: true });
  return importByArchive(context, 'mirror-empty', { confirmed: true });
}

/** Импорт после посева из выгрузки проекта: D = ∅ относительно hash(P), затем поиск сирот. */
async function importSeeded(context: SyncOperationContext, base: Record<string, string>): Promise<AgentImportResult> {
  const { result, changedOwners } = await importChanges(context, 'fresh', base);
  // Архив сам удаляет из P всё, чего нет в базе: сирот после него не бывает.
  const orphans = result.strategy === 'archive' ? undefined : await handleOrphans(context, changedOwners);
  return { ...withOrphans(result, orphans), seededFrom: 'project' };
}

function withOrphans(result: AgentImportResult, orphans: OrphanFilesOutcome | undefined): AgentImportResult {
  if (orphans === undefined) {
    return result;
  }
  const { changedProjectFiles, ...summary } = orphans;
  return {
    ...result,
    changedProjectFiles: [...new Set([...result.changedProjectFiles, ...changedProjectFiles])].sort(),
    orphans: summary,
  };
}

async function importChanges(
  context: SyncOperationContext,
  mirrorState: SyncMirrorState,
  assumedBase: Readonly<Record<string, string>> | undefined
): Promise<ChangesOutcome> {
  const mirror = context.workspace.targetAgentDir;
  const changeSet = await fetchChangeSet(context);
  // `--get-changes` вместе с `--update` только пишет список (пилот §5b п.4): M обновляется вторым
  // шагом. FullDump/нераспознанный список уходят в архив ДО него — иначе вторая полная выгрузка.
  const before = planBeforeUpdate({ mirrorState, changeSet });
  if (before.action === 'archive') {
    return { result: await importByArchive(context, before.reason), changedOwners: new Set() };
  }
  if (before.action === 'update') {
    context.markMirrorMutated();
    await context.exec.execute(buildDumpConfigToFilesCommand(mirror, {
      extensionName: context.extensionName,
      update: true,
      force: true,
    }));
  }

  const projectDir = context.target.rootPath;
  const coverage = context.mirror.coverage;
  const { owners, unresolved } = resolveChangedOwners(before.objects);
  const changedOwners = new Set(owners.map((owner) => owner.fullName));
  const ownerFiles = unresolved.length === 0
    ? await withTransferCancellation(() => collectOwnerFiles(context.store, mirror, owners, transferOptions(context)))
    : undefined;
  const inMirror = new Set(ownerFiles?.files ?? []);
  // Владелец изменения, которого нет в M даже после второго шага, — признак неверного перевода
  // строки в путь (вложенная подсистема и т.п.): дельта молча пропустила бы его, архив — нет.
  const missingOwners = ownerFiles?.missingOwners.map((owner) => owner.fullName) ?? [];
  // `--update` пишет только изменившиеся файлы владельца: при разреженном M файлы владельца в P,
  // которых нет в M, — не удалённые в базе, а просто не выгруженные, и кандидатами быть не могут.
  const changedFiles = coverage === 'sparse'
    ? [...inMirror]
    : [...new Set([...inMirror, ...owners.flatMap((owner) => projectOwnerFiles(projectDir, owner))])];
  const dirty = diffSyncFiles(assumedBase ?? context.manifest.files, await buildSyncManifestFiles(projectDir, context.projectRoot));
  const dirtyFiles = [...dirty.added, ...dirty.modified, ...dirty.deleted];
  // Сверх порога план и так даст архив — лишние STAT по M не нужны.
  const dirtyAbsentFromMirror = coverage === 'sparse' && new Set([...changedFiles, ...dirtyFiles]).size <= context.archiveThresholdFiles
    ? await absentFromMirror(context, [...dirty.modified, ...dirty.deleted].filter((rel) => !inMirror.has(rel)))
    : [];
  const plan = planRemoteImport({
    mirrorState,
    changeSet,
    changedFiles,
    unresolvedObjects: [...unresolved, ...missingOwners],
    dirtyFiles,
    mirrorCoverage: coverage,
    dirtyAddedFiles: dirty.added,
    dirtyAbsentFromMirror,
    archiveThresholdFiles: context.archiveThresholdFiles,
  });
  if (plan.action === 'archive') {
    return { result: await importByArchive(context, plan.reason), changedOwners };
  }
  const deletable = new Set(plan.deletableIfAbsent);
  const restore = plan.restoreFromDatabase;
  if (restore.length === 0) {
    return { result: await importByDelta(context, plan.files, inMirror, deletable), changedOwners };
  }
  context.hooks?.onMessage?.(`Точечная выгрузка из базы локально изменённых файлов: ${String(restore.length)}.`);
  const restored = await restoreFromDatabase(context, restore);
  if (!restored.ok) {
    // Текст агента бывает многострочным: сообщение журнала — одна строка.
    const reason = restored.reason.replace(/\s+/g, ' ').trim();
    context.hooks?.onMessage?.(`Точечная выгрузка не удалась (${reason}): импорт пойдёт полной выгрузкой.`);
    return { result: await importByArchive(context, 'sparse-mirror-dirty'), changedOwners };
  }
  const source = { dir: restored.sourceDir, files: new Set(restore) };
  const result = await importByDelta(context, plan.files, inMirror, deletable, source);
  return { result: { ...result, restoredFromDatabase: restore.length }, changedOwners };
}

function transferOptions(context: SyncOperationContext): AgentTransferOptions {
  return { concurrency: context.transferConcurrency, cancellation: context.hooks?.cancellation };
}

/** Файлы, которых нет в M: правку такого файла в разреженном M берёт точечная выгрузка из базы. */
async function absentFromMirror(context: SyncOperationContext, rels: readonly string[]): Promise<string[]> {
  const prefix = `${context.workspace.targetAgentDir}/`;
  const entries = await statFiles(context.store, rels.map((rel) => prefix + rel), transferOptions(context));
  throwIfCancelled(context);
  return rels.filter((rel) => entries.get(prefix + rel)?.type !== 'file');
}

/** Флаг манифеста; M без файла версий (потерян на сервере) — недостоверен, как пустой. */
async function effectiveMirrorState(context: SyncOperationContext): Promise<SyncMirrorState> {
  if (context.manifest.mirrorState === 'empty') {
    return 'empty';
  }
  const dumpInfo = await context.store.stat(`${context.workspace.targetAgentDir}/${CONFIG_DUMP_INFO_XML}`);
  return dumpInfo === undefined ? 'empty' : context.manifest.mirrorState;
}

async function fetchChangeSet(context: SyncOperationContext): Promise<DumpChangeSet> {
  const changesFile = `${exchangeDirOf(context)}.changes`;
  await context.exec.execute(buildDumpConfigToFilesCommand(context.workspace.targetAgentDir, {
    extensionName: context.extensionName,
    update: true,
    getChanges: changesFile,
  }));
  return parseDumpChanges((await context.store.readFile(changesFile)).toString('utf-8'));
}

/** Файлы владельца в P: XML и всё поддерево — то, что в M могло исчезнуть. */
function projectOwnerFiles(projectDir: string, owner: ChangedOwner): string[] {
  const files = projectFileExists(projectDir, owner.xmlRel) ? [owner.xmlRel] : [];
  return [...files, ...listProjectFiles(projectDir, owner.dirRel)];
}

/** Файлы точечной выгрузки: каталог обмена, откуда они берутся вместо M. */
interface RestoreSource {
  readonly dir: string;
  readonly files: ReadonlySet<string>;
}

/**
 * Дельта: STAT отсутствующих в M — пулом, скачивание — пулом, отличающиеся от P файлы — во временные
 * файлы локального каталога обмена; в памяти только «путь → staging»: при пороге в тысячи файлов
 * буфер в памяти занял бы гигабайты, а второе скачивание ради записи удвоило бы трафик (Н25).
 * Staging убирает движок вместе с каталогом обмена.
 */
async function importByDelta(
  context: SyncOperationContext,
  files: readonly string[],
  knownInMirror: ReadonlySet<string>,
  deletableIfAbsent: ReadonlySet<string>,
  restore: RestoreSource = { dir: '', files: new Set() }
): Promise<AgentImportResult> {
  const { store } = context;
  const prefix = `${context.workspace.targetAgentDir}/`;
  const toStat = files.filter((rel) => !knownInMirror.has(rel) && !restore.files.has(rel));
  const stats = await statFiles(store, toStat.map((rel) => prefix + rel), transferOptions(context));
  throwIfCancelled(context);
  const present = files.filter((rel) =>
    restore.files.has(rel) || knownInMirror.has(rel) || stats.get(prefix + rel)?.type === 'file');
  const presentSet = new Set(present);
  const lost = files.filter((rel) => !presentSet.has(rel) && !deletableIfAbsent.has(rel));
  // План отдаёт неудаляемыми только файлы, проверенные STAT по M (правки неизменённых владельцев
  // берёт точечная выгрузка); исчезнуть из M между той проверкой и этой файл может только при чужой
  // записи в M. Без границы такая гонка молча оставила бы P неверным; M после неё недостоверен.
  if (lost.length > 0) {
    context.markMirrorMutated();
    throw new Error(`Разреженное зеркало агента не содержит файлов, нужных импорту: ${lost.join(', ')}. Повторите импорт.`);
  }

  const projectDir = context.target.rootPath;
  // Источник файла — каталог точечной выгрузки или M; путь в проекте восстанавливается по префиксу.
  const restorePrefix = `${restore.dir}/`;
  const sources = present.map((rel) => (restore.files.has(rel) ? restorePrefix : prefix) + rel);
  const staged = new Map<string, string>();
  let stagingCount = 0;
  await downloadFiles(store, sources, async (source, data) => {
    const rel = source.startsWith(restorePrefix) ? source.slice(restorePrefix.length) : source.slice(prefix.length);
    if (hasSameProjectContent(projectDir, rel, data)) {
      return;
    }
    // Имя по номеру, а не по пути (длинные пути Windows); номер берётся до первого await. Это не файл
    // выгрузки: его читает только эта операция после успешной записи, а обрыв убирает каталог обмена
    // целиком — temp+rename здесь не нужен.
    stagingCount += 1;
    const stagingPath = await context.localExchange.file(`delta-${String(stagingCount)}`);
    await fs.promises.writeFile(stagingPath, data);
    staged.set(rel, stagingPath);
  }, transferOptions(context));
  throwIfCancelled(context);

  const deletes = files.filter((rel) => !presentSet.has(rel) && projectFileExists(projectDir, rel));
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
  });
  return { changedProjectFiles, strategy: 'delta' };
}
