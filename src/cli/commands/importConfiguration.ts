import * as fs from 'fs';
import * as path from 'path';
import { getBool, getString } from '../core/args';
import { resolveConnection } from '../core/connection';
import { buildScopeKey, collectCurrentHashes, loadHashCache, patchHashSnapshot, saveHashCache, scanHashSnapshot } from '../core/hashCache';
import { createTempDir, printLogFile, runDesignerAndPrintResult, safeRemoveDir, writeUtf8BomLines } from '../core/onecCommon';
import { resolveConfigDir } from '../core/projectLayout';
import type { CliArgs } from '../core/types';
import { saveMetadataCacheForEntry } from '../../infra/cache/MetadataCache';

export async function importConfiguration(args: CliArgs): Promise<number> {
  const projectRoot = path.resolve(getString(args, 'ProjectRoot', process.cwd()));
  const mode = getString(args, 'Mode', 'Full');
  const format = getString(args, 'Format', 'Hierarchical');
  const target = getString(args, 'Target', 'cf');
  const extension = getString(args, 'Extension', '');
  const files = getString(args, 'Files', '');
  const listFileFromArgs = getString(args, 'ListFile', '');
  const configDir = getString(args, 'ConfigDir', '') || resolveConfigDir(projectRoot, target === 'cfe' ? 'cfe' : 'cf', extension);
  const allExtensions = getBool(args, 'AllExtensions');
  const verbose = getBool(args, 'Verbose');
  const connection = resolveConnection(args);

  if (!['Full', 'Partial'].includes(mode)) {
    throw new Error('Error: -Mode must be Full or Partial');
  }
  if (!['Hierarchical', 'Plain'].includes(format)) {
    throw new Error('Error: -Format must be Hierarchical or Plain');
  }
  if (!fs.existsSync(configDir)) {
    throw new Error(`Error: config directory not found: ${configDir}`);
  }
  if (mode === 'Partial' && !files.trim() && !listFileFromArgs.trim()) {
    throw new Error('Error: -Files or -ListFile required for Partial mode');
  }
  if (target !== 'cfe' && isConfigurationOnSupport(configDir)) {
    throw new Error('Обновление основной конфигурации запрещено: конфигурация на поддержке');
  }

  const tempDir = createTempDir('db_load_xml_');
  try {
    console.log('Загрузка исходников');
    const designerArgs: string[] = ['/LoadConfigFromFiles', configDir];
    let partialFiles: string[] = [];
    if (mode !== 'Full') {
      let listFile = listFileFromArgs;
      if (listFile) {
        if (!fs.existsSync(listFile)) {
          throw new Error(`Error: list file not found: ${listFile}`);
        }
        partialFiles = readListFile(listFile);
      } else {
        const fileList = files.split(',').map((item) => item.trim()).filter(Boolean);
        listFile = path.join(tempDir, 'load_list.txt');
        writeUtf8BomLines(listFile, fileList);
        partialFiles = fileList;
        if (verbose) {
          console.log(`Files to load: ${String(fileList.length)}`);
        }
      }
      designerArgs.push('-listFile', listFile, '-partial', '-updateConfigDumpInfo');
    }

    designerArgs.push('-Format', format);
    if (target === 'cfe' || extension) {
      designerArgs.push('-Extension', extension);
    } else if (allExtensions) {
      designerArgs.push('-AllExtensions');
    }

    const outFile = path.join(tempDir, 'load_log.txt');
    designerArgs.push('/Out', outFile, '/DisableStartupDialogs');

    const exitCode = await runDesignerAndPrintResult(
      connection,
      designerArgs,
      'Загрузка завершена',
      'Error loading configuration',
      verbose ? undefined : outFile
    );
    if (verbose) {
      printLogFile(outFile);
    }
    /* c8 ignore start */
    // Тело достижимо только при успешной загрузке платформой 1С (e2e с 1cv8); сама логика обновления
    // хеш-кэша покрыта unit-тестом экспортированной refreshHashCacheAfterImport (cliHashCache.test).
    if (exitCode === 0) {
      await refreshHashCacheAfterImport(projectRoot, configDir, target, extension, mode, partialFiles);
    }
    /* c8 ignore stop */
    return exitCode;
  } finally {
    safeRemoveDir(tempDir);
  }
}

function isConfigurationOnSupport(configDir: string): boolean {
  return fs.existsSync(path.join(configDir, 'Ext', 'ParentConfigurations.bin'));
}

/**
 * Экспортируется ради теста без платформы 1С: сама загрузка требует 1cv8, а обновление кэша —
 * чистая работа с ФС. Полная ветка идёт быстрой проверкой: `/LoadConfigFromFiles` файлы выгрузки не
 * переписывает, и после полной загрузки почти все хеши берутся из stat-мемо.
 */
export async function refreshHashCacheAfterImport(
  projectRoot: string,
  configDir: string,
  target: string,
  extension: string,
  mode: string,
  partialFiles: string[]
): Promise<void> {
  const normalizedTarget = target === 'cfe' ? 'cfe' : 'cf';
  const scopeKey = buildScopeKey(normalizedTarget, configDir, extension);
  console.log('Формирование хеш-кэша');
  if (mode === 'Full') {
    const snapshot = await scanHashSnapshot(projectRoot, scopeKey, configDir);
    saveHashCache(projectRoot, snapshot);
    console.log('Формирование кэша метаданных');
    saveMetadataCacheForEntry(projectRoot, scopeKey, { kind: normalizedTarget, rootPath: configDir });
    return;
  }
  const previous = loadHashCache(projectRoot, scopeKey);
  const changedHashes = collectCurrentHashes(configDir, partialFiles);
  const deletedFiles = partialFiles.filter((file) => !changedHashes[file]);
  const patched = patchHashSnapshot(previous, changedHashes, deletedFiles);
  saveHashCache(projectRoot, patched);
  console.log('Формирование кэша метаданных');
  saveMetadataCacheForEntry(projectRoot, scopeKey, { kind: normalizedTarget, rootPath: configDir });
}

function readListFile(listFilePath: string): string[] {
  let text = fs.readFileSync(listFilePath, 'utf-8');
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  return text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}
