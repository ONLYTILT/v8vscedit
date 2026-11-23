import * as fs from 'fs';
import * as vscode from 'vscode';
import type { RepositoryBinding, RepositoryNodeRef, RepositoryService, RepositoryTarget } from '../../../infra/repository/RepositoryService';
import { toSelectionNodes, type RepositoryNodeSelection } from '../../../infra/repository/RepositoryObjectsSelection';
import { resolveDbPassword, type ProjectSecretStorage } from '../../../infra/environment';
import {
  formatCommandLineForLog,
  normalizeInfoBasePath,
  resolveV8ExecutablePath,
  resolveV8PathHintFromVersion,
} from '../../../infra/process';
import {
  describeDesignerArgs,
  type DesignerBatchExecutor,
  type DesignerBatchResult,
} from '../../../infra/process/designer/DesignerBatchExecutor';
import { moveStagingToTarget } from '../../../infra/fs/StagingFile';
import {
  buildRepositoryDesignerRequest,
  type RepositoryOperation,
} from '../../../infra/repository/RepositoryDesignerArgs';
import {
  hasReceivedFromRepository,
  hasReferencesCleaned,
  isUnlockLogRecognized,
  parseRepositoryLockLog,
  resolveCommittedFullNames,
  resolveLockedFullNames,
  resolveNotCommittedFullNames,
  resolveOverwrittenLocked,
  resolveUnlockedFullNames,
  type LockedByOther,
} from '../../../infra/repository/RepositoryLockLog';
import type { RepositoryLockOutcome } from './repositoryLockFlow';
import type { RepositoryUpdateOutcome } from './repositoryUpdateFlow';
import type { RepositoryCommitOutcome } from './repositoryCommitFlow';
import { releaseAgentInfoBaseForBatch } from '../ext/agent/AgentServiceRegistry';
import { acquireDesignerBatchExecutor, type DesignerExecutorDeps } from '../ext/designerExecutorRegistry';
import {
  beginRepositoryOperationStatus,
  endRepositoryOperationStatus,
  trimStatusMessage,
  updateRepositoryOperationStatus,
} from './repositoryStatusBar';

// Статус-бар вынесен ради размера раннера; прежние точки импорта (Container, тесты) сохраняются.
export {
  beginRepositoryOperationStatus,
  disposeRepositoryCommandStatusBar,
  endRepositoryOperationStatus,
  setRepositoryOperationStatus,
  updateRepositoryOperationStatus,
} from './repositoryStatusBar';

interface ConnectionParams {
  infoBasePath?: string;
  infoBaseServer?: string;
  infoBaseRef?: string;
  userName?: string;
  password?: string;
  v8Path?: string;
  /** `--v8version` env.json: по нему путь к 1cv8 на сервере выводится, если `remote.v8Path` пуст. */
  v8Version?: string;
}

/** Запуск операции хранилища без UI-сообщений: исход — результат или исключение. */
export interface RepositoryCliExecuteOptions {
  operation: RepositoryOperation;
  target: RepositoryTarget;
  bindingOverride?: RepositoryBinding;
  /** Выходной файл операции (dump/report): staging переносится на `targetPath` только при успехе. */
  output?: { name: string; targetPath: string };
  progressTitle: string;
  progressStartMessage: string;
  errorTitle: string;
  failureOperation?: string;
  /** Получает результат запуска: по логу платформы уточняется, что именно сделано (Н10). */
  afterSuccess?: (result: DesignerBatchResult) => void | Promise<void>;
  /**
   * Получает результат отказа платформы (exit≠0) до исключения: отказ бывает частичным, и сделанное
   * по логу (освобождение части объектов, Э24) должно попасть в учёт.
   */
  afterPlatformFailure?: (result: DesignerBatchResult) => void;
}

interface RepositoryCliRunOptions extends RepositoryCliExecuteOptions {
  successMessage: string;
  showSuccessMessage?: boolean;
}

/**
 * Отказ операции хранилища после её запуска (платформа, агент, выходной файл). `title` — заголовок
 * для человека, `message` — «Ошибка при <операции>: <причина>»: тот же текст, что UI показывал всегда.
 */
export class RepositoryCliError extends Error {
  constructor(
    readonly title: string,
    message: string,
    readonly log?: string,
    readonly exitCode?: number
  ) {
    super(message);
    this.name = 'RepositoryCliError';
  }
}

/** Операция прервана пользователем («Отмена» прогресса). Это не отказ платформы: её решение — человека. */
export class RepositoryCliInterruptedError extends Error {
  constructor(
    /** Заголовок прогресса операции: UI показывает «<заголовок>: <текст прерывания>». */
    readonly title: string,
    message: string
  ) {
    super(message);
    this.name = 'RepositoryCliInterruptedError';
  }
}

export interface RepositoryCliServices {
  workspaceFolder: vscode.WorkspaceFolder;
  outputChannel: vscode.OutputChannel;
  repositoryService: RepositoryService;
  projectSecretStorage: ProjectSecretStorage;
  /**
   * Фабрика исполнителя пакетного конфигуратора — приоритетный шов под интеграционный тест без
   * установленной платформы. Без неё исполнитель выбирает реестр (локальный или удалённый).
   */
  createDesignerExecutor?: (v8Path: string, cwd: string) => DesignerBatchExecutor;
  /** Шов реестра исполнителей (подмена хоста PowerShell в тестах); в продукте не задаётся. */
  designerExecutorDeps?: DesignerExecutorDeps;
}

interface ResolvedExecutor {
  readonly executor: DesignerBatchExecutor;
  readonly v8Path: string;
  readonly connection: ConnectionParams;
}

interface PreparedRepositoryRun extends ResolvedExecutor {
  readonly binding: RepositoryBinding;
}

/** Подключение из env.json: путь к 1cv8 вычислен всегда (пустая строка — искать стандартную установку). */
type ResolvedConnection = ConnectionParams & { v8Path: string };

/**
 * Исполнитель и путь к 1cv8. Ошибки конфигурации (env.json, удалённый режим) бросаются здесь,
 * ДО начала операции: статус не включается, на сервер ничего не уходит.
 */
async function resolveExecutor(connection: ResolvedConnection, services: RepositoryCliServices): Promise<ResolvedExecutor> {
  if (services.createDesignerExecutor) {
    const v8Path = resolveV8ExecutablePath(connection.v8Path);
    return { executor: services.createDesignerExecutor(v8Path, services.workspaceFolder.uri.fsPath), v8Path, connection };
  }
  const lease = await acquireDesignerBatchExecutor({
    workspaceFolder: services.workspaceFolder,
    outputChannel: services.outputChannel,
    secrets: services.projectSecretStorage,
    localV8Path: connection.v8Path,
    v8Version: connection.v8Version,
  }, services.designerExecutorDeps);
  // С сервера база может адресоваться иначе (remote.ibConnection): учётные данные — те же, из env.json.
  const effective = lease.ibConnectionOverride
    ? { ...parseIbConnection(lease.ibConnectionOverride), userName: connection.userName, password: connection.password }
    : connection;
  return { executor: lease.executor, v8Path: lease.v8Path, connection: effective };
}

/** Всё, что проверяется до запуска: здесь ошибки — обычные `Error`, исполнитель ещё не занят. */
async function prepareRepositoryRun(
  options: RepositoryCliExecuteOptions,
  services: RepositoryCliServices
): Promise<PreparedRepositoryRun> {
  const connection = await resolveDatabaseConnection(
    services.repositoryService.getEnvJsonPath(),
    services.projectSecretStorage
  );
  const binding = options.bindingOverride
    ?? await services.repositoryService.resolveBindingForCommand(options.target);
  if (!binding) {
    throw new Error(`Для "${options.target.displayName}" не настроено подключение к хранилищу в env.json.`);
  }
  return { ...await resolveExecutor(connection, services), binding };
}

/**
 * Сам запуск: статус-бар, прогресс с «Отмена», лог, перенос выходного файла. Любой сбой после старта —
 * `RepositoryCliError` (заголовок операции сохраняется для UI), прерывание — `RepositoryCliInterruptedError`.
 * Исполнитель освобождается всегда: не забранный staging (сбой/отмена) не должен пережить операцию.
 */
async function launchRepositoryRun(
  prepared: PreparedRepositoryRun,
  options: RepositoryCliExecuteOptions,
  services: RepositoryCliServices
): Promise<DesignerBatchResult> {
  const { executor, v8Path, connection, binding } = prepared;
  beginRepositoryOperationStatus(options.progressTitle, options.progressStartMessage);

  try {
    // Пакетный Конфигуратор не войдёт в базу, пока её держит агент: отпускаем до запуска,
    // а сбой отключения — отказ операции.
    await releaseAgentInfoBaseForBatch(services.workspaceFolder, services.outputChannel);
    const request = buildRepositoryDesignerRequest(connection, binding, options.operation, options.target.extensionName);
    // Секреты (пароли базы, хранилища и пользователя операции) маскируются ЗНАЧЕНИЯМИ —
    // это точнее правил по ключам и не зависит от формы записи.
    const commandAsText = formatCommandLineForLog(v8Path, describeDesignerArgs(request.args), request.secrets);
    services.outputChannel.appendLine(`[repository] Старт: ${commandAsText}`);

    const outputLines: string[] = [];
    // Прогресс-нотификация с кнопкой отмены для прерывания зависшего конфигуратора.
    // Статус-бар не переписываем — withProgress добавлен только ради отмены.
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: options.progressTitle,
        cancellable: true,
      },
      (_progress, token) => executor.run({
        ...request,
        cancellation: token,
        onOutput: (text) => {
          const line = text.trim();
          if (!line) {
            return;
          }
          outputLines.push(line);
          services.outputChannel.appendLine(`[repository][output] ${line}`);
          updateRepositoryOperationStatus(options.progressTitle, trimStatusMessage(line));
        },
      })
    );

    if (result.interrupted) {
      services.outputChannel.appendLine(`[repository] ${result.interrupted}`);
      endRepositoryOperationStatus(options.progressTitle, 'прервано');
      throw new RepositoryCliInterruptedError(options.progressTitle, result.interrupted);
    }

    if (result.log) {
      services.outputChannel.appendLine(`[repository][log]\n${result.log}`);
    }
    const operation = options.failureOperation ?? options.progressTitle.toLowerCase();
    if (result.exitCode !== 0) {
      options.afterPlatformFailure?.(result);
      const reason = extractFailureReason([...outputLines, result.log], result.exitCode);
      throw new RepositoryCliError(options.errorTitle, `Ошибка при ${operation}: ${reason}`, result.log, result.exitCode);
    }

    if (options.output) {
      const staged = result.outputs.get(options.output.name);
      if (!staged) {
        throw new RepositoryCliError(options.errorTitle, `Ошибка при ${operation}: конфигуратор не создал выходной файл.`, result.log, result.exitCode);
      }
      moveStagingToTarget(staged, options.output.targetPath);
    }

    if (options.afterSuccess) {
      await options.afterSuccess(result);
    }

    services.outputChannel.appendLine(`[repository] Завершено: ${commandAsText}`);
    endRepositoryOperationStatus(options.progressTitle, 'завершено');
    return result;
  } catch (error) {
    if (error instanceof RepositoryCliInterruptedError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    services.outputChannel.appendLine(`[repository][error] ${message}`);
    endRepositoryOperationStatus(options.progressTitle, 'ошибка');
    throw error instanceof RepositoryCliError ? error : new RepositoryCliError(options.errorTitle, message);
  } finally {
    await executor.dispose();
  }
}

/**
 * Операция хранилища без UI-сообщений — для MCP и цепочек (`repositoryChains`): тостов нет, исход —
 * результат запуска или исключение. Ошибки конфигурации до запуска — обычный `Error`.
 */
export async function executeRepositoryCliCommand(
  options: RepositoryCliExecuteOptions,
  services: RepositoryCliServices
): Promise<DesignerBatchResult> {
  const prepared = await prepareRepositoryRun(options, services);
  return launchRepositoryRun(prepared, options, services);
}

/**
 * UI-обёртка: сбой после запуска показывается уведомлением и даёт `false`; ошибки конфигурации до
 * запуска, как и прежде, бросаются вызывающему.
 */
export async function runRepositoryCliCommand(
  options: RepositoryCliRunOptions,
  services: RepositoryCliServices
): Promise<boolean> {
  const prepared = await prepareRepositoryRun(options, services);
  try {
    await launchRepositoryRun(prepared, options, services);
  } catch (error) {
    showRepositoryCliFailure(error);
    return false;
  }
  if (options.showSuccessMessage !== false) {
    void vscode.window.showInformationMessage(options.successMessage);
  }
  return true;
}

/**
 * Уведомление о сбое операции хранилища, запущенной под замком. Без await (запрет №18): открытая
 * нотификация держала бы «операция уже выполняется» до её закрытия. Чужие ошибки (не операции
 * хранилища) пробрасываются: их показ — забота вызывающего, как было до разделения раннера.
 */
export function showRepositoryCliFailure(error: unknown): void {
  if (error instanceof RepositoryCliInterruptedError) {
    void vscode.window.showInformationMessage(`${error.title}: ${error.message}`);
    return;
  }
  if (error instanceof RepositoryCliError) {
    void vscode.window.showErrorMessage(`${error.title}\n${error.message}`);
    return;
  }
  throw error;
}

export function resolveRepositoryTarget(
  repositoryService: RepositoryService,
  node: RepositoryNodeRef
): RepositoryTarget | null {
  if (!node.xmlPath) {
    return null;
  }
  return repositoryService.resolveTargetByXmlPath(node.xmlPath);
}

export type RepositoryActionKind = 'lock' | 'unlock' | 'commit' | 'update';

/** Сообщение об успехе операции узла — одно для раннера и UI-команд, вызывающих цепочки. */
export function describeRepositoryActionSuccess(kind: RepositoryActionKind, label: string): string {
  switch (kind) {
    case 'lock':
      return `Объекты "${label}" захвачены.`;
    case 'unlock':
      return `Объекты "${label}" освобождены.`;
    case 'commit':
      return `Изменения "${label}" помещены в хранилище.`;
    case 'update':
      return `Объекты "${label}" обновлены из хранилища.`;
  }
}

/** Действие узла: параметры запуска и исход, который заполняет `afterSuccess` по логу. */
interface RepositoryNodeAction<T> {
  readonly options: RepositoryCliRunOptions;
  readonly outcome: () => T;
}

async function executeNodeAction<T>(action: RepositoryNodeAction<T>, services: RepositoryCliServices): Promise<T> {
  await executeRepositoryCliCommand(action.options, services);
  return action.outcome();
}

async function runNodeAction<T>(action: RepositoryNodeAction<T>, services: RepositoryCliServices): Promise<T | undefined> {
  return await runRepositoryCliCommand(action.options, services) ? action.outcome() : undefined;
}

/** Выборка действия: цель, единый файл `-Objects` и подпись для заголовков. */
interface PreparedSelection {
  readonly target: RepositoryTarget;
  readonly nodes: readonly RepositoryNodeRef[];
  readonly objects: { readonly xml: string; readonly fullNames: string[] };
  readonly label: string;
}

function prepareSelection(services: RepositoryCliServices, selection: RepositoryNodeSelection, recursive: boolean): PreparedSelection {
  const nodes = toSelectionNodes(selection);
  // Прежний текст отказа для узла вне конфигурации — до сборки выборки, у которой свой текст.
  for (const node of nodes) {
    requireTarget(services.repositoryService, node);
  }
  const { xml, fullNames, target } = services.repositoryService.buildObjectsSelectionForNodes(nodes, recursive);
  return { target, nodes, objects: { xml, fullNames }, label: selectionLabel(nodes, target) };
}

/** Один узел — прежняя подпись (тексты UI байт-в-байт), несколько — «<подпись первого> и ещё N». */
export function selectionLabel(nodes: readonly RepositoryNodeRef[], target: RepositoryTarget): string {
  const first = nodes[0].label ?? target.displayName;
  return nodes.length > 1 ? `${first} и ещё ${String(nodes.length - 1)}` : first;
}

/** Исход захвата раннера: план (`repositoryLockFlow`) не знает о чужих захватах и частичном отказе. */
export interface RepositoryLockActionOutcome extends RepositoryLockOutcome {
  readonly lockedByOthers: LockedByOther[];
  /** Текст отказа платформы, если захват списка завершился exit≠0, но часть объектов захвачена (Э33.1). */
  readonly platformFailure?: string;
}

interface RepositoryLockAction extends RepositoryNodeAction<RepositoryLockActionOutcome> {
  /** Исход по логу отказа, если по нему захвачено что-то новое; иначе `undefined`. */
  readonly partialOutcome: () => RepositoryLockActionOutcome | undefined;
}

function lockAction(
  services: RepositoryCliServices,
  selection: RepositoryNodeSelection,
  recursive: boolean,
  options: { readonly revised: boolean }
): RepositoryLockAction {
  const { target, objects, label } = prepareSelection(services, selection, recursive);
  const repository = services.repositoryService;
  // Повторный захват своего объекта строки в логе не даёт (Э33.(а)): нужен учёт до запуска.
  const alreadyLocked = repository.listLockedFullNames(target);
  const alreadyKeys = new Set(alreadyLocked.map(toLockKey));
  let outcome: RepositoryLockActionOutcome | undefined;
  let partial: RepositoryLockActionOutcome | undefined;
  const applyLog = (log: string, failed: boolean): RepositoryLockActionOutcome => {
    const rootLockName = repository.getRootLockName(target);
    // Корень по логу не виден: при отказе платформы его захват не подтверждён ничем.
    const lockedFullNames = resolveLockedFullNames(objects.fullNames, log, alreadyLocked)
      .filter((name) => !failed || name !== rootLockName || alreadyKeys.has(toLockKey(name)));
    repository.setLocked(target, lockedFullNames, true);
    return {
      lockedFullNames,
      receivedFromRepository: hasReceivedFromRepository(log),
      lockedByOthers: parseRepositoryLockLog(log).lockedByOthers,
    };
  };
  return {
    options: {
      operation: { kind: 'lock', objectsXml: objects.xml, revised: options.revised },
      target,
      progressTitle: `Захват: ${label}`,
      progressStartMessage: options.revised
        ? 'Захватываю объекты и получаю их версии из хранилища...'
        : 'Получаю объекты из хранилища для редактирования...',
      successMessage: describeRepositoryActionSuccess('lock', label),
      errorTitle: `Ошибка захвата объектов "${label}".`,
      failureOperation: 'захвате объектов хранилища',
      // Частичный захват — успех платформы (Н10): отмечаются только объекты, которые лог называет захваченными.
      afterSuccess: (result) => {
        outcome = applyLog(result.log, false);
      },
      // Захват списка неатомарен (Э33.1): при exit≠0 часть объектов захвачена, и учёт не должен их терять.
      afterPlatformFailure: (result) => {
        if (!parseRepositoryLockLog(result.log).recognized) {
          return;
        }
        const failed = applyLog(result.log, true);
        partial = failed.lockedFullNames.some((name) => !alreadyKeys.has(toLockKey(name))) ? failed : undefined;
      },
    },
    outcome: () => requireOutcome(outcome),
    partialOutcome: () => partial,
  };
}

function toLockKey(name: string): string {
  return name.toLocaleLowerCase('ru');
}

/**
 * Захват объектов. Результат — что захвачено и получила ли база новые версии (по логу): по нему
 * команда решает, нужен ли импорт в проект. `undefined` — захват не выполнен (ошибку показал раннер).
 */
export async function runRepositoryLockAction(
  services: RepositoryCliServices,
  selection: RepositoryNodeSelection,
  recursive: boolean,
  options: { readonly revised: boolean }
): Promise<RepositoryLockActionOutcome | undefined> {
  return runNodeAction(lockAction(services, selection, recursive, options), services);
}

/**
 * Захват без UI-сообщений: сбой — исключение (`RepositoryCliError`/`RepositoryCliInterruptedError`). Отказ
 * платформы, после которого по логу захвачено что-то новое, — частичный исход с `platformFailure`: захват мог
 * получить версии, и без продолжения цепочки (импорта) проект молча отстал бы от базы.
 */
export async function executeRepositoryLockAction(
  services: RepositoryCliServices,
  selection: RepositoryNodeSelection,
  recursive: boolean,
  options: { readonly revised: boolean }
): Promise<RepositoryLockActionOutcome> {
  const action = lockAction(services, selection, recursive, options);
  try {
    return await executeNodeAction(action, services);
  } catch (error) {
    const partial = action.partialOutcome();
    if (partial && error instanceof RepositoryCliError) {
      return { ...partial, platformFailure: error.message };
    }
    throw error;
  }
}

export interface RepositoryUnlockOutcome {
  /** Снятые с учёта объекты — по строкам «Захват объекта отменен», в том числе вне запрошенных. */
  readonly unlocked: string[];
  readonly lockedByOthers: LockedByOther[];
  /** Запрошенные объекты, захват которых не отменён (чужой захват, отказ платформы по объекту). */
  readonly notUnlocked: string[];
}

function unlockAction(
  services: RepositoryCliServices,
  selection: RepositoryNodeSelection,
  recursive: boolean,
  force: boolean
): RepositoryNodeAction<RepositoryUnlockOutcome> {
  const { target, objects, label } = prepareSelection(services, selection, recursive);
  let outcome: RepositoryUnlockOutcome | undefined;
  // Э24: освобождение чужого захвата — exit 0 без снятия, поэтому учёт снимается по строкам лога.
  const applyLog = (log: string): RepositoryUnlockOutcome => {
    const parsed = parseRepositoryLockLog(log);
    const unlocked = resolveUnlockedFullNames(objects.fullNames, log);
    // «Не захвачен вами» в учёте — устаревшая запись: её снятие верно, но освобождённой она не считается.
    services.repositoryService.setLocked(target, [...unlocked, ...parsed.notLockedByYou], false);
    const settled = new Set([...unlocked, ...parsed.notLockedByYou].map(toLockKey));
    return {
      unlocked,
      lockedByOthers: parsed.lockedByOthers,
      notUnlocked: objects.fullNames.filter((name) => !settled.has(toLockKey(name))),
    };
  };
  return {
    options: {
      operation: { kind: 'unlock', objectsXml: objects.xml, force },
      target,
      progressTitle: `Освобождение: ${label}`,
      progressStartMessage: 'Отменяю захват объектов...',
      successMessage: describeRepositoryActionSuccess('unlock', label),
      errorTitle: `Ошибка освобождения объектов "${label}".`,
      failureOperation: 'освобождении объектов хранилища',
      afterSuccess: (result) => {
        outcome = applyLog(result.log);
      },
      // Отказ бывает частичным: отпущенное до него платформа называет в логе. Нераспознанный лог
      // ничего не подтверждает — учёт не трогается.
      afterPlatformFailure: (result) => {
        if (isUnlockLogRecognized(result.log)) {
          applyLog(result.log);
        }
      },
    },
    outcome: () => requireOutcome(outcome),
  };
}

export async function runRepositoryUnlockAction(
  services: RepositoryCliServices,
  selection: RepositoryNodeSelection,
  recursive: boolean,
  force: boolean
): Promise<boolean> {
  return await runNodeAction(unlockAction(services, selection, recursive, force), services) !== undefined;
}

export async function executeRepositoryUnlockAction(
  services: RepositoryCliServices,
  selection: RepositoryNodeSelection,
  recursive: boolean,
  force: boolean
): Promise<RepositoryUnlockOutcome> {
  return executeNodeAction(unlockAction(services, selection, recursive, force), services);
}

interface RepositoryCommitRequest {
  recursive: boolean;
  comment: string;
  keepLocked: boolean;
  force: boolean;
}

/** Исход помещения раннера: запрошенные объекты, которые платформа молча пропустила (Э33.4б/в). */
export interface RepositoryCommitActionOutcome extends RepositoryCommitOutcome {
  readonly notCommitted: string[];
}

function commitAction(
  services: RepositoryCliServices,
  selection: RepositoryNodeSelection,
  options: RepositoryCommitRequest
): RepositoryNodeAction<RepositoryCommitActionOutcome> {
  const { target, objects, label } = prepareSelection(services, selection, options.recursive);
  let outcome: RepositoryCommitActionOutcome | undefined;
  return {
    options: {
      operation: {
        kind: 'commit',
        objectsXml: objects.xml,
        comment: options.comment,
        keepLocked: options.keepLocked,
        force: options.force,
      },
      target,
      progressTitle: `Помещение: ${label}`,
      progressStartMessage: 'Помещаю изменения в хранилище...',
      successMessage: describeRepositoryActionSuccess('commit', label),
      errorTitle: `Ошибка помещения "${label}" в хранилище.`,
      failureOperation: 'помещении изменений в хранилище',
      afterSuccess: (result) => {
        // Э25: снятие захвата после помещения в лог не пишется — учёт снимается у запрошенных. Незахваченный
        // или чужой объект в учёте — устаревшая запись, её снятие тоже верно.
        if (!options.keepLocked) {
          services.repositoryService.setLocked(target, objects.fullNames, false);
        }
        outcome = {
          committedFullNames: resolveCommittedFullNames(objects.fullNames, result.log),
          referencesCleaned: hasReferencesCleaned(result.log),
          notCommitted: resolveNotCommittedFullNames(objects.fullNames, result.log),
        };
      },
    },
    outcome: () => requireOutcome(outcome),
  };
}

export async function runRepositoryCommitAction(
  services: RepositoryCliServices,
  selection: RepositoryNodeSelection,
  options: RepositoryCommitRequest
): Promise<boolean> {
  return await runNodeAction(commitAction(services, selection, options), services) !== undefined;
}

export async function executeRepositoryCommitAction(
  services: RepositoryCliServices,
  selection: RepositoryNodeSelection,
  options: RepositoryCommitRequest
): Promise<RepositoryCommitActionOutcome> {
  return executeNodeAction(commitAction(services, selection, options), services);
}

interface RepositoryUpdateRequest {
  recursive: boolean;
  force: boolean;
  version?: string;
}

/** Исход получения раннера: захваченные вами объекты выборки, которые получение реально перезаписало. */
export interface RepositoryUpdateActionOutcome extends RepositoryUpdateOutcome {
  readonly lockedOverwritten: string[];
}

function updateAction(
  services: RepositoryCliServices,
  selection: RepositoryNodeSelection,
  options: RepositoryUpdateRequest
): RepositoryNodeAction<RepositoryUpdateActionOutcome> {
  const { target, nodes, objects, label } = prepareSelection(services, selection, options.recursive);
  // Учёт до запуска: перезапись захваченных решает журнал, но кандидаты — только захваченные в выборке.
  const lockedInSelection = services.repositoryService.findLockedInSelectionForNodes(nodes, options.recursive);
  let outcome: RepositoryUpdateActionOutcome | undefined;
  return {
    options: {
      operation: { kind: 'update', objectsXml: objects.xml, version: options.version, force: options.force },
      target,
      progressTitle: `Получение: ${label}`,
      progressStartMessage: 'Получаю изменения из хранилища...',
      successMessage: describeRepositoryActionSuccess('update', label),
      errorTitle: `Ошибка получения "${label}" из хранилища.`,
      failureOperation: 'получении изменений из хранилища',
      // Формат лога тот же, что у захвата: строки «Объект получен из хранилища».
      afterSuccess: (result) => {
        outcome = {
          receivedFromRepository: hasReceivedFromRepository(result.log),
          lockedOverwritten: resolveOverwrittenLocked(lockedInSelection, result.log),
        };
      },
    },
    outcome: () => requireOutcome(outcome),
  };
}

/**
 * Получение из хранилища. Результат — получила ли база новые версии (по логу): по нему команда
 * решает, нужен ли импорт в проект. `undefined` — получение не выполнено (ошибку показал раннер).
 */
export async function runRepositoryUpdateAction(
  services: RepositoryCliServices,
  selection: RepositoryNodeSelection,
  options: RepositoryUpdateRequest
): Promise<RepositoryUpdateActionOutcome | undefined> {
  return runNodeAction(updateAction(services, selection, options), services);
}

export async function executeRepositoryUpdateAction(
  services: RepositoryCliServices,
  selection: RepositoryNodeSelection,
  options: RepositoryUpdateRequest
): Promise<RepositoryUpdateActionOutcome> {
  return executeNodeAction(updateAction(services, selection, options), services);
}

/** Исход заполняет `afterSuccess`; успешный запуск без него означал бы ошибку в коде раннера. */
function requireOutcome<T>(outcome: T | undefined): T {
  /* c8 ignore next 3 -- защитная ветка: успешный запуск всегда вызывает afterSuccess */
  if (outcome === undefined) {
    throw new Error('Исход операции хранилища не получен.');
  }
  return outcome;
}

function requireTarget(repositoryService: RepositoryService, node: RepositoryNodeRef): RepositoryTarget {
  const target = resolveRepositoryTarget(repositoryService, node);
  if (!target) {
    throw new Error('Не удалось определить конфигурацию для выбранного узла.');
  }
  return target;
}

async function resolveDatabaseConnection(
  settingsPath: string,
  secrets: ProjectSecretStorage
): Promise<ResolvedConnection> {
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`Не найден env.json для подключения к базе: ${settingsPath}`);
  }

  const raw = fs.readFileSync(settingsPath, 'utf-8');
  const parsed = JSON.parse(raw) as {
    default?: Record<string, unknown>;
  };
  const defaults = parsed.default ?? {};
  const ibConnectionRaw = asString(defaults['--ibconnection']);
  if (!ibConnectionRaw) {
    throw new Error(`В env.json отсутствует "--ibconnection": ${settingsPath}`);
  }

  return {
    ...parseIbConnection(ibConnectionRaw),
    userName: asString(defaults['--db-user']) ?? '',
    password: await resolveDbPassword(secrets, asString(defaults['--db-pwd']) ?? ''),
    v8Path: resolveV8PathFromSettings(defaults),
    v8Version: asString(defaults['--v8version']),
  };
}

function parseIbConnection(rawValue: string): ConnectionParams {
  const normalized = rawValue.replace(/^"+|"+$/g, '');
  if (/^\/F/i.test(normalized)) {
    return {
      infoBasePath: normalizeInfoBasePath(normalized.slice(2).trim()),
    };
  }

  if (/^\/S/i.test(normalized)) {
    const serverRef = normalized.slice(2).trim();
    const slashIndex = serverRef.indexOf('/');
    if (slashIndex > 0) {
      return {
        infoBaseServer: serverRef.slice(0, slashIndex),
        infoBaseRef: serverRef.slice(slashIndex + 1),
      };
    }
  }

  throw new Error(`Не удалось разобрать "--ibconnection": ${rawValue}`);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function resolveV8PathFromSettings(defaults: Record<string, unknown>): string {
  return asString(defaults['--path']) ?? resolveV8PathHintFromVersion(asString(defaults['--v8version']) ?? '');
}

function extractFailureReason(details: string[], exitCode: number): string {
  const lines = details
    .map((item) => item.replace(/\r/g, '').trim())
    .filter(Boolean)
    .flatMap((block) => block.split('\n'))
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== '--- Log ---' && line !== '--- End ---');

  if (lines.length === 0) {
    return `команда завершилась с кодом ${String(exitCode)}`;
  }

  const filtered = lines.filter((line) => {
    if (/^Error [^(]+\(code:\s*\d+\)$/i.test(line)) {
      return false;
    }
    if (/завершил(?:ось|ся) с ошибкой$/i.test(line)) {
      return false;
    }
    return true;
  });
  return filtered.at(-1) ?? lines.at(-1) ?? `команда завершилась с кодом ${String(exitCode)}`;
}
