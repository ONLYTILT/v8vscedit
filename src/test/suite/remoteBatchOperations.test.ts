/**
 * Э9 / Н51: чисто пакетные операции Конфигуратора при `v8vscedit.agent.location = "remote"`.
 *
 * До Э9 они запускали ЛОКАЛЬНЫЙ 1cv8 по `--ibconnection` из env.json без разбора вида базы. Хранилище
 * конфигурации теперь идёт через удалённый исполнитель (repositoryRemoteExecution.test.ts); то, что исполнить на
 * сервере через PSSession нельзя (внутренний CLI расширения — локальный процесс Node, который сам запускает 1cv8;
 * интерактивный Конфигуратор — окно на машине пользователя), решается по ВИДУ базы (решение оркестратора по Н51):
 *  - клиент-серверная база (`/S`): с машины пользователя это та же база по сети — операция выполняется локально,
 *    как раньше, с одной строкой в журнале, что работает локальный Конфигуратор (без всплывающих уведомлений);
 *    тотальный отказ лишил бы пользователя загрузки CF/CFE, пакетов расширений и Конфигуратора без замены;
 *  - файловая база (`/F`): путь указан для сервера, локальному 1cv8 он недоступен или указывает на ДРУГУЮ базу —
 *    явный отказ ДО побочных эффектов.
 *
 * Контракт:
 *  - `runInternalCliCommand` (ExtensionCommandRunner), remote + `/F` (в любом operationMode) → `false`, причина (текст со
 *    словами «удалённ…», «пакетн…», «v8vscedit.agent.location») уходит в `onFailureReason` и в `showErrorMessage` (если не
 *    отключён), CLI не стартует, строки «[actions] Старт» нет, агент не трогается, afterSuccess не вызывается;
 *    remote + `/S` → CLI запускается как раньше, в журнале одна строка о локальном Конфигураторе, ошибки про режим нет.
 *  - `runDbClientFromWorkspace` (DbRunCommandRunner): DESIGNER в remote + `/F` → сообщение с «удалённ…» и «Конфигуратор»,
 *    процесс не запускается, агент не трогается; DESIGNER в remote + `/S` → Конфигуратор запускается как раньше (строка
 *    журнала о локальном запуске); ENTERPRISE (тонкий клиент подключается к базе сам) — как раньше.
 *  - клиент-серверная база с ПЕТЛЕВЫМ адресом (`/S localhost/…`, `127.0.0.1`, `.`, `::1`) в remote — отказ как для `/F`:
 *    строка env.json записана с точки зрения сервера, локальный 1cv8 ушёл бы в кластер на машине пользователя.
 *  - Разбор вида базы — чистая функция `classifyInfoBaseConnection` (infoBaseConnectionKind.test.ts).
 *  - Локальный режим не меняется (покрыт agentBatchRelease.test.ts).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { InteractiveDesignerProcess } from '../../infra/agent';
import type { ProjectSecretStorage } from '../../infra/environment';
import { runDbClientFromWorkspace } from '../../ui/commands/db/DbRunCommandRunner';
import { disposeCachedAgentOperationServices } from '../../ui/commands/ext/agent/AgentServiceRegistry';
import { runInternalCliCommand } from '../../ui/commands/ext/ExtensionCommandRunner';
import { endConfigurationOperation } from '../../ui/commands/ext/configurationOperationLock';
import { resetAgentSettings, setAgentSetting } from './support/agentRemoteHarness';
import { seedCachedAgentService } from './support/agentRegistrySeed';

type WindowRef = Record<string, unknown>;
const windowRef = vscode.window as unknown as WindowRef;

async function setOperationMode(value: string | undefined): Promise<void> {
  await vscode.workspace.getConfiguration('v8vscedit.configuration').update('operationMode', value, vscode.ConfigurationTarget.Global);
}

suite('Э9 / Н51: пакетные операции в удалённом режиме агента — по виду базы (файловая — отказ, серверная — локально)', function () {
  this.timeout(60_000);
  let root: string;
  let folder: vscode.WorkspaceFolder;
  let lines: string[];
  let channel: vscode.OutputChannel;
  let errors: string[];
  let infos: string[];
  let warnings: string[];
  const saved: Record<string, unknown> = {};

  setup(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-e9-batch-')));
    folder = { uri: vscode.Uri.file(root), name: 'e9', index: 0 };
    lines = [];
    errors = [];
    infos = [];
    warnings = [];
    channel = { appendLine: (line: string) => { lines.push(line); } } as unknown as vscode.OutputChannel;
    for (const key of ['showErrorMessage', 'showInformationMessage', 'showWarningMessage']) {
      saved[key] = windowRef[key];
    }
    windowRef.showErrorMessage = (message: string) => { errors.push(message); return Promise.resolve(undefined); };
    windowRef.showInformationMessage = (message: string) => { infos.push(message); return Promise.resolve(undefined); };
    windowRef.showWarningMessage = (message: string) => { warnings.push(message); return Promise.resolve(undefined); };
    await disposeCachedAgentOperationServices();
    await resetAgentSettings();
  });

  teardown(async () => {
    for (const key of Object.keys(saved)) {
      windowRef[key] = saved[key];
    }
    await endConfigurationOperation();
    await disposeCachedAgentOperationServices();
    await resetAgentSettings();
    await setOperationMode(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const everything = (): string => [...lines, ...errors, ...infos, ...warnings].join('\n');

  function writeEnv(ibConnection: string, extra: Record<string, unknown> = {}): void {
    fs.writeFileSync(
      path.join(root, 'env.json'),
      JSON.stringify({ default: { '--ibconnection': ibConnection, ...extra } }),
      'utf-8'
    );
  }

  /** Файловая база с путём «на сервере»: локальному 1cv8 он недоступен или указывает на другую базу. */
  const FILE_BASE = '/FD:/Базы/Сервер';

  suite('runInternalCliCommand', () => {
    const cliOptions = (overrides: Record<string, unknown> = {}) => ({
      cliArgs: ['e9-unknown-command'],
      progressTitle: 'Тест Э9',
      progressStartMessage: 'старт',
      successMessage: 'ok',
      errorTitle: 'Ошибка Э9',
      logPrefix: 'e9-test',
      ...overrides,
    });

    // remote при operationMode=agent — штатная конфигурация удалённого режима; remote при batch — конфигурационная
    // ошибка. В обоих случаях локальный 1cv8 не стартует.
    for (const operationMode of ['agent', 'batch'] as const) {
      test(`remote + /F + operationMode=${operationMode}: false, причина про v8vscedit.agent.location в onFailureReason и сообщении, CLI не стартует`, async () => {
        await setAgentSetting('location', 'remote');
        await setOperationMode(operationMode);
        writeEnv(FILE_BASE);
        const reasons: string[] = [];

        const result = await runInternalCliCommand(cliOptions({ onFailureReason: (reason: string) => reasons.push(reason) }), folder, channel);

        assert.strictEqual(result, false);
        assert.ok(reasons.some((reason) => reason.includes('v8vscedit.agent.location')), reasons.join('|'));
        assert.ok(errors.some((message) => message.includes('v8vscedit.agent.location')), errors.join('|'));
        assert.ok(!lines.some((line) => line.startsWith('[actions] Старт') || line.startsWith('[e9-test]')), 'процесс CLI не должен был стартовать');
      });
    }

    test('remote + /F + agent: текст объясняет, что пакетные операции в удалённом режиме недоступны (а не просто «ошибка»)', async () => {
      await setAgentSetting('location', 'remote');
      await setOperationMode('agent');
      writeEnv(FILE_BASE);
      const reasons: string[] = [];
      await runInternalCliCommand(cliOptions({ onFailureReason: (reason: string) => reasons.push(reason) }), folder, channel);
      assert.match(reasons.join('\n'), /удал[её]нн/i);
      assert.match(reasons.join('\n'), /пакетн/i);
    });

    test('remote + /F: агент не трогается (подключённая база остаётся подключённой, команд агенту нет)', async () => {
      await setAgentSetting('location', 'remote');
      await setOperationMode('agent');
      writeEnv(FILE_BASE);
      const seeded = await seedCachedAgentService(root, { connected: true });
      await runInternalCliCommand(cliOptions(), folder, channel);
      assert.deepStrictEqual(seeded.factory.log, []);
      assert.strictEqual(seeded.service.isInfoBaseConnected(), true);
    });

    test('remote + /F и showErrorMessage=false: всплывающего окна нет, причина всё равно возвращена вызывающему', async () => {
      await setAgentSetting('location', 'remote');
      await setOperationMode('agent');
      writeEnv(FILE_BASE);
      const reasons: string[] = [];
      const result = await runInternalCliCommand(
        cliOptions({ showErrorMessage: false, onFailureReason: (reason: string) => reasons.push(reason) }),
        folder,
        channel
      );
      assert.strictEqual(result, false);
      assert.deepStrictEqual(errors, []);
      assert.strictEqual(reasons.length, 1);
    });

    test('remote + /F: afterSuccess не вызывается', async () => {
      await setAgentSetting('location', 'remote');
      await setOperationMode('agent');
      writeEnv(FILE_BASE);
      let called = false;
      await runInternalCliCommand(cliOptions({ afterSuccess: () => { called = true; return Promise.resolve(); } }), folder, channel);
      assert.strictEqual(called, false);
    });

    for (const ibConnection of ['/Ssrv-1c/base', ' "/s srv-1c/base" ']) {
      test(`remote + клиент-серверная база ${JSON.stringify(ibConnection)}: CLI запускается локально как раньше, одна строка журнала о локальном Конфигураторе`, async () => {
        await setAgentSetting('location', 'remote');
        await setOperationMode('agent');
        writeEnv(ibConnection);
        const reasons: string[] = [];

        const result = await runInternalCliCommand(cliOptions({ onFailureReason: (reason: string) => reasons.push(reason) }), folder, channel);

        assert.strictEqual(result, false, 'неизвестная команда CLI завершается ошибкой самого CLI');
        assert.ok(lines.some((line) => line.startsWith('[actions] Старт')), everything());
        assert.strictEqual(lines.filter((line) => /локальн/i.test(line) && line.includes('Конфигуратор')).length, 1, everything());
        assert.ok(!reasons.some((reason) => reason.includes('v8vscedit.agent.location')), reasons.join('|'));
        assert.deepStrictEqual(warnings, []);
        assert.deepStrictEqual(infos, []);
      });
    }

    for (const ibConnection of ['/Slocalhost/base', '/S 127.0.0.1:1541/base', 'Srvr="localhost";Ref="base";']) {
      test(`remote + петлевой адрес сервера ${JSON.stringify(ibConnection)}: отказ как для файловой базы, CLI не стартует`, async () => {
        await setAgentSetting('location', 'remote');
        await setOperationMode('agent');
        writeEnv(ibConnection);
        const reasons: string[] = [];
        const result = await runInternalCliCommand(cliOptions({ onFailureReason: (reason: string) => reasons.push(reason) }), folder, channel);
        assert.strictEqual(result, false);
        assert.ok(reasons.some((reason) => reason.includes('v8vscedit.agent.location') && reason.includes('localhost')), reasons.join('|'));
        assert.ok(!lines.some((line) => line.startsWith('[actions] Старт')), everything());
      });
    }

    test('remote без env.json (вид базы не определить): CLI запускается как раньше и сам сообщает о проблеме', async () => {
      await setAgentSetting('location', 'remote');
      await setOperationMode('agent');
      const result = await runInternalCliCommand(cliOptions(), folder, channel);
      assert.strictEqual(result, false);
      assert.ok(lines.some((line) => line.startsWith('[actions] Старт')), everything());
      assert.ok(!errors.some((message) => message.includes('v8vscedit.agent.location')), errors.join('|'));
    });

    test('контроль: location=local — CLI запускается как раньше (строка «Старт» есть)', async () => {
      await setAgentSetting('location', 'local');
      await setOperationMode('batch');
      const result = await runInternalCliCommand(cliOptions(), folder, channel);
      assert.strictEqual(result, false, 'неизвестная команда CLI завершается ошибкой');
      assert.ok(lines.some((line) => line.startsWith('[actions] Старт')), everything());
    });
  });

  suite('runDbClientFromWorkspace', () => {
    class FakeClientProcess implements InteractiveDesignerProcess {
      once(): this { return this; }
    }

    const secrets = { getDbPassword: () => Promise.resolve(undefined) } as unknown as ProjectSecretStorage;

    const thinClientPath = (): string => path.join(root, process.platform === 'win32' ? '1cv8c.exe' : '1cv8c');

    // Установка платформы содержит оба файла: Конфигуратор (1cv8) и тонкий клиент (1cv8c) рядом.
    function writeLaunchableEnv(ibConnection = '/Ssrv/base', withThinClient = true): string {
      const v8Path = path.join(root, process.platform === 'win32' ? '1cv8.exe' : '1cv8');
      fs.writeFileSync(v8Path, '');
      if (withThinClient) {
        fs.writeFileSync(thinClientPath(), '');
      }
      writeEnv(ibConnection, { '--path': v8Path });
      return v8Path;
    }

    test('remote + DESIGNER + файловая база: сообщение про удалённый режим, процесс не запускается, агент не трогается', async () => {
      await setAgentSetting('location', 'remote');
      await setOperationMode('agent');
      writeLaunchableEnv(FILE_BASE);
      const seeded = await seedCachedAgentService(root, { connected: true });
      const spawned: string[][] = [];

      await runDbClientFromWorkspace(folder, channel, secrets, { mode: 'DESIGNER' }, {
        spawnClient: (command, args) => { spawned.push([command, ...args]); return new FakeClientProcess(); },
      });

      assert.deepStrictEqual(spawned, []);
      const shown = [...errors, ...infos, ...warnings];
      assert.ok(shown.some((message) => /удал[её]нн/i.test(message) && /Конфигуратор/i.test(message)), shown.join('|'));
      assert.deepStrictEqual(seeded.factory.log, []);
      assert.strictEqual(seeded.service.isInfoBaseConnected(), true);
    });

    test('remote + DESIGNER + клиент-серверная база: Конфигуратор запускается локально как раньше, строка журнала о локальном запуске', async () => {
      await setAgentSetting('location', 'remote');
      await setOperationMode('agent');
      const v8Path = writeLaunchableEnv('/Ssrv/base');
      const spawned: string[][] = [];

      await runDbClientFromWorkspace(folder, channel, secrets, { mode: 'DESIGNER' }, {
        spawnClient: (command, args) => { spawned.push([command, ...args]); return new FakeClientProcess(); },
      });

      assert.strictEqual(spawned.length, 1);
      assert.strictEqual(path.resolve(spawned[0][0]), path.resolve(v8Path));
      assert.deepStrictEqual(spawned[0].slice(1, 4), ['DESIGNER', '/S', 'srv/base']);
      assert.ok(lines.some((line) => line.startsWith('[db-run]') && line.includes('Конфигуратор') && line.includes('клиент-серверн')), everything());
      assert.deepStrictEqual(errors, []);
      assert.deepStrictEqual(warnings, []);
    });

    test('remote + DESIGNER + петлевой адрес сервера: отказ, Конфигуратор не запускается', async () => {
      await setAgentSetting('location', 'remote');
      await setOperationMode('agent');
      writeLaunchableEnv('/S localhost:1541/base');
      const spawned: string[][] = [];
      await runDbClientFromWorkspace(folder, channel, secrets, { mode: 'DESIGNER' }, {
        spawnClient: (command, args) => { spawned.push([command, ...args]); return new FakeClientProcess(); },
      });
      assert.deepStrictEqual(spawned, []);
      assert.ok(errors.some((message) => /удал[её]нн/i.test(message) && message.includes('localhost')), errors.join('|'));
    });

    test('remote + ENTERPRISE + файловая база: тонкий клиент запускается как раньше (ограничение — только для Конфигуратора)', async () => {
      await setAgentSetting('location', 'remote');
      await setOperationMode('agent');
      writeLaunchableEnv(FILE_BASE);
      const spawned: string[][] = [];
      await runDbClientFromWorkspace(folder, channel, secrets, { mode: 'ENTERPRISE' }, {
        spawnClient: (command, args) => { spawned.push([command, ...args]); return new FakeClientProcess(); },
      });
      assert.strictEqual(spawned.length, 1);
      assert.deepStrictEqual(errors, []);
    });

    test('remote + ENTERPRISE: тонкий клиент запускается как раньше, агент не отключается', async () => {
      await setAgentSetting('location', 'remote');
      await setOperationMode('agent');
      writeLaunchableEnv();
      const seeded = await seedCachedAgentService(root, { connected: true });
      const spawned: string[][] = [];

      await runDbClientFromWorkspace(folder, channel, secrets, { mode: 'ENTERPRISE' }, {
        spawnClient: (command, args) => { spawned.push([command, ...args]); return new FakeClientProcess(); },
      });

      assert.strictEqual(spawned.length, 1);
      assert.strictEqual(path.resolve(spawned[0][0]), path.resolve(thinClientPath()));
      assert.strictEqual(spawned[0][1], 'ENTERPRISE');
      assert.deepStrictEqual(seeded.factory.log, []);
      assert.deepStrictEqual(errors, []);
    });

    test('ENTERPRISE запускает 1cv8c из каталога платформы, DESIGNER — 1cv8 (одна настройка --path)', async () => {
      await setAgentSetting('location', 'local');
      await setOperationMode('batch');
      const v8Path = writeLaunchableEnv();
      const spawned: string[] = [];
      const spawnClient = (command: string): InteractiveDesignerProcess => { spawned.push(path.resolve(command)); return new FakeClientProcess(); };

      await runDbClientFromWorkspace(folder, channel, secrets, { mode: 'ENTERPRISE' }, { spawnClient });
      await runDbClientFromWorkspace(folder, channel, secrets, { mode: 'DESIGNER' }, { spawnClient });

      assert.deepStrictEqual(spawned, [path.resolve(thinClientPath()), path.resolve(v8Path)]);
      assert.deepStrictEqual(errors, []);
    });

    test('ENTERPRISE без 1cv8c рядом с 1cv8: ошибка про тонкий клиент, толстый клиент не запускается', async () => {
      await setAgentSetting('location', 'local');
      await setOperationMode('batch');
      writeLaunchableEnv('/Ssrv/base', false);
      const spawned: string[] = [];

      await runDbClientFromWorkspace(folder, channel, secrets, { mode: 'ENTERPRISE' }, {
        spawnClient: (command) => { spawned.push(command); return new FakeClientProcess(); },
      });

      assert.deepStrictEqual(spawned, []);
      assert.ok(errors.some((message) => message.includes('Не найден тонкий клиент 1cv8c')), errors.join('|'));
    });
  });
});
