import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type {
  AgentMirrorSeedDecision,
  AgentMirrorSeedRequest,
  AgentOperationHooks,
} from '../../infra/agent/AgentOperationService';
import { AgentWorkspaceService, buildAgentProjectId } from '../../infra/agent/AgentWorkspaceService';
import { IO_WINDOW } from '../../infra/agent/files/SftpChunkedIo';
import { AgentSyncCancelledError, AgentSyncEngine } from '../../infra/agent/sync/AgentSyncEngine';
import { ArchiveFormatError } from '../../infra/agent/sync/ArchiveCodec';
import { inspectProjectMirrorSeed } from '../../infra/agent/sync/MirrorSeed';
import { buildSyncManifestFiles, mirrorCoverageOf } from '../../infra/agent/sync/SyncManifest';
import { createHarness, dbAsText, HARNESS_EXTENSION_NAME, type HarnessTargetKind, type SyncHarness } from './support/agentSyncHarness';
import { CountingAgentFileStore, DelegatingAgentFileStore } from './support/delegatingAgentFileStore';
import { patternBytes } from './support/zipFixtures';

/**
 * Потоковый архив и посев зеркала M (удалённый агент, SFTP). Первый импорт на пустом M — ОДНА серверная
 * выгрузка (архив): P заполняется из него, а M засевается только файлом версий и Configuration.xml из
 * архива (разреженный M, `mirrorCoverage: 'sparse'`). Либо, с согласия пользователя (хук
 * `confirmMirrorSeed`), M засевается из выгрузки проекта, и скачиваются только объекты, изменённые в базе
 * после неё. Разреженный M никогда не удаляет из P файлы, кроме локально добавленных (D.added): отсутствие
 * файла в нём ничего не означает.
 *
 * Агент — эмулятор по фактам пилота; SFTP — настоящий ssh2.Server. Режим `updateGranularity: 'changed-files'`
 * эмулирует настоящий `dump --update` (пишет только изменившиеся ФАЙЛЫ владельца).
 */

const BOM = String.fromCharCode(0xfeff);
const EXCHANGE_ZIP = /^exchange\/[^/]+\/full\.zip$/;
const ANY_ZIP = /full\.zip$/;

interface SeedHookSpy {
  readonly requests: AgentMirrorSeedRequest[];
  readonly messages: string[];
  readonly hooks: AgentOperationHooks;
}

function hookReturning(decision: AgentMirrorSeedDecision, extra: AgentOperationHooks = {}): SeedHookSpy {
  const requests: AgentMirrorSeedRequest[] = [];
  const messages: string[] = [];
  return {
    requests,
    messages,
    hooks: {
      ...extra,
      onMessage: (message) => { messages.push(message); extra.onMessage?.(message); },
      confirmMirrorSeed: (request) => { requests.push(request); return Promise.resolve(decision); },
    },
  };
}

const relativeSorted = (h: SyncHarness, absPaths: readonly string[]): string[] =>
  absPaths.map((p) => path.relative(h.configRoot, p).replace(/\\/g, '/')).sort();

function expectPMatchesDb(h: SyncHarness, withInfo: boolean): void {
  const expected = dbAsText(withInfo ? h.emulator.dbFiles() : h.emulator.dbTrackedFiles());
  const actual = h.snapshotP();
  if (!withInfo) {
    delete actual['ConfigDumpInfo.xml'];
  }
  assert.deepStrictEqual(actual, expected);
}

const targetNameOf = (kind: HarnessTargetKind): string => (kind === 'cf' ? 'Основная' : HARNESS_EXTENSION_NAME);

suite('AgentSyncEngine: потоковый архив и посев зеркала (sftp)', function () {
  this.timeout(120_000);
  let h: SyncHarness;
  const holder: { store?: CountingAgentFileStore } = {};

  async function start(options: Parameters<typeof createHarness>[1] = {}, kind: HarnessTargetKind = 'cf'): Promise<void> {
    holder.store = undefined;
    h = await createHarness('sftp', {
      ...options,
      targetKind: kind,
      wrapStore: (store) => { holder.store = new CountingAgentFileStore(store); return holder.store; },
    });
    h.seedDb();
    h.emulator.setConfiguration(targetNameOf(kind), kind);
  }
  const counting = (): CountingAgentFileStore => {
    assert.ok(holder.store);
    return holder.store;
  };

  teardown(async () => { await h.dispose(); });

  function sftpOpens(): string[] {
    return (h.sftp?.ops('OPEN') ?? []).map((entry) => entry.path ?? '');
  }

  for (const kind of ['cf', 'cfe'] as const) {
    suite(`цель ${kind}`, () => {
      const extension = kind === 'cfe' ? HARNESS_EXTENSION_NAME : undefined;
      const seedFromOldDump = (): void => { h.emulator.snapshotToProject(h.configRoot); };

      // ── a, b: самопосев из архива ─────────────────────────────────────────────

      suite('первый импорт без согласия: самопосев M из архива', () => {
        test('одна серверная выгрузка (--archive), без выгрузки в M; M = CDI + Configuration.xml из архива; fresh+sparse; seededFrom=archive; P ≡ БД', async () => {
          await start({}, kind);

          const result = await h.importTarget();

          assert.strictEqual(result.strategy, 'archive');
          assert.strictEqual(result.reason, 'mirror-empty');
          assert.strictEqual(result.seededFrom, 'archive');
          const dumps = h.emulator.dumps();
          assert.strictEqual(dumps.length, 1, 'ровно ОДНА серверная выгрузка');
          assert.strictEqual(dumps[0].options.archive, 'full.zip');
          assert.ok(!dumps[0].options.update);
          assert.ok(dumps.every((d) => d.options.dir !== h.mirrorDir), 'полной выгрузки в M нет');
          assert.deepStrictEqual(h.listM(), ['ConfigDumpInfo.xml', 'Configuration.xml']);
          assert.strictEqual(h.readM('Configuration.xml'), h.emulator.dbFiles()['Configuration.xml'].toString('utf-8'));
          assert.strictEqual(h.readM('ConfigDumpInfo.xml'), h.emulator.dbFiles()['ConfigDumpInfo.xml'].toString('utf-8'));
          assert.strictEqual(h.manifest().mirrorState, 'fresh');
          assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
          assert.deepStrictEqual(h.manifest().files, await buildSyncManifestFiles(h.configRoot));
          expectPMatchesDb(h, true);
          assert.deepStrictEqual(relativeSorted(h, result.changedProjectFiles), Object.keys(h.emulator.dbFiles()).sort());
        });

        test('архив НЕ проходит через память: readFile/writeFile по full.zip — 0 вызовов, downloadToFile — 1; обмены (серверный и локальный) убраны', async () => {
          await start({}, kind);
          await h.importTarget();

          const store = counting();
          assert.strictEqual(store.count('readFile', ANY_ZIP), 0);
          assert.strictEqual(store.count('writeFile', ANY_ZIP), 0);
          assert.strictEqual(store.count('downloadToFile', EXCHANGE_ZIP), 1);
          const [download] = store.calls.filter((call) => call.method === 'downloadToFile');
          assert.ok(download.localPath && path.resolve(download.localPath).startsWith(path.resolve(h.localExchangeRoot)), `локальный файл: ${String(download.localPath)}`);
          assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
          assert.deepStrictEqual(h.localExchangeLeftovers(), []);
          assert.ok(!fs.existsSync(download.localPath));
        });

        test('следующая правка в БД: дельта (--get-changes + --update), скачаны только файлы изменённого владельца', async () => {
          await start({}, kind);
          await h.importTarget();
          h.emulator.putFile('Catalogs/Товары/Ext/ObjectModule.bsl', 'Процедура Новая() КонецПроцедуры', ['ObjectModule']);
          const dumpsBefore = h.emulator.dumps().length;
          h.sftp?.log.splice(0);

          const result = await h.importTarget();

          assert.strictEqual(result.strategy, 'delta');
          assert.strictEqual(result.seededFrom, undefined);
          const dumps = h.emulator.dumps().slice(dumpsBefore);
          assert.strictEqual(dumps.length, 2);
          assert.ok(typeof dumps[0].options['get-changes'] === 'string' && dumps[0].options.update === true);
          assert.ok(!dumps[1].options['get-changes'] && dumps[1].options.update === true);
          const opened = sftpOpens();
          const changesFiles = opened.filter((p) => /^exchange\/[^/]+\.changes$/.test(p));
          assert.strictEqual(changesFiles.length, 1);
          assert.deepStrictEqual(opened.filter((p) => !changesFiles.includes(p)).sort(), [
            `${h.mirrorDir}/Catalogs/Товары.xml`,
            `${h.mirrorDir}/Catalogs/Товары/Ext/ObjectModule.bsl`,
          ].sort());
          assert.strictEqual(h.readP('Catalogs/Товары/Ext/ObjectModule.bsl'), 'Процедура Новая() КонецПроцедуры');
          assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
          assert.strictEqual(h.manifest().mirrorState, 'fresh');
        });
      });

      // ── c, g, h: посев из выгрузки проекта ────────────────────────────────────

      suite('посев из выгрузки проекта (хук confirmMirrorSeed)', () => {
        /** Выгрузка проекта «старая»; затем в БД изменён объект и добавлен новый. */
        function prepareOldProjectDump(): void {
          seedFromOldDump();
          h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
          h.emulator.setObject('Catalog.Новый', {
            'Catalogs/Новый.xml': '<Catalog>Новый</Catalog>',
            'Catalogs/Новый/Ext/ObjectModule.bsl': 'Процедура Н() КонецПроцедуры',
          });
        }

        test("решение 'seed': нет --archive и выгрузки без --update; M — CDI, Configuration.xml и файлы только изменённых; P ≡ БД по изменённым; ручная правка неизменённого сохранена; fresh+sparse, B = hash(P)", async () => {
          await start({}, kind);
          prepareOldProjectDump();
          h.writeP('Catalogs/Клиенты.xml', '<Catalog>ручная правка</Catalog>');
          const spy = hookReturning('seed');

          const result = await h.importTarget(spy.hooks);

          assert.strictEqual(result.seededFrom, 'project');
          assert.strictEqual(result.strategy, 'delta');
          const dumps = h.emulator.dumps();
          assert.ok(dumps.every((d) => !d.options.archive), 'архива нет');
          assert.ok(dumps.every((d) => d.options.update === true), 'ни одной выгрузки без --update');
          assert.strictEqual(spy.requests.length, 1);
          assert.deepStrictEqual(h.listM().sort(), [
            'Catalogs/Новый.xml',
            'Catalogs/Новый/Ext/ObjectModule.bsl',
            'Catalogs/Товары.xml',
            'Catalogs/Товары/Ext/ObjectModule.bsl',
            'ConfigDumpInfo.xml',
            'Configuration.xml',
          ].sort());
          assert.strictEqual(h.readP('Catalogs/Товары.xml'), '<Catalog>Товары v2</Catalog>');
          assert.strictEqual(h.readP('Catalogs/Новый.xml'), '<Catalog>Новый</Catalog>');
          assert.strictEqual(h.readP('Catalogs/Клиенты.xml'), '<Catalog>ручная правка</Catalog>', 'ручная правка файла НЕизменённого объекта сохранена');
          for (const rel of ['Roles/Админ.xml', 'Roles/Админ/Ext/Rights.xml', 'Documents/Заказ/Forms/Форма.xml', 'CommonModules/Общий/Ext/Module.bsl']) {
            assert.ok(h.existsP(rel), `${rel}: файл неизменённого владельца не удалён`);
          }
          assert.ok(!relativeSorted(h, result.changedProjectFiles).includes('Catalogs/Клиенты.xml'));
          assert.strictEqual(h.manifest().mirrorState, 'fresh');
          assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
          assert.deepStrictEqual(h.manifest().files, await buildSyncManifestFiles(h.configRoot));
          assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
          assert.deepStrictEqual(h.localExchangeLeftovers(), []);
        });

        test('хук получает верные поля кандидата; без базовой линии localEditsSinceBaseline = undefined', async () => {
          await start({}, kind);
          prepareOldProjectDump();
          const cdi = path.join(h.configRoot, 'ConfigDumpInfo.xml');
          const spy = hookReturning('seed');

          await h.importTarget(spy.hooks);

          const [request] = spy.requests;
          assert.strictEqual(request.targetKind, kind);
          assert.strictEqual(request.targetName, targetNameOf(kind));
          assert.strictEqual(request.projectDir, h.configRoot);
          assert.strictEqual(request.formatVersion, '2.20');
          assert.strictEqual(request.dumpInfoSize, fs.statSync(cdi).size);
          assert.strictEqual(request.dumpInfoModifiedAt.getTime(), fs.statSync(cdi).mtime.getTime());
          assert.strictEqual(request.localEditsSinceBaseline, undefined);
        });

        test('при известной базовой линии localEditsSinceBaseline = число файлов P, изменённых относительно B (изменён + добавлен + удалён)', async () => {
          await start({}, kind);
          prepareOldProjectDump();
          h.saveManifest('empty', await buildSyncManifestFiles(h.configRoot));
          h.writeP('Catalogs/Клиенты.xml', '<Catalog>ручная правка</Catalog>');
          h.writeP('Catalogs/Лишний.xml', '<Catalog>добавлен</Catalog>');
          h.removeP('Roles/Админ/Ext/Rights.xml');
          const spy = hookReturning('seed');

          await h.importTarget(spy.hooks);

          assert.strictEqual(spy.requests[0].localEditsSinceBaseline, 3);
        });

        test("решение 'full': самопосев из архива (как без хука); хук вызван один раз", async () => {
          await start({}, kind);
          prepareOldProjectDump();
          const spy = hookReturning('full');

          const result = await h.importTarget(spy.hooks);

          assert.strictEqual(spy.requests.length, 1);
          assert.strictEqual(result.seededFrom, 'archive');
          assert.strictEqual(result.reason, 'mirror-empty');
          assert.strictEqual(h.emulator.dumps().length, 1);
          assert.ok(h.emulator.dumps()[0].options.archive);
          assert.deepStrictEqual(h.listM(), ['ConfigDumpInfo.xml', 'Configuration.xml']);
          expectPMatchesDb(h, true);
        });

        test('без хука при пригодной выгрузке проекта — безопасное умолчание «полная выгрузка» (самопосев из архива)', async () => {
          await start({}, kind);
          prepareOldProjectDump();
          assert.ok(inspectProjectMirrorSeed(h.target, extension).ok, 'кандидат на посев есть');

          const result = await h.importTarget();

          assert.strictEqual(result.seededFrom, 'archive');
          expectPMatchesDb(h, true);
        });

        test("решение 'cancel': AgentSyncCancelledError ДО мутаций — ни одной команды агента, M, P и манифест не тронуты", async () => {
          await start({}, kind);
          prepareOldProjectDump();
          fs.mkdirSync(h.mirrorAbs, { recursive: true });
          fs.writeFileSync(path.join(h.mirrorAbs, 'Метка.xml'), '<marker/>');
          const manifestBefore = h.manifest();
          const projectBefore = h.snapshotP();
          const spy = hookReturning('cancel');

          await assert.rejects(h.importTarget(spy.hooks), AgentSyncCancelledError);

          assert.deepStrictEqual(h.emulator.commands, []);
          assert.deepStrictEqual(h.manifest(), manifestBefore);
          assert.deepStrictEqual(h.snapshotP(), projectBefore);
          assert.ok(fs.existsSync(path.join(h.mirrorAbs, 'Метка.xml')), 'M не очищен');
          assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
        });

        const rejectedProjects: { label: string; prepare: () => void }[] = [
          { label: 'нет файла версий', prepare: () => { seedFromOldDump(); fs.unlinkSync(path.join(h.configRoot, 'ConfigDumpInfo.xml')); } },
          { label: 'чужое имя в Configuration.xml', prepare: () => { h.emulator.setConfiguration('ЧужоеИмя', kind); seedFromOldDump(); } },
          { label: 'формат файла версий не Hierarchical', prepare: () => {
            seedFromOldDump();
            const cdi = path.join(h.configRoot, 'ConfigDumpInfo.xml');
            fs.writeFileSync(cdi, fs.readFileSync(cdi, 'utf-8').replace('Hierarchical', 'Plain'));
          } },
        ];
        for (const { label, prepare } of rejectedProjects) {
          test(`проверки посева провалены (${label}): хук не вызван, в onMessage причина, самопосев из архива`, async () => {
            await start({}, kind);
            prepare();
            const inspected = inspectProjectMirrorSeed(h.target, extension);
            assert.ok(!inspected.ok, 'сценарий действительно непригоден для посева');
            const spy = hookReturning('seed');

            const result = await h.importTarget(spy.hooks);

            assert.strictEqual(spy.requests.length, 0, 'диалог не показывается');
            assert.ok(spy.messages.includes(inspected.message), `причина в onMessage: ${spy.messages.join(' | ')}`);
            assert.strictEqual(result.seededFrom, 'archive');
            expectPMatchesDb(h, true);
          });
        }

        test('чужой файл версий (все версии другие) → дельта-кандидат превышает порог → архив; посев самопроверяется, P ≡ БД', async () => {
          await start({ archiveThresholdFiles: 3 }, kind);
          seedFromOldDump();
          const cdi = path.join(h.configRoot, 'ConfigDumpInfo.xml');
          const foreign = fs.readFileSync(cdi, 'utf-8').replace(/configVersion="\d+"/g, 'configVersion="999999"');
          fs.writeFileSync(cdi, foreign);
          const spy = hookReturning('seed');

          const result = await h.importTarget(spy.hooks);

          assert.strictEqual(result.seededFrom, 'project');
          assert.strictEqual(result.strategy, 'archive');
          assert.strictEqual(result.reason, 'over-threshold');
          expectPMatchesDb(h, true);
          assert.strictEqual(h.manifest().mirrorState, 'fresh');
        });
      });
    });
  }

  // ── d, e: ключевой регресс разреженности ──────────────────────────────────────

  suite('разреженный M никогда не удаляет из P лишнего', () => {
    const MODULE = 'Documents/Заказ/Ext/ObjectModule.bsl';
    const NEW_MODULE = 'Процедура Заказ() Экспорт КонецПроцедуры';

    async function changeOnlyOrderModule(): Promise<Awaited<ReturnType<SyncHarness['importTarget']>>> {
      h.emulator.updateGranularity = 'changed-files';
      h.emulator.putFile(MODULE, NEW_MODULE, ['ObjectModule']);
      return h.importTarget();
    }

    test("--update пишет только изменившийся ФАЙЛ (changed-files): изменён лишь ObjectModule.bsl документа → формы и XML документа в P на месте, M содержит только изменённый файл", async () => {
      await start();
      await h.importTarget();
      assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
      const before = h.snapshotP();

      const result = await changeOnlyOrderModule();

      assert.strictEqual(result.strategy, 'delta');
      assert.strictEqual(h.readP(MODULE), NEW_MODULE);
      for (const rel of ['Documents/Заказ.xml', 'Documents/Заказ/Forms/Форма.xml', 'Documents/Заказ/Forms/Форма/Ext/Form.xml']) {
        assert.strictEqual(h.readP(rel), before[rel], `${rel}: не должен быть удалён или изменён`);
      }
      assert.deepStrictEqual(h.listM().sort(), ['ConfigDumpInfo.xml', 'Configuration.xml', MODULE].sort());
      assert.deepStrictEqual(relativeSorted(h, result.changedProjectFiles).filter((rel) => rel !== 'ConfigDumpInfo.xml'), [MODULE]);
      expectPMatchesDb(h, false);
      assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
    });

    test('контроль: тот же сценарий при ПОЛНОМ M ведёт себя как прежде — результат в P тот же, M остаётся полным', async () => {
      await start();
      await h.importTarget();
      h.makeMirrorFull();
      assert.strictEqual(mirrorCoverageOf(h.manifest()), 'full');

      const result = await changeOnlyOrderModule();

      assert.strictEqual(result.strategy, 'delta');
      assert.strictEqual(h.readP(MODULE), NEW_MODULE);
      expectPMatchesDb(h, false);
      assert.deepStrictEqual(h.listM().sort(), Object.keys(h.emulator.dbFiles()).sort(), 'полный M содержит все файлы');
      assert.strictEqual(mirrorCoverageOf(h.manifest()), 'full');
    });

    test('после посева в БД удалён объект → FullDump → архив; файлы удалённого объекта убраны из P; полнота остаётся sparse', async () => {
      await start();
      await h.importTarget();
      h.emulator.removeObject('Document.Заказ');

      const result = await h.importTarget();

      assert.strictEqual(result.strategy, 'archive');
      assert.strictEqual(result.reason, 'full-dump');
      assert.strictEqual(h.existsP('Documents'), false);
      expectPMatchesDb(h, true);
      assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
      assert.strictEqual(h.manifest().mirrorState, 'fresh');
    });
  });

  // ── i: локальные правки при разреженном M ─────────────────────────────────────

  suite('локальные правки (D) при разреженном M', () => {
    test('D.modified файла неизменённого владельца → архив sparse-mirror-dirty, файл восстановлен', async () => {
      await start();
      await h.importTarget();
      h.writeP('Catalogs/Клиенты.xml', '<Catalog>моя правка</Catalog>');

      const result = await h.importTarget();

      assert.strictEqual(result.strategy, 'archive');
      assert.strictEqual(result.reason, 'sparse-mirror-dirty');
      assert.strictEqual(h.readP('Catalogs/Клиенты.xml'), '<Catalog>Клиенты</Catalog>');
      expectPMatchesDb(h, true);
    });

    test('D.deleted файла неизменённого владельца → тоже архив sparse-mirror-dirty, файл возвращён', async () => {
      await start();
      await h.importTarget();
      h.removeP('Roles/Админ/Ext/Rights.xml');

      const result = await h.importTarget();

      assert.strictEqual(result.reason, 'sparse-mirror-dirty');
      assert.strictEqual(h.readP('Roles/Админ/Ext/Rights.xml'), '<Rights/>');
    });

    test('D.modified файла, который засеян в M (Configuration.xml), при неизменённой БД → восстановлен дельтой, архив не нужен', async () => {
      await start();
      await h.importTarget();
      const original = h.readP('Configuration.xml');
      h.writeP('Configuration.xml', '<Configuration>моя правка</Configuration>');

      const result = await h.importTarget();

      assert.strictEqual(result.strategy, 'delta', 'файл есть в разреженном M — восстановим без архива');
      assert.strictEqual(h.readP('Configuration.xml'), original);
      expectPMatchesDb(h, false);
    });

    test('D.added, отсутствующий в M → удалён дельтой (архив не нужен)', async () => {
      await start();
      await h.importTarget();
      h.writeP('Catalogs/Лишний.xml', '<Catalog>добавлен локально</Catalog>');
      h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>Клиенты v2</Catalog>');

      const result = await h.importTarget();

      assert.strictEqual(result.strategy, 'delta');
      assert.strictEqual(h.existsP('Catalogs/Лишний.xml'), false);
      assert.strictEqual(h.readP('Catalogs/Клиенты.xml'), '<Catalog>Клиенты v2</Catalog>');
      assert.ok(relativeSorted(h, result.changedProjectFiles).includes('Catalogs/Лишний.xml'));
    });

    test('D.modified файла, присутствующего в M (владелец изменён в БД) → восстановлен дельтой', async () => {
      await start();
      await h.importTarget();
      h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
      h.writeP('Catalogs/Товары/Ext/ObjectModule.bsl', 'Процедура МояПравка() КонецПроцедуры');

      const result = await h.importTarget();

      assert.strictEqual(result.strategy, 'delta');
      assert.strictEqual(h.readP('Catalogs/Товары/Ext/ObjectModule.bsl'), 'Процедура Товары() КонецПроцедуры');
      assert.strictEqual(h.readP('Catalogs/Товары.xml'), '<Catalog>Товары v2</Catalog>');
    });
  });

  // ── контроль: дельта при ПОЛНОМ M (прежние правила кандидатов и наличия в M) ──────

  suite('дельта при полном M', () => {
    test('новый объект в БД, XML владельца в P ещё нет: кандидаты владельца из P пусты, файлы приходят дельтой', async () => {
      await start();
      await h.importTarget();
      h.makeMirrorFull();
      h.emulator.setObject('Catalog.Новый', {
        'Catalogs/Новый.xml': '<Catalog>Новый</Catalog>',
        'Catalogs/Новый/Ext/ObjectModule.bsl': 'Процедура Н() КонецПроцедуры',
      });
      assert.strictEqual(h.existsP('Catalogs/Новый.xml'), false);

      const result = await h.importTarget();

      assert.strictEqual(result.strategy, 'delta');
      assert.strictEqual(h.readP('Catalogs/Новый.xml'), '<Catalog>Новый</Catalog>');
      assert.strictEqual(h.readP('Catalogs/Новый/Ext/ObjectModule.bsl'), 'Процедура Н() КонецПроцедуры');
      expectPMatchesDb(h, false);
      assert.strictEqual(mirrorCoverageOf(h.manifest()), 'full');
    });

    test('локальная правка файла НЕизменённого владельца: файла нет среди выгруженных --update, но он есть в полном M — восстановлен дельтой по STAT', async () => {
      await start();
      await h.importTarget();
      h.makeMirrorFull();
      h.writeP('Catalogs/Клиенты.xml', '<Catalog>моя правка</Catalog>');
      h.sftp?.log.splice(0);

      const result = await h.importTarget();

      assert.strictEqual(result.strategy, 'delta', 'полный M восстанавливает правку без архива');
      assert.strictEqual(h.readP('Catalogs/Клиенты.xml'), '<Catalog>Клиенты</Catalog>');
      assert.ok(
        (h.sftp?.ops('OPEN') ?? []).some((entry) => entry.path === `${h.mirrorDir}/Catalogs/Клиенты.xml`),
        'файл скачан из M'
      );
      expectPMatchesDb(h, false);
    });
  });

  // ── j: загрузка при разреженном M ─────────────────────────────────────────────

  suite('загрузка P → БД при разреженном M', () => {
    test('частичная (none) проходит, B обновлена; удаление → полная архивом через uploadFromFile (writeFile по full.zip — 0), M stale, sparse; следующая частичная → refresh-dump, sparse', async () => {
      await start();
      await h.importTarget();

      h.writeP('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
      const partial = await h.loadTarget('changed');
      assert.strictEqual(partial.strategy, 'partial');
      assert.deepStrictEqual(h.manifest().files, await buildSyncManifestFiles(h.configRoot), 'B обновлена');
      assert.strictEqual(h.manifest().mirrorState, 'fresh');
      assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
      assert.deepStrictEqual(h.emulator.loads.at(-1)?.files, ['Catalogs/Клиенты.xml']);

      h.removeP('Catalogs/Клиенты.xml');
      const store = counting();
      store.calls.splice(0);
      const full = await h.loadTarget('changed');
      assert.strictEqual(full.strategy, 'full');
      assert.strictEqual(full.via, 'archive');
      assert.strictEqual(store.count('uploadFromFile', EXCHANGE_ZIP), 1);
      assert.strictEqual(store.count('writeFile', ANY_ZIP), 0);
      assert.strictEqual(store.count('readFile', ANY_ZIP), 0);
      assert.strictEqual(h.manifest().mirrorState, 'stale');
      assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
      assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
      assert.deepStrictEqual(h.localExchangeLeftovers(), []);

      h.writeP('Catalogs/Товары.xml', '<Catalog>после полной</Catalog>');
      const dumpsBefore = h.emulator.dumps().length;
      const next = await h.loadTarget('changed');
      assert.strictEqual(next.strategy, 'partial');
      const dumps = h.emulator.dumps().slice(dumpsBefore);
      assert.strictEqual(dumps.length, 1, 'refresh-dump: одна выгрузка --update без скачивания');
      assert.strictEqual(dumps[0].options.update, true);
      assert.ok(!dumps[0].options['get-changes'] && !dumps[0].options.archive);
      assert.strictEqual(h.manifest().mirrorState, 'fresh');
      assert.strictEqual(h.manifest().mirrorCoverage, 'sparse', 'refresh-dump полноту не меняет');
    });

    test('M потерян (full-dump) при известной B: полная выгрузка в M без --update → полнота full, в M все файлы', async () => {
      await start();
      await h.importTarget();
      assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
      for (const rel of h.listM()) {
        fs.unlinkSync(path.join(h.mirrorAbs, ...rel.split('/')));
      }
      h.writeP('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
      const dumpsBefore = h.emulator.dumps().length;

      const result = await h.loadTarget('changed');

      assert.strictEqual(result.strategy, 'partial');
      const dumps = h.emulator.dumps().slice(dumpsBefore);
      assert.strictEqual(dumps.length, 1);
      assert.ok(!dumps[0].options.update && !dumps[0].options.archive);
      assert.strictEqual(dumps[0].options.dir, h.mirrorDir);
      assert.strictEqual(mirrorCoverageOf(h.manifest()), 'full');
      assert.ok(h.listM().includes('Documents/Заказ/Forms/Форма.xml'), 'M снова полный');
    });
  });

  // ── k: сбои и отмена ─────────────────────────────────────────────────────────

  suite('сбои и отмена', () => {
    test('сбой ПОСЛЕ посева из проекта (на --update) при манифесте full: манифест empty + sparse; полная загрузка полноту не теряет, импорт не удаляет из P файлы, которых нет в M', async () => {
      await start();
      h.saveManifest('empty', {});
      assert.strictEqual(mirrorCoverageOf(h.manifest()), 'full', 'старт: поля полноты нет — full');
      h.emulator.updateGranularity = 'changed-files';
      h.emulator.snapshotToProject(h.configRoot);
      h.emulator.putFile('Documents/Заказ/Ext/ObjectModule.bsl', 'Процедура Заказ() Экспорт КонецПроцедуры', ['ObjectModule']);
      h.emulator.failWhen = (command) => (
        command.command === 'config dump-config-to-files' && command.options.update === true && !('get-changes' in command.options)
          ? new Error('сбой --update')
          : undefined
      );

      await assert.rejects(h.importTarget(hookReturning('seed').hooks), /сбой --update/);
      h.emulator.failWhen = undefined;

      assert.strictEqual(h.manifest().mirrorState, 'empty');
      assert.strictEqual(h.manifest().mirrorCoverage, 'sparse', 'начатый посев — полнота sparse, а не прежняя full');
      assert.deepStrictEqual(h.listM(), ['ConfigDumpInfo.xml', 'Configuration.xml']);

      await h.loadTarget('full');
      assert.strictEqual(h.manifest().mirrorCoverage, 'sparse', 'полная загрузка архивом полноту не меняет');

      const result = await h.importTarget();
      assert.notStrictEqual(result.strategy, 'compare');
      for (const rel of ['Documents/Заказ.xml', 'Documents/Заказ/Forms/Форма.xml', 'Documents/Заказ/Forms/Форма/Ext/Form.xml']) {
        assert.ok(h.existsP(rel), `${rel}: не удалён по отсутствию в разреженном M`);
      }
      expectPMatchesDb(h, false);
      assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
    });

    test('гонка: файл был в разреженном M при проверке и исчез к скачиванию → ошибка до записи в P, манифест empty', async () => {
      let armed = false;
      let hits = 0;
      // Второй STAT того же файла (importByDelta) видит его исчезнувшим — так, как при чужой записи в M.
      class VanishingStore extends DelegatingAgentFileStore {
        override stat(rel: string): ReturnType<DelegatingAgentFileStore['stat']> {
          if (armed && rel.startsWith('workspace/') && rel.endsWith('/Configuration.xml')) {
            hits += 1;
            if (hits >= 2) {
              return Promise.resolve(undefined);
            }
          }
          return super.stat(rel);
        }
      }
      h = await createHarness('sftp', { wrapStore: (store) => new VanishingStore(store) });
      h.seedDb();
      h.emulator.setConfiguration('Основная', 'cf');
      await h.importTarget();
      h.writeP('Configuration.xml', '<Configuration>моя правка</Configuration>');
      const before = h.snapshotP();
      armed = true;

      await assert.rejects(h.importTarget(), /Разреженное зеркало агента не содержит файлов, нужных импорту: Configuration\.xml/);

      assert.strictEqual(hits, 2);
      assert.deepStrictEqual(h.snapshotP(), before, 'P не тронут');
      assert.strictEqual(h.manifest().mirrorState, 'empty');
      assert.strictEqual(h.manifest().mirrorCoverage, 'sparse');
    });

    test('обрыв скачивания архива (отказ READ по full.zip): P не тронут, манифест empty, оба каталога обмена убраны; повтор успешен', async () => {
      await start();
      await h.importTarget();
      h.emulator.removeObject('Document.Заказ');
      const before = h.snapshotP();
      h.sftp?.failNext({ op: 'READ', pathIncludes: 'full.zip', times: 1, code: 'FAILURE' });

      await assert.rejects(h.importTarget(), /full\.zip/);

      assert.deepStrictEqual(h.snapshotP(), before);
      assert.strictEqual(h.manifest().mirrorState, 'empty');
      assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
      assert.deepStrictEqual(h.localExchangeLeftovers(), []);

      const retry = await h.importTarget();
      assert.strictEqual(retry.strategy, 'archive');
      assert.strictEqual(retry.reason, 'mirror-empty');
      expectPMatchesDb(h, true);
      assert.strictEqual(h.manifest().mirrorState, 'fresh');
    });

    test("сбой закачки файла версий при посеве из проекта: M без файла версий, P не тронут, манифест empty; повтор успешен", async () => {
      await start();
      h.emulator.snapshotToProject(h.configRoot);
      h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>Клиенты v2</Catalog>');
      const before = h.snapshotP();
      h.sftp?.failNext({ op: 'WRITE', pathIncludes: 'ConfigDumpInfo.xml', times: 1, code: 'PERMISSION_DENIED' });

      await assert.rejects(h.importTarget(hookReturning('seed').hooks), /ConfigDumpInfo\.xml/);

      assert.deepStrictEqual(h.snapshotP(), before);
      assert.strictEqual(h.manifest().mirrorState, 'empty');
      assert.ok(!h.listM().includes('ConfigDumpInfo.xml'));
      assert.deepStrictEqual(h.serverExchangeLeftovers(), []);

      const retry = await h.importTarget(hookReturning('seed').hooks);
      assert.strictEqual(retry.seededFrom, 'project');
      assert.strictEqual(h.readP('Catalogs/Клиенты.xml'), '<Catalog>Клиенты v2</Catalog>');
      assert.strictEqual(h.manifest().mirrorState, 'fresh');
    });

    test('отмена во время скачивания (гейт READ после первого окна): AgentSyncCancelledError, P не тронут, временный файл и обмены убраны', async () => {
      await start();
      h.emulator.setObject('CommonPicture.Большой', {
        'CommonPictures/Большой.xml': '<CommonPicture>Большой</CommonPicture>',
        'CommonPictures/Большой/Ext/Picture/Picture.png': patternBytes(3_000_000, 77),
      });
      const cancellation = { isCancellationRequested: false };
      const gate = h.sftp?.hold('READ');
      assert.ok(gate);

      const outcome = h.importTarget({ cancellation }).then(() => undefined, (error: unknown) => error);
      await gate.waitForPending(IO_WINDOW);
      cancellation.isCancellationRequested = true;
      gate.release();

      assert.ok((await outcome) instanceof AgentSyncCancelledError);
      assert.strictEqual(fs.existsSync(h.configRoot), false, 'P не создан');
      assert.ok((h.sftp?.ops('READ').length ?? 0) <= IO_WINDOW * 2, 'после отмены архив дочитан не был');
      const [download] = counting().calls.filter((call) => call.method === 'downloadToFile');
      assert.ok(download.localPath && !fs.existsSync(download.localPath), 'временный файл удалён');
      assert.deepStrictEqual(h.localExchangeLeftovers(), []);
      assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
      assert.strictEqual(h.manifest().mirrorState, 'empty');
    });

    test('отмена при упаковке полной загрузки: команды load нет, закачки нет, обмены убраны', async () => {
      await start();
      await h.importTarget();
      const cancellation = { isCancellationRequested: false };
      const loadsBefore = h.emulator.commands.filter((c) => c.command === 'config load-config-from-files').length;
      counting().calls.splice(0);

      await assert.rejects(
        h.loadTarget('full', { cancellation, onMessage: () => { cancellation.isCancellationRequested = true; } }),
        AgentSyncCancelledError
      );

      assert.strictEqual(h.emulator.commands.filter((c) => c.command === 'config load-config-from-files').length, loadsBefore);
      assert.strictEqual(counting().count('uploadFromFile', ANY_ZIP), 0);
      assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
      assert.deepStrictEqual(h.localExchangeLeftovers(), []);
    });

    test('испорченный архив (nextArchiveTamper): ArchiveFormatError, P не тронут, манифест empty, обмены убраны', async () => {
      await start();
      h.emulator.nextArchiveTamper = (zip) => zip.subarray(0, zip.length - 40);

      await assert.rejects(h.importTarget(), ArchiveFormatError);

      assert.strictEqual(fs.existsSync(h.configRoot), false);
      assert.strictEqual(h.manifest().mirrorState, 'empty');
      assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
      assert.deepStrictEqual(h.localExchangeLeftovers(), []);
      assert.ok(!h.listM().includes('ConfigDumpInfo.xml'), 'M не засеян из испорченного архива');
    });
  });

  // ── l: остатки локального обмена ─────────────────────────────────────────────

  suite('остатки локального обмена упавшей операции', () => {
    for (const kind of ['cf', 'cfe'] as const) {
      test(`цель ${kind}: остаток той же цели удаляется на следующей операции, остаток чужой цели остаётся`, async () => {
        await start({}, kind);
        const own = kind === 'cf' ? 'cf-777' : `cfe-${HARNESS_EXTENSION_NAME}-777`;
        const foreign = kind === 'cf' ? `cfe-${HARNESS_EXTENSION_NAME}-5` : 'cf-5';
        for (const name of [own, foreign]) {
          fs.mkdirSync(path.join(h.localExchangeRoot, name, 'Каталог'), { recursive: true });
          fs.writeFileSync(path.join(h.localExchangeRoot, name, 'full.zip'), 'остаток');
          fs.writeFileSync(path.join(h.localExchangeRoot, name, 'Каталог', 'Файл.xml'), 'остаток');
        }

        await h.importTarget();

        assert.deepStrictEqual(h.localExchangeLeftovers(), [foreign]);
      });
    }

    test('корень по умолчанию — <проект>/.v8vscedit/agent-exchange (тот же диск, что у P)', async () => {
      await start();
      const engine = new AgentSyncEngine({
        projectRoot: h.projectRoot,
        store: h.store,
        workspace: new AgentWorkspaceService(h.store, buildAgentProjectId(h.projectRoot)),
        now: h.clock.now,
      });

      await engine.importTarget(h.target, h.exec);

      const [download] = counting().calls.filter((call) => call.method === 'downloadToFile');
      const expectedRoot = path.resolve(h.projectRoot, '.v8vscedit', 'agent-exchange');
      assert.ok(download.localPath && path.resolve(download.localPath).startsWith(expectedRoot + path.sep), String(download.localPath));
    });
  });

  test('«нет изменений» после посева: ни одного файла не скачивается, кроме списка изменений', async () => {
    await start();
    await h.importTarget();
    h.sftp?.log.splice(0);

    const result = await h.importTarget();

    assert.strictEqual(result.strategy, 'delta');
    assert.deepStrictEqual(result.changedProjectFiles, []);
    assert.ok(sftpOpens().every((p) => /^exchange\/[^/]+\.changes$/.test(p)), sftpOpens().join(' | '));
  });

  test('нераспознанный --get-changes при разреженном M → архив unrecognized (импорт корректен)', async () => {
    await start();
    await h.importTarget();
    h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
    h.emulator.nextChangesText = `${BOM}Deleted: Catalog.Клиенты\r\n`;

    const result = await h.importTarget();

    assert.strictEqual(result.reason, 'unrecognized');
    assert.strictEqual(h.readP('Catalogs/Клиенты.xml'), '<Catalog>v2</Catalog>');
  });
});
