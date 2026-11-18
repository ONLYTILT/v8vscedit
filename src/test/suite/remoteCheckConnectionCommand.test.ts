/**
 * Э8: команда v8vscedit.remote.checkConnection «Проверить подключение к серверу 1С» (UI-слой).
 *
 * Контракт (ui/commands/ext/agent/CheckRemoteConnectionCommand.ts):
 *  - `CHECK_REMOTE_CONNECTION_COMMAND_ID = 'v8vscedit.remote.checkConnection'`;
 *    `registerCheckRemoteConnectionCommand(context, services)`, подключена в `CommandRegistry.registerCommands`,
 *    объявлена в `package.json → contributes.commands` с русским заголовком; в меню/палитру специально не выносится.
 *  - Обработчик без аргументов, под общим `configurationOperationLock` (замок занят → сообщение «уже выполняется»,
 *    подключений к серверу нет); уведомления внутри замка — без `await` (запрет №18).
 *  - `v8vscedit.agent.location !== 'remote'` → предупреждение «проверка доступна только для удалённого режима»,
 *    подключений нет.
 *  - Параметры подключения — те же, что у реестра: `agent.host/port/user/privateKeyPath`, пароль — пароль ИБ из
 *    SecretStorage (никакого отдельного пароля SSH); env.json нет/битый → showErrorMessage с причиной, без исключения.
 *  - Отчёт `checkRemoteAgentConnection` печатается в журнал построчно с префиксом `[remote-check]`
 *    (`formatRemoteConnectionReport`); всё в порядке → showInformationMessage (слово «успешно»);
 *    есть отказ → showErrorMessage с текстом ПЕРВОЙ упавшей части. Пароль ни в журнале, ни в сообщениях.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerCommands } from '../../ui/commands/CommandRegistry';
import type { CommandServices } from '../../ui/commands/_shared';
import { endConfigurationOperation, tryBeginConfigurationOperation } from '../../ui/commands/ext/configurationOperationLock';
import {
  REMOTE_DB_PASSWORD,
  REMOTE_LEGACY_PASSWORD,
  RemoteHarness,
  type RemoteHarnessOptions,
  assertNoSecrets,
  setAgentSetting,
} from './support/agentRemoteHarness';

const ROOT = path.resolve(__dirname, '../../..');
const COMMAND = 'v8vscedit.remote.checkConnection';

suite('Агент Э8: команда v8vscedit.remote.checkConnection', function () {
  this.timeout(60_000);
  const commandsRef = vscode.commands as unknown as { registerCommand: unknown };
  let h = new RemoteHarness();
  let started = false;
  let handler: (() => Promise<void>) | undefined;
  let originalRegister: unknown;

  async function setup8(options: RemoteHarnessOptions = {}): Promise<void> {
    h = new RemoteHarness();
    started = true;
    await h.start(options);
    originalRegister = commandsRef.registerCommand;
    const handlers = new Map<string, () => Promise<void>>();
    commandsRef.registerCommand = (id: string, callback: () => Promise<void>) => {
      handlers.set(id, callback);
      return { dispose: () => undefined };
    };
    try {
      registerCommands(
        { subscriptions: [] } as unknown as vscode.ExtensionContext,
        { workspaceFolder: h.folder, outputChannel: h.channel } as unknown as CommandServices
      );
    } finally {
      commandsRef.registerCommand = originalRegister;
    }
    handler = handlers.get(COMMAND);
  }

  teardown(async () => {
    await endConfigurationOperation();
    if (started) {
      await h.dispose();
      started = false;
    }
    handler = undefined;
  });

  function run(): Promise<void> {
    assert.ok(handler, `${COMMAND} не зарегистрирована в CommandRegistry.registerCommands`);
    return handler();
  }

  test('package.json: команда объявлена, заголовок на русском', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
      contributes: { commands: { command: string; title?: string }[] };
    };
    const entry = manifest.contributes.commands.find((c) => c.command === COMMAND);
    assert.ok(entry, `${COMMAND} не объявлена в contributes.commands`);
    assert.match(entry.title ?? '', /[А-Яа-яЁё]/);
  });

  test('всё доступно: отчёт в журнале, сообщение об успехе, пароль нигде не виден, соединения закрыты', async () => {
    await setup8();
    await run();
    assert.deepStrictEqual(h.errors, []);
    assert.deepStrictEqual(h.warnings, []);
    assert.ok(h.infos.some((m) => /успешно/i.test(m)), h.infos.join('|'));
    const report = h.lines.filter((line) => line.startsWith('[remote-check]'));
    assert.strictEqual(report.length >= 3, true, h.lines.join('\n'));
    assert.ok(report.some((line) => line.includes('[OK]')));
    assert.ok(h.server.shellLog.flat().includes('common connect-ib'));
    assert.ok(h.server.shellLog.flat().includes('common disconnect-ib'));
    assert.ok(h.server.passwordsSeen.every((p) => p === REMOTE_DB_PASSWORD));
    await h.server.whenClientCount(0);
    assertNoSecrets(h.everythingShown());
  });

  test('неверный логин или пароль: ошибка с причиной, одна попытка входа, пароль не светится', async () => {
    await setup8();
    h.server.setBehavior({ mode: 'reject-all' });
    await run();
    assert.ok(h.errors.some((m) => m.includes('неверный логин или пароль')), h.errors.join('|'));
    assert.deepStrictEqual(h.infos, []);
    assert.strictEqual(h.server.passwordAttempts, 1);
    assert.ok(h.lines.some((line) => line.startsWith('[remote-check]') && line.includes('[ОШИБКА]')));
    assertNoSecrets(h.everythingShown());
  });

  test('агент без SFTP: ошибка называет SFTP', async () => {
    await setup8({ sftp: false });
    await run();
    assert.ok(h.errors.some((m) => m.includes('SFTP')), h.errors.join('|'));
  });

  test('агент не слушает порт: ошибка «не отвечает», пакет не падает исключением', async () => {
    await setup8();
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await setAgentSetting('port', port);
    await run();
    assert.ok(h.errors.some((m) => m.includes('не отвечает')), h.errors.join('|'));
  });

  test('режим local: предупреждение, к серверу не подключаемся', async () => {
    await setup8();
    await setAgentSetting('location', 'local');
    await run();
    assert.ok(h.warnings.some((m) => /удал[её]нн/i.test(m)), h.warnings.join('|'));
    assert.strictEqual(h.server.passwordAttempts, 0);
    assert.deepStrictEqual(h.errors, []);
  });

  test('нет env.json: сообщение об ошибке с причиной, без исключения и без подключений', async () => {
    await setup8();
    fs.rmSync(path.join(h.root, 'env.json'));
    await run();
    assert.ok(h.errors.some((m) => m.includes('env.json')), h.errors.join('|'));
    assert.strictEqual(h.server.passwordAttempts, 0);
  });

  test('идёт другая операция с конфигурацией: отказ с сообщением, подключений нет', async () => {
    await setup8();
    assert.strictEqual(await tryBeginConfigurationOperation(), true);
    await run();
    assert.ok([...h.infos, ...h.warnings].some((m) => m.includes('уже выполняется')));
    assert.strictEqual(h.server.passwordAttempts, 0);
  });

  test('пароль берётся из SecretStorage, а не из legacy-значения env.json', async () => {
    await setup8();
    await run();
    assert.ok(h.server.passwordsSeen.length > 0);
    assert.ok(!h.server.passwordsSeen.includes(REMOTE_LEGACY_PASSWORD));
  });
});
