/**
 * Э9: вторая половина проверки подключения к серверу 1С — PowerShell-сессия и путь к 1cv8.
 *
 * Контракт infra/process/remote/RemotePowerShellCheck.ts (без vscode):
 *   export type RemotePsPartId = 'powershell' | 'v8';
 *   export type RemotePsFailureReason = 'host-start' | 'session' | 'temp-write' | 'v8-not-found' | 'v8-config';
 *   export interface RemotePsPart { id: RemotePsPartId; status: 'ok' | 'failed' | 'skipped'; reason?: RemotePsFailureReason; message: string }
 *   export interface RemotePowerShellReport { ok: boolean; parts: readonly RemotePsPart[] }   // ВСЕГДА две части: powershell, v8
 *   export interface RemotePsCheckHost {
 *     ping(): Promise<{ pid: number }>; mktemp(): Promise<string>;
 *     put(dir: string, name: string, content: Uint8Array | string): Promise<void>; rmtemp(dir: string): Promise<void>;
 *     resolveV8(target: { v8Path?: string; v8Version?: string }): Promise<string | undefined>;
 *   }
 *   export function checkRemotePowerShell(
 *     host: RemotePsCheckHost,
 *     target: { computerName: string; v8Path?: string; v8Version?: string }
 *   ): Promise<RemotePowerShellReport>;
 *   export function formatRemotePowerShellReport(report): string[]   // `[OK] PowerShell: …`, `[ОШИБКА] 1cv8: …`, `[ПРОПУЩЕНО] 1cv8: …`
 *
 * Правила: powershell — `ping` (сессия жива), затем пробная запись (mktemp → put → rmtemp) во временный каталог
 * сервера: проверка прав на запись и уборки; v8 — `resolveV8` (при заданном v8Path — по нему и только по нему, иначе
 * по версии); сессия не открылась → v8 пропущен. Одна попытка на часть. Тексты на русском, называют сервер
 * (computerName) и проблемный путь/версию; пароль не попадает никуда (классы ошибок хоста его не содержат).
 * Пробный каталог убирается и при сбое записи (best effort).
 *
 * Контракт команды `v8vscedit.remote.checkConnection` после Э9 (CheckRemoteConnectionCommand.ts): после отчёта SSH/SFTP
 * выполняется проверка PowerShell (независимо от результата SSH-части — другой транспорт и другая учётка); хост берётся
 * из `acquireRemotePowerShellHost` (шов `CommandServices.designerExecutorDeps`, пароль — `services.projectSecretStorage`);
 * строки отчёта идут в журнал с префиксом `[remote-check]`; сообщение об ошибке — текст ПЕРВОЙ упавшей части в порядке
 * ssh, infobase, sftp, powershell, v8; успех — одно сообщение со словом «успешно», называющее и PowerShell. Нет
 * `remote.user`/пароля — часть powershell падает с понятным текстом (v8vscedit.remote.user / пароль), хост не создаётся.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { PowerShellHostError, PowerShellRemoteHost } from '../../infra/process/remote/PowerShellRemoteHost';
import {
  checkRemotePowerShell,
  formatRemotePowerShellReport,
  type RemotePsCheckHost,
} from '../../infra/process/remote/RemotePowerShellCheck';
import { registerCommands } from '../../ui/commands/CommandRegistry';
import type { CommandServices } from '../../ui/commands/_shared';
import { disposeCachedDesignerExecutors, type DesignerExecutorDeps } from '../../ui/commands/ext/designerExecutorRegistry';
import { endConfigurationOperation } from '../../ui/commands/ext/configurationOperationLock';
import {
  REMOTE_DB_PASSWORD,
  RemoteHarness,
  assertNoSecrets,
  memorySecrets,
  setAgentSetting,
} from './support/agentRemoteHarness';
import {
  IN_PROCESS_CONNECTION,
  sandboxedHostEnv,
  windowsPowerShellAvailable,
} from './support/powerShellTestEnv';
import { resetRemoteSettings, setRemoteSetting } from './support/remoteDesignerSettings';

const PS_PASSWORD = 'PS-секрет-Pa$$"w0rd';
const SERVER = 'srv-1c.corp';

class CheckHost implements RemotePsCheckHost {
  readonly calls: string[] = [];
  pingError?: Error;
  mktempError?: Error;
  putError?: Error;
  resolveError?: Error;
  resolved: string | undefined = 'C:\\1c\\1cv8.exe';
  readonly resolveTargets: { v8Path?: string; v8Version?: string }[] = [];

  ping(): Promise<{ pid: number }> {
    this.calls.push('ping');
    return this.pingError ? Promise.reject(this.pingError) : Promise.resolve({ pid: 4242 });
  }
  mktemp(): Promise<string> {
    this.calls.push('mktemp');
    return this.mktempError ? Promise.reject(this.mktempError) : Promise.resolve('C:\\Temp\\v8vscedit-check');
  }
  put(dir: string, name: string): Promise<void> {
    this.calls.push(`put:${dir}:${name}`);
    return this.putError ? Promise.reject(this.putError) : Promise.resolve();
  }
  rmtemp(dir: string): Promise<void> { this.calls.push(`rmtemp:${dir}`); return Promise.resolve(); }
  resolveV8(target: { v8Path?: string; v8Version?: string }): Promise<string | undefined> {
    this.calls.push('resolveV8');
    this.resolveTargets.push(target);
    return this.resolveError ? Promise.reject(this.resolveError) : Promise.resolve(this.resolved);
  }
}

const hostError = (code: ConstructorParameters<typeof PowerShellHostError>[1], message: string): PowerShellHostError =>
  new PowerShellHostError(message, code);

suite('Э9: checkRemotePowerShell — части powershell и v8', () => {
  test('всё в порядке: две части ok, порядок обращений ping → mktemp → put → rmtemp → resolveV8, сервер назван в текстах', async () => {
    const host = new CheckHost();
    const report = await checkRemotePowerShell(host, { computerName: SERVER, v8Path: 'C:\\1c\\1cv8.exe' });
    assert.strictEqual(report.ok, true);
    assert.deepStrictEqual(report.parts.map((part) => `${part.id}:${part.status}`), ['powershell:ok', 'v8:ok']);
    assert.strictEqual(host.calls[0], 'ping');
    assert.strictEqual(host.calls[1], 'mktemp');
    assert.ok(host.calls[2].startsWith('put:C:\\Temp\\v8vscedit-check:'));
    assert.strictEqual(host.calls[3], 'rmtemp:C:\\Temp\\v8vscedit-check');
    assert.strictEqual(host.calls[4], 'resolveV8');
    for (const part of report.parts) {
      assert.match(part.message, /[А-Яа-яЁё]/);
      assert.ok(part.message.includes(SERVER) || part.id === 'v8', part.message);
    }
    assert.ok(report.parts[1].message.includes('C:\\1c\\1cv8.exe'));
  });

  test('заданный v8Path проверяется по пути (и только по нему), иначе — по версии платформы', async () => {
    const byPath = new CheckHost();
    await checkRemotePowerShell(byPath, { computerName: SERVER, v8Path: 'C:\\1c\\1cv8.exe', v8Version: '8.3.27.2130' });
    assert.deepStrictEqual(byPath.resolveTargets, [{ v8Path: 'C:\\1c\\1cv8.exe' }]);

    const byVersion = new CheckHost();
    byVersion.resolved = 'C:\\Program Files\\1cv8\\8.3.27.2130\\bin\\1cv8.exe';
    const report = await checkRemotePowerShell(byVersion, { computerName: SERVER, v8Version: '8.3.27.2130' });
    assert.deepStrictEqual(byVersion.resolveTargets, [{ v8Version: '8.3.27.2130' }]);
    assert.ok(report.parts[1].message.includes('C:\\Program Files\\1cv8\\8.3.27.2130\\bin\\1cv8.exe'));
  });

  const pingFailures: { code: ConstructorParameters<typeof PowerShellHostError>[1]; reason: string }[] = [
    { code: 'spawn-failed', reason: 'host-start' },
    { code: 'remote-error', reason: 'session' },
    { code: 'session-broken', reason: 'session' },
    { code: 'host-exited', reason: 'session' },
    { code: 'protocol', reason: 'session' },
  ];
  for (const row of pingFailures) {
    test(`ping падает (${row.code}): powershell failed/${row.reason}, текст хоста сохранён, v8 пропущен, больше обращений нет`, async () => {
      const host = new CheckHost();
      host.pingError = hostError(row.code, 'Отказано в доступе к серверу');
      const report = await checkRemotePowerShell(host, { computerName: SERVER, v8Path: 'C:\\1c\\1cv8.exe' });
      assert.strictEqual(report.ok, false);
      assert.strictEqual(report.parts[0].status, 'failed');
      assert.strictEqual(report.parts[0].reason, row.reason);
      assert.ok(report.parts[0].message.includes('Отказано в доступе к серверу'), report.parts[0].message);
      assert.strictEqual(report.parts[1].status, 'skipped');
      assert.deepStrictEqual(host.calls, ['ping']);
    });
  }

  test('неизвестная ошибка (не PowerShellHostError) тоже превращается в отчёт, а не в исключение', async () => {
    const host = new CheckHost();
    host.pingError = new Error('что-то странное');
    const report = await checkRemotePowerShell(host, { computerName: SERVER, v8Path: 'C:\\1c\\1cv8.exe' });
    assert.strictEqual(report.parts[0].status, 'failed');
    assert.ok(report.parts[0].message.includes('что-то странное'));
  });

  test('запись в TEMP сервера запрещена: powershell failed/temp-write, пробный каталог всё равно убран; v8 проверяется независимо', async () => {
    const host = new CheckHost();
    host.putError = hostError('remote-error', 'Отказано в доступе к пути');
    const report = await checkRemotePowerShell(host, { computerName: SERVER, v8Path: 'C:\\1c\\1cv8.exe' });
    assert.strictEqual(report.parts[0].reason, 'temp-write');
    assert.ok(report.parts[0].message.includes('Отказано в доступе к пути'));
    assert.ok(host.calls.includes('rmtemp:C:\\Temp\\v8vscedit-check'));
    assert.strictEqual(report.parts[1].status, 'ok');
  });

  test('временный каталог сервера не создаётся: powershell failed/temp-write, убирать нечего (rmtemp не вызывается)', async () => {
    const host = new CheckHost();
    host.mktempError = hostError('remote-error', 'Нет доступа к TEMP');
    const report = await checkRemotePowerShell(host, { computerName: SERVER, v8Path: 'C:\\1c\\1cv8.exe' });
    assert.strictEqual(report.parts[0].reason, 'temp-write');
    assert.ok(report.parts[0].message.includes('Нет доступа к TEMP'));
    assert.ok(!host.calls.some((call) => call.startsWith('rmtemp')), host.calls.join('|'));
    assert.strictEqual(report.parts[1].status, 'ok');
  });

  test('1cv8 не найден на сервере: v8 failed/v8-not-found, текст называет путь и сервер', async () => {
    const host = new CheckHost();
    host.resolved = undefined;
    const report = await checkRemotePowerShell(host, { computerName: SERVER, v8Path: 'C:\\нет\\1cv8.exe' });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.parts[0].status, 'ok');
    assert.strictEqual(report.parts[1].reason, 'v8-not-found');
    assert.ok(report.parts[1].message.includes('C:\\нет\\1cv8.exe') && report.parts[1].message.includes(SERVER), report.parts[1].message);
  });

  test('версия не найдена на сервере: текст называет версию', async () => {
    const host = new CheckHost();
    host.resolved = undefined;
    const report = await checkRemotePowerShell(host, { computerName: SERVER, v8Version: '9.9.9.9' });
    assert.strictEqual(report.parts[1].reason, 'v8-not-found');
    assert.ok(report.parts[1].message.includes('9.9.9.9'));
  });

  test('сбой resolveV8: v8 failed/session с текстом хоста', async () => {
    const host = new CheckHost();
    host.resolveError = hostError('session-broken', 'Сеанс закрыт');
    const report = await checkRemotePowerShell(host, { computerName: SERVER, v8Path: 'C:\\1c\\1cv8.exe' });
    assert.strictEqual(report.parts[1].reason, 'session');
    assert.ok(report.parts[1].message.includes('Сеанс закрыт'));
  });

  test('нет ни v8Path, ни версии: v8 failed/v8-config с названием настройки, resolveV8 не вызывается', async () => {
    const host = new CheckHost();
    const report = await checkRemotePowerShell(host, { computerName: SERVER });
    assert.strictEqual(report.parts[1].reason, 'v8-config');
    assert.match(report.parts[1].message, /v8vscedit\.remote\.v8Path/);
    assert.ok(!host.calls.includes('resolveV8'));
  });

  test('formatRemotePowerShellReport: по строке на часть с признаком статуса и названием', async () => {
    const host = new CheckHost();
    host.pingError = hostError('remote-error', 'нет связи');
    const failed = formatRemotePowerShellReport(await checkRemotePowerShell(host, { computerName: SERVER, v8Path: 'p' }));
    assert.strictEqual(failed.length, 2);
    assert.ok(failed[0].startsWith('[ОШИБКА] PowerShell: '), failed[0]);
    assert.ok(failed[1].startsWith('[ПРОПУЩЕНО] 1cv8: '), failed[1]);

    const ok = formatRemotePowerShellReport(await checkRemotePowerShell(new CheckHost(), { computerName: SERVER, v8Path: 'p' }));
    assert.ok(ok[0].startsWith('[OK] PowerShell: ') && ok[1].startsWith('[OK] 1cv8: '), ok.join('|'));
  });
});

suite('Э9: checkRemotePowerShell на настоящем хосте powershell.exe (без удалённой сессии)', function () {
  this.timeout(120_000);
  let sandbox: string;
  let host: PowerShellRemoteHost | undefined;

  suiteSetup(function () {
    if (!windowsPowerShellAvailable()) {
      this.skip();
    }
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-pscheck-'));
  });
  teardown(async () => { await host?.dispose(); host = undefined; });
  suiteTeardown(() => { if (sandbox) { fs.rmSync(sandbox, { recursive: true, force: true }); } });

  test('существующий 1cv8: обе части ok, TEMP хоста после проверки чист', async () => {
    const tempDir = path.join(sandbox, 'temp');
    const exe = path.join(sandbox, '1cv8.exe');
    fs.writeFileSync(exe, '');
    host = new PowerShellRemoteHost({ connection: IN_PROCESS_CONNECTION, env: sandboxedHostEnv(tempDir) });
    const report = await checkRemotePowerShell(host, { computerName: 'localhost', v8Path: exe });
    assert.strictEqual(report.ok, true, JSON.stringify(report));
    assert.deepStrictEqual(fs.readdirSync(tempDir).filter((name) => name.startsWith('v8vscedit-')), []);
  });

  test('несуществующий 1cv8: powershell ok, v8 failed/v8-not-found', async () => {
    host = new PowerShellRemoteHost({ connection: IN_PROCESS_CONNECTION, env: sandboxedHostEnv(path.join(sandbox, 'temp2')) });
    const report = await checkRemotePowerShell(host, { computerName: 'localhost', v8Path: path.join(sandbox, 'нет.exe') });
    assert.strictEqual(report.parts[0].status, 'ok');
    assert.strictEqual(report.parts[1].reason, 'v8-not-found');
  });
});

// ---------------------------------------------------------------------------------------------------------
// Команда v8vscedit.remote.checkConnection: SSH/SFTP + PowerShell
// ---------------------------------------------------------------------------------------------------------
suite('Э9: команда v8vscedit.remote.checkConnection — часть PowerShell', function () {
  this.timeout(60_000);
  const COMMAND = 'v8vscedit.remote.checkConnection';
  const commandsRef = vscode.commands as unknown as { registerCommand: unknown };
  let h: RemoteHarness;
  let started = false;
  let handler: (() => Promise<void>) | undefined;
  let psHost: CheckHost;
  let hostsCreated: number;
  let prompts: number;
  let promptAnswer: string | undefined;
  let storage: ProjectSecretStorage;

  async function setup9(options: { sftp?: boolean; user?: string | null; password?: string | null } = {}): Promise<void> {
    h = new RemoteHarness();
    started = true;
    await h.start({ sftp: options.sftp });
    psHost = new CheckHost();
    hostsCreated = 0;
    prompts = 0;
    promptAnswer = PS_PASSWORD;
    await resetRemoteSettings();
    if (options.user !== null) {
      await setRemoteSetting('user', options.user ?? 'CORP\\svc');
    }
    await setRemoteSetting('v8Path', 'C:\\1c\\1cv8.exe');
    await setAgentSetting('host', '127.0.0.1');
    storage = new ProjectSecretStorage(memorySecrets(h.secrets), h.root);
    if (options.password !== null) {
      await storage.setRemotePassword(options.password ?? PS_PASSWORD);
    }
    const designerExecutorDeps: DesignerExecutorDeps = {
      createHost: () => { hostsCreated += 1; return Object.assign(psHost, { fetch: () => Promise.resolve(false), run: () => Promise.reject(new Error('не используется')), dispose: () => Promise.resolve() }); },
      promptRemotePassword: () => { prompts += 1; return Promise.resolve(promptAnswer); },
    };

    const original = commandsRef.registerCommand;
    const handlers = new Map<string, () => Promise<void>>();
    commandsRef.registerCommand = (id: string, callback: () => Promise<void>) => {
      handlers.set(id, callback);
      return { dispose: () => undefined };
    };
    try {
      registerCommands(
        { subscriptions: [] } as unknown as vscode.ExtensionContext,
        { workspaceFolder: h.folder, outputChannel: h.channel, projectSecretStorage: storage, designerExecutorDeps } as unknown as CommandServices
      );
    } finally {
      commandsRef.registerCommand = original;
    }
    handler = handlers.get(COMMAND);
  }

  teardown(async () => {
    await endConfigurationOperation();
    await disposeCachedDesignerExecutors();
    await resetRemoteSettings();
    if (started) {
      await h.dispose();
      started = false;
    }
    handler = undefined;
  });

  async function run(): Promise<void> {
    assert.ok(handler, `${COMMAND} не зарегистрирована`);
    await handler();
  }

  const reportLines = (): string[] => h.lines.filter((line) => line.startsWith('[remote-check]'));
  const shown = (): string => `${h.everythingShown()}\n${h.lines.join('\n')}`;

  test('SSH и PowerShell в порядке: в журнале части PowerShell и 1cv8, сообщение об успехе называет PowerShell, ошибок нет', async () => {
    await setup9();
    await run();
    assert.deepStrictEqual(h.errors, []);
    assert.ok(h.infos.some((m) => /успешно/i.test(m) && m.includes('PowerShell')), h.infos.join('|'));
    assert.ok(reportLines().some((line) => line.includes('[OK] PowerShell')), h.lines.join('\n'));
    assert.ok(reportLines().some((line) => line.includes('[OK] 1cv8')));
    assert.strictEqual(hostsCreated, 1);
    assertNoSecrets(shown(), [REMOTE_DB_PASSWORD, PS_PASSWORD]);
  });

  test('PowerShell не отвечает: ошибка с текстом хоста (первая упавшая часть), успеха нет', async () => {
    await setup9();
    psHost.pingError = hostError('remote-error', 'WinRM: доступ запрещён');
    await run();
    assert.ok(h.errors.some((m) => m.includes('WinRM: доступ запрещён')), h.errors.join('|'));
    assert.deepStrictEqual(h.infos, []);
    assert.ok(reportLines().some((line) => line.includes('[ОШИБКА] PowerShell')));
    assertNoSecrets(shown(), [REMOTE_DB_PASSWORD, PS_PASSWORD]);
  });

  test('1cv8 не найден на сервере: ошибка называет путь', async () => {
    await setup9();
    psHost.resolved = undefined;
    await run();
    assert.ok(h.errors.some((m) => m.includes('C:\\1c\\1cv8.exe')), h.errors.join('|'));
  });

  test('часть SSH/SFTP упала (агент без SFTP): показана ПЕРВАЯ упавшая часть — SFTP; PowerShell проверена независимо', async () => {
    await setup9({ sftp: false });
    await run();
    assert.ok(h.errors.some((m) => m.includes('SFTP')), h.errors.join('|'));
    assert.ok(!h.errors.some((m) => m.includes('PowerShell')), 'одно сообщение об ошибке — про первую упавшую часть');
    assert.ok(reportLines().some((line) => line.includes('[OK] PowerShell')), 'PowerShell проверена независимо от SSH');
  });

  test('нет remote.user: часть powershell падает с названием настройки, хост не создаётся', async () => {
    await setup9({ user: null });
    await run();
    assert.ok(h.errors.some((m) => m.includes('v8vscedit.remote.user')), h.errors.join('|'));
    assert.strictEqual(hostsCreated, 0);
    assert.deepStrictEqual(h.infos, []);
  });

  test('нет пароля в SecretStorage: спрашиваем и сохраняем в SecretStorage (не в настройки), проверка продолжается', async () => {
    await setup9({ password: null });
    await run();
    assert.strictEqual(prompts, 1);
    assert.strictEqual(await storage.getRemotePassword(), PS_PASSWORD);
    assert.deepStrictEqual(h.errors, []);
    assertNoSecrets(shown(), [PS_PASSWORD]);
  });

  test('пользователь отказался вводить пароль: ошибка про пароль, хост не создан, пустое значение не сохранено', async () => {
    await setup9({ password: null });
    promptAnswer = undefined;
    await run();
    assert.ok(h.errors.some((m) => /парол/i.test(m)), h.errors.join('|'));
    assert.strictEqual(hostsCreated, 0);
    assert.strictEqual(await storage.hasRemotePassword(), false);
  });

  test('режим local: предупреждение прежнее, ни SSH, ни PowerShell не трогаются', async () => {
    await setup9();
    await setAgentSetting('location', 'local');
    await run();
    assert.ok(h.warnings.some((m) => /удал[её]нн/i.test(m)));
    assert.strictEqual(hostsCreated, 0);
    assert.strictEqual(h.server.passwordAttempts, 0);
  });
});
