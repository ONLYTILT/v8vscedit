import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readConfigDumpInfoHeader } from '../../infra/xml/dumpInfo/ConfigDumpInfoHeader';
import { EXAMPLE_GENERATIONS, skipWithoutCorpus } from './support/corpus';
import { AgentConfigEmulator } from './support/agentConfigEmulator';

/**
 * Заголовок ConfigDumpInfo.xml (`format`, `version`): файл версий настоящей выгрузки — десятки мегабайт, а
 * решение о пригодности посева зеркала нужно ДО скачивания/чтения чего-либо, поэтому читается только
 * префикс (первые 8 КБ), BOM допускается. Регулярки — только в `infra/xml/` (запрет №1).
 */
suite('readConfigDumpInfoHeader', () => {
  let tmp: string;
  setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-cdi-header-')); });
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const HEADER = '<ConfigDumpInfo xmlns="http://v8.1c.ru/8.3/xcf/dumpinfo" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" format="Hierarchical" version="2.20">';

  function write(content: string | Buffer, name = 'ConfigDumpInfo.xml'): string {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, content);
    return file;
  }

  test('заголовок без BOM: format и version', () => {
    assert.deepStrictEqual(readConfigDumpInfoHeader(write(`<?xml version="1.0" encoding="UTF-8"?>\n${HEADER}\n</ConfigDumpInfo>`)), {
      format: 'Hierarchical',
      version: '2.20',
    });
  });

  test('заголовок с BOM (как у платформы)', () => {
    assert.deepStrictEqual(readConfigDumpInfoHeader(write(`\uFEFF${HEADER}\r\n</ConfigDumpInfo>`)), { format: 'Hierarchical', version: '2.20' });
  });

  test('порядок атрибутов не важен; посторонние атрибуты не мешают', () => {
    const header = '<ConfigDumpInfo version="2.21" xmlns="http://v8.1c.ru/8.3/xcf/dumpinfo" format="Hierarchical" extra="1">';
    assert.deepStrictEqual(readConfigDumpInfoHeader(write(`${header}\n</ConfigDumpInfo>`)), { format: 'Hierarchical', version: '2.21' });
  });

  test('значение format ≠ Hierarchical возвращается как есть (решение о пригодности — у вызывающего)', () => {
    const header = HEADER.replace('Hierarchical', 'Plain');
    assert.strictEqual(readConfigDumpInfoHeader(write(`${header}</ConfigDumpInfo>`))?.format, 'Plain');
  });

  test('заголовок + 10 МБ содержимого: читается префикс, результат верный', () => {
    const file = write(Buffer.concat([Buffer.from(`\uFEFF${HEADER}\n`), Buffer.alloc(10 * 1024 * 1024, 0x20)]));
    assert.deepStrictEqual(readConfigDumpInfoHeader(file), { format: 'Hierarchical', version: '2.20' });
  });

  test('корневой тег за пределами первых 8 КБ не ищется → undefined (файл версий начинается с заголовка)', () => {
    const file = write(`<!--${'x'.repeat(20_000)}-->${HEADER}</ConfigDumpInfo>`);
    assert.strictEqual(readConfigDumpInfoHeader(file), undefined);
  });

  test('битые и неподходящие файлы → undefined: не XML, пустой, корень без атрибутов, нет version, нет format', () => {
    assert.strictEqual(readConfigDumpInfoHeader(write('это не xml')), undefined);
    assert.strictEqual(readConfigDumpInfoHeader(write('')), undefined);
    assert.strictEqual(readConfigDumpInfoHeader(write('<ConfigDumpInfo>\n</ConfigDumpInfo>')), undefined);
    assert.strictEqual(readConfigDumpInfoHeader(write('<ConfigDumpInfo format="Hierarchical">')), undefined);
    assert.strictEqual(readConfigDumpInfoHeader(write('<ConfigDumpInfo version="2.20">')), undefined);
    assert.strictEqual(readConfigDumpInfoHeader(write('<Other format="Hierarchical" version="2.20">')), undefined);
  });

  test('файла нет → undefined, без исключения', () => {
    assert.strictEqual(readConfigDumpInfoHeader(path.join(tmp, 'нет.xml')), undefined);
  });

  test('каталог вместо файла → undefined', () => {
    assert.strictEqual(readConfigDumpInfoHeader(tmp), undefined);
  });

  test('файл версий, который пишет эмулятор агента, читается так же (стенд и разбор согласованы)', () => {
    const emulator = new AgentConfigEmulator(tmp);
    emulator.setObject('Catalog.А', { 'Catalogs/А.xml': '<c/>' });
    emulator.formatVersion = '2.21';
    assert.deepStrictEqual(readConfigDumpInfoHeader(write(emulator.dbFiles()['ConfigDumpInfo.xml'])), { format: 'Hierarchical', version: '2.21' });
  });

  suite('реальный корпус example/2.20 (только чтение)', () => {
    setup(function () { skipWithoutCorpus(this, path.join(EXAMPLE_GENERATIONS.cf20, 'ConfigDumpInfo.xml')); });

    test('ConfigDumpInfo.xml платформы: Hierarchical, версия 2.20', () => {
      assert.deepStrictEqual(readConfigDumpInfoHeader(path.join(EXAMPLE_GENERATIONS.cf20, 'ConfigDumpInfo.xml')), {
        format: 'Hierarchical',
        version: '2.20',
      });
    });
  });
});
