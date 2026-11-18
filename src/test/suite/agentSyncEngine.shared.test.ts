import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentFileEntry, AgentFileStore } from '../../infra/agent/files/AgentFileStore';
import { AgentSyncCancelledError } from '../../infra/agent/sync/AgentSyncEngine';
import { buildSyncManifestFiles } from '../../infra/agent/sync/SyncManifest';
import { createHash } from 'crypto';
import { dbAsText, createHarness, type HarnessKind, type SyncHarness } from './support/agentSyncHarness';

/**
 * Э7: AgentSyncEngine — E2E на эмуляторе агента. Один и тот же набор сценариев идёт поверх ДВУХ
 * хранилищ: локального (стратегия полного сравнения M и P — регресс локального режима) и SFTP на
 * настоящем in-process ssh2.Server (дельта по `--get-changes`, архив). Расхождения стратегий
 * проверяются явно (`kind === 'sftp' ? … : …`), а общее для обоих инварианты — одинаково:
 * P ≡ M после импорта, B = hash(P), хук onProjectFilesWillChange (до первой записи / перед
 * Configuration.xml / после последней), Configuration.xml — последним, отказ без Configuration.xml,
 * отмена (Н26).
 */

const OLD = new Date('2001-02-03T04:05:06Z');

function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf-8').digest('hex');
}

function setOldMtimes(dir: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      setOldMtimes(abs);
    } else {
      fs.utimesSync(abs, OLD, OLD);
    }
  }
}

function touchedFiles(dir: string, base = dir): string[] {
  const result: string[] = [];
  if (!fs.existsSync(dir)) {
    return result;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...touchedFiles(abs, base));
    } else if (fs.statSync(abs).mtime.getTime() !== OLD.getTime()) {
      result.push(path.relative(base, abs).replace(/\\/g, '/'));
    }
  }
  return result.sort();
}

/** Хранилище, которое после N-го чтения (счёт с момента `arm`) поднимает флаг отмены — детерминированная отмена посреди передачи. */
class CancelAfterReads implements AgentFileStore {
  private reads = 0;
  private threshold = Number.POSITIVE_INFINITY;
  constructor(private readonly inner: AgentFileStore, private readonly cancel: { isCancellationRequested: boolean }) {}
  arm(after: number): void { this.reads = 0; this.threshold = after; }
  disarm(): void { this.threshold = Number.POSITIVE_INFINITY; }
  get kind(): 'local' | 'sftp' { return this.inner.kind; }
  stat(rel: string): Promise<AgentFileEntry | undefined> { return this.inner.stat(rel); }
  async readFile(rel: string): Promise<Buffer> {
    const data = await this.inner.readFile(rel);
    this.reads += 1;
    if (this.reads >= this.threshold) {
      this.cancel.isCancellationRequested = true;
    }
    return data;
  }
  writeFile(rel: string, data: Uint8Array | string): Promise<void> { return this.inner.writeFile(rel, data); }
  remove(rel: string, options?: { readonly recursive?: boolean }): Promise<void> { return this.inner.remove(rel, options); }
  list(relDir: string, options?: { readonly recursive?: boolean }): Promise<AgentFileEntry[]> { return this.inner.list(relDir, options); }
  mkdirp(rel: string): Promise<void> { return this.inner.mkdirp(rel); }
  dispose(): Promise<void> { return this.inner.dispose(); }
}

function relativeSorted(h: SyncHarness, absPaths: readonly string[]): string[] {
  return absPaths.map((p) => path.relative(h.configRoot, p).replace(/\\/g, '/')).sort();
}

function expectPMatchesDb(h: SyncHarness, withInfo: boolean): void {
  const expected = dbAsText(withInfo ? h.emulator.dbFiles() : h.emulator.dbTrackedFiles());
  const actual = h.snapshotP();
  if (!withInfo) {
    delete actual['ConfigDumpInfo.xml'];
  }
  assert.deepStrictEqual(actual, expected);
}

function exchangeLeftovers(h: SyncHarness): string[] {
  const dir = path.join(h.userRoot, 'exchange');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

for (const kind of ['local', 'sftp'] as HarnessKind[]) {
  suite(`AgentSyncEngine (Э7): общие сценарии, хранилище ${kind}`, function () {
    this.timeout(60_000);
    let h: SyncHarness;
    const cancel = { isCancellationRequested: false };

    async function start(options: Parameters<typeof createHarness>[1] = {}): Promise<void> {
      h = await createHarness(kind, options);
      h.seedDb();
    }
    const doImport = (hooks?: Parameters<SyncHarness['engine']['importTarget']>[2]): ReturnType<SyncHarness['engine']['importTarget']> =>
      h.engine.importTarget(h.target, h.exec, hooks);
    const doLoad = (mode: 'full' | 'changed', hooks?: Parameters<SyncHarness['engine']['loadTarget']>[3]): ReturnType<SyncHarness['engine']['loadTarget']> =>
      h.engine.loadTarget(h.target, mode, h.exec, hooks);

    setup(() => { cancel.isCancellationRequested = false; });
    teardown(async () => { await h.dispose(); });

    suite('импорт БД → P', () => {
      test('первый импорт (P нет): P = база; B = hash(P); хранилище: ' + (kind === 'sftp' ? 'архив после полной выгрузки в M' : 'полное сравнение M и P'), async () => {
        await start();
        const result = await doImport();

        expectPMatchesDb(h, true);
        assert.strictEqual(result.strategy, kind === 'sftp' ? 'archive' : 'compare');
        assert.strictEqual(result.reason, kind === 'sftp' ? 'mirror-empty' : undefined);
        assert.deepStrictEqual(relativeSorted(h, result.changedProjectFiles), Object.keys(h.emulator.dbFiles()).sort());
        assert.deepStrictEqual(h.manifest().files, buildSyncManifestFiles(h.configRoot));

        const dumps = h.emulator.dumps();
        assert.strictEqual(dumps[0].options.dir, h.mirrorDir);
        assert.ok(!dumps[0].options.update && !dumps[0].options.archive && !dumps[0].options['get-changes']);
        if (kind === 'sftp') {
          assert.strictEqual(dumps.length, 2);
          assert.ok(String(dumps[1].options.dir).startsWith('exchange/'), String(dumps[1].options.dir));
          assert.strictEqual(dumps[1].options.archive, 'full.zip');
          assert.ok(!dumps[1].options.update, '--update и --archive вместе не работают');
          assert.strictEqual(h.manifest().mirrorState, 'fresh');
        } else {
          assert.strictEqual(dumps.length, 1);
        }
        assert.deepStrictEqual(exchangeLeftovers(h), [], 'служебные файлы обмена убраны');
      });

      test('повторный импорт без изменений: P не тронут (mtime цел), changedProjectFiles пуст, архив не используется', async () => {
        await start();
        await doImport();
        setOldMtimes(h.configRoot);
        const before = h.snapshotP();
        const dumpsBefore = h.emulator.dumps().length;

        const result = await doImport();

        assert.deepStrictEqual(result.changedProjectFiles, []);
        assert.deepStrictEqual(h.snapshotP(), before);
        assert.deepStrictEqual(touchedFiles(h.configRoot), []);
        assert.strictEqual(result.strategy, kind === 'sftp' ? 'delta' : 'compare');
        assert.ok(h.emulator.dumps().slice(dumpsBefore).every((d) => !d.options.archive));
      });

      test('изменение объекта в базе: меняется только он; mtime неизменённого соседа цел; B обновлён', async () => {
        await start();
        await doImport();
        setOldMtimes(h.configRoot);
        h.emulator.putFile('Catalogs/Товары/Ext/ObjectModule.bsl', 'Процедура Новая() КонецПроцедуры', ['ObjectModule']);
        h.sftp?.log.splice(0);
        const dumpsBefore = h.emulator.dumps().length;

        const result = await doImport();

        assert.strictEqual(result.strategy, kind === 'sftp' ? 'delta' : 'compare');
        assert.strictEqual(h.readP('Catalogs/Товары/Ext/ObjectModule.bsl'), 'Процедура Новая() КонецПроцедуры');
        assert.deepStrictEqual(relativeSorted(h, result.changedProjectFiles).filter((rel) => rel !== 'ConfigDumpInfo.xml'), [
          'Catalogs/Товары/Ext/ObjectModule.bsl',
        ]);
        const touched = touchedFiles(h.configRoot).filter((rel) => rel !== 'ConfigDumpInfo.xml');
        assert.deepStrictEqual(touched, ['Catalogs/Товары/Ext/ObjectModule.bsl'], 'Catalogs/Товары.xml не переписан');
        assert.strictEqual(h.manifest().files['Catalogs/Товары/Ext/ObjectModule.bsl'], sha1('Процедура Новая() КонецПроцедуры'));
        assert.deepStrictEqual(h.manifest().files, buildSyncManifestFiles(h.configRoot));

        if (kind === 'sftp') {
          // Дельта-импорт ДВУМЯ шагами (§5b п.4): список, затем запись M; архив не нужен.
          const dumps = h.emulator.dumps().slice(dumpsBefore);
          assert.strictEqual(dumps.length, 2);
          assert.strictEqual(dumps[0].options.update, true);
          assert.ok(typeof dumps[0].options['get-changes'] === 'string');
          const listArg = dumps[0].options['get-changes'];
          assert.ok(typeof listArg === 'string' && /^exchange\/[^/]+$/.test(listArg));
          assert.strictEqual(dumps[1].options.update, true);
          assert.ok(!dumps[1].options['get-changes'] && !dumps[1].options.archive);
          // Скачано ровно: файл списка + файлы владельца изменённого объекта; ConfigDumpInfo.xml — нет.
          const opened = (h.sftp?.ops('OPEN') ?? []).map((e) => e.path ?? '');
          const changesFiles = opened.filter((p) => /^exchange\/[^/]+\.changes$/.test(p));
          assert.strictEqual(changesFiles.length, 1, opened.join(' | '));
          assert.deepStrictEqual(opened.filter((p) => !changesFiles.includes(p)).sort(), [
            `${h.mirrorDir}/Catalogs/Товары.xml`,
            `${h.mirrorDir}/Catalogs/Товары/Ext/ObjectModule.bsl`,
          ].sort());
        }
      });

      test('новый объект в базе (New): файлы объекта и подкаталоги появляются в P', async () => {
        await start();
        await doImport();
        h.emulator.setObject('Catalog.Новый', {
          'Catalogs/Новый.xml': '<Catalog>Новый</Catalog>',
          'Catalogs/Новый/Ext/ObjectModule.bsl': 'Процедура Н() КонецПроцедуры',
        });

        const result = await doImport();

        assert.strictEqual(h.readP('Catalogs/Новый/Ext/ObjectModule.bsl'), 'Процедура Н() КонецПроцедуры');
        assert.ok(relativeSorted(h, result.changedProjectFiles).includes('Catalogs/Новый.xml'));
        expectPMatchesDb(h, kind === 'local');
        assert.strictEqual(result.strategy, kind === 'sftp' ? 'delta' : 'compare');
      });

      test('удаление объекта в базе: файлы удалены из P, опустевшие каталоги убраны; sftp — FullDump → архив', async () => {
        await start();
        await doImport();
        h.emulator.removeObject('Document.Заказ');
        const dumpsBefore = h.emulator.dumps().length;

        const result = await doImport();

        expectPMatchesDb(h, true);
        assert.strictEqual(h.existsP('Documents'), false, 'каталог Documents опустел и убран');
        assert.ok(relativeSorted(h, result.changedProjectFiles).includes('Documents/Заказ/Forms/Форма.xml'));
        assert.deepStrictEqual(h.manifest().files, buildSyncManifestFiles(h.configRoot));
        if (kind === 'sftp') {
          assert.strictEqual(result.strategy, 'archive');
          assert.strictEqual(result.reason, 'full-dump');
          const dumps = h.emulator.dumps().slice(dumpsBefore);
          assert.strictEqual(dumps.length, 3, 'список, запись M, архив');
          assert.ok(dumps[0].options['get-changes'] && dumps[0].options.update === true);
          assert.ok(!dumps[1].options['get-changes'] && dumps[1].options.update === true);
          assert.strictEqual(dumps[2].options.archive, 'full.zip');
          assert.ok(!dumps[2].options.update);
          assert.strictEqual(h.manifest().mirrorState, 'fresh');
        }
        assert.deepStrictEqual(exchangeLeftovers(h), []);
      });

      test('локальные правки без загрузки перетираются: изменённый, удалённый и лишний локально файлы приводятся к базе', async () => {
        await start();
        await doImport();
        h.writeP('Catalogs/Клиенты.xml', '<Catalog>моя правка</Catalog>');
        h.removeP('Roles/Админ/Ext/Rights.xml');
        h.writeP('Catalogs/Лишний.xml', '<Catalog>добавлен локально</Catalog>');

        const result = await doImport();

        expectPMatchesDb(h, kind === 'local');
        assert.ok(!h.existsP('Catalogs/Лишний.xml'));
        assert.deepStrictEqual(
          relativeSorted(h, result.changedProjectFiles).filter((rel) => rel !== 'ConfigDumpInfo.xml'),
          ['Catalogs/Клиенты.xml', 'Catalogs/Лишний.xml', 'Roles/Админ/Ext/Rights.xml']
        );
        assert.deepStrictEqual(h.manifest().files, buildSyncManifestFiles(h.configRoot));
        assert.strictEqual(result.strategy, kind === 'sftp' ? 'delta' : 'compare');
      });

      suite('onProjectFilesWillChange: инварианты записи в проект', () => {
        interface Snapshot { files: string[]; config: string; klients: string; extra: boolean; fresh: boolean }
        function recorder(): { snapshots: Snapshot[]; hook: (files: string[]) => void } {
          const snapshots: Snapshot[] = [];
          return {
            snapshots,
            hook: (files) => {
              snapshots.push({
                files: relativeSorted(h, files),
                config: h.readP('Configuration.xml'),
                klients: h.readP('Catalogs/Клиенты.xml'),
                extra: h.existsP('Catalogs/Лишний.xml'),
                fresh: h.existsP('Catalogs/Новый.xml'),
              });
            },
          };
        }
        const infoIfLocal = (files: string[]): string[] => (kind === 'local' ? [...files, 'ConfigDumpInfo.xml'].sort() : files);

        test('Configuration.xml в изменениях: хук до первой записи, перед Configuration.xml (он пишется последним, остальное уже применено) и после последней', async () => {
          await start();
          await doImport();
          h.writeP('Catalogs/Лишний.xml', '<Catalog>лишний</Catalog>');
          h.emulator.putFile('Configuration.xml', '<Configuration v="2"/>');
          h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>Клиенты v2</Catalog>');
          h.emulator.setObject('Catalog.Новый', { 'Catalogs/Новый.xml': '<Catalog>Новый</Catalog>' });
          const { snapshots, hook } = recorder();

          await doImport({ onProjectFilesWillChange: hook });

          const expectedFiles = infoIfLocal(['Catalogs/Клиенты.xml', 'Catalogs/Лишний.xml', 'Catalogs/Новый.xml', 'Configuration.xml']);
          for (const snapshot of snapshots) {
            assert.deepStrictEqual(snapshot.files, expectedFiles);
          }
          assert.deepStrictEqual(snapshots.map(({ config, klients, extra, fresh }) => ({ config, klients, extra, fresh })), [
            { config: '<Configuration v="1"/>', klients: '<Catalog>Клиенты</Catalog>', extra: true, fresh: false },
            { config: '<Configuration v="1"/>', klients: '<Catalog>Клиенты v2</Catalog>', extra: false, fresh: true },
            { config: '<Configuration v="2"/>', klients: '<Catalog>Клиенты v2</Catalog>', extra: false, fresh: true },
          ]);
        });

        test('без изменения Configuration.xml: ровно до первой записи и после последней', async () => {
          await start();
          await doImport();
          h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>Клиенты v2</Catalog>');
          const { snapshots, hook } = recorder();

          await doImport({ onProjectFilesWillChange: hook });

          assert.strictEqual(snapshots.length, 2);
          assert.deepStrictEqual(snapshots.map((s) => s.klients), ['<Catalog>Клиенты</Catalog>', '<Catalog>Клиенты v2</Catalog>']);
          assert.deepStrictEqual(snapshots[0].files, infoIfLocal(['Catalogs/Клиенты.xml']));
        });

        test('первый импорт (в P ещё нет файлов): хук получает полный список новых файлов, Configuration.xml пишется последним', async () => {
          await start();
          const written: string[] = [];
          let configAtSecondCall: boolean | undefined;
          let calls = 0;
          await doImport({
            onProjectFilesWillChange: (files) => {
              calls += 1;
              if (calls === 1) {
                assert.strictEqual(h.existsP('Configuration.xml'), false);
                assert.deepStrictEqual(relativeSorted(h, files), Object.keys(h.emulator.dbFiles()).sort());
              }
              if (calls === 2) {
                configAtSecondCall = h.existsP('Configuration.xml');
                written.push(...Object.keys(h.snapshotP()));
              }
            },
          });
          assert.strictEqual(calls, 3);
          assert.strictEqual(configAtSecondCall, false, 'перед Configuration.xml он ещё не записан');
          assert.ok(written.length > 0 && !written.includes('Configuration.xml'), 'остальные файлы к этому моменту уже записаны');
        });

      });

      test('результат без Configuration.xml → отказ; P не тронут, хук не вызван, B прежний', async () => {
        await start();
        await doImport();
        const before = h.snapshotP();
        const manifestBefore = h.manifest().files;
        h.emulator.removeObject('Configuration.Конфигурация');
        let hookCalls = 0;

        await assert.rejects(doImport({ onProjectFilesWillChange: () => { hookCalls += 1; } }), /Configuration\.xml/);

        assert.deepStrictEqual(h.snapshotP(), before);
        assert.strictEqual(hookCalls, 0);
        assert.deepStrictEqual(h.manifest().files, manifestBefore);
        if (kind === 'sftp') {
          assert.strictEqual(h.manifest().mirrorState, 'empty', 'M уже изменён, P — нет: следующий импорт обязан быть полным');
        }
        assert.deepStrictEqual(exchangeLeftovers(h), []);
      });

      suite('отмена (Н26: AgentTransferResult.cancelled)', () => {
        test('отмена до старта: AgentSyncCancelledError, ни одной команды агента', async () => {
          await start();
          cancel.isCancellationRequested = true;
          await assert.rejects(doImport({ cancellation: cancel }), AgentSyncCancelledError);
          assert.deepStrictEqual(h.emulator.commands, []);
          assert.deepStrictEqual(h.snapshotP(), {});
        });

        test('отмена посреди передачи: AgentSyncCancelledError, P и B не тронуты, хук не вызван; повторный импорт самовосстанавливается', async () => {
          const holder: { wrapper?: CancelAfterReads } = {};
          await start({
            transferConcurrency: 1,
            wrapStore: (store) => { holder.wrapper = new CancelAfterReads(store, cancel); return holder.wrapper; },
          });
          await doImport();
          for (const rel of [
            'Catalogs/Клиенты.xml',
            'Catalogs/Товары.xml',
            'Catalogs/Товары/Ext/ObjectModule.bsl',
            'Roles/Админ.xml',
            'Roles/Админ/Ext/Rights.xml',
            'CommonModules/Общий/Ext/Module.bsl',
          ]) {
            h.emulator.putFile(rel, `изменено ${rel}`);
          }
          const before = h.snapshotP();
          const manifestBefore = h.manifest().files;
          let hookCalls = 0;
          const wrapper = holder.wrapper;
          assert.ok(wrapper);
          wrapper.arm(3);

          await assert.rejects(
            doImport({ cancellation: cancel, onProjectFilesWillChange: () => { hookCalls += 1; } }),
            AgentSyncCancelledError
          );

          assert.deepStrictEqual(h.snapshotP(), before);
          assert.strictEqual(hookCalls, 0);
          assert.deepStrictEqual(h.manifest().files, manifestBefore);
          if (kind === 'sftp') {
            assert.strictEqual(h.manifest().mirrorState, 'empty', 'M уже обновлён, P — нет: следующий импорт обязан быть полным');
          }

          wrapper.disarm();
          cancel.isCancellationRequested = false;
          const retry = await doImport({ cancellation: cancel });
          assert.strictEqual(retry.strategy, kind === 'sftp' ? 'archive' : 'compare');
          expectPMatchesDb(h, true);
          assert.deepStrictEqual(h.manifest().files, buildSyncManifestFiles(h.configRoot));
        });
      });
    });

    suite('загрузка P → БД', () => {
      async function imported(options?: Parameters<typeof createHarness>[1]): Promise<void> {
        await start(options);
        await doImport();
      }

      test('нет изменений → skipped, ни одной команды агента', async () => {
        await imported();
        const before = h.emulator.commands.length;
        const result = await doLoad('changed');
        assert.strictEqual(result.skipped, true);
        assert.strictEqual(result.strategy, 'skipped');
        assert.deepStrictEqual(result.changedProjectFiles, []);
        assert.strictEqual(h.emulator.commands.length, before);
      });

      test('частичная загрузка: в M попадают ровно изменённые и добавленные файлы, list-файл верен, команда без --update-config-dump-info', async () => {
        await imported();
        setOldMtimes(h.mirrorAbs);
        h.writeP('Catalogs/Товары/Ext/ObjectModule.bsl', 'Процедура Правка() КонецПроцедуры');
        h.writeP('Catalogs/Клиенты/Ext/ObjectModule.bsl', 'Процедура Новый() КонецПроцедуры');
        const commandsBefore = h.emulator.commands.length;
        const dumpsBefore = h.emulator.dumps().length;

        const result = await doLoad('changed');

        assert.strictEqual(result.strategy, 'partial');
        assert.strictEqual(h.emulator.dumps().length, dumpsBefore, 'M свежий — выгрузок перед частичной загрузкой нет');
        assert.deepStrictEqual(touchedFiles(h.mirrorAbs), [
          'Catalogs/Клиенты/Ext/ObjectModule.bsl',
          'Catalogs/Товары/Ext/ObjectModule.bsl',
        ]);
        const commands = h.emulator.commands.slice(commandsBefore).filter((c) => c.command === 'config load-config-from-files');
        assert.strictEqual(commands.length, 1);
        const options = commands[0].options;
        assert.strictEqual(options.dir, h.mirrorDir);
        assert.strictEqual(options.partial, true);
        assert.strictEqual(options['no-check'], true);
        assert.ok(!options['update-config-dump-info'] && !options.archive);
        assert.ok(String(options['list-file']).startsWith('lists/'), String(options['list-file']));
        const listText = fs.readFileSync(path.join(h.userRoot, ...String(options['list-file']).split('/')), 'utf-8');
        assert.strictEqual(listText.charCodeAt(0), 0xfeff, 'list-файл: UTF-8 с BOM');
        assert.ok(!listText.includes('\r'), 'разделитель — LF');
        assert.deepStrictEqual(listText.slice(1).split('\n').sort(), [
          'Catalogs/Клиенты/Ext/ObjectModule.bsl',
          'Catalogs/Товары/Ext/ObjectModule.bsl',
        ]);
        assert.deepStrictEqual(h.emulator.loads.at(-1)?.mode, 'partial');
        assert.strictEqual(h.emulator.dbTrackedFiles()['Catalogs/Товары/Ext/ObjectModule.bsl'].toString('utf-8'), 'Процедура Правка() КонецПроцедуры');
        assert.strictEqual(h.manifest().files['Catalogs/Товары/Ext/ObjectModule.bsl'], sha1('Процедура Правка() КонецПроцедуры'));
        assert.deepStrictEqual(h.manifest().files, buildSyncManifestFiles(h.configRoot));
        if (kind === 'sftp') {
          assert.strictEqual(h.manifest().mirrorState, 'fresh');
        }
      });

      test('после частичной загрузки повторная загрузка без правок — skipped (B обновлён)', async () => {
        await imported();
        h.writeP('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
        await doLoad('changed');
        const again = await doLoad('changed');
        assert.strictEqual(again.skipped, true);
      });

      test('удаление файла → полная загрузка (' + (kind === 'sftp' ? 'архивом' : 'из каталога M') + ')', async () => {
        await imported();
        h.removeP('Catalogs/Клиенты.xml');
        const commandsBefore = h.emulator.commands.length;

        const result = await doLoad('changed');

        assert.strictEqual(result.strategy, 'full');
        assert.strictEqual(result.reason, 'deletion');
        assert.strictEqual(result.via, kind === 'sftp' ? 'archive' : 'dir');
        const loads = h.emulator.commands.slice(commandsBefore).filter((c) => c.command === 'config load-config-from-files');
        assert.strictEqual(loads.length, 1);
        assert.ok(!loads[0].options.partial);
        assert.deepStrictEqual(h.emulator.dbTrackedFiles()['Catalogs/Клиенты.xml'], undefined, 'удалённого в проекте объекта нет и в базе');
        assert.deepStrictEqual(Object.keys(h.emulator.dbTrackedFiles()).sort(), Object.keys(buildSyncManifestFiles(h.configRoot)).sort());
        assert.deepStrictEqual(h.manifest().files, buildSyncManifestFiles(h.configRoot));
        if (kind === 'sftp') {
          assert.strictEqual(loads[0].options.archive, 'full.zip');
          assert.ok(String(loads[0].options.dir).startsWith('exchange/'), String(loads[0].options.dir));
          assert.ok(!loads[0].options['update-config-dump-info']);
          assert.strictEqual(h.emulator.loads.at(-1)?.mode, 'archive');
          assert.ok(!h.emulator.loads.at(-1)?.files.includes('ConfigDumpInfo.xml'), 'устаревший ConfigDumpInfo.xml проекта в архив загрузки не кладётся');
          assert.strictEqual(h.manifest().mirrorState, 'stale', 'M не обновлялся — каркас устарел');
        } else {
          assert.strictEqual(loads[0].options.dir, h.mirrorDir);
          assert.strictEqual(loads[0].options['update-config-dump-info'], true);
          assert.strictEqual(h.emulator.loads.at(-1)?.mode, 'dir');
          assert.strictEqual(fs.existsSync(path.join(h.mirrorAbs, 'Catalogs', 'Клиенты.xml')), false, 'M зеркалит P: лишнее убрано');
        }
        assert.deepStrictEqual(exchangeLeftovers(h), []);
      });

      test('переименование объекта → полная загрузка с причиной rename', async () => {
        await imported();
        fs.renameSync(path.join(h.configRoot, 'Catalogs', 'Клиенты.xml'), path.join(h.configRoot, 'Catalogs', 'Заказчики.xml'));
        const result = await doLoad('changed');
        assert.strictEqual(result.strategy, 'full');
        assert.strictEqual(result.reason, 'rename');
      });

      test('mode full: сразу полная загрузка (' + (kind === 'sftp' ? 'архив' : 'каталог M') + '), B = hash(P)', async () => {
        await imported();
        const commandsBefore = h.emulator.commands.length;
        const result = await doLoad('full');
        assert.strictEqual(result.strategy, 'full');
        assert.strictEqual(result.via, kind === 'sftp' ? 'archive' : 'dir');
        const loads = h.emulator.commands.slice(commandsBefore).filter((c) => c.command === 'config load-config-from-files');
        assert.strictEqual(loads.length, 1);
        assert.ok(!loads[0].options.partial && !loads[0].options['list-file']);
        assert.deepStrictEqual(Object.keys(h.emulator.dbTrackedFiles()).sort(), Object.keys(buildSyncManifestFiles(h.configRoot)).sort());
        assert.deepStrictEqual(h.manifest().files, buildSyncManifestFiles(h.configRoot));
      });

      test('нет каталога исходников: full — «Каталог источника не найден», changed — «Каталог исходников не найден»; команд агента нет', async () => {
        await start();
        await assert.rejects(doLoad('full'), /Каталог источника не найден/);
        await assert.rejects(doLoad('changed'), /Каталог исходников не найден/);
        assert.deepStrictEqual(h.emulator.commands, []);
      });
    });
  });
}
