import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { loadHashCache } from '../../cache/HashCache';
import { scanHashSnapshot, type HashScanOptions } from '../../cache/HashScanner';
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

export interface SyncManifest {
  readonly schemaVersion: 1;
  readonly scopeKey: string;
  readonly mirrorState: SyncMirrorState;
  readonly files: Readonly<Record<string, string>>;
  /** Нет — `full`: манифесты до появления поля писались только при полном M. */
  readonly mirrorCoverage?: SyncMirrorCoverage;
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
  const { schemaVersion, mirrorState, files, mirrorCoverage } = parsed;
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
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
