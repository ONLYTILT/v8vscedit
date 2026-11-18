import { buildDumpConfigToFilesCommand } from '../../../domain/agent/AgentCommand';
import { parseDumpChanges, type DumpChangeSet } from '../../../domain/agent/DumpChangesParser';
import { downloadFiles } from '../files/AgentFileTransfer';
import { extractArchive } from './ArchiveCodec';
import { collectOwnerFiles, resolveChangedOwners, type ChangedOwner } from './ChangedObjectFiles';
import {
  CONFIG_DUMP_INFO_XML,
  CONFIGURATION_XML,
  applyProjectChanges,
  assertConfigurationPresent,
  hasSameProjectContent,
  listProjectFiles,
  projectFileExists,
} from './ProjectFiles';
import {
  EXCHANGE_ARCHIVE,
  exchangeDirOf,
  throwIfCancelled,
  type SyncOperationContext,
} from './SyncContext';
import { buildSyncManifestFiles, diffSyncFiles, type SyncMirrorState } from './SyncManifest';
import { planRemoteImport, type ImportArchiveReason } from './SyncPlanner';

/**
 * Импорт БД → P (таблица плана §1.1). Локальное хранилище — полное сравнение M и P; удалённое —
 * список изменений `--get-changes`, дельта по владельцам и архив там, где списку верить нельзя.
 * Всё, что приходит от агента, сначала целиком оказывается у нас (память или архив), и только
 * потом пишется в проект: отмена и сбой передачи не оставляют P наполовину обновлённым.
 */

export interface AgentImportResult {
  readonly changedProjectFiles: string[];
  readonly strategy: 'compare' | 'delta' | 'archive';
  readonly reason?: ImportArchiveReason;
}

export async function runImport(context: SyncOperationContext): Promise<AgentImportResult> {
  return context.store.kind === 'local' ? importByCompare(context) : importRemote(context);
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
  }, { concurrency: context.transferConcurrency, cancellation: context.hooks?.cancellation });
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

async function importRemote(context: SyncOperationContext): Promise<AgentImportResult> {
  const mirror = context.workspace.targetAgentDir;
  const mirrorState = await effectiveMirrorState(context);
  if (mirrorState === 'empty') {
    // Первый раз (или M потерян/недостоверен): полная выгрузка в M на сервере, P — из архива.
    // M очищается заранее: что делает выгрузка без `--update` с лишними файлами существующего
    // каталога, пилотом не проверено, а остаток недостоверного M иначе пережил бы её.
    context.markMirrorMutated();
    await context.store.remove(mirror, { recursive: true });
    await context.exec.execute(buildDumpConfigToFilesCommand(mirror, { extensionName: context.extensionName, force: true }));
    return importByArchive(context, 'mirror-empty');
  }

  const changeSet = await fetchChangeSet(context);
  // `--get-changes` вместе с `--update` только пишет список (пилот §5b п.4): M обновляется вторым
  // шагом. Пустой список значит, что M и так совпадает с базой.
  if (!(changeSet.kind === 'objects' && changeSet.objects.length === 0)) {
    context.markMirrorMutated();
    await context.exec.execute(buildDumpConfigToFilesCommand(mirror, {
      extensionName: context.extensionName,
      update: true,
      force: true,
    }));
  }

  const projectDir = context.target.rootPath;
  const { owners, unresolved } = changeSet.kind === 'objects'
    ? resolveChangedOwners(changeSet.objects)
    : { owners: [], unresolved: [] };
  const ownerFiles = unresolved.length === 0 ? await collectOwnerFiles(context.store, mirror, owners) : undefined;
  const inMirror = new Set(ownerFiles?.files ?? []);
  // Владелец изменения, которого нет в M даже после второго шага, — признак неверного перевода
  // строки в путь (вложенная подсистема и т.п.): дельта молча пропустила бы его, архив — нет.
  const missingOwners = ownerFiles?.missingOwners.map((owner) => owner.fullName) ?? [];
  const changedFiles = [...new Set([...inMirror, ...owners.flatMap((owner) => projectOwnerFiles(projectDir, owner))])];
  const dirty = diffSyncFiles(context.manifest.files, await buildSyncManifestFiles(projectDir, context.projectRoot));
  const plan = planRemoteImport({
    mirrorState,
    changeSet,
    changedFiles,
    unresolvedObjects: [...unresolved, ...missingOwners],
    dirtyFiles: [...dirty.added, ...dirty.modified, ...dirty.deleted],
    archiveThresholdFiles: context.archiveThresholdFiles,
  });
  if (plan.action === 'archive') {
    return importByArchive(context, plan.reason);
  }
  return importByDelta(context, plan.files, inMirror);
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

async function importByDelta(
  context: SyncOperationContext,
  files: readonly string[],
  knownInMirror: ReadonlySet<string>
): Promise<AgentImportResult> {
  const { store } = context;
  const prefix = `${context.workspace.targetAgentDir}/`;
  const present: string[] = [];
  for (const rel of files) {
    if (knownInMirror.has(rel) || (await store.stat(prefix + rel))?.type === 'file') {
      present.push(rel);
    }
  }

  // Число файлов дельты ограничено порогом архива, поэтому они держатся в памяти: второе
  // скачивание ради записи удвоило бы передачу по сети (Н25).
  const downloaded = new Map<string, Uint8Array>();
  await downloadFiles(store, present.map((rel) => prefix + rel), (agentRel, data) => {
    downloaded.set(agentRel.slice(prefix.length), data);
  }, { concurrency: context.transferConcurrency, cancellation: context.hooks?.cancellation });
  throwIfCancelled(context);

  const projectDir = context.target.rootPath;
  const writes = [...downloaded]
    .filter(([rel, data]) => !hasSameProjectContent(projectDir, rel, data))
    .map(([rel]) => rel);
  const presentSet = new Set(present);
  const deletes = files.filter((rel) => !presentSet.has(rel) && projectFileExists(projectDir, rel));
  // Configuration.xml попадает в удаляемые, только если владелец «конфигурация» исчез из M.
  assertConfigurationPresent(!deletes.includes(CONFIGURATION_XML), `"${context.workspace.targetAgentDir}"`);
  const changedProjectFiles = await applyProjectChanges({
    projectDir,
    writes,
    deletes,
    read: async (rels, sink) => {
      const wanted = new Set(rels);
      for (const [rel, data] of downloaded) {
        if (wanted.has(rel)) {
          await sink(rel, data);
        }
      }
    },
    onWillChange: context.hooks?.onProjectFilesWillChange,
  });
  return { changedProjectFiles, strategy: 'delta' };
}

async function importByArchive(context: SyncOperationContext, reason: ImportArchiveReason): Promise<AgentImportResult> {
  const exchangeDir = exchangeDirOf(context);
  // `--update` с `--archive` агент не выполняет (пилот): архив — отдельная полная выгрузка в обмен.
  await context.exec.execute(buildDumpConfigToFilesCommand(exchangeDir, {
    extensionName: context.extensionName,
    archive: EXCHANGE_ARCHIVE,
  }));
  const zip = await context.store.readFile(`${exchangeDir}/${EXCHANGE_ARCHIVE}`);
  throwIfCancelled(context);

  // Первый проход валидирует архив и сравнивает его с P; запись — вторым проходом.
  const projectDir = context.target.rootPath;
  const entries = new Set<string>();
  const changed: string[] = [];
  await extractArchive(zip, (entry) => {
    entries.add(entry.path);
    if (!hasSameProjectContent(projectDir, entry.path, entry.data)) {
      changed.push(entry.path);
    }
  });
  assertConfigurationPresent(entries.has(CONFIGURATION_XML), 'архиве выгрузки');

  const changedProjectFiles = await applyProjectChanges({
    projectDir,
    writes: changed,
    deletes: listProjectFiles(projectDir).filter((rel) => !entries.has(rel)),
    read: (rels, sink) => {
      const wanted = new Set(rels);
      return extractArchive(zip, (entry) => (wanted.has(entry.path) ? sink(entry.path, entry.data) : undefined));
    },
    onWillChange: context.hooks?.onProjectFilesWillChange,
  });
  return { changedProjectFiles, strategy: 'archive', reason };
}
