import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SupportMode } from '../../infra/support/SupportInfoService';
import { diffSnapshots, directoriesNamedAsXml, snapshotTree } from './support/fsSnapshot';
import { isToolError, toolText } from './support/mcpFormToolsHarness';
import {
  MXL_DEFINITION,
  SKD_DEFINITION,
  createTemplateFixtureExport,
  createTemplateMcpFixture,
  createTemplateMcpHarnessOverEntry,
  type TemplateFixtureItem,
  type TemplateKindName,
  type TemplateMcpFixture,
  type TemplateMcpHarnessOptions,
} from './support/mcpTemplateToolsHarness';
import { removeTreeSync } from './support/tempTree';

/**
 * MCP-инструменты макетов (mxl_info, validate_mxl, compile_mxl, decompile_mxl, skd_info,
 * validate_skd, compile_skd, edit_skd) на настоящей выгрузке и настоящем дереве навигатора.
 *
 * Дефект: узел макета несёт `xmlPath` дескриптора `Templates/<Имя>.xml`; сервисы принимали его
 * за тело `Ext/Template.xml`, а `compile_*` писали содержимое прямо в дескриптор и затирали
 * метаданные макета. Каждый инструмент проверяется для ОБОИХ видов узла (макет объекта и общий
 * макет): у них разные `xmlPath` и разные пути тела.
 */

const TOOL = {
  mxlInfo: 'v8vscedit_mxl_info',
  mxlValidate: 'v8vscedit_validate_mxl',
  mxlCompile: 'v8vscedit_compile_mxl',
  mxlDecompile: 'v8vscedit_decompile_mxl',
  skdInfo: 'v8vscedit_skd_info',
  skdValidate: 'v8vscedit_validate_skd',
  skdCompile: 'v8vscedit_compile_skd',
  skdEdit: 'v8vscedit_edit_skd',
} as const;

const ALL_TOOLS = Object.values(TOOL);
const NODE_KINDS = ['Template', 'CommonTemplate'] as const;

interface TypeProfile {
  readonly type: TemplateKindName;
  readonly readTools: readonly string[];
  readonly compileTool: string;
  readonly mutationTools: readonly { readonly tool: string; readonly args: Record<string, unknown> }[];
  readonly otherTypes: readonly TemplateKindName[];
}

const NEW_MXL_DEFINITION = {
  ...MXL_DEFINITION,
  areas: [{ name: 'Другая', rows: [{ cells: [{ col: 1, style: 'cell', text: 'Новый текст' }] }] }],
};
const NEW_SKD_DEFINITION = {
  ...SKD_DEFINITION,
  dataSets: [{ name: 'Другой', query: 'ВЫБРАТЬ 1 КАК Поле', fields: ['Поле [Поле]: string'] }],
};

const PROFILES: readonly TypeProfile[] = [
  {
    type: 'SpreadsheetDocument',
    readTools: [TOOL.mxlInfo, TOOL.mxlValidate, TOOL.mxlDecompile],
    compileTool: TOOL.mxlCompile,
    mutationTools: [{ tool: TOOL.mxlCompile, args: { definition: NEW_MXL_DEFINITION } }],
    otherTypes: ['DataCompositionSchema', 'TextDocument'],
  },
  {
    type: 'DataCompositionSchema',
    readTools: [TOOL.skdInfo, TOOL.skdValidate],
    compileTool: TOOL.skdCompile,
    mutationTools: [
      { tool: TOOL.skdCompile, args: { definition: NEW_SKD_DEFINITION } },
      { tool: TOOL.skdEdit, args: { operation: 'add-parameter', value: 'Организация: CatalogRef.Организации' } },
    ],
    otherTypes: ['SpreadsheetDocument', 'TextDocument'],
  },
];

function parse(result: CallToolResult): Record<string, unknown> {
  assert.ok(!isToolError(result), `инструмент не должен возвращать ошибку: ${toolText(result)}`);
  return JSON.parse(toolText(result)) as Record<string, unknown>;
}

function argsFor(tool: string, item: TemplateFixtureItem, extra: Record<string, unknown> = {}): Record<string, unknown> {
  if (tool === TOOL.mxlCompile) {
    return { path: item.canonical, definition: NEW_MXL_DEFINITION, ...extra };
  }
  if (tool === TOOL.skdCompile) {
    return { path: item.canonical, definition: NEW_SKD_DEFINITION, ...extra };
  }
  if (tool === TOOL.skdEdit) {
    return { path: item.canonical, operation: 'add-parameter', value: 'Организация: CatalogRef.Организации', ...extra };
  }
  return { path: item.canonical, ...extra };
}

function assertGateFired(fx: TemplateMcpFixture, changedFiles: readonly string[], label: string): void {
  const log = fx.harness.postMutation;
  assert.ok(changedFiles.length > 0, `${label}: changedFiles не пуст`);
  assert.deepStrictEqual(log.suppress, [[...changedFiles]], `${label}: suppressConfigurationReloadForFiles ровно один раз`);
  assert.deepStrictEqual(log.markChanged, [[...changedFiles]], `${label}: markChangedConfigurationByFiles ровно один раз`);
  assert.strictEqual(log.refreshActionsView, 1, `${label}: refreshActionsView ровно один раз`);
}

function assertGateNotFired(fx: TemplateMcpFixture, label: string): void {
  const log = fx.harness.postMutation;
  assert.deepStrictEqual(log.suppress, [], `${label}: post-mutation путь не запускается`);
  assert.deepStrictEqual(log.markChanged, [], label);
  assert.strictEqual(log.refreshActionsView, 0, label);
}

function rel(fx: TemplateMcpFixture, absolute: string): string {
  return path.relative(fx.configRoot, absolute);
}

/** Тест со свежей выгрузкой: мутирующие инструменты не должны делить состояние друг с другом. */
function fixtureTest(
  title: string,
  options: TemplateMcpHarnessOptions,
  body: (fx: TemplateMcpFixture) => Promise<void> | void,
): void {
  test(title, async function () {
    this.timeout(60_000);
    const fx = createTemplateMcpFixture(options);
    try {
      await body(fx);
    } finally {
      fx.dispose();
    }
  });
}

suite('Макеты: MCP-инструменты — чтение и guard типа (общая выгрузка)', () => {
  let fx: TemplateMcpFixture;
  suiteSetup(function () {
    this.timeout(60_000);
    fx = createTemplateMcpFixture();
  });
  suiteTeardown(() => {
    fx.dispose();
  });
  /**
   * Все тесты сьюта — чтение/отказ: выгрузка не должна меняться, а гейт — срабатывать. Проверка
   * сделана обёрткой теста, а не `teardown`: упавший хук обрывает весь сьют и маскирует остальные тесты.
   */
  const guarded = (title: string, body: () => Promise<void> | void): void => {
    test(title, async () => {
      // Слепок берётся перед КАЖДЫМ тестом: иначе правка одного (в красной фазе — перезапись дескриптора) роняла бы все следующие.
      const before = snapshotTree(fx.configRoot);
      const gateBefore = JSON.stringify(fx.harness.postMutation);
      await body();
      assert.deepStrictEqual(diffSnapshots(before, snapshotTree(fx.configRoot)), []);
      assert.strictEqual(JSON.stringify(fx.harness.postMutation), gateBefore, 'чтение и отказы: post-mutation путь не запускается');
    });
  };

  for (const profile of PROFILES) {
    for (const nodeKind of NODE_KINDS) {
      for (const tool of profile.readTools) {
        guarded(`${tool} × ${nodeKind}: читает ТЕЛО макета, а не дескриптор`, async () => {
          const item = fx.item(nodeKind, profile.type);
          const result = await fx.harness.call(tool, argsFor(tool, item));
          const parsed = parse(result);
          if (tool !== TOOL.mxlDecompile) {
            assert.strictEqual(parsed.templatePath, item.body, 'путь в ответе — тело макета');
          } else {
            assert.strictEqual(parsed.columns, 2);
          }
          if (tool === TOOL.mxlInfo) {
            assert.strictEqual(parsed.name, item.name);
          }
          if (tool === TOOL.mxlValidate || tool === TOOL.skdValidate) {
            assert.strictEqual(parsed.errors, 0, JSON.stringify(parsed.issues));
          }
        });
      }

      for (const tool of profile.readTools.concat(profile.compileTool, profile.type === 'DataCompositionSchema' ? [TOOL.skdEdit] : [])) {
        for (const otherType of profile.otherTypes) {
          guarded(`${tool} × ${nodeKind}: макет ${otherType} — отказ по типу, файлы не тронуты`, async () => {
            const item = fx.item(nodeKind, otherType);
            const result = await fx.harness.call(tool, argsFor(tool, item));
            assert.ok(isToolError(result), toolText(result));
            assert.match(toolText(result), new RegExp(`имеет тип ${otherType}; инструмент работает с ${profile.type}`));
          });
        }
      }
    }
  }

  for (const tool of ALL_TOOLS) {
    guarded(`${tool}: путь не к макету (Справочники.X) — отказ с подсказкой про канон`, async () => {
      const result = await fx.harness.call(tool, {
        path: `Справочники.${fx.catalogName}`,
        definition: {},
        operation: 'add-parameter',
        value: 'X: string',
      });
      assert.ok(isToolError(result));
      assert.match(toolText(result), /должен указывать на макет/);
    });
  }
});

suite('Макеты: MCP-инструменты — запись только в тело', () => {
  for (const profile of PROFILES) {
    for (const nodeKind of NODE_KINDS) {
      for (const mutation of profile.mutationTools) {
        fixtureTest(`${mutation.tool} × ${nodeKind}: меняется ровно тело, дескриптор и XML владельца байт-в-байт`, {}, async (fx) => {
          const item = fx.item(nodeKind, profile.type);
          const untouchedBefore = item.untouched.map((file) => fs.readFileSync(file));
          const bodyBefore = fs.readFileSync(item.body);
          const tree = snapshotTree(fx.configRoot);

          const parsed = parse(await fx.harness.call(mutation.tool, { path: item.canonical, ...mutation.args }));

          const changed = parsed.changedFiles as string[];
          assert.deepStrictEqual(changed, [item.body], 'changedFiles — только тело');
          assert.strictEqual(parsed.templatePath, item.body);
          assert.deepStrictEqual(diffSnapshots(tree, snapshotTree(fx.configRoot)), [rel(fx, item.body)]);
          item.untouched.forEach((file, index) => {
            assert.ok(fs.readFileSync(file).equals(untouchedBefore[index]), `${rel(fx, file)} не тронут`);
          });
          assert.ok(!fs.readFileSync(item.body).equals(bodyBefore), 'тело изменено');
          assert.ok(!/<MetaDataObject\b/.test(fs.readFileSync(item.body, 'utf-8')), 'в теле нет корня дескриптора');
          assert.deepStrictEqual(directoriesNamedAsXml(snapshotTree(fx.configRoot)), [], 'нет каталогов с именем *.xml');
          assertGateFired(fx, changed, mutation.tool);
        });
      }

      fixtureTest(`${profile.compileTool} × ${nodeKind}: скомпилированное содержимое читается инструментом чтения`, {}, async (fx) => {
        const item = fx.item(nodeKind, profile.type);
        parse(await fx.harness.call(profile.compileTool, argsFor(profile.compileTool, item)));
        const info = parse(await fx.harness.call(profile.readTools[0], argsFor(profile.readTools[0], item)));
        if (profile.type === 'SpreadsheetDocument') {
          assert.deepStrictEqual((info.areas as { name: string }[]).map((area) => area.name), ['Другая']);
        } else {
          assert.deepStrictEqual((info.dataSets as { name: string }[]).map((set) => set.name), ['Другой']);
        }
      });

      fixtureTest(`${profile.compileTool} × ${nodeKind}: тела нет — создаётся (каталоги + атомарная запись), дескриптор цел`, {}, async (fx) => {
        const item = fx.item(nodeKind, profile.type);
        const descriptorBefore = fs.readFileSync(item.descriptor);
        removeTreeSync(path.dirname(path.dirname(item.body)));
        assert.strictEqual(fs.existsSync(item.body), false);
        const harness = createTemplateMcpHarnessOverEntry({ rootPath: fx.configRoot, kind: 'cf' });
        try {
          const parsed = parse(await harness.call(profile.compileTool, argsFor(profile.compileTool, item)));
          assert.deepStrictEqual(parsed.changedFiles, [item.body]);
          assert.strictEqual(fs.existsSync(item.body), true);
          assert.deepStrictEqual(fs.readdirSync(path.dirname(item.body)), ['Template.xml'], 'временных файлов нет');
          assert.ok(fs.readFileSync(item.descriptor).equals(descriptorBefore), 'дескриптор цел');
        } finally {
          harness.dispose();
        }
      });
    }
  }

  fixtureTest('compile_mxl: на месте тела лежит дескриптор — отказ без записи', {}, async (fx) => {
    const item = fx.item('Template', 'SpreadsheetDocument');
    fs.writeFileSync(item.body, fs.readFileSync(item.descriptor));
    const tree = snapshotTree(fx.configRoot);
    const result = await fx.harness.call(TOOL.mxlCompile, argsFor(TOOL.mxlCompile, item));
    assert.ok(isToolError(result));
    assert.match(toolText(result), /дескриптор/);
    assert.deepStrictEqual(diffSnapshots(tree, snapshotTree(fx.configRoot)), []);
    assertGateNotFired(fx, 'compile_mxl поверх дескриптора');
  });
});

suite('Макеты: MCP-инструменты — удалённое тело и отсутствующий дескриптор', () => {
  for (const profile of PROFILES) {
    for (const nodeKind of NODE_KINDS) {
      for (const tool of profile.readTools.concat(profile.type === 'DataCompositionSchema' ? [TOOL.skdEdit] : [])) {
        fixtureTest(`${tool} × ${nodeKind}: тела нет — ошибка с подсказкой про add_template, ничего не создано`, {}, async (fx) => {
          const item = fx.item(nodeKind, profile.type);
          removeTreeSync(path.dirname(path.dirname(item.body)));
          const harness = createTemplateMcpHarnessOverEntry({ rootPath: fx.configRoot, kind: 'cf' });
          try {
            const tree = snapshotTree(fx.configRoot);
            const result = await harness.call(tool, argsFor(tool, item));
            assert.ok(isToolError(result), toolText(result));
            assert.match(toolText(result), /Тело макета \(Ext\/Template\.xml\) не найдено/);
            assert.match(toolText(result), /v8vscedit_add_template/);
            assert.deepStrictEqual(diffSnapshots(tree, snapshotTree(fx.configRoot)), []);
          } finally {
            harness.dispose();
          }
        });
      }
    }

    test(`${profile.compileTool} × Template без дескриптора: write — отказ «не описан дескриптором»; чтение тела работает`, async function () {
      this.timeout(60_000);
      const exportInfo = createTemplateFixtureExport();
      const item = exportInfo.item('Template', profile.type);
      fs.unlinkSync(item.descriptor);
      const harness = createTemplateMcpHarnessOverEntry({ rootPath: exportInfo.configRoot, kind: 'cf' });
      try {
        const tree = snapshotTree(exportInfo.configRoot);
        for (const mutation of profile.mutationTools) {
          const result = await harness.call(mutation.tool, { path: item.canonical, ...mutation.args });
          assert.ok(isToolError(result), toolText(result));
          assert.match(toolText(result), /не описан дескриптором/);
          assert.match(toolText(result), /add_template/);
        }
        assert.deepStrictEqual(diffSnapshots(tree, snapshotTree(exportInfo.configRoot)), [], 'файлы не тронуты');
        const read = parse(await harness.call(profile.readTools[0], argsFor(profile.readTools[0], item)));
        assert.strictEqual(read.templatePath, item.body);
      } finally {
        harness.dispose();
        removeTreeSync(exportInfo.configRoot);
      }
    });
  }
});

suite('Макеты: MCP-инструменты — блокировка узла', () => {
  const lockCases: readonly { readonly name: string; readonly options: TemplateMcpHarnessOptions; readonly message: RegExp }[] = [
    { name: 'поддержка с запретом редактирования (Locked)', options: { supportMode: SupportMode.Locked }, message: /поддержке/ },
    { name: 'объект не захвачен в хранилище', options: { repositoryRestricted: true }, message: /хранилищ/ },
  ];
  for (const lock of lockCases) {
    for (const profile of PROFILES) {
      for (const nodeKind of NODE_KINDS) {
        for (const mutation of profile.mutationTools) {
          fixtureTest(`${mutation.tool} × ${nodeKind}: ${lock.name} — отказ, файлы не тронуты, гейт не запускается`, lock.options, async (fx) => {
            const item = fx.item(nodeKind, profile.type);
            const tree = snapshotTree(fx.configRoot);
            const result = await fx.harness.call(mutation.tool, { path: item.canonical, ...mutation.args });
            assert.ok(isToolError(result), toolText(result));
            assert.match(toolText(result), lock.message);
            assert.deepStrictEqual(diffSnapshots(tree, snapshotTree(fx.configRoot)), []);
            assertGateNotFired(fx, `${mutation.tool} ${lock.name}`);
          });
        }
      }
    }

    fixtureTest(`чтение работает при блокировке (${lock.name}) и не опрашивает гейт`, lock.options, async (fx) => {
      for (const profile of PROFILES) {
        for (const nodeKind of NODE_KINDS) {
          for (const tool of profile.readTools) {
            const item = fx.item(nodeKind, profile.type);
            const result = await fx.harness.call(tool, argsFor(tool, item));
            assert.ok(!isToolError(result), toolText(result));
          }
        }
      }
      assert.strictEqual(fx.harness.supportQueries.length, 0);
      assert.strictEqual(fx.harness.repositoryQueries.length, 0);
    });
  }

  fixtureTest('проверка блокировки Template идёт по XML владельца, общего макета — по его дескриптору', { supportMode: SupportMode.Locked }, async (fx) => {
    await fx.harness.call(TOOL.mxlCompile, argsFor(TOOL.mxlCompile, fx.item('Template', 'SpreadsheetDocument')));
    await fx.harness.call(TOOL.mxlCompile, argsFor(TOOL.mxlCompile, fx.item('CommonTemplate', 'SpreadsheetDocument')));
    assert.deepStrictEqual(fx.harness.supportQueries, [fx.catalogXml, fx.item('CommonTemplate', 'SpreadsheetDocument').descriptor]);
  });
});
