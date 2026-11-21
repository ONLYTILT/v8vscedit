import * as fs from 'fs';
import * as path from 'path';
import { buildScopeKey } from '../cache/HashCache';
import { writeFileAtomic } from '../fs/AtomicFileWriter';
import type { Logger } from '../support/Logger';

/**
 * Признак «конфигурация БД отстаёт от основной» — локальный учёт расширения.
 *
 * Семантика честная и узкая: «расширение изменило ОСНОВНУЮ конфигурацию цели и не подтвердило
 * последующее UpdateDBCfg». Это не знание о базе: обновление БД в Конфигураторе или другим
 * пользователем расширение не видит (замер Э32: `config generation-id` агента несимметричен для
 * основной конфигурации и расширений, поэтому для признака не используется).
 *
 * Файл живёт в `.v8vscedit/` (как `.v8vscedit/repository/state.json`), а не в `workspaceState`:
 * слой infra остаётся без `vscode`, а CLI в будущем сможет писать тот же файл.
 */

export type DatabaseLagSource = 'load-without-update' | 'update-failed' | 'cf-file-load' | 'repository-receive';

export interface DatabaseLagTarget {
  readonly kind: 'cf' | 'cfe';
  readonly name: string;
  /** Абсолютный каталог выгрузки цели (в файле хранится относительно корня проекта). */
  readonly rootPath: string;
  readonly extensionName?: string;
}

export interface DatabaseLagEntry extends DatabaseLagTarget {
  readonly since: string;
  readonly source: DatabaseLagSource;
}

/** То, что получают раннеры и цепочки: ставить, снимать и читать признак. */
export interface DatabaseConfigLagRecorder {
  markBehind(target: DatabaseLagTarget, source: DatabaseLagSource): void;
  markCurrent(target: DatabaseLagTarget): void;
  isBehind(target: DatabaseLagTarget): boolean;
  list(): readonly DatabaseLagEntry[];
}

export interface DatabaseLagDisposable {
  dispose(): void;
}

const LAG_FILE_VERSION = 1;
const LAG_SOURCES: readonly DatabaseLagSource[] = ['load-without-update', 'update-failed', 'cf-file-load', 'repository-receive'];

/**
 * Ключ цели — тот же, что у хеш-кэша: второго нормализатора путей не заводим. Для расширения без явного
 * `extensionName` имя расширения — имя цели: вызывающие (раннер, хранилище, CF-файл) передают одну и ту же
 * цель по-разному, а ключ обязан совпасть, иначе `markCurrent` не снимет отметку `markBehind`.
 */
export function lagScopeKey(target: DatabaseLagTarget): string {
  return buildScopeKey(target.kind, target.rootPath, target.kind === 'cfe' ? target.extensionName ?? target.name : '');
}

/** Корень конфигурации проекта — в той части, что нужна чистке признака (структурно — `ConfigEntry`). */
export interface DatabaseLagRoot {
  readonly kind: 'cf' | 'cfe';
  readonly rootPath: string;
}

function rootIdentity(kind: 'cf' | 'cfe', rootPath: string): string {
  return `${kind}:${path.resolve(rootPath).replace(/\\/g, '/').toLowerCase()}`;
}

interface StoredEntry {
  kind: 'cf' | 'cfe';
  name: string;
  rootPath: string;
  extensionName?: string;
  since: string;
  source: DatabaseLagSource;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStoredEntry(value: unknown): StoredEntry | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const { kind, name, rootPath, extensionName, since, source } = value;
  if ((kind !== 'cf' && kind !== 'cfe') || typeof name !== 'string' || typeof rootPath !== 'string'
    || typeof since !== 'string' || !LAG_SOURCES.includes(source as DatabaseLagSource)) {
    return undefined;
  }
  return {
    kind,
    name,
    rootPath,
    ...(typeof extensionName === 'string' ? { extensionName } : {}),
    since,
    source: source as DatabaseLagSource,
  };
}

/**
 * Хранилище признака: файл `.v8vscedit/database-config/lag.json`, читается один раз при создании
 * (маленький файл, не hot path), пишется только через `writeFileAtomic`.
 */
export class DatabaseConfigLagStore implements DatabaseConfigLagRecorder {
  private readonly filePath: string;
  private readonly entries = new Map<string, DatabaseLagEntry>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly projectRoot: string, private readonly logger: Logger) {
    this.filePath = path.join(projectRoot, '.v8vscedit', 'database-config', 'lag.json');
    this.load();
  }

  markBehind(target: DatabaseLagTarget, source: DatabaseLagSource): void {
    const key = lagScopeKey(target);
    const previous = this.entries.get(key);
    if (previous?.source === source) {
      return;
    }
    // Первоначальный момент отставания важнее последней причины: пользователь видит, с какого
    // времени БД не обновлялась, даже если поверх легли новые загрузки.
    this.entries.set(key, {
      kind: target.kind,
      name: target.name,
      rootPath: path.resolve(target.rootPath),
      ...(target.kind === 'cfe' ? { extensionName: target.extensionName ?? target.name } : {}),
      since: previous?.since ?? new Date().toISOString(),
      source,
    });
    this.commit();
  }

  markCurrent(target: DatabaseLagTarget): void {
    if (this.entries.delete(lagScopeKey(target))) {
      this.commit();
    }
  }

  isBehind(target: DatabaseLagTarget): boolean {
    return this.entries.has(lagScopeKey(target));
  }

  list(): readonly DatabaseLagEntry[] {
    return [...this.entries.values()];
  }

  /** Убирает цели, которых больше нет среди конфигураций проекта (удалённое расширение). */
  retainOnly(scopeKeys: Iterable<string>): void {
    const keep = new Set(scopeKeys);
    let changed = false;
    for (const key of [...this.entries.keys()]) {
      if (!keep.has(key)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.commit();
    }
  }

  /**
   * Чистка после перечитывания конфигураций проекта: отметка цели, корня которой больше нет, снимается
   * (удалённое расширение не висит в индикаторе вечно). Отметки `cf-file-load` не снимаются никогда: CF/CFE-файл
   * грузят и в расширение, которого нет в проекте, а цель CF строится по раскладке `src/cf`, которая может не
   * совпадать с реальным корнем, — отставание базы от этого не исчезает. Снять их — «Отметить как обновлённую».
   */
  pruneMissingRoots(roots: Iterable<DatabaseLagRoot>): void {
    const present = new Set([...roots].map((root) => rootIdentity(root.kind, root.rootPath)));
    this.retainOnly(this.list()
      .filter((entry) => entry.source === 'cf-file-load' || present.has(rootIdentity(entry.kind, entry.rootPath)))
      .map(lagScopeKey));
  }

  onDidChange(listener: () => void): DatabaseLagDisposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
    } catch {
      this.logger.appendLine(`[database-lag] Файл ${this.filePath} (lag.json) повреждён (не JSON). Признак отставания БД сброшен.`);
      return;
    }
    if (!isObject(parsed) || parsed.version !== LAG_FILE_VERSION || !isObject(parsed.targets)) {
      this.logger.appendLine(`[database-lag] Файл ${this.filePath} (lag.json) имеет неизвестный формат. Признак отставания БД сброшен.`);
      return;
    }
    for (const value of Object.values(parsed.targets)) {
      const stored = parseStoredEntry(value);
      if (!stored) {
        continue;
      }
      const entry: DatabaseLagEntry = { ...stored, rootPath: path.resolve(this.projectRoot, stored.rootPath) };
      // Ключ пересчитывается из содержимого, а не берётся из файла: ручная правка ключа не должна
      // давать запись, которую ни одна цель не найдёт.
      this.entries.set(lagScopeKey(entry), entry);
    }
  }

  private commit(): void {
    const targets: Record<string, StoredEntry> = {};
    for (const [key, entry] of this.entries) {
      targets[key] = {
        kind: entry.kind,
        name: entry.name,
        rootPath: path.relative(this.projectRoot, entry.rootPath).replace(/\\/g, '/'),
        ...(entry.extensionName !== undefined ? { extensionName: entry.extensionName } : {}),
        since: entry.since,
        source: entry.source,
      };
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileAtomic(this.filePath, `${JSON.stringify({ version: LAG_FILE_VERSION, targets }, null, 2)}\n`);
    } catch (error) {
      // Отметку ставит хук внутри операции с базой (до update-db-cfg): сбой записи служебного файла не должен
      // обрывать загрузку. Признак остаётся в памяти до перезапуска, причина — в журнале.
      this.logger.appendLine(`[database-lag] Не удалось сохранить ${this.filePath}: ${(error as Error).message}. Признак отставания БД сохранён только до перезапуска.`);
    }
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
