import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { AgentSyncCancelledError } from '../../infra/agent/sync/SyncContext';
import { restoreFromDatabase } from '../../infra/agent/sync/SparseRestore';
import { createHarness, HARNESS_EXTENSION_NAME, type HarnessKind, type HarnessTargetKind, type SyncHarness } from './support/agentSyncHarness';
import { hasOption } from './support/agentConfigEmulator';
import { agentError } from './support/agentInfoBaseFakes';
import {
  RICH_DOCUMENT_FILES,
  RICH_DOCUMENT_FILE_LEVEL_NAMES,
  makeContext,
  seedRichDocument,
} from './support/archiveAvoidFixtures';

/**
 * Точечная выгрузка грязных файлов из базы (plan-archive-avoid.md §3.3, вариант А): список ИМЁН объектов из
 * CDI ПРОЕКТА (владелец + его файловые подобъекты) → `dump --list-file` в каталог обмена
 * `exchange/<op>/restore`; M не трогается. Агент — эмулятор по фактам эксперимента 12 (агент 8.3.27.2130).
 * ВНИМАНИЕ: поведение агента для расширения (`--extension`) экспериментом не проверено — ветка cfe здесь
 * построена по плану, а эмулятор отвечает для неё так же, как для основной конфигурации.
 */

const BOM = String.fromCharCode(0xfeff);
const FORM_BODY = 'Documents/Д/Forms/Ф/Ext/Form.xml';
const TEMPLATE = 'Documents/Д/Templates/М.xml';

for (const kind of ['sftp', 'local'] as const satisfies readonly HarnessKind[]) {
  for (const targetKind of ['cf', 'cfe'] as const satisfies readonly HarnessTargetKind[]) {
    suite(`SparseRestore: ${kind}, цель ${targetKind}`, function () {
      this.timeout(60_000);
      let h: SyncHarness;
      const OPERATION = `${targetKind}-restore-1`;
      const sourceDir = `exchange/${OPERATION}/restore`;
      const listPath = `exchange/${OPERATION}.objects.txt`;

      setup(async () => {
        h = await createHarness(kind, { targetKind });
        h.seedDb();
        seedRichDocument(h.emulator);
        h.emulator.setConfiguration(targetKind === 'cf' ? 'Основная' : HARNESS_EXTENSION_NAME, targetKind);
        await h.importTarget();
        // Правки базы и P после первого импорта не нужны: CDI проекта = CDI базы на момент импорта.
      });
      teardown(async () => { await h.dispose(); });

      const run = async (
        files: string[],
        hooks?: Parameters<typeof makeContext>[1]
      ): Promise<{ result: Awaited<ReturnType<typeof restoreFromDatabase>>; mutations: { count: number } }> => {
        const fixture = await makeContext(h, { ...hooks, operationId: OPERATION });
        const result = await restoreFromDatabase(fixture.context, files);
        return { result, mutations: fixture.mutations };
      };
      const listText = async (): Promise<string> => (await h.store.readFile(listPath)).toString('utf-8');

      suite('успех', () => {
        test('одна команда без --update/--archive в exchange/<op>/restore; файлы из базы лежат там; M побайтно не тронут; markMirrorMutated не вызван', async () => {
          const mBefore = h.snapshotM();
          const dumpsBefore = h.emulator.dumps().length;

          const { result, mutations } = await run([FORM_BODY, TEMPLATE]);

          assert.deepStrictEqual(result, { ok: true, sourceDir });
          const newDumps = h.emulator.dumps().slice(dumpsBefore);
          assert.strictEqual(newDumps.length, 1, 'ровно одна команда агента');
          const [dump] = newDumps;
          assert.strictEqual(dump.options.dir, sourceDir);
          assert.strictEqual(dump.options['list-file'], listPath);
          assert.strictEqual(dump.options.force, true);
          assert.ok(!dump.options.update && !dump.options.archive && !dump.options['get-changes']);
          assert.strictEqual(dump.options.format, 'hierarchical');
          assert.strictEqual(dump.options.extension, targetKind === 'cfe' ? HARNESS_EXTENSION_NAME : undefined);
          assert.strictEqual(h.emulator.listDumpCalls, 1);
          for (const rel of [FORM_BODY, TEMPLATE]) {
            assert.ok(h.emulator.dbFiles()[rel].equals(await h.store.readFile(`${sourceDir}/${rel}`)), rel);
          }
          assert.deepStrictEqual(h.snapshotM(), mBefore, 'M не изменён');
          assert.strictEqual(mutations.count, 0);
        });

        test('файл списка: UTF-8 с BOM, разделитель \\n без \\r и пустых строк; имена — владелец и ВСЕ его файловые подобъекты из CDI проекта', async () => {
          await run([FORM_BODY, TEMPLATE]);

          const text = await listText();
          assert.ok(text.startsWith(BOM), 'BOM в начале');
          assert.ok(!text.includes('\r'));
          const names = text.slice(1).split('\n');
          assert.ok(names.every((name) => name.trim() !== ''), 'пустых строк нет');
          assert.deepStrictEqual([...names].sort(), [...RICH_DOCUMENT_FILE_LEVEL_NAMES].sort());
          assert.deepStrictEqual([...(h.emulator.lastListNames ?? [])].sort(), [...RICH_DOCUMENT_FILE_LEVEL_NAMES].sort());
          // Встроенные подобъекты (реквизит, ТЧ) в список не попадают: агент отвечает на них ошибкой.
          assert.ok(names.every((name) => !/\.(Attribute|TabularSection)\./.test(name)));
        });

        test('два владельца → имена обоих, каждый ровно один раз; несколько файлов одного владельца не дублируют имён', async () => {
          const { result } = await run([FORM_BODY, TEMPLATE, 'Documents/Д/Ext/ObjectModule.bsl', 'Catalogs/Клиенты.xml']);

          assert.strictEqual(result.ok, true);
          const names = h.emulator.lastListNames ?? [];
          assert.strictEqual(new Set(names).size, names.length, 'без дублей');
          assert.deepStrictEqual([...names].sort(), [...RICH_DOCUMENT_FILE_LEVEL_NAMES, 'Catalog.Клиенты'].sort());
        });

        test('выгружается поддерево ТОЛЬКО перечисленных владельцев: чужой владелец в каталоге обмена отсутствует', async () => {
          await run([FORM_BODY]);

          assert.strictEqual(await h.store.stat(`${sourceDir}/Catalogs/Товары.xml`), undefined);
          assert.strictEqual((await h.store.stat(`${sourceDir}/Documents/Д.xml`))?.type, 'file');
          assert.strictEqual(await h.store.stat(`${sourceDir}/ConfigDumpInfo.xml`), undefined, 'CDI агент при --list-file не создаёт');
        });

        test('владелец — конфигурация: Ext/SessionModule.bsl → имена Configuration.<Имя> и её файловые подобъекты', async () => {
          h.emulator.putFile('Ext/SessionModule.bsl', 'Процедура УстановкаПараметровСеанса() КонецПроцедуры', ['SessionModule']);
          h.emulator.putFile('Ext/ManagedApplicationModule.bsl', 'Процедура ПриНачалеРаботыСистемы() КонецПроцедуры', ['ManagedApplicationModule']);
          // Свежий CDI проекта: в нём уже есть записи модулей конфигурации.
          h.emulator.snapshotToProject(h.configRoot);

          const { result } = await run(['Ext/SessionModule.bsl']);

          assert.deepStrictEqual(result, { ok: true, sourceDir });
          assert.deepStrictEqual([...(h.emulator.lastListNames ?? [])].sort(), [
            'Configuration.Конфигурация',
            'Configuration.Конфигурация.ManagedApplicationModule',
            'Configuration.Конфигурация.SessionModule',
          ]);
          assert.ok(h.emulator.dbFiles()['Ext/SessionModule.bsl'].equals(await h.store.readFile(`${sourceDir}/Ext/SessionModule.bsl`)));
        });

        test('файловое имя владельца без файла (пустой командный интерфейс не выгружается) — не недовыгрузка: проверяются только грязные файлы', async () => {
          // В реальной выгрузке (БП КОРП) у подсистем есть запись `…CommandInterface` с configVersion, а файла
          // `Ext/CommandInterface.xml` нет. Эмулятор: имя в CDI есть, а агент по нему ничего не пишет.
          const commandInterface = 'Documents/Д/Ext/CommandInterface.xml';
          h.emulator.putFile(commandInterface, '<CommandInterface/>');
          h.emulator.snapshotToProject(h.configRoot);
          h.emulator.listDumpMissingFiles = new Set([commandInterface]);

          const { result } = await run([FORM_BODY]);

          assert.deepStrictEqual(result, { ok: true, sourceDir });
          assert.ok((h.emulator.lastListNames ?? []).includes('Document.Д.CommandInterface'), 'имя без файла в списке есть');
          assert.strictEqual(await h.store.stat(`${sourceDir}/${commandInterface}`), undefined, 'файла по нему агент не выгрузил');
          assert.ok(h.emulator.dbFiles()[FORM_BODY].equals(await h.store.readFile(`${sourceDir}/${FORM_BODY}`)));
        });

        test('Configuration.xml как грязный файл → тот же владелец-конфигурация, файл восстановлен из базы', async () => {
          const { result } = await run(['Configuration.xml']);

          assert.strictEqual(result.ok, true);
          assert.ok(h.emulator.dbFiles()['Configuration.xml'].equals(await h.store.readFile(`${sourceDir}/Configuration.xml`)));
        });
      });

      suite('отказ до обращения к агенту (P и M не тронуты, команд нет)', () => {
        const expectRefusal = async (files: string[], reason: RegExp): Promise<void> => {
          const mBefore = h.snapshotM();
          const pBefore = h.snapshotP();
          const callsBefore = h.emulator.commands.length;

          const { result, mutations } = await run(files);

          assert.ok(!result.ok, 'отказ');
          assert.match(result.reason, reason);
          assert.strictEqual(h.emulator.listDumpCalls, 0, 'агент не вызывался');
          assert.strictEqual(h.emulator.commands.length, callsBefore, 'ни одной команды');
          assert.deepStrictEqual(h.snapshotM(), mBefore);
          assert.deepStrictEqual(h.snapshotP(), pBefore);
          assert.strictEqual(mutations.count, 0);
        };

        test('файл вне известных папок выгрузки', async () => {
          await expectRefusal(['Неизвестная/файл.xml'], /файл вне известных папок выгрузки: Неизвестная\/файл\.xml/);
        });

        test('файл в корне, не относящийся ни к одному владельцу', async () => {
          await expectRefusal(['readme.txt'], /файл вне известных папок выгрузки: readme\.txt/);
        });

        test('в проекте нет ConfigDumpInfo.xml', async () => {
          fs.unlinkSync(path.join(h.configRoot, 'ConfigDumpInfo.xml'));
          await expectRefusal([FORM_BODY], /ConfigDumpInfo|файл версий/i);
        });

        test('ConfigDumpInfo.xml проекта не разобран (нет корня)', async () => {
          fs.writeFileSync(path.join(h.configRoot, 'ConfigDumpInfo.xml'), 'мусор');
          await expectRefusal([FORM_BODY], /ConfigDumpInfo|файл версий/i);
        });

        test('владельца нет в CDI проекта', async () => {
          await expectRefusal(['Catalogs/Нет.xml'], /Catalog\.Нет/);
        });

        test('корня конфигурации нет в CDI проекта, а грязный файл — Ext/…', async () => {
          const cdi = path.join(h.configRoot, 'ConfigDumpInfo.xml');
          const text = fs.readFileSync(cdi, 'utf-8').replace(/<Metadata name="Configuration\.[^>]*\/>\n?/, '');
          fs.writeFileSync(cdi, text);
          await expectRefusal(['Ext/SessionModule.bsl'], /Configuration|конфигурац/i);
        });

        for (const [label, nameWithBreak] of [['\\n', 'А\nБ'], ['\\r', 'А\rБ']] as const) {
          test(`имя владельца с переводом строки (${label}) — защита формата list-файла`, async () => {
            const cdi = path.join(h.configRoot, 'ConfigDumpInfo.xml');
            const text = fs.readFileSync(cdi, 'utf-8').replace('</ConfigDumpInfo>', `  <Metadata name="Catalog.${nameWithBreak}" id="x" configVersion="1"/>\n</ConfigDumpInfo>`);
            fs.writeFileSync(cdi, text);
            await expectRefusal([`Catalogs/${nameWithBreak}.xml`], /перевод|строк|Catalog\./i);
          });
        }
      });

      suite('отказ по ответу агента или результату выгрузки', () => {
        const expectRefusalAfterCall = async (files: string[], reason: RegExp): Promise<void> => {
          const mBefore = h.snapshotM();
          const pBefore = h.snapshotP();

          const { result, mutations } = await run(files);

          assert.ok(!result.ok, 'отказ');
          assert.match(result.reason, reason);
          assert.deepStrictEqual(h.snapshotM(), mBefore, 'M не тронут');
          assert.deepStrictEqual(h.snapshotP(), pBefore, 'P не тронут');
          assert.strictEqual(mutations.count, 0);
        };

        test('встроенный подобъект в CDI проекта выдан за файловый → ConfigFilesError агента → отказ с его текстом', async () => {
          const cdi = path.join(h.configRoot, 'ConfigDumpInfo.xml');
          const text = fs.readFileSync(cdi, 'utf-8').replace(
            /(<Metadata name="Catalog\.Клиенты\.Attribute\.Реквизит" id="[^"]*")\/>/,
            '$1 configVersion="777"/>'
          );
          assert.notStrictEqual(text, fs.readFileSync(cdi, 'utf-8'), 'подстановка в CDI сработала');
          fs.writeFileSync(cdi, text);

          await expectRefusalAfterCall(['Catalogs/Клиенты.xml'], /Невозможно сохранить объект метаданых/);
          assert.strictEqual(h.emulator.listDumpCalls, 1);
        });

        test('устаревшее имя в CDI проекта (подобъекта уже нет в базе) → «не существует в конфигурации» → отказ', async () => {
          // Из базы форма Ф удалена, а CDI проекта о ней ещё помнит.
          h.emulator.setObject('Document.Д', Object.fromEntries(
            Object.entries(RICH_DOCUMENT_FILES).filter(([rel]) => !rel.includes('/Forms/'))
          ));

          await expectRefusalAfterCall([TEMPLATE], /не существует в конфигурации/);
        });

        test('агент не выгрузил запрошенный файл (listDumpMissingFiles) → отказ «точечная выгрузка не содержит <rel>»', async () => {
          h.emulator.listDumpMissingFiles = new Set([FORM_BODY]);

          await expectRefusalAfterCall([FORM_BODY, TEMPLATE], /точечная выгрузка не содержит Documents\/Д\/Forms\/Ф\/Ext\/Form\.xml/i);
        });

        test('ошибка транспорта (не ошибка агента) пробрасывается наружу, а не превращается в «отказ → архив»', async () => {
          h.emulator.failWhen = (cmd) => (!hasOption(cmd, 'list-file') ? undefined : new Error('обрыв транспорта SSH'));

          await assert.rejects(run([FORM_BODY]), /обрыв транспорта SSH/);
        });

        test('ошибка агента — это отказ с текстом агента, а не исключение', async () => {
          h.emulator.failWhen = (cmd) => (!hasOption(cmd, 'list-file') ? undefined : agentError('ConfigFilesError', 'Файл не обнаружен'));

          const { result } = await run([FORM_BODY]);

          assert.ok(!result.ok);
          assert.match(result.reason, /Файл не обнаружен/);
        });

        test('отмена после команды → AgentSyncCancelledError', async () => {
          const cancellation = { isCancellationRequested: false };
          h.emulator.onCommand = (cmd) => {
            if (hasOption(cmd, 'list-file')) {
              cancellation.isCancellationRequested = true;
            }
          };

          await assert.rejects(run([FORM_BODY], { hooks: { cancellation } }), AgentSyncCancelledError);
        });
      });
    });
  }
}
