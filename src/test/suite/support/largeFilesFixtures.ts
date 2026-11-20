/**
 * Общие стенды задачи «большие файлы в импорте» (plan-large-files.md §5): пороги для тестов (гигабайтов нет),
 * «база» с конфигурацией поставщика, шпион одновременных скачиваний, ожидание придержанных READ и разбор
 * журнала SFTP-сервера по путям M. Агент 1С — эмулятор, хранилище — настоящее.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentStreamOptions } from '../../../infra/agent/files/AgentFileStore';
import { hasOption, type AgentConfigEmulator } from './agentConfigEmulator';
import type { SyncHarness } from './agentSyncHarness';
import type { SftpGate } from './agentSftpTestBackend';
import { CountingAgentFileStore } from './delegatingAgentFileStore';
import { patternBytes } from './zipFixtures';

/** Порог «большого» файла в тестах: 64 КиБ (продакшн — 16 МиБ). */
export const LARGE_THRESHOLD = 64 * 1024;
/** «Большой» файл: 300 КиБ ≈ 10 порций SFTP по 31 КиБ. */
export const LARGE_SIZE = 300 * 1024;
/** Порог предупреждения о большом файле заранее: 128 КиБ (продакшн — 100 МиБ). */
export const WARN_BYTES = 128 * 1024;

/** Большой отслеживаемый файл обычного объекта (`.bsl` входит в манифест B, в отличие от `.cf`/`.bin`). */
export const BIG_REL = 'Catalogs/Товары/Ext/Данные.bsl';
export const BIG2_REL = 'Catalogs/Клиенты/Ext/Данные2.bsl';
export const SMALL_REL = 'Catalogs/Клиенты.xml';

export const VENDOR_BIN = 'Ext/ParentConfigurations.bin';
export const VENDOR_CF = 'Ext/ParentConfigurations/Поставщик.cf';
export const ROOT_MODULE = 'Ext/ManagedApplicationModule.bsl';
export const ROOT_OWNER = 'Configuration.Конфигурация';
export const BOM = String.fromCharCode(0xfeff);

export function bigBytes(size = LARGE_SIZE, seed = 1): Buffer {
  return patternBytes(size, seed);
}

/** «База» с конфигурацией поставщика: `.bin` (малый, первым) и `.cf` (большой) — одна файловая запись CDI корня. */
export function seedVendor(emulator: AgentConfigEmulator, options: { readonly binSeed?: number; readonly cfSeed?: number } = {}): void {
  emulator.putFile(VENDOR_BIN, patternBytes(2048, options.binSeed ?? 1));
  emulator.putFile(VENDOR_CF, bigBytes(LARGE_SIZE, options.cfSeed ?? 2));
}

/** Обновление поставщика: меняются и `.bin`, и `.cf` (версия части растёт). */
export function updateVendor(emulator: AgentConfigEmulator, seed = 50): void {
  emulator.putFile(VENDOR_BIN, patternBytes(2048, seed));
  emulator.putFile(VENDOR_CF, bigBytes(LARGE_SIZE, seed + 1));
}

/** Записи журнала SFTP-сервера с путём, оканчивающимся на `suffix`, по операции. */
export function opsAt(h: SyncHarness, op: 'OPEN' | 'READ', suffix: string): number {
  assert.ok(h.sftp, 'нужен SFTP-бэкенд');
  return h.sftp.ops(op).filter((entry) => (entry.path ?? '').endsWith(suffix)).length;
}

export const wasOpened = (h: SyncHarness, rel: string): boolean => opsAt(h, 'OPEN', rel) > 0;

export function bytesInP(h: SyncHarness, rel: string): Buffer {
  return fs.readFileSync(path.join(h.configRoot, ...rel.split('/')));
}

export function bytesInDb(h: SyncHarness, rel: string): Buffer {
  const data = h.emulator.dbFiles()[rel];
  assert.ok(data, `в базе эмулятора нет ${rel}`);
  return data;
}

/** mtime файла P (мс) — «P не тронут» проверяется неизменностью, а не содержимым. */
export function mtimeOfP(h: SyncHarness, rel: string): number {
  return fs.statSync(path.join(h.configRoot, ...rel.split('/'))).mtimeMs;
}

/** Уводит mtime файла P в прошлое: любая перезапись заметна по смене времени. */
export function agePFile(h: SyncHarness, rel: string, seconds = 7200): number {
  const past = Date.now() / 1000 - seconds;
  const abs = path.join(h.configRoot, ...rel.split('/'));
  fs.utimesSync(abs, past, past);
  return fs.statSync(abs).mtimeMs;
}

/**
 * Придерживает ответы READ с момента команды `dump --update` (без `--get-changes`): список изменений к этому
 * времени уже прочитан, дальше читаются только файлы дельты. Резолвится шлюзом, когда команда пришла.
 */
export function holdReadsAfterUpdate(h: SyncHarness): Promise<SftpGate> {
  assert.ok(h.sftp, 'нужен SFTP-бэкенд');
  const sftp = h.sftp;
  return new Promise<SftpGate>((resolve) => {
    h.emulator.onCommand = (command) => {
      if (command.command === 'config dump-config-to-files' && command.options.update === true && !hasOption(command, 'get-changes')) {
        resolve(sftp.hold('READ'));
      }
    };
  });
}

/** Ждёт `count` придержанных запросов; вместо вечного ожидания (последовательный код) — внятный отказ. */
export async function expectPending(gate: SftpGate, count: number, what: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), 10_000); });
  const outcome = await Promise.race([gate.waitForPending(count).then(() => 'ok' as const), timeout]);
  if (timer) {
    clearTimeout(timer);
  }
  assert.strictEqual(outcome, 'ok', `${what}: придержано ${String(gate.pendingCount())} из ожидаемых ${String(count)}`);
}

/**
 * Считает одновременно идущие `downloadToFile` (полоса больших файлов обязана идти по одному: параллель больших
 * файлов только делила бы канал и удваивала staging на диске) и сохраняет вызовы родителя (`CountingAgentFileStore`).
 */
export class DownloadProbeStore extends CountingAgentFileStore {
  maxDownloadsInFlight = 0;
  private inFlight = 0;

  override async downloadToFile(rel: string, localPath: string, options?: AgentStreamOptions): Promise<void> {
    this.inFlight += 1;
    this.maxDownloadsInFlight = Math.max(this.maxDownloadsInFlight, this.inFlight);
    try {
      await super.downloadToFile(rel, localPath, options);
    } finally {
      this.inFlight -= 1;
    }
  }
}
