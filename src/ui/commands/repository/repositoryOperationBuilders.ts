import type { RepositoryBinding } from '../../../infra/repository/RepositoryService';
import type { RepositoryOperation } from '../../../infra/repository/RepositoryDesignerArgs';

/*
 * Построение операций хранилища из данных диалогов. Без `vscode`: диалоги в
 * RepositoryCommands.ts лишь собирают ответы, а то, какие ключи уйдут в
 * Конфигуратор, решается здесь и проверяется unit-тестом.
 */

export type RepositoryReportFlag =
  | 'GroupByObject'
  | 'GroupByComment'
  | 'DoNotIncludeVersionsWithLabels'
  | 'IncludeOnlyVersionsWithLabels'
  | 'IncludeCommentLinesWithDoubleSlash';

export type RepositoryReportFormat = 'txt' | 'mxl';

type OperationOf<K extends RepositoryOperation['kind']> = Extract<RepositoryOperation, { kind: K }>;

export function buildBindOperation(form: {
  forceBindAlreadyBindedUser?: boolean;
  forceReplaceCfg?: boolean;
}): OperationOf<'bind'> {
  return {
    kind: 'bind',
    forceBindAlreadyBindedUser: form.forceBindAlreadyBindedUser,
    forceReplaceCfg: form.forceReplaceCfg,
  };
}

export function buildCreateOperation(form: {
  allowConfigurationChanges?: boolean;
  changesAllowedRule?: string;
  changesNotRecommendedRule?: string;
  noBind?: boolean;
}): OperationOf<'create'> {
  return {
    kind: 'create',
    allowConfigurationChanges: form.allowConfigurationChanges,
    changesAllowedRule: form.changesAllowedRule,
    changesNotRecommendedRule: form.changesNotRecommendedRule,
    noBind: form.noBind,
  };
}

export function buildAddUserOperation(input: {
  user: string;
  password: string;
  rights: string;
  restoreDeletedUser: boolean;
}): OperationOf<'addUser'> {
  return {
    kind: 'addUser',
    user: input.user,
    password: input.password,
    rights: input.rights,
    restoreDeletedUser: input.restoreDeletedUser,
  };
}

export function buildCopyUsersOperation(input: {
  path: string;
  user: string;
  password: string;
  restoreDeletedUser: boolean;
}): OperationOf<'copyUsers'> {
  return {
    kind: 'copyUsers',
    path: input.path,
    user: input.user,
    password: input.password,
    restoreDeletedUser: input.restoreDeletedUser,
  };
}

/** Пустая версия — «актуальная»: построитель вектора пустые значения не передаёт. */
export function buildDumpOperation(version: string): OperationOf<'dump'> {
  return { kind: 'dump', version: version.trim() };
}

/** У получения пустая версия — `undefined`, а не пустая строка: так её трактует поле формы. */
export function normalizeUpdateVersion(version: string): string | undefined {
  return version.trim() || undefined;
}

export function buildReportOperation(input: {
  nBegin: string;
  nEnd: string;
  dateBegin: string;
  dateEnd: string;
  configurationVersion: string;
  format: RepositoryReportFormat;
  flags: readonly RepositoryReportFlag[];
}): OperationOf<'report'> {
  const flags = input.flags;
  return {
    kind: 'report',
    nBegin: input.nBegin.trim(),
    nEnd: input.nEnd.trim(),
    dateBegin: input.dateBegin.trim(),
    dateEnd: input.dateEnd.trim(),
    configurationVersion: input.configurationVersion.trim(),
    reportFormat: input.format,
    groupByObject: flags.includes('GroupByObject'),
    groupByComment: flags.includes('GroupByComment'),
    doNotIncludeVersionsWithLabels: flags.includes('DoNotIncludeVersionsWithLabels'),
    includeOnlyVersionsWithLabels: flags.includes('IncludeOnlyVersionsWithLabels'),
    includeCommentLinesWithDoubleSlash: flags.includes('IncludeCommentLinesWithDoubleSlash'),
  };
}

/** Расширение файла отчёта по умолчанию: платформа пишет mxl только в формате mxl. */
export function reportDefaultExtension(format: RepositoryReportFormat): 'mxl' | 'txt' {
  return format === 'mxl' ? 'mxl' : 'txt';
}

export function buildSetLabelOperation(input: {
  name: string;
  version: string;
  comment: string;
}): OperationOf<'setLabel'> {
  return { kind: 'setLabel', name: input.name, version: input.version.trim(), comment: input.comment.trim() };
}

export type BindingFormValidation =
  | { ok: true; binding: RepositoryBinding }
  | { ok: false; errorMessage: string };

/** Пароль не обрезается: пробелы в нём значимы, в отличие от пути и имени пользователя. */
export function validateBindingForm(
  formData: { repoPath: string; repoUser: string; repoPassword: string }
): BindingFormValidation {
  const repoPath = formData.repoPath.trim();
  const repoUser = formData.repoUser.trim();
  if (!repoPath) {
    return { ok: false, errorMessage: 'Нужно указать путь к хранилищу или адрес сервера.' };
  }
  if (!repoUser) {
    return { ok: false, errorMessage: 'Нужно указать пользователя хранилища.' };
  }
  return { ok: true, binding: { repoPath, repoUser, repoPassword: formData.repoPassword } };
}

/** Имя объекта в имени файла по умолчанию: символы, запрещённые в путях Windows, заменяются. */
export function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_');
}
