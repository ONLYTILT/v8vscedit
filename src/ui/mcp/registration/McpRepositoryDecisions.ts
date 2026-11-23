/**
 * Чистые решения MCP-инструментов хранилища: вопрос диалога UI-команды превращается в явный параметр
 * агента, а решает та же таблица `planRepository*`, что и для человека. Агент диалогов не видит,
 * поэтому там, где UI спросил бы ('ask') или человек отказался ('cancel'), здесь — исключение с
 * текстом, по которому агент знает, какой параметр передать.
 */
import * as path from 'path';
import type { RepositoryNodeRef, RepositoryTarget } from '../../../infra/repository/RepositoryService';
import {
  planRepositoryCommit,
  type CommitLocalChangesChoice,
  type RepositoryCommitPlan,
} from '../../commands/repository/repositoryCommitFlow';
import {
  planRepositoryLock,
  type LockLocalChangesChoice,
  type RepositoryLockPlan,
} from '../../commands/repository/repositoryLockFlow';
import {
  describeLockedOverwrite,
  planRepositoryUpdate,
  type RepositoryUpdatePlan,
  type UpdateLocalChangesChoice,
} from '../../commands/repository/repositoryUpdateFlow';

export type McpLockLocalChanges = 'loadFirst' | 'keepProjectBehind' | 'abort';
export type McpUpdateLocalChanges = 'loadAfter' | 'keepProjectBehind' | 'abort';
export type McpCommitLocalChanges = 'loadFirst' | 'abort';

export const MCP_LOCK_LOCAL_CHANGES = ['loadFirst', 'keepProjectBehind', 'abort'] as const;
export const MCP_UPDATE_LOCAL_CHANGES = ['loadAfter', 'keepProjectBehind', 'abort'] as const;
export const MCP_COMMIT_LOCAL_CHANGES = ['loadFirst', 'abort'] as const;

const LOCK_CHOICE: Record<McpLockLocalChanges, LockLocalChangesChoice> = {
  loadFirst: 'update-then-lock',
  keepProjectBehind: 'lock-without-import',
  abort: 'cancel',
};

const UPDATE_CHOICE: Record<McpUpdateLocalChanges, UpdateLocalChangesChoice> = {
  loadAfter: 'receive-then-load',
  keepProjectBehind: 'receive-without-import',
  abort: 'cancel',
};

const COMMIT_CHOICE: Record<McpCommitLocalChanges, CommitLocalChangesChoice> = {
  loadFirst: 'load-first',
  abort: 'cancel',
};

const ROOT_RECURSIVE_LOCK_NOT_CONFIRMED =
  'Рекурсивный захват корня захватывает всю конфигурацию и блокирует её для всей команды. Передайте confirm: true.';
const COMMIT_NOT_CONFIRMED = 'Помещение необратимо записывает версию в общее хранилище команды. Передайте confirm: true.';
const COMMIT_EMPTY_COMMENT = 'Для помещения требуется непустой комментарий (comment).';
const OVERWRITE_LOCKED_HINT =
  ' Передайте overwriteLocked: true, чтобы подтвердить, или сначала поместите правки (v8vscedit_repository_commit).';
const OVERWRITE_LOCKED_DECLINED =
  'Получение не выполнено: в выборке есть захваченные вами объекты (overwriteLocked: false).';
const ABORTED_BY_PARAMETER = "отменено параметром localChanges: 'abort'.";

/**
 * Режим шага загрузки: явный параметр агента или настройка `updateDatabaseAfterLoad`. Это не вопрос диалога
 * (там умолчания нет), а режим работы — поэтому умолчание допустимо.
 */
interface McpLoadModeInput {
  readonly updateDatabase?: boolean;
  readonly updateDatabaseAfterLoad: boolean;
}

function effectiveUpdateDatabase(input: McpLoadModeInput): boolean {
  return input.updateDatabase ?? input.updateDatabaseAfterLoad;
}

export function resolveMcpLockPlan(input: McpLoadModeInput & {
  readonly revisedSetting: boolean;
  readonly dirtyFilesCount: number;
  readonly localChanges?: McpLockLocalChanges;
}): RepositoryLockPlan {
  const plan = planRepositoryLock({
    revisedSetting: input.revisedSetting,
    dirtyFilesCount: input.dirtyFilesCount,
    choice: input.localChanges === undefined ? undefined : LOCK_CHOICE[input.localChanges],
    updateDatabaseAfterLoad: effectiveUpdateDatabase(input),
  });
  if (plan === 'ask') {
    throw new Error(
      `В проекте ${String(input.dirtyFilesCount)} незагруженных изменённых файлов; захват может получить новые версии, ` +
      "а импорт после него перезаписал бы эти правки. Передайте localChanges: 'loadFirst' (загрузить правки в базу " +
      "перед захватом), 'keepProjectBehind' (захватить, проект не обновлять) или 'abort'."
    );
  }
  if (plan === 'cancel') {
    throw new Error(`Захват не выполнен: ${ABORTED_BY_PARAMETER}`);
  }
  return plan;
}

export function resolveMcpUpdatePlan(input: McpLoadModeInput & {
  readonly dirtyFilesCount: number;
  readonly lockedInSelection: readonly string[];
  readonly overwriteLocked?: boolean;
  readonly localChanges?: McpUpdateLocalChanges;
}): RepositoryUpdatePlan {
  const decision = planRepositoryUpdate({
    dirtyFilesCount: input.dirtyFilesCount,
    lockedInSelection: input.lockedInSelection,
    lockedOverwriteConfirmed: input.overwriteLocked,
    choice: input.localChanges === undefined ? undefined : UPDATE_CHOICE[input.localChanges],
    updateDatabaseAfterLoad: effectiveUpdateDatabase(input),
  });
  switch (decision) {
    case 'ask-locked-overwrite':
      throw new Error(`${describeLockedOverwrite(input.lockedInSelection)}${OVERWRITE_LOCKED_HINT}`);
    case 'ask-local-changes':
      throw new Error(
        `В проекте ${String(input.dirtyFilesCount)} незагруженных изменённых файлов; импорт после получения ` +
        "перезаписал бы эти правки. Передайте localChanges: 'loadAfter' (загрузить правки в базу после получения), " +
        "'keepProjectBehind' (получить, проект не обновлять) или 'abort'."
      );
    case 'cancel':
      // Отказ от перезаписи захваченных проверяется планировщиком первым — тем же порядком и здесь.
      throw new Error(
        input.lockedInSelection.length > 0 && input.overwriteLocked === false
          ? OVERWRITE_LOCKED_DECLINED
          : `Получение не выполнено: ${ABORTED_BY_PARAMETER}`
      );
    default:
      return decision;
  }
}

export function resolveMcpCommitPlan(input: McpLoadModeInput & {
  readonly dirtyFilesCount: number;
  readonly localChanges?: McpCommitLocalChanges;
}): RepositoryCommitPlan {
  const plan = planRepositoryCommit({
    dirtyFilesCount: input.dirtyFilesCount,
    choice: input.localChanges === undefined ? undefined : COMMIT_CHOICE[input.localChanges],
    updateDatabaseAfterLoad: effectiveUpdateDatabase(input),
  });
  if (plan === 'ask') {
    throw new Error(
      `В проекте ${String(input.dirtyFilesCount)} незагруженных изменённых файлов; помещение без предварительной ` +
      "загрузки запрещено. Передайте localChanges: 'loadFirst' (загрузить правки в базу перед помещением) или 'abort'."
    );
  }
  if (plan === 'cancel') {
    throw new Error(`Помещение не выполнено: ${ABORTED_BY_PARAMETER}`);
  }
  return plan;
}

/** Необратимость — первой: без согласия комментарий не важен. */
export function assertCommitArgs(input: { readonly confirm?: boolean; readonly comment: string }): void {
  if (input.confirm !== true) {
    throw new Error(COMMIT_NOT_CONFIRMED);
  }
  if (!input.comment.trim()) {
    throw new Error(COMMIT_EMPTY_COMMENT);
  }
}

/** Рекурсивный захват корня блокирует всю конфигурацию для команды — только с явным согласием. */
export function assertRootRecursiveLockConfirmed(input: {
  readonly nodeKind?: string;
  readonly recursive: boolean;
  readonly confirm?: boolean;
}): void {
  const isRoot = input.nodeKind === 'configuration' || input.nodeKind === 'extension';
  if (isRoot && input.recursive && input.confirm !== true) {
    throw new Error(ROOT_RECURSIVE_LOCK_NOT_CONFIRMED);
  }
}

/**
 * Лимит длины `paths`. Технического ограничения на этом масштабе нет (файл `-Objects` — КБ-порядок); это защита
 * от ошибочной выборки: операция держит общий замок и захватывает объекты для всей команды, а 100 явных объектов —
 * уже «подсистема», для которой есть `recursive: true`.
 */
export const MCP_REPOSITORY_PATHS_LIMIT = 100;

/**
 * `path` или `paths` → список путей (ДО резолвинга и замка). Взаимоисключение, а не «paths побеждает», как у
 * `validate_metadata`: операции мутирующие, и двусмысленный вызов агента должен отбиваться, а не угадываться.
 * Буквальный повтор — ошибка агента; разные пути к одному объекту схлопывает выборка по `fullName`.
 */
export function normalizeRepositoryPathsInput(input: { readonly path?: string; readonly paths?: readonly string[] }): string[] {
  if (input.path !== undefined && input.paths !== undefined) {
    throw new Error('Передайте либо path (один объект), либо paths (список объектов), но не оба.');
  }
  if (input.path !== undefined) {
    return [input.path];
  }
  if (input.paths === undefined) {
    throw new Error('Укажите path (канонический путь объекта) или paths (список канонических путей).');
  }
  if (input.paths.length === 0) {
    throw new Error('Список paths пуст: передайте хотя бы один канонический путь.');
  }
  const paths = input.paths.map((item) => item.trim());
  const emptyIndex = paths.findIndex((item) => item.length === 0);
  if (emptyIndex >= 0) {
    throw new Error(`Пустой элемент в paths (позиция ${String(emptyIndex + 1)}).`);
  }
  if (paths.length > MCP_REPOSITORY_PATHS_LIMIT) {
    throw new Error(
      `В paths ${String(paths.length)} путей; за один вызов допускается не более ${String(MCP_REPOSITORY_PATHS_LIMIT)}. ` +
      'Для крупной выборки используйте рекурсивную операцию над подсистемой или корнем (recursive: true) либо разбейте список.'
    );
  }
  const seen = new Set<string>();
  const repeated = new Map<string, string>();
  for (const item of paths) {
    const key = item.toLocaleLowerCase('ru');
    if (seen.has(key) && !repeated.has(key)) {
      repeated.set(key, item);
    }
    seen.add(key);
  }
  if (repeated.size > 0) {
    throw new Error(`Повторяющиеся пути в paths: ${[...repeated.values()].map((item) => `"${item}"`).join(', ')}.`);
  }
  return paths;
}

/**
 * Один запуск Конфигуратора работает с одной целью (основной конфигурацией или одним расширением): разные цели
 * отбиваются до замка, с одним примером пути на цель — по нему агент разобьёт вызов.
 */
export function assertSingleRepositoryTarget(items: readonly { readonly path: string; readonly target: RepositoryTarget }[]): RepositoryTarget {
  const examples = new Map<string, { readonly path: string; readonly target: RepositoryTarget }>();
  for (const item of items) {
    const key = path.resolve(item.target.configRoot).toLowerCase();
    if (!examples.has(key)) {
      examples.set(key, item);
    }
  }
  if (examples.size > 1) {
    const listed = [...examples.values()].map((item) => `"${item.target.displayName}" (${item.path})`).join(', ');
    throw new Error(
      'Все пути paths должны относиться к одной цели хранилища (основной конфигурации или одному расширению), ' +
      `а получено несколько: ${listed}. Выполните операцию отдельным вызовом для каждой цели.`
    );
  }
  return items[0].target;
}

/**
 * Узел дерева → ссылка для `RepositoryService`. `MetadataNode.label` может быть `TreeItemLabel`,
 * а сервис ждёт строку: подпись берётся из `textLabel`.
 */
export function toRepositoryNodeRef(node: {
  readonly nodeKind?: string;
  /** Подпись узла как есть (строка или `TreeItemLabel`) — не используется, см. `textLabel`. */
  readonly label?: unknown;
  readonly textLabel: string;
  readonly xmlPath?: string;
  readonly metaContext?: RepositoryNodeRef['metaContext'];
}): RepositoryNodeRef {
  return {
    nodeKind: node.nodeKind,
    label: node.textLabel,
    xmlPath: node.xmlPath,
    metaContext: node.metaContext,
  };
}
