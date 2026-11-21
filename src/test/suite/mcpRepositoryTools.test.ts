import * as assert from 'assert';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as vscode from 'vscode';
import { formatRepositoryLockName } from '../../infra/repository/RepositoryService';
import {
  MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE,
  getConfigurationOperationStartedAt,
  isConfigurationOperationRunning,
  tryBeginConfigurationOperation,
} from '../../ui/commands/ext/configurationOperationLock';
import { describeImportFailureAfterReceive, describeLockedOverwrite } from '../../ui/commands/repository/repositoryUpdateFlow';
import { McpMetadataPathService } from '../../ui/mcp/McpMetadataPathService';
import { McpMutationGate } from '../../ui/mcp/registration/McpMutationGate';
import { registerRepositoryTools } from '../../ui/mcp/registration/McpRepositoryTools';
import type { MetadataNode } from '../../ui/tree/TreeNode';
import { ManualScheduler } from './support/manualScheduler';
import { McpOperationOutcomeRegistry } from '../../infra/mcp/McpOperationOutcome';
import { operationStageFeed } from '../../ui/commands/ext/configurationOperationStatus';
import { fakeExtra, waitForNextMillisecond } from './support/mcpFakeExtra';
import {
  COMMIT_DONE, LOCK_DONE, ROOT_LOCK_CF, UNLOCK_DONE, UPDATE_DONE, createRepoProject, opLog, operationTail, type RepoProject,
} from './support/repositoryMcpFixtures';

/**
 * MCP-инструменты хранилища (`ui/mcp/registration/McpRepositoryTools.ts`, `registerRepositoryTools`):
 * v8vscedit_repository_status/lock/update/commit/unlock. Интеграция на настоящих RepositoryService,
 * env.json и выгрузках cf/cfe; подменены исполнитель Конфигуратора, шаги загрузки/импорта через
 * платформу и окна сообщений (у MCP их быть не должно — проверяется).
 * Все защиты проверяются БЕЗ запуска исполнителя: `runs.length === 0`, замок свободен.
 */

const T = 'Справочник.Товары';
const FOREIGN = 'Объект захвачен для редактирования другим пользователем: ';
const CALLS = ['lock', 'update', 'commit', 'unlock'] as const;
type CallName = (typeof CALLS)[number];

interface RegisteredTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean };
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

suite('MCP-инструменты хранилища (v8vscedit_repository_*)', function () {
  this.timeout(60_000);

  let p: RepoProject;
  let tools: Map<string, RegisteredTool>;
  let resolved: { path: string; configuration?: string }[];
  // Шлюз общий для инструментов и проверок lastOperation: исходы пишет wrapLongRunning, статус их читает.
  let gate: McpMutationGate;

  /** Регистрирует инструменты хранилища с заданным резолвером путей (пересборка реестра `tools`). */
  function mount(paths: unknown): void {
    tools.clear();
    const server = {
      registerTool: (name: string, config: Omit<RegisteredTool, 'name' | 'handler'>, handler: RegisteredTool['handler']) => {
        tools.set(name, { ...config, name, handler });
      },
    };
    gate = new McpMutationGate(
      p.services,
      { scheduler: new ManualScheduler(), intervalMs: 20_000, readStage: () => operationStageFeed.current() },
      new McpOperationOutcomeRegistry()
    );
    registerRepositoryTools(server as never, {
      services: p.services, xmlEditor: {}, paths, properties: {}, mutations: {}, gate,
    } as never);
  }

  async function boot(): Promise<void> {
    p = await createRepoProject();
    tools = new Map();
    resolved = [];
    const map: Record<string, MetadataNode> = {
      'Справочники.Товары': p.nodes.catalog,
      'Справочники.Товары.Артикул': p.nodes.child,
      Конфигурация: p.nodes.cfRoot,
      'Расширение.Расш': p.nodes.cfeRoot,
      'Расш.Справочники.Товары': p.nodes.cfeCatalog,
    };
    const paths = {
      resolveNode: (canonical: string, configuration?: string) => {
        resolved.push({ path: canonical, configuration });
        if (!Object.prototype.hasOwnProperty.call(map, canonical)) {
          throw new Error(`Метаданные по пути "${canonical}" не найдены.`);
        }
        return map[canonical];
      },
    };
    mount(paths);
  }

  setup(boot);
  teardown(() => p.dispose());

  const call = (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    const tool = tools.get(`v8vscedit_repository_${name}`);
    assert.ok(tool, `инструмент v8vscedit_repository_${name} не зарегистрирован`);
    return tool.handler(args);
  };
  const dirty = (count = 3): void => { p.changed = [{ rootPath: p.cfRoot, name: 'Основная', changedFilesCount: count }]; };

  function assertNoSideEffects(): void {
    assert.strictEqual(p.runs.length, 0, 'исполнитель не запускался');
    assert.deepStrictEqual(p.events, []);
    assert.strictEqual(isConfigurationOperationRunning(), false, 'замок свободен');
    assert.deepStrictEqual(p.toasts, []);
  }

  suite('регистрация', () => {
    test('пять инструментов; аннотации: status — readOnly, lock/unlock — не destructive, update/commit — destructive', () => {
      assert.deepStrictEqual(
        [...tools.keys()].sort(),
        ['status', 'lock', 'update', 'commit', 'unlock'].map((name) => `v8vscedit_repository_${name}`).sort()
      );
      assert.strictEqual(tools.get('v8vscedit_repository_status')?.annotations?.readOnlyHint, true);
      assert.strictEqual(tools.get('v8vscedit_repository_lock')?.annotations?.destructiveHint, false);
      assert.strictEqual(tools.get('v8vscedit_repository_unlock')?.annotations?.destructiveHint, false);
      assert.strictEqual(tools.get('v8vscedit_repository_update')?.annotations?.destructiveHint, true);
      assert.strictEqual(tools.get('v8vscedit_repository_commit')?.annotations?.destructiveHint, true);
    });

    test('схемы входа: путь — path (не objectPath), force/version у update не открыты, force у unlock не открыт, confirm и comment у commit обязательны', () => {
      assert.deepStrictEqual(shape(tools.get('v8vscedit_repository_status')?.inputSchema), { path: false, configuration: true });
      assert.deepStrictEqual(shape(tools.get('v8vscedit_repository_lock')?.inputSchema),
        { path: false, configuration: true, recursive: true, localChanges: true, confirm: true, updateDatabase: true });
      assert.deepStrictEqual(shape(tools.get('v8vscedit_repository_update')?.inputSchema),
        { path: false, configuration: true, recursive: true, localChanges: true, overwriteLocked: true, updateDatabase: true });
      assert.deepStrictEqual(shape(tools.get('v8vscedit_repository_commit')?.inputSchema),
        { path: false, configuration: true, recursive: true, comment: false, keepLocked: true, force: true, localChanges: true, confirm: false, updateDatabase: true });
      assert.deepStrictEqual(shape(tools.get('v8vscedit_repository_unlock')?.inputSchema),
        { path: false, configuration: true, recursive: true });
    });

    test('description помещения предупреждает: -force молча чистит ссылки на удалённые объекты и не обходит захват', () => {
      const description = tools.get('v8vscedit_repository_commit')?.description ?? '';
      assert.ok(description.includes('платформа сама удалит из объекта ссылки на удалённые объекты'), description);
      assert.ok(description.includes('захват не обходит'), description);
    });
  });

  suite('v8vscedit_repository_status', () => {
    test('объект с привязкой: цель, привязка без пароля, подключено, захваты (с подписью), счётчик незагруженных, узел', async () => {
      p.lock([T, ROOT_LOCK_CF]);
      dirty(2);
      const result = data(await call('status', { path: 'Справочники.Товары' }));

      const names = [T, ROOT_LOCK_CF].sort((a, b) => a.localeCompare(b, 'ru'));
      assert.strictEqual(result.path, 'Справочники.Товары');
      assert.deepStrictEqual(result.target, { displayName: p.cfTarget.displayName, kind: 'cf' });
      assert.deepStrictEqual(result.binding, { repoPath: 'C:\\repo', repoUser: 'u' }, 'пароль наружу не отдаётся');
      assert.strictEqual(JSON.stringify(result).includes('"p"'), false);
      assert.strictEqual(result.passwordStored, true);
      assert.strictEqual(result.connected, true);
      assert.deepStrictEqual(result.lockedObjects, names.map((name) => ({ name, label: formatRepositoryLockName(name) })));
      assert.strictEqual(result.lockAccounting, 'local');
      assert.strictEqual(result.unloadedChangedFilesCount, 2);
      assert.deepStrictEqual(result.node, { fullName: T, locked: true, editRestricted: false });
      assert.deepStrictEqual(p.runs, [], 'платформа не вызывается');
      assert.strictEqual(isConfigurationOperationRunning(), false, 'замок не берётся');
    });

    test('незахваченный объект: locked=false, editRestricted=true; счётчик другой конфигурации не смешивается (0)', async () => {
      p.changed = [{ rootPath: p.cfeRoot, name: 'Расш', changedFilesCount: 9 }];
      const result = data(await call('status', { path: 'Справочники.Товары' }));
      assert.deepStrictEqual(result.node, { fullName: T, locked: false, editRestricted: true });
      assert.strictEqual(result.unloadedChangedFilesCount, 0);
      assert.deepStrictEqual(result.lockedObjects, []);
    });

    test('дочерний узел разрешается во владельца; корень расширения: kind=cfe, extensionName, fullName=null', async () => {
      const child = data(await call('status', { path: 'Справочники.Товары.Артикул' }));
      assert.strictEqual((child.node as { fullName: string }).fullName, T);

      const root = data(await call('status', { path: 'Расширение.Расш', configuration: 'Расш' }));
      assert.deepStrictEqual(root.target, { displayName: p.cfeTarget.displayName, kind: 'cfe', extensionName: 'Расш' });
      assert.strictEqual((root.node as { fullName: unknown }).fullName, null);
      assert.deepStrictEqual(resolved.at(-1), { path: 'Расширение.Расш', configuration: 'Расш' });
    });

    test('расширение без привязки: binding=null, passwordStored=false, connected=false — это штатный ответ, а не ошибка', async () => {
      const bare = p.addUnboundExtension('Безхранилища');
      mount({ resolveNode: () => bare.node });
      const result = data(await call('status', { path: 'Расширение.Безхранилища' }));
      assert.strictEqual(result.binding, null);
      assert.strictEqual(result.passwordStored, false);
      assert.strictEqual(result.connected, false);
    });

    test('неканонический путь (английский алиас) — isError с подсказкой канона, без побочных эффектов', async () => {
      const real = new McpMetadataPathService({ getAutomationRoots: () => [], getEntries: () => [] } as never);
      mount(real);
      const result = await call('status', { path: 'Catalog.Товары' });
      assert.strictEqual(result.isError, true);
      assertNoSideEffects();
    });
  });

  suite('v8vscedit_repository_status: состояние идущей операции и lastOperation (контракт плана 1.6/1.8)', () => {
    const statusOf = async (): Promise<Record<string, unknown>> => data(await call('status', { path: 'Справочники.Товары' }));
    const iso = (ms: number): string => new Date(ms).toISOString();
    const run = (fn: () => Promise<unknown>, tool = 'v8vscedit_repository_lock'): Promise<unknown> =>
      gate.wrapLongRunning(tool, fakeExtra(), fn);

    test('операции нет: operationRunning=false, currentOperation=null, lastOperation=null', async () => {
      const result = await statusOf();
      assert.strictEqual(result.operationRunning, false);
      assert.strictEqual(result.currentOperation, null);
      assert.strictEqual(result.lastOperation, null);
    });

    test('идёт операция со свежим этапом: startedAt (ISO момента старта замка), elapsedSeconds, title, stage, stageUpdatedAt', async () => {
      assert.strictEqual(await tryBeginConfigurationOperation(), true);
      const startedAt = getConfigurationOperationStartedAt();
      assert.strictEqual(typeof startedAt, 'number');
      const feed = operationStageFeed;
      feed.publish('update', 'Получение из хранилища', 'Объект Товары');
      const stageAt = feed.current()?.at ?? -1;

      const result = await statusOf();
      assert.strictEqual(result.operationRunning, true);
      const current = result.currentOperation as Record<string, unknown>;
      assert.deepStrictEqual(Object.keys(current).sort(), ['elapsedSeconds', 'stage', 'stageUpdatedAt', 'startedAt', 'title']);
      assert.strictEqual(current.startedAt, iso(startedAt ?? 0));
      assert.strictEqual(current.title, 'Получение из хранилища');
      assert.strictEqual(current.stage, 'Объект Товары');
      assert.strictEqual(current.stageUpdatedAt, iso(stageAt));
      assert.ok(typeof current.elapsedSeconds === 'number' && current.elapsedSeconds >= 0);
      assert.strictEqual(isConfigurationOperationRunning(), true, 'статус замок не освобождает и не берёт');
      assert.deepStrictEqual(p.runs, [], 'платформа не вызывается');
    });

    test('идёт операция, этап устаревший (опубликован до старта замка): только startedAt и elapsedSeconds', async () => {
      operationStageFeed.publish('update', 'Чужая операция', 'остаток прошлого этапа');
      waitForNextMillisecond();
      assert.strictEqual(await tryBeginConfigurationOperation(), true);

      const result = await statusOf();
      assert.strictEqual(result.operationRunning, true);
      const current = result.currentOperation as Record<string, unknown>;
      assert.deepStrictEqual(Object.keys(current).sort(), ['elapsedSeconds', 'startedAt']);
    });

    test('lastOperation после успешной долгой операции: tool, ISO-время начала/конца, isError=false, summary', async () => {
      await run(() => Promise.resolve({ path: 'Справочники.Товары', done: true }));
      const last = (await statusOf()).lastOperation as Record<string, unknown>;
      assert.deepStrictEqual(Object.keys(last).sort(), ['finishedAt', 'isError', 'startedAt', 'summary', 'tool']);
      assert.strictEqual(last.tool, 'v8vscedit_repository_lock');
      assert.strictEqual(last.isError, false);
      assert.strictEqual(typeof last.summary, 'string');
      for (const key of ['startedAt', 'finishedAt'] as const) {
        const value = last[key];
        assert.ok(typeof value === 'string' && iso(Date.parse(value)) === value, `${key} — ISO-строка: ${String(value)}`);
      }
      assert.ok(Date.parse(last.finishedAt as string) >= Date.parse(last.startedAt as string));
    });

    test('lastOperation после ошибки: isError=true, summary — первая строка текста ошибки; следующая операция заменяет запись', async () => {
      await run(() => Promise.reject(new Error('Отказ платформы\nПодробности во второй строке')));
      const failed = (await statusOf()).lastOperation as Record<string, unknown>;
      assert.strictEqual(failed.isError, true);
      assert.strictEqual(failed.summary, 'Отказ платформы');

      await run(() => Promise.resolve({ done: true }), 'v8vscedit_repository_commit');
      const next = (await statusOf()).lastOperation as Record<string, unknown>;
      assert.strictEqual(next.tool, 'v8vscedit_repository_commit');
      assert.strictEqual(next.isError, false);
    });
  });

  suite('защиты без побочных эффектов (исполнитель не запускается, замок свободен)', () => {
    const GUARDS: readonly {
      title: string;
      tool: CallName;
      args: Record<string, unknown>;
      prepare?: (project: RepoProject) => void;
      message: (project: RepoProject) => string | RegExp;
    }[] = [
      {
        title: 'захват корня рекурсивно без confirm',
        tool: 'lock', args: { path: 'Конфигурация', recursive: true },
        message: () => 'Рекурсивный захват корня захватывает всю конфигурацию и блокирует её для всей команды. Передайте confirm: true.',
      },
      {
        title: 'захват корня рекурсивно, confirm=false',
        tool: 'lock', args: { path: 'Конфигурация', recursive: true, confirm: false },
        message: () => 'Рекурсивный захват корня захватывает всю конфигурацию и блокирует её для всей команды. Передайте confirm: true.',
      },
      {
        title: 'захват корня расширения рекурсивно без confirm',
        tool: 'lock', args: { path: 'Расширение.Расш', recursive: true },
        message: () => /Передайте confirm: true\.$/,
      },
      {
        title: 'захват: незагруженные правки без localChanges — перечень вариантов',
        tool: 'lock', args: { path: 'Справочники.Товары' }, prepare: () => dirty(),
        message: () => /localChanges[\s\S]*loadFirst[\s\S]*keepProjectBehind[\s\S]*abort/,
      },
      {
        title: 'захват: localChanges=abort',
        tool: 'lock', args: { path: 'Справочники.Товары', localChanges: 'abort' }, prepare: () => dirty(),
        message: () => /^Захват не выполнен:/,
      },
      {
        title: 'получение: захвачен получаемый объект, overwriteLocked не передан',
        tool: 'update', args: { path: 'Справочники.Товары' }, prepare: (project) => project.lock([T]),
        message: () => `${describeLockedOverwrite([T])} Передайте overwriteLocked: true, чтобы подтвердить, или сначала поместите правки (v8vscedit_repository_commit).`,
      },
      {
        title: 'получение: overwriteLocked=false',
        tool: 'update', args: { path: 'Справочники.Товары', overwriteLocked: false }, prepare: (project) => project.lock([T]),
        message: () => 'Получение не выполнено: в выборке есть захваченные вами объекты (overwriteLocked: false).',
      },
      {
        title: 'получение: незагруженные правки без localChanges',
        tool: 'update', args: { path: 'Справочники.Товары' }, prepare: () => dirty(),
        message: () => /localChanges[\s\S]*loadAfter[\s\S]*keepProjectBehind[\s\S]*abort/,
      },
      {
        title: 'получение: localChanges=abort',
        tool: 'update', args: { path: 'Справочники.Товары', localChanges: 'abort' }, prepare: () => dirty(),
        message: () => /^Получение не выполнено:/,
      },
      {
        title: 'помещение: confirm не передан',
        tool: 'commit', args: { path: 'Справочники.Товары', comment: 'Правка' },
        message: () => 'Помещение необратимо записывает версию в общее хранилище команды. Передайте confirm: true.',
      },
      {
        title: 'помещение: confirm=false',
        tool: 'commit', args: { path: 'Справочники.Товары', comment: 'Правка', confirm: false },
        message: () => 'Помещение необратимо записывает версию в общее хранилище команды. Передайте confirm: true.',
      },
      {
        title: 'помещение: пустой комментарий',
        tool: 'commit', args: { path: 'Справочники.Товары', comment: '   ', confirm: true },
        message: () => 'Для помещения требуется непустой комментарий (comment).',
      },
      {
        title: 'помещение: незагруженные правки без localChanges',
        tool: 'commit', args: { path: 'Справочники.Товары', comment: 'Правка', confirm: true }, prepare: () => dirty(),
        message: () => /^В проекте 3 незагруженных изменённых файлов; помещение без предварительной загрузки запрещено\. Передайте localChanges: 'loadFirst'/,
      },
      {
        title: 'помещение: localChanges=abort',
        tool: 'commit', args: { path: 'Справочники.Товары', comment: 'Правка', confirm: true, localChanges: 'abort' }, prepare: () => dirty(),
        message: () => /^Помещение не выполнено:/,
      },
      {
        title: 'неканонический/неизвестный путь',
        tool: 'unlock', args: { path: 'Catalog.Товары' },
        message: () => /Catalog\.Товары/,
      },
    ];

    for (const guard of GUARDS) {
      test(`${guard.tool}: ${guard.title}`, async () => {
        guard.prepare?.(p);
        const result = await call(guard.tool, guard.args);
        assert.strictEqual(result.isError, true, text(result));
        const expected = guard.message(p);
        if (typeof expected === 'string') {
          assert.strictEqual(text(result), expected);
        } else {
          assert.match(text(result), expected);
        }
        assertNoSideEffects();
      });
    }

    const VALID: Record<CallName, Record<string, unknown>> = {
      lock: { path: 'Расширение.Безхранилища' },
      update: { path: 'Расширение.Безхранилища' },
      commit: { path: 'Расширение.Безхранилища', comment: 'Правка', confirm: true },
      unlock: { path: 'Расширение.Безхранилища' },
    };

    for (const name of CALLS) {
      test(`${name}: нет привязки к хранилищу — «Для "<имя>" нет активного подключения…» + ссылка на status, без запуска`, async () => {
        const bare = p.addUnboundExtension('Безхранилища');
        mount({ resolveNode: () => bare.node });
        const result = await call(name, VALID[name]);
        assert.strictEqual(result.isError, true);
        assert.ok(text(result).startsWith(`Для "${bare.target.displayName}" нет активного подключения к хранилищу.`), text(result));
        assert.ok(text(result).includes('(состояние — v8vscedit_repository_status)'), text(result));
        assertNoSideEffects();
      });

      test(`${name}: хранилище отключено (setConnected=false) — тот же отказ`, async () => {
        p.service.setConnected(p.cfTarget, false);
        const args = { ...VALID[name], path: 'Справочники.Товары' };
        const result = await call(name, args);
        assert.strictEqual(result.isError, true);
        assert.ok(text(result).includes('нет активного подключения к хранилищу'), text(result));
        assertNoSideEffects();
      });

      test(`${name}: замок занят другой операцией — MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE, запуска нет, чужой замок не снят`, async () => {
        assert.strictEqual(await tryBeginConfigurationOperation(), true);
        const args = { ...VALID[name], path: 'Справочники.Товары' };
        const result = await call(name, args);
        assert.strictEqual(result.isError, true);
        // Смена контракта (план mcp-long-running, 1.8): MCP-текст вместо базового.
        assert.strictEqual(text(result), MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE);
        assert.strictEqual(p.runs.length, 0);
        assert.strictEqual(isConfigurationOperationRunning(), true);
        assert.deepStrictEqual(p.toasts, []);
      });
    }

    test('ответ по защите не меняет учёт захватов', async () => {
      p.lock([T]);
      await call('update', { path: 'Справочники.Товары' });
      assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
    });
  });

  suite('захват', () => {
    const OBJECTS = (project: RepoProject, recursive: boolean, ref = project.refs.catalog): unknown =>
      ({ kind: 'inputFile', name: 'objects.xml', content: project.service.buildObjectsSelectionForNode(ref, recursive).xml });

    test('вектор: -Objects (XML выборки), -revised при настройке true; результат, учёт, замок, пост-мутационный путь', async () => {
      p.setResult(opLog(LOCK_DONE, `Объект захвачен для редактирования: ${T}`, `Объект получен из хранилища: ${T}`));
      const revised = vscodeRevised(true);
      await revised.apply();
      try {
        const result = data(await call('lock', { path: 'Справочники.Товары' }));

        assert.deepStrictEqual(operationTail(p.args()), ['/ConfigurationRepositoryLock', '-Objects', OBJECTS(p, false), '-revised']);
        assert.strictEqual(p.args()[0], 'DESIGNER');
        assert.ok(p.args().includes('C:\\repo'));
        assert.deepStrictEqual(result, {
          path: 'Справочники.Товары', lockedObjects: [T], requestedObjects: [T], receivedFromRepository: true,
          databaseLoadedBefore: false, projectImported: true, projectBehind: false, warnings: [],
          databaseConfigurationUpdated: false, databaseConfigurationBehind: true,
        });
        assert.deepStrictEqual(p.events, ['repo:lock', 'import:cf']);
        assert.deepStrictEqual(p.lockHeldAt, { 'repo:lock': true, 'import:cf': true });
        assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
        assert.deepStrictEqual(p.cleaned, [[p.cfRoot]]);
        assert.deepStrictEqual(p.suppressCalls, [], 'suppressConfigurationReloadForFiles не вызывается');
        assert.deepStrictEqual(p.markChangedCalls, [], 'markChangedConfigurationByFiles не вызывается (иначе «Обновить БД» залила бы старые файлы)');
        assert.ok(p.refreshes >= 1 && p.actionViewRefreshes >= 1, 'treeProvider.refresh + refreshActionsView');
        assert.deepStrictEqual(p.toasts, [], 'тостов нет');
        assert.strictEqual(isConfigurationOperationRunning(), false);
      } finally {
        await revised.restore();
      }
    });

    test('настройка getRevisedOnLock=false: -revised нет', async () => {
      const revised = vscodeRevised(false);
      await revised.apply();
      try {
        p.setResult(opLog(LOCK_DONE, `Объект захвачен для редактирования: ${T}`));
        await call('lock', { path: 'Справочники.Товары' });
        assert.deepStrictEqual(operationTail(p.args()), ['/ConfigurationRepositoryLock', '-Objects', OBJECTS(p, false)]);
      } finally {
        await revised.restore();
      }
    });

    test('цель cfe: вектор оканчивается -Extension Расш; импорт расширения', async () => {
      const revised = vscodeRevised(false);
      await revised.apply();
      try {
        p.setResult(opLog(LOCK_DONE, `Объект захвачен для редактирования: ${T}`, `Объект получен из хранилища: ${T}`));
        await call('lock', { path: 'Расш.Справочники.Товары', configuration: 'Расш' });
        assert.deepStrictEqual(operationTail(p.args()), [
          '/ConfigurationRepositoryLock', '-Objects', OBJECTS(p, false, p.refs.cfeCatalog), '-Extension', 'Расш',
        ]);
        assert.deepStrictEqual(p.events, ['repo:lock', 'import:cfe:Расш']);
        assert.strictEqual(p.service.isLocked(p.cfeTarget, T), true);
      } finally {
        await revised.restore();
      }
    });

    test('дочерний узел → владелец: выборка по полному имени владельца, учёт по владельцу', async () => {
      p.setResult(opLog(LOCK_DONE, `Объект захвачен для редактирования: ${T}`));
      const result = data(await call('lock', { path: 'Справочники.Товары.Артикул' }));
      const objects = operationTail(p.args())[2] as { content: string };
      assert.ok(objects.content.includes(`fullName="${T}"`), objects.content);
      assert.deepStrictEqual(result.requestedObjects, [T]);
      assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
    });

    test('рекурсивный корень с confirm=true: includeChildObjects="true", служебное имя корня в requestedObjects', async () => {
      p.setResult(opLog(LOCK_DONE));
      const result = data(await call('lock', { path: 'Конфигурация', recursive: true, confirm: true }));
      assert.deepStrictEqual(result.requestedObjects, [ROOT_LOCK_CF]);
      assert.ok((operationTail(p.args())[2] as { content: string }).content.includes('includeChildObjects="true"'));
    });

    test('частичный захват (Н10): помечается только названное логом', async () => {
      p.setResult(opLog(LOCK_DONE, 'Объекты, отсутствующие в обеих конфигурациях: Справочник.Нет'));
      const result = data(await call('lock', { path: 'Справочники.Товары' }));
      assert.deepStrictEqual(result.lockedObjects, []);
      assert.strictEqual(p.service.isLocked(p.cfTarget, T), false);
    });

    test('правки проекта: loadFirst — загрузка → захват → импорт; keepProjectBehind — без импорта, projectBehind=true и предупреждение', async () => {
      dirty();
      p.setResult(opLog(LOCK_DONE, `Объект захвачен для редактирования: ${T}`, `Объект получен из хранилища: ${T}`));
      const first = data(await call('lock', { path: 'Справочники.Товары', localChanges: 'loadFirst' }));
      assert.deepStrictEqual(p.events, ['update:cf', 'repo:lock', 'import:cf']);
      assert.strictEqual(first.databaseLoadedBefore, true);
      assert.strictEqual(first.projectImported, true);

      p.events.length = 0;
      p.runs.length = 0;
      p.service.setLocked(p.cfTarget, [T], false);
      const second = data(await call('lock', { path: 'Справочники.Товары', localChanges: 'keepProjectBehind' }));
      assert.deepStrictEqual(p.events, ['repo:lock']);
      assert.ok(!operationTail(p.args()).includes('-revised'), 'keepProjectBehind отключает -revised');
      assert.strictEqual(second.projectBehind, true);
      assert.strictEqual(second.projectImported, false);
      assert.strictEqual((second.warnings as string[]).length, 1);
    });

    test('сбой загрузки до захвата: точный текст, захват не выполнялся', async () => {
      dirty();
      p.updateResult = false;
      const result = await call('lock', { path: 'Справочники.Товары', localChanges: 'loadFirst' });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(text(result), 'Загрузка правок проекта в базу не выполнена; захват не выполнялся. Подробности — в журнале «1С Редактор».');
      assert.strictEqual(p.runs.length, 0);
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });

    test('unattended: отказ загрузки перед захватом несёт причину раннера («Причина: …»); интерактивных окон нет; цепочка получила interaction', async () => {
      dirty();
      p.updateResult = false;
      p.loadFailureReason = 'Загрузка отменена; база и проект не изменены. Выполните загрузку из интерфейса VS Code.';
      const result = await call('lock', { path: 'Справочники.Товары', localChanges: 'loadFirst' });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(
        text(result),
        'Загрузка правок проекта в базу не выполнена; захват не выполнялся. Подробности — в журнале «1С Редактор». ' +
          'Причина: Загрузка отменена; база и проект не изменены. Выполните загрузку из интерфейса VS Code.'
      );
      assert.strictEqual(p.updateOptions().interaction, 'unattended');
      assert.strictEqual(p.runs.length, 0);
      assert.deepStrictEqual(p.toasts, []);
    });

    test('exit≠0: isError «Ошибка при захвате объектов хранилища: <причина>», учёт не тронут, тостов нет, замок свободен', async () => {
      p.setResult('Нет доступа к хранилищу', 1);
      const result = await call('lock', { path: 'Справочники.Товары' });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(text(result), 'Ошибка при захвате объектов хранилища: Нет доступа к хранилищу');
      assert.strictEqual(p.service.isLocked(p.cfTarget, T), false);
      assert.deepStrictEqual(p.toasts, []);
      assert.strictEqual(isConfigurationOperationRunning(), false);
      assert.strictEqual(p.disposedExecutors, 1);
    });

    test('прерывание пользователем: isError «Операция прервана пользователем»', async () => {
      p.setResult('', 0, { interrupted: 'Отменено пользователем' });
      const result = await call('lock', { path: 'Справочники.Товары' });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(text(result), 'Операция прервана пользователем');
      assert.deepStrictEqual(p.toasts, []);
    });
  });

  suite('получение', () => {
    const GOT = opLog(UPDATE_DONE, `Объект получен из хранилища: ${T}`);

    test('вектор без -force и -v (не открыты); результат; импорт; пост-мутационный путь как у захвата', async () => {
      p.setResult(GOT);
      const result = data(await call('update', { path: 'Справочники.Товары' }));
      const tail = operationTail(p.args());
      assert.deepStrictEqual([tail[0], tail[1], tail.length], ['/ConfigurationRepositoryUpdateCfg', '-Objects', 3]);
      assert.deepStrictEqual(result, {
        path: 'Справочники.Товары', receivedFromRepository: true, changesLoadedAfter: false,
        projectImported: true, projectBehind: false, lockedOverwritten: [], warnings: [],
        databaseConfigurationUpdated: false, databaseConfigurationBehind: true,
      });
      assert.deepStrictEqual(p.events, ['repo:update', 'import:cf']);
      assert.deepStrictEqual(p.lockHeldAt, { 'repo:update': true, 'import:cf': true });
      assert.deepStrictEqual(p.suppressCalls, []);
      assert.deepStrictEqual(p.markChangedCalls, []);
      assert.ok(p.refreshes >= 1 && p.actionViewRefreshes >= 1);
      assert.deepStrictEqual(p.toasts, []);
    });

    test('overwriteLocked=true при захваченном: получение выполняется, lockedOverwritten — имена, учёт захвата остаётся', async () => {
      p.lock([T]);
      p.setResult(GOT);
      const result = data(await call('update', { path: 'Справочники.Товары', overwriteLocked: true }));
      assert.deepStrictEqual(result.lockedOverwritten, [T]);
      assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
    });

    test('правки проекта: loadAfter — получение → загрузка → импорт (Э24); keepProjectBehind — projectBehind=true', async () => {
      dirty();
      p.setResult(GOT);
      const first = data(await call('update', { path: 'Справочники.Товары', localChanges: 'loadAfter' }));
      assert.deepStrictEqual(p.events, ['repo:update', 'update:cf', 'import:cf']);
      assert.strictEqual(first.changesLoadedAfter, true);

      p.events.length = 0;
      const second = data(await call('update', { path: 'Справочники.Товары', localChanges: 'keepProjectBehind' }));
      assert.deepStrictEqual(p.events, ['repo:update']);
      assert.strictEqual(second.projectBehind, true);
    });

    test('сбой загрузки после получения — УСПЕХ с describeLoadFailureAfterReceive и projectBehind=true', async () => {
      dirty();
      p.updateResult = false;
      p.setResult(GOT);
      const result = data(await call('update', { path: 'Справочники.Товары', localChanges: 'loadAfter' }));
      assert.strictEqual(result.projectBehind, true);
      assert.strictEqual((result.warnings as string[]).length, 1);
      assert.ok((result.warnings as string[])[0].includes('правки проекта в базу не загружены'));
    });

    test('unattended: импорт после получения отказал (полная выгрузка) — предупреждение с причиной и projectBehind=true; импорт шёл в unattended', async () => {
      p.importResult = false;
      p.importFailureReason = 'Импорт «Основная» требует полной выгрузки конфигурации на сервере. Проект не изменён.';
      p.setResult(GOT);
      const result = data(await call('update', { path: 'Справочники.Товары' }));
      assert.strictEqual(result.projectBehind, true);
      assert.strictEqual(result.projectImported, false);
      assert.deepStrictEqual(result.warnings, [
        `${describeImportFailureAfterReceive(p.cfTarget.displayName)} Причина: ${p.importFailureReason}`,
      ]);
      assert.strictEqual(p.importOptions()?.interaction, 'unattended');
      assert.deepStrictEqual(p.toasts, []);
    });

    test('unattended: сбой загрузки после получения — предупреждение дополнено причиной раннера', async () => {
      dirty();
      p.updateResult = false;
      p.loadFailureReason = 'Платформа отказала';
      p.setResult(GOT);
      const result = data(await call('update', { path: 'Справочники.Товары', localChanges: 'loadAfter' }));
      assert.strictEqual(result.projectBehind, true);
      assert.ok((result.warnings as string[])[0].endsWith('Причина: Платформа отказала'), (result.warnings as string[])[0]);
    });

    test('exit≠0 и прерывание', async () => {
      p.setResult('нет доступа', 1);
      const failed = await call('update', { path: 'Справочники.Товары' });
      assert.strictEqual(text(failed), 'Ошибка при получении изменений из хранилища: нет доступа');
      p.setResult('', 0, { interrupted: 'Отменено пользователем' });
      assert.strictEqual(text(await call('update', { path: 'Справочники.Товары' })), 'Операция прервана пользователем');
    });
  });

  suite('помещение', () => {
    const COMMITTED = opLog(COMMIT_DONE, `Объект помещен в хранилище: ${T}`);
    const ARGS = { path: 'Справочники.Товары', comment: 'Правка', confirm: true };

    test('вектор: -Objects, -comment; результат по строкам лога; учёт снят; без -keepLocked/-force', async () => {
      p.lock([T]);
      p.setResult(COMMITTED);
      const result = data(await call('commit', ARGS));
      assert.deepStrictEqual(operationTail(p.args()), [
        '/ConfigurationRepositoryCommit', '-Objects',
        { kind: 'inputFile', name: 'objects.xml', content: p.service.buildObjectsSelectionForNode(p.refs.catalog, false).xml },
        '-comment', 'Правка',
      ]);
      assert.deepStrictEqual(result, {
        path: 'Справочники.Товары', committedObjects: [T], keptLocked: false, referencesCleaned: false,
        databaseLoadedBefore: false, projectImported: false, warnings: [],
        databaseConfigurationUpdated: false, databaseConfigurationBehind: false,
      });
      assert.strictEqual(p.service.isLocked(p.cfTarget, T), false);
      assert.deepStrictEqual(p.lockHeldAt, { 'repo:commit': true });
      assert.deepStrictEqual(p.suppressCalls, []);
      assert.deepStrictEqual(p.markChangedCalls, []);
      assert.ok(p.refreshes >= 1 && p.actionViewRefreshes >= 1);
      assert.deepStrictEqual(p.toasts, []);
    });

    test('keepLocked и force: -keepLocked, -force в конце вектора; захват сохраняется', async () => {
      p.lock([T]);
      p.setResult(COMMITTED);
      const result = data(await call('commit', { ...ARGS, keepLocked: true, force: true }));
      assert.deepStrictEqual(operationTail(p.args()).slice(-2), ['-keepLocked', '-force']);
      assert.strictEqual(result.keptLocked, true);
      assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
    });

    test('цель cfe: -Extension Расш в конце', async () => {
      p.lock([T], p.cfeTarget);
      p.setResult(COMMITTED);
      await call('commit', { ...ARGS, path: 'Расш.Справочники.Товары' });
      assert.deepStrictEqual(p.args().slice(-2), ['-Extension', 'Расш']);
    });

    test('loadFirst при правках проекта: загрузка → помещение', async () => {
      dirty();
      p.lock([T]);
      p.setResult(COMMITTED);
      const result = data(await call('commit', { ...ARGS, localChanges: 'loadFirst' }));
      assert.deepStrictEqual(p.events, ['update:cf', 'repo:commit']);
      assert.strictEqual(result.databaseLoadedBefore, true);
    });

    test('сбой загрузки перед помещением: isError, помещение не запускалось', async () => {
      dirty();
      p.updateResult = false;
      const result = await call('commit', { ...ARGS, localChanges: 'loadFirst' });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(text(result), 'Загрузка правок проекта в базу не выполнена; помещение не выполнялось. Подробности — в журнале «1С Редактор».');
      assert.strictEqual(p.runs.length, 0);
    });

    test('очистка ссылок (-force, Э25): импорт ОБЯЗАТЕЛЕН, referencesCleaned=true, projectImported=true', async () => {
      p.lock([T]);
      p.setResult(opLog(COMMIT_DONE, 'Очистка объектов от некорректных ссылок выполнена', `Объект помещен в хранилище: ${T}`));
      const result = data(await call('commit', { ...ARGS, force: true }));
      assert.deepStrictEqual(p.events, ['repo:commit', 'import:cf']);
      assert.strictEqual(result.referencesCleaned, true);
      assert.strictEqual(result.projectImported, true);
    });

    test('помещение без правок: успех, committedObjects пуст, предупреждение «нечего помещать»', async () => {
      p.lock([T]);
      p.setResult(opLog(COMMIT_DONE, `Объект не был изменен: ${T}`));
      const result = data(await call('commit', ARGS));
      assert.deepStrictEqual(result.committedObjects, []);
      assert.ok((result.warnings as string[]).some((warning) => warning.includes('нечего помещать')));
    });

    test('exit≠0: isError «Ошибка при помещении изменений в хранилище: …», захват остаётся; прерывание', async () => {
      p.lock([T]);
      p.setResult('Объект содержит ссылки на удаленные объекты', 1);
      const failed = await call('commit', ARGS);
      assert.strictEqual(text(failed), 'Ошибка при помещении изменений в хранилище: Объект содержит ссылки на удаленные объекты');
      assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
      p.setResult('', 0, { interrupted: 'Отменено пользователем' });
      assert.strictEqual(text(await call('commit', ARGS)), 'Операция прервана пользователем');
    });
  });

  suite('освобождение', () => {
    test('вектор БЕЗ -force (не открыт); результат; учёт снят; пост-мутационный путь', async () => {
      p.lock([T]);
      p.setResult(opLog(UNLOCK_DONE, `Захват объекта отменен: ${T}`));
      const result = data(await call('unlock', { path: 'Справочники.Товары' }));
      assert.deepStrictEqual(operationTail(p.args()), [
        '/ConfigurationRepositoryUnLock', '-Objects',
        { kind: 'inputFile', name: 'objects.xml', content: p.service.buildObjectsSelectionForNode(p.refs.catalog, false).xml },
      ]);
      assert.deepStrictEqual(result, {
        path: 'Справочники.Товары', unlockedObjects: [T], lockedByOthers: [], notUnlocked: [], warnings: [],
      });
      assert.strictEqual(p.service.isLocked(p.cfTarget, T), false);
      assert.deepStrictEqual(p.lockHeldAt, { 'repo:unlock': true });
      assert.deepStrictEqual(p.suppressCalls, []);
      assert.deepStrictEqual(p.markChangedCalls, []);
      assert.ok(p.refreshes >= 1 && p.actionViewRefreshes >= 1);
      assert.deepStrictEqual(p.toasts, []);
    });

    test('незагруженные правки проекта: в ответе предупреждение про невозможность загрузки по освобождённым объектам', async () => {
      dirty();
      p.lock([T]);
      p.setResult(opLog(UNLOCK_DONE, `Захват объекта отменен: ${T}`));
      const result = data(await call('unlock', { path: 'Справочники.Товары' }));
      assert.ok((result.warnings as string[]).some((warning) => warning.includes('после отмены захвата загрузить их в базу по освобождённым объектам будет нельзя')));
    });

    test('частично: освобождено другое, запрошенное осталось — успех с notUnlocked', async () => {
      p.lock([T, 'Справочник.Другой']);
      p.setResult(opLog(UNLOCK_DONE, 'Захват объекта отменен: Справочник.Другой'));
      const result = data(await call('unlock', { path: 'Справочники.Товары' }));
      assert.deepStrictEqual(result.unlockedObjects, ['Справочник.Другой']);
      assert.deepStrictEqual(result.notUnlocked, [T]);
      assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
    });

    test('Э24: чужой захват, ничего не освобождено — isError «Захват не отменён: …; захвачено другим пользователем: X (User)», учёт остаётся', async () => {
      p.lock([T]);
      p.setResult(opLog(UNLOCK_DONE, `${FOREIGN}${T} (Иванов) `));
      const result = await call('unlock', { path: 'Справочники.Товары' });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(text(result), `Захват не отменён: ${T}; захвачено другим пользователем: ${T} (Иванов)`);
      assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
    });

    test('ничего не освобождено без чужого захвата — «Захват не отменён: <имена>» без хвоста', async () => {
      p.lock([T]);
      p.setResult(opLog(UNLOCK_DONE));
      const result = await call('unlock', { path: 'Справочники.Товары' });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(text(result), `Захват не отменён: ${T}`);
    });

    test('exit 1: причина платформы + подсказка про помещение; строки «отменен» всё равно применены к учёту', async () => {
      p.lock([T, 'Справочник.Склады']);
      p.setResult(opLog('Ошибка', 'Захват объекта отменен: Справочник.Склады'), 1);
      const result = await call('unlock', { path: 'Справочники.Товары' });
      assert.strictEqual(result.isError, true);
      assert.ok(text(result).startsWith('Ошибка при освобождении объектов хранилища:'), text(result));
      assert.ok(text(result).includes('Если объект изменён в базе, отменить захват без потери правок нельзя: поместите изменения (v8vscedit_repository_commit).'), text(result));
      assert.strictEqual(p.service.isLocked(p.cfTarget, 'Справочник.Склады'), false);
      assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
    });

    test('прерывание: «Операция прервана пользователем»', async () => {
      p.lock([T]);
      p.setResult('', 0, { interrupted: 'Отменено пользователем' });
      assert.strictEqual(text(await call('unlock', { path: 'Справочники.Товары' })), 'Операция прервана пользователем');
      assert.strictEqual(p.service.isLocked(p.cfTarget, T), true);
    });
  });
});

/** Подмена настройки `v8vscedit.repository.getRevisedOnLock` (Global), как в `repositoryLockCommand.test.ts`. */
function vscodeRevised(value: boolean): { apply(): Promise<void>; restore(): Promise<void> } {
  const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('v8vscedit.repository');
  return {
    apply: async () => { await config().update('getRevisedOnLock', value, vscode.ConfigurationTarget.Global); },
    restore: async () => { await config().update('getRevisedOnLock', undefined, vscode.ConfigurationTarget.Global); },
  };
}
