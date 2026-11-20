import * as assert from 'assert';
import type { DumpChangedObject } from '../../domain/agent/DumpChangesParser';
import { META_TYPES } from '../../domain/MetaTypes';
import {
  PARENT_CONFIGURATIONS_BIN_REL,
  PARENT_CONFIGURATIONS_DIR_REL,
  PARENT_CONFIGURATIONS_PART,
} from '../../infra/support/SupportFiles';
import {
  VENDOR_CONFIGURATION_GATE_ENABLED,
  decideVendorDownload,
  evidenceFromChangeObjects,
  evidenceFromDumpInfoNames,
  isVendorConfigurationFile,
  type RootPartEvidence,
  type VendorDownloadInput,
} from '../../infra/agent/sync/VendorConfigurationGate';

/**
 * Шлюз конфигурации поставщика (plan-large-files.md §1, ФАКТ Э27): файлы `Ext/ParentConfigurations/**`
 * (до гигабайта) скачиваются только при ДОКАЗАННОМ изменении части. `Ext/ParentConfigurations.bin` не шлюзуется —
 * идёт по обычным правилам и служит страховкой: изменился `.bin` — качаем `.cf`. Любая неопределённость — скачивание.
 */

function line(change: 'added' | 'modified', fullName: string): DumpChangedObject {
  const [kind, name, ...parts] = fullName.split('.');
  return { change, fullName, kind, name, parts };
}

const ROOT = 'Configuration.Конфигурация';

function parts(evidence: RootPartEvidence): string[] {
  if (evidence.kind === 'unknown') {
    assert.fail(`ожидалось known, получено unknown: ${evidence.reason}`);
  }
  return [...evidence.changedParts].sort();
}

suite('VendorConfigurationGate: константы путей', () => {
  test('значения совпадают с раскладкой выгрузки платформы', () => {
    assert.strictEqual(PARENT_CONFIGURATIONS_PART, 'ParentConfigurations');
    assert.strictEqual(PARENT_CONFIGURATIONS_BIN_REL, 'Ext/ParentConfigurations.bin');
    assert.strictEqual(PARENT_CONFIGURATIONS_DIR_REL, 'Ext/ParentConfigurations');
  });

  test('шлюз включён по умолчанию (решение оркестратора по ФАКТУ Э27)', () => {
    assert.strictEqual(VENDOR_CONFIGURATION_GATE_ENABLED, true);
  });
});

suite('VendorConfigurationGate: evidenceFromChangeObjects', () => {
  test('только `Modified: Configuration.X` — известно, частей нет', () => {
    assert.deepStrictEqual(parts(evidenceFromChangeObjects([line('modified', ROOT)])), []);
  });

  test('строки корня нет вовсе — известно, частей нет', () => {
    assert.deepStrictEqual(parts(evidenceFromChangeObjects([])), []);
  });

  test('часть корня попадает в набор: ManagedApplicationModule', () => {
    const evidence = evidenceFromChangeObjects([line('modified', `${ROOT}.ManagedApplicationModule`), line('modified', ROOT)]);
    assert.deepStrictEqual(parts(evidence), ['ManagedApplicationModule']);
  });

  test('часть ParentConfigurations — в наборе', () => {
    const evidence = evidenceFromChangeObjects([line('modified', `${ROOT}.ParentConfigurations`), line('modified', ROOT)]);
    assert.ok(evidence.kind === 'known' && evidence.changedParts.has(PARENT_CONFIGURATIONS_PART));
  });

  test('ФАКТ Э27: `New: Configuration.X.SessionModule` + `Modified: Configuration.X` — известно, часть SessionModule', () => {
    const evidence = evidenceFromChangeObjects([line('added', `${ROOT}.SessionModule`), line('modified', ROOT)]);
    assert.deepStrictEqual(parts(evidence), ['SessionModule']);
  });

  test('`New: Configuration.X.ParentConfigurations` без строки корня — известно, часть в наборе', () => {
    assert.deepStrictEqual(parts(evidenceFromChangeObjects([line('added', `${ROOT}.ParentConfigurations`)])), ['ParentConfigurations']);
  });

  test('`New: Configuration.X` — корень выгружается целиком: неизвестно, причина непустая', () => {
    const evidence = evidenceFromChangeObjects([line('added', ROOT)]);
    assert.strictEqual(evidence.kind, 'unknown');
    assert.ok(evidence.reason.length > 0);
  });

  test('`New: Configuration.X` побеждает строку части: неизвестно, даже если ParentConfigurations в списке', () => {
    const evidence = evidenceFromChangeObjects([line('added', `${ROOT}.ParentConfigurations`), line('added', ROOT)]);
    assert.strictEqual(evidence.kind, 'unknown');
  });

  test('строки других видов на доказательство не влияют', () => {
    const evidence = evidenceFromChangeObjects([
      line('modified', 'Catalog.Товары.Form.Форма'),
      line('added', 'Document.Заказ'),
      line('modified', `${ROOT}.CommandInterface`),
    ]);
    assert.deepStrictEqual(parts(evidence), ['CommandInterface']);
  });

  test('`Modified` у части с вложенными сегментами — берётся первый сегмент после имени', () => {
    assert.deepStrictEqual(parts(evidenceFromChangeObjects([line('modified', `${ROOT}.Form.Главная`)])), ['Form']);
  });

  test('вид корня берётся из META_TYPES, а не из литерала', () => {
    const kind = META_TYPES.configuration.englishKind ?? META_TYPES.configuration.kind;
    const evidence = evidenceFromChangeObjects([line('added', `${kind}.Имя`)]);
    assert.strictEqual(evidence.kind, 'unknown');
  });
});

suite('VendorConfigurationGate: evidenceFromDumpInfoNames', () => {
  test('modified `Configuration.X.ParentConfigurations` — часть в наборе', () => {
    const evidence = evidenceFromDumpInfoNames({ added: [], modified: [`${ROOT}.ParentConfigurations`] });
    assert.deepStrictEqual(parts(evidence), ['ParentConfigurations']);
  });

  test('added `Configuration.X.ParentConfigurations` — часть в наборе', () => {
    const evidence = evidenceFromDumpInfoNames({ added: [`${ROOT}.ParentConfigurations`], modified: [] });
    assert.deepStrictEqual(parts(evidence), ['ParentConfigurations']);
  });

  test('запись самого корня в modified — это норма (версия владельца растёт вместе с частью): известно, частей нет', () => {
    assert.deepStrictEqual(parts(evidenceFromDumpInfoNames({ added: [], modified: [ROOT] })), []);
  });

  test('запись самого корня в added — корня не было в сравниваемом файле версий: неизвестно', () => {
    const evidence = evidenceFromDumpInfoNames({ added: [ROOT], modified: [] });
    assert.strictEqual(evidence.kind, 'unknown');
    assert.ok(evidence.reason.length > 0);
  });

  test('записи других владельцев не влияют', () => {
    const evidence = evidenceFromDumpInfoNames({
      added: ['Catalog.Товары', 'Catalog.Товары.Form.Форма'],
      modified: ['Document.Заказ.ObjectModule', `${ROOT}.HomePageWorkArea`],
    });
    assert.deepStrictEqual(parts(evidence), ['HomePageWorkArea']);
  });

  test('пустые списки — известно, частей нет', () => {
    assert.deepStrictEqual(parts(evidenceFromDumpInfoNames({ added: [], modified: [] })), []);
  });
});

suite('VendorConfigurationGate: isVendorConfigurationFile', () => {
  const CASES: readonly (readonly [string, boolean, string])[] = [
    ['Ext/ParentConfigurations/Поставщик.cf', true, 'файл поставщика'],
    ['Ext/ParentConfigurations/sub/b.cf', true, 'вложенный файл поставщика'],
    ['Ext/ParentConfigurations.bin', false, 'страхующий .bin не шлюзуется'],
    ['Ext/ParentConfigurationsX/a.cf', false, 'соседний каталог с общим префиксом имени'],
    ['Catalogs/ParentConfigurations/x', false, 'не корень выгрузки'],
    ['ext/parentconfigurations/a.cf', false, 'регистр сравнивается точно: ошибка — в сторону скачивания'],
    ['Ext/ParentConfigurations', false, 'сам каталог без файла'],
    ['Configuration.xml', false, 'прочее'],
  ];
  for (const [rel, expected, why] of CASES) {
    test(`${rel} → ${String(expected)} (${why})`, () => {
      assert.strictEqual(isVendorConfigurationFile(rel), expected);
    });
  }
});

suite('VendorConfigurationGate: decideVendorDownload', () => {
  const VENDOR = 'Ext/ParentConfigurations/Поставщик.cf';
  const KNOWN_NONE: RootPartEvidence = { kind: 'known', changedParts: new Set(['ManagedApplicationModule']) };
  /** Вход, при котором ВСЕ правила сходятся на `skip`; каждый тест ломает ровно одно условие. */
  const SKIP_INPUT: VendorDownloadInput = {
    rel: VENDOR,
    mustFetch: false,
    evidence: KNOWN_NONE,
    binChanged: false,
    projectSize: 1000,
    mirrorSize: 1000,
  };

  test('базовый вход: все условия «ничего не изменилось» → skip', () => {
    assert.strictEqual(decideVendorDownload(SKIP_INPUT), 'skip');
  });

  const DOWNLOAD_CASES: readonly (readonly [string, VendorDownloadInput])[] = [
    ['1. файл не шлюзуемый (.bin) — обычные правила вне шлюза', { ...SKIP_INPUT, rel: 'Ext/ParentConfigurations.bin' }],
    ['1. файл не шлюзуемый (обычный) — обычные правила вне шлюза', { ...SKIP_INPUT, rel: 'Ext/Другой.bsl' }],
    ['2. mustFetch (грязный, вне B или совпадает с удаляемым)', { ...SKIP_INPUT, mustFetch: true }],
    ['3. доказательство unknown', { ...SKIP_INPUT, evidence: { kind: 'unknown', reason: 'корень выгружается целиком' } }],
    ['3. доказательство не передано', { ...SKIP_INPUT, evidence: undefined }],
    ['4. часть ParentConfigurations в списке изменений', { ...SKIP_INPUT, evidence: { kind: 'known', changedParts: new Set([PARENT_CONFIGURATIONS_PART]) } }],
    ['5. страховка: .bin изменился', { ...SKIP_INPUT, binChanged: true }],
    ['6. файла нет в P', { ...SKIP_INPUT, projectSize: undefined }],
    ['7. размер в P меньше размера в M', { ...SKIP_INPUT, projectSize: 999 }],
    ['7. размер в P больше размера в M', { ...SKIP_INPUT, projectSize: 1001 }],
    ['7. размер в M неизвестен', { ...SKIP_INPUT, mirrorSize: undefined }],
  ];
  for (const [name, input] of DOWNLOAD_CASES) {
    test(`${name} → download`, () => {
      assert.strictEqual(decideVendorDownload(input), 'download');
    });
  }

  test('несколько причин сразу — всё равно download', () => {
    assert.strictEqual(decideVendorDownload({
      ...SKIP_INPUT,
      mustFetch: true,
      binChanged: true,
      evidence: undefined,
      projectSize: undefined,
      mirrorSize: undefined,
    }), 'download');
  });

  test('пустая известная картина частей (корень изменён без частей) — skip', () => {
    assert.strictEqual(decideVendorDownload({ ...SKIP_INPUT, evidence: { kind: 'known', changedParts: new Set() } }), 'skip');
  });

  test('нулевой размер, равный в P и M, — skip (нуль — известный размер, а не «неизвестен»)', () => {
    assert.strictEqual(decideVendorDownload({ ...SKIP_INPUT, projectSize: 0, mirrorSize: 0 }), 'skip');
  });
});
