/**
 * «Показать в дереве метаданных» (`v8vscedit.revealInNavigator`): файл редактора → узел
 * навигатора → выделение, раскрытие ветки и прокрутка в webview.
 *
 * Конфигурация синтетическая: справочник с формой (`FormAddService`), макетом и командой
 * (`MetadataXmlCreator`), подсистема с вложенной. Дерево — настоящий `MetadataTreeProvider`,
 * панель — настоящий `UniversalPanelViewProvider` (обвязка `universalPanelHarness`).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { MetadataFileTarget } from '../../infra/fs/MetadataFileTarget';
import { FormAddService } from '../../infra/xml/form/FormAddService';
import { MetadataXmlCreator } from '../../infra/xml/MetadataXmlCreator';
import type { CommandServices } from '../../ui/commands/_shared';
import {
  registerRevealInNavigatorCommand,
  revealFileInNavigator,
  REVEAL_IN_NAVIGATOR_COMMAND,
} from '../../ui/commands/navigator/RevealInNavigatorCommand';
import { findMetadataNodeForTarget } from '../../ui/tree/metadataFileNode';
import type { MetadataNode } from '../../ui/tree/TreeNode';
import { makeTempDir, removeTempDir } from './support/parentConfigurationsBin';
import { buildSupportConfig } from './support/supportConfigFixture';
import {
  createUniversalPanelFixture,
  type PanelStateLike,
  type UniversalPanelFixture,
} from './support/universalPanelHarness';

interface StateNode {
  readonly id: string;
  readonly label: string;
  readonly kind?: string;
  readonly children?: readonly StateNode[];
}

const OWNER = 'Собственный';

function findById(nodes: readonly StateNode[], id: string | null | undefined): StateNode | undefined {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    const nested = findById(node.children ?? [], id);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

/** Метки по пути от корня к узлу `id` — что пользователь видит раскрытым. */
function labelPath(nodes: readonly StateNode[], id: string, prefix: string[] = []): string[] | undefined {
  for (const node of nodes) {
    const own = [...prefix, node.label];
    if (node.id === id) {
      return own;
    }
    const nested = labelPath(node.children ?? [], id, own);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function isMessageOfType(message: unknown, type: string): boolean {
  return typeof message === 'object' && message !== null && (message as { type?: string }).type === type;
}

function lastState(panel: UniversalPanelFixture): PanelStateLike {
  const state = [...panel.postedMessages].reverse().find((message) => isMessageOfType(message, 'state'));
  assert.ok(state, 'панель не прислала снимок state');
  return (state as { state: PanelStateLike }).state;
}

function countOfType(panel: UniversalPanelFixture, type: string): number {
  return panel.postedMessages.filter((message) => isMessageOfType(message, type)).length;
}

function writeNestedSubsystem(cfRoot: string, creator: MetadataXmlCreator): void {
  for (const name of ['Продажи', 'Опт']) {
    const created = creator.addRootObject({ configRoot: cfRoot, kind: 'Subsystem', name });
    assert.ok(created.success, created.errors.join('; '));
  }
  // Создатель не умеет вкладывать подсистемы — переносим «Опт» под «Продажи» так, как это
  // выглядит в выгрузке платформы: файл в Subsystems/Продажи/Subsystems и ссылка в ChildObjects.
  const subsystems = path.join(cfRoot, 'Subsystems');
  const nestedDir = path.join(subsystems, 'Продажи', 'Subsystems');
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.renameSync(path.join(subsystems, 'Опт.xml'), path.join(nestedDir, 'Опт.xml'));
  const parentXml = path.join(subsystems, 'Продажи.xml');
  const text = fs.readFileSync(parentXml, 'utf8');
  const withChild = text.replace(/<ChildObjects\s*\/>/, '<ChildObjects><Subsystem>Опт</Subsystem></ChildObjects>');
  assert.notStrictEqual(withChild, text, 'у подсистемы ожидался пустой <ChildObjects/>');
  fs.writeFileSync(parentXml, withChild, 'utf8');
}

suite('Показать в дереве метаданных — файл редактора → узел навигатора', () => {
  let tmp: string;
  let cfRoot: string;
  let cfeRoot: string;
  let ownerDir: string;
  let fixture: UniversalPanelFixture | undefined;

  suiteSetup(function () {
    this.timeout(60_000);
    tmp = makeTempDir('v8vscedit-reveal-');
    cfRoot = path.join(tmp, 'cf');
    buildSupportConfig(cfRoot, false);
    const ownerXml = path.join(cfRoot, 'Catalogs', `${OWNER}.xml`);
    ownerDir = path.join(cfRoot, 'Catalogs', OWNER);
    new FormAddService().addForm({ objectPath: ownerXml, formName: 'ФормаЭлемента', autoFill: false });
    const creator = new MetadataXmlCreator();
    for (const [childTag, name] of [['Template', 'Макет'], ['Command', 'Печать']] as const) {
      const added = creator.addChildElement({ ownerObjectXmlPath: ownerXml, childTag, name });
      assert.ok(added.success, added.errors.join('; '));
    }
    writeNestedSubsystem(cfRoot, creator);
    // Расширение — та же синтетическая выгрузка, подключённая как cfe: в дереве оно под «Расширения».
    cfeRoot = path.join(tmp, 'cfe', 'Доработки');
    buildSupportConfig(cfeRoot, false);
  });

  suiteTeardown(() => {
    removeTempDir(tmp);
  });

  teardown(() => {
    fixture?.dispose();
    fixture = undefined;
  });

  function open(): UniversalPanelFixture {
    fixture = createUniversalPanelFixture({
      entries: [{ kind: 'cf', rootPath: cfRoot }, { kind: 'cfe', rootPath: cfeRoot }],
    });
    return fixture;
  }

  function servicesOf(panel: UniversalPanelFixture): Pick<CommandServices, 'treeProvider' | 'revealNodeInNavigator'> {
    return {
      treeProvider: panel.treeProvider,
      revealNodeInNavigator: (node: MetadataNode) => Promise.resolve(panel.provider.revealNode(node)),
    };
  }

  async function reveal(panel: UniversalPanelFixture, ...segments: string[]): Promise<boolean> {
    return revealFileInNavigator(servicesOf(panel), vscode.Uri.file(path.join(cfRoot, ...segments)));
  }

  function selectedPath(panel: UniversalPanelFixture): string[] {
    const state = lastState(panel);
    assert.ok(state.selectedNodeId, 'в снимке нет выделенного узла');
    const labels = labelPath(state.rootNodes, state.selectedNodeId);
    assert.ok(labels, `выделенный узел ${state.selectedNodeId} не раскрыт в снимке`);
    return labels.slice(1);
  }

  const cases: readonly { readonly title: string; readonly file: readonly string[]; readonly expected: readonly string[] }[] = [
    { title: 'модуль объекта', file: ['Catalogs', OWNER, 'Ext', 'ObjectModule.bsl'], expected: ['Справочники', OWNER] },
    { title: 'XML объекта', file: ['Catalogs', `${OWNER}.xml`], expected: ['Справочники', OWNER] },
    { title: 'модуль формы', file: ['Catalogs', OWNER, 'Forms', 'ФормаЭлемента', 'Ext', 'Form', 'Module.bsl'], expected: ['Справочники', OWNER, 'Формы', 'ФормаЭлемента'] },
    { title: 'тело макета', file: ['Catalogs', OWNER, 'Templates', 'Макет', 'Ext', 'Template.xml'], expected: ['Справочники', OWNER, 'Макеты', 'Макет'] },
    { title: 'модуль команды', file: ['Catalogs', OWNER, 'Commands', 'Печать', 'Ext', 'CommandModule.bsl'], expected: ['Справочники', OWNER, 'Команды', 'Печать'] },
    { title: 'вложенная подсистема', file: ['Subsystems', 'Продажи', 'Subsystems', 'Опт.xml'], expected: ['Общие', 'Подсистемы', 'Продажи', 'Опт'] },
    { title: 'несуществующая форма — её объект', file: ['Catalogs', OWNER, 'Forms', 'НетТакой', 'Ext', 'Form.xml'], expected: ['Справочники', OWNER] },
  ];

  for (const testCase of cases) {
    test(`${testCase.title} → выделение с раскрытой веткой`, async function () {
      this.timeout(60_000);
      const panel = open();

      assert.strictEqual(await reveal(panel, ...testCase.file), true);

      assert.deepStrictEqual(selectedPath(panel), testCase.expected);
    });
  }

  test('Configuration.xml → корень конфигурации', async function () {
    this.timeout(60_000);
    const panel = open();
    assert.strictEqual(await reveal(panel, 'Configuration.xml'), true);
    const state = lastState(panel);
    assert.strictEqual(state.selectedNodeId, state.rootNodes[0].id);
  });

  test('объект расширения → ветка через узел «Расширения»', async function () {
    this.timeout(60_000);
    const panel = open();
    const file = vscode.Uri.file(path.join(cfeRoot, 'Catalogs', 'Разрешённый.xml'));

    assert.strictEqual(await revealFileInNavigator(servicesOf(panel), file), true);

    assert.deepStrictEqual(selectedPath(panel), ['ТестоваяКонфигурация', 'Справочники', 'Разрешённый']);
    const state = lastState(panel);
    assert.ok(state.selectedNodeId);
    assert.strictEqual(labelPath(state.rootNodes, state.selectedNodeId)?.[0], 'Расширения');
  });

  test('прокрутка уходит в webview только после готовности, ровно один раз', async function () {
    this.timeout(60_000);
    const panel = open();
    panel.ready();
    assert.strictEqual(countOfType(panel, 'revealSelected'), 0, 'готовность без запроса перехода — без прокрутки');

    await reveal(panel, 'Catalogs', `${OWNER}.xml`);
    assert.strictEqual(countOfType(panel, 'revealSelected'), 1);
    const stateIndex = panel.postedMessages.map((message) => isMessageOfType(message, 'state')).lastIndexOf(true);
    const revealIndex = panel.postedMessages.findIndex((message) => isMessageOfType(message, 'revealSelected'));
    assert.ok(stateIndex < revealIndex, 'прокрутка — после снимка с новым выделением');

    panel.ready();
    assert.strictEqual(countOfType(panel, 'revealSelected'), 1, 'повторная готовность не повторяет прокрутку');
  });

  test('переход до готовности webview: прокрутка — по сигналу ready', async function () {
    this.timeout(60_000);
    const panel = open();
    await reveal(panel, 'Catalogs', `${OWNER}.xml`);
    assert.strictEqual(countOfType(panel, 'revealSelected'), 0);
    panel.ready();
    assert.strictEqual(countOfType(panel, 'revealSelected'), 1);
  });

  test('узел скрыт поиском — ничего не происходит, фильтр и выделение не меняются', async function () {
    this.timeout(60_000);
    const panel = open();
    panel.ready();
    await panel.search('Разреш');
    const messagesBefore = panel.postedMessages.length;

    assert.strictEqual(await reveal(panel, 'Catalogs', OWNER, 'Ext', 'ObjectModule.bsl'), false);

    assert.strictEqual(panel.postedMessages.length, messagesBefore, 'панель не получила ни снимка, ни прокрутки');
    const state = await panel.search('Разреш');
    assert.strictEqual(state.searchQuery, 'Разреш');
    assert.strictEqual(state.selectedNodeId, null);
  });

  test('узел виден под поиском — переход выполняется', async function () {
    this.timeout(60_000);
    const panel = open();
    await panel.search('Разреш');
    assert.strictEqual(await reveal(panel, 'Catalogs', 'Разрешённый.xml'), true);
    const state = lastState(panel);
    assert.strictEqual(findById(state.rootNodes, state.selectedNodeId)?.label, 'Разрешённый');
    assert.strictEqual(state.searchQuery, 'Разреш');
  });

  test('объекта нет в дереве — переход не выполняется', async function () {
    this.timeout(60_000);
    const panel = open();
    const messagesBefore = panel.postedMessages.length;
    assert.strictEqual(await reveal(panel, 'Catalogs', 'НетТакого.xml'), false);
    assert.strictEqual(await reveal(panel, 'Subsystems', 'НетТакой', 'Subsystems', 'Опт.xml'), false);
    assert.strictEqual(panel.postedMessages.length, messagesBefore);
  });

  test('файл вне метаданных и не-файловая схема — отказ', async function () {
    this.timeout(60_000);
    const panel = open();
    const services = servicesOf(panel);
    assert.strictEqual(await revealFileInNavigator(services, vscode.Uri.file(path.join(tmp, 'README.md'))), false);
    assert.strictEqual(await revealFileInNavigator(services, vscode.Uri.parse('onec-git:/cf/Catalogs/Собственный.xml')), false);
    assert.strictEqual(await revealFileInNavigator(services, undefined), false);
  });

  test('корень цели не загружен в дерево — узла нет', function () {
    this.timeout(60_000);
    const panel = open();
    const target: MetadataFileTarget = { configRoot: path.join(tmp, 'other') };
    assert.strictEqual(findMetadataNodeForTarget(panel.treeProvider, target), undefined);
  });

  suite('регистрация команды', () => {
    let context: vscode.ExtensionContext;
    let revealed: MetadataNode[];

    setup(() => {
      const panel = open();
      revealed = [];
      context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
      registerRevealInNavigatorCommand(context, {
        treeProvider: panel.treeProvider,
        revealNodeInNavigator: (node: MetadataNode) => { revealed.push(node); return Promise.resolve(true); },
      } as unknown as CommandServices);
    });

    teardown(async () => {
      for (const disposable of context.subscriptions) {
        disposable.dispose();
      }
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('из меню вкладки — по переданному URI', async function () {
      this.timeout(60_000);
      const uri = vscode.Uri.file(path.join(cfRoot, 'Catalogs', `${OWNER}.xml`));
      assert.strictEqual(await vscode.commands.executeCommand(REVEAL_IN_NAVIGATOR_COMMAND, uri), true);
      assert.deepStrictEqual(revealed.map((node) => node.textLabel), [OWNER]);
    });

    test('по горячей клавише — файл активного редактора', async function () {
      this.timeout(60_000);
      const file = path.join(ownerDir, 'Forms', 'ФормаЭлемента', 'Ext', 'Form', 'Module.bsl');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
      assert.strictEqual(await vscode.commands.executeCommand(REVEAL_IN_NAVIGATOR_COMMAND), true);
      assert.deepStrictEqual(revealed.map((node) => node.textLabel), ['ФормаЭлемента']);
    });

    test('package.json: команда, меню и Ctrl+Alt+T под признаком активного файла', () => {
      const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as {
        contributes: {
          commands: { command: string }[];
          keybindings: { command: string; key: string; when?: string }[];
          menus: Record<string, { command?: string; when?: string }[]>;
        };
      };
      const { commands, keybindings, menus } = manifest.contributes;
      assert.ok(commands.some((item) => item.command === REVEAL_IN_NAVIGATOR_COMMAND));
      assert.deepStrictEqual(
        keybindings.filter((item) => item.command === REVEAL_IN_NAVIGATOR_COMMAND),
        [{ command: REVEAL_IN_NAVIGATOR_COMMAND, key: 'ctrl+alt+t', when: 'editorTextFocus && v8vscedit.activeFileInMetadata' }]
      );
      for (const menu of ['editor/title/context', 'editor/context', 'commandPalette']) {
        assert.ok(menus[menu].some((item) => item.command === REVEAL_IN_NAVIGATOR_COMMAND), menu);
      }
    });
  });
});
