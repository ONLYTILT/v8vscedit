/**
 * Одиночный обмен CF/CFE-файлом через агента (infra/agent/extensions/AgentCfFileExchange.ts), §4.2/§4.3 плана + ФАКТ Э29.
 *
 * Параметризация: хранилище `local` (каталог агента) и `sftp` (настоящий ssh2.Server), цель `cf` и `cfe`.
 * Подменяется только агент 1С (эмулятор). Журнал команд — `exec.log` (маркер `<reconnect>` — переподключение ИБ).
 *
 * Правила, на которых держатся проверки:
 *  - файл обмена на сервере всегда ASCII (`payload.cf|payload.cfe`) в `exchange/cffile-<projectId>-<op>`;
 *  - выгрузка скачивается потоком в staging рядом с целью и переносится ТОЛЬКО после полного скачивания;
 *  - загрузка НОВОГО расширения без немедленного `update-db-cfg` оставляет заглушку (Э28) — применение в той же операции;
 *  - заглушка в имени загрузки — не отказ (Э29, П3): load → update → сверка списком;
 *  - имя после применения берётся из файла (Э29, П4): `renamed` → предупреждение E11;
 *  - зависание/обрыв — AgentConnectionLostError, E1 с «проверьте состояние …»;
 *  - отмена после `load-cfg` нового расширения НЕ прерывает `update-db-cfg` (выбранная политика: успех с предупреждением).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AgentConnectionLostError } from '../../infra/agent';
import {
  cfExchangeDir,
  dumpCfFileViaAgent,
  loadCfFileViaAgent,
  pruneCfExchangeLeftovers,
} from '../../infra/agent/extensions/AgentCfFileExchange';
import type { AgentFileStore, AgentStreamOptions } from '../../infra/agent/files/AgentFileStore';
import { AgentSyncCancelledError } from '../../infra/agent/sync/SyncContext';
import { cfFile, cfeFile, PROPERTIES_GET_ALL } from './support/agentExtensionsEmulator';
import { RECONNECT_MARKER, createExtensionsStand, type ExtensionsStand } from './support/agentExtensionsStands';
import { CountingAgentFileStore, DelegatingAgentFileStore } from './support/delegatingAgentFileStore';
import type { HarnessKind } from './support/agentSyncHarness';

const MIB = 1024 * 1024;

class CancelOnTransferStore extends DelegatingAgentFileStore {
  constructor(inner: AgentFileStore, private readonly cancellation: () => { isCancellationRequested: boolean }, private readonly on: 'download' | 'upload') {
    super(inner);
  }
  override downloadToFile(rel: string, localPath: string, options?: AgentStreamOptions): Promise<void> {
    if (this.on === 'download') {
      this.cancellation().isCancellationRequested = true;
    }
    return super.downloadToFile(rel, localPath, options);
  }
  override uploadFromFile(localPath: string, rel: string, options?: AgentStreamOptions): Promise<void> {
    if (this.on === 'upload') {
      this.cancellation().isCancellationRequested = true;
    }
    return super.uploadFromFile(localPath, rel, options);
  }
}

/** Хранилище, у которого не удаляется каталог обмена операции (права на сервере, занятый файл). */
class FailingExchangeRemoveStore extends DelegatingAgentFileStore {
  override remove(rel: string, options?: { readonly recursive?: boolean }): Promise<void> {
    if (rel.startsWith('exchange/cffile-')) {
      return Promise.reject(new Error('каталог занят'));
    }
    return super.remove(rel, options);
  }
}

const DUMP = /^config dump-cfg /;
const LOAD = /^config load-cfg /;
const UPDATE = /^config update-db-cfg/;
const only = (log: readonly string[], pattern: RegExp): string[] => log.filter((line) => pattern.test(line));

suite('AgentCfFileExchange: cfExchangeDir и pruneCfExchangeLeftovers', () => {
  test('cfExchangeDir: exchange/cffile-<projectId>-<opId>', () => {
    assert.strictEqual(cfExchangeDir('proj1', 'op-7'), 'exchange/cffile-proj1-op-7');
  });
});

for (const kind of ['local', 'sftp'] as HarnessKind[]) {
  suite(`AgentCfFileExchange [${kind}]`, function () {
    this.timeout(120_000);
    let stand: ExtensionsStand;
    let counting: CountingAgentFileStore | undefined;
    let wrap: ((store: AgentFileStore) => AgentFileStore) | undefined;

    const open = async (): Promise<void> => {
      stand = await createExtensionsStand(kind, { wrapStore: wrap });
    };
    setup(() => { counting = undefined; wrap = undefined; });
    teardown(async () => { await stand.dispose(); });

    const counted = (): CountingAgentFileStore => {
      assert.ok(counting, 'хранилище-счётчик не создано');
      return counting;
    };
    const dumpRequest = (name: string, extensionName?: string, overwrite = false) =>
      ({ outputFile: path.join(stand.workDir, name), extensionName, overwrite });

    // ── Выгрузка ─────────────────────────────────────────────────────────

    test(`выгрузка cfe существующего: [properties get, dump-cfg --extension], файл = содержимое эмулятора, staging и сервер чисты`, async () => {
      await open();
      stand.emulator.extensions.addExtension('Расш', 'payload-1');
      const request = dumpRequest('Расш.cfe', 'расш');

      const result = await dumpCfFileViaAgent(stand.ctx(), request);

      assert.strictEqual(stand.exec.log.length, 2, stand.exec.log.join('\n'));
      assert.strictEqual(stand.exec.log[0], PROPERTIES_GET_ALL);
      assert.match(
        stand.exec.log[1],
        new RegExp(`^config dump-cfg --file=exchange/cffile-${stand.projectId}-[^/\\s]+/payload\\.cfe --extension=Расш$`),
        'имя расширения — в регистре базы, файл обмена ASCII'
      );
      const expected = cfeFile('Расш', 'payload-1');
      assert.strictEqual(fs.readFileSync(request.outputFile, 'utf-8'), expected);
      assert.deepStrictEqual(result, { outputFile: request.outputFile, sizeBytes: Buffer.byteLength(expected) });
      assert.deepStrictEqual(stand.workFiles(), ['Расш.cfe'], 'staging-файлов нет');
      assert.deepStrictEqual(stand.serverExchange(), [], 'каталог обмена на сервере удалён');
    });

    test('выгрузка cf: без properties get и без --extension; содержимое основной конфигурации', async () => {
      await open();
      stand.emulator.extensions.mainPayload = 'главная';
      const request = dumpRequest('main.cf');

      await dumpCfFileViaAgent(stand.ctx(), request);

      assert.strictEqual(stand.exec.log.length, 1);
      assert.match(stand.exec.log[0], new RegExp(`^config dump-cfg --file=exchange/cffile-${stand.projectId}-[^/\\s]+/payload\\.cf$`));
      assert.strictEqual(fs.readFileSync(request.outputFile, 'utf-8'), cfFile('главная'));
      assert.deepStrictEqual(stand.serverExchange(), []);
    });

    test('выгрузка cf больше порога больших файлов (> 16 МиБ): скачивание потоком, readFile по файлу обмена нет, байты совпадают', async () => {
      wrap = (store) => (counting = new CountingAgentFileStore(store));
      await open();
      const payload = 'ж'.repeat(9 * MIB);
      stand.emulator.extensions.mainPayload = payload;
      const request = dumpRequest('big.cf');

      const result = await dumpCfFileViaAgent(stand.ctx(), request);

      const expected = Buffer.from(cfFile(payload));
      assert.ok(expected.length > 16 * MIB);
      assert.strictEqual(result.sizeBytes, expected.length);
      assert.ok(fs.readFileSync(request.outputFile).equals(expected));
      assert.strictEqual(counted().count('readFile', /payload\.cf$/), 0, 'файл размером с ГБ не читается целиком');
      assert.strictEqual(counted().count('downloadToFile', /payload\.cf$/), 1);
    });

    test('выгрузка cfe: расширения нет в базе → E5, dump-cfg не отправлен, цель не создана', async () => {
      await open();
      stand.emulator.extensions.addExtension('A');
      stand.emulator.extensions.addExtension('B');

      await assert.rejects(dumpCfFileViaAgent(stand.ctx(), dumpRequest('X.cfe', 'X')), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('«X»') && error.message.includes('нет в базе') && error.message.includes('A, B'), error.message);
        return true;
      });
      assert.deepStrictEqual(only(stand.exec.log, DUMP), []);
      assert.deepStrictEqual(stand.workFiles(), []);
    });

    test('выгрузка cfe: заглушка → E3, dump-cfg не отправлен (выгрузка заглушки роняет агента)', async () => {
      await open();
      stand.emulator.extensions.addStub('Заглушка');

      await assert.rejects(dumpCfFileViaAgent(stand.ctx(), dumpRequest('З.cfe', 'Заглушка')), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('не применено') && error.message.includes('выгружать нельзя'), error.message);
        return true;
      });
      assert.deepStrictEqual(only(stand.exec.log, DUMP), []);
      assert.deepStrictEqual(stand.workFiles(), []);
    });

    test('overwrite: false и цель существует → отказ до любых команд агента, файл не тронут', async () => {
      await open();
      const request = dumpRequest('main.cf');
      fs.writeFileSync(request.outputFile, 'прежний');

      await assert.rejects(dumpCfFileViaAgent(stand.ctx(), request), /существует/);

      assert.deepStrictEqual(stand.exec.log, []);
      assert.strictEqual(fs.readFileSync(request.outputFile, 'utf-8'), 'прежний');
    });

    test('overwrite: true — существующий целевой файл заменяется', async () => {
      await open();
      stand.emulator.extensions.addExtension('Расш', 'новое');
      const request = dumpRequest('Расш.cfe', 'Расш', true);
      fs.writeFileSync(request.outputFile, 'старое');

      await dumpCfFileViaAgent(stand.ctx(), request);

      assert.strictEqual(fs.readFileSync(request.outputFile, 'utf-8'), cfeFile('Расш', 'новое'));
      assert.deepStrictEqual(stand.workFiles(), ['Расш.cfe']);
    });

    const noFileModes: ['no-file' | 'empty-file', string][] = [['no-file', 'файла нет'], ['empty-file', '0 байт']];
    for (const [mode, title] of noFileModes) {
      test(`агент вернул success, но ${title} → E8; цель не создана, прежний файл не тронут`, async () => {
        await open();
        stand.emulator.extensions.dumpMode = mode;
        const request = dumpRequest('main.cf', undefined, true);
        fs.writeFileSync(request.outputFile, 'прежний');

        await assert.rejects(dumpCfFileViaAgent(stand.ctx(), request), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes('успешной выгрузке') && error.message.includes('payload.cf'), error.message);
          return true;
        });
        assert.strictEqual(fs.readFileSync(request.outputFile, 'utf-8'), 'прежний');
        assert.deepStrictEqual(stand.workFiles(), ['main.cf']);
        assert.deepStrictEqual(stand.serverExchange(), []);
      });
    }

    test('dump-cfg упал (пустой UnknownError + log) с 16 байтами мусора: текст из log, цель не создана, мусор на сервере убран', async () => {
      await open();
      stand.emulator.extensions.dumpLeavesGarbage = true;
      stand.emulator.extensions.emptyUnknownErrorOn((command) => command.command === 'config dump-cfg', 'Недостаточно прав для выгрузки');
      const request = dumpRequest('main.cf');

      await assert.rejects(dumpCfFileViaAgent(stand.ctx(), request), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('Недостаточно прав для выгрузки'), error.message);
        return true;
      });
      assert.strictEqual(fs.existsSync(request.outputFile), false);
      assert.deepStrictEqual(stand.workFiles(), []);
      assert.deepStrictEqual(stand.serverExchange(), []);
    });

    test('нехватка локального места (шов freeSpace меньше размера) → E9 до скачивания', async () => {
      wrap = (store) => (counting = new CountingAgentFileStore(store));
      await open();
      stand.emulator.extensions.mainPayload = 'x'.repeat(1000);
      const request = dumpRequest('main.cf');

      await assert.rejects(
        dumpCfFileViaAgent(stand.ctx({ freeSpace: () => Promise.resolve(10) }), request),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes('Недостаточно места') && error.message.includes(stand.workDir), error.message);
          return true;
        }
      );
      assert.strictEqual(counted().count('downloadToFile', /payload/), 0, 'скачивание не начиналось');
      assert.deepStrictEqual(stand.workFiles(), []);
      assert.deepStrictEqual(stand.serverExchange(), []);
    });

    test('свободное место неизвестно (undefined) — скачивание идёт', async () => {
      await open();
      const request = dumpRequest('main.cf');
      await dumpCfFileViaAgent(stand.ctx({ freeSpace: () => Promise.resolve(undefined) }), request);
      assert.ok(fs.existsSync(request.outputFile));
    });

    test('отмена до команды: ни одной dump-cfg, цель не создана, сервер чист', async () => {
      await open();
      stand.cancellation.isCancellationRequested = true;

      await assert.rejects(dumpCfFileViaAgent(stand.ctx(), dumpRequest('main.cf')), AgentSyncCancelledError);

      assert.deepStrictEqual(only(stand.exec.log, DUMP), []);
      assert.deepStrictEqual(stand.workFiles(), []);
      assert.deepStrictEqual(stand.serverExchange(), []);
    });

    test('отмена во время скачивания (расширение с кириллицей): AgentSyncCancelledError, staging удалён, цель не создана, сервер чист', async () => {
      wrap = (store) => new CancelOnTransferStore(store, () => stand.cancellation, 'download');
      await open();
      stand.emulator.extensions.addExtension('Расширение_Кириллица', 'п');

      await assert.rejects(
        dumpCfFileViaAgent(stand.ctx(), dumpRequest('Расширение_Кириллица.cfe', 'Расширение_Кириллица')),
        AgentSyncCancelledError
      );

      assert.deepStrictEqual(stand.workFiles(), [], 'ни цели, ни staging-остатка с кириллицей в имени');
      assert.deepStrictEqual(stand.serverExchange(), []);
    });

    test('обрыв во время dump-cfg → E1, цель не создана, сервер чист', async () => {
      await open();
      stand.emulator.extensions.crashOn((command) => command.command === 'config dump-cfg', 'drop');

      await assert.rejects(dumpCfFileViaAgent(stand.ctx(), dumpRequest('main.cf')), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('Соединение с агентом конфигуратора потеряно') && error.message.includes('«config dump-cfg»'), error.message);
        assert.ok(error.message.includes('основной конфигурации'), error.message);
        return true;
      });
      assert.deepStrictEqual(stand.workFiles(), []);
    });

    test('остатки прошлых операций СВОЕГО projectId убираются, чужого и посторонние — нет', async () => {
      await open();
      await stand.store.writeFile(`exchange/cffile-${stand.projectId}-old/payload.cfe`, 'остаток');
      await stand.store.writeFile('exchange/cffile-ДРУГОЙ-old/payload.cfe', 'чужой проект');
      await stand.store.writeFile('exchange/stray/readme.txt', 'посторонний');

      await dumpCfFileViaAgent(stand.ctx(), dumpRequest('main.cf'));

      assert.deepStrictEqual(stand.serverExchange(), ['cffile-ДРУГОЙ-old', 'stray']);
    });

    test('отказ уборки каталога обмена на сервере — строка журнала, выгрузка успешна', async () => {
      wrap = (store) => new FailingExchangeRemoveStore(store);
      await open();
      const request = dumpRequest('main.cf');

      await dumpCfFileViaAgent(stand.ctx(), request);

      assert.ok(fs.existsSync(request.outputFile));
      assert.ok(stand.messages.some((message) => message.includes('Не удалось убрать каталог обмена')), stand.messages.join('|'));
    });

    test('pruneCfExchangeLeftovers напрямую: каталога exchange нет — не ошибка; свои остатки удаляются', async () => {
      await open();
      await pruneCfExchangeLeftovers(stand.store, stand.projectId);
      await stand.store.writeFile(`exchange/cffile-${stand.projectId}-1/payload.cf`, 'x');
      await stand.store.writeFile(`exchange/cffile-${stand.projectId}-2/payload.cf`, 'y');
      await pruneCfExchangeLeftovers(stand.store, stand.projectId);
      assert.deepStrictEqual(stand.serverExchange(), []);
    });

    // ── Загрузка ─────────────────────────────────────────────────────────

    const loadRequest = (name: string, content: string | Buffer, extensionName?: string) =>
      ({ inputFile: stand.writeWork(name, content), extensionName });

    test('загрузка cfe НОВОГО: [properties get, load-cfg, update-db-cfg, properties get]; создано и применено; сервер чист', async () => {
      await open();
      stand.emulator.extensions.addExtension('Старое');

      const result = await loadCfFileViaAgent(stand.ctx(), loadRequest('Новое.cfe', cfeFile('Новое', 'данные'), 'Новое'));

      assert.strictEqual(stand.exec.log.length, 4, stand.exec.log.join('\n'));
      assert.strictEqual(stand.exec.log[0], PROPERTIES_GET_ALL);
      assert.match(stand.exec.log[1], new RegExp(`^config load-cfg --file=exchange/cffile-${stand.projectId}-[^/\\s]+/payload\\.cfe --extension=Новое$`));
      assert.strictEqual(stand.exec.log[2], 'config update-db-cfg --extension=Новое');
      assert.strictEqual(stand.exec.log[3], PROPERTIES_GET_ALL);
      assert.strictEqual(result.createdInDatabase, true);
      assert.strictEqual(result.appliedToDatabase, true);
      assert.strictEqual(result.extensionName, 'Новое');
      assert.deepStrictEqual(result.warnings, []);
      assert.strictEqual(stand.emulator.extensions.payloadOf('Новое'), 'данные');
      assert.deepStrictEqual(stand.serverExchange(), []);
    });

    test('загрузка cfe СУЩЕСТВУЮЩЕГО: без update-db-cfg и без второго properties get; created=false, applied=false', async () => {
      await open();
      stand.emulator.extensions.addExtension('Расш', 'старое');

      const result = await loadCfFileViaAgent(stand.ctx(), loadRequest('Расш.cfe', cfeFile('Расш', 'новое'), 'расш'));

      assert.strictEqual(stand.exec.log.length, 2, stand.exec.log.join('\n'));
      assert.strictEqual(stand.exec.log[0], PROPERTIES_GET_ALL);
      assert.match(stand.exec.log[1], /^config load-cfg .*--extension=Расш$/, 'имя в регистре базы');
      assert.strictEqual(result.createdInDatabase, false);
      assert.strictEqual(result.appliedToDatabase, false);
      assert.deepStrictEqual(only(stand.exec.log, UPDATE), []);
      assert.strictEqual(stand.emulator.extensions.pendingOf('Расш'), cfeFile('Расш', 'новое'), 'файл ждёт применения');
      assert.strictEqual(stand.emulator.extensions.payloadOf('Расш'), 'старое', 'применённое состояние не менялось');
    });

    test('загрузка cf: load-cfg без --extension; без update-db-cfg и без properties get', async () => {
      await open();

      const result = await loadCfFileViaAgent(stand.ctx(), loadRequest('main.cf', cfFile('новая-главная')));

      assert.strictEqual(stand.exec.log.length, 1);
      assert.match(stand.exec.log[0], new RegExp(`^config load-cfg --file=exchange/cffile-${stand.projectId}-[^/\\s]+/payload\\.cf$`));
      assert.strictEqual(result.extensionName, '');
      assert.strictEqual(result.createdInDatabase, false);
      assert.strictEqual(result.appliedToDatabase, false);
      assert.strictEqual(stand.emulator.extensions.mainPending, cfFile('новая-главная'));
      assert.deepStrictEqual(stand.serverExchange(), []);
    });

    test('загрузка cf больше порога больших файлов: передача потоком (uploadFromFile), writeFile по файлу обмена нет', async () => {
      wrap = (store) => (counting = new CountingAgentFileStore(store));
      await open();
      const content = cfFile('ж'.repeat(9 * MIB));
      const request = loadRequest('big.cf', content);

      await loadCfFileViaAgent(stand.ctx(), request);

      assert.ok(Buffer.byteLength(content) > 16 * MIB);
      assert.strictEqual(counted().count('uploadFromFile', /payload\.cf$/), 1);
      assert.strictEqual(counted().count('writeFile', /payload\.cf$/), 0);
      assert.strictEqual(stand.emulator.extensions.mainPending, content, 'агент получил файл целиком');
    });

    test('заглушка в имени (Э29, П3) — НЕ отказ: load → update → сверка; заглушка стала применённым расширением', async () => {
      await open();
      stand.emulator.extensions.addStub('Расш');

      const result = await loadCfFileViaAgent(stand.ctx(), loadRequest('Расш.cfe', cfeFile('Расш', 'п'), 'Расш'));

      assert.deepStrictEqual(
        stand.exec.log.map((line) => line.split(' --')[0]),
        [PROPERTIES_GET_ALL.split(' --')[0], 'config load-cfg', 'config update-db-cfg', PROPERTIES_GET_ALL.split(' --')[0]]
      );
      assert.strictEqual(result.appliedToDatabase, true);
      assert.deepStrictEqual(result.warnings, []);
      assert.strictEqual(stand.emulator.extensions.isStub('Расш'), false);
      assert.strictEqual(stand.emulator.extensions.payloadOf('Расш'), 'п');
    });

    test('заглушка S + файл с внутренним именем X: имя берётся из файла → E11, extensionNameInDatabase = X', async () => {
      await open();
      stand.emulator.extensions.addStub('S');

      const result = await loadCfFileViaAgent(stand.ctx(), loadRequest('X.cfe', cfeFile('X', 'п'), 'S'));

      assert.strictEqual(result.extensionNameInDatabase, 'X');
      assert.ok(result.warnings.some((warning) => warning.includes('«X»') && warning.includes('«S»')), result.warnings.join('|'));
      assert.deepStrictEqual(stand.emulator.extensions.names(), ['X']);
    });

    test('новое имя, файл с другим внутренним именем Z → E11 и extensionNameInDatabase = Z (цель X в базе не появилась)', async () => {
      await open();

      const result = await loadCfFileViaAgent(stand.ctx(), loadRequest('X.cfe', cfeFile('Z', 'п'), 'X'));

      assert.strictEqual(result.extensionNameInDatabase, 'Z');
      assert.strictEqual(result.createdInDatabase, true);
      assert.strictEqual(result.appliedToDatabase, true);
      const warning = result.warnings.join('|');
      assert.ok(warning.includes('Расширение загружено под именем из файла') && warning.includes('«Z»') && warning.includes('«X»'), warning);
      assert.deepStrictEqual(stand.emulator.extensions.names(), ['Z']);
    });

    test('новое, коллизия внутреннего имени (файл Z, а Z уже есть) → E7 с текстом агента и пометкой про заглушку; reconnect', async () => {
      await open();
      stand.emulator.extensions.addExtension('Z');

      await assert.rejects(loadCfFileViaAgent(stand.ctx(), loadRequest('X.cfe', cfeFile('Z', 'п'), 'X')), (error: unknown) => {
        assert.ok(error instanceof Error);
        const text = error.message;
        assert.ok(text.includes('«X»') && text.includes('загружено, но не применено'), text);
        assert.ok(text.includes('Расширение с таким именем уже существует'), text);
        assert.ok(text.includes('заглушк'), text);
        return true;
      });
      assert.strictEqual(stand.exec.log.at(-1), RECONNECT_MARKER, 'после отказа update — переподключение ИБ');
      assert.ok(stand.emulator.extensions.isStub('X'), 'заглушка X осталась в базе');
      assert.deepStrictEqual(stand.serverExchange(), []);
    });

    test('новое: load-cfg упал (пустой UnknownError + log) → текст из log, «неопределённо», reconnect', async () => {
      await open();
      stand.emulator.extensions.stubOnFailedLoad = true;
      stand.emulator.extensions.emptyUnknownErrorOn((command) => command.command === 'config load-cfg', 'Файл расширения повреждён');

      await assert.rejects(loadCfFileViaAgent(stand.ctx(), loadRequest('X.cfe', cfeFile('X'), 'X')), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('Файл расширения повреждён'), error.message);
        assert.ok(error.message.includes('неопределённо') && error.message.includes('«X»'), error.message);
        return true;
      });
      const loadIndex = stand.exec.log.findIndex((line) => line.startsWith('config load-cfg '));
      assert.strictEqual(stand.exec.log[loadIndex + 1], RECONNECT_MARKER);
      assert.deepStrictEqual(only(stand.exec.log, UPDATE), [], 'update после упавшей загрузки не выполняется');
      assert.ok(stand.emulator.extensions.isStub('X'));
    });

    test('новое: отказ переподключения после упавшей load-cfg — в журнал, причина операции прежняя', async () => {
      await open();
      stand.exec.reconnectError = new Error('агент не отвечает на connect-ib');
      stand.emulator.extensions.emptyUnknownErrorOn((command) => command.command === 'config load-cfg', 'Файл расширения повреждён');

      await assert.rejects(loadCfFileViaAgent(stand.ctx(), loadRequest('X.cfe', cfeFile('X'), 'X')), (error: unknown) => {
        assert.ok(error instanceof Error && error.message.includes('Файл расширения повреждён'), String(error));
        return true;
      });
      assert.ok(stand.messages.some((message) => message.includes('Не удалось переподключить') && message.includes('connect-ib')), stand.messages.join('|'));
    });

    test('новое: обрыв во время update-db-cfg → E1 с «проверьте состояние расширения», без E7-текста', async () => {
      await open();
      stand.emulator.extensions.crashOn((command) => command.command === 'config update-db-cfg', 'drop');

      await assert.rejects(loadCfFileViaAgent(stand.ctx(), loadRequest('X.cfe', cfeFile('X'), 'X')), (error: unknown) => {
        assert.ok(error instanceof AgentConnectionLostError, String(error));
        assert.ok(error.message.includes('«config update-db-cfg»') && error.message.includes('проверьте состояние расширения «X»'), error.message);
        assert.ok(!error.message.includes('загружено, но не применено'), error.message);
        return true;
      });
    });

    test('новое: сбой сверки списком ПОСЛЕ применения → успех с предупреждением, применение не теряется', async () => {
      await open();
      stand.emulator.onCommand = (command) => {
        if (command.command === 'config update-db-cfg') {
          stand.emulator.extensions.emptyUnknownErrorOn((next) => next.command === 'config extensions', 'Список недоступен');
        }
      };

      const result = await loadCfFileViaAgent(stand.ctx(), loadRequest('X.cfe', cfeFile('X', 'п'), 'X'));

      assert.strictEqual(result.appliedToDatabase, true);
      assert.ok(result.warnings.some((warning) => warning.includes('Список недоступен')), result.warnings.join('|'));
      assert.strictEqual(stand.emulator.extensions.payloadOf('X'), 'п');
    });

    test('существующее/cf: load-cfg упал → ошибка с текстом агента и оговоркой «часть изменений могла быть применена»; без reconnect-маркера состояния', async () => {
      await open();
      stand.emulator.extensions.addExtension('Расш');
      stand.emulator.extensions.emptyUnknownErrorOn((command) => command.command === 'config load-cfg', 'Ошибка формата');

      await assert.rejects(loadCfFileViaAgent(stand.ctx(), loadRequest('Расш.cfe', cfeFile('Расш'), 'Расш')), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('Ошибка формата') && error.message.includes('часть изменений могла быть применена'), error.message);
        return true;
      });
      assert.deepStrictEqual(only(stand.exec.log, UPDATE), []);
    });

    const afterUpdate: ['ignore' | 'vanish', RegExp][] = [['ignore', /заглушк/], ['vanish', /нет/]];
    for (const [mode, expected] of afterUpdate) {
      test(`новое: после update в списке ${mode === 'ignore' ? 'заглушка' : 'нет имени'} → E12 «неопределённо»`, async () => {
        await open();
        stand.emulator.extensions.updateMode = mode;

        await assert.rejects(loadCfFileViaAgent(stand.ctx(), loadRequest('X.cfe', cfeFile('X'), 'X')), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes('«X»') && error.message.includes('неопределённо'), error.message);
          assert.match(error.message, expected);
          return true;
        });
      });
    }

    test('отмена во время upload → база не тронута: load-cfg не отправлялся, сервер чист', async () => {
      wrap = (store) => new CancelOnTransferStore(store, () => stand.cancellation, 'upload');
      await open();

      await assert.rejects(loadCfFileViaAgent(stand.ctx(), loadRequest('X.cfe', cfeFile('X'), 'X')), AgentSyncCancelledError);

      assert.deepStrictEqual(only(stand.exec.log, LOAD), []);
      assert.deepStrictEqual(only(stand.exec.log, UPDATE), []);
      assert.strictEqual(stand.emulator.extensions.has('X'), false);
      assert.deepStrictEqual(stand.serverExchange(), []);
    });

    test('отмена до загрузки: ни одной команды load-cfg', async () => {
      await open();
      stand.cancellation.isCancellationRequested = true;
      await assert.rejects(loadCfFileViaAgent(stand.ctx(), loadRequest('X.cfe', cfeFile('X'), 'X')), AgentSyncCancelledError);
      assert.deepStrictEqual(only(stand.exec.log, LOAD), []);
    });

    test('отмена ПОСЛЕ load-cfg нового: update-db-cfg всё равно выполнен; итог — успех с предупреждением об отмене', async () => {
      await open();
      stand.emulator.onCommand = (command) => {
        if (command.command === 'config load-cfg') {
          stand.cancellation.isCancellationRequested = true;
        }
      };

      const result = await loadCfFileViaAgent(stand.ctx(), loadRequest('X.cfe', cfeFile('X', 'п'), 'X'));

      assert.strictEqual(only(stand.exec.log, UPDATE).length, 1, 'правило Э28: после load нового — сразу update, иначе заглушка');
      assert.strictEqual(result.appliedToDatabase, true);
      assert.ok(result.warnings.some((warning) => /отмена/i.test(warning) && warning.includes('применен')), result.warnings.join('|'));
      assert.strictEqual(stand.emulator.extensions.isStub('X'), false);
    });

    test('обрыв во время load-cfg → E1 с «проверьте состояние расширения»; для cf — «основной конфигурации»', async () => {
      await open();
      stand.emulator.extensions.crashOn((command) => command.command === 'config load-cfg', 'drop', 2);

      await assert.rejects(loadCfFileViaAgent(stand.ctx(), loadRequest('X.cfe', cfeFile('X'), 'X')), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('Соединение с агентом конфигуратора потеряно') && error.message.includes('проверьте состояние расширения «X»'), error.message);
        return true;
      });
      await assert.rejects(loadCfFileViaAgent(stand.ctx(), loadRequest('main.cf', cfFile('м'))), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('основной конфигурации'), error.message);
        return true;
      });
    });

    test('зависание агента на коротком properties get в начале загрузки → AgentConnectionLostError(no-response), upload не начинался', async () => {
      wrap = (store) => (counting = new CountingAgentFileStore(store));
      await open();
      stand.emulator.extensions.crashOn((command) => command.raw === PROPERTIES_GET_ALL, 'hang');

      await assert.rejects(
        loadCfFileViaAgent(stand.ctx(), loadRequest('X.cfe', cfeFile('X'), 'X')),
        (error: unknown) => error instanceof AgentConnectionLostError && error.lossKind === 'no-response'
      );
      assert.strictEqual(counted().count('uploadFromFile', /payload/), 0);
    });

    test('остатки прошлых операций своего projectId убираются и перед загрузкой', async () => {
      await open();
      await stand.store.writeFile(`exchange/cffile-${stand.projectId}-old/payload.cf`, 'остаток');
      await stand.store.writeFile('exchange/посторонний/файл.txt', 'не трогать');

      await loadCfFileViaAgent(stand.ctx(), loadRequest('main.cf', cfFile('м')));

      assert.deepStrictEqual(stand.serverExchange(), ['посторонний']);
    });
  });
}
