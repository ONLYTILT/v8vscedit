import type { AgentOperationHooks } from '../AgentOperationService';
import { createTransferCounter, type TransferCounter, type TransferFormat } from './TransferProgress';

/**
 * Единственный источник сообщений о ходе операции агента. Текст строится один раз и уходит в оба канала:
 * в журнал (`hooks.onMessage` — журнал, статус-бар, строка дерева) и в UI (`hooks.onProgress` — уведомление).
 * Частота каналов разная: журнал читают глазами после операции, ему нужны вехи (шаг процентов и «не реже»),
 * а уведомление живое и обновляется часто. Часы внедряются: троттлинг проверяется без реального времени.
 */

export interface AgentProgressEvent {
  readonly text: string;
  /** Счётчик этапа; у этапа без счётчика — `undefined`. */
  readonly done?: number;
  readonly total?: number;
}

export interface SyncProgressPolicy {
  /** Журнал: сообщение при пересечении очередного шага процентов… */
  readonly journalStepPercent: number;
  /** …и не реже этого интервала, даже если шаг не пересечён (медленный этап не выглядит зависшим). */
  readonly journalIntervalMs: number;
  /** UI: не чаще этого интервала (плюс все сообщения журнала). */
  readonly uiIntervalMs: number;
}

export const DEFAULT_SYNC_PROGRESS_POLICY: Readonly<SyncProgressPolicy> = Object.freeze({
  journalStepPercent: 10,
  journalIntervalMs: 15_000,
  uiIntervalMs: 500,
});

/** Текст счётчика по состоянию; байты — сумма, переданная в `advance`. */
export type ProgressFormat = (done: number, total: number, bytes: number) => string;

export interface ProgressCounter {
  advance(count?: number, bytes?: number): void;
  /** Итоговое значение, если оно ещё не показано; повторный вызов ничего не делает. */
  finish(): void;
}

export interface SyncProgress {
  /** Этап без счётчика: без троттлинга, в оба канала. */
  step(text: string): void;
  /** Счётчик этапа; при `total === 0` молчит целиком (нечего считать). */
  counter(format: ProgressFormat, total: number): ProgressCounter;
  /** Счётчик передачи по весу (байты, скорость, оставшееся время); при 0 файлов и 0 байт молчит. */
  transfer(format: TransferFormat, totals: { readonly files: number; readonly bytes: number }): TransferCounter;
}

const SILENT_COUNTER: ProgressCounter = { advance: () => undefined, finish: () => undefined };

export function createSyncProgress(
  hooks: AgentOperationHooks | undefined,
  now: () => number,
  policy: SyncProgressPolicy = DEFAULT_SYNC_PROGRESS_POLICY
): SyncProgress {
  const journal = (text: string): void => { hooks?.onMessage?.(text); };
  const ui = (event: AgentProgressEvent): void => { hooks?.onProgress?.(event); };
  return {
    step: (text) => {
      journal(text);
      ui({ text });
    },
    counter: (format, total) => (total === 0 ? SILENT_COUNTER : createCounter(format, total, now, policy, journal, ui)),
    transfer: (format, totals) => createTransferCounter(format, totals, now, policy, { journal, ui }),
  };
}

function createCounter(
  format: ProgressFormat,
  total: number,
  now: () => number,
  policy: SyncProgressPolicy,
  journal: (text: string) => void,
  ui: (event: AgentProgressEvent) => void
): ProgressCounter {
  // Номер шага — целочисленной арифметикой: «12 %» не должно стать «11,999…» на дробях.
  const stepOf = (value: number): number => Math.floor((value * 100) / (total * policy.journalStepPercent));
  let done = 0;
  let bytes = 0;
  let finished = false;
  const startedAt = now();
  let journalAt = startedAt;
  let uiAt = startedAt;
  let journalStep = stepOf(0);
  let journalDone = 0;
  let uiDone = 0;

  const emit = (toJournal: boolean, toUi: boolean, at: number): void => {
    const text = format(done, total, bytes);
    if (toJournal) {
      journal(text);
      journalAt = at;
      journalStep = stepOf(done);
      journalDone = done;
    }
    if (toUi) {
      ui({ text, done, total });
      uiAt = at;
      uiDone = done;
    }
  };

  emit(true, true, startedAt);
  return {
    advance: (count = 1, addedBytes = 0) => {
      done += count;
      bytes += addedBytes;
      const at = now();
      const toJournal = stepOf(done) > journalStep || at - journalAt >= policy.journalIntervalMs;
      // Всё, что уходит в журнал, уходит и в UI: уведомление не должно отставать от журнала.
      const toUi = toJournal || at - uiAt >= policy.uiIntervalMs;
      if (toUi) {
        emit(toJournal, toUi, at);
      }
    },
    finish: () => {
      if (finished) {
        return;
      }
      finished = true;
      if (journalDone !== done || uiDone !== done) {
        emit(journalDone !== done, uiDone !== done, now());
      }
    },
  };
}
