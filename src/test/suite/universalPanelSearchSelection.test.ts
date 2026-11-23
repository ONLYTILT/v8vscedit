/**
 * Выбранный узел навигатора переживает поиск: после очистки строки поиска
 * выделение и раскрытие ветки возвращаются на тот же узел.
 *
 * Id узлов в DTO позиционные (`n0_2_5`) и между перестроениями дерева указывают
 * на РАЗНЫЕ узлы. Поэтому, когда выбранного узла в текущем дереве нет (отфильтрован),
 * хост обязан прислать `selectedNodeId: null` явно: `undefined` теряется при
 * сериализации, webview оставляет старый id, и тот подсвечивает чужой узел,
 * занявший ту же позицию.
 *
 * Конфигурация синтетическая (реальный `MetadataXmlCreator`, четыре справочника) —
 * сьют не зависит от наличия эталонного корпуса `example/`. Выбирается узел-группа
 * «Справочники»: у неё нет `xmlPath`/`command`, поэтому `selectNode` не открывает
 * свойств/документов в headless-хосте.
 */
import * as assert from 'assert';
import * as path from 'path';
import { makeTempDir, removeTempDir } from './support/parentConfigurationsBin';
import { buildSupportConfig } from './support/supportConfigFixture';
import {
  createUniversalPanelFixture,
  type PanelStateLike,
  type TreeNodeDtoLike,
  type UniversalPanelFixture,
} from './support/universalPanelHarness';

const CATALOGS_GROUP_LABEL = 'Справочники';
const MISSING_QUERY = 'zzz-нет-такого-узла';
/** Подстрока имени справочника `Разрешённый` из синтетической конфигурации. */
const CATALOG_QUERY = 'Разреш';

interface StateNode {
  readonly id: string;
  readonly label: string;
  readonly children?: readonly StateNode[];
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

function findPath(nodes: readonly StateNode[], id: string): StateNode[] | undefined {
  for (const node of nodes) {
    if (node.id === id) {
      return [node];
    }
    const tail = node.children ? findPath(node.children, id) : undefined;
    if (tail) {
      return [node, ...tail];
    }
  }
  return undefined;
}

/** Путь от корня до выбранного узла по снимку состояния; падает, если выбора нет. */
function selectedPath(state: PanelStateLike): StateNode[] {
  assert.ok(state.selectedNodeId, 'в снимке state нет выбранного узла');
  const found = findPath(state.rootNodes, state.selectedNodeId);
  assert.ok(found, `выбранный id ${state.selectedNodeId} не найден в дереве снимка`);
  return found;
}

suite('UniversalPanelViewProvider — выбранный узел и поиск', () => {
  let tmp: string;
  let fixture: UniversalPanelFixture | undefined;

  setup(() => {
    tmp = makeTempDir('v8vscedit-panel-search-');
  });

  teardown(() => {
    fixture?.dispose();
    fixture = undefined;
    removeTempDir(tmp);
  });

  async function openWithSelectedCatalogsGroup(): Promise<UniversalPanelFixture> {
    const cf = path.join(tmp, 'cf');
    buildSupportConfig(cf, false);
    fixture = createUniversalPanelFixture({ entries: [{ kind: 'cf', rootPath: cf }] });
    const catalogs = await findByLabel(fixture, fixture.rootNodes, CATALOGS_GROUP_LABEL);
    assert.ok(catalogs, `в дереве нет группы «${CATALOGS_GROUP_LABEL}»`);
    fixture.sendCommand('selectNode', { nodeId: catalogs.id });
    return fixture;
  }

  test('выбранный узел отфильтрован — хост шлёт selectedNodeId: null, а не опускает поле', async function () {
    this.timeout(60_000);
    const panel = await openWithSelectedCatalogsGroup();

    const state = await panel.search(MISSING_QUERY);

    assert.strictEqual(state.searchQuery, MISSING_QUERY);
    assert.ok(
      Object.prototype.hasOwnProperty.call(state, 'selectedNodeId'),
      'поле selectedNodeId должно присутствовать в снимке, иначе webview оставит устаревший позиционный id'
    );
    assert.strictEqual(state.selectedNodeId, null);
  });

  test('после очистки поиска выделение возвращается на тот же узел, ветка к нему раскрыта', async function () {
    this.timeout(60_000);
    const panel = await openWithSelectedCatalogsGroup();

    const filtered = await panel.search(CATALOG_QUERY);
    assert.strictEqual(selectedPath(filtered).at(-1)?.label, CATALOGS_GROUP_LABEL,
      'группа с найденным справочником остаётся в выдаче и выделенной');

    const hidden = await panel.search(MISSING_QUERY);
    assert.strictEqual(hidden.selectedNodeId, null);

    const cleared = await panel.search('');
    assert.strictEqual(cleared.searchQuery, '');
    const route = selectedPath(cleared);
    assert.strictEqual(route.at(-1)?.label, CATALOGS_GROUP_LABEL);
    for (const ancestor of route.slice(0, -1)) {
      assert.ok(cleared.openNodeIds.includes(ancestor.id), `предок «${ancestor.label}» должен быть раскрыт`);
    }
  });
});
