import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DataCompositionSchemaService,
  MxlTemplateService,
} from '../../infra/xml';
import { removeTreeSync } from './support/tempTree';

suite('MxlTemplateService и DataCompositionSchemaService', () => {
  test('компилирует, анализирует, декомпилирует и валидирует MXL', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-mxl-'));
    const templatePath = path.join(root, 'Печать', 'Ext', 'Template.xml');
    const service = new MxlTemplateService();

    const compile = service.compile({
      outputPath: templatePath,
      definition: {
        columns: 4,
        page: 'A4-portrait',
        columnWidths: { '1': 40, '2-4': '1x' },
        fonts: { default: { face: 'Arial', size: 10 }, header: { face: 'Arial', size: 12, bold: true } },
        styles: {
          header: { font: 'header', align: 'center', border: 'all', wrap: true },
          cell: { border: 'all' },
        },
        areas: [
          {
            name: 'Шапка',
            rows: [
              { cells: [{ col: 1, span: 4, style: 'header', text: 'Счёт [Номер]' }] },
            ],
          },
          {
            name: 'Строка',
            rows: [
              { cells: [{ col: 1, style: 'cell', param: 'Номенклатура', detail: 'Товар' }, { col: 2, style: 'cell', param: 'Количество' }] },
            ],
          },
        ],
      },
    });

    assert.ok(fs.existsSync(templatePath));
    assert.strictEqual(compile.rows, 2);

    const info = service.info({ templatePath: path.dirname(path.dirname(templatePath)), withText: true });
    assert.strictEqual(info.columns, 4);
    assert.strictEqual(info.areas.length, 2);
    assert.ok(info.lines.some((line) => line.includes('Номенклатура')));
    assert.ok(info.areas[0].params.includes('Номер [tpl]'));

    const validation = service.validate({ templatePath });
    assert.strictEqual(validation.errors, 0);

    const dsl = service.decompile({ templatePath });
    assert.strictEqual(dsl.columns, 4);
    assert.strictEqual(dsl.areas[1].name, 'Строка');
  });

  test('дескриптор макета: info/validate/compile работают с ТЕЛОМ, дескриптор остаётся байт-в-байт', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-mxl-descriptor-'));
    try {
      const descriptor = path.join(root, 'Templates', 'Печать.xml');
      const body = path.join(root, 'Templates', 'Печать', 'Ext', 'Template.xml');
      fs.mkdirSync(path.dirname(descriptor), { recursive: true });
      const descriptorXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<MetaDataObject><Template><Properties><Name>Печать</Name><TemplateType>SpreadsheetDocument</TemplateType></Properties></Template></MetaDataObject>',
        '',
      ].join('\n');
      fs.writeFileSync(descriptor, descriptorXml, 'utf-8');
      const service = new MxlTemplateService();
      const definition = { columns: 1, areas: [{ name: 'Шапка', rows: [{ cells: [{ col: 1, text: 'Тест' }] }] }] };

      const compiled = service.compile({ outputPath: descriptor, definition });
      assert.strictEqual(compiled.templatePath, body);
      assert.deepStrictEqual([...compiled.changedFiles], [body]);
      assert.strictEqual(fs.readFileSync(descriptor, 'utf-8'), descriptorXml);

      assert.strictEqual(service.info({ templatePath: descriptor }).templatePath, body);
      assert.strictEqual(service.info({ templatePath: descriptor }).name, 'Печать');
      assert.strictEqual(service.validate({ templatePath: descriptor }).templatePath, body);
    } finally {
      removeTreeSync(root);
    }
  });

  test('компилирует, редактирует, анализирует и валидирует СКД', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-skd-'));
    const templatePath = path.join(root, 'ОсновнаяСхема', 'Ext', 'Template.xml');
    const service = new DataCompositionSchemaService();

    service.compile({
      outputPath: templatePath,
      definition: {
        dataSets: [
          {
            name: 'Продажи',
            query: 'ВЫБРАТЬ Товары.Ссылка КАК Номенклатура ИЗ Справочник.Товары КАК Товары',
            fields: ['Номенклатура [Номенклатура]: CatalogRef.Товары @dimension'],
          },
        ],
        parameters: ['Период [Период]: StandardPeriod @autoDates'],
        totalFields: ['Количество: Сумма'],
        settingsVariants: [{ name: 'Основной', selection: ['Номенклатура'], structure: 'Номенклатура > details', dataParameters: 'auto' }],
      },
    });

    const edit = service.edit({
      templatePath: path.dirname(path.dirname(templatePath)),
      operation: 'add-field',
      value: 'Количество: decimal(15,3)',
      dataSet: 'Продажи',
    });
    assert.strictEqual(edit.changedFiles.length, 1);

    service.edit({
      templatePath,
      operation: 'add-calculated-field',
      value: 'Сумма: decimal(15,2) = Количество * 10',
    });
    service.edit({
      templatePath,
      operation: 'add-parameter',
      value: 'Организация: CatalogRef.Организации',
    });
    service.edit({
      templatePath,
      operation: 'set-query',
      value: 'ВЫБРАТЬ 1 КАК Номенклатура',
      dataSet: 'Продажи',
    });

    const info = service.info({ templatePath, mode: 'full' });
    assert.ok(info.dataSets[0].fields.some((field) => field.dataPath === 'Количество'));
    assert.ok(info.calculatedFields.some((field) => field.dataPath === 'Сумма'));
    assert.ok(info.parameters.some((param) => param.name === 'Организация'));
    assert.ok(info.lines.some((line) => line.includes('Наборы данных: 1')));

    const validation = service.validate({ templatePath });
    assert.strictEqual(validation.errors, 0);
  });
});
