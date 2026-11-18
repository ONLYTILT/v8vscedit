import type { DumpChangeSet } from '../../../domain/agent/DumpChangesParser';
import { detectPotentialRename } from '../ConfigLoadFileCollector';
import { diffSyncFiles, type SyncMirrorCoverage, type SyncMirrorState } from './SyncManifest';

/**
 * Чистый планировщик синхронизации цели с агентом (таблицы плана §1.1). Решает только «что делать»
 * по данным; команды агента, передача файлов и запись в проект — забота движка.
 *
 * Локальное хранилище работает стратегией полного сравнения M и P: хэширование локально дёшево,
 * а разбор `--get-changes` и архив дали бы регресс там, где формат списка ещё не подтверждён.
 */

export type SyncStoreKind = 'local' | 'sftp';

export interface ImportPlanInput {
  readonly storeKind: SyncStoreKind;
  readonly mirrorState: SyncMirrorState;
  /** Разбор `--get-changes`; для sftp с непустым M обязателен. */
  readonly changeSet?: DumpChangeSet;
  /** C — файлы проекта, сопоставленные объектам списка изменений. */
  readonly changedFiles: readonly string[];
  /** Объекты списка, которые не удалось перевести в файлы. */
  readonly unresolvedObjects: readonly string[];
  /** D — локальные правки P относительно B, которые импорт обязан перетереть. */
  readonly dirtyFiles: readonly string[];
  /** Полнота M: в разреженном M отсутствие файла ничего не означает. */
  readonly mirrorCoverage: SyncMirrorCoverage;
  /** Часть D, которой нет в B (добавлено локально): единственное, что разреженный M позволяет удалять. */
  readonly dirtyAddedFiles: readonly string[];
  /** D.modified ∪ D.deleted, отсутствующие в разреженном M: восстановить их дельтой нечем. */
  readonly unrestorableDirtyFiles: readonly string[];
  readonly archiveThresholdFiles: number;
}

export type ImportArchiveReason =
  | 'mirror-empty'
  | 'full-dump'
  | 'unrecognized'
  | 'unresolved-objects'
  | 'over-threshold'
  | 'sparse-mirror-dirty';

export type RemoteImportPlan =
  | { readonly action: 'archive'; readonly reason: ImportArchiveReason }
  | {
    readonly action: 'delta';
    readonly files: string[];
    /**
     * Файлы, которые при отсутствии в M после `--update` удаляются из P. У полного M — все `files`;
     * у разреженного — только добавленные локально: их нет в B, и раз нет в M — нет и в БД.
     */
    readonly deletableIfAbsent: string[];
  };

export type ImportPlan = { readonly action: 'compare' } | RemoteImportPlan;

export function planImport(input: ImportPlanInput): ImportPlan {
  return input.storeKind === 'local' ? { action: 'compare' } : planRemoteImport(input);
}

/** Решение для удалённого хранилища: тип исключает `compare`, которого здесь не бывает. */
export function planRemoteImport(input: Omit<ImportPlanInput, 'storeKind'>): RemoteImportPlan {
  if (input.mirrorState === 'empty') {
    return { action: 'archive', reason: 'mirror-empty' };
  }
  const { changeSet } = input;
  if (!changeSet) {
    // Молчаливая дельта без списка изменений пропустила бы всё, что поменялось в БД.
    throw new Error('planImport: для удалённого зеркала нужен разобранный список изменений (changeSet).');
  }
  if (changeSet.kind === 'fullDump') {
    return { action: 'archive', reason: 'full-dump' };
  }
  if (changeSet.kind === 'unrecognized') {
    return { action: 'archive', reason: 'unrecognized' };
  }
  if (input.unresolvedObjects.length > 0) {
    return { action: 'archive', reason: 'unresolved-objects' };
  }
  const files = Array.from(new Set([...input.changedFiles, ...input.dirtyFiles])).sort();
  if (files.length > input.archiveThresholdFiles) {
    return { action: 'archive', reason: 'over-threshold' };
  }
  if (input.unrestorableDirtyFiles.length > 0) {
    return { action: 'archive', reason: 'sparse-mirror-dirty' };
  }
  if (input.mirrorCoverage === 'full') {
    return { action: 'delta', files, deletableIfAbsent: files };
  }
  const added = new Set(input.dirtyAddedFiles);
  return { action: 'delta', files, deletableIfAbsent: files.filter((file) => added.has(file)) };
}

export interface LoadPlanInput {
  readonly storeKind: SyncStoreKind;
  readonly mirrorState: SyncMirrorState;
  /** B — манифест последней синхронизации. */
  readonly base: Readonly<Record<string, string>>;
  /** Текущий P. */
  readonly current: Readonly<Record<string, string>>;
  readonly archiveThresholdFiles: number;
  /** Выбор файлов для `--list-file` по изменённым (по умолчанию — сами изменённые). */
  readonly selectLoadFiles?: (changed: readonly string[]) => string[];
}

export type LoadFullReason = 'no-baseline' | 'deletion' | 'rename' | 'over-threshold';

/**
 * Подготовка M перед частичной загрузкой: `full-copy` — каркаса нет, P копируется целиком (прежнее
 * поведение локального агента); `refresh-dump` — после загрузки архивом M отстал от БД, но БД ≡ P,
 * поэтому достаточно `dump --update` без скачивания; `full-dump` — удалённого M нет (проект ни разу
 * не импортировался, M потерян), но при известной B база ≡ B: M очищается и выгружается из базы
 * целиком на сервере, без скачивания (Н47) — иначе правка одного файла гнала бы весь P архивом.
 */
export type LoadMirrorPreparation = 'none' | 'full-copy' | 'refresh-dump' | 'full-dump';

/** Удалённый агент: подготовка M по его состоянию (без базовой линии сюда не доходит — там полная загрузка). */
const REMOTE_MIRROR_PREPARATION: Readonly<Record<SyncMirrorState, LoadMirrorPreparation>> = {
  fresh: 'none',
  stale: 'refresh-dump',
  empty: 'full-dump',
};

export type LoadPlan =
  | { readonly action: 'skip'; readonly reason: 'no-changes' | 'no-loadable-files' }
  | { readonly action: 'full'; readonly reason: LoadFullReason; readonly via: 'dir' | 'archive' }
  | {
    readonly action: 'partial';
    /** Добавленные, затем изменённые файлы P. */
    readonly changed: string[];
    /** Файлы для `--list-file`. */
    readonly files: string[];
    readonly prepareMirror: LoadMirrorPreparation;
  };

export function planLoad(input: LoadPlanInput): LoadPlan {
  const diff = diffSyncFiles(input.base, input.current);
  if (diff.added.length + diff.modified.length + diff.deleted.length === 0) {
    return { action: 'skip', reason: 'no-changes' };
  }
  // Без архива локальный агент грузит каталог M, удалённый — архив P (M там может отставать).
  const via = input.storeKind === 'local' ? 'dir' : 'archive';
  if (Object.keys(input.base).length === 0) {
    return { action: 'full', reason: 'no-baseline', via };
  }
  if (diff.deleted.length > 0) {
    // Частичная загрузка удалений не передаёт: удалённый объект остался бы в базе.
    const rename = detectPotentialRename(
      { ...input.base },
      { ...input.current },
      diff.added,
      diff.deleted
    );
    return { action: 'full', reason: rename ? 'rename' : 'deletion', via };
  }
  const changed = [...diff.added, ...diff.modified];
  const files = input.selectLoadFiles ? input.selectLoadFiles(changed) : changed;
  if (files.length === 0) {
    return { action: 'skip', reason: 'no-loadable-files' };
  }
  if (input.storeKind === 'local') {
    return { action: 'partial', changed, files, prepareMirror: input.mirrorState === 'empty' ? 'full-copy' : 'none' };
  }
  if (files.length > input.archiveThresholdFiles) {
    return { action: 'full', reason: 'over-threshold', via };
  }
  return { action: 'partial', changed, files, prepareMirror: REMOTE_MIRROR_PREPARATION[input.mirrorState] };
}
