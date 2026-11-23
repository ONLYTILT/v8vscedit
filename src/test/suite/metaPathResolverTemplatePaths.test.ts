import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MetaPathResolver,
  resolveChildTemplateBody,
  resolveChildTemplateDescriptor,
  resolveTemplateBodyByDescriptor,
  resolveTemplateBodyPath,
} from '../../infra/fs/MetaPathResolver';
import { removeTreeSync } from './support/tempTree';

/**
 * Арифметика путей макетов в `MetaPathResolver`.
 *
 * Дефект: узел макета несёт дескриптор `Templates/<Имя>.xml` (или XML владельца), а сервисы
 * MXL/СКД принимали его за тело `Ext/Template.xml` и подменяли путь только при ОТСУТСТВИИ
 * входного файла; `compile_*` писали содержимое прямо в дескриптор. Теперь «дескриптор →
 * тело» и «владелец + имя → дескриптор» считаются явно в одном месте; единый
 * `resolveTemplateBodyPath` заменяет две копии `resolveTemplateContentPath`.
 */

const ROOT = path.join(path.sep, 'выгрузка', 'cf');
const resolver = new MetaPathResolver();

/** Обе поверхности API (метод класса и module-level фасад) обязаны давать одно и то же. */
const SURFACES = [
  {
    label: 'метод MetaPathResolver',
    byDescriptor: (d: string) => resolver.resolveTemplateBodyByDescriptor(d),
    childDescriptor: (owner: string, name: string) => resolver.resolveChildTemplateDescriptor(owner, name),
    childBody: (owner: string, name: string) => resolver.resolveChildTemplateBody(owner, name),
    bodyPath: (input: string) => resolver.resolveTemplateBodyPath(input),
  },
  {
    label: 'module-level фасад',
    byDescriptor: resolveTemplateBodyByDescriptor,
    childDescriptor: resolveChildTemplateDescriptor,
    childBody: resolveChildTemplateBody,
    bodyPath: resolveTemplateBodyPath,
  },
] as const;

suite('Макеты: MetaPathResolver', () => {
  for (const surface of SURFACES) {
    suite(surface.label, () => {
      const descriptorCases: readonly { readonly name: string; readonly descriptor: string; readonly body: string }[] = [
        {
          name: 'макет объекта Templates/Y.xml',
          descriptor: path.join(ROOT, 'Catalogs', 'X', 'Templates', 'Y.xml'),
          body: path.join(ROOT, 'Catalogs', 'X', 'Templates', 'Y', 'Ext', 'Template.xml'),
        },
        {
          name: 'общий макет CommonTemplates/Y.xml',
          descriptor: path.join(ROOT, 'CommonTemplates', 'Y.xml'),
          body: path.join(ROOT, 'CommonTemplates', 'Y', 'Ext', 'Template.xml'),
        },
        {
          // Имя макета совпадает с именем файла тела: дескриптор Templates/Template.xml не должен
          // приниматься за уже готовое тело.
          name: 'макет с именем Template',
          descriptor: path.join(ROOT, 'Catalogs', 'X', 'Templates', 'Template.xml'),
          body: path.join(ROOT, 'Catalogs', 'X', 'Templates', 'Template', 'Ext', 'Template.xml'),
        },
        {
          name: 'макет с именем Ext',
          descriptor: path.join(ROOT, 'Catalogs', 'X', 'Templates', 'Ext.xml'),
          body: path.join(ROOT, 'Catalogs', 'X', 'Templates', 'Ext', 'Ext', 'Template.xml'),
        },
        {
          name: 'макет с именем Templates',
          descriptor: path.join(ROOT, 'Catalogs', 'X', 'Templates', 'Templates.xml'),
          body: path.join(ROOT, 'Catalogs', 'X', 'Templates', 'Templates', 'Ext', 'Template.xml'),
        },
        {
          name: 'кириллические имена объекта и макета',
          descriptor: path.join(ROOT, 'Documents', 'Заказ', 'Templates', 'ПечатнаяФорма.xml'),
          body: path.join(ROOT, 'Documents', 'Заказ', 'Templates', 'ПечатнаяФорма', 'Ext', 'Template.xml'),
        },
      ];
      for (const c of descriptorCases) {
        test(`resolveTemplateBodyByDescriptor: ${c.name}`, () => {
          assert.strictEqual(surface.byDescriptor(c.descriptor), c.body);
        });
      }

      const childCases: readonly { readonly name: string; readonly owner: string; readonly template: string; readonly descriptor: string }[] = [
        {
          name: 'плоская раскладка Catalogs/X.xml',
          owner: path.join(ROOT, 'Catalogs', 'X.xml'),
          template: 'Y',
          descriptor: path.join(ROOT, 'Catalogs', 'X', 'Templates', 'Y.xml'),
        },
        {
          name: 'глубокая раскладка Catalogs/X/X.xml',
          owner: path.join(ROOT, 'Catalogs', 'X', 'X.xml'),
          template: 'Y',
          descriptor: path.join(ROOT, 'Catalogs', 'X', 'Templates', 'Y.xml'),
        },
        {
          name: 'отчёт, кириллица',
          owner: path.join(ROOT, 'Reports', 'Продажи.xml'),
          template: 'ОсновнаяСхема',
          descriptor: path.join(ROOT, 'Reports', 'Продажи', 'Templates', 'ОсновнаяСхема.xml'),
        },
        {
          name: 'имя макета совпадает с именем владельца',
          owner: path.join(ROOT, 'Catalogs', 'X.xml'),
          template: 'X',
          descriptor: path.join(ROOT, 'Catalogs', 'X', 'Templates', 'X.xml'),
        },
      ];
      for (const c of childCases) {
        test(`resolveChildTemplateDescriptor: ${c.name}`, () => {
          assert.strictEqual(surface.childDescriptor(c.owner, c.template), c.descriptor);
        });

        test(`resolveChildTemplateBody (композиция): ${c.name}`, () => {
          assert.strictEqual(
            surface.childBody(c.owner, c.template),
            path.join(path.dirname(c.descriptor), c.template, 'Ext', 'Template.xml'),
          );
          assert.strictEqual(
            surface.childBody(c.owner, c.template),
            surface.byDescriptor(surface.childDescriptor(c.owner, c.template)),
          );
        });
      }

      test('арифметика дескриптора не обращается к ФС: для несуществующих путей результат тот же', () => {
        const ghostOwner = path.join(ROOT, 'НетТакого', 'Catalogs', 'X.xml');
        assert.strictEqual(fs.existsSync(ROOT), false, 'предусловие: путь фикстуры не существует');
        assert.strictEqual(
          surface.childBody(ghostOwner, 'Y'),
          path.join(ROOT, 'НетТакого', 'Catalogs', 'X', 'Templates', 'Y', 'Ext', 'Template.xml'),
        );
      });

      suite('resolveTemplateBodyPath — единая замена двух resolveTemplateContentPath', () => {
        let tmp: string;
        setup(() => {
          tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-template-body-path-')));
        });
        teardown(() => {
          removeTreeSync(tmp);
        });

        const touch = (file: string): string => {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, '<x/>', 'utf-8');
          return file;
        };

        test('ветка 1: существующий каталог макета -> <каталог>/Ext/Template.xml, даже если тела ещё нет', () => {
          const dir = path.join(tmp, 'Templates', 'Макет');
          fs.mkdirSync(dir, { recursive: true });
          assert.strictEqual(surface.bodyPath(dir), path.join(dir, 'Ext', 'Template.xml'));
        });

        test('ветка 1: каталог с готовым телом -> то же тело', () => {
          const body = touch(path.join(tmp, 'Templates', 'Макет', 'Ext', 'Template.xml'));
          assert.strictEqual(surface.bodyPath(path.dirname(path.dirname(body))), body);
        });

        test('ветка 2: путь уже указывает на Ext/Template.xml -> как есть (существует)', () => {
          const body = touch(path.join(tmp, 'Templates', 'Макет', 'Ext', 'Template.xml'));
          assert.strictEqual(surface.bodyPath(body), body);
        });

        test('ветка 2: путь Ext/Template.xml не существует -> как есть, существование не проверяется', () => {
          const body = path.join(tmp, 'Templates', 'Нет', 'Ext', 'Template.xml');
          assert.strictEqual(surface.bodyPath(body), body);
        });

        test('ветка 3: <каталог>/Template.xml, рядом есть Ext/Template.xml -> уводит в Ext', () => {
          const ext = touch(path.join(tmp, 'Макет', 'Ext', 'Template.xml'));
          assert.strictEqual(surface.bodyPath(path.join(tmp, 'Макет', 'Template.xml')), ext);
        });

        test('ветка 3 не срабатывает у дескриптора макета с именем Template: рядом нет Ext/Template.xml -> дескриптор -> тело', () => {
          const descriptor = touch(path.join(tmp, 'Templates', 'Template.xml'));
          assert.strictEqual(
            surface.bodyPath(descriptor),
            path.join(tmp, 'Templates', 'Template', 'Ext', 'Template.xml'),
          );
        });

        test('ветка 4: существующий дескриптор Templates/Макет.xml -> тело, а не сам дескриптор (даже когда дескриптор существует)', () => {
          const descriptor = touch(path.join(tmp, 'Templates', 'Макет.xml'));
          const body = touch(path.join(tmp, 'Templates', 'Макет', 'Ext', 'Template.xml'));
          assert.strictEqual(fs.existsSync(descriptor), true);
          assert.strictEqual(surface.bodyPath(descriptor), body);
        });

        test('ветка 4: дескриптор есть, тела нет -> путь тела (создание — забота записывающего кода)', () => {
          const descriptor = touch(path.join(tmp, 'Templates', 'Макет.xml'));
          assert.strictEqual(
            surface.bodyPath(descriptor),
            path.join(tmp, 'Templates', 'Макет', 'Ext', 'Template.xml'),
          );
        });

        test('ветка 4: несуществующий дескриптор -> путь тела', () => {
          assert.strictEqual(
            surface.bodyPath(path.join(tmp, 'Templates', 'Призрак.xml')),
            path.join(tmp, 'Templates', 'Призрак', 'Ext', 'Template.xml'),
          );
        });

        test('ветка 4: макет с именем Ext -> Templates/Ext/Ext/Template.xml', () => {
          assert.strictEqual(
            surface.bodyPath(path.join(tmp, 'Templates', 'Ext.xml')),
            path.join(tmp, 'Templates', 'Ext', 'Ext', 'Template.xml'),
          );
        });

        test('ветка 5: не каталог и не .xml -> ошибка', () => {
          const txt = touch(path.join(tmp, 'Макет', 'Ext', 'Template.txt'));
          assert.throws(() => surface.bodyPath(txt), Error);
          assert.throws(() => surface.bodyPath(path.join(tmp, 'нет-такого-пути')), Error);
        });
      });
    });
  }
});
