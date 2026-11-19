import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentFileStore } from '../../infra/agent/files/AgentFileStore';
import { AgentFullDumpDeclinedError, AgentSyncCancelledError } from '../../infra/agent/sync/SyncContext';
import { ARCHIVE_REASON_POLICY, SERVER_DUMP_POLICY } from '../../infra/agent/sync/SyncPlanner';
import { buildSyncManifestFiles } from '../../infra/agent/sync/SyncManifest';
import { createHarness, dbAsText, HARNESS_EXTENSION_NAME, type HarnessTargetKind, type SyncHarness } from './support/agentSyncHarness';
import { DelegatingAgentFileStore } from './support/delegatingAgentFileStore';
import { importHookSpy } from './support/archiveAvoidFixtures';
import { hasOption } from './support/agentConfigEmulator';
import { removeRootPart, seedRootPart } from './support/fullDumpAvoidFixtures';

// Реальный модуль fs: namespace-импорт TypeScript — копия с геттерами, подмена свойства на ней не видна production-коду.
const realFs = require('fs') as typeof fs;

/** Фиксирует удаления: отказ в вопросе обязан происходить ДО очистки зеркала M. */
class RemoveRecordingStore extends DelegatingAgentFileStore {
  readonly removed: string[] = [];
  override remove(rel: string, options?: { readonly recursive?: boolean }): Promise<void> {
    this.removed.push(rel);
    return super.remove(rel, options);
  }
}

const targetNameOf = (kind: HarnessTargetKind): string => (kind === 'cf' ? 'Основная' : HARNESS_EXTENSION_NAME);

/**
 * Вопрос о полной выгрузке на пути загрузки (4b), контекст отказа (4c), явный источник файла дельты (4d)
 * и отсутствие хеширования файла версий без хука посева (4f). Агент — эмулятор; SFTP — настоящий ssh2.Server.
 */
suite('AgentSyncEngine: согласие на полную выгрузку — загрузка, контексты отказа, дельта, посев', function () {
  this.timeout(120_000);
  let h: SyncHarness;
  let recording: RemoveRecordingStore | undefined;

  async function start(kind: HarnessTargetKind): Promise<void> {
    recording = undefined;
    h = await createHarness('sftp', {
      targetKind: kind,
      wrapStore: (store: AgentFileStore) => { recording = new RemoveRecordingStore(store); return recording; },
    });
    h.seedDb();
    h.emulator.setConfiguration(targetNameOf(kind), kind);
  }

  teardown(async () => { await h.dispose(); });

  /** Импорт, затем M «потерян» (файлов нет): план загрузки — `full-dump` (подготовка зеркала на сервере). */
  async function prepareLostMirror(): Promise<void> {
    await h.importTarget();
    for (const rel of h.listM()) {
      fs.unlinkSync(path.join(h.mirrorAbs, ...rel.split('/')));
    }
    h.writeP('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
  }

  for (const kind of ['cf', 'cfe'] as const) {
    suite(`4b: загрузка при пустом M, цель ${kind}`, () => {
      test("хук 'dump': вопрос задан с operation=load и reason=mirror-empty; выгрузка в M и частичная загрузка как прежде", async () => {
        await start(kind);
        await prepareLostMirror();
        const spy = importHookSpy({ fullDump: 'dump' });
        const dumpsBefore = h.emulator.dumps().length;

        const result = await h.loadTarget('changed', spy.hooks);

        assert.strictEqual(result.strategy, 'partial');
        assert.deepStrictEqual(spy.fullDumpRequests, [{
          targetKind: kind,
          targetName: targetNameOf(kind),
          projectDir: h.configRoot,
          operation: 'load',
          reason: 'mirror-empty',
          reasonText: ARCHIVE_REASON_POLICY['mirror-empty'].text,
          download: true,
        }]);
        const dumps = h.emulator.dumps().slice(dumpsBefore);
        assert.strictEqual(dumps.length, 1, 'одна полная выгрузка в M');
        assert.ok(!dumps[0].options.update && !dumps[0].options.archive);
        assert.deepStrictEqual(h.emulator.loads.at(-1)?.files, ['Catalogs/Клиенты.xml']);
      });

      test("хук 'cancel': AgentFullDumpDeclinedError(load), M не очищен, команд агента нет, манифест побайтно прежний", async () => {
        await start(kind);
        await prepareLostMirror();
        const spy = importHookSpy({ fullDump: 'cancel' });
        const commandsBefore = h.emulator.commands.length;
        const manifestBefore = h.rawManifestText();
        const mBefore = h.snapshotM();
        const removedBefore = recording?.removed.length ?? 0;
        const loadsBefore = h.emulator.loads.length;

        await assert.rejects(h.loadTarget('changed', spy.hooks), (error: unknown) => {
          assert.ok(error instanceof AgentFullDumpDeclinedError);
          assert.ok(error instanceof AgentSyncCancelledError);
          assert.strictEqual(error.consent, 'load');
          assert.match(error.message, /Загрузка отменена; база и проект не изменены/);
          assert.match(error.message, /Частичной загрузке нужно зеркало агента/);
          assert.ok(!error.message.includes('Выгрузите конфигурацию в файлы вручную'), 'инструкции ручной выгрузки импорта здесь нет');
          return true;
        });

        assert.strictEqual(spy.fullDumpRequests.length, 1);
        // Движок всегда убирает служебные пути обмена (`exchange/…`); мутацией M было бы любое иное удаление.
        const removedOutsideExchange = (recording?.removed ?? []).slice(removedBefore).filter((rel) => !rel.includes('/exchange/') && !rel.startsWith('exchange/'));
        assert.deepStrictEqual(removedOutsideExchange, [], 'store.remove(M) не вызывался');
        assert.strictEqual(h.emulator.commands.length, commandsBefore, 'ни dump, ни load');
        assert.strictEqual(h.emulator.loads.length, loadsBefore);
        assert.deepStrictEqual(h.snapshotM(), mBefore);
        assert.strictEqual(h.rawManifestText(), manifestBefore);
        assert.ok(!spy.messages.some((m) => m.includes('Зеркало выгрузки на стороне агента не подготовлено')), 'сообщение о выгрузке — только после согласия');
      });

      test('без хука confirmFullDump: прежнее поведение — выгрузка в M без вопроса', async () => {
        await start(kind);
        await prepareLostMirror();

        const result = await h.loadTarget('changed');

        assert.strictEqual(result.strategy, 'partial');
        assert.deepStrictEqual(h.emulator.loads.at(-1)?.files, ['Catalogs/Клиенты.xml']);
      });
    });

    suite(`4c: текст отказа по контексту, цель ${kind}`, () => {
      const IMPORT_TEXT = /Выгрузите конфигурацию в файлы вручную \(иерархический формат\) и замените/;

      // Вопрос о полной выгрузке: cf — запасной путь «перезапись зеркала» (часть корня очистить нельзя, причина
      // mirror-rewrite); cfe — прежний архив full-dump при удалении объекта. Удаление объекта у cf вопроса не задаёт.
      const seedTrigger = (): void => { if (kind === 'cf') { seedRootPart(h.emulator); } };
      const fireTrigger = (): void => {
        if (kind === 'cf') {
          removeRootPart(h.emulator);
        } else {
          h.emulator.removeObject('Document.Заказ');
        }
      };
      const triggerReasonText = (): string => (kind === 'cf' ? SERVER_DUMP_POLICY['mirror-rewrite'].text : ARCHIVE_REASON_POLICY['full-dump'].text);

      test("импорт без посева, отказ после FullDump: consent=import, текст прежний дословно", async () => {
        await start(kind);
        seedTrigger();
        await h.importTarget();
        fireTrigger();

        await assert.rejects(h.importTarget(importHookSpy({ fullDump: 'cancel' }).hooks), (error: unknown) => {
          assert.ok(error instanceof AgentFullDumpDeclinedError);
          assert.strictEqual(error.consent, 'import');
          assert.match(error.message, /Полная выгрузка на сервере отменена\./);
          assert.match(error.message, IMPORT_TEXT);
          assert.match(error.message, /включая ConfigDumpInfo\.xml/);
          assert.match(error.message, /следующий импорт предложит взять её за основу/);
          return true;
        });
      });

      test("импорт: хук получает operation=import", async () => {
        await start(kind);
        seedTrigger();
        await h.importTarget();
        fireTrigger();
        const spy = importHookSpy({ fullDump: 'dump' });

        await h.importTarget(spy.hooks);

        assert.strictEqual(spy.fullDumpRequests[0].operation, 'import');
      });

      test("посев из проекта (mirror-empty), затем FullDump и отказ: consent=import-after-seed, текст про подготовленное зеркало", async () => {
        await start(kind);
        seedTrigger();
        h.emulator.snapshotToProject(h.configRoot);
        fireTrigger();
        const spy = importHookSpy({ seed: 'seed', fullDump: 'cancel' });

        await assert.rejects(h.importTarget(spy.hooks), (error: unknown) => {
          assert.ok(error instanceof AgentFullDumpDeclinedError);
          assert.strictEqual(error.consent, 'import-after-seed');
          assert.match(error.message, /Зеркало агента уже подготовлено/);
          assert.ok(error.message.includes(triggerReasonText()), error.message);
          assert.doesNotMatch(error.message, IMPORT_TEXT, 'прежний текст импорта не используется');
          assert.match(error.message, /проект не изменён/);
          return true;
        });
        assert.deepStrictEqual(spy.calls, ['seed', 'fullDump']);
        assert.strictEqual(spy.fullDumpRequests[0].operation, 'import');
      });

      test("посев после ручной замены выгрузки проекта (project-replaced), затем FullDump и отказ: consent=import-after-seed", async () => {
        await start(kind);
        seedTrigger();
        await h.importTarget();
        h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
        h.emulator.snapshotToProject(h.configRoot);
        // Замена распознаётся по отпечатку size+mtime файла версий (как replaceProjectDump в archiveAvoid):
        // без сдвига mtime новый CDI той же длины в ту же секунду неотличим от прежнего.
        const replacedAt = new Date('2031-01-02T03:04:05Z');
        fs.utimesSync(path.join(h.configRoot, 'ConfigDumpInfo.xml'), replacedAt, replacedAt);
        fireTrigger();
        const spy = importHookSpy({ seed: 'seed', fullDump: 'cancel' });

        await assert.rejects(
          h.importTarget(spy.hooks),
          (error: unknown) => error instanceof AgentFullDumpDeclinedError && error.consent === 'import-after-seed'
        );
        assert.deepStrictEqual(spy.calls, ['seed', 'fullDump']);
      });

      // Сценарий «посев → sparse-mirror-dirty» недостижим: после посева B = hash(P), локальных правок
      // относительно неё нет, и точечная выгрузка не запускается. Контекст import-after-seed во всех трёх
      // ветках архива importChanges передаётся одной переменной — её проверяют FullDump-сценарии выше.

      test("без посева, сбой точечной выгрузки → sparse-mirror-dirty и отказ: consent=import (прежний текст)", async () => {
        await start(kind);
        await h.importTarget();
        h.emulator.updateGranularity = 'changed-files';
        h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
        h.writeP('Catalogs/Клиенты.xml', '<Catalog>моя правка</Catalog>');
        h.emulator.listDumpMissingFiles = new Set(['Catalogs/Клиенты.xml']);

        await assert.rejects(h.importTarget(importHookSpy({ fullDump: 'cancel' }).hooks), (error: unknown) => {
          assert.ok(error instanceof AgentFullDumpDeclinedError);
          assert.strictEqual(error.consent, 'import');
          assert.match(error.message, IMPORT_TEXT);
          return true;
        });
      });

      test('AgentFullDumpDeclinedError по умолчанию: consent=import', () => {
        const error = new AgentFullDumpDeclinedError();
        assert.strictEqual(error.consent, 'import');
        assert.match(error.message, IMPORT_TEXT);
        assert.strictEqual(error.name, 'AgentFullDumpDeclinedError');
      });

      test('reasonText подставляется в текст import-after-seed и load; для import не используется', () => {
        const afterSeed = new AgentFullDumpDeclinedError('import-after-seed', 'причина-А');
        assert.ok(afterSeed.message.includes('причина-А'));
        assert.match(afterSeed.message, /Повторите импорт и выберите «Полная выгрузка на сервере»/);
        const load = new AgentFullDumpDeclinedError('load', 'причина-Б');
        assert.match(load.message, /Загрузка отменена; база и проект не изменены/);
        assert.match(load.message, /выполните полную загрузку/);
        const plain = new AgentFullDumpDeclinedError('import', 'причина-В');
        assert.ok(!plain.message.includes('причина-В'));
      });
    });

    suite(`4d: источник файла дельты — из карты, цель ${kind}`, () => {
      test('дельта с точечным восстановлением: файлы из каталога восстановления и из M попадают в нужные пути проекта (кириллица, вложенные пути)', async () => {
        await start(kind);
        await h.importTarget();
        h.emulator.updateGranularity = 'changed-files';
        h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
        h.writeP('Catalogs/Клиенты.xml', '<Catalog>моя правка</Catalog>');
        h.writeP('Roles/Админ/Ext/Rights.xml', '<Rights>моя правка</Rights>');
        const from = h.emulator.commands.length;

        const result = await h.importTarget();

        assert.strictEqual(result.strategy, 'delta');
        assert.strictEqual(result.restoredFromDatabase, 2);
        assert.ok(h.emulator.dumps().slice(from).some((d) => hasOption(d, 'list-file')), 'точечная выгрузка выполнена');
        assert.strictEqual(h.readP('Catalogs/Товары.xml'), '<Catalog>Товары v2</Catalog>', 'файл из M');
        assert.strictEqual(h.readP('Catalogs/Клиенты.xml'), '<Catalog>Клиенты</Catalog>', 'файл из каталога восстановления');
        assert.strictEqual(h.readP('Roles/Админ/Ext/Rights.xml'), '<Rights/>', 'вложенный путь из каталога восстановления');
        assert.deepStrictEqual(dbAsText(h.emulator.dbTrackedFiles()), (() => { const p = h.snapshotP(); delete p['ConfigDumpInfo.xml']; return p; })());
        assert.deepStrictEqual(h.manifest().files, await buildSyncManifestFiles(h.configRoot));
      });

      test('дельта без восстановления: только файлы из M (регресс)', async () => {
        await start(kind);
        await h.importTarget();
        h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');

        const result = await h.importTarget();

        assert.strictEqual(result.strategy, 'delta');
        assert.strictEqual(result.restoredFromDatabase, undefined);
        assert.strictEqual(h.readP('Catalogs/Товары.xml'), '<Catalog>Товары v2</Catalog>');
      });
    });
  }

  suite('4f: файл версий проекта не хешируется без хука посева', () => {
    /** Считает открытия потока чтения `ConfigDumpInfo.xml` проекта: sha1 считается потоком (ProjectDumpInfo.sha1OfFile). */
    function countDumpInfoReads(run: () => Promise<void>): Promise<number> {
      const original = realFs.createReadStream;
      let reads = 0;
      realFs.createReadStream = ((file: fs.PathLike, ...rest: unknown[]) => {
        if (String(file).startsWith(h.configRoot) && String(file).endsWith('ConfigDumpInfo.xml')) {
          reads += 1;
        }
        return (original as (...args: unknown[]) => fs.ReadStream)(file, ...rest);
      });
      return run().then(() => reads).finally(() => { realFs.createReadStream = original; });
    }

    test('импорт без confirmMirrorSeed при замене CDI проекта: проверка замены не читает файл — единственное чтение в движке, отпечаток = sha1 нового файла', async () => {
      await start('cf');
      await h.importTarget();
      h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
      const cdi = path.join(h.configRoot, 'ConfigDumpInfo.xml');
      fs.writeFileSync(cdi, `${fs.readFileSync(cdi, 'utf-8')}\n<!-- ручная замена выгрузки проекта -->`);
      fs.utimesSync(cdi, new Date(), new Date(Date.now() + 5_000));
      let result: Awaited<ReturnType<SyncHarness['importTarget']>> | undefined;

      const reads = await countDumpInfoReads(async () => { result = await h.importTarget(); });

      assert.ok(result);
      assert.strictEqual(result.seededFrom, undefined, 'без хука посева посева нет');
      assert.strictEqual(result.strategy, 'delta');
      assert.strictEqual(reads, 1, 'sha1 CDI не считается для проверки замены: остаётся только отпечаток движка');
      const crypto = await import('crypto');
      assert.strictEqual(
        h.manifest().projectDumpInfo?.sha1,
        crypto.createHash('sha1').update(fs.readFileSync(cdi)).digest('hex'),
        'отпечаток обновлён: замена не будет «обнаруживаться» вечно'
      );
    });

    test('при неизменённом CDI файл не читается вовсе', async () => {
      await start('cf');
      await h.importTarget();
      h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');

      const reads = await countDumpInfoReads(async () => { await h.importTarget(); });

      assert.strictEqual(reads, 0);
    });
  });
});
