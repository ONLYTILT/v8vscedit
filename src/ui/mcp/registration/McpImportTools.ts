/**
 * MCP-инструмент импорта конфигураций из базы в файлы проекта: `v8vscedit_import_configurations`, и общая
 * точка для моста `execute_command importConfigurations`. Бизнес-логика — общий раннер импорта
 * (`ui/commands/ext/importConfigurationsRunner.ts`, тот же код, что у команды UI), режим — unattended: ни
 * окон, ни тостов, вопрос, требующий человека, — отказ цели с инструкцией.
 *
 * `gate.afterMutation` НЕ вызывается сознательно (как у repository_* и load_cf): импорт делает файлы
 * проекта РАВНЫМИ базе, а пометка «изменено» заставила бы «Обновить БД» залить их обратно. Раннер сам
 * гасит перезагрузку по файлам, помечает корни чистыми и перезагружает дерево.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { META_TYPES } from '../../../domain/MetaTypes';
import type { DatabaseLagTarget } from '../../../infra/database/DatabaseConfigLag';
import { runWithConfigurationOperationLockOrThrow } from '../../commands/ext/configurationOperationLock';
import { runImportTargets } from '../../commands/ext/importConfigurationsRunner';
import {
  NO_IMPORT_TARGETS,
  collectImportTargets,
  selectImportTargetsByRoots,
  type ImportTarget,
  type ImportTargetResult,
} from '../../commands/ext/importTargets';
import { resolveConfigurationRootDirByCanonical } from '../McpPathResolvers';
import { definedFields, mergeWarnings } from './McpResponseFields';
import type { McpRegistrationDeps } from './McpRegistrationDeps';

/** `targets` без умолчания: что перезаписать в проекте — решение вызывающего агента. */
export const MCP_IMPORT_TARGETS_SCHEMA = z.union([
  z.literal('all'),
  z.array(z.object({ path: z.string(), configuration: z.string().optional() })).min(1),
]);
export type McpImportTargetsArg = z.infer<typeof MCP_IMPORT_TARGETS_SCHEMA>;

export interface McpImportResponse {
  readonly requested: McpImportTargetsArg;
  readonly completed: boolean;
  readonly imported: number;
  readonly failed: number;
  readonly skipped: number;
  readonly targets: readonly Record<string, unknown>[];
  readonly warnings?: readonly string[];
}

const DESCRIPTION = 'Импортирует основную конфигурацию и/или расширения из базы в файлы выгрузки проекта (тот же код, что ' +
  'команда «Импортировать конфигурации из базы»), без окна выбора. targets обязателен: "all" — все подключённые (src/cf ' +
  'и src/cfe/*; так же выполняется первичный импорт пустого src/cf) или список корней [{ path: "Конфигурация" | ' +
  '"Расширение", configuration? }] — канон корня, как у v8vscedit_load_configuration_changes. Порядок: основная ' +
  'конфигурация, затем расширения по алфавиту; на первой неудаче импорт останавливается (status: imported | failed | ' +
  'skipped). Вызов без участия человека: если нужна полная выгрузка на сервере (пустое зеркало агента и т.п.) или ' +
  'агент конфигуратора задал вопрос, цель получает failed с requiresUserAction: true и инструкцией выполнить импорт ' +
  'из интерфейса VS Code; посев зеркала из выгрузки проекта и удаление осиротевших файлов не выполняются. Проверяйте ' +
  'completed и failed. databaseConfigurationBehind — признак «конфигурация БД не обновлена» по цели.';

export function registerImportTools(server: McpServer, deps: McpRegistrationDeps): void {
  server.registerTool(
    'v8vscedit_import_configurations',
    {
      title: 'Импортировать конфигурации из базы',
      description: DESCRIPTION,
      inputSchema: z.object({ targets: MCP_IMPORT_TARGETS_SCHEMA }),
      annotations: {
        // Перезаписывает файлы выгрузки проекта содержимым базы.
        destructiveHint: true,
      },
    },
    ({ targets }, extra) => deps.gate.wrapLongRunning(
      'v8vscedit_import_configurations',
      extra,
      () => runMcpImportConfigurations(deps, targets)
    )
  );
}

/**
 * Общая точка инструмента и моста `execute_command`: проверки без побочных эффектов → замок (бросающий:
 * занято — отказ, а не ожидание) → общий раннер. Исключение — только при отказе до запуска; частичный
 * отказ — структурный ответ со статусами целей.
 */
export async function runMcpImportConfigurations(
  deps: McpRegistrationDeps,
  targets: McpImportTargetsArg
): Promise<McpImportResponse> {
  const { services } = deps;
  const available = collectImportTargets(services.treeProvider.getEntries(), services.workspaceFolder.uri.fsPath);
  if (available.length === 0) {
    throw new Error(NO_IMPORT_TARGETS);
  }
  const selected = targets === 'all'
    ? available
    : selectImportTargetsByRoots(available, targets.map((item) => ({
        label: item.configuration === undefined ? item.path : `${item.path} (${item.configuration})`,
        rootDir: resolveConfigurationRootDirByCanonical(deps.paths, item.path, item.configuration),
      })));
  const run = await runWithConfigurationOperationLockOrThrow(() => runImportTargets(services, selected, 'unattended'));
  if (run.error !== undefined) {
    throw new Error(run.error);
  }
  const count = (status: ImportTargetResult['status']): number => run.results.filter((item) => item.status === status).length;
  const failed = count('failed');
  const skipped = count('skipped');
  return {
    requested: targets,
    completed: failed === 0 && skipped === 0,
    imported: count('imported'),
    failed,
    skipped,
    targets: run.results.map((result) => describeTargetResult(result, services.databaseConfigLag.isBehind(toLagTarget(result)))),
    ...definedFields({ warnings: mergeWarnings(run.warnings) }),
  };
}

/** Ключ признака — тот же, что у раннеров загрузки: у расширения имя цели и есть имя расширения. */
function toLagTarget(target: ImportTarget): DatabaseLagTarget {
  return target.kind === 'cfe'
    ? { kind: 'cfe', name: target.name, rootPath: target.rootPath, extensionName: target.name }
    : { kind: 'cf', name: target.name, rootPath: target.rootPath };
}

function describeTargetResult(result: ImportTargetResult, behind: boolean): Record<string, unknown> {
  return definedFields({
    // Канон корня и имя конфигурации — те же, что принимает инструмент и отдаёт workspace_overview.
    path: META_TYPES[result.kind === 'cf' ? 'configuration' : 'extension'].pathSegment,
    configuration: result.name,
    kind: result.kind,
    name: result.name,
    status: result.status,
    reason: result.reason,
    requiresUserAction: result.requiresUserAction,
    warnings: mergeWarnings(result.warnings),
    databaseConfigurationBehind: behind,
  });
}
