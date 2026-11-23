import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { RoleRightsEditService } from '../../infra/role/RoleRightsEditService';
import type { RoleRightsEditOperation, RoleRightsEditResult } from '../../infra/role/types';
import { EXAMPLE_GENERATIONS } from './support/corpus';
import {
  REFERENCE_VARIANT,
  makeTempRoot,
  objectLines,
  rightLines,
  rightsFileText,
  templateLines,
  writeRights,
  type RightsFileVariant,
} from './support/rightsFixtures';
import { removeTreeSync } from './support/tempTree';

/**
 * edit_role — ТОЧЕЧНАЯ правка Rights.xml и идемпотентность.
 *
 * Дефект: повторный `grant РегистрСведений.X` Read/View при уже выданных правах давал
 * «changed: true» и полную пересборку файла (потеря BOM/`xsi:type`/`<field>`/`<condition/>`,
 * сущности `&amp;` и переупорядочивание). Теперь файл правится splice'ом по диапазонам, а если
 * итоговый текст совпадает с исходным — записи нет вовсе (байты и mtime целы).
 */

const VARIANTS: readonly (RightsFileVariant & { readonly name: string })[] = [
  { name: 'эталон CRLF+BOM без хвоста', ...REFERENCE_VARIANT },
  { name: 'LF', eol: '\n', bom: false, trailing: true },
  { name: 'LF+BOM', eol: '\n', bom: true, trailing: false },
  { name: 'CRLF без BOM с хвостом', eol: '\r\n', bom: false, trailing: true },
];

const KURSY = objectLines('InformationRegister.МК_Курсы', [['Read', 'true'], ['View', 'true']]);
const AMP = objectLines('Catalog.А&amp;Б', [['Read', 'true']]);
const TERM: string[] = [
  '\t<object>',
  '\t\t<name>Catalog.СБ_Терминалы</name>',
  '\t\t<right>',
  '\t\t\t<name>Read</name>',
  '\t\t\t<value>true</value>',
  '\t\t\t<restrictionByCondition>',
  '\t\t\t\t<field>Code</field>',
  '\t\t\t\t<field>Ref</field>',
  '\t\t\t\t<condition/>',
  '\t\t\t</restrictionByCondition>',
  '\t\t</right>',
  '\t</object>',
];
const BANKI_ATTR = objectLines('Catalog.Банки.Attribute.БИК', [['View', 'true'], ['Edit', 'false']]);
const TPL = templateLines('Т1', 'ГДЕ А &lt; 1 &amp;&amp; Б');

interface Blocks {
  objects: string[][];
  templates: string[][];
}

const baseBlocks = (): Blocks => ({
  objects: [KURSY, AMP, TERM, BANKI_ATTR].map((block) => [...block]),
  templates: [[...TPL]],
});

const compose = (blocks: Blocks, variant: RightsFileVariant): string =>
  rightsFileText([...blocks.objects.flat(), ...blocks.templates.flat()], variant);

const service = new RoleRightsEditService();

suite('Rights.xml: edit_role', () => {
  const roots: string[] = [];
  const newRoot = (prefix: string): string => {
    const root = makeTempRoot(prefix);
    roots.push(root);
    return root;
  };
  teardown(() => {
    for (const root of roots.splice(0)) {
      removeTreeSync(root);
    }
  });

  /** Файл роли с эталонным содержимым и «старой» меткой mtime — чтобы запись была заметна. */
  function prepare(variant: RightsFileVariant, blocks: Blocks = baseBlocks()): { rightsPath: string; original: string } {
    const root = newRoot('v8vscedit-rights-edit-');
    const original = compose(blocks, variant);
    const rightsPath = writeRights(root, 'Роль', original);
    const past = new Date('2001-02-03T04:05:06Z');
    fs.utimesSync(rightsPath, past, past);
    return { rightsPath, original };
  }

  const readText = (rightsPath: string): string => fs.readFileSync(rightsPath, 'utf-8');

  function edit(rightsPath: string, operations: RoleRightsEditOperation[]): RoleRightsEditResult {
    return service.edit({ rightsPath, operations });
  }

  suite('идемпотентность: повтор уже выданного не меняет файл', () => {
    const repeats: readonly { readonly name: string; readonly op: RoleRightsEditOperation }[] = [
      { name: 'сценарий пользователя: РегистрСведений.X, Read/View', op: { op: 'grant', object: 'РегистрСведений.МК_Курсы', rights: ['Read', 'View'] } },
      { name: 'канон MCP во множественном числе', op: { op: 'grant', object: 'РегистрыСведений.МК_Курсы', rights: ['Read', 'View'] } },
      { name: 'английская форма', op: { op: 'grant', object: 'InformationRegister.МК_Курсы', rights: ['Read', 'View'] } },
      { name: 'русские имена прав', op: { op: 'grant', object: 'РегистрСведений.МК_Курсы', rights: ['Чтение', 'Просмотр'] } },
      { name: 'форма Record<string, boolean>', op: { op: 'grant', object: 'РегистрСведений.МК_Курсы', rights: { Read: true, View: true } } },
      { name: 'пресет view (права уже есть)', op: { op: 'grant', object: 'РегистрСведений.МК_Курсы', preset: 'view' } },
      { name: 'имя объекта с амперсандом (в файле &amp;)', op: { op: 'grant', object: 'Catalog.А&Б', rights: ['Read'] } },
      { name: 'вложенный объект', op: { op: 'grant', object: 'Справочники.Банки.Реквизит.БИК', rights: ['View'] } },
      { name: 'setFlags теми же значениями', op: { op: 'setFlags', flags: { setForNewObjects: false, setForAttributesByDefault: true, independentRightsOfChildObjects: true } } },
      { name: 'addTemplate с тем же условием', op: { op: 'addTemplate', name: 'Т1', condition: 'ГДЕ А < 1 && Б' } },
      { name: 'setRls пустым условием у права с <condition/>', op: { op: 'setRls', object: 'Catalog.СБ_Терминалы', right: 'Read', condition: '' } },
      { name: 'revoke отсутствующего права', op: { op: 'revoke', object: 'Catalog.Банки.Attribute.БИК', rights: ['Use'] } },
    ];
    for (const variant of VARIANTS) {
      for (const repeat of repeats) {
        test(`${repeat.name} [${variant.name}] -> changed:false, applied:0, байты и mtime целы`, () => {
          const { rightsPath, original } = prepare(variant);
          const mtimeBefore = fs.statSync(rightsPath).mtimeMs;
          const result = edit(rightsPath, [repeat.op]);
          assert.strictEqual(result.success, true, result.errors.join('; '));
          assert.strictEqual(result.changed, false);
          assert.strictEqual(result.applied, 0);
          assert.deepStrictEqual([...result.changedFiles], []);
          assert.strictEqual(readText(rightsPath), original, 'байт-в-байт');
          assert.strictEqual(fs.statSync(rightsPath).mtimeMs, mtimeBefore, 'файл не перезаписывался');
        });
      }
    }

    test('пакет из повторов и одной реальной правки: applied считает только изменившие', () => {
      const { rightsPath } = prepare(REFERENCE_VARIANT);
      const result = edit(rightsPath, [
        { op: 'grant', object: 'РегистрСведений.МК_Курсы', rights: ['Read', 'View'] },
        { op: 'grant', object: 'РегистрСведений.МК_Курсы', rights: ['Update'] },
        { op: 'setFlags', flags: { setForNewObjects: false } },
      ]);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.changed, true);
      assert.strictEqual(result.applied, 1);
      assert.deepStrictEqual([...result.changedFiles], [rightsPath]);
    });

    test('повторное применение той же реальной правки вторым вызовом: уже без изменений', () => {
      const { rightsPath } = prepare(REFERENCE_VARIANT);
      const op: RoleRightsEditOperation = { op: 'grant', object: 'РегистрСведений.МК_Курсы', rights: ['Update'] };
      assert.strictEqual(edit(rightsPath, [op]).changed, true);
      const afterFirst = readText(rightsPath);
      const second = edit(rightsPath, [op]);
      assert.strictEqual(second.changed, false);
      assert.strictEqual(second.applied, 0);
      assert.strictEqual(readText(rightsPath), afterFirst);
    });
  });

  suite('реальная правка меняет только целевой блок', () => {
    for (const variant of VARIANTS) {
      test(`новое право: вставка перед </object> [${variant.name}]`, () => {
        const { rightsPath } = prepare(variant);
        const result = edit(rightsPath, [{ op: 'grant', object: 'РегистрСведений.МК_Курсы', rights: ['Update'] }]);
        assert.strictEqual(result.changed, true);
        assert.strictEqual(result.applied, 1);
        assert.deepStrictEqual([...result.changedFiles], [rightsPath]);
        const expected = baseBlocks();
        expected.objects[0].splice(expected.objects[0].length - 1, 0, ...rightLines('Update', 'true'));
        assert.strictEqual(readText(rightsPath), compose(expected, variant));
      });

      test(`смена значения права: меняется одна строка <value> [${variant.name}]`, () => {
        const { rightsPath } = prepare(variant);
        const result = edit(rightsPath, [{ op: 'grant', object: 'InformationRegister.МК_Курсы', rights: { Read: false } }]);
        assert.strictEqual(result.changed, true);
        const expected = baseBlocks();
        expected.objects[0][4] = '\t\t\t<value>false</value>';
        assert.strictEqual(readText(rightsPath), compose(expected, variant));
      });

      test(`новый объект: вставка перед первым restrictionTemplate [${variant.name}]`, () => {
        const { rightsPath } = prepare(variant);
        edit(rightsPath, [{ op: 'grant', object: 'Справочники.Новый', rights: ['Read'] }]);
        const expected = baseBlocks();
        expected.objects.push(objectLines('Catalog.Новый', [['Read', 'true']]));
        assert.strictEqual(readText(rightsPath), compose(expected, variant));
      });

      test(`revoke права и затем последнего права объекта: объект исчезает [${variant.name}]`, () => {
        const { rightsPath } = prepare(variant);
        edit(rightsPath, [{ op: 'revoke', object: 'РегистрСведений.МК_Курсы', rights: ['View'] }]);
        const afterView = baseBlocks();
        afterView.objects[0] = objectLines('InformationRegister.МК_Курсы', [['Read', 'true']]);
        assert.strictEqual(readText(rightsPath), compose(afterView, variant));

        edit(rightsPath, [{ op: 'revoke', object: 'РегистрСведений.МК_Курсы', rights: ['Read'] }]);
        const afterRead = baseBlocks();
        afterRead.objects.shift();
        assert.strictEqual(readText(rightsPath), compose(afterRead, variant));
      });

      test(`revoke объекта целиком [${variant.name}]`, () => {
        const { rightsPath } = prepare(variant);
        edit(rightsPath, [{ op: 'revoke', object: 'Catalog.А&Б' }]);
        const expected = baseBlocks();
        expected.objects.splice(1, 1);
        assert.strictEqual(readText(rightsPath), compose(expected, variant));
      });

      test(`setFlags: меняется только строка флага [${variant.name}]`, () => {
        const { rightsPath } = prepare(variant);
        const result = edit(rightsPath, [{ op: 'setFlags', flags: { independentRightsOfChildObjects: false } }]);
        assert.strictEqual(result.changed, true);
        assert.strictEqual(
          readText(rightsPath),
          compose(baseBlocks(), variant).replace(
            '<independentRightsOfChildObjects>true</independentRightsOfChildObjects>',
            '<independentRightsOfChildObjects>false</independentRightsOfChildObjects>',
          ),
        );
      });

      test(`шаблоны: добавление нового перед </Rights>, удаление, удаление отсутствующего [${variant.name}]`, () => {
        const { rightsPath } = prepare(variant);
        edit(rightsPath, [{ op: 'addTemplate', name: 'Т2', condition: 'ГДЕ Z < 2' }]);
        const withSecond = baseBlocks();
        withSecond.templates.push(templateLines('Т2', 'ГДЕ Z &lt; 2'));
        assert.strictEqual(readText(rightsPath), compose(withSecond, variant));

        edit(rightsPath, [{ op: 'removeTemplate', name: 'Т1' }]);
        const withoutFirst = baseBlocks();
        withoutFirst.templates = [templateLines('Т2', 'ГДЕ Z &lt; 2')];
        assert.strictEqual(readText(rightsPath), compose(withoutFirst, variant));

        const missing = edit(rightsPath, [{ op: 'removeTemplate', name: 'Нет' }]);
        assert.strictEqual(missing.changed, false);
        assert.ok(missing.warnings.some((warning) => warning.includes('Нет')), missing.warnings.join('; '));
      });
    }

    test('RLS на праве с <field>/<condition/>: условие задаётся, <field> целы; снятие возвращает исходные байты', () => {
      const { rightsPath, original } = prepare(REFERENCE_VARIANT);
      const set = edit(rightsPath, [{ op: 'setRls', object: 'Catalog.СБ_Терминалы', right: 'Read', condition: 'ГДЕ Х > 1' }]);
      assert.strictEqual(set.changed, true);
      const expected = baseBlocks();
      expected.objects[2][8] = '\t\t\t\t<condition>ГДЕ Х &gt; 1</condition>';
      assert.strictEqual(readText(rightsPath), compose(expected, REFERENCE_VARIANT));
      assert.ok(readText(rightsPath).includes('<field>Code</field>'));

      const cleared = edit(rightsPath, [{ op: 'setRls', object: 'Catalog.СБ_Терминалы', right: 'Read', condition: '' }]);
      assert.strictEqual(cleared.changed, true);
      assert.strictEqual(readText(rightsPath), original, 'круговая правка не оставляет следов');
    });

    test('эталонные свойства файла сохраняются после реальной правки: BOM, CRLF, xsi:type, нет хвостового перевода строки, &amp;', () => {
      const { rightsPath } = prepare(REFERENCE_VARIANT);
      edit(rightsPath, [{ op: 'grant', object: 'РегистрСведений.МК_Курсы', rights: ['Update'] }]);
      const text = readText(rightsPath);
      assert.strictEqual(text.charCodeAt(0), 0xfeff);
      assert.ok(!/(?<!\r)\n/.test(text), 'только CRLF');
      assert.ok(text.includes('xsi:type="Rights"'));
      assert.ok(text.endsWith('</Rights>'), 'хвостового перевода строки нет');
      assert.ok(text.includes('Catalog.А&amp;Б'));
    });
  });

  suite('строгие имена: ошибки останавливают пакет без записи', () => {
    test('неизвестный тип во втором операторе: первая валидная операция НЕ записана', () => {
      const { rightsPath, original } = prepare(REFERENCE_VARIANT);
      const result = edit(rightsPath, [
        { op: 'grant', object: 'Справочники.Новый', rights: ['Read'] },
        { op: 'grant', object: 'Foo.Bar', rights: ['Read'] },
      ]);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.changed, false);
      assert.strictEqual(result.applied, 0);
      assert.deepStrictEqual([...result.changedFiles], []);
      assert.ok(result.errors.some((error) => error.includes('Foo')), result.errors.join('; '));
      assert.strictEqual(readText(rightsPath), original);
    });

    test('Справочники.X.ИНН (атрибут без вида) — ошибка с подсказкой Реквизит.ИНН', () => {
      const { rightsPath, original } = prepare(REFERENCE_VARIANT);
      const result = edit(rightsPath, [{ op: 'grant', object: 'Справочники.X.ИНН', rights: ['View'] }]);
      assert.strictEqual(result.success, false);
      assert.ok(result.errors.some((error) => error.includes('Реквизит.ИНН')), result.errors.join('; '));
      assert.strictEqual(readText(rightsPath), original);
    });
  });

  suite('повреждённый файл и отсутствующий файл', () => {
    test('нет </Rights>: success:false без записи', () => {
      const root = newRoot('v8vscedit-rights-broken-');
      const broken = '<?xml version="1.0"?>\n<Rights xmlns="http://v8.1c.ru/8.2/roles">\n\t<object>\n';
      const rightsPath = writeRights(root, 'Битая', broken);
      const result = edit(rightsPath, [{ op: 'grant', object: 'Catalog.X', rights: ['Read'] }]);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.changed, false);
      assert.ok(result.errors.some((error) => error.includes('Не удалось распарсить Rights.xml')), result.errors.join('; '));
      assert.strictEqual(readText(rightsPath), broken);
    });

    test('файла нет: прежний текст ошибки', () => {
      const root = newRoot('v8vscedit-rights-missing-');
      const result = edit(path.join(root, 'Roles', 'Нет', 'Ext', 'Rights.xml'), [{ op: 'revoke', object: 'Catalog.X' }]);
      assert.strictEqual(result.success, false);
      assert.ok(result.errors[0].includes('Rights.xml не найден'));
    });
  });

  suite('на реальном Rights.xml эталона (МК_Контрагент: <field>, <condition/>, &amp;)', () => {
    const source = path.join(EXAMPLE_GENERATIONS.cf20, 'Roles', 'МК_Контрагент', 'Ext', 'Rights.xml');

    function copySource(): { rightsPath: string; original: string } {
      const root = newRoot('v8vscedit-rights-corpus-');
      const rightsPath = path.join(root, 'Roles', 'МК_Контрагент', 'Ext', 'Rights.xml');
      fs.mkdirSync(path.dirname(rightsPath), { recursive: true });
      fs.copyFileSync(source, rightsPath);
      return { rightsPath, original: readText(rightsPath) };
    }

    test('повтор первого выданного права: файл не меняется ни на байт', function () {
      this.timeout(120_000);
      if (!fs.existsSync(source)) {
        this.skip();
      }
      const { rightsPath, original } = copySource();
      const head = original.slice(0, 20_000);
      const match = /<name>([^<]+)<\/name>\s*<right>\s*<name>([^<]+)<\/name>\s*<value>true<\/value>/.exec(head);
      assert.ok(match, 'в начале файла есть объект с выданным правом');
      const [, objectName, rightName] = match;
      const mtimeBefore = fs.statSync(rightsPath).mtimeMs;
      const result = edit(rightsPath, [{ op: 'grant', object: objectName.replace(/&amp;/g, '&'), rights: [rightName] }]);
      assert.strictEqual(result.success, true, result.errors.join('; '));
      assert.strictEqual(result.changed, false);
      assert.strictEqual(result.applied, 0);
      assert.strictEqual(readText(rightsPath), original);
      assert.strictEqual(fs.statSync(rightsPath).mtimeMs, mtimeBefore);
    });

    test('RLS на праве с <field>/<condition/>: задать и снять — исходные байты', function () {
      this.timeout(120_000);
      if (!fs.existsSync(source)) {
        this.skip();
      }
      const { rightsPath, original } = copySource();
      assert.ok(original.includes('<condition/>'), 'эталон содержит <condition/>');
      const set = edit(rightsPath, [{ op: 'setRls', object: 'Catalog.СБ_Терминалы', right: 'Read', condition: 'ГДЕ Х > 1' }]);
      assert.strictEqual(set.changed, true, set.warnings.join('; '));
      assert.ok(readText(rightsPath).includes('<condition>ГДЕ Х &gt; 1</condition>'));
      assert.strictEqual(
        readText(rightsPath).split('<field>').length,
        original.split('<field>').length,
        'число <field> не изменилось',
      );
      const cleared = edit(rightsPath, [{ op: 'setRls', object: 'Catalog.СБ_Терминалы', right: 'Read', condition: '' }]);
      assert.strictEqual(cleared.changed, true);
      assert.strictEqual(readText(rightsPath), original);
    });

    test('revoke объекта целиком: результат равен исходнику без блока этого объекта', function () {
      this.timeout(120_000);
      if (!fs.existsSync(source)) {
        this.skip();
      }
      const { rightsPath, original } = copySource();
      const start = original.indexOf('\t<object>\r\n\t\t<name>Catalog.СБ_Терминалы</name>');
      assert.ok(start > 0, 'объект есть в эталоне');
      const endMarker = '\t</object>\r\n';
      const end = original.indexOf(endMarker, start) + endMarker.length;
      const result = edit(rightsPath, [{ op: 'revoke', object: 'Catalog.СБ_Терминалы' }]);
      assert.strictEqual(result.changed, true);
      assert.strictEqual(readText(rightsPath), original.slice(0, start) + original.slice(end));
    });
  });

  suite('масштаб', () => {
    test('200 000 объектов x 50 операций: итог совпадает с независимо собранным ожиданием', function () {
      this.timeout(300_000);
      const count = 200_000;
      const names = Array.from({ length: count }, (_, i) => `InformationRegister.Объект${String(i)}`);
      const blocks = names.map((name) => objectLines(name, [['Read', 'true']]));
      const render = (list: readonly string[][]): string => rightsFileText(list.flat(), REFERENCE_VARIANT);
      const { rightsPath } = (() => {
        const root = newRoot('v8vscedit-rights-large-');
        return { rightsPath: writeRights(root, 'Большая', render(blocks)) };
      })();

      const expected = blocks.map((block) => [...block]);
      const added: string[][] = [];
      const operations: RoleRightsEditOperation[] = [];
      for (let i = 0; i < 20; i += 1) {
        const index = i * 9_973 + 1;
        operations.push({ op: 'grant', object: names[index], rights: { Read: false } });
        expected[index] = objectLines(names[index], [['Read', 'false']]);
      }
      for (let i = 0; i < 10; i += 1) {
        const index = i * 10_007 + 5;
        operations.push({ op: 'grant', object: names[index], rights: ['Update'] });
        expected[index] = objectLines(names[index], [['Read', 'true'], ['Update', 'true']]);
      }
      for (let i = 0; i < 10; i += 1) {
        const index = i * 10_037 + 3;
        operations.push({ op: 'revoke', object: names[index] });
        expected[index] = [];
      }
      for (let i = 0; i < 10; i += 1) {
        operations.push({ op: 'grant', object: `Справочники.Новый${String(i)}`, rights: ['Read'] });
        added.push(objectLines(`Catalog.Новый${String(i)}`, [['Read', 'true']]));
      }
      assert.strictEqual(operations.length, 50);

      const result = edit(rightsPath, operations);
      assert.strictEqual(result.success, true, result.errors.join('; '));
      assert.strictEqual(result.changed, true);
      assert.strictEqual(result.applied, 50);
      assert.deepStrictEqual([...result.changedFiles], [rightsPath]);
      assert.strictEqual(readText(rightsPath), render([...expected, ...added]));
    });
  });
});
