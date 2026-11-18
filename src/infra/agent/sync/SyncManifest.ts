import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { buildHashSnapshot, loadHashCache } from '../../cache/HashCache';
import { writeFileAtomic } from '../../fs/AtomicFileWriter';

/**
 * Манифест B — базовая линия синхронизации цели (cf или cfe/<имя>) с агентом: «отн. путь → sha1»
 * отслеживаемых файлов P на момент последней успешной операции и состояние серверного зеркала M.
 *
 * Набор отслеживаемых файлов и хэш — РОВНО те же, что у HashCache (`buildHashSnapshot`): иначе B и
 * кэш хэшей расходились бы, и загрузка «по изменениям» считала бы разные множества в двух местах.
 */

/** Состояние M: `empty` — зеркала нет (или ему нельзя верить), `stale` — БД новее M, `fresh` — M ≡ БД. */
export type SyncMirrorState = 'empty' | 'stale' | 'fresh';

export interface SyncManifest {
  readonly schemaVersion: 1;
  readonly scopeKey: string;
  readonly mirrorState: SyncMirrorState;
  readonly files: Readonly<Record<string, string>>;
}

export interface SyncFilesDiff {
  readonly added: string[];
  readonly modified: string[];
  readonly deleted: string[];
}

const SCHEMA_VERSION = 1;
const MIRROR_STATES: readonly SyncMirrorState[] = ['empty', 'stale', 'fresh'];

/**
 * Каталог `.v8vscedit/agent-sync`, а не внутри `.v8vscedit/agent`: последний — `/AgentBaseDir`
 * агента по умолчанию, агент вправе его чистить и расширять, а пользовательский `/AgentBaseDir`
 * может указывать куда угодно (решение Н38).
 */
export function resolveSyncManifestPath(projectRoot: string, scopeKey: string): string {
  const hash = crypto.createHash('sha1').update(scopeKey).digest('hex');
  return path.join(projectRoot, '.v8vscedit', 'agent-sync', `${hash}.json`);
}

export function buildSyncManifestFiles(configDir: string): Record<string, string> {
  return buildHashSnapshot('', configDir).files;
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
  const { schemaVersion, mirrorState, files } = parsed;
  if (
    schemaVersion !== SCHEMA_VERSION
    || parsed.scopeKey !== scopeKey
    || !MIRROR_STATES.includes(mirrorState as SyncMirrorState)
    || !isRecord(files)
  ) {
    return undefined;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    scopeKey,
    mirrorState: mirrorState as SyncMirrorState,
    files: files as Record<string, string>,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
