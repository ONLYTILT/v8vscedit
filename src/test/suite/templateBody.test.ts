import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataCompositionSchemaService, MxlTemplateService } from '../../infra/xml';
import {
  assertTemplateBodyRoot,
  readTemplateBody,
  resolveExistingTemplateBody,
} from '../../infra/xml/TemplateXml';
import { rootLocalNamePattern, sliceToRootElement } from '../../infra/xml/XmlUtils';
import { MXL_DEFINITION, SKD_DEFINITION } from './support/mcpTemplateToolsHarness';
import { removeTreeSync } from './support/tempTree';

/**
 * Сервисы макетов работают с ТЕЛОМ `…/Ext/Template.xml`, а не с дескриптором.
 *
 * Дефект: узел макета несёт дескриптор `Templates/<Имя>.xml`; сервисы принимали его за тело
 * (подмена пути — только при ОТСУТСТВИИ входного файла), а `compile_*` писали содержимое
 * прямо в дескриптор и затирали метаданные макета. Тесты параметризованы по обоим сервисам
 * (MXL и СКД) и по всем формам входного пути (каталог макета, тело, дескриптор).
 */

const ADD_TEMPLATE_HINT = 'v8vscedit_add_template';
const MISSING_BODY = 'Тело макета (Ext/Template.xml) не найдено';

function descriptorXml(name: string, templateType: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.20">',
    '\t<Template uuid="11111111-2222-3333-4444-555555555555">',
    '\t\t<Properties>',
    `\t\t\t<Name>${name}</Name>`,
    `\t\t\t<TemplateType>${templateType}</TemplateType>`,
    '\t\t</Properties>',
    '\t</Template>',
    '</MetaDataObject>',
    '',
  ].join('\n');
}

interface TemplateMethodCase {
  readonly name: string;
  /** Запускает метод по входному пути; `templatePath` — то, что вернул сервис (если метод его возвращает). */
  readonly run: (input: string) => { readonly templatePath?: string };
  /** Метод меняет тело (edit/compile) — для него дополнительно проверяется неприкосновенность дескриптора. */
  readonly mutates: boolean;
}

interface ServiceCase {
  readonly label: string;
  readonly templateType: string;
  readonly compile: (outputPath: string) => { templatePath: string; changedFiles: readonly string[] };
  readonly readers: readonly TemplateMethodCase[];
  /** Метод, который при корне MetaDataObject обязан вернуть ОТЧЁТ с ошибкой, а не исключение. */
  readonly validate: (input: string) => { errors: number; issues: readonly { severity: string; message: string }[] };
}

const mxl = new MxlTemplateService();
const skd = new DataCompositionSchemaService();

const SERVICES: readonly ServiceCase[] = [
  {
    label: 'MXL',
    templateType: 'SpreadsheetDocument',
    compile: (outputPath) => mxl.compile({ outputPath, definition: MXL_DEFINITION }),
    validate: (input) => mxl.validate({ templatePath: input, detailed: true }),
    readers: [
      { name: 'info', mutates: false, run: (input) => mxl.info({ templatePath: input }) },
      { name: 'validate', mutates: false, run: (input) => mxl.validate({ templatePath: input }) },
      {
        name: 'decompile',
        mutates: false,
        run: (input) => {
          const dsl = mxl.decompile({ templatePath: input });
          assert.strictEqual(dsl.columns, 2);
          return {};
        },
      },
    ],
  },
  {
    label: 'СКД',
    templateType: 'DataCompositionSchema',
    compile: (outputPath) => skd.compile({ outputPath, definition: SKD_DEFINITION }),
    validate: (input) => skd.validate({ templatePath: input, detailed: true }),
    readers: [
      { name: 'info', mutates: false, run: (input) => skd.info({ templatePath: input }) },
      { name: 'validate', mutates: false, run: (input) => skd.validate({ templatePath: input }) },
      {
        name: 'edit',
        mutates: true,
        run: (input) => skd.edit({
          templatePath: input,
          operation: 'add-parameter',
          value: 'Организация: CatalogRef.Организации',
        }),
      },
    ],
  },
];

interface Tree {
  readonly root: string;
  readonly templateDir: string;
  readonly descriptor: string;
  readonly body: string;
}

/** Раскладка `Templates/Макет.xml` + `Templates/Макет/Ext/Template.xml` с телом, собранным компиляцией по пути тела. */
function makeTree(service: ServiceCase, withBody = true): Tree {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-template-body-')));
  const descriptor = path.join(root, 'Templates', 'Макет.xml');
  const templateDir = path.join(root, 'Templates', 'Макет');
  const body = path.join(templateDir, 'Ext', 'Template.xml');
  fs.mkdirSync(path.dirname(descriptor), { recursive: true });
  fs.writeFileSync(descriptor, descriptorXml('Макет', service.templateType), 'utf-8');
  if (withBody) {
    service.compile(body);
  }
  return { root, templateDir, descriptor, body };
}

suite('Макеты: тело и guard', () => {
  const trees: string[] = [];
  const tracked = (service: ServiceCase, withBody = true): Tree => {
    const tree = makeTree(service, withBody);
    trees.push(tree.root);
    return tree;
  };
  teardown(() => {
    for (const root of trees.splice(0)) {
      removeTreeSync(root);
    }
  });

  suite('XmlUtils: sliceToRootElement / rootLocalNamePattern (вынесены из FormShared)', () => {
    const sliceCases: readonly { readonly name: string; readonly xml: string; readonly expected: string | null }[] = [
      { name: 'голый корень', xml: '<document/>', expected: '<document/>' },
      { name: 'BOM + пролог + пробелы', xml: '\uFEFF<?xml version="1.0"?>\r\n  <document a="1"/>', expected: '<document a="1"/>' },
      { name: 'комментарии до корня', xml: '<?xml version="1.0"?><!-- один --> <!-- два --><Root/>', expected: '<Root/>' },
      { name: 'оборванный пролог', xml: '<?xml version="1.0"', expected: null },
      { name: 'оборванный комментарий', xml: '<?xml version="1.0"?><!-- нет конца <Root/>', expected: null },
      { name: 'пустой документ', xml: '', expected: '' },
    ];
    for (const c of sliceCases) {
      test(`sliceToRootElement: ${c.name}`, () => {
        assert.strictEqual(sliceToRootElement(c.xml), c.expected);
      });
    }

    const patternCases: readonly { readonly text: string; readonly matches: boolean }[] = [
      { text: '<Form>', matches: true },
      { text: '<Form xmlns="x">', matches: true },
      { text: '<Form/>', matches: true },
      { text: '<Form\n', matches: true },
      { text: '<lf:Form xmlns:lf="x">', matches: true },
      { text: '<FormX>', matches: false },
      { text: '<Forms>', matches: false },
      { text: '<MetaDataObject>', matches: false },
      { text: 'Form>', matches: false },
    ];
    for (const c of patternCases) {
      test(`rootLocalNamePattern('Form'): ${JSON.stringify(c.text)} -> ${String(c.matches)}`, () => {
        assert.strictEqual(rootLocalNamePattern('Form').test(c.text), c.matches);
      });
    }
  });

  suite('TemplateXml: guard корня тела', () => {
    const okRoots: readonly { readonly name: string; readonly xml: string }[] = [
      { name: 'document (MXL)', xml: '<?xml version="1.0"?>\n<document xmlns="http://v8.1c.ru/8.2/data/spreadsheet"/>' },
      { name: 'DataCompositionSchema (СКД)', xml: '\uFEFF<DataCompositionSchema xmlns="x"/>' },
      { name: 'комментарий перед корнем', xml: '<?xml version="1.0"?><!-- c --><anything/>' },
      { name: 'пустой документ: корень не распознан, решения нет — не бросает', xml: '' },
      { name: 'не XML — не бросает', xml: 'просто текст' },
    ];
    for (const c of okRoots) {
      test(`assertTemplateBodyRoot: ${c.name} — не бросает`, () => {
        assert.doesNotThrow(() => { assertTemplateBodyRoot(c.xml, path.join(path.sep, 'x', 'Templates', 'Макет', 'Ext', 'Template.xml')); });
      });
    }

    const descriptorRoots: readonly { readonly name: string; readonly xml: string }[] = [
      { name: 'MetaDataObject', xml: descriptorXml('Макет', 'SpreadsheetDocument') },
      { name: 'MetaDataObject с BOM и префиксом пространства', xml: '\uFEFF<?xml version="1.0"?>\r\n<md:MetaDataObject xmlns:md="x"/>' },
    ];
    for (const c of descriptorRoots) {
      test(`assertTemplateBodyRoot: ${c.name} — отказ с подсказкой про дескриптор и путь тела`, () => {
        const descriptor = path.join(path.sep, 'x', 'Templates', 'Макет.xml');
        assert.throws(
          () => { assertTemplateBodyRoot(c.xml, descriptor); },
          (error: unknown) => error instanceof Error
            && error.message.includes('дескриптор')
            && /Ext[\\/]Template\.xml/.test(error.message),
        );
      });
    }
  });

  suite('TemplateXml: resolveExistingTemplateBody / readTemplateBody', () => {
    for (const service of SERVICES) {
      test(`${service.label}: каталог, тело и дескриптор приводят к одному существующему телу`, () => {
        const tree = tracked(service);
        for (const input of [tree.templateDir, tree.body, tree.descriptor]) {
          assert.strictEqual(resolveExistingTemplateBody(input), tree.body, input);
          const read = readTemplateBody(input);
          assert.strictEqual(read.path, tree.body, input);
          assert.strictEqual(read.xml, fs.readFileSync(tree.body, 'utf-8'), input);
        }
      });

      test(`${service.label}: тела нет — понятная ошибка с путём тела и подсказкой про add_template`, () => {
        const tree = tracked(service, false);
        for (const input of [tree.templateDir, tree.body, tree.descriptor]) {
          for (const call of [resolveExistingTemplateBody, readTemplateBody]) {
            assert.throws(
              () => { call(input); },
              (error: unknown) => error instanceof Error
                && error.message.includes(MISSING_BODY)
                && error.message.includes(path.join('Макет', 'Ext', 'Template.xml'))
                && error.message.includes(ADD_TEMPLATE_HINT),
              input,
            );
          }
        }
      });

      test(`${service.label}: readTemplateBody отбивает дескриптор, лежащий на месте тела`, () => {
        const tree = tracked(service);
        fs.writeFileSync(tree.body, fs.readFileSync(tree.descriptor));
        assert.throws(() => readTemplateBody(tree.body), /дескриптор/);
      });
    }

    test('вход не каталог и не .xml — ошибка разрешения пути', () => {
      assert.throws(() => resolveExistingTemplateBody(path.join(os.tmpdir(), 'v8vscedit-нет-такого.txt')), Error);
    });
  });

  for (const service of SERVICES) {
    suite(`${service.label}: методы чтения и правки принимают каталог, тело и дескриптор`, () => {
      for (const method of service.readers) {
        const inputs: readonly { readonly label: string; readonly pick: (t: Tree) => string }[] = [
          { label: 'каталог макета', pick: (t) => t.templateDir },
          { label: 'тело Ext/Template.xml', pick: (t) => t.body },
          { label: 'дескриптор (существует)', pick: (t) => t.descriptor },
        ];
        for (const input of inputs) {
          test(`${method.name} по входу "${input.label}": работает с телом, дескриптор не тронут`, () => {
            const tree = tracked(service);
            const descriptorBefore = fs.readFileSync(tree.descriptor);
            const bodyBefore = fs.readFileSync(tree.body);
            const result = method.run(input.pick(tree));
            if (result.templatePath !== undefined) {
              assert.strictEqual(result.templatePath, tree.body, 'сервис возвращает путь ТЕЛА, а не дескриптора');
            }
            assert.ok(fs.readFileSync(tree.descriptor).equals(descriptorBefore), 'дескриптор не меняется');
            if (method.mutates) {
              assert.ok(!fs.readFileSync(tree.body).equals(bodyBefore), 'правка меняет тело');
            } else {
              assert.ok(fs.readFileSync(tree.body).equals(bodyBefore), 'чтение не меняет тело');
            }
          });
        }

        test(`${method.name}: тела нет — ошибка с подсказкой про add_template (по любому входу)`, () => {
          const tree = tracked(service, false);
          for (const input of [tree.templateDir, tree.body, tree.descriptor]) {
            assert.throws(
              () => { method.run(input); },
              (error: unknown) => error instanceof Error && error.message.includes(MISSING_BODY) && error.message.includes(ADD_TEMPLATE_HINT),
              input,
            );
          }
        });

        if (method.name !== 'validate') {
          test(`${method.name}: на месте тела лежит дескриптор (корень MetaDataObject) — исключение, файл не тронут`, () => {
            const tree = tracked(service);
            fs.writeFileSync(tree.body, fs.readFileSync(tree.descriptor));
            const before = fs.readFileSync(tree.body);
            assert.throws(() => { method.run(tree.body); }, /дескриптор/);
            assert.ok(fs.readFileSync(tree.body).equals(before));
          });
        }
      }

      test('validate: на месте тела лежит дескриптор — ОТЧЁТ с ошибкой, а не исключение', () => {
        const tree = tracked(service);
        fs.writeFileSync(tree.body, fs.readFileSync(tree.descriptor));
        const report = service.validate(tree.body);
        assert.ok(report.errors >= 1);
        assert.ok(report.issues.some((issue) => issue.severity === 'error' && issue.message.includes('дескриптор')), JSON.stringify(report.issues));
      });
    });

    suite(`${service.label}: compile пишет ТОЛЬКО в тело`, () => {
      test('по дескриптору: тело перезаписано, дескриптор байт-в-байт, result указывает на тело', () => {
        const tree = tracked(service);
        const descriptorBefore = fs.readFileSync(tree.descriptor);
        const result = service.compile(tree.descriptor);
        assert.strictEqual(result.templatePath, tree.body);
        assert.deepStrictEqual([...result.changedFiles], [tree.body]);
        assert.ok(fs.readFileSync(tree.descriptor).equals(descriptorBefore), 'дескриптор не затёрт');
        assert.ok(!/<MetaDataObject\b/.test(fs.readFileSync(tree.body, 'utf-8')), 'в теле нет корня дескриптора');
      });

      test('по каталогу макета: пишет в <каталог>/Ext/Template.xml', () => {
        const tree = tracked(service);
        const result = service.compile(tree.templateDir);
        assert.strictEqual(result.templatePath, tree.body);
        assert.deepStrictEqual([...result.changedFiles], [tree.body]);
      });

      test('тела нет: каталоги создаются, файл пишется атомарно (временных файлов не остаётся), дескриптор цел', () => {
        const tree = tracked(service, false);
        const descriptorBefore = fs.readFileSync(tree.descriptor);
        assert.strictEqual(fs.existsSync(path.dirname(tree.body)), false, 'предусловие: каталога Ext нет');
        const result = service.compile(tree.descriptor);
        assert.strictEqual(result.templatePath, tree.body);
        assert.strictEqual(fs.existsSync(tree.body), true);
        assert.deepStrictEqual(fs.readdirSync(path.dirname(tree.body)), ['Template.xml']);
        assert.ok(fs.readFileSync(tree.descriptor).equals(descriptorBefore));
      });

      test('тела нет, вход — путь тела: создаётся тот же файл', () => {
        const tree = tracked(service, false);
        const result = service.compile(tree.body);
        assert.strictEqual(result.templatePath, tree.body);
        assert.strictEqual(fs.existsSync(tree.body), true);
      });

      test('существующее тело с BOM и CRLF: BOM и переводы строк сохраняются', () => {
        const tree = tracked(service);
        const withBomCrlf = `\uFEFF${fs.readFileSync(tree.body, 'utf-8').replace(/\r?\n/g, '\r\n')}`;
        fs.writeFileSync(tree.body, withBomCrlf, 'utf-8');
        service.compile(tree.descriptor);
        const after = fs.readFileSync(tree.body, 'utf-8');
        assert.strictEqual(after.charCodeAt(0), 0xfeff, 'BOM сохранён');
        assert.ok(!/(?<!\r)\n/.test(after), 'во всех переводах строк есть CR (CRLF сохранён)');
        assert.ok(!after.includes('\r\r'));
      });

      test('существующее тело с LF и без BOM: BOM не появляется, CR не появляется', () => {
        const tree = tracked(service);
        fs.writeFileSync(tree.body, fs.readFileSync(tree.body, 'utf-8').replace(/\r\n/g, '\n').replace(/^\uFEFF/, ''), 'utf-8');
        service.compile(tree.body);
        const after = fs.readFileSync(tree.body, 'utf-8');
        assert.notStrictEqual(after.charCodeAt(0), 0xfeff);
        assert.ok(!after.includes('\r'));
      });

      test('на месте тела дескриптор (корень MetaDataObject): отказ без записи', () => {
        const tree = tracked(service);
        fs.writeFileSync(tree.body, fs.readFileSync(tree.descriptor));
        const before = fs.readFileSync(tree.body);
        assert.throws(() => service.compile(tree.body), /дескриптор/);
        assert.ok(fs.readFileSync(tree.body).equals(before), 'файл не изменён');
        assert.deepStrictEqual(fs.readdirSync(path.dirname(tree.body)), ['Template.xml'], 'временных файлов нет');
      });

      test('вход не каталог и не .xml: отказ до записи', () => {
        const tree = tracked(service, false);
        assert.throws(() => service.compile(path.join(tree.root, 'Templates', 'Макет', 'Ext', 'Template.txt')), Error);
        assert.strictEqual(fs.existsSync(tree.body), false);
      });
    });
  }

  suite('имя макета в отчётах', () => {
    test('MXL info: name — имя макета, а не имя каталога выше', () => {
      const tree = tracked(SERVICES[0]);
      for (const input of [tree.templateDir, tree.body, tree.descriptor]) {
        assert.strictEqual(mxl.info({ templatePath: input }).name, 'Макет', input);
      }
    });

    test('MXL validate: в заголовке отчёта имя макета', () => {
      const tree = tracked(SERVICES[0]);
      const report = mxl.validate({ templatePath: tree.descriptor });
      assert.ok(report.lines.some((line) => line.includes('Template.Макет')), report.lines.join('\n'));
    });
  });
});
