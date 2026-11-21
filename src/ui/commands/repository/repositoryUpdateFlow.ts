import { formatRepositoryLockName } from '../../../infra/repository/RepositoryService';

/**
 * Чистое решение команды «Получить из хранилища»: какие шаги выполнятся. Без `vscode`, чтобы набор
 * шагов был виден в unit-тесте.
 *
 * `/ConfigurationRepositoryUpdateCfg` пишет полученные версии в основную конфигурацию базы, а файлы
 * проекта остаются прежними: следующая «Обновить БД» из них перезаписала бы полученное. Поэтому
 * после получения изменившиеся объекты импортируются в проект — как после захвата (repositoryLockFlow).
 * Решение об импорте принимается по логу (строки «Объект получен из хранилища»), а не по факту успеха:
 * получение без новых версий проект не трогает.
 *
 * Э24 (plan §5b п.31): получение возвращает к версии хранилища и ЗАХВАЧЕННЫЙ объект — с `-force` и
 * без, — и его правки в базе теряются. Отсюда два правила: правки проекта загружаются в базу ПОСЛЕ
 * получения (загруженные до него оно бы затёрло, а импорт затем перезаписал бы ими же проект), а
 * захваченные объекты в выборке требуют подтверждения: правки, загруженные в базу раньше и не
 * помещённые, так не вернуть.
 */

export type UpdateLocalChangesChoice = 'receive-then-load' | 'receive-without-import' | 'cancel';

export interface RepositoryUpdatePlan {
  /** Загрузить правки проекта в базу после получения, до импорта. */
  readonly loadChangesAfterReceive: boolean;
  /** Обновлять ли конфигурацию БД на шаге загрузки (настройка `updateDatabaseAfterLoad`); шага нет — `false`. */
  readonly updateDatabaseOnLoad: boolean;
  /** Разрешён ли импорт после получения; выполняется он, только если получение что-то получило. */
  readonly importAfterReceive: boolean;
}

export interface RepositoryUpdateOutcome {
  readonly receivedFromRepository: boolean;
}

export type RepositoryUpdateDecision = RepositoryUpdatePlan | 'ask-locked-overwrite' | 'ask-local-changes' | 'cancel';

/**
 * Вопрос о захваченных объектах — первым: при отказе вопрос о правках проекта не нужен. Незагруженные
 * правки проекта импорт перезаписал бы молча, поэтому при них задаётся второй вопрос.
 */
export function planRepositoryUpdate(input: {
  readonly dirtyFilesCount: number;
  readonly lockedInSelection: readonly string[];
  readonly lockedOverwriteConfirmed?: boolean;
  readonly choice?: UpdateLocalChangesChoice;
  readonly updateDatabaseAfterLoad: boolean;
}): RepositoryUpdateDecision {
  if (input.lockedInSelection.length > 0) {
    if (input.lockedOverwriteConfirmed === undefined) {
      return 'ask-locked-overwrite';
    }
    if (!input.lockedOverwriteConfirmed) {
      return 'cancel';
    }
  }
  if (input.dirtyFilesCount <= 0) {
    return { loadChangesAfterReceive: false, updateDatabaseOnLoad: false, importAfterReceive: true };
  }
  switch (input.choice) {
    case undefined:
      return 'ask-local-changes';
    case 'receive-then-load':
      return { loadChangesAfterReceive: true, updateDatabaseOnLoad: input.updateDatabaseAfterLoad, importAfterReceive: true };
    case 'receive-without-import':
      return { loadChangesAfterReceive: false, updateDatabaseOnLoad: false, importAfterReceive: false };
    case 'cancel':
      return 'cancel';
  }
}

export function shouldImportAfterReceive(plan: RepositoryUpdatePlan, outcome: RepositoryUpdateOutcome): boolean {
  return plan.importAfterReceive && outcome.receivedFromRepository;
}

const LOCKED_NAMES_SHOWN = 5;

export function describeLockedOverwrite(lockedFullNames: readonly string[]): string {
  const shown = lockedFullNames.slice(0, LOCKED_NAMES_SHOWN).map(formatRepositoryLockName).join(', ');
  const rest = lockedFullNames.length - LOCKED_NAMES_SHOWN;
  return `Захвачены вами: ${shown}${rest > 0 ? ` и ещё ${String(rest)}` : ''}. Получение вернёт их в базе к версии ` +
    'хранилища: правки, загруженные в базу и не помещённые, будут потеряны.';
}

export function describeImportFailureAfterReceive(displayName: string): string {
  return `Версии объектов "${displayName}" получены из хранилища в базу, но импорт в файлы проекта не выполнен ` +
    '(причина — в журнале и в предыдущем сообщении). Выполните «Импорт конфигурации» до любой загрузки в базу: ' +
    '«Обновить БД» из устаревших файлов перезапишет полученные версии.';
}

export function describeLoadFailureAfterReceive(displayName: string): string {
  return `Версии объектов "${displayName}" получены из хранилища, но правки проекта в базу не загружены ` +
    '(причина — в журнале и в предыдущем сообщении), поэтому импорт не выполнялся: он перезаписал бы правки. ' +
    'Загрузите правки («Обновить БД»), затем выполните «Импорт конфигурации».';
}

export function describeProjectBehindAfterReceive(displayName: string): string {
  return `Из хранилища получены новые версии объектов "${displayName}", файлы проекта не обновлены. ` +
    'Чтобы не потерять незагруженные правки, сначала загрузите их в базу («Обновить БД»), затем выполните ' +
    '«Импорт конфигурации»: до импорта файлы проекта по полученным объектам устарели.';
}
