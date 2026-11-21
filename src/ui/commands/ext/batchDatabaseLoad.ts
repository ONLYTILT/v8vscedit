import type { DatabaseLagTarget } from '../../../infra/database/DatabaseConfigLag';
import {
  decideLagAfterLoad,
  lagSourceFor,
  settleDatabaseLag,
  type BatchLoadSteps,
  type DatabaseLoadOptions,
} from './databaseLoadPlan';

/**
 * Последовательность шагов пакетной загрузки (частичная → [применение] | запасной путь) и признак «БД
 * отстаёт». Без `vscode` и без запуска процессов: шаги исполняет вызывающий (`runInternalCliCommand`), а
 * здесь — только порядок и правила признака, общие с агентской веткой (`decideLagAfterLoad`).
 */

export type BatchLoadStepKind = 'partial' | 'update' | 'fallback';

export interface BatchLoadStepResult {
  readonly ok: boolean;
  /** Причина сбоя частичной загрузки — для вопроса о запасном пути. */
  readonly failureReason?: string;
}

export interface BatchLoadDeps {
  /**
   * Есть ли что загружать. `import-git-changes` на «изменений нет» отвечает кодом 0 — без предпроверки это
   * неотличимо от успешной загрузки, и признак «БД отстаёт» ставился бы ложно.
   */
  hasChanges(): Promise<boolean>;
  runStep(kind: BatchLoadStepKind, args: string[]): Promise<BatchLoadStepResult>;
  /** Согласие на полную загрузку после отказа частичной; `false` — операция отменена. */
  confirmFallback(failureReason: string): Promise<boolean>;
  log(line: string): void;
}

export interface BatchLoadOutcome {
  readonly ok: boolean;
  /** Выполнено ли успешное UpdateDBCfg (шаг применения или запасной путь с применением). */
  readonly databaseUpdated: boolean;
  /** Загружать было нечего: основная конфигурация не менялась. */
  readonly unchanged: boolean;
}

export async function runBatchDatabaseLoad(
  steps: BatchLoadSteps,
  target: DatabaseLagTarget,
  options: DatabaseLoadOptions,
  deps: BatchLoadDeps
): Promise<BatchLoadOutcome> {
  const source = lagSourceFor(options.updateDatabase);
  const settle = (input: Parameters<typeof decideLagAfterLoad>[0]): void => {
    settleDatabaseLag(options.lag, target, decideLagAfterLoad(input), source);
  };

  if (!await deps.hasChanges()) {
    deps.log('[update-configuration] Изменений для загрузки нет.');
    if (!steps.update) {
      return { ok: true, databaseUpdated: false, unchanged: true };
    }
    // Явное «Обновить в базе» без изменений по-прежнему применяет конфигурацию: так снимается отставание.
    const update = await deps.runStep('update', steps.update);
    settle({ loaded: update.ok, updateRequested: true, updateSucceeded: update.ok, ambiguousFailure: false });
    return { ok: update.ok, databaseUpdated: update.ok, unchanged: true };
  }

  const partial = await deps.runStep('partial', steps.partial);
  if (!partial.ok) {
    // Сбой частичной загрузки: изменена ли основная конфигурация, по коду возврата не понять.
    settle({ loaded: false, updateRequested: options.updateDatabase, updateSucceeded: false, ambiguousFailure: true });
    deps.log('[update-configuration] Частичная загрузка по хеш-кэшу недоступна, запрашиваю подтверждение полной загрузки.');
    if (!await deps.confirmFallback(partial.failureReason ?? '')) {
      deps.log('[update-configuration] Полная загрузка отклонена пользователем.');
      return { ok: false, databaseUpdated: false, unchanged: false };
    }
    const fallback = await deps.runStep('fallback', steps.fallback);
    settle({
      loaded: fallback.ok,
      updateRequested: steps.fallbackUpdatesDatabase,
      updateSucceeded: fallback.ok,
      // `sync-configuration-full` = загрузка + применение: на каком шаге сбой, не определить.
      ambiguousFailure: !fallback.ok,
    });
    return { ok: fallback.ok, databaseUpdated: fallback.ok && steps.fallbackUpdatesDatabase, unchanged: false };
  }

  // Загрузка прошла: до применения отметка уже стоит — сбой реструктуризации её не потеряет.
  settle({ loaded: true, updateRequested: options.updateDatabase, updateSucceeded: false, ambiguousFailure: false });
  if (!steps.update) {
    return { ok: true, databaseUpdated: false, unchanged: false };
  }
  const update = await deps.runStep('update', steps.update);
  settle({ loaded: true, updateRequested: true, updateSucceeded: update.ok, ambiguousFailure: false });
  return { ok: update.ok, databaseUpdated: update.ok, unchanged: false };
}
