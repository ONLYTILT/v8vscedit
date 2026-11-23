/**
 * Разбор пути открытого в редакторе файла в цель навигатора («Показать в дереве метаданных»).
 * Модуль работает только со строкой пути (файлов на диске не требует), поэтому пути — синтетические.
 */
import * as assert from 'assert';
import * as path from 'path';
import { isMetadataFile, resolveMetadataFileTarget } from '../../infra/fs/MetadataFileTarget';

const PROJECT = path.resolve('C:\\work\\project');
const CF = path.join(PROJECT, 'src', 'cf');
const CFE = path.join(PROJECT, 'src', 'cfe', 'EVOLC');
const ROOTS = [CF, CFE];

const inCf = (...segments: string[]): string => path.join(CF, ...segments);

suite('MetadataFileTarget — путь файла выгрузки → цель в дереве', () => {
  test('Configuration.xml и модули конфигурации (Ext/*) ведут к корню', () => {
    for (const file of [inCf('Configuration.xml'), inCf('Ext', 'SessionModule.bsl'), inCf('Ext', 'ManagedApplicationModule.bsl')]) {
      assert.deepStrictEqual(resolveMetadataFileTarget(ROOTS, file), { configRoot: CF }, file);
    }
  });

  test('корень расширения выбирается по самому длинному префиксу', () => {
    assert.deepStrictEqual(resolveMetadataFileTarget(ROOTS, path.join(CFE, 'Configuration.xml')), { configRoot: CFE });
    assert.deepStrictEqual(
      resolveMetadataFileTarget([CF, path.join(CF, 'nested')], path.join(CF, 'nested', 'Configuration.xml')),
      { configRoot: path.join(CF, 'nested') }
    );
  });

  test('XML и модули объекта (плоская и глубокая раскладка) ведут к объекту', () => {
    const cases: readonly string[] = [
      inCf('Catalogs', 'Товары.xml'),
      inCf('Catalogs', 'Товары', 'Товары.xml'),
      inCf('Catalogs', 'Товары', 'Ext', 'ObjectModule.bsl'),
      inCf('Catalogs', 'Товары', 'Ext', 'ManagerModule.bsl'),
      inCf('Catalogs', 'Товары', 'Ext', 'Help.xml'),
      inCf('Catalogs', 'Товары', 'Ext', 'Predefined.xml'),
      // Каталог группы без имени дочернего элемента — это ещё сам объект.
      inCf('Catalogs', 'Товары', 'Forms'),
    ];
    for (const file of cases) {
      assert.deepStrictEqual(
        resolveMetadataFileTarget(ROOTS, file),
        { configRoot: CF, object: { kind: 'Catalog', names: ['Товары'] } },
        file
      );
    }
    assert.deepStrictEqual(
      resolveMetadataFileTarget(ROOTS, inCf('CommonModules', 'ОбщегоНазначения', 'Ext', 'Module.bsl')),
      { configRoot: CF, object: { kind: 'CommonModule', names: ['ОбщегоНазначения'] } }
    );
  });

  test('форма: дескриптор, тело и модуль ведут к узлу формы', () => {
    for (const file of [
      inCf('Catalogs', 'Товары', 'Forms', 'ФормаЭлемента.xml'),
      inCf('Catalogs', 'Товары', 'Forms', 'ФормаЭлемента', 'Ext', 'Form.xml'),
      inCf('Catalogs', 'Товары', 'Forms', 'ФормаЭлемента', 'Ext', 'Form', 'Module.bsl'),
    ]) {
      assert.deepStrictEqual(
        resolveMetadataFileTarget(ROOTS, file),
        { configRoot: CF, object: { kind: 'Catalog', names: ['Товары'], child: { kind: 'Form', name: 'ФормаЭлемента' } } },
        file
      );
    }
  });

  test('макет: дескриптор, тело и бинарное содержимое ведут к узлу макета', () => {
    for (const file of [
      inCf('Reports', 'Продажи', 'Templates', 'Схема.xml'),
      inCf('Reports', 'Продажи', 'Templates', 'Схема', 'Ext', 'Template.xml'),
      inCf('Reports', 'Продажи', 'Templates', 'Схема', 'Ext', 'Template.bin'),
    ]) {
      assert.deepStrictEqual(
        resolveMetadataFileTarget(ROOTS, file),
        { configRoot: CF, object: { kind: 'Report', names: ['Продажи'], child: { kind: 'Template', name: 'Схема' } } },
        file
      );
    }
  });

  test('модуль команды объекта ведёт к узлу команды', () => {
    assert.deepStrictEqual(
      resolveMetadataFileTarget(ROOTS, inCf('Catalogs', 'Товары', 'Commands', 'Печать', 'Ext', 'CommandModule.bsl')),
      { configRoot: CF, object: { kind: 'Catalog', names: ['Товары'], child: { kind: 'Command', name: 'Печать' } } }
    );
  });

  test('вложенная подсистема — цепочка имён от верхней к вложенной', () => {
    for (const file of [
      inCf('Subsystems', 'Продажи', 'Subsystems', 'Опт.xml'),
      inCf('Subsystems', 'Продажи', 'Subsystems', 'Опт', 'Ext', 'CommandInterface.xml'),
    ]) {
      assert.deepStrictEqual(
        resolveMetadataFileTarget(ROOTS, file),
        { configRoot: CF, object: { kind: 'Subsystem', names: ['Продажи', 'Опт'] } },
        file
      );
    }
    assert.deepStrictEqual(
      resolveMetadataFileTarget(ROOTS, inCf('Subsystems', 'Продажи', 'Subsystems', 'Опт', 'Subsystems', 'Мелкий.xml')),
      { configRoot: CF, object: { kind: 'Subsystem', names: ['Продажи', 'Опт', 'Мелкий'] } }
    );
    assert.deepStrictEqual(
      resolveMetadataFileTarget(ROOTS, inCf('Subsystems', 'Продажи', 'Subsystems')),
      { configRoot: CF, object: { kind: 'Subsystem', names: ['Продажи'] } }
    );
    assert.deepStrictEqual(
      resolveMetadataFileTarget(ROOTS, inCf('Subsystems', 'Продажи.xml')),
      { configRoot: CF, object: { kind: 'Subsystem', names: ['Продажи'] } }
    );
  });

  test('регистр буквы диска и разделители не мешают определить корень', () => {
    const lowered = inCf('Catalogs', 'Товары.xml').replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
    assert.deepStrictEqual(
      resolveMetadataFileTarget(ROOTS, lowered),
      { configRoot: CF, object: { kind: 'Catalog', names: ['Товары'] } }
    );
  });

  test('файлы вне метаданных — null', () => {
    const outside: readonly string[] = [
      path.join(PROJECT, 'README.md'),
      path.join(PROJECT, 'src', 'cfOther', 'Catalogs', 'Товары.xml'),
      inCf('ConfigDumpInfo.xml'),
      inCf('Unknown', 'X.xml'),
      inCf('Catalogs'),
      CF,
    ];
    for (const file of outside) {
      assert.strictEqual(resolveMetadataFileTarget(ROOTS, file), null, file);
      assert.strictEqual(isMetadataFile(ROOTS, file), false, file);
    }
    assert.strictEqual(resolveMetadataFileTarget([], inCf('Catalogs', 'Товары.xml')), null);
  });

  test('isMetadataFile — истина ровно для путей, у которых есть цель', () => {
    assert.strictEqual(isMetadataFile(ROOTS, inCf('Catalogs', 'Товары', 'Ext', 'ObjectModule.bsl')), true);
    assert.strictEqual(isMetadataFile(ROOTS, inCf('Configuration.xml')), true);
  });
});
