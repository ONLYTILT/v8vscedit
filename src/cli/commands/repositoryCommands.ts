import * as fs from 'fs';
import type { CliArgs } from '../core/types';
import { resolveConnection } from '../core/connection';
import { moveStagingToTarget, printLogText } from '../core/onecCommon';
import { getBool, getRequiredString, getString } from '../core/args';
import type {
  DesignerBatchExecutor,
  DesignerBatchRequest,
  DesignerBatchResult,
} from '../../infra/process/designer/DesignerBatchExecutor';
import { LocalDesignerBatchExecutor } from '../../infra/process/designer/LocalDesignerBatchExecutor';
import {
  buildRepositoryDesignerRequest,
  repositoryOperationOutputName,
  type RepositoryOperation,
} from '../../infra/repository/RepositoryDesignerArgs';
import type { RepositoryBinding } from '../../infra/repository/RepositoryService';

export type RepositoryCliCommand =
  | 'repository-create'
  | 'repository-bind'
  | 'repository-unbind'
  | 'repository-lock'
  | 'repository-unlock'
  | 'repository-commit'
  | 'repository-update'
  | 'repository-add-user'
  | 'repository-copy-users'
  | 'repository-dump'
  | 'repository-report'
  | 'repository-set-label';

function resolveRepositoryBinding(args: CliArgs): RepositoryBinding {
  const repoPath = getRequiredString(args, 'RepoPath');
  const repoUser = getRequiredString(args, 'RepoUser');
  return {
    repoPath,
    repoUser,
    repoPassword: getString(args, 'RepoPassword', ''),
  };
}

/**
 * Содержимое `-ObjectsFile` уходит в запрос БАЙТАМИ: чтение как UTF-8 испортило бы
 * файл в UTF-16/cp1251 (BOM и кириллица), а кодировку файла задаёт вызывающий.
 */
function readObjectsXml(args: CliArgs): Uint8Array | undefined {
  const objectsFile = getString(args, 'ObjectsFile', '');
  return objectsFile ? fs.readFileSync(objectsFile) : undefined;
}

/**
 * Разбор аргументов CLI в типизированную операцию. `-File` у dump/report
 * обязателен, но в операцию не входит: выходной файл объявляет построитель, а
 * перенос на `-File` делает CLI после успешного завершения.
 */
export function parseRepositoryOperation(command: RepositoryCliCommand, args: CliArgs): RepositoryOperation {
  switch (command) {
    case 'repository-create':
      return {
        kind: 'create',
        allowConfigurationChanges: getBool(args, 'AllowConfigurationChanges'),
        changesAllowedRule: getString(args, 'ChangesAllowedRule', ''),
        changesNotRecommendedRule: getString(args, 'ChangesNotRecommendedRule', ''),
        noBind: getBool(args, 'NoBind'),
      };
    case 'repository-bind':
      return {
        kind: 'bind',
        forceBindAlreadyBindedUser: getBool(args, 'ForceBindAlreadyBindedUser'),
        forceReplaceCfg: getBool(args, 'ForceReplaceCfg'),
      };
    case 'repository-unbind':
      return { kind: 'unbind', force: getBool(args, 'Force') };
    case 'repository-lock':
      return { kind: 'lock', objectsXml: readObjectsXml(args), revised: getBool(args, 'Revised') };
    case 'repository-unlock':
      return { kind: 'unlock', objectsXml: readObjectsXml(args), force: getBool(args, 'Force') };
    case 'repository-commit':
      return {
        kind: 'commit',
        objectsXml: readObjectsXml(args),
        comment: getString(args, 'Comment', ''),
        keepLocked: getBool(args, 'KeepLocked'),
        force: getBool(args, 'Force'),
      };
    case 'repository-update':
      return {
        kind: 'update',
        objectsXml: readObjectsXml(args),
        version: getString(args, 'Version', ''),
        force: getBool(args, 'Force'),
      };
    case 'repository-add-user': {
      const user = getRequiredString(args, 'User');
      const password = getRequiredString(args, 'Pwd');
      const rights = getRequiredString(args, 'Rights');
      return { kind: 'addUser', user, password, rights, restoreDeletedUser: getBool(args, 'RestoreDeletedUser') };
    }
    case 'repository-copy-users': {
      const sourcePath = getRequiredString(args, 'Path');
      const user = getRequiredString(args, 'User');
      const password = getRequiredString(args, 'Pwd');
      return {
        kind: 'copyUsers',
        path: sourcePath,
        user,
        password,
        restoreDeletedUser: getBool(args, 'RestoreDeletedUser'),
      };
    }
    case 'repository-dump':
      getRequiredString(args, 'File');
      return { kind: 'dump', version: getString(args, 'Version', '') };
    case 'repository-report':
      getRequiredString(args, 'File');
      return {
        kind: 'report',
        nBegin: getString(args, 'NBegin', ''),
        nEnd: getString(args, 'NEnd', ''),
        dateBegin: getString(args, 'DateBegin', ''),
        dateEnd: getString(args, 'DateEnd', ''),
        configurationVersion: getString(args, 'ConfigurationVersion', ''),
        reportFormat: getString(args, 'ReportFormat', ''),
        groupByObject: getBool(args, 'GroupByObject'),
        groupByComment: getBool(args, 'GroupByComment'),
        doNotIncludeVersionsWithLabels: getBool(args, 'DoNotIncludeVersionsWithLabels'),
        includeOnlyVersionsWithLabels: getBool(args, 'IncludeOnlyVersionsWithLabels'),
        includeCommentLinesWithDoubleSlash: getBool(args, 'IncludeCommentLinesWithDoubleSlash'),
      };
    case 'repository-set-label':
      return {
        kind: 'setLabel',
        name: getRequiredString(args, 'LabelName'),
        version: getString(args, 'Version', ''),
        comment: getString(args, 'Comment', ''),
      };
  }
}

function buildRepositoryCliRun(
  command: RepositoryCliCommand,
  args: CliArgs
): { request: DesignerBatchRequest; operation: RepositoryOperation } {
  const connection = resolveConnection(args);
  const binding = resolveRepositoryBinding(args);
  const operation = parseRepositoryOperation(command, args);
  const request = buildRepositoryDesignerRequest(connection, binding, operation, getString(args, 'Extension', ''));
  return { request, operation };
}

/** Запрос пакетного конфигуратора из аргументов CLI — тем же построителем, что и в расширении. */
export function buildRepositoryCliRequest(command: RepositoryCliCommand, args: CliArgs): DesignerBatchRequest {
  return buildRepositoryCliRun(command, args).request;
}

/** Сообщения CLI по командам: успех — для человека, ошибка — для разбора вызывающим скриптом. */
export const REPOSITORY_CLI_MESSAGES: Readonly<Record<RepositoryCliCommand, { success: string; error: string }>> = {
  'repository-create': { success: 'Создание хранилища завершено', error: 'Error creating configuration repository' },
  'repository-bind': { success: 'Подключение к хранилищу завершено', error: 'Error binding configuration repository' },
  'repository-unbind': { success: 'Отключение от хранилища завершено', error: 'Error unbinding configuration repository' },
  'repository-lock': { success: 'Захват объектов завершен', error: 'Error locking repository objects' },
  'repository-unlock': { success: 'Освобождение объектов завершено', error: 'Error unlocking repository objects' },
  'repository-commit': { success: 'Помещение изменений завершено', error: 'Error committing repository objects' },
  'repository-update': {
    success: 'Получение объектов из хранилища завершено',
    error: 'Error updating configuration from repository',
  },
  'repository-add-user': { success: 'Добавление пользователя завершено', error: 'Error adding repository user' },
  'repository-copy-users': { success: 'Копирование пользователей завершено', error: 'Error copying repository users' },
  'repository-dump': { success: 'Выгрузка версии хранилища завершена', error: 'Error dumping configuration repository' },
  'repository-report': { success: 'Построение отчета по хранилищу завершено', error: 'Error building repository report' },
  'repository-set-label': { success: 'Установка метки завершена', error: 'Error setting repository label' },
};

/** Фабрика исполнителя: внедряется, чтобы прогнать CLI без установленной платформы 1С. */
export type RepositoryCliExecutorFactory = (v8Path: string) => DesignerBatchExecutor;

const createLocalExecutor: RepositoryCliExecutorFactory = (v8Path) => new LocalDesignerBatchExecutor(v8Path);

export interface RepositoryCliFinishContext {
  /** Имя выходного файла операции в `result.outputs` (dump/report); нет — операция без выходного файла. */
  readonly outputName?: string;
  /** Путь `-File`, на который переносится staging; обязателен при наличии `outputName`. */
  readonly targetFile?: string;
  readonly verbose: boolean;
  readonly successMessage: string;
  readonly errorMessage: string;
  /** Строки stdout/stderr процесса — печатаются как детали ошибки. */
  readonly outputLines: readonly string[];
  /** Перенос staging; шов для теста, по умолчанию — общий `moveStagingToTarget`. */
  readonly moveOutput?: (stagingPath: string, targetPath: string) => void;
}

/**
 * Обработка результата исполнителя: перенос выходного файла, печать лога и деталей,
 * код возврата процесса CLI. Отдельно от запуска, чтобы ветки проверялись без 1С.
 */
export function finishRepositoryCliRun(result: DesignerBatchResult, ctx: RepositoryCliFinishContext): number {
  let exitCode = result.exitCode;
  if (exitCode === 0) {
    const staged = ctx.outputName ? result.outputs.get(ctx.outputName) : undefined;
    if (ctx.outputName && !staged) {
      // Код 0 без выходного файла — сбой: вызывающий скрипт иначе прочитал бы старый/пустой файл.
      console.error(`${ctx.errorMessage}: платформа не создала выходной файл`);
      exitCode = 1;
    } else {
      if (staged) {
        if (!ctx.targetFile) {
          throw new Error('Не задан путь -File для выходного файла');
        }
        (ctx.moveOutput ?? moveStagingToTarget)(staged, ctx.targetFile);
      }
      console.log(ctx.successMessage);
    }
  } else {
    // В verbose лог печатается ниже в любом случае — не дублируем.
    if (!ctx.verbose) {
      printLogText(result.log);
    }
    const details = ctx.outputLines.join('\n').trim();
    if (details) {
      console.error(details);
    }
    console.error(`${ctx.errorMessage} (code: ${String(exitCode)})`);
  }
  if (ctx.verbose) {
    printLogText(result.log);
  }
  return exitCode;
}

/**
 * Полный цикл команды хранилища: разбор аргументов → запуск → обработка результата.
 * Запрос и `-File` разбираются ДО создания исполнителя, чтобы ошибка аргументов не
 * запускала платформу и не оставляла временных каталогов.
 */
export async function executeRepositoryCommand(
  command: RepositoryCliCommand,
  args: CliArgs,
  createExecutor: RepositoryCliExecutorFactory = createLocalExecutor
): Promise<number> {
  // Имя выходного файла берётся из той же операции, что и вектор: у report оно зависит
  // от формата, и отдельный расчёт мог бы разойтись с вектором.
  const { request, operation } = buildRepositoryCliRun(command, args);
  const outputName = repositoryOperationOutputName(operation);
  const targetFile = outputName ? getRequiredString(args, 'File') : undefined;
  const messages = REPOSITORY_CLI_MESSAGES[command];
  const outputLines: string[] = [];
  const executor = createExecutor(resolveConnection(args).v8Path);
  try {
    const result = await executor.run({ ...request, onOutput: (line) => outputLines.push(line) });
    return finishRepositoryCliRun(result, {
      outputName,
      targetFile,
      verbose: getBool(args, 'Verbose'),
      successMessage: messages.success,
      errorMessage: messages.error,
      outputLines,
    });
  } finally {
    await executor.dispose();
  }
}

export function createRepository(args: CliArgs): Promise<number> {
  return executeRepositoryCommand('repository-create', args);
}

export function bindRepositoryConfiguration(args: CliArgs): Promise<number> {
  return executeRepositoryCommand('repository-bind', args);
}

export function unbindRepositoryConfiguration(args: CliArgs): Promise<number> {
  return executeRepositoryCommand('repository-unbind', args);
}

export function lockRepositoryObjects(args: CliArgs): Promise<number> {
  return executeRepositoryCommand('repository-lock', args);
}

export function unlockRepositoryObjects(args: CliArgs): Promise<number> {
  return executeRepositoryCommand('repository-unlock', args);
}

export function commitRepositoryObjects(args: CliArgs): Promise<number> {
  return executeRepositoryCommand('repository-commit', args);
}

export function updateRepositoryConfiguration(args: CliArgs): Promise<number> {
  return executeRepositoryCommand('repository-update', args);
}

export function addRepositoryUser(args: CliArgs): Promise<number> {
  return executeRepositoryCommand('repository-add-user', args);
}

export function copyRepositoryUsers(args: CliArgs): Promise<number> {
  return executeRepositoryCommand('repository-copy-users', args);
}

export function dumpRepositoryConfiguration(args: CliArgs): Promise<number> {
  return executeRepositoryCommand('repository-dump', args);
}

export function reportRepository(args: CliArgs): Promise<number> {
  return executeRepositoryCommand('repository-report', args);
}

export function setRepositoryLabel(args: CliArgs): Promise<number> {
  return executeRepositoryCommand('repository-set-label', args);
}
