import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../fs/AtomicFileWriter';

/**
 * Stat-мемо — факты «отпечаток файла (mtime, ctime, size) → sha1 его содержимого», чтобы повторная
 * проверка выгрузки стоила O(число файлов) вызовов `stat`, а не O(размер выгрузки) байт чтения.
 *
 * Мемо хранится ОТДЕЛЬНО от базовой линии хеш-кэша (`.v8vscedit/cache`), а не полем в ней:
 * - базовую линию («что загружено в БД») пишут только импорт и синхронизация агента. Если бы
 *   детектор изменений дописывал в неё отпечатки, запоздалая запись из Extension Host могла бы
 *   затереть линию, только что сохранённую CLI после импорта;
 * - `AgentSyncEngine.saveBaseline` пишет базовую линию литералом и стирал бы любое новое поле;
 * - мемо описывает содержимое КАТАЛОГА, а не области (cf/cfe/манифест агента), и один на всех.
 * Запоздалая или конкурентная перезапись мемо безвредна: в нём только истинные факты, теряется
 * лишь скорость следующего прохода.
 */

export const HASH_STAT_MEMO_SCHEMA_VERSION = 1;

/**
 * Окно недоверия к свежим отпечаткам (racy-git). Запись в файл в ту же единицу времени ФС, в
 * которой снят отпечаток, не меняет mtime — и изменение было бы пропущено. Отпечаток, у которого
 * max(mtime, ctime) позже чем за окно до старта прохода, в мемо не сохраняется. 3 с покрывают
 * FAT32 (2 с) и HFS+/ext3 (1 с) с запасом на округление; у NTFS гранулярность 100 нс.
 */
export const HASH_STAT_RACY_WINDOW_MS = 3_000;

/** Кортеж, а не объект: на ~100 тыс. файлов выгрузки разница в размере JSON — десятки МБ. */
export type HashStatEntry = readonly [mtimeMs: number, ctimeMs: number, size: number, sha1: string];

export interface HashStatMemo {
  readonly schemaVersion: 1;
  readonly configDir: string;
  readonly entries: Readonly<Record<string, HashStatEntry>>;
}

export interface FileFingerprint {
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly size: number;
}

const HASH_STAT_DIR = path.join('.v8vscedit', 'hash-stat');

/** Та же нормализация, что у `buildScopeKey`: регистр и вид разделителей пути на Windows не значимы. */
export function normalizeMemoConfigDir(configDir: string): string {
  return path.resolve(configDir).replace(/\\/g, '/').toLowerCase();
}

export function resolveHashStatMemoPath(projectRoot: string, configDir: string): string {
  const hash = crypto.createHash('sha1').update(`stat::${normalizeMemoConfigDir(configDir)}`).digest('hex');
  return path.join(projectRoot, HASH_STAT_DIR, `${hash}.json`);
}

export function emptyHashStatMemo(configDir: string): HashStatMemo {
  return { schemaVersion: HASH_STAT_MEMO_SCHEMA_VERSION, configDir: normalizeMemoConfigDir(configDir), entries: {} };
}

/**
 * Мемо — только ускорение, поэтому любой непригодный файл (нет, битый, чужая схема или каталог)
 * равен пустому мемо: следующий проход просто перехеширует всё, а не падает.
 */
export async function loadHashStatMemo(projectRoot: string, configDir: string): Promise<HashStatMemo> {
  const empty = emptyHashStatMemo(configDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.promises.readFile(resolveHashStatMemoPath(projectRoot, configDir), 'utf-8'));
  } catch {
    return empty;
  }
  if (!isRecord(parsed)) {
    return empty;
  }
  const { schemaVersion, configDir: storedDir, entries } = parsed;
  if (schemaVersion !== HASH_STAT_MEMO_SCHEMA_VERSION || storedDir !== empty.configDir || !isRecord(entries)) {
    return empty;
  }
  // Отдельные записи не валидируются здесь: `lookupMemoHash` отвергает невалидную при обращении,
  // а полный проход по 100 тыс. записей на загрузке был бы лишней работой на потоке хоста.
  return { schemaVersion: HASH_STAT_MEMO_SCHEMA_VERSION, configDir: empty.configDir, entries: entries as Record<string, HashStatEntry> };
}

export function saveHashStatMemo(projectRoot: string, memo: HashStatMemo): void {
  const filePath = resolveHashStatMemoPath(projectRoot, memo.configDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, JSON.stringify(memo));
}

/** Хеш из мемо — только при полном совпадении отпечатка и валидной записи; иначе файл перечитывается. */
export function lookupMemoHash(memo: HashStatMemo, relativePath: string, fp: FileFingerprint): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(memo.entries, relativePath)) {
    return undefined;
  }
  const entry: unknown = memo.entries[relativePath];
  if (!isValidEntry(entry)) {
    return undefined;
  }
  const [mtimeMs, ctimeMs, size, sha1] = entry;
  if (mtimeMs !== fp.mtimeMs || ctimeMs !== fp.ctimeMs || size !== fp.size) {
    return undefined;
  }
  return sha1;
}

/**
 * Порог отсчитывается от момента СТАРТА прохода (он взят раньше любого stat/read): у доверенной
 * записи mtime + окно ≤ старт ≤ чтение, значит любая последующая запись даст строго больший mtime.
 * Время в будущем (расхождение часов сетевой ФС) — всегда racy: страдает скорость, не корректность.
 */
export function isRacyFingerprint(
  fp: FileFingerprint,
  scanStartedAtMs: number,
  windowMs: number = HASH_STAT_RACY_WINDOW_MS
): boolean {
  return Math.max(fp.mtimeMs, fp.ctimeMs) > scanStartedAtMs - windowMs;
}

function isValidEntry(entry: unknown): entry is HashStatEntry {
  return Array.isArray(entry)
    && entry.length === 4
    && typeof entry[0] === 'number'
    && typeof entry[1] === 'number'
    && typeof entry[2] === 'number'
    && typeof entry[3] === 'string'
    && entry[3].length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
