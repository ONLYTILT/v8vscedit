import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findOrphanProjectFiles } from '../../infra/agent/sync/ProjectSeed';
import { parseConfigDumpInfoIndex } from '../../infra/xml/dumpInfo/ConfigDumpInfoIndex';

/**
 * «Осиротевшие» файлы выгрузки проекта (plan-archive-avoid.md §3.7): после посева из выгрузки проекта
 * объекты, удалённые в базе до ручной выгрузки, остаются в P от прежней выгрузки (ручную замену делают
 * ПОВЕРХ старой, без очистки). Признак: владельца файла нет ни в CDI проекта (из него засеян M), ни среди
 * владельцев списка изменений этой операции (объекты, созданные в базе ПОСЛЕ ручной выгрузки, пришли
 * дельтой, а в CDI проекта их нет). Файлы вне известных папок и корень конфигурации не трогаются.
 */

const wrap = (names: string[]): string => [
  '<ConfigDumpInfo xmlns="http://v8.1c.ru/8.3/xcf/dumpinfo" format="Hierarchical" version="2.21">',
  ...names.map((name) => `  <Metadata name="${name}" id="x" configVersion="1"/>`),
  '</ConfigDumpInfo>',
].join('\n');

suite('ProjectSeed.findOrphanProjectFiles', () => {
  let dir: string;

  const write = (rel: string): void => {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, rel);
  };

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-orphans-'));
    write('Configuration.xml');
    write('ConfigDumpInfo.xml');
    write('Ext/SessionModule.bsl');
    write('Catalogs/Живой.xml');
    write('Catalogs/Живой/Ext/ObjectModule.bsl');
    write('Catalogs/Старый.xml');
    write('Catalogs/Старый/Ext/ObjectModule.bsl');
    write('Catalogs/Старый/Forms/Ф/Ext/Form.xml');
    write('Documents/Новый.xml');
    write('Documents/Новый/Ext/ObjectModule.bsl');
    write('Subsystems/Удалённая.xml');
    write('Subsystems/Удалённая/Subsystems/Дочерняя.xml');
    write('Subsystems/Живая.xml');
    write('Subsystems/Живая/Subsystems/Дочерняя.xml');
    write('Неизвестная/Папка.xml');
    write('readme.txt');
  });
  teardown(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const index = (...names: string[]): ReturnType<typeof parseConfigDumpInfoIndex> => parseConfigDumpInfoIndex(wrap(names));

  test('владельца нет в CDI проекта и в списке изменений → сирота: ВСЕ файлы владельца (XML и поддерево)', () => {
    const orphans = findOrphanProjectFiles(dir, index('Configuration.Основная', 'Catalog.Живой', 'Document.Новый', 'Subsystem.Живая'), new Set(['Document.Новый']));
    assert.deepStrictEqual([...orphans].sort(), [
      'Catalogs/Старый.xml',
      'Catalogs/Старый/Ext/ObjectModule.bsl',
      'Catalogs/Старый/Forms/Ф/Ext/Form.xml',
      'Subsystems/Удалённая.xml',
      'Subsystems/Удалённая/Subsystems/Дочерняя.xml',
    ]);
  });

  test('владелец в changedOwners (создан в базе после ручной выгрузки; в CDI проекта его нет) → не сирота', () => {
    const orphans = findOrphanProjectFiles(dir, index('Catalog.Живой', 'Subsystem.Живая'), new Set(['Document.Новый', 'Catalog.Старый', 'Subsystem.Удалённая']));
    assert.deepStrictEqual(orphans, []);
  });

  test('без changedOwners тот же объект — сирота (признак строится именно по списку изменений операции)', () => {
    const orphans = findOrphanProjectFiles(dir, index('Catalog.Живой', 'Catalog.Старый', 'Subsystem.Живая', 'Subsystem.Удалённая'), new Set());
    assert.deepStrictEqual([...orphans].sort(), ['Documents/Новый.xml', 'Documents/Новый/Ext/ObjectModule.bsl']);
  });

  test('Configuration.xml, Ext/**, ConfigDumpInfo.xml, неизвестные папки и файлы в корне сиротами не бывают — даже если конфигурации нет в CDI', () => {
    const orphans = findOrphanProjectFiles(dir, index(), new Set());
    for (const kept of ['Configuration.xml', 'ConfigDumpInfo.xml', 'Ext/SessionModule.bsl', 'Неизвестная/Папка.xml', 'readme.txt']) {
      assert.ok(!orphans.includes(kept), kept);
    }
  });

  test('вложенная подсистема удалённой верхней — сирота; вложенная подсистема живой верхней — нет', () => {
    const orphans = findOrphanProjectFiles(dir, index('Catalog.Живой', 'Catalog.Старый', 'Document.Новый', 'Subsystem.Живая'), new Set());
    assert.ok(orphans.includes('Subsystems/Удалённая/Subsystems/Дочерняя.xml'));
    assert.ok(orphans.includes('Subsystems/Удалённая.xml'));
    assert.ok(!orphans.includes('Subsystems/Живая/Subsystems/Дочерняя.xml'));
  });

  test('каждый файл-сирота возвращается ровно один раз', () => {
    const orphans = findOrphanProjectFiles(dir, index(), new Set());
    assert.strictEqual(new Set(orphans).size, orphans.length);
  });

  test('пустая выгрузка проекта → сирот нет', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-orphans-empty-'));
    try {
      assert.deepStrictEqual(findOrphanProjectFiles(empty, index('Catalog.Живой'), new Set()), []);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
