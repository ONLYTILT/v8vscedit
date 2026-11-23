import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isMxlTemplateNode, isSkdTemplateNode } from '../../ui/commands/template/TemplateToolsCommands';
import {
  createTemplateCommandsStand,
  createTemplateFixtureExport,
  createTemplateMcpFixture,
  createTemplateMcpHarnessOverEntry,
  type TemplateCommandsStand,
  type TemplateFixtureItem,
  type TemplateKindName,
  type TemplateMcpFixture,
} from './support/mcpTemplateToolsHarness';
import { removeTreeSync } from './support/tempTree';

/**
 * Команды навигатора `v8vscedit.mxl.*`/`v8vscedit.skd.*` на настоящей выгрузке и дереве.
 *
 * Та же деривация, что у MCP (`ui/tree/templateNodePaths`): команда читает ТЕЛО макета и
 * сверяет тип дескриптора с типом инструмента; ошибка адаптера показывается предупреждением,
 * а не необработанным исключением. Стенд — `mcpTemplateToolsHarness`: одна выгрузка и один
 * набор сервисов на MCP и команды.
 */

const COMMAND = {
  mxlInfo: 'v8vscedit.mxl.info',
  mxlValidate: 'v8vscedit.mxl.validate',
  skdInfo: 'v8vscedit.skd.info',
  skdValidate: 'v8vscedit.skd.validate',
} as const;

interface WindowRef {
  showWarningMessage: typeof vscode.window.showWarningMessage;
  showTextDocument: typeof vscode.window.showTextDocument;
}

let original: WindowRef;
let warnings: string[];
let reports: string[];

function installStubs(): void {
  const windowRef = vscode.window as unknown as WindowRef;
  original = { showWarningMessage: windowRef.showWarningMessage, showTextDocument: windowRef.showTextDocument };
  windowRef.showWarningMessage = ((message: string) => {
    warnings.push(message);
    return Promise.resolve(undefined);
  });
  windowRef.showTextDocument = ((document: vscode.TextDocument) => {
    reports.push(document.getText());
    return Promise.resolve(undefined);
  }) as unknown as typeof vscode.window.showTextDocument;
}

function restoreStubs(): void {
  const windowRef = vscode.window as unknown as WindowRef;
  windowRef.showWarningMessage = original.showWarningMessage;
  windowRef.showTextDocument = original.showTextDocument;
}

interface CommandCase {
  readonly command: string;
  readonly type: TemplateKindName;
  readonly selectMessage: string;
  /** Проверка заголовка отчёта, который открывает команда. */
  readonly title: (item: TemplateFixtureItem) => RegExp;
}

const CASES: readonly CommandCase[] = [
  { command: COMMAND.mxlInfo, type: 'SpreadsheetDocument', selectMessage: 'Выберите макет табличного документа.', title: (item) => new RegExp(`^MXL: ${item.name}\\n`) },
  { command: COMMAND.mxlValidate, type: 'SpreadsheetDocument', selectMessage: 'Выберите макет табличного документа.', title: () => /^Валидация MXL: 0 ошибок\n/ },
  { command: COMMAND.skdInfo, type: 'DataCompositionSchema', selectMessage: 'Выберите макет СКД.', title: () => /^СКД: структура\n/ },
  { command: COMMAND.skdValidate, type: 'DataCompositionSchema', selectMessage: 'Выберите макет СКД.', title: () => /^Валидация СКД: 0 ошибок\n/ },
];
const OTHER: Readonly<Record<'SpreadsheetDocument' | 'DataCompositionSchema', TemplateKindName[]>> = {
  SpreadsheetDocument: ['DataCompositionSchema', 'TextDocument'],
  DataCompositionSchema: ['SpreadsheetDocument', 'TextDocument'],
};

suite('Макеты: команды навигатора', () => {
  let fx: TemplateMcpFixture;
  let stand: TemplateCommandsStand;

  suiteSetup(function () {
    this.timeout(60_000);
    fx = createTemplateMcpFixture();
    stand = createTemplateCommandsStand(fx.harness);
  });
  suiteTeardown(() => {
    fx.dispose();
  });
  setup(() => {
    warnings = [];
    reports = [];
    installStubs();
  });
  teardown(() => {
    restoreStubs();
  });

  test('регистрируются ровно четыре команды макетов', () => {
    assert.deepStrictEqual([...stand.registered].sort(), Object.values(COMMAND).sort());
  });

  for (const c of CASES) {
    for (const nodeKind of ['Template', 'CommonTemplate'] as const) {
      test(`${c.command} × ${nodeKind}: открывает отчёт по ТЕЛУ макета`, async () => {
        const item = fx.item(nodeKind, c.type);
        const node = fx.harness.paths.resolveNode(item.canonical);
        await stand.run(c.command, node);
        assert.deepStrictEqual(warnings, []);
        assert.strictEqual(reports.length, 1);
        assert.match(reports[0], c.title(item));
      });

      for (const otherType of OTHER[c.type as 'SpreadsheetDocument' | 'DataCompositionSchema']) {
        test(`${c.command} × ${nodeKind}: макет ${otherType} — предупреждение с типами, отчёта нет`, async () => {
          const item = fx.item(nodeKind, otherType);
          const node = fx.harness.paths.resolveNode(item.canonical);
          await stand.run(c.command, node);
          assert.strictEqual(reports.length, 0);
          assert.strictEqual(warnings.length, 1);
          assert.match(warnings[0], new RegExp(`имеет тип ${otherType}; инструмент работает с ${c.type}`));
        });
      }
    }

    test(`${c.command}: узел не передан — «${c.selectMessage}»`, async () => {
      await stand.run(c.command, undefined);
      assert.deepStrictEqual(warnings, [c.selectMessage]);
      assert.strictEqual(reports.length, 0);
    });

    test(`${c.command}: узел не макет — «${c.selectMessage}»`, async () => {
      const node = fx.harness.paths.resolveNode(`Справочники.${fx.catalogName}`);
      await stand.run(c.command, node);
      assert.deepStrictEqual(warnings, [c.selectMessage]);
      assert.strictEqual(reports.length, 0);
    });
  }

  test('isMxlTemplateNode / isSkdTemplateNode: различают макеты по типу дескриптора, оба вида узла', () => {
    for (const nodeKind of ['Template', 'CommonTemplate'] as const) {
      const mxl = fx.harness.paths.resolveNode(fx.item(nodeKind, 'SpreadsheetDocument').canonical);
      const skd = fx.harness.paths.resolveNode(fx.item(nodeKind, 'DataCompositionSchema').canonical);
      const text = fx.harness.paths.resolveNode(fx.item(nodeKind, 'TextDocument').canonical);
      assert.strictEqual(isMxlTemplateNode(mxl), true);
      assert.strictEqual(isSkdTemplateNode(mxl), false);
      assert.strictEqual(isMxlTemplateNode(skd), false);
      assert.strictEqual(isSkdTemplateNode(skd), true);
      assert.strictEqual(isMxlTemplateNode(text), false);
      assert.strictEqual(isSkdTemplateNode(text), false);
    }
  });

  test('isMxlTemplateNode / isSkdTemplateNode: узел без владельца-объекта и узел не макета — false, без исключения', () => {
    const noOwner = {
      nodeKind: 'Template',
      textLabel: 'Макет',
      metaContext: {},
    } as unknown as Parameters<typeof isMxlTemplateNode>[0];
    assert.strictEqual(isMxlTemplateNode(noOwner), false);
    assert.strictEqual(isSkdTemplateNode(noOwner), false);
    const notTemplate = fx.harness.paths.resolveNode(`Справочники.${fx.catalogName}`);
    assert.strictEqual(isMxlTemplateNode(notTemplate), false);
    assert.strictEqual(isSkdTemplateNode(notTemplate), false);
  });

  suite('макет с удалённым телом / без дескриптора', () => {
    test('тела нет: предупреждение «Тело макета … не найдено», отчёта нет', async function () {
      this.timeout(60_000);
      const exportInfo = createTemplateFixtureExport();
      const item = exportInfo.item('Template', 'SpreadsheetDocument');
      removeTreeSync(path.dirname(path.dirname(item.body)));
      const harness = createTemplateMcpHarnessOverEntry({ rootPath: exportInfo.configRoot, kind: 'cf' });
      try {
        const localStand = createTemplateCommandsStand(harness);
        await localStand.run(COMMAND.mxlInfo, harness.paths.resolveNode(item.canonical));
        assert.strictEqual(reports.length, 0);
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0], /Тело макета \(Ext\/Template\.xml\) не найдено/);
      } finally {
        harness.dispose();
        removeTreeSync(exportInfo.configRoot);
      }
    });

    test('дескриптора нет, тело есть: чтение работает (intent read)', async function () {
      this.timeout(60_000);
      const exportInfo = createTemplateFixtureExport();
      const item = exportInfo.item('Template', 'SpreadsheetDocument');
      fs.unlinkSync(item.descriptor);
      const harness = createTemplateMcpHarnessOverEntry({ rootPath: exportInfo.configRoot, kind: 'cf' });
      try {
        const localStand = createTemplateCommandsStand(harness);
        await localStand.run(COMMAND.mxlValidate, harness.paths.resolveNode(item.canonical));
        assert.deepStrictEqual(warnings, []);
        assert.strictEqual(reports.length, 1);
        assert.match(reports[0], /^Валидация MXL: 0 ошибок\n/);
      } finally {
        harness.dispose();
        removeTreeSync(exportInfo.configRoot);
      }
    });
  });
});
