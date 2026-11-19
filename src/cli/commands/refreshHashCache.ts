import * as path from 'path';
import { getString } from '../core/args';
import { buildScopeKey, saveHashCache, scanHashSnapshot } from '../core/hashCache';
import { resolveConfigDir } from '../core/projectLayout';
import type { CliArgs } from '../core/types';
import { saveMetadataCacheForEntry } from '../../infra/cache/MetadataCache';

/**
 * Полностью пересобирает кэш хешей для указанной области конфигурации. Пересборка идёт быстрой
 * проверкой: файлы, не тронутые выгрузкой из БД, берут хеш из stat-мемо, а мемо хранит только
 * факты о содержимом, поэтому полная базовая линия остаётся корректной.
 */
export async function refreshHashCache(args: CliArgs): Promise<number> {
  const projectRoot = path.resolve(getString(args, 'ProjectRoot', process.cwd()));
  const target = getString(args, 'Target', 'cf');
  const extension = getString(args, 'Extension', '');
  const configDir = getString(args, 'ConfigDir', '') || resolveConfigDir(projectRoot, target === 'cfe' ? 'cfe' : 'cf', extension);
  const normalizedTarget = target === 'cfe' ? 'cfe' : 'cf';
  const scopeKey = buildScopeKey(normalizedTarget, configDir, extension);
  console.log('Формирование хеш-кэша');
  const snapshot = await scanHashSnapshot(projectRoot, scopeKey, configDir);
  saveHashCache(projectRoot, snapshot);
  console.log('Формирование кэша метаданных');
  saveMetadataCacheForEntry(projectRoot, scopeKey, { kind: normalizedTarget, rootPath: configDir });
  console.log(`Hash cache rebuilt: ${String(Object.keys(snapshot.files).length)} files`);
  return 0;
}
