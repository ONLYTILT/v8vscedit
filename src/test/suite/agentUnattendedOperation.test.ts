/**
 * Режим `unattended` агентских и пакетных операций (MCP: ни окон, ни тостов): подмена хуков согласия в ОДНОЙ
 * точке (`runInProgress` в `agentConfigurationOperation.ts`), исход импорта (`runDecompile*` + `onOutcome`),
 * исход загрузки (`runUpdate*` + `onFailure`/`onOutcome`), чистые решения `databaseLoadPlan`.
 *
 * Агент 1С подменяется швом реестра `ensureAgentService` (внешняя недоступная система). Чтобы проверка шла
 * по реальной семантике «нет хука = согласие», сценарий отказа зовёт НАСТОЯЩИЙ `confirmFullDumpOrThrow` с
 * хуками, которые операция передала сервису. Окна в unattended-тестах запрещены: любое `show*` записывает
 * нарушение и роняет вызов.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentMessage } from '../../domain/agent';
import { AgentCommandError } from '../../infra/agent';
import type { AgentFullDumpRequest, AgentOperationHooks } from '../../infra/agent/AgentOperationService';
import { confirmFullDumpOrThrow } from '../../infra/agent/sync/FullDumpConsent';
import { AgentSyncCancelledError, type SyncOperationContext } from '../../infra/agent/sync/SyncContext';
import { SERVER_DUMP_POLICY, type ServerDumpReason } from '../../infra/agent/sync/SyncPlanner';
import {
  disposeCachedAgentOperationServices,
  ensureAgentService,
  type CachedAgentService,
} from '../../ui/commands/ext/agent/AgentServiceRegistry';
import {
  runAgentOperation,
  type AgentOperationUiHooks,
  type RunAgentOptions,
} from '../../ui/commands/ext/agent/agentConfigurationOperation';
import { promptFullDump } from '../../ui/commands/ext/agent/fullDumpPrompt';
import { promptMirrorSeed } from '../../ui/commands/ext/agent/mirrorSeedPrompt';
import { promptOrphanRemoval } from '../../ui/commands/ext/agent/orphanFilesPrompt';
import {
  describeUnattendedFullDumpRefusal,
  describeUnattendedQuestion,
} from '../../ui/commands/ext/agent/unattendedAgentHooks';
import {
  runDecompileExtension,
  runDecompileMainConfiguration,
  runUpdateExtension,
  runUpdateMainConfiguration,
} from '../../ui/commands/ext/ExtensionCommandRunner';
import type { ConfigurationImportOutcome } from '../../ui/commands/ext/configurationOperationTypes';
import {
  describeUnattendedFullLoadRefusal,
  isSilentLoad,
} from '../../ui/commands/ext/databaseLoadPlan';
import { FakeLagRecorder } from './support/databaseLagFakes';
import { removeTreeSync } from './support/tempTree';

type Fn = (...args: never[]) => unknown;
const win = vscode.window as unknown as Record<string, Fn>;
const WINDOW_NAMES = ['showErrorMessage', 'showWarningMessage', 'showInformationMessage', 'showQuickPick', 'showInputBox'] as const;

interface Windows {
  readonly shown: string[];
  restore(): void;
}

/** `forbid` — любое окно роняет вызов (unattended); иначе окна записываются и закрываются без ответа. */
function stubWindows(forbid: boolean): Windows {
  const originals = new Map<string, Fn>();
  const shown: string[] = [];
  for (const name of WINDOW_NAMES) {
    originals.set(name, win[name]);
    win[name] = (...args: unknown[]) => {
      shown.push(`${name}: ${String(args[0])}`);
      if (forbid) {
        throw new Error(`окно в unattended-режиме: ${name}`);
      }
      return Promise.resolve(undefined);
    };
  }
  return {
    shown,
    restore: () => { for (const [name, fn] of originals) { win[name] = fn; } },
  };
}

async function setOperationMode(value: string | undefined): Promise<void> {
  await vscode.workspace.getConfiguration('v8vscedit.configuration').update('operationMode', value, vscode.ConfigurationTarget.Global);
}

function fullDumpRequest(): AgentFullDumpRequest {
  return {
    targetKind: 'cf', targetName: 'Основная', projectDir: path.join(os.tmpdir(), 'p'), operation: 'import',
    reason: 'full-dump', reasonText: 'причина', download: true,
  };
}

const QUESTIONS: [string, AgentMessage][] = [
  ['обычный', { type: 'question', message: 'Продолжить операцию?' }],
  ['секретный', { type: 'question', message: 'Введите пароль пользователя' }],
  ['логинный', { type: 'question', message: 'Введите логин пользователя' }],
];

interface AgentStand {
  readonly tmp: string;
  readonly folder: vscode.WorkspaceFolder;
  readonly channel: vscode.OutputChannel;
  readonly lines: string[];
  /** Сценарии «агента». */
  impl: {
    importFromDatabase: (target: Record<string, unknown>, hooks: AgentOperationHooks) => Promise<unknown>;
    loadChanged: (target: Record<string, unknown>, mode: unknown, hooks: AgentOperationHooks) => Promise<unknown>;
  };
  captured: { target: Record<string, unknown>; hooks: AgentOperationHooks }[];
  dispose(): Promise<void>;
}

async function openStand(mode: 'agent' | 'batch'): Promise<AgentStand> {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-unattended-')));
  const lines: string[] = [];
  const stand: AgentStand = {
    tmp,
    folder: { uri: vscode.Uri.file(tmp), name: 'ws', index: 0 },
    channel: { appendLine: (line: string) => { lines.push(line); }, show: () => undefined } as unknown as vscode.OutputChannel,
    lines,
    captured: [],
    impl: {
      importFromDatabase: () => Promise.resolve({ changedProjectFiles: [] }),
      loadChanged: () => Promise.resolve({ databaseUpdated: false }),
    },
    dispose: async () => {
      await disposeCachedAgentOperationServices();
      await setOperationMode(undefined);
      removeTreeSync(tmp);
    },
  };
  await disposeCachedAgentOperationServices();
  await setOperationMode(mode);
  if (mode === 'agent') {
    const entry = {
      service: {
        importFromDatabase: (target: Record<string, unknown>, hooks: AgentOperationHooks) => {
          stand.captured.push({ target, hooks });
          return stand.impl.importFromDatabase(target, hooks);
        },
        loadChanged: (target: Record<string, unknown>, loadMode: unknown, hooks: AgentOperationHooks) => {
          stand.captured.push({ target, hooks });
          return stand.impl.loadChanged(target, loadMode, hooks);
        },
        dispose: () => Promise.resolve(),
      },
      sessions: { disposeAll: () => Promise.resolve() },
    } as unknown as CachedAgentService;
    await ensureAgentService(tmp, () => Promise.resolve(entry));
  }
  return stand;
}

/** Контекст синхронизации с минимумом полей, которые читает `confirmFullDumpOrThrow`. */
function syncContext(target: Record<string, unknown>, hooks: AgentOperationHooks): SyncOperationContext {
  return { hooks, target, extensionName: target.extensionName } as unknown as SyncOperationContext;
}

function expectedRequest(
  target: { kind: 'cf' | 'cfe'; name: string; rootPath: string },
  operation: 'import' | 'load',
  reason: ServerDumpReason
): AgentFullDumpRequest {
  const policy = SERVER_DUMP_POLICY[reason];
  return {
    targetKind: target.kind, targetName: target.name, projectDir: target.rootPath, operation, reason,
    reasonText: policy.text, download: policy.download,
  };
}

suite('runInProgress: режим unattended (подмена хуков согласия в одной точке)', function () {
  this.timeout(60_000);
  let stand: AgentStand;
  let windows: Windows;

  setup(async () => {
    stand = await openStand('agent');
    windows = stubWindows(true);
  });
  teardown(async () => {
    windows.restore();
    await stand.dispose();
  });

  const base = (): RunAgentOptions => ({
    progressTitle: 'Импорт', progressStartMessage: 'старт', successMessage: 'Готово', errorTitle: 'Сбой',
    showSuccessMessage: true, workspaceFolder: stand.folder, outputChannel: stand.channel, rootPath: stand.tmp,
    interaction: 'unattended',
  });

  test('хуки: посева и сирот нет, confirmFullDump — отказ, даже если в опциях переданы prompt-хуки', async () => {
    let captured: AgentOperationUiHooks | undefined;
    await runAgentOperation({
      ...base(),
      confirmMirrorSeed: promptMirrorSeed, confirmFullDump: promptFullDump, confirmOrphanRemoval: promptOrphanRemoval,
    }, (_service, hooks) => { captured = hooks; return Promise.resolve(); });

    assert.ok(captured);
    assert.strictEqual(captured.confirmMirrorSeed, undefined);
    assert.strictEqual(captured.confirmOrphanRemoval, undefined);
    assert.strictEqual(typeof captured.confirmFullDump, 'function');
    assert.strictEqual(await captured.confirmFullDump?.(fullDumpRequest()), 'cancel');
    assert.deepStrictEqual(windows.shown, []);
  });

  for (const [title, message] of QUESTIONS) {
    test(`onQuestion (${title}) → 'cancel' без окон; журнал не врёт про «Ответ пользователя»`, async () => {
      let answer: string | undefined;
      await runAgentOperation(base(), async (_service, hooks) => { answer = await hooks.onQuestion(message); });

      assert.strictEqual(answer, 'cancel');
      assert.deepStrictEqual(windows.shown, []);
      assert.ok(stand.lines.some((line) => line.includes('без участия человека')), stand.lines.join(' | '));
      assert.ok(!stand.lines.some((line) => line.includes('Ответ пользователя')), stand.lines.join(' | '));
    });
  }

  test('отказ полной выгрузки через настоящий confirmFullDumpOrThrow → cancelled + requiresUserAction + текст; тостов нет', async () => {
    const target = { kind: 'cf' as const, name: 'Основная', rootPath: stand.tmp };
    const outcome = await runAgentOperation(base(), async (_service, hooks) => {
      await confirmFullDumpOrThrow(syncContext(target, hooks), 'mirror-empty', 'import');
    });

    assert.deepStrictEqual(outcome, {
      ok: false,
      cancelled: true,
      requiresUserAction: true,
      reason: describeUnattendedFullDumpRefusal(expectedRequest(target, 'import', 'mirror-empty')),
    });
    assert.deepStrictEqual(windows.shown, []);
    assert.ok(stand.lines.some((line) => line.includes('без участия человека')), stand.lines.join(' | '));
  });

  test('AgentSyncCancelledError (кнопка «Отмена» в уведомлении) → cancelled: true, без тостов', async () => {
    const outcome = await runAgentOperation(base(), () => Promise.reject(new AgentSyncCancelledError()));
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.cancelled, true);
    assert.deepStrictEqual(windows.shown, []);
  });

  test('вопрос агента, затем AgentCommandError: причина начинается с описания вопроса; showErrorMessage не задан и не вызван', async () => {
    const outcome = await runAgentOperation(base(), async (_service, hooks) => {
      await hooks.onQuestion({ type: 'question', message: 'Продолжить операцию?\nДетали' });
      throw new AgentCommandError('Ошибка агента: команда отклонена', 'config load');
    });

    assert.strictEqual(outcome.ok, false);
    assert.ok(outcome.reason.startsWith(describeUnattendedQuestion('Продолжить операцию?')), outcome.reason);
    assert.ok(outcome.reason.includes('Ошибка агента: команда отклонена'), outcome.reason);
    assert.strictEqual(outcome.requiresUserAction, true);
    assert.deepStrictEqual(windows.shown, []);
  });

  test('вопрос агента и успех: ok, interactionWarnings из одного элемента, тоста успеха нет даже при showSuccessMessage: true', async () => {
    const outcome = await runAgentOperation(base(), async (_service, hooks) => {
      await hooks.onQuestion({ type: 'question', message: 'Продолжить операцию?' });
      return 7;
    });

    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.value, 7);
    assert.deepStrictEqual(outcome.interactionWarnings, [describeUnattendedQuestion('Продолжить операцию?')]);
    assert.deepStrictEqual(windows.shown, []);
  });

  test('прочая ошибка без вопросов: причина — текст ошибки, requiresUserAction не выставлен', async () => {
    const outcome = await runAgentOperation(base(), () => Promise.reject(new Error('Платформа отказала')));
    assert.strictEqual(outcome.ok, false);
    assert.ok(outcome.reason.includes('Платформа отказала'), outcome.reason);
    assert.ok(!outcome.requiresUserAction);
    assert.deepStrictEqual(windows.shown, []);
  });

  test('успех без вопросов: interactionWarnings пуст', async () => {
    const outcome = await runAgentOperation(base(), () => Promise.resolve('ok'));
    assert.strictEqual(outcome.ok, true);
    assert.deepStrictEqual(outcome.interactionWarnings ?? [], []);
  });
});

for (const kind of ['cf', 'cfe'] as const) {
  suite(`runDecompile* [agent, ${kind}]: интерфейс исхода и режим interaction`, function () {
    this.timeout(60_000);
    let stand: AgentStand;
    let windows: Windows | undefined;
    const NAME = kind === 'cf' ? 'Основная' : 'Расш';
    const root = (): string => path.join(stand.tmp, 'src', ...(kind === 'cf' ? ['cf'] : ['cfe', NAME]));
    const run = (options?: { interaction: 'interactive' | 'unattended'; onOutcome?: (o: ConfigurationImportOutcome) => void }): Promise<boolean> =>
      (kind === 'cf'
        ? runDecompileMainConfiguration(NAME, root(), stand.folder, stand.channel, undefined, options)
        : runDecompileExtension(NAME, root(), stand.folder, stand.channel, undefined, options));

    setup(async () => { stand = await openStand('agent'); windows = undefined; });
    teardown(async () => { windows?.restore(); await stand.dispose(); });

    test('unattended + отказ полной выгрузки: onOutcome ровно раз с отказом, возврат false, окон нет', async () => {
      windows = stubWindows(true);
      const target = { kind, name: NAME, rootPath: root() };
      stand.impl.importFromDatabase = async (t, hooks) => {
        await confirmFullDumpOrThrow(syncContext(t, hooks), 'mirror-empty', 'import');
      };
      const outcomes: ConfigurationImportOutcome[] = [];

      const ok = await run({ interaction: 'unattended', onOutcome: (o) => { outcomes.push(o); } });

      assert.strictEqual(ok, false);
      assert.deepStrictEqual(outcomes, [{
        success: false,
        cancelled: true,
        requiresUserAction: true,
        reason: describeUnattendedFullDumpRefusal(expectedRequest(target, 'import', 'mirror-empty')),
        warnings: [],
      }]);
      assert.deepStrictEqual(windows.shown, []);
      assert.strictEqual(stand.captured[0].hooks.confirmMirrorSeed, undefined);
    });

    test('unattended + успех: onOutcome({ success: true, warnings: [] }), возврат true', async () => {
      windows = stubWindows(true);
      const outcomes: ConfigurationImportOutcome[] = [];
      const ok = await run({ interaction: 'unattended', onOutcome: (o) => { outcomes.push(o); } });
      assert.strictEqual(ok, true);
      assert.deepStrictEqual(outcomes, [{ success: true, warnings: [] }]);
      assert.deepStrictEqual(windows.shown, []);
    });

    test('interactive (явно): onOutcome вызван, хуки согласия — prompt-обёртки', async () => {
      windows = stubWindows(false);
      const outcomes: ConfigurationImportOutcome[] = [];
      assert.strictEqual(await run({ interaction: 'interactive', onOutcome: (o) => { outcomes.push(o); } }), true);
      assert.deepStrictEqual(outcomes, [{ success: true, warnings: [] }]);
      const hooks = stand.captured[0].hooks as unknown as Record<string, unknown>;
      assert.strictEqual(typeof hooks.confirmMirrorSeed, 'function');
      assert.strictEqual(typeof hooks.confirmFullDump, 'function');
      assert.strictEqual(typeof hooks.confirmOrphanRemoval, 'function');
    });

    test('без 6-го параметра: прежнее поведение (prompt-хуки есть), результат true', async () => {
      windows = stubWindows(false);
      assert.strictEqual(await run(), true);
      const hooks = stand.captured[0].hooks as unknown as Record<string, unknown>;
      assert.strictEqual(typeof hooks.confirmMirrorSeed, 'function');
    });

    test('characterization: заголовок прогресса и заголовок ошибки слитой агентской ветки не изменились', async () => {
      windows = stubWindows(false);
      stand.impl.importFromDatabase = () => Promise.reject(new Error('сбой импорта'));
      assert.strictEqual(await run(), false);

      const start = kind === 'cf'
        ? `[agent] Старт: Выгрузка основной конфигурации ${NAME} во внутренний XML`
        : `[agent] Старт: Выгрузка расширения ${NAME} во внутренний XML`;
      assert.ok(stand.lines.includes(start), stand.lines.join(' | '));
      const errorTitle = kind === 'cf'
        ? `Ошибка импорта основной конфигурации "${NAME}".`
        : `Ошибка импорта расширения "${NAME}".`;
      assert.ok(windows.shown.some((line) => line.startsWith(`showErrorMessage: ${errorTitle}\n`)), windows.shown.join(' | '));
    });

    test('characterization: сообщение о старте для cf/cfe отличается стартовым текстом', async () => {
      windows = stubWindows(false);
      stand.impl.importFromDatabase = () => Promise.resolve({ changedProjectFiles: [] });
      await run();
      // Прогресс-сообщение уходит в статус; в журнал попадает `[agent] Завершено: <заголовок>`.
      const finish = kind === 'cf'
        ? `[agent] Завершено: Выгрузка основной конфигурации ${NAME} во внутренний XML`
        : `[agent] Завершено: Выгрузка расширения ${NAME} во внутренний XML`;
      assert.ok(stand.lines.includes(finish), stand.lines.join(' | '));
    });
  });
}

for (const kind of ['cf', 'cfe'] as const) {
  for (const interaction of ['interactive', 'unattended'] as const) {
    suite(`runDecompile* [batch, ${kind}, ${interaction}]`, function () {
      this.timeout(120_000);
      let stand: AgentStand;
      let windows: Windows;
      const NAME = kind === 'cf' ? 'Основная' : 'Расш';
      const root = (): string => path.join(stand.tmp, 'src', ...(kind === 'cf' ? ['cf'] : ['cfe', NAME]));
      const run = (onOutcome: (o: ConfigurationImportOutcome) => void): Promise<boolean> => (kind === 'cf'
        ? runDecompileMainConfiguration(NAME, root(), stand.folder, stand.channel, undefined, { interaction, onOutcome })
        : runDecompileExtension(NAME, root(), stand.folder, stand.channel, undefined, { interaction, onOutcome }));

      setup(async () => {
        stand = await openStand('batch');
        windows = stubWindows(false);
        fs.mkdirSync(root(), { recursive: true });
      });
      teardown(async () => { windows.restore(); await stand.dispose(); });

      test('нет env.json → исключение пробрасывается (его ловит раннер импорта), onOutcome не вызван, окон нет', async () => {
        const outcomes: ConfigurationImportOutcome[] = [];
        await assert.rejects(() => run((o) => { outcomes.push(o); }));
        assert.deepStrictEqual(outcomes, []);
        assert.deepStrictEqual(windows.shown, []);
      });

      test('сбой внутреннего CLI (--path не существует): onOutcome({ success: false, reason }) один раз; тост ошибки — только в interactive', async () => {
        // 1cv8 не трогается: собственный CLI детерминированно падает на несуществующем --path до спавна Конфигуратора.
        fs.writeFileSync(path.join(stand.tmp, 'env.json'), JSON.stringify({
          default: { '--ibconnection': `/F${path.join(stand.tmp, 'base')}`, '--path': path.join(stand.tmp, 'нет', 'такого', '1cv8') },
        }), 'utf-8');
        const outcomes: ConfigurationImportOutcome[] = [];

        const ok = await run((o) => { outcomes.push(o); });

        assert.strictEqual(ok, false);
        assert.strictEqual(outcomes.length, 1);
        assert.strictEqual(outcomes[0].success, false);
        assert.deepStrictEqual(outcomes[0].warnings, []);
        assert.ok((outcomes[0].reason ?? '').length > 0);
        assert.ok((outcomes[0].reason ?? '').includes(kind === 'cf' ? 'импорте основной конфигурации' : 'импорте расширения'), outcomes[0].reason);
        const errorToasts = windows.shown.filter((line) => line.startsWith('showErrorMessage'));
        assert.strictEqual(errorToasts.length, interaction === 'interactive' ? 1 : 0, windows.shown.join(' | '));
        const successToasts = windows.shown.filter((line) => line.startsWith('showInformationMessage'));
        assert.deepStrictEqual(successToasts, []);
      });
    });
  }
}

suite('databaseLoadPlan: isSilentLoad и describeUnattendedFullLoadRefusal', () => {
  const silentValues = [undefined, false, true];
  const interactions = [undefined, 'interactive', 'unattended'] as const;
  for (const silent of silentValues) {
    for (const interaction of interactions) {
      test(`isSilentLoad({ silent: ${String(silent)}, interaction: ${String(interaction)} })`, () => {
        assert.strictEqual(isSilentLoad({ silent, interaction }), silent === true || interaction === 'unattended');
      });
    }
  }

  test('describeUnattendedFullLoadRefusal: с причиной', () => {
    assert.strictEqual(
      describeUnattendedFullLoadRefusal('конфигурации "Основная"', 'нет изменений в кэше'),
      'Быстрая загрузка изменений конфигурации "Основная" не выполнена: нет изменений в кэше. Полная загрузка ' +
        'перезаписывает конфигурацию базы и без подтверждения человека не запускается: выполните «Обновить в базе» ' +
        'из интерфейса VS Code.'
    );
  });

  test('describeUnattendedFullLoadRefusal: без причины — без «: <причина>»', () => {
    assert.strictEqual(
      describeUnattendedFullLoadRefusal('расширения "Расш"', ''),
      'Быстрая загрузка изменений расширения "Расш" не выполнена. Полная загрузка перезаписывает конфигурацию базы и ' +
        'без подтверждения человека не запускается: выполните «Обновить в базе» из интерфейса VS Code.'
    );
  });
});

for (const kind of ['cf', 'cfe'] as const) {
  suite(`Загрузка изменений через агента [${kind}]: unattended и interactive`, function () {
    this.timeout(60_000);
    let stand: AgentStand;
    let windows: Windows;
    let lag: FakeLagRecorder;
    const NAME = kind === 'cf' ? 'Основная' : 'Расш';
    const root = (): string => path.join(stand.tmp, 'src', ...(kind === 'cf' ? ['cf'] : ['cfe', NAME]));
    const lagTarget = () => (kind === 'cf'
      ? { kind: 'cf' as const, name: NAME, rootPath: root() }
      : { kind: 'cfe' as const, name: NAME, rootPath: root(), extensionName: NAME });
    const load = (options: Record<string, unknown>): Promise<boolean> => (kind === 'cf'
      ? runUpdateMainConfiguration(NAME, root(), stand.folder, stand.channel, true, undefined, { updateDatabase: false, lag, ...options })
      : runUpdateExtension(NAME, root(), stand.folder, stand.channel, true, undefined, { updateDatabase: false, lag, ...options }));

    setup(async () => { stand = await openStand('agent'); lag = new FakeLagRecorder(); windows = stubWindows(true); });
    teardown(async () => { windows.restore(); await stand.dispose(); });

    test('unattended: отказ полной выгрузки на загрузке → false, onFailure с текстом load-отказа, onOutcome не вызван, признак не ставится', async () => {
      stand.impl.loadChanged = async (target, _mode, hooks) => {
        await confirmFullDumpOrThrow(syncContext(target, hooks), 'mirror-empty', 'load');
      };
      const failures: string[] = [];
      let outcomes = 0;

      const ok = await load({
        interaction: 'unattended',
        onFailure: (reason: string) => { failures.push(reason); },
        onOutcome: () => { outcomes += 1; },
      });

      assert.strictEqual(ok, false);
      assert.deepStrictEqual(failures, [describeUnattendedFullDumpRefusal(expectedRequest({ kind, name: NAME, rootPath: root() }, 'load', 'mirror-empty'))]);
      assert.strictEqual(outcomes, 0);
      assert.deepStrictEqual(lag.calls, []);
      assert.deepStrictEqual(windows.shown, []);
    });

    test('unattended: прочий отказ → onFailure(reason), без окон', async () => {
      stand.impl.loadChanged = () => Promise.reject(new Error('Платформа отказала'));
      const failures: string[] = [];
      const ok = await load({ interaction: 'unattended', onFailure: (reason: string) => { failures.push(reason); } });
      assert.strictEqual(ok, false);
      assert.strictEqual(failures.length, 1);
      assert.ok(failures[0].includes('Платформа отказала'), failures[0]);
      assert.deepStrictEqual(windows.shown, []);
    });

    test('unattended: успех с вопросом агента → предупреждение в onOutcome.warnings вместе с предупреждениями результата', async () => {
      stand.impl.loadChanged = async (_target, _mode, hooks) => {
        await hooks.onQuestion?.({ type: 'question', message: 'Продолжить?' });
        return { databaseUpdated: false, warnings: ['E11'] };
      };
      const outcomes: { databaseUpdated: boolean; warnings: readonly string[] }[] = [];

      const ok = await load({ interaction: 'unattended', onOutcome: (o: { databaseUpdated: boolean; warnings: readonly string[] }) => { outcomes.push(o); } });

      assert.strictEqual(ok, true);
      assert.strictEqual(outcomes.length, 1);
      assert.ok(outcomes[0].warnings.includes('E11'), outcomes[0].warnings.join(' | '));
      assert.ok(outcomes[0].warnings.includes(describeUnattendedQuestion('Продолжить?')), outcomes[0].warnings.join(' | '));
      assert.strictEqual(outcomes[0].warnings.length, 2);
      assert.deepStrictEqual(windows.shown, []);
      assert.strictEqual(lag.isBehind(lagTarget()), false, 'загрузка не началась — признак не ставился');
    });

    test('interactive (регресс): confirmFullDump — обёртка promptFullDump (тот же диалог и ответ)', async () => {
      windows.restore();
      windows = stubWindows(false);
      const dialogs: unknown[][] = [];
      win.showWarningMessage = (...args: unknown[]) => { dialogs.push(args); return Promise.resolve(undefined); };

      await load({ interaction: 'interactive' });
      const wrapped = stand.captured[0].hooks.confirmFullDump;
      assert.strictEqual(typeof wrapped, 'function');
      const request = fullDumpRequest();
      const viaHook = await wrapped?.(request);
      const direct = await promptFullDump(request);
      assert.deepStrictEqual(viaHook, direct);
      assert.strictEqual(dialogs.length, 2);
      assert.strictEqual(dialogs[0][0], dialogs[1][0]);
    });
  });
}
