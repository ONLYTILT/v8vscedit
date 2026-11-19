import type { DumpChangedObject, DumpChangeSet } from '../../../domain/agent/DumpChangesParser';
import type { DumpInfoOwnerChanges } from '../../xml/dumpInfo/ConfigDumpInfoDiff';
import { CONFIGURATION_PREFIX } from '../../xml/dumpInfo/ConfigDumpInfoIndex';
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

/**
 * Снимать `FullDump` очисткой зеркала по свежему файлу версий (plan-fulldump-avoid.md, Р1) — по цели.
 * Расширения — прежний путь (архив `full-dump`): `--config-dump-info-only` с `--extension` и очистка
 * файла версий расширения на платформе не проверены (пилот П1). Включение — правка строки таблицы.
 */
export const FULL_DUMP_AVOIDANCE_BY_TARGET: Readonly<Record<'cf' | 'cfe', boolean>> = { cf: true, cfe: false };

export interface ImportPlanInput extends ImportPreUpdateInput {
  readonly storeKind: SyncStoreKind;
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
  /**
   * D.modified ∪ D.deleted, отсутствующие в разреженном M: восстановить их из M нечем — их берёт из базы
   * точечная выгрузка (`restoreFromDatabase` плана).
   */
  readonly dirtyAbsentFromMirror: readonly string[];
  readonly archiveThresholdFiles: number;
  /**
   * P-файлы владельцев, удалённых в базе (по сравнению файлов версий): удаляются при любой полноте M, не
   * восстанавливаются из базы (их там нет) и не считаются в порог — выгружать их не нужно.
   */
  readonly removedOwnerFiles: readonly string[];
  /**
   * P-файлы живых владельцев, у которых пропала часть: их записи убраны из файла версий M, и `--update`
   * выгрузил поддерево владельца в M целиком — отсутствие в M означает удаление при любой полноте.
   */
  readonly replacedOwnerFiles: readonly string[];
  /** `rewrite` — M уже переписан серверной выгрузкой (запасной путь): порог архива не применяется. */
  readonly updateKind: 'incremental' | 'rewrite';
  /**
   * Владельцы с пропавшими частями по сравнению файлов версий ПОСЛЕ перезаписи: в разреженном M их
   * поддерево неполно, удалённое от невыгруженного не отличить — архив `sparse-removed-parts`.
   */
  readonly rewriteOwnersWithRemovedParts: readonly string[];
}

export type ImportArchiveReason =
  | 'mirror-empty'
  | 'full-dump'
  | 'unrecognized'
  | 'unresolved-objects'
  | 'over-threshold'
  | 'sparse-mirror-dirty'
  | 'sparse-removed-parts';

/** Политика причины полной выгрузки импорта: ДАННЫЕ, а не ветки в потоке (новая причина — строка таблицы). */
export interface ArchiveReasonPolicy {
  /** До `--update` (M не мутирован, вопрос задаётся до мутаций) или после. */
  readonly phase: 'before-update' | 'after-update';
  /** Засевать M из архива (CDI + Configuration.xml архива): `--update` не выполнялся или M пуст. */
  readonly reseedMirror: boolean;
  /** Текст причины для журнала и вопроса пользователю. */
  readonly text: string;
}

export const ARCHIVE_REASON_POLICY: Readonly<Record<ImportArchiveReason, ArchiveReasonPolicy>> = {
  'mirror-empty': { phase: 'before-update', reseedMirror: true, text: 'зеркало агента пусто' },
  'full-dump': {
    phase: 'before-update',
    reseedMirror: true,
    text: 'в базе удалены или переименованы объекты (агент сообщил FullDump)',
  },
  'unrecognized': { phase: 'before-update', reseedMirror: true, text: 'список изменений агента не распознан' },
  'unresolved-objects': {
    phase: 'after-update',
    reseedMirror: false,
    text: 'изменённые объекты не удалось сопоставить файлам выгрузки',
  },
  'over-threshold': {
    phase: 'after-update',
    reseedMirror: false,
    text: 'изменено больше файлов, чем порог v8vscedit.agent.archiveThresholdFiles',
  },
  // Планировщик эту причину не возвращает: она запасная у движка, когда не удалась точечная выгрузка.
  'sparse-mirror-dirty': {
    phase: 'after-update',
    reseedMirror: false,
    text: 'локально изменённые файлы не удалось восстановить из базы точечно',
  },
  // Редкий случай запасного пути: части объектов обычно снимает очистка зеркала, а довыгрузка владельцев
  // ради него не окупает сложности (plan-fulldump-avoid.md, Р10).
  'sparse-removed-parts': {
    phase: 'after-update',
    reseedMirror: false,
    text: 'после перезаписи разреженного зеркала у объектов пропали части, а удалённые файлы не отличить от невыгруженных',
  },
};

/**
 * Причина серверной выгрузки, о которой спрашивают пользователя: архив импорта или перезапись зеркала
 * (`--update` при пропавших записях файла версий — сервер переписывает выгрузку целиком, но скачиваются
 * только изменённые файлы).
 */
export type ServerDumpReason = ImportArchiveReason | 'mirror-rewrite';

export interface ServerDumpPolicy {
  readonly text: string;
  /** Скачивается ли выгрузка целиком (архив): от этого зависит текст вопроса. */
  readonly download: boolean;
}

/** Выводится из `ARCHIVE_REASON_POLICY`: тексты причин архива не дублируются. */
export const SERVER_DUMP_POLICY: Readonly<Record<ServerDumpReason, ServerDumpPolicy>> = {
  ...(Object.fromEntries(
    (Object.keys(ARCHIVE_REASON_POLICY) as ImportArchiveReason[]).map((reason) => [
      reason,
      { text: ARCHIVE_REASON_POLICY[reason].text, download: true },
    ])
  ) as Record<ImportArchiveReason, ServerDumpPolicy>),
  'mirror-rewrite': {
    text: 'в базе удалены части объектов, которые нельзя снять очисткой зеркала (агент сообщил FullDump)',
    download: false,
  },
};

/**
 * Решение фазы 1 (до `dump --update`): `skip-update` — список пуст, M и так совпадает с базой. Варианты
 * без архива несут объекты списка: вид списка здесь уже сужен, и движку не нужно сужать его повторно.
 */
export type ImportPreUpdatePlan =
  | { readonly action: 'archive'; readonly reason: 'mirror-empty' | 'full-dump' | 'unrecognized' }
  | { readonly action: 'update'; readonly objects: readonly DumpChangedObject[] }
  | { readonly action: 'skip-update'; readonly objects: readonly DumpChangedObject[] }
  /** `FullDump`: очистить M по свежему файлу версий базы и спросить список повторно. */
  | { readonly action: 'prune' }
  /** `FullDump` и после очистки: запасной путь — перезапись M на сервере (вопрос `mirror-rewrite`). */
  | { readonly action: 'rewrite-mirror' };

export interface ImportPreUpdateInput {
  readonly mirrorState: SyncMirrorState;
  /** Разбор `--get-changes`; для sftp с непустым M обязателен. */
  readonly changeSet?: DumpChangeSet;
  /** Снимать ли `FullDump` без архива (`FULL_DUMP_AVOIDANCE_BY_TARGET` цели). */
  readonly fullDumpAvoidance: boolean;
  /** Первый список изменений или повторный — после очистки зеркала. */
  readonly fullDumpStage: 'initial' | 'after-prune';
}

/**
 * Фаза 1 импорта. `fullDump`/`unrecognized` уходят в архив ДО `--update`: архив и так заменит M
 * посевом, а предварительный `--update` при `FullDump` — вторая полная серверная выгрузка впустую.
 */
export function planBeforeUpdate(input: ImportPreUpdateInput): ImportPreUpdatePlan {
  if (input.mirrorState === 'empty') {
    return { action: 'archive', reason: 'mirror-empty' };
  }
  const { changeSet } = input;
  if (!changeSet) {
    // Молчаливая дельта без списка изменений пропустила бы всё, что поменялось в БД.
    throw new Error('planImport: для удалённого зеркала нужен разобранный список изменений (changeSet).');
  }
  if (changeSet.kind === 'fullDump') {
    if (!input.fullDumpAvoidance) {
      return { action: 'archive', reason: 'full-dump' };
    }
    // Повторный `FullDump` после очистки — очистка его не объяснила: дальше только перезапись M.
    return { action: input.fullDumpStage === 'initial' ? 'prune' : 'rewrite-mirror' };
  }
  if (changeSet.kind === 'unrecognized') {
    return { action: 'archive', reason: 'unrecognized' };
  }
  const { objects } = changeSet;
  return { action: objects.length === 0 ? 'skip-update' : 'update', objects };
}

export interface PruneInput {
  /** Получен ли свежий файл версий базы (стражи пройдены). */
  readonly freshDumpInfo: 'ok' | 'failed';
  /** Сравнение файла версий M со свежим (при `ok`). */
  readonly changes?: DumpInfoOwnerChanges;
  /** Владельцы набора очистки, которых нельзя перевести в файлы. */
  readonly unresolved: readonly string[];
}

/**
 * Можно ли снять `FullDump` очисткой M.
 * - `archive` (`full-dump`, до мутаций): владельца набора нельзя перевести в файлы. Перезапись M тут не
 *   помогла бы: тот же владелец после неё дал бы архив `unresolved-objects`, то есть две полные
 *   серверные выгрузки и два вопроса. Архив `full-dump` засевает M заново одним проходом.
 * - `rewrite-mirror` (запасной путь до мутаций): свежего файла версий нет, очищать нечего (FullDump
 *   необъясним) или удалена часть корня (корень из файла версий не убирается — без него зеркало
 *   перестаёт быть выгрузкой).
 */
export function planPrune(input: PruneInput): 'prune' | 'rewrite-mirror' | 'archive' {
  const { changes } = input;
  if (input.freshDumpInfo === 'failed' || changes === undefined) {
    return 'rewrite-mirror';
  }
  if (input.unresolved.length > 0) {
    return 'archive';
  }
  const empty = changes.removedOwners.length + changes.ownersWithRemovedParts.length === 0;
  const rootPart = changes.ownersWithRemovedParts.some((owner) => owner.startsWith(CONFIGURATION_PREFIX));
  return empty || rootPart ? 'rewrite-mirror' : 'prune';
}

export type RetryVerification = { readonly ok: true } | { readonly ok: false; readonly missingNew: string[] };

/**
 * Сверка повторного списка (Р4): владелец, очищенный из-за пропавшей части, обязан прийти строкой
 * `New: <владелец>` — только тогда `--update` выгрузит его целиком (ФАКТ П3b). Строки подобъектов
 * (`New: Владелец.Template.Макет`) ожидаемы, но сами по себе полную выгрузку владельца не подтверждают.
 */
export function verifyRetryChanges(
  objects: readonly DumpChangedObject[],
  ownersWithRemovedParts: readonly string[]
): RetryVerification {
  const newOwners = new Set(objects
    .filter((object) => object.change === 'added' && object.parts.length === 0)
    .map((object) => object.fullName));
  const missingNew = ownersWithRemovedParts.filter((owner) => !newOwners.has(owner));
  return missingNew.length === 0 ? { ok: true } : { ok: false, missingNew };
}

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
    /** Отсутствующие в разреженном M грязные файлы: выгрузить из базы точечно (подмножество `files`). */
    readonly restoreFromDatabase: string[];
  };

export type ImportPlan = { readonly action: 'compare' } | RemoteImportPlan;

export function planImport(input: ImportPlanInput): ImportPlan {
  return input.storeKind === 'local' ? { action: 'compare' } : planRemoteImport(input);
}

/**
 * Решение для удалённого хранилища (фаза 2, после `--update`): тип исключает `compare`, которого здесь
 * не бывает. Фаза 1 проверяется той же функцией, что у движка, — одна таблица решений.
 */
export function planRemoteImport(input: Omit<ImportPlanInput, 'storeKind'>): RemoteImportPlan {
  // `prune`/`rewrite-mirror` к этому моменту уже разрешены движком (FullDump снят очисткой или
  // перезаписью M): фаза 2 работает с переданными ей объектами, и возврат фазы 1 — только архив.
  const before = planBeforeUpdate(input);
  if (before.action === 'archive') {
    return before;
  }
  if (input.unresolvedObjects.length > 0) {
    return { action: 'archive', reason: 'unresolved-objects' };
  }
  const rewrite = input.updateKind === 'rewrite';
  if (rewrite && input.mirrorCoverage === 'sparse' && input.rewriteOwnersWithRemovedParts.length > 0) {
    return { action: 'archive', reason: 'sparse-removed-parts' };
  }
  const removed = new Set(input.removedOwnerFiles);
  const counted = [...new Set([...input.changedFiles, ...input.dirtyFiles, ...input.replacedOwnerFiles])]
    .filter((file) => !removed.has(file));
  // После перезаписи серверная выгрузка уже выполнена: архив сверх порога повторил бы её.
  if (!rewrite && counted.length > input.archiveThresholdFiles) {
    return { action: 'archive', reason: 'over-threshold' };
  }
  const files = [...new Set([...counted, ...removed])].sort();
  if (input.mirrorCoverage === 'full') {
    // В полном M каждый файл базы есть: восстанавливать из базы отдельно нечего.
    return { action: 'delta', files, deletableIfAbsent: files, restoreFromDatabase: [] };
  }
  const replaced = new Set(input.replacedOwnerFiles);
  const deletable = new Set([...input.dirtyAddedFiles, ...removed, ...replaced]);
  const absent = new Set(input.dirtyAbsentFromMirror);
  return {
    action: 'delta',
    files,
    deletableIfAbsent: files.filter((file) => deletable.has(file)),
    // Удалённого в базе владельца из базы не восстановить, а поддерево переподготовленного в M полное.
    restoreFromDatabase: files.filter((file) => absent.has(file) && !removed.has(file) && !replaced.has(file)),
  };
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
