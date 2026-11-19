/**
 * Чистое решение команды «Получить из хранилища»: какие шаги выполнятся. Без `vscode`, чтобы набор
 * шагов был виден в unit-тесте.
 *
 * `/ConfigurationRepositoryUpdateCfg` пишет полученные версии в основную конфигурацию базы, а файлы
 * проекта остаются прежними: следующая «Обновить БД» из них перезаписала бы полученное. Поэтому
 * после получения изменившиеся объекты импортируются в проект — как после захвата (repositoryLockFlow).
 * Решение об импорте принимается по логу (строки «Объект получен из хранилища»), а не по факту успеха:
 * получение без новых версий проект не трогает.
 */

export type UpdateLocalChangesChoice = 'update-then-receive' | 'receive-without-import' | 'cancel';

export interface RepositoryUpdatePlan {
  readonly updateDatabaseFirst: boolean;
  /** Разрешён ли импорт после получения; выполняется он, только если получение что-то получило. */
  readonly importAfterReceive: boolean;
}

export interface RepositoryUpdateOutcome {
  readonly receivedFromRepository: boolean;
}

/**
 * Незагруженные правки проекта импорт перезаписал бы молча, поэтому при них задаётся вопрос.
 */
export function planRepositoryUpdate(input: {
  readonly dirtyFilesCount: number;
  readonly choice?: UpdateLocalChangesChoice;
}): RepositoryUpdatePlan | 'ask' | 'cancel' {
  if (input.dirtyFilesCount <= 0) {
    return { updateDatabaseFirst: false, importAfterReceive: true };
  }
  switch (input.choice) {
    case undefined:
      return 'ask';
    case 'update-then-receive':
      return { updateDatabaseFirst: true, importAfterReceive: true };
    case 'receive-without-import':
      return { updateDatabaseFirst: false, importAfterReceive: false };
    case 'cancel':
      return 'cancel';
  }
}

export function shouldImportAfterReceive(plan: RepositoryUpdatePlan, outcome: RepositoryUpdateOutcome): boolean {
  return plan.importAfterReceive && outcome.receivedFromRepository;
}

export function describeImportFailureAfterReceive(displayName: string): string {
  return `Версии объектов "${displayName}" получены из хранилища в базу, но импорт в файлы проекта не выполнен ` +
    '(причина — в журнале и в предыдущем сообщении). Выполните «Импорт конфигурации» до любой загрузки в базу: ' +
    '«Обновить БД» из устаревших файлов перезапишет полученные версии.';
}

export function describeProjectBehindAfterReceive(displayName: string): string {
  return `Из хранилища получены новые версии объектов "${displayName}", файлы проекта не обновлены. ` +
    'Чтобы не потерять незагруженные правки, сначала загрузите их в базу («Обновить БД»), затем выполните ' +
    '«Импорт конфигурации»: до импорта файлы проекта по полученным объектам устарели.';
}
