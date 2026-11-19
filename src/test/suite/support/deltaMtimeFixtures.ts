/**
 * Общие приёмы тестов «дельта импорта по времени изменения»: подсчёт файлов, прочитанных с сервера по журналу
 * SFTP-бэкенда (настоящий протокол, настоящие чтения), и состаривание M.
 */
import * as assert from 'assert';
import type { SyncHarness } from './agentSyncHarness';

const CDI = 'ConfigDumpInfo.xml';

/** Файлы M (относительно каталога выгрузки), которые клиент ЧИТАЛ с сервера после последней очистки журнала; без файла версий. */
export function mirrorReads(h: SyncHarness): string[] {
  assert.ok(h.sftp, 'нужен SFTP-бэкенд');
  const prefix = `${h.mirrorDir}/`;
  const rels = h.sftp.ops('READ')
    .map((entry) => entry.path ?? '')
    .filter((rel) => rel.startsWith(prefix))
    .map((rel) => rel.slice(prefix.length))
    .filter((rel) => rel !== CDI);
  return [...new Set(rels)].sort();
}

/** Файлы, прочитанные из каталога точечной выгрузки `exchange/<op>/restore/…` (источник вместо M). */
export function restoreReads(h: SyncHarness): string[] {
  assert.ok(h.sftp, 'нужен SFTP-бэкенд');
  const rels: string[] = [];
  for (const entry of h.sftp.ops('READ')) {
    const match = /^exchange\/[^/]+\/restore\/(.+)$/.exec(entry.path ?? '');
    if (match) {
      rels.push(match[1]);
    }
  }
  return [...new Set(rels)].sort();
}

/** Файлы выгрузки «базы» эмулятора по префиксу пути, без файла версий, отсортированные. */
export function dbFilesUnder(h: SyncHarness, prefix: string): string[] {
  return Object.keys(h.emulator.dbTrackedFiles()).filter((rel) => rel.startsWith(prefix)).sort();
}

/** Нужная строка журнала ровно один раз. */
export function assertOnce(messages: readonly string[], matcher: RegExp | string): string {
  const found = messages.filter((message) => (typeof matcher === 'string' ? message === matcher : matcher.test(message)));
  assert.strictEqual(found.length, 1, `ожидалась одна строка ${String(matcher)}: ${messages.join(' | ')}`);
  return found[0];
}

/** Строки следуют в журнале в заданном порядке (между ними могут быть другие). */
export function assertSubsequence(messages: readonly string[], matchers: readonly (RegExp | string)[]): void {
  let from = 0;
  for (const matcher of matchers) {
    const index = messages.findIndex((message, position) =>
      position >= from && (typeof matcher === 'string' ? message === matcher : matcher.test(message)));
    assert.ok(index >= 0, `нет строки ${String(matcher)} после позиции ${String(from)}: ${messages.join(' | ')}`);
    from = index + 1;
  }
}
