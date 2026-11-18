import * as path from 'path';
import { buildDumpConfigToFilesCommand } from '../../../domain/agent/AgentCommand';
import { parseDumpChanges, type DumpChangeSet } from '../../../domain/agent/DumpChangesParser';
import { downloadFiles } from '../files/AgentFileTransfer';
import { importByArchive } from './ArchiveImport';
import { collectOwnerFiles, resolveChangedOwners, type ChangedOwner } from './ChangedObjectFiles';
import { inspectProjectMirrorSeed, seedMirror } from './MirrorSeed';
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
  AgentSyncCancelledError,
  exchangeDirOf,
  throwIfCancelled,
  type SyncOperationContext,
} from './SyncContext';
import {
  buildSyncManifestFiles,
  diffSyncFiles,
  type SyncFilesDiff,
  type SyncMirrorCoverage,
  type SyncMirrorState,
} from './SyncManifest';
import { planRemoteImport, type ImportArchiveReason } from './SyncPlanner';

/**
 * Импорт БД → P (таблица плана §1.1). Локальное хранилище — полное сравнение M и P; удалённое —
 * список изменений `--get-changes`, дельта по владельцам и архив там, где списку верить нельзя.
 * Всё, что приходит от агента, сначала целиком оказывается у нас (память или архив), и только
 * потом пишется в проект: отмена и сбой передачи не оставляют P наполовину обновлённым.
 *
 * Пустой удалённый M засевается без полной выгрузки в него: из выгрузки проекта (с согласия
 * пользователя) или из архива первого импорта. Такой M разреженный, и правила дельты для него
 * строже: отсутствие файла в M не означает его удаления в базе.
 */

export interface AgentImportResult {
  readonly changedProjectFiles: string[];
  readonly strategy: 'compare' | 'delta' | 'archive';
  readonly reason?: ImportArchiveReason;
  /** Из чего засеян пустой M в этой операции. */
  readonly seededFrom?: 'project' | 'archive';
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
  const mirrorState = await effectiveMirrorState(context);
  if (mirrorState !== 'empty') {
    return importChanges(context, mirrorState, undefined);
  }
  const assumedBase = await seedFromProject(context);
  if (assumedBase !== undefined) {
    return { ...(await importChanges(context, 'fresh', assumedBase)), seededFrom: 'project' };
  }
  // Первый раз (или M потерян/недостоверен) без посева из проекта: ОДНА серверная выгрузка
  // архивом, M засевается из него же. Недостоверный M очищается заранее: его остаток не должен
  // пережить операцию, даже если до посева дело не дойдёт.
  context.markMirrorMutated();
  await context.store.remove(context.workspace.targetAgentDir, { recursive: true });
  return importByArchive(context, 'mirror-empty');
}

/**
 * Посев M из выгрузки проекта — только с согласия пользователя: файл версий проекта описывает базу
 * на момент выгрузки, и ручные правки XML после неё импорт не перезапишет. Возвращает B, от которой
 * считаются локальные правки (= hash(P): правки после выгрузки не перетираются, как обещано в
 * вопросе), или `undefined`, если посева нет.
 */
async function seedFromProject(context: SyncOperationContext): Promise<Record<string, string> | undefined> {
  const confirm = context.hooks?.confirmMirrorSeed;
  if (confirm === undefined) {
    return undefined;
  }
  const inspection = inspectProjectMirrorSeed(context.target, context.extensionName);
  if (!inspection.ok) {
    context.hooks?.onMessage?.(inspection.message);
    return undefined;
  }
  const projectDir = context.target.rootPath;
  const current = await buildSyncManifestFiles(projectDir, context.projectRoot);
  const base = context.manifest.files;
  const decision = await confirm({
    ...inspection.candidate,
    localEditsSinceBaseline: Object.keys(base).length > 0 ? countFiles(diffSyncFiles(base, current)) : undefined,
  });
  if (decision === 'cancel') {
    // До любой мутации: манифест и M остаются как были.
    throw new AgentSyncCancelledError();
  }
  if (decision === 'full') {
    return undefined;
  }
  await seedMirror(context, {
    configuration: path.join(projectDir, CONFIGURATION_XML),
    dumpInfo: path.join(projectDir, CONFIG_DUMP_INFO_XML),
  });
  context.hooks?.onMessage?.('Зеркало агента подготовлено из выгрузки проекта.');
  return current;
}

async function importChanges(
  context: SyncOperationContext,
  mirrorState: SyncMirrorState,
  assumedBase: Readonly<Record<string, string>> | undefined
): Promise<AgentImportResult> {
  const mirror = context.workspace.targetAgentDir;
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
  const coverage = context.mirror.coverage;
  const { owners, unresolved } = changeSet.kind === 'objects'
    ? resolveChangedOwners(changeSet.objects)
    : { owners: [], unresolved: [] };
  const ownerFiles = unresolved.length === 0 ? await collectOwnerFiles(context.store, mirror, owners) : undefined;
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
  const unrestorable = coverage === 'sparse' && new Set([...changedFiles, ...dirtyFiles]).size <= context.archiveThresholdFiles
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
    unrestorableDirtyFiles: unrestorable,
    archiveThresholdFiles: context.archiveThresholdFiles,
  });
  if (plan.action === 'archive') {
    return importByArchive(context, plan.reason);
  }
  return importByDelta(context, plan.files, inMirror, new Set(plan.deletableIfAbsent));
}

/** Файлы, которых нет в M: правку такого файла в разреженном M восстановить нечем. */
async function absentFromMirror(context: SyncOperationContext, rels: readonly string[]): Promise<string[]> {
  const prefix = `${context.workspace.targetAgentDir}/`;
  const entries = await Promise.all(rels.map((rel) => context.store.stat(prefix + rel)));
  return rels.filter((_rel, index) => entries[index]?.type !== 'file');
}

function countFiles(diff: SyncFilesDiff): number {
  return diff.added.length + diff.modified.length + diff.deleted.length;
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
  knownInMirror: ReadonlySet<string>,
  deletableIfAbsent: ReadonlySet<string>
): Promise<AgentImportResult> {
  const { store } = context;
  const prefix = `${context.workspace.targetAgentDir}/`;
  const present: string[] = [];
  for (const rel of files) {
    if (knownInMirror.has(rel) || (await store.stat(prefix + rel))?.type === 'file') {
      present.push(rel);
    }
  }
  const presentSet = new Set(present);
  const lost = files.filter((rel) => !presentSet.has(rel) && !deletableIfAbsent.has(rel));
  // План отдаёт неудаляемыми только файлы, проверенные STAT по M (правки неизменённых владельцев
  // уходят архивом); исчезнуть из M между той проверкой и этой файл может только при чужой записи
  // в M. Без границы такая гонка молча оставила бы P неверным; M после неё недостоверен.
  if (lost.length > 0) {
    context.markMirrorMutated();
    throw new Error(`Разреженное зеркало агента не содержит файлов, нужных импорту: ${lost.join(', ')}. Повторите импорт.`);
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
