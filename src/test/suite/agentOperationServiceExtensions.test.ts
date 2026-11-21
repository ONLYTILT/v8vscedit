/**
 * Фасад `AgentOperationService` для расширений и CF/CFE-файлов (plan-remote-extensions §3.3, §4, §7.3) через СЕССИЮ:
 * `connect-ib` один раз на операцию, `disconnect-ib` + сброс транспорта при любом исключении, переподключение
 * после обрыва. Параметризация `location`: `local` — фабрика транспорта поверх эмулятора + локальное хранилище,
 * `remote` — настоящий ssh2 (shell + SFTP). Подменяется только агент 1С.
 *
 * Guard применения (ловушка Э28: `update-db-cfg --extension=<нет>` отвечает успехом молча): для cfe перед
 * `update-db-cfg` — `properties get --all-extensions`; после применения — сверка списком: имя берётся из файла
 * (ФАКТ Э29, П4), цель `cfe/<X>` может перестать существовать → предупреждение E11 в `result.warnings`.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AgentConnectionLostError } from '../../infra/agent';
import { cfFile, cfeFile, PROPERTIES_GET_ALL } from './support/agentExtensionsEmulator';
import { createServiceStand, type ServiceLocation, type ServiceStand } from './support/agentExtensionsStands';

const CONNECT = 'common connect-ib';
const DISCONNECT = 'common disconnect-ib';
const UPDATE_X = 'config update-db-cfg --extension=Расш';

const cfeTarget = (stand: ServiceStand, name: string) => ({ kind: 'cfe' as const, name, extensionName: name, rootPath: stand.cfRoot });

for (const location of ['local', 'remote'] as ServiceLocation[]) {
  suite(`AgentOperationService: расширения и CF/CFE через агента [${location}]`, function () {
    this.timeout(120_000);
    let stand: ServiceStand;

    setup(async () => { stand = await createServiceStand(location); });
    teardown(async () => { await stand.dispose(); });

    test('listDatabaseExtensions: connect-ib и один properties get; результат отсортирован, без файлов', async () => {
      stand.emulator.extensions.addExtension('Б');
      stand.emulator.extensions.addExtension('А');

      const infos = await stand.service.listDatabaseExtensions();

      assert.deepStrictEqual(infos.map((info) => info.name), ['А', 'Б']);
      assert.deepStrictEqual(stand.commandLog(), [CONNECT, PROPERTIES_GET_ALL]);
    });

    test('ОДНО расширение в базе (ответ без success, ФАКТ Э30–Э31) → список из одного, без срока и без потери связи', async () => {
      stand.emulator.extensions.addExtension('Единственное');

      const infos = await stand.service.listDatabaseExtensions();

      assert.deepStrictEqual(infos.map((info) => info.name), ['Единственное']);
      assert.strictEqual(stand.service.isInfoBaseConnected(), true, 'агент исправен: соединение и подключение ИБ живы');
      // Guard E6 перед update-db-cfg с одним расширением в базе — тот же ответ, операция проходит.
      await stand.service.updateDatabaseConfiguration(cfeTarget(stand, 'Единственное'));
      assert.ok(stand.commandLog().includes('config update-db-cfg --extension=Единственное'), stand.commandLog().join(' | '));
      assert.strictEqual(stand.commandLog().filter((line) => line === CONNECT).length, 1, 'переподключений не было');
    });

    test('dumpCfFile cfe: [connect-ib, properties get, dump-cfg]; файл на диске = содержимое эмулятора', async () => {
      stand.emulator.extensions.addExtension('Расш', 'данные');
      const outputFile = path.join(stand.workDir, 'Расш.cfe');

      const result = await stand.service.dumpCfFile({ outputFile, extensionName: 'Расш', overwrite: false });

      const log = stand.commandLog();
      assert.deepStrictEqual([log[0], log[1]], [CONNECT, PROPERTIES_GET_ALL]);
      assert.match(log[2], /^config dump-cfg --file=exchange\/cffile-[^/\s]+\/payload\.cfe --extension=Расш$/);
      assert.strictEqual(log.length, 3);
      assert.strictEqual(fs.readFileSync(outputFile, 'utf-8'), cfeFile('Расш', 'данные'));
      assert.strictEqual(result.outputFile, outputFile);
      assert.deepStrictEqual(stand.serverExchange(), []);
    });

    test('loadCfFile cfe НОВОГО: [connect-ib, properties get, load-cfg, update-db-cfg, properties get]; созданное расширение применено', async () => {
      const inputFile = stand.writeWork('Расш.cfe', cfeFile('Расш', 'п'));

      const result = await stand.service.loadCfFile({ inputFile, extensionName: 'Расш' });

      const log = stand.commandLog();
      assert.deepStrictEqual(log.map((line) => line.split(' --')[0]), [
        CONNECT, 'config extensions properties get', 'config load-cfg', 'config update-db-cfg', 'config extensions properties get',
      ]);
      assert.strictEqual(log[3], UPDATE_X);
      assert.strictEqual(result.createdInDatabase, true);
      assert.strictEqual(result.appliedToDatabase, true);
      assert.strictEqual(stand.emulator.extensions.payloadOf('Расш'), 'п');
    });

    test('loadCfFile cf: load-cfg без --extension; в базе pending, update не выполнялся', async () => {
      const inputFile = stand.writeWork('main.cf', cfFile('новая'));
      await stand.service.loadCfFile({ inputFile });
      const log = stand.commandLog();
      assert.deepStrictEqual(log.map((line) => line.split(' --')[0]), [CONNECT, 'config load-cfg']);
      assert.strictEqual(stand.emulator.extensions.mainPending, cfFile('новая'));
    });

    test('dumpAllExtensionsToCfe / loadAllExtensionsFromCfe: пакеты идут через сессию с одним connect-ib', async () => {
      stand.emulator.extensions.addExtension('А', 'a');
      stand.emulator.extensions.addExtension('Б', 'b');
      const outputDir = path.join(stand.workDir, 'пакет');
      fs.mkdirSync(outputDir);

      const dumped = await stand.service.dumpAllExtensionsToCfe({ outputDir, overwrite: false });
      assert.deepStrictEqual(dumped.items.map((item) => item.status), ['ok', 'ok']);

      const loaded = await stand.service.loadAllExtensionsFromCfe({ inputDir: outputDir, createMissing: false });
      assert.deepStrictEqual(loaded.items.map((item) => item.status), ['ok', 'ok']);
      assert.strictEqual(stand.commandLog().filter((line) => line === CONNECT).length, 1);
    });

    // ── Guard применения ─────────────────────────────────────────────────

    test('updateDatabaseConfiguration(cfe X) при отсутствии X → E6, update-db-cfg НЕ отправлен', async () => {
      stand.emulator.extensions.addExtension('Другое');

      await assert.rejects(stand.service.updateDatabaseConfiguration(cfeTarget(stand, 'Расш')), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('«Расш»') && error.message.includes('применять нечего'), error.message);
        return true;
      });

      assert.deepStrictEqual(stand.commandLog().slice(0, 2), [CONNECT, PROPERTIES_GET_ALL]);
      assert.ok(!stand.commandLog().some((line) => line.startsWith('config update-db-cfg')));
      assert.ok(stand.commandLog().includes(DISCONNECT), 'failure path: база отпущена');
    });

    test('updateDatabaseConfiguration(cfe X) при заглушке X → update-db-cfg отправлен (guard: заглушка существует); заглушка осталась → E12', async () => {
      stand.emulator.extensions.addStub('Расш');
      // Политика сверки едина с загрузкой нового расширения: «применили, а применённого нет» — ошибка, а не успех.
      await assert.rejects(stand.service.updateDatabaseConfiguration(cfeTarget(stand, 'Расш')), (error: unknown) => {
        assert.ok(error instanceof Error && error.message.includes('После применения расширения «Расш»') && error.message.includes('заглушка'), String(error));
        return true;
      });
      assert.ok(stand.commandLog().includes(UPDATE_X));
    });

    test('сбой сверки списком ПОСЛЕ применения — предупреждение, применение не превращается в отказ', async () => {
      stand.emulator.extensions.addExtension('Расш');
      stand.emulator.onCommand = (command) => {
        if (command.command === 'config update-db-cfg') {
          stand.emulator.extensions.emptyUnknownErrorOn((next) => next.command === 'config extensions', 'Список недоступен');
        }
      };

      const result = await stand.service.updateDatabaseConfiguration(cfeTarget(stand, 'Расш'));

      const warnings = (result.warnings ?? []).join(' | ');
      assert.ok(warnings.includes('проверить результат по списку расширений не удалось') && warnings.includes('Список недоступен'), warnings);
    });

    test('updateDatabaseConfiguration(cfe X) существующего: [connect-ib, properties get, update-db-cfg, properties get]', async () => {
      stand.emulator.extensions.addExtension('Расш');
      const result = await stand.service.updateDatabaseConfiguration(cfeTarget(stand, 'Расш'));
      assert.deepStrictEqual(stand.commandLog(), [CONNECT, PROPERTIES_GET_ALL, UPDATE_X, PROPERTIES_GET_ALL]);
      assert.deepStrictEqual(result.warnings ?? [], []);
    });

    test('updateDatabaseConfiguration(cf): properties get НЕ отправляется — только update-db-cfg', async () => {
      await stand.service.updateDatabaseConfiguration({ kind: 'cf', name: 'Основная', rootPath: stand.cfRoot });
      assert.deepStrictEqual(stand.commandLog(), [CONNECT, 'config update-db-cfg']);
    });

    test('Э29, П4: существующее X применено файлом с внутренним именем Z → X исчезло, E11 в warnings (цель cfe/X больше не существует)', async () => {
      stand.emulator.extensions.addExtension('Расш', 'старое');
      await stand.service.loadCfFile({ inputFile: stand.writeWork('Z.cfe', cfeFile('Другое', 'новое')), extensionName: 'Расш' });

      const result = await stand.service.updateDatabaseConfiguration(cfeTarget(stand, 'Расш'));

      assert.deepStrictEqual(stand.emulator.extensions.names(), ['Другое']);
      const warnings = (result.warnings ?? []).join('\n');
      assert.ok(warnings.includes('«Другое»') && warnings.includes('«Расш»'), warnings);
      assert.ok(/cfe\/Расш|цел[ьи]/i.test(warnings), `предупреждение называет потерянную цель проекта: ${warnings}`);
    });

    // ── Сбои и сессия ────────────────────────────────────────────────────

    test('dump-cfg упал (пустой UnknownError + log, мусор 16 байт): текст из log, цель не создана, сервер убран, disconnect-ib выполнен', async () => {
      stand.emulator.extensions.dumpLeavesGarbage = true;
      stand.emulator.extensions.emptyUnknownErrorOn((command) => command.command === 'config dump-cfg', 'Диск агента переполнен');
      const outputFile = path.join(stand.workDir, 'main.cf');

      await assert.rejects(stand.service.dumpCfFile({ outputFile, overwrite: false }), (error: unknown) => {
        assert.ok(error instanceof Error && error.message.includes('Диск агента переполнен'), String(error));
        return true;
      });

      assert.strictEqual(fs.existsSync(outputFile), false);
      assert.deepStrictEqual(stand.serverExchange(), []);
      const log = stand.commandLog();
      assert.ok(log.indexOf(DISCONNECT) > log.findIndex((line) => line.startsWith('config dump-cfg')), log.join('\n'));
      assert.strictEqual(stand.service.isInfoBaseConnected(), false);
    });

    test('обрыв во время dump-cfg → E1; следующая операция начинается с connect-ib на новом соединении', async () => {
      stand.emulator.extensions.addExtension('Расш');
      stand.emulator.extensions.crashOn((command) => command.command === 'config dump-cfg', 'drop');

      await assert.rejects(
        stand.service.dumpCfFile({ outputFile: path.join(stand.workDir, 'Расш.cfe'), extensionName: 'Расш', overwrite: false }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes('Соединение с агентом конфигуратора потеряно') && error.message.includes('«config dump-cfg»'), error.message);
          return true;
        }
      );
      assert.strictEqual(stand.service.isInfoBaseConnected(), false);

      const infos = await stand.service.listDatabaseExtensions();

      assert.deepStrictEqual(infos.map((info) => info.name), ['Расш']);
      assert.strictEqual(stand.commandLog().filter((line) => line === CONNECT).length, 2, 'второй connect-ib — после обрыва');
    });

    test('обрыв во время load-cfg нового → E1 с «проверьте состояние расширения»; следующая операция работает', async () => {
      stand.emulator.extensions.crashOn((command) => command.command === 'config load-cfg', 'drop');

      await assert.rejects(
        stand.service.loadCfFile({ inputFile: stand.writeWork('Расш.cfe', cfeFile('Расш')), extensionName: 'Расш' }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes('проверьте состояние расширения «Расш»'), error.message);
          return true;
        }
      );

      await stand.service.listDatabaseExtensions();
      assert.strictEqual(stand.commandLog().filter((line) => line === CONNECT).length, 2);
    });

    test('зависание списка за срок (в `local` — через AgentConnectionLostError(no-response) эмулятора)', async function () {
      if (location === 'remote') {
        // Срок короткой команды — константа 30–60 с: реальное ожидание недопустимо; сам срок на настоящем ssh2 проверен
        // в agentTransportFailure.test.ts малым deadlineMs.
        this.skip();
      }
      stand.emulator.extensions.crashOn((command) => command.raw === PROPERTIES_GET_ALL, 'hang');
      await assert.rejects(
        stand.service.listDatabaseExtensions(),
        (error: unknown) => error instanceof AgentConnectionLostError && error.lossKind === 'no-response'
      );
    });
  });
}
