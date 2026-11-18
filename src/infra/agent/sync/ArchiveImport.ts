import { buildDumpConfigToFilesCommand } from '../../../domain/agent/AgentCommand';
import type { AgentImportResult } from './AgentImportFlow';
import { openArchive, type ArchiveReader } from './ArchiveCodec';
import { openFileByteSource } from './ArchiveFile';
import { seedMirror } from './MirrorSeed';
import {
  CONFIG_DUMP_INFO_XML,
  CONFIGURATION_XML,
  applyProjectChanges,
  assertConfigurationPresent,
  hasSameProjectContent,
  listProjectFiles,
} from './ProjectFiles';
import {
  AgentFullDumpDeclinedError,
  EXCHANGE_ARCHIVE,
  exchangeDirOf,
  throwIfCancelled,
  withTransferCancellation,
  type SyncOperationContext,
} from './SyncContext';
import { ARCHIVE_REASON_POLICY, type ImportArchiveReason } from './SyncPlanner';

/**
 * Импорт архивом: полная выгрузка базы в каталог обмена на сервере, архив — потоком в локальный
 * каталог обмена, оттуда — в P. Буфера размером с архив нет нигде: архив выгрузки большой
 * конфигурации — сотни мегабайт.
 *
 * P меняется только после полного валидирующего прохода `scan`: испорченный архив не оставляет
 * проект с частью новых файлов. Для причин до `--update` (`ARCHIVE_REASON_POLICY.reseedMirror`) M
 * засевается файлом версий и Configuration.xml из того же архива — второй, полной выгрузки в M нет.
 *
 * Перед выгрузкой — вопрос `confirmFullDump`, если его не задали раньше (`confirmed`): вызывающий,
 * которому нужно мутировать M до архива (очистка пустого M), задаёт его сам, до мутации.
 */
export async function importByArchive(
  context: SyncOperationContext,
  reason: ImportArchiveReason,
  options: { readonly confirmed?: boolean } = {}
): Promise<AgentImportResult> {
  if (options.confirmed !== true) {
    await confirmFullDumpOrThrow(context, reason);
  }
  return withTransferCancellation(() => importArchive(context, reason));
}

/** Вопрос перед полной серверной выгрузкой; нет хука — согласие (прежнее поведение), отказ — исключение. */
export async function confirmFullDumpOrThrow(context: SyncOperationContext, reason: ImportArchiveReason): Promise<void> {
  const confirm = context.hooks?.confirmFullDump;
  if (confirm === undefined) {
    return;
  }
  const decision = await confirm({
    targetKind: context.target.kind,
    targetName: context.extensionName ?? context.target.name,
    projectDir: context.target.rootPath,
    reason,
    reasonText: ARCHIVE_REASON_POLICY[reason].text,
  });
  if (decision === 'cancel') {
    throw new AgentFullDumpDeclinedError();
  }
}

async function importArchive(context: SyncOperationContext, reason: ImportArchiveReason): Promise<AgentImportResult> {
  const exchangeDir = exchangeDirOf(context);
  const cancellation = context.hooks?.cancellation;
  // `--update` с `--archive` агент не выполняет (пилот): архив — отдельная полная выгрузка в обмен.
  await context.exec.execute(buildDumpConfigToFilesCommand(exchangeDir, {
    extensionName: context.extensionName,
    archive: EXCHANGE_ARCHIVE,
  }));
  const zipPath = await context.localExchange.file(EXCHANGE_ARCHIVE);
  context.hooks?.onMessage?.('Скачивание архива выгрузки…');
  const onMessage = context.hooks?.onMessage;
  await context.store.downloadToFile(`${exchangeDir}/${EXCHANGE_ARCHIVE}`, zipPath, {
    cancellation,
    onProgress: onMessage && downloadProgressReporter(onMessage),
  });
  throwIfCancelled(context);

  context.hooks?.onMessage?.('Распаковка архива выгрузки.');
  const source = await openFileByteSource(zipPath);
  try {
    const reader = await openArchive(source);
    const projectDir = context.target.rootPath;
    const entries = new Set<string>();
    const changed: string[] = [];
    await reader.scan((entry) => {
      entries.add(entry.path);
      if (!hasSameProjectContent(projectDir, entry.path, entry.data)) {
        changed.push(entry.path);
      }
    }, cancellation);
    assertConfigurationPresent(entries.has(CONFIGURATION_XML), 'архиве выгрузки');

    const seeded = ARCHIVE_REASON_POLICY[reason].reseedMirror;
    if (seeded) {
      // До записи в P: сбой посева оставляет проект нетронутым, а M — недостоверным (`empty`).
      await seedMirrorFromArchive(context, reader);
    }
    const changedProjectFiles = await applyProjectChanges({
      projectDir,
      writes: changed,
      deletes: listProjectFiles(projectDir).filter((rel) => !entries.has(rel)),
      // Отмены здесь нет: запись в проект, начавшись, доводится до конца.
      read: (rels, sink) => reader.read(new Set(rels), (entry) => sink(entry.path, entry.data)),
      onWillChange: context.hooks?.onProjectFilesWillChange,
    });
    return { changedProjectFiles, strategy: 'archive', reason, ...(seeded ? { seededFrom: 'archive' as const } : {}) };
  } finally {
    await source.close();
  }
}

const PROGRESS_STEP_PERCENT = 10;
/** Шаг сообщений, когда сервер не сообщил размер: архив большой конфигурации — сотни мегабайт. */
const PROGRESS_STEP_BYTES = 16 * 1024 * 1024;
const MEBIBYTE = 1024 * 1024;

/**
 * Прогресс скачивания архива — в журнал операции: каждые 10% (или 16 МБ без известного размера),
 * а не на каждую порцию в 31 КБ, иначе журнал утонул бы в сообщениях.
 */
function downloadProgressReporter(onMessage: (message: string) => void): (done: number, total: number | undefined) => void {
  let nextPercent = PROGRESS_STEP_PERCENT;
  let nextBytes = PROGRESS_STEP_BYTES;
  const mb = (bytes: number): string => (bytes / MEBIBYTE).toFixed(1);
  return (done, total) => {
    if (total === undefined) {
      if (done >= nextBytes) {
        onMessage(`Скачано ${mb(done)} МБ архива выгрузки.`);
        nextBytes = (Math.floor(done / PROGRESS_STEP_BYTES) + 1) * PROGRESS_STEP_BYTES;
      }
      return;
    }
    const percent = Math.floor((done * 100) / total);
    if (percent >= nextPercent) {
      onMessage(`Скачано ${String(percent)}% архива выгрузки (${mb(done)} из ${mb(total)} МБ).`);
      nextPercent = (Math.floor(percent / PROGRESS_STEP_PERCENT) + 1) * PROGRESS_STEP_PERCENT;
    }
  };
}

/**
 * Файл версий архива точен (пилот §5b п.7): он описывает ровно ту базу, из которой выгружен архив,
 * поэтому согласие пользователя на такой посев не нужно. Файл версий большой конфигурации — одна
 * запись в десятки мегабайт; держать её в памяти до закачки допустимо.
 */
async function seedMirrorFromArchive(context: SyncOperationContext, reader: ArchiveReader): Promise<void> {
  // `read` отдаёт ровно запрошенные записи, а отсутствие любой из них — отказ до приёмника.
  let configuration: Uint8Array = new Uint8Array(0);
  let dumpInfo: Uint8Array = new Uint8Array(0);
  await reader.read(new Set([CONFIGURATION_XML, CONFIG_DUMP_INFO_XML]), (entry) => {
    if (entry.path === CONFIGURATION_XML) {
      configuration = entry.data;
    } else {
      dumpInfo = entry.data;
    }
  });
  await seedMirror(context, { configuration, dumpInfo });
}
