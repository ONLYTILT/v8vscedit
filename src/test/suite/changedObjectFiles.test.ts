import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { META_TYPES, type MetaTypeDef } from '../../domain/MetaTypes';
import type { DumpChangedObject } from '../../domain/agent/DumpChangesParser';
import type { AgentFileStore } from '../../infra/agent/files/AgentFileStore';
import { AgentTransferError } from '../../infra/agent/files/AgentFileTransfer';
import type { AgentFileEntry } from '../../infra/agent/files/AgentFileStore';
import { LocalAgentFileStore } from '../../infra/agent/files/LocalAgentFileStore';
import { buildFolderByEnglishKind, collectOwnerFiles, resolveChangedOwners } from '../../infra/agent/sync/ChangedObjectFiles';
import { EXAMPLE_GENERATIONS, skipWithoutCorpus } from './support/corpus';

/**
 * Э7: перевод строк `--get-changes` в файлы выгрузки. Политика пилота (§5b п.10): гранулярность —
 * ВЛАДЕЛЕЦ верхнего уровня (`<EnglishKind>.<Name>`): `<Folder>/<Name>.xml` + всё поддерево
 * `<Folder>/<Name>/`. Вид → папка — ТОЛЬКО через META_TYPES (`englishKind ?? kind`, `folder`),
 * без параллельного словаря (CLAUDE.md, запрет №2).
 */

function line(change: 'added' | 'modified', fullName: string): DumpChangedObject {
  const [kind, name, ...parts] = fullName.split('.');
  return { change, fullName, kind, name, parts };
}

suite('ChangedObjectFiles: resolveChangedOwners (Э7)', () => {
  // Папки заданы НЕЗАВИСИМО от META_TYPES — по раскладке выгрузки 1С; расхождение с таблицей — дефект таблицы.
  const KNOWN_FOLDERS: [string, string][] = [
    ['Catalog', 'Catalogs'],
    ['Document', 'Documents'],
    ['Enum', 'Enums'],
    ['Report', 'Reports'],
    ['DataProcessor', 'DataProcessors'],
    ['InformationRegister', 'InformationRegisters'],
    ['AccumulationRegister', 'AccumulationRegisters'],
    ['AccountingRegister', 'AccountingRegisters'],
    ['ChartOfAccounts', 'ChartsOfAccounts'],
    ['ChartOfCharacteristicTypes', 'ChartsOfCharacteristicTypes'],
    ['BusinessProcess', 'BusinessProcesses'],
    ['Task', 'Tasks'],
    ['ExchangePlan', 'ExchangePlans'],
    ['DocumentJournal', 'DocumentJournals'],
    ['Constant', 'Constants'],
    ['CommonModule', 'CommonModules'],
    ['CommonForm', 'CommonForms'],
    ['CommonCommand', 'CommonCommands'],
    ['CommonTemplate', 'CommonTemplates'],
    ['CommonPicture', 'CommonPictures'],
    ['CommonAttribute', 'CommonAttributes'],
    ['Role', 'Roles'],
    ['Subsystem', 'Subsystems'],
    ['SessionParameter', 'SessionParameters'],
    ['ScheduledJob', 'ScheduledJobs'],
    ['EventSubscription', 'EventSubscriptions'],
    ['FunctionalOption', 'FunctionalOptions'],
    ['FunctionalOptionsParameter', 'FunctionalOptionsParameters'],
    ['DefinedType', 'DefinedTypes'],
    ['SettingsStorage', 'SettingsStorages'],
    ['FilterCriterion', 'FilterCriteria'],
    ['WebService', 'WebServices'],
    ['HTTPService', 'HTTPServices'],
    ['WSReference', 'WSReferences'],
    ['XDTOPackage', 'XDTOPackages'],
    ['StyleItem', 'StyleItems'],
    ['Language', 'Languages'],
    ['Sequence', 'Sequences'],
    ['CommandGroup', 'CommandGroups'],
  ];

  for (const [englishKind, folder] of KNOWN_FOLDERS) {
    test(`${englishKind}.Имя → ${folder}/Имя.xml и поддерево ${folder}/Имя/`, () => {
      const { owners, unresolved } = resolveChangedOwners([line('modified', `${englishKind}.Имя`)]);
      assert.deepStrictEqual(unresolved, []);
      assert.strictEqual(owners.length, 1);
      assert.strictEqual(owners[0].fullName, `${englishKind}.Имя`);
      assert.strictEqual(owners[0].name, 'Имя');
      assert.strictEqual(owners[0].xmlRel, `${folder}/Имя.xml`);
      assert.strictEqual(owners[0].dirRel, `${folder}/Имя`);
    });
  }

  test('согласованность с META_TYPES: каждый вид с папкой разрешается в свою папку по englishKind ?? kind', () => {
    let checked = 0;
    for (const def of Object.values(META_TYPES)) {
      if (!def.folder) {
        continue;
      }
      const english = def.englishKind ?? def.kind;
      const { owners, unresolved } = resolveChangedOwners([line('added', `${english}.Тест`)]);
      assert.deepStrictEqual(unresolved, [], `вид ${def.kind} (${english})`);
      assert.strictEqual(owners[0]?.xmlRel, `${def.folder}/Тест.xml`, `вид ${def.kind}`);
      assert.strictEqual(owners[0]?.dirRel, `${def.folder}/Тест`, `вид ${def.kind}`);
      checked += 1;
    }
    assert.ok(checked > 30, `проверено видов: ${String(checked)}`);
  });

  test('части сворачиваются во владельца верхнего уровня; части и владелец одного объекта — один владелец', () => {
    const result = resolveChangedOwners([
      line('added', 'InformationRegister.МК.RecordSetModule'),
      line('modified', 'InformationRegister.МК'),
      line('modified', 'Document.Заказ.Form.Форма.Form'),
      line('added', 'Document.Заказ.Template.Макет'),
      line('modified', 'Role.Админ.Rights'),
    ]);
    assert.deepStrictEqual(result.unresolved, []);
    assert.deepStrictEqual(result.owners.map((o) => o.fullName), [
      'InformationRegister.МК',
      'Document.Заказ',
      'Role.Админ',
    ], 'порядок — по первому появлению');
    assert.deepStrictEqual(result.owners.map((o) => o.xmlRel), [
      'InformationRegisters/МК.xml',
      'Documents/Заказ.xml',
      'Roles/Админ.xml',
    ]);
  });

  test('вложенная подсистема: Subsystem.A.Subsystem.B → владелец верхнего уровня A (поддерево Subsystems/A/ содержит B)', () => {
    const { owners } = resolveChangedOwners([line('modified', 'Subsystem.Родитель.Subsystem.Дочерняя')]);
    assert.strictEqual(owners.length, 1);
    assert.strictEqual(owners[0].fullName, 'Subsystem.Родитель');
    assert.strictEqual(owners[0].xmlRel, 'Subsystems/Родитель.xml');
    assert.strictEqual(owners[0].dirRel, 'Subsystems/Родитель');
  });

  test('Configuration.<имя> → Configuration.xml и поддерево Ext/ (модули и интерфейс конфигурации), но не вся выгрузка', () => {
    for (const fullName of [
      'Configuration.Конфигурация',
      'Configuration.Конфигурация.SessionModule',
      'Configuration.Конфигурация.ManagedApplicationModule',
      'Configuration.Конфигурация.CommandInterface',
      'Configuration.Конфигурация.HomePageWorkArea',
      'Configuration.Конфигурация.ClientApplicationInterface',
    ]) {
      const { owners, unresolved } = resolveChangedOwners([line('modified', fullName)]);
      assert.deepStrictEqual(unresolved, [], fullName);
      assert.strictEqual(owners.length, 1, fullName);
      assert.strictEqual(owners[0].xmlRel, 'Configuration.xml', fullName);
      assert.strictEqual(owners[0].dirRel, 'Ext', fullName);
    }
  });

  test('неизвестный вид, вид без папки (дочерний/служебный) → unresolved, остальные владельцы разрешаются', () => {
    const result = resolveChangedOwners([
      line('modified', 'Catalog.Товары'),
      line('modified', 'Foo.Bar'),
      line('added', 'Attribute.Реквизит'),
      line('modified', 'Extension.Расш'),
      line('modified', 'Foo.Bar.Part'),
    ]);
    assert.deepStrictEqual(result.owners.map((o) => o.fullName), ['Catalog.Товары']);
    assert.deepStrictEqual(result.unresolved, ['Foo.Bar', 'Attribute.Реквизит', 'Extension.Расш', 'Foo.Bar.Part']);
  });

  test('пустой вход → пустой результат', () => {
    assert.deepStrictEqual(resolveChangedOwners([]), { owners: [], unresolved: [] });
  });

  test('имя вида чувствительно к регистру: catalog.X — не Catalog.X', () => {
    const result = resolveChangedOwners([line('modified', 'catalog.Товары')]);
    assert.deepStrictEqual(result.owners, []);
    assert.deepStrictEqual(result.unresolved, ['catalog.Товары']);
  });
});

suite('ChangedObjectFiles: buildFolderByEnglishKind (Э7)', () => {
  // В реестре у всех видов с папкой englishKind задан явно; контракт META_TYPES допускает его
  // отсутствие («по умолчанию = kind») — фолбэк проверяется на синтетических записях.
  test('вид без englishKind берётся по kind, вид без folder в карту не попадает', () => {
    const base = META_TYPES.Catalog;
    const defs: MetaTypeDef[] = [
      { ...base, kind: 'Catalog', englishKind: undefined, folder: 'Catalogs' },
      { ...base, kind: 'Document', englishKind: 'Document', folder: 'Documents' },
      { ...base, kind: 'configuration', englishKind: 'Configuration', folder: undefined },
    ];
    const map = buildFolderByEnglishKind(defs);
    assert.deepStrictEqual([...map.entries()], [['Catalog', 'Catalogs'], ['Document', 'Documents']]);
  });
});

suite('ChangedObjectFiles: collectOwnerFiles (Э7)', () => {
  let tempRoot: string;
  const TARGET = 'workspace/ab/cf';
  let store: LocalAgentFileStore;

  function put(rel: string, content = 'x'): void {
    const abs = path.join(tempRoot, ...TARGET.split('/'), ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  setup(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-changed-owner-'));
    store = new LocalAgentFileStore(tempRoot);
    put('Configuration.xml');
    put('ConfigDumpInfo.xml');
    put('Catalogs/Товары.xml');
    put('Catalogs/Товары/Ext/ObjectModule.bsl');
    put('Catalogs/Товары/Forms/Форма.xml');
    put('Catalogs/Товары/Forms/Форма/Ext/Form.xml');
    put('Catalogs/Товары/Forms/Форма/Ext/Form/Module.bsl');
    put('Catalogs/Клиенты.xml');
    put('Roles/Админ.xml');
    put('Roles/Админ/Ext/Rights.xml');
    put('CommonPictures/Лого.xml');
    put('CommonPictures/Лого/Ext/Picture/Picture.png', 'png');
  });
  teardown(() => { fs.rmSync(tempRoot, { recursive: true, force: true }); });

  test('владелец с поддеревом: XML + все файлы подкаталога (любого расширения), пути от каталога цели; порядок не специфицирован', async () => {
    const { owners } = resolveChangedOwners([line('modified', 'Catalog.Товары'), line('modified', 'CommonPicture.Лого')]);
    const result = await collectOwnerFiles(store, TARGET, owners);
    assert.deepStrictEqual(result.missingOwners, []);
    assert.deepStrictEqual([...result.files].sort(), [
      'Catalogs/Товары.xml',
      'Catalogs/Товары/Ext/ObjectModule.bsl',
      'Catalogs/Товары/Forms/Форма.xml',
      'Catalogs/Товары/Forms/Форма/Ext/Form.xml',
      'Catalogs/Товары/Forms/Форма/Ext/Form/Module.bsl',
      'CommonPictures/Лого.xml',
      'CommonPictures/Лого/Ext/Picture/Picture.png',
    ].sort());
  });

  test('владелец без подкаталога — только его XML; соседние объекты и служебные файлы не попадают', async () => {
    const { owners } = resolveChangedOwners([line('modified', 'Catalog.Клиенты')]);
    const result = await collectOwnerFiles(store, TARGET, owners);
    assert.deepStrictEqual(result.files, ['Catalogs/Клиенты.xml']);
  });

  test('Configuration → Configuration.xml и файлы Ext/; ConfigDumpInfo.xml и каталоги объектов не попадают', async () => {
    put('Ext/SessionModule.bsl');
    put('Ext/ManagedApplicationModule.bsl');
    put('Ext/ClientApplicationInterface.xml');
    const { owners } = resolveChangedOwners([line('modified', 'Configuration.Конфигурация.SessionModule')]);
    const result = await collectOwnerFiles(store, TARGET, owners);
    assert.deepStrictEqual([...result.files].sort(), [
      'Configuration.xml',
      'Ext/ClientApplicationInterface.xml',
      'Ext/ManagedApplicationModule.bsl',
      'Ext/SessionModule.bsl',
    ]);
    assert.deepStrictEqual(result.missingOwners, []);
  });

  test('Configuration без каталога Ext/ — только Configuration.xml, владелец не «отсутствует»', async () => {
    const { owners } = resolveChangedOwners([line('modified', 'Configuration.Конфигурация')]);
    const result = await collectOwnerFiles(store, TARGET, owners);
    assert.deepStrictEqual(result.files, ['Configuration.xml']);
    assert.deepStrictEqual(result.missingOwners, []);
  });

  test('владельца нет на сервере (ни XML, ни каталога) → missingOwners; остальные собираются', async () => {
    const { owners } = resolveChangedOwners([line('modified', 'Catalog.Удалённый'), line('modified', 'Role.Админ')]);
    const result = await collectOwnerFiles(store, TARGET, owners);
    assert.deepStrictEqual(result.missingOwners.map((o) => o.fullName), ['Catalog.Удалённый']);
    assert.deepStrictEqual([...result.files].sort(), ['Roles/Админ.xml', 'Roles/Админ/Ext/Rights.xml'].sort());
  });

  test('есть только каталог владельца (XML нет) — владелец не «отсутствует», файлы каталога собираются', async () => {
    fs.unlinkSync(path.join(tempRoot, ...TARGET.split('/'), 'Roles', 'Админ.xml'));
    const { owners } = resolveChangedOwners([line('modified', 'Role.Админ')]);
    const result = await collectOwnerFiles(store, TARGET, owners);
    assert.deepStrictEqual(result.missingOwners, []);
    assert.deepStrictEqual(result.files, ['Roles/Админ/Ext/Rights.xml']);
  });

  test('нет владельцев → пустой результат без обращений к хранилищу', async () => {
    const exploding = new Proxy({}, {
      get: () => () => { throw new Error('хранилище не должно вызываться'); },
    }) as unknown as AgentFileStore;
    assert.deepStrictEqual(await collectOwnerFiles(exploding, TARGET, []), { files: [], missingOwners: [] });
  });

  test('каталог цели — сам корень хранилища (пустой targetRel): пути без префикса, от корня', async () => {
    const rootStore = new LocalAgentFileStore(path.join(tempRoot, ...TARGET.split('/')));
    const { owners } = resolveChangedOwners([line('modified', 'Role.Админ'), line('modified', 'Catalog.Нет')]);
    const result = await collectOwnerFiles(rootStore, '', owners);
    assert.deepStrictEqual([...result.files].sort(), ['Roles/Админ.xml', 'Roles/Админ/Ext/Rights.xml']);
    assert.deepStrictEqual(result.missingOwners.map((owner) => owner.fullName), ['Catalog.Нет']);
  });
});

suite('ChangedObjectFiles: на реальном корпусе example/2.20 (только чтение)', () => {
  setup(function () { skipWithoutCorpus(this, EXAMPLE_GENERATIONS.cf20); });

  test('все владельцы верхнего уровня из ConfigDumpInfo.xml корпуса сопоставляются существующим <Folder>/<Name>.xml', function () {
    this.timeout(120_000);
    const dumpInfo = path.join(EXAMPLE_GENERATIONS.cf20, 'ConfigDumpInfo.xml');
    if (!fs.existsSync(dumpInfo)) {
      this.skip();
    }
    const text = fs.readFileSync(dumpInfo, 'utf-8');
    const names = new Set<string>();
    for (const match of text.matchAll(/<Metadata name="([^"]+)"/g)) {
      if (match[1].split('.').length === 2) {
        names.add(match[1]);
      }
    }
    assert.ok(names.size > 1000, `владельцев в корпусе: ${String(names.size)}`);

    const missing: string[] = [];
    const kinds = new Set<string>();
    for (const fullName of names) {
      const { owners, unresolved } = resolveChangedOwners([line('modified', fullName)]);
      if (unresolved.length > 0) {
        missing.push(`${fullName}: unresolved`);
        continue;
      }
      kinds.add(fullName.split('.')[0]);
      const owner = owners[0];
      if (!fs.existsSync(path.join(EXAMPLE_GENERATIONS.cf20, ...owner.xmlRel.split('/')))) {
        missing.push(`${fullName}: нет ${owner.xmlRel}`);
      }
    }
    assert.deepStrictEqual(missing.slice(0, 10), [], `не сопоставлено: ${String(missing.length)}`);
    assert.ok(kinds.size >= 30, `видов в выборке: ${String(kinds.size)}`);
  });

  test('collectOwnerFiles на настоящем документе корпуса = XML + рекурсивный обход его каталога', async () => {
    const root = EXAMPLE_GENERATIONS.cf20;
    const documents = fs.readdirSync(path.join(root, 'Documents'), { withFileTypes: true });
    const dirName = documents.find((e) => e.isDirectory() && fs.existsSync(path.join(root, 'Documents', `${e.name}.xml`)))?.name;
    assert.ok(dirName, 'в корпусе есть документ с каталогом');

    const walk = (dir: string, rel: string, out: string[]): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const childRel = `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), childRel, out);
        } else {
          out.push(childRel);
        }
      }
    };
    const expected = [`Documents/${dirName}.xml`];
    walk(path.join(root, 'Documents', dirName), `Documents/${dirName}`, expected);

    const { owners } = resolveChangedOwners([line('modified', `Document.${dirName}`)]);
    const result = await collectOwnerFiles(new LocalAgentFileStore(root), '', owners);
    assert.deepStrictEqual([...result.files].sort(), expected.sort());
  });
});

suite('ChangedObjectFiles: collectOwnerFiles — отказ чтения каталогов (4e)', () => {
  test('list бросает: AgentTransferError с action = list и именем владельца в failures[0].path', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-changed-owner-list-'));
    try {
      const abs = path.join(tempRoot, 'ws', 'Catalogs', 'Товары', 'Ext');
      fs.mkdirSync(abs, { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'ws', 'Catalogs', 'Товары.xml'), 'x');
      fs.writeFileSync(path.join(abs, 'ObjectModule.bsl'), 'x');
      class FailingListStore extends LocalAgentFileStore {
        override list(): Promise<AgentFileEntry[]> { return Promise.reject(new Error('листинг недоступен')); }
      }
      const { owners } = resolveChangedOwners([line('modified', 'Catalog.Товары')]);
      await assert.rejects(
        collectOwnerFiles(new FailingListStore(tempRoot), 'ws', owners),
        (error: unknown) => error instanceof AgentTransferError
          && error.action === 'list'
          && error.failures[0].path === 'Catalog.Товары'
          && error.message.startsWith('Не удалось прочитать каталоги агента')
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
