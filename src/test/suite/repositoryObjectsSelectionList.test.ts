import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import {
  buildObjectsSelectionXml,
  mergeSelectionEntries,
  selectLockedInSelection,
  selectionFullNames,
  toSelectionNodes,
  type RepositorySelectionEntry,
} from '../../infra/repository/RepositoryObjectsSelection';
import { RepositoryService, type RepositoryNodeRef, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { diffSnapshots, snapshotTree } from './support/fsSnapshot';
import { removeTreeSync } from './support/tempTree';

/**
 * Единый файл выбора `-Objects` для списка узлов (docs/plans/mcp-repository-paths-plan.md §1.3, тесты §4.A):
 * чистые функции `RepositoryObjectsSelection` и методы `RepositoryService`, которые ими пользуются.
 * Эталоны XML для одной записи — те же литералы, что в `repositoryObjectsSelection.test.ts` (формат принимает
 * платформа; байт-в-байт, включая завершающий перевод строки). Структура выгрузки — во временном каталоге.
 */

const NS = 'http://v8.1c.ru/8.3/config/objects';
const CF_ROOT_NAME = '__configuration_root__';
const CFE_ROOT_NAME = '__extension_root__';

const ROOT: RepositorySelectionEntry = { kind: 'root' };
const object = (fullName: string, subsystem = false): RepositorySelectionEntry => ({ kind: 'object', fullName, subsystem });

const flag = (recursive: boolean): string => (recursive ? 'true' : 'false');
const rootLine = (recursive: boolean): string => `  <Configuration includeChildObjects="${flag(recursive)}"/>`;
const objectLines = (fullName: string, recursive: boolean, subsystem = false): string[] => [
  `  <Object fullName="${fullName}" includeChildObjects="${flag(recursive)}">`,
  ...(subsystem ? [`    <Subsystem includeObjectsFromSubordinateSubsystems="${flag(recursive)}"/>`] : []),
  '  </Object>',
];
const xmlOf = (...body: string[]): string => [`<Objects xmlns="${NS}" version="1.0">`, ...body, '</Objects>', ''].join('\n');

suite('RepositoryObjectsSelection: buildObjectsSelectionXml', () => {
  for (const recursive of [false, true]) {
    const mode = recursive ? 'рекурсивно' : 'нерекурсивно';

    test(`одна запись «корень» (${mode}): прежний эталон`, () => {
      assert.strictEqual(buildObjectsSelectionXml([ROOT], recursive), xmlOf(rootLine(recursive)));
    });

    test(`одна запись «объект» (${mode}): прежний эталон`, () => {
      assert.strictEqual(
        buildObjectsSelectionXml([object('Справочник.Товары')], recursive),
        xmlOf(...objectLines('Справочник.Товары', recursive))
      );
    });

    test(`одна запись «подсистема» (${mode}): прежний эталон с элементом Subsystem`, () => {
      assert.strictEqual(
        buildObjectsSelectionXml([object('Подсистема.Продажи', true)], recursive),
        xmlOf(...objectLines('Подсистема.Продажи', recursive, true))
      );
    });

    test(`список «корень + объект + подсистема» (${mode}): эталон-литерал формата §1.3`, () => {
      const expected = [
        `<Objects xmlns="${NS}" version="1.0">`,
        `  <Configuration includeChildObjects="${flag(recursive)}"/>`,
        `  <Object fullName="Справочник.Товары" includeChildObjects="${flag(recursive)}">`,
        '  </Object>',
        `  <Object fullName="Подсистема.Продажи" includeChildObjects="${flag(recursive)}">`,
        `    <Subsystem includeObjectsFromSubordinateSubsystems="${flag(recursive)}"/>`,
        '  </Object>',
        '</Objects>',
        '',
      ].join('\n');
      assert.strictEqual(
        buildObjectsSelectionXml([ROOT, object('Справочник.Товары'), object('Подсистема.Продажи', true)], recursive),
        expected
      );
    });
  }

  test('список объектов без корня: объекты в порядке записей, специальные символы экранируются', () => {
    assert.strictEqual(
      buildObjectsSelectionXml([object('Справочник.Т&Т'), object('Документ.Заказ')], false),
      xmlOf(...objectLines('Справочник.Т&amp;Т', false), ...objectLines('Документ.Заказ', false))
    );
  });
});

suite('RepositoryObjectsSelection: mergeSelectionEntries', () => {
  test('пустой список → пусто', () => {
    assert.deepStrictEqual(mergeSelectionEntries([]), []);
  });

  test('дубликат объекта схлопывается', () => {
    assert.deepStrictEqual(
      mergeSelectionEntries([object('Справочник.Товары'), object('Справочник.Товары')]),
      [object('Справочник.Товары')]
    );
  });

  test('дубликат в другом регистре схлопывается, остаётся первое написание', () => {
    assert.deepStrictEqual(
      mergeSelectionEntries([object('Справочник.Товары'), object('справочник.ТОВАРЫ')]),
      [object('Справочник.Товары')]
    );
    assert.deepStrictEqual(
      mergeSelectionEntries([object('справочник.ТОВАРЫ'), object('Справочник.Товары')]),
      [object('справочник.ТОВАРЫ')]
    );
  });

  test('два корня — один', () => {
    assert.deepStrictEqual(mergeSelectionEntries([ROOT, object('Справочник.А'), ROOT]), [ROOT, object('Справочник.А')]);
  });

  test('корень не первым — переносится первым; порядок объектов — порядок появления', () => {
    assert.deepStrictEqual(
      mergeSelectionEntries([object('Справочник.Б'), object('Справочник.А'), ROOT, object('Справочник.Б'), object('Документ.В')]),
      [ROOT, object('Справочник.Б'), object('Справочник.А'), object('Документ.В')]
    );
  });

  test('подсистема и объект с разными именами не склеиваются', () => {
    assert.deepStrictEqual(
      mergeSelectionEntries([object('Подсистема.П', true), object('Справочник.А')]),
      [object('Подсистема.П', true), object('Справочник.А')]
    );
  });
});

suite('RepositoryObjectsSelection: selectionFullNames', () => {
  test('cf: корень (служебное имя) первым, затем объекты', () => {
    assert.deepStrictEqual(
      selectionFullNames([ROOT, object('Справочник.А'), object('Документ.Б')], CF_ROOT_NAME),
      [CF_ROOT_NAME, 'Справочник.А', 'Документ.Б']
    );
  });

  test('cfe: служебное имя корня расширения', () => {
    assert.deepStrictEqual(selectionFullNames([ROOT, object('Справочник.А')], CFE_ROOT_NAME), [CFE_ROOT_NAME, 'Справочник.А']);
  });

  test('без корня: только объекты, служебного имени нет', () => {
    assert.deepStrictEqual(selectionFullNames([object('Справочник.А')], CF_ROOT_NAME), ['Справочник.А']);
    assert.deepStrictEqual(selectionFullNames([object('Справочник.А')], CFE_ROOT_NAME), ['Справочник.А']);
  });

  test('только корень', () => {
    assert.deepStrictEqual(selectionFullNames([ROOT], CF_ROOT_NAME), [CF_ROOT_NAME]);
  });
});

suite('RepositoryObjectsSelection: selectLockedInSelection', () => {
  const LOCKED = ['Справочник.А', CF_ROOT_NAME, 'Справочник.Б', 'Документ.В'];

  test('корень рекурсивно: все захваты цели', () => {
    assert.deepStrictEqual(selectLockedInSelection(LOCKED, [ROOT], true, CF_ROOT_NAME), LOCKED);
  });

  test('корень нерекурсивно: только захват самого корня', () => {
    assert.deepStrictEqual(selectLockedInSelection(LOCKED, [ROOT], false, CF_ROOT_NAME), [CF_ROOT_NAME]);
    assert.deepStrictEqual(selectLockedInSelection(['Справочник.А'], [ROOT], false, CF_ROOT_NAME), []);
  });

  for (const recursive of [false, true]) {
    test(`подсистема (recursive=${String(recursive)}): состав не разрешается — все захваты цели (Э33.5)`, () => {
      assert.deepStrictEqual(selectLockedInSelection(LOCKED, [object('Подсистема.П', true)], recursive, CF_ROOT_NAME), LOCKED);
    });

    test(`объект захвачен (recursive=${String(recursive)}): [его имя]`, () => {
      assert.deepStrictEqual(selectLockedInSelection(LOCKED, [object('Справочник.Б')], recursive, CF_ROOT_NAME), ['Справочник.Б']);
    });

    test(`объект не захвачен (recursive=${String(recursive)}): пусто`, () => {
      assert.deepStrictEqual(selectLockedInSelection(LOCKED, [object('Справочник.Нет')], recursive, CF_ROOT_NAME), []);
    });
  }

  test('два объекта: порядок — как в учёте (locked), а не как в выборке', () => {
    assert.deepStrictEqual(
      selectLockedInSelection(LOCKED, [object('Документ.В'), object('Справочник.А')], false, CF_ROOT_NAME),
      ['Справочник.А', 'Документ.В']
    );
  });

  test('два объекта, захвачен один', () => {
    assert.deepStrictEqual(
      selectLockedInSelection(LOCKED, [object('Справочник.Б'), object('Справочник.Нет')], false, CF_ROOT_NAME),
      ['Справочник.Б']
    );
  });

  test('корень нерекурсивно + объект: захваты корня и объекта', () => {
    assert.deepStrictEqual(
      selectLockedInSelection(LOCKED, [ROOT, object('Справочник.Б')], false, CF_ROOT_NAME),
      [CF_ROOT_NAME, 'Справочник.Б']
    );
  });

  test('пустой учёт: пусто для любой выборки', () => {
    assert.deepStrictEqual(selectLockedInSelection([], [ROOT], true, CF_ROOT_NAME), []);
    assert.deepStrictEqual(selectLockedInSelection([], [object('Справочник.А')], false, CF_ROOT_NAME), []);
    assert.deepStrictEqual(selectLockedInSelection([], [object('Подсистема.П', true)], true, CF_ROOT_NAME), []);
  });

  test('cfe: корень расширения — служебное имя расширения', () => {
    assert.deepStrictEqual(
      selectLockedInSelection(['Справочник.А', CFE_ROOT_NAME], [ROOT], false, CFE_ROOT_NAME),
      [CFE_ROOT_NAME]
    );
  });
});

suite('RepositoryObjectsSelection: toSelectionNodes', () => {
  const a: RepositoryNodeRef = { nodeKind: 'Catalog', label: 'А' };
  const b: RepositoryNodeRef = { nodeKind: 'Catalog', label: 'Б' };

  test('один узел → список из одного узла', () => {
    assert.deepStrictEqual(toSelectionNodes(a), [a]);
  });

  test('массив → те же узлы в том же порядке', () => {
    assert.deepStrictEqual(toSelectionNodes([a, b]), [a, b]);
  });
});

function fakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

const CONFIGURATION_XML =
  '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Configuration uuid="11111111-1111-1111-1111-111111111111"><Properties><Name>Основная</Name></Properties></Configuration></MetaDataObject>';
const EXTENSION_XML =
  '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Configuration uuid="22222222-2222-2222-2222-222222222222"><Properties><Name>EVOLC</Name><ConfigurationExtensionPurpose>Patch</ConfigurationExtensionPurpose></Properties></Configuration></MetaDataObject>';
const objectXml = (tag: string, name: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><${tag} uuid="33333333-3333-3333-3333-333333333333"><Properties><Name>${name}</Name></Properties></${tag}></MetaDataObject>`;

suite('RepositoryService: выборка по списку узлов', () => {
  let workspaceRoot: string;
  let service: RepositoryService;
  let cfRoot: string;
  let cfeRoot: string;
  let cfTarget: RepositoryTarget;
  let goods: RepositoryNodeRef;
  let stock: RepositoryNodeRef;
  let sales: RepositoryNodeRef;
  let cfRootNode: RepositoryNodeRef;
  let cfeCatalog: RepositoryNodeRef;
  let cfeRootNode: RepositoryNodeRef;

  const write = (filePath: string, content: string): string => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  };

  setup(() => {
    workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-objsel-list-')));
    cfRoot = path.join(workspaceRoot, 'src', 'cf');
    cfeRoot = path.join(workspaceRoot, 'src', 'cfe', 'EVOLC');
    write(path.join(cfRoot, 'Configuration.xml'), CONFIGURATION_XML);
    write(path.join(cfeRoot, 'Configuration.xml'), EXTENSION_XML);
    const goodsXml = write(path.join(cfRoot, 'Catalogs', 'Товары.xml'), objectXml('Catalog', 'Товары'));
    const stockXml = write(path.join(cfRoot, 'Catalogs', 'Склады.xml'), objectXml('Catalog', 'Склады'));
    const salesXml = write(path.join(cfRoot, 'Subsystems', 'Продажи.xml'), objectXml('Subsystem', 'Продажи'));
    const cfeCatalogXml = write(path.join(cfeRoot, 'Catalogs', 'Партнёры.xml'), objectXml('Catalog', 'Партнёры'));
    goods = { nodeKind: 'Catalog', label: 'Товары', xmlPath: goodsXml };
    stock = { nodeKind: 'Catalog', label: 'Склады', xmlPath: stockXml };
    sales = { nodeKind: 'Subsystem', label: 'Продажи', xmlPath: salesXml };
    cfRootNode = { nodeKind: 'configuration', label: 'Основная', xmlPath: path.join(cfRoot, 'Configuration.xml') };
    cfeCatalog = { nodeKind: 'Catalog', label: 'Партнёры', xmlPath: cfeCatalogXml };
    cfeRootNode = { nodeKind: 'extension', label: 'EVOLC', xmlPath: path.join(cfeRoot, 'Configuration.xml') };
    service = new RepositoryService(workspaceRoot, new ProjectSecretStorage(fakeSecretStore(), workspaceRoot));
    const target = service.resolveTargetByConfigRoot(cfRoot);
    assert.ok(target);
    cfTarget = target;
  });

  teardown(() => {
    removeTreeSync(workspaceRoot);
  });

  suite('resolveSelectionEntry', () => {
    test('корень конфигурации и корень расширения → { kind: root }', () => {
      assert.deepStrictEqual(service.resolveSelectionEntry(cfRootNode), { kind: 'root' });
      assert.deepStrictEqual(service.resolveSelectionEntry(cfeRootNode), { kind: 'root' });
    });

    test('обычный объект → { object, fullName, subsystem: false }; подсистема → subsystem: true', () => {
      assert.deepStrictEqual(service.resolveSelectionEntry(goods), { kind: 'object', fullName: 'Справочник.Товары', subsystem: false });
      assert.deepStrictEqual(service.resolveSelectionEntry(sales), { kind: 'object', fullName: 'Подсистема.Продажи', subsystem: true });
    });

    test('дочерний узел сводится к владельцу', () => {
      const child: RepositoryNodeRef = {
        nodeKind: 'Attribute', label: 'Артикул', xmlPath: goods.xmlPath,
        metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: goods.xmlPath },
      };
      assert.deepStrictEqual(service.resolveSelectionEntry(child), { kind: 'object', fullName: 'Справочник.Товары', subsystem: false });
    });

    test('ошибки: нет xmlPath / вне конфигурации, нет типа, нет полного имени (тексты прежние)', () => {
      assert.throws(() => service.resolveSelectionEntry({ nodeKind: 'Catalog', label: 'Товары' }), /корень конфигурации/);
      const stray = path.join(os.tmpdir(), `v8vscedit-stray-list-${String(process.pid)}.xml`);
      assert.throws(() => service.resolveSelectionEntry({ nodeKind: 'Catalog', label: 'Т', xmlPath: stray }), /корень конфигурации/);
      assert.throws(() => service.resolveSelectionEntry({ label: 'Товары', xmlPath: goods.xmlPath }), /не определён тип/);
      assert.throws(
        () => service.resolveSelectionEntry({ nodeKind: 'Attribute', label: 'Артикул', xmlPath: goods.xmlPath }),
        /полное имя/
      );
    });
  });

  suite('buildObjectsSelectionForNodes', () => {
    test('реквизит и его владелец → один fullName (дедупликация)', () => {
      const child: RepositoryNodeRef = {
        nodeKind: 'Attribute', label: 'Артикул', xmlPath: goods.xmlPath,
        metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: goods.xmlPath },
      };
      const selection = service.buildObjectsSelectionForNodes([child, goods], true);
      assert.deepStrictEqual(selection.fullNames, ['Справочник.Товары']);
      assert.strictEqual(selection.xml, xmlOf(...objectLines('Справочник.Товары', true)));
      assert.deepStrictEqual(selection.target, cfTarget);
    });

    test('дубликат в другом порядке и повтор узла: одна запись', () => {
      const selection = service.buildObjectsSelectionForNodes([goods, stock, goods], false);
      assert.deepStrictEqual(selection.fullNames, ['Справочник.Товары', 'Справочник.Склады']);
    });

    test('корень + объект + подсистема: корень первым, XML — эталон списка, fullNames с служебным именем корня', () => {
      const selection = service.buildObjectsSelectionForNodes([goods, sales, cfRootNode], false);
      assert.deepStrictEqual(selection.fullNames, [CF_ROOT_NAME, 'Справочник.Товары', 'Подсистема.Продажи']);
      assert.strictEqual(selection.xml, xmlOf(
        rootLine(false), ...objectLines('Справочник.Товары', false), ...objectLines('Подсистема.Продажи', false, true)
      ));
    });

    test('список из одного узла совпадает с buildObjectsSelectionForNode (делегат)', () => {
      for (const node of [goods, sales, cfRootNode]) {
        for (const recursive of [false, true]) {
          const single = service.buildObjectsSelectionForNode(node, recursive);
          const list = service.buildObjectsSelectionForNodes([node], recursive);
          assert.strictEqual(list.xml, single.xml);
          assert.deepStrictEqual(list.fullNames, single.fullNames);
        }
      }
    });

    test('узлы разных конфигураций (cf + cfe): ошибка о разных конфигурациях хранилища', () => {
      assert.throws(
        () => service.buildObjectsSelectionForNodes([goods, cfeCatalog], false),
        /Узлы выборки относятся к разным конфигурациям хранилища/
      );
    });

    test('пустой список: «Выборка объектов хранилища пуста.»', () => {
      assert.throws(() => service.buildObjectsSelectionForNodes([], false), /Выборка объектов хранилища пуста\./);
    });

    test('узел без xmlPath внутри списка: прежняя ошибка резолвинга', () => {
      assert.throws(() => service.buildObjectsSelectionForNodes([goods, { nodeKind: 'Catalog', label: 'Х' }], false), /корень конфигурации/);
    });

    test('ничего не пишет на диск: слепок рабочей области до и после совпадает, .v8vscedit не создан', () => {
      const before = snapshotTree(workspaceRoot);
      service.buildObjectsSelectionForNodes([goods, stock, sales, cfRootNode], true);
      service.buildObjectsSelectionForNodes([cfeCatalog, cfeRootNode], false);
      assert.deepStrictEqual(diffSnapshots(before, snapshotTree(workspaceRoot)), []);
      assert.strictEqual(fs.existsSync(path.join(workspaceRoot, '.v8vscedit')), false);
    });
  });

  suite('findLockedInSelectionForNodes', () => {
    test('два объекта: захваченные из них, порядок — как в учёте', () => {
      service.setLocked(cfTarget, ['Справочник.Склады', 'Справочник.Товары', 'Документ.Другой'], true);
      assert.deepStrictEqual(
        [...service.findLockedInSelectionForNodes([goods, stock], false)].sort(),
        ['Справочник.Склады', 'Справочник.Товары']
      );
      assert.deepStrictEqual(service.findLockedInSelectionForNodes([goods], false), ['Справочник.Товары']);
    });

    test('ни один не захвачен: пусто', () => {
      service.setLocked(cfTarget, ['Документ.Другой'], true);
      assert.deepStrictEqual(service.findLockedInSelectionForNodes([goods, stock], true), []);
    });

    test('в списке подсистема: все захваты цели, даже нерекурсивно (Э33.5)', () => {
      service.setLocked(cfTarget, ['Справочник.Склады', 'Документ.Другой'], true);
      assert.deepStrictEqual(
        [...service.findLockedInSelectionForNodes([goods, sales], false)].sort(),
        ['Документ.Другой', 'Справочник.Склады']
      );
    });

    test('рекурсивный корень в списке: все захваты цели', () => {
      service.setLocked(cfTarget, ['Справочник.Склады', '__configuration_root__'], true);
      assert.deepStrictEqual(
        [...service.findLockedInSelectionForNodes([goods, cfRootNode], true)].sort(),
        ['Справочник.Склады', '__configuration_root__'].sort()
      );
    });

    test('узел вне конфигурации или без xmlPath: пусто (выборку всё равно не построить)', () => {
      service.setLocked(cfTarget, ['Справочник.Товары'], true);
      assert.deepStrictEqual(service.findLockedInSelectionForNodes([{ nodeKind: 'Catalog', label: 'Товары' }], true), []);
      assert.deepStrictEqual(service.findLockedInSelectionForNodes([], true), []);
    });

    test('прежний findLockedInSelection — делегат: подсистема нерекурсивно даёт все захваты цели (Э33.5)', () => {
      service.setLocked(cfTarget, ['Справочник.Склады'], true);
      assert.deepStrictEqual(service.findLockedInSelection(sales, false), ['Справочник.Склады']);
      assert.deepStrictEqual(service.findLockedInSelection(goods, false), []);
    });
  });
});
