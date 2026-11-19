import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  ConfigDumpInfoFormatError,
  removeConfigDumpInfoOwners,
} from '../../infra/xml/dumpInfo/ConfigDumpInfoEditor';
import { parseConfigDumpInfoIndex } from '../../infra/xml/dumpInfo/ConfigDumpInfoIndex';
import { EXAMPLE_GENERATIONS, skipWithoutCorpus } from './support/corpus';
import { buildCdiText, documentOwner, ROOT_OWNER, type CdiOwner, type CdiRenderOptions } from './support/dumpInfoFixtures';

/**
 * Редактор файла версий выгрузки (plan-fulldump-avoid.md, Т1): удаляет записи верхнего уровня владельца и
 * все его вложенные записи (имя или префикс `имя.`) целыми строками. Эталон результата в синтетических
 * тестах — тот же файл, собранный без этих владельцев: BOM, EOL, отступы и порядок атрибутов не меняются.
 * Разбор и правка CDI — только в `infra/xml/dumpInfo/` (запрет №1).
 */

const CATALOG_A: CdiOwner = {
  name: 'Catalog.А',
  version: 'a1',
  children: [
    { name: 'Catalog.А.Attribute.Р' },
    { name: 'Catalog.А.ObjectModule', version: 'a2' },
  ],
};
const CATALOG_B: CdiOwner = { name: 'Catalog.Б', version: 'b1' };
const CATALOG_X: CdiOwner = { name: 'Catalog.X', version: 'x1', children: [{ name: 'Catalog.X.ObjectModule', version: 'x2' }] };
const CATALOG_XY: CdiOwner = { name: 'Catalog.XY', version: 'y1', children: [{ name: 'Catalog.XY.ObjectModule', version: 'y2' }] };
const DOC = documentOwner('Д');

const EOLS = ['\n', '\r\n'] as const;
const BOMS = [true, false] as const;

function render(owners: readonly CdiOwner[], options: CdiRenderOptions = {}): string {
  return buildCdiText([ROOT_OWNER, ...owners], options);
}

suite('removeConfigDumpInfoOwners: байт-в-байт', () => {
  for (const eol of EOLS) {
    for (const bom of BOMS) {
      const options: CdiRenderOptions = { eol, bom };
      const label = `EOL ${JSON.stringify(eol)}, BOM ${bom ? 'есть' : 'нет'}`;

      test(`${label}: блок владельца с детьми вырезан целиком, остальное побайтно прежнее`, () => {
        const result = removeConfigDumpInfoOwners(render([CATALOG_A, CATALOG_B, DOC], options), ['Catalog.А']);

        assert.strictEqual(result.text, render([CATALOG_B, DOC], options));
        assert.deepStrictEqual(result.removedNames, ['Catalog.А', 'Catalog.А.Attribute.Р', 'Catalog.А.ObjectModule']);
        assert.deepStrictEqual(result.missingOwners, []);
      });

      test(`${label}: самозакрытая запись владельца без детей`, () => {
        const result = removeConfigDumpInfoOwners(render([CATALOG_A, CATALOG_B, DOC], options), ['Catalog.Б']);

        assert.strictEqual(result.text, render([CATALOG_A, DOC], options));
        assert.deepStrictEqual(result.removedNames, ['Catalog.Б']);
      });

      test(`${label}: несколько владельцев за раз; removedNames — в порядке файла`, () => {
        const result = removeConfigDumpInfoOwners(render([CATALOG_A, CATALOG_B, DOC], options), ['Document.Д', 'Catalog.А']);

        assert.strictEqual(result.text, render([CATALOG_B], options));
        assert.deepStrictEqual(result.removedNames, [
          'Catalog.А', 'Catalog.А.Attribute.Р', 'Catalog.А.ObjectModule',
          'Document.Д', ...(DOC.children ?? []).map((child) => child.name),
        ]);
      });
    }
  }

  test('отступы пробелами вместо табуляции: вырезаются целые строки, чужие отступы не трогаются', () => {
    const options: CdiRenderOptions = { indent: '  ' };
    const result = removeConfigDumpInfoOwners(render([CATALOG_A, CATALOG_B], options), ['Catalog.А']);
    assert.strictEqual(result.text, render([CATALOG_B], options));
  });

  test('коллизия префикса: Catalog.X не задевает Catalog.XY и наоборот', () => {
    const source = render([CATALOG_X, CATALOG_XY]);

    const removedX = removeConfigDumpInfoOwners(source, ['Catalog.X']);
    assert.strictEqual(removedX.text, render([CATALOG_XY]));
    assert.deepStrictEqual(removedX.removedNames, ['Catalog.X', 'Catalog.X.ObjectModule']);

    const removedXY = removeConfigDumpInfoOwners(source, ['Catalog.XY']);
    assert.strictEqual(removedXY.text, render([CATALOG_X]));
    assert.deepStrictEqual(removedXY.removedNames, ['Catalog.XY', 'Catalog.XY.ObjectModule']);
  });

  test('порядок атрибутов и вид тега произвольны: configVersion, id, name; пара <Metadata></Metadata> без детей', () => {
    const source = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ConfigDumpInfo xmlns="http://v8.1c.ru/8.3/xcf/dumpinfo" format="Hierarchical" version="2.20">',
      '  <ConfigVersions>',
      '    <Metadata configVersion="7" id="1" name="Catalog.А">',
      '      <Metadata id="2" name="Catalog.А.ObjectModule" configVersion="8"/>',
      '    </Metadata>',
      '    <Metadata name="Catalog.Б" configVersion="9"></Metadata>',
      '    <Metadata id="3" configVersion="10" name="Catalog.В"/>',
      '  </ConfigVersions>',
      '</ConfigDumpInfo>',
      '',
    ].join('\n');

    const result = removeConfigDumpInfoOwners(source, ['Catalog.А', 'Catalog.Б']);

    assert.strictEqual(result.text, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ConfigDumpInfo xmlns="http://v8.1c.ru/8.3/xcf/dumpinfo" format="Hierarchical" version="2.20">',
      '  <ConfigVersions>',
      '    <Metadata id="3" configVersion="10" name="Catalog.В"/>',
      '  </ConfigVersions>',
      '</ConfigDumpInfo>',
      '',
    ].join('\n'));
    assert.deepStrictEqual(result.removedNames, ['Catalog.А', 'Catalog.А.ObjectModule', 'Catalog.Б']);
  });
});

suite('removeConfigDumpInfoOwners: отсутствующие владельцы и идемпотентность', () => {
  test('missingOwners: владельцы без записей; текст при этом неизменен', () => {
    const source = render([CATALOG_A]);
    const result = removeConfigDumpInfoOwners(source, ['Catalog.Нет', 'Role.Нет']);
    assert.strictEqual(result.text, source);
    assert.deepStrictEqual(result.removedNames, []);
    assert.deepStrictEqual(result.missingOwners, ['Catalog.Нет', 'Role.Нет']);
  });

  test('часть владельцев найдена, часть нет: missingOwners — только отсутствующие', () => {
    const result = removeConfigDumpInfoOwners(render([CATALOG_A, CATALOG_B]), ['Catalog.Б', 'Catalog.Нет']);
    assert.strictEqual(result.text, render([CATALOG_A]));
    assert.deepStrictEqual(result.missingOwners, ['Catalog.Нет']);
  });

  test('пустой список владельцев: текст неизменен', () => {
    const source = render([CATALOG_A]);
    assert.deepStrictEqual(removeConfigDumpInfoOwners(source, []), { text: source, removedNames: [], missingOwners: [] });
  });

  test('идемпотентность: повторное применение не меняет файл, владелец уже «отсутствует»', () => {
    const once = removeConfigDumpInfoOwners(render([CATALOG_A, CATALOG_B, DOC]), ['Catalog.А', 'Document.Д']);
    const twice = removeConfigDumpInfoOwners(once.text, ['Catalog.А', 'Document.Д']);
    assert.strictEqual(twice.text, once.text);
    assert.deepStrictEqual(twice.removedNames, []);
    assert.deepStrictEqual(twice.missingOwners, ['Catalog.А', 'Document.Д']);
  });

  test('результат — корректный CDI: индекс без вырезанного владельца, версии остальных прежние', () => {
    const before = parseConfigDumpInfoIndex(render([CATALOG_A, CATALOG_B, DOC]));
    const after = parseConfigDumpInfoIndex(removeConfigDumpInfoOwners(render([CATALOG_A, CATALOG_B, DOC]), ['Catalog.А']).text);

    assert.ok(!after.rootNames.has('Catalog.А'));
    assert.deepStrictEqual([...after.rootNames].sort(), [...before.rootNames].filter((name) => name !== 'Catalog.А').sort());
    for (const [name, version] of before.fileLevelVersions) {
      if (!name.startsWith('Catalog.А')) {
        assert.strictEqual(after.fileLevelVersions.get(name), version, name);
      }
    }
  });
});

suite('removeConfigDumpInfoOwners: отказы', () => {
  test('Configuration.* среди владельцев → Error (корень не чистится), это не FormatError', () => {
    for (const owners of [['Configuration.Конфигурация'], ['Catalog.А', 'Configuration.Другая']]) {
      assert.throws(() => removeConfigDumpInfoOwners(render([CATALOG_A]), owners), (error: unknown) =>
        error instanceof Error && !(error instanceof ConfigDumpInfoFormatError) && error.message.includes('Configuration'));
    }
  });

  test('запись владельца без закрывающего тега → ConfigDumpInfoFormatError', () => {
    const source = [
      '<ConfigDumpInfo format="Hierarchical" version="2.20">',
      '  <ConfigVersions>',
      '    <Metadata name="Catalog.А" id="1" configVersion="7">',
      '      <Metadata name="Catalog.А.ObjectModule" id="2" configVersion="8"/>',
      '  </ConfigVersions>',
      '</ConfigDumpInfo>',
      '',
    ].join('\n');
    assert.throws(() => removeConfigDumpInfoOwners(source, ['Catalog.А']), ConfigDumpInfoFormatError);
  });

  test('лишний закрывающий </Metadata> → ConfigDumpInfoFormatError', () => {
    const source = [
      '<ConfigDumpInfo format="Hierarchical" version="2.20">',
      '  <ConfigVersions>',
      '    <Metadata name="Catalog.А" id="1" configVersion="7"/>',
      '    </Metadata>',
      '  </ConfigVersions>',
      '</ConfigDumpInfo>',
      '',
    ].join('\n');
    assert.throws(() => removeConfigDumpInfoOwners(source, ['Catalog.А']), ConfigDumpInfoFormatError);
  });

  test('последняя запись без завершающего перевода строки: вырезается до конца текста', () => {
    const head = '<ConfigDumpInfo format="Hierarchical" version="2.20">\n  <Metadata name="Catalog.А" id="1" configVersion="7"/>\n';
    const source = `${head}  <Metadata name="Catalog.Б" id="2" configVersion="8"/>`;

    const result = removeConfigDumpInfoOwners(source, ['Catalog.Б']);

    assert.strictEqual(result.text, head);
    assert.deepStrictEqual(result.removedNames, ['Catalog.Б']);
  });

  test('текст без <ConfigVersions> и записей: владелец отсутствует, не FormatError', () => {
    const source = '<ConfigDumpInfo format="Hierarchical" version="2.20"></ConfigDumpInfo>\n';
    const result = removeConfigDumpInfoOwners(source, ['Catalog.А']);
    assert.strictEqual(result.text, source);
    assert.deepStrictEqual(result.missingOwners, ['Catalog.А']);
  });
});

suite('removeConfigDumpInfoOwners: корпус example/2.20', function () {
  this.timeout(120_000);
  suiteSetup(function () { skipWithoutCorpus(this, EXAMPLE_GENERATIONS.cf20); });

  const lineSplit = (text: string): string[] => text.split(/\r?\n/);

  test('вырезанные владельцы разных видов: результат — подпоследовательность строк, имена и версии прочих неизменны', () => {
    const original = fs.readFileSync(path.join(EXAMPLE_GENERATIONS.cf20, 'ConfigDumpInfo.xml'), 'utf-8');
    const before = parseConfigDumpInfoIndex(original);
    // по одному владельцу каждого вида (первые три вида по порядку файла), без корня конфигурации
    const byKind = new Map<string, string>();
    for (const name of before.rootNames) {
      const kind = name.split('.')[0];
      if (kind !== 'Configuration' && !byKind.has(kind)) {
        byKind.set(kind, name);
      }
    }
    const owners = [...byKind.values()].slice(0, 3);
    assert.strictEqual(owners.length, 3, 'в корпусе есть три разных вида владельцев');

    const result = removeConfigDumpInfoOwners(original, owners);

    assert.deepStrictEqual(result.missingOwners, []);
    assert.ok(result.removedNames.length >= owners.length);
    assert.ok(result.text.length < original.length);
    const sourceLines = lineSplit(original);
    let cursor = 0;
    for (const line of lineSplit(result.text)) {
      while (cursor < sourceLines.length && sourceLines[cursor] !== line) {
        cursor += 1;
      }
      assert.ok(cursor < sourceLines.length, `строка результата не из исходного файла: ${line.slice(0, 80)}`);
      cursor += 1;
    }
    const after = parseConfigDumpInfoIndex(result.text);
    assert.deepStrictEqual([...after.rootNames].sort(), [...before.rootNames].filter((name) => !owners.includes(name)).sort());
    for (const [name, version] of before.fileLevelVersions) {
      const removed = owners.some((owner) => name === owner || name.startsWith(`${owner}.`));
      assert.strictEqual(after.fileLevelVersions.get(name), removed ? undefined : version, name);
    }
    assert.ok(after.configurationOwner !== undefined, 'корень конфигурации на месте');
    assert.strictEqual(result.text.charAt(0), original.charAt(0), 'BOM (или первый символ) сохранён');
  });
});
