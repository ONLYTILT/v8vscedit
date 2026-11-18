import type { DesignerArg, DesignerBatchRequest } from '../process/designer/DesignerBatchExecutor';
import type { RepositoryBinding } from './RepositoryService';
import { buildInfoBaseConnectionArgs, type InfoBaseConnection } from '../process/designer/InfoBaseConnectionArgs';

// Н5: прежние импорты из этого модуля остаются рабочими.
export { buildInfoBaseConnectionArgs, type InfoBaseConnection };

/**
 * ЕДИНСТВЕННЫЙ построитель вектора пакетного конфигуратора для операций хранилища.
 *
 * Прежде вектор собирался дважды (UI через псевдо-CLI `extraArgs`, CLI вручную) с
 * разным порядком аргументов. Платформа молча принимает и игнорирует неизвестные
 * ключи, поэтому расхождение двух копий не проявилось бы ни одним запуском —
 * отсюда одна реализация под точным регресс-тестом вектора.
 */

/**
 * Содержимое файла `-Objects`: строка (UI собирает XML сам) или байты как есть (CLI
 * передаёт `-ObjectsFile` без перекодировки — кодировку файла задаёт вызывающий).
 */
export type RepositoryObjectsXml = string | Uint8Array;

export type RepositoryOperation =
  | {
    readonly kind: 'create';
    readonly allowConfigurationChanges?: boolean;
    readonly changesAllowedRule?: string;
    readonly changesNotRecommendedRule?: string;
    readonly noBind?: boolean;
  }
  | { readonly kind: 'bind'; readonly forceBindAlreadyBindedUser?: boolean; readonly forceReplaceCfg?: boolean }
  | { readonly kind: 'unbind'; readonly force?: boolean }
  | { readonly kind: 'lock'; readonly objectsXml?: RepositoryObjectsXml; readonly revised?: boolean }
  | { readonly kind: 'unlock'; readonly objectsXml?: RepositoryObjectsXml; readonly force?: boolean }
  | {
    readonly kind: 'commit';
    readonly objectsXml?: RepositoryObjectsXml;
    readonly comment?: string;
    readonly keepLocked?: boolean;
    readonly force?: boolean;
  }
  | { readonly kind: 'update'; readonly objectsXml?: RepositoryObjectsXml; readonly version?: string; readonly force?: boolean }
  | {
    readonly kind: 'addUser';
    readonly user: string;
    readonly password?: string;
    readonly rights?: string;
    readonly restoreDeletedUser?: boolean;
  }
  | {
    readonly kind: 'copyUsers';
    readonly path: string;
    readonly user: string;
    readonly password?: string;
    readonly restoreDeletedUser?: boolean;
  }
  | { readonly kind: 'dump'; readonly version?: string }
  | {
    readonly kind: 'report';
    readonly nBegin?: string;
    readonly nEnd?: string;
    readonly dateBegin?: string;
    readonly dateEnd?: string;
    readonly configurationVersion?: string;
    readonly reportFormat?: string;
    readonly groupByObject?: boolean;
    readonly groupByComment?: boolean;
    readonly doNotIncludeVersionsWithLabels?: boolean;
    readonly includeOnlyVersionsWithLabels?: boolean;
    readonly includeCommentLinesWithDoubleSlash?: boolean;
  }
  | { readonly kind: 'setLabel'; readonly name: string; readonly version?: string; readonly comment?: string };

/** Имя выходного файла `dump` в `DesignerBatchResult.outputs`. */
export const REPOSITORY_DUMP_OUTPUT = 'dump.cf';

type ReportOperation = Extract<RepositoryOperation, { kind: 'report' }>;

/**
 * Имя staging-файла отчёта (оно же ключ в `DesignerBatchResult.outputs`).
 *
 * Расширение — только для человека, читающего staging: замер на платформе 8.3.27.2130
 * показал, что формат отчёта задаёт ТОЛЬКО `-ReportFormat`, расширение файла платформа
 * игнорирует (`.mxl`/`.txt`/`.out` дают одинаковый результат), а без ключа всегда пишет
 * MXL. Поэтому без явного формата имя — `report.mxl`, независимо от пути пользователя.
 */
export function repositoryReportOutputName(op: Pick<ReportOperation, 'reportFormat'>): 'report.mxl' | 'report.txt' {
  return op.reportFormat?.trim().toLowerCase() === 'txt' ? 'report.txt' : 'report.mxl';
}

/**
 * Имя выходного файла операции в `DesignerBatchResult.outputs`; `undefined` — у операции
 * нет выходного файла. Одна точка для UI и CLI, чтобы ключ переноса не разошёлся с вектором.
 */
export function repositoryOperationOutputName(op: RepositoryOperation): string | undefined {
  if (op.kind === 'dump') {
    return REPOSITORY_DUMP_OUTPUT;
  }
  return op.kind === 'report' ? repositoryReportOutputName(op) : undefined;
}

const OBJECTS_INPUT = 'objects.xml';

export function buildRepositoryDesignerRequest(
  connection: InfoBaseConnection,
  binding: RepositoryBinding,
  op: RepositoryOperation,
  extensionName?: string
): DesignerBatchRequest {
  const args: DesignerArg[] = ['DESIGNER', ...buildInfoBaseConnectionArgs(connection)];
  args.push('/ConfigurationRepositoryF', binding.repoPath, '/ConfigurationRepositoryN', binding.repoUser);
  if (binding.repoPassword) {
    args.push('/ConfigurationRepositoryP', binding.repoPassword);
  }
  args.push(...buildOperationArgs(op));
  if (extensionName) {
    args.push('-Extension', extensionName);
  }

  // Пустые значения маскеру не нужны: пустая подстрока совпала бы с чем угодно.
  const secrets = [connection.password, binding.repoPassword, operationSecret(op)]
    .filter((value): value is string => Boolean(value));
  return { args, secrets };
}

function operationSecret(op: RepositoryOperation): string | undefined {
  return op.kind === 'addUser' || op.kind === 'copyUsers' ? op.password : undefined;
}

function buildOperationArgs(op: RepositoryOperation): DesignerArg[] {
  const args: DesignerArg[] = [];
  const value = (name: string, raw: string | undefined): void => {
    if (raw) {
      args.push(name, raw);
    }
  };
  const flag = (name: string, enabled: boolean | undefined): void => {
    if (enabled) {
      args.push(name);
    }
  };
  const objects = (xml: RepositoryObjectsXml | undefined): void => {
    // Длина, а не истинность: пустой Uint8Array истинен, но -Objects без списка не нужен.
    if (xml !== undefined && xml.length > 0) {
      args.push('-Objects', { kind: 'inputFile', name: OBJECTS_INPUT, content: xml });
    }
  };

  switch (op.kind) {
    case 'create':
      args.push('/ConfigurationRepositoryCreate');
      flag('-AllowConfigurationChanges', op.allowConfigurationChanges);
      value('-ChangesAllowedRule', op.changesAllowedRule);
      value('-ChangesNotRecommendedRule', op.changesNotRecommendedRule);
      flag('-NoBind', op.noBind);
      break;
    case 'bind':
      args.push('/ConfigurationRepositoryBindCfg');
      flag('-forceBindAlreadyBindedUser', op.forceBindAlreadyBindedUser);
      flag('-forceReplaceCfg', op.forceReplaceCfg);
      break;
    case 'unbind':
      args.push('/ConfigurationRepositoryUnbindCfg');
      flag('-force', op.force);
      break;
    case 'lock':
      args.push('/ConfigurationRepositoryLock');
      objects(op.objectsXml);
      flag('-revised', op.revised);
      break;
    case 'unlock':
      args.push('/ConfigurationRepositoryUnLock');
      objects(op.objectsXml);
      flag('-force', op.force);
      break;
    case 'commit':
      args.push('/ConfigurationRepositoryCommit');
      objects(op.objectsXml);
      value('-comment', op.comment);
      flag('-keepLocked', op.keepLocked);
      flag('-force', op.force);
      break;
    case 'update':
      args.push('/ConfigurationRepositoryUpdateCfg');
      objects(op.objectsXml);
      value('-v', op.version);
      flag('-force', op.force);
      break;
    case 'addUser':
      args.push('/ConfigurationRepositoryAddUser');
      value('-User', op.user);
      value('-Pwd', op.password);
      value('-Rights', op.rights);
      flag('-RestoreDeletedUser', op.restoreDeletedUser);
      break;
    case 'copyUsers':
      args.push('/ConfigurationRepositoryCopyUsers');
      value('-Path', op.path);
      value('-User', op.user);
      value('-Pwd', op.password);
      flag('-RestoreDeletedUser', op.restoreDeletedUser);
      break;
    case 'dump':
      // Путь выходного файла выбирает исполнитель (локальный temp или каталог на сервере);
      // перенос на путь пользователя — дело вызывающего и только при exitCode === 0.
      args.push('/ConfigurationRepositoryDumpCfg', { kind: 'outputFile', name: REPOSITORY_DUMP_OUTPUT });
      value('-v', op.version);
      break;
    case 'report':
      args.push('/ConfigurationRepositoryReport', { kind: 'outputFile', name: repositoryReportOutputName(op) });
      value('-NBegin', op.nBegin);
      value('-NEnd', op.nEnd);
      value('-DateBegin', op.dateBegin);
      value('-DateEnd', op.dateEnd);
      value('-ConfigurationVersion', op.configurationVersion);
      value('-ReportFormat', op.reportFormat);
      flag('-GroupByObject', op.groupByObject);
      flag('-GroupByComment', op.groupByComment);
      flag('-DoNotIncludeVersionsWithLabels', op.doNotIncludeVersionsWithLabels);
      flag('-IncludeOnlyVersionsWithLabels', op.includeOnlyVersionsWithLabels);
      flag('-IncludeCommentLinesWithDoubleSlash', op.includeCommentLinesWithDoubleSlash);
      break;
    case 'setLabel':
      args.push('/ConfigurationRepositorySetLabel');
      value('-name', op.name);
      value('-v', op.version);
      value('-comment', op.comment);
      break;
  }
  return args;
}
