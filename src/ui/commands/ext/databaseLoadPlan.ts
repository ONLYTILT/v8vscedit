import * as path from 'path';
import type {
  DatabaseConfigLagRecorder,
  DatabaseLagEntry,
  DatabaseLagSource,
  DatabaseLagTarget,
} from '../../../infra/database/DatabaseConfigLag';
import type { ChangedConfiguration } from '../../../infra/fs/ConfigurationChangeDetector';
import type { OperationInteraction } from './configurationOperationTypes';

/**
 * Чистые решения загрузки изменений в базу с обновлением конфигурации БД и без него. Без `vscode`: вектор
 * CLI и правила признака «БД отстаёт» проверяются unit-тестом, раннеры UI остаются тонкими адаптерами.
 */

export interface BatchLoadRequest {
  readonly projectRoot: string;
  readonly kind: 'cf' | 'cfe';
  readonly configDir: string;
  readonly extensionName: string | undefined;
  readonly connectionArgs: readonly string[];
  readonly updateDatabase: boolean;
}

export interface BatchLoadSteps {
  /** Частичная загрузка по хеш-кэшу (`/LoadConfigFromFiles -partial`). */
  readonly partial: string[];
  /** Применение (`/UpdateDBCfg`) — только при `updateDatabase`. */
  readonly update?: string[];
  /** Запасной путь при отказе частичной загрузки: полная загрузка (с применением или без). */
  readonly fallback: string[];
  readonly fallbackUpdatesDatabase: boolean;
}

/**
 * Векторы внутреннего CLI для пакетного режима. «Без обновления» — это пропуск шага `update-configuration`
 * и замена `sync-configuration-full` (загрузка + применение) на `import-configuration -Mode Full`
 * (`/LoadConfigFromFiles` без `/UpdateDBCfg`): нового вектора CLI не требуется.
 */
export function buildBatchLoadSteps(request: BatchLoadRequest): BatchLoadSteps {
  const extension = request.extensionName === undefined ? [] : ['-Extension', request.extensionName];
  const connection = [...request.connectionArgs];
  const head = (command: string): string[] =>
    [command, '-ProjectRoot', request.projectRoot, '-Target', request.kind, '-ConfigDir', request.configDir];
  const partial = [...head('import-git-changes'), ...extension, ...connection];
  if (request.updateDatabase) {
    return {
      partial,
      update: ['update-configuration', ...extension, ...connection],
      fallback: [...head('sync-configuration-full'), ...extension, ...connection],
      fallbackUpdatesDatabase: true,
    };
  }
  return {
    partial,
    fallback: [...head('import-configuration'), '-Mode', 'Full', ...extension, ...connection],
    fallbackUpdatesDatabase: false,
  };
}

export type DatabaseLagDecision = 'behind' | 'current' | 'unchanged';

/**
 * Единая таблица правил признака для агентской и пакетной ветки. `ambiguousFailure` — сбой после начала
 * загрузки, по которому нельзя сказать, изменена ли основная конфигурация: признак ставится консервативно
 * (атомарность частичной загрузки не замерена — лишнее напоминание безопаснее пропущенного).
 */
export function decideLagAfterLoad(input: {
  readonly loaded: boolean;
  readonly updateRequested: boolean;
  readonly updateSucceeded: boolean;
  readonly ambiguousFailure: boolean;
}): DatabaseLagDecision {
  if (input.loaded) {
    return input.updateRequested && input.updateSucceeded ? 'current' : 'behind';
  }
  return input.ambiguousFailure ? 'behind' : 'unchanged';
}

/** Фактический исход загрузки для вызывающего без UI (MCP): что сделано с конфигурацией БД и предупреждения E11. */
export interface DatabaseLoadOutcome {
  readonly databaseUpdated: boolean;
  readonly warnings: readonly string[];
}

/** Режим загрузки, общий для раннеров agent и batch: явный (команды узла) или по настройке. */
export interface DatabaseLoadOptions {
  readonly updateDatabase: boolean;
  readonly lag: DatabaseConfigLagRecorder;
  /** Без уведомлений об ошибке и предупреждений (MCP получает их в ответе). */
  readonly silent?: boolean;
  /** Исход успешной операции; при отказе не вызывается. */
  readonly onOutcome?: (outcome: DatabaseLoadOutcome) => void;
  /** По умолчанию interactive. unattended — без окон и тостов (подразумевает silent), вопрос = отказ. */
  readonly interaction?: OperationInteraction;
  /** Причина отказа (агент, CLI, отказ unattended); при успехе не вызывается. */
  readonly onFailure?: (reason: string) => void;
}

/** Без уведомлений: явный `silent` или вызов без участия человека. */
export function isSilentLoad(options: Pick<DatabaseLoadOptions, 'silent' | 'interaction'>): boolean {
  return options.silent === true || options.interaction === 'unattended';
}

/** Текст отказа от полной загрузки (запасной путь пакетного режима), когда подтвердить её некому. */
export function describeUnattendedFullLoadRefusal(targetLabel: string, failureReason: string): string {
  const reason = failureReason ? `: ${failureReason}` : '';
  return `Быстрая загрузка изменений ${targetLabel} не выполнена${reason}. Полная загрузка перезаписывает ` +
    'конфигурацию базы и без подтверждения человека не запускается: выполните «Обновить в базе» из интерфейса VS Code.';
}

/** Причина отставания по режиму: без обновления — намеренно, с обновлением — обновление не завершилось. */
export function lagSourceFor(updateDatabase: boolean): DatabaseLagSource {
  return updateDatabase ? 'update-failed' : 'load-without-update';
}

/** Применяет решение {@link decideLagAfterLoad} к признаку цели. */
export function settleDatabaseLag(
  lag: DatabaseConfigLagRecorder,
  target: DatabaseLagTarget,
  decision: DatabaseLagDecision,
  source: DatabaseLagSource
): void {
  if (decision === 'behind') {
    lag.markBehind(target, source);
  } else if (decision === 'current') {
    lag.markCurrent(target);
  }
}

/**
 * Признак после загрузки CF/CFE-файла: агент сам применяет НОВОЕ расширение (иначе в базе осталась бы
 * заглушка) — тогда БД актуальна; иначе `/LoadCfg` меняет только основную конфигурацию.
 */
export function settleCfFileLoadLag(lag: DatabaseConfigLagRecorder, target: DatabaseLagTarget, appliedToDatabase: boolean): void {
  if (appliedToDatabase) {
    lag.markCurrent(target);
  } else {
    lag.markBehind(target, 'cf-file-load');
  }
}

/** Отчёт пакетной загрузки расширений — в той части, что нужна признаку (структурно — `CfeBatchReport`). */
export interface CfeBatchLoadLagReport {
  readonly items: readonly { readonly status: string; readonly extensionName: string; readonly appliedToDatabase?: boolean }[];
  readonly failedAt?: { readonly extensionName: string };
}

/**
 * Признак по каждому расширению пакетной загрузки — общий для UI и MCP. Сбойное расширение отмечается
 * консервативно: его состояние в базе неопределённо (неудачная загрузка всё равно регистрирует расширение).
 */
export function settleCfeBatchLoadLag(
  lag: DatabaseConfigLagRecorder,
  report: CfeBatchLoadLagReport | undefined,
  targetOf: (extensionName: string) => DatabaseLagTarget
): void {
  for (const item of (report?.items ?? []).filter((entry) => entry.status === 'ok')) {
    settleCfFileLoadLag(lag, targetOf(item.extensionName), item.appliedToDatabase === true);
  }
  if (report?.failedAt) {
    lag.markBehind(targetOf(report.failedAt.extensionName), 'cf-file-load');
  }
}

export type UpdateTargetAction = 'load' | 'load-and-update' | 'update-only';

export interface UpdateTargetItem {
  readonly target: DatabaseLagTarget;
  readonly action: UpdateTargetAction;
  /** Число изменённых файлов (для окна выбора); у `update-only` его нет. */
  readonly changedFilesCount?: number;
}

function rootKey(rootPath: string): string {
  return path.resolve(rootPath).replace(/\\/g, '/').toLowerCase();
}

/**
 * Цели «Обновить изменённые конфигурации»: изменённые загружаются (с обновлением или без), а отстающие без
 * изменений при `updateDatabase` получают только UpdateDBCfg — иначе команда сказала бы «изменений нет», а
 * отставание осталось бы. Порядок — cf первой (расширения применяются поверх основной), затем по имени.
 */
export function planUpdateTargets(
  changed: readonly ChangedConfiguration[],
  behind: readonly DatabaseLagEntry[],
  updateDatabase: boolean
): UpdateTargetItem[] {
  const items: UpdateTargetItem[] = [];
  const seen = new Set<string>();
  for (const item of changed) {
    seen.add(rootKey(item.rootPath));
    items.push({
      target: {
        kind: item.kind,
        name: item.name,
        rootPath: item.rootPath,
        ...(item.kind === 'cfe' ? { extensionName: item.name } : {}),
      },
      action: updateDatabase ? 'load-and-update' : 'load',
      changedFilesCount: item.changedFilesCount,
    });
  }
  if (updateDatabase) {
    for (const entry of behind) {
      if (seen.has(rootKey(entry.rootPath))) {
        continue;
      }
      seen.add(rootKey(entry.rootPath));
      items.push({
        target: {
          kind: entry.kind,
          name: entry.name,
          rootPath: entry.rootPath,
          ...(entry.extensionName !== undefined ? { extensionName: entry.extensionName } : {}),
        },
        action: 'update-only',
      });
    }
  }
  return items.sort((left, right) => {
    if (left.target.kind !== right.target.kind) {
      return left.target.kind === 'cf' ? -1 : 1;
    }
    return left.target.name.localeCompare(right.target.name);
  });
}

export type ThinClientLaunchId = 'update' | 'update-database' | 'run';

export interface ThinClientLaunchItem {
  readonly id: ThinClientLaunchId;
  readonly label: string;
  readonly description: string;
  readonly detail?: string;
}

/**
 * Вопрос перед запуском тонкого клиента: Предприятию нужна КОНФИГУРАЦИЯ БД, поэтому загрузка перед запуском —
 * всегда с обновлением. Загрузка с обновлением покрывает и отстающие цели, поэтому при изменениях пункт один.
 */
export function planThinClientLaunch(input: { readonly changedCount: number; readonly behindCount: number }): ThinClientLaunchItem[] {
  const run: ThinClientLaunchItem = {
    id: 'run',
    label: '$(play) Запустить без обновления',
    description: 'Оставить изменения только в файлах',
  };
  if (input.changedCount > 0) {
    return [
      {
        id: 'update',
        label: '$(sync) Обновить и запустить',
        description: 'Загрузить изменения в базу перед запуском',
        detail: `Изменено конфигураций: ${String(input.changedCount)}`,
      },
      run,
    ];
  }
  if (input.behindCount > 0) {
    return [
      {
        id: 'update-database',
        label: '$(database) Обновить конфигурацию БД и запустить',
        description: 'Применить загруженные изменения к конфигурации базы данных',
        detail: `Не обновлено конфигураций: ${String(input.behindCount)}`,
      },
      run,
    ];
  }
  return [];
}

export function describeLoadWithoutUpdateSuccess(name: string): string {
  return `Изменения "${name}" загружены в основную конфигурацию. Конфигурация БД не обновлена — ` +
    'выполните «Обновить конфигурацию БД» перед запуском Предприятия.';
}
