import type { DatabaseLagEntry, DatabaseLagSource } from '../../infra/database/DatabaseConfigLag';

/**
 * Представление индикатора «БД не обновлена» без `vscode`: текст и tooltip статус-бара считаются здесь, а
 * адаптер (`DatabaseLagStatusBar`) только переносит их в `StatusBarItem`.
 */

export interface DatabaseLagView {
  readonly visible: boolean;
  readonly text: string;
  readonly tooltip: string;
}

const REASON_TEXT: Record<DatabaseLagSource, string> = {
  'load-without-update': 'загрузка без обновления БД',
  'update-failed': 'обновление БД не завершено',
  'cf-file-load': 'загружен CF/CFE-файл',
  'repository-receive': 'получены версии из хранилища',
};

const HONEST_NOTE =
  'Расширение не видит обновление БД, выполненное в Конфигураторе или другим пользователем: в этом случае ' +
  'отметьте цель как обновлённую.';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Локальное время отметки «дд.мм чч:мм»: год не нужен — отставание живёт часы и дни, а не годы. */
function formatSince(since: string): string {
  const date = new Date(since);
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * `now` — часть контракта (детерминизм вызова), хотя текущий формат от него не зависит: относительное время
 * («2 ч назад») можно ввести без смены сигнатуры.
 */
export function describeDatabaseLag(entries: readonly DatabaseLagEntry[], now: Date): DatabaseLagView {
  void now;
  if (entries.length === 0) {
    return { visible: false, text: '', tooltip: '' };
  }
  const text = entries.length === 1
    ? `$(database) БД не обновлена: ${entries[0].name}`
    : `$(database) БД не обновлена: ${String(entries.length)}`;
  const lines = entries.map((entry) => `• ${entry.name} — с ${formatSince(entry.since)}, ${REASON_TEXT[entry.source]}`);
  return {
    visible: true,
    text,
    tooltip: ['Конфигурация БД отстаёт от основной (по данным расширения):', ...lines, HONEST_NOTE].join('\n'),
  };
}
