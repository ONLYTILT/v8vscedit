// Чистое решение наблюдателя скрытого прогона: ждать / готово / сбой. Без I/O — покрывается
// тестом; scripts/test-hidden.mjs только собирает факты (состояние задачи, файл результата, время).

/** Состояния задачи, при которых прогон ещё идёт или вот-вот начнётся. */
const ACTIVE_STATES = new Set(['Running', 'Queued']);

/** Сколько подряд опросов «не выполняется» после окна старта нужно для отказа: один неудачный
 *  вызов Get-ScheduledTask не должен объявлять живой прогон упавшим. */
export const NOT_RUNNING_POLLS_TO_FAIL = 2;

/**
 * @param {{ taskState: string | undefined, result: { id?: string, exitCode?: unknown } | undefined,
 *           expectedId: string, elapsedMs: number, startGraceMs: number, notRunningPolls: number }} facts
 *   notRunningPolls — число подряд идущих опросов ПОСЛЕ окна старта, где задача не активна.
 * @returns {{ action: 'wait' } | { action: 'done', exitCode: number } | { action: 'fail', reason: string, exitCode: number }}
 */
export function decideHiddenRunState({ taskState, result, expectedId, elapsedMs, startGraceMs, notRunningPolls }) {
  if (result !== undefined) {
    // Результат без id пишет исполнитель, который не смог прочитать запрос, либо его устаревшая копия.
    if (typeof result.id !== 'string' || result.id === '') {
      return {
        action: 'fail',
        reason: 'результат без id: исполнитель устарел или не прочитал запрос — см. run.log; при необходимости перерегистрируйте register.ps1',
        exitCode: 4,
      };
    }
    // Результат чужого запроса — признак гонки двух запусков: доверять ему нельзя.
    if (result.id !== expectedId) {
      return { action: 'fail', reason: 'результат принадлежит другому запросу (параллельный запуск)', exitCode: 4 };
    }
    return Number.isInteger(result.exitCode)
      ? { action: 'done', exitCode: /** @type {number} */ (result.exitCode) }
      : { action: 'fail', reason: 'некорректный код выхода в result.json', exitCode: 4 };
  }
  if (taskState !== undefined && ACTIVE_STATES.has(taskState)) {
    return { action: 'wait' };
  }
  // До старта задача какое-то время не активна — ждём окно; после него отказ только при
  // подтверждении несколькими опросами (иначе наблюдатель ждал бы вечно — или ошибался на одном сбое).
  if (elapsedMs < startGraceMs || notRunningPolls < NOT_RUNNING_POLLS_TO_FAIL) {
    return { action: 'wait' };
  }
  return { action: 'fail', reason: `задача не выполняется (состояние: ${taskState ?? 'неизвестно'}), результата нет`, exitCode: 4 };
}

/** Белый список скриптов — тот же, что в runner.ps1: опечатка видна сразу, а не кодом 3 от SYSTEM. */
export const HIDDEN_ALLOWED_SCRIPTS = Object.freeze(['test', 'test:fast', 'coverage:changed']);
