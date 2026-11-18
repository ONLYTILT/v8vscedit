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
  mirrorCoverageOf,
  resolveSyncManifestPath,
  saveSyncManifest,
  type SyncManifest,
} from '../../infra/agent/sync/SyncManifest';
import { resolveHashStatMemoPath } from '../../infra/cache/HashStatMemo';
import { countingFs, futureNow } from './support/hashScanFixtures';

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
    test('sha1 содержимого по POSIX-путям; ConfigDumpInfo.xml не отслеживается', async () => {
      const files = await buildSyncManifestFiles(configRoot);
      assert.strictEqual(files['Configuration.xml'], sha1('<Configuration/>'));
      assert.strictEqual(files['Catalogs/Товары/Ext/ObjectModule.bsl'], sha1('Процедура А() КонецПроцедуры'));
      assert.ok(!('ConfigDumpInfo.xml' in files));
      assert.ok(Object.keys(files).every((rel) => !rel.includes('\\')));
    });

    test('набор и хэши совпадают с HashCache (единый критерий «отслеживаемого файла»)', async () => {
      assert.deepStrictEqual(await buildSyncManifestFiles(configRoot), buildHashSnapshot(SCOPE(), configRoot).files);
    });

    test('каталога нет → пустой манифест, без исключения', async () => {
      assert.deepStrictEqual(await buildSyncManifestFiles(path.join(projectRoot, 'нет')), {});
    });

    test('без projectRoot мемо не пишется; с projectRoot второй вызов не читает файлы (быстрая проверка)', async () => {
      const counting = countingFs();
      await buildSyncManifestFiles(configRoot, undefined, { fs: counting, now: futureNow });
      assert.ok(!fs.existsSync(path.join(projectRoot, '.v8vscedit')));

      counting.reset();
      const first = await buildSyncManifestFiles(configRoot, projectRoot, { fs: counting, now: futureNow });
      assert.strictEqual(counting.counts.readFile, 3, 'первый вызов хеширует все 3 отслеживаемых файла');
      counting.reset();
      const second = await buildSyncManifestFiles(configRoot, projectRoot, { fs: counting, now: futureNow });
      assert.strictEqual(counting.counts.readFile, 0);
      assert.deepStrictEqual(second, first);
      assert.deepStrictEqual(second, buildHashSnapshot(SCOPE(), configRoot).files);
    });

    test('мемо и базовая линия сосуществуют: B берётся из базовой линии, buildSyncManifestFiles её не меняет (байты)', async () => {
      const snapshot = { ...buildHashSnapshot(SCOPE(), configRoot), files: { 'Catalogs/Товары.xml': 'из-базовой-линии' } };
      saveHashCache(projectRoot, snapshot);
      const baselineFile = path.join(projectRoot, '.v8vscedit', 'cache', `${sha1(SCOPE())}.json`);
      const bytes = fs.readFileSync(baselineFile);
      await buildSyncManifestFiles(configRoot, projectRoot, { now: futureNow });
      assert.ok(fs.existsSync(resolveHashStatMemoPath(projectRoot, configRoot)), 'мемо записан');
      assert.deepStrictEqual(fs.readFileSync(baselineFile), bytes, 'базовая линия не тронута');
      assert.deepStrictEqual(loadSyncManifest(projectRoot, SCOPE()).files, snapshot.files);
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

/**
 * Полнота зеркала M в манифесте (`mirrorCoverage`): ось, ортогональная `empty | stale | fresh`. Поле
 * необязательное — манифесты, записанные до его появления, описывали только полный M, поэтому отсутствие
 * значит `full`; значение вне множества `full | sparse` делает манифест непригодным (как неверный
 * `mirrorState`): откат к HashCache и `empty`.
 */
suite('SyncManifest: mirrorCoverage', () => {
  let projectRoot: string;
  let configRoot: string;
  const scope = (): string => buildScopeKey('cf', configRoot);

  setup(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-sync-coverage-'));
    configRoot = path.join(projectRoot, 'src', 'cf');
    fs.mkdirSync(configRoot, { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'Configuration.xml'), '<Configuration/>');
  });
  teardown(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

  function writeRaw(value: Record<string, unknown>): void {
    const file = resolveSyncManifestPath(projectRoot, scope());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, scopeKey: scope(), mirrorState: 'fresh', files: { 'a.xml': 'h' }, ...value }));
  }

  for (const coverage of ['full', 'sparse'] as const) {
    test(`round-trip: ${coverage} сохраняется и читается; поле лежит в файле манифеста`, () => {
      const manifest: SyncManifest = { schemaVersion: 1, scopeKey: scope(), mirrorState: 'fresh', files: { 'a.xml': 'h' }, mirrorCoverage: coverage };
      saveSyncManifest(projectRoot, manifest);
      const loaded = loadSyncManifest(projectRoot, scope());
      assert.strictEqual(loaded.mirrorCoverage, coverage);
      assert.strictEqual(mirrorCoverageOf(loaded), coverage);
      assert.strictEqual(loaded.mirrorState, 'fresh');
      const raw = JSON.parse(fs.readFileSync(resolveSyncManifestPath(projectRoot, scope()), 'utf-8')) as Record<string, unknown>;
      assert.strictEqual(raw.mirrorCoverage, coverage);
    });
  }

  test('поле отсутствует (манифест прежней версии) → full; остальное читается как раньше', () => {
    writeRaw({});
    const loaded = loadSyncManifest(projectRoot, scope());
    assert.strictEqual(mirrorCoverageOf(loaded), 'full');
    assert.strictEqual(loaded.mirrorState, 'fresh');
    assert.deepStrictEqual(loaded.files, { 'a.xml': 'h' });
  });

  test('манифест, которого нет вовсе (миграция с HashCache): полнота full, M empty', () => {
    const loaded = loadSyncManifest(projectRoot, scope());
    assert.strictEqual(loaded.mirrorState, 'empty');
    assert.strictEqual(mirrorCoverageOf(loaded), 'full');
  });

  for (const bad of ['partial', 'FULL', '', 42, true, [], {}]) {
    test(`значение вне множества (${JSON.stringify(bad)}) → манифест отвергнут: откат к HashCache, M empty, файлы из кэша хэшей`, () => {
      writeRaw({ mirrorCoverage: bad });
      saveHashCache(projectRoot, {
        schemaVersion: 1,
        scopeKey: scope(),
        generatedAt: new Date(0).toISOString(),
        files: { 'cache.xml': 'c' },
      });
      const loaded = loadSyncManifest(projectRoot, scope());
      assert.strictEqual(loaded.mirrorState, 'empty');
      assert.deepStrictEqual(loaded.files, { 'cache.xml': 'c' });
      assert.strictEqual(mirrorCoverageOf(loaded), 'full');
    });
  }
});

/**
 * Отпечаток `ConfigDumpInfo.xml` проекта в манифесте (plan-archive-avoid.md §3.7): по нему импорт узнаёт,
 * что выгрузку проекта заменили извне. Отсутствие признака безопасно (нет ложного срабатывания), поэтому
 * битое поле ОТБРАСЫВАЕТСЯ, а манифест принимается — в отличие от неизвестной полноты M (там отвергается
 * весь манифест).
 */
suite('SyncManifest: projectDumpInfo', () => {
  let projectRoot: string;
  let configRoot: string;
  const scope = (): string => buildScopeKey('cf', configRoot);
  const fingerprint = { sha1: 'a'.repeat(40), size: 33_000_000, mtimeMs: 1_700_000_000_123 };

  setup(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-sync-dumpinfo-'));
    configRoot = path.join(projectRoot, 'src', 'cf');
    fs.mkdirSync(configRoot, { recursive: true });
  });
  teardown(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

  function writeRaw(value: Record<string, unknown>): void {
    const file = resolveSyncManifestPath(projectRoot, scope());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, scopeKey: scope(), mirrorState: 'fresh', files: { 'a.xml': 'h' }, mirrorCoverage: 'sparse', ...value }));
  }

  test('round-trip: отпечаток сохраняется и читается как есть; поле лежит в файле манифеста', () => {
    saveSyncManifest(projectRoot, {
      schemaVersion: 1, scopeKey: scope(), mirrorState: 'fresh', files: { 'a.xml': 'h' }, projectDumpInfo: fingerprint,
    });
    assert.deepStrictEqual(loadSyncManifest(projectRoot, scope()).projectDumpInfo, fingerprint);
    const raw = JSON.parse(fs.readFileSync(resolveSyncManifestPath(projectRoot, scope()), 'utf-8')) as Record<string, unknown>;
    assert.deepStrictEqual(raw.projectDumpInfo, fingerprint);
  });

  test('поле отсутствует (манифест прежней версии) → undefined; остальное читается как раньше', () => {
    writeRaw({});
    const loaded = loadSyncManifest(projectRoot, scope());
    assert.strictEqual(loaded.projectDumpInfo, undefined);
    assert.strictEqual(loaded.mirrorState, 'fresh');
    assert.strictEqual(loaded.mirrorCoverage, 'sparse');
    assert.deepStrictEqual(loaded.files, { 'a.xml': 'h' });
  });

  const broken: [string, unknown][] = [
    ['строка вместо объекта', 'sha'],
    ['null', null],
    ['массив', []],
    ['нет sha1', { size: 1, mtimeMs: 2 }],
    ['sha1 не строка', { sha1: 5, size: 1, mtimeMs: 2 }],
    ['size строкой', { sha1: 'abc', size: '1', mtimeMs: 2 }],
    ['нет size', { sha1: 'abc', mtimeMs: 2 }],
    ['mtimeMs строкой', { sha1: 'abc', size: 1, mtimeMs: '2' }],
    ['нет mtimeMs', { sha1: 'abc', size: 1 }],
    ['size NaN (в JSON — null)', { sha1: 'abc', size: Number.NaN, mtimeMs: 2 }],
  ];
  for (const [label, value] of broken) {
    test(`битое поле (${label}) → поле отброшено, манифест ПРИНЯТ (полнота и состояние M сохранены)`, () => {
      writeRaw({ projectDumpInfo: value });
      const loaded = loadSyncManifest(projectRoot, scope());
      assert.strictEqual(loaded.projectDumpInfo, undefined);
      assert.strictEqual(loaded.mirrorState, 'fresh', 'манифест не отвергнут');
      assert.strictEqual(loaded.mirrorCoverage, 'sparse');
      assert.deepStrictEqual(loaded.files, { 'a.xml': 'h' });
    });
  }
});
