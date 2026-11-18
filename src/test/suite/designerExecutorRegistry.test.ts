/**
 * Э9: настройки `v8vscedit.remote.*` и реестр исполнителей пакетного конфигуратора
 * (ui/commands/ext/designerExecutorRegistry.ts, Extension Host).
 *
 * Контракт designerExecutorRegistry.ts:
 *   export interface RemoteDesignerSettings {
 *     computerName: string;                       // v8vscedit.remote.computerName; пусто → v8vscedit.agent.host
 *     authentication: 'Default' | 'Negotiate' | 'Kerberos';   // незнакомое → 'Default'
 *     user: string; useSsl: boolean; port: number; v8Path: string; ibConnection: string;   // строки — trim; port: целое ≥ 0, иначе 0
 *   }
 *   export function readRemoteDesignerSettings(): RemoteDesignerSettings;
 *   export interface DesignerExecutorLease {
 *     readonly kind: 'local' | 'remote';
 *     readonly executor: DesignerBatchExecutor;   // свой на каждый acquire; dispose() хост НЕ закрывает
 *     readonly v8Path: string;                    // local — локальный путь; remote — путь на СЕРВЕРЕ, проверенный host.resolveV8
 *     readonly ibConnectionOverride?: string;     // непустой v8vscedit.remote.ibConnection (только remote)
 *   }
 *   export type RegistryHost = RemoteDesignerHost & { ping(): Promise<{ pid: number }>; resolveV8(target: { v8Path?: string; v8Version?: string }): Promise<string | undefined>; dispose(): Promise<void> };
 *   export interface DesignerExecutorDeps {
 *     createHost?: (options: PowerShellRemoteHostOptions) => RegistryHost;     // шов под тест; по умолчанию — настоящий PowerShellRemoteHost
 *     promptRemotePassword?: () => Promise<string | undefined>;                // по умолчанию — vscode.window.showInputBox({ password: true })
 *   }
 *   export function acquireDesignerBatchExecutor(
 *     input: { workspaceFolder: vscode.WorkspaceFolder; outputChannel: vscode.OutputChannel; secrets: ProjectSecretStorage;
 *              localV8Path?: string; v8Version?: string },
 *     deps?: DesignerExecutorDeps
 *   ): Promise<DesignerExecutorLease>;
 *   export function acquireRemotePowerShellHost(
 *     input: { workspaceFolder: vscode.WorkspaceFolder; outputChannel: vscode.OutputChannel; secrets: ProjectSecretStorage },
 *     deps?: DesignerExecutorDeps
 *   ): Promise<RegistryHost>;      // тот же кэш, те же проверки remote.user/пароля, но без проверки 1cv8 (для checkConnection)
 *   export function disposeCachedDesignerExecutors(): Promise<void>;
 *
 * Пароль (ревью Э9, B2): введённый в диалоге сохраняется в SecretStorage ТОЛЬКО после успешного подключения (ping нового
 * хоста); отказ аутентификации (`PowerShellHostError` с кодом auth-failed) стирает сохранённый пароль, освобождает хост и
 * автоматически вход не повторяет (риск блокировки доменной учётки); пробелы в пароле значимы (не обрезаются); пробельный
 * ввод — как пустой. Команда `v8vscedit.remote.resetPassword` стирает пароль и освобождает хост.
 *
 * Правила: выбор local/remote — по `getAgentExecutionMode()`/`v8vscedit.agent.location` (remote при
 * operationMode ≠ agent — ошибка конфигурации с упоминанием v8vscedit.agent.location, без молчаливого отката на
 * локальный режим); `remote.user` обязателен (учётка явная, вариант «текущий пользователь Windows» не
 * реализуется); пароль — ТОЛЬКО из ProjectSecretStorage (нет — запрос у пользователя и сохранение там же;
 * отказ/пустой ввод — ошибка); хост кэшируется на проект и пересоздаётся при смене настроек remote (все ключи) или agent.host
 * или пароля (старый — dispose); `disposeCachedAgentOperationServices()` освобождает и хосты.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { LocalDesignerBatchExecutor } from '../../infra/process/designer/LocalDesignerBatchExecutor';
import {
  PowerShellHostError,
  type PowerShellRemoteHostOptions,
  type HostRunResult,
} from '../../infra/process/remote/PowerShellRemoteHost';
import type { CommandServices } from '../../ui/commands/_shared';
import { registerResetRemotePasswordCommand } from '../../ui/commands/ext/agent/ResetRemotePasswordCommand';
import { RemoteDesignerBatchExecutor } from '../../infra/process/remote/RemoteDesignerBatchExecutor';
import { disposeCachedAgentOperationServices } from '../../ui/commands/ext/agent/AgentServiceRegistry';
import {
  acquireDesignerBatchExecutor,
  acquireRemotePowerShellHost,
  disposeCachedDesignerExecutors,
  readRemoteDesignerSettings,
  type DesignerExecutorDeps,
  type RegistryHost,
} from '../../ui/commands/ext/designerExecutorRegistry';
import { memorySecrets, resetAgentSettings, setAgentSetting } from './support/agentRemoteHarness';
import { resetRemoteSettings, setRemoteSetting } from './support/remoteDesignerSettings';

const ROOT = path.resolve(__dirname, '../../..');
const PASSWORD = 'П@роль"с $пец';

interface ManifestProperty {
  type?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  enumDescriptions?: string[];
  description?: string;
}

function manifestProperty(key: string): ManifestProperty {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
    contributes: { configuration: { properties: Record<string, ManifestProperty> } };
  };
  const property = manifest.contributes.configuration.properties[key];
  assert.ok(property, `нет ${key} в contributes.configuration`);
  return property;
}

suite('Э9: package.json — объявление настроек v8vscedit.remote.*', () => {
  const table: { key: string; type: string; default: unknown }[] = [
    { key: 'computerName', type: 'string', default: '' },
    { key: 'authentication', type: 'string', default: 'Default' },
    { key: 'user', type: 'string', default: '' },
    { key: 'useSsl', type: 'boolean', default: false },
    { key: 'port', type: 'number', default: 0 },
    { key: 'v8Path', type: 'string', default: '' },
    { key: 'ibConnection', type: 'string', default: '' },
  ];
  for (const row of table) {
    test(`v8vscedit.remote.${row.key}: тип ${row.type}, умолчание ${JSON.stringify(row.default)}, русское описание`, () => {
      const property = manifestProperty(`v8vscedit.remote.${row.key}`);
      assert.strictEqual(property.type, row.type);
      assert.strictEqual(property.default, row.default);
      assert.match(property.description ?? '', /[А-Яа-яЁё]/);
    });
  }

  test('authentication: enum Default|Negotiate|Kerberos с русскими описаниями значений', () => {
    const property = manifestProperty('v8vscedit.remote.authentication');
    assert.deepStrictEqual(property.enum, ['Default', 'Negotiate', 'Kerberos']);
    assert.strictEqual(property.enumDescriptions?.length, 3);
    for (const text of property.enumDescriptions ?? []) {
      assert.match(text, /[А-Яа-яЁё]/);
    }
  });

  test('port: границы 0…65535', () => {
    const property = manifestProperty('v8vscedit.remote.port');
    assert.strictEqual(property.minimum, 0);
    assert.strictEqual(property.maximum, 65535);
  });

  test('user: описание сообщает, что пароль хранится в SecretStorage, а не в настройках', () => {
    assert.match(manifestProperty('v8vscedit.remote.user').description ?? '', /SecretStorage|секретн/i);
  });

  test('пароль PSSession в настройках не объявлен вовсе (запрет №9)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
      contributes: { configuration: { properties: Record<string, unknown> } };
    };
    const keys = Object.keys(manifest.contributes.configuration.properties).filter((key) => key.startsWith('v8vscedit.remote.'));
    assert.ok(keys.length >= 7);
    assert.ok(!keys.some((key) => /pass|pwd|secret/i.test(key)), keys.join(', '));
  });
});

suite('Э9: readRemoteDesignerSettings — чтение настроек', () => {
  teardown(async () => {
    await resetRemoteSettings();
    await resetAgentSettings();
  });

  test('умолчания: всё пусто, Default, без SSL, порт 0; computerName берётся из agent.host', async () => {
    await resetRemoteSettings();
    await setAgentSetting('host', 'agent-host.corp');
    assert.deepStrictEqual(readRemoteDesignerSettings(), {
      computerName: 'agent-host.corp', authentication: 'Default', user: '', useSsl: false, port: 0, v8Path: '', ibConnection: '',
    });
  });

  test('заданные значения читаются, строки обрезаются; явный computerName важнее agent.host', async () => {
    await setAgentSetting('host', 'agent-host.corp');
    await setRemoteSetting('computerName', '  ps-host.corp ');
    await setRemoteSetting('authentication', 'Kerberos');
    await setRemoteSetting('user', ' CORP\\svc ');
    await setRemoteSetting('useSsl', true);
    await setRemoteSetting('port', 5986);
    await setRemoteSetting('v8Path', '  C:\\1c\\1cv8.exe ');
    await setRemoteSetting('ibConnection', ' /Ssrv/base ');
    assert.deepStrictEqual(readRemoteDesignerSettings(), {
      computerName: 'ps-host.corp', authentication: 'Kerberos', user: 'CORP\\svc', useSsl: true, port: 5986,
      v8Path: 'C:\\1c\\1cv8.exe', ibConnection: '/Ssrv/base',
    });
  });

  test('нестроковое значение строковой настройки — пусто; пустой computerName и пустой agent.host — localhost', async () => {
    await setAgentSetting('host', '');
    await setRemoteSetting('computerName', 42);
    await setRemoteSetting('user', true);
    const settings = readRemoteDesignerSettings();
    assert.strictEqual(settings.computerName, 'localhost');
    assert.strictEqual(settings.user, '');
  });

  const authTable: [unknown, string][] = [['Negotiate', 'Negotiate'], ['Kerberos', 'Kerberos'], ['Basic', 'Default'], ['', 'Default'], [42, 'Default']];
  for (const [raw, expected] of authTable) {
    test(`authentication ${JSON.stringify(raw)} → ${expected}`, async () => {
      await setRemoteSetting('authentication', raw);
      assert.strictEqual(readRemoteDesignerSettings().authentication, expected);
    });
  }

  const portTable: [unknown, number][] = [[5985, 5985], [0, 0], [-1, 0], [1.9, 1], ['abc', 0], [null, 0], [65535, 65535], [65536, 0]];
  for (const [raw, expected] of portTable) {
    test(`port ${JSON.stringify(raw)} → ${String(expected)}`, async () => {
      await setRemoteSetting('port', raw);
      assert.strictEqual(readRemoteDesignerSettings().port, expected);
    });
  }
});

class FakeRegistryHost implements RegistryHost {
  disposed = 0;
  readonly calls: string[] = [];
  /** Пути/версии, которые «сервер» считает существующими: ключ запроса → найденный путь. */
  readonly resolvable = new Map<string, string>();

  constructor(readonly options: PowerShellRemoteHostOptions) {}

  pingError?: Error;
  ping(): Promise<{ pid: number }> {
    this.calls.push('ping');
    return this.pingError ? Promise.reject(this.pingError) : Promise.resolve({ pid: 1 });
  }
  mktemp(): Promise<string> { this.calls.push('mktemp'); return Promise.resolve('C:\\Temp\\v8vscedit-1'); }
  put(): Promise<void> { this.calls.push('put'); return Promise.resolve(); }
  run(): Promise<HostRunResult> {
    this.calls.push('run');
    return Promise.resolve({ exitCode: 0, interrupted: false, logBytes: Buffer.alloc(0), pid: 1 });
  }
  fetch(): Promise<boolean> { this.calls.push('fetch'); return Promise.resolve(false); }
  rmtemp(): Promise<void> { this.calls.push('rmtemp'); return Promise.resolve(); }
  resolveV8(target: { v8Path?: string; v8Version?: string }): Promise<string | undefined> {
    return Promise.resolve(this.resolvable.get(target.v8Path ?? `v${target.v8Version ?? ''}`));
  }
  dispose(): Promise<void> { this.disposed += 1; return Promise.resolve(); }
}

suite('Э9: designerExecutorRegistry — выбор local/remote, хост, пароль', function () {
  this.timeout(60_000);
  let root: string;
  let folder: vscode.WorkspaceFolder;
  let secretsMap: Map<string, string>;
  let secrets: ProjectSecretStorage;
  let lines: string[];
  let channel: vscode.OutputChannel;
  let hosts: FakeRegistryHost[];
  let prompts: number;
  let promptAnswer: string | undefined;
  let deps: DesignerExecutorDeps;
  let localExe: string;

  async function setOperationMode(value: string | undefined): Promise<void> {
    await vscode.workspace.getConfiguration('v8vscedit.configuration').update('operationMode', value, vscode.ConfigurationTarget.Global);
  }

  setup(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-exec-registry-')));
    folder = { uri: vscode.Uri.file(root), name: 'e9', index: 0 };
    secretsMap = new Map();
    secrets = new ProjectSecretStorage(memorySecrets(secretsMap), root);
    lines = [];
    channel = { appendLine: (line: string) => { lines.push(line); } } as unknown as vscode.OutputChannel;
    hosts = [];
    prompts = 0;
    promptAnswer = PASSWORD;
    deps = {
      createHost: (options) => {
        const host = new FakeRegistryHost(options);
        host.resolvable.set('C:\\1c\\1cv8.exe', 'C:\\1c\\1cv8.exe');
        host.resolvable.set('v8.3.27.2130', 'C:\\Program Files\\1cv8\\8.3.27.2130\\bin\\1cv8.exe');
        hosts.push(host);
        return host;
      },
      promptRemotePassword: () => { prompts += 1; return Promise.resolve(promptAnswer); },
    };
    localExe = path.join(root, process.platform === 'win32' ? '1cv8.exe' : '1cv8');
    fs.writeFileSync(localExe, '');
    await disposeCachedDesignerExecutors();
    await resetRemoteSettings();
    await resetAgentSettings();
  });

  teardown(async () => {
    await disposeCachedDesignerExecutors();
    await resetRemoteSettings();
    await resetAgentSettings();
    await setOperationMode(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const input = (extra: { v8Version?: string; localV8Path?: string } = {}) => ({
    workspaceFolder: folder, outputChannel: channel, secrets, localV8Path: '', ...extra,
  });

  async function configureRemote(overrides: { user?: string; v8Path?: string; ibConnection?: string } = {}): Promise<void> {
    await setAgentSetting('location', 'remote');
    await setOperationMode('agent');
    await setAgentSetting('host', 'srv-1c.corp');
    await setRemoteSetting('user', overrides.user ?? 'CORP\\svc');
    await setRemoteSetting('v8Path', overrides.v8Path ?? 'C:\\1c\\1cv8.exe');
    if (overrides.ibConnection) {
      await setRemoteSetting('ibConnection', overrides.ibConnection);
    }
    await secrets.setRemotePassword(PASSWORD);
  }

  suite('локальный режим', () => {
    test('location=local: локальный исполнитель на локальном 1cv8, хост PowerShell не создаётся', async () => {
      const lease = await acquireDesignerBatchExecutor(input({ localV8Path: localExe }), deps);
      assert.strictEqual(lease.kind, 'local');
      assert.ok(lease.executor instanceof LocalDesignerBatchExecutor);
      assert.strictEqual(path.resolve(lease.v8Path), path.resolve(localExe));
      assert.strictEqual(lease.ibConnectionOverride, undefined);
      assert.strictEqual(hosts.length, 0);
      await lease.executor.dispose();
    });

    test('local: remote.ibConnection игнорируется (override только для удалённого режима)', async () => {
      await setRemoteSetting('ibConnection', '/Ssrv/base');
      const lease = await acquireDesignerBatchExecutor(input({ localV8Path: localExe }), deps);
      assert.strictEqual(lease.ibConnectionOverride, undefined);
    });

    test('local: каждый acquire — свой исполнитель', async () => {
      const first = await acquireDesignerBatchExecutor(input({ localV8Path: localExe }), deps);
      const second = await acquireDesignerBatchExecutor(input({ localV8Path: localExe }), deps);
      assert.notStrictEqual(first.executor, second.executor);
    });
  });

  suite('удалённый режим', () => {
    test('remote: хост создаётся с параметрами из настроек и паролем из SecretStorage, исполнитель — удалённый', async () => {
      await configureRemote();
      await setRemoteSetting('authentication', 'Negotiate');
      await setRemoteSetting('useSsl', true);
      await setRemoteSetting('port', 5986);

      const lease = await acquireDesignerBatchExecutor(input(), deps);

      assert.strictEqual(lease.kind, 'remote');
      assert.ok(lease.executor instanceof RemoteDesignerBatchExecutor);
      assert.strictEqual(hosts.length, 1);
      assert.deepStrictEqual(hosts[0].options.connection, {
        computerName: 'srv-1c.corp', user: 'CORP\\svc', password: PASSWORD, authentication: 'Negotiate', useSsl: true, port: 5986,
      });
      assert.strictEqual(prompts, 0, 'пароль уже в SecretStorage — пользователя не спрашиваем');
    });

    test('remote.computerName важнее agent.host', async () => {
      await configureRemote();
      await setRemoteSetting('computerName', 'ps-gateway.corp');
      await acquireDesignerBatchExecutor(input(), deps);
      assert.strictEqual(hosts[0].options.connection.computerName, 'ps-gateway.corp');
    });

    test('v8Path из remote.v8Path проверяется на сервере и возвращается как путь сервера', async () => {
      await configureRemote();
      const lease = await acquireDesignerBatchExecutor(input({ localV8Path: 'D:\\локальный\\1cv8.exe' }), deps);
      assert.strictEqual(lease.v8Path, 'C:\\1c\\1cv8.exe');
    });

    test('remote.v8Path пуст: путь выводится из версии платформы env.json через resolveV8({v8Version})', async () => {
      await configureRemote({ v8Path: '' });
      const lease = await acquireDesignerBatchExecutor(input({ v8Version: '8.3.27.2130' }), deps);
      assert.strictEqual(lease.v8Path, 'C:\\Program Files\\1cv8\\8.3.27.2130\\bin\\1cv8.exe');
    });

    test('remote.v8Path пуст и версии нет: понятная ошибка с названием настройки', async () => {
      await configureRemote({ v8Path: '' });
      await assert.rejects(() => acquireDesignerBatchExecutor(input(), deps), /v8vscedit\.remote\.v8Path/);
    });

    test('1cv8 по заданному пути на сервере не найден: ошибка называет путь и сервер', async () => {
      await configureRemote({ v8Path: 'C:\\нет\\1cv8.exe' });
      await assert.rejects(
        () => acquireDesignerBatchExecutor(input(), deps),
        (error: unknown) => error instanceof Error && error.message.includes('C:\\нет\\1cv8.exe') && /сервер/i.test(error.message)
      );
    });

    test('версия платформы на сервере не найдена: ошибка называет версию', async () => {
      await configureRemote({ v8Path: '' });
      await assert.rejects(() => acquireDesignerBatchExecutor(input({ v8Version: '9.9.9.9' }), deps), /9\.9\.9\.9/);
    });

    test('remote.ibConnection (обрезанный) возвращается как ibConnectionOverride; пусто — undefined', async () => {
      await configureRemote({ ibConnection: ' /Ssrv/prod ' });
      assert.strictEqual((await acquireDesignerBatchExecutor(input(), deps)).ibConnectionOverride, '/Ssrv/prod');
      await setRemoteSetting('ibConnection', '');
      assert.strictEqual((await acquireDesignerBatchExecutor(input(), deps)).ibConnectionOverride, undefined);
    });

    test('remote без remote.user: ошибка с названием настройки, хост не создаётся', async () => {
      await configureRemote({ user: '' });
      await assert.rejects(() => acquireDesignerBatchExecutor(input(), deps), /v8vscedit\.remote\.user/);
      assert.strictEqual(hosts.length, 0);
    });

    test('remote при operationMode=batch: ошибка конфигурации про v8vscedit.agent.location, откат на локальный режим не происходит', async () => {
      await configureRemote();
      await setOperationMode('batch');
      await assert.rejects(() => acquireDesignerBatchExecutor(input({ localV8Path: localExe }), deps), /v8vscedit\.agent\.location/);
      assert.strictEqual(hosts.length, 0);
    });
  });

  suite('пароль PSSession', () => {
    test('пароля нет в SecretStorage: спрашиваем пользователя один раз, сохраняем в SecretStorage и используем', async () => {
      await configureRemote();
      await secrets.setRemotePassword('');
      await acquireDesignerBatchExecutor(input(), deps);
      assert.strictEqual(prompts, 1);
      assert.strictEqual(await secrets.getRemotePassword(), PASSWORD);
      assert.strictEqual(hosts[0].options.connection.password, PASSWORD);
      await acquireDesignerBatchExecutor(input(), deps);
      assert.strictEqual(prompts, 1, 'второй раз пароль берётся из SecretStorage');
    });

    for (const answer of [undefined, '', '   ']) {
      test(`пользователь отказался/ввёл пусто (${JSON.stringify(answer)}): ошибка про пароль, хост не создан, пустой пароль не сохранён`, async () => {
        await configureRemote();
        await secrets.setRemotePassword('');
        promptAnswer = answer;
        await assert.rejects(() => acquireDesignerBatchExecutor(input(), deps), /парол/i);
        assert.strictEqual(hosts.length, 0);
        assert.strictEqual(await secrets.hasRemotePassword(), false);
      });
    }

    test('пароль не попадает ни в журнал, ни в тексты ошибок, ни в settings', async () => {
      await configureRemote({ v8Path: 'C:\\нет\\1cv8.exe' });
      let message = '';
      try {
        await acquireDesignerBatchExecutor(input(), deps);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.ok(message.length > 0);
      assert.ok(!message.includes(PASSWORD));
      assert.ok(!lines.join('\n').includes(PASSWORD));
      for (const section of ['v8vscedit.remote', 'v8vscedit.agent']) {
        assert.ok(!JSON.stringify(vscode.workspace.getConfiguration(section)).includes(PASSWORD), section);
      }
    });
  });

  suite('пароль: сохранение после подключения, отказ аутентификации, сброс', () => {
    function failingDeps(error: Error): DesignerExecutorDeps {
      return {
        ...deps,
        createHost: (options) => {
          const host = new FakeRegistryHost(options);
          host.pingError = error;
          hosts.push(host);
          return host;
        },
      };
    }

    test('новый хост проверяется ping один раз; повторный acquire того же хоста не пингует', async () => {
      await configureRemote();
      await acquireDesignerBatchExecutor(input(), deps);
      await acquireDesignerBatchExecutor(input(), deps);
      assert.deepStrictEqual(hosts[0].calls.filter((call) => call === 'ping'), ['ping']);
    });

    test('пароль из диалога НЕ сохраняется, если подключение не удалось; хост освобождён и убран из кэша', async () => {
      await configureRemote();
      await secrets.setRemotePassword('');
      await assert.rejects(
        () => acquireDesignerBatchExecutor(input(), failingDeps(new PowerShellHostError('WinRM недоступен', 'remote-error'))),
        /WinRM недоступен/
      );
      assert.strictEqual(await secrets.hasRemotePassword(), false);
      assert.strictEqual(hosts[0].disposed, 1);
      await acquireDesignerBatchExecutor(input(), deps);
      assert.strictEqual(hosts.length, 2, 'следующая попытка — новый хост');
      assert.strictEqual(prompts, 2, 'пароль спрашивается снова');
      assert.strictEqual(await secrets.getRemotePassword(), PASSWORD);
    });

    test('сохранённый пароль отклонён сервером (auth-failed): стёрт из SecretStorage, хост освобождён, вход один, сообщение называет команду сброса', async () => {
      await configureRemote();
      let message = '';
      try {
        await acquireDesignerBatchExecutor(input(), failingDeps(new PowerShellHostError('Отказано в доступе', 'auth-failed')));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.match(message, /Отказано в доступе/);
      assert.match(message, /парол/i);
      assert.strictEqual(await secrets.hasRemotePassword(), false);
      assert.strictEqual(hosts[0].disposed, 1);
      assert.deepStrictEqual(hosts[0].calls.filter((call) => call === 'ping'), ['ping'], 'автоматического повторного входа нет');
      assert.strictEqual(prompts, 0, 'в том же вызове пароль заново не спрашивается');
      assert.ok(!message.includes(PASSWORD));
    });

    test('пароль с пробелами по краям используется и сохраняется как есть', async () => {
      await configureRemote();
      await secrets.setRemotePassword('');
      promptAnswer = '  пароль с пробелами  ';
      await acquireDesignerBatchExecutor(input(), deps);
      assert.strictEqual(hosts[0].options.connection.password, '  пароль с пробелами  ');
      assert.strictEqual(await secrets.getRemotePassword(), '  пароль с пробелами  ');
    });

    test('команда v8vscedit.remote.resetPassword: пароль стёрт, хост освобождён, следующий acquire спрашивает пароль заново', async () => {
      await configureRemote();
      await acquireDesignerBatchExecutor(input(), deps);
      const handlers = new Map<string, () => Promise<void>>();
      const commandsRef = vscode.commands as unknown as { registerCommand: unknown };
      const windowRef = vscode.window as unknown as Record<string, unknown>;
      const originalRegister = commandsRef.registerCommand;
      const originalInfo = windowRef.showInformationMessage;
      const infos: string[] = [];
      commandsRef.registerCommand = (id: string, callback: () => Promise<void>) => {
        handlers.set(id, callback);
        return { dispose: () => undefined };
      };
      windowRef.showInformationMessage = (text: string) => { infos.push(text); return Promise.resolve(undefined); };
      try {
        registerResetRemotePasswordCommand({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
          workspaceFolder: folder, outputChannel: channel, projectSecretStorage: secrets,
        } as unknown as CommandServices);
        const handler = handlers.get('v8vscedit.remote.resetPassword');
        assert.ok(handler, 'команда не зарегистрирована');
        await handler();
        await handler(); // повторный сброс без закэшированного хоста безопасен
      } finally {
        commandsRef.registerCommand = originalRegister;
        windowRef.showInformationMessage = originalInfo;
      }
      assert.strictEqual(await secrets.hasRemotePassword(), false);
      assert.strictEqual(hosts[0].disposed, 1);
      assert.ok(infos.some((text) => /парол/i.test(text)), infos.join('|'));
      await acquireDesignerBatchExecutor(input(), deps);
      assert.strictEqual(prompts, 1);
      assert.strictEqual(hosts.length, 2);
    });

    test('package.json объявляет v8vscedit.remote.resetPassword с русским заголовком', () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
        contributes: { commands: { command: string; title: string }[] };
      };
      const command = manifest.contributes.commands.find((item) => item.command === 'v8vscedit.remote.resetPassword');
      assert.ok(command);
      assert.match(command.title, /[А-Яа-яЁё]/);
    });
  });

  suite('кэш хоста и освобождение', () => {
    test('повторные и параллельные acquire делят один хост, исполнители разные', async () => {
      await configureRemote();
      const [first, second] = await Promise.all([acquireDesignerBatchExecutor(input(), deps), acquireDesignerBatchExecutor(input(), deps)]);
      const third = await acquireDesignerBatchExecutor(input(), deps);
      assert.strictEqual(hosts.length, 1);
      assert.notStrictEqual(first.executor, second.executor);
      assert.notStrictEqual(second.executor, third.executor);
    });

    test('dispose исполнителя хост не закрывает: он общий и живёт в реестре', async () => {
      await configureRemote();
      const lease = await acquireDesignerBatchExecutor(input(), deps);
      await lease.executor.dispose();
      assert.strictEqual(hosts[0].disposed, 0);
      await acquireDesignerBatchExecutor(input(), deps);
      assert.strictEqual(hosts.length, 1);
    });

    const settingChanges: { title: string; change: () => Promise<void> }[] = [
      { title: 'remote.user', change: () => setRemoteSetting('user', 'CORP\\other') },
      { title: 'remote.computerName', change: () => setRemoteSetting('computerName', 'other.corp') },
      { title: 'remote.authentication', change: () => setRemoteSetting('authentication', 'Negotiate') },
      { title: 'remote.useSsl', change: () => setRemoteSetting('useSsl', true) },
      { title: 'remote.port', change: () => setRemoteSetting('port', 5986) },
      { title: 'agent.host (при пустом remote.computerName)', change: () => setAgentSetting('host', 'moved.corp') },
      { title: 'пароль в SecretStorage', change: () => secrets.setRemotePassword('новый-пароль') },
    ];
    for (const row of settingChanges) {
      test(`смена ${row.title}: старый хост освобождён, создан новый с новыми параметрами`, async () => {
        await configureRemote();
        await acquireDesignerBatchExecutor(input(), deps);
        await row.change();
        await acquireDesignerBatchExecutor(input(), deps);
        assert.strictEqual(hosts.length, 2);
        assert.strictEqual(hosts[0].disposed, 1);
        assert.strictEqual(hosts[1].disposed, 0);
      });
    }

    test('disposeCachedDesignerExecutors освобождает хост; следующий acquire создаёт новый', async () => {
      await configureRemote();
      await acquireDesignerBatchExecutor(input(), deps);
      await disposeCachedDesignerExecutors();
      assert.strictEqual(hosts[0].disposed, 1);
      await disposeCachedDesignerExecutors();
      assert.strictEqual(hosts[0].disposed, 1, 'повторный вызов безопасен');
      await acquireDesignerBatchExecutor(input(), deps);
      assert.strictEqual(hosts.length, 2);
    });

    test('disposeCachedAgentOperationServices (сброс по смене v8vscedit.agent.*/remote.*) освобождает и хосты PowerShell', async () => {
      await configureRemote();
      await acquireDesignerBatchExecutor(input(), deps);
      await disposeCachedAgentOperationServices();
      assert.strictEqual(hosts[0].disposed, 1);
    });

    test('сбой создания хоста не оставляет мусор в кэше: повтор пробует снова', async () => {
      await configureRemote();
      let attempts = 0;
      const flaky: DesignerExecutorDeps = {
        ...deps,
        createHost: (options) => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('не удалось запустить powershell.exe');
          }
          const create = deps.createHost;
          assert.ok(create);
          return create(options);
        },
      };
      await assert.rejects(() => acquireDesignerBatchExecutor(input(), flaky), /powershell\.exe/);
      const lease = await acquireDesignerBatchExecutor(input(), flaky);
      assert.strictEqual(lease.kind, 'remote');
      assert.strictEqual(attempts, 2);
    });
  });
  suite('умолчания реестра без швов и журнал', () => {
    test('без promptRemotePassword пароль спрашивается полем ввода VS Code (password: true) и сохраняется в SecretStorage', async () => {
      await configureRemote();
      await secrets.setRemotePassword('');
      const windowRef = vscode.window as unknown as Record<string, unknown>;
      const original = windowRef.showInputBox;
      const asked: { password?: boolean; prompt?: string }[] = [];
      windowRef.showInputBox = (options: { password?: boolean; prompt?: string }) => {
        asked.push(options);
        return Promise.resolve(PASSWORD);
      };
      try {
        await acquireDesignerBatchExecutor(input(), { createHost: deps.createHost });
      } finally {
        windowRef.showInputBox = original;
      }
      assert.strictEqual(asked.length, 1);
      assert.strictEqual(asked[0].password, true);
      assert.ok(asked[0].prompt?.includes('CORP\\svc'), asked[0].prompt);
      assert.ok(!asked[0].prompt?.includes(PASSWORD));
      assert.strictEqual(await secrets.getRemotePassword(), PASSWORD);
    });

    test('без createHost — настоящий PowerShellRemoteHost (запуск процесса подменён швом hostOptions, без сети): сбой запуска → spawn-failed, пароль не тронут', async () => {
      await configureRemote();
      const spawned: string[] = [];
      const hostOptions = {
        powershellPath: 'подменённый-powershell.exe',
        spawn: (command: string): never => {
          spawned.push(command);
          throw new Error('запуск подменён тестом');
        },
      };
      await assert.rejects(
        () => acquireRemotePowerShellHost({ workspaceFolder: folder, outputChannel: channel, secrets }, { hostOptions }),
        (error: unknown) => error instanceof PowerShellHostError && error.code === 'spawn-failed' && error.message.includes('запуск подменён тестом')
      );
      assert.deepStrictEqual(spawned, ['подменённый-powershell.exe'], 'умолчательная фабрика передаёт шов настоящему хосту');
      assert.strictEqual(await secrets.getRemotePassword(), PASSWORD, 'сбой запуска — не повод стирать пароль');
    });

    test('журнал хоста идёт в канал вывода с префиксом [remote-ps], сбой уборки сервера исполнителем — с префиксом [remote]', async () => {
      await configureRemote();
      const lease = await acquireDesignerBatchExecutor(input(), deps);
      hosts[0].options.log?.('шум PowerShell');
      assert.ok(lines.includes('[remote-ps] шум PowerShell'), lines.join('|'));
      hosts[0].rmtemp = () => Promise.reject(new Error('каталог занят'));
      await lease.executor.run({ args: ['DESIGNER'], secrets: [] });
      assert.ok(lines.some((line) => line.startsWith('[remote] ') && line.includes('каталог занят')), lines.join('|'));
    });
  });

  suite('хост для проверки подключения (acquireRemotePowerShellHost)', () => {
    test('возвращает тот же кэшированный хост, что и acquireDesignerBatchExecutor, 1cv8 не проверяет', async () => {
      await configureRemote({ v8Path: 'C:\\нет\\1cv8.exe' });
      const host = await acquireRemotePowerShellHost({ workspaceFolder: folder, outputChannel: channel, secrets }, deps);
      assert.strictEqual(host, hosts[0]);
      await setRemoteSetting('v8Path', 'C:\\1c\\1cv8.exe');
      await acquireDesignerBatchExecutor(input(), deps);
      assert.strictEqual(hosts.length, 1);
    });

    test('без remote.user — ошибка про v8vscedit.remote.user; без пароля — запрос и сохранение в SecretStorage', async () => {
      await configureRemote({ user: '' });
      await assert.rejects(
        () => acquireRemotePowerShellHost({ workspaceFolder: folder, outputChannel: channel, secrets }, deps),
        /v8vscedit\.remote\.user/
      );
      await setRemoteSetting('user', 'CORP\\svc');
      await secrets.setRemotePassword('');
      await acquireRemotePowerShellHost({ workspaceFolder: folder, outputChannel: channel, secrets }, deps);
      assert.strictEqual(prompts, 1);
      assert.strictEqual(await secrets.getRemotePassword(), PASSWORD);
    });
  });
});
