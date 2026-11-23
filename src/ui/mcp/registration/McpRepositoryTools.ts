/**
 * MCP-инструменты хранилища конфигурации: состояние, захват, получение, помещение, отмена захвата.
 *
 * Бизнес-логика — общие с UI-командами цепочки (`commands/repository/repositoryChains`) и
 * планировщики `planRepository*` (через `McpRepositoryDecisions`): вопрос диалога UI здесь — явный
 * параметр агента. Порядок каждого инструмента: проверка аргументов без побочных эффектов → узлы и
 * одна подключённая цель → бросающий замок → ПОД ЗАМКОМ число незагруженных файлов и захваты выборки →
 * план → цепочка. Пароль хранилища агент не передаёт: он берётся из SecretStorage тем же
 * `resolveBindingForCommand`, что у UI.
 *
 * `path` или `paths` (план docs/plans/mcp-repository-paths-plan.md): список одной цели выполняется ОДНИМ
 * запуском Конфигуратора с единым файлом `-Objects` — та же цепочка, что для одного узла.
 *
 * `gate.afterMutation` НЕ вызывается сознательно (отклонение от общего post-mutation пути, как у
 * `v8vscedit_load_cf`): операции меняют базу и учёт захватов, а файлы проекта меняет только импорт,
 * который сам делает `markConfigurationsClean` + `reloadEntries`. Пометка «изменено» заставила бы
 * «Обновить БД» залить старые файлы поверх полученного из хранилища. После операции обновляются
 * только дерево и панель действий (`refreshRepositoryUi`).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import {
  formatRepositoryLockName,
  type RepositoryNodeRef,
  type RepositoryTarget,
} from '../../../infra/repository/RepositoryService';
import { describeRunningOperation } from '../../../infra/progress/OperationStageFeed';
import {
  getConfigurationOperationStartedAt,
  isConfigurationOperationRunning,
  runWithConfigurationOperationLockOrThrow,
} from '../../commands/ext/configurationOperationLock';
import { operationStageFeed } from '../../commands/ext/configurationOperationStatus';
import { RepositoryCliError, RepositoryCliInterruptedError } from '../../commands/repository/RepositoryCommandRunner';
import { readUpdateDatabaseAfterLoad } from '../../commands/ext/databaseSettings';
import { readRevisedOnLockSetting } from '../../commands/repository/RepositoryLockCommand';
import {
  describeUnlockNotDone,
  runCommitChain,
  runLockChain,
  runUnlockChain,
  runUpdateChain,
} from '../../commands/repository/repositoryChains';
import { describeNotConnected } from '../../commands/repository/repositoryNodeTargets';
import { lagScopeKey } from '../../../infra/database/DatabaseConfigLag';
import { findChangedConfiguration, refreshRepositoryUi, toDatabaseLagTarget } from '../../commands/repository/repositoryPostSync';
import {
  MCP_COMMIT_LOCAL_CHANGES,
  MCP_LOCK_LOCAL_CHANGES,
  MCP_UPDATE_LOCAL_CHANGES,
  assertCommitArgs,
  assertRootRecursiveLockConfirmed,
  assertSingleRepositoryTarget,
  normalizeRepositoryPathsInput,
  resolveMcpCommitPlan,
  resolveMcpLockPlan,
  resolveMcpUpdatePlan,
  toRepositoryNodeRef,
} from './McpRepositoryDecisions';
import type { McpMutationGate } from './McpMutationGate';
import type { McpCommandServices, McpRegistrationDeps } from './McpRegistrationDeps';

const INTERRUPTED_MESSAGE = 'Операция прервана пользователем';
/**
 * Режим шага загрузки — не вопрос диалога, а режим работы: без параметра действует настройка
 * `updateDatabaseAfterLoad`, поэтому параметр необязателен (в отличие от `localChanges`).
 */
const UPDATE_DATABASE_SCHEMA = z.boolean().optional();
/** Взаимоисключение path/paths проверяет `normalizeRepositoryPathsInput`: схема допускает оба, чтобы отказ был понятным. */
const PATH_SCHEMA = z.string().optional();
const PATHS_SCHEMA = z.array(z.string()).optional();

const UNLOCK_FAILURE_HINT =
  'Если объект изменён в базе, отменить захват без потери правок нельзя: поместите изменения (v8vscedit_repository_commit).';

/** Общая часть описаний четырёх инструментов: как задаётся выборка. */
const PATHS_DESCRIPTION =
  'Принимает канонический путь (path) или список путей одной конфигурации/расширения (paths, до 100) — операция ' +
  'выполняется одним запуском Конфигуратора; recursive применяется к каждому элементу; дочерний элемент обрабатывает владельца.';

interface ResolvedRepositoryNode {
  readonly ref: RepositoryNodeRef;
  readonly target: RepositoryTarget;
}

/** Выборка вызова: узлы одной подключённой цели и эхо входа (`path` или нормализованный `paths`). */
interface ResolvedRepositorySelection {
  readonly refs: RepositoryNodeRef[];
  readonly target: RepositoryTarget;
  readonly echo: { readonly path: string } | { readonly paths: string[] };
}

interface RepositoryPathsInput {
  readonly path?: string;
  readonly paths?: string[];
  readonly configuration?: string;
}

export function registerRepositoryTools(server: McpServer, deps: McpRegistrationDeps): void {
  const { services, gate } = deps;

  /** Узел по канону → ссылка и цель, без проверки подключения (статус показывает и неподключённые). */
  const resolveNodeTarget = (path: string, configuration: string | undefined): ResolvedRepositoryNode => {
    const ref = toRepositoryNodeRef(deps.paths.resolveNode(path, configuration));
    const target = ref.xmlPath ? services.repositoryService.resolveTargetByXmlPath(ref.xmlPath) : null;
    if (!target) {
      throw new Error(`Не удалось определить конфигурацию для узла "${path}".`);
    }
    return { ref, target };
  };

  /**
   * Всё, что проверяется без побочных эффектов и до замка: вход, узлы, одна цель, подключение (один раз) и
   * полное имя каждого узла — чтобы плохой элемент списка отбился раньше запуска, а не посреди цепочки.
   */
  const resolveConnectedSelection = (input: RepositoryPathsInput): ResolvedRepositorySelection => {
    const paths = normalizeRepositoryPathsInput(input);
    const items = paths.map((path) => resolveNodeTarget(path, input.configuration));
    const target = assertSingleRepositoryTarget(items.map((item, index) => ({ path: paths[index], target: item.target })));
    const repository = services.repositoryService;
    if (!repository.hasBinding(target) || !repository.isConnected(target)) {
      throw new Error(`${describeNotConnected(target)} (состояние — v8vscedit_repository_status)`);
    }
    items.forEach((item, index) => {
      try {
        repository.resolveSelectionEntry(item.ref);
      } catch (error) {
        throw new Error(`Путь "${paths[index]}": ${(error as Error).message}`, { cause: error });
      }
    });
    return {
      refs: items.map((item) => item.ref),
      target,
      echo: input.path !== undefined ? { path: input.path } : { paths },
    };
  };

  const dirtyFilesCount = async (target: RepositoryTarget): Promise<number> =>
    (await findChangedConfiguration(services, target))?.changedFilesCount ?? 0;

  /** Цепочка под уже взятым замком; дерево обновляется и после частичного исхода (учёт мог измениться). */
  const runChain = async <T>(chain: () => Promise<T>): Promise<T> => {
    try {
      return await chain();
    } finally {
      refreshRepositoryUi(services);
    }
  };

  server.registerTool(
    'v8vscedit_repository_status',
    {
      title: 'Состояние хранилища конфигурации',
      description: 'Показывает подключение узла к хранилищу конфигурации: привязку (без пароля), подключено ли оно, захваченные вами объекты по локальному учёту и число незагруженных изменённых файлов проекта. databaseConfigurationBehind — признак «конфигурация БД не обновлена» по данным расширения ({ since, source } или null). Также показывает состояние общей операции с конфигурацией: operationRunning — идёт ли сейчас операция; currentOperation — время её начала, длительность и текущий этап (null, если операции нет); lastOperation — исход последней завершённой долгой операции MCP (null, если их не было): по нему можно узнать результат, если соединение оборвалось. Платформу не вызывает. Принимает канонический путь объекта или корня конфигурации/расширения (Справочники.Товары, Конфигурация, Расширение).',
      inputSchema: z.object({
        path: z.string(),
        configuration: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ path, configuration }) => gate.wrapAsync(async () => {
      const { ref, target } = resolveNodeTarget(path, configuration);
      return {
        ...await buildStatus(services, path, ref, target, await dirtyFilesCount(target)),
        ...describeOperationState(gate),
      };
    })
  );

  server.registerTool(
    'v8vscedit_repository_lock',
    {
      title: 'Захватить объекты в хранилище',
      description: `Захватывает объекты в хранилище конфигурации для редактирования через пакетный Конфигуратор; после захвата, если из хранилища получены новые версии, импортирует их в файлы проекта. Рекурсивный захват корня (корень где угодно в списке) требует confirm: true. При незагруженных правках проекта обязателен localChanges: loadFirst (загрузить правки в базу перед захватом), keepProjectBehind (захватить, проект не обновлять) или abort. updateDatabase — обновлять ли конфигурацию БД на шаге загрузки правок (по умолчанию — настройка updateDatabaseAfterLoad); в ответе databaseConfigurationUpdated и databaseConfigurationBehind (конфигурация БД отстаёт от основной, например после получения версий). Частичный захват (часть объектов занята другим пользователем или отсутствует) — успех с предупреждением: в ответе notLocked (не захваченные) и lockedByOthers (кем заняты). ${PATHS_DESCRIPTION}`,
      inputSchema: z.object({
        path: PATH_SCHEMA,
        paths: PATHS_SCHEMA,
        configuration: z.string().optional(),
        recursive: z.boolean().optional(),
        localChanges: z.enum(MCP_LOCK_LOCAL_CHANGES).optional(),
        confirm: z.boolean().optional(),
        updateDatabase: UPDATE_DATABASE_SCHEMA,
      }),
      annotations: { destructiveHint: false },
    },
    (args, extra) => gate.wrapLongRunning('v8vscedit_repository_lock', extra, () => withRepositoryErrors(async () => {
      const { refs, target, echo } = resolveConnectedSelection(args);
      const isRecursive = args.recursive ?? false;
      for (const ref of refs) {
        assertRootRecursiveLockConfirmed({ nodeKind: ref.nodeKind, recursive: isRecursive, confirm: args.confirm });
      }
      const result = await runWithConfigurationOperationLockOrThrow(async () => {
        const plan = resolveMcpLockPlan({
          revisedSetting: readRevisedOnLockSetting(),
          dirtyFilesCount: await dirtyFilesCount(target),
          localChanges: args.localChanges,
          updateDatabase: args.updateDatabase,
          updateDatabaseAfterLoad: readUpdateDatabaseAfterLoad(),
        });
        return runChain(() => runLockChain(services, target, refs, isRecursive, plan, 'unattended'));
      });
      return { ...echo, ...result };
    }))
  );

  server.registerTool(
    'v8vscedit_repository_update',
    {
      title: 'Получить объекты из хранилища',
      description: `Получает объекты из хранилища конфигурации в базу и импортирует изменившиеся объекты в файлы проекта. Получение возвращает захваченные вами объекты к версии хранилища: правки, загруженные в базу и не помещённые, будут потеряны — если в выборке есть захваченные вами объекты, нужен overwriteLocked: true. В ответе lockedOverwritten — захваченные вами объекты, которые получение реально перезаписало (по журналу платформы; пусто, если ничего не получено). При незагруженных правках проекта обязателен localChanges: loadAfter (загрузить правки после получения), keepProjectBehind (проект не обновлять) или abort. updateDatabase — обновлять ли конфигурацию БД на шаге загрузки правок (по умолчанию — настройка updateDatabaseAfterLoad); в ответе databaseConfigurationUpdated и databaseConfigurationBehind (конфигурация БД отстаёт от основной, например после получения версий). ${PATHS_DESCRIPTION}`,
      inputSchema: z.object({
        path: PATH_SCHEMA,
        paths: PATHS_SCHEMA,
        configuration: z.string().optional(),
        recursive: z.boolean().optional(),
        localChanges: z.enum(MCP_UPDATE_LOCAL_CHANGES).optional(),
        overwriteLocked: z.boolean().optional(),
        updateDatabase: UPDATE_DATABASE_SCHEMA,
      }),
      annotations: { destructiveHint: true },
    },
    // `-force` и версия не открыты: по Э24 различий у `-force` нет, а откат к версии — решение человека.
    (args, extra) => gate.wrapLongRunning('v8vscedit_repository_update', extra, () => withRepositoryErrors(async () => {
      const { refs, target, echo } = resolveConnectedSelection(args);
      const isRecursive = args.recursive ?? false;
      const result = await runWithConfigurationOperationLockOrThrow(async () => {
        const plan = resolveMcpUpdatePlan({
          dirtyFilesCount: await dirtyFilesCount(target),
          lockedInSelection: services.repositoryService.findLockedInSelectionForNodes(refs, isRecursive),
          overwriteLocked: args.overwriteLocked,
          localChanges: args.localChanges,
          updateDatabase: args.updateDatabase,
          updateDatabaseAfterLoad: readUpdateDatabaseAfterLoad(),
        });
        return runChain(
          () => runUpdateChain(services, target, refs, { recursive: isRecursive, force: false }, plan, 'unattended')
        );
      });
      return { ...echo, ...result };
    }))
  );

  server.registerTool(
    'v8vscedit_repository_commit',
    {
      title: 'Поместить объекты в хранилище',
      description: `Помещает изменения объектов в хранилище конфигурации через пакетный Конфигуратор. Операция необратима и требует confirm: true и непустого comment. Помещение без предварительной загрузки правок проекта запрещено: при незагруженных правках передайте localChanges: loadFirst. keepLocked оставляет объекты захваченными. force: платформа сама удалит из объекта ссылки на удалённые объекты (молчаливая правка объекта в базе и в хранилище), захват не обходит; после такой очистки проект импортируется заново. Не захваченные вами объекты платформа пропускает молча — они в ответе в notCommitted с предупреждением. updateDatabase — обновлять ли конфигурацию БД на шаге загрузки правок (по умолчанию — настройка updateDatabaseAfterLoad); в ответе databaseConfigurationUpdated и databaseConfigurationBehind (конфигурация БД отстаёт от основной, например после получения версий). ${PATHS_DESCRIPTION}`,
      inputSchema: z.object({
        path: PATH_SCHEMA,
        paths: PATHS_SCHEMA,
        configuration: z.string().optional(),
        recursive: z.boolean().optional(),
        comment: z.string(),
        keepLocked: z.boolean().optional(),
        force: z.boolean().optional(),
        localChanges: z.enum(MCP_COMMIT_LOCAL_CHANGES).optional(),
        confirm: z.boolean(),
        updateDatabase: UPDATE_DATABASE_SCHEMA,
      }),
      annotations: { destructiveHint: true },
    },
    (args, extra) => gate.wrapLongRunning('v8vscedit_repository_commit', extra, () => withRepositoryErrors(async () => {
      // Необратимость — первой: без согласия ни выборка, ни комментарий не важны.
      assertCommitArgs(args);
      const { refs, target, echo } = resolveConnectedSelection(args);
      const request = {
        recursive: args.recursive ?? false,
        comment: args.comment,
        keepLocked: args.keepLocked ?? false,
        force: args.force ?? false,
      };
      const result = await runWithConfigurationOperationLockOrThrow(async () => {
        const plan = resolveMcpCommitPlan({
          dirtyFilesCount: await dirtyFilesCount(target),
          localChanges: args.localChanges,
          updateDatabase: args.updateDatabase,
          updateDatabaseAfterLoad: readUpdateDatabaseAfterLoad(),
        });
        return runChain(() => runCommitChain(services, target, refs, request, plan, 'unattended'));
      });
      return { ...echo, ...result };
    }))
  );

  server.registerTool(
    'v8vscedit_repository_unlock',
    {
      title: 'Отменить захват объектов в хранилище',
      description: `Отменяет захват объектов в хранилище конфигурации. Успех определяется по журналу платформы: объект, захваченный другим пользователем, не освобождается. Список освобождается целиком или никак: изменённый в базе объект блокирует освобождение всех — тогда в ошибке названы изменённые объекты. Рекурсивно — со всеми подчинёнными объектами. Незагруженные правки проекта по освобождённым объектам после этого загрузить в базу будет нельзя. ${PATHS_DESCRIPTION}`,
      inputSchema: z.object({
        path: PATH_SCHEMA,
        paths: PATHS_SCHEMA,
        configuration: z.string().optional(),
        recursive: z.boolean().optional(),
      }),
      annotations: { destructiveHint: false },
    },
    // `force` не открыт: по Э24 он отменяет захват ценой правок объекта в базе.
    (args, extra) => gate.wrapLongRunning('v8vscedit_repository_unlock', extra, () => withRepositoryErrors(async () => {
      const { refs, target, echo } = resolveConnectedSelection(args);
      const request = { recursive: args.recursive ?? false, force: false };
      const result = await runWithConfigurationOperationLockOrThrow(async () => {
        const dirty = await dirtyFilesCount(target);
        return runChain(() => runUnlockChain(services, target, refs, request, dirty, 'unattended'));
      });
      if (result.unlockedObjects.length === 0 && result.notUnlocked.length > 0) {
        throw new Error(describeUnlockNotDone(result.notUnlocked, result.lockedByOthers));
      }
      return { ...echo, ...result };
    }, UNLOCK_FAILURE_HINT))
  );
}

async function buildStatus(
  services: McpCommandServices,
  path: string,
  ref: RepositoryNodeRef,
  target: RepositoryTarget,
  unloadedChangedFilesCount: number
): Promise<Record<string, unknown>> {
  const repository = services.repositoryService;
  const stored = await repository.loadBinding(target);
  const fullName = repository.resolveFullName(ref);
  // Для корня (fullName = null) захват и запрет правки считаются по захвату корня — как у создания объектов.
  const ownerXml = ref.metaContext?.ownerObjectXmlPath ?? (fullName ? ref.xmlPath : undefined);
  return {
    path,
    target: { displayName: target.displayName, kind: target.configKind, extensionName: target.extensionName },
    binding: stored ? { repoPath: stored.repoPath, repoUser: stored.repoUser } : null,
    passwordStored: await repository.hasStoredRepoPassword(target),
    connected: repository.hasBinding(target) && repository.isConnected(target),
    lockedObjects: repository.listLockedFullNames(target).map((name) => ({ name, label: formatRepositoryLockName(name) })),
    // Учёт захватов локальный: хранилище его не подтверждает, о чужих захватах он не знает.
    lockAccounting: 'local',
    unloadedChangedFilesCount,
    databaseConfigurationBehind: describeDatabaseLagOf(services, target),
    node: {
      fullName,
      locked: fullName ? repository.isLocked(target, fullName) : repository.isRootLocked(target),
      editRestricted: repository.isMetadataEditRestricted(target, ownerXml),
    },
  };
}

/** Признак «БД отстаёт» цели: `{ since, source }` или `null` (локальный учёт расширения, не знание о базе). */
function describeDatabaseLagOf(services: McpCommandServices, target: RepositoryTarget): { since: string; source: string } | null {
  const key = lagScopeKey(toDatabaseLagTarget(target));
  const entry = services.databaseConfigLag.list().find((item) => lagScopeKey(item) === key);
  return entry ? { since: entry.since, source: entry.source } : null;
}

/**
 * Идущая общая операция (замок + свежий этап ленты) и исход последней долгой операции MCP: по ним
 * агент узнаёт, чего ждать при «занято», и результат вызова, ответ на который потерян при обрыве.
 */
function describeOperationState(gate: McpMutationGate): Record<string, unknown> {
  const last = gate.lastOperation();
  return {
    ...describeRunningOperation({
      running: isConfigurationOperationRunning(),
      startedAt: getConfigurationOperationStartedAt(),
      stage: operationStageFeed.current(),
      now: Date.now(),
    }),
    lastOperation: last
      ? {
          tool: last.tool,
          startedAt: new Date(last.startedAt).toISOString(),
          finishedAt: new Date(last.finishedAt).toISOString(),
          isError: last.isError,
          summary: last.summary,
        }
      : null,
  };
}

/**
 * Ошибки операций хранилища — в текст для агента: прерывание — решение человека, а не отказ
 * платформы; к отказу платформы добавляется подсказка, что делать дальше (если она есть).
 */
async function withRepositoryErrors<T>(operation: () => Promise<T>, platformFailureHint?: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RepositoryCliInterruptedError) {
      throw new Error(INTERRUPTED_MESSAGE, { cause: error });
    }
    if (platformFailureHint && error instanceof RepositoryCliError && error.exitCode !== undefined) {
      throw new Error(`${error.message} ${platformFailureHint}`, { cause: error });
    }
    throw error;
  }
}
