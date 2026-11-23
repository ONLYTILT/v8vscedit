import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { RoleRightsService } from '../../infra/role';
import { diffSnapshots, snapshotTree } from './support/fsSnapshot';
import {
  REFERENCE_VARIANT,
  makeTempRoot,
  objectLines,
  rightsFileText,
  scaffoldConfiguration,
  writeRights,
} from './support/rightsFixtures';
import { removeTreeSync } from './support/tempTree';

/**
 * Сервисы ролей поверх каталога прав: compile_role (strict, до записи), edit_role (grant —
 * strict, revoke/setRls — lenient, имя конфигурации), validate_role (единый предикат прав).
 * Тексты предупреждений валидатора сохранены: меняется критерий, а не формулировки.
 */

const service = new RoleRightsService();

suite('Права ролей: сервисы', () => {
  const roots: string[] = [];
  const newRoot = (prefix: string): string => {
    const root = makeTempRoot(prefix);
    roots.push(root);
    return root;
  };
  teardown(() => {
    for (const root of roots.splice(0)) {
      removeTreeSync(root);
    }
  });

  const configRoot = (): string => {
    const root = newRoot('v8vscedit-role-cat-');
    scaffoldConfiguration(root);
    return root;
  };

  suite('compile_role', () => {
    test('имена объектов: канон MCP, единственное число и английская форма дают канонические английские имена', () => {
      const root = configRoot();
      const result = service.compile({
        outputDir: root,
        definition: {
          name: 'Смешанная',
          objects: [
            'Справочники.Товары: Read,View',
            'РегистрСведений.МК_Курсы: @view',
            'Document.Заказ: Read',
            'Подсистема.Продажи.Розница: View',
            'Справочники.Товары.Реквизит.Цена: View,Edit',
            'Конфигурация: ThinClient',
            { name: 'РегистрыСведений.Остатки', rights: { Read: true, Update: false } },
          ],
        },
      });
      const xml = fs.readFileSync(result.rightsPath, 'utf-8');
      for (const name of [
        'Catalog.Товары',
        'InformationRegister.МК_Курсы',
        'Document.Заказ',
        'Subsystem.Продажи.Subsystem.Розница',
        'Catalog.Товары.Attribute.Цена',
        'Configuration.Основа',
        'InformationRegister.Остатки',
      ]) {
        assert.ok(xml.includes(`<name>${name}</name>`), `нет объекта ${name}`);
      }
      assert.ok(!xml.includes('<name>Справочники.'), 'русские имена в файл не попадают');
      assert.ok(!xml.includes('<name>Configuration</name>'), 'голого Configuration нет');
    });

    test('новый Rights.xml: xsi:type="Rights", без BOM, хвостовой перевод строки сохранён', () => {
      const root = configRoot();
      const result = service.compile({ outputDir: root, definition: { name: 'Новая', objects: ['Catalog.Товары: Read'] } });
      const xml = fs.readFileSync(result.rightsPath, 'utf-8');
      assert.ok(xml.includes('xsi:type="Rights"'));
      assert.notStrictEqual(xml.charCodeAt(0), 0xfeff);
      assert.ok(xml.endsWith('</Rights>\n'));
    });

    test('неизвестное право известного типа: предупреждение и пропуск, остальные права выданы', () => {
      const root = configRoot();
      const result = service.compile({ outputDir: root, definition: { name: 'ЛишнееПраво', objects: ['Справочники.Товары: Read,Foo'] } });
      const xml = fs.readFileSync(result.rightsPath, 'utf-8');
      assert.ok(xml.includes('<name>Read</name>'));
      assert.ok(!xml.includes('<name>Foo</name>'));
      assert.ok(result.warnings.some((warning) => warning.includes('Foo')), result.warnings.join('; '));
    });

    const badNames: readonly { readonly name: string; readonly objects: readonly string[]; readonly message: RegExp }[] = [
      { name: 'неизвестный тип верхнего уровня', objects: ['Foo.Bar: Read'], message: /Foo/ },
      { name: 'атрибут без вида', objects: ['Справочники.X.ИНН: View'], message: /Реквизит\.ИНН/ },
      { name: 'нечётное число сегментов', objects: ['Справочники.X.Реквизит.Y.Z: View'], message: /./ },
    ];
    for (const c of badNames) {
      test(`ошибка имени (${c.name}): исключение ДО любой записи, Configuration.xml не тронут`, () => {
        const root = configRoot();
        const before = snapshotTree(root);
        const configBefore = fs.readFileSync(path.join(root, 'Configuration.xml'));
        assert.throws(
          () => service.compile({ outputDir: root, definition: { name: 'Плохая', objects: ['Catalog.Хороший: Read', ...c.objects] } }),
          (error: unknown) => error instanceof Error && c.message.test(error.message),
        );
        assert.deepStrictEqual(diffSnapshots(before, snapshotTree(root)), [], 'ни каталога Roles, ни файлов роли');
        assert.ok(fs.readFileSync(path.join(root, 'Configuration.xml')).equals(configBefore));
        assert.strictEqual(fs.existsSync(path.join(root, 'Roles')), false);
      });
    }

    test('ошибка в объектной форме определения (name) — тоже исключение до записи', () => {
      const root = configRoot();
      const before = snapshotTree(root);
      assert.throws(
        () => service.compile({ outputDir: root, definition: { name: 'Плохая2', objects: [{ name: 'Foo.Bar', rights: ['Read'] }] } }),
        /Foo/,
      );
      assert.deepStrictEqual(diffSnapshots(before, snapshotTree(root)), []);
    });

    test('Конфигурация без Configuration.xml: имя конфигурации неизвестно — исключение до записи', () => {
      const root = newRoot('v8vscedit-role-noconfig-');
      assert.throws(
        () => service.compile({ outputDir: root, definition: { name: 'БезКонфигурации', objects: ['Конфигурация: ThinClient'] } }),
        /конфигурац/i,
      );
      assert.strictEqual(fs.existsSync(path.join(root, 'Roles')), false);
    });
  });

  suite('validate_role: предикат прав — isAllowedRight, тексты прежние', () => {
    const cases: readonly { readonly object: string; readonly right: string; readonly warn: RegExp | null }[] = [
      { object: 'Catalog.X', right: 'Foo', warn: /неизвестное право "Foo"/ },
      { object: 'Catalog.X', right: 'ReadDataHistory', warn: null },
      { object: 'BusinessProcess.Б', right: 'ReadDataHistory', warn: null },
      { object: 'BusinessProcess.Б', right: 'InteractiveDeleteMarked', warn: null },
      { object: 'Task.З', right: 'SwitchToDataHistoryVersion', warn: null },
      { object: 'ChartOfAccounts.П', right: 'ViewDataHistory', warn: null },
      { object: 'Configuration.Основа', right: 'ExclusiveModeTerminationAtSessionStart', warn: null },
      { object: 'Catalog.X.Command.К', right: 'Edit', warn: /не является правом команды/ },
      { object: 'Catalog.X.Command.К', right: 'View', warn: null },
      { object: 'IntegrationService.И.IntegrationServiceChannel.К', right: 'View', warn: /не является правом канала сервиса интеграции/ },
      { object: 'IntegrationService.И.IntegrationServiceChannel.К', right: 'Use', warn: null },
      { object: 'Catalog.X.Attribute.А', right: 'Read', warn: /не является правом дочернего объекта/ },
      { object: 'Catalog.X.Attribute.А', right: 'View', warn: null },
      { object: 'WebService.С.Operation.О', right: 'Use', warn: null },
      { object: 'WebService.С.Operation.О', right: 'View', warn: /не является правом дочернего объекта/ },
      { object: 'HTTPService.С.URLTemplate.Ш.Method.М', right: 'Use', warn: null },
    ];
    for (const c of cases) {
      test(`${c.object} / ${c.right}: ${c.warn ? 'предупреждение' : 'без предупреждений'}`, () => {
        const root = newRoot('v8vscedit-role-validate-');
        const rightsPath = writeRights(root, 'Р', rightsFileText(objectLines(c.object, [[c.right, 'true']])));
        const report = service.validate({ rightsPath, detailed: true });
        const own = report.issues.filter((issue) => issue.severity === 'warning' && issue.message.startsWith(`${c.object}:`));
        if (c.warn) {
          assert.strictEqual(own.length, 1, JSON.stringify(own));
          assert.match(own[0].message, c.warn);
        } else {
          assert.deepStrictEqual(own, []);
        }
      });
    }

    test('неизвестный тип верхнего уровня по-прежнему даёт предупреждение «неизвестный тип объекта»', () => {
      const root = newRoot('v8vscedit-role-validate-');
      const rightsPath = writeRights(root, 'Р', rightsFileText(objectLines('Foo.X', [['Read', 'true']])));
      const report = service.validate({ rightsPath, detailed: true });
      assert.ok(report.issues.some((issue) => issue.severity === 'warning' && issue.message.includes('неизвестный тип объекта "Foo"')), JSON.stringify(report.issues));
    });
  });

  suite('edit_role: имена и конфигурация', () => {
    function roleWith(body: readonly string[]): { root: string; rightsPath: string } {
      const root = configRoot();
      return { root, rightsPath: writeRights(root, 'Р', rightsFileText(body, REFERENCE_VARIANT)) };
    }
    const read = (rightsPath: string): string => fs.readFileSync(rightsPath, 'utf-8');

    test('пример пользователя: grant РегистрСведений.МК_X создаёт InformationRegister.МК_X', () => {
      const { rightsPath } = roleWith([]);
      const result = service.edit({ rightsPath, operations: [{ op: 'grant', object: 'РегистрСведений.МК_Курсы', rights: ['Read', 'View'] }] });
      assert.strictEqual(result.success, true, result.errors.join('; '));
      assert.strictEqual(result.changed, true);
      assert.ok(read(rightsPath).includes('<name>InformationRegister.МК_Курсы</name>'));
    });

    test('три формы имени — один объект: повторы второй и третьей формой ничего не меняют', () => {
      const { rightsPath } = roleWith([]);
      const forms = ['Справочник.Банки', 'Справочники.Банки', 'Catalog.Банки'];
      const results = forms.map((object) => service.edit({ rightsPath, operations: [{ op: 'grant', object, rights: ['Read'] }] }));
      assert.deepStrictEqual(results.map((result) => result.changed), [true, false, false]);
      assert.strictEqual(read(rightsPath).split('<name>Catalog.Банки</name>').length, 2, 'ровно один объект');
    });

    test('неизвестное право известного типа: предупреждение и пропуск, остальные права выданы', () => {
      const { rightsPath } = roleWith([]);
      const result = service.edit({ rightsPath, operations: [{ op: 'grant', object: 'Справочники.Банки', rights: ['Read', 'Foo'] }] });
      assert.strictEqual(result.success, true);
      assert.ok(result.warnings.some((warning) => warning.includes('Foo')), result.warnings.join('; '));
      assert.ok(read(rightsPath).includes('<name>Read</name>'));
      assert.ok(!read(rightsPath).includes('<name>Foo</name>'));
    });

    test('вложенный объект: View/Edit на реквизит выдаются, Use — предупреждение, объект не создаётся', () => {
      const { rightsPath } = roleWith([]);
      const ok = service.edit({ rightsPath, operations: [{ op: 'grant', object: 'Справочники.Контрагенты.Реквизит.ИНН', rights: ['View', 'Edit'] }] });
      assert.strictEqual(ok.changed, true);
      assert.ok(read(rightsPath).includes('<name>Catalog.Контрагенты.Attribute.ИНН</name>'));

      const bad = service.edit({ rightsPath, operations: [{ op: 'grant', object: 'Справочники.Контрагенты.Реквизит.КПП', rights: ['Use'] }] });
      assert.strictEqual(bad.changed, false);
      assert.ok(bad.warnings.some((warning) => warning.includes('Use')), bad.warnings.join('; '));
      assert.ok(!read(rightsPath).includes('КПП'));
    });

    test('Подсистема.A.B.C разворачивается во вложенные Subsystem', () => {
      const { rightsPath } = roleWith([]);
      service.edit({ rightsPath, operations: [{ op: 'grant', object: 'Подсистема.A.B.C', rights: ['View'] }] });
      assert.ok(read(rightsPath).includes('<name>Subsystem.A.Subsystem.B.Subsystem.C</name>'));
    });

    test('revoke lenient: мусорное имя старого дефекта (Справочники.Банки в файле) удаляется, с предупреждением', () => {
      const { rightsPath } = roleWith([...objectLines('Справочники.Банки', [['Read', 'true']]), ...objectLines('Catalog.Другой', [['Read', 'true']])]);
      const result = service.edit({ rightsPath, operations: [{ op: 'revoke', object: 'Справочники.Банки' }] });
      assert.strictEqual(result.success, true, result.errors.join('; '));
      assert.strictEqual(result.changed, true);
      assert.ok(result.warnings.some((warning) => warning.includes('неканоническим именем')), result.warnings.join('; '));
      assert.ok(!read(rightsPath).includes('<name>Справочники.Банки</name>'));
      assert.ok(read(rightsPath).includes('<name>Catalog.Другой</name>'));
    });

    test('revoke lenient: если переведённое имя есть в файле, удаляется оно, а не сырое', () => {
      const { rightsPath } = roleWith([...objectLines('Catalog.Банки', [['Read', 'true']]), ...objectLines('Справочники.Банки', [['Read', 'true']])]);
      const result = service.edit({ rightsPath, operations: [{ op: 'revoke', object: 'Справочники.Банки' }] });
      assert.strictEqual(result.changed, true);
      assert.ok(!read(rightsPath).includes('<name>Catalog.Банки</name>'));
      assert.ok(read(rightsPath).includes('<name>Справочники.Банки</name>'));
    });

    test('setRls lenient: условие ставится на объект, записанный сырым именем', () => {
      const { rightsPath } = roleWith(objectLines('Справочники.Банки', [['Read', 'true']]));
      const result = service.edit({ rightsPath, operations: [{ op: 'setRls', object: 'Справочники.Банки', right: 'Read', condition: 'ГДЕ Х = 1' }] });
      assert.strictEqual(result.changed, true, result.warnings.join('; '));
      assert.ok(read(rightsPath).includes('<condition>ГДЕ Х = 1</condition>'));
    });

    test('Конфигурация: имя берётся из Configuration.xml (Roles/<R>/Ext/Rights.xml -> 4 уровня вверх)', () => {
      const { rightsPath } = roleWith([]);
      const result = service.edit({ rightsPath, operations: [{ op: 'grant', object: 'Конфигурация', rights: ['ThinClient'] }] });
      assert.strictEqual(result.success, true, result.errors.join('; '));
      assert.ok(read(rightsPath).includes('<name>Configuration.Основа</name>'));
      assert.ok(!read(rightsPath).includes('<name>Configuration</name>'));
    });

    test('Конфигурация: существующий в документе объект Configuration.* имеет приоритет над именем из Configuration.xml', () => {
      const { rightsPath } = roleWith(objectLines('Configuration.Старое', [['ThinClient', 'true']]));
      const result = service.edit({ rightsPath, operations: [{ op: 'grant', object: 'Configuration.Любое', rights: ['Output'] }] });
      assert.strictEqual(result.changed, true, result.errors.join('; '));
      const xml = read(rightsPath);
      assert.ok(xml.includes('<name>Configuration.Старое</name>'));
      assert.ok(!xml.includes('Configuration.Основа'));
      assert.ok(!xml.includes('Configuration.Любое'));
      assert.ok(xml.includes('<name>Output</name>'));
    });

    test('Конфигурация без Configuration.xml и без существующего объекта: ошибка, остальные имена работают', () => {
      const root = newRoot('v8vscedit-role-orphan-');
      const rightsPath = writeRights(root, 'Р', rightsFileText([], REFERENCE_VARIANT));
      const before = read(rightsPath);
      const failed = service.edit({ rightsPath, operations: [{ op: 'grant', object: 'Конфигурация', rights: ['ThinClient'] }] });
      assert.strictEqual(failed.success, false);
      assert.ok(failed.errors.some((error) => /конфигурац/i.test(error)), failed.errors.join('; '));
      assert.strictEqual(read(rightsPath), before);

      const fine = service.edit({ rightsPath, operations: [{ op: 'grant', object: 'Catalog.X', rights: ['Read'] }] });
      assert.strictEqual(fine.success, true);
      assert.strictEqual(fine.changed, true);
    });
  });
});
