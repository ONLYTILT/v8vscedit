import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentConfigEmulator } from './support/agentConfigEmulator';
import {
  BOM,
  FULL_DUMP_UPDATE_MODES,
  ORDER_FORM_FILES,
  ROOT_PART_FILE,
  seedOrderWithTemplate,
  seedRootPart,
} from './support/fullDumpAvoidFixtures';
import { dbAsText } from './support/agentSyncHarness';

/**
 * Самопроверка стенда (plan-fulldump-avoid.md, Т6): эмулятор агента ведёт себя так, как сняли факты Э19/П3b —
 * удаление файловой записи даёт `FullDump`, владелец, убранный из CDI зеркала, приходит как `New` и выгружается
 * целиком, а `--update` при пропавших записях переписывает выгрузку (счётчик `fullRewriteUpdates`). Без этой
 * проверки тесты движка опирались бы на непроверенную модель агента.
 */

const MIRROR = 'm';
const CDI = 'ConfigDumpInfo.xml';
const DUMP = `config dump-config-to-files --dir=${MIRROR} --format=hierarchical --force`;

suite('AgentConfigEmulator: FullDump при удалении файловых подобъектов (Э19, П3b)', () => {
  let root: string;
  let emulator: AgentConfigEmulator;

  setup(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-emu-fulldump-'));
    emulator = new AgentConfigEmulator(root);
    emulator.setObject('Configuration.Конфигурация', { 'Configuration.xml': '<Configuration/>' });
    emulator.setObject('Catalog.Клиенты', { 'Catalogs/Клиенты.xml': '<Catalog>Клиенты</Catalog>' });
    seedOrderWithTemplate(emulator, true);
    seedRootPart(emulator);
    emulator.updateGranularity = 'changed-files';
    await emulator.execute(DUMP);
  });
  teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const mAbs = (rel: string): string => path.join(root, MIRROR, ...rel.split('/'));
  const readM = (rel: string): string => fs.readFileSync(mAbs(rel), 'utf-8');
  const existsM = (rel: string): boolean => fs.existsSync(mAbs(rel));
  const changes = async (name = 'c.txt'): Promise<string> => {
    await emulator.execute(`config dump-config-to-files --dir=${MIRROR} --format=hierarchical --update --get-changes=${name}`);
    return fs.readFileSync(path.join(root, name), 'utf-8');
  };
  /** Вырезает владельца (блок записей) из файла версий зеркала. */
  const cutOwnerFromMirrorCdi = (owner: string): void => {
    const lines = readM(CDI).split('\n');
    const start = lines.findIndex((line) => line.includes(`name="${owner}"`));
    assert.ok(start >= 0, `в CDI зеркала есть ${owner}`);
    const end = lines[start].trimEnd().endsWith('/>') ? start : lines.findIndex((line, index) => index > start && line === '  </Metadata>');
    lines.splice(start, end - start + 1);
    fs.writeFileSync(mAbs(CDI), lines.join('\n'));
  };

  suite('1. removeFiles → FullDump', () => {
    test('до удаления: нет изменений — один BOM', async () => {
      assert.strictEqual(await changes(), BOM);
    });

    test('удалены файлы формы (две файловые записи CDI) → FullDump', async () => {
      emulator.removeFiles(ORDER_FORM_FILES);
      assert.strictEqual(await changes(), `${BOM}FullDump\r\n`);
    });

    test('удалён макет (две файловые записи CDI) → FullDump', async () => {
      emulator.removeFiles(['Documents/Заказ/Templates/Макет.xml', 'Documents/Заказ/Templates/Макет/Ext/Template.xml']);
      assert.strictEqual(await changes('a.txt'), `${BOM}FullDump\r\n`);
    });

    test('часть корня (Ext/HomePageWorkArea.xml) → FullDump', async () => {
      emulator.removeFiles([ROOT_PART_FILE]);
      assert.strictEqual(await changes(), `${BOM}FullDump\r\n`);
    });

    test('удалён файл без собственной записи CDI (модуль формы под телом) → всё равно запись формы жива: Modified, не FullDump', async () => {
      emulator.putFile('Documents/Заказ/Forms/Форма/Ext/Form/Module.bsl', 'модуль формы');
      await emulator.execute(`${DUMP} --update`);
      emulator.removeFiles(['Documents/Заказ/Forms/Форма/Ext/Form/Module.bsl']);
      assert.strictEqual(await changes(), `${BOM}Modified: Document.Заказ\r\n`);
    });

    test('записи формы пропадают из набора имён CDI владельца', () => {
      const before = emulator.cdiNamesOf('Document.Заказ');
      emulator.removeFiles(ORDER_FORM_FILES);
      const after = emulator.cdiNamesOf('Document.Заказ');
      assert.ok(before.includes('Document.Заказ.Form.Форма'));
      assert.ok(!after.includes('Document.Заказ.Form.Форма') && !after.includes('Document.Заказ.Form.Форма.Form'));
    });

    test('несуществующий файл → ошибка стенда', () => {
      assert.throws(() => emulator.removeFiles(['Documents/Заказ/Нет.xml']), /нет файла/);
      assert.throws(() => emulator.removeFiles(['Unknown/Файл.xml']), /нет файла|владельца/);
    });

    test('регресс: удалённый целиком владелец по-прежнему даёт FullDump, изменённый — Modified', async () => {
      emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
      assert.strictEqual(await changes('a.txt'), `${BOM}Modified: Catalog.Клиенты\r\n`);
      emulator.removeObject('Document.Заказ');
      assert.strictEqual(await changes('b.txt'), `${BOM}FullDump\r\n`);
    });
  });

  suite('2. владелец, убранный из CDI зеркала (моделирует очистку Р3)', () => {
    test('get-changes: New: <владелец> и строки его подобъектов (ФАКТ П3b); прочие владельцы не упомянуты', async () => {
      cutOwnerFromMirrorCdi('Document.Заказ');

      assert.strictEqual(await changes(), `${BOM}New: Document.Заказ.Template.Макет\r\nNew: Document.Заказ\r\n`);
    });

    test('без строк подобъектов (parts пусты) — одна строка New: <владелец>', async () => {
      seedOrderWithTemplate(emulator, false);
      await emulator.execute(DUMP);
      cutOwnerFromMirrorCdi('Document.Заказ');

      assert.strictEqual(await changes(), `${BOM}New: Document.Заказ\r\n`);
    });

    test('--update (changed-files) пишет в M ВСЕ файлы владельца и больше ничего; fullRewriteUpdates не растёт', async () => {
      cutOwnerFromMirrorCdi('Document.Заказ');
      for (const rel of ['Documents/Заказ.xml', 'Documents/Заказ/Ext/ObjectModule.bsl', ...ORDER_FORM_FILES]) {
        fs.unlinkSync(mAbs(rel));
      }
      fs.writeFileSync(mAbs('Catalogs/Клиенты.xml'), 'МЕТКА-НЕ-ПЕРЕЗАПИСЫВАТЬ');

      await emulator.execute(`${DUMP} --update`);

      for (const [rel, data] of Object.entries(emulator.dbFiles())) {
        if (rel.startsWith('Documents/')) {
          assert.ok(existsM(rel), rel);
          assert.strictEqual(readM(rel), data.toString('utf-8'));
        }
      }
      assert.strictEqual(readM('Catalogs/Клиенты.xml'), 'МЕТКА-НЕ-ПЕРЕЗАПИСЫВАТЬ', 'неизменённый владелец не выгружается');
      assert.strictEqual(readM(CDI), emulator.dbFiles()[CDI].toString('utf-8'));
      assert.strictEqual(emulator.fullRewriteUpdates, 0);
    });
  });

  suite('3. --update при пропавших записях известного CDI', () => {
    for (const mode of FULL_DUMP_UPDATE_MODES) {
      suite(`fullDumpUpdate = ${mode}`, () => {
        setup(() => { emulator.fullDumpUpdate = mode; });

        test('удалена форма: счётчик = 1; файлы формы из M убраны; CDI M ≡ CDI базы', async () => {
          emulator.removeFiles(ORDER_FORM_FILES);

          await emulator.execute(`${DUMP} --update`);

          assert.strictEqual(emulator.fullRewriteUpdates, 1);
          for (const rel of ORDER_FORM_FILES) {
            assert.ok(!existsM(rel), `${rel} убран`);
          }
          assert.strictEqual(readM(CDI), emulator.dbFiles()[CDI].toString('utf-8'));
          assert.ok(existsM('Documents/Заказ/Ext/ObjectModule.bsl'));
        });

        test('удалён владелец: счётчик = 1; файлы владельца убраны', async () => {
          emulator.removeObject('Document.Заказ');

          await emulator.execute(`${DUMP} --update`);

          assert.strictEqual(emulator.fullRewriteUpdates, 1);
          assert.ok(!existsM('Documents/Заказ.xml'));
          assert.ok(!existsM('Documents/Заказ/Ext/ObjectModule.bsl'));
        });

        test('обычное обновление (ничего не пропало): счётчик не растёт', async () => {
          emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');

          await emulator.execute(`${DUMP} --update`);

          assert.strictEqual(emulator.fullRewriteUpdates, 0);
          assert.strictEqual(readM('Catalogs/Клиенты.xml'), '<Catalog>v2</Catalog>');
        });
      });
    }

    test('rewrite-all: выгрузка переписывается целиком — испорченный неизменённый файл M восстановлен', async () => {
      emulator.fullDumpUpdate = 'rewrite-all';
      emulator.removeFiles(ORDER_FORM_FILES);
      fs.writeFileSync(mAbs('Catalogs/Клиенты.xml'), 'МЕТКА');

      await emulator.execute(`${DUMP} --update`);

      assert.deepStrictEqual(
        Object.fromEntries(Object.keys(emulator.dbFiles()).map((rel) => [rel, readM(rel)])),
        dbAsText(emulator.dbFiles())
      );
    });

    test('changed-and-removals: неизменённый файл M не переписывается', async () => {
      emulator.fullDumpUpdate = 'changed-and-removals';
      emulator.removeFiles(ORDER_FORM_FILES);
      fs.writeFileSync(mAbs('Catalogs/Клиенты.xml'), 'МЕТКА');

      await emulator.execute(`${DUMP} --update`);

      assert.strictEqual(readM('Catalogs/Клиенты.xml'), 'МЕТКА');
    });

    test('по умолчанию режим changed-and-removals', () => {
      assert.strictEqual(new AgentConfigEmulator(root).fullDumpUpdate, 'changed-and-removals');
    });
  });

  suite('4. счётчик infoOnlyDumps', () => {
    test('считает выгрузки --config-dump-info-only с архивом и без; прочие выгрузки не считает', async () => {
      assert.strictEqual(emulator.infoOnlyDumps, 0);

      await emulator.execute('config dump-config-to-files --dir=i1 --format=hierarchical --force --config-dump-info-only');
      await emulator.execute('config dump-config-to-files --dir=i2 --format=hierarchical --force --config-dump-info-only --archive=cdi.zip');
      await emulator.execute(`${DUMP} --update`);
      await emulator.execute('config dump-config-to-files --dir=a --format=hierarchical --force --archive=full.zip');

      assert.strictEqual(emulator.infoOnlyDumps, 2);
      assert.ok(fs.existsSync(path.join(root, 'i1', CDI)));
      assert.ok(fs.existsSync(path.join(root, 'i2', 'cdi.zip')));
    });
  });

  suite('5. формат файла версий', () => {
    test('<ConfigVersions> оборачивает записи; идентификаторы стабильны по имени: удаление владельца не меняет прочие строки', () => {
      const withOrder = emulator.dbFiles()[CDI].toString('utf-8');
      assert.ok(withOrder.includes('<ConfigVersions>') && withOrder.includes('</ConfigVersions>'));

      emulator.removeObject('Document.Заказ');
      const without = emulator.dbFiles()[CDI].toString('utf-8');

      const keep = withOrder.split('\n').filter((line) => !line.includes('Document.Заказ'));
      const remaining = without.split('\n');
      // у блока владельца пропадает и закрывающая строка `</Metadata>`: сравниваем строки с именами
      assert.deepStrictEqual(
        remaining.filter((line) => line.includes('<Metadata')),
        keep.filter((line) => line.includes('<Metadata'))
      );
    });
  });
});
