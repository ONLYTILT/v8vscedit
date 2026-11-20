import * as fs from 'fs';
import { buildDumpConfigToFilesCommand } from '../../../domain/agent/AgentCommand';
import type { DumpChangedObject } from '../../../domain/agent/DumpChangesParser';
import { diffConfigDumpInfo, groupDumpInfoDiffByOwner, type DumpInfoOwnerChanges } from '../../xml/dumpInfo/ConfigDumpInfoDiff';
import { ConfigDumpInfoFormatError, removeConfigDumpInfoOwners } from '../../xml/dumpInfo/ConfigDumpInfoEditor';
import { parseConfigDumpInfoIndex, type ConfigDumpInfoIndex } from '../../xml/dumpInfo/ConfigDumpInfoIndex';
import { fetchChangeSet } from './ChangeSet';
import { resolveOwnerNames, type ChangedOwner } from './ChangedObjectFiles';
import { fetchFreshDumpInfo } from './FreshDumpInfo';
import { confirmFullDumpOrThrow, type FullDumpConsentContext } from './FullDumpConsent';
import { evidenceFromChangeObjects, evidenceFromDumpInfoNames, type RootPartEvidence } from './VendorConfigurationGate';
import { CONFIG_DUMP_INFO_XML, assertConfigurationPresent } from './ProjectFiles';
import { summarizeList } from './ProjectSeed';
import {
  EXCHANGE_CHANGES_RETRY_SUFFIX,
  throwIfCancelled,
  withTransferCancellation,
  type SyncOperationContext,
} from './SyncContext';
import { planBeforeUpdate, planPrune, verifyRetryChanges } from './SyncPlanner';

/**
 * Импорт при `FullDump` без полной выгрузки (plan-fulldump-avoid.md, ред. 2). `FullDump` значит: в файле
 * версий M есть записи, которых в базе нет (удалён или переименован объект, удалена его часть). Свежий
 * файл версий базы (`--config-dump-info-only`) показывает, какие именно; их владельцы целиком убираются
 * из M и его файла версий — повторный `--get-changes` видит их как `New` и выгружает заново (ФАКТ П3b).
 *
 * Запасной путь — перезапись M на сервере (`--update --force` при пропавших записях) с вопросом
 * `mirror-rewrite`: выгрузка долгая, но скачиваются только изменённые файлы, архива нет. Изменения после
 * перезаписи даёт сравнение файла версий M до и после.
 *
 * P здесь не трогается: результат — входы фазы 2 импорта, которая одна пишет в проект.
 */

/** Итог для фазы 2: M уже приведён к базе (`--update` выполнен, если был нужен). */
export interface FullDumpResolved {
  readonly kind: 'resolved';
  readonly handling: 'pruned' | 'mirror-rewrite';
  /** Владельцы, файлы которых фаза 2 сравнивает (из M) с P. */
  readonly owners: readonly ChangedOwner[];
  /** Владельцы из `owners`, отсутствие которых в M — не ошибка (см. `divergedOwners`). */
  readonly optionalOwners: ReadonlySet<string>;
  /** Имена, которые нельзя перевести в файлы: фаза 2 уходит в архив `unresolved-objects`. */
  readonly unresolved: readonly string[];
  /** Удалены в базе: их P-файлы удаляются без выгрузки и восстановления. */
  readonly removedOwners: readonly ChangedOwner[];
  /** Очищены целиком и выгружены заново: поддерево в M полное, отсутствие файла — удаление. */
  readonly reseatedOwners: readonly ChangedOwner[];
  /** Живые владельцы с пропавшими частями — для отчёта операции. */
  readonly replacedOwners: readonly string[];
  readonly updateKind: 'incremental' | 'rewrite';
  readonly rewriteOwnersWithRemovedParts: readonly string[];
  /**
   * Изменённые части корня для шлюза конфигурации поставщика: после очистки — по ПОВТОРНОМУ списку изменений,
   * после перезаписи M — по сравнению файла версий до и после.
   */
  readonly rootPartEvidence: RootPartEvidence;
}

export type FullDumpResolution =
  | { readonly kind: 'archive'; readonly reason: 'mirror-empty' | 'full-dump' | 'unrecognized' }
  | FullDumpResolved;

/** Что уже вычищено из M до перезаписи (сравнение «до/после» этих владельцев не увидит). */
interface PrunedOwners {
  readonly removed: readonly string[];
  readonly withParts: readonly string[];
}

const NOTHING_PRUNED: PrunedOwners = { removed: [], withParts: [] };
const OWNERS_SHOWN = 10;
const CDI_BEFORE = 'cdi-before.xml';
const CDI_EDITED = 'cdi-edited.xml';
const CDI_AFTER = 'cdi-after.xml';

export async function resolveFullDump(context: SyncOperationContext, consent: FullDumpConsentContext): Promise<FullDumpResolution> {
  const beforeText = await downloadMirrorDumpInfo(context, CDI_BEFORE);
  const mirrorIndex = parseConfigDumpInfoIndex(beforeText);
  if (mirrorIndex.header === undefined) {
    // Файл версий M неразборчив: сравнивать не с чем, а перезапись по нему — тоже вслепую.
    return { kind: 'archive', reason: 'full-dump' };
  }
  const fresh = await fetchFreshDumpInfo(context, mirrorIndex);
  if (!fresh.ok) {
    report(context, `Свежий файл версий базы не получен (${fresh.reason}): зеркало агента будет перезаписано на сервере.`);
    return rewriteMirror(context, consent, mirrorIndex, NOTHING_PRUNED);
  }
  const changes = groupDumpInfoDiffByOwner(diffConfigDumpInfo(mirrorIndex, fresh.index), mirrorIndex, fresh.index);
  const pruneNames = [...changes.removedOwners, ...changes.ownersWithRemovedParts];
  const { owners, unresolved } = resolveOwnerNames(pruneNames);
  const decision = planPrune({ freshDumpInfo: 'ok', changes, unresolved });
  if (decision === 'archive') {
    report(context, `В базе изменились владельцы неизвестного вида (${summarizeList(unresolved, OWNERS_SHOWN, ', ')}): импорт пойдёт полной выгрузкой.`);
    return { kind: 'archive', reason: 'full-dump' };
  }
  if (decision === 'rewrite-mirror') {
    report(context, `Очистка зеркала по файлу версий невозможна (${pruneObstacle(changes)}): зеркало агента будет перезаписано на сервере.`);
    return rewriteMirror(context, consent, mirrorIndex, NOTHING_PRUNED);
  }
  let editedText: string;
  try {
    editedText = removeConfigDumpInfoOwners(beforeText, pruneNames).text;
  } catch (error) {
    if (error instanceof ConfigDumpInfoFormatError) {
      report(context, `Файл версий зеркала не правится (${error.message}): зеркало агента будет перезаписано на сервере.`);
      return rewriteMirror(context, consent, mirrorIndex, NOTHING_PRUNED);
    }
    /* c8 ignore start -- другой отказ редактора — корень среди владельцев, а его отсекает planPrune. */
    throw error;
  }
  /* c8 ignore stop */
  // Каталог обмена операции — не выгрузка: файл читает только закачка ниже, обрыв убирает каталог целиком.
  const editedPath = await context.localExchange.file(CDI_EDITED);
  await fs.promises.writeFile(editedPath, editedText);

  throwIfCancelled(context);
  report(context, pruneMessage(changes));
  await pruneMirror(context, owners, editedPath);
  return afterPrune(context, consent, changes, parseConfigDumpInfoIndex(editedText));
}

/**
 * Блок мутации M без отмены (Р8): после первой правки M уже не соответствует B, и обрыв переводит
 * манифест в `empty`. Файл версий — последним: пока он прежний, агент помнит владельцев, и M
 * остаётся согласованным с ним хотя бы в сторону «лишних» записей.
 */
async function pruneMirror(context: SyncOperationContext, owners: readonly ChangedOwner[], editedPath: string): Promise<void> {
  const { store } = context;
  const mirror = context.workspace.targetAgentDir;
  context.markMirrorMutated();
  const counter = context.progress.counter(
    (done, total) => `Очистка зеркала: объектов ${String(done)} из ${String(total)}`, owners.length);
  for (const owner of owners) {
    await store.remove(`${mirror}/${owner.xmlRel}`);
    await store.remove(`${mirror}/${owner.dirRel}`, { recursive: true });
    counter.advance();
  }
  counter.finish();
  // Закачка хранилища — временный файл и подмена (temp+rename): обрыв не оставляет файл версий наполовину.
  // Исключение — SFTP-режим `direct` (сервер без RENAME поверх файла): там запись идёт прямо в цель, и
  // обрыв может оставить файл версий неполным; это покрывает пометка `markMirrorMutated` выше —
  // следующий импорт идёт полным путём, не доверяя M.
  await store.uploadFromFile(editedPath, `${mirror}/${CONFIG_DUMP_INFO_XML}`);
}

/** Повторный список после очистки — источник истины и сверка допущения Р3 (Р4). */
async function afterPrune(
  context: SyncOperationContext,
  consent: FullDumpConsentContext,
  changes: DumpInfoOwnerChanges,
  editedIndex: ConfigDumpInfoIndex
): Promise<FullDumpResolution> {
  const pruned: PrunedOwners = { removed: changes.removedOwners, withParts: changes.ownersWithRemovedParts };
  const changeSet = await fetchChangeSet(context, EXCHANGE_CHANGES_RETRY_SUFFIX);
  throwIfCancelled(context);
  const plan = planBeforeUpdate({ mirrorState: 'fresh', changeSet, fullDumpAvoidance: true, fullDumpStage: 'after-prune' });
  if (plan.action === 'archive') {
    // При непустом M и включённой очистке это только `unrecognized`: архив засеет M заново.
    return { kind: 'archive', reason: plan.reason };
  }
  // На повторном списке `FullDump` даёт только `rewrite-mirror` (`prune` — для первого).
  if (plan.action !== 'update' && plan.action !== 'skip-update') {
    report(context, 'Агент снова сообщил FullDump после очистки зеркала: зеркало будет перезаписано на сервере.');
    return rewriteMirror(context, consent, editedIndex, pruned);
  }
  const listed = new Set(ownerNamesOf(plan.objects));
  // Самокоррекция Р6: «удалённый», которого база вернула в списке, — живой. Его записи тоже вычищены из
  // файла версий M, поэтому и он обязан прийти строкой `New: <владелец>`, как владелец с удалённой частью.
  const removed = changes.removedOwners.filter((owner) => !listed.has(owner));
  const revived = changes.removedOwners.filter((owner) => listed.has(owner));
  const verification = verifyRetryChanges(plan.objects, [...changes.ownersWithRemovedParts, ...revived]);
  if (!verification.ok) {
    report(context, `После очистки зеркала агент не сообщил New для ${summarizeList(verification.missingNew, OWNERS_SHOWN, ', ')}: зеркало будет перезаписано на сервере.`);
    return rewriteMirror(context, consent, editedIndex, pruned);
  }
  if (plan.action === 'update') {
    context.progress.step('Обновление зеркала агента на сервере…');
    await context.exec.execute(buildDumpConfigToFilesCommand(context.workspace.targetAgentDir, {
      extensionName: context.extensionName,
      update: true,
      force: true,
    }));
  }
  const diverged = divergedOwners(listed, changes);
  if (diverged.length > 0) {
    report(context, `Повторный список изменений не содержит владельцев из сравнения файлов версий: ${summarizeList(diverged, OWNERS_SHOWN, ', ')}.`);
  }
  return resolved(context, {
    handling: 'pruned',
    ownerNames: [...listed, ...changes.changedOwners.map((owner) => owner.fullName), ...changes.ownersWithRemovedParts],
    optional: diverged,
    removed,
    reseated: [...changes.ownersWithRemovedParts, ...revived],
    replaced: changes.ownersWithRemovedParts,
    updateKind: 'incremental',
    rewriteOwnersWithRemovedParts: [],
    rootPartEvidence: evidenceFromChangeObjects(plan.objects),
  });
}

/**
 * Запасной путь (Р10): вопрос `mirror-rewrite` → `--update --force` (сервер переписывает M) → сравнение
 * файла версий M до и после. `beforeIndex` — файл версий M перед перезаписью (после очистки — уже
 * исправленный), поэтому очищенные владельцы сравнение не покажет: они учитываются по `pruned`.
 */
async function rewriteMirror(
  context: SyncOperationContext,
  consent: FullDumpConsentContext,
  beforeIndex: ConfigDumpInfoIndex,
  pruned: PrunedOwners
): Promise<FullDumpResolution> {
  await confirmFullDumpOrThrow(context, 'mirror-rewrite', consent);
  const mirror = context.workspace.targetAgentDir;
  context.progress.step('Перезапись зеркала агента на сервере (долго)…');
  context.markMirrorMutated();
  await context.exec.execute(buildDumpConfigToFilesCommand(mirror, {
    extensionName: context.extensionName,
    update: true,
    force: true,
  }));
  throwIfCancelled(context);
  const afterIndex = parseConfigDumpInfoIndex(await downloadMirrorDumpInfo(context, CDI_AFTER));
  const diff = diffConfigDumpInfo(beforeIndex, afterIndex);
  const changes = groupDumpInfoDiffByOwner(diff, beforeIndex, afterIndex);
  assertConfigurationPresent(!changes.configurationMissing, `файле версий зеркала "${mirror}"`);
  const alive = afterIndex.rootNames;
  const prunedAll = [...pruned.removed, ...pruned.withParts];
  const reseated = prunedAll.filter((owner) => alive.has(owner));
  return resolved(context, {
    handling: 'mirror-rewrite',
    ownerNames: [...changes.changedOwners.map((owner) => owner.fullName), ...changes.ownersWithRemovedParts, ...reseated],
    // После перезаписи M равен базе: «лишних» владельцев нет, сравнение M до/после точное.
    optional: [],
    removed: [...changes.removedOwners, ...prunedAll.filter((owner) => !alive.has(owner))],
    reseated,
    replaced: [...pruned.withParts.filter((owner) => alive.has(owner)), ...changes.ownersWithRemovedParts],
    updateKind: 'rewrite',
    rewriteOwnersWithRemovedParts: changes.ownersWithRemovedParts,
    rootPartEvidence: evidenceFromDumpInfoNames(diff),
  });
}

interface ResolvedNames {
  readonly handling: FullDumpResolved['handling'];
  readonly ownerNames: readonly string[];
  /** Владельцы только из сравнения файлов версий (их нет в повторном списке): отсутствие в M не ошибка. */
  readonly optional: readonly string[];
  readonly removed: readonly string[];
  readonly reseated: readonly string[];
  readonly replaced: readonly string[];
  readonly updateKind: FullDumpResolved['updateKind'];
  readonly rewriteOwnersWithRemovedParts: readonly string[];
  readonly rootPartEvidence: RootPartEvidence;
}

/** Имена → файлы: одна таблица «вид → папка» (META_TYPES) через `resolveOwnerNames`. */
function resolved(context: SyncOperationContext, names: ResolvedNames): FullDumpResolved {
  const owners = resolveOwnerNames(unique(names.ownerNames));
  const removed = resolveOwnerNames(unique(names.removed));
  const removedNames = removed.owners.map((owner) => owner.fullName);
  if (removedNames.length > 0) {
    report(context, `Удалены в базе: ${summarizeList(removedNames, OWNERS_SHOWN, ', ')} — их файлы будут удалены из проекта.`);
  }
  return {
    kind: 'resolved',
    handling: names.handling,
    owners: owners.owners,
    optionalOwners: new Set(names.optional),
    unresolved: [...owners.unresolved, ...removed.unresolved],
    removedOwners: removed.owners,
    reseatedOwners: resolveOwnerNames(unique(names.reseated)).owners,
    replacedOwners: unique(names.replaced),
    updateKind: names.updateKind,
    rewriteOwnersWithRemovedParts: names.rewriteOwnersWithRemovedParts,
    rootPartEvidence: names.rootPartEvidence,
  };
}

async function downloadMirrorDumpInfo(context: SyncOperationContext, localName: string): Promise<string> {
  const localPath = await context.localExchange.file(localName);
  const cancellation = context.hooks?.cancellation;
  await withTransferCancellation(() =>
    context.store.downloadToFile(`${context.workspace.targetAgentDir}/${CONFIG_DUMP_INFO_XML}`, localPath, { cancellation }));
  throwIfCancelled(context);
  return fs.promises.readFile(localPath, 'utf-8');
}

/** Владельцы строк списка изменений: `Document.Заказ.Template.Макет` → `Document.Заказ`. */
function ownerNamesOf(objects: readonly DumpChangedObject[]): string[] {
  return unique(objects.map((object) => `${object.kind}.${object.name}`));
}

/**
 * Владельцы сравнения файлов версий, которых нет в повторном списке. Это не ошибка: список — источник
 * истины, а владельцы фазы 2 — объединение. Но это признак гонки с изменением базы или иной логики
 * агента — в журнал. В разреженном M такого владельца может не быть вовсе: он только сравнивается, а не
 * требуется (иначе гонка превращала бы дельту в архив `unresolved-objects`).
 */
function divergedOwners(listed: ReadonlySet<string>, changes: DumpInfoOwnerChanges): string[] {
  const expected = [...changes.changedOwners.map((owner) => owner.fullName), ...changes.ownersWithRemovedParts];
  return unique(expected.filter((owner) => !listed.has(owner)));
}

function pruneMessage(changes: DumpInfoOwnerChanges): string {
  const parts = [
    ...(changes.removedOwners.length > 0
      ? [`удалённые в базе — ${summarizeList([...changes.removedOwners], OWNERS_SHOWN, ', ')}`]
      : []),
    ...(changes.ownersWithRemovedParts.length > 0
      ? [`выгружаются заново — ${summarizeList([...changes.ownersWithRemovedParts], OWNERS_SHOWN, ', ')}`]
      : []),
  ];
  return `Агент сообщил FullDump: зеркало очищается по свежему файлу версий базы (${parts.join('; ')}).`;
}

/** Причину отказа решает `planPrune`; в журнал — набор, по которому решение принято. */
function pruneObstacle(changes: DumpInfoOwnerChanges): string {
  const listed = (items: readonly string[]): string => summarizeList([...items], OWNERS_SHOWN, ', ') || 'нет';
  return `удалённые: ${listed(changes.removedOwners)}; с удалёнными частями: ${listed(changes.ownersWithRemovedParts)}`;
}

function report(context: SyncOperationContext, message: string): void {
  context.hooks?.onMessage?.(message);
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)].sort();
}
