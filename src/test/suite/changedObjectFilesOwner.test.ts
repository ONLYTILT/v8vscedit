import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { META_TYPES } from '../../domain/MetaTypes';
import type { AgentFileEntry } from '../../infra/agent/files/AgentFileStore';
import { AgentTransferCancelledError } from '../../infra/agent/files/AgentFileTransfer';
import { LocalAgentFileStore } from '../../infra/agent/files/LocalAgentFileStore';
import {
  collectOwnerFiles,
  ownerOfProjectFile,
  resolveChangedOwners,
  type ChangedOwner,
} from '../../infra/agent/sync/ChangedObjectFiles';

/**
 * Обратное отображение «файл выгрузки → владелец» и конкурентный сбор файлов владельцев
 * (plan-archive-avoid.md §3.3, §3.5). Обратная карта папка → вид ВЫВОДИТСЯ из той же
 * `buildFolderByEnglishKind(META_TYPES)`, что и прямая: второго словаря нет (запрет №2).
 */

suite('ChangedObjectFiles: ownerOfProjectFile', () => {
  const cases: [string, ReturnType<typeof ownerOfProjectFile>][] = [
    ['Catalogs/Товары.xml', { fullName: 'Catalog.Товары' }],
    ['Catalogs/Товары/Ext/ObjectModule.bsl', { fullName: 'Catalog.Товары' }],
    ['Documents/Д/Forms/Ф/Ext/Form/Module.bsl', { fullName: 'Document.Д' }],
    ['Documents/Д/Templates/М/Ext/Template.xml', { fullName: 'Document.Д' }],
    ['Documents/Д/Commands/К/Ext/CommandModule.bsl', { fullName: 'Document.Д' }],
    ['Configuration.xml', { configuration: true }],
    ['Ext/SessionModule.bsl', { configuration: true }],
    ['Ext/ManagedApplicationModule.bsl', { configuration: true }],
    ['Ext/Help/Вложенный/файл.html', { configuration: true }],
    // Вложенные подсистемы живут в поддереве верхней: владелец — верхняя.
    ['Subsystems/A/Subsystems/B.xml', { fullName: 'Subsystem.A' }],
    ['Subsystems/A/Subsystems/B/Ext/CommandInterface.xml', { fullName: 'Subsystem.A' }],
    ['Roles/Админ/Ext/Rights.xml', { fullName: 'Role.Админ' }],
    // Не принадлежат ни одному владельцу: отказ точечной выгрузки, а не догадка.
    ['Неизвестная/Имя.xml', undefined],
    ['Неизвестная/Имя/Ext/Module.bsl', undefined],
    ['readme.txt', undefined],
    ['ConfigDumpInfo.xml', undefined],
    ['Catalogs', undefined],
    // Файл прямо в папке вида, но не XML владельца: не объект, а мусор — догадки нет.
    ['Catalogs/Товары.txt', undefined],
  ];
  for (const [rel, expected] of cases) {
    test(`${rel} → ${JSON.stringify(expected)}`, () => {
      assert.deepStrictEqual(ownerOfProjectFile(rel), expected);
    });
  }

  test('согласованность с META_TYPES: <folder>/Имя.xml и <folder>/Имя/x → <englishKind ?? kind>.Имя для КАЖДОГО вида с папкой', () => {
    let checked = 0;
    for (const def of Object.values(META_TYPES)) {
      if (def.folder === undefined) {
        continue;
      }
      checked += 1;
      const expected = { fullName: `${def.englishKind ?? def.kind}.Имя` };
      assert.deepStrictEqual(ownerOfProjectFile(`${def.folder}/Имя.xml`), expected, def.kind);
      assert.deepStrictEqual(ownerOfProjectFile(`${def.folder}/Имя/Ext/Module.bsl`), expected, def.kind);
    }
    assert.ok(checked > 30, `видов с папкой: ${String(checked)}`);
  });

  test('обратное отображение согласовано с прямым: файлы resolveChangedOwners возвращаются тому же владельцу', () => {
    const { owners } = resolveChangedOwners([
      { change: 'modified', fullName: 'Catalog.А', kind: 'Catalog', name: 'А', parts: [] },
      { change: 'modified', fullName: 'Configuration.Конфигурация', kind: 'Configuration', name: 'Конфигурация', parts: [] },
    ]);
    for (const owner of owners) {
      const fromXml = ownerOfProjectFile(owner.xmlRel);
      const fromDir = ownerOfProjectFile(`${owner.dirRel}/Ext/Module.bsl`);
      const expected = owner.kind === 'Configuration' ? { configuration: true } : { fullName: owner.fullName };
      assert.deepStrictEqual(fromXml, expected);
      assert.deepStrictEqual(fromDir, expected);
    }
  });
});

/** Локальное хранилище с подсчётом одновременных STAT/LIST: «живой» вызов виден до завершения. */
class MeteredStore extends LocalAgentFileStore {
  inFlight = 0;
  maxInFlight = 0;
  private async metered<T>(run: () => Promise<T>): Promise<T> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await run();
    } finally {
      this.inFlight -= 1;
    }
  }
  override stat(rel: string): Promise<AgentFileEntry | undefined> {
    return this.metered(() => super.stat(rel));
  }
  override list(relDir: string, options?: { readonly recursive?: boolean }): Promise<AgentFileEntry[]> {
    return this.metered(() => super.list(relDir, options));
  }
}

suite('ChangedObjectFiles: collectOwnerFiles с конкурентностью', () => {
  let root: string;
  let store: MeteredStore;
  const owner = (name: string): ChangedOwner => ({
    fullName: `Catalog.${name}`,
    kind: 'Catalog',
    name,
    xmlRel: `Catalogs/${name}.xml`,
    dirRel: `Catalogs/${name}`,
  });

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-owner-files-'));
    store = new MeteredStore(root);
    for (let i = 0; i < 12; i += 1) {
      const name = `О${String(i).padStart(2, '0')}`;
      fs.mkdirSync(path.join(root, 'Catalogs', name, 'Ext'), { recursive: true });
      fs.writeFileSync(path.join(root, 'Catalogs', `${name}.xml`), '<x/>');
      fs.writeFileSync(path.join(root, 'Catalogs', name, 'Ext', 'ObjectModule.bsl'), 'м');
      fs.writeFileSync(path.join(root, 'Catalogs', name, 'Ext', 'Другой.bsl'), 'д');
    }
    // Владелец только с XML, только с каталогом и отсутствующий.
    fs.writeFileSync(path.join(root, 'Catalogs', 'ТолькоXml.xml'), '<x/>');
    fs.mkdirSync(path.join(root, 'Catalogs', 'ТолькоКаталог'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Catalogs', 'ТолькоКаталог', 'файл.txt'), 'ф');
  });
  teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const allOwners = (): ChangedOwner[] => [
    ...Array.from({ length: 12 }, (_, i) => owner(`О${String(i).padStart(2, '0')}`)),
    owner('ТолькоXml'),
    owner('Нет1'),
    owner('ТолькоКаталог'),
    owner('Нет2'),
  ];

  test('результат при любой конкурентности ИДЕНТИЧЕН последовательному, порядок — по порядку владельцев', async () => {
    const sequential = await collectOwnerFiles(store, '', allOwners());
    assert.ok(sequential.files.length >= 12 * 3 + 2);
    assert.deepStrictEqual(sequential.missingOwners.map((o) => o.name), ['Нет1', 'Нет2']);
    // Файлы владельца: сначала его XML, затем поддерево; владельцы — в порядке входного массива.
    assert.deepStrictEqual(sequential.files.slice(0, 1), ['Catalogs/О00.xml']);
    const firstOwnerFiles = sequential.files.filter((rel) => rel.startsWith('Catalogs/О00'));
    assert.deepStrictEqual(sequential.files.slice(0, firstOwnerFiles.length), firstOwnerFiles);

    for (const concurrency of [1, 2, 3, 16]) {
      const parallel = await collectOwnerFiles(store, '', allOwners(), { concurrency });
      assert.deepStrictEqual(parallel, sequential, `concurrency=${String(concurrency)}`);
    }
  });

  test('каталог цели (targetRel) обрезается из путей результата, как и раньше', async () => {
    const nested = new MeteredStore(path.dirname(root));
    const result = await collectOwnerFiles(nested, path.basename(root), [owner('О00'), owner('Нет1')], { concurrency: 2 });
    assert.deepStrictEqual(result.files.slice(0, 1), ['Catalogs/О00.xml']);
    assert.ok(result.files.every((rel) => rel.startsWith('Catalogs/О00')));
    assert.deepStrictEqual(result.missingOwners.map((o) => o.name), ['Нет1']);
  });

  test('одновременных STAT/LIST не больше concurrency (и параллельность реально есть)', async () => {
    await collectOwnerFiles(store, '', allOwners(), { concurrency: 4 });
    assert.ok(store.maxInFlight <= 4, `max=${String(store.maxInFlight)}`);
    assert.ok(store.maxInFlight >= 2, `max=${String(store.maxInFlight)}`);
  });

  test('concurrency=1 — строго последовательно', async () => {
    await collectOwnerFiles(store, '', allOwners(), { concurrency: 1 });
    assert.strictEqual(store.maxInFlight, 1);
  });

  test('без опций прежнее поведение сохранено: ровно тот же результат', async () => {
    const withoutOptions = await collectOwnerFiles(store, '', allOwners());
    const withOptions = await collectOwnerFiles(store, '', allOwners(), { concurrency: 16 });
    assert.deepStrictEqual(withoutOptions, withOptions);
  });

  test('пустой список владельцев → пустой результат', async () => {
    assert.deepStrictEqual(await collectOwnerFiles(store, '', [], { concurrency: 4 }), { files: [], missingOwners: [] });
  });

  test('отмена до старта → AgentTransferCancelledError (неполный список владельцев нельзя отдавать как результат)', async () => {
    await assert.rejects(
      collectOwnerFiles(store, '', allOwners(), { concurrency: 4, cancellation: { isCancellationRequested: true } }),
      AgentTransferCancelledError
    );
  });
});
