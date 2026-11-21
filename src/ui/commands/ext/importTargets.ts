import * as fs from 'fs';
import * as path from 'path';
import type { ConfigEntry } from '../../../domain/Configuration';
import { parseConfigXml } from '../../../infra/xml';
import type { ConfigurationImportOutcome } from './configurationOperationTypes';

/**
 * Чистые решения импорта конфигураций из базы, общие для команды UI, MCP-инструмента и моста
 * `execute_command`: какие цели есть, какие выбраны аргументом, в каком порядке идут и чем закончились.
 * Без `vscode`: окно выбора и сам импорт — в адаптерах (`ImportConfigurationsCommands`,
 * `importConfigurationsRunner`).
 */

export interface ImportTarget {
  readonly kind: 'cf' | 'cfe';
  readonly name: string;
  readonly rootPath: string;
}

export const IMPORT_ARGS_INVALID =
  "Аргумент команды v8vscedit.importConfigurations: targets должен быть 'all' или непустым списком имён конфигураций.";

export const NO_IMPORT_TARGETS = 'Нет каталога src/cf для импорта основной конфигурации.';

const MAIN_CONFIGURATION_NAME = 'Основная конфигурация';

function rootKey(rootPath: string): string {
  return path.resolve(rootPath).replace(/\\/g, '/').toLowerCase();
}

/** Цели из записей дерева плюс первичный импорт пустого `src/cf`; порядок — как у запуска. */
export function collectImportTargets(entries: readonly ConfigEntry[], workspaceRoot: string): ImportTarget[] {
  const targets: ImportTarget[] = entries.map((entry) => ({
    kind: entry.kind,
    name: readConfigName(entry),
    rootPath: entry.rootPath,
  }));
  appendInitialMainConfigurationTarget(targets, workspaceRoot);
  return orderImportTargets(targets);
}

/**
 * Основная конфигурация первой (расширения применяются поверх неё), затем расширения по имени. Повтор
 * корня (в т.ч. в другом регистре пути) импортировался бы дважды подряд — оставляется первое вхождение.
 */
export function orderImportTargets(targets: readonly ImportTarget[]): ImportTarget[] {
  const seen = new Set<string>();
  const unique = targets.filter((target) => {
    const key = rootKey(target.rootPath);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return unique.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'cf' ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

export function isDirectory(directoryPath: string): boolean {
  try {
    return fs.statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

function appendInitialMainConfigurationTarget(targets: ImportTarget[], workspaceRoot: string): void {
  const mainConfigRoot = path.join(workspaceRoot, 'src', 'cf');
  if (!isDirectory(mainConfigRoot)) {
    return;
  }
  const key = rootKey(mainConfigRoot);
  if (targets.some((target) => target.kind === 'cf' && rootKey(target.rootPath) === key)) {
    return;
  }
  targets.push({ kind: 'cf', name: MAIN_CONFIGURATION_NAME, rootPath: mainConfigRoot });
}

function readConfigName(entry: ConfigEntry): string {
  try {
    const info = parseConfigXml(path.join(entry.rootPath, 'Configuration.xml'));
    if (info.name) {
      return info.name;
    }
  } catch {
    // При повреждённом XML оставляем имя каталога как диагностически полезное имя в списке выбора.
  }
  return path.basename(entry.rootPath);
}

export type ImportTargetsRequest =
  | { readonly kind: 'all' }
  | { readonly kind: 'names'; readonly names: readonly string[] };

/**
 * Аргумент команды `{ targets }`. Без собственного свойства `targets` аргумент посторонний — его передают
 * сам VS Code (Uri) или webview (узел дерева) — и остаётся прежнее окно выбора. Свойство неверной формы —
 * исключение: молча импортировать «что-то» по опечатке нельзя.
 */
export function parseImportConfigurationsArgs(arg: unknown): ImportTargetsRequest | undefined {
  if (typeof arg !== 'object' || arg === null || Array.isArray(arg) || !Object.prototype.hasOwnProperty.call(arg, 'targets')) {
    return undefined;
  }
  const targets = (arg as { readonly targets: unknown }).targets;
  if (targets === 'all') {
    return { kind: 'all' };
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error(IMPORT_ARGS_INVALID);
  }
  const names = targets.map((item) => (typeof item === 'string' ? item.trim() : ''));
  if (names.some((name) => name === '')) {
    throw new Error(IMPORT_ARGS_INVALID);
  }
  return { kind: 'names', names };
}

export function describeUnknownImportTargets(unknown: readonly string[], available: readonly ImportTarget[]): string {
  return `Неизвестные цели импорта: ${unknown.map((name) => `«${name}»`).join(', ')}. ` +
    `Доступны: ${available.map((target) => target.name).join(', ')}.`;
}

/** Имена — без учёта регистра и крайних пробелов; все неизвестные перечисляются в одном исключении. */
export function selectImportTargets(available: readonly ImportTarget[], request: ImportTargetsRequest): ImportTarget[] {
  if (request.kind === 'all') {
    return [...available];
  }
  const selected: ImportTarget[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const name of request.names) {
    const key = name.trim().toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const matches = available.filter((target) => target.name.trim().toLowerCase() === key);
    if (matches.length === 0) {
      unknown.push(name.trim());
    } else if (matches.length > 1) {
      // Одно имя у основной конфигурации и расширения: выбрать за человека значило бы угадать.
      throw new Error(`Имя «${name.trim()}» неоднозначно: ${matches.map(describeTargetKind).join(', ')}; ` +
        'выберите цель в окне импорта.');
    } else {
      selected.push(matches[0]);
    }
  }
  if (unknown.length > 0) {
    throw new Error(describeUnknownImportTargets(unknown, available));
  }
  return selected;
}

function describeTargetKind(target: ImportTarget): string {
  return `${target.kind === 'cf' ? 'основная конфигурация' : 'расширение'} (${target.rootPath})`;
}

/** Корни, разрешённые из канона MCP (каталог `Configuration.xml`), → цели; корень вне списка — исключение. */
export function selectImportTargetsByRoots(
  available: readonly ImportTarget[],
  roots: readonly { readonly label: string; readonly rootDir: string }[]
): ImportTarget[] {
  const selected: ImportTarget[] = [];
  for (const root of roots) {
    const key = rootKey(root.rootDir);
    const target = available.find((item) => rootKey(item.rootPath) === key);
    if (!target) {
      throw new Error(`Цель «${root.label}» не входит в подключённые конфигурации для импорта (${root.rootDir}).`);
    }
    if (!selected.includes(target)) {
      selected.push(target);
    }
  }
  return selected;
}

export type ImportTargetStatus = 'imported' | 'failed' | 'skipped';

export interface ImportTargetResult extends ImportTarget {
  readonly status: ImportTargetStatus;
  readonly reason?: string;
  readonly requiresUserAction?: boolean;
  readonly warnings: readonly string[];
}

/**
 * Сводка прогона: `outcomes` — исходы выполненных целей в порядке `ordered`. Невыполненные получают
 * `skipped` с причиной — иначе вызывающий агент принял бы невыполненную цель за выполненную.
 */
export function summarizeImportRun(
  ordered: readonly ImportTarget[],
  outcomes: readonly ConfigurationImportOutcome[]
): ImportTargetResult[] {
  const failedIndex = outcomes.findIndex((outcome) => !outcome.success);
  const skippedReason = failedIndex >= 0
    ? `Не выполнялся: импорт остановлен на «${ordered[failedIndex].name}».`
    : 'Не выполнялся: импорт прерван до запуска цели.';
  return ordered.map((target, index): ImportTargetResult => {
    const outcome = outcomes[index] as ConfigurationImportOutcome | undefined;
    if (!outcome) {
      return { ...target, status: 'skipped', reason: skippedReason, warnings: [] };
    }
    if (outcome.success) {
      return { ...target, status: 'imported', warnings: [...outcome.warnings] };
    }
    return {
      ...target,
      status: 'failed',
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.requiresUserAction ? { requiresUserAction: true } : {}),
      warnings: [...outcome.warnings],
    };
  });
}
