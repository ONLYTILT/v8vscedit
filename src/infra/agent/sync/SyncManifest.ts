import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isSupportedConfigFile, loadHashCache } from '../../cache/HashCache';
import { hashTrackedFiles, scanHashSnapshot, type HashScanOptions, type HashScanReport } from '../../cache/HashScanner';
import { writeFileAtomic } from '../../fs/AtomicFileWriter';

/**
 * Манифест B — базовая линия синхронизации цели (cf или cfe/<имя>) с агентом: «отн. путь → sha1»
 * отслеживаемых файлов P на момент последней успешной операции и состояние серверного зеркала M.
 *
 * Набор отслеживаемых файлов и хэш — РОВНО те же, что у HashCache (`buildHashSnapshot`/`scanHashSnapshot`): иначе B и
 * кэш хэшей расходились бы, и загрузка «по изменениям» считала бы разные множества в двух местах.
 */

/** Состояние M: `empty` — зеркала нет (или ему нельзя верить), `stale` — БД новее M, `fresh` — M ≡ БД. */
export type SyncMirrorState = 'empty' | 'stale' | 'fresh';

/**
 * Полнота M, ортогональная `SyncMirrorState`: `full` — в M все файлы выгрузки; `sparse` — часть
 * (посев: файл версий, Configuration.xml и файлы владельцев, изменённых после посева). Каждый
 * присутствующий в разреженном M файл равен БД, а отсутствующий не означает ничего.
 */
export type SyncMirrorCoverage = 'full' | 'sparse';

/**
 * Отпечаток `ConfigDumpInfo.xml` проекта: по нему импорт узнаёт, что выгрузку проекта заменили извне.
 * Отдельным полем, потому что файл версий в B не входит (`isSupportedConfigFile` исключает его явно).
 */
export interface ProjectDumpInfoFingerprint {
  readonly sha1: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface SyncManifest {
  readonly schemaVersion: 1;
  readonly scopeKey: string;
  readonly mirrorState: SyncMirrorState;
  readonly files: Readonly<Record<string, string>>;
  /** Нет — `full`: манифесты до появления поля писались только при полном M. */
  readonly mirrorCoverage?: SyncMirrorCoverage;
  /** Отпечаток файла версий проекта после последнего успешного импорта; нет — признака замены нет. */
  readonly projectDumpInfo?: ProjectDumpInfoFingerprint;
}

export interface SyncFilesDiff {
  readonly added: string[];
  readonly modified: string[];
  readonly deleted: string[];
}

const SCHEMA_VERSION = 1;
const MIRROR_STATES: readonly SyncMirrorState[] = ['empty', 'stale', 'fresh'];
const MIRROR_COVERAGES: readonly SyncMirrorCoverage[] = ['full', 'sparse'];

export function mirrorCoverageOf(manifest: SyncManifest): SyncMirrorCoverage {
  return manifest.mirrorCoverage ?? 'full';
}

/**
 * Каталог `.v8vscedit/agent-sync`, а не внутри `.v8vscedit/agent`: последний — `/AgentBaseDir`
 * агента по умолчанию, агент вправе его чистить и расширять, а пользовательский `/AgentBaseDir`
 * может указывать куда угодно (решение Н38).
 */
export function resolveSyncManifestPath(projectRoot: string, scopeKey: string): string {
  const hash = crypto.createHash('sha1').update(scopeKey).digest('hex');
  return path.join(projectRoot, '.v8vscedit', 'agent-sync', `${hash}.json`);
}

/**
 * Текущее состояние P быстрой проверкой: с `projectRoot` используется stat-мемо проекта — тот же,
 * что у детектора изменений (мемо привязан к каталогу, а не к области), поэтому после проверки
 * изменений манифест агента почти ничего не перечитывает. Операции агента идут в Extension Host,
 * и полный синхронный проход по выгрузке блокировал бы его.
 */
export async function buildSyncManifestFiles(
  configDir: string,
  projectRoot?: string,
  options?: HashScanOptions
): Promise<Record<string, string>> {
  return (await scanHashSnapshot(projectRoot, '', configDir, options)).files;
}

/** Почему B после импорта снята полным проходом, а не по изменённым файлам. */
export type SyncBaselineFullReason = 'compare' | 'archive' | 'no-project-snapshot' | 'case-mismatch' | 'foreign-path';

export type SyncBaselineMode =
  | { readonly kind: 'incremental'; readonly rehashed: number; readonly removed: number }
  | { readonly kind: 'full'; readonly reason: SyncBaselineFullReason; readonly report: HashScanReport };

export interface SyncBaselineInput {
  readonly configDir: string;
  readonly projectRoot: string;
  /** Снимок P, снятый ЭТОЙ ЖЕ операцией до записи; нет — полный проход. */
  readonly projectSnapshot?: Readonly<Record<string, string>>;
  /** Причина полного прохода по построению стратегии; задана — полный проход даже при наличии снимка. */
  readonly fullReason?: 'compare' | 'archive';
  /** Абсолютные пути, записанные или удалённые операцией (`AgentImportResult.changedProjectFiles`). */
  readonly changedFiles: readonly string[];
  readonly scan?: Omit<HashScanOptions, 'onReport' | 'signal'>;
  readonly clock?: () => number;
}

export interface SyncBaselineResult {
  /** Новый объект: снимок операции не мутируется. */
  readonly files: Record<string, string>;
  readonly mode: SyncBaselineMode;
  readonly elapsedMs: number;
}

/**
 * B после импорта = снимок P операции ⊕ перехеширование записанного. Прежняя B в расчёте не участвует:
 * грязные файлы снимок уже содержит текущим содержимым. Для пути, который импорт не трогал, P после
 * операции равна снимку — `applyProjectChanges` единственный писатель P в импорте, и его результат
 * (`changedProjectFiles`) и есть вход сюда.
 *
 * Осознанное расхождение с полным проходом — правка пользователя во время операции в нетронутом файле:
 * полный проход молча поглотил бы её в B, здесь в B остаётся хеш снимка, и правка видна как изменение.
 *
 * Полный проход: нет снимка (архив, сравнение с локальным зеркалом), путь вне каталога цели (не бывает,
 * но молча пропустить нельзя), пути, отличающиеся только регистром (переименование объекта регистром:
 * полный проход берёт имена из `readdir`, а патч по запрошенному пути оставил бы старый ключ).
 */
export async function buildSyncBaselineAfterImport(input: SyncBaselineInput): Promise<SyncBaselineResult> {
  const clock = input.clock ?? Date.now;
  const startedAt = clock();
  const finish = (files: Record<string, string>, mode: SyncBaselineMode): SyncBaselineResult =>
    ({ files, mode, elapsedMs: clock() - startedAt });
  const full = async (reason: SyncBaselineFullReason): Promise<SyncBaselineResult> => {
    const reports: HashScanReport[] = [];
    const snapshot = await scanHashSnapshot(input.projectRoot, '', input.configDir, {
      ...input.scan,
      onReport: (scanReport) => { reports.push(scanReport); },
    });
    // onReport зовётся ровно один раз до возврата успешного scanHashSnapshot.
    return finish(snapshot.files, { kind: 'full', reason, report: reports[0] });
  };

  const snapshot = input.projectSnapshot;
  // Явная причина полного прохода сильнее снимка: стратегия (архив, сравнение) переписала P мимо
  // перечня изменений, и патч по снимку дал бы неверную B.
  if (input.fullReason !== undefined) {
    return full(input.fullReason);
  }
  if (snapshot === undefined) {
    return full('no-project-snapshot');
  }
  const changed: string[] = [];
  for (const file of input.changedFiles) {
    const rel = path.relative(input.configDir, file);
    if (/^\.\.(?:[\\/]|$)/.test(rel) || path.isAbsolute(rel)) {
      return full('foreign-path');
    }
    const posix = rel.replace(/\\/g, '/');
    if (isSupportedConfigFile(posix)) {
      changed.push(posix);
    }
  }
  const snapshotKeysByUpper = new Map(Object.keys(snapshot).map((key) => [key.toUpperCase(), key]));
  for (const rel of changed) {
    const key = snapshotKeysByUpper.get(rel.toUpperCase());
    if (key !== undefined && key !== rel) {
      return full('case-mismatch');
    }
  }
  const rehash = await hashTrackedFiles(input.configDir, changed, input.scan);
  if (rehash.caseMismatch.length > 0) {
    return full('case-mismatch');
  }
  const missing = new Set(rehash.missing);
  const files: Record<string, string> = {};
  let removed = 0;
  for (const [rel, hash] of Object.entries(snapshot)) {
    if (missing.has(rel)) {
      removed += 1;
    } else {
      files[rel] = hash;
    }
  }
  Object.assign(files, rehash.hashes);
  return finish(files, { kind: 'incremental', rehashed: rehash.hashed, removed });
}

/**
 * Манифест цели. Нет своего файла (или он непригоден) — B берётся из HashCache, а M считается
 * `empty`: миграция с прежнего режима, где базой служил кэш хэшей, а о состоянии зеркала
 * ничего не известно.
 */
export function loadSyncManifest(projectRoot: string, scopeKey: string): SyncManifest {
  const stored = readStoredManifest(resolveSyncManifestPath(projectRoot, scopeKey), scopeKey);
  if (stored) {
    return stored;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    scopeKey,
    mirrorState: 'empty',
    files: loadHashCache(projectRoot, scopeKey).files,
  };
}

export function saveSyncManifest(projectRoot: string, manifest: SyncManifest): void {
  const filePath = resolveSyncManifestPath(projectRoot, manifest.scopeKey);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, JSON.stringify(manifest));
}

export function diffSyncFiles(
  base: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>
): SyncFilesDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [file, hash] of Object.entries(current)) {
    if (!Object.prototype.hasOwnProperty.call(base, file)) {
      added.push(file);
    } else if (base[file] !== hash) {
      modified.push(file);
    }
  }
  for (const file of Object.keys(base)) {
    if (!Object.prototype.hasOwnProperty.call(current, file)) {
      deleted.push(file);
    }
  }
  return { added: added.sort(compare), modified: modified.sort(compare), deleted: deleted.sort(compare) };
}

function compare(a: string, b: string): number {
  return a.localeCompare(b);
}

function readStoredManifest(filePath: string, scopeKey: string): SyncManifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const { schemaVersion, mirrorState, files, mirrorCoverage, projectDumpInfo } = parsed;
  if (
    schemaVersion !== SCHEMA_VERSION
    || parsed.scopeKey !== scopeKey
    || !MIRROR_STATES.includes(mirrorState as SyncMirrorState)
    || !isRecord(files)
    // Неизвестная полнота опаснее отсутствующей: принять её за `full` значило бы удалять из P файлы
    // по отсутствию в разреженном M.
    || (mirrorCoverage !== undefined && !MIRROR_COVERAGES.includes(mirrorCoverage as SyncMirrorCoverage))
  ) {
    return undefined;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    scopeKey,
    mirrorState: mirrorState as SyncMirrorState,
    files: files as Record<string, string>,
    ...(mirrorCoverage === undefined ? {} : { mirrorCoverage: mirrorCoverage as SyncMirrorCoverage }),
    // Битый отпечаток отбрасывается, а манифест принимается: отсутствие признака лишь отключает
    // вопрос о замене выгрузки, тогда как неизвестная полнота разрешила бы неверные удаления.
    ...(isFingerprint(projectDumpInfo)
      ? { projectDumpInfo: { sha1: projectDumpInfo.sha1, size: projectDumpInfo.size, mtimeMs: projectDumpInfo.mtimeMs } }
      : {}),
  };
}

function isFingerprint(value: unknown): value is ProjectDumpInfoFingerprint {
  return isRecord(value)
    && typeof value.sha1 === 'string'
    && Number.isFinite(value.size)
    && Number.isFinite(value.mtimeMs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
