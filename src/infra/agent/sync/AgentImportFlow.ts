import { buildDumpConfigToFilesCommand } from '../../../domain/agent/AgentCommand';
import type { DumpChangeSet } from '../../../domain/agent/DumpChangesParser';
import { downloadFiles, statFiles } from '../files/AgentFileTransfer';
import { importByArchive } from './ArchiveImport';
import { fetchChangeSet } from './ChangeSet';
import { confirmFullDumpOrThrow, type FullDumpConsentContext } from './FullDumpConsent';
import { resolveFullDump } from './FullDumpAvoidance';
import { collectOwnerFiles, resolveChangedOwners, type ChangedOwner, type OwnerFilesResult } from './ChangedObjectFiles';
import { caseCollisions, importByDelta } from './DeltaImport';
import { MIRROR_MTIME_SELECTION_ENABLED, takeMirrorMarker, type MirrorMarker } from './MirrorChangeWindow';
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
  EXCHANGE_CHANGES_SUFFIX,
  throwIfCancelled,
  transferOptionsOf,
  withTransferCancellation,
  type SyncOperationContext,
} from './SyncContext';
import {
  buildSyncManifestFiles,
  diffSyncFiles,
  type SyncMirrorCoverage,
  type SyncMirrorState,
} from './SyncManifest';
import {
  FULL_DUMP_AVOIDANCE_BY_TARGET,
  planBeforeUpdate,
  planRemoteImport,
  type ImportArchiveReason,
} from './SyncPlanner';

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
  /** Как снят `FullDump` без архива (plan-fulldump-avoid.md); нет — FullDump в операции не было. */
  readonly fullDump?: AgentFullDumpHandling;
}

export interface AgentFullDumpHandling {
  /** `pruned` — очистка зеркала по свежему файлу версий; `mirror-rewrite` — перезапись зеркала на сервере. */
  readonly handling: 'pruned' | 'mirror-rewrite';
  /** Владельцы, удалённые в базе (их файлы удалены из проекта), по имени. */
  readonly removedOwners: string[];
  /** Живые владельцы с удалёнными частями, выгруженные заново, по имени. */
  readonly replacedOwners: string[];
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
  const counter = context.progress.counter(
    (done, total) => `Сравнение зеркала с проектом: ${String(done)} из ${String(total)}`, mirrorFiles.length);
  await downloadFiles(store, mirrorFiles.map((rel) => prefix + rel), (agentRel, data) => {
    counter.advance();
    const rel = agentRel.slice(prefix.length);
    if (!hasSameProjectContent(projectDir, rel, data)) {
      changed.push(rel);
    }
  }, transferOptionsOf(context));
  counter.finish();
  throwIfCancelled(context);

  const inMirror = new Set(mirrorFiles);
  const deletes = listProjectFiles(projectDir).filter((rel) => !inMirror.has(rel));
  const sameFileAsDeleted = caseCollisions(deletes);
  const changedSet = new Set(changed);
  const changedProjectFiles = await applyProjectChanges({
    projectDir,
    writes: [...changed, ...mirrorFiles.filter((rel) => !changedSet.has(rel) && sameFileAsDeleted(rel))],
    deletes,
    // Второй проход без отмены: запись в проект, начавшись, доводится до конца.
    read: (rels, sink) => downloadFiles(store, rels.map((rel) => prefix + rel), (agentRel, data) =>
      sink(agentRel.slice(prefix.length), data), { concurrency: context.transferConcurrency }),
    onWillChange: context.hooks?.onProjectFilesWillChange,
    onProgress: context.progress,
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
    // Без хука посева seedFromProject всё равно вернул бы `skipped` — sha1 файла версий (десятки МБ)
    // не считается зря.
    if (context.hooks?.confirmMirrorSeed !== undefined
      && await isProjectDumpReplaced(context.target.rootPath, context.manifest.projectDumpInfo)) {
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
    await confirmFullDumpOrThrow(context, 'mirror-empty', 'import');
  }
  context.markMirrorMutated();
  await context.store.remove(context.workspace.targetAgentDir, { recursive: true });
  return importByArchive(context, 'mirror-empty', 'confirmed');
}

/** Импорт после посева из выгрузки проекта: D = ∅ относительно hash(P), затем поиск сирот. */
async function importSeeded(context: SyncOperationContext, base: Record<string, string>): Promise<AgentImportResult> {
  const { result, changedOwners } = await importChanges(context, 'fresh', base, { afterSeed: true });
  // Архив сам удаляет из P всё, чего нет в базе: сирот после него не бывает.
  const orphans = result.strategy === 'archive' ? undefined : await findOrphans(context, changedOwners);
  return { ...withOrphans(result, orphans), seededFrom: 'project' };
}

function findOrphans(context: SyncOperationContext, changedOwners: ReadonlySet<string>): Promise<OrphanFilesOutcome | undefined> {
  context.progress.step('Поиск осиротевших файлов выгрузки проекта…');
  return handleOrphans(context, changedOwners);
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

/** Входы фазы 2: M уже приведён к базе, осталось сравнить владельцев с P и записать разницу. */
interface ChangesPhase2 {
  /** Для повторной проверки фазы 1 в `planRemoteImport`: FullDump к этому моменту уже снят. */
  readonly changeSet: DumpChangeSet;
  readonly owners: readonly ChangedOwner[];
  /** Владельцы из `owners`, которых может не быть в M (только сравниваются, не требуются). */
  readonly optionalOwners: ReadonlySet<string>;
  readonly unresolved: readonly string[];
  readonly removedOwners: readonly ChangedOwner[];
  readonly reseatedOwners: readonly ChangedOwner[];
  readonly updateKind: 'incremental' | 'rewrite';
  readonly rewriteOwnersWithRemovedParts: readonly string[];
  readonly fullDump?: AgentFullDumpHandling;
  /** Метка времени сервера до первой мутации M (`undefined` — отбор по времени не применяется). */
  readonly marker: MirrorMarker | undefined;
}

async function importChanges(
  context: SyncOperationContext,
  mirrorState: SyncMirrorState,
  assumedBase: Readonly<Record<string, string>> | undefined,
  options: { readonly afterSeed?: boolean } = {}
): Promise<ChangesOutcome> {
  // После посева отказ от выгрузки означает другое: зеркало уже подготовлено, ручная выгрузка не нужна.
  const consent: FullDumpConsentContext = options.afterSeed === true ? 'import-after-seed' : 'import';
  // Метка — ПЕРВОЙ операцией импорта, до любой мутации M (`--update`, очистка, перезапись): всё, что
  // операция перепишет в M, получит время не раньше неё. Мутации M в импорте — только после этой строки.
  const marker = await takeMarker(context);
  const changeSet = await fetchChangeSet(context, EXCHANGE_CHANGES_SUFFIX);
  // `--get-changes` M не меняет: отмена здесь оставляет манифест прежним, без переподготовки зеркала.
  throwIfCancelled(context);
  // `--get-changes` вместе с `--update` только пишет список (пилот §5b п.4): M обновляется вторым
  // шагом. Нераспознанный список (и FullDump без очистки — цель cfe) уходит в архив ДО него — иначе
  // вторая полная выгрузка.
  const before = planBeforeUpdate({
    mirrorState,
    changeSet,
    fullDumpAvoidance: FULL_DUMP_AVOIDANCE_BY_TARGET[context.target.kind],
    fullDumpStage: 'initial',
  });
  if (before.action === 'archive') {
    return { result: await importByArchive(context, before.reason, consent), changedOwners: new Set() };
  }
  if (before.action !== 'update' && before.action !== 'skip-update') {
    // FullDump на первом списке — всегда `prune`: очистка зеркала по свежему файлу версий базы.
    const resolution = await resolveFullDump(context, consent);
    if (resolution.kind === 'archive') {
      return { result: await importByArchive(context, resolution.reason, consent), changedOwners: new Set() };
    }
    return importPhase2(context, mirrorState, assumedBase, consent, {
      changeSet: RESOLVED_CHANGE_SET,
      owners: resolution.owners,
      optionalOwners: resolution.optionalOwners,
      unresolved: resolution.unresolved,
      removedOwners: resolution.removedOwners,
      reseatedOwners: resolution.reseatedOwners,
      updateKind: resolution.updateKind,
      rewriteOwnersWithRemovedParts: resolution.rewriteOwnersWithRemovedParts,
      fullDump: {
        handling: resolution.handling,
        removedOwners: resolution.removedOwners.map((owner) => owner.fullName).sort(),
        replacedOwners: [...resolution.replacedOwners].sort(),
      },
      marker,
    });
  }
  if (before.action === 'update') {
    context.progress.step('Обновление зеркала агента на сервере…');
    context.markMirrorMutated();
    await context.exec.execute(buildDumpConfigToFilesCommand(context.workspace.targetAgentDir, {
      extensionName: context.extensionName,
      update: true,
      force: true,
    }));
  }
  const { owners, unresolved } = resolveChangedOwners(before.objects);
  return importPhase2(context, mirrorState, assumedBase, consent, {
    changeSet,
    owners,
    optionalOwners: new Set(),
    unresolved,
    removedOwners: [],
    reseatedOwners: [],
    updateKind: 'incremental',
    rewriteOwnersWithRemovedParts: [],
    marker,
  });
}

function takeMarker(context: SyncOperationContext): Promise<MirrorMarker | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- выключатель меняется правкой константы
  return MIRROR_MTIME_SELECTION_ENABLED
    ? takeMirrorMarker(context)
    /* c8 ignore start -- ветка «выключено» нужна только на случай, если стенд опровергнет Э23; константа
       включена, и тестами ветка недостижима. */
    : Promise.resolve(undefined);
  /* c8 ignore stop */
}

/** Фаза 1 после снятого FullDump: объекты уже учтены владельцами, повторный архив фазы 1 невозможен. */
const RESOLVED_CHANGE_SET: DumpChangeSet = { kind: 'objects', objects: [] };

async function importPhase2(
  context: SyncOperationContext,
  mirrorState: SyncMirrorState,
  assumedBase: Readonly<Record<string, string>> | undefined,
  consent: FullDumpConsentContext,
  input: ChangesPhase2
): Promise<ChangesOutcome> {
  const projectDir = context.target.rootPath;
  const coverage = context.mirror.coverage;
  const { owners, unresolved } = input;
  const changedOwners = new Set(owners.map((owner) => owner.fullName));
  const ownerFiles = unresolved.length === 0 ? await listOwnerFiles(context, owners) : undefined;
  const inMirror = new Set(ownerFiles?.files ?? []);
  const mirrorEntries = ownerFiles?.entries;
  // Владелец изменения, которого нет в M даже после второго шага, — признак неверного перевода
  // строки в путь (вложенная подсистема и т.п.): дельта молча пропустила бы его, архив — нет.
  const missingOwners = (ownerFiles?.missingOwners ?? [])
    .map((owner) => owner.fullName)
    .filter((owner) => !input.optionalOwners.has(owner));
  // `--update` пишет только изменившиеся файлы владельца: при разреженном M файлы владельца в P,
  // которых нет в M, — не удалённые в базе, а просто не выгруженные, и кандидатами быть не могут.
  const changedFiles = coverage === 'sparse'
    ? [...inMirror]
    : [...new Set([...inMirror, ...owners.flatMap((owner) => projectOwnerFiles(projectDir, owner))])];
  // Удалённых в базе владельцев в M нет ни при какой полноте: их файлы P удаляются без STAT по M.
  const removedOwnerFiles = input.removedOwners.flatMap((owner) => projectOwnerFiles(projectDir, owner));
  const removed = new Set(removedOwnerFiles);
  context.progress.step('Проверка локальных изменений проекта…');
  const base = assumedBase ?? context.manifest.files;
  const dirty = diffSyncFiles(base, await buildSyncManifestFiles(projectDir, context.projectRoot));
  const dirtyFiles = [...dirty.added, ...dirty.modified, ...dirty.deleted];
  // Сверх порога план и так даст архив — лишние STAT по M не нужны; после перезаписи порога нет.
  const dirtyAbsentFromMirror = coverage === 'sparse'
    && (input.updateKind === 'rewrite' || new Set([...changedFiles, ...dirtyFiles]).size <= context.archiveThresholdFiles)
    ? await absentFromMirror(context, [...dirty.modified, ...dirty.deleted].filter((rel) => !inMirror.has(rel) && !removed.has(rel)))
    : [];
  const plan = planRemoteImport({
    mirrorState,
    changeSet: input.changeSet,
    changedFiles,
    unresolvedObjects: [...unresolved, ...missingOwners],
    dirtyFiles,
    mirrorCoverage: coverage,
    dirtyAddedFiles: dirty.added,
    dirtyAbsentFromMirror,
    archiveThresholdFiles: context.archiveThresholdFiles,
    fullDumpAvoidance: FULL_DUMP_AVOIDANCE_BY_TARGET[context.target.kind],
    fullDumpStage: 'initial',
    removedOwnerFiles,
    replacedOwnerFiles: input.reseatedOwners.flatMap((owner) => projectOwnerFiles(projectDir, owner)),
    updateKind: input.updateKind,
    rewriteOwnersWithRemovedParts: input.rewriteOwnersWithRemovedParts,
  });
  if (plan.action === 'archive') {
    return { result: await importByArchive(context, plan.reason, consent), changedOwners };
  }
  const deletable = new Set(plan.deletableIfAbsent);
  const restore = plan.restoreFromDatabase;
  const withFullDump = (result: AgentImportResult): AgentImportResult =>
    (input.fullDump === undefined ? result : { ...result, fullDump: input.fullDump });
  const delta = {
    files: plan.files,
    knownInMirror: inMirror,
    deletableIfAbsent: deletable,
    knownAbsent: removed,
    mirrorEntries,
    marker: input.marker,
    dirtyFiles: new Set(dirtyFiles),
    base,
    expectRewrites: owners.length > 0,
    updateKind: input.updateKind,
  };
  if (restore.length === 0) {
    return { result: withFullDump(await importByDelta(context, delta)), changedOwners };
  }
  context.hooks?.onMessage?.(`Точечная выгрузка из базы локально изменённых файлов: ${String(restore.length)}.`);
  const restored = await restoreFromDatabase(context, restore);
  if (!restored.ok) {
    // Текст агента бывает многострочным: сообщение журнала — одна строка.
    const reason = restored.reason.replace(/\s+/g, ' ').trim();
    context.hooks?.onMessage?.(`Точечная выгрузка не удалась (${reason}): импорт пойдёт полной выгрузкой.`);
    return { result: await importByArchive(context, 'sparse-mirror-dirty', consent), changedOwners };
  }
  const source = { dir: restored.sourceDir, files: new Set(restore) };
  const result = await importByDelta(context, { ...delta, restore: source });
  return { result: { ...withFullDump(result), restoredFromDatabase: restore.length }, changedOwners };
}

/** Файлы владельцев в M (LIST поддеревьев) со счётчиком просмотра. */
async function listOwnerFiles(context: SyncOperationContext, owners: readonly ChangedOwner[]): Promise<OwnerFilesResult> {
  const counter = context.progress.counter(
    (done, total) => `Просмотр зеркала: объектов ${String(done)} из ${String(total)}`, owners.length);
  const result = await withTransferCancellation(() => collectOwnerFiles(context.store, context.workspace.targetAgentDir, owners, {
    ...transferOptionsOf(context),
    onProgress: () => { counter.advance(); },
  }));
  counter.finish();
  return result;
}

/** Файлы, которых нет в M: правку такого файла в разреженном M берёт точечная выгрузка из базы. */
async function absentFromMirror(context: SyncOperationContext, rels: readonly string[]): Promise<string[]> {
  const prefix = `${context.workspace.targetAgentDir}/`;
  const counter = context.progress.counter(
    (done, total) => `Проверка файлов зеркала: ${String(done)} из ${String(total)}`, rels.length);
  const entries = await statFiles(context.store, rels.map((rel) => prefix + rel), {
    ...transferOptionsOf(context),
    onProgress: () => { counter.advance(); },
  });
  counter.finish();
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

/** Файлы владельца в P: XML и всё поддерево — то, что в M могло исчезнуть. */
function projectOwnerFiles(projectDir: string, owner: ChangedOwner): string[] {
  const files = projectFileExists(projectDir, owner.xmlRel) ? [owner.xmlRel] : [];
  return [...files, ...listProjectFiles(projectDir, owner.dirRel)];
}
