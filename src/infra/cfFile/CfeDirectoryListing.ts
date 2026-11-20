/**
 * Чтение каталога пакета CFE-файлов. Общее для CLI (`dump-cfe-all`/`load-cfe-all`) и агентской ветки пакетов
 * (`infra/agent/extensions/AgentCfeBatch`): infra не импортирует cli, поэтому единственная реализация — здесь,
 * а `cli/commands/cfeBatchShared.ts` её реэкспортирует.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { CfeDirectoryEntry } from './CfeBatchPlan';

/** Записи файлов первого уровня каталога (имя + размер) для `planCfeLoad`. */
export function readCfeDirectoryEntries(directoryPath: string): CfeDirectoryEntry[] {
  return fs.readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, sizeBytes: fs.statSync(path.join(directoryPath, entry.name)).size }));
}

/** Имена файлов первого уровня каталога; недоступный каталог — пустой список. */
export function readDirectoryFileNames(directoryPath: string): string[] {
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
