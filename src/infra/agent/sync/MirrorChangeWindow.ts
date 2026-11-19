import type { AgentFileEntry } from '../files/AgentFileStore';
import { AgentTransferCancelledError } from '../files/AgentFileTransfer';
import {
  AgentSyncCancelledError,
  EXCHANGE_MIRROR_MARKER_SUFFIX,
  exchangeDirOf,
  type SyncOperationContext,
} from './SyncContext';

/**
 * Отбор файлов дельты импорта по времени изменения в M (plan-delta-progress.md §1). Инвариант M/P/B: после
 * успешной операции P ≡ M, поэтому файл M, который эта операция не переписала (mtime раньше метки), равен
 * P, если сам P не менялся (это ловит B). Такой файл скачивать незачем — раньше скачивались ВСЕ файлы
 * изменённых владельцев, и лишь приёмник отбрасывал совпадающие (минуты на десятках владельцев).
 *
 * Сравнение — ТОЛЬКО с меткой, записанной на сервере этой же операцией: часы клиента не участвуют. У
 * настоящего агента время по SFTP — местное время сервера, выданное как UTC (Э23: сдвиг ~1 ч), и любое
 * сравнение с `Date.now()` дало бы ложный пропуск. Любая неопределённость (метки нет, у записи нет времени,
 * растяжка) возвращает прежнее поведение — скачивание.
 */

/**
 * Запас порога, секунд: секундная гранулярность SFTP, 2-секундная FAT/SMB и запись в ту же секунду, что
 * метка. Цена — лишнее скачивание файлов, переписанных за 2 с до метки (на практике таких нет).
 */
export const MARKER_SAFETY_SEC = 2;

/**
 * Выключатель отбора. Э23 (локальный агент 8.3.27, `dump --update --force`) подтвердил: mtime по SFTP
 * не меньше метки ровно у переписанных файлов. Если стенд с клиент-серверной базой это опровергнет,
 * отбор выключается здесь, а прогресс остаётся.
 */
export const MIRROR_MTIME_SELECTION_ENABLED = true;

export interface MirrorMarker {
  /** Порог: файл с секундой mtime не меньше порога считается переписанным в этой операции. */
  readonly sinceSec: number;
}

/**
 * Метка времени сервера: пустой файл рядом с каталогом обмена и его mtime по STAT. Берётся ДО любой мутации M в
 * операции (раньше — консервативнее). Отказ — не сбой операции: прежнее поведение и причина в журнал;
 * отмена пробрасывается.
 */
export async function takeMirrorMarker(context: SyncOperationContext): Promise<MirrorMarker | undefined> {
  const rel = `${exchangeDirOf(context)}${EXCHANGE_MIRROR_MARKER_SUFFIX}`;
  let reason: string;
  try {
    await context.store.writeFile(rel, '');
    const mtimeMs = (await context.store.stat(rel))?.mtimeMs;
    if (mtimeMs !== undefined) {
      return { sinceSec: Math.floor(mtimeMs / 1000) - MARKER_SAFETY_SEC };
    }
    reason = 'хранилище не сообщило время изменения файла';
  } catch (error) {
    if (error instanceof AgentSyncCancelledError || error instanceof AgentTransferCancelledError) {
      throw error;
    }
    // Сообщение журнала — одна строка: текст отказа SFTP бывает многострочным.
    reason = String(error).replace(/\s+/g, ' ').trim();
  }
  context.progress.step(`Метка времени сервера не получена (${reason}): файлы изменённых объектов будут сравниваться целиком.`);
  return undefined;
}

export interface MirrorDownloadInput {
  /** Файлы, которые есть в M (без источника точечной выгрузки), — пути от каталога цели. */
  readonly candidates: readonly string[];
  /** Записи M из уже сделанных LIST/STAT (лишних запросов отбор не делает). */
  readonly entries: ReadonlyMap<string, AgentFileEntry>;
  readonly marker: MirrorMarker | undefined;
  /** Скачиваются всегда: грязные относительно B, неотслеживаемые B, совпадающие с удаляемым путём. */
  readonly mustFetch: ReadonlySet<string>;
  /** Размер файла в P; `undefined` — файла нет. */
  readonly projectSizeOf: (rel: string) => number | undefined;
  /** В операции был `--update` по изменённым владельцам: хотя бы один их файл обязан стать свежим. */
  readonly expectRewrites: boolean;
}

export interface MirrorDownloadSelection {
  /** Что скачивать, в порядке кандидатов. */
  readonly download: string[];
  /** Пропущено как не переписанное в этой операции. */
  readonly unchanged: number;
  /** Старые файлы, чей размер в P расходится с M: нарушенный инвариант, берутся из M (самовосстановление). */
  readonly sizeMismatch: string[];
  /** Почему отбор не применён: метки нет или растяжка (ожидалась перезапись, а свежих файлов нет). */
  readonly fallback?: 'no-marker' | 'no-rewritten-files';
}

export function selectMirrorDownloads(input: MirrorDownloadInput): MirrorDownloadSelection {
  const { candidates, entries, marker, mustFetch } = input;
  if (marker === undefined) {
    return { download: [...candidates], unchanged: 0, sizeMismatch: [], fallback: 'no-marker' };
  }
  const isFresh = (rel: string): boolean => {
    const mtimeMs = entries.get(rel)?.mtimeMs;
    return mtimeMs !== undefined && Math.floor(mtimeMs / 1000) >= marker.sinceSec;
  };
  // Растяжка: `--update` прошёл по изменённым владельцам, а ни один файл не стал свежим — значит, платформа
  // (или ФС) не обновляет время, и пропуск по нему молча потерял бы изменения. Судить можно, только если
  // есть файлы вне обязательных: их отбор и решается временем.
  if (input.expectRewrites && candidates.some((rel) => !mustFetch.has(rel)) && !candidates.some(isFresh)) {
    return { download: [...candidates], unchanged: 0, sizeMismatch: [], fallback: 'no-rewritten-files' };
  }
  const download: string[] = [];
  const sizeMismatch: string[] = [];
  let unchanged = 0;
  for (const rel of candidates) {
    const entry = entries.get(rel);
    if (mustFetch.has(rel) || entry?.mtimeMs === undefined || isFresh(rel)) {
      download.push(rel);
      continue;
    }
    const projectSize = input.projectSizeOf(rel);
    if (projectSize === undefined) {
      download.push(rel);
    } else if (projectSize !== entry.size) {
      download.push(rel);
      sizeMismatch.push(rel);
    } else {
      unchanged += 1;
    }
  }
  return { download, unchanged, sizeMismatch };
}
