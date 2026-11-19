import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentFileStore, AgentStreamOptions } from '../../infra/agent/files/AgentFileStore';
import { AgentFullDumpDeclinedError, AgentSyncCancelledError } from '../../infra/agent/sync/SyncContext';
import { SERVER_DUMP_POLICY } from '../../infra/agent/sync/SyncPlanner';
import { hasOption } from './support/agentConfigEmulator';
import { agentError } from './support/agentInfoBaseFakes';
import { createHarness, dbAsText, type SyncHarness } from './support/agentSyncHarness';
import { importHookSpy } from './support/archiveAvoidFixtures';
import { CountingAgentFileStore, DelegatingAgentFileStore } from './support/delegatingAgentFileStore';
import {
  BOM,
  COVERAGES,
  FULL_DUMP_UPDATE_MODES,
  ORDER_FILES,
  ORDER_FORM_FILES,
  assertCommon,
  assertMirrorEqualsDb,
  assertSparseMirrorWithoutFiles,
  assertUntouched,
  cutOwnerFromCdiText,
  dbAsBase64,
  dumpKindOf,
  dumpKindsFrom,
  removeRootPart,
  seedOrderWithTemplate,
  seedRootPart,
  snapshotUntouched,
  startAvoidHarness,
  type AvoidStartOptions,
} from './support/fullDumpAvoidFixtures';
import { buildZip, readZipAsMap } from './support/zipFixtures';

/**
 * Импорт при `FullDump` без полной выгрузки (plan-fulldump-avoid.md, ред. 2, Т7): очистка зеркала по свежему
 * файлу версий (удалённый владелец, переименование, удалённая форма живого владельца), сверка повторного
 * `--get-changes`, запасной путь «перезапись зеркала» с вопросом `mirror-rewrite`, отказы и отмена.
 * Агент — эмулятор (режим `changed-files`, как у настоящего), хранилище — настоящее (SFTP на ssh2.Server).
 *
 * ФАКТ П3b: после очистки живого владельца повторный `--get-changes` даёт `New: <владелец>` И отдельные
 * строки `New: <владелец>.<подобъект>`; эмулятор воспроизводит это через `parts` объекта.
 */

const CDI = 'ConfigDumpInfo.xml';
const CLIENT_V2 = '<Catalog>Клиенты v2</Catalog>';
const FIRST_FLOW = ['get-changes', 'info-only', 'get-changes-retry'] as const;

const abs = (h: SyncHarness, rel: string): string => path.join(h.configRoot, ...rel.split('/'));

suite('AgentSyncEngine: FullDump без полной выгрузки (sftp, цель cf)', function () {
  this.timeout(180_000);
  let h: SyncHarness;
  let from = 0;

  async function begin(options: AvoidStartOptions): Promise<void> {
    h = await startAvoidHarness(options);
    from = h.emulator.commands.length;
  }
  teardown(async () => { await h.dispose(); });

  /** Сводка P ≡ dbFiles (с файлом версий): так выглядит P после импорта архивом. */
  const expectPEqualsDbWithInfo = (): void => {
    assert.deepStrictEqual(h.snapshotP(), dbAsText(h.emulator.dbFiles()));
  };

  // ── 1. удалён владелец ────────────────────────────────────────────────────────────────────────

  for (const coverage of COVERAGES) {
    suite(`1. удалён владелец, M ${coverage}`, () => {
      test('чистое удаление: список → CDI → повторный список; архива и перезаписи нет; вопроса нет; P ≡ БД; удалённые пути сообщены хуку', async () => {
        await begin({ coverage });
        h.emulator.removeObject('Document.Заказ');
        const willChange: string[] = [];
        const spy = importHookSpy({ fullDump: 'cancel', extra: { onProjectFilesWillChange: (files) => { willChange.push(...files); } } });

        const result = await h.importTarget(spy.hooks);

        assert.strictEqual(result.strategy, 'delta');
        assert.deepStrictEqual(result.fullDump, { handling: 'pruned', removedOwners: ['Document.Заказ'], replacedOwners: [] });
        assert.deepStrictEqual(dumpKindsFrom(h.emulator, from), [...FIRST_FLOW], 'правок кроме удаления нет: --update пропускается');
        assert.strictEqual(h.emulator.infoOnlyDumps, 1);
        assert.strictEqual(h.emulator.fullRewriteUpdates, 0);
        assert.deepStrictEqual(spy.fullDumpRequests, [], 'вопроса нет');
        for (const rel of ORDER_FILES) {
          assert.ok(!h.existsP(rel), `${rel} удалён из P`);
          assert.ok(willChange.includes(abs(h, rel)), `хук onProjectFilesWillChange получил ${rel}`);
        }
        assert.strictEqual(h.existsP('Documents'), false, 'опустевший каталог убран');
        if (coverage === 'full') {
          assertMirrorEqualsDb(h);
        } else {
          assertSparseMirrorWithoutFiles(h, ORDER_FILES);
        }
        await assertCommon(h, from, coverage);
      });

      test('в журнале есть сообщение об очищенных владельцах (с их именами)', async () => {
        await begin({ coverage });
        h.emulator.removeObject('Document.Заказ');
        const spy = importHookSpy();

        await h.importTarget(spy.hooks);

        assert.ok(spy.messages.some((message) => message.includes('Document.Заказ')), spy.messages.join(' | '));
      });

      test('удаление + изменение другого владельца: список → CDI → повторный список → --update без --get-changes; M и P ≡ БД', async () => {
        await begin({ coverage });
        h.emulator.removeObject('Document.Заказ');
        h.emulator.putFile('Catalogs/Клиенты.xml', CLIENT_V2);

        const result = await h.importTarget();

        assert.strictEqual(result.strategy, 'delta');
        assert.deepStrictEqual(dumpKindsFrom(h.emulator, from), [...FIRST_FLOW, 'update']);
        const update = h.emulator.dumps().at(-1);
        assert.ok(update);
        assert.ok(update.options.update === true && !hasOption(update, 'get-changes') && !hasOption(update, 'archive'));
        assert.strictEqual(h.emulator.fullRewriteUpdates, 0);
        assert.strictEqual(h.readP('Catalogs/Клиенты.xml'), CLIENT_V2);
        if (coverage === 'full') {
          assertMirrorEqualsDb(h);
        } else {
          assertSparseMirrorWithoutFiles(h, ORDER_FILES);
        }
        await assertCommon(h, from, coverage);
      });
    });

    // ── 2. переименование ─────────────────────────────────────────────────────────────────────

    test(`2. переименование (M ${coverage}): старые файлы удалены, новые пришли; перезаписи нет`, async () => {
      await begin({ coverage });
      h.emulator.removeObject('Catalog.Клиенты');
      h.emulator.setObject('Catalog.Заказчики', { 'Catalogs/Заказчики.xml': '<Catalog>Заказчики</Catalog>' });

      const result = await h.importTarget();

      assert.strictEqual(result.strategy, 'delta');
      assert.deepStrictEqual(result.fullDump, { handling: 'pruned', removedOwners: ['Catalog.Клиенты'], replacedOwners: [] });
      assert.ok(!h.existsP('Catalogs/Клиенты.xml'));
      assert.strictEqual(h.readP('Catalogs/Заказчики.xml'), '<Catalog>Заказчики</Catalog>');
      assert.deepStrictEqual(dumpKindsFrom(h.emulator, from), [...FIRST_FLOW, 'update']);
      assert.strictEqual(h.emulator.fullRewriteUpdates, 0);
      if (coverage === 'full') {
        assertMirrorEqualsDb(h);
      }
      await assertCommon(h, from, coverage);
    });

    // ── 2b. переименование только регистром ───────────────────────────────────────────────────

    test(`2b. переименование только регистром Catalog.Товары → Catalog.товары (M ${coverage}): модули на месте, P ≡ БД с регистром базы`, async () => {
      await begin({ coverage });
      // На Windows старый и новый пути — один физический файл: удаление «старого» не должно унести модуль живого объекта
      h.emulator.removeObject('Catalog.Товары');
      h.emulator.setObject('Catalog.товары', {
        'Catalogs/товары.xml': '<Catalog>товары</Catalog>',
        'Catalogs/товары/Ext/ObjectModule.bsl': 'Процедура Товары() КонецПроцедуры',
      });

      const result = await h.importTarget();

      assert.strictEqual(result.strategy, 'delta');
      assert.deepStrictEqual(result.fullDump, { handling: 'pruned', removedOwners: ['Catalog.Товары'], replacedOwners: [] });
      const p = Object.keys(h.snapshotP());
      assert.ok(p.includes('Catalogs/товары/Ext/ObjectModule.bsl'), `модуль на месте под новым регистром: ${p.join(', ')}`);
      assert.ok(p.includes('Catalogs/товары.xml'));
      assert.ok(!p.some((rel) => rel.startsWith('Catalogs/Товары')), 'старого регистра в P нет');
      assert.strictEqual(h.readP('Catalogs/товары/Ext/ObjectModule.bsl'), 'Процедура Товары() КонецПроцедуры');
      if (coverage === 'full') {
        assertMirrorEqualsDb(h);
      }
      await assertCommon(h, from, coverage);
    });

    // ── 3. удалена форма живого владельца ─────────────────────────────────────────────────────

    for (const withSubObjectLines of [true, false]) {
      suite(`3. удалена форма живого владельца, M ${coverage}, строки подобъектов в списке: ${withSubObjectLines ? 'да (ФАКТ П3b)' : 'нет'}`, () => {
        const prepare = async (): Promise<void> => {
          await begin({ coverage, seed: (emulator) => { seedOrderWithTemplate(emulator, withSubObjectLines); } });
          // removeFiles повышает версию владельца и не трогает его `parts`: список №2 даст New и строки подобъектов
          h.emulator.removeFiles(ORDER_FORM_FILES);
        };

        test('владелец очищен целиком и выгружен заново: файлы формы удалены из P, прочее ≡ БД; перезаписи и вопроса нет', async () => {
          await prepare();
          const spy = importHookSpy({ fullDump: 'cancel' });

          const result = await h.importTarget(spy.hooks);

          assert.strictEqual(result.strategy, 'delta');
          assert.deepStrictEqual(result.fullDump, { handling: 'pruned', removedOwners: [], replacedOwners: ['Document.Заказ'] });
          for (const rel of ORDER_FORM_FILES) {
            assert.ok(!h.existsP(rel), `${rel} удалён из P`);
          }
          assert.strictEqual(h.readP('Documents/Заказ/Templates/Макет.xml'), '<Template>Макет</Template>');
          assert.deepStrictEqual(dumpKindsFrom(h.emulator, from), [...FIRST_FLOW, 'update']);
          assert.strictEqual(h.emulator.fullRewriteUpdates, 0);
          assert.deepStrictEqual(spy.fullDumpRequests, [], 'вопроса нет');
          if (coverage === 'sparse') {
            for (const rel of Object.keys(h.emulator.dbFiles()).filter((name) => name.startsWith('Documents/Заказ'))) {
              assert.ok(h.listM().includes(rel), `поддерево владельца в M полное: ${rel}`);
            }
          } else {
            assertMirrorEqualsDb(h);
          }
          await assertCommon(h, from, coverage);
        });
      });
    }

    // ── 4. всё сразу ──────────────────────────────────────────────────────────────────────────

    test(`4. удалён A + форма у B + изменён C + добавлен D (M ${coverage}): один проход очистки, без перезаписи`, async () => {
      await begin({ coverage });
      h.emulator.removeObject('Catalog.Клиенты');
      h.emulator.removeFiles(ORDER_FORM_FILES);
      h.emulator.putFile('Catalogs/Товары/Ext/ObjectModule.bsl', 'Процедура Товары() v2 КонецПроцедуры');
      h.emulator.setObject('Catalog.Новый', { 'Catalogs/Новый.xml': '<Catalog>Новый</Catalog>' });

      const result = await h.importTarget();

      assert.strictEqual(result.strategy, 'delta');
      assert.deepStrictEqual(result.fullDump, {
        handling: 'pruned',
        removedOwners: ['Catalog.Клиенты'],
        replacedOwners: ['Document.Заказ'],
      });
      assert.deepStrictEqual(dumpKindsFrom(h.emulator, from), [...FIRST_FLOW, 'update']);
      assert.strictEqual(h.emulator.infoOnlyDumps, 1, 'свежий CDI берётся один раз');
      assert.strictEqual(h.emulator.fullRewriteUpdates, 0);
      assert.strictEqual(h.readP('Catalogs/Новый.xml'), '<Catalog>Новый</Catalog>');
      if (coverage === 'full') {
        assertMirrorEqualsDb(h);
      }
      await assertCommon(h, from, coverage);
    });
  }

  // ── 5. часть корня: запасной путь ─────────────────────────────────────────────────────────────

  suite('5. удалена часть корня → запасной путь с вопросом mirror-rewrite ДО мутаций', () => {
    for (const coverage of COVERAGES) {
      test(`'cancel' (M ${coverage}): AgentFullDumpDeclinedError, M, P и манифест побайтно прежние; свежий CDI был получен`, async () => {
        await begin({ coverage, seed: seedRootPart });
        removeRootPart(h.emulator);
        const before = snapshotUntouched(h);
        const from5 = h.emulator.commands.length;
        const spy = importHookSpy({ fullDump: 'cancel' });

        await assert.rejects(h.importTarget(spy.hooks), (error: unknown) =>
          error instanceof AgentFullDumpDeclinedError && error.consent === 'import');

        assert.deepStrictEqual(spy.fullDumpRequests, [{
          targetKind: 'cf',
          targetName: 'Основная',
          projectDir: h.configRoot,
          operation: 'import',
          reason: 'mirror-rewrite',
          reasonText: SERVER_DUMP_POLICY['mirror-rewrite'].text,
          download: false,
        }]);
        assert.deepStrictEqual(dumpKindsFrom(h.emulator, from5), ['get-changes', 'info-only'], 'мутирующих команд нет');
        assert.strictEqual(h.emulator.updateDbCalls, 0);
        assertUntouched(h, before);
        assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
        assert.deepStrictEqual(h.localExchangeLeftovers(), []);
      });
    }

    for (const mode of FULL_DUMP_UPDATE_MODES) {
      test(`'dump' (M full, перезапись ${mode}): итог ≡ БД, fullRewriteUpdates = 1, handling mirror-rewrite, без архива`, async () => {
        await begin({ coverage: 'full', seed: seedRootPart });
        h.emulator.fullDumpUpdate = mode;
        removeRootPart(h.emulator);
        const spy = importHookSpy({ fullDump: 'dump' });

        const result = await h.importTarget(spy.hooks);

        assert.strictEqual(result.strategy, 'delta');
        assert.strictEqual(result.fullDump?.handling, 'mirror-rewrite');
        assert.strictEqual(spy.fullDumpRequests.length, 1);
        assert.strictEqual(spy.fullDumpRequests[0].reason, 'mirror-rewrite');
        assert.strictEqual(spy.fullDumpRequests[0].download, false);
        assert.strictEqual(h.emulator.fullRewriteUpdates, 1);
        assert.ok(!h.existsP('Ext/HomePageWorkArea.xml'), 'пропавшая часть корня удалена из P');
        await assertCommon(h, from, 'full');
      });
    }

    test('без хука (MCP): автосогласие — перезапись без вопроса, итог ≡ БД', async () => {
      await begin({ coverage: 'full', seed: seedRootPart });
      removeRootPart(h.emulator);

      const result = await h.importTarget();

      assert.strictEqual(result.fullDump?.handling, 'mirror-rewrite');
      assert.strictEqual(h.emulator.fullRewriteUpdates, 1);
      await assertCommon(h, from, 'full');
    });
  });

  // ── 6. нарушение допущения Р3 ─────────────────────────────────────────────────────────────────

  suite('6. повторный список даёт Modified вместо New для владельца с удалённой формой → запасной путь ПОСЛЕ мутации', () => {
    const breakAssumption = (): void => {
      h.emulator.onCommand = (command) => {
        if (dumpKindOf(command) === 'get-changes-retry') {
          h.emulator.nextChangesText = `${BOM}Modified: Document.Заказ\r\n`;
        }
      };
    };

    test("'dump' (M full): вопрос задан уже после очистки зеркала; итог ≡ БД", async () => {
      await begin({ coverage: 'full' });
      h.emulator.removeFiles(ORDER_FORM_FILES);
      breakAssumption();
      let mirrorCdiAtQuestion: string | undefined;
      const spy = importHookSpy({
        extra: {
          confirmFullDump: (request) => {
            mirrorCdiAtQuestion = h.readM(CDI);
            assert.strictEqual(request.reason, 'mirror-rewrite');
            return Promise.resolve('dump');
          },
        },
      });

      const result = await h.importTarget(spy.hooks);

      assert.ok(mirrorCdiAtQuestion !== undefined, 'вопрос задан');
      assert.ok(!mirrorCdiAtQuestion.includes('name="Document.Заказ"'), 'к моменту вопроса владелец уже убран из CDI зеркала');
      assert.strictEqual(result.fullDump?.handling, 'mirror-rewrite');
      await assertCommon(h, from, 'full');
    });

    for (const coverage of COVERAGES) {
      test(`'cancel' (M ${coverage}): AgentFullDumpDeclinedError, манифест empty с прежней полнотой, P не тронут`, async () => {
        await begin({ coverage });
        h.emulator.removeFiles(ORDER_FORM_FILES);
        breakAssumption();
        const pBefore = h.snapshotP();
        const spy = importHookSpy({ fullDump: 'cancel' });

        await assert.rejects(h.importTarget(spy.hooks), AgentFullDumpDeclinedError);

        assert.strictEqual(spy.fullDumpRequests.length, 1);
        assert.strictEqual(spy.fullDumpRequests[0].reason, 'mirror-rewrite');
        assert.strictEqual(h.manifest().mirrorState, 'empty');
        assert.strictEqual(h.manifest().mirrorCoverage, coverage);
        assert.deepStrictEqual(h.snapshotP(), pBefore);
      });
    }
  });

  // ── 7. повторный список = FullDump ────────────────────────────────────────────────────────────

  suite('7. повторный список — FullDump → запасной путь', () => {
    const retryFullDump = (): void => {
      h.emulator.onCommand = (command) => {
        if (dumpKindOf(command) === 'get-changes-retry') {
          h.emulator.nextChangesText = `${BOM}FullDump\r\n`;
        }
      };
    };

    for (const coverage of COVERAGES) {
      test(`с хуком 'dump' (M ${coverage}): вопрос mirror-rewrite после очистки; итог ≡ БД (удалённый владелец из P убран)`, async () => {
        await begin({ coverage });
        h.emulator.removeObject('Document.Заказ');
        retryFullDump();
        const spy = importHookSpy({ fullDump: 'dump' });

        const result = await h.importTarget(spy.hooks);

        assert.deepStrictEqual(spy.fullDumpRequests.map((request) => request.reason), ['mirror-rewrite']);
        assert.strictEqual(result.fullDump?.handling, 'mirror-rewrite');
        await assertCommon(h, from, coverage);
      });

      test(`без хука (MCP) (M ${coverage}): вопроса нет, итог ≡ БД`, async () => {
        await begin({ coverage });
        h.emulator.removeObject('Document.Заказ');
        retryFullDump();

        const result = await h.importTarget();

        assert.strictEqual(result.fullDump?.handling, 'mirror-rewrite');
        await assertCommon(h, from, coverage);
      });
    }
  });

  // ── 8. сбой выгрузки свежего CDI ──────────────────────────────────────────────────────────────

  suite('8. сбой info-only', () => {
    const failInfoOnly = (error: Error): void => {
      h.emulator.failWhen = (command) => (hasOption(command, 'config-dump-info-only') ? error : undefined);
    };

    for (const coverage of COVERAGES) {
      for (const mode of FULL_DUMP_UPDATE_MODES) {
        test(`AgentCommandError (M ${coverage}, перезапись ${mode}): запасной путь с вопросом ДО мутаций, сообщение в журнале, итог ≡ БД`, async () => {
          await begin({ coverage });
          h.emulator.fullDumpUpdate = mode;
          h.emulator.removeObject('Document.Заказ');
          failInfoOnly(agentError('UnknownError', 'не удалось выгрузить файл версий'));
          const spy = importHookSpy({ fullDump: 'dump' });

          const result = await h.importTarget(spy.hooks);

          assert.strictEqual(result.fullDump?.handling, 'mirror-rewrite');
          assert.deepStrictEqual(spy.fullDumpRequests.map((request) => request.reason), ['mirror-rewrite']);
          assert.ok(spy.messages.some((message) => /версий|ConfigDumpInfo|CDI|перезапис/i.test(message)), spy.messages.join(' | '));
          assert.strictEqual(h.emulator.infoOnlyDumps, 0);
          assert.strictEqual(h.emulator.fullRewriteUpdates, 1);
          await assertCommon(h, from, coverage);
        });
      }
    }

    test("AgentCommandError + 'cancel': ничего не тронуто (вопрос до мутаций)", async () => {
      await begin({ coverage: 'sparse' });
      h.emulator.removeObject('Document.Заказ');
      failInfoOnly(agentError('UnknownError', 'сбой'));
      const before = snapshotUntouched(h);

      await assert.rejects(h.importTarget(importHookSpy({ fullDump: 'cancel' }).hooks), AgentFullDumpDeclinedError);

      assertUntouched(h, before);
    });

    test('не-AgentCommandError: операция падает, манифест прежний, M и P не тронуты', async () => {
      await begin({ coverage: 'sparse' });
      h.emulator.removeObject('Document.Заказ');
      failInfoOnly(new Error('обрыв транспорта'));
      const before = snapshotUntouched(h);

      await assert.rejects(h.importTarget(importHookSpy({ fullDump: 'dump' }).hooks), /обрыв транспорта/);

      assertUntouched(h, before);
    });
  });

  // ── 9. испорченный cdi.zip ────────────────────────────────────────────────────────────────────

  test('9. испорченный cdi.zip → запасной путь; CDI зеркала не перезаписывался (uploadFromFile не вызывался), M не очищался', async () => {
    let counting: CountingAgentFileStore | undefined;
    await begin({
      coverage: 'sparse',
      harness: { wrapStore: (store: AgentFileStore) => { counting = new CountingAgentFileStore(store); return counting; } },
    });
    assert.ok(counting);
    const callsBefore = counting.calls.length;
    h.emulator.removeObject('Document.Заказ');
    h.emulator.nextArchiveTamper = (zip) => zip.subarray(0, zip.length - 40);
    const spy = importHookSpy({ fullDump: 'dump' });

    const result = await h.importTarget(spy.hooks);

    const uploads = counting.calls.slice(callsBefore).filter((call) => call.method === 'uploadFromFile');
    assert.deepStrictEqual(uploads.filter((call) => call.path.endsWith(`/${CDI}`) && call.path.startsWith(h.mirrorDir)), []);
    assert.strictEqual(result.fullDump?.handling, 'mirror-rewrite');
    assert.deepStrictEqual(spy.fullDumpRequests.map((request) => request.reason), ['mirror-rewrite']);
    await assertCommon(h, from, 'sparse');
  });

  // ── 10. владелец неизвестного вида ────────────────────────────────────────────────────────────

  suite('10. в CDI зеркала подложен владелец неизвестного вида, которого нет в базе', () => {
    const plantUnknownOwner = (): void => {
      const text = h.readM(CDI);
      fs.writeFileSync(
        path.join(h.mirrorAbs, CDI),
        text.replace('</ConfigVersions>', '  <Metadata name="Foo.Bar" id="foo-bar" configVersion="1"/>\n</ConfigVersions>')
      );
    };

    // Ревью: перезапись M здесь не помогла бы — тот же владелец после неё дал бы архив unresolved-objects (две полные
    // серверные выгрузки и два вопроса). Поэтому сразу архив full-dump до мутаций: одна выгрузка, один вопрос.
    test("unresolved → архив full-dump с вопросом до мутаций; 'cancel' ничего не меняет", async () => {
      await begin({ coverage: 'sparse' });
      plantUnknownOwner();
      const before = snapshotUntouched(h);
      const spy = importHookSpy({ fullDump: 'cancel' });

      await assert.rejects(h.importTarget(spy.hooks), AgentFullDumpDeclinedError);

      assert.deepStrictEqual(spy.fullDumpRequests.map((request) => [request.reason, request.download]), [['full-dump', true]]);
      assertUntouched(h, before);
    });

    test("'dump': ровно одна полная выгрузка (архив full-dump, M засеян заново), один вопрос; P ≡ БД, манифест fresh", async () => {
      await begin({ coverage: 'sparse' });
      plantUnknownOwner();
      h.emulator.putFile('Catalogs/Клиенты.xml', CLIENT_V2);
      const spy = importHookSpy({ fullDump: 'dump' });

      const result = await h.importTarget(spy.hooks);

      assert.strictEqual(result.strategy, 'archive');
      assert.strictEqual(result.reason, 'full-dump');
      assert.strictEqual(result.seededFrom, 'archive');
      assert.deepStrictEqual(dumpKindsFrom(h.emulator, from), ['get-changes', 'info-only', 'archive'], 'перезаписи M нет');
      assert.strictEqual(h.emulator.fullRewriteUpdates, 0);
      assert.deepStrictEqual(spy.fullDumpRequests.map((request) => [request.reason, request.download]), [['full-dump', true]]);
      assert.ok(spy.messages.some((message) => message.includes('Foo.Bar')), spy.messages.join(' | '));
      expectPEqualsDbWithInfo();
      assert.strictEqual(h.manifest().mirrorState, 'fresh');
    });
  });

  // ── 11. самокоррекция: ложный «пропал» ────────────────────────────────────────────────────────

  for (const coverage of COVERAGES) {
    test(`11. свежий CDI подменён без живого Catalog.Клиенты (M ${coverage}): Клиенты приходит в списке №2 как New, файлы в P на месте, не в removedOwners`, async () => {
      await begin({ coverage });
      h.emulator.removeObject('Document.Заказ');
      h.emulator.nextArchiveTamper = (zip) => {
        const entries = readZipAsMap(zip);
        return buildZip([...entries].map(([name, data]) => ({
          name,
          data: name === CDI ? Buffer.from(cutOwnerFromCdiText(data.toString('utf-8'), 'Catalog.Клиенты'), 'utf-8') : data,
        })));
      };

      const result = await h.importTarget();

      assert.strictEqual(result.strategy, 'delta');
      assert.deepStrictEqual(result.fullDump, { handling: 'pruned', removedOwners: ['Document.Заказ'], replacedOwners: [] });
      assert.strictEqual(h.readP('Catalogs/Клиенты.xml'), '<Catalog>Клиенты</Catalog>', 'файл живого владельца на месте');
      assert.deepStrictEqual(dumpKindsFrom(h.emulator, from), [...FIRST_FLOW, 'update']);
      assert.strictEqual(h.emulator.fullRewriteUpdates, 0);
      if (coverage === 'full') {
        assertMirrorEqualsDb(h);
      }
      await assertCommon(h, from, coverage);
    });
  }

  // ── 11b. расхождение повторного списка со сравнением файлов версий ────────────────────────────

  for (const coverage of COVERAGES) {
    test(`11b. в свежем CDI у живого Catalog.Клиенты другая версия, а в повторном списке его нет (M ${coverage}): расхождение в журнале, владелец только сравнивается; дельта, P ≡ БД`, async () => {
      await begin({ coverage });
      h.emulator.removeObject('Document.Заказ');
      // Гонка/иная логика агента: сравнение CDI видит изменение, которого повторный список не подтверждает
      h.emulator.nextArchiveTamper = (zip) => {
        const entries = readZipAsMap(zip);
        return buildZip([...entries].map(([name, data]) => ({
          name,
          data: name === CDI
            ? Buffer.from(data.toString('utf-8').replace(/(<Metadata name="Catalog\.Клиенты" [^>]*configVersion=")\d+"/, '$1999999"'), 'utf-8')
            : data,
        })));
      };
      const spy = importHookSpy();

      const result = await h.importTarget(spy.hooks);

      assert.strictEqual(result.strategy, 'delta', 'отсутствие владельца в разреженном M — не повод для архива');
      assert.deepStrictEqual(result.fullDump, { handling: 'pruned', removedOwners: ['Document.Заказ'], replacedOwners: [] });
      assert.ok(
        spy.messages.some((message) => message.includes('Повторный список') && message.includes('Catalog.Клиенты')),
        spy.messages.join(' | ')
      );
      assert.deepStrictEqual(dumpKindsFrom(h.emulator, from), [...FIRST_FLOW]);
      assert.strictEqual(h.readP('Catalogs/Клиенты.xml'), '<Catalog>Клиенты</Catalog>');
      await assertCommon(h, from, coverage);
    });
  }

  // ── 12. отмена ────────────────────────────────────────────────────────────────────────────────

  suite('12. отмена', () => {
    test('на info-only: AgentSyncCancelledError, манифест и M побайтно прежние', async () => {
      await begin({ coverage: 'sparse' });
      h.emulator.removeObject('Document.Заказ');
      const cancellation = { isCancellationRequested: false };
      h.emulator.onCommand = (command) => {
        if (dumpKindOf(command) === 'info-only') {
          cancellation.isCancellationRequested = true;
        }
      };
      const before = snapshotUntouched(h);

      await assert.rejects(h.importTarget({ cancellation }), AgentSyncCancelledError);

      assertUntouched(h, before);
      assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
    });

    for (const coverage of COVERAGES) {
      test(`на повторном get-changes (M ${coverage}): манифест empty с прежней полнотой, P не тронут; следующий импорт приводит P к БД`, async () => {
        await begin({ coverage });
        h.emulator.removeObject('Document.Заказ');
        const cancellation = { isCancellationRequested: false };
        h.emulator.onCommand = (command) => {
          if (dumpKindOf(command) === 'get-changes-retry') {
            cancellation.isCancellationRequested = true;
          }
        };
        const pBefore = h.snapshotP();

        await assert.rejects(h.importTarget({ cancellation }), AgentSyncCancelledError);

        assert.strictEqual(h.manifest().mirrorState, 'empty');
        assert.strictEqual(h.manifest().mirrorCoverage, coverage);
        assert.deepStrictEqual(h.snapshotP(), pBefore);

        h.emulator.onCommand = undefined;
        await h.importTarget();
        expectPEqualsDbWithInfo();
        assert.strictEqual(h.manifest().mirrorState, 'fresh');
      });
    }
  });

  // ── 13. сбой закачки CDI зеркала ──────────────────────────────────────────────────────────────

  test('13. сбой uploadFromFile CDI зеркала: ошибка, манифест empty, CDI зеркала прежний; следующий импорт → P ≡ БД', async () => {
    class FailCdiUploadStore extends DelegatingAgentFileStore {
      armed = false;
      override uploadFromFile(localPath: string, rel: string, options?: AgentStreamOptions): Promise<void> {
        return this.armed && rel.endsWith(`/${CDI}`) ? Promise.reject(new Error('сбой закачки файла версий')) : super.uploadFromFile(localPath, rel, options);
      }
    }
    let store: FailCdiUploadStore | undefined;
    await begin({ coverage: 'sparse', harness: { wrapStore: (inner) => { store = new FailCdiUploadStore(inner); return store; } } });
    assert.ok(store);
    h.emulator.removeObject('Document.Заказ');
    const cdiBefore = h.readM(CDI);
    const pBefore = h.snapshotP();
    store.armed = true;

    await assert.rejects(h.importTarget(), /сбой закачки файла версий/);

    assert.strictEqual(h.manifest().mirrorState, 'empty');
    assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
    assert.strictEqual(h.readM(CDI), cdiBefore, 'CDI зеркала прежний');
    assert.deepStrictEqual(h.snapshotP(), pBefore);

    store.armed = false;
    await h.importTarget();
    expectPEqualsDbWithInfo();
  });

  // ── 14. повторный список не распознан ─────────────────────────────────────────────────────────

  for (const coverage of COVERAGES) {
    test(`14. повторный список не распознан (M ${coverage}) → архив unrecognized, M засеян из архива; P ≡ БД`, async () => {
      await begin({ coverage });
      h.emulator.removeObject('Document.Заказ');
      h.emulator.onCommand = (command) => {
        if (dumpKindOf(command) === 'get-changes-retry') {
          h.emulator.nextChangesText = `${BOM}Deleted: Catalog.Клиенты\r\n`;
        }
      };
      const spy = importHookSpy({ fullDump: 'dump' });

      const result = await h.importTarget(spy.hooks);

      assert.strictEqual(result.strategy, 'archive');
      assert.strictEqual(result.reason, 'unrecognized');
      assert.strictEqual(result.seededFrom, 'archive');
      assert.deepStrictEqual(spy.fullDumpRequests.map((request) => [request.reason, request.download]), [['unrecognized', true]]);
      assert.deepStrictEqual(h.listM(), [CDI, 'Configuration.xml']);
      assert.strictEqual(h.manifest().mirrorState, 'fresh');
      assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
      expectPEqualsDbWithInfo();
    });
  }

  // ── 15. разреженный M + локальные правки ──────────────────────────────────────────────────────

  test('15. sparse + локальные правки: файл удалённого владельца удаляется без restore; правка неизменённого владельца, отсутствующего в M, — restore, как раньше', async () => {
    await begin({ coverage: 'sparse' });
    h.emulator.removeObject('Document.Заказ');
    h.writeP('Documents/Заказ/Ext/ObjectModule.bsl', 'моя правка в файле удалённого владельца');
    h.writeP('Catalogs/Товары/Ext/ObjectModule.bsl', 'моя правка неизменённого владельца');

    const result = await h.importTarget();

    assert.strictEqual(result.strategy, 'delta');
    assert.strictEqual(result.restoredFromDatabase, 1, 'из базы взят только файл неизменённого владельца');
    assert.ok(!h.existsP('Documents/Заказ/Ext/ObjectModule.bsl'));
    assert.strictEqual(h.emulator.listDumpCalls, 1);
    assert.ok((h.emulator.lastListNames ?? []).every((name) => !name.startsWith('Document.Заказ')), 'владельца, удалённого в базе, из базы не просят');
    assert.ok((h.emulator.lastListNames ?? []).some((name) => name.startsWith('Catalog.Товары')));
    await assertCommon(h, from, 'sparse');
  });

  // ── 16. порог ─────────────────────────────────────────────────────────────────────────────────

  suite('16. порог archiveThresholdFiles', () => {
    for (const coverage of COVERAGES) {
      test(`владелец с несколькими файлами + 1 изменённый файл при пороге 1 (M ${coverage}) → дельта: файлы удалённого владельца в порог не входят`, async () => {
        await begin({ coverage, harness: { archiveThresholdFiles: 1 } });
        h.emulator.removeObject('Document.Заказ');
        h.emulator.putFile('Catalogs/Клиенты.xml', CLIENT_V2);

        const result = await h.importTarget();

        assert.strictEqual(result.strategy, 'delta');
        assert.ok(ORDER_FILES.length > 1);
        await assertCommon(h, from, coverage);
      });
    }

    test('перезапись зеркала: изменённых файлов больше порога → всё равно дельта (серверная выгрузка уже выполнена)', async () => {
      await begin({ coverage: 'full', seed: seedRootPart, harness: { archiveThresholdFiles: 1 } });
      removeRootPart(h.emulator);
      h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
      h.emulator.putFile('Catalogs/Товары/Ext/ObjectModule.bsl', 'v2');
      h.emulator.putFile('Catalogs/Клиенты.xml', CLIENT_V2);

      const result = await h.importTarget(importHookSpy({ fullDump: 'dump' }).hooks);

      assert.strictEqual(result.strategy, 'delta');
      assert.strictEqual(result.fullDump?.handling, 'mirror-rewrite');
      await assertCommon(h, from, 'full');
    });
  });

  // ── 17. посев из проекта, затем удалена часть корня ───────────────────────────────────────────

  test("17. посев из проекта, затем в базе удалена часть корня → 'cancel': consent import-after-seed, текст про подготовленное зеркало", async () => {
    h = await createHarness('sftp');
    h.seedDb();
    seedRootPart(h.emulator);
    h.emulator.setConfiguration('Основная', 'cf');
    h.emulator.updateGranularity = 'changed-files';
    h.emulator.snapshotToProject(h.configRoot);
    removeRootPart(h.emulator);
    const spy = importHookSpy({ seed: 'seed', fullDump: 'cancel' });

    await assert.rejects(h.importTarget(spy.hooks), (error: unknown) => {
      assert.ok(error instanceof AgentFullDumpDeclinedError);
      assert.strictEqual(error.consent, 'import-after-seed');
      assert.match(error.message, /Зеркало агента уже подготовлено/);
      assert.ok(error.message.includes(SERVER_DUMP_POLICY['mirror-rewrite'].text), error.message);
      return true;
    });

    assert.deepStrictEqual(spy.calls, ['seed', 'fullDump']);
    assert.strictEqual(spy.fullDumpRequests[0].reason, 'mirror-rewrite');
  });

  // ── 18. разреженный M: перезапись показала удалённые части ────────────────────────────────────

  suite('18. sparse + запасной путь: сравнение показало удалённые части → вопрос sparse-removed-parts → архив', () => {
    for (const mode of FULL_DUMP_UPDATE_MODES) {
      test(`'dump' на обоих вопросах (перезапись ${mode}): P ≡ БД, причина архива sparse-removed-parts`, async () => {
        await begin({ coverage: 'sparse', seed: seedRootPart });
        h.emulator.fullDumpUpdate = mode;
        removeRootPart(h.emulator);
        const spy = importHookSpy({ fullDump: 'dump' });

        const result = await h.importTarget(spy.hooks);

        assert.deepStrictEqual(spy.fullDumpRequests.map((request) => [request.reason, request.download]), [
          ['mirror-rewrite', false],
          ['sparse-removed-parts', true],
        ]);
        assert.strictEqual(result.strategy, 'archive');
        assert.strictEqual(result.reason, 'sparse-removed-parts');
        expectPEqualsDbWithInfo();
        assert.strictEqual(h.manifest().mirrorState, 'fresh');
      });
    }

    test("'cancel' на втором вопросе: AgentFullDumpDeclinedError, манифест empty, полнота прежняя (sparse), P не тронут", async () => {
      await begin({ coverage: 'sparse', seed: seedRootPart });
      removeRootPart(h.emulator);
      const pBefore = h.snapshotP();
      let asked = 0;
      const spy = importHookSpy({
        extra: {
          confirmFullDump: () => { asked += 1; return Promise.resolve(asked === 1 ? 'dump' : 'cancel'); },
        },
      });

      await assert.rejects(h.importTarget(spy.hooks), AgentFullDumpDeclinedError);

      assert.strictEqual(asked, 2);
      assert.strictEqual(h.manifest().mirrorState, 'empty');
      assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
      assert.deepStrictEqual(h.snapshotP(), pBefore);
    });
  });

  // ── 19. после перезаписи изменён владелец неизвестного вида ───────────────────────────────────

  test("19. после перезаписи в базе появился владелец неизвестного вида → архив unresolved-objects", async () => {
    await begin({ coverage: 'full', seed: seedRootPart });
    removeRootPart(h.emulator);
    h.emulator.setObject('Foo.Bar', { 'Foo/Bar.xml': '<Foo>Bar</Foo>' });
    const spy = importHookSpy({ fullDump: 'dump' });

    const result = await h.importTarget(spy.hooks);

    assert.strictEqual(result.strategy, 'archive');
    assert.strictEqual(result.reason, 'unresolved-objects');
    assert.deepStrictEqual(spy.fullDumpRequests.map((request) => request.reason), ['mirror-rewrite', 'unresolved-objects']);
    expectPEqualsDbWithInfo();
  });

  // ── 20. удалён корень ─────────────────────────────────────────────────────────────────────────

  for (const coverage of COVERAGES) {
    test(`20. удалён корень конфигурации (M ${coverage}): страж свежего CDI → запасной путь → «Агент не выгрузил конфигурацию»; P не тронут, манифест empty`, async () => {
      await begin({ coverage });
      h.emulator.removeObject('Configuration.Конфигурация');
      const pBefore = h.snapshotP();

      await assert.rejects(h.importTarget(), /Агент не выгрузил конфигурацию/);

      assert.deepStrictEqual(h.snapshotP(), pBefore);
      assert.strictEqual(h.manifest().mirrorState, 'empty');
      assert.strictEqual(h.manifest().mirrorCoverage, coverage);
      assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
    });
  }

  // ── 23, 24. CDI зеркала недоступен для очистки ────────────────────────────────────────────────

  test("23. CDI зеркала с несбалансированными тегами → редактор отказывает до мутаций → запасной путь: вопрос mirror-rewrite, 'cancel' ничего не меняет", async () => {
    await begin({ coverage: 'sparse' });
    fs.writeFileSync(path.join(h.mirrorAbs, CDI), h.readM(CDI).replace('\n  </Metadata>', ''));
    h.emulator.removeObject('Document.Заказ');
    const before = snapshotUntouched(h);
    const spy = importHookSpy({ fullDump: 'cancel' });

    await assert.rejects(h.importTarget(spy.hooks), AgentFullDumpDeclinedError);

    assert.deepStrictEqual(spy.fullDumpRequests.map((request) => request.reason), ['mirror-rewrite']);
    assertUntouched(h, before);
  });

  test('24. CDI зеркала неразборчив (нет корня) → архив full-dump; P ≡ БД', async () => {
    await begin({ coverage: 'sparse' });
    fs.writeFileSync(path.join(h.mirrorAbs, CDI), 'это не файл версий');
    h.emulator.nextChangesText = `${BOM}FullDump\r\n`;
    const spy = importHookSpy({ fullDump: 'dump' });

    const result = await h.importTarget(spy.hooks);

    assert.strictEqual(result.strategy, 'archive');
    assert.strictEqual(result.reason, 'full-dump');
    assert.deepStrictEqual(spy.fullDumpRequests.map((request) => [request.reason, request.download]), [['full-dump', true]]);
    expectPEqualsDbWithInfo();
  });

  // ── регресс: обычный импорт без FullDump ──────────────────────────────────────────────────────

  test('обычное изменение (без удаления): fullDump в результате нет, свежий CDI не запрашивается', async () => {
    await begin({ coverage: 'sparse' });
    h.emulator.putFile('Catalogs/Клиенты.xml', CLIENT_V2);

    const result = await h.importTarget();

    assert.strictEqual(result.strategy, 'delta');
    assert.strictEqual(result.fullDump, undefined);
    assert.strictEqual(h.emulator.infoOnlyDumps, 0);
    assert.deepStrictEqual(dumpKindsFrom(h.emulator, from), ['get-changes', 'update']);
  });
});

// ── 21. cfe: прежний путь ───────────────────────────────────────────────────────────────────────

suite('AgentSyncEngine: FullDump, цель cfe — прежний путь (архив full-dump)', function () {
  this.timeout(120_000);
  let h: SyncHarness;
  teardown(async () => { await h.dispose(); });

  for (const coverage of COVERAGES) {
    test(`21. удаление владельца (M ${coverage}): архив full-dump как раньше, свежий CDI не запрашивается и CDI зеркала не скачивается`, async () => {
      let counting: CountingAgentFileStore | undefined;
      h = await startAvoidHarness({
        coverage,
        targetKind: 'cfe',
        harness: { wrapStore: (store: AgentFileStore) => { counting = new CountingAgentFileStore(store); return counting; } },
      });
      assert.ok(counting);
      const callsBefore = counting.calls.length;
      const from = h.emulator.commands.length;
      h.emulator.removeObject('Document.Заказ');
      const spy = importHookSpy({ fullDump: 'dump' });

      const result = await h.importTarget(spy.hooks);

      assert.strictEqual(result.strategy, 'archive');
      assert.strictEqual(result.reason, 'full-dump');
      assert.strictEqual(result.fullDump, undefined);
      assert.strictEqual(h.emulator.infoOnlyDumps, 0);
      assert.deepStrictEqual(dumpKindsFrom(h.emulator, from), ['get-changes', 'archive']);
      assert.deepStrictEqual(spy.fullDumpRequests.map((request) => [request.reason, request.download]), [['full-dump', true]]);
      const cdiReads = counting.calls.slice(callsBefore).filter((call) => call.path.startsWith(h.mirrorDir) && call.path.endsWith(`/${CDI}`)
        && (call.method === 'readFile' || call.method === 'downloadToFile'));
      assert.deepStrictEqual(cdiReads, [], 'CDI зеркала не скачивался');
      assert.deepStrictEqual(h.snapshotP(), dbAsText(h.emulator.dbFiles()));
    });
  }
});

// ── 22. local: прежний путь compare ─────────────────────────────────────────────────────────────

suite('AgentSyncEngine: FullDump, локальное хранилище — compare (регресс)', function () {
  this.timeout(60_000);
  let h: SyncHarness;
  teardown(async () => { await h.dispose(); });

  test('22. удаление владельца → compare; свежий CDI не запрашивается, архива нет; P ≡ БД', async () => {
    h = await createHarness('local');
    h.seedDb();
    h.emulator.setConfiguration('Основная', 'cf');
    await h.importTarget();
    const from = h.emulator.commands.length;
    h.emulator.removeObject('Document.Заказ');

    const result = await h.importTarget();

    assert.strictEqual(result.strategy, 'compare');
    assert.strictEqual(result.fullDump, undefined);
    assert.strictEqual(h.emulator.infoOnlyDumps, 0);
    assert.ok(!dumpKindsFrom(h.emulator, from).some((kind) => kind === 'archive' || kind === 'info-only'));
    assert.deepStrictEqual(h.snapshotP(), dbAsText(h.emulator.dbFiles()));
    assert.deepStrictEqual(dbAsBase64(h.emulator.dbFiles()), h.snapshotM());
  });

  test('22b. переименование только регистром → compare: модуль живого объекта не пропадает, P ≡ БД без учёта регистра пути и ≡ M', async () => {
    h = await createHarness('local');
    h.seedDb();
    h.emulator.setConfiguration('Основная', 'cf');
    await h.importTarget();
    h.emulator.removeObject('Catalog.Товары');
    h.emulator.setObject('Catalog.товары', {
      'Catalogs/товары.xml': '<Catalog>товары</Catalog>',
      'Catalogs/товары/Ext/ObjectModule.bsl': 'Процедура Товары() КонецПроцедуры',
    });

    const result = await h.importTarget();

    assert.strictEqual(result.strategy, 'compare');
    // Каталог M эмулятор дописывает на месте (на регистронезависимой ФС он сохраняет прежний регистр), а compare
    // повторяет M: регистр каталогов сверяется с M, а содержимое — с базой без учёта регистра пути.
    const lowered = (files: Record<string, string>): Record<string, string> =>
      Object.fromEntries(Object.entries(files).map(([rel, data]) => [rel.toLowerCase(), data]));
    assert.deepStrictEqual(lowered(h.snapshotP()), lowered(dbAsText(h.emulator.dbFiles())), 'модуль живого объекта на месте');
    assert.deepStrictEqual(Object.keys(h.snapshotP()).sort(), Object.keys(h.snapshotM()).sort(), 'P повторяет M');
  });
});
