/**
 * Пакеты «все расширения» через агента (infra/agent/extensions/AgentCfeBatch.ts), §4.4/§4.5 плана + ФАКТ Э29.
 * Параметризация по хранилищу: `local` и `sftp`. Отчёт — тот же `CfeBatchReport`, что у CLI.
 *
 *  - dump: цикл по применённым расширениям; сбой команды элемента — `failed` + reconnect + ПРОДОЛЖЕНИЕ;
 *    заглушки — `failed` (E3) без команды; обрыв — остальные `notAttempted`, `interrupted`, `abortReason`;
 *  - load: остановка на первом отказе (`failedAt.stateUncertain`, reconnect); новое имя — сразу update
 *    (`appliedToDatabase`); заглушка в базе — НЕ отказ (Э29, П3); проверка списком после цикла → `verificationWarnings`.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { dumpAllExtensionsViaAgent, loadAllExtensionsViaAgent } from '../../infra/agent/extensions/AgentCfeBatch';
import { CFE_MANIFEST_FILE_NAME, readCfeManifest, writeCfeManifest, serializeCfeManifest } from '../../infra/cfFile/CfeBatchManifest';
import { cfeFileNameForExtension } from '../../infra/cfFile/CfeBatchNaming';
import { resolveDumpStagingPath } from '../../infra/cfFile/CfFileValidation';
import type { CfeBatchReport } from '../../infra/cfFile/CfeBatchReport';
import { cfeFile, PROPERTIES_GET_ALL } from './support/agentExtensionsEmulator';
import { RECONNECT_MARKER, createExtensionsStand, type ExtensionsStand } from './support/agentExtensionsStands';
import type { HarnessKind } from './support/agentSyncHarness';

const DUMP = /^config dump-cfg /;
const LOAD = /^config load-cfg /;
const UPDATE = /^config update-db-cfg/;
const only = (log: readonly string[], pattern: RegExp): string[] => log.filter((line) => pattern.test(line));
const statuses = (report: CfeBatchReport): string[] => report.items.map((item) => `${item.extensionName}:${item.status}`);

for (const kind of ['local', 'sftp'] as HarnessKind[]) {
  suite(`AgentCfeBatch [${kind}]`, function () {
    this.timeout(120_000);
    let stand: ExtensionsStand;
    let dir: string;

    setup(async () => {
      stand = await createExtensionsStand(kind);
      dir = path.join(stand.workDir, 'пакет');
      fs.mkdirSync(dir, { recursive: true });
    });
    teardown(async () => { await stand.dispose(); });

    const dumpCommandOf = (name: string) => (command: { command: string; options: Readonly<Record<string, string | true>> }): boolean =>
      command.command === 'config dump-cfg' && command.options.extension === name;
    const seedThree = (): void => {
      stand.emulator.extensions.addExtension('Альфа', 'a');
      stand.emulator.extensions.addExtension('Бета', 'b');
      stand.emulator.extensions.addExtension('Гамма', 'c');
    };

    // ── Выгрузка всех ────────────────────────────────────────────────────

    test('dump-all: 3 расширения → 3 файла с содержимым эмулятора + манифест только текущего прогона; отчёт ok', async () => {
      seedThree();

      const report = await dumpAllExtensionsViaAgent(stand.ctx(), { outputDir: dir, overwrite: false });

      assert.deepStrictEqual(statuses(report), ['Альфа:ok', 'Бета:ok', 'Гамма:ok']);
      assert.strictEqual(report.operation, 'dump');
      assert.strictEqual(report.interrupted, false);
      assert.strictEqual(report.abortReason, undefined);
      for (const [name, payload] of [['Альфа', 'a'], ['Бета', 'b'], ['Гамма', 'c']]) {
        assert.strictEqual(fs.readFileSync(path.join(dir, cfeFileNameForExtension(name)), 'utf-8'), cfeFile(name, payload));
      }
      const manifest = readCfeManifest(dir);
      assert.deepStrictEqual(manifest?.items.map((item) => `${item.extensionName}:${item.status}`), ['Альфа:ok', 'Бета:ok', 'Гамма:ok']);
      assert.strictEqual(stand.exec.log[0], PROPERTIES_GET_ALL);
      assert.strictEqual(only(stand.exec.log, DUMP).length, 3);
      assert.deepStrictEqual(stand.serverExchange(), []);
      assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => name.startsWith('.')), [], 'staging-остатков нет');
    });

    test('dump-all: один падает (пустой UnknownError + log) → failed с log-текстом, reconnect, остальные ok (продолжение)', async () => {
      seedThree();
      stand.emulator.extensions.emptyUnknownErrorOn(dumpCommandOf('Бета'), 'Объект заблокирован другим пользователем');

      const report = await dumpAllExtensionsViaAgent(stand.ctx(), { outputDir: dir, overwrite: false });

      assert.deepStrictEqual(statuses(report), ['Альфа:ok', 'Бета:failed', 'Гамма:ok']);
      assert.ok(report.items[1].message?.includes('Объект заблокирован другим пользователем'), report.items[1].message);
      assert.strictEqual(report.interrupted, false);
      const failedIndex = stand.exec.log.findIndex((line) => line.includes('--extension=Бета'));
      assert.strictEqual(stand.exec.log[failedIndex + 1], RECONNECT_MARKER, 'после сбоя элемента — переподключение ИБ');
      assert.strictEqual(only(stand.exec.log, DUMP).length, 3, 'третье расширение выгружалось после сбоя второго');
      assert.strictEqual(fs.existsSync(path.join(dir, cfeFileNameForExtension('Бета'))), false);
      assert.deepStrictEqual(readCfeManifest(dir)?.items.map((item) => `${item.extensionName}:${item.status}`), ['Альфа:ok', 'Бета:failed', 'Гамма:ok']);
    });

    test('dump-all: заглушка → failed E3 БЕЗ команды dump-cfg; в манифесте failed; прочие выгружены', async () => {
      stand.emulator.extensions.addExtension('Альфа', 'a');
      stand.emulator.extensions.addStub('Заглушка');

      const report = await dumpAllExtensionsViaAgent(stand.ctx(), { outputDir: dir, overwrite: false });

      assert.deepStrictEqual(statuses(report).sort(), ['Альфа:ok', 'Заглушка:failed']);
      const stubItem = report.items.find((item) => item.extensionName === 'Заглушка');
      assert.ok(stubItem?.message?.includes('не применено') && stubItem.message.includes('выгружать нельзя'), stubItem?.message);
      assert.deepStrictEqual(only(stand.exec.log, DUMP).filter((line) => line.includes('Заглушка')), []);
      assert.strictEqual(
        readCfeManifest(dir)?.items.find((item) => item.extensionName === 'Заглушка')?.status,
        'failed'
      );
    });

    test('dump-all: обрыв на втором → второй failed (E1), третий notAttempted, interrupted, abortReason; третья dump-cfg не отправлялась', async () => {
      seedThree();
      stand.emulator.extensions.crashOn(dumpCommandOf('Бета'), 'drop');

      const report = await dumpAllExtensionsViaAgent(stand.ctx(), { outputDir: dir, overwrite: false });

      assert.deepStrictEqual(statuses(report), ['Альфа:ok', 'Бета:failed', 'Гамма:notAttempted']);
      assert.strictEqual(report.interrupted, true);
      assert.ok(report.abortReason?.includes('аварийно завершился'), report.abortReason);
      assert.ok(report.items[1].message?.includes('аварийно завершился'), report.items[1].message);
      assert.deepStrictEqual(only(stand.exec.log, DUMP).filter((line) => line.includes('Гамма')), []);
      assert.strictEqual(only(stand.exec.log, DUMP).length, 2);
    });

    test('dump-all: отмена между элементами → остальные notAttempted, interrupted', async () => {
      seedThree();
      stand.emulator.onCommand = (command) => {
        if (command.command === 'config dump-cfg') {
          stand.cancellation.isCancellationRequested = true;
        }
      };

      const report = await dumpAllExtensionsViaAgent(stand.ctx(), { outputDir: dir, overwrite: false });

      assert.deepStrictEqual(statuses(report), ['Альфа:ok', 'Бета:notAttempted', 'Гамма:notAttempted']);
      assert.strictEqual(report.interrupted, true);
      assert.strictEqual(only(stand.exec.log, DUMP).length, 1);
    });

    test('dump-all: конфликт имён без overwrite → отказ ДО первой dump-cfg, манифест и файлы не тронуты', async () => {
      seedThree();
      fs.writeFileSync(path.join(dir, cfeFileNameForExtension('Бета')), 'чужой бэкап');
      const manifestText = serializeCfeManifest({ version: 1, createdAt: '2020-01-01T00:00:00.000Z', items: [] });
      fs.writeFileSync(path.join(dir, CFE_MANIFEST_FILE_NAME), manifestText);

      const report = await dumpAllExtensionsViaAgent(stand.ctx(), { outputDir: dir, overwrite: false });

      assert.ok((report.errors ?? []).some((error) => error.includes(cfeFileNameForExtension('Бета'))), (report.errors ?? []).join('|'));
      assert.deepStrictEqual(only(stand.exec.log, DUMP), []);
      assert.strictEqual(fs.readFileSync(path.join(dir, CFE_MANIFEST_FILE_NAME), 'utf-8'), manifestText);
      assert.strictEqual(fs.readFileSync(path.join(dir, cfeFileNameForExtension('Бета')), 'utf-8'), 'чужой бэкап');
    });

    test('dump-all: staging-остатки по маркеру убираются перед выгрузкой, посторонний .part пользователя — нет', async () => {
      stand.emulator.extensions.addExtension('Альфа', 'a');
      const leftover = path.basename(resolveDumpStagingPath(path.join(dir, 'Старое.cfe'), '1-2'));
      fs.writeFileSync(path.join(dir, leftover), 'остаток');
      fs.writeFileSync(path.join(dir, 'мой.part'), 'пользовательский файл');

      const report = await dumpAllExtensionsViaAgent(stand.ctx(), { outputDir: dir, overwrite: true });

      assert.deepStrictEqual(statuses(report), ['Альфа:ok']);
      assert.strictEqual(fs.existsSync(path.join(dir, leftover)), false);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'мой.part'), 'utf-8'), 'пользовательский файл');
    });

    test('dump-all: пустая база → пустой отчёт без команд dump-cfg', async () => {
      const report = await dumpAllExtensionsViaAgent(stand.ctx(), { outputDir: dir, overwrite: false });
      assert.deepStrictEqual(report.items, []);
      assert.deepStrictEqual(only(stand.exec.log, DUMP), []);
    });

    test('dump-all: нехватка локального места (E9) — элемент failed без переподключения ИБ, остальные выгружаются', async () => {
      stand.emulator.extensions.addExtension('Альфа', 'a'.repeat(200));
      stand.emulator.extensions.addExtension('Бета', 'b');
      // Место есть ровно под маленький файл: большой отказывает до скачивания, маленький выгружается.
      const report = await dumpAllExtensionsViaAgent(stand.ctx({ freeSpace: () => Promise.resolve(150) }), { outputDir: dir, overwrite: false });

      assert.deepStrictEqual(statuses(report), ['Альфа:failed', 'Бета:ok']);
      assert.ok(report.items[0].message?.includes('Недостаточно места'), report.items[0].message);
      assert.strictEqual(stand.exec.reconnects, 0, 'отказ вне агента не требует переподключения ИБ');
      assert.strictEqual(fs.existsSync(path.join(dir, cfeFileNameForExtension('Альфа'))), false);
      assert.strictEqual(report.interrupted, false);
      assert.deepStrictEqual(stand.serverExchange(), []);
    });

    // ── Загрузка всех ────────────────────────────────────────────────────

    function writeCatalog(entries: { name: string; internal?: string; payload?: string }[]): void {
      const items = entries.map((entry) => {
        const fileName = cfeFileNameForExtension(entry.name);
        const content = cfeFile(entry.internal ?? entry.name, entry.payload ?? 'п');
        fs.writeFileSync(path.join(dir, fileName), content);
        return { extensionName: entry.name, fileName, status: 'ok' as const, sizeBytes: Buffer.byteLength(content) };
      });
      writeCfeManifest(dir, { version: 1, createdAt: '2020-01-01T00:00:00.000Z', items });
    }

    test('dump-all: отказ переподключения ИБ после сбоя элемента → прогон обрывается (abortReason), остальные notAttempted', async () => {
      seedThree();
      stand.exec.reconnectError = new Error('connect-ib не прошёл');
      stand.emulator.extensions.emptyUnknownErrorOn(dumpCommandOf('Альфа'), 'Сбой выгрузки');

      const report = await dumpAllExtensionsViaAgent(stand.ctx(), { outputDir: dir, overwrite: false });

      assert.deepStrictEqual(statuses(report), ['Альфа:failed', 'Бета:notAttempted', 'Гамма:notAttempted']);
      assert.strictEqual(report.interrupted, true);
      assert.ok(report.abortReason?.includes('переподключить') && report.abortReason.includes('connect-ib не прошёл'), report.abortReason);
    });

    test('load-all: каталога нет → отказ до старта (errors), ни одной команды агента', async () => {
      const report = await loadAllExtensionsViaAgent(stand.ctx(), { inputDir: path.join(dir, 'нет-такого'), createMissing: false });
      assert.ok((report.errors ?? []).some((error) => error.includes('не существует')), (report.errors ?? []).join('|'));
      assert.deepStrictEqual(stand.exec.log, []);
    });

    test('load-all: существующие → load-cfg по каждому, без update-db-cfg; appliedToDatabase не задан', async () => {
      stand.emulator.extensions.addExtension('Альфа', 'старое-a');
      stand.emulator.extensions.addExtension('Бета', 'старое-b');
      writeCatalog([{ name: 'Альфа', payload: 'новое-a' }, { name: 'Бета', payload: 'новое-b' }]);

      const report = await loadAllExtensionsViaAgent(stand.ctx(), { inputDir: dir, createMissing: false });

      assert.deepStrictEqual(statuses(report), ['Альфа:ok', 'Бета:ok']);
      assert.strictEqual(only(stand.exec.log, LOAD).length, 2);
      assert.deepStrictEqual(only(stand.exec.log, UPDATE), []);
      assert.ok(report.items.every((item) => item.appliedToDatabase !== true));
      assert.strictEqual(report.failedAt, undefined);
      assert.strictEqual(stand.emulator.extensions.pendingOf('Альфа'), cfeFile('Альфа', 'новое-a'));
      assert.deepStrictEqual(stand.serverExchange(), []);
    });

    test('load-all: createMissing, новое расширение → load-cfg + сразу update-db-cfg, appliedToDatabase: true', async () => {
      stand.emulator.extensions.addExtension('Альфа');
      writeCatalog([{ name: 'Альфа' }, { name: 'Новое', payload: 'н' }]);

      const report = await loadAllExtensionsViaAgent(stand.ctx(), { inputDir: dir, createMissing: true });

      assert.deepStrictEqual(statuses(report), ['Альфа:ok', 'Новое:ok']);
      assert.strictEqual(report.items.find((item) => item.extensionName === 'Новое')?.appliedToDatabase, true);
      assert.deepStrictEqual(only(stand.exec.log, UPDATE), ['config update-db-cfg --extension=Новое']);
      assert.strictEqual(stand.emulator.extensions.payloadOf('Новое'), 'н');
      assert.strictEqual(report.verificationWarnings === undefined || report.verificationWarnings.length === 0, true);
    });

    test('load-all: без createMissing новое расширение → отказ ДО старта (errors), ни одного load-cfg', async () => {
      stand.emulator.extensions.addExtension('Альфа');
      writeCatalog([{ name: 'Альфа' }, { name: 'Новое' }]);

      const report = await loadAllExtensionsViaAgent(stand.ctx(), { inputDir: dir, createMissing: false });

      assert.ok((report.errors ?? []).length > 0);
      assert.deepStrictEqual(only(stand.exec.log, LOAD), []);
      assert.deepStrictEqual(only(stand.exec.log, UPDATE), []);
    });

    test('load-all: заглушка в базе с именем из каталога — НЕ отказ (Э29, П3): load → update, appliedToDatabase', async () => {
      stand.emulator.extensions.addStub('Заглушка');
      writeCatalog([{ name: 'Заглушка', payload: 'ожила' }]);

      const report = await loadAllExtensionsViaAgent(stand.ctx(), { inputDir: dir, createMissing: false });

      assert.deepStrictEqual(report.errors ?? [], []);
      assert.deepStrictEqual(statuses(report), ['Заглушка:ok']);
      assert.strictEqual(report.items[0].appliedToDatabase, true);
      assert.strictEqual(stand.emulator.extensions.isStub('Заглушка'), false);
      assert.strictEqual(stand.emulator.extensions.payloadOf('Заглушка'), 'ожила');
    });

    test('load-all: второй падает → failedAt.stateUncertain, reconnect, третий notAttempted (стоп на первом отказе)', async () => {
      seedThree();
      writeCatalog([{ name: 'Альфа' }, { name: 'Бета' }, { name: 'Гамма' }]);
      stand.emulator.extensions.emptyUnknownErrorOn(
        (command) => command.command === 'config load-cfg' && command.options.extension === 'Бета',
        'Файл повреждён'
      );

      const report = await loadAllExtensionsViaAgent(stand.ctx(), { inputDir: dir, createMissing: false });

      assert.deepStrictEqual(statuses(report), ['Альфа:ok', 'Бета:failed', 'Гамма:notAttempted']);
      assert.deepStrictEqual(report.failedAt && [report.failedAt.extensionName, report.failedAt.stateUncertain], ['Бета', true]);
      assert.ok(report.items[1].message?.includes('Файл повреждён'), report.items[1].message);
      const failedIndex = stand.exec.log.findIndex((line) => line.includes('--extension=Бета'));
      assert.strictEqual(stand.exec.log[failedIndex + 1], RECONNECT_MARKER);
      assert.strictEqual(only(stand.exec.log, LOAD).length, 2);
    });

    test('load-all: обрыв → failedAt + abortReason, остальные notAttempted, проверка списком не выполняется', async () => {
      seedThree();
      writeCatalog([{ name: 'Альфа' }, { name: 'Бета' }, { name: 'Гамма' }]);
      stand.emulator.extensions.crashOn((command) => command.command === 'config load-cfg' && command.options.extension === 'Бета', 'drop');

      const report = await loadAllExtensionsViaAgent(stand.ctx(), { inputDir: dir, createMissing: false });

      assert.deepStrictEqual(statuses(report), ['Альфа:ok', 'Бета:failed', 'Гамма:notAttempted']);
      assert.strictEqual(report.failedAt?.extensionName, 'Бета');
      assert.ok(report.abortReason?.includes('аварийно завершился'), report.abortReason);
      assert.strictEqual(only(stand.exec.log, LOAD).length, 2);
      assert.strictEqual(only(stand.exec.log, /properties get/).length, 1, 'после обрыва список не запрашивается повторно');
    });

    test('load-all: проверка после цикла — новое имя из файла (renamed) → verificationWarnings, элемент остаётся ok', async () => {
      writeCatalog([{ name: 'Новое', internal: 'Другое' }]);

      const report = await loadAllExtensionsViaAgent(stand.ctx(), { inputDir: dir, createMissing: true });

      assert.deepStrictEqual(statuses(report), ['Новое:ok']);
      assert.strictEqual((report.verificationWarnings ?? []).length, 1);
      const [warning] = report.verificationWarnings ?? [];
      assert.ok(warning.includes('«Другое»') && warning.includes('«Новое»'), warning);
    });

    test('load-all: отказ переподключения после сбоя загрузки → abortReason, сверка не выполняется', async () => {
      seedThree();
      writeCatalog([{ name: 'Альфа' }, { name: 'Бета' }]);
      stand.exec.reconnectError = new Error('connect-ib не прошёл');
      stand.emulator.extensions.emptyUnknownErrorOn((command) => command.command === 'config load-cfg', 'Файл повреждён');

      const report = await loadAllExtensionsViaAgent(stand.ctx(), { inputDir: dir, createMissing: false });

      assert.deepStrictEqual(statuses(report), ['Альфа:failed', 'Бета:notAttempted']);
      assert.strictEqual(report.failedAt?.extensionName, 'Альфа');
      assert.ok(report.abortReason?.includes('connect-ib не прошёл'), report.abortReason);
    });

    test('load-all: новое, отказ update-db-cfg (коллизия имени) — переподключение одно (шаг уже переподключил), failedAt', async () => {
      stand.emulator.extensions.addExtension('Альфа');
      writeCatalog([{ name: 'Новое', internal: 'Альфа' }]);

      const report = await loadAllExtensionsViaAgent(stand.ctx(), { inputDir: dir, createMissing: true });

      assert.deepStrictEqual(statuses(report), ['Новое:failed']);
      assert.ok(report.items[0].message?.includes('загружено, но не применено'), report.items[0].message);
      assert.strictEqual(stand.exec.reconnects, 1, 'повторного переподключения пакетом нет');
    });

    test('load-all: сбой сверки списком после цикла → verificationWarnings, отчёт сохранён', async () => {
      writeCatalog([{ name: 'Новое' }]);
      stand.emulator.onCommand = (command) => {
        if (command.command === 'config update-db-cfg') {
          stand.emulator.extensions.emptyUnknownErrorOn((next) => next.command === 'config extensions', 'Список недоступен');
        }
      };

      const report = await loadAllExtensionsViaAgent(stand.ctx(), { inputDir: dir, createMissing: true });

      assert.deepStrictEqual(statuses(report), ['Новое:ok']);
      assert.ok((report.verificationWarnings ?? []).some((warning) => warning.includes('Список недоступен')), (report.verificationWarnings ?? []).join('|'));
    });

    test('load-all: проверка после цикла — осталась заглушка (update проигнорирован) → verificationWarnings про заглушку', async () => {
      stand.emulator.extensions.updateMode = 'ignore';
      writeCatalog([{ name: 'Новое' }]);

      const report = await loadAllExtensionsViaAgent(stand.ctx(), { inputDir: dir, createMissing: true });

      assert.deepStrictEqual(statuses(report), ['Новое:ok']);
      assert.ok((report.verificationWarnings ?? []).some((warning) => warning.includes('«Новое»') && warning.includes('заглушк')), (report.verificationWarnings ?? []).join('|'));
    });

    test('load-all: отмена между элементами → notAttempted, interrupted', async () => {
      seedThree();
      writeCatalog([{ name: 'Альфа' }, { name: 'Бета' }, { name: 'Гамма' }]);
      stand.emulator.onCommand = (command) => {
        if (command.command === 'config load-cfg') {
          stand.cancellation.isCancellationRequested = true;
        }
      };

      const report = await loadAllExtensionsViaAgent(stand.ctx(), { inputDir: dir, createMissing: false });

      assert.deepStrictEqual(statuses(report), ['Альфа:ok', 'Бета:notAttempted', 'Гамма:notAttempted']);
      assert.strictEqual(report.interrupted, true);
    });
  });
}
