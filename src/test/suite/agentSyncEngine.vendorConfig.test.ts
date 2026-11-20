import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ageAgentTree, type AgentConfigEmulator } from './support/agentConfigEmulator';
import { createHarness, dbAsText, type SyncHarness } from './support/agentSyncHarness';
import { importHookSpy, seedBulkOwners } from './support/archiveAvoidFixtures';
import { assertOnce } from './support/deltaMtimeFixtures';
import { assertCommon, removeRootPart, seedRootPart, startAvoidHarness } from './support/fullDumpAvoidFixtures';
import {
  BOM,
  LARGE_SIZE,
  LARGE_THRESHOLD,
  ROOT_MODULE,
  ROOT_OWNER,
  VENDOR_BIN,
  VENDOR_CF,
  WARN_BYTES,
  agePFile,
  bigBytes,
  bytesInDb,
  bytesInP,
  mtimeOfP,
  opsAt,
  seedVendor,
  updateVendor,
  wasOpened,
} from './support/largeFilesFixtures';

/**
 * Шлюз конфигурации поставщика на движке (plan-large-files.md §1, §5.3 тесты 18–28; SFTP, ФАКТЫ Э26/Э27).
 * `Ext/ParentConfigurations/*.cf` — до гигабайта, платформе нужные только при загрузке — скачивается лишь при
 * доказанном изменении части; `Ext/ParentConfigurations.bin` идёт по обычным правилам и служит страховкой (изменился
 * `.bin` — качаем `.cf`). Шлюз включён по умолчанию: его безопасность держится не на одном списке изменений.
 *
 * Эмулятор — в режиме факта стенда: список даёт ТОЛЬКО изменившиеся части (`changed-parts`), `--update` корня
 * переписывает все файлы корня (`rewriteWholeRootOnUpdate`) — значит `.cf` оказывается кандидатом при любой правке
 * корня, и пропустить его может только шлюз. Скачанное считается по журналу OPEN настоящего SFTP-сервера.
 *
 * ВАЖНО для реализации: `.bin` и `.cf` НЕ входят в манифест B (отслеживаются только `.xml`/`.bsl`/макеты — `isSupportedConfigFile`),
 * поэтому «вне B» для шлюзуемого файла не причина качать (иначе шлюз не сработал бы никогда); `mustFetch` шлюзуемого —
 * грязный относительно B (для файлов вне B не бывает) или совпадающий с удаляемым без учёта регистра.
 */

const SKIP_LINE = /^Конфигурация поставщика не изменилась \(по списку изменений агента\): пропущено файлов — 1, 300,0 КБ \(.*Ext\/ParentConfigurations\/.*\)\.$/;
const HARNESS = { largeFileThresholdBytes: LARGE_THRESHOLD, largeFileWarnBytes: WARN_BYTES };
const INSURANCE_LINE = /не упоминает конфигурацию поставщика, но ParentConfigurations\.bin изменился — файлы поставщика скачиваются/;
const PARTS_LINE = 'Части корня в списке изменений: ManagedApplicationModule';

suite('AgentSyncEngine: шлюз конфигурации поставщика (sftp)', function () {
  this.timeout(180_000);
  let h: SyncHarness;
  let from = 0;

  /** Стенд: корень с `.bin` и `.cf`, M полный (или разреженный), режим эмулятора — факт стенда, журнал SFTP очищен. */
  async function begin(options: { readonly seed?: (emulator: AgentConfigEmulator) => void; readonly coverage?: 'full' | 'sparse' } = {}): Promise<void> {
    h = await startAvoidHarness({
      coverage: options.coverage ?? 'full',
      seed: (emulator) => { seedVendor(emulator); options.seed?.(emulator); },
      harness: HARNESS,
    });
    h.emulator.changeLines = 'changed-parts';
    h.emulator.rewriteWholeRootOnUpdate = true;
    ageAgentTree(h.mirrorAbs);
    from = h.emulator.commands.length;
    h.sftp?.log.splice(0);
  }
  teardown(async () => { await h.dispose(); });

  const putRootModule = (text = 'Процедура ПриНачале() КонецПроцедуры'): void => { h.emulator.putFile(ROOT_MODULE, text); };

  function assertPEqualsDb(): void {
    const actual = h.snapshotP();
    delete actual['ConfigDumpInfo.xml'];
    assert.deepStrictEqual(actual, dbAsText(h.emulator.dbTrackedFiles()), 'P ≡ БД');
  }

  // ── 18. правка только модуля корня ────────────────────────────────────────────────────────────

  test('18. изменён только модуль корня: .cf не открывался, .bin обработан по обычным правилам (прочитан, равен P — не записан), журнал называет пропуск и его объём, P .cf не тронут', async () => {
    await begin();
    const cfMtime = agePFile(h, VENDOR_CF);
    const binMtime = agePFile(h, VENDOR_BIN);
    putRootModule();
    const messages: string[] = [];

    const result = await h.importTarget({ onMessage: (message) => { messages.push(message); } });

    assert.strictEqual(result.strategy, 'delta');
    assert.ok(!wasOpened(h, VENDOR_CF), '.cf поставщика не открывался');
    assert.ok(wasOpened(h, VENDOR_BIN), '.bin прочитан — он не шлюзуется');
    assertOnce(messages, SKIP_LINE);
    assertOnce(messages, PARTS_LINE);
    assert.strictEqual(mtimeOfP(h, VENDOR_CF), cfMtime, '.cf в P не тронут');
    assert.strictEqual(mtimeOfP(h, VENDOR_BIN), binMtime, '.bin равен P — не записан');
    assert.ok(result.changedProjectFiles.some((file) => file.endsWith('ManagedApplicationModule.bsl')), 'модуль записан');
    assert.ok(!result.changedProjectFiles.some((file) => file.endsWith('Поставщик.cf')));
    await assertCommon(h, from, 'full');
  });

  test('18б. повторный импорт без изменений: «нет изменений» — .cf не открывается, ничего не записано', async () => {
    await begin();
    putRootModule();
    await h.importTarget();
    h.sftp?.log.splice(0);

    const result = await h.importTarget();

    assert.deepStrictEqual(result.changedProjectFiles, []);
    assert.ok(!wasOpened(h, VENDOR_CF));
  });

  test('18в. две части корня в списке: диагностика называет обе, отсортированно', async () => {
    await begin();
    putRootModule();
    h.emulator.putFile('Ext/CommandInterface.xml', '<CommandInterface/>');
    const messages: string[] = [];

    await h.importTarget({ onMessage: (message) => { messages.push(message); } });

    assertOnce(messages, 'Части корня в списке изменений: CommandInterface, ManagedApplicationModule');
    assert.ok(!wasOpened(h, VENDOR_CF));
  });

  test('18г. изменён обычный объект, корня в списке нет: .cf не кандидат, строки о пропуске нет', async () => {
    await begin();
    h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
    const messages: string[] = [];

    await h.importTarget({ onMessage: (message) => { messages.push(message); } });

    assert.ok(!wasOpened(h, VENDOR_CF));
    assert.ok(!messages.some((message) => message.startsWith('Конфигурация поставщика')), messages.join(' | '));
    assert.strictEqual(h.readP('Catalogs/Товары.xml'), '<Catalog>Товары v2</Catalog>');
  });

  test('18д. ФАКТ Э27 без «переписать весь корень»: --update записал только изменённое — .cf не кандидат и не открывался', async () => {
    await begin();
    h.emulator.rewriteWholeRootOnUpdate = false;
    putRootModule();
    const messages: string[] = [];

    await h.importTarget({ onMessage: (message) => { messages.push(message); } });

    assert.ok(!wasOpened(h, VENDOR_CF));
    assert.ok(!messages.some((message) => message.startsWith('Конфигурация поставщика не изменилась')), 'пропускать нечего: файл не кандидат');
    await assertCommon(h, from, 'full');
  });

  test('18е. конфигурации поставщика в выгрузке нет: корень изменён — прежнее поведение, строки о поставщике нет', async () => {
    h = await startAvoidHarness({ coverage: 'full', harness: HARNESS });
    h.emulator.changeLines = 'changed-parts';
    h.emulator.rewriteWholeRootOnUpdate = true;
    ageAgentTree(h.mirrorAbs);
    from = h.emulator.commands.length;
    putRootModule();
    const messages: string[] = [];

    await h.importTarget({ onMessage: (message) => { messages.push(message); } });

    assert.ok(!messages.some((message) => message.startsWith('Конфигурация поставщика')), messages.join(' | '));
    await assertCommon(h, from, 'full');
  });

  // ── 19. обновление поставщика ─────────────────────────────────────────────────────────────────

  test('19. изменена часть ParentConfigurations (меняются .bin и .cf): оба скачаны и записаны побайтно, строки о пропуске нет', async () => {
    await begin();
    updateVendor(h.emulator);
    const messages: string[] = [];

    const result = await h.importTarget({ onMessage: (message) => { messages.push(message); } });

    assert.ok(wasOpened(h, VENDOR_CF), '.cf скачан');
    assert.ok(wasOpened(h, VENDOR_BIN));
    assert.ok(bytesInP(h, VENDOR_CF).equals(bytesInDb(h, VENDOR_CF)));
    assert.ok(bytesInP(h, VENDOR_BIN).equals(bytesInDb(h, VENDOR_BIN)));
    assert.ok(result.changedProjectFiles.some((file) => file.endsWith('Поставщик.cf')));
    assert.ok(!messages.some((message) => message.startsWith('Конфигурация поставщика не изменилась')), messages.join(' | '));
    assertOnce(messages, 'Части корня в списке изменений: ParentConfigurations');
    await assertCommon(h, from, 'full');
  });

  test('19б. изменилась только часть ParentConfigurations в списке, .bin в M равен P (повторная поставка той же версии): .cf всё равно скачан', async () => {
    await begin();
    h.emulator.putFile(VENDOR_CF, bigBytes(LARGE_SIZE, 77));

    await h.importTarget();

    assert.ok(wasOpened(h, VENDOR_CF));
    assert.ok(bytesInP(h, VENDOR_CF).equals(bytesInDb(h, VENDOR_CF)));
  });

  // ── 20. страховка .bin ────────────────────────────────────────────────────────────────────────

  test('20. страховка: список без части, но .bin в M отличается от P — .cf скачан и записан, в журнале предупреждение', async () => {
    await begin();
    updateVendor(h.emulator);
    h.emulator.nextChangesText = `${BOM}Modified: ${ROOT_OWNER}\r\n`;
    const messages: string[] = [];

    await h.importTarget({ onMessage: (message) => { messages.push(message); } });

    assert.ok(wasOpened(h, VENDOR_CF), '.cf скачан по страховке');
    assert.ok(bytesInP(h, VENDOR_CF).equals(bytesInDb(h, VENDOR_CF)));
    assert.ok(bytesInP(h, VENDOR_BIN).equals(bytesInDb(h, VENDOR_BIN)));
    assertOnce(messages, INSURANCE_LINE);
    assert.ok(!messages.some((message) => message.startsWith('Конфигурация поставщика не изменилась')), messages.join(' | '));
    await assertCommon(h, from, 'full');
  });

  test('20б. страховка: .bin пропал в M при наличии .cf — .cf скачан, .bin удалён из P', async () => {
    await begin();
    h.emulator.removeFiles([VENDOR_BIN]);

    await h.importTarget();

    assert.ok(wasOpened(h, VENDOR_CF), '.cf скачан: набор файлов поставщика изменился');
    assert.ok(!h.existsP(VENDOR_BIN), '.bin удалён из P');
    assertPEqualsDb();
  });

  // ── 21. самовосстановление ────────────────────────────────────────────────────────────────────

  test('21. .cf нет в P: скачан и записан (корень изменён, часть не в списке)', async () => {
    await begin();
    h.removeP(VENDOR_CF);
    putRootModule();

    await h.importTarget();

    assert.ok(wasOpened(h, VENDOR_CF));
    assert.ok(bytesInP(h, VENDOR_CF).equals(bytesInDb(h, VENDOR_CF)));
    await assertCommon(h, from, 'full');
  });

  test('21б. размер .cf в P ≠ размеру в M: скачан и исправлен (самовосстановление)', async () => {
    await begin();
    h.writeP(VENDOR_CF, bigBytes(LARGE_SIZE + 10, 3));
    putRootModule();

    await h.importTarget();

    assert.ok(wasOpened(h, VENDOR_CF));
    assert.ok(bytesInP(h, VENDOR_CF).equals(bytesInDb(h, VENDOR_CF)));
    await assertCommon(h, from, 'full');
  });

  // ── 23. нет меток времени ─────────────────────────────────────────────────────────────────────

  test('23. сервер без времён (attrsWithoutTimes): отбор по mtime недоступен, но шлюз всё равно не даёт скачать .cf', async () => {
    await begin();
    assert.ok(h.sftp);
    h.sftp.attrsWithoutTimes = true;
    putRootModule();
    const messages: string[] = [];

    await h.importTarget({ onMessage: (message) => { messages.push(message); } });

    assert.ok(messages.some((message) => message.startsWith('Метка времени сервера не получена')), messages.join(' | '));
    assert.ok(!wasOpened(h, VENDOR_CF), 'шлюз не зависит от mtime');
    assertOnce(messages, SKIP_LINE);
    await assertCommon(h, from, 'full');
  });

  // ── 24. FullDump → очистка зеркала ────────────────────────────────────────────────────────────

  test('24. FullDump → очистка зеркала (удалён объект + изменён корень): по ПОВТОРНОМУ списку без части .cf не скачан', async () => {
    await begin();
    h.emulator.removeObject('Catalog.Клиенты');
    putRootModule();
    const spy = importHookSpy({ fullDump: 'cancel' });

    const result = await h.importTarget(spy.hooks);

    assert.strictEqual(result.fullDump?.handling, 'pruned');
    assert.ok(!wasOpened(h, VENDOR_CF));
    assertOnce(spy.messages, SKIP_LINE);
    assert.ok(!h.existsP('Catalogs/Клиенты.xml'));
    await assertCommon(h, from, 'full');
  });

  test('24б. FullDump → очистка зеркала, поставщик обновлён: .cf скачан и записан', async () => {
    await begin();
    h.emulator.removeObject('Catalog.Клиенты');
    updateVendor(h.emulator);

    const result = await h.importTarget(importHookSpy({ fullDump: 'cancel' }).hooks);

    assert.strictEqual(result.fullDump?.handling, 'pruned');
    assert.ok(wasOpened(h, VENDOR_CF));
    assert.ok(bytesInP(h, VENDOR_CF).equals(bytesInDb(h, VENDOR_CF)));
  });

  // ── 25. FullDump → перезапись зеркала ─────────────────────────────────────────────────────────

  test('25. FullDump → перезапись зеркала: запись …ParentConfigurations файла версий не изменилась — .cf не скачан, хотя сервер переписал весь M', async () => {
    await begin({ seed: seedRootPart });
    h.emulator.fullDumpUpdate = 'rewrite-all';
    removeRootPart(h.emulator);
    h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
    const spy = importHookSpy({ fullDump: 'dump' });

    const result = await h.importTarget(spy.hooks);

    assert.strictEqual(result.fullDump?.handling, 'mirror-rewrite');
    assert.ok(!wasOpened(h, VENDOR_CF));
    assert.ok(wasOpened(h, VENDOR_BIN), '.bin идёт по обычным правилам');
    assertOnce(spy.messages, SKIP_LINE);
    await assertCommon(h, from, 'full');
  });

  test('25б. FullDump → перезапись зеркала, запись …ParentConfigurations изменилась: .cf скачан и записан', async () => {
    await begin({ seed: seedRootPart });
    h.emulator.fullDumpUpdate = 'rewrite-all';
    removeRootPart(h.emulator);
    updateVendor(h.emulator);

    const result = await h.importTarget(importHookSpy({ fullDump: 'dump' }).hooks);

    assert.strictEqual(result.fullDump?.handling, 'mirror-rewrite');
    assert.ok(wasOpened(h, VENDOR_CF));
    assert.ok(bytesInP(h, VENDOR_CF).equals(bytesInDb(h, VENDOR_CF)));
    await assertCommon(h, from, 'full');
  });

  // ── 26. нераспознанный список ─────────────────────────────────────────────────────────────────

  test('26. нераспознанный список → архив: поведение прежнее, шлюз не участвует — .cf не читается отдельно, строки о поставщике нет', async () => {
    await begin();
    putRootModule();
    h.emulator.nextChangesText = `${BOM}Deleted: Catalog.Клиенты\r\n`;
    const messages: string[] = [];

    const result = await h.importTarget({ onMessage: (message) => { messages.push(message); } });

    assert.strictEqual(result.strategy, 'archive');
    assert.strictEqual(opsAt(h, 'READ', 'Поставщик.cf'), 0, 'выгрузка целиком одним архивом');
    assert.ok(!messages.some((message) => message.startsWith('Конфигурация поставщика')), messages.join(' | '));
    assertPEqualsDb();
    assert.ok(bytesInP(h, VENDOR_CF).equals(bytesInDb(h, VENDOR_CF)));
  });

  // ── 28. корень целиком ────────────────────────────────────────────────────────────────────────

  test('28. `New: Configuration.X` (корень выгружается целиком): доказательства нет — .cf скачан (равен P — не записан)', async () => {
    await begin();
    const cfMtime = agePFile(h, VENDOR_CF);
    putRootModule();
    h.emulator.nextChangesText = `${BOM}New: ${ROOT_OWNER}\r\n`;
    const messages: string[] = [];

    await h.importTarget({ onMessage: (message) => { messages.push(message); } });

    assert.ok(wasOpened(h, VENDOR_CF), 'скачан: при unknown шлюз скачивает');
    assert.strictEqual(mtimeOfP(h, VENDOR_CF), cfMtime, 'содержимое равно P — не перезаписан');
    assert.ok(!messages.some((message) => message.startsWith('Конфигурация поставщика не изменилась')), messages.join(' | '));
  });
});

suite('AgentSyncEngine: шлюз конфигурации поставщика — разреженный M после посева из проекта (sftp)', function () {
  this.timeout(180_000);
  let h: SyncHarness;

  teardown(async () => { await h.dispose(); });

  test('27. разреженный M: `--update` записал весь корень, .cf в кандидатах, но не скачан — P имеет его, размер равен', async () => {
    h = await createHarness('sftp', HARNESS);
    h.seedDb();
    seedVendor(h.emulator);
    h.emulator.setConfiguration('Основная', 'cf');
    h.emulator.snapshotToProject(h.configRoot);
    await h.importTarget(importHookSpy({ seed: 'seed' }).hooks);
    assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
    h.emulator.updateGranularity = 'changed-files';
    h.emulator.changeLines = 'changed-parts';
    h.emulator.rewriteWholeRootOnUpdate = true;
    ageAgentTree(h.mirrorAbs);
    h.emulator.putFile(ROOT_MODULE, 'Процедура ПриНачале() КонецПроцедуры');
    h.sftp?.log.splice(0);
    const spy = importHookSpy();

    const result = await h.importTarget(spy.hooks);

    assert.strictEqual(result.strategy, 'delta');
    assert.ok(!wasOpened(h, VENDOR_CF));
    assertOnce(spy.messages, SKIP_LINE);
    assert.ok(bytesInP(h, VENDOR_CF).equals(bytesInDb(h, VENDOR_CF)));
    assert.strictEqual(h.readP(ROOT_MODULE), 'Процедура ПриНачале() КонецПроцедуры');
    const actual = h.snapshotP();
    delete actual['ConfigDumpInfo.xml'];
    assert.deepStrictEqual(actual, dbAsText(h.emulator.dbTrackedFiles()));
  });

  test('27б. разреженный M и обновление поставщика: .cf скачан и записан', async () => {
    h = await createHarness('sftp', HARNESS);
    h.seedDb();
    seedVendor(h.emulator);
    h.emulator.setConfiguration('Основная', 'cf');
    h.emulator.snapshotToProject(h.configRoot);
    await h.importTarget(importHookSpy({ seed: 'seed' }).hooks);
    h.emulator.updateGranularity = 'changed-files';
    h.emulator.changeLines = 'changed-parts';
    h.emulator.rewriteWholeRootOnUpdate = true;
    ageAgentTree(h.mirrorAbs);
    updateVendor(h.emulator);
    h.sftp?.log.splice(0);

    await h.importTarget();

    assert.ok(wasOpened(h, VENDOR_CF));
    assert.ok(bytesInP(h, VENDOR_CF).equals(bytesInDb(h, VENDOR_CF)));
  });
});

suite('AgentSyncEngine: конфигурация поставщика — не затрагивает прочие пути', function () {
  this.timeout(120_000);
  let h: SyncHarness;
  teardown(async () => { await h.dispose(); });

  test('локальный агент: шлюза нет, файл поставщика сравнивается как любой большой (потоком), P ≡ M', async () => {
    h = await createHarness('local', HARNESS);
    h.seedDb();
    seedVendor(h.emulator);
    h.emulator.setConfiguration('Основная', 'cf');
    await h.importTarget();
    h.emulator.putFile(ROOT_MODULE, 'Процедура ПриНачале() КонецПроцедуры');
    const messages: string[] = [];

    await h.importTarget({ onMessage: (message) => { messages.push(message); } });

    assert.ok(!messages.some((message) => message.startsWith('Конфигурация поставщика')), messages.join(' | '));
    assert.ok(bytesInP(h, VENDOR_CF).equals(bytesInDb(h, VENDOR_CF)));
    assert.ok(fs.existsSync(path.join(h.configRoot, ...VENDOR_BIN.split('/'))));
  });

  test('массовые владельцы без корня в списке: шлюз не вмешивается (строк о поставщике нет)', async () => {
    h = await startAvoidHarness({
      coverage: 'full',
      seed: (emulator) => { seedBulkOwners(emulator, 3, 3); seedVendor(emulator); },
      harness: HARNESS,
    });
    ageAgentTree(h.mirrorAbs);
    h.emulator.putFile('Catalogs/Б1/Ext/Ф1.bsl', 'v2');
    const messages: string[] = [];

    await h.importTarget({ onMessage: (message) => { messages.push(message); } });

    assert.ok(!messages.some((message) => message.startsWith('Конфигурация поставщика')), messages.join(' | '));
    assert.strictEqual(h.readP('Catalogs/Б1/Ext/Ф1.bsl'), 'v2');
  });
});
