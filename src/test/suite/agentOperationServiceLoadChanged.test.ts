/**
 * `AgentOperationService.loadChanged` (вместо `loadChangedAndUpdate`) и хук `onConfigurationLoaded`:
 * загрузка изменений БЕЗ обновления конфигурации БД и признак «БД отстаёт».
 *
 * Параметризация: `kind ∈ {cf, cfe}` × `location ∈ {local, remote(sftp)}` × `updateDatabase ∈ {true, false}`.
 * Подменяется только агент 1С (эмулятор), файлы — настоящие (локальное хранилище / ssh2+SFTP).
 *
 * Решения оркестратора (ФАКТ Э32):
 *  - для cfe проверка наличия расширения (guard E6) — ДО `load-config-from-files` в ОБОИХ режимах: загрузка
 *    из файлов в отсутствующее имя молча создаёт заглушку;
 *  - хук вызывается сразу после успешной не-skipped загрузки и ДО `update-db-cfg` — обрыв на реструктуризации
 *    оставляет признак выставленным;
 *  - сбой самой загрузки тоже обрабатывается консервативно на стороне раннера (см. тесты раннера).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentConfigurationOperationTarget } from '../../infra/agent';
import { PROPERTIES_GET_ALL, emulatedFailure } from './support/agentExtensionsEmulator';
import { createServiceStand, type ServiceLocation, type ServiceStand } from './support/agentExtensionsStands';

const JOURNAL_NO_UPDATE = 'Конфигурация БД не обновлялась (загрузка без обновления).';
const LOAD = 'config load-config-from-files';
const UPDATE = 'config update-db-cfg';
const CONNECT = 'common connect-ib';

const verbOf = (line: string): string => line.split(' --')[0];
const indexOfVerb = (log: readonly string[], verb: string): number => log.findIndex((line) => verbOf(line) === verb);

type Kind = 'cf' | 'cfe';

function targetOf(stand: ServiceStand, kind: Kind): AgentConfigurationOperationTarget {
  return kind === 'cf'
    ? { kind: 'cf', name: 'Основная', rootPath: stand.cfRoot }
    : { kind: 'cfe', name: 'Расш', extensionName: 'Расш', rootPath: stand.cfRoot };
}

function writeProject(stand: ServiceStand): void {
  fs.mkdirSync(path.join(stand.cfRoot, 'Catalogs'), { recursive: true });
  fs.writeFileSync(path.join(stand.cfRoot, 'Configuration.xml'), '<MetaDataObject/>', 'utf-8');
  fs.writeFileSync(path.join(stand.cfRoot, 'Catalogs', 'Товары.xml'), '<Catalog>v1</Catalog>', 'utf-8');
}

function editProject(stand: ServiceStand, version: string): void {
  fs.writeFileSync(path.join(stand.cfRoot, 'Catalogs', 'Товары.xml'), `<Catalog>${version}</Catalog>`, 'utf-8');
}

for (const location of ['local', 'remote'] as ServiceLocation[]) {
  for (const kind of ['cf', 'cfe'] as Kind[]) {
    for (const updateDatabase of [true, false]) {
      suite(`loadChanged [${location}, ${kind}, updateDatabase=${String(updateDatabase)}]`, function () {
        this.timeout(120_000);
        let stand: ServiceStand;
        let hookCalls = 0;
        let logAtHook: string[] = [];
        const messages: string[] = [];
        const hooks = () => ({
          onMessage: (message: string) => { messages.push(message); },
          onConfigurationLoaded: () => { hookCalls += 1; logAtHook = stand.commandLog(); },
        });

        setup(async () => {
          stand = await createServiceStand(location);
          hookCalls = 0;
          logAtHook = [];
          messages.length = 0;
          writeProject(stand);
          if (kind === 'cfe') {
            stand.emulator.extensions.addExtension('Расш');
          }
        });
        teardown(async () => { await stand.dispose(); });

        test('загрузка изменений: хук ровно один раз, ДО update-db-cfg; update-db-cfg — только при updateDatabase', async () => {
          const result = await stand.service.loadChanged(targetOf(stand, kind), { updateDatabase }, hooks());

          const log = stand.commandLog();
          assert.strictEqual(hookCalls, 1);
          assert.ok(logAtHook.some((line) => verbOf(line) === LOAD), 'к моменту хука загрузка уже выполнена');
          assert.ok(!logAtHook.some((line) => verbOf(line) === UPDATE), 'к моменту хука update-db-cfg ещё не отправлен');
          assert.strictEqual(result.databaseUpdated, updateDatabase);
          assert.deepStrictEqual(result.changedProjectFiles, []);
          assert.notStrictEqual(result.skipped, true);
          if (updateDatabase) {
            assert.ok(indexOfVerb(log, LOAD) < indexOfVerb(log, UPDATE), log.join('\n'));
            assert.ok(!messages.includes(JOURNAL_NO_UPDATE));
          } else {
            assert.strictEqual(indexOfVerb(log, UPDATE), -1, log.join('\n'));
            assert.strictEqual(messages.filter((message) => message === JOURNAL_NO_UPDATE).length, 1, messages.join('|'));
          }
        });

        test('правка после первой загрузки: частичная загрузка (--partial), хук снова один раз', async () => {
          await stand.service.loadFullAndUpdate(targetOf(stand, kind));
          hookCalls = 0;
          editProject(stand, 'v2');
          const before = stand.commandLog().length;

          const result = await stand.service.loadChanged(targetOf(stand, kind), { updateDatabase }, hooks());

          const added = stand.commandLog().slice(before);
          const load = added.find((line) => verbOf(line) === LOAD) ?? '';
          assert.ok(load.includes('--partial'), added.join('\n'));
          assert.strictEqual(hookCalls, 1);
          assert.strictEqual(result.databaseUpdated, updateDatabase);
          assert.strictEqual(added.some((line) => verbOf(line) === UPDATE), updateDatabase);
        });

        test('изменений нет: skipped, хук не вызывается, load/update-db-cfg не отправляются', async () => {
          await stand.service.loadFullAndUpdate(targetOf(stand, kind));
          hookCalls = 0;
          const before = stand.commandLog().length;

          const result = await stand.service.loadChanged(targetOf(stand, kind), { updateDatabase }, hooks());

          const added = stand.commandLog().slice(before);
          assert.strictEqual(result.skipped, true);
          assert.strictEqual(hookCalls, 0);
          assert.ok(!added.some((line) => verbOf(line) === LOAD || verbOf(line) === UPDATE), added.join('\n'));
        });

        test(`изменений нет + updateWhenUnchanged: ${updateDatabase ? 'update-db-cfg выполняется (databaseUpdated), хук не вызывается' : 'прежний skipped, обновления нет'}`, async () => {
          await stand.service.loadFullAndUpdate(targetOf(stand, kind));
          hookCalls = 0;
          const before = stand.commandLog().length;

          const result = await stand.service.loadChanged(targetOf(stand, kind), { updateDatabase, updateWhenUnchanged: true }, hooks());

          const added = stand.commandLog().slice(before);
          assert.strictEqual(hookCalls, 0, 'ничего не загружалось');
          assert.ok(!added.some((line) => verbOf(line) === LOAD));
          if (updateDatabase) {
            assert.notStrictEqual(result.skipped, true);
            assert.strictEqual(result.databaseUpdated, true);
            const updateAt = indexOfVerb(added, UPDATE);
            assert.ok(updateAt >= 0, added.join('\n'));
            if (kind === 'cfe') {
              assert.ok(added.slice(0, updateAt).includes(PROPERTIES_GET_ALL), 'E6 до обновления');
              assert.ok(added.slice(updateAt + 1).includes(PROPERTIES_GET_ALL), 'E11 после обновления');
            }
          } else {
            assert.strictEqual(result.skipped, true);
            assert.ok(!added.some((line) => verbOf(line) === UPDATE));
          }
        });

        test('update-db-cfg упал после загрузки: хук УЖЕ вызван (признак остаётся), исключение наружу', async () => {
          if (!updateDatabase) {
            return;
          }
          stand.emulator.extensions.failOn((command) => command.command === 'config update-db-cfg', emulatedFailure('UnknownError', 'Реструктуризация прервана'));

          await assert.rejects(stand.service.loadChanged(targetOf(stand, kind), { updateDatabase }, hooks()), /Реструктуризация прервана/);

          assert.strictEqual(hookCalls, 1);
          assert.ok(logAtHook.some((line) => verbOf(line) === LOAD));
        });

        test('обрыв соединения на update-db-cfg: хук уже вызван', async () => {
          if (!updateDatabase) {
            return;
          }
          stand.emulator.extensions.crashOn((command) => command.command === 'config update-db-cfg', 'drop');

          await assert.rejects(stand.service.loadChanged(targetOf(stand, kind), { updateDatabase }, hooks()));

          assert.strictEqual(hookCalls, 1);
        });

        test('сбой самой загрузки: исключение наружу, update-db-cfg не отправлен, хук «загружено» не вызван', async () => {
          stand.emulator.failWhen = (command) => (command.command === 'config load-config-from-files'
            ? new Error('Ошибка загрузки файлов')
            : undefined);

          await assert.rejects(stand.service.loadChanged(targetOf(stand, kind), { updateDatabase }, hooks()), /Ошибка загрузки файлов/);

          assert.strictEqual(indexOfVerb(stand.commandLog(), UPDATE), -1);
          assert.strictEqual(hookCalls, 0, 'onConfigurationLoaded — только после УСПЕШНОЙ загрузки');
        });
      });
    }
  }

  suite(`loadChanged cfe: guard наличия расширения ДО загрузки из файлов (Э32) [${location}]`, function () {
    this.timeout(120_000);
    let stand: ServiceStand;
    let hookCalls = 0;
    const target = (): AgentConfigurationOperationTarget => targetOf(stand, 'cfe');

    setup(async () => {
      stand = await createServiceStand(location);
      hookCalls = 0;
      writeProject(stand);
    });
    teardown(async () => { await stand.dispose(); });

    const hooks = () => ({ onConfigurationLoaded: () => { hookCalls += 1; } });

    test('без обновления, расширения нет в базе: отказ текстом §6, load-config-from-files НЕ отправлен, заглушка не создана', async () => {
      stand.emulator.extensions.addExtension('Другое');

      await assert.rejects(stand.service.loadChanged(target(), { updateDatabase: false }, hooks()), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.strictEqual(
          error.message,
          'Расширения "Расш" нет в базе. Загрузка без обновления конфигурации БД оставила бы неприменённую заглушку — выполните «Обновить в базе».'
        );
        return true;
      });

      const log = stand.commandLog();
      assert.strictEqual(indexOfVerb(log, LOAD), -1, log.join('\n'));
      assert.strictEqual(indexOfVerb(log, UPDATE), -1);
      assert.deepStrictEqual(stand.emulator.extensions.stubsCreatedByFileLoad, []);
      assert.strictEqual(stand.emulator.extensions.has('Расш'), false);
      assert.strictEqual(hookCalls, 0);
      assert.ok(log.includes('common disconnect-ib'), 'отказ — как любая ошибка операции: база отпущена');
    });

    test('с обновлением, расширения нет в базе: отказ E6 ДО загрузки (а не после), заглушки нет', async () => {
      await assert.rejects(stand.service.loadChanged(target(), { updateDatabase: true }, hooks()), (error: unknown) => {
        assert.ok(error instanceof Error && error.message.includes('«Расш»') && error.message.includes('применять нечего'), String(error));
        return true;
      });

      const log = stand.commandLog();
      assert.strictEqual(indexOfVerb(log, LOAD), -1, log.join('\n'));
      assert.deepStrictEqual(stand.emulator.extensions.stubsCreatedByFileLoad, []);
      assert.strictEqual(hookCalls, 0);
    });

    test('без обновления, расширение есть: порядок [connect-ib, список, load-config-from-files], сверки E11 нет', async () => {
      stand.emulator.extensions.addExtension('Расш');

      await stand.service.loadChanged(target(), { updateDatabase: false }, hooks());

      assert.deepStrictEqual(stand.commandLog().map(verbOf), [CONNECT, 'config extensions properties get', LOAD]);
    });

    test('с обновлением, расширение есть: список → загрузка → update-db-cfg; E11-сверка после применения', async () => {
      stand.emulator.extensions.addExtension('Расш');

      await stand.service.loadChanged(target(), { updateDatabase: true }, hooks());

      const log = stand.commandLog();
      const firstList = log.indexOf(PROPERTIES_GET_ALL);
      assert.ok(firstList >= 0 && firstList < indexOfVerb(log, LOAD), log.join('\n'));
      assert.ok(indexOfVerb(log, LOAD) < indexOfVerb(log, UPDATE));
      assert.strictEqual(log[log.length - 1], PROPERTIES_GET_ALL, 'после применения — сверка списком');
    });

    test('эмулятор Э32: load-config-from-files в отсутствующее расширение создаёт заглушку (success), существующее не трогает', async () => {
      stand.emulator.extensions.addExtension('Есть', 'данные');
      const emulator = stand.emulator;
      const dir = 'agent-fixture-dir';
      fs.mkdirSync(path.join(stand.userRoot, dir), { recursive: true });
      fs.writeFileSync(path.join(stand.userRoot, dir, 'Configuration.xml'), '<MetaDataObject/>');

      await emulator.execute(`config load-config-from-files --dir=${dir} --extension=Нет`);
      await emulator.execute(`config load-config-from-files --dir=${dir} --extension=Есть`);

      assert.deepStrictEqual(emulator.extensions.stubsCreatedByFileLoad, ['Нет']);
      assert.strictEqual(emulator.extensions.isStub('Нет'), true);
      assert.strictEqual(emulator.extensions.isStub('Есть'), false);
      assert.strictEqual(emulator.extensions.payloadOf('Есть'), 'данные');
    });
  });

  suite(`loadFullAndUpdate: хук onConfigurationLoaded между загрузкой и обновлением [${location}]`, function () {
    this.timeout(120_000);
    let stand: ServiceStand;

    setup(async () => {
      stand = await createServiceStand(location);
      writeProject(stand);
    });
    teardown(async () => { await stand.dispose(); });

    for (const kind of ['cf', 'cfe'] as Kind[]) {
      test(`${kind}: хук после load-config-from-files и до update-db-cfg`, async () => {
        if (kind === 'cfe') {
          stand.emulator.extensions.addExtension('Расш');
        }
        let seen: string[] = [];
        await stand.service.loadFullAndUpdate(targetOf(stand, kind), { onConfigurationLoaded: () => { seen = stand.commandLog(); } });

        assert.ok(seen.some((line) => verbOf(line) === LOAD));
        assert.ok(!seen.some((line) => verbOf(line) === UPDATE), seen.join('\n'));
      });

      test(`${kind}: сбой update-db-cfg после полной загрузки — хук уже вызван`, async () => {
        if (kind === 'cfe') {
          stand.emulator.extensions.addExtension('Расш');
        }
        stand.emulator.extensions.failOn((command) => command.command === 'config update-db-cfg', emulatedFailure('UnknownError', 'Сбой'));
        let calls = 0;

        await assert.rejects(stand.service.loadFullAndUpdate(targetOf(stand, kind), { onConfigurationLoaded: () => { calls += 1; } }));

        assert.strictEqual(calls, 1);
      });
    }
  });
}
