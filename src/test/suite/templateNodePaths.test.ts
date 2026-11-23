import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MetadataNode } from '../../ui/tree/TreeNode';
import { resolveTemplateBodyFromNode, resolveTemplateNodeParts } from '../../ui/tree/templateNodePaths';
import {
  createTemplateFixtureExport,
  createTemplateMcpFixture,
  createTemplateMcpHarnessOverEntry,
  type TemplateFixtureItem,
  type TemplateKindName,
  type TemplateMcpFixture,
} from './support/mcpTemplateToolsHarness';
import { removeTreeSync } from './support/tempTree';

/**
 * Адаптер «узел дерева макета -> файлы макета» (`ui/tree/templateNodePaths`), образец —
 * `formNodePaths`. Узлы берутся от НАСТОЯЩЕГО дерева навигатора: узел макета объекта несёт
 * в `xmlPath` дескриптор `Templates/<Имя>.xml` (а при его отсутствии — XML владельца), узел
 * общего макета — дескриптор `CommonTemplates/<Имя>.xml`. Арифметика путей от `node.xmlPath`
 * узла `Template` НЕ зависит — только от `ownerObjectXmlPath` и имени узла.
 */

function synthetic(
  nodeKind: 'Template' | 'CommonTemplate' | 'Catalog',
  label: string,
  extra: { xmlPath?: string; ownerObjectXmlPath?: string } = {},
): MetadataNode {
  return new MetadataNode({
    label,
    nodeKind,
    xmlPath: extra.xmlPath,
    metaContext: extra.ownerObjectXmlPath === undefined
      ? undefined
      : { rootMetaKind: 'Catalog', ownerObjectXmlPath: extra.ownerObjectXmlPath },
  }, vscode.TreeItemCollapsibleState.None);
}

suite('Макеты: адаптер узла', () => {
  let fx: TemplateMcpFixture;
  suiteSetup(function () {
    this.timeout(60_000);
    fx = createTemplateMcpFixture();
  });
  suiteTeardown(() => {
    fx.dispose();
  });

  suite('resolveTemplateNodeParts на узлах настоящего дерева', () => {
    for (const nodeKind of ['Template', 'CommonTemplate'] as const) {
      for (const templateType of ['SpreadsheetDocument', 'DataCompositionSchema'] as const) {
        test(`${nodeKind}/${templateType}: дескриптор и тело считаются арифметикой`, () => {
          const item = fx.item(nodeKind, templateType);
          const node = fx.harness.paths.resolveNode(item.canonical);
          assert.strictEqual(node.nodeKind, nodeKind);
          const parts = resolveTemplateNodeParts(node, item.canonical);
          assert.strictEqual(parts.descriptorPath, item.descriptor);
          assert.strictEqual(parts.bodyPath, item.body);
        });
      }
    }

    test('контракт дерева: у узла Template xmlPath — дескриптор, ownerObjectXmlPath — XML владельца; у CommonTemplate xmlPath — дескриптор', () => {
      const own = fx.item('Template', 'SpreadsheetDocument');
      const ownNode = fx.harness.paths.resolveNode(own.canonical);
      assert.strictEqual(ownNode.xmlPath, own.descriptor);
      assert.strictEqual(ownNode.metaContext?.ownerObjectXmlPath, fx.catalogXml);
      const common = fx.item('CommonTemplate', 'SpreadsheetDocument');
      assert.strictEqual(fx.harness.paths.resolveNode(common.canonical).xmlPath, common.descriptor);
    });

    test('Template: xmlPath узла в арифметике не участвует (подмена на XML владельца не меняет результат)', () => {
      const item = fx.item('Template', 'SpreadsheetDocument');
      const node = synthetic('Template', item.name, { xmlPath: fx.catalogXml, ownerObjectXmlPath: fx.catalogXml });
      const parts = resolveTemplateNodeParts(node, item.canonical);
      assert.strictEqual(parts.descriptorPath, item.descriptor);
      assert.strictEqual(parts.bodyPath, item.body);
    });

    test('Template: даже без xmlPath узла путь строится из владельца и имени', () => {
      const item = fx.item('Template', 'DataCompositionSchema');
      const node = synthetic('Template', item.name, { ownerObjectXmlPath: fx.catalogXml });
      assert.strictEqual(resolveTemplateNodeParts(node, item.canonical).bodyPath, item.body);
    });

    test('ошибка: узел не макет — подсказка про канонические пути и вид узла', () => {
      const node = fx.harness.paths.resolveNode(`Справочники.${fx.catalogName}`);
      assert.throws(
        () => resolveTemplateNodeParts(node, `Справочники.${fx.catalogName}`),
        (error: unknown) => error instanceof Error
          && error.message.includes('должен указывать на макет')
          && error.message.includes(`Справочники.${fx.catalogName}`)
          && error.message.includes('Catalog'),
      );
    });

    test('ошибка: у Template нет объекта-владельца', () => {
      const node = synthetic('Template', 'Макет', { xmlPath: path.join(fx.configRoot, 'Catalogs', 'Т', 'Templates', 'Макет.xml') });
      assert.throws(() => resolveTemplateNodeParts(node, 'Справочники.Т.Макет.Макет'), /объект-владелец/);
    });

    test('ошибка: у CommonTemplate нет xmlPath', () => {
      const node = synthetic('CommonTemplate', 'ОбщийМакет');
      assert.throws(() => resolveTemplateNodeParts(node, 'ОбщиеМакеты.ОбщийМакет'), /не имеет XML-файла/);
    });
  });

  suite('resolveTemplateBodyFromNode', () => {
    const TYPES: readonly TemplateKindName[] = ['SpreadsheetDocument', 'DataCompositionSchema'];
    const nodeOf = (item: TemplateFixtureItem) => fx.harness.paths.resolveNode(item.canonical);

    for (const nodeKind of ['Template', 'CommonTemplate'] as const) {
      for (const expected of TYPES) {
        for (const intent of ['read', 'write'] as const) {
          test(`${nodeKind}: тип совпадает (${expected}), intent=${intent} -> тело`, () => {
            const item = fx.item(nodeKind, expected);
            assert.strictEqual(resolveTemplateBodyFromNode(nodeOf(item), item.canonical, expected, intent), item.body);
          });
        }
      }

      for (const [actual, expected] of [
        ['DataCompositionSchema', 'SpreadsheetDocument'],
        ['SpreadsheetDocument', 'DataCompositionSchema'],
        ['TextDocument', 'SpreadsheetDocument'],
        ['TextDocument', 'DataCompositionSchema'],
      ] as const) {
        for (const intent of ['read', 'write'] as const) {
          test(`${nodeKind}: макет ${actual}, инструмент ${expected}, intent=${intent} -> отказ`, () => {
            const item = fx.item(nodeKind, actual);
            assert.throws(
              () => resolveTemplateBodyFromNode(nodeOf(item), item.canonical, expected, intent),
              (error: unknown) => error instanceof Error
                && /^Макет .+ имеет тип /.test(error.message)
                && error.message.includes(`имеет тип ${actual}; инструмент работает с ${expected}`),
            );
          });
        }
      }

      test(`${nodeKind}: expected не задан — проверка типа не делается`, () => {
        const item = fx.item(nodeKind, 'TextDocument');
        assert.strictEqual(resolveTemplateBodyFromNode(nodeOf(item), item.canonical, undefined, 'read'), item.body);
      });
    }

    test('дескриптор без распознаваемого TemplateType: проверка типа пропускается, тело возвращается', () => {
      const item = fx.item('CommonTemplate', 'SpreadsheetDocument');
      const descriptor = fs.readFileSync(item.descriptor, 'utf-8');
      try {
        fs.writeFileSync(item.descriptor, descriptor.replace(/<TemplateType>[^<]*<\/TemplateType>/, '<TemplateType>Неизвестный</TemplateType>'), 'utf-8');
        assert.strictEqual(resolveTemplateBodyFromNode(nodeOf(item), item.canonical, 'DataCompositionSchema', 'write'), item.body);
      } finally {
        fs.writeFileSync(item.descriptor, descriptor, 'utf-8');
      }
    });

    suite('макет без дескриптора', () => {
      const cases: readonly { readonly label: string; readonly build: (item: TemplateFixtureItem) => MetadataNode }[] = [
        {
          label: 'узел Template (xmlPath — XML владельца, как отдаёт дерево)',
          build: (item) => synthetic('Template', item.name, { xmlPath: item.untouched[0], ownerObjectXmlPath: item.untouched[0] }),
        },
        {
          label: 'узел CommonTemplate (xmlPath указывает на несуществующий дескриптор)',
          build: (item) => synthetic('CommonTemplate', item.name, { xmlPath: item.descriptor }),
        },
      ];
      for (const c of cases) {
        test(`${c.label}: write -> ошибка про add_template`, () => {
          const kind = c.label.startsWith('узел Template') ? 'Template' : 'CommonTemplate';
          const item = fx.item(kind, 'SpreadsheetDocument');
          const { ghost, root } = createGhost(item);
          try {
            assert.throws(
              () => resolveTemplateBodyFromNode(c.build(ghost), ghost.canonical, 'SpreadsheetDocument', 'write'),
              (error: unknown) => error instanceof Error && error.message.includes('не описан дескриптором') && error.message.includes('add_template'),
            );
          } finally {
            removeTreeSync(root);
          }
        });

        test(`${c.label}: read -> тело без отказа`, () => {
          const kind = c.label.startsWith('узел Template') ? 'Template' : 'CommonTemplate';
          const item = fx.item(kind, 'SpreadsheetDocument');
          const { ghost, root } = createGhost(item);
          try {
            assert.strictEqual(
              resolveTemplateBodyFromNode(c.build(ghost), ghost.canonical, 'SpreadsheetDocument', 'read'),
              ghost.body,
            );
          } finally {
            removeTreeSync(root);
          }
        });
      }
    });

    test('ошибки структуры узла пробрасываются и из resolveTemplateBodyFromNode', () => {
      assert.throws(() => resolveTemplateBodyFromNode(synthetic('Catalog', 'Товары'), 'Справочники.Товары', 'SpreadsheetDocument', 'read'), /должен указывать на макет/);
    });
  });

  test('реальное дерево над выгрузкой без дескриптора макета объекта: узел Template всё равно даёт тело (read) и отказ (write)', function () {
    this.timeout(60_000);
    const exportInfo = createTemplateFixtureExport();
    const item = exportInfo.item('Template', 'SpreadsheetDocument');
    fs.unlinkSync(item.descriptor);
    const harness = createTemplateMcpHarnessOverEntry({ rootPath: exportInfo.configRoot, kind: 'cf' });
    try {
      const node = harness.paths.resolveNode(item.canonical);
      assert.strictEqual(resolveTemplateBodyFromNode(node, item.canonical, 'SpreadsheetDocument', 'read'), item.body);
      assert.throws(() => resolveTemplateBodyFromNode(node, item.canonical, 'SpreadsheetDocument', 'write'), /не описан дескриптором/);
    } finally {
      harness.dispose();
      removeTreeSync(exportInfo.configRoot);
    }
  });
});

/**
 * Макет «призрак»: дескриптора на диске нет, но пути арифметически корректны и лежат во
 * временном каталоге (чтобы проверка существования дескриптора давала честное «нет»).
 */
function createGhost(item: TemplateFixtureItem): { ghost: TemplateFixtureItem; root: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-ghost-')));
  const dir = item.nodeKind === 'Template' ? path.join(root, 'Catalogs', 'Т', 'Templates') : path.join(root, 'CommonTemplates');
  const owner = path.join(root, 'Catalogs', 'Т.xml');
  const descriptor = path.join(dir, `${item.name}.xml`);
  return {
    root,
    ghost: {
      ...item,
      descriptor,
      body: path.join(dir, item.name, 'Ext', 'Template.xml'),
      untouched: [owner, descriptor],
    },
  };
}
