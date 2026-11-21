import * as path from 'path';
import type { AgentMirrorSeedReason } from '../AgentOperationService';
import { readConfigDumpInfoIndex, type ConfigDumpInfoIndex } from '../../xml/dumpInfo/ConfigDumpInfoIndex';
import { ownerOfProjectFile } from './ChangedObjectFiles';
import { inspectProjectMirrorSeed, seedMirror } from './MirrorSeed';
import { CONFIG_DUMP_INFO_XML, CONFIGURATION_XML, applyProjectChanges, listProjectFiles } from './ProjectFiles';
import { AgentSyncCancelledError, type SyncOperationContext } from './SyncContext';
import { buildSyncManifestFiles, diffSyncFiles, type SyncFilesDiff } from './SyncManifest';

/**
 * Посев M из выгрузки проекта и «осиротевшие» файлы после него (план «полная выгрузка — только когда
 * без неё нельзя», §3.7). Посев — только с согласия пользователя: файл версий проекта описывает базу на
 * момент выгрузки, и ручные правки XML после неё импорт не перезапишет.
 */

/**
 * Исход вопроса о посеве: `seeded` — M засеян, `base` — B, от которой считаются локальные правки
 * (= hash(P): правки после выгрузки не перетираются, как обещано в вопросе); `full` — пользователь
 * выбрал вторую кнопку («Полная выгрузка» / «Обычный импорт»); `skipped` — вопроса не было (нет хука,
 * выгрузка непригодна).
 */
export type ProjectSeedOutcome =
  | { readonly kind: 'seeded'; readonly base: Record<string, string> }
  | { readonly kind: 'full' }
  | { readonly kind: 'skipped' };

export async function seedFromProject(context: SyncOperationContext, reason: AgentMirrorSeedReason): Promise<ProjectSeedOutcome> {
  const confirm = context.hooks?.confirmMirrorSeed;
  if (confirm === undefined) {
    return { kind: 'skipped' };
  }
  const inspection = inspectProjectMirrorSeed(context.target, context.extensionName);
  if (!inspection.ok) {
    context.hooks?.onMessage?.(inspection.message);
    return { kind: 'skipped' };
  }
  const projectDir = context.target.rootPath;
  const current = await buildSyncManifestFiles(projectDir, context.projectRoot, context.hashScan);
  const base = context.manifest.files;
  const decision = await confirm({
    ...inspection.candidate,
    reason,
    localEditsSinceBaseline: Object.keys(base).length > 0 ? countFiles(diffSyncFiles(base, current)) : undefined,
  });
  if (decision === 'cancel') {
    // До любой мутации: манифест и M остаются как были.
    throw new AgentSyncCancelledError();
  }
  if (decision === 'full') {
    return { kind: 'full' };
  }
  await seedMirror(context, {
    configuration: path.join(projectDir, CONFIGURATION_XML),
    dumpInfo: path.join(projectDir, CONFIG_DUMP_INFO_XML),
  });
  context.hooks?.onMessage?.('Зеркало агента подготовлено из выгрузки проекта.');
  return { kind: 'seeded', base: current };
}

/**
 * Файлы P, чьих владельцев нет ни в файле версий проекта (из него засеян M), ни среди владельцев
 * списка изменений операции (созданные в базе после ручной выгрузки пришли дельтой, в CDI проекта их
 * нет). Это объекты, удалённые в базе до ручной выгрузки, сделанной поверх прежней без очистки. Корень
 * конфигурации и файлы вне известных папок не трогаются. Пути — относительные, каждый один раз.
 */
export function findOrphanProjectFiles(
  projectDir: string,
  index: ConfigDumpInfoIndex,
  changedOwners: ReadonlySet<string>
): string[] {
  return collectOrphans(projectDir, index, changedOwners).map((orphan) => orphan.rel);
}

function collectOrphans(
  projectDir: string,
  index: ConfigDumpInfoIndex,
  changedOwners: ReadonlySet<string>
): { readonly rel: string; readonly owner: string }[] {
  const orphans: { rel: string; owner: string }[] = [];
  for (const rel of listProjectFiles(projectDir)) {
    const owner = ownerOfProjectFile(rel);
    if (owner !== undefined && 'fullName' in owner && !index.rootNames.has(owner.fullName) && !changedOwners.has(owner.fullName)) {
      orphans.push({ rel, owner: owner.fullName });
    }
  }
  return orphans;
}

/**
 * Первые `limit` элементов через `separator` и «и ещё N» сверх них: общий формат перечня владельцев-сирот
 * для журнала и для вопроса пользователю (длинный перечень в модальном окне нечитаем).
 */
export function summarizeList(items: readonly string[], limit: number, separator: string): string {
  const rest = items.length - limit;
  return [items.slice(0, limit).join(separator), ...(rest > 0 ? [`и ещё ${String(rest)}`] : [])].join(separator);
}

export interface OrphanFilesOutcome {
  readonly owners: string[];
  readonly files: string[];
  readonly removed: boolean;
  /** Абсолютные пути удалённых файлов (для общего списка изменённых файлов импорта). */
  readonly changedProjectFiles: string[];
}

const ORPHAN_OWNERS_SHOWN = 20;

/**
 * Поиск и обработка сирот после посева из выгрузки проекта: удаление — только по согласию
 * (`confirmOrphanRemoval`), иначе сообщение. Вызывается до расчёта B: удалённые сироты в неё не попадают.
 */
export async function handleOrphans(
  context: SyncOperationContext,
  changedOwners: ReadonlySet<string>
): Promise<OrphanFilesOutcome | undefined> {
  const projectDir = context.target.rootPath;
  const index = await readConfigDumpInfoIndex(path.join(projectDir, CONFIG_DUMP_INFO_XML));
  /* c8 ignore start -- посев выше уже прочитал и проверил этот же файл версий; исчезнуть он может только при чужой записи в P посреди операции */
  if (index === undefined) {
    return undefined;
  }
  /* c8 ignore stop */
  const orphans = collectOrphans(projectDir, index, changedOwners);
  if (orphans.length === 0) {
    return undefined;
  }
  const files = orphans.map((orphan) => orphan.rel).sort();
  const owners = [...new Set(orphans.map((orphan) => orphan.owner))].sort();
  const confirm = context.hooks?.confirmOrphanRemoval;
  const removed = confirm !== undefined
    && await confirm({ targetName: context.extensionName ?? context.target.name, owners, files });
  if (!removed) {
    context.hooks?.onMessage?.(
      `В выгрузке проекта есть файлы объектов, которых нет в базе (${String(owners.length)} ${objectsWord(owners.length)}): ` +
      `${summarizeList(owners, ORPHAN_OWNERS_SHOWN, ', ')}. Файлы оставлены в проекте.`
    );
    return { owners, files, removed: false, changedProjectFiles: [] };
  }
  const changedProjectFiles = await applyProjectChanges({
    projectDir,
    writes: [],
    deletes: files,
    read: () => Promise.resolve(),
    onWillChange: context.hooks?.onProjectFilesWillChange,
  });
  return { owners, files, removed: true, changedProjectFiles };
}

const OBJECT_WORDS: Readonly<Record<Intl.LDMLPluralRule, string>> = {
  zero: 'объектов',
  one: 'объект',
  two: 'объекта',
  few: 'объекта',
  many: 'объектов',
  other: 'объекта',
};
const RUSSIAN_PLURAL = new Intl.PluralRules('ru-RU');

/** «объект / объекта / объектов» по числу — правилами ICU, а не своими ветками по последней цифре. */
function objectsWord(count: number): string {
  return OBJECT_WORDS[RUSSIAN_PLURAL.select(count)];
}

function countFiles(diff: SyncFilesDiff): number {
  return diff.added.length + diff.modified.length + diff.deleted.length;
}
