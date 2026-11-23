import * as assert from 'assert';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as vscode from 'vscode';
import { isConfigurationOperationRunning } from '../../ui/commands/ext/configurationOperationLock';
import { operationStageFeed } from '../../ui/commands/ext/configurationOperationStatus';
import { describeLockNotComplete } from '../../ui/commands/repository/repositoryChains';
import { describeLockedOverwrite } from '../../ui/commands/repository/repositoryUpdateFlow';
import { McpOperationOutcomeRegistry } from '../../infra/mcp/McpOperationOutcome';
import { McpMutationGate } from '../../ui/mcp/registration/McpMutationGate';
import { registerRepositoryTools } from '../../ui/mcp/registration/McpRepositoryTools';
import { MetadataNode } from '../../ui/tree/TreeNode';
import { ManualScheduler } from './support/manualScheduler';
import { ROOT_LOCK_CF, createRepoProject, operationTail, type RepoProject } from './support/repositoryMcpFixtures';
import {
  C1, C3, D1, EXT_X, EXT_Y, SUBSYSTEM,
  COMMIT_DONE, E33_1_LOG, E33_1_RECEIVED_LOG, E33_3_LOG, LOCK_DONE, UNLOCK_DONE, UPDATE_DONE,
  addListObjects, cancelledLine, committedLine, foreignLine, lockedLine, notLockedLine, opLog, receivedLine,
  type ListObjects,
} from './support/repositoryListFixtures';

/**
 * MCP-инструменты хранилища со списком `paths` (docs/plans/mcp-repository-paths-plan.md, тесты §4.F):
 * lock/update/commit/unlock принимают `path` ИЛИ `paths` (одна цель, до 100 путей), выполняют один запуск
 * Конфигуратора с единым `-Objects` и возвращают один ответ. Техника — `mcpRepositoryTools.test.ts`: настоящие
 * RepositoryService/env.json/выгрузки, подменён только исполнитель 1cv8 (логи Э33 дословно), шаги загрузки/импорта
 * и окна сообщений (у MCP их быть не должно).
 */

const CALLS = ['lock', 'update', 'commit', 'unlock'] as const;
type CallName = (typeof CALLS)[number];

const NS = 'http://v8.1c.ru/8.3/config/objects';
const listXml = (...fullNames: string[]): string => [
  `<Objects xmlns="${NS}" version="1.0">`,
  ...fullNames.flatMap((name) => [`  <Object fullName="${name}" includeChildObjects="false">`, '  </Object>']),
  '</Objects>',
  '',
].join('\n');

const MARKERS: Record<CallName, string> = {
  lock: '/ConfigurationRepositoryLock',
  update: '/ConfigurationRepositoryUpdateCfg',
  commit: '/ConfigurationRepositoryCommit',
  unlock: '/ConfigurationRepositoryUnLock',
};
const UNLOCK_FAILURE_HINT =
  'Если объект изменён в базе, отменить захват без потери правок нельзя: поместите изменения (v8vscedit_repository_commit).';

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

function text(result: CallToolResult): string {
  const part = result.content[0];
  return part.type === 'text' ? part.text : '';
}

function data(result: CallToolResult): Record<string, unknown> {
  assert.ok(result.isError !== true, `ожидался успех, получено: ${text(result)}`);
  return JSON.parse(text(result)) as Record<string, unknown>;
}

function shape(inputSchema: unknown): Record<string, boolean> {
  const fields = (inputSchema as { shape?: Record<string, { def?: { type?: string } }> }).shape;
  assert.ok(fields, 'inputSchema — z.object');
  return Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, schema.def?.type === 'optional']));
}

function vscodeRevised(value: boolean): { apply(): Promise<void>; restore(): Promise<void> } {
  const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('v8vscedit.repository');
  return {
    apply: async () => { await config().update('getRevisedOnLock', value, vscode.ConfigurationTarget.Global); },
    restore: async () => { await config().update('getRevisedOnLock', undefined, vscode.ConfigurationTarget.Global); },
  };
}

suite('MCP-инструменты хранилища: список paths', function () {
  this.timeout(60_000);

  let p: RepoProject;
  let o: ListObjects;
  let tools: Map<string, RegisteredTool>;
  let resolved: string[];
  const revised = vscodeRevised(false);

  setup(async () => {
    await revised.apply();
    p = await createRepoProject();
    o = addListObjects(p);
    tools = new Map();
    resolved = [];
    const noPath = new MetadataNode({ label: 'БезПути', nodeKind: 'Catalog' } as never, vscode.TreeItemCollapsibleState.None);
    const group = new MetadataNode(
      { label: 'Справочники', nodeKind: 'group-type', xmlPath: o.catalog1.ref.xmlPath } as never,
      vscode.TreeItemCollapsibleState.None
    );
    const map: Record<string, MetadataNode> = {
      'Справочники.Справочник1': o.catalog1.node,
      'Справочники.Справочник1.Артикул': o.catalog1Child.node,
      'Справочники.Справочник3': o.catalog3.node,
      'Документы.Документ1': o.document1.node,
      'Подсистемы.П': o.subsystem.node,
      Конфигурация: p.nodes.cfRoot,
      'Расширение.Расш': p.nodes.cfeRoot,
      'Расш.Справочники.Э33_X': o.extX.node,
      'Расш.Справочники.Э33_Y': o.extY.node,
      'Справочники.Товары': p.nodes.catalog,
      БезПути: noPath,
      Справочники: group,
    };
    const paths = {
      resolveNode: (canonical: string) => {
        resolved.push(canonical);
        if (!Object.prototype.hasOwnProperty.call(map, canonical)) {
          throw new Error(`Метаданные по пути "${canonical}" не найдены.`);
        }
        return map[canonical];
      },
    };
    const server = {
      registerTool: (name: string, config: Omit<RegisteredTool, 'name' | 'handler'>, handler: RegisteredTool['handler']) => {
        tools.set(name, { ...config, name, handler });
      },
    };
    const gate = new McpMutationGate(
      p.services,
      { scheduler: new ManualScheduler(), intervalMs: 20_000, readStage: () => operationStageFeed.current() },
      new McpOperationOutcomeRegistry()
    );
    registerRepositoryTools(server as never, { services: p.services, xmlEditor: {}, paths, properties: {}, mutations: {}, gate } as never);
  });

  teardown(async () => {
    await p.dispose();
    await revised.restore();
  });

  const call = (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    const tool = tools.get(`v8vscedit_repository_${name}`);
    assert.ok(tool, `инструмент v8vscedit_repository_${name} не зарегистрирован`);
    return tool.handler(args);
  };

  /** Обязательные поля инструмента помимо path/paths. */
  const base = (name: CallName): Record<string, unknown> => (name === 'commit' ? { comment: 'Правка', confirm: true } : {});

  function assertNoSideEffects(): void {
    assert.strictEqual(p.runs.length, 0, 'исполнитель не запускался');
    assert.deepStrictEqual(p.events, []);
    assert.strictEqual(isConfigurationOperationRunning(), false, 'замок свободен');
    assert.deepStrictEqual(p.toasts, []);
  }

  function assertPostMutationPath(): void {
    // Один вызов refreshRepositoryUi от самой операции (finally) плюс по одному от каждого шага загрузки/импорта цепочки.
    const expected = 1 + p.importCalls.length + p.updateCalls.length;
    assert.strictEqual(p.refreshes, expected, 'treeProvider.refresh: по одному разу на операцию и на шаг цепочки');
    assert.strictEqual(p.actionViewRefreshes, expected, 'refreshActionsView: по одному разу на операцию и на шаг цепочки');
    assert.deepStrictEqual(p.suppressCalls, [], 'suppressConfigurationReloadForFiles не вызывается');
    assert.deepStrictEqual(p.markChangedCalls, [], 'markChangedConfigurationByFiles не вызывается');
    assert.deepStrictEqual(p.toasts, []);
    assert.strictEqual(isConfigurationOperationRunning(), false);
  }

  suite('регистрация', () => {
    test('path и paths необязательны у всех четырёх инструментов; status без изменений (path обязателен, paths нет)', () => {
      for (const name of CALLS) {
        const fields = shape(tools.get(`v8vscedit_repository_${name}`)?.inputSchema);
        assert.strictEqual(fields.path, true, `${name}: path optional`);
        assert.strictEqual(fields.paths, true, `${name}: paths optional`);
        assert.strictEqual(fields.configuration, true, `${name}: configuration optional`);
      }
      assert.deepStrictEqual(shape(tools.get('v8vscedit_repository_status')?.inputSchema), { path: false, configuration: true });
    });

    test('описание каждого инструмента сообщает про paths, лимит 100 и один запуск Конфигуратора', () => {
      for (const name of CALLS) {
        const description = tools.get(`v8vscedit_repository_${name}`)?.description ?? '';
        assert.ok(description.includes('paths'), `${name}: ${description}`);
        assert.ok(description.includes('100'), `${name}: ${description}`);
        assert.ok(description.includes('одним запуском'), `${name}: ${description}`);
      }
    });
  });

  suite('отказы входа и выбора цели — без запуска исполнителя, без замка, без тостов', () => {
    for (const name of CALLS) {
      const rows: { title: string; args: Record<string, unknown>; message: string | RegExp }[] = [
        {
          title: 'заданы оба path и paths',
          args: { path: 'Справочники.Справочник1', paths: ['Справочники.Справочник3'] },
          message: 'Передайте либо path (один объект), либо paths (список объектов), но не оба.',
        },
        {
          title: 'не задано ни одно',
          args: {},
          message: 'Укажите path (канонический путь объекта) или paths (список канонических путей).',
        },
        {
          title: 'paths пуст',
          args: { paths: [] },
          message: 'Список paths пуст: передайте хотя бы один канонический путь.',
        },
        {
          title: 'пустой элемент',
          args: { paths: ['Справочники.Справочник1', '  '] },
          message: 'Пустой элемент в paths (позиция 2).',
        },
        {
          title: 'больше 100 путей',
          args: { paths: Array.from({ length: 101 }, (_, i) => `Справочники.Объект${String(i + 1)}`) },
          message: /^В paths 101 путей; за один вызов допускается не более 100\./,
        },
        {
          title: 'повторяющиеся пути',
          args: { paths: ['Справочники.Справочник1', 'Справочники.Справочник3', 'Справочники.Справочник1'] },
          message: 'Повторяющиеся пути в paths: "Справочники.Справочник1".',
        },
      ];
      for (const row of rows) {
        test(`${name}: ${row.title} — отказ до резолвинга путей`, async () => {
          const result = await call(name, { ...base(name), ...row.args });
          assert.strictEqual(result.isError, true, text(result));
          if (typeof row.message === 'string') {
            assert.strictEqual(text(result), row.message);
          } else {
            assert.match(text(result), row.message);
          }
          assert.deepStrictEqual(resolved, [], 'резолвер путей не вызывался');
          assertNoSideEffects();
        });
      }

      test(`${name}: разные цели (cf + cfe) в одном paths — отказ с примером пути на цель`, async () => {
        const result = await call(name, { ...base(name), paths: ['Справочники.Справочник1', 'Расш.Справочники.Э33_X'] });
        assert.strictEqual(result.isError, true);
        assert.strictEqual(
          text(result),
          'Все пути paths должны относиться к одной цели хранилища (основной конфигурации или одному расширению), ' +
          `а получено несколько: "${p.cfTarget.displayName}" (Справочники.Справочник1), "${p.cfeTarget.displayName}" (Расш.Справочники.Э33_X). ` +
          'Выполните операцию отдельным вызовом для каждой цели.'
        );
        assertNoSideEffects();
      });

      test(`${name}: цель не подключена к хранилищу — отказ со ссылкой на status (проверка один раз)`, async () => {
        p.service.setConnected(p.cfTarget, false);
        const result = await call(name, { ...base(name), paths: ['Справочники.Справочник1', 'Справочники.Справочник3'] });
        assert.strictEqual(result.isError, true);
        assert.ok(text(result).includes('нет активного подключения к хранилищу'), text(result));
        assert.ok(text(result).includes('(состояние — v8vscedit_repository_status)'), text(result));
        assertNoSideEffects();
      });

      test(`${name}: ошибка резолвера пути — как есть (неизвестный путь в списке)`, async () => {
        const result = await call(name, { ...base(name), paths: ['Справочники.Справочник1', 'Справочники.Нет'] });
        assert.strictEqual(result.isError, true);
        assert.strictEqual(text(result), 'Метаданные по пути "Справочники.Нет" не найдены.');
        assertNoSideEffects();
      });

      test(`${name}: узел без xmlPath — «Не удалось определить конфигурацию для узла "<p>".»`, async () => {
        const result = await call(name, { ...base(name), paths: ['Справочники.Справочник1', 'БезПути'] });
        assert.strictEqual(result.isError, true);
        assert.strictEqual(text(result), 'Не удалось определить конфигурацию для узла "БезПути".');
        assertNoSideEffects();
      });

      test(`${name}: узел без полного имени объекта — «Путь "<p>": …»`, async () => {
        const result = await call(name, { ...base(name), paths: ['Справочники.Справочник1', 'Справочники'] });
        assert.strictEqual(result.isError, true);
        assert.strictEqual(
          text(result),
          'Путь "Справочники": Для выбранного узла не удалось сформировать полное имя объекта.'
        );
        assertNoSideEffects();
      });
    }

    test('lock: рекурсивный корень в списке (где угодно) без confirm — отказ; confirm=false — тоже', async () => {
      const expected = 'Рекурсивный захват корня захватывает всю конфигурацию и блокирует её для всей команды. Передайте confirm: true.';
      for (const order of [['Конфигурация', 'Справочники.Справочник1'], ['Справочники.Справочник1', 'Конфигурация']]) {
        const result = await call('lock', { paths: order, recursive: true });
        assert.strictEqual(result.isError, true);
        assert.strictEqual(text(result), expected);
      }
      const denied = await call('lock', { paths: ['Справочники.Справочник1', 'Конфигурация'], recursive: true, confirm: false });
      assert.strictEqual(text(denied), expected);
      const ext = await call('lock', { paths: ['Расш.Справочники.Э33_X', 'Расширение.Расш'], recursive: true, configuration: 'Расш' });
      assert.strictEqual(ext.isError, true);
      assert.match(text(ext), /Передайте confirm: true\.$/);
      assertNoSideEffects();
    });

    test('lock: рекурсивный корень в списке с confirm=true — выполняется одним запуском', async () => {
      p.setResult(opLog(LOCK_DONE, lockedLine(C1)));
      data(await call('lock', { paths: ['Справочники.Справочник1', 'Конфигурация'], recursive: true, confirm: true }));
      assert.strictEqual(p.runs.length, 1);
      assert.ok((operationTail(p.args())[2] as { content: string }).content.includes('includeChildObjects="true"'));
    });

    test('commit: порядок проверок — сначала confirm/comment (assertCommitArgs), потом path/paths', async () => {
      const both = { path: 'Справочники.Справочник1', paths: ['Справочники.Справочник3'] };
      const noConfirm = await call('commit', { ...both, comment: 'Правка' });
      assert.strictEqual(text(noConfirm), 'Помещение необратимо записывает версию в общее хранилище команды. Передайте confirm: true.');
      const noComment = await call('commit', { ...both, comment: '  ', confirm: true });
      assert.strictEqual(text(noComment), 'Для помещения требуется непустой комментарий (comment).');
      const bothOnly = await call('commit', { ...both, comment: 'Правка', confirm: true });
      assert.strictEqual(text(bothOnly), 'Передайте либо path (один объект), либо paths (список объектов), но не оба.');
      assertNoSideEffects();
    });

    test('update: захваченный объект ОБЪЕДИНЁННОЙ выборки двух узлов требует overwriteLocked; захват вне списка — нет', async () => {
      p.lock([C3]);
      const ask = await call('update', { paths: ['Справочники.Справочник1', 'Справочники.Справочник3'] });
      assert.strictEqual(ask.isError, true);
      assert.strictEqual(
        text(ask),
        `${describeLockedOverwrite([C3])} Передайте overwriteLocked: true, чтобы подтвердить, или сначала поместите правки (v8vscedit_repository_commit).`
      );
      const declined = await call('update', { paths: ['Справочники.Справочник1', 'Справочники.Справочник3'], overwriteLocked: false });
      assert.strictEqual(text(declined), 'Получение не выполнено: в выборке есть захваченные вами объекты (overwriteLocked: false).');
      assertNoSideEffects();

      p.service.setLocked(p.cfTarget, [C3], false);
      p.lock([D1]);
      p.setResult(opLog(UPDATE_DONE));
      data(await call('update', { paths: ['Справочники.Справочник1', 'Справочники.Справочник3'] }));
      assert.strictEqual(p.runs.length, 1, 'захват вне списка вопроса не вызывает');
    });
  });

  suite('успешное выполнение: один запуск, единый -Objects, один ответ', () => {
    interface Scenario {
      readonly title: string;
      readonly paths: string[];
      readonly recursive: boolean;
      /** fullName объектов выборки без служебного имени корня. */
      readonly names: string[];
      /** Служебное имя корня в requestedObjects (корень первым). */
      readonly withRoot: boolean;
      readonly refs: () => { nodeKind?: string; label?: string; xmlPath?: string }[];
    }
    const SCENARIOS: readonly Scenario[] = [
      {
        title: 'два объекта', paths: ['Справочники.Справочник1', 'Справочники.Справочник3'], recursive: false,
        names: [C1, C3], withRoot: false, refs: () => [o.catalog1.ref, o.catalog3.ref],
      },
      {
        title: 'дочерний элемент и его владелец (дедупликация)', paths: ['Справочники.Справочник1.Артикул', 'Справочники.Справочник1'], recursive: false,
        names: [C1], withRoot: false, refs: () => [o.catalog1Child.ref, o.catalog1.ref],
      },
      {
        title: 'корень вместе с объектом', paths: ['Справочники.Справочник1', 'Конфигурация'], recursive: false,
        names: [C1], withRoot: true, refs: () => [o.catalog1.ref, p.refs.cfRoot],
      },
      {
        title: 'рекурсивная подсистема вместе со своим объектом', paths: ['Подсистемы.П', 'Справочники.Справочник1'], recursive: true,
        names: [SUBSYSTEM, C1], withRoot: false, refs: () => [o.subsystem.ref, o.catalog1.ref],
      },
    ];

    const prepare = (name: CallName, names: readonly string[]): void => {
      if (name === 'unlock') {
        p.lock([...names]);
      }
    };
    const successLog = (name: CallName, names: readonly string[]): string => {
      switch (name) {
        case 'lock': return opLog(LOCK_DONE, ...names.map(lockedLine));
        case 'update': return opLog(UPDATE_DONE, receivedLine(names[0]));
        case 'commit': return opLog(COMMIT_DONE, ...names.map(committedLine));
        case 'unlock': return opLog(UNLOCK_DONE, ...names.map(cancelledLine));
      }
    };

    for (const name of CALLS) {
      for (const scenario of SCENARIOS) {
        test(`${name}: ${scenario.title}`, async () => {
          prepare(name, scenario.names);
          p.setResult(successLog(name, scenario.names));
          const args = { ...base(name), paths: scenario.paths, ...(scenario.recursive ? { recursive: true } : {}) };
          const result = data(await call(name, args));

          assert.strictEqual(p.runs.length, 1, 'один запуск Конфигуратора на весь список');
          const tail = operationTail(p.args());
          assert.strictEqual(tail[0], MARKERS[name]);
          assert.strictEqual(tail[1], '-Objects');
          assert.deepStrictEqual(tail[2], {
            kind: 'inputFile', name: 'objects.xml',
            content: p.service.buildObjectsSelectionForNodes(scenario.refs(), scenario.recursive).xml,
          });
          assert.deepStrictEqual(result.paths, scenario.paths, 'эхо paths');
          assert.strictEqual('path' in result, false, 'при paths эхо path нет');
          if (name !== 'unlock') {
            assert.deepStrictEqual(
              result.requestedObjects,
              scenario.withRoot ? [ROOT_LOCK_CF, ...scenario.names] : scenario.names
            );
          }
          assert.strictEqual(p.events.filter((event) => event.startsWith('repo:')).length, 1);
          assertPostMutationPath();
        });
      }

      test(`${name}: path (один объект) — эхо path без paths, выборка одного объекта`, async () => {
        prepare(name, [C1]);
        p.setResult(successLog(name, [C1]));
        const result = data(await call(name, { ...base(name), path: 'Справочники.Справочник1' }));
        assert.strictEqual(result.path, 'Справочники.Справочник1');
        assert.strictEqual('paths' in result, false);
        assert.deepStrictEqual(operationTail(p.args())[2], { kind: 'inputFile', name: 'objects.xml', content: listXml(C1) });
        assertPostMutationPath();
      });

      test(`${name}: paths из одного элемента — поведение как у path, эхо paths`, async () => {
        prepare(name, [C1]);
        p.setResult(successLog(name, [C1]));
        const result = data(await call(name, { ...base(name), paths: ['Справочники.Справочник1'] }));
        assert.deepStrictEqual(result.paths, ['Справочники.Справочник1']);
        assert.strictEqual('path' in result, false);
        assert.deepStrictEqual(operationTail(p.args())[2], { kind: 'inputFile', name: 'objects.xml', content: listXml(C1) });
      });

      test(`${name}: расширение — paths двух объектов, -Extension Расш в векторе`, async () => {
        const names = [EXT_X, EXT_Y];
        if (name === 'unlock') {
          p.lock(names, p.cfeTarget);
        }
        p.setResult(successLog(name, names));
        const result = data(await call(name, { ...base(name), paths: ['Расш.Справочники.Э33_X', 'Расш.Справочники.Э33_Y'], configuration: 'Расш' }));
        assert.strictEqual(p.runs.length, 1);
        const tail = operationTail(p.args());
        assert.deepStrictEqual(tail.slice(-2), ['-Extension', 'Расш']);
        assert.deepStrictEqual(tail[2], { kind: 'inputFile', name: 'objects.xml', content: listXml(EXT_X, EXT_Y) });
        assert.deepStrictEqual(result.paths, ['Расш.Справочники.Э33_X', 'Расш.Справочники.Э33_Y']);
        if (name === 'lock') {
          assert.deepStrictEqual(result.lockedObjects, names);
          assert.strictEqual(p.service.isLocked(p.cfeTarget, EXT_X), true);
        }
        if (name === 'unlock') {
          assert.deepStrictEqual(result.unlockedObjects, names);
          assert.deepStrictEqual(p.service.listLockedFullNames(p.cfeTarget), []);
        }
      });
    }
  });

  suite('lock: частичный захват, повторный захват своего (Э33.1, Э33.7, Э33.(а))', () => {
    test('Э33.1: exit 1, часть захвачена и версии получены — УСПЕХ с notLocked, lockedByOthers и двумя предупреждениями', async () => {
      p.setResult(E33_1_RECEIVED_LOG, 1);
      const result = data(await call('lock', { paths: ['Справочники.Справочник1', 'Справочники.Справочник3', 'Документы.Документ1'] }));
      assert.deepStrictEqual(result.lockedObjects, [C1, C3]);
      assert.deepStrictEqual(result.requestedObjects, [C1, C3, D1]);
      assert.deepStrictEqual(result.notLocked, [D1]);
      assert.deepStrictEqual(result.lockedByOthers, [{ name: D1, user: 'UserB' }]);
      assert.strictEqual(result.receivedFromRepository, true);
      assert.strictEqual(result.projectImported, true);
      const warnings = result.warnings as string[];
      assert.strictEqual(warnings.length, 2);
      assert.ok(warnings.includes(describeLockNotComplete([D1], [{ name: D1, user: 'UserB' }])), warnings.join(' | '));
      assert.ok(warnings.some((w) => w.startsWith('Ошибка при захвате объектов хранилища:')), warnings.join(' | '));
      assert.deepStrictEqual(p.events, ['repo:lock', 'import:cf']);
      assert.strictEqual(p.service.isLocked(p.cfTarget, C1), true);
      assert.strictEqual(p.service.isLocked(p.cfTarget, D1), false);
      assertPostMutationPath();
    });

    test('Э33.1 без полученных версий: успех без импорта, учёт записан', async () => {
      p.setResult(E33_1_LOG, 1);
      const result = data(await call('lock', { paths: ['Справочники.Справочник1', 'Справочники.Справочник3', 'Документы.Документ1'] }));
      assert.deepStrictEqual(result.lockedObjects, [C1, C3]);
      assert.strictEqual(result.projectImported, false);
      assert.deepStrictEqual(p.events, ['repo:lock']);
    });

    test('Э33.(а): X уже захвачен этим пользователем, строки о нём нет — X в lockedObjects', async () => {
      p.lock([C1]);
      p.setResult(opLog(LOCK_DONE, lockedLine(C3)));
      const result = data(await call('lock', { paths: ['Справочники.Справочник1', 'Справочники.Справочник3'] }));
      assert.deepStrictEqual(result.lockedObjects, [C1, C3]);
      assert.deepStrictEqual(result.notLocked, []);
      assert.deepStrictEqual(result.warnings, []);
    });

    test('Э33.7 (расширение): X захвачен, Y у UserB — lockedObjects [X], notLocked [Y], lockedByOthers', async () => {
      p.setResult(opLog(LOCK_DONE, lockedLine(EXT_X), foreignLine(EXT_Y, 'UserB')));
      const result = data(await call('lock', { paths: ['Расш.Справочники.Э33_X', 'Расш.Справочники.Э33_Y'], configuration: 'Расш' }));
      assert.deepStrictEqual(result.lockedObjects, [EXT_X]);
      assert.deepStrictEqual(result.notLocked, [EXT_Y]);
      assert.deepStrictEqual(result.lockedByOthers, [{ name: EXT_Y, user: 'UserB' }]);
    });

    test('ничего не захвачено и exit 1 — ошибка (как раньше), дерево всё равно обновлено один раз', async () => {
      p.setResult(opLog('Захват объектов не выполнен', foreignLine(D1, 'UserB')), 1);
      const result = await call('lock', { paths: ['Документы.Документ1', 'Справочники.Справочник3'] });
      assert.strictEqual(result.isError, true);
      assert.ok(text(result).startsWith('Ошибка при захвате объектов хранилища:'), text(result));
      assert.strictEqual(p.refreshes, 1);
      assert.strictEqual(p.actionViewRefreshes, 1);
      assert.deepStrictEqual(p.service.listLockedFullNames(p.cfTarget), []);
    });
  });

  suite('update: lockedOverwritten — реально перезаписанные по журналу (Э33.6), а не захваченные в выборке', () => {
    const PATHS = ['Справочники.Справочник1', 'Документы.Документ1', 'Справочники.Справочник3'];

    test('Э33.6: С1 захвачен и получен — перезаписан; Д1 не захвачен; С3 захвачен и не назван', async () => {
      p.lock([C1, C3]);
      p.setResult(opLog(UPDATE_DONE, receivedLine(C1), receivedLine(D1)));
      const result = data(await call('update', { paths: PATHS, overwriteLocked: true }));
      assert.deepStrictEqual(result.lockedOverwritten, [C1]);
      assert.deepStrictEqual(result.requestedObjects, [C1, D1, C3]);
      assert.strictEqual(result.receivedFromRepository, true);
      assert.strictEqual(p.service.isLocked(p.cfTarget, C1), true, 'учёт захвата остаётся');
    });

    test('Э33.6б: «получен» без новой версии в хранилище — всё равно перезаписан', async () => {
      p.lock([C1]);
      p.setResult(opLog(UPDATE_DONE, receivedLine(C1)));
      const result = data(await call('update', { paths: ['Справочники.Справочник1', 'Справочники.Справочник3'], overwriteLocked: true }));
      assert.deepStrictEqual(result.lockedOverwritten, [C1]);
    });

    test('Э33.6в и регресс дефекта: ничего не получено — receivedFromRepository=false и lockedOverwritten=[] (раньше отдавались захваченные в выборке)', async () => {
      p.lock([C1, C3]);
      p.setResult(opLog(UPDATE_DONE));
      const result = data(await call('update', { paths: PATHS, overwriteLocked: true }));
      assert.strictEqual(result.receivedFromRepository, false);
      assert.deepStrictEqual(result.lockedOverwritten, []);
    });

    test('один path: тот же смысл поля', async () => {
      p.lock([C1]);
      p.setResult(opLog(UPDATE_DONE));
      const result = data(await call('update', { path: 'Справочники.Справочник1', overwriteLocked: true }));
      assert.deepStrictEqual(result.lockedOverwritten, []);
      assert.strictEqual(result.path, 'Справочники.Справочник1');
    });
  });

  suite('commit: notCommitted (Э33.4)', () => {
    test('Э33.4б: Д1 не захвачен — платформа молчит; notCommitted, предупреждение, учёт снят у запрошенных', async () => {
      p.lock([C1, D1]);
      p.setResult(opLog(COMMIT_DONE, committedLine(C1)));
      const result = data(await call('commit', { paths: ['Справочники.Справочник1', 'Документы.Документ1'], comment: 'Правка', confirm: true }));
      assert.deepStrictEqual(result.committedObjects, [C1]);
      assert.deepStrictEqual(result.notCommitted, [D1]);
      assert.deepStrictEqual(result.requestedObjects, [C1, D1]);
      assert.deepStrictEqual(result.warnings, [
        'Не помещены: Документ.Документ1 — не захвачены вами или захвачены другим пользователем (платформа пропускает такие объекты без ошибки).',
      ]);
      assert.deepStrictEqual(p.service.listLockedFullNames(p.cfTarget), []);
    });

    test('keepLocked и force применяются ко всему списку: ключи в конце вектора, захват сохраняется', async () => {
      p.lock([C1, C3]);
      p.setResult(opLog(COMMIT_DONE, committedLine(C1), committedLine(C3)));
      data(await call('commit', {
        paths: ['Справочники.Справочник1', 'Справочники.Справочник3'], comment: 'Правка', confirm: true, keepLocked: true, force: true,
      }));
      const tail = operationTail(p.args()).filter((arg): arg is string => typeof arg === 'string');
      assert.ok(tail.includes('-keepLocked') && tail.includes('-force'));
      assert.strictEqual(p.service.isLocked(p.cfTarget, C1), true);
      assert.strictEqual(p.service.isLocked(p.cfTarget, C3), true);
    });
  });

  suite('unlock: атомарный отказ, рекурсия корня, частичное освобождение (Э33.3, Э33.(б))', () => {
    test('Э33.3: изменённый в базе объект блокирует освобождение списка — isError с именами и подсказкой; учёт не тронут; force не передаётся', async () => {
      p.lock([C1, C3]);
      p.setResult(E33_3_LOG, 1);
      const result = await call('unlock', { paths: ['Справочники.Справочник1', 'Справочники.Справочник3'] });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(
        text(result),
        'Захват не отменён ни у одного объекта: платформа отменяет захват списка целиком, а изменены в базе: Справочник.Справочник1. ' +
        UNLOCK_FAILURE_HINT
      );
      assert.ok(!operationTail(p.args()).includes('-force'));
      assert.strictEqual(p.service.isLocked(p.cfTarget, C1), true);
      assert.strictEqual(p.service.isLocked(p.cfTarget, C3), true);
      assert.strictEqual(p.refreshes, 1);
    });

    test('Э33.3 для одного объекта (path): «Захват не отменён: объект X изменён в базе.» + подсказка', async () => {
      p.lock([C1]);
      p.setResult(E33_3_LOG, 1);
      const result = await call('unlock', { path: 'Справочники.Справочник1' });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(text(result), `Захват не отменён: объект Справочник.Справочник1 изменён в базе. ${UNLOCK_FAILURE_HINT}`);
    });

    test('Э33.(б): рекурсивный корень — чужой объект НЕ в unlockedObjects и остаётся в учёте; «не захвачен» не считается неосвобождённым', async () => {
      p.lock([ROOT_LOCK_CF, C1, C3, D1]);
      p.setResult(opLog(
        UNLOCK_DONE, cancelledLine(C1), cancelledLine(C3), cancelledLine(D1), notLockedLine(C3), foreignLine(D1, 'UserB')
      ));
      const result = data(await call('unlock', { path: 'Конфигурация', recursive: true }));
      assert.deepStrictEqual(result.unlockedObjects, [ROOT_LOCK_CF, C1]);
      assert.deepStrictEqual(result.lockedByOthers, [{ name: D1, user: 'UserB' }]);
      assert.deepStrictEqual(result.notUnlocked, []);
      assert.strictEqual(p.service.isLocked(p.cfTarget, D1), true);
      assert.strictEqual(p.service.isLocked(p.cfTarget, C1), false);
    });

    test('частичное освобождение: успех с notUnlocked и предупреждением тем же текстом', async () => {
      p.lock([C1, D1]);
      p.setResult(opLog(UNLOCK_DONE, cancelledLine(C1), foreignLine(D1, 'UserB')));
      const result = data(await call('unlock', { paths: ['Справочники.Справочник1', 'Документы.Документ1'] }));
      assert.deepStrictEqual(result.unlockedObjects, [C1]);
      assert.deepStrictEqual(result.notUnlocked, [D1]);
      assert.deepStrictEqual(result.warnings, ['Захват не отменён: Документ.Документ1; захвачено другим пользователем: Документ.Документ1 (UserB)']);
    });

    test('ничего не освобождено (чужой захват) — ошибка «Захват не отменён: …; захвачено другим пользователем: …», учёт остаётся', async () => {
      p.lock([D1]);
      p.setResult(opLog(UNLOCK_DONE, foreignLine(D1, 'UserB')));
      const result = await call('unlock', { paths: ['Документы.Документ1'] });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(text(result), 'Захват не отменён: Документ.Документ1; захвачено другим пользователем: Документ.Документ1 (UserB)');
      assert.strictEqual(p.service.isLocked(p.cfTarget, D1), true);
    });
  });
});
