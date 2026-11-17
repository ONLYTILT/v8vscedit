import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { RepositoryService, type RepositoryNodeRef } from '../../infra/repository/RepositoryService';
import { diffSnapshots, snapshotTree } from './support/fsSnapshot';

/**
 * `buildObjectsSelectionForNode` — прежний `createObjectsFileForNode` без записи на диск.
 * Прежняя реализация складывала `.v8vscedit/repository/objects/*.xml` и никогда их
 * не удаляла (утечка), а содержимое уходило в `-Objects <файл>`. Теперь XML едет в
 * запросе как `inputFile`, поэтому на диске не остаётся ничего.
 *
 * Эталоны XML — литералы, снятые с вывода прежней реализации (включая завершающий
 * перевод строки, который прежний код дописывал при записи файла): формат принимает
 * платформа, менять его нельзя. Структура выгрузки собирается во временном каталоге,
 * а не берётся из `example/` — тест не зависит от наличия корпуса и ничего в нём не пишет.
 */

const NS = 'http://v8.1c.ru/8.3/config/objects';

function createFakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}

const CONFIGURATION_XML =
  '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Configuration uuid="11111111-1111-1111-1111-111111111111"><Properties><Name>Основная</Name></Properties></Configuration></MetaDataObject>';

const EXTENSION_XML =
  '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Configuration uuid="22222222-2222-2222-2222-222222222222"><Properties><Name>EVOLC</Name><ConfigurationExtensionPurpose>Patch</ConfigurationExtensionPurpose></Properties></Configuration></MetaDataObject>';

function objectXml(tag: string, name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><${tag} uuid="33333333-3333-3333-3333-333333333333"><Properties><Name>${name}</Name></Properties></${tag}></MetaDataObject>`;
}

function expectedObject(fullName: string, recursive: boolean, withSubsystem = false): string {
  const flag = recursive ? 'true' : 'false';
  const lines = [
    `<Objects xmlns="${NS}" version="1.0">`,
    `  <Object fullName="${fullName}" includeChildObjects="${flag}">`,
  ];
  if (withSubsystem) {
    lines.push(`    <Subsystem includeObjectsFromSubordinateSubsystems="${flag}"/>`);
  }
  lines.push('  </Object>', '</Objects>');
  return `${lines.join('\n')}\n`;
}

function expectedRoot(recursive: boolean): string {
  return [
    `<Objects xmlns="${NS}" version="1.0">`,
    `  <Configuration includeChildObjects="${recursive ? 'true' : 'false'}"/>`,
    '</Objects>',
    '',
  ].join('\n');
}

suite('RepositoryService.buildObjectsSelectionForNode', () => {
  let workspaceRoot: string;
  let service: RepositoryService;
  let cfRoot: string;
  let cfeRoot: string;
  let catalogXml: string;

  function write(filePath: string, content: string): string {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  setup(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-objsel-'));
    cfRoot = path.join(workspaceRoot, 'src', 'cf');
    cfeRoot = path.join(workspaceRoot, 'src', 'cfe', 'EVOLC');
    write(path.join(cfRoot, 'Configuration.xml'), CONFIGURATION_XML);
    write(path.join(cfeRoot, 'Configuration.xml'), EXTENSION_XML);
    catalogXml = write(path.join(cfRoot, 'Catalogs', 'Товары.xml'), objectXml('Catalog', 'Товары'));
    write(path.join(cfRoot, 'Subsystems', 'Продажи.xml'), objectXml('Subsystem', 'Продажи'));
    write(path.join(cfeRoot, 'Catalogs', 'Партнёры.xml'), objectXml('Catalog', 'Партнёры'));
    service = new RepositoryService(workspaceRoot, new ProjectSecretStorage(createFakeSecretStore(), workspaceRoot));
  });

  teardown(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  for (const recursive of [false, true]) {
    const mode = recursive ? 'рекурсивно' : 'нерекурсивно';

    test(`корень конфигурации (${mode})`, () => {
      const selection = service.buildObjectsSelectionForNode(
        { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(cfRoot, 'Configuration.xml') },
        recursive
      );
      assert.strictEqual(selection.xml, expectedRoot(recursive));
      assert.deepStrictEqual(selection.fullNames, ['__configuration_root__']);
    });

    test(`корень расширения (${mode})`, () => {
      const selection = service.buildObjectsSelectionForNode(
        { nodeKind: 'extension', label: 'EVOLC', xmlPath: path.join(cfeRoot, 'Configuration.xml') },
        recursive
      );
      assert.strictEqual(selection.xml, expectedRoot(recursive));
      assert.deepStrictEqual(selection.fullNames, ['__extension_root__']);
    });

    test(`обычный объект (${mode})`, () => {
      const selection = service.buildObjectsSelectionForNode(
        { nodeKind: 'Catalog', label: 'Товары', xmlPath: catalogXml },
        recursive
      );
      assert.strictEqual(selection.xml, expectedObject('Справочник.Товары', recursive));
      assert.deepStrictEqual(selection.fullNames, ['Справочник.Товары']);
    });

    test(`подсистема несёт элемент Subsystem (${mode})`, () => {
      const selection = service.buildObjectsSelectionForNode(
        { nodeKind: 'Subsystem', label: 'Продажи', xmlPath: path.join(cfRoot, 'Subsystems', 'Продажи.xml') },
        recursive
      );
      assert.strictEqual(selection.xml, expectedObject('Подсистема.Продажи', recursive, true));
      assert.deepStrictEqual(selection.fullNames, ['Подсистема.Продажи']);
    });
  }

  test('объект расширения резолвится в корень расширения, имя берётся из узла', () => {
    const selection = service.buildObjectsSelectionForNode(
      { nodeKind: 'Catalog', label: 'Партнёры', xmlPath: path.join(cfeRoot, 'Catalogs', 'Партнёры.xml') },
      false
    );
    assert.strictEqual(selection.xml, expectedObject('Справочник.Партнёры', false));
    assert.deepStrictEqual(selection.fullNames, ['Справочник.Партнёры']);
  });

  test('дочерний узел (реквизит) захватывается через владельца', () => {
    const selection = service.buildObjectsSelectionForNode(
      {
        nodeKind: 'Attribute',
        label: 'Артикул',
        xmlPath: catalogXml,
        metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: catalogXml },
      },
      true
    );
    assert.strictEqual(selection.xml, expectedObject('Справочник.Товары', true));
    assert.deepStrictEqual(selection.fullNames, ['Справочник.Товары']);
  });

  test('специальные символы в имени экранируются в XML, а fullNames хранит исходное имя', () => {
    const selection = service.buildObjectsSelectionForNode(
      { nodeKind: 'Catalog', label: 'Т&Т', xmlPath: catalogXml },
      false
    );
    assert.strictEqual(selection.xml, expectedObject('Справочник.Т&amp;Т', false));
    assert.deepStrictEqual(selection.fullNames, ['Справочник.Т&Т']);
  });

  test('ничего не пишет на диск: слепок рабочей области до и после совпадает, .v8vscedit не создан', () => {
    const before = snapshotTree(workspaceRoot);
    const nodes: RepositoryNodeRef[] = [
      { nodeKind: 'configuration', xmlPath: path.join(cfRoot, 'Configuration.xml') },
      { nodeKind: 'extension', xmlPath: path.join(cfeRoot, 'Configuration.xml') },
      { nodeKind: 'Catalog', label: 'Товары', xmlPath: catalogXml },
      { nodeKind: 'Subsystem', label: 'Продажи', xmlPath: path.join(cfRoot, 'Subsystems', 'Продажи.xml') },
    ];
    for (const node of nodes) {
      service.buildObjectsSelectionForNode(node, true);
      service.buildObjectsSelectionForNode(node, false);
    }

    assert.deepStrictEqual(diffSnapshots(before, snapshotTree(workspaceRoot)), []);
    assert.strictEqual(fs.existsSync(path.join(workspaceRoot, '.v8vscedit')), false);
  });

  test('прежний метод записи файла удалён: утечки objects/*.xml больше нет', () => {
    assert.strictEqual(
      (service as unknown as Record<string, unknown>).createObjectsFileForNode,
      undefined
    );
  });

  suite('ошибки', () => {
    test('узел без xmlPath', () => {
      assert.throws(
        () => service.buildObjectsSelectionForNode({ nodeKind: 'Catalog', label: 'Товары' }, false),
        /корень конфигурации/
      );
    });

    test('xmlPath вне любой конфигурации', () => {
      const stray = write(path.join(os.tmpdir(), `v8vscedit-stray-${String(process.pid)}.xml`), '<x/>');
      try {
        assert.throws(
          () => service.buildObjectsSelectionForNode({ nodeKind: 'Catalog', label: 'Товары', xmlPath: stray }, false),
          /корень конфигурации/
        );
      } finally {
        fs.rmSync(stray, { force: true });
      }
    });

    test('узел без типа', () => {
      assert.throws(
        () => service.buildObjectsSelectionForNode({ label: 'Товары', xmlPath: catalogXml }, false),
        /не определён тип/
      );
    });

    test('дочерний узел без владельца: полное имя не сформировать', () => {
      assert.throws(
        () => service.buildObjectsSelectionForNode({ nodeKind: 'Attribute', label: 'Артикул', xmlPath: catalogXml }, false),
        /полное имя/
      );
    });

    test('вид без имени в реестре платформенных имён: полное имя не сформировать', () => {
      assert.throws(
        () => service.buildObjectsSelectionForNode({ nodeKind: 'group-common', label: 'Общие', xmlPath: catalogXml }, false),
        /полное имя/
      );
    });
  });
});
