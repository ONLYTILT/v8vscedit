import * as assert from 'assert';
import { CHILD_TAG_CONFIG } from '../../domain/ChildTag';
import { META_TYPES } from '../../domain/MetaTypes';
import {
  KNOWN_RIGHTS,
  LEGACY_SINGULAR_ROOT_ALIASES,
  NESTED_CONTAINER_KINDS,
  NESTED_KIND_RIGHTS,
  isAllowedRight,
  resolveRoleObjectName,
} from '../../infra/role/RoleRightsCatalog';

/**
 * Каталог прав ролей и перевод имён объектов.
 *
 * Фильтр прав снят с эталона 2.20 (826 Rights.xml): неизвестное право отбивается, а режим
 * «тип не каталогизирован -> всё можно» удалён — `isAllowedRight` теперь единственный предикат
 * для edit_role, compile_role и валидации. Имена объектов переводятся ПОЗИЦИОННО (тип только в
 * сегментах 0, 2, 4…), поэтому `Справочники.Задачи` — это справочник «Задачи», а не задача.
 * Принимаются обе формы корня: канон MCP (множественное число, из `META_TYPES.pathSegment`) и
 * единственное число (`LEGACY_SINGULAR_ROOT_ALIASES`, осознанное исключение из запрета №2 по
 * решению пользователя).
 */

const CTX = { configurationName: 'Основа' } as const;

function strict(raw: string, ctx: { configurationName?: string } = CTX): string {
  const result = resolveRoleObjectName(raw, ctx, 'strict');
  if ('error' in result) {
    assert.fail(`${raw}: ожидался перевод, получена ошибка: ${result.error}`);
  }
  return result.name;
}

function strictError(raw: string, ctx: { configurationName?: string } = CTX): string {
  const result = resolveRoleObjectName(raw, ctx, 'strict');
  if (!('error' in result)) {
    assert.fail(`${raw}: ожидалась ошибка, получено имя ${result.name}`);
  }
  return result.error;
}

function lenient(raw: string, ctx: { configurationName?: string } = CTX): string {
  const result = resolveRoleObjectName(raw, ctx, 'lenient');
  assert.ok(!('error' in result), `${raw}: lenient не возвращает ошибок`);
  return result.name;
}

/** Английский вид корня -> описание в META_TYPES (общее для сшивки). */
const rootDefs = new Map(
  Object.values(META_TYPES).map((def) => [def.englishKind ?? def.kind, def] as const),
);

suite('Права ролей: каталог', () => {
  suite('isAllowedRight: корни по KNOWN_RIGHTS', () => {
    for (const [type, rights] of Object.entries(KNOWN_RIGHTS)) {
      for (const right of rights ?? []) {
        test(`${type}: право ${right} допустимо`, () => {
          assert.strictEqual(isAllowedRight(`${type}.Объект`, right), true);
        });
      }
      test(`${type}: несуществующее право и право чужого вида отбиваются`, () => {
        assert.strictEqual(isAllowedRight(`${type}.Объект`, 'НесуществующееПраво'), false);
        assert.strictEqual(isAllowedRight(`${type}.Объект`, 'Posting_'), false);
      });
    }

    test('режим «тип не каталогизирован -> разрешено» удалён: неизвестный тип отбивает любое право', () => {
      assert.strictEqual(isAllowedRight('Foo.Объект', 'Read'), false);
      assert.strictEqual(isAllowedRight('Foo.Объект', 'Use'), false);
      assert.strictEqual(isAllowedRight('Enum.Значения', 'Read'), false);
    });

    const additions: readonly { readonly types: readonly string[]; readonly rights: readonly string[] }[] = [
      {
        // Снято с эталона: у этих видов есть права истории данных и интерактивное удаление помеченных.
        types: ['BusinessProcess', 'Task', 'ChartOfCalculationTypes'],
        rights: [
          'ReadDataHistory', 'ViewDataHistory', 'UpdateDataHistory', 'UpdateDataHistoryOfMissingData',
          'ReadDataHistoryOfMissingData', 'UpdateDataHistorySettings', 'UpdateDataHistoryVersionComment',
          'EditDataHistoryVersionComment', 'SwitchToDataHistoryVersion', 'InteractiveDeleteMarked',
        ],
      },
      {
        types: ['ChartOfAccounts'],
        rights: ['InteractiveDeleteMarked', 'EditDataHistoryVersionComment', 'SwitchToDataHistoryVersion', 'ViewDataHistory'],
      },
      { types: ['Configuration'], rights: ['ExclusiveModeTerminationAtSessionStart'] },
    ];
    for (const group of additions) {
      for (const type of group.types) {
        for (const right of group.rights) {
          test(`дополнение по эталону: ${type}.${right}`, () => {
            assert.strictEqual(isAllowedRight(`${type}.Объект`, right), true);
          });
        }
      }
    }
  });

  suite('isAllowedRight: вложенные объекты — по предпоследнему сегменту', () => {
    const viewEditKinds = [
      'Attribute', 'StandardAttribute', 'TabularSection', 'StandardTabularSection', 'Dimension', 'Resource',
      'AccountingFlag', 'ExtDimensionAccountingFlag', 'AddressingAttribute',
    ];
    for (const kind of viewEditKinds) {
      test(`${kind}: View и Edit допустимы, Read/Use/мусор — нет`, () => {
        assert.strictEqual(isAllowedRight(`Catalog.X.${kind}.Y`, 'View'), true);
        assert.strictEqual(isAllowedRight(`Catalog.X.${kind}.Y`, 'Edit'), true);
        assert.strictEqual(isAllowedRight(`Catalog.X.${kind}.Y`, 'Read'), false);
        assert.strictEqual(isAllowedRight(`Catalog.X.${kind}.Y`, 'Use'), false);
        assert.strictEqual(isAllowedRight(`Catalog.X.${kind}.Y`, 'Мусор'), false);
      });
    }

    const useOnly: readonly { readonly name: string; readonly object: string }[] = [
      { name: 'Operation (WebService)', object: 'WebService.С.Operation.О' },
      { name: 'Method (HTTPService)', object: 'HTTPService.С.URLTemplate.Ш.Method.М' },
      { name: 'IntegrationServiceChannel', object: 'IntegrationService.И.IntegrationServiceChannel.К' },
    ];
    for (const c of useOnly) {
      test(`${c.name}: только Use`, () => {
        assert.strictEqual(isAllowedRight(c.object, 'Use'), true);
        assert.strictEqual(isAllowedRight(c.object, 'View'), false);
        assert.strictEqual(isAllowedRight(c.object, 'Edit'), false);
      });
    }

    test('Command и Subsystem (вложенные): только View', () => {
      assert.strictEqual(isAllowedRight('Catalog.X.Command.К', 'View'), true);
      assert.strictEqual(isAllowedRight('Catalog.X.Command.К', 'Edit'), false);
      assert.strictEqual(isAllowedRight('Subsystem.А.Subsystem.Б', 'View'), true);
      assert.strictEqual(isAllowedRight('Subsystem.А.Subsystem.Б', 'Edit'), false);
    });

    test('колонка табличной части: предпоследний сегмент — Attribute', () => {
      assert.strictEqual(isAllowedRight('Document.Д.TabularSection.Т.Attribute.Р', 'View'), true);
      assert.strictEqual(isAllowedRight('Document.Д.TabularSection.Т.Attribute.Р', 'Read'), false);
      assert.strictEqual(isAllowedRight('Document.Д.TabularSection.Т', 'Edit'), true);
    });

    test('неизвестный вид вложенного объекта: любые права отбиваются', () => {
      assert.strictEqual(isAllowedRight('Catalog.X.Form.Ф', 'View'), false);
      assert.strictEqual(isAllowedRight('Catalog.X.Неизвестный.Y', 'View'), false);
    });

    test('таблицы данных согласованы: контейнеры и ключи', () => {
      for (const kind of ['TabularSection', 'StandardTabularSection', 'URLTemplate', 'Subsystem']) {
        assert.ok(NESTED_CONTAINER_KINDS.has(kind), kind);
      }
      assert.strictEqual(NESTED_CONTAINER_KINDS.size, 4);
      assert.deepStrictEqual([...(NESTED_KIND_RIGHTS.Command ?? [])], ['View']);
      assert.deepStrictEqual([...(NESTED_KIND_RIGHTS.Subsystem ?? [])], ['View']);
      assert.deepStrictEqual([...(NESTED_KIND_RIGHTS.Operation ?? [])], ['Use']);
      assert.deepStrictEqual([...(NESTED_KIND_RIGHTS.Method ?? [])], ['Use']);
      assert.deepStrictEqual([...(NESTED_KIND_RIGHTS.IntegrationServiceChannel ?? [])], ['Use']);
      for (const kind of viewEditKinds) {
        assert.deepStrictEqual([...(NESTED_KIND_RIGHTS[kind] ?? [])].sort(), ['Edit', 'View'], kind);
      }
    });
  });

  suite('resolveRoleObjectName (strict): корни — канон множественного числа из META_TYPES', () => {
    for (const type of Object.keys(KNOWN_RIGHTS)) {
      if (type === 'Configuration') {
        continue;
      }
      test(`${type}: pathSegment -> английский вид`, () => {
        const def = rootDefs.get(type);
        assert.ok(def?.pathSegment, `у ${type} должен быть pathSegment в META_TYPES`);
        assert.strictEqual(strict(`${def.pathSegment}.Объект`), `${type}.Объект`);
      });

      test(`${type}: английская форма проходит как есть`, () => {
        assert.strictEqual(strict(`${type}.Объект`), `${type}.Объект`);
      });
    }

    test('пример пользователя: РегистрыСведений.МК_Х -> InformationRegister.МК_Х', () => {
      assert.strictEqual(strict('РегистрыСведений.МК_Курсы'), 'InformationRegister.МК_Курсы');
    });

    test('позиционный перевод: имя объекта, совпадающее с названием вида, не переводится', () => {
      assert.strictEqual(strict('Справочники.Задачи'), 'Catalog.Задачи');
      assert.strictEqual(strict('Справочники.Справочники'), 'Catalog.Справочники');
      assert.strictEqual(strict('Задачи.Справочники'), 'Task.Справочники');
      assert.strictEqual(strict('Документы.Реквизит.Реквизит.Реквизит'), 'Document.Реквизит.Attribute.Реквизит');
      assert.strictEqual(strict('Справочники.Документы.ТабличнаяЧасть.Справочники.Реквизит.Документы'), 'Catalog.Документы.TabularSection.Справочники.Attribute.Документы');
    });
  });

  suite('resolveRoleObjectName (strict): единственное число принимается (LEGACY_SINGULAR_ROOT_ALIASES)', () => {
    const legacy: readonly (readonly [string, string])[] = [
      ['Справочник', 'Catalog'], ['Документ', 'Document'], ['РегистрСведений', 'InformationRegister'],
      ['РегистрНакопления', 'AccumulationRegister'], ['РегистрБухгалтерии', 'AccountingRegister'],
      ['РегистрРасчета', 'CalculationRegister'], ['Константа', 'Constant'], ['ПланСчетов', 'ChartOfAccounts'],
      ['ПланВидовХарактеристик', 'ChartOfCharacteristicTypes'], ['ПланВидовРасчета', 'ChartOfCalculationTypes'],
      ['ПланОбмена', 'ExchangePlan'], ['БизнесПроцесс', 'BusinessProcess'], ['Задача', 'Task'],
      ['Обработка', 'DataProcessor'], ['Отчет', 'Report'], ['ОбщаяФорма', 'CommonForm'],
      ['ОбщаяКоманда', 'CommonCommand'], ['КритерийОтбора', 'FilterCriterion'],
      ['ЖурналДокументов', 'DocumentJournal'], ['Последовательность', 'Sequence'], ['ВебСервис', 'WebService'],
      ['HTTPСервис', 'HTTPService'], ['СервисИнтеграции', 'IntegrationService'],
      ['ПараметрСеанса', 'SessionParameter'], ['ОбщийРеквизит', 'CommonAttribute'],
    ];
    for (const [singular, english] of legacy) {
      test(`${singular}.Х -> ${english}.Х`, () => {
        assert.strictEqual(strict(`${singular}.Х`), `${english}.Х`);
        assert.strictEqual(LEGACY_SINGULAR_ROOT_ALIASES[singular], english);
      });
    }

    test('пример из описания инструмента: Справочник.Банки -> Catalog.Банки; РегистрСведений.X -> InformationRegister.X', () => {
      assert.strictEqual(strict('Справочник.Банки'), 'Catalog.Банки');
      assert.strictEqual(strict('РегистрСведений.X'), 'InformationRegister.X');
    });

    test('единственное число работает и с вложенными объектами', () => {
      assert.strictEqual(strict('Справочник.Банки.Реквизит.БИК'), 'Catalog.Банки.Attribute.БИК');
    });

    test('значения алиасов — существующие английские виды META_TYPES', () => {
      for (const [singular, english] of Object.entries(LEGACY_SINGULAR_ROOT_ALIASES)) {
        if (rootDefs.has(english)) {
          continue;
        }
        // Вложенные виды (бывший TYPE_ALIASES) допустимы, если они известны таблицам прав или тегам.
        const nested = english in NESTED_KIND_RIGHTS || NESTED_CONTAINER_KINDS.has(english)
          || Object.values(CHILD_TAG_CONFIG).some((config) => config.tag === english);
        assert.ok(nested, `${singular} -> ${english}: ни корневой вид, ни вложенный`);
      }
    });
  });

  suite('resolveRoleObjectName (strict): вложенные объекты', () => {
    const nestedCases: readonly (readonly [string, string])[] = [
      ['Справочники.Контрагенты.Реквизит.ИНН', 'Catalog.Контрагенты.Attribute.ИНН'],
      ['Справочники.Контрагенты.СтандартныйРеквизит.Code', 'Catalog.Контрагенты.StandardAttribute.Code'],
      ['Документы.Д.ТабличнаяЧасть.Т', 'Document.Д.TabularSection.Т'],
      ['Документы.Д.ТабличнаяЧасть.Т.Реквизит.Р', 'Document.Д.TabularSection.Т.Attribute.Р'],
      ['РегистрыСведений.Р.Измерение.И', 'InformationRegister.Р.Dimension.И'],
      ['РегистрыСведений.Р.Ресурс.Р1', 'InformationRegister.Р.Resource.Р1'],
      ['Обработки.О.Команда.К', 'DataProcessor.О.Command.К'],
      ['Задачи.З.РеквизитАдресации.А', 'Task.З.AddressingAttribute.А'],
      ['HTTPСервисы.С.URLШаблон.Ш.Метод.М', 'HTTPService.С.URLTemplate.Ш.Method.М'],
      ['Catalog.Контрагенты.Attribute.ИНН', 'Catalog.Контрагенты.Attribute.ИНН'],
      ['WebService.С.Operation.О', 'WebService.С.Operation.О'],
      ['IntegrationService.И.IntegrationServiceChannel.К', 'IntegrationService.И.IntegrationServiceChannel.К'],
      ['Catalog.X.StandardTabularSection.С', 'Catalog.X.StandardTabularSection.С'],
      ['AccountingRegister.Р.AccountingFlag.Ф', 'AccountingRegister.Р.AccountingFlag.Ф'],
      ['ChartOfAccounts.П.ExtDimensionAccountingFlag.Ф', 'ChartOfAccounts.П.ExtDimensionAccountingFlag.Ф'],
    ];
    for (const [raw, expected] of nestedCases) {
      test(`${raw} -> ${expected}`, () => {
        assert.strictEqual(strict(raw), expected);
      });
    }

    for (const config of Object.values(CHILD_TAG_CONFIG)) {
      if (!(config.tag in NESTED_KIND_RIGHTS) && !NESTED_CONTAINER_KINDS.has(config.tag)) {
        continue;
      }
      test(`сшивка с CHILD_TAG_CONFIG: ${config.pathSegment} -> ${config.tag}`, () => {
        assert.strictEqual(strict(`Справочники.X.${config.pathSegment}.Y`), `Catalog.X.${config.tag}.Y`);
      });
    }

    test('все ключи NESTED_KIND_RIGHTS принимаются в английской форме в позиции вида', () => {
      for (const kind of Object.keys(NESTED_KIND_RIGHTS)) {
        assert.strictEqual(strict(`Catalog.X.${kind}.Y`), `Catalog.X.${kind}.Y`, kind);
      }
    });
  });

  suite('resolveRoleObjectName (strict): подсистемы', () => {
    test('Подсистема.A.B.C разворачивается в Subsystem.A.Subsystem.B.Subsystem.C', () => {
      assert.strictEqual(strict('Подсистема.A.B.C'), 'Subsystem.A.Subsystem.B.Subsystem.C');
    });

    test('Подсистема.A -> Subsystem.A; Subsystem.A как есть', () => {
      assert.strictEqual(strict('Подсистема.A'), 'Subsystem.A');
      assert.strictEqual(strict('Subsystem.A'), 'Subsystem.A');
    });

    test('уже развёрнутая английская форма проходит без изменений (глубина 10 сегментов эталона)', () => {
      const deep = 'Subsystem.А.Subsystem.Б.Subsystem.В.Subsystem.Г.Subsystem.Д';
      assert.strictEqual(strict(deep), deep);
    });

    test('имя подсистемы, совпадающее с названием вида, не переводится', () => {
      assert.strictEqual(strict('Подсистема.Справочники.Документы'), 'Subsystem.Справочники.Subsystem.Документы');
    });
  });

  suite('resolveRoleObjectName (strict): Configuration', () => {
    for (const raw of ['Configuration', 'Конфигурация', 'Configuration.Configuration', 'Configuration.Любое', 'Конфигурация.Любое']) {
      test(`${raw} -> Configuration.<имя конфигурации>`, () => {
        assert.strictEqual(strict(raw), 'Configuration.Основа');
      });

      test(`${raw}: без имени конфигурации — ошибка`, () => {
        assert.match(strictError(raw, {}), /конфигурац/i);
      });
    }
  });

  suite('resolveRoleObjectName (strict): ошибки', () => {
    test('неизвестный тип верхнего уровня', () => {
      assert.match(strictError('Foo.X'), /Foo/);
      assert.match(strictError('Абракадабра.X'), /Абракадабра/);
    });

    test('единственное сегмент не Configuration', () => {
      assert.match(strictError('Справочники'), /Справочники/);
      assert.match(strictError('Catalog'), /Catalog/);
    });

    test('пустое имя и пустые сегменты', () => {
      assert.ok(strictError('').length > 0);
      assert.ok(strictError('   ').length > 0);
      assert.ok(strictError('Справочники..X').length > 0);
      assert.ok(strictError('Справочники.').length > 0);
    });

    test('нечётное число сегментов: Справочники.X.ИНН -> подсказка Реквизит.ИНН', () => {
      assert.match(strictError('Справочники.X.ИНН'), /Реквизит\.ИНН/);
    });

    test('нечётное число сегментов (5): отказ', () => {
      assert.ok(strictError('Справочники.X.Реквизит.Y.Z').length > 0);
    });

    test('неизвестный вид в позиции вида', () => {
      assert.match(strictError('Справочники.X.Неведомое.Y'), /Неведомое/);
      assert.match(strictError('Catalog.X.Foo.Y'), /Foo/);
    });

    test('незавершённый вложенный путь (вид без имени)', () => {
      assert.ok(strictError('Справочники.X.Реквизит').length > 0);
    });
  });

  suite('resolveRoleObjectName (lenient): переводит что может и никогда не возвращает ошибку', () => {
    test('корректные имена переводятся так же, как в strict', () => {
      for (const raw of ['Справочники.Банки', 'Справочник.Банки', 'Catalog.Банки', 'Документы.Д.ТабличнаяЧасть.Т.Реквизит.Р', 'Подсистема.A.B', 'Конфигурация']) {
        assert.strictEqual(lenient(raw), strict(raw), raw);
      }
    });

    test('неизвестный корень остаётся как есть', () => {
      assert.strictEqual(lenient('Foo.X'), 'Foo.X');
    });

    test('неполный/нечётный путь переводится позиционно, хвост сохраняется (чтобы можно было удалить мусор старого дефекта)', () => {
      const name = lenient('Справочники.X.ИНН');
      assert.ok(name.startsWith('Catalog.X.'), name);
      assert.ok(name.endsWith('ИНН'), name);
    });

    test('Configuration без имени конфигурации: голое Configuration (так писал старый код)', () => {
      assert.strictEqual(lenient('Configuration', {}), 'Configuration');
    });

    test('пустое имя не бросает исключения', () => {
      assert.doesNotThrow(() => resolveRoleObjectName('', CTX, 'lenient'));
    });
  });

  suite('lenient: хвосты, которые нечем перевести', () => {
    test('корень без имени объекта: переводится только корень', () => {
      assert.strictEqual(lenient('Справочники'), 'Catalog');
    });

    test('пара «неизвестный вид.имя» в середине пути сохраняется как есть, перевод идёт дальше', () => {
      assert.strictEqual(lenient('Справочники.X.Неизвестный.Y.Реквизит.Z'), 'Catalog.X.Неизвестный.Y.Attribute.Z');
    });
  });

  suite('сшивка с META_TYPES', () => {
    test('каждый корень KNOWN_RIGHTS — вид из META_TYPES с каноническим сегментом пути', () => {
      for (const type of Object.keys(KNOWN_RIGHTS)) {
        const def = rootDefs.get(type);
        assert.ok(def, `${type}: нет в META_TYPES (по englishKind/kind)`);
        assert.ok(def.pathSegment, `${type}: нет pathSegment`);
      }
    });
  });
});
