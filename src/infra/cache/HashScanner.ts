import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildScopeKey,
  diffHashSnapshots,
  hashContent,
  isSupportedConfigFile,
  loadHashCache,
  type HashCacheSnapshot,
} from './HashCache';
import {
  emptyHashStatMemo,
  isRacyFingerprint,
  loadHashStatMemo,
  lookupMemoHash,
  saveHashStatMemo,
  type FileFingerprint,
  type HashStatEntry,
  type HashStatMemo,
} from './HashStatMemo';

/**
 * Быстрая асинхронная проверка выгрузки: `stat` каждого отслеживаемого файла; чтение и SHA-1 —
 * только для новых файлов и тех, у кого сменился отпечаток. «Изменено» по-прежнему решает хеш
 * содержимого (сравнение с базовой линией делает `diffHashSnapshots`): мемо лишь подставляет хеш,
 * ранее посчитанный для того же отпечатка.
 *
 * Асинхронный обход (`fs.promises`) нужен ради потока Extension Host: на выгрузке в 100 тыс. файлов
 * синхронный проход блокировал хост на минуты, и вместе с ним все расширения окна.
 */

/** Шов ФС: тесты оборачивают реальную ФС счётчиком и воспроизводят гонки реальными действиями. */
export interface HashScanFs {
  readdir(dir: string): Promise<readonly fs.Dirent[]>;
  stat(filePath: string): Promise<FileFingerprint>;
  readFile(filePath: string): Promise<Buffer>;
  /** SHA-1 hex содержимого потоком (большие файлы); совпадает с `hashContent`. */
  hashFile(filePath: string): Promise<string>;
}

export const nodeHashScanFs: HashScanFs = {
  readdir: (dir) => fs.promises.readdir(dir, { withFileTypes: true }),
  stat: async (filePath) => {
    const stat = await fs.promises.stat(filePath);
    return { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size };
  },
  readFile: (filePath) => fs.promises.readFile(filePath),
  hashFile: (filePath) => new Promise<string>((resolve, reject) => {
    const hash = createHash('sha1');
    fs.createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => { hash.update(chunk); })
      .on('end', () => { resolve(hash.digest('hex')); });
  }),
};

/**
 * С этого размера хеш считается потоком: новый `.cf`/CDI в P прочитался бы одним буфером в гигабайт
 * (plan-large-files.md §2.6). Ниже порога буфер дешевле потока на тысячах мелких файлов.
 */
export const HASH_STREAM_THRESHOLD_BYTES = 16 * 1024 * 1024;

/**
 * Не больше: пул libuv по умолчанию — 4 потока, и операции ФС других расширений не должны надолго
 * вставать в очередь за проверкой выгрузки.
 */
export const HASH_SCAN_CONCURRENCY = 16;

export interface HashScanReport {
  readonly configDir: string;
  readonly files: number;
  readonly hashed: number;
  readonly racy: number;
  readonly memoSaved: boolean;
  readonly memoSaveError?: string;
  readonly elapsedMs: number;
}

export interface HashScanOptions {
  readonly fs?: HashScanFs;
  /** Часы прохода: от них отсчитывается racy-окно. Подменяются в тестах ради детерминизма. */
  readonly now?: () => number;
  readonly onReport?: (report: HashScanReport) => void;
  /** Порог потокового хеша (по умолчанию {@link HASH_STREAM_THRESHOLD_BYTES}); тесты ставят малый. */
  readonly streamThresholdBytes?: number;
  /**
   * Прерывание прохода: проверяется между каталогами и перед каждым файлом. Прерванный проход мемо
   * НЕ пишет (частичный мемо выкинул бы записи непройденных файлов, и следующий проход перечитал бы
   * всю выгрузку) и `onReport` не зовёт; промис отклоняется `signal.reason` (AbortError).
   */
  readonly signal?: AbortSignal;
}

export interface HashScanResult {
  readonly files: Record<string, string>;
  readonly memo: HashStatMemo;
  readonly memoChanged: boolean;
  readonly hashed: number;
  readonly racy: number;
}

interface TrackedFile {
  readonly fullPath: string;
  readonly relativePath: string;
}

export async function scanCurrentHashes(
  configDir: string,
  previous: HashStatMemo,
  options: HashScanOptions = {}
): Promise<HashScanResult> {
  const scanFs = options.fs ?? nodeHashScanFs;
  const now = options.now ?? Date.now;
  const streamThreshold = options.streamThresholdBytes ?? HASH_STREAM_THRESHOLD_BYTES;
  // Момент старта берётся ДО любого stat/read — на этом держится racy-защита (см. isRacyFingerprint).
  const scanStartedAtMs = now();

  const signal = options.signal;
  const tracked = await listTrackedFiles(scanFs, configDir, signal);
  const files: Record<string, string> = {};
  const entries: Record<string, HashStatEntry> = {};
  let hashed = 0;
  let racy = 0;
  let reused = 0;

  await runPool(tracked, async ({ fullPath, relativePath }) => {
    signal?.throwIfAborted();
    let fp: FileFingerprint;
    try {
      fp = await scanFs.stat(fullPath);
    } catch (error) {
      rethrowUnlessGone(error);
      return;
    }
    const cached = lookupMemoHash(previous, relativePath, fp);
    if (cached !== undefined) {
      files[relativePath] = cached;
      entries[relativePath] = [fp.mtimeMs, fp.ctimeMs, fp.size, cached];
      reused += 1;
      return;
    }
    // stat обязан предшествовать чтению: правка после stat сдвинет mtime/ctime вперёд, и следующий
    // проход увидит несовпадение отпечатка, а не доверится хешу старого содержимого.
    let hash: string;
    try {
      hash = fp.size >= streamThreshold ? await scanFs.hashFile(fullPath) : hashContent(await scanFs.readFile(fullPath));
    } catch (error) {
      rethrowUnlessGone(error);
      return;
    }
    files[relativePath] = hash;
    hashed += 1;
    if (isRacyFingerprint(fp, scanStartedAtMs)) {
      racy += 1;
      return;
    }
    entries[relativePath] = [fp.mtimeMs, fp.ctimeMs, fp.size, hash];
  });
  // Сигнал, пришедший во время последних файлов пула, тоже обрывает проход: иначе вызывающий записал бы
  // мемо и применил результат, от которого уже отказался.
  signal?.throwIfAborted();

  // Новый мемо содержит только существующие файлы — записи удалённых вычищаются сами собой.
  const memoChanged = Object.keys(entries).length !== reused || Object.keys(previous.entries).length !== reused;
  return {
    files,
    memo: { schemaVersion: previous.schemaVersion, configDir: previous.configDir, entries },
    memoChanged,
    hashed,
    racy,
  };
}

/**
 * Снимок текущего состояния в формате базовой линии. Без `projectRoot` мемо не читается и не
 * пишется. Сбой записи мемо проверку не роняет: мемо — только ускорение следующего прохода.
 */
export async function scanHashSnapshot(
  projectRoot: string | undefined,
  scopeKey: string,
  configDir: string,
  options: HashScanOptions = {}
): Promise<HashCacheSnapshot> {
  const startedAt = Date.now();
  const memo = projectRoot ? await loadHashStatMemo(projectRoot, configDir) : emptyHashStatMemo(configDir);
  const result = await scanCurrentHashes(configDir, memo, options);

  let memoSaved = false;
  let memoSaveError: string | undefined;
  if (projectRoot && result.memoChanged) {
    try {
      saveHashStatMemo(projectRoot, result.memo);
      memoSaved = true;
    } catch (error) {
      // mkdirSync/writeFileAtomic бросают только Error; ветка String(error) — защитная, без
      // шва записи мемо её не воспроизвести (сам путь catch покрыт тестом «путь мемо занят каталогом»).
      /* c8 ignore next */
      memoSaveError = error instanceof Error ? error.message : String(error);
    }
  }

  options.onReport?.({
    configDir,
    files: Object.keys(result.files).length,
    hashed: result.hashed,
    racy: result.racy,
    memoSaved,
    ...(memoSaveError === undefined ? {} : { memoSaveError }),
    elapsedMs: Date.now() - startedAt,
  });

  return {
    schemaVersion: 1,
    scopeKey,
    generatedAt: new Date().toISOString(),
    files: result.files,
  };
}

export interface TrackedFilesRehash {
  /** Хеши существующих отслеживаемых файлов; ключ — запрошенный путь (совпал с диском побайтно, с регистром). */
  readonly hashes: Record<string, string>;
  /** Отслеживаемые пути, которых на диске нет (в том числе исчезнувшие во время чтения). */
  readonly missing: string[];
  /** Пути, у которых на диске есть совпадение только без учёта регистра (в любом сегменте). */
  readonly caseMismatch: string[];
  readonly hashed: number;
}

/**
 * Точечное перехеширование известных путей (после записи операцией): тот же критерий отслеживаемости
 * (`isSupportedConfigFile`), тот же хеш (буфер или поток по `streamThresholdBytes`) и то же правило
 * ошибок (`ENOENT`/`ENOTDIR` — файла нет, остальное пробрасывается), что у полного прохода.
 *
 * Существование и регистр проверяются по `readdir` каждого предка (кэш на вызов), а не по `stat`: на
 * регистронезависимой ФС `stat('A.xml')` нашёл бы `a.xml`, и ключ результата разошёлся бы с ключом,
 * который полный проход берёт из имени на диске. `stat` зовётся только у найденного файла — ради размера
 * (выбор буфер/поток). Stat-мемо не читается и не пишется: только что записанные файлы racy и в мемо всё
 * равно не попали бы, а вторая точка записи мемо дала бы гонку с детектором изменений.
 */
export async function hashTrackedFiles(
  configDir: string,
  relativePaths: readonly string[],
  options: Pick<HashScanOptions, 'fs' | 'streamThresholdBytes'> = {}
): Promise<TrackedFilesRehash> {
  const scanFs = options.fs ?? nodeHashScanFs;
  const streamThreshold = options.streamThresholdBytes ?? HASH_STREAM_THRESHOLD_BYTES;
  const requested = [...new Set(relativePaths)].filter((rel) => isSupportedConfigFile(rel));
  // Промис, а не результат: параллельные пути одного каталога ждут один и тот же readdir.
  const listings = new Map<string, Promise<readonly fs.Dirent[] | undefined>>();
  const listDir = (dir: string): Promise<readonly fs.Dirent[] | undefined> => {
    let listing = listings.get(dir);
    if (listing === undefined) {
      listing = scanFs.readdir(dir).catch((error: unknown) => {
        rethrowUnlessGone(error);
        return undefined;
      });
      listings.set(dir, listing);
    }
    return listing;
  };

  const hashes: Record<string, string> = {};
  const missing: string[] = [];
  const caseMismatch: string[] = [];
  await runPool(requested, async (relativePath) => {
    const segments = relativePath.split('/');
    let dir = configDir;
    for (const segment of segments) {
      const entries = await listDir(dir);
      const presence = entries === undefined ? 'missing' : segmentPresence(entries, segment);
      if (presence !== 'exact') {
        (presence === 'missing' ? missing : caseMismatch).push(relativePath);
        return;
      }
      dir = path.join(dir, segment);
    }
    try {
      const fp = await scanFs.stat(dir);
      hashes[relativePath] = fp.size >= streamThreshold ? await scanFs.hashFile(dir) : hashContent(await scanFs.readFile(dir));
    } catch (error) {
      rethrowUnlessGone(error);
      missing.push(relativePath);
    }
  });

  return { hashes, missing: missing.sort(), caseMismatch: caseMismatch.sort(), hashed: Object.keys(hashes).length };
}

/**
 * Предок-файл (не каталог) здесь не отсекается: следующий `readdir` даст `ENOTDIR`, то есть «нет файла» —
 * ровно как у полного прохода. Сравнение без регистра — через верхний регистр, как таблица NTFS.
 */
function segmentPresence(entries: readonly fs.Dirent[], segment: string): 'exact' | 'case' | 'missing' {
  if (entries.some((entry) => entry.name === segment)) {
    return 'exact';
  }
  const upper = segment.toUpperCase();
  return entries.some((entry) => entry.name.toUpperCase() === upper) ? 'case' : 'missing';
}

/** Тот же критерий отслеживаемого файла и те же POSIX-пути, что у `walkSupportedFiles` в HashCache. */
async function listTrackedFiles(scanFs: HashScanFs, configDir: string, signal: AbortSignal | undefined): Promise<TrackedFile[]> {
  const tracked: TrackedFile[] = [];
  const pending = [configDir];
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const batch = pending.splice(0, HASH_SCAN_CONCURRENCY);
    await Promise.all(batch.map(async (dir) => {
      let entries: readonly fs.Dirent[];
      try {
        entries = await scanFs.readdir(dir);
      } catch (error) {
        // Отсутствующий каталог выгрузки и подкаталог, исчезнувший во время обхода, — это отсутствие файлов.
        rethrowUnlessGone(error);
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          pending.push(fullPath);
          continue;
        }
        const relativePath = path.relative(configDir, fullPath).replace(/\\/g, '/');
        if (isSupportedConfigFile(relativePath)) {
          tracked.push({ fullPath, relativePath });
        }
      }
    }));
  }
  return tracked;
}

/**
 * Отказ одной полосы (прерывание, EBUSY) останавливает выдачу новых файлов, но промис отклоняется только
 * после того, как ВСЕ полосы закончили текущее обращение: иначе чтения продолжались бы после отказа, держа
 * открытые дескрипторы в каталоге, который вызывающий уже удаляет или перезаписывает.
 */
async function runPool<T>(items: readonly T[], worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const errors: unknown[] = [];
  const lane = async (): Promise<void> => {
    while (errors.length === 0 && next < items.length) {
      const item = items[next];
      next += 1;
      try {
        await worker(item);
      } catch (error) {
        errors.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HASH_SCAN_CONCURRENCY, items.length) }, lane));
  if (errors.length > 0) {
    throw errors[0];
  }
}

/**
 * Исчезновение файла или каталога между обходом и обращением — то же, что его отсутствие. Любая
 * иная ошибка (EBUSY, EACCES, …) пробрасывается: пропуск заблокированного файла превратил бы его в
 * «удалённый», и частичная загрузка в БД ушла бы с удалением.
 */
function rethrowUnlessGone(error: unknown): void {
  const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return;
  }
  throw error;
}

/**
 * Есть ли у цели изменения относительно базовой линии — ровно тот же критерий, что у первой проверки
 * `import-git-changes` (нет базовой линии — все файлы новые). Нужна пакетной загрузке без обновления БД:
 * CLI на «изменений нет» отвечает кодом 0, и без предпроверки это нельзя отличить от успешной загрузки.
 */
export async function hasPendingHashChanges(
  projectRoot: string,
  kind: 'cf' | 'cfe',
  configDir: string,
  extensionName = ''
): Promise<boolean> {
  const scopeKey = buildScopeKey(kind, configDir, extensionName);
  const diff = diffHashSnapshots(loadHashCache(projectRoot, scopeKey), await scanHashSnapshot(projectRoot, scopeKey, configDir));
  return diff.added.length + diff.modified.length + diff.deleted.length > 0;
}
