import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_ARCHIVE_THRESHOLD_FILES } from '../../infra/agent/sync/AgentSyncEngine';
import { AgentFullDumpDeclinedError, AgentSyncCancelledError } from '../../infra/agent/sync/SyncContext';
import { ARCHIVE_REASON_POLICY } from '../../infra/agent/sync/SyncPlanner';
import { buildSyncManifestFiles } from '../../infra/agent/sync/SyncManifest';
import { inspectProjectMirrorSeed } from '../../infra/agent/sync/MirrorSeed';
import type { AgentFileStore } from '../../infra/agent/files/AgentFileStore';
import { hasOption } from './support/agentConfigEmulator';
import { agentError } from './support/agentInfoBaseFakes';
import {
  createHarness,
  dbAsText,
  HARNESS_EXTENSION_NAME,
  type HarnessOptions,
  type HarnessTargetKind,
  type SyncHarness,
} from './support/agentSyncHarness';
import {
  ConcurrencyProbeStore,
  RICH_DOCUMENT_FILES,
  findFilesNamed,
  importHookSpy,
  seedBulkOwners,
  seedRichDocument,
  snapshotDirBytes,
} from './support/archiveAvoidFixtures';

/**
 * Полная выгрузка — только когда без неё нельзя (plan-archive-avoid.md §3, §6, §8; удалённый агент, SFTP).
 * Агент — эмулятор по фактам пилота и эксперимента 12; SFTP — настоящий ssh2.Server. ВНИМАНИЕ: поведение
 * агента для расширения (`--extension`) экспериментом не проверено — сценарии cfe построены по плану, а
 * эмулятор отвечает для них так же, как для основной конфигурации.
 */

const BOM = String.fromCharCode(0xfeff);
const FORM_BODY = 'Documents/Д/Forms/Ф/Ext/Form.xml';
const TEMPLATE = 'Documents/Д/Templates/М.xml';
const TARGET_KINDS: readonly HarnessTargetKind[] = ['cf', 'cfe'];
const sha1 = (data: Buffer): string => createHash('sha1').update(data).digest('hex');

suite('AgentSyncEngine: умолчание порога', () => {
  test('DEFAULT_ARCHIVE_THRESHOLD_FILES = 20000 (было 300: полная выгрузка при любой «средней» правке)', () => {
    assert.strictEqual(DEFAULT_ARCHIVE_THRESHOLD_FILES, 20_000);
  });
});

suite('AgentSyncEngine: полная выгрузка только по необходимости (sftp)', function () {
  this.timeout(180_000);
  let h: SyncHarness;
  let probe: ConcurrencyProbeStore | undefined;

  async function start(
    kind: HarnessTargetKind,
    options: HarnessOptions & { rich?: boolean; probeStore?: boolean } = {}
  ): Promise<void> {
    probe = undefined;
    const { rich, probeStore, ...harnessOptions } = options;
    h = await createHarness('sftp', {
      ...harnessOptions,
      targetKind: kind,
      ...(probeStore === true ? { wrapStore: (store: AgentFileStore) => { probe = new ConcurrencyProbeStore(store); return probe; } } : {}),
    });
    h.seedDb();
    if (rich === true) {
      seedRichDocument(h.emulator);
    }
    h.emulator.setConfiguration(kind === 'cf' ? 'Основная' : HARNESS_EXTENSION_NAME, kind);
  }
  teardown(async () => { await h.dispose(); });

  const extensionOf = (kind: HarnessTargetKind): string | undefined => (kind === 'cfe' ? HARNESS_EXTENSION_NAME : undefined);
  const targetNameOf = (kind: HarnessTargetKind): string => (kind === 'cf' ? 'Основная' : HARNESS_EXTENSION_NAME);

  function expectPMatchesDb(withInfo: boolean): void {
    const expected = dbAsText(withInfo ? h.emulator.dbFiles() : h.emulator.dbTrackedFiles());
    const actual = h.snapshotP();
    if (!withInfo) {
      delete actual['ConfigDumpInfo.xml'];
    }
    assert.deepStrictEqual(actual, expected);
  }

  /** Команды выгрузки после точки `from`, кроме чтения списка изменений: то, что мутирует M или тянет архив. */
  const mutatingDumps = (from: number): ReturnType<SyncHarness['emulator']['dumps']> =>
    h.emulator.dumps().slice(from).filter((d) => !hasOption(d, 'get-changes'));

  /** Подмена выгрузки проекта «руками»: свежая выгрузка базы ПОВЕРХ прежней, без очистки; CDI с другим mtime. */
  function replaceProjectDump(): void {
    h.emulator.snapshotToProject(h.configRoot);
    const cdi = path.join(h.configRoot, 'ConfigDumpInfo.xml');
    const mtime = new Date('2031-01-02T03:04:05Z');
    fs.utimesSync(cdi, mtime, mtime);
  }

  /** Недавний импорт создаёт M разреженным (самопосев из архива) и запоминает отпечаток CDI проекта. */
  async function firstImport(hooks?: Parameters<SyncHarness['importTarget']>[0]): Promise<void> {
    await h.importTarget(hooks);
    assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
  }

  // ── a, b: FullDump / unrecognized без лишней выгрузки в M ──────────────────────────────────────

  for (const kind of TARGET_KINDS) {
    suite(`FullDump и unrecognized, цель ${kind}`, () => {
      const scenarios = [
        {
          reason: 'full-dump' as const,
          prepare: (): void => { h.emulator.removeObject('Document.Заказ'); },
        },
        {
          reason: 'unrecognized' as const,
          prepare: (): void => {
            h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>Клиенты v2</Catalog>');
            h.emulator.nextChangesText = `${BOM}Deleted: Catalog.Клиенты\r\n`;
          },
        },
      ];

      for (const { reason, prepare } of scenarios) {
        test(`${reason} без хука: ровно ОДНА полная выгрузка (--archive), --update без --get-changes в операции нет; M засеян из архива (sparse), P ≡ БД`, async () => {
          await start(kind);
          await firstImport();
          // Прежний M с лишним файлом: самопосев из архива заменяет его целиком.
          h.emulator.updateGranularity = 'owner';
          h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
          await h.importTarget();
          assert.ok(h.listM().includes('Catalogs/Товары.xml'), 'сценарий: в M есть файл после дельты');
          prepare();
          const from = h.emulator.commands.length;

          const result = await h.importTarget();

          assert.strictEqual(result.strategy, 'archive');
          assert.strictEqual(result.reason, reason);
          assert.strictEqual(result.seededFrom, 'archive');
          const dumps = h.emulator.dumps().slice(from);
          assert.strictEqual(dumps.length, 2, 'список изменений и архив');
          assert.ok(hasOption(dumps[0], 'get-changes') && dumps[0].options.update === true);
          assert.strictEqual(dumps[1].options.archive, 'full.zip');
          assert.ok(!dumps[1].options.update);
          assert.deepStrictEqual(mutatingDumps(from).map((d) => d.options.archive), ['full.zip'], 'единственная мутирующая команда — архив');
          assert.deepStrictEqual(h.listM(), ['ConfigDumpInfo.xml', 'Configuration.xml']);
          assert.strictEqual(h.readM('ConfigDumpInfo.xml'), h.emulator.dbFiles()['ConfigDumpInfo.xml'].toString('utf-8'));
          assert.strictEqual(h.manifest().mirrorState, 'fresh');
          assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
          assert.deepStrictEqual(h.manifest().files, await buildSyncManifestFiles(h.configRoot));
          expectPMatchesDb(true);
          assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
          assert.deepStrictEqual(h.localExchangeLeftovers(), []);
        });

        test(`${reason} + хук 'cancel': AgentFullDumpDeclinedError (и AgentSyncCancelledError), мутирующих команд 0, M, P и файл манифеста побайтно прежние; хук получил причину и цель`, async () => {
          await start(kind);
          await firstImport();
          prepare();
          const mBefore = h.snapshotM();
          const pBefore = h.snapshotP();
          const manifestBefore = h.rawManifestText();
          const from = h.emulator.commands.length;
          const spy = importHookSpy({ fullDump: 'cancel' });

          await assert.rejects(h.importTarget(spy.hooks), (error: unknown) =>
            error instanceof AgentFullDumpDeclinedError && error instanceof AgentSyncCancelledError && error.name === 'AgentFullDumpDeclinedError');

          assert.deepStrictEqual(mutatingDumps(from), [], 'ни архива, ни --update без --get-changes');
          assert.strictEqual(h.emulator.updateDbCalls, 0);
          assert.deepStrictEqual(h.snapshotM(), mBefore);
          assert.deepStrictEqual(h.snapshotP(), pBefore);
          assert.strictEqual(h.rawManifestText(), manifestBefore);
          assert.deepStrictEqual(spy.fullDumpRequests, [{
            targetKind: kind,
            targetName: targetNameOf(kind),
            projectDir: h.configRoot,
            operation: 'import',
            reason,
            reasonText: ARCHIVE_REASON_POLICY[reason].text,
          }]);
          assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
          assert.deepStrictEqual(h.localExchangeLeftovers(), []);
        });

        test(`${reason} + хук 'dump': вопрос задан один раз, дальше — как без хука (одна полная выгрузка)`, async () => {
          await start(kind);
          await firstImport();
          prepare();
          const from = h.emulator.commands.length;
          const spy = importHookSpy({ fullDump: 'dump' });

          const result = await h.importTarget(spy.hooks);

          assert.strictEqual(spy.fullDumpRequests.length, 1);
          assert.strictEqual(spy.fullDumpRequests[0].reason, reason);
          assert.strictEqual(result.reason, reason);
          assert.deepStrictEqual(mutatingDumps(from).map((d) => d.options.archive), ['full.zip']);
          expectPMatchesDb(true);
        });
      }

      test('текст ошибки отказа — инструкция ручной выгрузки: «выгрузите вручную», замена каталога, ConfigDumpInfo.xml, следующий импорт', async () => {
        await start(kind);
        await firstImport();
        h.emulator.removeObject('Document.Заказ');

        await assert.rejects(h.importTarget(importHookSpy({ fullDump: 'cancel' }).hooks), (error: unknown) => {
          assert.ok(error instanceof AgentFullDumpDeclinedError);
          assert.match(error.message, /Полная выгрузка на сервере отменена\./);
          assert.match(error.message, /Выгрузите конфигурацию в файлы вручную \(иерархический формат\)/);
          assert.match(error.message, /включая ConfigDumpInfo\.xml/);
          assert.match(error.message, /следующий импорт предложит взять её за основу/);
          return true;
        });
      });

      test('mirror-empty без посева (в P нет CDI) + хук: вопрос задан; cancel → M НЕ очищен, манифест прежний, ни одной команды выгрузки', async () => {
        await start(kind);
        fs.mkdirSync(path.join(h.mirrorAbs, 'Catalogs'), { recursive: true });
        fs.writeFileSync(path.join(h.mirrorAbs, 'Catalogs', 'Остаток.xml'), '<stale/>');
        h.saveManifest('empty', {});
        const mBefore = h.snapshotM();
        const manifestBefore = h.rawManifestText();
        const spy = importHookSpy({ fullDump: 'cancel' });

        await assert.rejects(h.importTarget(spy.hooks), AgentFullDumpDeclinedError);

        assert.strictEqual(spy.fullDumpRequests.length, 1);
        assert.strictEqual(spy.fullDumpRequests[0].reason, 'mirror-empty');
        assert.strictEqual(spy.fullDumpRequests[0].reasonText, ARCHIVE_REASON_POLICY['mirror-empty'].text);
        assert.deepStrictEqual(h.emulator.dumps(), [], 'агент не вызывался');
        assert.deepStrictEqual(h.snapshotM(), mBefore, 'остаток M не удалён: remove не вызывался');
        assert.strictEqual(h.rawManifestText(), manifestBefore);
        assert.strictEqual(fs.existsSync(h.configRoot), false, 'P не создан');
      });

      test("mirror-empty без посева + хук 'dump': недостоверный M очищен, архив, самопосев из архива", async () => {
        await start(kind);
        fs.mkdirSync(path.join(h.mirrorAbs, 'Catalogs'), { recursive: true });
        fs.writeFileSync(path.join(h.mirrorAbs, 'Catalogs', 'Остаток.xml'), '<stale/>');
        const spy = importHookSpy({ fullDump: 'dump' });

        const result = await h.importTarget(spy.hooks);

        assert.strictEqual(spy.fullDumpRequests.length, 1);
        assert.strictEqual(result.reason, 'mirror-empty');
        assert.strictEqual(result.seededFrom, 'archive');
        assert.deepStrictEqual(h.listM(), ['ConfigDumpInfo.xml', 'Configuration.xml']);
        expectPMatchesDb(true);
      });

      test('проверки посева провалены (в P нет CDI), хук посева есть: он не вызван, вопрос о полной выгрузке задан ОДИН раз', async () => {
        await start(kind);
        const spy = importHookSpy({ seed: 'seed', fullDump: 'dump' });

        await h.importTarget(spy.hooks);

        assert.deepStrictEqual(spy.calls, ['fullDump']);
      });

      test("в вопросе о посеве выбрано «Полная выгрузка»: confirmFullDump НЕ вызывается (решение уже принято), архив mirror-empty", async () => {
        await start(kind);
        h.emulator.snapshotToProject(h.configRoot);
        const spy = importHookSpy({ seed: 'full', fullDump: 'cancel' });

        const result = await h.importTarget(spy.hooks);

        assert.deepStrictEqual(spy.calls, ['seed']);
        assert.strictEqual(result.strategy, 'archive');
        assert.strictEqual(result.reason, 'mirror-empty');
        expectPMatchesDb(true);
      });
    });
  }

  // ── d: порог и отказ после --update ─────────────────────────────────────────────────────────────

  suite('порог архива (archiveThresholdFiles) и вопрос после --update', () => {
    const changeOwners = (revision: string, owners: readonly string[]): void => {
      const files: Record<string, string> = {
        'Товары': 'Catalogs/Товары.xml', 'Клиенты': 'Catalogs/Клиенты.xml', 'Админ': 'Roles/Админ.xml', 'Общий': 'CommonModules/Общий.xml',
      };
      for (const owner of owners) {
        h.emulator.putFile(files[owner], `<changed>${revision}${owner}</changed>`);
      }
    };

    test('ровно порог (5 файлов: Товары 2 + Админ 2 + Клиенты 1) → дельта, вопрос не задаётся', async () => {
      await start('cf', { archiveThresholdFiles: 5 });
      await firstImport();
      changeOwners('v2', ['Товары', 'Админ', 'Клиенты']);
      const spy = importHookSpy({ fullDump: 'cancel' });

      const result = await h.importTarget(spy.hooks);

      assert.strictEqual(result.strategy, 'delta');
      assert.deepStrictEqual(spy.fullDumpRequests, []);
    });

    test("порог+1 (7 файлов) → архив over-threshold + вопрос; 'cancel' → манифест empty и прежняя полнота (sparse), P не тронут", async () => {
      await start('cf', { archiveThresholdFiles: 5 });
      await firstImport();
      changeOwners('v2', ['Товары', 'Админ', 'Клиенты', 'Общий']);
      const pBefore = h.snapshotP();
      const spy = importHookSpy({ fullDump: 'cancel' });

      await assert.rejects(h.importTarget(spy.hooks), AgentFullDumpDeclinedError);

      assert.strictEqual(spy.fullDumpRequests[0].reason, 'over-threshold');
      assert.strictEqual(spy.fullDumpRequests[0].reasonText, ARCHIVE_REASON_POLICY['over-threshold'].text);
      assert.strictEqual(h.manifest().mirrorState, 'empty', 'M уже обновлён --update, P — нет');
      assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
      assert.deepStrictEqual(h.snapshotP(), pBefore);
    });

    test("порог+1 + 'dump' → архив over-threshold, P ≡ БД, манифест fresh", async () => {
      await start('cf', { archiveThresholdFiles: 5 });
      await firstImport();
      changeOwners('v2', ['Товары', 'Админ', 'Клиенты', 'Общий']);

      const result = await h.importTarget(importHookSpy({ fullDump: 'dump' }).hooks);

      assert.strictEqual(result.strategy, 'archive');
      assert.strictEqual(result.reason, 'over-threshold');
      expectPMatchesDb(true);
      assert.strictEqual(h.manifest().mirrorState, 'fresh');
    });

    test("unresolved-objects (вид не из META_TYPES) + 'cancel': вопрос после --update, манифест empty, полнота прежняя", async () => {
      await start('cf');
      await firstImport();
      h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
      h.emulator.nextChangesText = `${BOM}Modified: Foo.Bar\r\nModified: Catalog.Клиенты\r\n`;
      const spy = importHookSpy({ fullDump: 'cancel' });

      await assert.rejects(h.importTarget(spy.hooks), AgentFullDumpDeclinedError);

      assert.strictEqual(spy.fullDumpRequests[0].reason, 'unresolved-objects');
      assert.strictEqual(h.manifest().mirrorState, 'empty');
      assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
    });

    test('умолчание порога: 400 изменённых файлов → дельта, а НЕ архив (регресс старого порога 300)', async () => {
      await start('cf');
      seedBulkOwners(h.emulator, 8, 50);
      await firstImport();
      seedBulkOwners(h.emulator, 8, 50, 'v2');
      const spy = importHookSpy({ fullDump: 'cancel' });

      const result = await h.importTarget(spy.hooks);

      assert.strictEqual(result.strategy, 'delta');
      assert.strictEqual(result.changedProjectFiles.length, 400);
      assert.deepStrictEqual(spy.fullDumpRequests, []);
      assert.ok(h.emulator.dumps().slice(1).every((d) => !d.options.archive));
    });
  });

  // ── e, f, g, h: точечная выгрузка грязных файлов ───────────────────────────────────────────────

  for (const kind of TARGET_KINDS) {
    for (const seedMode of ['archive', 'project'] as const) {
      suite(`точечная выгрузка, цель ${kind}, M засеян из ${seedMode === 'archive' ? 'архива' : 'выгрузки проекта'}`, () => {
        async function prepareSparse(): Promise<void> {
          await start(kind, { rich: true });
          if (seedMode === 'project') {
            h.emulator.snapshotToProject(h.configRoot);
            await h.importTarget(importHookSpy({ seed: 'seed' }).hooks);
            assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
            assert.deepStrictEqual(h.listM(), ['ConfigDumpInfo.xml', 'Configuration.xml']);
          } else {
            await firstImport();
          }
          h.emulator.updateGranularity = 'changed-files';
        }

        test('правка формы и удаление макета неизменённого документа + изменение другого объекта в БД: НЕТ --archive, одна --list-file без --update; файлы восстановлены; M = M после --update; restoredFromDatabase 2', async () => {
          await prepareSparse();
          h.writeP(FORM_BODY, '<FormBody>моя правка</FormBody>');
          h.removeP(TEMPLATE);
          h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
          const from = h.emulator.commands.length;
          let mirrorAfterUpdate: Record<string, string> | undefined;
          h.emulator.onCommand = (cmd) => {
            if (hasOption(cmd, 'list-file')) {
              mirrorAfterUpdate = h.snapshotM();
            }
          };
          h.sftp?.log.splice(0);

          const result = await h.importTarget();

          assert.strictEqual(result.strategy, 'delta');
          assert.strictEqual(result.reason, undefined);
          assert.strictEqual(result.restoredFromDatabase, 2);
          const dumps = h.emulator.dumps().slice(from);
          assert.deepStrictEqual(dumps.map((d) => (hasOption(d, 'get-changes') ? 'changes' : hasOption(d, 'list-file') ? 'list' : d.options.update === true ? 'update' : 'other')), ['changes', 'update', 'list']);
          assert.ok(dumps.every((d) => !d.options.archive), '--archive нет');
          const list = dumps[2];
          assert.ok(!list.options.update);
          assert.strictEqual(list.options.force, true);
          assert.strictEqual(list.options.extension, extensionOf(kind));
          assert.match(String(list.options.dir), /^exchange\/[^/]+\/restore$/);
          assert.match(String(list.options['list-file']), /^exchange\/[^/]+\.objects\.txt$/);
          assert.strictEqual(h.readP(FORM_BODY), RICH_DOCUMENT_FILES[FORM_BODY]);
          assert.strictEqual(h.readP(TEMPLATE), RICH_DOCUMENT_FILES[TEMPLATE]);
          assert.strictEqual(h.readP('Catalogs/Товары.xml'), '<Catalog>Товары v2</Catalog>', 'файл изменённого объекта пришёл дельтой');
          expectPMatchesDb(false);
          // M не получил восстановленных файлов (вариант А): после --update в нём CDI, Configuration.xml и файл Товары.
          assert.deepStrictEqual(h.snapshotM(), mirrorAfterUpdate, 'точечная выгрузка M не меняет');
          assert.deepStrictEqual(h.listM(), ['Catalogs/Товары.xml', 'ConfigDumpInfo.xml', 'Configuration.xml']);
          assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
          assert.strictEqual(h.manifest().mirrorState, 'fresh');
          assert.deepStrictEqual(h.manifest().files, await buildSyncManifestFiles(h.configRoot));
          assert.deepStrictEqual(h.serverExchangeLeftovers(), [], 'каталог обмена и *.objects.txt убраны');
          assert.deepStrictEqual(h.localExchangeLeftovers(), []);

          const opened = (h.sftp?.ops('OPEN') ?? []).map((entry) => entry.path ?? '');
          assert.ok(opened.some((p) => /^exchange\/[^/]+\/restore\/Documents\/Д\/Forms\/Ф\/Ext\/Form\.xml$/.test(p)), opened.join(' | '));
          assert.ok(opened.some((p) => /^exchange\/[^/]+\/restore\/Documents\/Д\/Templates\/М\.xml$/.test(p)));
          assert.ok(!opened.some((p) => p.endsWith('/restore/Documents/Д/Ext/ObjectModule.bsl')), 'скачиваются только нужные файлы');
          assert.ok(!opened.some((p) => p === `${h.mirrorDir}/${FORM_BODY}`), 'из M эти файлы не читаются');
        });
      });
    }

    suite(`сбой точечной выгрузки → архив sparse-mirror-dirty, цель ${kind}`, () => {
      async function prepareDirty(): Promise<void> {
        await start(kind, { rich: true });
        await firstImport();
        h.emulator.updateGranularity = 'changed-files';
        h.writeP(FORM_BODY, '<FormBody>моя правка</FormBody>');
      }

      const breakers: { label: string; apply: () => void }[] = [
        { label: 'нет ConfigDumpInfo.xml в проекте', apply: () => fs.unlinkSync(path.join(h.configRoot, 'ConfigDumpInfo.xml')) },
        { label: 'агент не выгрузил файл (listDumpMissingFiles)', apply: () => { h.emulator.listDumpMissingFiles = new Set([FORM_BODY]); } },
        {
          label: 'встроенный подобъект в CDI проекта выдан за файловый',
          apply: () => {
            const cdi = path.join(h.configRoot, 'ConfigDumpInfo.xml');
            const text = fs.readFileSync(cdi, 'utf-8');
            const patched = text.replace(/(<Metadata name="Document\.Д\.TabularSection\.ТЧ" id="[^"]*")\/>/, '$1 configVersion="9999"/>');
            assert.notStrictEqual(patched, text);
            fs.writeFileSync(cdi, patched);
          },
        },
        {
          label: 'устаревшее имя в CDI проекта (подобъекта нет в базе)',
          apply: () => {
            const cdi = path.join(h.configRoot, 'ConfigDumpInfo.xml');
            const text = fs.readFileSync(cdi, 'utf-8');
            const marker = '    <Metadata name="Document.Д.ObjectModule"';
            assert.ok(text.includes(marker));
            fs.writeFileSync(cdi, text.replace(marker, `    <Metadata name="Document.Д.Form.Старая" id="s" configVersion="1"/>\n${marker}`));
          },
        },
      ];

      for (const { label, apply } of breakers) {
        test(`${label}: onMessage о сбое, архив sparse-mirror-dirty, P до архива не тронут, итог P ≡ БД`, async () => {
          await prepareDirty();
          apply();
          h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
          const pBefore = h.snapshotP();
          let pAtArchive: Record<string, string> | undefined;
          h.emulator.onCommand = (cmd) => {
            if (hasOption(cmd, 'archive')) {
              pAtArchive = h.snapshotP();
            }
          };
          const spy = importHookSpy({ fullDump: 'dump' });

          const result = await h.importTarget(spy.hooks);

          assert.strictEqual(result.strategy, 'archive');
          assert.strictEqual(result.reason, 'sparse-mirror-dirty');
          assert.strictEqual(result.restoredFromDatabase, undefined);
          assert.deepStrictEqual(pAtArchive, pBefore, 'до архива P не тронут');
          assert.strictEqual(spy.fullDumpRequests.length, 1, 'перед архивом задан вопрос');
          assert.strictEqual(spy.fullDumpRequests[0].reason, 'sparse-mirror-dirty');
          assert.strictEqual(spy.fullDumpRequests[0].reasonText, ARCHIVE_REASON_POLICY['sparse-mirror-dirty'].text);
          assert.ok(
            spy.messages.some((m) => /^Точечная выгрузка не удалась \(.+\): импорт пойдёт полной выгрузкой\.$/.test(m)),
            spy.messages.join(' | ')
          );
          expectPMatchesDb(true);
          assert.strictEqual(h.manifest().mirrorState, 'fresh');
          assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
        });
      }

      test("отказ в вопросе после сбоя точечной выгрузки: AgentFullDumpDeclinedError, манифест empty + прежняя полнота, P не тронут", async () => {
        await prepareDirty();
        h.emulator.listDumpMissingFiles = new Set([FORM_BODY]);
        h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
        const pBefore = h.snapshotP();

        await assert.rejects(h.importTarget(importHookSpy({ fullDump: 'cancel' }).hooks), AgentFullDumpDeclinedError);

        assert.strictEqual(h.manifest().mirrorState, 'empty');
        assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
        assert.deepStrictEqual(h.snapshotP(), pBefore);
        assert.ok(h.emulator.dumps().every((d) => !d.options.archive || d === h.emulator.dumps()[0]), 'архив не запущен');
      });
    });
  }

  test('грязный файл конфигурации (Ext/SessionModule.bsl) при разреженном M → точечная выгрузка владельца Configuration', async () => {
    await start('cf', { rich: true });
    h.emulator.putFile('Ext/SessionModule.bsl', 'Процедура УстановкаПараметровСеанса() КонецПроцедуры', ['SessionModule']);
    await firstImport();
    h.emulator.updateGranularity = 'changed-files';
    h.writeP('Ext/SessionModule.bsl', 'Процедура МояПравка() КонецПроцедуры');
    h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');

    const result = await h.importTarget();

    assert.strictEqual(result.strategy, 'delta');
    assert.strictEqual(result.restoredFromDatabase, 1);
    assert.deepStrictEqual([...(h.emulator.lastListNames ?? [])].sort(), [
      'Configuration.Конфигурация',
      'Configuration.Конфигурация.SessionModule',
    ]);
    assert.strictEqual(h.readP('Ext/SessionModule.bsl'), 'Процедура УстановкаПараметровСеанса() КонецПроцедуры');
    expectPMatchesDb(false);
  });

  test('отмена во время точечной выгрузки (гейт после команды): AgentSyncCancelledError, P не тронут; M уже обновлён --update → манифест empty', async () => {
    await start('cf', { rich: true });
    await firstImport();
    h.emulator.updateGranularity = 'changed-files';
    h.writeP(FORM_BODY, '<FormBody>моя правка</FormBody>');
    h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
    const pBefore = h.snapshotP();
    const cancellation = { isCancellationRequested: false };
    h.emulator.onCommand = (cmd) => {
      if (hasOption(cmd, 'list-file')) {
        cancellation.isCancellationRequested = true;
      }
    };

    await assert.rejects(h.importTarget({ cancellation }), AgentSyncCancelledError);

    assert.deepStrictEqual(h.snapshotP(), pBefore);
    assert.strictEqual(h.manifest().mirrorState, 'empty');
    assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
  });

  // ── i: ручная замена выгрузки проекта ───────────────────────────────────────────────────────────

  for (const kind of TARGET_KINDS) {
    suite(`ручная замена выгрузки проекта, цель ${kind}`, () => {
      /** Импорт; затем выгрузку проекта заменяют свежей, и в базе меняется ещё один объект («после ручной выгрузки»). */
      async function prepareReplaced(): Promise<void> {
        await start(kind);
        await firstImport();
        h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>Клиенты v2</Catalog>');
        replaceProjectDump();
        h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v3</Catalog>');
      }

      test("хук посева получает reason 'project-replaced'; 'seed' → нет --archive, M засеян из нового CDI проекта, дельта по изменённым после выгрузки, B = hash(P), seededFrom 'project'", async () => {
        await prepareReplaced();
        const from = h.emulator.commands.length;
        const spy = importHookSpy({ seed: 'seed', fullDump: 'cancel' });

        const result = await h.importTarget(spy.hooks);

        assert.strictEqual(spy.seedRequests.length, 1);
        assert.strictEqual(spy.seedRequests[0].reason, 'project-replaced');
        assert.strictEqual(spy.seedRequests[0].targetName, targetNameOf(kind));
        assert.strictEqual(result.seededFrom, 'project');
        assert.strictEqual(result.strategy, 'delta');
        assert.ok(h.emulator.dumps().slice(from).every((d) => !d.options.archive), 'архива нет');
        assert.deepStrictEqual(spy.fullDumpRequests, [], 'вопрос о полной выгрузке не задавался');
        assert.strictEqual(h.readP('Catalogs/Товары.xml'), '<Catalog>Товары v3</Catalog>');
        assert.strictEqual(h.readP('Catalogs/Клиенты.xml'), '<Catalog>Клиенты v2</Catalog>');
        assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
        assert.strictEqual(h.manifest().mirrorState, 'fresh');
        assert.deepStrictEqual(h.manifest().files, await buildSyncManifestFiles(h.configRoot));
        // M засеян CDI проекта (после --update — актуальным) и Configuration.xml; Клиенты (изменён ДО выгрузки) в M не нужен.
        assert.ok(!h.listM().includes('Catalogs/Клиенты.xml'));
        assert.ok(h.listM().includes('Catalogs/Товары.xml'));
        expectPMatchesDb(false);
      });

      test("'full' («Обычный импорт») → прежний путь без посева, архив не нужен; seededFrom не задан", async () => {
        await prepareReplaced();
        const spy = importHookSpy({ seed: 'full' });

        const result = await h.importTarget(spy.hooks);

        assert.strictEqual(spy.seedRequests.length, 1);
        assert.strictEqual(result.seededFrom, undefined);
        assert.strictEqual(result.strategy, 'delta');
        expectPMatchesDb(false);
      });

      test("'cancel' → AgentSyncCancelledError до мутаций: ни одной мутирующей команды, M, P и манифест побайтно прежние", async () => {
        await prepareReplaced();
        const mBefore = h.snapshotM();
        const pBefore = h.snapshotP();
        const manifestBefore = h.rawManifestText();
        const from = h.emulator.commands.length;

        await assert.rejects(h.importTarget(importHookSpy({ seed: 'cancel' }).hooks), AgentSyncCancelledError);

        assert.deepStrictEqual(mutatingDumps(from), []);
        assert.deepStrictEqual(h.snapshotM(), mBefore);
        assert.deepStrictEqual(h.snapshotP(), pBefore);
        assert.strictEqual(h.rawManifestText(), manifestBefore);
      });

      test('без хука посева → прежний путь без вопроса', async () => {
        await prepareReplaced();

        const result = await h.importTarget();

        assert.strictEqual(result.seededFrom, undefined);
        assert.strictEqual(result.strategy, 'delta');
        expectPMatchesDb(false);
      });

      test('проверки посева не прошли (в Configuration.xml проекта чужое имя): хук не вызван, в onMessage причина, прежний путь', async () => {
        await start(kind);
        await firstImport();
        h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>Клиенты v2</Catalog>');
        h.emulator.setConfiguration('ЧужоеИмя', kind);
        replaceProjectDump();
        h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v3</Catalog>');
        const inspected = inspectProjectMirrorSeed(h.target, extensionOf(kind));
        assert.ok(!inspected.ok, 'сценарий действительно непригоден для посева');
        const spy = importHookSpy({ seed: 'seed' });

        const result = await h.importTarget(spy.hooks);

        assert.strictEqual(spy.seedRequests.length, 0);
        assert.ok(spy.messages.includes(inspected.message), spy.messages.join(' | '));
        assert.strictEqual(result.seededFrom, undefined);
        assert.strictEqual(result.strategy, 'delta');
        expectPMatchesDb(false);
      });

      test('старый манифест без отпечатка CDI: вопроса нет (признака нет — нет и ложного срабатывания), прежний путь', async () => {
        await prepareReplaced();
        const file = path.join(h.projectRoot, '.v8vscedit', 'agent-sync');
        const manifestFile = path.join(file, fs.readdirSync(file)[0]);
        const raw = JSON.parse(fs.readFileSync(manifestFile, 'utf-8')) as Record<string, unknown>;
        assert.ok(raw.projectDumpInfo, 'после импорта отпечаток записан');
        delete raw.projectDumpInfo;
        fs.writeFileSync(manifestFile, JSON.stringify(raw));
        const spy = importHookSpy({ seed: 'seed' });

        const result = await h.importTarget(spy.hooks);

        assert.deepStrictEqual(spy.seedRequests, []);
        assert.strictEqual(result.seededFrom, undefined);
        expectPMatchesDb(false);
      });

      test('выгрузку проекта НЕ заменяли (CDI тот же): повторный импорт вопроса о посеве не задаёт', async () => {
        await start(kind);
        await firstImport();
        h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>Клиенты v2</Catalog>');
        const spy = importHookSpy({ seed: 'seed' });

        const result = await h.importTarget(spy.hooks);

        assert.deepStrictEqual(spy.seedRequests, []);
        assert.strictEqual(result.strategy, 'delta');
      });

      suite('отпечаток CDI проекта в манифесте', () => {
        const fingerprintOfProject = (): { sha1: string; size: number; mtimeMs: number } => {
          const cdi = path.join(h.configRoot, 'ConfigDumpInfo.xml');
          const stat = fs.statSync(cdi);
          return { sha1: sha1(fs.readFileSync(cdi)), size: stat.size, mtimeMs: stat.mtimeMs };
        };

        test('после импорта = sha1+size+mtimeMs файла проекта; обновляется следующим импортом (в т.ч. после архива, переписавшего CDI)', async () => {
          await start(kind);
          await firstImport();
          assert.deepStrictEqual(h.manifest().projectDumpInfo, fingerprintOfProject());
          const first = h.manifest().projectDumpInfo;

          h.emulator.removeObject('Document.Заказ');
          await h.importTarget();

          assert.deepStrictEqual(h.manifest().projectDumpInfo, fingerprintOfProject());
          assert.notDeepStrictEqual(h.manifest().projectDumpInfo, first, 'архив переписал CDI проекта');
        });

        test('загрузка прежнее значение сохраняет (загрузка P не меняет, а перезапись скрыла бы ручную замену)', async () => {
          await start(kind);
          await firstImport();
          const before = h.manifest().projectDumpInfo;
          assert.ok(before);
          h.writeP('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');

          await h.loadTarget('changed');

          assert.deepStrictEqual(h.manifest().projectDumpInfo, before);
          assert.notStrictEqual(h.manifest().files['Catalogs/Клиенты.xml'], undefined);
        });

        test('ошибка импорта (после --update) прежнее значение сохраняет', async () => {
          await start(kind);
          await firstImport();
          const before = h.manifest().projectDumpInfo;
          assert.ok(before);
          h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
          h.emulator.failWhen = (cmd) => (
            cmd.options.update === true && !hasOption(cmd, 'get-changes') ? agentError('UnknownError', 'сбой записи') : undefined
          );

          await assert.rejects(h.importTarget(), /сбой записи/);

          assert.strictEqual(h.manifest().mirrorState, 'empty');
          assert.deepStrictEqual(h.manifest().projectDumpInfo, before);
        });

        test('файла CDI в проекте нет после импорта → поле убрано из манифеста', async () => {
          await start(kind);
          await firstImport();
          assert.ok(h.manifest().projectDumpInfo);
          // Следующий импорт приводит P к БД; CDI в дельте не пишется, поэтому удаление файла видно сразу.
          fs.unlinkSync(path.join(h.configRoot, 'ConfigDumpInfo.xml'));

          await h.importTarget();

          assert.strictEqual(h.manifest().projectDumpInfo, undefined);
        });
      });
    });
  }

  // ── j: сироты ──────────────────────────────────────────────────────────────────────────────────

  for (const kind of TARGET_KINDS) {
    suite(`«осиротевшие» файлы выгрузки проекта, цель ${kind}`, () => {
      const ORPHAN_FILES = ['Catalogs/Удалённый.xml', 'Catalogs/Удалённый/Ext/ObjectModule.bsl'];

      /**
       * P = старая выгрузка (с объектом `Удалённый`), поверх неё свежая БЕЗ очистки: объект удалён в базе ДО
       * свежей выгрузки, а объект `Новый` добавлен ПОСЛЕ неё.
       */
      async function prepareOrphans(): Promise<void> {
        await start(kind);
        h.emulator.setObject('Catalog.Удалённый', {
          'Catalogs/Удалённый.xml': '<Catalog>Удалённый</Catalog>',
          'Catalogs/Удалённый/Ext/ObjectModule.bsl': 'Процедура У() КонецПроцедуры',
        });
        h.emulator.snapshotToProject(h.configRoot);
        h.emulator.removeObject('Catalog.Удалённый');
        h.emulator.snapshotToProject(h.configRoot);
        h.emulator.setObject('Catalog.Новый', { 'Catalogs/Новый.xml': '<Catalog>Новый</Catalog>' });
        for (const rel of ORPHAN_FILES) {
          assert.ok(h.existsP(rel), 'сценарий: файлы удалённого объекта остались в P');
        }
      }

      test('посев из проекта: хук получает ровно удалённый объект (добавленный после выгрузки — нет); true → файлы удалены и не попали в B; orphans в результате', async () => {
        await prepareOrphans();
        const spy = importHookSpy({ seed: 'seed', orphans: true });

        const result = await h.importTarget(spy.hooks);

        assert.strictEqual(result.seededFrom, 'project');
        assert.deepStrictEqual(spy.orphanRequests.length, 1);
        assert.strictEqual(spy.orphanRequests[0].targetName, targetNameOf(kind));
        assert.deepStrictEqual([...spy.orphanRequests[0].owners], ['Catalog.Удалённый']);
        assert.deepStrictEqual([...spy.orphanRequests[0].files].sort(), ORPHAN_FILES);
        for (const rel of ORPHAN_FILES) {
          assert.ok(!h.existsP(rel), `${rel} удалён`);
          assert.ok(!(rel in h.manifest().files), `${rel} не в B`);
        }
        assert.deepStrictEqual(result.orphans && { ...result.orphans, files: [...result.orphans.files].sort() }, {
          owners: ['Catalog.Удалённый'],
          files: ORPHAN_FILES,
          removed: true,
        });
        assert.strictEqual(h.readP('Catalogs/Новый.xml'), '<Catalog>Новый</Catalog>', 'новый объект пришёл дельтой');
        assert.deepStrictEqual(h.manifest().files, await buildSyncManifestFiles(h.configRoot));
        expectPMatchesDb(false);
      });

      for (const [label, orphans] of [['false', false], ['хука нет', undefined]] as const) {
        test(`${label}: файлы на месте и в B, в onMessage число объектов, orphans.removed = false`, async () => {
          await prepareOrphans();
          const spy = importHookSpy({ seed: 'seed', ...(orphans === undefined ? {} : { orphans }) });

          const result = await h.importTarget(spy.hooks);

          for (const rel of ORPHAN_FILES) {
            assert.ok(h.existsP(rel), `${rel} на месте`);
            assert.ok(rel in h.manifest().files, `${rel} в B`);
          }
          assert.ok(
            spy.messages.some((m) => m.includes('В выгрузке проекта есть файлы объектов, которых нет в базе (1 объект')),
            spy.messages.join(' | ')
          );
          assert.strictEqual(result.orphans?.removed, false);
          assert.deepStrictEqual(result.orphans.owners, ['Catalog.Удалённый']);
        });
      }

      test('два удалённых объекта → в сообщении «2 объект…», в хуке оба владельца', async () => {
        await prepareOrphans();
        h.emulator.setObject('Role.Лишняя', { 'Roles/Лишняя.xml': '<Role>Лишняя</Role>' });
        h.emulator.snapshotToProject(h.configRoot);
        h.emulator.removeObject('Role.Лишняя');
        h.emulator.snapshotToProject(h.configRoot);
        const spy = importHookSpy({ seed: 'seed', orphans: false });

        await h.importTarget(spy.hooks);

        assert.deepStrictEqual([...spy.orphanRequests[0].owners].sort(), ['Catalog.Удалённый', 'Role.Лишняя']);
        assert.ok(spy.messages.some((m) => m.includes('(2 объект')), spy.messages.join(' | '));
      });

      test('нет сирот → хук не вызывается, orphans в результате не задан', async () => {
        await start(kind);
        h.emulator.snapshotToProject(h.configRoot);
        h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
        const spy = importHookSpy({ seed: 'seed', orphans: true });

        const result = await h.importTarget(spy.hooks);

        assert.deepStrictEqual(spy.orphanRequests, []);
        assert.strictEqual(result.orphans, undefined);
      });

      test("после ручной замены выгрузки (reason project-replaced) сироты ищутся так же", async () => {
        await start(kind);
        await firstImport();
        h.emulator.removeObject('Catalog.Товары');
        replaceProjectDump();
        for (const rel of ['Catalogs/Товары.xml', 'Catalogs/Товары/Ext/ObjectModule.bsl']) {
          assert.ok(h.existsP(rel), 'сценарий: файлы удалённого объекта остались в P');
        }
        const spy = importHookSpy({ seed: 'seed', orphans: true });

        const result = await h.importTarget(spy.hooks);

        assert.strictEqual(spy.seedRequests[0].reason, 'project-replaced');
        assert.deepStrictEqual([...spy.orphanRequests[0].owners], ['Catalog.Товары']);
        assert.ok(!h.existsP('Catalogs/Товары.xml'));
        assert.strictEqual(result.orphans?.removed, true);
        expectPMatchesDb(false);
      });
    });
  }

  // ── k: дельта без буфера и с ограниченной конкурентностью ───────────────────────────────────────

  suite('дельта без буфера в памяти и с конкурентными STAT/LIST', () => {
    const CONCURRENCY = 4;

    test('2000 изменённых файлов (порог по умолчанию) → дельта; staging delta-* на диске во время передачи и убран после; одновременных stat/list/readFile не больше transferConcurrency', async () => {
      await start('cf', { transferConcurrency: CONCURRENCY, probeStore: true });
      seedBulkOwners(h.emulator, 40, 50);
      await firstImport();
      seedBulkOwners(h.emulator, 40, 50, 'v2');
      assert.ok(probe);
      probe.arm();
      const stagingSeen: number[] = [];
      let reads = 0;
      probe.onReadFile = () => {
        reads += 1;
        if (reads % 100 === 0) {
          stagingSeen.push(findFilesNamed(h.localExchangeRoot, /^delta-\d+$/).length);
        }
      };

      const result = await h.importTarget();

      assert.strictEqual(result.strategy, 'delta');
      assert.strictEqual(result.changedProjectFiles.length, 2000);
      assert.ok(probe.max.stat >= 2 && probe.max.list >= 2, `STAT/LIST по владельцам идут пулом: stat ${String(probe.max.stat)}, list ${String(probe.max.list)}`);
      for (const method of ['stat', 'list', 'readFile'] as const) {
        assert.ok(probe.max[method] <= CONCURRENCY, `${method}: max ${String(probe.max[method])} > ${String(CONCURRENCY)}`);
      }
      assert.ok(probe.max.readFile >= 2, 'скачивание параллельное');
      // Данные дельты уходят на диск по мере прихода, а не копятся в Map: к концу передачи staging-файлов почти столько же, сколько прочитано.
      assert.ok(stagingSeen.length >= 10, `наблюдений: ${String(stagingSeen.length)}`);
      assert.ok((stagingSeen.at(-1) ?? 0) >= 1500, `staging к концу передачи: ${String(stagingSeen.at(-1))}`);
      assert.deepStrictEqual(findFilesNamed(h.localExchangeRoot, /^delta-\d+$/), [], 'staging убран');
      assert.deepStrictEqual(h.localExchangeLeftovers(), []);
      expectPMatchesDb(false);
      assert.deepStrictEqual(h.manifest().files, await buildSyncManifestFiles(h.configRoot));
    });

    test('60 грязных файлов неизменённых владельцев: STAT по M идут пулом (не больше transferConcurrency, параллельность есть); все 60 восстановлены точечной выгрузкой, а не архивом', async () => {
      await start('cf', { transferConcurrency: CONCURRENCY, probeStore: true });
      seedBulkOwners(h.emulator, 12, 50);
      await firstImport();
      h.emulator.updateGranularity = 'changed-files';
      const dirty: string[] = [];
      for (let owner = 0; owner < 12; owner += 1) {
        for (let i = 1; i <= 5; i += 1) {
          dirty.push(`Catalogs/Б${String(owner)}/Ext/Ф${String(i)}.bsl`);
        }
      }
      for (const rel of dirty) {
        h.writeP(rel, 'моя правка');
      }
      h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>Клиенты v2</Catalog>');
      assert.ok(probe);
      probe.arm();

      const result = await h.importTarget();

      assert.strictEqual(result.strategy, 'delta');
      assert.strictEqual(result.restoredFromDatabase, 60);
      assert.ok(probe.total.stat >= 60, `stat: ${String(probe.total.stat)}`);
      assert.ok(probe.max.stat >= 2, `параллельность STAT: ${String(probe.max.stat)}`);
      assert.ok(probe.max.stat <= CONCURRENCY, `stat: max ${String(probe.max.stat)}`);
      for (const rel of dirty) {
        assert.strictEqual(h.readP(rel), h.emulator.dbFiles()[rel].toString('utf-8'), rel);
      }
    });
  });

  // ── потоки: каталог обмена не оставляет следов ──────────────────────────────────────────────────

  test('список *.objects.txt и каталог restore убраны и при сбое точечной выгрузки (ошибка агента)', async () => {
    await start('cf', { rich: true });
    await firstImport();
    h.emulator.updateGranularity = 'changed-files';
    h.writeP(FORM_BODY, '<FormBody>моя правка</FormBody>');
    h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
    h.emulator.failWhen = (cmd) => (hasOption(cmd, 'list-file') ? new Error('обрыв транспорта') : undefined);

    await assert.rejects(h.importTarget(), /обрыв транспорта/);

    assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
    assert.deepStrictEqual(snapshotDirBytes(path.join(h.userRoot, 'exchange')), {});
    assert.strictEqual(h.manifest().mirrorState, 'empty', 'M уже обновлён --update');
  });
});
