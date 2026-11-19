import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentCommandError } from '../../infra/agent/AgentTransport';
import { AgentConfigEmulator } from './support/agentConfigEmulator';
import { RICH_DOCUMENT_FILES, RICH_DOCUMENT_FILE_LEVEL_NAMES, seedRichDocument } from './support/archiveAvoidFixtures';

/**
 * Самопроверка стенда: эмулятор агента воспроизводит ровно ответы настоящего агента 8.3.27.2130 из
 * эксперимента 12 (plan-archive-avoid.md §7) для `dump --list-file` и формат CDI с подобъектами. Без этой
 * проверки тесты движка строились бы на непроверенной модели агента и могли бы «закрепить» её ошибку.
 */

const BOM = String.fromCharCode(0xfeff);

suite('AgentConfigEmulator: CDI с подобъектами и dump --list-file (факты эксперимента 12)', () => {
  let root: string;
  let emulator: AgentConfigEmulator;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-emu-list-'));
    emulator = new AgentConfigEmulator(root);
    emulator.setObject('Configuration.Конфигурация', {
      'Configuration.xml': '<Configuration/>',
      'Ext/ManagedApplicationModule.bsl': 'приложение',
      'Ext/SessionModule.bsl': 'сеанс',
    });
    seedRichDocument(emulator);
    emulator.setObject('Catalog.Клиенты', { 'Catalogs/Клиенты.xml': '<Catalog/>' });
  });
  teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const writeList = (names: string[], text?: string): void => {
    fs.mkdirSync(path.join(root, 'lists'), { recursive: true });
    fs.writeFileSync(path.join(root, 'lists', 'l.txt'), text ?? `${BOM}${names.join('\n')}`, 'utf-8');
  };
  const dump = (extra = ''): Promise<unknown> => emulator.execute(
    `config dump-config-to-files --dir=exchange/x/restore --format=hierarchical --force --list-file=lists/l.txt${extra}`
  );
  const outFiles = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string, rel: string): void => {
      if (!fs.existsSync(dir)) {
        return;
      }
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), childRel);
        } else {
          out.push(childRel);
        }
      }
    };
    walk(path.join(root, 'exchange', 'x', 'restore'), '');
    return out.sort();
  };
  const rejection = async (run: () => Promise<unknown>): Promise<{ type: string; message: string }> => {
    try {
      await run();
    } catch (error) {
      assert.ok(error instanceof AgentCommandError);
      const final = error.finalMessage as unknown as Record<string, string>;
      return { type: final['error-type'], message: final.message };
    }
    throw new assert.AssertionError({ message: 'ожидалась ошибка агента' });
  };

  suite('CDI: файловые подобъекты — записи с configVersion, встроенные — без', () => {
    test('владелец открывающий, внутри встроенные (без configVersion) и файловые подобъекты (с ним); имена из карты стенда', () => {
      const cdi = emulator.dbFiles()['ConfigDumpInfo.xml'].toString('utf-8');
      const tags = [...cdi.matchAll(/<Metadata\b[^>]*>/g)].map((m) => m[0]);
      const withVersion = new Set(tags.filter((t) => /\bconfigVersion="/.test(t)).map((t) => /\bname="([^"]+)"/.exec(t)?.[1]));
      const withoutVersion = new Set(tags.filter((t) => !/\bconfigVersion="/.test(t)).map((t) => /\bname="([^"]+)"/.exec(t)?.[1]));
      for (const name of RICH_DOCUMENT_FILE_LEVEL_NAMES) {
        assert.ok(withVersion.has(name), `${name} — файловое (с configVersion)`);
      }
      assert.ok(withoutVersion.has('Document.Д.Attribute.Реквизит'));
      assert.ok(withoutVersion.has('Document.Д.TabularSection.ТЧ'));
      assert.ok(!withVersion.has('Document.Д.Command.К'), 'у самой команды записи с configVersion нет (факт эксперимента 12)');
      assert.ok(cdi.includes('</Metadata>'), 'тег владельца с детьми открывающий');
      assert.deepStrictEqual(emulator.cdiNamesOf('Document.Д').filter((n) => RICH_DOCUMENT_FILE_LEVEL_NAMES.includes(n)), [...RICH_DOCUMENT_FILE_LEVEL_NAMES]);
    });

    test('конфигурация: Configuration.<Имя>.ManagedApplicationModule и .SessionModule — файловые записи', () => {
      assert.deepStrictEqual(emulator.cdiNamesOf('Configuration.Конфигурация'), [
        'Configuration.Конфигурация',
        'Configuration.Конфигурация.ManagedApplicationModule',
        'Configuration.Конфигурация.SessionModule',
      ]);
    });

    test('версии для --update читаются только у владельцев (два сегмента): подобъекты их не затирают', async () => {
      await emulator.execute('config dump-config-to-files --dir=m --format=hierarchical --force');
      emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
      await emulator.execute('config dump-config-to-files --dir=m --format=hierarchical --update --get-changes=ch.txt');
      assert.strictEqual(fs.readFileSync(path.join(root, 'ch.txt'), 'utf-8'), `${BOM}Modified: Catalog.Клиенты\r\n`);
    });

    test('addInlineChild / setInlineChildren меняют только встроенные записи', () => {
      emulator.addInlineChild('Catalog.Клиенты', 'TabularSection.Т');
      assert.deepStrictEqual(emulator.cdiNamesOf('Catalog.Клиенты'), ['Catalog.Клиенты', 'Catalog.Клиенты.Attribute.Реквизит', 'Catalog.Клиенты.TabularSection.Т']);
      emulator.setInlineChildren('Catalog.Клиенты', []);
      assert.deepStrictEqual(emulator.cdiNamesOf('Catalog.Клиенты'), ['Catalog.Клиенты']);
    });
  });

  suite('dump --list-file', () => {
    test('имя владельца → ТОЛЬКО его XML (не поддерево); ConfigDumpInfo.xml в каталоге не создаётся', async () => {
      writeList(['Document.Д']);
      await dump();
      assert.deepStrictEqual(outFiles(), ['Documents/Д.xml']);
      assert.strictEqual(emulator.listDumpCalls, 1);
      assert.deepStrictEqual(emulator.lastListNames, ['Document.Д']);
    });

    test('файловые подобъекты → их файлы: модули, команда (CommandModule), форма (дескриптор и тело с модулем), макет', async () => {
      writeList([
        'Document.Д.ObjectModule', 'Document.Д.ManagerModule', 'Document.Д.Command.К.CommandModule',
        'Document.Д.Form.Ф', 'Document.Д.Form.Ф.Form', 'Document.Д.Template.М', 'Document.Д.Template.М.Template',
      ]);
      await dump();
      assert.deepStrictEqual(outFiles(), [
        'Documents/Д/Commands/К/Ext/CommandModule.bsl',
        'Documents/Д/Ext/ManagerModule.bsl',
        'Documents/Д/Ext/ObjectModule.bsl',
        'Documents/Д/Forms/Ф.xml',
        'Documents/Д/Forms/Ф/Ext/Form.xml',
        'Documents/Д/Forms/Ф/Ext/Form/Module.bsl',
        'Documents/Д/Templates/М.xml',
        'Documents/Д/Templates/М/Ext/Template.xml',
      ]);
    });

    test('всё поддерево владельца = имена владельца и всех его файловых подобъектов; файлы побайтно из базы', async () => {
      writeList([...RICH_DOCUMENT_FILE_LEVEL_NAMES]);
      await dump();
      assert.deepStrictEqual(outFiles(), Object.keys(RICH_DOCUMENT_FILES).sort());
      for (const [rel, text] of Object.entries(RICH_DOCUMENT_FILES)) {
        assert.strictEqual(fs.readFileSync(path.join(root, 'exchange', 'x', 'restore', ...rel.split('/')), 'utf-8'), text);
      }
    });

    test('Configuration.<Имя> → Configuration.xml; её модули — файловые записи Ext/*.bsl', async () => {
      writeList(['Configuration.Конфигурация', 'Configuration.Конфигурация.SessionModule']);
      await dump();
      assert.deepStrictEqual(outFiles(), ['Configuration.xml', 'Ext/SessionModule.bsl']);
    });

    test('--extension принимается (поведение настоящего агента для расширения не проверено)', async () => {
      writeList(['Catalog.Клиенты']);
      await dump(' --extension=Расш');
      assert.deepStrictEqual(outFiles(), ['Catalogs/Клиенты.xml']);
    });

    test('список без BOM и с пустыми строками допустим; кириллица в именах', async () => {
      writeList([], 'Catalog.Клиенты\n\n');
      await dump();
      assert.deepStrictEqual(outFiles(), ['Catalogs/Клиенты.xml']);
    });

    test('строка-путь → ConfigFilesError «Объект метаданных … не существует в конфигурации»; ничего не пишется', async () => {
      writeList(['Documents/Д.xml']);
      const error = await rejection(dump);
      assert.strictEqual(error.type, 'ConfigFilesError');
      assert.match(error.message, /^Объект метаданных Documents\/Д\.xml не существует в конфигурации/);
      assert.deepStrictEqual(outFiles(), []);
    });

    test('несуществующее имя среди корректных → ConfigFilesError, НЕ выгружено НИЧЕГО (всё или ничего)', async () => {
      writeList(['Catalog.Клиенты', 'Document.Д', 'Document.Нет']);
      const error = await rejection(dump);
      assert.deepStrictEqual(error, { type: 'ConfigFilesError', message: 'Объект метаданных Document.Нет не существует в конфигурации.' });
      assert.deepStrictEqual(outFiles(), []);
      assert.strictEqual(fs.existsSync(path.join(root, 'exchange', 'x', 'restore')), false, 'каталог не создан');
    });

    test('встроенный подобъект → ConfigFilesError «Невозможно сохранить объект метаданых … в отдельный XML-файл…»; ничего не пишется', async () => {
      writeList(['Catalog.Клиенты', 'Document.Д.Attribute.Реквизит']);
      const error = await rejection(dump);
      assert.strictEqual(error.type, 'ConfigFilesError');
      assert.match(error.message, /^Невозможно сохранить объект метаданых Document\.Д\.Attribute\.Реквизит в отдельный XML-файл\. Вы можете сохранить его как часть родительского объекта\.$/);
      assert.deepStrictEqual(outFiles(), []);
    });

    test('--update вместе с --list-file → CommandFormatError «Ключ -listFile не может использоваться совместно с ключами инкрементальной выгрузки.»', async () => {
      writeList(['Catalog.Клиенты']);
      const error = await rejection(() => dump(' --update'));
      assert.deepStrictEqual(error, { type: 'CommandFormatError', message: 'Ключ -listFile не может использоваться совместно с ключами инкрементальной выгрузки.' });
      assert.deepStrictEqual(outFiles(), []);
      assert.strictEqual(emulator.listDumpCalls, 1);
    });

    test('файл списка отсутствует → ConfigFilesError', async () => {
      const error = await rejection(dump);
      assert.strictEqual(error.type, 'ConfigFilesError');
    });

    test('имя с \\r (список с CRLF) агент не находит — как и настоящий: разделитель только \\n', async () => {
      writeList([], `${BOM}Catalog.Клиенты\r\nDocument.Д\r\n`);
      const error = await rejection(dump);
      assert.strictEqual(error.type, 'ConfigFilesError');
    });

    test('каталог с прежним содержимым: чужие файлы и CDI не удаляются и не меняются', async () => {
      const dir = path.join(root, 'exchange', 'x', 'restore');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'ConfigDumpInfo.xml'), 'прежний CDI');
      fs.writeFileSync(path.join(dir, 'Чужой.txt'), 'чужой');
      writeList(['Catalog.Клиенты']);
      await dump();
      assert.strictEqual(fs.readFileSync(path.join(dir, 'ConfigDumpInfo.xml'), 'utf-8'), 'прежний CDI');
      assert.strictEqual(fs.readFileSync(path.join(dir, 'Чужой.txt'), 'utf-8'), 'чужой');
      assert.ok(fs.existsSync(path.join(dir, 'Catalogs', 'Клиенты.xml')));
    });

    test('listDumpMissingFiles: перечисленный файл «не выгружен» (недовыгрузка агента), остальные пишутся', async () => {
      emulator.listDumpMissingFiles = new Set(['Documents/Д/Forms/Ф/Ext/Form.xml']);
      writeList(['Document.Д.Form.Ф.Form', 'Document.Д.Template.М']);
      await dump();
      assert.deepStrictEqual(outFiles(), ['Documents/Д/Forms/Ф/Ext/Form/Module.bsl', 'Documents/Д/Templates/М.xml']);
    });

    test('счётчик и история списков: каждая команда учитывается, lastListNames — последний список', async () => {
      writeList(['Catalog.Клиенты']);
      await dump();
      writeList(['Document.Д']);
      await dump();
      assert.strictEqual(emulator.listDumpCalls, 2);
      assert.deepStrictEqual(emulator.listDumpNames, [['Catalog.Клиенты'], ['Document.Д']]);
      assert.deepStrictEqual(emulator.lastListNames, ['Document.Д']);
    });
  });
});
