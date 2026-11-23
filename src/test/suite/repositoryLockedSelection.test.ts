import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { RepositoryService, type RepositoryNodeRef, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { removeTreeSync } from './support/tempTree';

/**
 * `RepositoryService.findLockedInSelection`: какие захваченные (по локальному учёту) объекты попадут
 * в выборку операции хранилища. Э24: получение затирает правки захваченного объекта в базе, поэтому
 * команда «Получить» спрашивает подтверждение по этому списку. Выгрузка — во временном каталоге.
 */

function fakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

const CF_XML =
  '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Configuration uuid="11111111-1111-1111-1111-111111111111"><Properties><Name>Основная</Name></Properties></Configuration></MetaDataObject>';
const CFE_XML =
  '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Configuration uuid="22222222-2222-2222-2222-222222222222"><Properties><Name>Расш</Name><ConfigurationExtensionPurpose>Customization</ConfigurationExtensionPurpose></Properties></Configuration></MetaDataObject>';
const catalogXml = (name: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Catalog uuid="33333333-3333-3333-3333-333333333333"><Properties><Name>${name}</Name></Properties></Catalog></MetaDataObject>`;
const SUBSYSTEM_XML =
  '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Subsystem uuid="44444444-4444-4444-4444-444444444444"><Properties><Name>Продажи</Name></Properties></Subsystem></MetaDataObject>';

suite('RepositoryService.findLockedInSelection: захваченные объекты в выборке операции', () => {
  let root: string;
  let cfRoot: string;
  let cfeRoot: string;
  let service: RepositoryService;
  let cfTarget: RepositoryTarget;
  let cfeTarget: RepositoryTarget;

  const node = (dir: string, kind: string, folder: string, name: string): RepositoryNodeRef =>
    ({ nodeKind: kind, label: name, xmlPath: path.join(dir, folder, `${name}.xml`) });
  const rootNode = (dir: string, kind: 'configuration' | 'extension'): RepositoryNodeRef =>
    ({ nodeKind: kind, label: 'корень', xmlPath: path.join(dir, 'Configuration.xml') });

  setup(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-locked-selection-')));
    cfRoot = path.join(root, 'src', 'cf');
    cfeRoot = path.join(root, 'src', 'cfe', 'Расш');
    for (const [dir, xml] of [[cfRoot, CF_XML], [cfeRoot, CFE_XML]] as const) {
      fs.mkdirSync(path.join(dir, 'Catalogs'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'Subsystems'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'Configuration.xml'), xml);
      fs.writeFileSync(path.join(dir, 'Catalogs', 'Товары.xml'), catalogXml('Товары'));
      fs.writeFileSync(path.join(dir, 'Catalogs', 'Склады.xml'), catalogXml('Склады'));
      fs.writeFileSync(path.join(dir, 'Subsystems', 'Продажи.xml'), SUBSYSTEM_XML);
    }
    service = new RepositoryService(root, new ProjectSecretStorage(fakeSecretStore(), root));
    const cf = service.resolveTargetByConfigRoot(cfRoot);
    const cfe = service.resolveTargetByConfigRoot(cfeRoot);
    assert.ok(cf && cfe);
    cfTarget = cf;
    cfeTarget = cfe;
  });

  teardown(() => {
    removeTreeSync(root);
  });

  test('ничего не захвачено: пусто для любого узла и режима', () => {
    for (const recursive of [true, false]) {
      assert.deepStrictEqual(service.findLockedInSelection(node(cfRoot, 'Catalog', 'Catalogs', 'Товары'), recursive), []);
      assert.deepStrictEqual(service.findLockedInSelection(rootNode(cfRoot, 'configuration'), recursive), []);
    }
  });

  for (const recursive of [true, false]) {
    test(`объект захвачен, выборка — он сам (recursive=${String(recursive)}): [его имя]`, () => {
      service.setLocked(cfTarget, ['Справочник.Товары'], true);
      assert.deepStrictEqual(
        service.findLockedInSelection(node(cfRoot, 'Catalog', 'Catalogs', 'Товары'), recursive),
        ['Справочник.Товары']
      );
    });

    test(`захвачен другой объект, выборка — незахваченный (recursive=${String(recursive)}): пусто`, () => {
      service.setLocked(cfTarget, ['Справочник.Склады'], true);
      assert.deepStrictEqual(service.findLockedInSelection(node(cfRoot, 'Catalog', 'Catalogs', 'Товары'), recursive), []);
    });
  }

  test('корень рекурсивно: все захваченные цели, включая корень', () => {
    service.setLocked(cfTarget, ['Справочник.Товары', 'Справочник.Склады', '__configuration_root__'], true);
    assert.deepStrictEqual(
      [...service.findLockedInSelection(rootNode(cfRoot, 'configuration'), true)].sort(),
      ['Справочник.Склады', 'Справочник.Товары', '__configuration_root__'].sort()
    );
  });

  test('корень не рекурсивно: только корень, если он захвачен', () => {
    service.setLocked(cfTarget, ['Справочник.Товары'], true);
    assert.deepStrictEqual(service.findLockedInSelection(rootNode(cfRoot, 'configuration'), false), []);
    service.setLocked(cfTarget, ['__configuration_root__'], true);
    assert.deepStrictEqual(service.findLockedInSelection(rootNode(cfRoot, 'configuration'), false), ['__configuration_root__']);
  });

  test('корень расширения рекурсивно: захваты расширения, а не основной конфигурации', () => {
    service.setLocked(cfTarget, ['Справочник.Склады'], true);
    service.setLocked(cfeTarget, ['Справочник.Товары', '__extension_root__'], true);
    assert.deepStrictEqual(
      [...service.findLockedInSelection(rootNode(cfeRoot, 'extension'), true)].sort(),
      ['Справочник.Товары', '__extension_root__'].sort()
    );
  });

  test('подсистема рекурсивно: состав не разрешается — консервативно все захваченные цели', () => {
    service.setLocked(cfTarget, ['Справочник.Склады'], true);
    assert.deepStrictEqual(
      service.findLockedInSelection(node(cfRoot, 'Subsystem', 'Subsystems', 'Продажи'), true),
      ['Справочник.Склады']
    );
  });

  test('подсистема не рекурсивно (Э33.5): элемент Subsystem включает состав и без рекурсии — консервативно все захваты цели', () => {
    service.setLocked(cfTarget, ['Справочник.Склады'], true);
    assert.deepStrictEqual(
      service.findLockedInSelection(node(cfRoot, 'Subsystem', 'Subsystems', 'Продажи'), false),
      ['Справочник.Склады']
    );
  });

  test('узел без xmlPath или вне корней: пусто (выборку всё равно не построить)', () => {
    service.setLocked(cfTarget, ['Справочник.Товары'], true);
    assert.deepStrictEqual(service.findLockedInSelection({ nodeKind: 'Catalog', label: 'Товары' }, true), []);
    assert.deepStrictEqual(
      service.findLockedInSelection({ nodeKind: 'Catalog', label: 'Чужой', xmlPath: path.join(os.tmpdir(), 'вне', 'Catalogs', 'Чужой.xml') }, true),
      []
    );
  });

  test('узел, для которого полное имя не строится (группа): пусто', () => {
    service.setLocked(cfTarget, ['Справочник.Товары'], true);
    assert.deepStrictEqual(
      service.findLockedInSelection({ nodeKind: 'group-type', label: 'Справочники', xmlPath: path.join(cfRoot, 'Catalogs', 'Товары.xml') }, true),
      []
    );
  });
});
