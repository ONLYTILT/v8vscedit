import * as fs from 'fs';
import * as vscode from 'vscode';
import type { RepositoryBinding, RepositoryNodeRef, RepositoryService, RepositoryTarget } from '../../../infra/repository/RepositoryService';
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
import { hasReceivedFromRepository, resolveLockedFullNames } from '../../../infra/repository/RepositoryLockLog';
import type { RepositoryLockOutcome } from './repositoryLockFlow';
import type { RepositoryUpdateOutcome } from './repositoryUpdateFlow';
import { releaseAgentInfoBaseForBatch } from '../ext/agent/AgentServiceRegistry';
import { acquireDesignerBatchExecutor, type DesignerExecutorDeps } from '../ext/designerExecutorRegistry';

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

interface RepositoryCliRunOptions {
  operation: RepositoryOperation;
  target: RepositoryTarget;
  bindingOverride?: RepositoryBinding;
  /** Выходной файл операции (dump/report): staging переносится на `targetPath` только при успехе. */
  output?: { name: string; targetPath: string };
  progressTitle: string;
  progressStartMessage: string;
  successMessage: string;
  errorTitle: string;
  failureOperation?: string;
  showSuccessMessage?: boolean;
  /** Получает результат запуска: по логу платформы уточняется, что именно сделано (Н10). */
  afterSuccess?: (result: DesignerBatchResult) => void | Promise<void>;
}

let statusBarItem: vscode.StatusBarItem | undefined;
let clearStatusTimer: NodeJS.Timeout | undefined;
// Счётчик активных операций хранилища: параллельные операции делят один статус-бар,
// поэтому скрывать его по таймеру можно только когда завершилась последняя (count → 0).
let activeOperationCount = 0;

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

/**
 * Исполнитель и путь к 1cv8. Ошибки конфигурации (env.json, удалённый режим) бросаются здесь,
 * ДО начала операции: статус не включается, на сервер ничего не уходит.
 */
/** Подключение из env.json: путь к 1cv8 вычислен всегда (пустая строка — искать стандартную установку). */
type ResolvedConnection = ConnectionParams & { v8Path: string };

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

export async function runRepositoryCliCommand(
  options: RepositoryCliRunOptions,
  services: RepositoryCliServices
): Promise<boolean> {
  const connection = await resolveDatabaseConnection(
    services.repositoryService.getEnvJsonPath(),
    services.projectSecretStorage
  );
  const binding = options.bindingOverride
    ?? await services.repositoryService.resolveBindingForCommand(options.target);
  if (!binding) {
    throw new Error(`Для "${options.target.displayName}" не настроено подключение к хранилищу в env.json.`);
  }

  const { executor, v8Path, connection: effectiveConnection } = await resolveExecutor(connection, services);

  beginRepositoryOperationStatus(options.progressTitle, options.progressStartMessage);

  try {
    // Пакетный Конфигуратор не войдёт в базу, пока её держит агент: отпускаем до запуска,
    // а сбой отключения — отказ операции (ошибка показывается, исполнитель освобождается в finally).
    await releaseAgentInfoBaseForBatch(services.workspaceFolder, services.outputChannel);
    const request = buildRepositoryDesignerRequest(effectiveConnection, binding, options.operation, options.target.extensionName);
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
      void vscode.window.showInformationMessage(`${options.progressTitle}: ${result.interrupted}`);
      return false;
    }

    if (result.log) {
      services.outputChannel.appendLine(`[repository][log]\n${result.log}`);
    }
    const operation = options.failureOperation ?? options.progressTitle.toLowerCase();
    if (result.exitCode !== 0) {
      const reason = extractFailureReason([...outputLines, result.log], result.exitCode);
      throw new Error(`Ошибка при ${operation}: ${reason}`);
    }

    if (options.output) {
      const staged = result.outputs.get(options.output.name);
      if (!staged) {
        throw new Error(`Ошибка при ${operation}: конфигуратор не создал выходной файл.`);
      }
      moveStagingToTarget(staged, options.output.targetPath);
    }

    if (options.afterSuccess) {
      await options.afterSuccess(result);
    }

    services.outputChannel.appendLine(`[repository] Завершено: ${commandAsText}`);
    endRepositoryOperationStatus(options.progressTitle, 'завершено');
    if (options.showSuccessMessage !== false) {
      void vscode.window.showInformationMessage(options.successMessage);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.outputChannel.appendLine(`[repository][error] ${message}`);
    endRepositoryOperationStatus(options.progressTitle, 'ошибка');
    // Без await (запрет №18): раннер выполняется внутри секции общего замка, и открытая
    // нотификация держала бы «операция уже выполняется» до её закрытия.
    void vscode.window.showErrorMessage(`${options.errorTitle}\n${message}`);
    return false;
  } finally {
    // Не забранный staging (сбой/отмена) не должен пережить операцию.
    await executor.dispose();
  }
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

/**
 * Захват объектов. Результат — что захвачено и получила ли база новые версии (по логу): по нему
 * команда решает, нужен ли импорт в проект. `undefined` — захват не выполнен (ошибку показал раннер).
 */
export async function runRepositoryLockAction(
  services: RepositoryCliServices,
  node: RepositoryNodeRef,
  recursive: boolean,
  options: { readonly revised: boolean }
): Promise<RepositoryLockOutcome | undefined> {
  const target = requireTarget(services.repositoryService, node);
  const objects = services.repositoryService.buildObjectsSelectionForNode(node, recursive);
  let outcome: RepositoryLockOutcome | undefined;
  const ok = await runRepositoryCliCommand({
    operation: { kind: 'lock', objectsXml: objects.xml, revised: options.revised },
    target,
    progressTitle: `Захват: ${node.label ?? target.displayName}`,
    progressStartMessage: options.revised
      ? 'Захватываю объекты и получаю их версии из хранилища...'
      : 'Получаю объекты из хранилища для редактирования...',
    successMessage: `Объекты "${node.label ?? target.displayName}" захвачены.`,
    errorTitle: `Ошибка захвата объектов "${node.label ?? target.displayName}".`,
    failureOperation: 'захвате объектов хранилища',
    // Частичный захват — успех платформы (Н10): отмечаются только объекты, которые лог называет захваченными.
    afterSuccess: (result) => {
      const lockedFullNames = resolveLockedFullNames(objects.fullNames, result.log);
      services.repositoryService.setLocked(target, lockedFullNames, true);
      outcome = { lockedFullNames, receivedFromRepository: hasReceivedFromRepository(result.log) };
    },
  }, services);
  return ok ? outcome : undefined;
}

export async function runRepositoryUnlockAction(
  services: RepositoryCliServices,
  node: RepositoryNodeRef,
  recursive: boolean,
  force: boolean
): Promise<boolean> {
  const target = requireTarget(services.repositoryService, node);
  const objects = services.repositoryService.buildObjectsSelectionForNode(node, recursive);
  return runRepositoryCliCommand({
    operation: { kind: 'unlock', objectsXml: objects.xml, force },
    target,
    progressTitle: `Освобождение: ${node.label ?? target.displayName}`,
    progressStartMessage: 'Отменяю захват объектов...',
    successMessage: `Объекты "${node.label ?? target.displayName}" освобождены.`,
    errorTitle: `Ошибка освобождения объектов "${node.label ?? target.displayName}".`,
    failureOperation: 'освобождении объектов хранилища',
    afterSuccess: () => {
      services.repositoryService.setLocked(target, objects.fullNames, false);
    },
  }, services);
}

export async function runRepositoryCommitAction(
  services: RepositoryCliServices,
  node: RepositoryNodeRef,
  options: {
    recursive: boolean;
    comment: string;
    keepLocked: boolean;
    force: boolean;
  }
): Promise<boolean> {
  const target = requireTarget(services.repositoryService, node);
  const objects = services.repositoryService.buildObjectsSelectionForNode(node, options.recursive);
  return runRepositoryCliCommand({
    operation: {
      kind: 'commit',
      objectsXml: objects.xml,
      comment: options.comment,
      keepLocked: options.keepLocked,
      force: options.force,
    },
    target,
    progressTitle: `Помещение: ${node.label ?? target.displayName}`,
    progressStartMessage: 'Помещаю изменения в хранилище...',
    successMessage: `Изменения "${node.label ?? target.displayName}" помещены в хранилище.`,
    errorTitle: `Ошибка помещения "${node.label ?? target.displayName}" в хранилище.`,
    failureOperation: 'помещении изменений в хранилище',
    afterSuccess: () => {
      if (!options.keepLocked) {
        services.repositoryService.setLocked(target, objects.fullNames, false);
      }
    },
  }, services);
}

/**
 * Получение из хранилища. Результат — получила ли база новые версии (по логу): по нему команда
 * решает, нужен ли импорт в проект. `undefined` — получение не выполнено (ошибку показал раннер).
 */
export async function runRepositoryUpdateAction(
  services: RepositoryCliServices,
  node: RepositoryNodeRef,
  options: {
    recursive: boolean;
    force: boolean;
    version?: string;
  }
): Promise<RepositoryUpdateOutcome | undefined> {
  const target = requireTarget(services.repositoryService, node);
  const objects = services.repositoryService.buildObjectsSelectionForNode(node, options.recursive);
  let outcome: RepositoryUpdateOutcome | undefined;
  const ok = await runRepositoryCliCommand({
    operation: { kind: 'update', objectsXml: objects.xml, version: options.version, force: options.force },
    target,
    progressTitle: `Получение: ${node.label ?? target.displayName}`,
    progressStartMessage: 'Получаю изменения из хранилища...',
    successMessage: `Объекты "${node.label ?? target.displayName}" обновлены из хранилища.`,
    errorTitle: `Ошибка получения "${node.label ?? target.displayName}" из хранилища.`,
    failureOperation: 'получении изменений из хранилища',
    // Формат лога тот же, что у захвата: строки «Объект получен из хранилища».
    afterSuccess: (result) => {
      outcome = { receivedFromRepository: hasReceivedFromRepository(result.log) };
    },
  }, services);
  return ok ? outcome : undefined;
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

function trimStatusMessage(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 80) {
    return oneLine;
  }
  return `${oneLine.slice(0, 77)}...`;
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

/**
 * Компат-обёртка: `running=true` — граница старта операции (begin), `running=false` —
 * терминал (end). Промежуточные обновления текста прогресса должны идти через
 * {@link updateRepositoryOperationStatus}, иначе счётчик активных операций растёт на
 * каждом прогресс-сообщении и статус-бар перестаёт скрываться (регресс M9).
 */
export function setRepositoryOperationStatus(title: string, message: string, running: boolean): void {
  if (running) {
    beginRepositoryOperationStatus(title, message);
  } else {
    endRepositoryOperationStatus(title, message);
  }
}

/** Начало операции хранилища: инкремент счётчика + спиннер-текст. */
export function beginRepositoryOperationStatus(title: string, message: string): void {
  ensureRepositoryStatusItem();
  cancelRepositoryHideTimer();
  activeOperationCount++;
  showRepositorySpinnerStatus(title, message);
}

/** Обновление текста прогресса без изменения счётчика активных операций. */
export function updateRepositoryOperationStatus(title: string, message: string): void {
  ensureRepositoryStatusItem();
  cancelRepositoryHideTimer();
  showRepositorySpinnerStatus(title, message);
}

/** Терминал операции хранилища: декремент счётчика; при нуле — таймер скрытия. */
export function endRepositoryOperationStatus(title: string, message: string): void {
  ensureRepositoryStatusItem();
  cancelRepositoryHideTimer();
  activeOperationCount = Math.max(0, activeOperationCount - 1);

  const text = `${title}: ${message}`;
  if (statusBarItem) {
    statusBarItem.text = `$(check) ${trimStatusMessage(text)}`;
    statusBarItem.tooltip = text;
    statusBarItem.show();
  }

  // Скрываем статус только когда завершилась последняя активная операция хранилища.
  if (activeOperationCount === 0) {
    clearStatusTimer = setTimeout(() => {
      statusBarItem?.hide();
      clearStatusTimer = undefined;
    }, 5_000);
  }
}

function ensureRepositoryStatusItem(): void {
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
    statusBarItem.name = '1С: хранилище конфигурации';
  }
}

function cancelRepositoryHideTimer(): void {
  if (clearStatusTimer) {
    clearTimeout(clearStatusTimer);
    clearStatusTimer = undefined;
  }
}

function showRepositorySpinnerStatus(title: string, message: string): void {
  const text = `${title}: ${message}`;
  if (statusBarItem) {
    statusBarItem.text = `$(sync~spin) ${trimStatusMessage(text)}`;
    statusBarItem.tooltip = text;
    statusBarItem.show();
  }
}

/**
 * Освобождает лениво созданный статус-бар хранилища на остановке расширения.
 * Статус-бар не попадает в context.subscriptions, поэтому его нужно диспозить явно
 * (симметрично disposeCachedAgentOperationServices для ExtensionCommandRunner).
 */
export function disposeRepositoryCommandStatusBar(): void {
  if (clearStatusTimer) {
    clearTimeout(clearStatusTimer);
    clearStatusTimer = undefined;
  }
  statusBarItem?.dispose();
  statusBarItem = undefined;
  activeOperationCount = 0;
}
