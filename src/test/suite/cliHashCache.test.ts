import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { importGitChanges } from '../../cli/commands/importGitChanges';
import { refreshHashCacheAfterImport } from '../../cli/commands/importConfiguration';
import { refreshHashCache } from '../../cli/commands/refreshHashCache';
import { scanHashSnapshot as scanHashSnapshotFromCli } from '../../cli/core/hashCache';
import { buildHashSnapshot, buildScopeKey, loadHashCache, saveHashCache } from '../../infra/cache/HashCache';
import { scanHashSnapshot } from '../../infra/cache/HashScanner';
import { HASH_STAT_RACY_WINDOW_MS, loadHashStatMemo, resolveHashStatMemoPath } from '../../infra/cache/HashStatMemo';
import { captureConsole } from './support/consoleCapture';
import { buildMinimalConfigXml, writeRel } from './support/hashScanFixtures';

/**
 * CLI-потребители хеш-кэша на быстрой проверке (без платформы 1С: DryRun и экспортированная
 * функция обновления кэша после импорта). У CLI нет шва `now`, поэтому выгрузка, на которой
 * проверяется запись мемо, «стареет» ОДИН раз в suiteSetup на величину racy-окна: после этого
 * max(mtime, ctime) любого её файла гарантированно вне окна — детерминированно, без угадывания.
 */
suite('CLI: хеш-кэш с быстрой проверкой', function () {
  this.timeout(60_000);
  let agedRoot: string;
  let agedConfigDir: string;
  let projectRoot: string;
  const TRACKED = 3;

  suiteSetup(async function () {
    this.timeout(30_000);
    agedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-cli-hash-aged-'));
    agedConfigDir = path.join(agedRoot, 'cf');
    writeRel(agedConfigDir, 'Configuration.xml', buildMinimalConfigXml('Конфигурация'));
    writeRel(agedConfigDir, 'Catalogs/Товары.xml', '<Catalog>Товары</Catalog>');
    writeRel(agedConfigDir, 'Catalogs/Товары/Ext/ObjectModule.bsl', 'Процедура А() КонецПроцедуры');
    await new Promise((resolve) => setTimeout(resolve, HASH_STAT_RACY_WINDOW_MS + 300));
  });
  suiteTeardown(() => { fs.rmSync(agedRoot, { recursive: true, force: true }); });

  setup(() => { projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-cli-hash-project-')); });
  teardown(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

  async function withConsole<T>(action: () => Promise<T>): Promise<{ result: T; log: string[] }> {
    const capture = captureConsole();
    try {
      const result = await action();
      return { result, log: capture.log };
    } finally {
      capture.restore();
    }
  }

  test('cli/core/hashCache реэкспортирует scanHashSnapshot', () => {
    assert.strictEqual(scanHashSnapshotFromCli, scanHashSnapshot);
  });

  suite('refreshHashCache', () => {
    test('код 0; базовая линия = эталонному полному проходу; мемо записан; повтор — тот же результат', async () => {
      const args = { ProjectRoot: projectRoot, ConfigDir: agedConfigDir, Target: 'cf' };
      const { result, log } = await withConsole(() => refreshHashCache(args));
      assert.strictEqual(result, 0);
      const scopeKey = buildScopeKey('cf', agedConfigDir);
      assert.deepStrictEqual(loadHashCache(projectRoot, scopeKey).files, buildHashSnapshot(scopeKey, agedConfigDir).files);
      assert.ok(log.some((l) => l.includes(`Hash cache rebuilt: ${String(TRACKED)} files`)), log.join('\n'));
      assert.strictEqual(Object.keys((await loadHashStatMemo(projectRoot, agedConfigDir)).entries).length, TRACKED);

      const again = await withConsole(() => refreshHashCache(args));
      assert.strictEqual(again.result, 0);
      assert.deepStrictEqual(loadHashCache(projectRoot, scopeKey).files, buildHashSnapshot(scopeKey, agedConfigDir).files);
    });
  });

  suite('importGitChanges -DryRun', () => {
    test('базовой линии нет → «Hash changes detected», код 0, мемо записан', async () => {
      const { result, log } = await withConsole(() => importGitChanges({
        ProjectRoot: projectRoot, ConfigDir: agedConfigDir, Target: 'cf', DryRun: true,
      }));
      assert.strictEqual(result, 0);
      assert.ok(log.some((l) => l.startsWith(`Hash changes detected: added=${String(TRACKED)}`)), log.join('\n'));
      assert.ok(log.some((l) => l.includes('DryRun mode - no changes applied')));
      assert.ok(fs.existsSync(resolveHashStatMemoPath(projectRoot, agedConfigDir)));
    });

    test('базовая линия совпадает с текущим состоянием → «No hash changes found»', async () => {
      const scopeKey = buildScopeKey('cf', agedConfigDir);
      saveHashCache(projectRoot, buildHashSnapshot(scopeKey, agedConfigDir));
      const { result, log } = await withConsole(() => importGitChanges({
        ProjectRoot: projectRoot, ConfigDir: agedConfigDir, Target: 'cf', DryRun: true,
      }));
      assert.strictEqual(result, 0);
      assert.ok(log.includes('No hash changes found'), log.join('\n'));
      assert.ok(fs.existsSync(resolveHashStatMemoPath(projectRoot, agedConfigDir)));
    });

    test('Target cfe: область расширения (cfe::<имя>::<каталог>)', async () => {
      const scopeKey = buildScopeKey('cfe', agedConfigDir, 'Расш');
      saveHashCache(projectRoot, buildHashSnapshot(scopeKey, agedConfigDir));
      const { result, log } = await withConsole(() => importGitChanges({
        ProjectRoot: projectRoot, ConfigDir: agedConfigDir, Target: 'cfe', Extension: 'Расш', DryRun: true,
      }));
      assert.strictEqual(result, 0);
      assert.ok(log.includes('No hash changes found'), log.join('\n'));
    });

    test('изменённый файл относительно базовой линии виден', async () => {
      const scopeKey = buildScopeKey('cf', agedConfigDir);
      const snapshot = buildHashSnapshot(scopeKey, agedConfigDir);
      saveHashCache(projectRoot, { ...snapshot, files: { ...snapshot.files, 'Catalogs/Товары.xml': 'устарело' } });
      const { log } = await withConsole(() => importGitChanges({
        ProjectRoot: projectRoot, ConfigDir: agedConfigDir, Target: 'cf', DryRun: true,
      }));
      assert.ok(log.some((l) => l.startsWith('Hash changes detected: added=0, modified=1, deleted=0')), log.join('\n'));
    });
  });

  suite('refreshHashCacheAfterImport', () => {
    test('Full: базовая линия = полному проходу, мемо записан', async () => {
      await withConsole(() => refreshHashCacheAfterImport(projectRoot, agedConfigDir, 'cf', '', 'Full', []));
      const scopeKey = buildScopeKey('cf', agedConfigDir);
      assert.deepStrictEqual(loadHashCache(projectRoot, scopeKey).files, buildHashSnapshot(scopeKey, agedConfigDir).files);
      assert.ok(fs.existsSync(resolveHashStatMemoPath(projectRoot, agedConfigDir)));
    });

    test('Full для cfe: область расширения', async () => {
      await withConsole(() => refreshHashCacheAfterImport(projectRoot, agedConfigDir, 'cfe', 'Расш', 'Full', []));
      const scopeKey = buildScopeKey('cfe', agedConfigDir, 'Расш');
      assert.deepStrictEqual(loadHashCache(projectRoot, scopeKey).files, buildHashSnapshot(scopeKey, agedConfigDir).files);
    });

    test('Partial: пропатчены только перечисленные; отсутствующий перечисленный удалён из базовой линии', async () => {
      const configDir = path.join(projectRoot, 'src', 'cf');
      writeRel(configDir, 'Configuration.xml', buildMinimalConfigXml('Конфигурация'));
      writeRel(configDir, 'Catalogs/А.xml', '<a/>');
      writeRel(configDir, 'Catalogs/Б.xml', '<b/>');
      const scopeKey = buildScopeKey('cf', configDir);
      saveHashCache(projectRoot, {
        schemaVersion: 1,
        scopeKey,
        generatedAt: 'x',
        files: { 'Catalogs/А.xml': 'старый', 'Catalogs/Б.xml': 'не-трогать', 'Catalogs/Удалён.xml': 'был' },
      });
      await withConsole(() => refreshHashCacheAfterImport(
        projectRoot, configDir, 'cf', '', 'Partial', ['Catalogs/А.xml', 'Catalogs/Удалён.xml']
      ));
      assert.deepStrictEqual(loadHashCache(projectRoot, scopeKey).files, {
        'Catalogs/А.xml': createHash('sha1').update('<a/>').digest('hex'),
        'Catalogs/Б.xml': 'не-трогать',
      });
    });
  });
});
