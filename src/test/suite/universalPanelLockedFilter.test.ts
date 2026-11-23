/**
 * Кнопка «только захваченные» у строки поиска навигатора (аналог отбора захваченных
 * объектов в Конфигураторе). Захват — по локальному учёту `RepositoryService` (тот же,
 * по которому рисуется замок у узла). Отбор сочетается с поиском по тексту (И).
 *
 * При активном фильтре ветки к оставшимся узлам приходят раскрытыми: иначе включённый
 * отбор показал бы один свёрнутый корень. Это же касается и обычного поиска.
 *
 * Конфигурация синтетическая (реальный `MetadataXmlCreator`), сервис хранилища — настоящий
 * над временным каталогом с привязкой в `env.json`.
 */
import * as assert from 'assert';
import * as path from 'path';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { RepositoryService, type RepositoryTarget } from '../../infra/repository/RepositoryService';
import { MetadataXmlCreator } from '../../infra/xml/MetadataXmlCreator';
import { makeTempDir, removeTempDir } from './support/parentConfigurationsBin';
import { buildSupportConfig } from './support/supportConfigFixture';
import {
  createUniversalPanelFixture,
  type PanelStateLike,
  type TreeNodeDtoLike,
  type UniversalPanelFixture,
} from './support/universalPanelHarness';

const CATALOGS = 'Справочники';

interface StateNode {
  readonly id: string;
  readonly label: string;
  readonly hasChildren?: boolean;
  readonly children?: readonly StateNode[];
}

function fakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

/** Все узлы, которые webview получил в снимке (с уже подгруженными детьми), как пути меток. */
function visiblePaths(nodes: readonly StateNode[], prefix = ''): string[] {
  return nodes.flatMap((node) => {
    const own = prefix ? `${prefix}/${node.label}` : node.label;
    return [own, ...visiblePaths(node.children ?? [], own)];
  });
}

function findVisible(nodes: readonly StateNode[], label: string): StateNode | undefined {
  for (const node of nodes) {
    if (node.label === label) {
      return node;
    }
    const nested = findVisible(node.children ?? [], label);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

async function findByLabel(
  panel: UniversalPanelFixture,
  nodes: readonly TreeNodeDtoLike[],
  label: string,
  depth = 0
): Promise<TreeNodeDtoLike | undefined> {
  for (const node of nodes) {
    if (node.label === label) {
      return node;
    }
    if (depth < 3 && node.hasChildren) {
      const found = await findByLabel(panel, await panel.loadChildren(node.id), label, depth + 1);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

suite('UniversalPanelViewProvider — отбор захваченных объектов', () => {
  let tmp: string;
  let cfRoot: string;
  let repository: RepositoryService;
  let target: RepositoryTarget;
  let fixture: UniversalPanelFixture | undefined;

  setup(async () => {
    tmp = makeTempDir('v8vscedit-panel-locked-');
    cfRoot = path.join(tmp, 'cf');
    buildSupportConfig(cfRoot, false);
    // У незахваченного справочника есть состав: отбор должен пройти мимо его дочерних элементов,
    // а не искать в них захваты (учёт ведётся по объекту-владельцу).
    const added = new MetadataXmlCreator().addChildElement({
      ownerObjectXmlPath: path.join(cfRoot, 'Catalogs', 'Собственный.xml'),
      childTag: 'Attribute',
      name: 'Код1С',
    });
    assert.ok(added.success, added.errors.join('; '));
    repository =new RepositoryService(tmp, new ProjectSecretStorage(fakeSecretStore(), tmp));
    const resolved = repository.resolveTargetByConfigRoot(cfRoot);
    assert.ok(resolved, 'цель хранилища для синтетической конфигурации');
    target = resolved;
    await repository.saveBinding(target, { repoPath: 'tcp://repo/storage', repoUser: 'tester', repoPassword: '' });
  });

  teardown(() => {
    fixture?.dispose();
    fixture = undefined;
    removeTempDir(tmp);
  });

  function open(withRepository = true): UniversalPanelFixture {
    fixture = createUniversalPanelFixture({
      entries: [{ kind: 'cf', rootPath: cfRoot }],
      repositoryService: withRepository ? repository : undefined,
    });
    return fixture;
  }

  const enable = (panel: UniversalPanelFixture, enabled = true): Promise<PanelStateLike> =>
    panel.requestState('setLockedFilter', { enabled });

  test('отбор включён: видны только захваченный объект и путь к нему, ветки раскрыты', async function () {
    this.timeout(60_000);
    repository.setLocked(target, ['Справочник.Разрешённый'], true);
    const panel = open();

    const state = await enable(panel);

    assert.strictEqual(state.lockedOnly, true);
    assert.strictEqual(state.rootNodes.length, 1, 'корень «Расширения» без захватов скрыт');
    const root = state.rootNodes[0];
    assert.deepStrictEqual(visiblePaths(state.rootNodes), [
      root.label,
      `${root.label}/${CATALOGS}`,
      `${root.label}/${CATALOGS}/Разрешённый`,
    ]);
    const catalogsGroup = findVisible(state.rootNodes, CATALOGS);
    assert.ok(catalogsGroup);
    assert.ok(state.openNodeIds.includes(root.id), 'корень раскрыт');
    assert.ok(state.openNodeIds.includes(catalogsGroup.id), 'группа раскрыта');
  });

  test('захваченный объект сохраняет свой состав (дети не отсекаются отбором)', async function () {
    this.timeout(60_000);
    repository.setLocked(target, ['Справочник.Разрешённый'], true);
    const panel = open();
    const unfiltered = await findByLabel(panel, panel.rootNodes, 'Разрешённый');
    assert.ok(unfiltered);

    const state = await enable(panel);

    const locked = findVisible(state.rootNodes, 'Разрешённый');
    assert.ok(locked);
    assert.strictEqual(Boolean(locked.hasChildren), Boolean(unfiltered.hasChildren));
    assert.ok(!state.openNodeIds.includes(locked.id), 'сам захваченный объект не раскрывается автоматически');
  });

  test('ничего не захвачено — дерево пустое', async function () {
    this.timeout(60_000);
    const state = await enable(open());
    assert.deepStrictEqual(state.rootNodes, []);
  });

  test('захвачен только корень конфигурации — виден один корень без детей', async function () {
    this.timeout(60_000);
    repository.setLocked(target, [repository.getRootLockName(target)], true);
    const state = await enable(open());
    assert.strictEqual(state.rootNodes.length, 1);
    assert.strictEqual(Boolean(state.rootNodes[0].hasChildren), false);
  });

  test('хранилище отключено — захваты не учитываются, дерево пустое', async function () {
    this.timeout(60_000);
    repository.setLocked(target, ['Справочник.Разрешённый'], true);
    repository.setConnected(target, false);
    const state = await enable(open());
    assert.deepStrictEqual(state.rootNodes, []);
  });

  test('без сервиса хранилища отбор даёт пустое дерево, а не полное', async function () {
    this.timeout(60_000);
    const state = await enable(open(false));
    assert.strictEqual(state.lockedOnly, true);
    assert.deepStrictEqual(state.rootNodes, []);
  });

  test('отбор и поиск работают вместе (И); очистка поиска возвращает все захваченные', async function () {
    this.timeout(60_000);
    repository.setLocked(target, ['Справочник.Разрешённый', 'Справочник.Запрещённый'], true);
    const panel = open();
    await enable(panel);

    const searched = await panel.search('Разреш');
    const searchedLabels = visiblePaths(searched.rootNodes);
    assert.ok(searchedLabels.some((p) => p.endsWith('/Разрешённый')), searchedLabels.join('\n'));
    assert.ok(!searchedLabels.some((p) => p.endsWith('/Запрещённый')), searchedLabels.join('\n'));

    const cleared = await panel.search('');
    const clearedLabels = visiblePaths(cleared.rootNodes);
    assert.strictEqual(cleared.lockedOnly, true, 'очистка поиска не снимает отбор');
    assert.ok(clearedLabels.some((p) => p.endsWith('/Разрешённый')));
    assert.ok(clearedLabels.some((p) => p.endsWith('/Запрещённый')));
    assert.ok(!clearedLabels.some((p) => p.endsWith('/Собственный')));
  });

  test('выключение отбора возвращает полное дерево', async function () {
    this.timeout(60_000);
    repository.setLocked(target, ['Справочник.Разрешённый'], true);
    const panel = open();
    await enable(panel);

    const state = await enable(panel, false);

    assert.strictEqual(state.lockedOnly, false);
    assert.strictEqual(state.rootNodes.length, 2, 'корень конфигурации и «Расширения»');
    assert.ok(!state.openNodeIds.includes(state.rootNodes[0].id), 'без фильтра ветки не раскрываются сами');
  });

  test('незахваченный объект с составом: ни он, ни его дочерние элементы в отбор не попадают', async function () {
    this.timeout(60_000);
    repository.setLocked(target, ['Справочник.Разрешённый'], true);
    const panel = open();
    const own = await findByLabel(panel, panel.rootNodes, 'Собственный');
    assert.ok(own?.hasChildren, 'у «Собственный» в полном дереве есть состав (реквизит Код1С)');

    const state = await enable(panel);

    const labels = visiblePaths(state.rootNodes);
    assert.ok(!labels.some((p) => p.includes('Собственный') || p.endsWith('Код1С')), labels.join('\n'));
  });

  test('запрос статуса автономного сервера проходит мимо отбора и не сбрасывает его', async function () {
    this.timeout(60_000);
    repository.setLocked(target, ['Справочник.Разрешённый'], true);
    const panel = open();
    await enable(panel);

    await panel.request('refreshStandaloneStatus', undefined, 'standaloneStatus');

    const state = await panel.search('');
    assert.strictEqual(state.lockedOnly, true);
  });

  test('поиск без отбора: ветки к найденному приходят раскрытыми', async function () {
    this.timeout(60_000);
    const panel = open();

    const state = await panel.search('Разреш');

    assert.strictEqual(state.lockedOnly, false);
    const found = findVisible(state.rootNodes, 'Разрешённый');
    assert.ok(found, visiblePaths(state.rootNodes).join('\n'));
    const catalogsGroup = findVisible(state.rootNodes, CATALOGS);
    assert.ok(catalogsGroup && state.openNodeIds.includes(catalogsGroup.id));
  });
});
