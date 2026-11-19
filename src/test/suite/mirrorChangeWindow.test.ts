import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentFileEntry } from '../../infra/agent/files/AgentFileStore';
import { AgentTransferCancelledError } from '../../infra/agent/files/AgentFileTransfer';
import {
  MARKER_SAFETY_SEC,
  selectMirrorDownloads,
  takeMirrorMarker,
  type MirrorMarker,
} from '../../infra/agent/sync/MirrorChangeWindow';
import { AgentSyncCancelledError, EXCHANGE_MIRROR_MARKER_SUFFIX, EXCHANGE_SIDE_SUFFIXES, exchangeDirOf } from '../../infra/agent/sync/SyncContext';
import { createHarness, type SyncHarness } from './support/agentSyncHarness';
import { makeContext } from './support/archiveAvoidFixtures';
import { DelegatingAgentFileStore, MtimeShapingAgentFileStore } from './support/delegatingAgentFileStore';

/**
 * Отбор файлов дельты импорта по времени изменения в зеркале агента. Сравнение — только с меткой, записанной
 * на сервере самой операцией (часы клиента не участвуют: у настоящего агента серверные времена сдвинуты на час).
 */

const SINCE = 1_000;
const MARKER: MirrorMarker = { sinceSec: SINCE };

function entry(rel: string, mtimeSec: number | undefined, size = 10): AgentFileEntry {
  return { path: rel, type: 'file', size, ...(mtimeSec === undefined ? {} : { mtimeMs: mtimeSec * 1000 }) };
}

interface SelectArgs {
  readonly candidates: string[];
  readonly entries: Record<string, AgentFileEntry | undefined>;
  readonly marker?: MirrorMarker;
  readonly mustFetch?: string[];
  readonly projectSizes?: Record<string, number | undefined>;
  readonly expectRewrites?: boolean;
}

function select(args: SelectArgs): ReturnType<typeof selectMirrorDownloads> {
  const entries = new Map<string, AgentFileEntry>();
  for (const [rel, value] of Object.entries(args.entries)) {
    if (value !== undefined) {
      entries.set(rel, value);
    }
  }
  const sizes = args.projectSizes ?? {};
  return selectMirrorDownloads({
    candidates: args.candidates,
    entries,
    marker: 'marker' in args ? args.marker : MARKER,
    mustFetch: new Set(args.mustFetch ?? []),
    // По умолчанию размер файла в P совпадает с размером записи M (10).
    projectSizeOf: (rel) => (rel in sizes ? sizes[rel] : 10),
    expectRewrites: args.expectRewrites ?? false,
  });
}

suite('MirrorChangeWindow: selectMirrorDownloads', () => {
  test('нет метки → скачивается всё, причина no-marker', () => {
    const result = select({
      candidates: ['a', 'b'],
      entries: { a: entry('a', 1), b: entry('b', 2) },
      marker: undefined,
    });
    assert.deepStrictEqual(result.download, ['a', 'b']);
    assert.strictEqual(result.unchanged, 0);
    assert.strictEqual(result.fallback, 'no-marker');
  });

  test('старый файл с тем же размером пропускается; порядок скачиваемых — как у кандидатов', () => {
    const result = select({
      candidates: ['old1', 'new1', 'old2', 'new2'],
      entries: {
        old1: entry('old1', SINCE - 100),
        new1: entry('new1', SINCE + 5),
        old2: entry('old2', SINCE - 50),
        new2: entry('new2', SINCE + 6),
      },
    });
    assert.deepStrictEqual(result.download, ['new1', 'new2']);
    assert.strictEqual(result.unchanged, 2);
    assert.deepStrictEqual(result.sizeMismatch, []);
    assert.strictEqual(result.fallback, undefined);
  });

  test('файл из mustFetch скачивается, даже если он старый и размеры равны', () => {
    const result = select({
      candidates: ['dirty', 'clean', 'fresh'],
      entries: { dirty: entry('dirty', 1), clean: entry('clean', 1), fresh: entry('fresh', SINCE + 1) },
      mustFetch: ['dirty'],
    });
    assert.deepStrictEqual(result.download, ['dirty', 'fresh']);
    assert.strictEqual(result.unchanged, 1);
  });

  test('записи нет или у неё нет mtimeMs → файл скачивается (откат на уровне файла)', () => {
    const result = select({
      candidates: ['noEntry', 'noTime', 'old', 'fresh'],
      entries: { noTime: entry('noTime', undefined), old: entry('old', 1), fresh: entry('fresh', SINCE + 1) },
    });
    assert.deepStrictEqual(result.download, ['noEntry', 'noTime', 'fresh']);
    assert.strictEqual(result.unchanged, 1);
  });

  test('граница: секунда mtime равна порогу → скачивать; на секунду меньше → пропуск; дробная часть секунды не в счёт', () => {
    const result = select({
      candidates: ['equal', 'below', 'belowFraction', 'equalFraction'],
      entries: {
        equal: entry('equal', SINCE),
        below: entry('below', SINCE - 1),
        belowFraction: { path: 'belowFraction', type: 'file', size: 10, mtimeMs: SINCE * 1000 - 1 },
        equalFraction: { path: 'equalFraction', type: 'file', size: 10, mtimeMs: SINCE * 1000 + 999 },
      },
    });
    assert.deepStrictEqual(result.download, ['equal', 'equalFraction']);
    assert.strictEqual(result.unchanged, 2);
  });

  test('размер записи M расходится с размером файла P → скачивать и перечислить в sizeMismatch', () => {
    const result = select({
      candidates: ['same', 'diff'],
      entries: { same: entry('same', 1, 10), diff: entry('diff', 1, 10) },
      projectSizes: { diff: 11 },
    });
    assert.deepStrictEqual(result.download, ['diff']);
    assert.deepStrictEqual(result.sizeMismatch, ['diff']);
    assert.strictEqual(result.unchanged, 1);
  });

  test('размер расходится у файла из mustFetch или со свежим mtime — это не самовосстановление, в sizeMismatch не попадает', () => {
    const result = select({
      candidates: ['dirty', 'fresh'],
      entries: { dirty: entry('dirty', 1, 10), fresh: entry('fresh', SINCE + 1, 10) },
      mustFetch: ['dirty'],
      projectSizes: { dirty: 99, fresh: 99 },
    });
    assert.deepStrictEqual(result.download, ['dirty', 'fresh']);
    assert.deepStrictEqual(result.sizeMismatch, []);
  });

  test('файла нет в P → скачивать', () => {
    const result = select({
      candidates: ['absent', 'present'],
      entries: { absent: entry('absent', 1), present: entry('present', 1) },
      projectSizes: { absent: undefined },
    });
    assert.deepStrictEqual(result.download, ['absent']);
    assert.strictEqual(result.unchanged, 1);
  });

  test('растяжка: ожидалась перезапись, а свежих файлов нет → скачивается ВСЁ (в т.ч. mustFetch), причина no-rewritten-files', () => {
    const result = select({
      candidates: ['a', 'b', 'dirty'],
      entries: { a: entry('a', 1), b: entry('b', 2), dirty: entry('dirty', 3) },
      mustFetch: ['dirty'],
      expectRewrites: true,
    });
    assert.deepStrictEqual(result.download, ['a', 'b', 'dirty']);
    assert.strictEqual(result.unchanged, 0);
    assert.strictEqual(result.fallback, 'no-rewritten-files');
  });

  test('растяжка: файл без mtimeMs свежим не считается', () => {
    const result = select({
      candidates: ['a', 'b'],
      entries: { a: entry('a', undefined), b: entry('b', 1) },
      expectRewrites: true,
    });
    assert.strictEqual(result.fallback, 'no-rewritten-files');
    assert.deepStrictEqual(result.download, ['a', 'b']);
  });

  test('растяжка не срабатывает, если есть хотя бы один свежий файл', () => {
    const result = select({
      candidates: ['a', 'b'],
      entries: { a: entry('a', 1), b: entry('b', SINCE) },
      expectRewrites: true,
    });
    assert.strictEqual(result.fallback, undefined);
    assert.deepStrictEqual(result.download, ['b']);
  });

  test('растяжка не срабатывает, если все кандидаты — mustFetch (нет файлов вне него, судить не о чем)', () => {
    const result = select({
      candidates: ['d1', 'd2'],
      entries: { d1: entry('d1', 1), d2: entry('d2', 1) },
      mustFetch: ['d1', 'd2'],
      expectRewrites: true,
    });
    assert.strictEqual(result.fallback, undefined);
    assert.deepStrictEqual(result.download, ['d1', 'd2']);
  });

  test('перезаписи не ожидалось (владельцев нет) и свежих нет → пропуск разрешён', () => {
    const result = select({
      candidates: ['a', 'b'],
      entries: { a: entry('a', 1), b: entry('b', 2) },
      expectRewrites: false,
    });
    assert.deepStrictEqual(result.download, []);
    assert.strictEqual(result.unchanged, 2);
    assert.strictEqual(result.fallback, undefined);
  });

  test('пустые кандидаты: ничего не скачивается, растяжка молчит даже при expectRewrites', () => {
    for (const expectRewrites of [false, true]) {
      const result = select({ candidates: [], entries: {}, expectRewrites });
      assert.deepStrictEqual(result.download, []);
      assert.strictEqual(result.unchanged, 0);
      assert.deepStrictEqual(result.sizeMismatch, []);
      assert.strictEqual(result.fallback, undefined);
    }
  });

  test('запас MARKER_SAFETY_SEC: он уже вычтен в sinceSec, пороговые секунды разделяются ровно по since', () => {
    // since = секунда метки − запас: файл, записанный за запас до метки, ещё скачивается; на секунду раньше — нет.
    const result = select({
      candidates: ['before', 'at', 'after1', 'after2'],
      entries: {
        before: entry('before', SINCE - 1),
        at: entry('at', SINCE),
        after1: entry('after1', SINCE + 1),
        after2: entry('after2', SINCE + MARKER_SAFETY_SEC),
      },
    });
    assert.deepStrictEqual(result.download, ['at', 'after1', 'after2']);
  });
});

suite('MirrorChangeWindow: takeMirrorMarker', function () {
  this.timeout(60_000);
  let h: SyncHarness;

  setup(async () => { h = await createHarness('local'); });
  teardown(async () => { await h.dispose(); });

  const markerPath = (context: Parameters<typeof exchangeDirOf>[0]): string => `${exchangeDirOf(context)}${EXCHANGE_MIRROR_MARKER_SUFFIX}`;

  test('константы: запас — 2 с; метка — файл exchange/<op>.marker РЯДОМ с каталогом обмена (не внутри --dir архива), убирается со служебными файлами обмена', () => {
    assert.strictEqual(MARKER_SAFETY_SEC, 2);
    assert.strictEqual(EXCHANGE_MIRROR_MARKER_SUFFIX, '.marker');
    assert.ok(EXCHANGE_SIDE_SUFFIXES.includes(EXCHANGE_MIRROR_MARKER_SUFFIX));
  });

  test('локальное хранилище: пишется пустой файл метки; sinceSec = секунда метки − запас и не позже секунды последующей записи', async () => {
    const messages: string[] = [];
    const { context } = await makeContext(h, { hooks: { onMessage: (m) => { messages.push(m); } } });
    const marker = await takeMirrorMarker(context);
    await h.store.writeFile('after/file.txt', 'x');
    assert.ok(marker);
    const written = await h.store.stat(markerPath(context));
    assert.ok(written?.mtimeMs !== undefined);
    assert.strictEqual(written.size, 0, 'метка — пустой файл');
    assert.strictEqual(marker.sinceSec, Math.floor(written.mtimeMs / 1000) - MARKER_SAFETY_SEC);
    const after = await h.store.stat('after/file.txt');
    assert.ok(after?.mtimeMs !== undefined);
    assert.ok(marker.sinceSec <= Math.floor(after.mtimeMs / 1000));
    assert.deepStrictEqual(messages, [], 'при успехе сообщений нет');
  });

  test('sinceSec считается по времени СЕРВЕРА из stat, а не по часам клиента (сдвиг на час не влияет)', async () => {
    class FixedTimeStore extends DelegatingAgentFileStore {
      override async stat(rel: string): Promise<AgentFileEntry | undefined> {
        const entryValue = await super.stat(rel);
        return entryValue && { ...entryValue, mtimeMs: 1_700_000_123_456 };
      }
    }
    const { context } = await makeContext(h);
    const marker = await takeMirrorMarker({ ...context, store: new FixedTimeStore(h.store) });
    assert.deepStrictEqual(marker, { sinceSec: 1_700_000_123 - MARKER_SAFETY_SEC });
  });

  test('хранилище без mtimeMs → undefined и сообщение «Метка времени сервера не получена»', async () => {
    const messages: string[] = [];
    const { context } = await makeContext(h, { hooks: { onMessage: (m) => { messages.push(m); } } });
    const marker = await takeMirrorMarker({ ...context, store: new MtimeShapingAgentFileStore(h.store, { stripMtime: true }) });
    assert.strictEqual(marker, undefined);
    assert.strictEqual(messages.length, 1, messages.join(' | '));
    assert.match(messages[0], /^Метка времени сервера не получена \(.+\): файлы изменённых объектов будут сравниваться целиком/);
  });

  test('запись метки отказала → undefined и сообщение с причиной; операция не падает', async () => {
    const messages: string[] = [];
    const { context } = await makeContext(h, { hooks: { onMessage: (m) => { messages.push(m); } } });
    const store = new MtimeShapingAgentFileStore(h.store, { failWriteIncluding: EXCHANGE_MIRROR_MARKER_SUFFIX });
    const marker = await takeMirrorMarker({ ...context, store });
    assert.strictEqual(marker, undefined);
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0], /^Метка времени сервера не получена \(.*запись метки отказала.*\)/);
  });

  test('сообщение не обязательно: без хуков отказ тоже даёт undefined', async () => {
    const { context } = await makeContext(h);
    const store = new MtimeShapingAgentFileStore(h.store, { failWriteIncluding: EXCHANGE_MIRROR_MARKER_SUFFIX });
    assert.strictEqual(await takeMirrorMarker({ ...context, store }), undefined);
  });

  for (const [label, makeError] of [
    ['отмена синхронизации', () => new AgentSyncCancelledError()],
    ['отмена передачи', () => new AgentTransferCancelledError()],
  ] as const) {
    test(`${label} при записи метки пробрасывается, а не превращается в «метка не получена»`, async () => {
      const messages: string[] = [];
      const { context } = await makeContext(h, { hooks: { onMessage: (m) => { messages.push(m); } } });
      class CancellingStore extends DelegatingAgentFileStore {
        override writeFile(): Promise<void> { return Promise.reject(makeError()); }
      }
      await assert.rejects(
        takeMirrorMarker({ ...context, store: new CancellingStore(h.store) }),
        (error: unknown) => error instanceof AgentSyncCancelledError || error instanceof AgentTransferCancelledError
      );
      assert.deepStrictEqual(messages, []);
    });
  }

  test('после полной операции импорта метки на сервере нет (каталог обмена убран движком)', async () => {
    h.seedDb();
    await h.importTarget();
    const exchange = path.join(h.userRoot, 'exchange');
    const leftovers = fs.existsSync(exchange) ? fs.readdirSync(exchange) : [];
    assert.deepStrictEqual(leftovers, []);
  });
});
