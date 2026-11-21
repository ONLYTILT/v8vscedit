/**
 * Раннеры CF/CFE-файлов и пакетов расширений в агентском режиме (plan-remote-extensions §3.4, §7.4, §4):
 * `runDumpConfigurationToCf` / `runLoadConfigurationFromCf` / `runDumpAllExtensionsToCfe` / `runLoadAllExtensionsFromCfe`.
 *
 * Параметризация `location`: `remote` — `RemoteHarness` (настоящий ssh2 + SFTP, env.json с файловой базой `/F…`),
 * `local` — запись реестра с настоящим `AgentOperationService` поверх эмулятора и локального хранилища.
 * Контракт агентской ветки:
 *  - валидация запроса (`validateCfFileRequest`) — ПЕРВОЙ, до любых обращений к агенту;
 *  - внутренний CLI не запускается (нет строки «[actions] Старт»), `disconnect-ib` до операции не отправляется
 *    (release для пакетных операций не нужен — операция сама идёт агентом);
 *  - результат — `CfFileRunOutcome` (success, failureReason, createdInDatabase, appliedToDatabase,
 *    extensionNameInDatabase, warnings); отказ показывается тостом, при `silent: true` — не показывается;
 *  - файловая база и петлевой сервер при remote больше НЕ отказ (раньше — Н51);
 *  - remote + batch — прежняя ошибка `resolveAgentExecutionMode`, команд агента нет;
 *  - пароль ИБ нигде не всплывает.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { writeCfeManifest } from '../../infra/cfFile/CfeBatchManifest';
import { cfeFileNameForExtension } from '../../infra/cfFile/CfeBatchNaming';
import { runDumpAllExtensionsToCfe, runLoadAllExtensionsFromCfe } from '../../ui/commands/ext/CfeBatchCommandRunner';
import { runDumpConfigurationToCf, runLoadConfigurationFromCf } from '../../ui/commands/ext/CfFileCommandRunner';
import { cfFile, cfeFile } from './support/agentExtensionsEmulator';
import { openLocal, openRemote, setOperationMode, type UiStand } from './support/agentUiStands';
import { REMOTE_DB_PASSWORD, assertNoSecrets } from './support/agentRemoteHarness';

for (const location of ['remote', 'local'] as const) {
  suite(`Раннеры CF/CFE и пакетов в агентском режиме [${location}]`, function () {
    this.timeout(120_000);
    let ui: UiStand;

    setup(async () => { ui = location === 'remote' ? await openRemote() : await openLocal(); });
    teardown(async () => { await ui.dispose(); });

    const file = (name: string): string => path.join(ui.workDir, name);
    const common = () => ({ workspaceFolder: ui.folder, outputChannel: ui.channel });
    const noCli = (): void => {
      assert.ok(!ui.lines.some((line) => line.startsWith('[actions] Старт')), 'внутренний CLI не запускался: ' + ui.lines.join('|'));
    };

    test('dump cf: CLI не запускается, release (disconnect-ib) до операции не было, результат — outcome, пароль не всплыл', async () => {
      ui.emulator.extensions.mainPayload = 'главная';
      const outputFile = file('main.cf');

      const outcome = await runDumpConfigurationToCf({ ...common(), outputFile, silent: true });

      assert.strictEqual(outcome.success, true);
      assert.strictEqual(outcome.failureReason, undefined);
      assert.strictEqual(fs.readFileSync(outputFile, 'utf-8'), cfFile('главная'));
      noCli();
      const log = ui.commandLog();
      assert.strictEqual(log[0], 'common connect-ib', 'первой командой агента — подключение ИБ, а не release');
      assert.ok(!log.includes('common disconnect-ib'), log.join('\n'));
      assertNoSecrets(ui.everythingShown(), [REMOTE_DB_PASSWORD]);
    });

    test('dump cfe: список + dump-cfg --extension; файл = содержимое расширения', async () => {
      ui.emulator.extensions.addExtension('Расш', 'п');
      const outputFile = file('Расш.cfe');

      const outcome = await runDumpConfigurationToCf({ ...common(), outputFile, extensionName: 'Расш', silent: true });

      assert.strictEqual(outcome.success, true);
      assert.strictEqual(fs.readFileSync(outputFile, 'utf-8'), cfeFile('Расш', 'п'));
      assert.ok(ui.commandLog().some((line) => line.startsWith('config dump-cfg') && line.endsWith('--extension=Расш')));
    });

    test('dump cfe заглушки: success=false, failureReason — E3; тост показан без silent и НЕ показан с silent', async () => {
      ui.emulator.extensions.addStub('Заглушка');
      const outputFile = file('З.cfe');

      const silent = await runDumpConfigurationToCf({ ...common(), outputFile, extensionName: 'Заглушка', silent: true });
      assert.strictEqual(silent.success, false);
      assert.ok(silent.failureReason?.includes('не применено') && silent.failureReason.includes('выгружать нельзя'), silent.failureReason);
      assert.strictEqual(ui.errors.length, 0, 'silent: всплывающего окна нет');

      const loud = await runDumpConfigurationToCf({ ...common(), outputFile, extensionName: 'Заглушка' });
      assert.strictEqual(loud.success, false);
      assert.ok(ui.errors.some((message) => message.includes('не применено')), ui.errors.join('|'));
      assert.strictEqual(fs.existsSync(outputFile), false);
      assertNoSecrets(ui.everythingShown(), [REMOTE_DB_PASSWORD]);
    });

    test('load cfe новое: outcome createdInDatabase/appliedToDatabase = true, без предупреждений', async () => {
      const inputFile = file('Расш.cfe');
      fs.writeFileSync(inputFile, cfeFile('Расш', 'данные'));

      const outcome = await runLoadConfigurationFromCf({ ...common(), inputFile, extensionName: 'Расш', silent: true });

      assert.strictEqual(outcome.success, true);
      assert.strictEqual(outcome.createdInDatabase, true);
      assert.strictEqual(outcome.appliedToDatabase, true);
      assert.strictEqual(outcome.extensionNameInDatabase, undefined);
      assert.deepStrictEqual(outcome.warnings ?? [], []);
      assert.strictEqual(ui.emulator.extensions.payloadOf('Расш'), 'данные');
      noCli();
      assertNoSecrets(ui.everythingShown(), [REMOTE_DB_PASSWORD]);
    });

    test('load cfe новое с другим внутренним именем: extensionNameInDatabase и предупреждение E11 в outcome', async () => {
      const inputFile = file('X.cfe');
      fs.writeFileSync(inputFile, cfeFile('Z', 'п'));

      const outcome = await runLoadConfigurationFromCf({ ...common(), inputFile, extensionName: 'X', silent: true });

      assert.strictEqual(outcome.success, true);
      assert.strictEqual(outcome.extensionNameInDatabase, 'Z');
      assert.ok((outcome.warnings ?? []).some((warning) => warning.includes('«Z»') && warning.includes('«X»')), (outcome.warnings ?? []).join('|'));
    });

    test('load cf: applied=false, created=false (применение — отдельный шаг UI)', async () => {
      const inputFile = file('main.cf');
      fs.writeFileSync(inputFile, cfFile('новая'));

      const outcome = await runLoadConfigurationFromCf({ ...common(), inputFile, silent: true });

      assert.strictEqual(outcome.success, true);
      assert.notStrictEqual(outcome.createdInDatabase, true);
      assert.notStrictEqual(outcome.appliedToDatabase, true);
      assert.strictEqual(ui.emulator.extensions.mainPending, cfFile('новая'));
    });

    test('load: отказ агента (пустой UnknownError + log) → success=false, failureReason из log, команда update не отправлена', async () => {
      ui.emulator.extensions.addExtension('Расш');
      ui.emulator.extensions.emptyUnknownErrorOn((command) => command.command === 'config load-cfg', 'Версия расширения не поддерживается');
      const inputFile = file('Расш.cfe');
      fs.writeFileSync(inputFile, cfeFile('Расш'));

      const outcome = await runLoadConfigurationFromCf({ ...common(), inputFile, extensionName: 'Расш', silent: true });

      assert.strictEqual(outcome.success, false);
      assert.ok(outcome.failureReason?.includes('Версия расширения не поддерживается'), outcome.failureReason);
      assert.ok(!ui.commandLog().some((line) => line.startsWith('config update-db-cfg')));
    });

    test('обрыв агента: failureReason — E1 (соединение потеряно), outcome без исключения', async () => {
      ui.emulator.extensions.crashOn((command) => command.command === 'config dump-cfg', 'drop');
      const outcome = await runDumpConfigurationToCf({ ...common(), outputFile: file('main.cf'), silent: true });
      assert.strictEqual(outcome.success, false);
      assert.ok(outcome.failureReason?.includes('Соединение с агентом конфигуратора потеряно'), outcome.failureReason);
    });

    test('валидация ПЕРВОЙ: файл существует без overwrite / входной файл отсутствует / неверный суффикс — отказ до агента', async () => {
      const existing = file('есть.cf');
      fs.writeFileSync(existing, 'x');
      await assert.rejects(runDumpConfigurationToCf({ ...common(), outputFile: existing, silent: true }), /существует|overwrite/i);
      await assert.rejects(runLoadConfigurationFromCf({ ...common(), inputFile: file('нет-такого.cf'), silent: true }), /не найден/i);
      const wrongSuffix = file('Расш.cf');
      fs.writeFileSync(wrongSuffix, cfeFile('Расш'));
      await assert.rejects(runLoadConfigurationFromCf({ ...common(), inputFile: wrongSuffix, extensionName: 'Расш', silent: true }), /\.cfe/);
      const empty = file('пустой.cf');
      fs.writeFileSync(empty, '');
      await assert.rejects(runLoadConfigurationFromCf({ ...common(), inputFile: empty, silent: true }));

      assert.deepStrictEqual(ui.commandLog(), [], 'ни одной команды агента (и ни одного connect-ib)');
    });

    test('пакет dump-all: результат {success, report}; файлы выгружены, CLI не запускался', async () => {
      ui.emulator.extensions.addExtension('А', 'a');
      ui.emulator.extensions.addExtension('Б', 'b');
      const outputDir = path.join(ui.workDir, 'пакет');
      fs.mkdirSync(outputDir);

      const result = await runDumpAllExtensionsToCfe({ ...common(), outputDir, silent: true });

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.report?.items.map((item) => item.status), ['ok', 'ok']);
      assert.strictEqual(fs.existsSync(path.join(outputDir, 'cfe-dump.json')), true);
      noCli();
      assertNoSecrets(ui.everythingShown(), [REMOTE_DB_PASSWORD]);
    });

    test('пакет load-all: createMissing → у нового appliedToDatabase; обрыв на загрузке → success=false и report.abortReason', async () => {
      const writeCatalog = (dir: string, name: string, payload: string): void => {
        fs.mkdirSync(dir, { recursive: true });
        const fileName = cfeFileNameForExtension(name);
        const content = cfeFile(name, payload);
        fs.writeFileSync(path.join(dir, fileName), content);
        writeCfeManifest(dir, {
          version: 1,
          createdAt: '2020-01-01T00:00:00.000Z',
          items: [{ extensionName: name, fileName, status: 'ok', sizeBytes: Buffer.byteLength(content) }],
        });
      };
      const first = path.join(ui.workDir, 'вход-1');
      const second = path.join(ui.workDir, 'вход-2');
      writeCatalog(first, 'Новое', 'н');
      writeCatalog(second, 'Второе', 'в');

      const created = await runLoadAllExtensionsFromCfe({ ...common(), inputDir: first, createMissing: true, silent: true });
      assert.strictEqual(created.success, true);
      assert.strictEqual(created.report?.items[0].appliedToDatabase, true);
      assert.strictEqual(ui.emulator.extensions.payloadOf('Новое'), 'н');

      ui.emulator.extensions.crashOn((command) => command.command === 'config load-cfg', 'drop');
      const broken = await runLoadAllExtensionsFromCfe({ ...common(), inputDir: second, createMissing: true, silent: true });
      assert.strictEqual(broken.success, false);
      assert.ok(broken.report?.abortReason?.includes('Соединение с агентом конфигуратора потеряно'), broken.report?.abortReason);
      assertNoSecrets(ui.everythingShown(), [REMOTE_DB_PASSWORD]);
    });
  });
}

suite('Раннеры CF/CFE в удалённом режиме: вид базы больше не причина отказа (было Н51), remote + batch — по-прежнему ошибка', function () {
  this.timeout(120_000);
  let ui: Awaited<ReturnType<typeof openRemote>>;

  setup(async () => { ui = await openRemote(); });
  teardown(async () => { await ui.dispose(); });

  const writeEnv = (ibConnection: string): void => {
    fs.writeFileSync(path.join(ui.harness.root, 'env.json'), JSON.stringify({ default: { '--ibconnection': ibConnection } }), 'utf-8');
  };

  const bases: [string, string][] = [
    ['файловая база /F (путь «на сервере»)', '/FD:/Базы/Сервер'],
    ['петлевой сервер /S localhost/base', '/Slocalhost/base'],
    ['петлевой сервер 127.0.0.1:1541', '/S 127.0.0.1:1541/base'],
  ];
  for (const [title, ibConnection] of bases) {
    test(`${title}: операция ВЫПОЛНЯЕТСЯ через агента`, async () => {
      writeEnv(ibConnection);
      const outputFile = path.join(ui.workDir, 'main.cf');

      const outcome = await runDumpConfigurationToCf({ workspaceFolder: ui.folder, outputChannel: ui.channel, outputFile, silent: true });

      assert.strictEqual(outcome.success, true, outcome.failureReason);
      assert.ok(fs.existsSync(outputFile));
      assert.ok(!ui.errors.some((message) => message.includes('v8vscedit.agent.location')), ui.errors.join('|'));
    });
  }

  test('remote + batch: прежняя ошибка resolveAgentExecutionMode, команд агента нет', async () => {
    await setOperationMode('batch');
    const outputFile = path.join(ui.workDir, 'main.cf');

    await assert.rejects(
      runDumpConfigurationToCf({ workspaceFolder: ui.folder, outputChannel: ui.channel, outputFile, silent: true }),
      /v8vscedit\.agent\.location/
    );
    await assert.rejects(
      runLoadAllExtensionsFromCfe({ workspaceFolder: ui.folder, outputChannel: ui.channel, inputDir: ui.workDir, silent: true }),
      /v8vscedit\.agent\.location/
    );

    assert.deepStrictEqual(ui.commandLog(), []);
    assert.strictEqual(ui.harness.server.clientCount, 0, 'к агенту не подключались');
  });
});
