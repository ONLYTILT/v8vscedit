// Перенесено из ExtensionCommandRunner.ts (Э2) без изменения поведения; публичный API реэкспортируется оттуда.
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import {
  AgentOperationService,
  DesignerAgentProcess,
  DesignerAgentSessionManager,
  ProcessDesignerAgentTransportFactory,
  buildDesignerAgentModeArgs,
  waitForTcpPort,
  type DesignerAgentInfoBaseConnection,
  type DesignerAgentConnectionOptions,
} from '../../../../infra/agent';
import { getOrCreate } from '../../../../infra/process';
import { nonEmptyString, resolveConnectionFromSettings, resolveSettingsPath } from '../connectionSettings';
import { resetConfigurationOperationStatus } from '../configurationOperationStatus';
import { readAgentCommandSettings, toDesignerAgentConnection, type AgentCommandSettings } from './agentSettings';

export interface CachedAgentService {
  readonly service: AgentOperationService;
  readonly sessions: DesignerAgentSessionManager;
  readonly process?: DesignerAgentProcess;
}

export interface InteractiveDesignerAgentService {
  readonly service: AgentOperationService;
  readonly forceDisconnect: boolean;
}

// Кэшируем именно промис сервиса (а не готовый сервис), чтобы параллельные
// запросы с одним ключом не запускали конфигуратор/подключение дважды (TOCTOU).
const agentServices = new Map<string, Promise<CachedAgentService>>();

/**
 * Единая точка создания/переиспользования кэшированного сервиса агента.
 * getOrCreate кладёт промис в map до await (TOCTOU-защита), а при ошибке старта
 * удаляет ключ, чтобы неудачная попытка не «отравляла» кэш навсегда.
 */
export function ensureAgentService(
  workspaceRoot: string,
  factory: () => Promise<CachedAgentService>
): Promise<CachedAgentService> {
  const key = path.resolve(workspaceRoot).toLowerCase();
  const entry = getOrCreate(agentServices, key, factory);
  // Помечаем промис его значением для синхронного геттера getCachedAgentOperationService.
  void entry.then((value) => resolvedServices.set(entry, value.service), () => undefined);
  return entry;
}

export function getAgentServiceCacheKey(workspaceRoot: string): string {
  return path.resolve(workspaceRoot).toLowerCase();
}

export function getCachedAgentOperationService(workspaceFolder: vscode.WorkspaceFolder): AgentOperationService | undefined {
  const key = getAgentServiceCacheKey(workspaceFolder.uri.fsPath);
  const cached = agentServices.get(key);
  if (!cached) {
    return undefined;
  }
  // Синхронный геттер отдаёт сервис, только если промис старта уже успешно
  // разрешён (значение попало в resolvedServices при создании через ensureAgentService).
  return resolvedServices.get(cached);
}

// Слабое сопоставление «промис старта → готовый сервис» для синхронного геттера:
// как только промис разрешается успешно, кладём сюда его значение.
const resolvedServices = new WeakMap<Promise<CachedAgentService>, AgentOperationService>();

export async function disposeCachedAgentOperationServices(): Promise<void> {
  // Статус-бар создаётся лениво при begin/update/end и не попадает в context.subscriptions,
  // поэтому освобождаем его здесь — на общем пути остановки расширения.
  resetConfigurationOperationStatus();

  const entries = [...agentServices.values()];
  agentServices.clear();
  await Promise.all(entries.map(async (entryPromise) => {
    // Зафейленный промис старта не должен ронять остановку расширения.
    const entry = await entryPromise.catch(() => undefined);
    if (!entry) {
      return;
    }
    try {
      await entry.sessions.disposeAll();
    } finally {
      await entry.process?.stop();
    }
  }));
}

export async function getAgentOperationServiceForInteractiveDesigner(
  workspaceFolder: vscode.WorkspaceFolder,
  outputChannel: vscode.OutputChannel
): Promise<InteractiveDesignerAgentService | undefined> {
  const cached = getCachedAgentOperationService(workspaceFolder);
  if (cached) {
    return { service: cached, forceDisconnect: false };
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;
  try {
    // Сигнальным исключением помечаем случай «агент не найден» — тогда ключ
    // не должен осесть в кэше отравленным, и getOrCreate его удалит.
    const entry = await ensureAgentService(workspaceRoot, async () => {
      const settingsPath = resolveSettingsPath(workspaceRoot, workspaceRoot);
      const connection = await resolveConnectionFromSettings(settingsPath);
      const agentSettings = readAgentCommandSettings(connection);
      const portOpened = await waitForTcpPort({
        host: agentSettings.host,
        port: agentSettings.port,
        timeoutMs: 500,
      });
      if (!portOpened) {
        throw new AgentPortNotOpenError();
      }
      outputChannel.appendLine(
        `[agent] Найден запущенный агент конфигуратора: ${agentSettings.host}:${String(agentSettings.port)}.`
      );
      return createAgentOperationServiceEntry(workspaceRoot, agentSettings);
    });
    return { service: entry.service, forceDisconnect: true };
  } catch (error) {
    if (error instanceof AgentPortNotOpenError) {
      return undefined;
    }
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[agent][warn] Не удалось проверить запущенный агент конфигуратора: ${message}`);
    return undefined;
  }
}

/** Внутренний сигнал: агент не слушает порт — не ошибка старта, а «нет агента». */
class AgentPortNotOpenError extends Error {
  constructor() {
    super('агент конфигуратора не обнаружен на порту');
    this.name = 'AgentPortNotOpenError';
  }
}

export function logAgentDiagnostics(workspaceFolder: vscode.WorkspaceFolder, outputChannel: vscode.OutputChannel): void {
  const workspaceRoot = workspaceFolder.uri.fsPath;
  const agentBaseDir = path.join(workspaceRoot, '.v8vscedit', 'agent');
  outputChannel.appendLine(`[agent][diag] Каталог агента: ${agentBaseDir}`);
  // Сам конфигуратор пишет дамп в `~/.1cv8/1C/1cv8/dumps` либо в каталог временных файлов платформы.
  // Здесь сообщаем только то, что мы заведомо знаем — служебный каталог расширения.
}

export async function getAgentOperationService(
  workspaceFolder: vscode.WorkspaceFolder,
  rootPath: string,
  outputChannel: vscode.OutputChannel
): Promise<AgentOperationService> {
  const workspaceRoot = workspaceFolder.uri.fsPath;
  // ensureAgentService закрывает TOCTOU: параллельные операции не запустят
  // конфигуратор дважды, а неудачный старт удалит ключ (getOrCreate).
  const entry = await ensureAgentService(
    workspaceRoot,
    () => startAgentOperationService(workspaceRoot, rootPath, outputChannel)
  );
  return entry.service;
}

export async function startAgentOperationService(
  workspaceRoot: string,
  rootPath: string,
  outputChannel: vscode.OutputChannel
): Promise<CachedAgentService> {
  const settingsPath = resolveSettingsPath(workspaceRoot, rootPath);
  const connection = await resolveConnectionFromSettings(settingsPath);
  const agentSettings = readAgentCommandSettings(connection);
  let agentProcess: DesignerAgentProcess | undefined;
  if (agentSettings.autoStart) {
    // Отдельная неизменяемая ссылка: замыкание isAborted видит процесс без проверки на undefined.
    const startedProcess = new DesignerAgentProcess();
    agentProcess = startedProcess;
    const agentBaseDir = path.join(workspaceRoot, '.v8vscedit', 'agent');
    fs.mkdirSync(agentBaseDir, { recursive: true });
    const args = buildAgentStartLogArgs(toDesignerAgentConnection(connection), agentSettings, agentBaseDir);
    outputChannel.appendLine(`[agent] Запуск конфигуратора: ${args.join(' ')}`);
    agentProcess.start({
      connection: toDesignerAgentConnection(connection),
      visible: agentSettings.visible,
      agentPort: agentSettings.port,
      agentListenAddress: agentSettings.listenAddress,
      agentBaseDir,
      agentModeArgs: agentSettings.agentModeArgs,
      // 1С создаёт 1cv8u.pfl в рабочем каталоге процесса, поэтому держим его в служебной папке агента.
      cwd: agentBaseDir,
      onStdout: (text) => appendAgentProcessOutput(outputChannel, 'stdout', text),
      onStderr: (text) => appendAgentProcessOutput(outputChannel, 'stderr', text),
      onExit: (code, signal) => {
        outputChannel.appendLine(`[agent][process] Конфигуратор в режиме агента завершился: код=${String(code ?? '-')}, сигнал=${signal ?? '-'}`);
      },
    });
    outputChannel.appendLine('[agent] Конфигуратор запущен в режиме агента.');
    outputChannel.appendLine(`[agent] Ожидание SSH-порта ${agentSettings.host}:${String(agentSettings.port)} до ${String(agentSettings.startupTimeoutMs)} мс.`);
    const portOpened = await waitForTcpPort({
      host: agentSettings.host,
      port: agentSettings.port,
      timeoutMs: agentSettings.startupTimeoutMs,
      isAborted: () => startedProcess.hasExited(),
    });
    if (!portOpened) {
      throw new Error(
        `Конфигуратор в режиме агента не открыл SSH-порт ${agentSettings.host}:${String(agentSettings.port)}. ` +
        `Состояние процесса: ${startedProcess.getExitDescription()}. Подробности выше в журнале 1С Редактора.`
      );
    }
    outputChannel.appendLine(`[agent] SSH-порт ${agentSettings.host}:${String(agentSettings.port)} открыт.`);
  }

  return createAgentOperationServiceEntry(workspaceRoot, agentSettings, agentProcess);
}

export function createAgentOperationServiceEntry(
  workspaceRoot: string,
  agentSettings: AgentCommandSettings,
  agentProcess?: DesignerAgentProcess
): CachedAgentService {
  const transportOptions: DesignerAgentConnectionOptions = {
    host: agentSettings.host,
    port: agentSettings.port,
    user: agentSettings.user,
    password: agentSettings.password,
    privateKeyPath: nonEmptyString(agentSettings.privateKeyPath),
    policy: {
      startupTimeoutMs: agentSettings.startupTimeoutMs,
      authWarmupMs: agentSettings.authWarmupMs,
      retryDelayMs: 1000,
    },
    agentStartedAt: agentProcess?.getStartedAt(),
  };
  const sessions = new DesignerAgentSessionManager(
    new ProcessDesignerAgentTransportFactory(transportOptions),
    { notifyProgressInterval: agentSettings.progressInterval }
  );
  return {
    service: new AgentOperationService(workspaceRoot, sessions),
    sessions,
    process: agentProcess,
  };
}

export function buildAgentStartLogArgs(
  connection: DesignerAgentInfoBaseConnection,
  settings: AgentCommandSettings,
  agentBaseDir: string
): string[] {
  const args = ['1cv8', 'DESIGNER'];
  if (connection.infoBaseServer && connection.infoBaseRef) {
    args.push('/S', `${connection.infoBaseServer}/${connection.infoBaseRef}`);
  } else {
    args.push('/F', connection.infoBasePath);
  }
  args.push('/AgentMode', ...buildDesignerAgentModeArgs({
    connection,
    agentPort: settings.port,
    agentListenAddress: settings.listenAddress,
    agentBaseDir,
    agentModeArgs: settings.agentModeArgs,
  }));
  if (settings.visible) {
    args.push('/Visible');
  }
  return args;
}

export function appendAgentProcessOutput(outputChannel: vscode.OutputChannel, stream: 'stdout' | 'stderr', text: string): void {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    outputChannel.appendLine(`[agent][process][${stream}] ${line}`);
  }
}
