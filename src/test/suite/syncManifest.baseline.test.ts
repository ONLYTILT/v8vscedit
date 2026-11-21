import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanHashSnapshot } from '../../infra/cache/HashScanner';
import {
  buildSyncBaselineAfterImport,
  diffSyncFiles,
  type SyncBaselineFullReason,
  type SyncBaselineResult,
} from '../../infra/agent/sync/SyncManifest';
import { countingFs, futureNow, writeRel } from './support/hashScanFixtures';
import { removeTreeSync } from './support/tempTree';

/**
 * Базовая линия B после импорта (`buildSyncBaselineAfterImport`): снимок P, снятый ТОЙ ЖЕ операцией до
 * записи, плюс перехеширование записанных/удалённых путей. Инвариант: B байт в байт равна полному проходу
 * по тем же файлам. Единственное осознанное расхождение — правка пользователя ВО ВРЕМЯ операции в
 * нетронутом файле: полный проход поглотил бы её в B, инкрементальная B оставляет хеш снимка (правка
 * остаётся видимой как изменение). Регистр путей, чужой путь и отсутствие снимка — полный проход.
 */
suite('SyncManifest: buildSyncBaselineAfterImport', function () {
  this.timeout(30_000);
  let projectRoot: string;
  let configDir: string;

  const INITIAL: Record<string, string> = {
    'Configuration.xml': '<Configuration/>',
    'Catalogs/Товары.xml': '<Catalog>Товары</Catalog>',
    'Catalogs/Товары/Ext/ObjectModule.bsl': 'Процедура Товары() КонецПроцедуры',
    'Documents/Заказ.xml': '<Document>Заказ</Document>',
    'Documents/Заказ/Ext/ObjectModule.bsl': 'Процедура Заказ() КонецПроцедуры',
    'Roles/Админ.xml': '<Role>Админ</Role>',
    'Roles/Админ/Ext/Rights.xml': '<Rights/>',
    'CommonModules/Общий/Ext/Module.bsl': 'Процедура Общий() КонецПроцедуры',
  };
  const TRACKED_COUNT = Object.keys(INITIAL).length;

  setup(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-sync-baseline-'));
    configDir = path.join(projectRoot, 'src', 'cf');
    for (const [rel, content] of Object.entries(INITIAL)) {
      writeRel(configDir, rel, content);
    }
  });
  teardown(() => { removeTreeSync(projectRoot); });

  const abs = (rel: string): string => path.join(configDir, ...rel.split('/'));
  const fullScan = async (): Promise<Record<string, string>> => (await scanHashSnapshot(undefined, '', configDir)).files;
  const snapshotP0 = fullScan;

  function baseline(
    projectSnapshot: Record<string, string> | undefined,
    rels: readonly string[],
    extra: Partial<Parameters<typeof buildSyncBaselineAfterImport>[0]> = {}
  ): Promise<SyncBaselineResult> {
    return buildSyncBaselineAfterImport({
      configDir,
      projectRoot,
      projectSnapshot,
      changedFiles: rels.map(abs),
      scan: { now: futureNow },
      ...extra,
    });
  }

  function assertFull(result: SyncBaselineResult, reason: SyncBaselineFullReason): void {
    assert.ok(result.mode.kind === 'full', `ожидался полный проход, получено ${result.mode.kind}`);
    assert.strictEqual(result.mode.reason, reason);
  }

  test('B1 эквивалентность: 2 изменены, 1 удалён, 1 добавлен + 1 неотслеживаемый → B равна полному проходу; точные счётчики и обращения к ФС', async () => {
    const p0 = await snapshotP0();
    writeRel(configDir, 'Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
    writeRel(configDir, 'Documents/Заказ.xml', '<Document>Заказ v2</Document>');
    fs.unlinkSync(abs('Roles/Админ.xml'));
    writeRel(configDir, 'Catalogs/Новый.xml', '<Catalog>Новый</Catalog>');
    writeRel(configDir, 'Catalogs/заметка.txt', 'не отслеживается');
    const changed = ['Catalogs/Товары.xml', 'Documents/Заказ.xml', 'Roles/Админ.xml', 'Catalogs/Новый.xml', 'Catalogs/заметка.txt'];
    const incremental = countingFs();
    const reference = countingFs();

    const result = await baseline(p0, changed, { scan: { fs: incremental, now: futureNow } });
    const expected = (await scanHashSnapshot(undefined, '', configDir, { fs: reference })).files;

    assert.deepStrictEqual(result.files, expected);
    assert.deepStrictEqual(result.mode, { kind: 'incremental', rehashed: 3, removed: 1 });
    assert.strictEqual(incremental.counts.readFile, 3, 'читаются только изменённые существующие');
    // stat — только у трёх перехешируемых файлов (размер для выбора буфер/поток), мемо не участвует.
    assert.strictEqual(incremental.counts.stat, 3);
    assert.ok(incremental.counts.readdir < reference.counts.readdir, `readdir ${String(incremental.counts.readdir)} < ${String(reference.counts.readdir)}`);
  });

  test('B1б пустой список изменений: копия снимка, rehashed 0, ФС не читается', async () => {
    const p0 = await snapshotP0();
    const counting = countingFs();

    const result = await baseline(p0, [], { scan: { fs: counting, now: futureNow } });

    assert.deepStrictEqual(result.files, p0);
    assert.deepStrictEqual(result.mode, { kind: 'incremental', rehashed: 0, removed: 0 });
    assert.strictEqual(counting.counts.readFile, 0);
  });

  test('B2 грязный нетронутый файл (правка ДО снимка, вне changed): хеш из снимка, B равна полному проходу', async () => {
    writeRel(configDir, 'Roles/Админ/Ext/Rights.xml', '<Rights>ручная правка</Rights>');
    const p0 = await snapshotP0();
    writeRel(configDir, 'Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');

    const result = await baseline(p0, ['Catalogs/Товары.xml']);

    assert.deepStrictEqual(result.files, await fullScan());
    assert.strictEqual(result.files['Roles/Админ/Ext/Rights.xml'], p0['Roles/Админ/Ext/Rights.xml']);
    assert.strictEqual(result.mode.kind, 'incremental');
  });

  test('B3 правка во время операции (после снимка, вне changed): в B хеш СНИМКА — правка видна как изменение, в отличие от полного прохода', async () => {
    const p0 = await snapshotP0();
    writeRel(configDir, 'Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
    writeRel(configDir, 'Roles/Админ/Ext/Rights.xml', '<Rights>правка пользователя во время импорта</Rights>');

    const result = await baseline(p0, ['Catalogs/Товары.xml']);
    const scan = await fullScan();

    assert.strictEqual(result.files['Roles/Админ/Ext/Rights.xml'], p0['Roles/Админ/Ext/Rights.xml']);
    assert.notStrictEqual(result.files['Roles/Админ/Ext/Rights.xml'], scan['Roles/Админ/Ext/Rights.xml']);
    assert.deepStrictEqual(diffSyncFiles(result.files, scan).modified, ['Roles/Админ/Ext/Rights.xml']);
  });

  test('B4 удалённый путь из changed — ключ убран (removed 1); путь, которого нет ни в снимке, ни на диске, — ключа нет', async () => {
    const p0 = await snapshotP0();
    fs.unlinkSync(abs('Roles/Админ.xml'));

    const removedOne = await baseline(p0, ['Roles/Админ.xml']);
    assert.ok(!('Roles/Админ.xml' in removedOne.files));
    assert.deepStrictEqual(removedOne.files, await fullScan());
    assert.deepStrictEqual(removedOne.mode, { kind: 'incremental', rehashed: 0, removed: 1 });

    const phantom = await baseline(p0, ['Catalogs/Призрак.xml']);
    assert.ok(!('Catalogs/Призрак.xml' in phantom.files));
    assert.deepStrictEqual(phantom.files, p0);
    assert.strictEqual(phantom.mode.kind, 'incremental');
  });

  test('B5 путь вне configDir (.. и другой корень) → полный проход foreign-path, результат равен полному проходу, report проброшен', async () => {
    const p0 = await snapshotP0();
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-sync-baseline-other-'));
    try {
      for (const foreign of [path.resolve(configDir, '..', 'x.xml'), path.join(otherRoot, 'y.xml')]) {
        const result = await buildSyncBaselineAfterImport({
          configDir,
          projectRoot,
          projectSnapshot: p0,
          changedFiles: [abs('Configuration.xml'), foreign],
          scan: { now: futureNow },
        });

        assertFull(result, 'foreign-path');
        assert.deepStrictEqual(result.files, await fullScan());
        if (result.mode.kind === 'full') {
          assert.strictEqual(result.mode.report.files, TRACKED_COUNT);
        }
      }
    } finally {
      removeTreeSync(otherRoot);
    }
  });

  const noSnapshotCases: readonly (readonly ['compare' | 'archive' | undefined, SyncBaselineFullReason])[] = [
    [undefined, 'no-project-snapshot'],
    ['compare', 'compare'],
    ['archive', 'archive'],
  ];
  for (const [fullReason, expectedReason] of noSnapshotCases) {
    test(`B6 без снимка проекта, fullReason=${String(fullReason)} → полный проход с причиной ${expectedReason}; report: files/hashed/racy`, async () => {
      const result = await baseline(undefined, ['Configuration.xml'], { fullReason });

      assertFull(result, expectedReason);
      assert.deepStrictEqual(result.files, await fullScan());
      if (result.mode.kind === 'full') {
        assert.strictEqual(result.mode.report.files, TRACKED_COUNT);
        assert.strictEqual(result.mode.report.hashed, TRACKED_COUNT);
        assert.strictEqual(result.mode.report.racy, 0);
      }
    });
  }

  for (const fullReason of ['compare', 'archive'] as const) {
    test(`B6б снимок есть, но fullReason=${fullReason} → всё равно полный проход с этой причиной (снимок не побеждает молча)`, async () => {
      const p0 = await snapshotP0();
      writeRel(configDir, 'Roles/Админ/Ext/Rights.xml', '<Rights>переписано стратегией мимо changed</Rights>');

      const result = await baseline(p0, [], { fullReason });

      assertFull(result, fullReason);
      assert.deepStrictEqual(result.files, await fullScan());
    });
  }

  test('B7 регистр: ключ снимка Foo/A.xml, изменён Foo/a.xml (переименование регистром) → full case-mismatch, B равна полному проходу', async () => {
    writeRel(configDir, 'Foo/A.xml', '<A/>');
    const p0 = await snapshotP0();
    fs.unlinkSync(abs('Foo/A.xml'));
    writeRel(configDir, 'Foo/a.xml', '<A/>');

    const result = await baseline(p0, ['Foo/a.xml']);

    assertFull(result, 'case-mismatch');
    assert.deepStrictEqual(result.files, await fullScan());
    assert.ok('Foo/a.xml' in result.files && !('Foo/A.xml' in result.files));
  });

  test('B7б регистр сегмента-каталога: ключ снимка Foo/x.xml, изменён foo/x.xml → full case-mismatch', async () => {
    writeRel(configDir, 'Foo/x.xml', '<x/>');
    const p0 = await snapshotP0();
    fs.renameSync(abs('Foo'), abs('Foo-tmp'));
    fs.renameSync(abs('Foo-tmp'), abs('foo'));

    const result = await baseline(p0, ['foo/x.xml']);

    assertFull(result, 'case-mismatch');
    assert.deepStrictEqual(result.files, await fullScan());
  });

  test('B7в регистр на диске (hashTrackedFiles.caseMismatch): запрошен Foo/A.xml, на диске Foo/a.xml, в снимке такого ключа нет → full case-mismatch', async () => {
    const p0 = await snapshotP0();
    writeRel(configDir, 'Foo/a.xml', '<a/>');

    const result = await baseline(p0, ['Foo/A.xml']);

    assertFull(result, 'case-mismatch');
    assert.deepStrictEqual(result.files, await fullScan());
  });

  test('B8 ConfigDumpInfo.xml в changed игнорируется: режим инкрементальный, файл не читается, ключа нет', async () => {
    const p0 = await snapshotP0();
    writeRel(configDir, 'ConfigDumpInfo.xml', '<ConfigDumpInfo/>');
    writeRel(configDir, 'Configuration.xml', '<Configuration v="2"/>');
    const counting = countingFs();

    const result = await baseline(p0, ['ConfigDumpInfo.xml', 'Configuration.xml'], { scan: { fs: counting, now: futureNow } });

    assert.deepStrictEqual(result.mode, { kind: 'incremental', rehashed: 1, removed: 0 });
    assert.ok(!('ConfigDumpInfo.xml' in result.files));
    assert.deepStrictEqual(counting.readPaths.map((file) => path.basename(file)), ['Configuration.xml']);
    assert.deepStrictEqual(result.files, await fullScan());
  });

  test('B9 elapsedMs считается по внедрённым часам (100 → 142 ⇒ 42) в обоих режимах', async () => {
    const p0 = await snapshotP0();
    const makeClock = (): (() => number) => {
      let calls = 0;
      return () => { calls += 1; return calls === 1 ? 100 : 142; };
    };

    const incremental = await baseline(p0, ['Configuration.xml'], { clock: makeClock() });
    const full = await baseline(undefined, [], { clock: makeClock() });

    assert.strictEqual(incremental.mode.kind, 'incremental');
    assert.strictEqual(incremental.elapsedMs, 42);
    assert.strictEqual(full.mode.kind, 'full');
    assert.strictEqual(full.elapsedMs, 42);
  });

  test('B10 снимок проекта не мутируется: возвращается новый объект', async () => {
    const p0 = await snapshotP0();
    const copy = JSON.parse(JSON.stringify(p0)) as Record<string, string>;
    writeRel(configDir, 'Catalogs/Товары.xml', '<Catalog>v2</Catalog>');
    writeRel(configDir, 'Catalogs/Новый.xml', '<Catalog/>');
    fs.unlinkSync(abs('Roles/Админ.xml'));

    const result = await baseline(p0, ['Catalogs/Товары.xml', 'Catalogs/Новый.xml', 'Roles/Админ.xml']);

    assert.deepStrictEqual(p0, copy);
    assert.notStrictEqual(result.files, p0);
    assert.notDeepStrictEqual(result.files, p0);
  });
});
