import * as fs from 'fs';
import { buildDumpConfigToFilesCommand } from '../../../domain/agent/AgentCommand';
import { filesHaveSameContent } from '../../fs/FileContentCompare';
import { downloadFiles } from '../files/AgentFileTransfer';
import type { AgentImportResult } from './AgentImportFlow';
import { caseCollisions } from './DeltaImport';
import {
  CONFIG_DUMP_INFO_XML,
  CONFIGURATION_XML,
  applyProjectChanges,
  assertConfigurationPresent,
  hasSameProjectContent,
  listProjectFiles,
  projectFileSize,
  toProjectPath,
} from './ProjectFiles';
import { throwIfCancelled, transferOptionsOf, withTransferCancellation, type SyncOperationContext } from './SyncContext';

/**
 * Импорт с локальным агентом: полное сравнение M и P (локально чтение дёшево, списка изменений не нужно).
 * Файлы ≥ порога (plan-large-files.md §2.5) не читаются буфером: размер M ≠ P — изменён без чтения, равен —
 * копия в staging и побайтное сравнение порциями; запись в P — потоком прямо во временный файл записи.
 * Без этого каждый импорт конфигурации на поддержке читал бы гигабайт `.cf` поставщика в память Extension Host.
 */
export async function importByCompare(context: SyncOperationContext): Promise<AgentImportResult> {
  const { store, workspace } = context;
  const mirror = workspace.targetAgentDir;
  const hasDumpInfo = (await store.stat(`${mirror}/${CONFIG_DUMP_INFO_XML}`)) !== undefined;
  context.markMirrorMutated();
  await context.exec.execute(buildDumpConfigToFilesCommand(mirror, {
    extensionName: context.extensionName,
    update: hasDumpInfo,
    force: true,
  }));
  throwIfCancelled(context);

  const prefix = `${mirror}/`;
  const mirrorEntries = (await store.list(mirror, { recursive: true })).filter((entry) => entry.type === 'file');
  const mirrorFiles = mirrorEntries.map((entry) => entry.path.slice(prefix.length));
  assertConfigurationPresent(mirrorFiles.includes(CONFIGURATION_XML), `"${mirror}"`);
  const sizeOf = new Map(mirrorEntries.map((entry) => [entry.path.slice(prefix.length), entry.size]));
  const isLarge = (rel: string): boolean => Number(sizeOf.get(rel)) >= context.largeFileThresholdBytes;
  const small = mirrorFiles.filter((rel) => !isLarge(rel));
  const large = new Set(mirrorFiles.filter(isLarge));

  // Первый проход только сравнивает: список изменений нужен до первой записи, а держать в
  // памяти всю выгрузку ради одного прохода нельзя (локально второе чтение дёшево).
  const changed: string[] = [];
  const projectDir = context.target.rootPath;
  const counter = context.progress.counter(
    (done, total) => `Сравнение зеркала с проектом: ${String(done)} из ${String(total)}`, mirrorFiles.length);
  await downloadFiles(store, small.map((rel) => prefix + rel), (agentRel, data) => {
    counter.advance();
    const rel = agentRel.slice(prefix.length);
    if (!hasSameProjectContent(projectDir, rel, data)) {
      changed.push(rel);
    }
  }, transferOptionsOf(context));
  throwIfCancelled(context);
  let stagingCount = 0;
  for (const rel of large) {
    stagingCount += 1;
    if (!await sameLargeFile(context, prefix + rel, rel, Number(sizeOf.get(rel)), `compare-${String(stagingCount)}`)) {
      changed.push(rel);
    }
    counter.advance();
  }
  counter.finish();

  const inMirror = new Set(mirrorFiles);
  const deletes = listProjectFiles(projectDir).filter((rel) => !inMirror.has(rel));
  const sameFileAsDeleted = caseCollisions(deletes);
  const changedSet = new Set(changed);
  const changedProjectFiles = await applyProjectChanges({
    projectDir,
    writes: [...changed, ...mirrorFiles.filter((rel) => !changedSet.has(rel) && sameFileAsDeleted(rel))],
    deletes,
    // Второй проход без отмены: запись в проект, начавшись, доводится до конца.
    read: async (rels, sink) => {
      await downloadFiles(store, rels.filter((rel) => !large.has(rel)).map((rel) => prefix + rel), (agentRel, data) =>
        sink(agentRel.slice(prefix.length), data), { concurrency: context.transferConcurrency });
      for (const rel of rels.filter((item) => large.has(item))) {
        // Временный файл записи — новый путь: `downloadToFile` открывает его `wx`, отказ убирает и его.
        await sink(rel, { writeTo: (tempPath) => store.downloadToFile(prefix + rel, tempPath) });
      }
    },
    onWillChange: context.hooks?.onProjectFilesWillChange,
    onProgress: context.progress,
  });
  return { changedProjectFiles, strategy: 'compare' };
}

/** Размер решает без чтения; при равном — копия M в staging и сравнение порциями, staging сразу убирается. */
async function sameLargeFile(
  context: SyncOperationContext,
  source: string,
  rel: string,
  mirrorSize: number,
  stagingName: string
): Promise<boolean> {
  const projectDir = context.target.rootPath;
  if (projectFileSize(projectDir, rel) !== mirrorSize) {
    return false;
  }
  const stagingPath = await context.localExchange.file(stagingName);
  await withTransferCancellation(() =>
    context.store.downloadToFile(source, stagingPath, { cancellation: context.hooks?.cancellation }));
  try {
    return await filesHaveSameContent(toProjectPath(projectDir, rel), stagingPath);
  } finally {
    // unlink, а не rmSync (запрет №19).
    await fs.promises.unlink(stagingPath);
  }
}
