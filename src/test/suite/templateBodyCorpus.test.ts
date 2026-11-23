import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { resolveTemplateBodyByDescriptor } from '../../infra/fs/MetaPathResolver';
import { DataCompositionSchemaService, MxlTemplateService, readTemplateTypeFromXml } from '../../infra/xml';
import { readTemplateBody } from '../../infra/xml/TemplateXml';
import { EXAMPLE_ROOT, hasCorpus, skipWithoutCorpus } from './support/corpus';

/**
 * Дескриптор -> тело макета на эталонных выгрузках (cf и cfe, обе генерации): для КАЖДОГО
 * макета табличного документа и СКД тело вычисляется арифметикой `MetaPathResolver`, существует
 * и не является дескриптором. Обход корпуса — лениво внутри `suiteSetup` (CLAUDE.md: на этапе
 * загрузки модуля `ENOENT` рушит весь прогон Mocha).
 */

interface Scope {
  readonly label: string;
  readonly root: string;
}

const SCOPES: readonly Scope[] = [
  { label: '2.20 cf', root: path.join(EXAMPLE_ROOT, '2.20', 'src', 'cf') },
  { label: '2.21 cf', root: path.join(EXAMPLE_ROOT, '2.21', 'src', 'cf') },
  { label: '2.21 cfe EVOLC', root: path.join(EXAMPLE_ROOT, '2.21', 'src', 'cfe', 'EVOLC') },
];

interface Found {
  readonly descriptor: string;
  readonly type: 'SpreadsheetDocument' | 'DataCompositionSchema';
}

/** Все дескрипторы макетов: `CommonTemplates/*.xml` и `<тип>/<объект>/Templates/*.xml`. */
function collectTemplateDescriptors(root: string): Found[] {
  const result: Found[] = [];
  const consider = (descriptor: string): void => {
    const type = readTemplateTypeFromXml(descriptor);
    if (type === 'SpreadsheetDocument' || type === 'DataCompositionSchema') {
      result.push({ descriptor, type });
    }
  };
  const common = path.join(root, 'CommonTemplates');
  if (fs.existsSync(common)) {
    for (const entry of fs.readdirSync(common, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.xml')) {
        consider(path.join(common, entry.name));
      }
    }
  }
  for (const typeDir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!typeDir.isDirectory() || typeDir.name === 'CommonTemplates') {
      continue;
    }
    const typePath = path.join(root, typeDir.name);
    for (const objectDir of fs.readdirSync(typePath, { withFileTypes: true })) {
      if (!objectDir.isDirectory()) {
        continue;
      }
      const templatesDir = path.join(typePath, objectDir.name, 'Templates');
      if (!fs.existsSync(templatesDir)) {
        continue;
      }
      for (const entry of fs.readdirSync(templatesDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.xml')) {
          consider(path.join(templatesDir, entry.name));
        }
      }
    }
  }
  return result.sort((a, b) => a.descriptor.localeCompare(b.descriptor));
}

suite('Макеты: корпус', () => {
  for (const scope of SCOPES) {
    suite(scope.label, function () {
      this.timeout(600_000);
      let found: Found[] = [];

      suiteSetup(function () {
        skipWithoutCorpus(this, scope.root);
        found = collectTemplateDescriptors(scope.root);
      });

      test('в корпусе есть макеты обоих типов (иначе проверка вакуумна)', function () {
        if (!hasCorpus(scope.root)) {
          this.skip();
        }
        assert.ok(found.some((item) => item.type === 'SpreadsheetDocument'), 'нет макетов MXL');
        if (!scope.label.includes('cfe')) {
          assert.ok(found.some((item) => item.type === 'DataCompositionSchema'), 'нет макетов СКД');
        }
      });

      test('у КАЖДОГО макета MXL/СКД тело вычисляется арифметикой, существует и не является дескриптором', function () {
        if (!hasCorpus(scope.root)) {
          this.skip();
        }
        const violations: string[] = [];
        for (const item of found) {
          const body = resolveTemplateBodyByDescriptor(item.descriptor);
          if (!fs.existsSync(body)) {
            violations.push(`${item.descriptor}: тела нет (${body})`);
            continue;
          }
          try {
            readTemplateBody(item.descriptor);
          } catch (error) {
            violations.push(`${item.descriptor}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        assert.deepStrictEqual(violations, []);
      });

      test('сервисы читают тела по дескриптору: 25 самых маленьких макетов каждого типа', function () {
        if (!hasCorpus(scope.root)) {
          this.skip();
        }
        const mxl = new MxlTemplateService();
        const skd = new DataCompositionSchemaService();
        for (const type of ['SpreadsheetDocument', 'DataCompositionSchema'] as const) {
          const smallest = found
            .filter((item) => item.type === type)
            .map((item) => ({ item, size: fs.statSync(resolveTemplateBodyByDescriptor(item.descriptor)).size }))
            .sort((a, b) => a.size - b.size || a.item.descriptor.localeCompare(b.item.descriptor))
            .slice(0, 25);
          for (const { item } of smallest) {
            const body = resolveTemplateBodyByDescriptor(item.descriptor);
            const result = type === 'SpreadsheetDocument'
              ? mxl.info({ templatePath: item.descriptor })
              : skd.info({ templatePath: item.descriptor });
            assert.strictEqual(result.templatePath, body, item.descriptor);
            const report = type === 'SpreadsheetDocument'
              ? mxl.validate({ templatePath: item.descriptor })
              : skd.validate({ templatePath: item.descriptor });
            assert.strictEqual(report.templatePath, body, item.descriptor);
          }
        }
      });
    });
  }
});
