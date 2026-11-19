import * as path from 'path';
import type { ConfigEntry } from '../../domain/Configuration';
import { parseConfigXml } from '../xml';
import {
  diffHashSnapshots,
  hasHashBaseline,
  loadHashCache,
  saveHashCache,
} from '../cache/HashCache';
import { scanHashSnapshot, type HashScanOptions } from '../cache/HashScanner';
import { buildMetadataCacheScopeKey } from '../cache/MetadataCache';

export interface ChangedConfiguration {
  kind: 'cf' | 'cfe';
  rootPath: string;
  name: string;
  changedFilesCount: number;
}

export interface ConfigurationChangeDetectorOptions {
  /** Шов быстрой проверки (ФС и часы) — для тестов; отчёт прохода детектор формирует сам. */
  readonly scan?: Omit<HashScanOptions, 'onReport'>;
  readonly log?: (line: string) => void;
}

/**
 * Определяет, в каких XML-исходниках есть изменения относительно локального хеш-кэша.
 */
export class ConfigurationChangeDetector {
  constructor(
    private readonly projectRoot: string,
    private readonly options: ConfigurationChangeDetectorOptions = {}
  ) {}

  describe(entry: ConfigEntry, changedFilesCount: number): ChangedConfiguration {
    const scope = this.resolveScope(entry);
    return {
      kind: entry.kind,
      rootPath: entry.rootPath,
      name: scope.name,
      changedFilesCount,
    };
  }

  /**
   * Конфигурации проверяются последовательно, а не параллельно: проход и так нагружает диск, а
   * параллельные проходы по нескольким выгрузкам вытеснили бы операции ФС остальных расширений.
   *
   * Первичная инициализация базовой линии (бывший `ensureCaches`) выполняется здесь же, в том же
   * прогоне, — так порядок «кэш создан → сравнение» соблюдается по построению, а single-flight
   * (`ChangeDetectionRunner`) исключает параллельный прогон, читающий недописанный кэш.
   */
  async detect(entries: readonly ConfigEntry[]): Promise<ChangedConfiguration[]> {
    const result: ChangedConfiguration[] = [];
    const log = this.options.log;

    for (const entry of entries) {
      const scope = this.resolveScope(entry);
      const previous = loadHashCache(this.projectRoot, scope.scopeKey);
      const current = await scanHashSnapshot(this.projectRoot, scope.scopeKey, entry.rootPath, {
        ...this.options.scan,
        onReport: (report) => {
          log?.(
            `[hash-cache] ${scope.name}: файлов ${String(report.files)}, перехешировано ${String(report.hashed)} `
            + `(racy ${String(report.racy)}), ${String(report.elapsedMs)} мс`
          );
        },
      });

      if (!hasHashBaseline(previous)) {
        // Базовую линию мог записать CLI (импорт) за время прохода — её нельзя затирать снимком,
        // снятым до импорта. В обоих случаях этот проход изменений не сообщает: сравнивать не с чем.
        if (!hasHashBaseline(loadHashCache(this.projectRoot, scope.scopeKey))) {
          saveHashCache(this.projectRoot, current);
          log?.(`Инициализация хеш-кэша: ${scope.name}`);
        }
        continue;
      }

      const diff = diffHashSnapshots(previous, current);
      const changedFilesCount = diff.added.length + diff.modified.length + diff.deleted.length;

      if (changedFilesCount === 0) {
        continue;
      }

      result.push({
        kind: entry.kind,
        rootPath: entry.rootPath,
        name: scope.name,
        changedFilesCount,
      });
    }

    return result.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'cf' ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
  }

  private resolveScope(entry: ConfigEntry): { name: string; scopeKey: string } {
    const configXmlPath = path.join(entry.rootPath, 'Configuration.xml');
    const info = parseConfigXml(configXmlPath);
    return {
      name: info.name,
      scopeKey: buildMetadataCacheScopeKey(entry, info),
    };
  }
}
