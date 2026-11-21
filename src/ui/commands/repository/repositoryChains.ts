import type { OperationInteraction } from '../ext/configurationOperationTypes';
import { formatRepositoryLockName, type RepositoryNodeRef, type RepositoryTarget } from '../../../infra/repository/RepositoryService';
import type { LockedByOther } from '../../../infra/repository/RepositoryLockLog';
import {
  executeRepositoryCommitAction,
  executeRepositoryLockAction,
  executeRepositoryUnlockAction,
  executeRepositoryUpdateAction,
} from './RepositoryCommandRunner';
import {
  describeImportFailureAfterCommit,
  describeNothingToCommit,
  shouldImportAfterCommit,
  type RepositoryCommitPlan,
} from './repositoryCommitFlow';
import {
  describeImportFailureAfterLock,
  describeProjectBehindAfterLock,
  shouldImportAfterLock,
  type RepositoryLockPlan,
} from './repositoryLockFlow';
import { toCliServices } from './repositoryNodeTargets';
import {
  importTargetFromDatabase,
  loadTargetChangesIntoDatabase,
  toDatabaseLagTarget,
  type RepositoryChainServices,
} from './repositoryPostSync';
import {
  describeImportFailureAfterReceive,
  describeLoadFailureAfterReceive,
  describeProjectBehindAfterReceive,
  shouldImportAfterReceive,
  type RepositoryUpdatePlan,
} from './repositoryUpdateFlow';

/**
 * Цепочки операций хранилища — ОДИН код для UI-команд и MCP-инструментов: решённый план (вопросы
 * диалога уже отвечены — человеком или параметрами агента) → шаги → структурный результат.
 *
 * Контракт: тостов цепочки не показывают (у MCP их нет, UI показывает `warnings` сам), замок
 * берёт вызывающий (вся цепочка — одна его секция: между шагами не должна вклиниться другая
 * операция над той же базой), сбой — исключение: `RepositoryCliError`/`RepositoryCliInterruptedError`
 * операции хранилища или `RepositoryStepFailedError` шага синхронизации до неё.
 */

/**
 * Шаг синхронизации базы и проекта (загрузка правок) не выполнен до операции хранилища, и она не
 * запускалась. Причину шаг уже записал в журнал и показал сам, поэтому UI второго сообщения не даёт.
 */
export class RepositoryStepFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryStepFailedError';
  }
}

const LOAD_BEFORE_LOCK_FAILED =
  'Загрузка правок проекта в базу не выполнена; захват не выполнялся. Подробности — в журнале «1С Редактор».';
const LOAD_BEFORE_COMMIT_FAILED =
  'Загрузка правок проекта в базу не выполнена; помещение не выполнялось. Подробности — в журнале «1С Редактор».';

/**
 * Текст отказа шага с причиной раннера. В interactive причину уже показал сам раннер (тост), тексты UI
 * прежние; в unattended тостов нет, и без причины агент получил бы лишь «подробности — в журнале».
 */
export function describeChainStepFailure(base: string, reason: string | undefined, interaction: OperationInteraction): string {
  return interaction === 'unattended' && reason ? `${base} Причина: ${reason}` : base;
}

/** Шаг синхронизации цепочки с запоминанием причины отказа раннера. */
function chainStep(interaction: OperationInteraction): {
  readonly options: { readonly interaction: OperationInteraction; readonly onFailure: (reason: string) => void };
  describe(base: string): string;
} {
  let reason: string | undefined;
  return {
    options: { interaction, onFailure: (value) => { reason = value; } },
    describe: (base) => describeChainStepFailure(base, reason, interaction),
  };
}

/**
 * Поля признака «БД отстаёт» в результатах цепочек: `databaseConfigurationUpdated` — шаг загрузки цепочки
 * выполнен С обновлением БД; `databaseConfigurationBehind` — признак цели в конце цепочки (оба могут быть
 * true: UpdateDBCfg до захвата не покрывает версии, полученные захватом позже).
 */
export interface DatabaseLagFields {
  readonly databaseConfigurationUpdated: boolean;
  readonly databaseConfigurationBehind: boolean;
}

function databaseLagFields(services: RepositoryChainServices, target: RepositoryTarget, updated: boolean): DatabaseLagFields {
  return {
    databaseConfigurationUpdated: updated,
    databaseConfigurationBehind: services.databaseConfigLag.isBehind(toDatabaseLagTarget(target)),
  };
}

/**
 * Получение версий из хранилища (и очистка ссылок при помещении) меняет ОСНОВНУЮ конфигурацию базы без
 * UpdateDBCfg — для индикатора это то же отставание, что загрузка без обновления.
 */
function markReceivedFromRepository(services: RepositoryChainServices, target: RepositoryTarget): void {
  services.databaseConfigLag.markBehind(toDatabaseLagTarget(target), 'repository-receive');
}

export interface LockChainResult extends DatabaseLagFields {
  readonly lockedObjects: string[];
  readonly requestedObjects: string[];
  readonly receivedFromRepository: boolean;
  readonly databaseLoadedBefore: boolean;
  readonly projectImported: boolean;
  readonly projectBehind: boolean;
  readonly warnings: string[];
}

/**
 * Захват и, если захват получил новые версии (Э14: и без `-revised`), импорт в проект. «Обновить БД»
 * (`/UpdateDBCfg`) в цепочку не входит: импорт читает основную конфигурацию, а конфигурация БД нужна
 * только для запуска Предприятия.
 */
export async function runLockChain(
  services: RepositoryChainServices,
  target: RepositoryTarget,
  node: RepositoryNodeRef,
  recursive: boolean,
  plan: RepositoryLockPlan,
  interaction: OperationInteraction
): Promise<LockChainResult> {
  const requestedObjects = services.repositoryService.buildObjectsSelectionForNode(node, recursive).fullNames;
  const load = chainStep(interaction);
  // Сбой загрузки (в т.ч. отказ платформы загрузить незахваченный объект) — захвата не было.
  if (plan.updateDatabaseFirst
    && !await loadTargetChangesIntoDatabase(target, services, { ...load.options, updateDatabase: plan.updateDatabaseOnLoad })) {
    throw new RepositoryStepFailedError(load.describe(LOAD_BEFORE_LOCK_FAILED));
  }
  const outcome = await executeRepositoryLockAction(toCliServices(services, interaction), node, recursive, { revised: plan.revised });
  if (outcome.receivedFromRepository) {
    markReceivedFromRepository(services, target);
  }
  const warnings: string[] = [];
  let projectImported = false;
  let projectBehind = false;
  if (shouldImportAfterLock(plan, outcome)) {
    const step = chainStep(interaction);
    projectImported = await importTargetFromDatabase(target, services, step.options);
    if (!projectImported) {
      projectBehind = true;
      warnings.push(step.describe(describeImportFailureAfterLock(target.displayName)));
    }
  } else if (!plan.importAfterLock && outcome.receivedFromRepository) {
    projectBehind = true;
    warnings.push(describeProjectBehindAfterLock(target.displayName));
  }
  return {
    lockedObjects: [...outcome.lockedFullNames],
    requestedObjects,
    receivedFromRepository: outcome.receivedFromRepository,
    databaseLoadedBefore: plan.updateDatabaseFirst,
    projectImported,
    projectBehind,
    warnings,
    ...databaseLagFields(services, target, plan.updateDatabaseFirst && plan.updateDatabaseOnLoad),
  };
}

export interface UpdateChainResult extends DatabaseLagFields {
  readonly receivedFromRepository: boolean;
  readonly changesLoadedAfter: boolean;
  readonly projectImported: boolean;
  readonly projectBehind: boolean;
  readonly warnings: string[];
}

/** Получение; правки проекта загружаются ПОСЛЕ него (Э24): загруженное до получения оно бы затёрло. */
export async function runUpdateChain(
  services: RepositoryChainServices,
  target: RepositoryTarget,
  node: RepositoryNodeRef,
  request: { readonly recursive: boolean; readonly force: boolean; readonly version?: string },
  plan: RepositoryUpdatePlan,
  interaction: OperationInteraction
): Promise<UpdateChainResult> {
  const outcome = await executeRepositoryUpdateAction(toCliServices(services, interaction), node, request);
  const received = outcome.receivedFromRepository;
  if (received) {
    markReceivedFromRepository(services, target);
  }
  const load = chainStep(interaction);
  if (plan.loadChangesAfterReceive
    && !await loadTargetChangesIntoDatabase(target, services, { ...load.options, updateDatabase: plan.updateDatabaseOnLoad })) {
    // Импорт перезаписал бы незагруженные правки проекта — не выполняется; получение уже успешно.
    return {
      receivedFromRepository: received,
      changesLoadedAfter: false,
      projectImported: false,
      projectBehind: received,
      warnings: [load.describe(describeLoadFailureAfterReceive(target.displayName))],
      ...databaseLagFields(services, target, false),
    };
  }
  const warnings: string[] = [];
  let projectImported = false;
  let projectBehind = false;
  if (shouldImportAfterReceive(plan, outcome)) {
    const step = chainStep(interaction);
    projectImported = await importTargetFromDatabase(target, services, step.options);
    if (!projectImported) {
      projectBehind = true;
      warnings.push(step.describe(describeImportFailureAfterReceive(target.displayName)));
    }
  } else if (!plan.importAfterReceive && received) {
    projectBehind = true;
    warnings.push(describeProjectBehindAfterReceive(target.displayName));
  }
  return {
    receivedFromRepository: received,
    changesLoadedAfter: plan.loadChangesAfterReceive,
    projectImported,
    projectBehind,
    warnings,
    ...databaseLagFields(services, target, plan.loadChangesAfterReceive && plan.updateDatabaseOnLoad),
  };
}

export interface CommitChainResult extends DatabaseLagFields {
  readonly committedObjects: string[];
  readonly keptLocked: boolean;
  readonly referencesCleaned: boolean;
  readonly databaseLoadedBefore: boolean;
  readonly projectImported: boolean;
  readonly warnings: string[];
}

/** «Загрузить → поместить»: помещается ровно то, что загружено в базу. Очистка ссылок (Э25) — импорт. */
export async function runCommitChain(
  services: RepositoryChainServices,
  target: RepositoryTarget,
  node: RepositoryNodeRef,
  request: { readonly recursive: boolean; readonly comment: string; readonly keepLocked: boolean; readonly force: boolean },
  plan: RepositoryCommitPlan,
  interaction: OperationInteraction
): Promise<CommitChainResult> {
  const load = chainStep(interaction);
  if (plan.updateDatabaseFirst
    && !await loadTargetChangesIntoDatabase(target, services, { ...load.options, updateDatabase: plan.updateDatabaseOnLoad })) {
    throw new RepositoryStepFailedError(load.describe(LOAD_BEFORE_COMMIT_FAILED));
  }
  const outcome = await executeRepositoryCommitAction(toCliServices(services, interaction), node, request);
  if (outcome.referencesCleaned) {
    markReceivedFromRepository(services, target);
  }
  const warnings: string[] = [];
  let projectImported = false;
  if (shouldImportAfterCommit(outcome)) {
    const step = chainStep(interaction);
    projectImported = await importTargetFromDatabase(target, services, step.options);
    if (!projectImported) {
      warnings.push(step.describe(describeImportFailureAfterCommit(target.displayName)));
    }
  }
  if (outcome.committedFullNames.length === 0) {
    warnings.push(describeNothingToCommit(node.label ?? target.displayName));
  }
  return {
    committedObjects: [...outcome.committedFullNames],
    keptLocked: request.keepLocked,
    referencesCleaned: outcome.referencesCleaned,
    databaseLoadedBefore: plan.updateDatabaseFirst,
    projectImported,
    warnings,
    ...databaseLagFields(services, target, plan.updateDatabaseFirst && plan.updateDatabaseOnLoad),
  };
}

export interface UnlockChainResult {
  readonly unlockedObjects: string[];
  readonly lockedByOthers: LockedByOther[];
  readonly notUnlocked: string[];
  readonly warnings: string[];
}

/** Освобождение: учёт — по строкам лога (Э24), чужой захват — не исключение, а `lockedByOthers`. */
export async function runUnlockChain(
  services: RepositoryChainServices,
  target: RepositoryTarget,
  node: RepositoryNodeRef,
  request: { readonly recursive: boolean; readonly force: boolean },
  dirtyFilesCount: number,
  interaction: OperationInteraction
): Promise<UnlockChainResult> {
  const outcome = await executeRepositoryUnlockAction(toCliServices(services, interaction), node, request.recursive, request.force);
  const warnings = dirtyFilesCount > 0 && outcome.unlocked.length > 0
    ? [describeUnloadedChangesAfterUnlock(target.displayName, dirtyFilesCount)]
    : [];
  return {
    unlockedObjects: outcome.unlocked,
    lockedByOthers: outcome.lockedByOthers,
    notUnlocked: outcome.notUnlocked,
    warnings,
  };
}

function describeUnloadedChangesAfterUnlock(displayName: string, dirtyFilesCount: number): string {
  return `В проекте "${displayName}" незагруженных изменённых файлов: ${String(dirtyFilesCount)}; после отмены захвата ` +
    'загрузить их в базу по освобождённым объектам будет нельзя — платформа не загружает незахваченные объекты.';
}

/** Ничего не освобождено: текст для UI-предупреждения и ошибки MCP-инструмента. */
export function describeUnlockNotDone(notUnlocked: readonly string[], lockedByOthers: readonly LockedByOther[]): string {
  const names = notUnlocked.map(formatRepositoryLockName).join(', ');
  const foreign = lockedByOthers.map((item) => (item.user ? `${item.name} (${item.user})` : item.name)).join(', ');
  return `Захват не отменён: ${names}${foreign ? `; захвачено другим пользователем: ${foreign}` : ''}`;
}
