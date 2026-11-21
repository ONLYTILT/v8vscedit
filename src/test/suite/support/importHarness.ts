/**
 * Стенд сквозного импорта конфигураций: настоящие раннеры `runDecompileMainConfiguration`/
 * `runDecompileExtension` (в `createRepoProject` их подменяют заглушки), настоящий общий раннер импорта и
 * агентская операция; подменён только сам агент 1С (внешняя недоступная система) — через шов реестра
 * `ensureAgentService`, как в `mirrorSeedPrompt.test.ts`.
 *
 * Поведение «агента» на цель задаётся `behavior`; чтобы проверка шла по реальной семантике «нет хука =
 * согласие» (`FullDumpConsent`), сценарий отказа зовёт настоящий `confirmFullDumpOrThrow` с хуками,
 * которые операция передала сервису. Окна в unattended-тестах запрещены: `forbidWindows()` записывает
 * нарушение и роняет вызов.
 */
import * as extensionRunner from '../../../ui/commands/ext/ExtensionCommandRunner';
import * as vscode from 'vscode';
import type { AgentOperationHooks } from '../../../infra/agent/AgentOperationService';
import {
  disposeCachedAgentOperationServices,
  ensureAgentService,
  type CachedAgentService,
} from '../../../ui/commands/ext/agent/AgentServiceRegistry';
import { confirmFullDumpOrThrow } from '../../../infra/agent/sync/FullDumpConsent';
import type { SyncOperationContext } from '../../../infra/agent/sync/SyncContext';
import type { ServerDumpReason } from '../../../infra/agent/sync/SyncPlanner';
import { createRepoProject, type RepoProject } from './repositoryMcpFixtures';

/** Оригиналы раннеров импорта: фиксируются при загрузке модуля, до подмен `createRepoProject`. */
const REAL_RUNNERS = {
  runDecompileMainConfiguration: extensionRunner.runDecompileMainConfiguration,
  runDecompileExtension: extensionRunner.runDecompileExtension,
  runUpdateMainConfiguration: extensionRunner.runUpdateMainConfiguration,
  runUpdateExtension: extensionRunner.runUpdateExtension,
};

const WINDOW_NAMES = ['showErrorMessage', 'showWarningMessage', 'showInformationMessage', 'showQuickPick', 'showInputBox'] as const;

export interface ImportCall {
  readonly target: Record<string, unknown>;
  readonly hooks: AgentOperationHooks;
}

export interface StandaloneStub {
  configured: boolean;
  state: string;
  refreshError?: Error;
  startState: string;
  startError?: Error;
  readonly stops: number[];
  readonly starts: number[];
}

export interface ImportHarness {
  readonly p: RepoProject;
  /** Вызовы `importFromDatabase` агента по порядку. */
  readonly calls: ImportCall[];
  /** Сценарий агента на цель (ключ — `target.name`); по умолчанию успех без изменённых файлов. */
  readonly behavior: Map<string, (call: ImportCall) => Promise<unknown>>;
  /** Сценарий `loadChanged` агента (загрузка изменений в базу); по умолчанию — успех без обновления БД. */
  loadBehavior?: (call: ImportCall) => Promise<unknown>;
  /** Нарушения «окно в unattended» (пусто — ни одного окна и тоста). */
  readonly violations: string[];
  readonly standalone: StandaloneStub;
  forbidWindows(): void;
  /** Сценарий: агент спрашивает согласие на полную выгрузку (хук операции) и получает отказ unattended. */
  askFullDump(reason: ServerDumpReason, consent?: 'import' | 'load'): (call: ImportCall) => Promise<void>;
  dispose(): Promise<void>;
}

async function setOperationMode(value: string | undefined): Promise<void> {
  await vscode.workspace.getConfiguration('v8vscedit.configuration').update('operationMode', value, vscode.ConfigurationTarget.Global);
}

export async function createImportHarness(): Promise<ImportHarness> {
  const p = await createRepoProject();
  const runnerRef = extensionRunner as unknown as Record<string, unknown>;
  runnerRef.runDecompileMainConfiguration = REAL_RUNNERS.runDecompileMainConfiguration;
  runnerRef.runDecompileExtension = REAL_RUNNERS.runDecompileExtension;
  runnerRef.runUpdateMainConfiguration = REAL_RUNNERS.runUpdateMainConfiguration;
  runnerRef.runUpdateExtension = REAL_RUNNERS.runUpdateExtension;

  await disposeCachedAgentOperationServices();
  await setOperationMode('agent');

  const calls: ImportCall[] = [];
  const behavior = new Map<string, (call: ImportCall) => Promise<unknown>>();
  const violations: string[] = [];
  const standalone: StandaloneStub = {
    configured: false, state: 'stopped', startState: 'running', stops: [], starts: [],
  };
  (p.services as unknown as Record<string, unknown>).standaloneServerService = {
    refreshHealth: () => (standalone.refreshError
      ? Promise.reject(standalone.refreshError)
      : Promise.resolve({ configured: standalone.configured, state: standalone.state })),
    stop: () => { standalone.stops.push(Date.now()); return Promise.resolve(); },
    start: () => {
      standalone.starts.push(Date.now());
      return standalone.startError
        ? Promise.reject(standalone.startError)
        : Promise.resolve({ state: standalone.startState, message: 'сервер не поднялся', url: 'http://127.0.0.1:1' });
    },
  };

  const entry = {
    service: {
      importFromDatabase: async (target: Record<string, unknown>, hooks: AgentOperationHooks) => {
        const call: ImportCall = { target, hooks };
        calls.push(call);
        const result = await behavior.get(String(target.name))?.(call);
        // Сценарий, вернувший список файлов, — импорт с изменениями: хук гасит перезагрузку по этим файлам.
        const changed = Array.isArray(result) ? result.map(String) : undefined;
        if (changed !== undefined) {
          hooks.onProjectFilesWillChange?.(changed);
        }
        return { changedProjectFiles: changed ?? [] };
      },
      loadChanged: async (target: Record<string, unknown>, _mode: unknown, hooks: AgentOperationHooks) => {
        const call: ImportCall = { target, hooks };
        calls.push(call);
        return (await harness.loadBehavior?.(call)) ?? { databaseUpdated: false };
      },
      dispose: () => Promise.resolve(),
    },
    sessions: { disposeAll: () => Promise.resolve() },
  } as unknown as CachedAgentService;
  await ensureAgentService(p.root, () => Promise.resolve(entry));

  const w = vscode.window as unknown as Record<string, unknown>;
  const harness: ImportHarness = {
    p, calls, behavior, violations, standalone,
    forbidWindows() {
      for (const name of WINDOW_NAMES) {
        w[name] = (...args: unknown[]) => {
          violations.push(`${name}: ${String(args[0])}`);
          throw new Error(`окно в unattended-режиме: ${name}`);
        };
      }
    },
    askFullDump: (reason, consent = 'import') => async (call) => {
      const context = {
        hooks: call.hooks,
        target: call.target,
        extensionName: call.target.extensionName,
      } as unknown as SyncOperationContext;
      await confirmFullDumpOrThrow(context, reason, consent);
    },
    async dispose() {
      await disposeCachedAgentOperationServices();
      await setOperationMode(undefined);
      await p.dispose();
    },
  };
  return harness;
}
