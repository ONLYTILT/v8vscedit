import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AgentSyncCancelledError } from '../../infra/agent/sync/SyncContext';
import { buildScopeKey, loadHashCache } from '../../infra/cache/HashCache';
import { scanHashSnapshot, type HashScanOptions } from '../../infra/cache/HashScanner';
import { ageAgentTree, hasOption } from './support/agentConfigEmulator';
import { createHarness, HARNESS_EXTENSION_NAME, type HarnessKind, type HarnessOptions, type SyncHarness } from './support/agentSyncHarness';
import { RICH_DOCUMENT_FILES, importHookSpy, seedRichDocument } from './support/archiveAvoidFixtures';
import { assertOnce } from './support/deltaMtimeFixtures';
import {
  ORDER_FILES,
  ROOT_PART_FILE,
  assertCommon,
  removeRootPart,
  seedRootPart,
  startAvoidHarness,
  type AvoidStartOptions,
} from './support/fullDumpAvoidFixtures';
import { countingFs, futureNow, type CountingFs } from './support/hashScanFixtures';

/**
 * Базовая линия B после импорта (plan-fast-baseline.md §2.1, §2.3): путь дельты не делает второго полного
 * прохода по выгрузке — B = снимок P операции + перехеширование записанного. Инвариант КАЖДОГО сценария:
 * манифест B и HashCache детектора deep-equal `scanHashSnapshot(P)` после операции. Строки итога в журнале
 * называют режим (по изменённым файлам / полный проход и причина). Обращения к P считает `countingFs` над
 * настоящей ФС (шов `hashScan` движка); время итоговой строки — внедрённые часы `baselineClock`.
 *
 * Не тестируется как исправленное: двойной снимок P при посеве из проекта (вне задачи).
 */

const INCREMENTAL = /^Базовая линия синхронизации: по изменённым файлам — перехешировано (\d+), удалено (\d+), (\d+) мс$/;
const FULL_LINE = (reason: string): RegExp =>
  new RegExp(`^Базовая линия синхронизации: полный проход \\(${reason}\\) — файлов \\d+, перехешировано \\d+ \\(racy \\d+\\), \\d+ мс$`);
const BASELINE_PREFIX = 'Базовая линия синхронизации: ';
const SNAPSHOT_ZERO = /^Проверка локальных изменений проекта: файлов (\d+), перехешировано (\d+) \(racy (\d+)\), (\d+) мс$/;

const REASON_TEXT = {
  compare: 'полное сравнение с локальным зеркалом',
  archive: 'импорт архивом',
  caseMismatch: 'пути, отличающиеся только регистром',
} as const;

const FORM_BODY = 'Documents/Заказ/Forms/Форма/Ext/Form.xml';
const FORM_V2 = '<FormBody>v2</FormBody>';
const BOM = String.fromCharCode(0xfeff);

const scopeKeyOf = (h: SyncHarness): string =>
  h.targetKind === 'cf' ? buildScopeKey('cf', h.configRoot) : buildScopeKey('cfe', h.configRoot, HARNESS_EXTENSION_NAME);

const fullScan = async (h: SyncHarness): Promise<Record<string, string>> => (await scanHashSnapshot(undefined, '', h.configRoot)).files;

/** Главный инвариант: B и базовая линия детектора равны полному проходу по P. */
async function assertBaselineEqualsFullScan(h: SyncHarness): Promise<void> {
  const full = await fullScan(h);
  assert.deepStrictEqual(h.manifest().files, full, 'манифест B ≡ полный проход');
  assert.deepStrictEqual(loadHashCache(h.projectRoot, scopeKeyOf(h)).files, full, 'HashCache ≡ полный проход');
}

function hashCacheBytes(h: SyncHarness): Buffer | undefined {
  const file = path.join(h.projectRoot, '.v8vscedit', 'cache', `${crypto.createHash('sha1').update(scopeKeyOf(h)).digest('hex')}.json`);
  return fs.existsSync(file) ? fs.readFileSync(file) : undefined;
}

function incrementalCounts(messages: readonly string[]): { rehashed: number; removed: number } {
  const line = assertOnce(messages, INCREMENTAL);
  const match = INCREMENTAL.exec(line);
  assert.ok(match);
  return { rehashed: Number(match[1]), removed: Number(match[2]) };
}

interface Scan { readonly counting: CountingFs; readonly hashScan: Omit<HashScanOptions, 'onReport' | 'signal'> }

function newScan(): Scan {
  const counting = countingFs();
  return { counting, hashScan: { fs: counting, now: futureNow } };
}

suite('AgentSyncEngine: базовая линия после импорта (sftp, цель cf)', function () {
  this.timeout(180_000);
  let h: SyncHarness;
  let from = 0;
  let scan: Scan;

  async function begin(options: Omit<AvoidStartOptions, 'harness'>, baselineClock?: () => number): Promise<void> {
    scan = newScan();
    h = await startAvoidHarness({ ...options, harness: { hashScan: scan.hashScan, ...(baselineClock === undefined ? {} : { baselineClock }) } });
    ageAgentTree(h.mirrorAbs);
    from = h.emulator.commands.length;
    scan.counting.reset();
  }
  teardown(async () => { await h.dispose(); });

  test('E1 дельта: один измененный владелец → по изменённым файлам, перехешировано 1; полный обход P один (снимок №0); итоговая строка с внедрёнными часами', async () => {
    await begin({ coverage: 'full' }, () => 5);
    h.emulator.putFile(FORM_BODY, FORM_V2);
    const spy = importHookSpy();

    const result = await h.importTarget(spy.hooks);

    assert.strictEqual(result.strategy, 'delta');
    assert.deepStrictEqual(incrementalCounts(spy.messages), { rehashed: 1, removed: 0 });
    assert.ok(spy.messages.includes('Базовая линия синхронизации: по изменённым файлам — перехешировано 1, удалено 0, 0 мс'), spy.messages.join(' | '));
    assert.strictEqual(scan.counting.counts.readFile, 1, 'P читается только в записанном файле: снимок №0 берёт хеши из мемо');
    await assertBaselineEqualsFullScan(h);
    await assertCommon(h, from, 'full');
  });

  test('E1б полных обходов за операцию ровно один: каталог Roles (не затронут операцией) обходится 1 раз', async () => {
    await begin({ coverage: 'full' });
    h.emulator.putFile(FORM_BODY, FORM_V2);
    const rolesDir = path.join(h.configRoot, 'Roles');
    let roles = 0;
    scan.counting.beforeReaddir = (dir) => { if (dir === rolesDir) { roles += 1; } };

    await h.importTarget();

    assert.strictEqual(roles, 1, 'снимок №0 — единственный полный обход');
    await assertBaselineEqualsFullScan(h);
  });

  for (const coverage of ['full', 'sparse'] as const) {
    test(`E2 удалён владелец (FullDump pruned, M ${coverage}) + изменён другой: удалённые файлы не в B, режим по изменённым файлам`, async () => {
      await begin({ coverage });
      h.emulator.removeObject('Document.Заказ');
      h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>Клиенты v2</Catalog>');
      const spy = importHookSpy();

      const result = await h.importTarget(spy.hooks);

      assert.strictEqual(result.fullDump?.handling, 'pruned');
      for (const rel of ORDER_FILES) {
        assert.ok(!(rel in h.manifest().files), `${rel} не в B`);
        assert.ok(!h.existsP(rel));
      }
      const counts = incrementalCounts(spy.messages);
      assert.ok(counts.removed >= ORDER_FILES.length, `удалено ${String(counts.removed)}`);
      await assertBaselineEqualsFullScan(h);
      await assertCommon(h, from, coverage);
    });
  }

  test('E5 mirror-rewrite (updateKind rewrite): пропавшая часть корня удалена, режим по изменённым файлам, инвариант', async () => {
    await begin({ coverage: 'full', seed: seedRootPart });
    removeRootPart(h.emulator);
    const spy = importHookSpy();

    const result = await h.importTarget(spy.hooks);

    assert.strictEqual(result.fullDump?.handling, 'mirror-rewrite');
    assert.ok(!(ROOT_PART_FILE in h.manifest().files));
    assert.ok(incrementalCounts(spy.messages).removed >= 1);
    await assertBaselineEqualsFullScan(h);
    await assertCommon(h, from, 'full');
  });

  test('E6 грязный файл, равный M (не перезаписан): в B его текущий хеш, правка пользователя в P сохранена', async () => {
    await begin({ coverage: 'full' });
    const dirty = '<Catalog>Клиенты общая правка</Catalog>';
    h.writeP('Catalogs/Клиенты.xml', dirty);
    h.emulator.putFile('Catalogs/Клиенты.xml', dirty);
    h.emulator.putFile(FORM_BODY, FORM_V2);
    const spy = importHookSpy();

    await h.importTarget(spy.hooks);

    assert.strictEqual(h.readP('Catalogs/Клиенты.xml'), dirty);
    assert.strictEqual(h.manifest().files['Catalogs/Клиенты.xml'], crypto.createHash('sha1').update(dirty).digest('hex'));
    assert.strictEqual(incrementalCounts(spy.messages).removed, 0);
    await assertBaselineEqualsFullScan(h);
  });

  test('E6б грязный файл НЕ затронутого владельца, отличный от M: импорт восстанавливает его из M (план включает все грязные файлы), файл попадает в перехешированные, B равна полному проходу', async () => {
    await begin({ coverage: 'full' });
    h.writeP('Roles/Админ.xml', '<Role>ручная правка</Role>');
    h.emulator.putFile(FORM_BODY, FORM_V2);
    const spy = importHookSpy();

    await h.importTarget(spy.hooks);

    assert.strictEqual(h.readP('Roles/Админ.xml'), '<Role>Админ</Role>');
    assert.deepStrictEqual(incrementalCounts(spy.messages), { rehashed: 2, removed: 0 });
    await assertBaselineEqualsFullScan(h);
  });

  test('E9 переименование владельца только регистром: инвариант на любой платформе; на win32 — полный проход «пути, отличающиеся только регистром»', async () => {
    await begin({ coverage: 'full' });
    h.emulator.removeObject('Catalog.Товары');
    h.emulator.setObject('Catalog.товары', {
      'Catalogs/товары.xml': '<Catalog>товары</Catalog>',
      'Catalogs/товары/Ext/ObjectModule.bsl': 'Процедура Товары() КонецПроцедуры',
    });
    const spy = importHookSpy();

    await h.importTarget(spy.hooks);

    if (process.platform === 'win32') {
      assertOnce(spy.messages, FULL_LINE(REASON_TEXT.caseMismatch));
    } else {
      assert.ok(spy.messages.some((message) => message.startsWith(BASELINE_PREFIX)), spy.messages.join(' | '));
    }
    await assertBaselineEqualsFullScan(h);
    await assertCommon(h, from, 'full');
  });

  test('E10а отмена до записи: манифест и HashCache побайтно прежние, строки итога B в журнале нет', async () => {
    await begin({ coverage: 'full' });
    h.emulator.putFile(FORM_BODY, FORM_V2);
    const manifestBefore = h.rawManifestText();
    const cacheBefore = hashCacheBytes(h);
    const cancellation = { isCancellationRequested: false };
    const spy = importHookSpy({
      extra: { cancellation, onProgress: (event) => { if (event.text === 'Запрос списка изменений базы у агента…') { cancellation.isCancellationRequested = true; } } },
    });

    await assert.rejects(h.importTarget(spy.hooks), (error: unknown) => error instanceof AgentSyncCancelledError);

    assert.strictEqual(h.rawManifestText(), manifestBefore);
    assert.ok(cacheBefore && hashCacheBytes(h)?.equals(cacheBefore), 'HashCache побайтно прежний');
    assert.ok(!spy.messages.some((message) => message.startsWith(BASELINE_PREFIX)), spy.messages.join(' | '));
  });

  test('E10б ошибка агента до записи: манифест и HashCache побайтно прежние, строки итога B нет', async () => {
    await begin({ coverage: 'full' });
    h.emulator.putFile(FORM_BODY, FORM_V2);
    const manifestBefore = h.rawManifestText();
    const cacheBefore = hashCacheBytes(h);
    h.emulator.failWhen = (cmd) => (hasOption(cmd, 'get-changes') ? new Error('обрыв транспорта') : undefined);
    const spy = importHookSpy();

    await assert.rejects(h.importTarget(spy.hooks), /обрыв транспорта/);

    assert.strictEqual(h.rawManifestText(), manifestBefore);
    assert.ok(cacheBefore && hashCacheBytes(h)?.equals(cacheBefore));
    assert.ok(!spy.messages.some((message) => message.startsWith(BASELINE_PREFIX)));
  });

  test('E11 строка снимка №0: «Проверка локальных изменений проекта: файлов N, перехешировано H (racy R), T мс» на пути дельты', async () => {
    await begin({ coverage: 'full' });
    const trackedBefore = Object.keys(await fullScan(h)).length;
    h.emulator.putFile(FORM_BODY, FORM_V2);
    const spy = importHookSpy();

    await h.importTarget(spy.hooks);

    const line = assertOnce(spy.messages, SNAPSHOT_ZERO);
    const match = SNAPSHOT_ZERO.exec(line);
    assert.ok(match);
    assert.strictEqual(Number(match[1]), trackedBefore);
    assert.strictEqual(match[2], '0', 'неизменённые файлы взяты из мемо');
    assert.strictEqual(match[3], '0');
    const order = [
      spy.messages.findIndex((message) => message === 'Проверка локальных изменений проекта…'),
      spy.messages.indexOf(line),
      spy.messages.findIndex((message) => message === 'Сохранение базовой линии синхронизации…'),
      spy.messages.findIndex((message) => INCREMENTAL.test(message)),
    ];
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order, `порядок строк: ${spy.messages.join(' | ')}`);
    assert.ok(order.every((index) => index >= 0));
  });
});

suite('AgentSyncEngine: базовая линия после импорта — посев, точечная выгрузка, архив, локальный агент', function () {
  this.timeout(180_000);
  let h: SyncHarness | undefined;
  teardown(async () => { await h?.dispose(); h = undefined; });

  async function start(kind: HarnessKind, extra: HarnessOptions = {}): Promise<{ h: SyncHarness; scan: Scan }> {
    const scan = newScan();
    h = await createHarness(kind, { hashScan: scan.hashScan, ...extra });
    h.seedDb();
    h.emulator.setConfiguration('Основная', 'cf');
    return { h, scan };
  }

  test('E3 посев из проекта с удалением сирот: сироты не в B, режим по изменённым файлам, инвариант', async () => {
    const { h: harness } = await start('sftp');
    const orphanFiles = ['Catalogs/Удалённый.xml', 'Catalogs/Удалённый/Ext/ObjectModule.bsl'];
    harness.emulator.setObject('Catalog.Удалённый', {
      'Catalogs/Удалённый.xml': '<Catalog>Удалённый</Catalog>',
      'Catalogs/Удалённый/Ext/ObjectModule.bsl': 'Процедура У() КонецПроцедуры',
    });
    harness.emulator.snapshotToProject(harness.configRoot);
    harness.emulator.removeObject('Catalog.Удалённый');
    harness.emulator.snapshotToProject(harness.configRoot);
    harness.emulator.setObject('Catalog.Новый', { 'Catalogs/Новый.xml': '<Catalog>Новый</Catalog>' });
    const spy = importHookSpy({ seed: 'seed', orphans: true });

    const result = await harness.importTarget(spy.hooks);

    assert.strictEqual(result.seededFrom, 'project');
    for (const rel of orphanFiles) {
      assert.ok(!harness.existsP(rel));
      assert.ok(!(rel in harness.manifest().files), `${rel} не в B`);
    }
    assert.ok(incrementalCounts(spy.messages).removed >= orphanFiles.length);
    await assertBaselineEqualsFullScan(harness);
  });

  test('E4 разреженный M + точечная выгрузка (restoreFromDatabase): правки restore учтены, инвариант, режим по изменённым файлам', async () => {
    const { h: harness } = await start('sftp');
    seedRichDocument(harness.emulator);
    harness.emulator.snapshotToProject(harness.configRoot);
    await harness.importTarget(importHookSpy({ seed: 'seed' }).hooks);
    assert.strictEqual(harness.manifest().mirrorCoverage, 'sparse');
    harness.emulator.updateGranularity = 'changed-files';
    const formBody = 'Documents/Д/Forms/Ф/Ext/Form.xml';
    const template = 'Documents/Д/Templates/М.xml';
    harness.writeP(formBody, '<FormBody>моя правка</FormBody>');
    harness.removeP(template);
    harness.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
    const spy = importHookSpy();

    const result = await harness.importTarget(spy.hooks);

    assert.strictEqual(result.restoredFromDatabase, 2);
    assert.strictEqual(harness.readP(formBody), RICH_DOCUMENT_FILES[formBody]);
    assert.strictEqual(harness.manifest().files[formBody], (await fullScan(harness))[formBody]);
    assert.ok(template in harness.manifest().files, 'восстановленный макет — в B');
    assert.ok(incrementalCounts(spy.messages).rehashed >= 3);
    await assertBaselineEqualsFullScan(harness);
  });

  const archiveScenarios: readonly {
    readonly reason: string;
    readonly prepare: (harness: SyncHarness) => Promise<void>;
    readonly options?: { archiveThresholdFiles: number };
    readonly decision?: 'dump';
  }[] = [
    { reason: 'mirror-empty', prepare: () => Promise.resolve() },
    {
      reason: 'over-threshold',
      options: { archiveThresholdFiles: 5 },
      decision: 'dump',
      prepare: async (harness) => {
        await harness.importTarget();
        for (const rel of ['Catalogs/Товары.xml', 'Roles/Админ.xml', 'Catalogs/Клиенты.xml', 'CommonModules/Общий.xml']) {
          harness.emulator.putFile(rel, `<Changed>v2 ${rel}</Changed>`);
        }
      },
    },
    {
      reason: 'unresolved-objects',
      decision: 'dump',
      prepare: async (harness) => {
        await harness.importTarget();
        harness.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
        harness.emulator.nextChangesText = `${BOM}Modified: Foo.Bar\r\nModified: Catalog.Клиенты\r\n`;
      },
    },
  ];
  for (const { reason, prepare, options, decision } of archiveScenarios) {
    test(`E7 архив (${reason}): полный проход «импорт архивом», инвариант`, async () => {
      const { h: harness } = await start('sftp', options);
      await prepare(harness);
      const spy = importHookSpy(decision === undefined ? {} : { fullDump: decision });

      const result = await harness.importTarget(spy.hooks);

      assert.strictEqual(result.strategy, 'archive');
      assert.strictEqual(result.reason, reason);
      assertOnce(spy.messages, FULL_LINE(REASON_TEXT.archive));
      assert.ok(!spy.messages.some((message) => INCREMENTAL.test(message)));
      await assertBaselineEqualsFullScan(harness);
    });
  }

  test('E8 локальный агент (compare): полный проход «полное сравнение с локальным зеркалом», инвариант', async () => {
    const { h: harness } = await start('local');
    await harness.importTarget();
    harness.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>Клиенты v2</Catalog>');
    const spy = importHookSpy();

    const result = await harness.importTarget(spy.hooks);

    assert.strictEqual(result.strategy, 'compare');
    assertOnce(spy.messages, FULL_LINE(REASON_TEXT.compare));
    assert.ok(!spy.messages.some((message) => INCREMENTAL.test(message)));
    await assertBaselineEqualsFullScan(harness);
  });
});
