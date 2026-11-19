import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ArchiveFormatError } from '../../infra/agent/sync/ArchiveCodec';
import { loadSyncManifest } from '../../infra/agent/sync/SyncManifest';
import { buildSyncManifestFiles } from '../../infra/agent/sync/SyncManifest';
import { buildScopeKey } from '../../infra/cache/HashCache';
import { agentError } from './support/agentInfoBaseFakes';
import { createHarness, dbAsText, type SyncHarness } from './support/agentSyncHarness';
import { readZip, patternBytes } from './support/zipFixtures';
import { DelegatingAgentFileStore } from './support/delegatingAgentFileStore';

/** Хранилище, у которого удаление служебных файлов обмена (`exchange/…`) отказывает. */
class FailingExchangeRemoveStore extends DelegatingAgentFileStore {
  removeAttempts = 0;
  override remove(rel: string, options?: { readonly recursive?: boolean }): Promise<void> {
    if (rel.startsWith('exchange/')) {
      this.removeAttempts += 1;
      return Promise.reject(new Error('сервер отказал в удалении'));
    }
    return super.remove(rel, options);
  }
}

/**
 * Э7: сценарии, специфичные для УДАЛЁННОГО хранилища (SFTP): порог архива, нераспознанный
 * `--get-changes`, состояние M (`stale`/`empty`), самовосстановление после сбоя, расширения (cfe).
 * Агент — эмулятор по фактам пилота; SFTP — настоящий ssh2.Server.
 */
const BOM = String.fromCharCode(0xfeff);

suite('AgentSyncEngine (Э7): sftp-ветка', function () {
  this.timeout(60_000);
  let h: SyncHarness;

  async function start(options: Parameters<typeof createHarness>[1] = {}): Promise<void> {
    h = await createHarness('sftp', options);
    h.seedDb();
  }
  const doImport = (): ReturnType<SyncHarness['engine']['importTarget']> => h.engine.importTarget(h.target, h.exec);
  const doLoad = (mode: 'full' | 'changed'): ReturnType<SyncHarness['engine']['loadTarget']> =>
    h.engine.loadTarget(h.target, mode, h.exec);
  const loadCommands = (from: number): ReturnType<SyncHarness['emulator']['dumps']> =>
    h.emulator.commands.slice(from).filter((c) => c.command === 'config load-config-from-files');

  teardown(async () => { await h.dispose(); });

  suite('импорт: выбор между дельтой и архивом', () => {
    test('порог: |C ∪ D| равно порогу → дельта; больше → архив over-threshold (файлы владельцев: Товары — 2 файла, Клиенты — 1)', async () => {
      await start({ archiveThresholdFiles: 3 });
      await doImport();
      h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
      h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>Клиенты v2</Catalog>');
      const exact = await doImport();
      assert.strictEqual(exact.strategy, 'delta', '3 файла при пороге 3');

      h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v3</Catalog>');
      h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>Клиенты v3</Catalog>');
      h.emulator.putFile('Roles/Админ.xml', '<Role>v3</Role>');
      const over = await doImport();
      assert.strictEqual(over.strategy, 'archive');
      assert.strictEqual(over.reason, 'over-threshold');
      assert.strictEqual(h.readP('Roles/Админ.xml'), '<Role>v3</Role>');
      assert.strictEqual(h.manifest().mirrorState, 'fresh');
    });

    test('локальные правки D входят в счёт порога', async () => {
      await start({ archiveThresholdFiles: 2 });
      await doImport();
      h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
      h.writeP('Roles/Админ.xml', '<Role>моя правка</Role>');
      h.writeP('CommonModules/Общий.xml', '<CommonModule>моя правка</CommonModule>');
      const result = await doImport();
      assert.strictEqual(result.strategy, 'archive');
      assert.strictEqual(result.reason, 'over-threshold');
      assert.strictEqual(h.readP('Roles/Админ.xml'), '<Role>Админ</Role>');
    });

    test('нераспознанный файл --get-changes → архив unrecognized (импорт корректен, только медленнее)', async () => {
      await start();
      await doImport();
      h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
      h.emulator.nextChangesText = `${BOM}Deleted: Catalog.Клиенты\r\n`;
      const result = await doImport();
      assert.strictEqual(result.strategy, 'archive');
      assert.strictEqual(result.reason, 'unrecognized');
      assert.strictEqual(h.readP('Catalogs/Клиенты.xml'), '<Catalog>v2</Catalog>');
    });

    test('вид объекта, которого нет в META_TYPES → архив unresolved-objects, без параллельного словаря', async () => {
      await start();
      await doImport();
      h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
      h.emulator.nextChangesText = `${BOM}Modified: Foo.Bar\r\nModified: Catalog.Клиенты\r\n`;
      const result = await doImport();
      assert.strictEqual(result.strategy, 'archive');
      assert.strictEqual(result.reason, 'unresolved-objects');
      assert.strictEqual(h.readP('Catalogs/Клиенты.xml'), '<Catalog>v2</Catalog>');
    });

    test('«нет изменений» (файл из одного BOM): ничего не скачивается, кроме самого списка', async () => {
      await start();
      await doImport();
      h.sftp?.log.splice(0);
      const result = await doImport();
      assert.strictEqual(result.strategy, 'delta');
      assert.deepStrictEqual(result.changedProjectFiles, []);
      const opened = (h.sftp?.ops('OPEN') ?? []).map((e) => e.path ?? '');
      assert.ok(opened.every((p) => /^exchange\/[^/]+\.changes$/.test(p)), opened.join(' | '));
    });

    test('M stale (после полной загрузки архивом): импорт идёт дельтой, лишних изменений в P нет, M снова fresh', async () => {
      await start();
      await doImport();
      await doLoad('full');
      assert.strictEqual(h.manifest().mirrorState, 'stale');
      const before = h.snapshotP();

      const result = await doImport();

      assert.strictEqual(result.strategy, 'delta');
      assert.deepStrictEqual(result.changedProjectFiles, [], 'база = P: содержимое не отличается');
      assert.deepStrictEqual(h.snapshotP(), before);
      assert.strictEqual(h.manifest().mirrorState, 'fresh');
    });

    test('двоичные файлы (картинка) идут байт-в-байт и архивом, и дельтой', async () => {
      await start();
      const picture = patternBytes(70_000, 11);
      h.emulator.setObject('CommonPicture.Лого', {
        'CommonPictures/Лого.xml': '<CommonPicture>Лого</CommonPicture>',
        'CommonPictures/Лого/Ext/Picture/Picture.png': picture,
      });
      await doImport();
      assert.ok(picture.equals(fs.readFileSync(path.join(h.configRoot, 'CommonPictures', 'Лого', 'Ext', 'Picture', 'Picture.png'))));

      const second = patternBytes(100_000, 12);
      h.emulator.putFile('CommonPictures/Лого/Ext/Picture/Picture.png', second);
      const result = await doImport();
      assert.strictEqual(result.strategy, 'delta');
      assert.ok(second.equals(fs.readFileSync(path.join(h.configRoot, 'CommonPictures', 'Лого', 'Ext', 'Picture', 'Picture.png'))));
    });
  });

  suite('импорт: сбои и самовосстановление', () => {
    test('повреждённый архив при FullDump: ArchiveFormatError, P не тронут, хук не вызван, M НЕ тронут (манифест fresh); следующий импорт снова идёт архивом full-dump и чинит', async () => {
      await start();
      await doImport();
      const before = h.snapshotP();
      h.emulator.removeObject('Document.Заказ');
      h.emulator.nextArchiveTamper = (zip) => zip.subarray(0, zip.length - 40);
      let hookCalls = 0;

      await assert.rejects(
        h.engine.importTarget(h.target, h.exec, { onProjectFilesWillChange: () => { hookCalls += 1; } }),
        ArchiveFormatError
      );

      assert.deepStrictEqual(h.snapshotP(), before, 'частичной записи в проект нет');
      assert.strictEqual(hookCalls, 0);
      // Изменено: FullDump → архив без предшествующей мутации M; испорченный архив отвергается до посева.
      assert.strictEqual(h.manifest().mirrorState, 'fresh');
      assert.deepStrictEqual(fs.existsSync(path.join(h.userRoot, 'exchange')) ? fs.readdirSync(path.join(h.userRoot, 'exchange')) : [], []);

      const healed = await doImport();
      assert.strictEqual(healed.strategy, 'archive');
      assert.strictEqual(healed.reason, 'full-dump');
      assert.deepStrictEqual(h.snapshotP(), dbAsText(h.emulator.dbFiles()));
      assert.strictEqual(h.manifest().mirrorState, 'fresh');
    });

    test('сбой второго шага (запись M после получения списка): P не тронут, M → empty', async () => {
      await start();
      await doImport();
      const before = h.snapshotP();
      h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
      h.emulator.failWhen = (cmd) => (
        cmd.command === 'config dump-config-to-files' && cmd.options.update === true && !cmd.options['get-changes']
          ? agentError('UnknownError', 'сбой записи')
          : undefined
      );

      await assert.rejects(doImport(), /сбой записи/);

      assert.deepStrictEqual(h.snapshotP(), before);
      assert.strictEqual(h.manifest().mirrorState, 'empty');
      assert.deepStrictEqual(fs.existsSync(path.join(h.userRoot, 'exchange')) ? fs.readdirSync(path.join(h.userRoot, 'exchange')) : [], []);
    });

    test('сбой самой команды агента на первом импорте: ошибка пробрасывается, P не создаётся', async () => {
      await start();
      h.emulator.failWhen = () => agentError('UnknownError', 'агент недоступен');
      await assert.rejects(doImport(), /агент недоступен/);
      assert.strictEqual(fs.existsSync(h.configRoot), false);
    });

    test('M потерян на сервере (манифест fresh, каталога нет → ConfigFilesError на get-changes): импорт восстанавливается полной выгрузкой и архивом', async () => {
      await start();
      await doImport();
      fs.rmSync(h.mirrorAbs, { recursive: true, force: true });
      h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');

      const result = await doImport();

      assert.strictEqual(result.strategy, 'archive');
      assert.strictEqual(result.reason, 'mirror-empty');
      assert.strictEqual(h.readP('Catalogs/Клиенты.xml'), '<Catalog>v2</Catalog>');
      assert.strictEqual(h.manifest().mirrorState, 'fresh');
    });

    test('дельта: Configuration.xml исчез из M (Ext/ корня на месте) → отказ до записи, P не тронут, M → empty (Н39)', async () => {
      await start();
      // Каталог Ext/ корня есть в M — владелец «найден», и отсутствие Configuration.xml дало бы его
      // удаление из P; без Ext/ владелец «отсутствует», и импорт уходит в архив (Б2).
      h.emulator.putFile('Ext/SessionModule.bsl', 'Процедура А() КонецПроцедуры', ['SessionModule']);
      await doImport();
      // После первого импорта M разреженный (только CDI и Configuration.xml), а сценарий Н39 — про ПОЛНЫЙ M
      // с Ext/ корня: ограничение дельты «владелец найден, Configuration.xml пропал» при разреженном M
      // невозможно (там удаление разрешено только для D.added).
      h.makeMirrorFull();
      const before = h.snapshotP();
      fs.unlinkSync(path.join(h.mirrorAbs, 'Configuration.xml'));
      h.emulator.nextChangesText = `${BOM}Modified: Configuration.Конфигурация
\r\n`;
      let hookCalls = 0;

      await assert.rejects(
        h.engine.importTarget(h.target, h.exec, { onProjectFilesWillChange: () => { hookCalls += 1; } }),
        /Configuration\.xml/
      );

      assert.deepStrictEqual(h.snapshotP(), before);
      assert.strictEqual(hookCalls, 0);
      assert.strictEqual(h.manifest().mirrorState, 'empty');
    });

    test('сбой уборки каталога обмена не заслоняет успешный импорт (Н39)', async () => {
      const holder: { store?: FailingExchangeRemoveStore } = {};
      await start({ wrapStore: (store) => { holder.store = new FailingExchangeRemoveStore(store); return holder.store; } });

      const result = await doImport();

      assert.strictEqual(result.strategy, 'archive');
      assert.deepStrictEqual(h.snapshotP(), dbAsText(h.emulator.dbFiles()));
      assert.ok((holder.store?.removeAttempts ?? 0) >= 2, 'уборка пробовала удалить и каталог обмена, и файл списка');
      assert.strictEqual(h.manifest().mirrorState, 'fresh');
    });

    test('модуль сеанса конфигурации изменён (Б1): дельта скачивает Ext/ корня, P = база', async () => {
      await start();
      h.emulator.putFile('Ext/SessionModule.bsl', 'Процедура УстановкаПараметровСеанса() КонецПроцедуры', ['SessionModule']);
      await doImport();
      h.emulator.putFile('Ext/SessionModule.bsl', 'Процедура УстановкаПараметровСеанса(Параметры) КонецПроцедуры', ['SessionModule']);

      const result = await doImport();

      assert.strictEqual(result.strategy, 'delta');
      assert.strictEqual(h.readP('Ext/SessionModule.bsl'), 'Процедура УстановкаПараметровСеанса(Параметры) КонецПроцедуры');
      assert.deepStrictEqual(h.manifest().files, await buildSyncManifestFiles(h.configRoot));
      const tracked = dbAsText(h.emulator.dbTrackedFiles());
      const actual = h.snapshotP();
      delete actual['ConfigDumpInfo.xml'];
      assert.deepStrictEqual(actual, tracked);
    });

    test('владелец изменения отсутствует в M после второго шага (Б2: вложенная подсистема) → архив, а не молчаливый пропуск', async () => {
      await start();
      h.emulator.setObject('Subsystem.Родитель', {
        'Subsystems/Родитель.xml': '<Subsystem>Родитель</Subsystem>',
        'Subsystems/Родитель/Subsystems/Дочерняя.xml': '<Subsystem>Дочерняя</Subsystem>',
      });
      await doImport();
      h.emulator.putFile('Subsystems/Родитель/Subsystems/Дочерняя.xml', '<Subsystem>Дочерняя v2</Subsystem>');
      h.emulator.nextChangesText = `${BOM}Modified: Subsystem.Дочерняя
\r\n`;

      const result = await doImport();

      assert.strictEqual(result.strategy, 'archive');
      assert.strictEqual(result.reason, 'unresolved-objects');
      assert.strictEqual(h.readP('Subsystems/Родитель/Subsystems/Дочерняя.xml'), '<Subsystem>Дочерняя v2</Subsystem>');
    });

    test('усечённый счётчик записей архива (Б3): ArchiveFormatError, P не тронут, M не тронут (архив отвергнут до посева)', async () => {
      await start();
      await doImport();
      const before = h.snapshotP();
      h.emulator.removeObject('Document.Заказ');
      h.emulator.nextArchiveTamper = (zip) => {
        const copy = Buffer.from(zip);
        const end = copy.length - 22;
        const count = copy.readUInt16LE(end + 10) - 1;
        copy.writeUInt16LE(count, end + 8);
        copy.writeUInt16LE(count, end + 10);
        return copy;
      };

      await assert.rejects(doImport(), ArchiveFormatError);

      assert.deepStrictEqual(h.snapshotP(), before, 'ни одного удаления «отсутствующих» файлов');
      assert.strictEqual(h.manifest().mirrorState, 'fresh');
    });

    // Изменено планом потокового архива/посева: полной выгрузки в M при первом импорте больше нет —
    // M очищается и засевается только файлом версий и Configuration.xml из архива.
    test('M empty: недостоверный M очищается ДО посева (остаток не переживает его), в M только CDI и Configuration.xml', async () => {
      await start();
      fs.mkdirSync(path.join(h.mirrorAbs, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(h.mirrorAbs, 'Catalogs', 'Остаток.xml'), '<stale/>');

      const result = await doImport();

      assert.strictEqual(result.reason, 'mirror-empty');
      assert.deepStrictEqual(h.listM(), ['ConfigDumpInfo.xml', 'Configuration.xml']);
      assert.ok(!fs.existsSync(path.join(h.mirrorAbs, 'Catalogs', 'Остаток.xml')));
      assert.ok(h.emulator.dumps().every((d) => d.options.dir !== h.mirrorDir), 'выгрузки в M нет');
    });

    test('архив без Configuration.xml на первом импорте → отказ, P не создаётся', async () => {
      await start();
      h.emulator.removeObject('Configuration.Конфигурация');
      await assert.rejects(doImport(), /Configuration\.xml/);
      assert.strictEqual(fs.existsSync(h.configRoot), false);
    });
  });

  suite('загрузка: состояние M, порог, содержимое архива', () => {
    test('M stale + частичная загрузка: сначала dump --update без скачивания, затем загрузка; M → fresh', async () => {
      await start();
      await doImport();
      await doLoad('full');
      assert.strictEqual(h.manifest().mirrorState, 'stale');
      h.writeP('Catalogs/Клиенты.xml', '<Catalog>после полной</Catalog>');
      const from = h.emulator.commands.length;
      h.sftp?.log.splice(0);

      const result = await doLoad('changed');

      assert.strictEqual(result.strategy, 'partial');
      const tail = h.emulator.commands.slice(from).filter((c) => c.command !== 'common connect-ib');
      assert.deepStrictEqual(tail.map((c) => c.command), ['config dump-config-to-files', 'config load-config-from-files']);
      assert.strictEqual(tail[0].options.update, true);
      assert.ok(!tail[0].options['get-changes'] && !tail[0].options.archive);
      assert.strictEqual(tail[0].options.dir, h.mirrorDir);
      assert.strictEqual(tail[1].options.partial, true);
      assert.strictEqual(h.readM('Catalogs/Клиенты.xml'), '<Catalog>после полной</Catalog>');
      assert.strictEqual(h.manifest().mirrorState, 'fresh');
      // Скачивания из M на этом шаге нет (кроме служебных): refresh-dump только на сервере.
      assert.deepStrictEqual((h.sftp?.ops('OPEN') ?? []).filter((e) => (e.path ?? '').startsWith(h.mirrorDir) && !(e.path ?? '').endsWith('.v8tmp')), []);
    });

    // Н47 (Э8): при известной B база ≡ B — пустой M восстанавливается полной выгрузкой на сервере
    // (без --update и без скачивания), затем частичная загрузка; архив P по сети не передаётся.
    test('M empty при известном B → очистка M, полная выгрузка в M без скачивания, затем частичная загрузка', async () => {
      await start();
      await doImport();
      h.saveManifest('empty', await buildSyncManifestFiles(h.configRoot));
      fs.writeFileSync(path.join(h.mirrorAbs, 'Остаток.xml'), '<stale/>');
      h.writeP('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
      const from = h.emulator.commands.length;
      let leftoverAtDump: boolean | undefined;
      h.emulator.onCommand = (cmd) => {
        if (cmd.command === 'config dump-config-to-files' && leftoverAtDump === undefined) {
          leftoverAtDump = fs.existsSync(path.join(h.mirrorAbs, 'Остаток.xml'));
        }
      };
      h.sftp?.log.splice(0);

      const result = await doLoad('changed');

      assert.strictEqual(result.strategy, 'partial');
      const tail = h.emulator.commands.slice(from).filter((c) => c.command !== 'common connect-ib');
      assert.deepStrictEqual(tail.map((c) => c.command), ['config dump-config-to-files', 'config load-config-from-files']);
      assert.strictEqual(tail[0].options.dir, h.mirrorDir);
      assert.ok(!tail[0].options.update && !tail[0].options.archive && !tail[0].options['get-changes']);
      assert.strictEqual(tail[1].options.partial, true);
      assert.ok(!loadCommands(from).some((c) => c.options.archive), 'архива P нет');
      assert.strictEqual(leftoverAtDump, false, 'M очищен до выгрузки');
      assert.strictEqual(h.readM('Catalogs/Клиенты.xml'), '<Catalog>v2</Catalog>');
      assert.strictEqual(h.manifest().mirrorState, 'fresh');
      assert.deepStrictEqual((h.sftp?.ops('OPEN') ?? []).filter((e) => (e.path ?? '').startsWith(h.mirrorDir) && !(e.path ?? '').endsWith('.v8tmp') && !(e.path ?? '').endsWith('Клиенты.xml')), []);
    });

    test('M empty при известном B, хуки без onMessage: подготовка full-dump проходит с тем же исходом', async () => {
      await start();
      await doImport();
      h.saveManifest('empty', await buildSyncManifestFiles(h.configRoot));
      h.writeP('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');

      const result = await h.engine.loadTarget(h.target, 'changed', h.exec, { cancellation: { isCancellationRequested: false } });

      assert.strictEqual(result.strategy, 'partial');
      assert.strictEqual(h.readM('Catalogs/Клиенты.xml'), '<Catalog>v2</Catalog>');
      assert.strictEqual(h.manifest().mirrorState, 'fresh');
    });

    test('M empty при известном B, хуков нет вовсе: подготовка full-dump проходит с тем же исходом', async () => {
      await start();
      await doImport();
      h.saveManifest('empty', await buildSyncManifestFiles(h.configRoot));
      h.writeP('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');

      const result = await h.engine.loadTarget(h.target, 'changed', h.exec);

      assert.strictEqual(result.strategy, 'partial');
      assert.strictEqual(h.readM('Catalogs/Клиенты.xml'), '<Catalog>v2</Catalog>');
      assert.strictEqual(h.manifest().mirrorState, 'fresh');
    });

    test('порог частичной загрузки: больше файлов → полная архивом over-threshold', async () => {
      await start({ archiveThresholdFiles: 2 });
      await doImport();
      h.writeP('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
      h.writeP('Roles/Админ.xml', '<Role>v2</Role>');
      h.writeP('Catalogs/Товары.xml', '<Catalog>v2</Catalog>');
      const result = await doLoad('changed');
      assert.strictEqual(result.strategy, 'full');
      assert.strictEqual(result.reason, 'over-threshold');
      assert.strictEqual(result.via, 'archive');
    });

    test('архив загрузки: все файлы проекта кроме ConfigDumpInfo.xml, байт-в-байт, имена UTF-8 с флагом, deflate; файл обмена после операции убран', async () => {
      await start();
      const picture = patternBytes(50_000, 21);
      h.emulator.setObject('CommonPicture.Лого', {
        'CommonPictures/Лого.xml': '<CommonPicture>Лого</CommonPicture>',
        'CommonPictures/Лого/Ext/Picture/Picture.png': picture,
      });
      await doImport();
      h.removeP('Catalogs/Клиенты.xml');
      let captured: ReturnType<typeof readZip> | undefined;
      h.emulator.onCommand = (cmd) => {
        if (cmd.command === 'config load-config-from-files' && typeof cmd.options.archive === 'string') {
          captured = readZip(fs.readFileSync(path.join(h.userRoot, ...String(cmd.options.dir).split('/'), cmd.options.archive)));
        }
      };

      await doLoad('changed');

      assert.ok(captured);
      const names = captured.map((e) => e.nameBytes.toString('utf-8')).sort();
      const expected = Object.keys(h.snapshotP()).filter((rel) => rel !== 'ConfigDumpInfo.xml').sort();
      assert.deepStrictEqual(names, expected);
      assert.ok(captured.every((e) => (e.flags & 0x0800) !== 0), 'бит 11 (UTF-8) у каждой записи');
      const png = captured.find((e) => e.nameBytes.toString('utf-8').endsWith('Picture.png'));
      assert.ok(png && picture.equals(png.data));
      assert.deepStrictEqual(fs.existsSync(path.join(h.userRoot, 'exchange')) ? fs.readdirSync(path.join(h.userRoot, 'exchange')) : [], []);
    });

    test('сбой загрузки архивом: ошибка пробрасывается, файл обмена убран, B прежний', async () => {
      await start();
      await doImport();
      const manifestBefore = h.manifest().files;
      h.removeP('Catalogs/Клиенты.xml');
      h.emulator.failWhen = (cmd) => (cmd.command === 'config load-config-from-files' ? agentError('UnknownError', 'загрузка упала') : undefined);

      await assert.rejects(doLoad('changed'), /загрузка упала/);

      assert.deepStrictEqual(h.manifest().files, manifestBefore, 'B обновляется только после успешной загрузки');
      assert.deepStrictEqual(fs.existsSync(path.join(h.userRoot, 'exchange')) ? fs.readdirSync(path.join(h.userRoot, 'exchange')) : [], []);
    });
  });

  suite('рабочая область и расширения', () => {
    test('каталоги exchange/ и lists/ существуют после операции; M лежит в workspace/<projectId>/cf', async () => {
      await start();
      await doImport();
      assert.ok(fs.existsSync(path.join(h.userRoot, 'exchange')));
      assert.ok(fs.existsSync(path.join(h.userRoot, 'lists')));
      assert.ok(fs.existsSync(path.join(h.mirrorAbs, 'Configuration.xml')));
    });

    test('cfe: --extension в КАЖДОЙ команде (выгрузка M, архив, список, запись, загрузка); свой M и свой манифест', async () => {
      await start();
      const extRoot = path.join(h.projectRoot, 'src', 'cfe', 'Расш');
      const target = { kind: 'cfe' as const, name: 'Расш', rootPath: extRoot };

      await h.engine.importTarget(target, h.exec);
      h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
      await h.engine.importTarget(target, h.exec);
      fs.writeFileSync(path.join(extRoot, 'Catalogs', 'Клиенты.xml'), '<Catalog>v3</Catalog>');
      await h.engine.loadTarget(target, 'changed', h.exec);
      fs.unlinkSync(path.join(extRoot, 'Catalogs', 'Клиенты.xml'));
      await h.engine.loadTarget(target, 'changed', h.exec);

      const agentCommands = h.emulator.commands.filter((c) => c.command.startsWith('config '));
      // Первый импорт — одна выгрузка архивом (полной выгрузки в M больше нет): архив, список изменений,
      // --update, частичная и полная загрузка.
      assert.ok(agentCommands.length >= 5);
      for (const command of agentCommands) {
        assert.strictEqual(command.options.extension, 'Расш', command.raw);
      }
      const manifest = loadSyncManifest(h.projectRoot, buildScopeKey('cfe', extRoot, 'Расш'));
      assert.strictEqual(manifest.mirrorState, 'stale');
      assert.deepStrictEqual(manifest.files, await buildSyncManifestFiles(extRoot));
      assert.ok(fs.existsSync(path.join(h.userRoot, 'workspace', path.basename(path.dirname(h.mirrorAbs)), 'cfe', 'Расш', 'Configuration.xml')));
      assert.deepStrictEqual(h.manifest().files, {}, 'манифест cf не затронут');
    });
  });
});
