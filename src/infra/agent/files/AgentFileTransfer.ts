import type { AgentFileEntry, AgentFileStore } from './AgentFileStore';

/**
 * Число одновременных запросов по умолчанию. При пинге ~80 мс до удалённого агента
 * последовательная передача тысяч мелких файлов выгрузки упирается в задержку, а не в
 * канал; 16 параллельных запросов снимают это ограничение, не перегружая SFTP-сервер агента.
 */
export const DEFAULT_AGENT_TRANSFER_CONCURRENCY = 16;

export interface AgentTransferProgress {
  readonly done: number;
  readonly total: number;
  /** Файл, передача которого только что завершилась. */
  readonly path: string;
}

/** Структурно совместим с `vscode.CancellationToken`, но без зависимости от vscode. */
export interface AgentTransferCancellation {
  readonly isCancellationRequested: boolean;
}

export interface AgentTransferOptions {
  readonly concurrency?: number;
  readonly onProgress?: (progress: AgentTransferProgress) => void;
  readonly cancellation?: AgentTransferCancellation;
}

export interface AgentTransferResult {
  readonly transferred: number;
  /** `true`, если часть файлов не начата из-за отмены. */
  readonly cancelled: boolean;
}

export interface AgentTransferFailure {
  readonly path: string;
  readonly error: Error;
}

/**
 * Потоковая передача (или упаковка/распаковка архива) прервана по запросу пользователя. Свой класс,
 * а не `AgentSyncCancelledError`: слой `files/` не зависит от `sync/`, перевод — `withTransferCancellation`.
 */
export class AgentTransferCancelledError extends Error {
  constructor() {
    super('Передача файлов агента отменена.');
    this.name = 'AgentTransferCancelledError';
  }
}

/** Бросает {@link AgentTransferCancelledError}, если отмена уже запрошена. */
export function throwIfTransferCancellationRequested(cancellation: AgentTransferCancellation | undefined): void {
  if (cancellation?.isCancellationRequested) {
    throw new AgentTransferCancelledError();
  }
}

/** Отказ передачи: перечень всех файлов, на которых она упала (одновременно идущие тоже). */
export class AgentTransferError extends Error {
  constructor(readonly failures: readonly AgentTransferFailure[]) {
    super(
      `Не удалось передать файлы агента (${String(failures.length)}): ` +
      failures.map((failure) => `${failure.path}: ${failure.error.message}`).join('; ')
    );
    this.name = 'AgentTransferError';
  }
}

export type AgentDownloadSink = (rel: string, data: Buffer) => void | Promise<void>;
export type AgentUploadSource = (rel: string) => Uint8Array | string | Promise<Uint8Array | string>;

/** Читает файлы хранилища и отдаёт каждый в `sink`; не более `concurrency` запросов одновременно. */
export function downloadFiles(
  store: AgentFileStore,
  rels: readonly string[],
  sink: AgentDownloadSink,
  options: AgentTransferOptions = {}
): Promise<AgentTransferResult> {
  return runTransfer(rels, async (rel) => sink(rel, await store.readFile(rel)), options, String);
}

/** Пишет в хранилище содержимое, полученное от `source`; не более `concurrency` запросов одновременно. */
export function uploadFiles(
  store: AgentFileStore,
  rels: readonly string[],
  source: AgentUploadSource,
  options: AgentTransferOptions = {}
): Promise<AgentTransferResult> {
  return runTransfer(rels, async (rel) => store.writeFile(rel, await source(rel)), options, String);
}

/**
 * Произвольная операция над каждым элементом тем же пулом, что у передачи файлов: STAT/LIST по SFTP
 * упираются в задержку так же, как чтение файлов (сотни владельцев × 80 мс последовательно — минуты).
 * `describe` — имя элемента в отказе {@link AgentTransferError} и в прогрессе.
 */
export function forEachConcurrent<T>(
  items: readonly T[],
  run: (item: T) => void | Promise<void>,
  options: AgentTransferOptions = {},
  describe: (item: T) => string = String
): Promise<AgentTransferResult> {
  return runTransfer(items, async (item) => { await run(item); }, options, describe);
}

/**
 * STAT каждого пути пулом. Ключи карты — в порядке `rels`; при отмене — только выполненные (без
 * исключения): решение, что делать с неполной картой, принимает вызывающий.
 */
export async function statFiles(
  store: AgentFileStore,
  rels: readonly string[],
  options: AgentTransferOptions = {}
): Promise<Map<string, AgentFileEntry | undefined>> {
  const done = new Map<string, AgentFileEntry | undefined>();
  await forEachConcurrent(rels, async (rel) => { done.set(rel, await store.stat(rel)); }, options);
  return new Map(rels.filter((rel) => done.has(rel)).map((rel) => [rel, done.get(rel)] as const));
}

/**
 * Пул из `concurrency` исполнителей над общей очередью. После первой ошибки и после отмены
 * новые файлы не стартуют, но уже начатые дожидаются: иначе их отказы потерялись бы, а
 * запись в хранилище продолжилась бы после того, как вызывающий уже получил ответ.
 */
async function runTransfer<T>(
  rels: readonly T[],
  transferOne: (rel: T) => Promise<void>,
  options: AgentTransferOptions,
  describe: (item: T) => string
): Promise<AgentTransferResult> {
  const concurrency = options.concurrency ?? DEFAULT_AGENT_TRANSFER_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`Некорректная конкурентность передачи файлов агента: ${String(concurrency)}.`);
  }

  const failures: AgentTransferFailure[] = [];
  let next = 0;
  let done = 0;
  let cancelled = false;

  const worker = async (): Promise<void> => {
    while (next < rels.length && failures.length === 0) {
      if (options.cancellation?.isCancellationRequested) {
        cancelled = true;
        return;
      }
      const rel = rels[next];
      next += 1;
      try {
        await transferOne(rel);
        done += 1;
        options.onProgress?.({ done, total: rels.length, path: describe(rel) });
      } catch (error) {
        failures.push({ path: describe(rel), error: error instanceof Error ? error : new Error(String(error)) });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, rels.length) }, worker));
  if (failures.length > 0) {
    throw new AgentTransferError(failures);
  }
  return { transferred: done, cancelled };
}
