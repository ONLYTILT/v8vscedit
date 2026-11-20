/**
 * Стенды для проверки операций с расширениями и CF/CFE-файлами через агента (plan-remote-extensions §7).
 * Подменяется ТОЛЬКО агент 1С (`AgentConfigEmulator` + `AgentExtensionsEmulator`); файлы — настоящие:
 * локальное хранилище каталога агента или SFTP на in-process ssh2.Server.
 *
 *  - {@link createExtensionsStand} — уровень функций `infra/agent/extensions/*` (исполнитель без сессии);
 *  - {@link createServiceStand} — уровень `AgentOperationService` (сессия, транспорт, `connect-ib`/`disconnect-ib`):
 *    `local` — фабрика транспорта поверх эмулятора + локальное хранилище; `remote` — настоящий ssh2 + SFTP.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAgentMessageText, type AgentConnectPolicyOptions } from '../../../domain/agent';
import {
  AgentCommandError,
  AgentConnectionLostError,
  AgentOperationService,
  DesignerAgentSessionManager,
  ProcessDesignerAgentTransportFactory,
  agentCommandVerb,
  type AgentCommandHooks,
  type AgentCommandResult,
  type DesignerAgentConnectionOptions,
  type DesignerAgentTransport,
  type ResettableDesignerAgentTransportFactory,
} from '../../../infra/agent';
import type { AgentCommandExecutor } from '../../../infra/agent/AgentInfoBaseSession';
import type { AgentOperationHooks } from '../../../infra/agent/AgentOperationService';
import { buildAgentProjectId } from '../../../infra/agent/AgentWorkspaceService';
import type { AgentCfFileContext } from '../../../infra/agent/extensions/AgentCfFileExchange';
import type { AgentFileStore } from '../../../infra/agent/files/AgentFileStore';
import { AgentConfigEmulator } from './agentConfigEmulator';
import { EmulatedAgentFailure, type CrashMode } from './agentExtensionsEmulator';
import { AgentSshTestServer } from './agentSshTestServer';
import { createHarness, type HarnessKind, type SyncHarness } from './agentSyncHarness';
import { AGENT_USER, agentBaseDirOf, userRootOf, writeAgentIndex } from './agentWorkspaceFixtures';
import { removeTreeSync } from './tempTree';

/** Эмулятор бросает тестовую ошибку; настоящий транспорт собирает `AgentCommandError` из ВСЕХ сообщений команды. */
export function toAgentCommandError(error: unknown, command: string): unknown {
  if (error instanceof EmulatedAgentFailure) {
    return new AgentCommandError(
      getAgentMessageText(error.finalMessage),
      command,
      error.finalMessage,
      [...error.precedingMessages, error.finalMessage]
    );
  }
  return error;
}

function crashAsConnectionLoss(mode: CrashMode, raw: string, deadlineMs: number | undefined): Promise<never> {
  const verb = agentCommandVerb(raw);
  if (mode === 'drop') {
    return Promise.reject(new AgentConnectionLostError(verb, 'closed'));
  }
  // Зависание без срока ждёт вечно (настоящий транспорт без `deadlineMs` ведёт себя так же).
  return deadlineMs === undefined
    ? new Promise<never>(() => undefined)
    : Promise.reject(new AgentConnectionLostError(verb, 'no-response'));
}

/** Исполнитель команд внутри операции: журнал строк, срок команды, обрыв/зависание как `AgentConnectionLostError`. */
export class EmulatorExecutor implements AgentCommandExecutor {
  /** Команды, отправленные операцией, и маркер `<reconnect>` на каждый `reconnectInfoBase`. */
  readonly log: string[] = [];
  readonly deadlines: (number | undefined)[] = [];
  reconnectError: Error | undefined;
  private currentDeadline: number | undefined;

  constructor(private readonly emulator: AgentConfigEmulator) {
    emulator.extensions.crashHandler = (mode, raw) => crashAsConnectionLoss(mode, raw, this.currentDeadline);
  }

  get reconnects(): number {
    return this.log.filter((line) => line === RECONNECT_MARKER).length;
  }

  async execute(command: string, options?: { readonly deadlineMs?: number }): Promise<AgentCommandResult> {
    this.log.push(command);
    this.deadlines.push(options?.deadlineMs);
    this.currentDeadline = options?.deadlineMs;
    try {
      const result = await this.emulator.execute(command);
      return { messages: result.messages };
    } catch (error) {
      throw toAgentCommandError(error, command);
    }
  }

  async reconnectInfoBase(): Promise<void> {
    this.log.push(RECONNECT_MARKER);
    await this.emulator.execute('common disconnect-ib');
    if (this.reconnectError) {
      throw this.reconnectError;
    }
    await this.emulator.execute('common connect-ib');
  }
}

export const RECONNECT_MARKER = '<reconnect>';

export interface ExtensionsStand {
  readonly kind: HarnessKind;
  readonly harness: SyncHarness;
  readonly emulator: AgentConfigEmulator;
  readonly exec: EmulatorExecutor;
  readonly store: AgentFileStore;
  readonly projectId: string;
  /** Локальный рабочий каталог теста (целевые файлы выгрузки, входные файлы загрузки). */
  readonly workDir: string;
  /** Токен отмены, передаваемый в хуки операции. */
  readonly cancellation: { isCancellationRequested: boolean };
  readonly messages: string[];
  readonly hooks: AgentOperationHooks;
  ctx(overrides?: Partial<AgentCfFileContext>): AgentCfFileContext;
  /** Файл в рабочем каталоге: возвращает абсолютный путь. */
  writeWork(name: string, content: string | Buffer): string;
  workFiles(): string[];
  /** Содержимое серверного каталога обмена `exchange` (то, что осталось после операции). */
  serverExchange(): string[];
  dispose(): Promise<void>;
}

export interface ExtensionsStandOptions {
  readonly wrapStore?: (store: AgentFileStore) => AgentFileStore;
}

export async function createExtensionsStand(kind: HarnessKind, options: ExtensionsStandOptions = {}): Promise<ExtensionsStand> {
  const harness = await createHarness(kind, { wrapStore: options.wrapStore });
  const exec = new EmulatorExecutor(harness.emulator);
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-ext-work-')));
  const cancellation = { isCancellationRequested: false };
  const messages: string[] = [];
  const hooks: AgentOperationHooks = { onMessage: (message) => { messages.push(message); }, cancellation };
  const projectId = buildAgentProjectId(harness.projectRoot);
  return {
    kind,
    harness,
    emulator: harness.emulator,
    exec,
    store: harness.store,
    projectId,
    workDir,
    cancellation,
    messages,
    hooks,
    ctx: (overrides = {}) => ({ exec, store: harness.store, projectId, hooks, now: harness.clock.now, ...overrides }),
    writeWork: (name, content) => {
      const target = path.join(workDir, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      return target;
    },
    workFiles: () => fs.readdirSync(workDir).sort(),
    serverExchange: () => harness.serverExchangeLeftovers(),
    dispose: async () => {
      await harness.dispose();
      removeTreeSync(workDir);
    },
  };
}

// ── Уровень сервиса ────────────────────────────────────────────────────────

export type ServiceLocation = 'local' | 'remote';

class EmulatorTransport implements DesignerAgentTransport {
  closed = false;

  constructor(private readonly factory: EmulatorTransportFactory) {}

  async execute(command: string, hooks?: AgentCommandHooks, options?: { readonly deadlineMs?: number }): Promise<AgentCommandResult> {
    if (this.closed) {
      throw new AgentConnectionLostError(agentCommandVerb(command), 'closed');
    }
    this.factory.log.push(command);
    this.factory.deadline = options?.deadlineMs;
    try {
      const result = await this.factory.emulator.execute(command);
      for (const message of result.messages) {
        hooks?.onMessage?.(message);
      }
      return { messages: result.messages };
    } catch (error) {
      if (error instanceof AgentConnectionLostError) {
        this.closed = true;
      }
      throw toAgentCommandError(error, command);
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

/** Фабрика транспорта поверх эмулятора для `location = local` (журнал ВСЕХ строк команд, как у `ScriptedFactory`). */
export class EmulatorTransportFactory implements ResettableDesignerAgentTransportFactory {
  readonly log: string[] = [];
  resetCount = 0;
  createCount = 0;
  deadline: number | undefined;
  private current: EmulatorTransport | undefined;

  constructor(readonly emulator: AgentConfigEmulator) {
    emulator.extensions.crashHandler = (mode, raw) => {
      if (this.current) {
        this.current.closed = mode === 'drop';
      }
      return crashAsConnectionLoss(mode, raw, this.deadline);
    };
  }

  create(): Promise<DesignerAgentTransport> {
    if (!this.current || this.current.closed) {
      this.current = new EmulatorTransport(this);
      this.createCount += 1;
    }
    return Promise.resolve(this.current);
  }

  reset(): Promise<void> {
    this.resetCount += 1;
    this.current = undefined;
    return Promise.resolve();
  }
}

export interface ServiceStand {
  readonly location: ServiceLocation;
  readonly service: AgentOperationService;
  readonly emulator: AgentConfigEmulator;
  readonly projectRoot: string;
  readonly cfRoot: string;
  readonly userRoot: string;
  readonly workDir: string;
  /** Строки команд агента в порядке прихода (без `options set`), по всем соединениям. */
  commandLog(): string[];
  writeWork(name: string, content: string | Buffer): string;
  serverExchange(): string[];
  dispose(): Promise<void>;
}

const POLICY: AgentConnectPolicyOptions = { startupTimeoutMs: 5_000, authWarmupMs: 90_000, retryDelayMs: 10 };

export async function createServiceStand(location: ServiceLocation): Promise<ServiceStand> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `v8-ext-svc-${location}-`)));
  const projectRoot = path.join(base, 'project');
  const cfRoot = path.join(projectRoot, 'src', 'cf');
  const workDir = path.join(base, 'work');
  fs.mkdirSync(cfRoot, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  const writeWork = (name: string, content: string | Buffer): string => {
    const target = path.join(workDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };

  if (location === 'local') {
    writeAgentIndex(projectRoot);
    const userRoot = userRootOf(projectRoot);
    fs.mkdirSync(userRoot, { recursive: true });
    const emulator = new AgentConfigEmulator(userRoot);
    const factory = new EmulatorTransportFactory(emulator);
    const service = new AgentOperationService(projectRoot, factory, {}, {
      userName: AGENT_USER,
      agentBaseDir: agentBaseDirOf(projectRoot),
    });
    return {
      location, service, emulator, projectRoot, cfRoot, userRoot, workDir, writeWork,
      commandLog: () => [...factory.log],
      serverExchange: () => listDir(path.join(userRoot, 'exchange')),
      dispose: async () => { await service.dispose(); removeTreeSync(base); },
    };
  }

  const userRoot = path.join(base, 'user-root');
  fs.mkdirSync(userRoot, { recursive: true });
  const emulator = new AgentConfigEmulator(userRoot);
  const server = await AgentSshTestServer.start({ sftpRoot: userRoot });
  server.setShellResponder(async (line) => {
    const result = await emulator.execute(line);
    return result.messages as unknown as readonly Record<string, unknown>[];
  });
  emulator.extensions.onDrop = () => server.dropClients();
  const connection: DesignerAgentConnectionOptions = {
    host: '127.0.0.1', port: server.port, user: 'admin', password: 'secret', connectTimeoutSeconds: 5, policy: POLICY,
  };
  const sessions = new DesignerAgentSessionManager(new ProcessDesignerAgentTransportFactory({ ...connection, shutdownOnDispose: false }));
  const service = new AgentOperationService(projectRoot, sessions, {}, { userName: 'admin', sftp: connection });
  return {
    location, service, emulator, projectRoot, cfRoot, userRoot, workDir, writeWork,
    commandLog: () => server.shellLog.flat().filter((line) => !line.startsWith('options set')),
    serverExchange: () => listDir(path.join(userRoot, 'exchange')),
    dispose: async () => {
      await service.dispose();
      await sessions.disposeAll();
      await server.close();
      removeTreeSync(base);
    },
  };
}

function listDir(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}
