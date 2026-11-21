/**
 * Чистое решение команды захвата объектов хранилища: какие шаги выполнятся. Без `vscode`, чтобы
 * набор шагов был виден в unit-тесте.
 *
 * Поправка по эксперименту Э14: платформа получает версию изменённого в хранилище объекта при
 * захвате и БЕЗ ключа `-revised`, поэтому импорт решается по логу захвата (строки «Объект получен
 * из хранилища»), а настройка управляет только самим ключом.
 */

export type LockLocalChangesChoice = 'update-then-lock' | 'lock-without-import' | 'cancel';

export interface RepositoryLockPlan {
  readonly revised: boolean;
  readonly updateDatabaseFirst: boolean;
  /** Обновлять ли конфигурацию БД на шаге загрузки (настройка `updateDatabaseAfterLoad`); шага нет — `false`. */
  readonly updateDatabaseOnLoad: boolean;
  /** Разрешён ли импорт после захвата; выполняется он только если захват что-то получил. */
  readonly importAfterLock: boolean;
}

export interface RepositoryLockOutcome {
  readonly lockedFullNames: readonly string[];
  readonly receivedFromRepository: boolean;
}

/**
 * Вопрос задаётся при любом значении настройки: захват может получить версии и без `-revised`, а
 * последующий импорт перезаписал бы незагруженные правки проекта молча.
 */
export function planRepositoryLock(input: {
  readonly revisedSetting: boolean;
  readonly dirtyFilesCount: number;
  readonly choice?: LockLocalChangesChoice;
  readonly updateDatabaseAfterLoad: boolean;
}): RepositoryLockPlan | 'ask' | 'cancel' {
  if (input.dirtyFilesCount <= 0) {
    return { revised: input.revisedSetting, updateDatabaseFirst: false, updateDatabaseOnLoad: false, importAfterLock: true };
  }
  switch (input.choice) {
    case undefined:
      return 'ask';
    case 'update-then-lock':
      return {
        revised: input.revisedSetting,
        updateDatabaseFirst: true,
        updateDatabaseOnLoad: input.updateDatabaseAfterLoad,
        importAfterLock: true,
      };
    case 'lock-without-import':
      return { revised: false, updateDatabaseFirst: false, updateDatabaseOnLoad: false, importAfterLock: false };
    case 'cancel':
      return 'cancel';
  }
}

export function shouldImportAfterLock(plan: RepositoryLockPlan, outcome: RepositoryLockOutcome): boolean {
  return plan.importAfterLock && outcome.receivedFromRepository;
}

export function describeImportFailureAfterLock(displayName: string): string {
  return `Объекты "${displayName}" захвачены, их версии из хранилища получены в базу, но импорт в файлы проекта ` +
    'не выполнен (причина — в журнале и в предыдущем сообщении). Выполните «Импорт конфигурации» до любой ' +
    'загрузки в базу: «Обновить БД» из устаревших файлов перезапишет полученные версии.';
}

export function describeProjectBehindAfterLock(displayName: string): string {
  return `Захват получил из хранилища новые версии объектов "${displayName}", файлы проекта не обновлены. ` +
    'Чтобы не потерять незагруженные правки, сначала загрузите их в базу («Обновить БД»), затем выполните ' +
    '«Импорт конфигурации»: до импорта файлы проекта по полученным объектам устарели.';
}
