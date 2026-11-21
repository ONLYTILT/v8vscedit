import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentOperationHooks } from '../../infra/agent/AgentOperationService';
import type { AgentFileStore } from '../../infra/agent/files/AgentFileStore';
import { AgentSyncCancelledError } from '../../infra/agent/sync/SyncContext';
import { buildSyncManifestFiles, type SyncMirrorCoverage } from '../../infra/agent/sync/SyncManifest';
import type { AgentProgressEvent } from '../../infra/agent/sync/SyncProgress';
import { ageAgentTree, hasOption } from './support/agentConfigEmulator';
import { createHarness, type SyncHarness } from './support/agentSyncHarness';
import { CountingAgentFileStore, MtimeShapingAgentFileStore } from './support/delegatingAgentFileStore';
import { assertOnce, assertSubsequence, dbFilesUnder, mirrorReads, restoreReads } from './support/deltaMtimeFixtures';
import {
  COVERAGES,
  ORDER_FILES,
  ORDER_FORM_FILES,
  assertCommon,
  removeRootPart,
  seedRootPart,
  snapshotUntouched,
  startAvoidHarness,
  type AvoidStartOptions,
} from './support/fullDumpAvoidFixtures';
import { RICH_DOCUMENT_FILES, importHookSpy, seedRichDocument } from './support/archiveAvoidFixtures';

/**
 * Дельта импорта по времени изменения файлов зеркала агента (plan-delta-progress.md §1, тесты 7–20; SFTP).
 *
 * Время моделируется СТАРЕНИЕМ, а не подменой часов: M пишется настоящей ФС, `ageAgentTree` уводит mtime всех
 * файлов M в прошлое, а метка и переписанные после неё файлы получают реальное «сейчас». Сравнение идёт ТОЛЬКО
 * с меткой, записанной на сервере: у настоящего агента серверные времена по SFTP сдвинуты на час (ФАКТ Э23),
 * поэтому тест 7 повторяется при сдвиге серверных времён вперёд и назад. Скачанное считается по журналу READ
 * SFTP-сервера: настоящий протокол, а не счётчик в тестовой обёртке.
 *
 * В каждом тесте после импорта: P ≡ база (без файла версий), манифест B = hash(P), остатков обмена нет
 * (`assertCommon`), если P не должен намеренно отличаться от базы.
 */

const FORM_BODY = 'Documents/Заказ/Forms/Форма/Ext/Form.xml';
const OBJECT_MODULE = 'Documents/Заказ/Ext/ObjectModule.bsl';
const ORDER_XML = 'Documents/Заказ.xml';
const FORM_V2 = '<FormBody>v2</FormBody>';
const SERVER_SHIFTS_SEC: readonly number[] = [-3600, 0, 3600];

suite('AgentSyncEngine: дельта импорта по времени изменения (sftp)', function () {
  this.timeout(180_000);
  let h: SyncHarness;
  let from = 0;

  /** Стенд: M полный или разреженный, нетронутые файлы M состарены, журнал SFTP очищен. */
  async function begin(coverage: SyncMirrorCoverage, options: Partial<Omit<AvoidStartOptions, 'coverage'>> = {}): Promise<void> {
    h = await startAvoidHarness({ coverage, ...options });
    ageAgentTree(h.mirrorAbs);
    from = h.emulator.commands.length;
    h.sftp?.log.splice(0);
  }
  teardown(async () => { await h.dispose(); });

  // ── 7. изменён один файл из N ─────────────────────────────────────────────────────────────────

  for (const coverage of COVERAGES) {
    for (const shift of SERVER_SHIFTS_SEC) {
      test(`7. владелец из 4 файлов, изменён 1: читается ровно он (M ${coverage}, серверные времена сдвинуты на ${String(shift)} с)`, async () => {
        await begin(coverage);
        assert.ok(h.sftp);
        h.sftp.mtimeShiftSec = shift;
        h.emulator.putFile(FORM_BODY, FORM_V2);
        const spy = importHookSpy();

        const result = await h.importTarget(spy.hooks);

        assert.strictEqual(result.strategy, 'delta');
        assert.deepStrictEqual(mirrorReads(h), [FORM_BODY], 'прочитан только изменённый файл');
        assert.strictEqual(h.readP(FORM_BODY), FORM_V2);
        assert.deepStrictEqual(result.changedProjectFiles.map((file) => path.basename(file)), ['Form.xml']);
        if (coverage === 'full') {
          assertOnce(spy.messages, /^Изменено в зеркале: 1 из 4 файлов изменённых объектов/);
        }
        await assertCommon(h, from, coverage);
      });
    }
  }

  test('7б. два владельца изменены в разных файлах: читаются только изменённые файлы, нетронутые файлы тех же владельцев — нет', async () => {
    await begin('full');
    h.emulator.putFile(FORM_BODY, FORM_V2);
    h.emulator.putFile('Catalogs/Товары/Ext/ObjectModule.bsl', 'Процедура Товары() v2 КонецПроцедуры');

    await h.importTarget();

    assert.deepStrictEqual(mirrorReads(h), ['Catalogs/Товары/Ext/ObjectModule.bsl', FORM_BODY].sort());
    await assertCommon(h, from, 'full');
  });

  // ── 8. грязный файл нетронутого в базе файла изменённого владельца ─────────────────────────────

  test('8. локальная правка нетронутого файла изменённого владельца: файл скачан и перезаписан из M (P ≡ база)', async () => {
    await begin('full');
    h.writeP(OBJECT_MODULE, 'Процедура МояПравка() КонецПроцедуры');
    h.emulator.putFile(FORM_BODY, FORM_V2);

    const result = await h.importTarget();

    assert.strictEqual(result.strategy, 'delta');
    assert.deepStrictEqual(mirrorReads(h), [OBJECT_MODULE, FORM_BODY].sort());
    assert.strictEqual(h.readP(OBJECT_MODULE), 'Процедура Заказ() КонецПроцедуры');
    await assertCommon(h, from, 'full');
  });

  // ── 9. файл вне B ─────────────────────────────────────────────────────────────────────────────

  for (const coverage of COVERAGES) {
    test(`9а. локально добавленный файл изменённого владельца, которого нет в M (M ${coverage}): прежнее поведение — удаляется из P`, async () => {
      await begin(coverage);
      h.writeP('Documents/Заказ/Ext/Лишний.bsl', 'локальный файл');
      h.emulator.putFile(FORM_BODY, FORM_V2);

      await h.importTarget();

      assert.ok(!h.existsP('Documents/Заказ/Ext/Лишний.bsl'));
      assert.ok(!mirrorReads(h).includes('Documents/Заказ/Ext/Лишний.bsl'));
      await assertCommon(h, from, coverage);
    });
  }

  test('9б. файл есть в M (состарен), но его нет в B: скачивается всегда и попадает в P — прежнее поведение', async () => {
    await begin('full');
    const extra = 'Documents/Заказ/Ext/ManagerModule.bsl';
    const target = path.join(h.mirrorAbs, ...extra.split('/'));
    fs.writeFileSync(target, 'Процедура ИзЗеркала() КонецПроцедуры');
    ageAgentTree(h.mirrorAbs);
    h.emulator.putFile(FORM_BODY, FORM_V2);

    await h.importTarget();

    assert.deepStrictEqual(mirrorReads(h), [extra, FORM_BODY].sort());
    assert.strictEqual(h.readP(extra), 'Процедура ИзЗеркала() КонецПроцедуры');
    const inP = Object.keys(h.snapshotP()).filter((rel) => rel !== extra && rel !== 'ConfigDumpInfo.xml').sort();
    assert.deepStrictEqual(inP, Object.keys(h.emulator.dbTrackedFiles()).sort());
    assert.deepStrictEqual(h.manifest().files, await buildSyncManifestFiles(h.configRoot));
  });

  // ── 10. новый владелец ────────────────────────────────────────────────────────────────────────

  test('10. новый владелец (New): скачаны все его файлы', async () => {
    await begin('full');
    h.emulator.setObject('Catalog.Новый', {
      'Catalogs/Новый.xml': '<Catalog>Новый</Catalog>',
      'Catalogs/Новый/Ext/ObjectModule.bsl': 'Процедура Новый() КонецПроцедуры',
      'Catalogs/Новый/Forms/Ф.xml': '<Form>Ф</Form>',
      'Catalogs/Новый/Forms/Ф/Ext/Form.xml': '<FormBody/>',
    });

    await h.importTarget();

    assert.deepStrictEqual(mirrorReads(h), dbFilesUnder(h, 'Catalogs/Новый'));
    await assertCommon(h, from, 'full');
  });

  // ── 11. FullDump → prune ──────────────────────────────────────────────────────────────────────

  for (const coverage of COVERAGES) {
    test(`11. FullDump → очистка зеркала (M ${coverage}): переподготовленный владелец скачан целиком, нетронутые файлы прочих — нет, удалённый владелец убран из P`, async () => {
      await begin(coverage);
      h.emulator.removeObject('Catalog.Клиенты');
      h.emulator.removeFiles(ORDER_FORM_FILES);
      const spy = importHookSpy({ fullDump: 'cancel' });

      const result = await h.importTarget(spy.hooks);

      assert.strictEqual(result.fullDump?.handling, 'pruned');
      assert.deepStrictEqual(mirrorReads(h), [ORDER_XML, OBJECT_MODULE].sort(), 'владелец Заказ — все оставшиеся файлы; Товары, Роли, Общие — не читались');
      assert.ok(!h.existsP('Catalogs/Клиенты.xml'), 'удалённый владелец убран из P');
      for (const rel of ORDER_FORM_FILES) {
        assert.ok(!h.existsP(rel));
      }
      await assertCommon(h, from, coverage);
    });
  }

  // ── 12. FullDump → перезапись зеркала ─────────────────────────────────────────────────────────

  test('12. FullDump → перезапись зеркала (rewrite-all): файлы изменённых владельцев скачаны все, в журнале «переписал целиком»', async () => {
    await begin('full', { seed: seedRootPart });
    h.emulator.fullDumpUpdate = 'rewrite-all';
    removeRootPart(h.emulator);
    h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
    const spy = importHookSpy({ fullDump: 'dump' });

    const result = await h.importTarget(spy.hooks);

    assert.strictEqual(result.fullDump?.handling, 'mirror-rewrite');
    const reads = mirrorReads(h);
    assert.ok(reads.includes('Catalogs/Товары.xml'));
    assert.ok(reads.includes('Catalogs/Товары/Ext/ObjectModule.bsl'), 'файл, не менявшийся в базе, но переписанный сервером, скачан');
    assertOnce(spy.messages, /Сервер переписал зеркало целиком/);
    await assertCommon(h, from, 'full');
  });

  // ── 13. skip-update ───────────────────────────────────────────────────────────────────────────

  test('13. список изменений пуст (--update не нужен), локальная правка файла: скачан только он', async () => {
    await begin('full');
    h.writeP('Catalogs/Клиенты.xml', '<Catalog>Мои правки</Catalog>');

    const result = await h.importTarget();

    assert.strictEqual(result.strategy, 'delta');
    assert.deepStrictEqual(mirrorReads(h), ['Catalogs/Клиенты.xml']);
    assert.ok(h.emulator.dumps().slice(from).every((dump) => hasOption(dump, 'get-changes')), '--update не запускался');
    await assertCommon(h, from, 'full');
  });

  // ── 14. разреженный M после посева + restoreFromDatabase ──────────────────────────────────────

  test('14. разреженный M после посева из проекта + точечная выгрузка: правки restore — из каталога выгрузки, нетронутые файлы не читались', async () => {
    h = await (async () => {
      const harness = await createHarness('sftp');
      harness.seedDb();
      seedRichDocument(harness.emulator);
      harness.emulator.setConfiguration('Основная', 'cf');
      return harness;
    })();
    h.emulator.snapshotToProject(h.configRoot);
    await h.importTarget(importHookSpy({ seed: 'seed' }).hooks);
    assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
    h.emulator.updateGranularity = 'changed-files';
    ageAgentTree(h.mirrorAbs);
    const formBody = 'Documents/Д/Forms/Ф/Ext/Form.xml';
    const template = 'Documents/Д/Templates/М.xml';
    h.writeP(formBody, '<FormBody>моя правка</FormBody>');
    h.removeP(template);
    h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
    from = h.emulator.commands.length;
    h.sftp?.log.splice(0);

    const result = await h.importTarget();

    assert.strictEqual(result.restoredFromDatabase, 2);
    assert.deepStrictEqual(restoreReads(h), [formBody, template].sort());
    assert.deepStrictEqual(mirrorReads(h), ['Catalogs/Товары.xml'], 'из M читается только переписанный --update файл');
    assert.strictEqual(h.readP(formBody), RICH_DOCUMENT_FILES[formBody]);
    assert.strictEqual(h.readP(template), RICH_DOCUMENT_FILES[template]);
    assert.strictEqual(h.readP('Catalogs/Товары.xml'), '<Catalog>Товары v2</Catalog>');
    const expected = Object.fromEntries(Object.entries(h.emulator.dbTrackedFiles()).map(([rel, data]) => [rel, data.toString('utf-8')]));
    const actual = h.snapshotP();
    delete actual['ConfigDumpInfo.xml'];
    assert.deepStrictEqual(actual, expected);
    assert.deepStrictEqual(h.manifest().files, await buildSyncManifestFiles(h.configRoot));
  });

  // ── 15. растяжка ──────────────────────────────────────────────────────────────────────────────

  test('15. платформа не обновила mtime (растяжка): откат на полное сравнение файлов изменённого владельца, сообщение, P верен', async () => {
    await begin('full');
    h.emulator.preserveMtimeOnUpdate = true;
    h.emulator.putFile(FORM_BODY, FORM_V2);
    const spy = importHookSpy();

    await h.importTarget(spy.hooks);

    assert.deepStrictEqual(mirrorReads(h), [...ORDER_FILES].sort(), 'прочитаны ВСЕ файлы владельца');
    assert.ok(!spy.messages.some((message) => message.startsWith('Изменено в зеркале:')), spy.messages.join(' | '));
    assert.ok(
      spy.messages.some((message) => /целиком|полн\w+ сравнени/i.test(message)),
      `сообщение о причине отката: ${spy.messages.join(' | ')}`
    );
    assert.strictEqual(h.readP(FORM_BODY), FORM_V2);
    await assertCommon(h, from, 'full');
  });

  // ── 16. самовосстановление по размеру ─────────────────────────────────────────────────────────

  test('16. размер файла в P расходится с M без изменения в зеркале (B подогнана под P): файл скачан, P исправлен, сообщение о расхождении', async () => {
    await begin('full');
    h.writeP(OBJECT_MODULE, 'Процедура СовсемДругая() // заметно длиннее исходного текста КонецПроцедуры');
    h.saveManifest('fresh', await buildSyncManifestFiles(h.configRoot), 'full');
    h.emulator.putFile(FORM_BODY, FORM_V2);
    const spy = importHookSpy();

    await h.importTarget(spy.hooks);

    assert.ok(mirrorReads(h).includes(OBJECT_MODULE), 'файл с расхождением размера скачан');
    assert.ok(!mirrorReads(h).includes(ORDER_XML), 'остальные нетронутые файлы — нет');
    assert.strictEqual(h.readP(OBJECT_MODULE), 'Процедура Заказ() КонецПроцедуры');
    assertOnce(spy.messages, /размер расходится/);
    await assertCommon(h, from, 'full');
  });

  // ── 17. метка недоступна ──────────────────────────────────────────────────────────────────────

  const NO_MARKER_CASES: readonly {
    readonly label: string;
    readonly harness?: { readonly wrapStore: (store: AgentFileStore) => AgentFileStore };
    readonly prepare?: (h: SyncHarness) => void;
  }[] = [
    {
      label: 'запись метки отказала',
      harness: { wrapStore: (store) => new MtimeShapingAgentFileStore(store, { failWriteIncluding: '.marker' }) },
    },
    {
      label: 'хранилище не отдаёт mtimeMs',
      harness: { wrapStore: (store) => new MtimeShapingAgentFileStore(store, { stripMtime: true }) },
    },
    {
      label: 'SFTP-сервер без времён (attrsWithoutTimes)',
      prepare: (harness) => { assert.ok(harness.sftp); harness.sftp.attrsWithoutTimes = true; },
    },
  ];

  for (const { label, harness, prepare } of NO_MARKER_CASES) {
    test(`17. метка недоступна — ${label}: скачано всё, в журнале причина, P верен`, async () => {
      await begin('full', harness === undefined ? {} : { harness });
      prepare?.(h);
      h.emulator.putFile(FORM_BODY, FORM_V2);
      const spy = importHookSpy();

      await h.importTarget(spy.hooks);

      assert.deepStrictEqual(mirrorReads(h), [...ORDER_FILES].sort());
      assertOnce(spy.messages, /^Метка времени сервера не получена \(.+\): файлы изменённых объектов будут сравниваться целиком/);
      await assertCommon(h, from, 'full');
    });
  }

  // ── метка: первой операцией и один раз ────────────────────────────────────────────────────────

  test('метка записывается один раз и ДО первой команды агента (и до --update); после операции её нет', async () => {
    let counting: CountingAgentFileStore | undefined;
    await begin('full', { harness: { wrapStore: (store) => { counting = new CountingAgentFileStore(store); return counting; } } });
    assert.ok(counting);
    counting.calls.splice(0);
    const markerSeenAtCommand: boolean[] = [];
    h.emulator.onCommand = (command) => {
      if (command.command === 'config dump-config-to-files') {
        const exchange = path.join(h.userRoot, 'exchange');
        const hasMarker = fs.existsSync(exchange)
          && fs.readdirSync(exchange).some((name) => name.endsWith('.marker'));
        markerSeenAtCommand.push(hasMarker);
      }
    };
    h.emulator.putFile(FORM_BODY, FORM_V2);

    await h.importTarget();

    assert.strictEqual(counting.count('writeFile', /^exchange\/[^/]+\.marker$/), 1);
    assert.ok(markerSeenAtCommand.length >= 2, 'были get-changes и --update');
    assert.ok(markerSeenAtCommand.every(Boolean), 'метка существовала перед каждой командой выгрузки');
    assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
  });

  test('архивный путь после метки (нераспознанный список): --dir архивной выгрузки пуст перед командой, метка лежит рядом с ним', async () => {
    await begin('full');
    h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
    h.emulator.nextChangesText = '\uFEFFDeleted: Catalog.Клиенты\r\n';
    const seen: { dirEntries: string[]; markerBeside: boolean }[] = [];
    h.emulator.onCommand = (command) => {
      const dir = command.options.dir;
      if (command.command === 'config dump-config-to-files' && typeof command.options.archive === 'string' && typeof dir === 'string') {
        const abs = path.join(h.userRoot, ...dir.split('/'));
        seen.push({
          dirEntries: fs.existsSync(abs) ? fs.readdirSync(abs) : [],
          markerBeside: fs.existsSync(`${abs}.marker`),
        });
      }
    };

    const result = await h.importTarget();

    assert.strictEqual(result.strategy, 'archive');
    assert.deepStrictEqual(seen, [{ dirEntries: [], markerBeside: true }]);
    assert.strictEqual(h.readP('Catalogs/Клиенты.xml'), '<Catalog>v2</Catalog>');
    assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
  });

  // ── 18. отмена ────────────────────────────────────────────────────────────────────────────────

  function cancellingHooks(trigger: (event: AgentProgressEvent) => boolean): { hooks: AgentOperationHooks; messages: string[] } {
    const cancellation = { isCancellationRequested: false };
    const messages: string[] = [];
    return {
      messages,
      hooks: {
        cancellation,
        onMessage: (message) => { messages.push(message); },
        onProgress: (event) => { if (trigger(event)) { cancellation.isCancellationRequested = true; } },
      },
    };
  }

  test('18а. отмена во время скачивания: AgentSyncCancelledError, P не тронут, манифест empty, строка об изменённом зеркале', async () => {
    await begin('full');
    h.emulator.putFile(FORM_BODY, FORM_V2);
    const pBefore = h.snapshotP();
    const { hooks, messages } = cancellingHooks((event) => event.text.startsWith('Скачивание изменённых файлов'));

    await assert.rejects(h.importTarget(hooks), (error: unknown) => error instanceof AgentSyncCancelledError);

    assert.deepStrictEqual(h.snapshotP(), pBefore, 'P не тронут');
    assert.strictEqual(h.manifest().mirrorState, 'empty');
    assertOnce(messages, /Импорт прерван после изменения зеркала агента: следующий импорт заново подготовит зеркало/);
    assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
    assert.deepStrictEqual(h.localExchangeLeftovers(), []);
  });

  test('18б. отмена до мутаций (на запросе списка изменений): манифест прежний побайтно, M и P не тронуты, строки о прерывании нет', async () => {
    await begin('full');
    h.emulator.putFile(FORM_BODY, FORM_V2);
    const before = snapshotUntouched(h);
    const { hooks, messages } = cancellingHooks((event) => event.text === 'Запрос списка изменений базы у агента…');

    await assert.rejects(h.importTarget(hooks), (error: unknown) => error instanceof AgentSyncCancelledError);

    assert.deepStrictEqual(snapshotUntouched(h), before);
    assert.ok(!messages.some((message) => message.includes('Импорт прерван')), messages.join(' | '));
    assert.ok(
      !h.emulator.dumps().slice(from).some((dump) => dump.options.update === true && !hasOption(dump, 'get-changes')),
      '--update не запускался'
    );
  });

  // ── 19. точная последовательность этапов ──────────────────────────────────────────────────────

  test('19. сообщения импорта дельтой при постоянных часах: этапы и счётчики в порядке, один раз, в журнале и в UI одинаково', async () => {
    await begin('full');
    h.emulator.putFile(FORM_BODY, FORM_V2);
    const journal: string[] = [];
    const ui: string[] = [];

    await h.importTarget({
      onMessage: (message) => { journal.push(message); },
      onProgress: (event) => { ui.push(event.text); },
    });

    const stages: (RegExp | string)[] = [
      'Запрос списка изменений базы у агента…',
      'Обновление зеркала агента на сервере…',
      'Просмотр зеркала: объектов 1 из 1',
      'Проверка локальных изменений проекта…',
      // Итог снимка №0 (plan-fast-baseline.md §2.3): самый дорогой оставшийся проход импорта виден в журнале.
      /^Проверка локальных изменений проекта: файлов \d+, перехешировано \d+ \(racy \d+\), \d+ мс$/,
      'Изменено в зеркале: 1 из 4 файлов изменённых объектов (скачиваются только они)',
      // Прогресс по весу (plan-large-files.md §3.1): файлы, байты из/всего, процент; часы постоянные — скорости и оценки времени нет.
      /^Скачивание изменённых файлов: 1 из 1, 23 Б из 23 Б \(100%\)$/,
      'Запись в проект: изменено 1, удалено 0',
      'Запись в проект: 1 из 1 файлов',
      'Сохранение базовой линии синхронизации…',
      // B по изменённым файлам: перехеширован единственный записанный файл, второго полного прохода нет.
      /^Базовая линия синхронизации: по изменённым файлам — перехешировано 1, удалено 0, \d+ мс$/,
    ];
    assertSubsequence(journal, stages);
    for (const stage of stages) {
      assertOnce(journal, stage);
      assertOnce(ui, stage);
    }
    for (const prefix of ['Просмотр зеркала: объектов 0 из 1', 'Скачивание изменённых файлов: 0 из 1', 'Запись в проект: 0 из 1 файлов']) {
      assert.ok(journal.some((message) => message.startsWith(prefix)), `старт счётчика «${prefix}»: ${journal.join(' | ')}`);
    }
    await assertCommon(h, from, 'full');
  });
});

// ── 20. локальный агент ─────────────────────────────────────────────────────────────────────────

suite('AgentSyncEngine: локальный агент — счётчик сравнения', function () {
  this.timeout(60_000);
  let h: SyncHarness;
  setup(async () => { h = await createHarness('local'); h.seedDb(); });
  teardown(async () => { await h.dispose(); });

  test('importByCompare: строки «Сравнение зеркала с проектом: N из M», последняя — полная; результат прежний (compare, P ≡ база)', async () => {
    await h.importTarget();
    h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>Клиенты v2</Catalog>');
    const spy = importHookSpy();

    const result = await h.importTarget(spy.hooks);

    assert.strictEqual(result.strategy, 'compare');
    const lines = spy.messages.filter((message) => message.startsWith('Сравнение зеркала с проектом: '));
    assert.ok(lines.length >= 2, spy.messages.join(' | '));
    const parsed = lines.map((line) => /: (\d+) из (\d+)$/.exec(line));
    assert.ok(parsed.every((match) => match !== null), lines.join(' | '));
    const [done, total] = (parsed.at(-1) ?? []).slice(1).map(Number);
    assert.strictEqual(done, total);
    assert.strictEqual(parsed[0]?.[1], '0');
    assert.strictEqual(h.readP('Catalogs/Клиенты.xml'), '<Catalog>Клиенты v2</Catalog>');
    assert.deepStrictEqual(h.manifest().files, await buildSyncManifestFiles(h.configRoot));
  });

  test('локальный агент: отбор по времени не применяется — метка в каталоге обмена не пишется', async () => {
    await h.dispose();
    let counting: CountingAgentFileStore | undefined;
    h = await createHarness('local', { wrapStore: (store) => { counting = new CountingAgentFileStore(store); return counting; } });
    h.seedDb();
    await h.importTarget();
    h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>Клиенты v2</Catalog>');

    await h.importTarget();

    assert.ok(counting);
    assert.strictEqual(counting.count('writeFile', /\.marker$/), 0);
  });
});
