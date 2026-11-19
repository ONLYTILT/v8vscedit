import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { diffConfigDumpInfo, groupDumpInfoDiffByOwner } from '../../infra/xml/dumpInfo/ConfigDumpInfoDiff';
import { parseConfigDumpInfoIndex, type ConfigDumpInfoIndex } from '../../infra/xml/dumpInfo/ConfigDumpInfoIndex';
import { EXAMPLE_GENERATIONS, skipWithoutCorpus } from './support/corpus';
import { buildCdiIndex, documentOwner, ROOT_OWNER, type CdiOwner } from './support/dumpInfoFixtures';

/**
 * Сравнение файла версий зеркала (M) со свежим файлом версий базы (plan-fulldump-avoid.md, Т3). Сравниваются
 * файловые записи (с `configVersion`); владельца записи даёт `dumpInfoOwnerOf`. Три набора: удалённые владельцы,
 * живые владельцы с пропавшей частью (форма, макет, модуль, вложенная подсистема) и изменённые владельцы.
 */

const ROOT_WITH_PART: CdiOwner = {
  ...ROOT_OWNER,
  children: [{ name: 'Configuration.Конфигурация.HomePageWorkArea', version: 'hp1' }],
};
const CATALOG: CdiOwner = { name: 'Catalog.Справочник', version: 'c1', children: [{ name: 'Catalog.Справочник.ObjectModule', version: 'c2' }] };
const SUBSYSTEM_A: CdiOwner = {
  name: 'Subsystem.A',
  version: 's1',
  children: [{ name: 'Subsystem.A.Subsystem.B', version: 's2' }],
};

function index(...owners: CdiOwner[]): ConfigDumpInfoIndex {
  return buildCdiIndex(owners);
}

/** Документ без формы: тот же владелец, у которого пропали две файловые записи формы. */
function documentWithoutForm(name: string, version = 'v1'): CdiOwner {
  const full = documentOwner(name, version);
  return { ...full, children: (full.children ?? []).filter((child) => !child.name.includes('.Form.')) };
}

suite('diffConfigDumpInfo', () => {
  test('одинаковые файлы версий → пусто', () => {
    const same = index(ROOT_OWNER, documentOwner('Д'), CATALOG);
    assert.deepStrictEqual(diffConfigDumpInfo(same, index(ROOT_OWNER, documentOwner('Д'), CATALOG)), { added: [], removed: [], modified: [], removedEmbedded: [] });
  });

  test('запись только в after — added; только в before — removed; другая версия — modified', () => {
    const before = index(ROOT_OWNER, { name: 'Catalog.А', version: 'a1', children: [{ name: 'Catalog.А.ObjectModule', version: 'm1' }] });
    const after = index(ROOT_OWNER, {
      name: 'Catalog.А',
      version: 'a2',
      children: [{ name: 'Catalog.А.ManagerModule', version: 'mm1' }],
    });

    assert.deepStrictEqual(diffConfigDumpInfo(before, after), {
      added: ['Catalog.А.ManagerModule'],
      removed: ['Catalog.А.ObjectModule'],
      modified: ['Catalog.А'],
      removedEmbedded: [],
    });
  });

  // Стенд пользователя (БП КОРП): переименование реквизита ТЧ дало агенту FullDump, а из файла версий пропала
  // ТОЛЬКО встроенная запись. Сравнение лишь файловых записей её не видело и уводило импорт в перезапись.
  test('пропавшая встроенная запись (переименованный реквизит) — removedEmbedded; появившаяся новая встроенная — не added', () => {
    const before = index(ROOT_OWNER, { name: 'Catalog.А', version: 'a1', children: [{ name: 'Catalog.А.Attribute.Р' }] });
    const after = index(ROOT_OWNER, { name: 'Catalog.А', version: 'a2', children: [{ name: 'Catalog.А.Attribute.Другой' }] });
    assert.deepStrictEqual(diffConfigDumpInfo(before, after), {
      added: [],
      removed: [],
      modified: ['Catalog.А'],
      removedEmbedded: ['Catalog.А.Attribute.Р'],
    });
  });

  test('встроенная запись, ставшая файловой, пропавшей не считается', () => {
    const before = index(ROOT_OWNER, { name: 'Catalog.А', version: 'a1', children: [{ name: 'Catalog.А.Command.К' }] });
    const after = index(ROOT_OWNER, { name: 'Catalog.А', version: 'a1', children: [{ name: 'Catalog.А.Command.К', version: 'k1' }] });
    const diff = diffConfigDumpInfo(before, after);
    assert.deepStrictEqual(diff.removedEmbedded, []);
    assert.deepStrictEqual(diff.added, ['Catalog.А.Command.К']);
  });

  test('детерминированная сортировка: порядок записей в файле не влияет на порядок результата', () => {
    const before = index(ROOT_OWNER, { name: 'Catalog.Я', version: '1' }, { name: 'Catalog.Б', version: '1' }, { name: 'Catalog.Ж', version: '1' });
    const after = index(ROOT_OWNER);
    const reversed = index(ROOT_OWNER);
    const diff = diffConfigDumpInfo(before, after);
    const sorted = [...diff.removed].sort();
    assert.deepStrictEqual(diff.removed, sorted);
    assert.deepStrictEqual(diff.removed, ['Catalog.Б', 'Catalog.Ж', 'Catalog.Я']);
    assert.deepStrictEqual(diffConfigDumpInfo(before, reversed), diff);
  });
});

suite('groupDumpInfoDiffByOwner', () => {
  function group(before: ConfigDumpInfoIndex, after: ConfigDumpInfoIndex): ReturnType<typeof groupDumpInfoDiffByOwner> {
    return groupDumpInfoDiffByOwner(diffConfigDumpInfo(before, after), before, after);
  }

  test('1. нет изменений → все наборы пусты, корень на месте', () => {
    const same = index(ROOT_OWNER, documentOwner('Д'));
    assert.deepStrictEqual(group(same, index(ROOT_OWNER, documentOwner('Д'))), {
      removedOwners: [],
      ownersWithRemovedParts: [],
      changedOwners: [],
      configurationMissing: false,
    });
  });

  test('2. изменён модуль → changedOwners: владелец, modified', () => {
    const changed: CdiOwner = {
      ...documentOwner('Д'),
      children: (documentOwner('Д').children ?? []).map((child) => (child.name === 'Document.Д.ObjectModule' ? { ...child, version: 'новая' } : child)),
    };

    const result = group(index(ROOT_OWNER, documentOwner('Д')), index(ROOT_OWNER, changed));

    assert.deepStrictEqual(result.changedOwners, [{ fullName: 'Document.Д', change: 'modified' }]);
    assert.deepStrictEqual(result.removedOwners, []);
    assert.deepStrictEqual(result.ownersWithRemovedParts, []);
  });

  test('3. удалена форма (Form.Ф и Form.Ф.Form) → владелец в ownersWithRemovedParts и НЕ в removedOwners', () => {
    const result = group(index(ROOT_OWNER, documentOwner('Д')), index(ROOT_OWNER, documentWithoutForm('Д')));

    assert.deepStrictEqual(result.ownersWithRemovedParts, ['Document.Д']);
    assert.deepStrictEqual(result.removedOwners, []);
    assert.strictEqual(result.configurationMissing, false);
  });

  test('4. удалён владелец → removedOwners; живым с частями он не считается', () => {
    const result = group(index(ROOT_OWNER, documentOwner('Д'), CATALOG), index(ROOT_OWNER, CATALOG));

    assert.deepStrictEqual(result.removedOwners, ['Document.Д']);
    assert.deepStrictEqual(result.ownersWithRemovedParts, []);
    assert.deepStrictEqual(result.changedOwners, []);
  });

  test('5. переименование → старое имя в removedOwners, новое в changedOwners как added', () => {
    const before = index(ROOT_OWNER, { name: 'Catalog.Старый', version: 'o1', children: [{ name: 'Catalog.Старый.ObjectModule', version: 'o2' }] });
    const after = index(ROOT_OWNER, { name: 'Catalog.Новый', version: 'n1', children: [{ name: 'Catalog.Новый.ObjectModule', version: 'n2' }] });

    const result = group(before, after);

    assert.deepStrictEqual(result.removedOwners, ['Catalog.Старый']);
    assert.deepStrictEqual(result.changedOwners, [{ fullName: 'Catalog.Новый', change: 'added' }]);
    assert.deepStrictEqual(result.ownersWithRemovedParts, []);
  });

  test('3b. переименован реквизит ТЧ (пропала встроенная запись) → живой владелец в ownersWithRemovedParts', () => {
    const owner = (attr: string): CdiOwner => ({
      name: 'Document.Д',
      version: attr === 'СуммаОплаты' ? 'd1' : 'd2',
      children: [{ name: 'Document.Д.TabularSection.Т' }, { name: `Document.Д.TabularSection.Т.Attribute.${attr}` }],
    });
    const before = index(ROOT_OWNER, owner('СуммаОплаты'));
    const after = index(ROOT_OWNER, owner('Сумма'));
    const changes = groupDumpInfoDiffByOwner(diffConfigDumpInfo(before, after), before, after);
    assert.deepStrictEqual(changes.ownersWithRemovedParts, ['Document.Д']);
    assert.deepStrictEqual(changes.removedOwners, []);
  });

  test('3c. удалён владелец со встроенными записями → только removedOwners, не ownersWithRemovedParts', () => {
    const before = index(ROOT_OWNER, { name: 'Catalog.А', version: 'a1', children: [{ name: 'Catalog.А.Attribute.Р' }] });
    const after = index(ROOT_OWNER);
    const changes = groupDumpInfoDiffByOwner(diffConfigDumpInfo(before, after), before, after);
    assert.deepStrictEqual(changes.removedOwners, ['Catalog.А']);
    assert.deepStrictEqual(changes.ownersWithRemovedParts, []);
  });

  test('6. удалена вложенная подсистема Subsystem.A.Subsystem.B → ownersWithRemovedParts = [Subsystem.A]', () => {
    const result = group(
      index(ROOT_OWNER, SUBSYSTEM_A),
      index(ROOT_OWNER, { name: 'Subsystem.A', version: 's1' })
    );

    assert.deepStrictEqual(result.ownersWithRemovedParts, ['Subsystem.A']);
    assert.deepStrictEqual(result.removedOwners, []);
  });

  test('7. удалена часть корня → Configuration.X в ownersWithRemovedParts, но не в removedOwners', () => {
    const result = group(index(ROOT_WITH_PART, CATALOG), index(ROOT_OWNER, CATALOG));

    assert.deepStrictEqual(result.ownersWithRemovedParts, ['Configuration.Конфигурация']);
    assert.deepStrictEqual(result.removedOwners, []);
    assert.strictEqual(result.configurationMissing, false);
  });

  test('8. корня нет в after → configurationMissing; Configuration.* в removedOwners не попадает никогда', () => {
    const result = group(index(ROOT_OWNER, CATALOG), index(CATALOG));

    assert.strictEqual(result.configurationMissing, true);
    assert.ok(!result.removedOwners.includes('Configuration.Конфигурация'));
  });

  test('9. изменён сам корень (его запись) → корень в changedOwners, не в removedOwners', () => {
    const result = group(index(ROOT_OWNER, CATALOG), index({ ...ROOT_OWNER, version: 'r2' }, CATALOG));

    assert.deepStrictEqual(result.changedOwners, [{ fullName: 'Configuration.Конфигурация', change: 'modified' }]);
    assert.deepStrictEqual(result.removedOwners, []);
  });

  test('10. всё сразу: удалён A, у B удалена форма, изменён C, добавлен D — четыре независимых набора', () => {
    const before = index(ROOT_OWNER, { name: 'Catalog.А', version: 'a1' }, documentOwner('Б'), { name: 'Catalog.В', version: 'c1' });
    const after = index(
      ROOT_OWNER,
      documentWithoutForm('Б'),
      { name: 'Catalog.В', version: 'c2' },
      { name: 'Catalog.Г', version: 'd1' }
    );

    const result = group(before, after);

    assert.deepStrictEqual(result.removedOwners, ['Catalog.А']);
    assert.deepStrictEqual(result.ownersWithRemovedParts, ['Document.Б']);
    assert.deepStrictEqual(result.changedOwners, [
      { fullName: 'Catalog.В', change: 'modified' },
      { fullName: 'Catalog.Г', change: 'added' },
    ]);
  });

  test('11. детерминированная сортировка всех наборов', () => {
    const before = index(
      ROOT_OWNER,
      { name: 'Catalog.Я', version: '1' }, { name: 'Catalog.Б', version: '1' },
      documentOwner('Ю'), documentOwner('Ё')
    );
    const after = index(ROOT_OWNER, documentWithoutForm('Ю'), documentWithoutForm('Ё'));

    const result = group(before, after);

    assert.deepStrictEqual(result.removedOwners, ['Catalog.Б', 'Catalog.Я']);
    assert.deepStrictEqual(result.ownersWithRemovedParts, [...result.ownersWithRemovedParts].sort());
    assert.deepStrictEqual(result.ownersWithRemovedParts, ['Document.Ё', 'Document.Ю']);
  });
});

suite('ConfigDumpInfoDiff: корпус example/2.20', function () {
  this.timeout(120_000);
  suiteSetup(function () { skipWithoutCorpus(this, EXAMPLE_GENERATIONS.cf20); });

  test('diff файла версий с самим собой пуст, наборы пусты, корень на месте', () => {
    const text = fs.readFileSync(path.join(EXAMPLE_GENERATIONS.cf20, 'ConfigDumpInfo.xml'), 'utf-8');
    const first = parseConfigDumpInfoIndex(text);
    const second = parseConfigDumpInfoIndex(text);

    assert.deepStrictEqual(diffConfigDumpInfo(first, second), { added: [], removed: [], modified: [] });
    assert.deepStrictEqual(groupDumpInfoDiffByOwner(diffConfigDumpInfo(first, second), first, second), {
      removedOwners: [],
      ownersWithRemovedParts: [],
      changedOwners: [],
      configurationMissing: false,
    });
  });
});
