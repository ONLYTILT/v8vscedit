import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { createLockedObjectFilter } from '../../infra/repository/RepositoryLockedObjectFilter';
import { RepositoryService, type RepositoryNodeRef, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { removeTreeSync } from './support/tempTree';

/**
 * `createLockedObjectFilter` (`infra/repository/RepositoryLockedObjectFilter.ts`): срез локального учёта захватов одной цели для
 * отбора дерева «только захваченные». Учёт ведётся по объекту-владельцу, поэтому дочерние
 * элементы (реквизит, форма) отбор пропускает, не вычисляя владельца по XML.
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

suite('createLockedObjectFilter: отбор захваченных объектов', () => {
  let root: string;
  let cfRoot: string;
  let cfeRoot: string;
  let service: RepositoryService;
  let cfTarget: RepositoryTarget;
  let cfeTarget: RepositoryTarget;

  const catalog = (dir: string, name: string): RepositoryNodeRef =>
    ({ nodeKind: 'Catalog', label: name, xmlPath: path.join(dir, 'Catalogs', `${name}.xml`) });
  const configXml = (dir: string): string => path.join(dir, 'Configuration.xml');

  async function bind(target: RepositoryTarget): Promise<void> {
    await service.saveBinding(target, { repoPath: 'tcp://repo/storage', repoUser: 'tester', repoPassword: '' });
  }

  setup(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-locked-filter-')));
    cfRoot = path.join(root, 'src', 'cf');
    cfeRoot = path.join(root, 'src', 'cfe', 'Расш');
    for (const [dir, xml] of [[cfRoot, CF_XML], [cfeRoot, CFE_XML]] as const) {
      fs.mkdirSync(path.join(dir, 'Catalogs'), { recursive: true });
      fs.writeFileSync(configXml(dir), xml);
      fs.writeFileSync(path.join(dir, 'Catalogs', 'Товары.xml'), catalogXml('Товары'));
      fs.writeFileSync(path.join(dir, 'Catalogs', 'Склады.xml'), catalogXml('Склады'));
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

  test('цель без привязки к хранилищу — null (захватов у неё быть не может)', () => {
    service.setLocked(cfTarget, ['Справочник.Товары'], true);
    assert.strictEqual(createLockedObjectFilter(service, configXml(cfRoot)), null);
  });

  test('привязка есть, но хранилище отключено — null, как у индикатора захвата в дереве', async () => {
    await bind(cfTarget);
    service.setLocked(cfTarget, ['Справочник.Товары'], true);
    service.setConnected(cfTarget, false);
    assert.strictEqual(createLockedObjectFilter(service, configXml(cfRoot)), null);
  });

  test('путь вне выгрузки (нет Configuration.xml) — null', () => {
    assert.strictEqual(createLockedObjectFilter(service, path.join(root, 'нет', 'Configuration.xml')), null);
  });

  test('ничего не захвачено: корень не захвачен, объект — искать глубже', async () => {
    await bind(cfTarget);
    const filter = createLockedObjectFilter(service, configXml(cfRoot));
    assert.ok(filter);
    assert.strictEqual(filter.rootLocked, false);
    assert.strictEqual(filter.classify(catalog(cfRoot, 'Товары')), 'descend');
  });

  test('захваченный объект — locked, незахваченный — descend', async () => {
    await bind(cfTarget);
    service.setLocked(cfTarget, ['Справочник.Товары'], true);
    const filter = createLockedObjectFilter(service, configXml(cfRoot));
    assert.ok(filter);
    assert.strictEqual(filter.classify(catalog(cfRoot, 'Товары')), 'locked');
    assert.strictEqual(filter.classify(catalog(cfRoot, 'Склады')), 'descend');
  });

  test('дочерний элемент захваченного владельца — skip: учёт ведётся по владельцу', async () => {
    await bind(cfTarget);
    service.setLocked(cfTarget, ['Справочник.Товары'], true);
    const filter = createLockedObjectFilter(service, configXml(cfRoot));
    assert.ok(filter);
    const ownerXml = path.join(cfRoot, 'Catalogs', 'Товары.xml');
    for (const kind of ['Attribute', 'Form', 'TabularSection']) {
      assert.strictEqual(
        filter.classify({ nodeKind: kind, label: 'Элемент', xmlPath: ownerXml, metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: ownerXml } }),
        'skip',
        kind
      );
    }
  });

  test('узлы-группы — descend (полного имени у них нет)', async () => {
    await bind(cfTarget);
    const filter = createLockedObjectFilter(service, configXml(cfRoot));
    assert.ok(filter);
    for (const kind of ['group-type', 'group-common']) {
      assert.strictEqual(filter.classify({ nodeKind: kind, label: 'Справочники' }), 'descend', kind);
    }
    // Служебный узел без вида («Загрузка...») не роняет отбор и не считается захваченным.
    assert.strictEqual(filter.classify({ label: 'Загрузка...' }), 'descend');
  });

  test('захвачен корень конфигурации — rootLocked', async () => {
    await bind(cfTarget);
    service.setLocked(cfTarget, [service.getRootLockName(cfTarget)], true);
    const filter = createLockedObjectFilter(service, configXml(cfRoot));
    assert.strictEqual(filter?.rootLocked, true);
  });

  test('расширение: свой учёт и своё служебное имя корня, учёт основной конфигурации не смешивается', async () => {
    await bind(cfTarget);
    await bind(cfeTarget);
    service.setLocked(cfTarget, ['Справочник.Склады'], true);
    service.setLocked(cfeTarget, [service.getRootLockName(cfeTarget), 'Справочник.Товары'], true);
    const filter = createLockedObjectFilter(service, configXml(cfeRoot));
    assert.ok(filter);
    assert.strictEqual(filter.rootLocked, true);
    assert.strictEqual(filter.classify(catalog(cfeRoot, 'Товары')), 'locked');
    assert.strictEqual(filter.classify(catalog(cfeRoot, 'Склады')), 'descend');
  });
});
