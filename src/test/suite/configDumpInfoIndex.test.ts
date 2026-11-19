import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { META_TYPES } from '../../domain/MetaTypes';
import { ownerOfProjectFile } from '../../infra/agent/sync/ChangedObjectFiles';
import { findOrphanProjectFiles } from '../../infra/agent/sync/ProjectSeed';
import { dumpInfoOwnerOf, parseConfigDumpInfoIndex, readConfigDumpInfoIndex } from '../../infra/xml/dumpInfo/ConfigDumpInfoIndex';
import { EXAMPLE_GENERATIONS, skipWithoutCorpus } from './support/corpus';

/**
 * Индекс `ConfigDumpInfo.xml` (plan-archive-avoid.md §4): по правилу эксперимента 12 «файловый подобъект =
 * запись `<Metadata>` с атрибутом `configVersion`»; записи без него (реквизиты, ТЧ) — в XML родителя и в
 * `--list-file` дают ошибку агента. Регулярки разбора живут только в `infra/xml/` (запрет №1).
 */

const HEADER = '<ConfigDumpInfo xmlns="http://v8.1c.ru/8.3/xcf/dumpinfo" format="Hierarchical" version="2.21">';
const wrap = (body: string, bom = ''): string => `${bom}<?xml version="1.0" encoding="UTF-8"?>\n${HEADER}\n<ConfigVersions>\n${body}\n</ConfigVersions>\n</ConfigDumpInfo>\n`;

/** Раскладка настоящего файла: тег владельца открывающий, внутри — дети; атрибуты `name`, `id`, `configVersion`. */
const DOCUMENT = `
<Metadata name="Document.Д" id="d1" configVersion="v1">
  <Metadata name="Document.Д.Attribute.Реквизит" id="a1"/>
  <Metadata name="Document.Д.TabularSection.ТЧ" id="t1"/>
  <Metadata name="Document.Д.TabularSection.ТЧ.Attribute.Колонка" id="c1"/>
  <Metadata name="Document.Д.ObjectModule" id="m1" configVersion="v2"/>
  <Metadata name="Document.Д.ManagerModule" id="m2" configVersion="v3"/>
  <Metadata name="Document.Д.Command.К" id="k1"/>
  <Metadata name="Document.Д.Command.К.CommandModule" id="k2" configVersion="v4"/>
  <Metadata name="Document.Д.Form.Ф" id="f1" configVersion="v5"/>
  <Metadata name="Document.Д.Form.Ф.Form" id="f2" configVersion="v6"/>
  <Metadata name="Document.Д.Template.М" id="x1" configVersion="v7"/>
  <Metadata name="Document.Д.Template.М.Template" id="x2" configVersion="v8"/>
</Metadata>`;

suite('ConfigDumpInfoIndex: parseConfigDumpInfoIndex', () => {
  test('владелец и файловые подобъекты — в порядке файла; вложенные без configVersion (реквизит, ТЧ, колонка, команда) не файловые', () => {
    const index = parseConfigDumpInfoIndex(wrap(DOCUMENT));
    assert.deepStrictEqual(index.fileLevelNamesOf('Document.Д'), [
      'Document.Д',
      'Document.Д.ObjectModule',
      'Document.Д.ManagerModule',
      'Document.Д.Command.К.CommandModule',
      'Document.Д.Form.Ф',
      'Document.Д.Form.Ф.Form',
      'Document.Д.Template.М',
      'Document.Д.Template.М.Template',
    ]);
  });

  test('rootNames — только имена из двух сегментов; вложенные имена в них не попадают', () => {
    const index = parseConfigDumpInfoIndex(wrap(`${DOCUMENT}\n<Metadata name="Catalog.Справочник" id="c" configVersion="v9"/>`));
    assert.deepStrictEqual([...index.rootNames].sort(), ['Catalog.Справочник', 'Document.Д']);
  });

  const orders: [string, string][] = [
    ['name, id, configVersion (как у платформы)', '<Metadata name="Catalog.А.ObjectModule" id="1" configVersion="7"/>'],
    ['configVersion, name, id', '<Metadata configVersion="7" name="Catalog.А.ObjectModule" id="1"/>'],
    ['id, configVersion, name', '<Metadata id="1" configVersion="7" name="Catalog.А.ObjectModule"/>'],
    ['без id, открывающий и закрывающий тег', '<Metadata name="Catalog.А.ObjectModule" configVersion="7"></Metadata>'],
  ];
  for (const [label, child] of orders) {
    test(`порядок атрибутов не фиксирован: ${label}`, () => {
      const index = parseConfigDumpInfoIndex(wrap(`<Metadata name="Catalog.А" id="0" configVersion="1">\n${child}\n</Metadata>`));
      assert.deepStrictEqual(index.fileLevelNamesOf('Catalog.А'), ['Catalog.А', 'Catalog.А.ObjectModule']);
    });
  }

  test('BOM в начале файла допускается', () => {
    const index = parseConfigDumpInfoIndex(wrap(DOCUMENT, String.fromCharCode(0xfeff)));
    assert.strictEqual(index.fileLevelNamesOf('Document.Д').length, 8);
  });

  test('Configuration.<Имя> → configurationOwner; его модули приложения и сеанса — файловые подобъекты', () => {
    const index = parseConfigDumpInfoIndex(wrap([
      '<Metadata name="Configuration.Основная" id="c0" configVersion="1">',
      '  <Metadata name="Configuration.Основная.ManagedApplicationModule" id="c1" configVersion="2"/>',
      '  <Metadata name="Configuration.Основная.SessionModule" id="c2" configVersion="3"/>',
      '  <Metadata name="Configuration.Основная.Language.Русский" id="c3"/>',
      '</Metadata>',
    ].join('\n')));
    assert.strictEqual(index.configurationOwner, 'Configuration.Основная');
    assert.deepStrictEqual(index.fileLevelNamesOf('Configuration.Основная'), [
      'Configuration.Основная',
      'Configuration.Основная.ManagedApplicationModule',
      'Configuration.Основная.SessionModule',
    ]);
  });

  test('нет записи конфигурации → configurationOwner === undefined', () => {
    assert.strictEqual(parseConfigDumpInfoIndex(wrap(DOCUMENT)).configurationOwner, undefined);
  });

  test('префикс не путает владельцев: Catalog.А не получает подобъекты Catalog.АБ', () => {
    const index = parseConfigDumpInfoIndex(wrap([
      '<Metadata name="Catalog.А" id="1" configVersion="1"/>',
      '<Metadata name="Catalog.АБ" id="2" configVersion="1">',
      '  <Metadata name="Catalog.АБ.ObjectModule" id="3" configVersion="2"/>',
      '</Metadata>',
    ].join('\n')));
    assert.deepStrictEqual(index.fileLevelNamesOf('Catalog.А'), ['Catalog.А']);
    assert.deepStrictEqual(index.fileLevelNamesOf('Catalog.АБ'), ['Catalog.АБ', 'Catalog.АБ.ObjectModule']);
  });

  test('вложенная подсистема Subsystem.A.Subsystem.B — подобъект Subsystem.A, а не корневой владелец', () => {
    const index = parseConfigDumpInfoIndex(wrap([
      '<Metadata name="Subsystem.A" id="1" configVersion="1">',
      '  <Metadata name="Subsystem.A.Subsystem.B" id="2" configVersion="2"/>',
      '</Metadata>',
    ].join('\n')));
    assert.deepStrictEqual([...index.rootNames], ['Subsystem.A']);
    assert.deepStrictEqual(index.fileLevelNamesOf('Subsystem.A'), ['Subsystem.A', 'Subsystem.A.Subsystem.B']);
    assert.deepStrictEqual(index.fileLevelNamesOf('Subsystem.B'), []);
  });

  test('неизвестный владелец → пустой список', () => {
    assert.deepStrictEqual(parseConfigDumpInfoIndex(wrap(DOCUMENT)).fileLevelNamesOf('Document.Нет'), []);
  });

  test('запись без name пропускается, остальные разбираются', () => {
    const index = parseConfigDumpInfoIndex(wrap([
      '<Metadata id="1" configVersion="1"/>',
      '<Metadata name="Catalog.А" id="2" configVersion="1"/>',
    ].join('\n')));
    assert.deepStrictEqual([...index.rootNames], ['Catalog.А']);
  });

  test('содержимое тегов, не являющихся <Metadata> (в т.ч. с похожим именем), не принимается за запись', () => {
    const index = parseConfigDumpInfoIndex(wrap('<MetadataExtra name="Catalog.Левый" configVersion="1"/>\n<Metadata name="Catalog.А" id="2" configVersion="1"/>'));
    assert.deepStrictEqual([...index.rootNames], ['Catalog.А']);
  });
});

suite('ConfigDumpInfoIndex: readConfigDumpInfoIndex', () => {
  let dir: string;
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-cdi-index-')); });
  teardown(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('читает файл с диска (UTF-8 с BOM) и строит тот же индекс', async () => {
    const file = path.join(dir, 'ConfigDumpInfo.xml');
    fs.writeFileSync(file, wrap(DOCUMENT, String.fromCharCode(0xfeff)), 'utf-8');
    const index = await readConfigDumpInfoIndex(file);
    assert.ok(index);
    assert.strictEqual(index.fileLevelNamesOf('Document.Д')[1], 'Document.Д.ObjectModule');
  });

  test('нет файла → undefined', async () => {
    assert.strictEqual(await readConfigDumpInfoIndex(path.join(dir, 'нет.xml')), undefined);
  });

  test('каталог вместо файла (не читается) → undefined', async () => {
    assert.strictEqual(await readConfigDumpInfoIndex(dir), undefined);
  });

  test('мусор без корня <ConfigDumpInfo → undefined', async () => {
    const file = path.join(dir, 'ConfigDumpInfo.xml');
    fs.writeFileSync(file, 'просто текст <Metadata name="Catalog.А" configVersion="1"/>', 'utf-8');
    assert.strictEqual(await readConfigDumpInfoIndex(file), undefined);
  });
});

suite('ConfigDumpInfoIndex: на реальном корпусе example/ (только чтение)', function () {
  this.timeout(240_000);
  const roots = [
    ['2.20 cf', EXAMPLE_GENERATIONS.cf20],
    ['2.21 cf', EXAMPLE_GENERATIONS.cf21],
    ['2.21 cfe', EXAMPLE_GENERATIONS.cfe21],
  ] as const;

  /** Папка → английский вид из того же реестра, что использует продакшн (`englishKind ?? kind`). */
  const folderToKind = new Map(
    Object.values(META_TYPES)
      .filter((def): def is typeof def & { folder: string } => def.folder !== undefined)
      .map((def) => [def.folder, def.englishKind ?? def.kind] as const)
  );
  /** Верхняя граница доли XML владельцев без записи в CDI (замер — у проверки). */
  const MAX_ORPHAN_OWNER_SHARE = 0.01;
  /** Нижняя граница отношения «файловых записей CDI / файлов *.xml|*.bsl выгрузки» (замер — у проверки). */
  const MIN_FILE_LEVEL_SHARE = 0.5;
  const NESTED_PENULTIMATE = new Set([
    'Attribute', 'TabularSection', 'Dimension', 'Resource', 'EnumValue',
    'AddressingAttribute', 'AccountingFlag', 'ExtDimensionAccountingFlag', 'Column',
  ]);

  /** XML владельцев верхнего уровня выгрузки: `<Folder>/<Name>.xml` → `<Kind>.<Name>`. */
  const ownerXmls = (root: string): { rel: string; fullName: string; name: string; folder: string }[] => {
    const result: { rel: string; fullName: string; name: string; folder: string }[] = [];
    for (const [folder, kind] of folderToKind) {
      const dir = path.join(root, folder);
      if (!fs.existsSync(dir)) {
        continue;
      }
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.xml')) {
          const name = entry.name.slice(0, -'.xml'.length);
          result.push({ rel: `${folder}/${name}.xml`, fullName: `${kind}.${name}`, name, folder });
        }
      }
    }
    return result;
  };

  for (const [label, root] of roots) {
    suite(label, () => {
      let index: Awaited<ReturnType<typeof readConfigDumpInfoIndex>>;
      setup(async function () {
        skipWithoutCorpus(this, root, path.join(root, 'ConfigDumpInfo.xml'));
        index = await readConfigDumpInfoIndex(path.join(root, 'ConfigDumpInfo.xml'));
      });

      /*
       * Пользовательский корпус дрейфует: в реальной выгрузке встречаются файлы владельцев, которых нет в
       * CDI (выгрузка поверх прежней без очистки, смена вида объекта) — это ровно «сироты» задачи. Поэтому
       * не пинится «каждый XML владельца есть в CDI», а проверяется настоящий инвариант поиска сирот:
       * XML владельца без записи в CDI ⇔ файл попадает в findOrphanProjectFiles.
       */
      test('XML владельца без записи в CDI ⇔ сирота findOrphanProjectFiles; корень конфигурации найден', () => {
        assert.ok(index, 'индекс корпуса прочитан');
        const orphans = new Set(findOrphanProjectFiles(root, index, new Set()));
        const owners = ownerXmls(root);
        // Эквивалентность ниже сама по себе почти тавтологична: разбор, потерявший владельцев, сделал бы их
        // всех «сиротами» и прошёл бы её. Поэтому — жёсткая ВЕРХНЯЯ граница доли XML владельцев без записи в
        // CDI. Точное число не пинится (корпус — живая выгрузка пользователя, дрейфует). Замер 2026-11-18,
        // 2.20 cf (БП КОРП 3.0.202): XML владельцев 18 187, без записи в CDI — 2
        // (`Reports/МК_СборДокументовПретензии.xml` — вид сменён на обработку после выгрузки;
        // `InformationRegisters/МК_КомментарииПроблемныхТочекИмпорт.xml` — в CDI нет), т.е. ≈ 0,011%.
        const { rootNames } = index;
        const withoutRecord = owners.filter((owner) => !rootNames.has(owner.fullName));
        assert.ok(owners.length > 0, 'в выгрузке есть XML владельцев');
        assert.ok(
          withoutRecord.length <= owners.length * MAX_ORPHAN_OWNER_SHARE,
          `XML владельцев без записи в CDI: ${String(withoutRecord.length)} из ${String(owners.length)} — разбор CDI теряет владельцев?`
        );
        const mismatched: string[] = [];
        for (const owner of owners) {
          if (index.rootNames.has(owner.fullName) === orphans.has(owner.rel)) {
            mismatched.push(owner.rel);
          }
        }
        for (const rel of orphans) {
          const owner = ownerOfProjectFile(rel);
          if (owner === undefined || !('fullName' in owner) || index.rootNames.has(owner.fullName)) {
            mismatched.push(`сирота с владельцем в CDI: ${rel}`);
          }
        }
        assert.deepStrictEqual(mismatched.slice(0, 10), [], `расхождений: ${String(mismatched.length)}`);
        assert.ok(index.configurationOwner?.startsWith('Configuration.'), String(index.configurationOwner));
      });

      test('объём индекса: файловых записей CDI не меньше половины файлов *.xml|*.bsl выгрузки (разбор не обеднел тихо)', () => {
        assert.ok(index);
        let fileLevel = 0;
        for (const owner of index.rootNames) {
          fileLevel += index.fileLevelNamesOf(owner).length;
        }
        const countSources = (dir: string): number => fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
          if (entry.isDirectory()) {
            return sum + countSources(path.join(dir, entry.name));
          }
          return sum + (/\.(xml|bsl)$/.test(entry.name) ? 1 : 0);
        }, 0);
        const sources = countSources(root);
        // Замер 2026-11-18, 2.20 cf: файловых записей 89 468 на 95 414 файлов *.xml|*.bsl (≈ 94%; разница —
        // файлы, у которых нет своей записи: одна запись подобъекта покрывает несколько файлов). Граница 50% — с
        // запасом на дрейф корпуса, но разбор, потерявший заметную часть записей, её не пройдёт.
        assert.ok(
          fileLevel >= sources * MIN_FILE_LEVEL_SHARE,
          `файловых записей CDI ${String(fileLevel)} на ${String(sources)} файлов *.xml|*.bsl`
        );
      });

      test('каждая форма <Owner>/Forms/<F>.xml владельца из CDI — файловое имя <owner>.Form.<F>', () => {
        assert.ok(index);
        const missing: string[] = [];
        let checked = 0;
        for (const owner of ownerXmls(root)) {
          const forms = path.join(root, owner.folder, owner.name, 'Forms');
          // Формы сироты описывать нечему — их владелец уже проверен как сирота выше.
          if (!index.rootNames.has(owner.fullName) || !fs.existsSync(forms)) {
            continue;
          }
          const names = new Set(index.fileLevelNamesOf(owner.fullName));
          for (const form of fs.readdirSync(forms, { withFileTypes: true })) {
            if (form.isFile() && form.name.endsWith('.xml')) {
              checked += 1;
              const expected = `${owner.fullName}.Form.${form.name.slice(0, -'.xml'.length)}`;
              if (!names.has(expected)) {
                missing.push(expected);
              }
            }
          }
        }
        assert.ok(checked > 0, 'в корпусе есть формы объектов');
        assert.deepStrictEqual(missing.slice(0, 10), [], `форм без файлового имени: ${String(missing.length)}`);
      });

      test('скан контрпримеров: ни одного файлового имени с предпоследним сегментом Attribute/TabularSection/… (ожидаемо 0)', () => {
        assert.ok(index);
        const offenders: string[] = [];
        for (const owner of index.rootNames) {
          for (const name of index.fileLevelNamesOf(owner)) {
            const segments = name.split('.');
            if (segments.length > 2 && NESTED_PENULTIMATE.has(segments[segments.length - 2])) {
              offenders.push(name);
            }
          }
        }
        assert.deepStrictEqual(offenders.slice(0, 10), [], `контрпримеров: ${String(offenders.length)}`);
      });

      /*
       * Снята прежняя проверка «файловых имён владельца не больше его файлов»: на БП КОРП у 10 подсистем есть
       * запись `Subsystem.X.CommandInterface` с configVersion, а файла `Ext/CommandInterface.xml` нет —
       * пустой командный интерфейс платформа не выгружает. Файловое имя, таким образом, не обещает файла;
       * точечная выгрузка поэтому проверяет наличие только нужных (грязных) файлов, а не всех имён списка
       * (sparseRestore.test.ts, «файловое имя владельца без файла»). Здесь остаётся обратное направление:
       * у каждого владельца из CDI, чей XML есть в выгрузке, файловые имена включают его самого.
       */
      test('владелец из CDI с XML в выгрузке — первое из своих файловых имён', () => {
        assert.ok(index);
        const violations: string[] = [];
        for (const owner of ownerXmls(root)) {
          if (index.rootNames.has(owner.fullName) && index.fileLevelNamesOf(owner.fullName)[0] !== owner.fullName) {
            violations.push(owner.fullName);
          }
        }
        assert.deepStrictEqual(violations.slice(0, 10), [], `нарушений: ${String(violations.length)}`);
      });
    });
  }
});

/**
 * `fileLevelVersions` и `dumpInfoOwnerOf` (plan-fulldump-avoid.md, Т2): сравнение свежего CDI с CDI зеркала
 * идёт по версиям файловых записей, а владельца записи даёт ОДНА функция — первые два сегмента имени.
 */
suite('ConfigDumpInfoIndex: fileLevelVersions', () => {
  test('имя файловой записи → configVersion, в порядке файла; встроенные записи (без configVersion) не входят', () => {
    const index = parseConfigDumpInfoIndex(wrap(DOCUMENT));
    assert.deepStrictEqual([...index.fileLevelVersions], [
      ['Document.Д', 'v1'],
      ['Document.Д.ObjectModule', 'v2'],
      ['Document.Д.ManagerModule', 'v3'],
      ['Document.Д.Command.К.CommandModule', 'v4'],
      ['Document.Д.Form.Ф', 'v5'],
      ['Document.Д.Form.Ф.Form', 'v6'],
      ['Document.Д.Template.М', 'v7'],
      ['Document.Д.Template.М.Template', 'v8'],
    ]);
  });

  test('значение — строка как в файле (хеш платформы не приводится к числу)', () => {
    const index = parseConfigDumpInfoIndex(wrap('<Metadata name="Catalog.А" id="1" configVersion="ef17bfe954778b44b47aa6f01350b83000000000"/>'));
    assert.strictEqual(index.fileLevelVersions.get('Catalog.А'), 'ef17bfe954778b44b47aa6f01350b83000000000');
  });

  test('порядок атрибутов не важен', () => {
    const index = parseConfigDumpInfoIndex(wrap('<Metadata configVersion="7" id="1" name="Catalog.А.ObjectModule"/>'));
    assert.strictEqual(index.fileLevelVersions.get('Catalog.А.ObjectModule'), '7');
  });

  test('файл без записей → пустая карта; согласована с fileLevelNamesOf на корпусе-образце', () => {
    assert.strictEqual(parseConfigDumpInfoIndex(wrap('')).fileLevelVersions.size, 0);
    const index = parseConfigDumpInfoIndex(wrap(DOCUMENT));
    assert.deepStrictEqual([...index.fileLevelVersions.keys()], [...index.fileLevelNamesOf('Document.Д')]);
  });
});

suite('ConfigDumpInfoIndex: dumpInfoOwnerOf', () => {
  const cases: [string, string][] = [
    ['Catalog.А', 'Catalog.А'],
    ['Document.Д.ObjectModule', 'Document.Д'],
    ['Document.Д.Form.Ф.Form', 'Document.Д'],
    ['Subsystem.A.Subsystem.B', 'Subsystem.A'],
    ['Configuration.Конфигурация.HomePageWorkArea', 'Configuration.Конфигурация'],
    ['Foo', 'Foo'],
  ];
  for (const [name, owner] of cases) {
    test(`${name} → ${owner}`, () => {
      assert.strictEqual(dumpInfoOwnerOf(name), owner);
    });
  }

  test('согласована с разбором: владелец каждой файловой записи индекса — её ключ в fileLevelNamesOf', () => {
    const index = parseConfigDumpInfoIndex(wrap(DOCUMENT));
    for (const name of index.fileLevelVersions.keys()) {
      assert.ok(index.fileLevelNamesOf(dumpInfoOwnerOf(name)).includes(name), name);
    }
  });
});
