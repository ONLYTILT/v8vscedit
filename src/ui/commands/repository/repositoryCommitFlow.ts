/**
 * Чистое решение команды «Поместить в хранилище»: какие шаги выполнятся. Без `vscode`, чтобы набор
 * шагов был виден в unit-тесте (образец — repositoryLockFlow/repositoryUpdateFlow).
 *
 * Помещается то, что загружено в базу, поэтому незагруженные правки проекта либо загружаются перед
 * помещением, либо помещение отменяется: поместить «как есть» значило бы записать в хранилище не ту
 * версию, что в файлах.
 *
 * Э25 (plan §5b п.32): `-force` с очисткой ссылок на удалённые объекты меняет базу помещающего,
 * поэтому после такого помещения проект отстаёт от базы и нужен импорт.
 */

export type CommitLocalChangesChoice = 'load-first' | 'cancel';

export interface RepositoryCommitPlan {
  /** Загрузить правки проекта в базу перед помещением. */
  readonly updateDatabaseFirst: boolean;
}

export interface RepositoryCommitOutcome {
  /** Помещённые объекты — по строкам лога «Объект помещен в хранилище» (Э25). */
  readonly committedFullNames: readonly string[];
  readonly referencesCleaned: boolean;
}

export function planRepositoryCommit(input: {
  readonly dirtyFilesCount: number;
  readonly choice?: CommitLocalChangesChoice;
}): RepositoryCommitPlan | 'ask' | 'cancel' {
  if (input.dirtyFilesCount <= 0) {
    return { updateDatabaseFirst: false };
  }
  switch (input.choice) {
    case undefined:
      return 'ask';
    case 'load-first':
      return { updateDatabaseFirst: true };
    case 'cancel':
      return 'cancel';
  }
}

export function shouldImportAfterCommit(outcome: RepositoryCommitOutcome): boolean {
  return outcome.referencesCleaned;
}

export function describeImportFailureAfterCommit(displayName: string): string {
  return `Изменения "${displayName}" помещены в хранилище, платформа при этом выполнила очистку ссылок на удалённые ` +
    'объекты в базе, но импорт в файлы проекта не выполнен (причина — в журнале и в предыдущем сообщении). ' +
    'Выполните «Импорт конфигурации» до любой загрузки в базу: «Обновить БД» из устаревших файлов вернёт удалённые ссылки.';
}

export function describeNothingToCommit(displayName: string): string {
  return `Помещение "${displayName}" выполнено, но нечего помещать: платформа сообщила, что объекты не изменены.`;
}
