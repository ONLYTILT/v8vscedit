import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { ProjectSecretStorage } from '../../../infra/environment/ProjectSecretStorage';
import { resolveV8ExecutablePath } from '../../../infra/process';
import type { DesignerBatchExecutor } from '../../../infra/process/designer/DesignerBatchExecutor';
import { LocalDesignerBatchExecutor } from '../../../infra/process/designer/LocalDesignerBatchExecutor';
import type { HostAuthentication } from '../../../infra/process/remote/PowerShellHostProtocol';
import {
  PowerShellHostError,
  PowerShellRemoteHost,
  type PowerShellHostConnection,
  type PowerShellRemoteHostOptions,
} from '../../../infra/process/remote/PowerShellRemoteHost';
import { RemoteDesignerBatchExecutor, type RemoteDesignerHost } from '../../../infra/process/remote/RemoteDesignerBatchExecutor';
import { getAgentExecutionMode, readAgentLocation } from './agent/agentSettings';
import { nonEmptyString } from './connectionSettings';

/**
 * Реестр исполнителей пакетного Конфигуратора: локальный (1cv8 на этой машине) или удалённый
 * (1cv8 на сервере через хост PowerShell) — по `v8vscedit.agent.location`.
 *
 * Хост PowerShell дорогой (процесс + PSSession по WinRM), поэтому он один на проект и живёт между
 * операциями; исполнитель — свой на каждую операцию (его staging принадлежит операции). Хост
 * пересоздаётся при смене любого параметра соединения, включая пароль: иначе после смены учётки
 * или пароля операции молча шли бы старой сессией.
 */

export interface RemoteDesignerSettings {
  readonly computerName: string;
  readonly authentication: HostAuthentication;
  readonly user: string;
  readonly useSsl: boolean;
  readonly port: number;
  readonly v8Path: string;
  readonly ibConnection: string;
}

export interface DesignerExecutorLease {
  readonly kind: 'local' | 'remote';
  /** Свой на каждый acquire; `dispose()` убирает его staging и хост НЕ закрывает. */
  readonly executor: DesignerBatchExecutor;
  /** local — локальный путь к 1cv8; remote — путь на СЕРВЕРЕ, проверенный там же. */
  readonly v8Path: string;
  /** Непустой `v8vscedit.remote.ibConnection` (только remote): с сервера кластер может адресоваться иначе. */
  readonly ibConnectionOverride?: string;
}

export type RegistryHost = RemoteDesignerHost & {
  ping(): Promise<{ pid: number }>;
  resolveV8(target: { v8Path?: string; v8Version?: string }): Promise<string | undefined>;
  dispose(): Promise<void>;
};

export interface DesignerExecutorDeps {
  /** Шов под тест; по умолчанию — настоящий `PowerShellRemoteHost`. */
  readonly createHost?: (options: PowerShellRemoteHostOptions) => RegistryHost;
  /** По умолчанию — поле ввода пароля VS Code. */
  readonly promptRemotePassword?: () => Promise<string | undefined>;
  /** Шов настоящего хоста (запуск процесса) при умолчательной фабрике — тест без сети и WinRM. */
  readonly hostOptions?: Pick<PowerShellRemoteHostOptions, 'spawn' | 'powershellPath'>;
}

export interface RemoteHostInput {
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly outputChannel: vscode.OutputChannel;
  readonly secrets: ProjectSecretStorage;
}

export interface DesignerExecutorInput extends RemoteHostInput {
  /** Путь к 1cv8 из env.json (может быть пустым — тогда ищется стандартная установка); только local. */
  readonly localV8Path: string;
  /** Версия платформы из env.json: по ней путь к 1cv8 на сервере выводится, если `remote.v8Path` пуст. */
  readonly v8Version?: string;
}

const AUTHENTICATIONS: readonly HostAuthentication[] = ['Default', 'Negotiate', 'Kerberos'];
const MAX_PORT = 65535;

interface CachedHost {
  readonly key: string;
  readonly host: RegistryHost;
}

const hosts = new Map<string, CachedHost>();

export function readRemoteDesignerSettings(): RemoteDesignerSettings {
  const config = vscode.workspace.getConfiguration('v8vscedit.remote');
  const agentHost = nonEmptyString(vscode.workspace.getConfiguration('v8vscedit.agent').get<string>('host', 'localhost')) ?? 'localhost';
  const authentication = config.get<unknown>('authentication', 'Default');
  return {
    computerName: readString(config.get<unknown>('computerName', '')) || agentHost,
    authentication: AUTHENTICATIONS.find((value) => value === authentication) ?? 'Default',
    user: readString(config.get<unknown>('user', '')),
    useSsl: config.get<unknown>('useSsl', false) === true,
    port: readPort(config.get<unknown>('port', 0)),
    v8Path: readString(config.get<unknown>('v8Path', '')),
    ibConnection: readString(config.get<unknown>('ibConnection', '')),
  };
}

export async function acquireDesignerBatchExecutor(
  input: DesignerExecutorInput,
  deps: DesignerExecutorDeps = {}
): Promise<DesignerExecutorLease> {
  // Бросает на «remote без агентского режима»: молчаливый откат на локальный 1cv8 означал бы
  // операцию не на той машине и, возможно, не с той базой.
  getAgentExecutionMode();
  if (readAgentLocation() !== 'remote') {
    const v8Path = resolveV8ExecutablePath(input.localV8Path);
    return {
      kind: 'local',
      executor: new LocalDesignerBatchExecutor(v8Path, { cwd: input.workspaceFolder.uri.fsPath }),
      v8Path,
    };
  }
  const settings = readRemoteDesignerSettings();
  const host = await obtainHost(input, settings, deps);
  const v8Path = await resolveServerV8Path(host, settings, input.v8Version);
  return {
    kind: 'remote',
    executor: new RemoteDesignerBatchExecutor(host, v8Path, {
      log: (line) => input.outputChannel.appendLine(`[remote] ${line}`),
    }),
    v8Path,
    ...(settings.ibConnection ? { ibConnectionOverride: settings.ibConnection } : {}),
  };
}

/** Тот же кэш и те же проверки учётки, но без проверки 1cv8: её делает сама проверка подключения. */
export function acquireRemotePowerShellHost(input: RemoteHostInput, deps: DesignerExecutorDeps = {}): Promise<RegistryHost> {
  return obtainHost(input, readRemoteDesignerSettings(), deps);
}

export async function disposeCachedDesignerExecutors(): Promise<void> {
  const entries = [...hosts.values()];
  hosts.clear();
  await Promise.allSettled(entries.map((entry) => entry.host.dispose()));
}

async function obtainHost(input: RemoteHostInput, settings: RemoteDesignerSettings, deps: DesignerExecutorDeps): Promise<RegistryHost> {
  if (!settings.user) {
    throw new Error(
      'Для удалённого Конфигуратора не задана учётная запись PowerShell-сессии: заполните v8vscedit.remote.user ' +
      '(пароль спрашивается один раз и хранится в SecretStorage).'
    );
  }
  const { password, prompted } = await resolveRemotePassword(input.secrets, settings, deps);
  const connection: PowerShellHostConnection = {
    computerName: settings.computerName,
    user: settings.user,
    password,
    authentication: settings.authentication,
    useSsl: settings.useSsl,
    port: settings.port,
  };
  const root = input.workspaceFolder.uri.fsPath;
  // В ключе — хэш пароля, а не он сам: ключ живёт в памяти дольше, чем нужно соединению.
  const key = JSON.stringify([
    connection.computerName, connection.user, connection.authentication, connection.useSsl, connection.port,
    crypto.createHash('sha256').update(password).digest('hex'),
  ]);
  const cached = hosts.get(root);
  if (cached?.key === key) {
    return cached.host;
  }
  const createHost = deps.createHost ?? ((options: PowerShellRemoteHostOptions) => new PowerShellRemoteHost({ ...deps.hostOptions, ...options }));
  // Новый хост кладётся в кэш синхронно, ДО освобождения старого: параллельный acquire после
  // любого await увидит уже новый хост, а не создаст второй.
  const host = createHost({
    connection,
    log: (line) => input.outputChannel.appendLine(`[remote-ps] ${line}`),
  });
  hosts.set(root, { key, host });
  if (cached) {
    await Promise.allSettled([cached.host.dispose()]);
  }
  try {
    // Вход выполняется здесь, один раз на новый хост: неверный пароль обнаруживается до операции.
    await host.ping();
  } catch (error) {
    hosts.delete(root);
    await Promise.allSettled([host.dispose()]);
    if (error instanceof PowerShellHostError && error.code === 'auth-failed') {
      // Автоповтора нет, а отклонённый пароль стирается: каждая следующая операция иначе снова
      // входила бы им, и политика домена заблокировала бы учётку.
      await input.secrets.setRemotePassword('');
      throw new Error(
        `Сервер ${settings.computerName} отклонил учётные данные ${settings.user} для PowerShell-сессии: ${error.message} ` +
        'Сохранённый пароль удалён — при следующей операции он будет запрошен заново.',
        { cause: error }
      );
    }
    throw error;
  }
  // Введённый пароль сохраняется только после успешного входа: опечатка не должна осесть в SecretStorage.
  if (prompted) {
    await input.secrets.setRemotePassword(password);
  }
  return host;
}

/** «Сбросить пароль удалённого сервера»: стирает пароль PSSession и освобождает хост проекта. */
export async function resetRemotePassword(input: RemoteHostInput): Promise<void> {
  await input.secrets.setRemotePassword('');
  const root = input.workspaceFolder.uri.fsPath;
  const cached = hosts.get(root);
  hosts.delete(root);
  await Promise.allSettled(cached ? [cached.host.dispose()] : []);
}

async function resolveRemotePassword(
  secrets: ProjectSecretStorage,
  settings: RemoteDesignerSettings,
  deps: DesignerExecutorDeps
): Promise<{ password: string; prompted: boolean }> {
  const stored = await secrets.getRemotePassword();
  if (stored) {
    return { password: stored, prompted: false };
  }
  const prompt = deps.promptRemotePassword ?? (() => promptPassword(settings));
  // Пробелы в пароле значимы и не обрезаются; пустой и чисто пробельный ввод — отказ.
  const answer = (await prompt()) ?? '';
  if (!answer.trim()) {
    throw new Error(`Не задан пароль учётной записи ${settings.user} для PowerShell-сессии с сервером ${settings.computerName}.`);
  }
  return { password: answer, prompted: true };
}

function promptPassword(settings: RemoteDesignerSettings): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    password: true,
    ignoreFocusOut: true,
    prompt: `Пароль учётной записи ${settings.user} для PowerShell-сессии с сервером ${settings.computerName} (сохраняется в SecretStorage)`,
  });
}

async function resolveServerV8Path(host: RegistryHost, settings: RemoteDesignerSettings, v8Version: string | undefined): Promise<string> {
  if (settings.v8Path) {
    const found = await host.resolveV8({ v8Path: settings.v8Path });
    if (!found) {
      throw new Error(`На сервере ${settings.computerName} не найден 1cv8 по пути ${settings.v8Path} (v8vscedit.remote.v8Path).`);
    }
    return found;
  }
  const version = v8Version?.trim();
  if (!version) {
    throw new Error('Путь к 1cv8 на сервере не задан: заполните v8vscedit.remote.v8Path или --v8version в env.json.');
  }
  const found = await host.resolveV8({ v8Version: version });
  if (!found) {
    throw new Error(`На сервере ${settings.computerName} не найдена платформа 1С версии ${version} (задайте v8vscedit.remote.v8Path).`);
  }
  return found;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Целое 0…65535 (дробное — вниз); иное — 0 (стандартный порт WinRM). */
function readPort(value: unknown): number {
  return typeof value !== 'number' || value < 0 || value > MAX_PORT ? 0 : Math.floor(value);
}
