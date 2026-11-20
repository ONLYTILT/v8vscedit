import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentConfigEmulator, ageAgentTree, cdiSuffixOfFile } from './support/agentConfigEmulator';
import { removeTreeSync } from './support/tempTree';
import { BOM, ROOT_MODULE, ROOT_OWNER, VENDOR_BIN, VENDOR_CF, seedVendor, updateVendor } from './support/largeFilesFixtures';

/**
 * Самопроверка стенда (plan-large-files.md §5.3, ФАКТ Э27): эмулятор умеет конфигурацию поставщика (одна файловая запись CDI
 * `…ParentConfigurations` на `.bin` и все `.cf`), три режима строк списка изменений и два режима `--update` корня. Тесты
 * шлюза на движке опираются на эту модель, поэтому она проверяется сама по себе.
 */
const MIRROR = 'm';
const DUMP = `config dump-config-to-files --dir=${MIRROR} --format=hierarchical --force`;

suite('AgentConfigEmulator: конфигурация поставщика и режимы списка изменений (ФАКТ Э27)', () => {
  let root: string;
  let emulator: AgentConfigEmulator;

  setup(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-emu-vendor-'));
    emulator = new AgentConfigEmulator(root);
    emulator.setObject(ROOT_OWNER, { 'Configuration.xml': '<Configuration/>' });
    seedVendor(emulator);
    emulator.putFile('Ext/HomePageWorkArea.xml', '<HomePageWorkArea/>');
    emulator.updateGranularity = 'changed-files';
    await emulator.execute(DUMP);
    ageAgentTree(path.join(root, MIRROR));
  });
  teardown(() => { removeTreeSync(root); });

  const mAbs = (rel: string): string => path.join(root, MIRROR, ...rel.split('/'));
  const mtimeM = (rel: string): number => fs.statSync(mAbs(rel)).mtimeMs;
  const changes = async (): Promise<string> => {
    await emulator.execute(`config dump-config-to-files --dir=${MIRROR} --format=hierarchical --update --get-changes=c.txt`);
    return fs.readFileSync(path.join(root, 'c.txt'), 'utf-8');
  };
  const update = (): Promise<unknown> => emulator.execute(`config dump-config-to-files --dir=${MIRROR} --format=hierarchical --update --force`);

  test('одна файловая запись CDI покрывает .bin и все .cf поставщика', () => {
    assert.strictEqual(cdiSuffixOfFile(ROOT_OWNER, VENDOR_BIN), '.ParentConfigurations');
    assert.strictEqual(cdiSuffixOfFile(ROOT_OWNER, VENDOR_CF), '.ParentConfigurations');
    assert.strictEqual(cdiSuffixOfFile(ROOT_OWNER, 'Ext/ParentConfigurations/sub/x.cf'), '.ParentConfigurations');
    const names = emulator.cdiNamesOf(ROOT_OWNER);
    assert.strictEqual(names.filter((name) => name.endsWith('.ParentConfigurations')).length, 1);
  });

  test('explicit (по умолчанию): строки только переданных частей — прежнее поведение', async () => {
    emulator.putFile(ROOT_MODULE, 'v2', ['ManagedApplicationModule']);
    assert.strictEqual(await changes(), `${BOM}Modified: ${ROOT_OWNER}.ManagedApplicationModule\r\nModified: ${ROOT_OWNER}\r\n`);
  });

  test('changed-parts: новая часть — New, изменённая — Modified, нетронутые частей не дают; владелец — Modified', async () => {
    emulator.changeLines = 'changed-parts';
    emulator.putFile(ROOT_MODULE, 'v2');
    emulator.putFile('Ext/HomePageWorkArea.xml', '<HomePageWorkArea v="2"/>');
    assert.strictEqual(
      await changes(),
      `${BOM}Modified: ${ROOT_OWNER}.HomePageWorkArea\r\nNew: ${ROOT_OWNER}.ManagedApplicationModule\r\nModified: ${ROOT_OWNER}\r\n`
    );
  });

  test('changed-parts: часть поставщика меняется целиком (.bin и .cf — одна запись)', async () => {
    emulator.changeLines = 'changed-parts';
    updateVendor(emulator);
    assert.strictEqual(await changes(), `${BOM}Modified: ${ROOT_OWNER}.ParentConfigurations\r\nModified: ${ROOT_OWNER}\r\n`);
  });

  test('changed-parts: ФАКТ Э27 — правка модуля корня не называет часть поставщика', async () => {
    emulator.changeLines = 'changed-parts';
    emulator.putFile(ROOT_MODULE, 'v2');
    const text = await changes();
    assert.ok(!text.includes('ParentConfigurations'), text);
  });

  test('all-parts: строки ВСЕХ файловых частей владельца (сверхприближение)', async () => {
    emulator.changeLines = 'all-parts';
    emulator.putFile(ROOT_MODULE, 'v2');
    const text = await changes();
    assert.ok(text.includes(`Modified: ${ROOT_OWNER}.ParentConfigurations\r\n`), text);
    assert.ok(text.includes(`Modified: ${ROOT_OWNER}.HomePageWorkArea\r\n`), text);
    assert.ok(text.includes(`New: ${ROOT_OWNER}.ManagedApplicationModule\r\n`), text);
    assert.ok(text.endsWith(`Modified: ${ROOT_OWNER}\r\n`), text);
  });

  test('новый владелец в changed-parts: все его части — New', async () => {
    emulator.changeLines = 'changed-parts';
    emulator.setObject('Catalog.Новый', { 'Catalogs/Новый.xml': '<Catalog/>', 'Catalogs/Новый/Ext/ObjectModule.bsl': 'м' });
    const text = await changes();
    assert.ok(text.includes('New: Catalog.Новый.ObjectModule\r\n'), text);
    assert.ok(text.includes('New: Catalog.Новый\r\n'), text);
  });

  test('rewriteWholeRootOnUpdate: --update при изменённом корне обновляет mtime ВСЕХ файлов корня, включая .cf', async () => {
    emulator.rewriteWholeRootOnUpdate = true;
    const before = mtimeM(VENDOR_CF);
    emulator.putFile(ROOT_MODULE, 'v2');
    await update();
    assert.ok(mtimeM(VENDOR_CF) > before, '.cf переписан');
    assert.ok(mtimeM(VENDOR_BIN) > before, '.bin переписан');
    assert.strictEqual(fs.readFileSync(mAbs(ROOT_MODULE), 'utf-8'), 'v2');
  });

  test('без rewriteWholeRootOnUpdate (ФАКТ Э27): переписываются только изменённые файлы — .cf остаётся старым', async () => {
    const before = mtimeM(VENDOR_CF);
    emulator.putFile(ROOT_MODULE, 'v2');
    await update();
    assert.strictEqual(mtimeM(VENDOR_CF), before, '.cf не тронут');
    assert.strictEqual(fs.readFileSync(mAbs(ROOT_MODULE), 'utf-8'), 'v2');
  });

  test('rewriteWholeRootOnUpdate касается только корня: файл обычного владельца остаётся нетронутым', async () => {
    emulator.setObject('Catalog.Клиенты', { 'Catalogs/Клиенты.xml': '<Catalog/>', 'Catalogs/Клиенты/Ext/ObjectModule.bsl': 'м' });
    await emulator.execute(DUMP);
    ageAgentTree(path.join(root, MIRROR));
    emulator.rewriteWholeRootOnUpdate = true;
    const before = mtimeM('Catalogs/Клиенты/Ext/ObjectModule.bsl');
    emulator.putFile('Catalogs/Клиенты.xml', '<Catalog v="2"/>');
    emulator.putFile(ROOT_MODULE, 'v3');
    await update();
    assert.strictEqual(mtimeM('Catalogs/Клиенты/Ext/ObjectModule.bsl'), before);
  });
});
