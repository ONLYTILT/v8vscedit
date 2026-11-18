import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildSyncManifestFiles, mirrorCoverageOf } from '../../infra/agent/sync/SyncManifest';
import { emptyHashStatMemo, loadHashStatMemo, saveHashStatMemo } from '../../infra/cache/HashStatMemo';
import { createHarness, type SyncHarness } from './support/agentSyncHarness';

/**
 * Э7: регресс локального режима. Для локального хранилища движок использует стратегию ПОЛНОГО
 * сравнения M и P (хэширование дёшево, формат `--get-changes` не нужен): ни `--get-changes`, ни
 * `--archive` в командах не появляются; прежнее поведение полного/частичной загрузки и каркаса M
 * сохраняется, но запись идёт через writeFileAtomic и только по реально изменённым файлам.
 */
suite('AgentSyncEngine (Э7): локальное хранилище', function () {
  this.timeout(60_000);
  let h: SyncHarness;

  setup(async () => {
    h = await createHarness('local', { archiveThresholdFiles: 1 });
    h.seedDb();
  });
  teardown(async () => { await h.dispose(); });

  const doImport = (): ReturnType<SyncHarness['engine']['importTarget']> => h.engine.importTarget(h.target, h.exec);
  const doLoad = (mode: 'full' | 'changed'): ReturnType<SyncHarness['engine']['loadTarget']> => h.engine.loadTarget(h.target, mode, h.exec);

  function allFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(path.join(current, entry.name));
        } else {
          out.push(path.join(current, entry.name));
        }
      }
    };
    if (fs.existsSync(dir)) {
      walk(dir);
    }
    return out;
  }

  test('полный цикл импорт → импорт → частичная загрузка → полная: ни --get-changes, ни --archive; порог архива (1) локально не действует', async () => {
    await doImport();
    h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>v2</Catalog>');
    h.emulator.putFile('Roles/Админ.xml', '<Role>v2</Role>');
    h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
    await doImport();
    h.writeP('Catalogs/Товары.xml', '<Catalog>v3</Catalog>');
    h.writeP('Roles/Админ.xml', '<Role>v3</Role>');
    const partial = await doLoad('changed');
    await doLoad('full');

    assert.strictEqual(partial.strategy, 'partial', 'два изменённых файла при пороге 1 — всё равно частичная');
    for (const command of h.emulator.commands) {
      assert.ok(!('get-changes' in command.options) && !('archive' in command.options), command.raw);
    }
    const dumps = h.emulator.dumps();
    assert.ok(!dumps[0].options.update, 'первая выгрузка — полная');
    assert.strictEqual(dumps[1].options.update, true, 'в M уже есть ConfigDumpInfo.xml — выгрузка с --update');
  });

  test('импорт пишет в P только отличающиеся файлы и не оставляет временных файлов writeFileAtomic', async () => {
    await doImport();
    for (const file of allFiles(h.configRoot)) {
      fs.utimesSync(file, new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'));
    }
    h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
    await doImport();
    const touched = allFiles(h.configRoot)
      .filter((file) => fs.statSync(file).mtime.getUTCFullYear() !== 2001)
      .map((file) => path.relative(h.configRoot, file).replace(/\\/g, '/'))
      .filter((rel) => rel !== 'ConfigDumpInfo.xml');
    assert.deepStrictEqual(touched, ['Catalogs/Клиенты.xml']);
    assert.ok(allFiles(h.configRoot).every((file) => !file.endsWith('.tmp')), 'временные файлы атомарной записи убраны');
  });

  test('частичная загрузка при готовом каркасе M: посторонний файл в M остаётся (M не зеркалится заново)', async () => {
    await doImport();
    fs.writeFileSync(path.join(h.mirrorAbs, 'Stray.xml'), '<stray/>');
    h.writeP('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
    await doLoad('changed');
    assert.ok(fs.existsSync(path.join(h.mirrorAbs, 'Stray.xml')));
    assert.strictEqual(h.readM('Catalogs/Клиенты.xml'), '<Catalog>v2</Catalog>');
  });

  test('частичная загрузка без каркаса M (нет Configuration.xml): P зеркалится в M целиком, лишнее в M убирается', async () => {
    await doImport();
    h.saveManifest('fresh', await buildSyncManifestFiles(h.configRoot));
    fs.unlinkSync(path.join(h.mirrorAbs, 'Configuration.xml'));
    fs.writeFileSync(path.join(h.mirrorAbs, 'Stray.xml'), '<stray/>');
    h.writeP('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');

    const result = await doLoad('changed');

    assert.strictEqual(result.strategy, 'partial');
    assert.strictEqual(h.readM('Configuration.xml'), '<Configuration v="1"/>');
    assert.ok(!fs.existsSync(path.join(h.mirrorAbs, 'Stray.xml')));
    assert.strictEqual(h.readM('Catalogs/Клиенты.xml'), '<Catalog>v2</Catalog>');
  });

  test('полная загрузка: M становится копией P (лишнее удалено), загрузка из каталога с --update-config-dump-info', async () => {
    await doImport();
    fs.writeFileSync(path.join(h.mirrorAbs, 'Lishnee.xml'), '<x/>');
    fs.mkdirSync(path.join(h.mirrorAbs, 'Old', 'Ext'), { recursive: true });
    fs.writeFileSync(path.join(h.mirrorAbs, 'Old', 'Ext', 'x.bsl'), 'x');

    const result = await doLoad('full');

    assert.strictEqual(result.via, 'dir');
    assert.ok(!fs.existsSync(path.join(h.mirrorAbs, 'Lishnee.xml')));
    assert.ok(!fs.existsSync(path.join(h.mirrorAbs, 'Old')));
    const load = h.emulator.commands.filter((c) => c.command === 'config load-config-from-files').at(-1);
    assert.ok(load);
    assert.strictEqual(load.options.dir, h.mirrorDir);
    assert.strictEqual(load.options['update-config-dump-info'], true);
  });

  test('P ≡ M по файлам P после импорта (локальный M — «зеркало» без второго источника правды)', async () => {
    await doImport();
    h.emulator.removeObject('Role.Админ');
    h.emulator.setObject('Catalog.Новый', { 'Catalogs/Новый.xml': '<n/>' });
    await doImport();
    const inP = Object.keys(h.snapshotP()).sort();
    const inM = allFiles(h.mirrorAbs).map((f) => path.relative(h.mirrorAbs, f).replace(/\\/g, '/')).sort();
    assert.deepStrictEqual(inP, inM);
    assert.deepStrictEqual(h.manifest().files, await buildSyncManifestFiles(h.configRoot));
  });

  test('импорт строит манифест B через stat-мемо проекта: мемо обновлён (устаревшая запись вычищена), B = hash(P)', async () => {
    // Свежезаписанные файлы racy и в мемо не попадают, поэтому участие мемо проверяется по вычистке
    // заведомо устаревшей записи: её убирает только проход, которому передан projectRoot.
    saveHashStatMemo(h.projectRoot, {
      ...emptyHashStatMemo(h.configRoot),
      entries: { 'Нет/Такого.xml': [1, 1, 1, 'устарело'] },
    });
    await doImport();
    const memo = await loadHashStatMemo(h.projectRoot, h.configRoot);
    assert.ok(!('Нет/Такого.xml' in memo.entries));
    assert.deepStrictEqual(h.manifest().files, await buildSyncManifestFiles(h.configRoot));
  });
});

/**
 * Посев зеркала — только для удалённого хранилища (SFTP): локальный агент пишет M на этой же машине, его
 * импорт сравнивает M и P целиком (`compare`), а зеркало всегда полное. Хук согласия не вызывается даже
 * при пригодной выгрузке проекта (файл версий и Configuration.xml в P), состав команд и стратегия прежние.
 */
suite('AgentSyncEngine (Э7): локальное хранилище не засевает зеркало', function () {
  this.timeout(60_000);
  let h: SyncHarness;

  setup(async () => {
    h = await createHarness('local');
    h.seedDb();
    h.emulator.setConfiguration('Основная', 'cf');
  });
  teardown(async () => { await h.dispose(); });

  test('пригодная выгрузка проекта в P: хук не вызывается, стратегия compare, полная выгрузка в M без --update/--archive, полнота full', async () => {
    h.emulator.snapshotToProject(h.configRoot);
    h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
    let hookCalls = 0;

    const result = await h.importTarget({
      confirmMirrorSeed: () => { hookCalls += 1; return Promise.resolve('seed'); },
    });

    assert.strictEqual(hookCalls, 0);
    assert.strictEqual(result.strategy, 'compare');
    assert.strictEqual(result.seededFrom, undefined);
    const dumps = h.emulator.dumps();
    assert.strictEqual(dumps.length, 1);
    assert.strictEqual(dumps[0].options.dir, h.mirrorDir);
    assert.ok(!dumps[0].options.archive && !dumps[0].options['get-changes']);
    assert.strictEqual(mirrorCoverageOf(h.manifest()), 'full');
    assert.strictEqual(h.readP('Catalogs/Клиенты.xml'), '<Catalog>v2</Catalog>');
    assert.deepStrictEqual(h.localExchangeLeftovers(), [], 'локальный обмен потокового архива локально не создаётся');
  });

  test('загрузка: полнота остаётся full (локальное хранилище полное и после полной загрузки каталогом)', async () => {
    await h.importTarget();
    await h.loadTarget('full');
    assert.strictEqual(mirrorCoverageOf(h.manifest()), 'full');
  });
});
