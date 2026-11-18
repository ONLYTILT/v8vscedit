/**
 * Стенд удалённого режима агента (Э8): настоящий in-process ssh2.Server с shell-каналом, который
 * отвечает через эмулятор команд агента, и SFTP над тем же персональным корнем (`userRoot`).
 * Подменяется ТОЛЬКО агент 1С. Настройки `v8vscedit.*` — настоящие (Global), env.json и каталог
 * проекта — временные, секреты — в памяти (`SecretStore`), диалоги vscode.window — приёмники строк.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectSecretStorage } from '../../../infra/environment';
import { setProjectSecretStorage } from '../../../ui/commands/ext/connectionSettings';
import { disposeCachedAgentOperationServices } from '../../../ui/commands/ext/agent/AgentServiceRegistry';
import { AgentConfigEmulator } from './agentConfigEmulator';
import { AgentSshTestServer, type AgentWireMessage } from './agentSshTestServer';

type WindowRef = Record<string, unknown>;
const windowRef = vscode.window as unknown as WindowRef;

export const REMOTE_DB_PASSWORD = 'секрет-БД-Pa$$w0rd';
export const REMOTE_LEGACY_PASSWORD = 'legacy-из-env-json';

const AGENT_KEYS = [
  'location', 'host', 'port', 'user', 'autoStart', 'listenAddress', 'agentModeArgs',
  'transferConcurrency', 'archiveThresholdFiles', 'authWarmupMs', 'startupTimeoutMs', 'idleDisconnectMinutes',
] as const;

export interface RemoteHarnessOptions {
  /** `false` — SFTP-подсистему сервер отклоняет (агент без SFTP). По умолчанию включена. */
  readonly sftp?: boolean;
  /** Ответ на строку команды вместо эмулятора (сценарии отказов агента); `undefined` — штатный эмулятор. */
  readonly respond?: (line: string) => Promise<readonly AgentWireMessage[]> | undefined;
}

export function memorySecrets(map: Map<string, string>) {
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

export async function setAgentSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration('v8vscedit.agent').update(key, value, vscode.ConfigurationTarget.Global);
}

export async function resetAgentSettings(): Promise<void> {
  for (const key of AGENT_KEYS) {
    await setAgentSetting(key, undefined);
  }
  await vscode.workspace.getConfiguration('v8vscedit.configuration')
    .update('operationMode', undefined, vscode.ConfigurationTarget.Global);
}

export class RemoteHarness {
  base = '';
  /** Корень проекта (рабочая папка VS Code). */
  root = '';
  /** Персональный корень пользователя агента: он же корень SFTP. */
  userRoot = '';
  /** P основной конфигурации. */
  cfRoot = '';
  folder!: vscode.WorkspaceFolder;
  channel!: vscode.OutputChannel;
  lines: string[] = [];
  infos: string[] = [];
  warnings: string[] = [];
  errors: string[] = [];
  server!: AgentSshTestServer;
  emulator!: AgentConfigEmulator;
  secrets = new Map<string, string>();
  private saved: Record<string, unknown> = {};

  async start(options: RemoteHarnessOptions = {}): Promise<void> {
    this.base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-remote-')));
    this.root = path.join(this.base, 'project');
    this.userRoot = path.join(this.base, 'user-root');
    this.cfRoot = path.join(this.root, 'src', 'cf');
    fs.mkdirSync(this.cfRoot, { recursive: true });
    fs.mkdirSync(this.userRoot, { recursive: true });
    this.folder = { uri: vscode.Uri.file(this.root), name: 'e8', index: 0 };
    this.lines = [];
    this.infos = [];
    this.warnings = [];
    this.errors = [];
    this.channel = { appendLine: (line: string) => { this.lines.push(line); } } as unknown as vscode.OutputChannel;
    for (const key of ['showErrorMessage', 'showInformationMessage', 'showWarningMessage']) {
      this.saved[key] = windowRef[key];
    }
    windowRef.showErrorMessage = (message: string) => { this.errors.push(message); return Promise.resolve(undefined); };
    windowRef.showInformationMessage = (message: string) => { this.infos.push(message); return Promise.resolve(undefined); };
    windowRef.showWarningMessage = (message: string) => { this.warnings.push(message); return Promise.resolve(undefined); };

    await disposeCachedAgentOperationServices();
    this.server = await AgentSshTestServer.start({ sftpRoot: options.sftp === false ? undefined : this.userRoot });
    this.emulator = new AgentConfigEmulator(this.userRoot);
    this.server.setShellResponder(async (line) => {
      const custom = options.respond?.(line);
      if (custom) {
        return custom;
      }
      await this.emulator.execute(line);
      return [];
    });

    this.writeEnv();
    this.secrets = new Map<string, string>();
    const storage = new ProjectSecretStorage(memorySecrets(this.secrets), this.root);
    await storage.setDbPassword(REMOTE_DB_PASSWORD);
    setProjectSecretStorage(storage);

    await resetAgentSettings();
    await setAgentSetting('location', 'remote');
    await setAgentSetting('host', '127.0.0.1');
    await setAgentSetting('port', this.server.port);
    // autoStart оставлен включённым (умолчание): в remote он обязан игнорироваться.
    await vscode.workspace.getConfiguration('v8vscedit.configuration')
      .update('operationMode', 'agent', vscode.ConfigurationTarget.Global);
  }

  writeEnv(): void {
    fs.writeFileSync(
      path.join(this.root, 'env.json'),
      JSON.stringify({
        default: {
          '--ibconnection': `/F${path.join(this.base, 'ib')}`,
          '--db-user': 'ibuser',
          '--db-pwd': REMOTE_LEGACY_PASSWORD,
        },
      }),
      'utf-8'
    );
  }

  /** Все видимые пользователю строки и сообщения: по ним проверяется, что пароль нигде не всплыл. */
  everythingShown(): string {
    return [...this.lines, ...this.infos, ...this.warnings, ...this.errors].join('\n');
  }

  async dispose(): Promise<void> {
    for (const key of Object.keys(this.saved)) {
      windowRef[key] = this.saved[key];
    }
    await disposeCachedAgentOperationServices();
    await resetAgentSettings();
    setProjectSecretStorage(new ProjectSecretStorage(memorySecrets(new Map()), 'neutral'));
    await this.server.close();
    fs.rmSync(this.base, { recursive: true, force: true });
  }
}

/** Сообщение пользователю/журналу без пароля: общий критерий всех тестов удалённого режима. */
export function assertNoSecrets(text: string, secrets: readonly string[] = [REMOTE_DB_PASSWORD, REMOTE_LEGACY_PASSWORD]): void {
  for (const secret of secrets) {
    if (text.includes(secret)) {
      throw new Error(`Секрет «${secret}» попал в сообщения или журнал.`);
    }
  }
}
