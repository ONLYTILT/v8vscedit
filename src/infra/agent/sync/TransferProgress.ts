import type { AgentProgressEvent, SyncProgressPolicy } from './SyncProgress';

/**
 * Счётчик передачи по ВЕСУ (plan-large-files.md §3.1). Счётчик по числу файлов врал на больших файлах: один
 * файл в 1,18 ГБ выглядел как «27 из 28 (96%)» десятки минут. Вехи журнала — по байтам (при нулевом весе — по
 * файлам), скорость — скользящее окно, оценка времени — остаток / скорость. Троттлинг каналов тот же, что у
 * `SyncProgress.counter`. Часы внедряются: тесты подают время вручную.
 */

/** Окно скорости: короче — скачет на неравномерных ответах сервера, длиннее — запаздывает за сменой канала. */
export const RATE_WINDOW_MS = 10_000;
/** Меньше секунды выборок — скорость не измерена (первые порции дают случайные всплески). */
export const MIN_RATE_SPAN_MS = 1_000;

export interface TransferState {
  readonly doneFiles: number;
  readonly totalFiles: number;
  readonly doneBytes: number;
  readonly totalBytes: number;
  /** Нет — скорость ещё не измерена. */
  readonly bytesPerSec?: number;
  readonly etaSec?: number;
}

export type TransferFormat = (state: TransferState) => string;

export interface TransferCounter {
  /** Порция внутри файла (`onProgress` потокового скачивания). */
  addBytes(bytes: number): void;
  /** Файл завершён; неизвестный заранее размер добавляется и в выполненное, и во всё. */
  fileDone(bytesIfUntracked?: number): void;
  /** Итог недостающему каналу; идемпотентно. */
  finish(): void;
}

export interface TransferChannels {
  readonly journal: (text: string) => void;
  readonly ui: (event: AgentProgressEvent) => void;
}

const SILENT: TransferCounter = { addBytes: () => undefined, fileDone: () => undefined, finish: () => undefined };

export function createTransferCounter(
  format: TransferFormat,
  totals: { readonly files: number; readonly bytes: number },
  now: () => number,
  policy: SyncProgressPolicy,
  channels: TransferChannels
): TransferCounter {
  if (totals.files === 0 && totals.bytes === 0) {
    return SILENT;
  }
  let doneFiles = 0;
  let doneBytes = 0;
  let totalBytes = totals.bytes;
  let finished = false;
  // Мера вех и UI: байты, а без веса — файлы (как у счётчика по числу).
  const measure = (): readonly [number, number] => (totalBytes > 0 ? [doneBytes, totalBytes] : [doneFiles, totals.files]);
  // Номер шага — целочисленной арифметикой: «12 %» не должно стать «11,999…» на дробях.
  const stepOf = (): number => {
    const [done, total] = measure();
    return Math.floor((done * 100) / (total * policy.journalStepPercent));
  };
  const startedAt = now();
  const samples: { t: number; bytes: number }[] = [{ t: startedAt, bytes: 0 }];
  let journalAt = startedAt;
  let uiAt = startedAt;
  let journalStep = stepOf();
  let journalText: string | undefined;
  let uiText: string | undefined;

  const sample = (at: number): void => {
    const last = samples[samples.length - 1];
    if (last.t === at) {
      last.bytes = doneBytes;
    } else {
      samples.push({ t: at, bytes: doneBytes });
    }
    while (samples[0].t < at - RATE_WINDOW_MS) {
      samples.shift();
    }
  };

  const state = (): TransferState => {
    const first = samples[0];
    const last = samples[samples.length - 1];
    const span = last.t - first.t;
    const base = { doneFiles, totalFiles: totals.files, doneBytes, totalBytes };
    if (span < MIN_RATE_SPAN_MS) {
      return base;
    }
    const bytesPerSec = ((last.bytes - first.bytes) * 1000) / span;
    return bytesPerSec > 0
      ? { ...base, bytesPerSec, etaSec: Math.max(0, totalBytes - doneBytes) / bytesPerSec }
      : { ...base, bytesPerSec };
  };

  const emit = (toJournal: boolean, toUi: boolean, at: number, text: string): void => {
    if (toJournal) {
      channels.journal(text);
      journalAt = at;
      journalStep = stepOf();
      journalText = text;
    }
    if (toUi) {
      const [done, total] = measure();
      channels.ui({ text, done, total });
      uiAt = at;
      uiText = text;
    }
  };

  const update = (): void => {
    const at = now();
    sample(at);
    const toJournal = stepOf() > journalStep || at - journalAt >= policy.journalIntervalMs;
    // Всё, что уходит в журнал, уходит и в UI: уведомление не должно отставать от журнала.
    if (toJournal || at - uiAt >= policy.uiIntervalMs) {
      emit(toJournal, true, at, format(state()));
    }
  };

  emit(true, true, startedAt, format(state()));
  return {
    addBytes: (bytes) => {
      doneBytes += bytes;
      update();
    },
    fileDone: (bytesIfUntracked) => {
      doneFiles += 1;
      if (bytesIfUntracked !== undefined) {
        doneBytes += bytesIfUntracked;
        totalBytes += bytesIfUntracked;
      }
      update();
    },
    finish: () => {
      if (finished) {
        return;
      }
      finished = true;
      const at = now();
      sample(at);
      const text = format(state());
      // Сравнение по тексту: последнее значение могло уйти в один канал и не уйти в другой.
      if (text !== journalText || text !== uiText) {
        emit(text !== journalText, text !== uiText, at, text);
      }
    },
  };
}
