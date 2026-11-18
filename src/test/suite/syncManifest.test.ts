import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildHashSnapshot, buildScopeKey, saveHashCache } from '../../infra/cache/HashCache';
import {
  buildSyncManifestFiles,
  diffSyncFiles,
  loadSyncManifest,
  resolveSyncManifestPath,
  saveSyncManifest,
  type SyncManifest,
} from '../../infra/agent/sync/SyncManifest';

/**
 * Э7: манифест B — «отн. путь → sha1» отслеживаемых файлов P на момент последней успешной
 * синхронизации + флаг состояния M (`empty | stale | fresh`). Хранится в
 * `.v8vscedit/agent-sync/<sha1(scopeKey)>.json` (вне каталога агента по умолчанию `.v8vscedit/agent`) через writeFileAtomic. Набор отслеживаемых файлов
 * и хэш — те же, что у HashCache (ConfigDumpInfo.xml не отслеживается): так B и «кэш хэшей»
 * не расходятся, а манифест, которого ещё нет, берётся из HashCache (миграция).
 */
suite('SyncManifest (Э7)', () => {
  let projectRoot: string;
  let configRoot: string;
  const SCOPE = (): string => buildScopeKey('cf', configRoot);

  function write(rel: string, content: string | Buffer): void {
    const abs = path.join(configRoot, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const sha1 = (data: string | Buffer): string => createHash('sha1').update(data).digest('hex');

  setup(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-sync-manifest-'));
    configRoot = path.join(projectRoot, 'src', 'cf');
    write('Configuration.xml', '<Configuration/>');
    write('Catalogs/Товары.xml', '<Catalog/>');
    write('Catalogs/Товары/Ext/ObjectModule.bsl', 'Процедура А() КонецПроцедуры');
    write('ConfigDumpInfo.xml', '<ConfigDumpInfo/>');
    write('CommonPictures/Лого/Ext/Picture/Picture.png', Buffer.from([1, 2, 3]));
  });
  teardown(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

  suite('buildSyncManifestFiles', () => {
    test('sha1 содержимого по POSIX-путям; ConfigDumpInfo.xml не отслеживается', () => {
      const files = buildSyncManifestFiles(configRoot);
      assert.strictEqual(files['Configuration.xml'], sha1('<Configuration/>'));
      assert.strictEqual(files['Catalogs/Товары/Ext/ObjectModule.bsl'], sha1('Процедура А() КонецПроцедуры'));
      assert.ok(!('ConfigDumpInfo.xml' in files));
      assert.ok(Object.keys(files).every((rel) => !rel.includes('\\')));
    });

    test('набор и хэши совпадают с HashCache (единый критерий «отслеживаемого файла»)', () => {
      assert.deepStrictEqual(buildSyncManifestFiles(configRoot), buildHashSnapshot(SCOPE(), configRoot).files);
    });

    test('каталога нет → пустой манифест, без исключения', () => {
      assert.deepStrictEqual(buildSyncManifestFiles(path.join(projectRoot, 'нет')), {});
    });
  });

  suite('resolveSyncManifestPath / saveSyncManifest / loadSyncManifest', () => {
    test('путь: <проект>/.v8vscedit/agent-sync/<sha1(scopeKey)>.json', () => {
      assert.strictEqual(
        resolveSyncManifestPath(projectRoot, SCOPE()),
        path.join(projectRoot, '.v8vscedit', 'agent-sync', `${sha1(SCOPE())}.json`)
      );
    });

    test('сохранение создаёт каталоги, round-trip возвращает то же; временных файлов не остаётся', () => {
      const manifest: SyncManifest = {
        schemaVersion: 1,
        scopeKey: SCOPE(),
        mirrorState: 'stale',
        files: { 'Catalogs/Товары.xml': 'aa', 'Configuration.xml': 'bb' },
      };
      saveSyncManifest(projectRoot, manifest);
      assert.deepStrictEqual(loadSyncManifest(projectRoot, SCOPE()), manifest);
      const dir = path.dirname(resolveSyncManifestPath(projectRoot, SCOPE()));
      assert.deepStrictEqual(fs.readdirSync(dir), [path.basename(resolveSyncManifestPath(projectRoot, SCOPE()))]);
    });

    test('повторное сохранение подменяет файл целиком; три состояния M сохраняются', () => {
      for (const mirrorState of ['empty', 'stale', 'fresh'] as const) {
        saveSyncManifest(projectRoot, { schemaVersion: 1, scopeKey: SCOPE(), mirrorState, files: { a: mirrorState } });
        const loaded = loadSyncManifest(projectRoot, SCOPE());
        assert.strictEqual(loaded.mirrorState, mirrorState);
        assert.deepStrictEqual(loaded.files, { a: mirrorState });
      }
    });

    test('цели разделены: cf и cfe/<имя> лежат в разных файлах', () => {
      const cfe = buildScopeKey('cfe', configRoot, 'Расш');
      saveSyncManifest(projectRoot, { schemaVersion: 1, scopeKey: SCOPE(), mirrorState: 'fresh', files: { a: '1' } });
      saveSyncManifest(projectRoot, { schemaVersion: 1, scopeKey: cfe, mirrorState: 'stale', files: { b: '2' } });
      assert.deepStrictEqual(loadSyncManifest(projectRoot, SCOPE()).files, { a: '1' });
      assert.deepStrictEqual(loadSyncManifest(projectRoot, cfe).files, { b: '2' });
      assert.notStrictEqual(resolveSyncManifestPath(projectRoot, SCOPE()), resolveSyncManifestPath(projectRoot, cfe));
    });

    test('ни манифеста, ни HashCache → пустой: M empty, B пуст', () => {
      assert.deepStrictEqual(loadSyncManifest(projectRoot, SCOPE()), {
        schemaVersion: 1,
        scopeKey: SCOPE(),
        mirrorState: 'empty',
        files: {},
      });
    });

    test('манифеста нет, есть HashCache → B берётся из него (миграция), M empty', () => {
      const snapshot = buildHashSnapshot(SCOPE(), configRoot);
      saveHashCache(projectRoot, snapshot);
      const loaded = loadSyncManifest(projectRoot, SCOPE());
      assert.strictEqual(loaded.mirrorState, 'empty');
      assert.deepStrictEqual(loaded.files, snapshot.files);
    });

    test('манифест приоритетнее HashCache', () => {
      saveHashCache(projectRoot, buildHashSnapshot(SCOPE(), configRoot));
      saveSyncManifest(projectRoot, { schemaVersion: 1, scopeKey: SCOPE(), mirrorState: 'fresh', files: { only: 'x' } });
      assert.deepStrictEqual(loadSyncManifest(projectRoot, SCOPE()).files, { only: 'x' });
    });

    test('битый JSON, чужой scopeKey, другая схема, не-объект files → как «манифеста нет» (фолбэк на HashCache)', () => {
      const snapshot = buildHashSnapshot(SCOPE(), configRoot);
      saveHashCache(projectRoot, snapshot);
      const file = resolveSyncManifestPath(projectRoot, SCOPE());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const broken: (string | object)[] = [
        '{ не json',
        '[]',
        'null',
        { schemaVersion: 1, scopeKey: 'другой', mirrorState: 'fresh', files: { a: '1' } },
        { schemaVersion: 99, scopeKey: SCOPE(), mirrorState: 'fresh', files: { a: '1' } },
        { schemaVersion: 1, scopeKey: SCOPE(), mirrorState: 'fresh', files: 'нет' },
        { schemaVersion: 1, scopeKey: SCOPE(), mirrorState: 'неизвестно', files: { a: '1' } },
      ];
      for (const content of broken) {
        fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
        const loaded = loadSyncManifest(projectRoot, SCOPE());
        assert.strictEqual(loaded.mirrorState, 'empty', JSON.stringify(content));
        assert.deepStrictEqual(loaded.files, snapshot.files, JSON.stringify(content));
      }
    });
  });

  suite('diffSyncFiles', () => {
    test('added / modified / deleted, отсортированы', () => {
      const base = { 'b.xml': '1', 'a.xml': '1', 'gone.xml': '1', 'same.xml': '1' };
      const current = { 'b.xml': '2', 'a.xml': '2', 'new2.xml': '1', 'new1.xml': '1', 'same.xml': '1' };
      assert.deepStrictEqual(diffSyncFiles(base, current), {
        added: ['new1.xml', 'new2.xml'],
        modified: ['a.xml', 'b.xml'],
        deleted: ['gone.xml'],
      });
    });

    test('одинаковые и пустые наборы — без различий', () => {
      assert.deepStrictEqual(diffSyncFiles({}, {}), { added: [], modified: [], deleted: [] });
      assert.deepStrictEqual(diffSyncFiles({ a: '1' }, { a: '1' }), { added: [], modified: [], deleted: [] });
    });

    test('пустая база — всё добавлено; пустое текущее — всё удалено', () => {
      assert.deepStrictEqual(diffSyncFiles({}, { a: '1' }).added, ['a']);
      assert.deepStrictEqual(diffSyncFiles({ a: '1' }, {}).deleted, ['a']);
    });
  });
});
