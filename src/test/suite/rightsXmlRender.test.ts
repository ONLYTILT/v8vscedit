import * as assert from 'assert';
import { serializeRightsXml, type SerializableRoleRights } from '../../infra/role/RoleRightsXml';
import { buildEmptyRightsXml } from '../../infra/xml/creator/auxiliaryFileBuilders';
import {
  renderObjectBlock,
  renderRightBlock,
  renderRightsDocument,
  renderTemplateBlock,
} from '../../infra/xml/role/RightsXmlRender';

/**
 * Рендер блоков Rights.xml: единственное место, где живёт текстовая раскладка прав
 * (табы как в эталоне, EOL задаётся вызывающим). `serializeRightsXml` (compile_role) и точечная
 * вставка `RightsXmlDocument` (edit_role) обязаны давать БАЙТ-В-БАЙТ одинаковые блоки.
 */

const EOLS: readonly { readonly name: string; readonly eol: string }[] = [
  { name: 'LF', eol: '\n' },
  { name: 'CRLF', eol: '\r\n' },
];

const join = (eol: string, lines: readonly string[]): string => lines.map((line) => line + eol).join('');

suite('Rights.xml: рендер', () => {
  for (const { name, eol } of EOLS) {
    suite(`EOL ${name}`, () => {
      test('право без условия: три строки внутри <right>, значение true', () => {
        assert.strictEqual(
          renderRightBlock({ name: 'Read', value: 'true' }, eol),
          join(eol, ['\t\t<right>', '\t\t\t<name>Read</name>', '\t\t\t<value>true</value>', '\t\t</right>']),
        );
      });

      test('право со значением false', () => {
        assert.strictEqual(
          renderRightBlock({ name: 'Edit', value: 'false' }, eol),
          join(eol, ['\t\t<right>', '\t\t\t<name>Edit</name>', '\t\t\t<value>false</value>', '\t\t</right>']),
        );
      });

      test('право с RLS-условием: restrictionByCondition, спецсимволы экранированы', () => {
        assert.strictEqual(
          renderRightBlock({ name: 'Read', value: 'true', condition: 'ГДЕ А < 5 И Б > 3 И В = &Параметр' }, eol),
          join(eol, [
            '\t\t<right>',
            '\t\t\t<name>Read</name>',
            '\t\t\t<value>true</value>',
            '\t\t\t<restrictionByCondition>',
            '\t\t\t\t<condition>ГДЕ А &lt; 5 И Б &gt; 3 И В = &amp;Параметр</condition>',
            '\t\t\t</restrictionByCondition>',
            '\t\t</right>',
          ]),
        );
      });

      test('пустое условие не порождает restrictionByCondition', () => {
        assert.strictEqual(
          renderRightBlock({ name: 'Read', value: 'true', condition: '' }, eol),
          renderRightBlock({ name: 'Read', value: 'true' }, eol),
        );
      });

      test('объект: имя экранируется, права идут в заданном порядке, блок оканчивается переводом строки', () => {
        assert.strictEqual(
          renderObjectBlock({
            name: 'Catalog.А&Б',
            rights: [{ name: 'Read', value: 'true' }, { name: 'Update', value: 'false' }],
          }, eol),
          join(eol, [
            '\t<object>',
            '\t\t<name>Catalog.А&amp;Б</name>',
            '\t\t<right>',
            '\t\t\t<name>Read</name>',
            '\t\t\t<value>true</value>',
            '\t\t</right>',
            '\t\t<right>',
            '\t\t\t<name>Update</name>',
            '\t\t\t<value>false</value>',
            '\t\t</right>',
            '\t</object>',
          ]),
        );
      });

      test('объект без прав: только имя', () => {
        assert.strictEqual(
          renderObjectBlock({ name: 'Catalog.Пусто', rights: [] }, eol),
          join(eol, ['\t<object>', '\t\t<name>Catalog.Пусто</name>', '\t</object>']),
        );
      });

      test('шаблон ограничения: имя и условие экранированы', () => {
        assert.strictEqual(
          renderTemplateBlock({ name: 'Для(А&Б)', condition: 'ГДЕ X < &P' }, eol),
          join(eol, [
            '\t<restrictionTemplate>',
            '\t\t<name>Для(А&amp;Б)</name>',
            '\t\t<condition>ГДЕ X &lt; &amp;P</condition>',
            '\t</restrictionTemplate>',
          ]),
        );
      });

      test('документ: xsi:type="Rights" в корне, порядок флагов и блоков, хвостовой перевод строки', () => {
        const rights: SerializableRoleRights = {
          setForNewObjects: true,
          setForAttributesByDefault: false,
          independentRightsOfChildObjects: true,
          objects: [{ name: 'Catalog.А', rights: [{ name: 'Read', value: 'true' }] }],
          templates: [{ name: 'Шаблон', condition: 'ГДЕ 1' }],
          formatVersion: '2.21',
        };
        assert.strictEqual(
          renderRightsDocument(rights, eol),
          join(eol, [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<Rights xmlns="http://v8.1c.ru/8.2/roles" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Rights" version="2.21">',
            '\t<setForNewObjects>true</setForNewObjects>',
            '\t<setForAttributesByDefault>false</setForAttributesByDefault>',
            '\t<independentRightsOfChildObjects>true</independentRightsOfChildObjects>',
            '\t<object>',
            '\t\t<name>Catalog.А</name>',
            '\t\t<right>',
            '\t\t\t<name>Read</name>',
            '\t\t\t<value>true</value>',
            '\t\t</right>',
            '\t</object>',
            '\t<restrictionTemplate>',
            '\t\t<name>Шаблон</name>',
            '\t\t<condition>ГДЕ 1</condition>',
            '\t</restrictionTemplate>',
            '</Rights>',
          ]),
        );
      });
    });
  }

  test('блоки внутри документа — ровно те же строки, что отдают renderObjectBlock/renderTemplateBlock', () => {
    const object = { name: 'Document.Д', rights: [{ name: 'Read', value: 'true' as const, condition: 'ГДЕ А = 1' }] };
    const template = { name: 'Т', condition: 'ГДЕ 2' };
    const document = renderRightsDocument({
      setForNewObjects: false,
      setForAttributesByDefault: true,
      independentRightsOfChildObjects: false,
      objects: [object],
      templates: [template],
      formatVersion: '2.20',
    }, '\n');
    assert.ok(document.includes(renderObjectBlock(object, '\n')));
    assert.ok(document.includes(renderTemplateBlock(template, '\n')));
  });

  test('документ без объектов совпадает с эталонной заготовкой пустой роли (buildEmptyRightsXml)', () => {
    assert.strictEqual(
      renderRightsDocument({
        setForNewObjects: false,
        setForAttributesByDefault: true,
        independentRightsOfChildObjects: false,
        objects: [],
        templates: [],
        formatVersion: '2.21',
      }, '\n'),
      buildEmptyRightsXml('2.21'),
    );
  });

  test('документ: версия формата экранируется как значение атрибута', () => {
    const xml = renderRightsDocument({
      setForNewObjects: false,
      setForAttributesByDefault: true,
      independentRightsOfChildObjects: false,
      objects: [],
      templates: [],
      formatVersion: '2.2"1',
    }, '\n');
    assert.ok(xml.includes('version="2.2&quot;1"'), xml);
  });

  test('документ без BOM и с хвостовым переводом строки (новый файл, golden metadataXmlCreatorGolden)', () => {
    const xml = renderRightsDocument({
      setForNewObjects: false,
      setForAttributesByDefault: true,
      independentRightsOfChildObjects: false,
      objects: [],
      templates: [],
      formatVersion: '2.20',
    }, '\n');
    assert.notStrictEqual(xml.charCodeAt(0), 0xfeff);
    assert.ok(xml.endsWith('</Rights>\n'));
  });

  test('serializeRightsXml (compile_role) делегирует рендеру: байт-в-байт и с xsi:type', () => {
    const rights: SerializableRoleRights = {
      setForNewObjects: false,
      setForAttributesByDefault: true,
      independentRightsOfChildObjects: false,
      objects: [
        { name: 'InformationRegister.Курсы', rights: [{ name: 'Read', value: 'true', condition: 'ГДЕ Валюта = &В' }, { name: 'View', value: 'true' }] },
        { name: 'Catalog.Банки.Attribute.БИК', rights: [{ name: 'View', value: 'false' }] },
      ],
      templates: [{ name: 'Для(Мод)', condition: 'ГДЕ Орг = &О' }],
      formatVersion: '2.21',
    };
    const serialized = serializeRightsXml(rights);
    assert.strictEqual(serialized, renderRightsDocument(rights, '\n'));
    assert.ok(serialized.includes('xsi:type="Rights"'));
  });
});
