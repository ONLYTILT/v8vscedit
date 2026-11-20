import * as fs from 'fs';
import * as path from 'path';
import { filesHaveSameContent } from '../../fs/FileContentCompare';
import { AgentTransferError, downloadFiles, forEachConcurrent, type AgentTransferCancellation } from '../files/AgentFileTransfer';
import { hasSameProjectContent, toProjectPath } from './ProjectFiles';
import { throwIfCancelled, type SyncOperationContext } from './SyncContext';
import type { TransferCounter, TransferFormat } from './TransferProgress';
import { formatByteSize, formatEta, formatRate } from './TransferProgressText';

/**
 * Две полосы скачивания дельты импорта (plan-large-files.md §2.3). Малая — прежний пул `readFile`: тысячи мелких
 * файлов упираются в задержку, а не в канал. Большая (файл ≥ порога) — `downloadToFile` в staging на диске ПО
 * ОДНОМУ: конвейер READ внутри файла даёт само хранилище, параллель больших файлов только делила бы канал и
 * удваивала staging (ФАКТ Э26: узкое место — пропускная способность канала, а не протокол). Буфера размером с
 * файл в большой полосе нет ни при скачивании, ни при сравнении с P.
 */

/** Файл к скачиванию: путь в хранилище, путь в P и размер из LIST/STAT (`undefined` — неизвестен). */
export interface DeltaFile {
  readonly source: string;
  readonly rel: string;
  readonly size: number | undefined;
}

export interface DeltaLanesInput {
  readonly files: readonly DeltaFile[];
  /** Заголовок строки прогресса этапа. */
  readonly title: string;
  readonly sameFileAsDeleted: (rel: string) => boolean;
  /** Сюда кладутся отличающиеся от P файлы: путь в P → staging. */
  readonly staged: Map<string, string>;
  /** Имя очередного staging-файла: по номеру, а не по пути (длинные пути Windows). */
  readonly nextStagingName: () => string;
}

export async function downloadDeltaLanes(context: SyncOperationContext, input: DeltaLanesInput): Promise<void> {
  const threshold = context.largeFileThresholdBytes;
  const isLarge = (file: DeltaFile): boolean => file.size !== undefined && file.size >= threshold;
  const large = input.files.filter(isLarge);
  const small = input.files.filter((file) => !isLarge(file));
  await assertFreeSpace(context, large);
  const counter = context.progress.transfer(transferFormat(input.title), {
    files: input.files.length,
    bytes: input.files.reduce((total, file) => total + (file.size ?? 0), 0),
  });
  // Отказ одной полосы останавливает старт новых файлов в другой (начатые дожидаются — семантика пула).
  const failed = { value: false };
  const laneCancellation: AgentTransferCancellation = {
    get isCancellationRequested(): boolean {
      return failed.value || context.hooks?.cancellation?.isCancellationRequested === true;
    },
  };
  const guard = (lane: Promise<unknown>): Promise<unknown> => lane.catch((error: unknown) => {
    failed.value = true;
    throw error;
  });
  const results = await Promise.allSettled([
    guard(downloadSmall(context, input, small, counter, laneCancellation)),
    guard(downloadLarge(context, input, large, counter, laneCancellation)),
  ]);
  // Отмена пользователя — раньше разбора отказов: большая полоса сообщает её отказом своего пула.
  throwIfCancelled(context);
  const errors = results.flatMap((result): unknown[] => (result.status === 'rejected' ? [result.reason as unknown] : []));
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    // Оба отказа — пулы передачи: одна ошибка с перечнем файлов обеих полос.
    throw new AgentTransferError(errors.flatMap((error) =>
      /* c8 ignore next -- пулы бросают только AgentTransferError; ветка страхует от смены их контракта. */
      error instanceof AgentTransferError ? error.failures : [{ path: '', error: error instanceof Error ? error : new Error(String(error)) }]));
  }
  counter.finish();
}

function downloadSmall(
  context: SyncOperationContext,
  input: DeltaLanesInput,
  files: readonly DeltaFile[],
  counter: TransferCounter,
  cancellation: AgentTransferCancellation
): Promise<unknown> {
  const projectDir = context.target.rootPath;
  const bySource = new Map(files.map((file) => [file.source, file]));
  return downloadFiles(context.store, files.map((file) => file.source), async (source, data) => {
    const file = bySource.get(source);
    /* c8 ignore start -- downloadFiles отдаёт в приёмник ровно запрошенные пути; ветка страхует от смены
       контракта хранилища, из тестов (настоящее хранилище и эмулятор агента) недостижима. */
    if (file === undefined) {
      throw new Error(`Неожиданный файл агента в дельте импорта: ${source}`);
    }
    /* c8 ignore stop */
    countFile(counter, file.size, data.length);
    // Совпадение с удаляемым путём без учёта регистра (переименование регистром на Windows) — тот же
    // физический файл: удаление идёт первым, поэтому запись обязательна даже при равном содержимом.
    if (!input.sameFileAsDeleted(file.rel) && hasSameProjectContent(projectDir, file.rel, data)) {
      return;
    }
    // Номер берётся до первого await. Это не файл выгрузки: его читает только эта операция после успешной
    // записи, а обрыв убирает каталог обмена целиком — temp+rename здесь не нужен.
    const stagingPath = await context.localExchange.file(input.nextStagingName());
    await fs.promises.writeFile(stagingPath, data);
    input.staged.set(file.rel, stagingPath);
  }, { concurrency: context.transferConcurrency, cancellation });
}

/** Файл сначала засчитывается, потом его байты: веха 100 % тогда показывает «N из N», а не «N−1 из N». */
function countFile(counter: TransferCounter, trackedSize: number | undefined, bytes: number): void {
  if (trackedSize === undefined) {
    counter.fileDone(bytes);
    return;
  }
  counter.fileDone();
  counter.addBytes(bytes);
}

function downloadLarge(
  context: SyncOperationContext,
  input: DeltaLanesInput,
  files: readonly DeltaFile[],
  counter: TransferCounter,
  cancellation: AgentTransferCancellation
): Promise<unknown> {
  const projectDir = context.target.rootPath;
  return forEachConcurrent(files, async (file) => {
    // Размер большого файла известен по построению (иначе он в малой полосе).
    const size = Number(file.size);
    context.progress.step(`Скачивание большого файла (${formatByteSize(size)}): ${file.rel}`);
    const stagingPath = await context.localExchange.file(input.nextStagingName());
    let reported = 0;
    // Отмену внутри файла видит само хранилище (настоящий признак пользователя, не отказ соседней полосы):
    // отказ соседней полосы не должен обрывать уже начатый файл.
    await context.store.downloadToFile(file.source, stagingPath, {
      cancellation: context.hooks?.cancellation,
      onProgress: (done) => {
        // Последняя порция засчитывается после файла — см. countFile.
        if (done < size) {
          counter.addBytes(done - reported);
          reported = done;
        }
      },
    });
    counter.fileDone();
    counter.addBytes(size - reported);
    if (!input.sameFileAsDeleted(file.rel) && await filesHaveSameContent(toProjectPath(projectDir, file.rel), stagingPath)) {
      // unlink, а не rmSync (запрет №19): имя staging латинское, но правило едино для файлов обмена.
      await fs.promises.unlink(stagingPath);
      return;
    }
    input.staged.set(file.rel, stagingPath);
  }, { concurrency: 1, cancellation }, (file) => file.source);
}

/**
 * Staging и временный файл записи в P живут одновременно: нужно ~2 × сумма больших файлов. Отказ — до
 * скачивания, понятным текстом, а не обрывом записи на середине гигабайта.
 */
async function assertFreeSpace(context: SyncOperationContext, large: readonly DeltaFile[]): Promise<void> {
  if (large.length === 0) {
    return;
  }
  const need = 2 * large.reduce((total, file) => total + Number(file.size), 0);
  const dir = path.dirname(await context.localExchange.file('free-space'));
  const free = await context.freeDiskSpace(dir);
  if (free !== undefined && free < need) {
    throw new Error(
      `Недостаточно места на диске для скачивания: нужно ~${formatByteSize(need)}, свободно ${formatByteSize(free)} ` +
      `(каталог обмена ${dir}).`
    );
  }
}

/** `Скачивание изменённых файлов: 27 из 28, 312,4 МБ из 1,19 ГБ (25%), 5,8 МБ/с, осталось ~3 мин 31 с`. */
function transferFormat(title: string): TransferFormat {
  return (state) => {
    const percent = state.totalBytes > 0
      ? Math.floor((state.doneBytes * 100) / state.totalBytes)
      : Math.floor((state.doneFiles * 100) / state.totalFiles);
    const rate = state.bytesPerSec === undefined ? '' : `, ${formatRate(state.bytesPerSec)}`;
    const eta = state.etaSec === undefined ? '' : `, осталось ${formatEta(state.etaSec)}`;
    return `${title}: ${String(state.doneFiles)} из ${String(state.totalFiles)}, ` +
      `${formatByteSize(state.doneBytes)} из ${formatByteSize(state.totalBytes)} (${String(percent)}%)${rate}${eta}`;
  };
}
