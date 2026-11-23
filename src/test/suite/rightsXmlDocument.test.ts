import * as assert from 'assert';
import { parseRightsXmlDocument, type RightsXmlDocument } from '../../infra/xml/role/RightsXmlDocument';

/**
 * `RightsXmlDocument` — чистая модель Rights.xml для ТОЧЕЧНОЙ правки (splice по диапазонам):
 * нетронутые байты копируются как есть, внутри затронутого права меняется только нужный
 * поддиапазон, `<field>` и чужие теги целы. Ожидаемые результаты собираются независимо от
 * продакшн-рендера (из строк-образцов), поэтому тест фиксирует именно раскладку эталона.
 *
 * Матрица вариантов файла: {LF, CRLF} x {BOM, без BOM} x {хвостовой перевод строки, без}.
 * Эталон 2.20 — CRLF + BOM + без хвостового перевода строки у 826 из 826 файлов.
 */

interface Variant {
  readonly name: string;
  readonly eol: string;
  readonly bom: boolean;
  readonly trailing: boolean;
}

const VARIANTS: readonly Variant[] = ((): Variant[] => {
  const list: Variant[] = [];
  for (const eol of [String.fromCharCode(10), String.fromCharCode(13, 10)]) {
    for (const bom of [false, true]) {
      for (const trailing of [false, true]) {
        list.push({
          name: `${eol.length === 1 ? 'LF' : 'CRLF'}${bom ? '+BOM' : ''}${trailing ? '+хвост' : ''}`,
          eol,
          bom,
          trailing,
        });
      }
    }
  }
  return list;
})();

interface Parts {
  head: string[];
  objects: string[][];
  templates: string[][];
}

const ROOT_LINE = '<Rights xmlns="http://v8.1c.ru/8.2/roles" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Rights" version="2.20">';
const PROLOG = '<?xml version="1.0" encoding="UTF-8"?>';

const OBJ_BANKI = [
  '\t<object>',
  '\t\t<name>Catalog.Банки</name>',
  '\t\t<right>',
  '\t\t\t<name>Read</name>',
  '\t\t\t<value>true</value>',
  '\t\t\t<futureTag attr="1">v</futureTag>',
  '\t\t</right>',
  '\t\t<right>',
  '\t\t\t<name>View</name>',
  '\t\t\t<value>true</value>',
  '\t\t</right>',
  '\t</object>',
];
const OBJ_KURSY = [
  '\t<object>',
  '\t\t<name>InformationRegister.Курсы</name>',
  '\t\t<right>',
  '\t\t\t<name>Read</name>',
  '\t\t\t<value>true</value>',
  '\t\t\t<restrictionByCondition>',
  '\t\t\t\t<condition>ГДЕ А &lt; 5 &amp;&amp; Б',
  'ВТОРАЯ СТРОКА</condition>',
  '\t\t\t</restrictionByCondition>',
  '\t\t</right>',
  '\t</object>',
];
const termObject = (name: string, conditionLine: string): string[] => [
  '\t<object>',
  `\t\t<name>${name}</name>`,
  '\t\t<right>',
  '\t\t\t<name>Read</name>',
  '\t\t\t<value>true</value>',
  '\t\t\t<restrictionByCondition>',
  '\t\t\t\t<field>Code</field>',
  '\t\t\t\t<field>Ref</field>',
  conditionLine,
  '\t\t\t</restrictionByCondition>',
  '\t\t</right>',
  '\t</object>',
];
const OBJ_TERM = termObject('Catalog.СБ_Терминалы', '\t\t\t\t<condition/>');
const OBJ_TERM2 = termObject('Catalog.Терм2', '\t\t\t\t<condition>ГДЕ Б</condition>');
const OBJ_AMP = [
  '\t<object>',
  '\t\t<name>Catalog.А&amp;Б</name>',
  '\t\t<right>',
  '\t\t\t<name>Read</name>',
  '\t\t\t<value>true</value>',
  '\t\t</right>',
  '\t</object>',
];
const TPL1 = [
  '\t<restrictionTemplate>',
  '\t\t<name>Т1</name>',
  '\t\t<condition>ГДЕ X &lt; 1',
  'И Y</condition>',
  '\t</restrictionTemplate>',
];
const TPL2 = [
  '\t<restrictionTemplate>',
  '\t\t<name>Т2</name>',
  '\t\t<condition>ГДЕ Z</condition>',
  '\t</restrictionTemplate>',
];

const FLAGS = [
  '\t<setForNewObjects>false</setForNewObjects>',
  '\t<setForAttributesByDefault>true</setForAttributesByDefault>',
  '\t<independentRightsOfChildObjects>true</independentRightsOfChildObjects>',
];

const baseParts = (): Parts => ({
  head: [PROLOG, ROOT_LINE, ...FLAGS],
  objects: [OBJ_BANKI, OBJ_KURSY, OBJ_TERM, OBJ_TERM2, OBJ_AMP].map((block) => [...block]),
  templates: [TPL1, TPL2].map((block) => [...block]),
});

function compose(parts: Parts, variant: Variant): string {
  const lines = [...parts.head, ...parts.objects.flat(), ...parts.templates.flat(), '</Rights>'];
  return (variant.bom ? '\uFEFF' : '') + lines.join(variant.eol) + (variant.trailing ? variant.eol : '');
}

const rightBlock = (name: string, value: string, conditionLines?: string[]): string[] => [
  '\t\t<right>',
  `\t\t\t<name>${name}</name>`,
  `\t\t\t<value>${value}</value>`,
  ...(conditionLines ? ['\t\t\t<restrictionByCondition>', ...conditionLines, '\t\t\t</restrictionByCondition>'] : []),
  '\t\t</right>',
];

const objectBlock = (name: string, rights: string[][]): string[] => [
  '\t<object>',
  `\t\t<name>${name}</name>`,
  ...rights.flat(),
  '\t</object>',
];

function parseOk(text: string): RightsXmlDocument {
  const doc = parseRightsXmlDocument(text);
  if ('error' in doc) {
    throw new Error(`Документ должен разбираться: ${doc.error}`);
  }
  return doc;
}

/** Применяет операцию к документу и сверяет и признак «изменилось», и итоговый текст. */
function check(
  variant: Variant,
  before: Parts,
  apply: (doc: RightsXmlDocument) => boolean,
  after: Parts,
  expectChanged: boolean,
): void {
  const input = compose(before, variant);
  const doc = parseOk(input);
  const changed = apply(doc);
  assert.strictEqual(changed, expectChanged, 'признак «изменилось»');
  assert.strictEqual(doc.render(), compose(after, variant));
}

function forVariants(title: string, body: (variant: Variant) => void): void {
  for (const variant of VARIANTS) {
    test(`${title} [${variant.name}]`, () => {
      body(variant);
    });
  }
}

suite('Rights.xml: документ', () => {
  suite('разбор и render без правок', () => {
    forVariants('render() без операций равен входу байт-в-байт', (variant) => {
      const input = compose(baseParts(), variant);
      assert.strictEqual(parseOk(input).render(), input);
    });

    forVariants('операции-«ничего не менять» возвращают false и не меняют текст', (variant) => {
      const parts = baseParts();
      const input = compose(parts, variant);
      const doc = parseOk(input);
      assert.strictEqual(doc.setRight('Catalog.Банки', 'Read', 'true'), false);
      assert.strictEqual(doc.setRight('Catalog.Банки', 'View', 'true'), false);
      assert.strictEqual(doc.setCondition('InformationRegister.Курсы', 'Read', 'ГДЕ А < 5 && Б\nВТОРАЯ СТРОКА'), false, 'сравнение после unescape и нормализации EOL');
      assert.strictEqual(doc.setCondition('Catalog.Терм2', 'Read', 'ГДЕ Б'), false);
      assert.strictEqual(doc.setCondition('Catalog.СБ_Терминалы', 'Read', undefined), false, '<condition/> уже «пусто»');
      assert.strictEqual(doc.setCondition('Catalog.СБ_Терминалы', 'Read', ''), false);
      assert.strictEqual(doc.setCondition('Catalog.Банки', 'Read', undefined), false, 'условия и не было');
      assert.strictEqual(doc.setFlag('setForNewObjects', false), false);
      assert.strictEqual(doc.setFlag('setForAttributesByDefault', true), false);
      assert.strictEqual(doc.setFlag('independentRightsOfChildObjects', true), false);
      assert.strictEqual(doc.setTemplate('Т2', 'ГДЕ Z'), false);
      assert.strictEqual(doc.setTemplate('Т1', 'ГДЕ X < 1\nИ Y'), false);
      assert.strictEqual(doc.removeRight('Catalog.Банки', 'Insert'), false);
      assert.strictEqual(doc.removeRight('Catalog.Нет', 'Read'), false);
      assert.strictEqual(doc.removeObject('Catalog.Нет'), false);
      assert.strictEqual(doc.removeTemplate('Нет'), false);
      assert.strictEqual(doc.render(), input);
    });

    const errorCases: readonly { readonly name: string; readonly xml: string }[] = [
      { name: 'пустая строка', xml: '' },
      { name: 'не XML', xml: 'просто текст' },
      { name: 'нет корня Rights', xml: '<?xml version="1.0"?>\n<Other/>' },
      { name: 'самозакрытый корень <Rights/>', xml: '<?xml version="1.0"?>\n<Rights xmlns="http://v8.1c.ru/8.2/roles"/>' },
      { name: 'нет закрывающего </Rights>', xml: `${PROLOG}\n${ROOT_LINE}\n\t<setForNewObjects>false</setForNewObjects>\n` },
      { name: 'незакрытый <object>', xml: `${PROLOG}\n${ROOT_LINE}\n\t<object>\n\t\t<name>Catalog.А</name>\n</Rights>` },
    ];
    for (const c of errorCases) {
      test(`ошибка разбора: ${c.name} -> { error } без исключения`, () => {
        const result = parseRightsXmlDocument(c.xml);
        assert.ok('error' in result, 'ожидался результат с error');
        assert.ok(result.error.length > 0);
      });
    }
  });

  suite('getObjectRights', () => {
    test('права объекта: имя, значение, условие (после unescape); для <condition/> условие пустое', () => {
      const doc = parseOk(compose(baseParts(), VARIANTS[0]));
      assert.deepStrictEqual(
        doc.getObjectRights('Catalog.Банки')?.map((right) => ({ name: right.name, value: right.value })),
        [{ name: 'Read', value: 'true' }, { name: 'View', value: 'true' }],
      );
      const kursy = doc.getObjectRights('InformationRegister.Курсы');
      assert.strictEqual(kursy?.length, 1);
      assert.strictEqual(kursy[0].condition?.replace(/\r\n/g, '\n'), 'ГДЕ А < 5 && Б\nВТОРАЯ СТРОКА');
      const term = doc.getObjectRights('Catalog.СБ_Терминалы');
      assert.strictEqual(term?.length, 1);
      assert.ok(!term[0].condition, '<condition/> — пустое условие');
    });

    test('имя с сущностью в файле находится по обычному имени; отсутствующий объект — undefined', () => {
      const doc = parseOk(compose(baseParts(), VARIANTS[0]));
      assert.strictEqual(doc.getObjectRights('Catalog.А&Б')?.length, 1);
      assert.strictEqual(doc.getObjectRights('Catalog.Нет'), undefined);
    });

    test('дубли имени объекта: действует первое вхождение (и для чтения, и для правки)', () => {
      const dup = objectBlock('Catalog.Дубль', [rightBlock('Read', 'true')]);
      const dup2 = objectBlock('Catalog.Дубль', [rightBlock('Read', 'false')]);
      const parts: Parts = { head: [PROLOG, ROOT_LINE], objects: [dup, dup2], templates: [] };
      const doc = parseOk(compose(parts, VARIANTS[0]));
      assert.strictEqual(doc.getObjectRights('Catalog.Дубль')?.[0].value, 'true');
      assert.strictEqual(doc.setRight('Catalog.Дубль', 'Read', 'false'), true);
      assert.strictEqual(doc.render(), compose({ ...parts, objects: [dup2, dup2] }, VARIANTS[0]));
    });
  });

  suite('setRight', () => {
    forVariants('смена значения: меняется ровно строка <value> нужного права; чужой тег внутри права цел', (variant) => {
      const after = baseParts();
      after.objects[0][4] = '\t\t\t<value>false</value>';
      check(variant, baseParts(), (doc) => doc.setRight('Catalog.Банки', 'Read', 'false'), after, true);
    });

    forVariants('новое право существующего объекта: вставка перед строкой </object>', (variant) => {
      const after = baseParts();
      after.objects[0].splice(after.objects[0].length - 1, 0, ...rightBlock('Insert', 'true'));
      check(variant, baseParts(), (doc) => doc.setRight('Catalog.Банки', 'Insert', 'true'), after, true);
    });

    forVariants('новый объект: вставка перед первым <restrictionTemplate> (после последнего объекта), имя экранируется', (variant) => {
      const after = baseParts();
      after.objects.push(objectBlock('Catalog.Н&amp;Н', [rightBlock('Read', 'true')]));
      check(variant, baseParts(), (doc) => doc.setRight('Catalog.Н&Н', 'Read', 'true'), after, true);
    });

    forVariants('новый объект при отсутствии шаблонов: вставка перед </Rights>', (variant) => {
      const before = baseParts();
      before.templates = [];
      const after = baseParts();
      after.templates = [];
      after.objects.push(objectBlock('Catalog.Новый', [rightBlock('Read', 'true')]));
      check(variant, before, (doc) => doc.setRight('Catalog.Новый', 'Read', 'true'), after, true);
    });

    forVariants('новый объект в документе без объектов и шаблонов', (variant) => {
      const before: Parts = { head: [PROLOG, ROOT_LINE, ...FLAGS], objects: [], templates: [] };
      const after: Parts = { ...before, objects: [objectBlock('Catalog.А', [rightBlock('Read', 'true')])] };
      check(variant, before, (doc) => doc.setRight('Catalog.А', 'Read', 'true'), after, true);
    });

    forVariants('несколько прав нового объекта подряд: объект один, права в порядке вызовов', (variant) => {
      const before = baseParts();
      const after = baseParts();
      after.objects.push(objectBlock('Catalog.Н', [rightBlock('Read', 'true'), rightBlock('View', 'false')]));
      check(variant, before, (doc) => {
        const first = doc.setRight('Catalog.Н', 'Read', 'true');
        const second = doc.setRight('Catalog.Н', 'View', 'false');
        return first && second;
      }, after, true);
    });

    forVariants('объект с сущностью в имени в файле: правка находит его, дубликата не создаётся', (variant) => {
      const after = baseParts();
      after.objects[4][4] = '\t\t\t<value>false</value>';
      check(variant, baseParts(), (doc) => doc.setRight('Catalog.А&Б', 'Read', 'false'), after, true);
    });
  });

  suite('removeRight / removeObject', () => {
    forVariants('removeRight: блок права исчезает целиком, объект с остальными правами остаётся', (variant) => {
      const after = baseParts();
      after.objects[0].splice(7, 4);
      check(variant, baseParts(), (doc) => doc.removeRight('Catalog.Банки', 'View'), after, true);
    });

    forVariants('removeRight первого права: исчезает только его блок вместе с чужим тегом внутри', (variant) => {
      const after = baseParts();
      after.objects[0].splice(2, 5);
      check(variant, baseParts(), (doc) => doc.removeRight('Catalog.Банки', 'Read'), after, true);
    });

    forVariants('removeObject: исчезает блок объекта от начала строки до конца строки после </object>', (variant) => {
      const after = baseParts();
      after.objects.splice(1, 1);
      check(variant, baseParts(), (doc) => doc.removeObject('InformationRegister.Курсы'), after, true);
    });

    forVariants('removeObject последнего объекта и единственного шаблона-соседа не задевает шаблоны', (variant) => {
      const after = baseParts();
      after.objects.pop();
      check(variant, baseParts(), (doc) => doc.removeObject('Catalog.А&Б'), after, true);
    });
  });

  suite('setCondition', () => {
    forVariants('условие у права без условия: restrictionByCondition вставляется сразу после строки <value>', (variant) => {
      const after = baseParts();
      after.objects[0].splice(5, 0,
        '\t\t\t<restrictionByCondition>',
        '\t\t\t\t<condition>ГДЕ А = 1</condition>',
        '\t\t\t</restrictionByCondition>',
      );
      check(variant, baseParts(), (doc) => doc.setCondition('Catalog.Банки', 'Read', 'ГДЕ А = 1'), after, true);
    });

    forVariants('замена многострочного условия: внутренность <condition> заменена, обвязка цела', (variant) => {
      const after = baseParts();
      after.objects[1].splice(6, 2, '\t\t\t\t<condition>ГДЕ Новое</condition>');
      check(variant, baseParts(), (doc) => doc.setCondition('InformationRegister.Курсы', 'Read', 'ГДЕ Новое'), after, true);
    });

    forVariants('спецсимволы условия пишутся экранированными', (variant) => {
      const after = baseParts();
      after.objects[3].splice(8, 1, '\t\t\t\t<condition>А &lt; 1 &amp; Б &gt; 2</condition>');
      check(variant, baseParts(), (doc) => doc.setCondition('Catalog.Терм2', 'Read', 'А < 1 & Б > 2'), after, true);
    });

    forVariants('многострочное условие записывается с EOL файла', (variant) => {
      const after = baseParts();
      after.objects[3].splice(8, 1, '\t\t\t\t<condition>А', 'Б</condition>');
      check(variant, baseParts(), (doc) => doc.setCondition('Catalog.Терм2', 'Read', 'А\nБ'), after, true);
    });

    forVariants('очистка условия при наличии <field>: остаётся <condition/>, <field> целы', (variant) => {
      const after = baseParts();
      after.objects[3].splice(8, 1, '\t\t\t\t<condition/>');
      check(variant, baseParts(), (doc) => doc.setCondition('Catalog.Терм2', 'Read', undefined), after, true);
      check(variant, baseParts(), (doc) => doc.setCondition('Catalog.Терм2', 'Read', ''), after, true);
    });

    forVariants('очистка условия без <field>: блок restrictionByCondition удаляется целиком', (variant) => {
      const after = baseParts();
      after.objects[1].splice(5, 4);
      check(variant, baseParts(), (doc) => doc.setCondition('InformationRegister.Курсы', 'Read', undefined), after, true);
      check(variant, baseParts(), (doc) => doc.setCondition('InformationRegister.Курсы', 'Read', ''), after, true);
    });

    forVariants('<condition/> + непустое условие: раскрывается в <condition>…</condition>, <field> целы', (variant) => {
      const after = baseParts();
      after.objects[2].splice(8, 1, '\t\t\t\t<condition>ГДЕ Х</condition>');
      check(variant, baseParts(), (doc) => doc.setCondition('Catalog.СБ_Терминалы', 'Read', 'ГДЕ Х'), after, true);
    });

    forVariants('круговая правка: задать условие и снять его — байты как до начала', (variant) => {
      const input = compose(baseParts(), variant);
      const doc = parseOk(input);
      assert.strictEqual(doc.setCondition('Catalog.СБ_Терминалы', 'Read', 'ГДЕ Х'), true);
      assert.strictEqual(doc.setCondition('Catalog.СБ_Терминалы', 'Read', undefined), true);
      assert.strictEqual(doc.render(), input);
    });

    test('нет объекта или права — false, текст не меняется', () => {
      const input = compose(baseParts(), VARIANTS[0]);
      const doc = parseOk(input);
      assert.strictEqual(doc.setCondition('Catalog.Нет', 'Read', 'ГДЕ 1'), false);
      assert.strictEqual(doc.setCondition('Catalog.Банки', 'Insert', 'ГДЕ 1'), false);
      assert.strictEqual(doc.render(), input);
    });
  });

  suite('setFlag', () => {
    forVariants('смена значения существующего флага: меняется только его строка', (variant) => {
      const after = baseParts();
      after.head[4] = '\t<independentRightsOfChildObjects>false</independentRightsOfChildObjects>';
      check(variant, baseParts(), (doc) => doc.setFlag('independentRightsOfChildObjects', false), after, true);
    });

    forVariants('отсутствующие флаги вставляются в каноническом порядке независимо от порядка вызовов', (variant) => {
      const before: Parts = { head: [PROLOG, ROOT_LINE], objects: [objectBlock('Catalog.А', [rightBlock('Read', 'true')])], templates: [] };
      const after: Parts = { ...before, head: [PROLOG, ROOT_LINE, ...FLAGS] };
      check(variant, before, (doc) => {
        const a = doc.setFlag('independentRightsOfChildObjects', true);
        const b = doc.setFlag('setForNewObjects', false);
        const c = doc.setFlag('setForAttributesByDefault', true);
        return a && b && c;
      }, after, true);
    });

    forVariants('отсутствует один средний флаг: встаёт между соседями', (variant) => {
      const before: Parts = { head: [PROLOG, ROOT_LINE, FLAGS[0], FLAGS[2]], objects: [], templates: [] };
      const after: Parts = { ...before, head: [PROLOG, ROOT_LINE, ...FLAGS] };
      check(variant, before, (doc) => doc.setFlag('setForAttributesByDefault', true), after, true);
    });
  });

  suite('setTemplate / removeTemplate', () => {
    forVariants('новый шаблон: вставка перед </Rights> после последнего шаблона, значения экранируются', (variant) => {
      const after = baseParts();
      after.templates.push([
        '\t<restrictionTemplate>',
        '\t\t<name>Т&amp;3</name>',
        '\t\t<condition>ГДЕ A &lt; &amp;P</condition>',
        '\t</restrictionTemplate>',
      ]);
      check(variant, baseParts(), (doc) => doc.setTemplate('Т&3', 'ГДЕ A < &P'), after, true);
    });

    forVariants('новый шаблон при отсутствии прочих: перед </Rights>', (variant) => {
      const before: Parts = { head: [PROLOG, ROOT_LINE, ...FLAGS], objects: [OBJ_AMP], templates: [] };
      const after: Parts = { ...before, templates: [TPL2] };
      check(variant, before, (doc) => doc.setTemplate('Т2', 'ГДЕ Z'), after, true);
    });

    forVariants('смена условия шаблона: заменяется внутренность <condition> (в т.ч. многострочная)', (variant) => {
      const after = baseParts();
      after.templates[0].splice(2, 2, '\t\t<condition>ГДЕ Новое</condition>');
      check(variant, baseParts(), (doc) => doc.setTemplate('Т1', 'ГДЕ Новое'), after, true);
    });

    forVariants('removeTemplate: исчезает блок шаблона целиком', (variant) => {
      const after = baseParts();
      after.templates.shift();
      check(variant, baseParts(), (doc) => doc.removeTemplate('Т1'), after, true);
    });
  });

  suite('масштаб: правка не зависит от размера файла по форме результата', () => {
    test('20 000 объектов x 50 операций: итог совпадает с независимо собранным ожиданием', function () {
      this.timeout(120_000);
      const count = 20_000;
      const names = Array.from({ length: count }, (_, i) => `InformationRegister.Объект${String(i)}`);
      const blocks = names.map((name) => objectBlock(name, [rightBlock('Read', 'true')]));
      const variant: Variant = { name: 'LF', eol: '\n', bom: false, trailing: true };
      const compose20k = (list: readonly string[][]): string => compose(
        { head: [PROLOG, ROOT_LINE, ...FLAGS], objects: [...list], templates: [] },
        variant,
      );
      const doc = parseOk(compose20k(blocks));

      const expected = blocks.map((block) => [...block]);
      const added: string[][] = [];
      // 20 смен значения, 10 новых прав, 10 удалений объектов, 10 новых объектов
      for (let i = 0; i < 20; i += 1) {
        const index = i * 997 + 1;
        assert.strictEqual(doc.setRight(names[index], 'Read', 'false'), true);
        expected[index] = objectBlock(names[index], [rightBlock('Read', 'false')]);
      }
      for (let i = 0; i < 10; i += 1) {
        const index = i * 1009 + 5;
        assert.strictEqual(doc.setRight(names[index], 'Update', 'true'), true);
        expected[index] = objectBlock(names[index], [rightBlock('Read', 'true'), rightBlock('Update', 'true')]);
      }
      for (let i = 0; i < 10; i += 1) {
        const index = i * 1013 + 3;
        assert.strictEqual(doc.removeObject(names[index]), true);
        expected[index] = [];
      }
      for (let i = 0; i < 10; i += 1) {
        assert.strictEqual(doc.setRight(`Catalog.Новый${String(i)}`, 'Read', 'true'), true);
        added.push(objectBlock(`Catalog.Новый${String(i)}`, [rightBlock('Read', 'true')]));
      }
      assert.strictEqual(doc.render(), compose20k([...expected, ...added]));
    });
  });

  suite('нештатные раскладки и ошибки структуры', () => {
    const NL = '\n';
    const xmlOf = (...lines: string[]): string => [PROLOG, ROOT_LINE, ...lines, '</Rights>'].join(NL);
    const obj = (name: string, ...rights: string[][]): string[] => objectBlock(name, rights);
    const messageOf = (action: () => unknown): string => {
      try {
        action();
      } catch (error) {
        return (error as Error).message;
      }
      return assert.fail('ожидалось исключение');
    };

    test('открывающий тег <Rights> без закрывающей скобки -> { error }', () => {
      const result = parseRightsXmlDocument('<Rights xmlns="http://v8.1c.ru/8.2/roles"');
      assert.ok('error' in result);
      assert.match(result.error, /Открывающий тег <Rights> не закрыт/);
    });

    test('литерал <restrictionTemplate> внутри объекта не считается шаблоном, настоящий шаблон после него находится', () => {
      const input = xmlOf('\t<object>', '\t\t<name>Catalog.А</name>', '\t\t<restrictionTemplate>', '\t</object>', ...TPL2);
      const doc = parseOk(input);
      assert.deepStrictEqual(doc.objectNames(), ['Catalog.А']);
      assert.strictEqual(doc.setTemplate('Т2', 'ГДЕ Z'), false, 'настоящий шаблон найден по имени');
      assert.strictEqual(doc.render(), input);
    });

    test('литерал <object> внутри шаблона не считается объектом, настоящий объект после шаблона находится', () => {
      const input = xmlOf('\t<restrictionTemplate>', '\t\t<name>Т1</name>', '\t\t<object>', '\t\t<condition>ГДЕ X</condition>', '\t</restrictionTemplate>', ...OBJ_AMP);
      const doc = parseOk(input);
      assert.deepStrictEqual(doc.objectNames(), ['Catalog.А&Б']);
      assert.strictEqual(doc.setTemplate('Т1', 'ГДЕ X'), false);
      assert.strictEqual(doc.render(), input);
    });

    test('хвостовые пробелы после </object> уходят вместе со строкой при removeObject', () => {
      const input = xmlOf('\t<object>', '\t\t<name>Catalog.А</name>', '\t</object>   ', ...OBJ_AMP);
      const doc = parseOk(input);
      assert.strictEqual(doc.removeObject('Catalog.А'), true);
      assert.strictEqual(doc.render(), xmlOf(...OBJ_AMP));
    });

    test('чужое содержимое между блоками и перед </Rights> сохраняется; тег, за которым на строке есть текст, режется по самому тегу', () => {
      const input = xmlOf(
        '\t<object>', '\t\t<name>Catalog.А</name>', '\t</object><!-- хвост -->',
        '\t<!-- между -->',
        ...OBJ_AMP,
        '\t<!-- перед закрытием -->',
      );
      const doc = parseOk(input);
      assert.strictEqual(doc.render(), input);
      assert.strictEqual(doc.removeObject('Catalog.А'), true);
      assert.strictEqual(
        doc.render(),
        xmlOf('<!-- хвост -->', '\t<!-- между -->', ...OBJ_AMP, '\t<!-- перед закрытием -->'),
      );
    });

    test('объекты без имени и с незакрытым <name>: имя пустое, остальные имена читаются', () => {
      const input = xmlOf(
        '\t<object>', '\t</object>',
        '\t<object>', '\t\t<name>Catalog.В', '\t</object>',
        ...obj('Catalog.Г', rightBlock('Read', 'true')),
        '\t<object>', '\t\t<name>Д', '\t</object>',
      );
      assert.deepStrictEqual(parseOk(input).objectNames(), ['', 'Catalog.Г']);
    });

    test('право без <value>: чтение даёт пустое значение, правка значения и условия — понятная ошибка', () => {
      const noValue = ['\t\t<right>', '\t\t\t<name>Read</name>', '\t\t</right>'];
      const doc = parseOk(xmlOf(...obj('Catalog.А', noValue, rightBlock('View', 'true'))));
      assert.deepStrictEqual(
        doc.getObjectRights('Catalog.А')?.map((right) => [right.name, right.value]),
        [['Read', ''], ['View', 'true']],
      );
      assert.match(messageOf(() => doc.setRight('Catalog.А', 'Read', 'true')), /У права Read объекта Catalog\.А нет элемента <value>/);
      assert.match(messageOf(() => doc.setCondition('Catalog.А', 'Read', 'ГДЕ 1')), /У права Read нет элемента <value>/);
    });

    test('<value> без закрывающего тега в праве: значение не берётся из соседнего права', () => {
      const input = xmlOf(
        '\t<object>', '\t\t<name>Catalog.А</name>',
        '\t\t<right>', '\t\t\t<name>Read</name>', '\t\t\t<value>true', '\t\t</right>',
        ...rightBlock('View', 'false'),
        '\t</object>',
      );
      assert.deepStrictEqual(
        parseOk(input).getObjectRights('Catalog.А')?.map((right) => [right.name, right.value]),
        [['Read', ''], ['View', 'false']],
      );
    });

    test('незакрытый <right> (нет </right> или перед ним новый <right>) -> исключение с именем объекта', () => {
      const noClose = parseOk(xmlOf('\t<object>', '\t\t<name>Catalog.А</name>', '\t\t<right>', '\t\t\t<name>Read</name>', '\t</object>'));
      assert.match(messageOf(() => noClose.getObjectRights('Catalog.А')), /Незакрытый <right> в объекте Catalog\.А/);
      const nested = parseOk(xmlOf('\t<object>', '\t\t<name>Catalog.Б</name>', '\t\t<right>', '\t\t<right>', '\t\t</right>', '\t</object>'));
      assert.match(messageOf(() => nested.removeRight('Catalog.Б', 'Read')), /Незакрытый <right> в объекте Catalog\.Б/);
    });

    test('незакрытый <restrictionByCondition> -> исключение', () => {
      const input = xmlOf('\t<object>', '\t\t<name>Catalog.А</name>', '\t\t<right>', '\t\t\t<name>Read</name>', '\t\t\t<value>true</value>', '\t\t\t<restrictionByCondition>', '\t\t</right>', '\t</object>');
      assert.match(messageOf(() => parseOk(input).getObjectRights('Catalog.А')), /Незакрытый <restrictionByCondition>/);
    });

    test('условия соседних прав одного объекта не путаются: нет ограничения / условие / <condition/> / только <field>', () => {
      const restricted = (name: string, ...inner: string[]): string[] => rightBlock(name, 'true', inner);
      const input = xmlOf(...obj(
        'Catalog.А',
        rightBlock('Read', 'true'),
        restricted('View', '\t\t\t\t<condition>ГДЕ 1</condition>'),
        restricted('Insert', '\t\t\t\t<field>Code</field>', '\t\t\t\t<condition/>'),
        restricted('Update', '\t\t\t\t<field>Code</field>'),
        restricted('Delete', '\t\t\t\t<condition/>', '\t\t\t\t<condition>после пустого</condition>'),
      ));
      const doc = parseOk(input);
      assert.deepStrictEqual(
        doc.getObjectRights('Catalog.А')?.map((right) => right.condition),
        [undefined, 'ГДЕ 1', '', '', ''],
      );
      assert.strictEqual(doc.setCondition('Catalog.А', 'Update', ''), false, 'условия не было — менять нечего');
      assert.strictEqual(doc.setCondition('Catalog.А', 'Update', 'ГДЕ 5'), true);
      assert.strictEqual(doc.getObjectRights('Catalog.А')?.find((right) => right.name === 'Update')?.condition, 'ГДЕ 5');
      assert.ok(
        doc.render().includes(['\t\t\t\t<field>Code</field>', '\t\t\t\t<condition>ГДЕ 5</condition>', '\t\t\t</restrictionByCondition>'].join(NL)),
        'условие встало после <field>, перед закрытием блока',
      );
    });

    test('право в одну строку: условие вставляется с переводом строки, результат разбирается заново', () => {
      const input = xmlOf('\t<object>', '\t\t<name>Catalog.А</name>', '\t\t<right><name>Read</name><value>true</value></right>', '\t</object>');
      const doc = parseOk(input);
      assert.strictEqual(doc.setCondition('Catalog.А', 'Read', 'ГДЕ 1'), true);
      const reparsed = parseOk(doc.render());
      assert.strictEqual(reparsed.getObjectRights('Catalog.А')?.[0].condition, 'ГДЕ 1');
      assert.strictEqual(reparsed.getObjectRights('Catalog.А')?.[0].value, 'true');
    });

    test('объект в одну строку: новое право уходит на новую строку, результат разбирается заново', () => {
      const doc = parseOk(xmlOf('\t<object><name>Catalog.А</name></object>'));
      assert.strictEqual(doc.setRight('Catalog.А', 'Read', 'true'), true);
      const reparsed = parseOk(doc.render());
      assert.deepStrictEqual(reparsed.getObjectRights('Catalog.А')?.map((right) => [right.name, right.value]), [['Read', 'true']]);
    });

    test('шаблон без <condition> или с незакрытым <condition> -> исключение, текст не меняется', () => {
      for (const body of [['\t\t<name>Т</name>'], ['\t\t<name>Т</name>', '\t\t<condition>ГДЕ X']]) {
        const input = xmlOf('\t<restrictionTemplate>', ...body, '\t</restrictionTemplate>');
        const doc = parseOk(input);
        assert.match(messageOf(() => doc.setTemplate('Т', 'ГДЕ Y')), /У шаблона ограничения Т нет элемента <condition>/);
        assert.strictEqual(doc.render(), input);
      }
    });

    test('флаг в документе, где корень и </Rights> на одной строке: вставка с переводом строки', () => {
      const doc = parseOk(`${PROLOG}${NL}${ROOT_LINE}</Rights>`);
      assert.strictEqual(doc.setFlag('setForNewObjects', false), true);
      assert.strictEqual(doc.render(), xmlOf('\t<setForNewObjects>false</setForNewObjects>'));
    });

    test('дубли имени: после removeObject действующим становится следующее вхождение, потом объект исчезает', () => {
      const first = obj('Catalog.Дубль', rightBlock('Read', 'true'));
      const second = obj('Catalog.Дубль', rightBlock('Read', 'false'));
      const doc = parseOk(xmlOf(...first, ...second));
      assert.strictEqual(doc.removeObject('Catalog.Дубль'), true);
      assert.strictEqual(doc.getObjectRights('Catalog.Дубль')?.[0].value, 'false');
      assert.deepStrictEqual(doc.objectNames(), ['Catalog.Дубль']);
      assert.strictEqual(doc.render(), xmlOf(...second));
      assert.strictEqual(doc.removeObject('Catalog.Дубль'), true);
      assert.strictEqual(doc.removeObject('Catalog.Дубль'), false);
      assert.strictEqual(doc.render(), xmlOf());
    });
  });

  suite('BOM и хвост сохраняются при правках', () => {
    for (const variant of VARIANTS) {
      test(`после правки BOM/EOL/хвост те же [${variant.name}]`, () => {
        const doc = parseOk(compose(baseParts(), variant));
        doc.setRight('Catalog.Банки', 'Read', 'false');
        doc.setTemplate('Т9', 'ГДЕ 9');
        doc.removeObject('Catalog.Терм2');
        const out = doc.render();
        assert.strictEqual(out.charCodeAt(0) === 0xfeff, variant.bom);
        assert.strictEqual(out.endsWith(`</Rights>${variant.eol}`), variant.trailing);
        assert.strictEqual(/(?<!\r)\n/.test(out.replace(/^\uFEFF/, '')), variant.eol === '\n');
        assert.ok(variant.eol === '\r\n' ? !/(?<!\r)\n/.test(out) : !out.includes('\r'));
      });
    }
  });
});
