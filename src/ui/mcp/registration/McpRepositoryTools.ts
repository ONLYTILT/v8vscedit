/**
 * MCP-инструменты хранилища конфигурации: состояние, захват, получение, помещение, отмена захвата.
 *
 * Бизнес-логика — общие с UI-командами цепочки (`commands/repository/repositoryChains`) и
 * планировщики `planRepository*` (через `McpRepositoryDecisions`): вопрос диалога UI здесь — явный
 * параметр агента. Порядок каждого инструмента: проверка аргументов без побочных эффектов → узел и
 * подключённая цель → бросающий замок → ПОД ЗАМКОМ число незагруженных файлов и захваты выборки →
 * план → цепочка. Пароль хранилища агент не передаёт: он берётся из SecretStorage тем же
 * `resolveBindingForCommand`, что у UI.
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
import { resolveConnectedTarget } from '../../commands/repository/repositoryNodeTargets';
import { lagScopeKey } from '../../../infra/database/DatabaseConfigLag';
import { findChangedConfiguration, refreshRepositoryUi, toDatabaseLagTarget } from '../../commands/repository/repositoryPostSync';
import {
  MCP_COMMIT_LOCAL_CHANGES,
  MCP_LOCK_LOCAL_CHANGES,
  MCP_UPDATE_LOCAL_CHANGES,
  assertCommitArgs,
  assertRootRecursiveLockConfirmed,
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

const UNLOCK_FAILURE_HINT =
  'Если объект изменён в базе, отменить захват без потери правок нельзя: поместите изменения (v8vscedit_repository_commit).';

interface ResolvedRepositoryNode {
  readonly ref: RepositoryNodeRef;
  readonly target: RepositoryTarget;
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

  const resolveConnected = (path: string, configuration: string | undefined): ResolvedRepositoryNode => {
    const ref = toRepositoryNodeRef(deps.paths.resolveNode(path, configuration));
    const resolution = resolveConnectedTarget(services.repositoryService, ref);
    switch (resolution.kind) {
      case 'ok':
        return { ref, target: resolution.target };
      case 'not-connected':
        throw new Error(`${resolution.message} (состояние — v8vscedit_repository_status)`);
      case 'no-xml':
      case 'no-target':
        throw new Error(`Не удалось определить конфигурацию для узла "${path}".`);
    }
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
      description: 'Захватывает объект в хранилище конфигурации для редактирования через пакетный Конфигуратор; после захвата, если из хранилища получены новые версии, импортирует их в файлы проекта. Рекурсивный захват корня требует confirm: true. При незагруженных правках проекта обязателен localChanges: loadFirst (загрузить правки в базу перед захватом), keepProjectBehind (захватить, проект не обновлять) или abort. updateDatabase — обновлять ли конфигурацию БД на шаге загрузки правок (по умолчанию — настройка updateDatabaseAfterLoad); в ответе databaseConfigurationUpdated и databaseConfigurationBehind (конфигурация БД отстаёт от основной, например после получения версий). Принимает канонический путь объекта или корня; дочерний элемент захватывает владельца.',
      inputSchema: z.object({
        path: z.string(),
        configuration: z.string().optional(),
        recursive: z.boolean().optional(),
        localChanges: z.enum(MCP_LOCK_LOCAL_CHANGES).optional(),
        confirm: z.boolean().optional(),
        updateDatabase: UPDATE_DATABASE_SCHEMA,
      }),
      annotations: { destructiveHint: false },
    },
    ({ path, configuration, recursive, localChanges, confirm, updateDatabase }, extra) => gate.wrapLongRunning('v8vscedit_repository_lock', extra, () => withRepositoryErrors(async () => {
      const { ref, target } = resolveConnected(path, configuration);
      const isRecursive = recursive ?? false;
      assertRootRecursiveLockConfirmed({ nodeKind: ref.nodeKind, recursive: isRecursive, confirm });
      const result = await runWithConfigurationOperationLockOrThrow(async () => {
        const plan = resolveMcpLockPlan({
          revisedSetting: readRevisedOnLockSetting(),
          dirtyFilesCount: await dirtyFilesCount(target),
          localChanges,
          updateDatabase,
          updateDatabaseAfterLoad: readUpdateDatabaseAfterLoad(),
        });
        return runChain(() => runLockChain(services, target, ref, isRecursive, plan, 'unattended'));
      });
      return { path, ...result };
    }))
  );

  server.registerTool(
    'v8vscedit_repository_update',
    {
      title: 'Получить объекты из хранилища',
      description: 'Получает объект из хранилища конфигурации в базу и импортирует изменившиеся объекты в файлы проекта. Получение возвращает захваченные вами объекты к версии хранилища: правки, загруженные в базу и не помещённые, будут потеряны — для таких объектов нужен overwriteLocked: true. При незагруженных правках проекта обязателен localChanges: loadAfter (загрузить правки после получения), keepProjectBehind (проект не обновлять) или abort. updateDatabase — обновлять ли конфигурацию БД на шаге загрузки правок (по умолчанию — настройка updateDatabaseAfterLoad); в ответе databaseConfigurationUpdated и databaseConfigurationBehind (конфигурация БД отстаёт от основной, например после получения версий). Принимает канонический путь объекта или корня.',
      inputSchema: z.object({
        path: z.string(),
        configuration: z.string().optional(),
        recursive: z.boolean().optional(),
        localChanges: z.enum(MCP_UPDATE_LOCAL_CHANGES).optional(),
        overwriteLocked: z.boolean().optional(),
        updateDatabase: UPDATE_DATABASE_SCHEMA,
      }),
      annotations: { destructiveHint: true },
    },
    // `-force` и версия не открыты: по Э24 различий у `-force` нет, а откат к версии — решение человека.
    ({ path, configuration, recursive, localChanges, overwriteLocked, updateDatabase }, extra) => gate.wrapLongRunning('v8vscedit_repository_update', extra, () => withRepositoryErrors(async () => {
      const { ref, target } = resolveConnected(path, configuration);
      const isRecursive = recursive ?? false;
      const result = await runWithConfigurationOperationLockOrThrow(async () => {
        const lockedInSelection = services.repositoryService.findLockedInSelection(ref, isRecursive);
        const plan = resolveMcpUpdatePlan({
          dirtyFilesCount: await dirtyFilesCount(target),
          lockedInSelection,
          overwriteLocked,
          localChanges,
          updateDatabase,
          updateDatabaseAfterLoad: readUpdateDatabaseAfterLoad(),
        });
        const chain = await runChain(
          () => runUpdateChain(services, target, ref, { recursive: isRecursive, force: false }, plan, 'unattended')
        );
        return { ...chain, lockedOverwritten: lockedInSelection };
      });
      return { path, ...result };
    }))
  );

  server.registerTool(
    'v8vscedit_repository_commit',
    {
      title: 'Поместить объекты в хранилище',
      description: 'Помещает изменения объекта в хранилище конфигурации через пакетный Конфигуратор. Операция необратима и требует confirm: true и непустого comment. Помещение без предварительной загрузки правок проекта запрещено: при незагруженных правках передайте localChanges: loadFirst. keepLocked оставляет объект захваченным. force: платформа сама удалит из объекта ссылки на удалённые объекты (молчаливая правка объекта в базе и в хранилище), захват не обходит; после такой очистки проект импортируется заново. updateDatabase — обновлять ли конфигурацию БД на шаге загрузки правок (по умолчанию — настройка updateDatabaseAfterLoad); в ответе databaseConfigurationUpdated и databaseConfigurationBehind (конфигурация БД отстаёт от основной, например после получения версий). Принимает канонический путь объекта или корня.',
      inputSchema: z.object({
        path: z.string(),
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
      assertCommitArgs(args);
      const { ref, target } = resolveConnected(args.path, args.configuration);
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
        return runChain(() => runCommitChain(services, target, ref, request, plan, 'unattended'));
      });
      return { path: args.path, ...result };
    }))
  );

  server.registerTool(
    'v8vscedit_repository_unlock',
    {
      title: 'Отменить захват объектов в хранилище',
      description: 'Отменяет захват объекта в хранилище конфигурации. Успех определяется по журналу платформы: объект, захваченный другим пользователем, не освобождается. Принимает канонический путь объекта или корня; рекурсивно — со всеми подчинёнными объектами. Незагруженные правки проекта по освобождённым объектам после этого загрузить в базу будет нельзя.',
      inputSchema: z.object({
        path: z.string(),
        configuration: z.string().optional(),
        recursive: z.boolean().optional(),
      }),
      annotations: { destructiveHint: false },
    },
    // `force` не открыт: по Э24 он отменяет захват ценой правок объекта в базе.
    ({ path, configuration, recursive }, extra) => gate.wrapLongRunning('v8vscedit_repository_unlock', extra, () => withRepositoryErrors(async () => {
      const { ref, target } = resolveConnected(path, configuration);
      const request = { recursive: recursive ?? false, force: false };
      const result = await runWithConfigurationOperationLockOrThrow(async () => {
        const dirty = await dirtyFilesCount(target);
        return runChain(() => runUnlockChain(services, target, ref, request, dirty, 'unattended'));
      });
      if (result.unlockedObjects.length === 0 && result.notUnlocked.length > 0) {
        throw new Error(describeUnlockNotDone(result.notUnlocked, result.lockedByOthers));
      }
      return { path, ...result };
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
