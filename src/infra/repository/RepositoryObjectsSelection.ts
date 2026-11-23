/**
 * Файл выбора объектов `-Objects` операций хранилища для узла или списка узлов (план
 * docs/plans/mcp-repository-paths-plan.md §1.3). Чистые функции: вектор аргументов Конфигуратора от числа
 * объектов не зависит, меняется только содержимое этого файла, поэтому список выполняется одним запуском.
 */
import type { MetaKind } from '../../domain/MetaTypes';
import { escapeXmlAttribute as escapeXml } from '../xml';
import type { RepositoryNodeRef } from './RepositoryService';

export type RepositorySelectionEntry =
  | { readonly kind: 'root' }
  | { readonly kind: 'object'; readonly fullName: string; readonly subsystem: boolean };

/**
 * Узел или список узлов. Объединение типов, а не новый параметр: все прежние вызовы с одним узлом (UI-команды,
 * тесты) остаются без правок, и их неизменность — регресс-доказательство одиночного пути.
 */
export type RepositoryNodeSelection = RepositoryNodeRef | readonly RepositoryNodeRef[];

const REPOSITORY_NAMESPACE = 'http://v8.1c.ru/8.3/config/objects';

/**
 * Внутренние имена типов объектов 1С, используемые для формирования полного имени
 * при захвате/освобождении в хранилище. Это НЕ человекочитаемые метки (label из META_TYPES),
 * а технические идентификаторы платформы 1С (например, «БизнесПроцесс» без дефиса).
 */
const ONE_C_TYPE_NAMES: Partial<Record<MetaKind, string>> = {
  Subsystem: 'Подсистема',
  CommonModule: 'ОбщийМодуль',
  SessionParameter: 'ПараметрСеанса',
  CommonAttribute: 'ОбщийРеквизит',
  Role: 'Роль',
  CommonForm: 'ОбщаяФорма',
  CommonCommand: 'ОбщаяКоманда',
  CommandGroup: 'ГруппаКоманд',
  CommonPicture: 'ОбщаяКартинка',
  CommonTemplate: 'ОбщийМакет',
  XDTOPackage: 'XDTOPackage',
  StyleItem: 'ЭлементСтиля',
  DefinedType: 'ОпределяемыйТип',
  FunctionalOption: 'ФункциональнаяОпция',
  FunctionalOptionsParameter: 'ПараметрФункциональнойОпции',
  SettingsStorage: 'ХранилищеНастроек',
  Style: 'Стиль',
  WSReference: 'WSСсылка',
  WebSocketClient: 'WebSocketКлиент',
  IntegrationService: 'СервисИнтеграции',
  Bot: 'Бот',
  Interface: 'Интерфейс',
  PaletteColor: 'ЦветПалитры',
  Language: 'Язык',
  HTTPService: 'HTTPСервис',
  WebService: 'WebСервис',
  Constant: 'Константа',
  Catalog: 'Справочник',
  Document: 'Документ',
  DocumentNumerator: 'НумераторДокументов',
  Enum: 'Перечисление',
  InformationRegister: 'РегистрСведений',
  AccumulationRegister: 'РегистрНакопления',
  AccountingRegister: 'РегистрБухгалтерии',
  CalculationRegister: 'РегистрРасчета',
  Report: 'Отчет',
  DataProcessor: 'Обработка',
  BusinessProcess: 'БизнесПроцесс',
  Task: 'Задача',
  ExchangePlan: 'ПланОбмена',
  ChartOfCharacteristicTypes: 'ПланВидовХарактеристик',
  ChartOfAccounts: 'ПланСчетов',
  ChartOfCalculationTypes: 'ПланВидовРасчета',
  DocumentJournal: 'ЖурналДокументов',
  ScheduledJob: 'РегламентноеЗадание',
  EventSubscription: 'ПодпискаНаСобытие',
  FilterCriterion: 'КритерийОтбора',
  Sequence: 'Последовательность',
  ExternalDataSource: 'ВнешнийИсточникДанных',
};

/**
 * Виды дочерних узлов (ChildTag + Column), для которых захват идёт
 * через владельца, а не напрямую. Используется только для проверки
 * принадлежности — логика блокировки/разблокировки всегда работает
 * с полным именем корневого объекта-владельца.
 */
const CHILD_LIKE_KINDS: ReadonlySet<string> = new Set([
  'Attribute',
  'AddressingAttribute',
  'TabularSection',
  'Form',
  'Command',
  'Template',
  'Dimension',
  'Resource',
  'EnumValue',
  'Column',
]);

/** Имя вида объекта платформы для полного имени в выборке; `undefined` — вид в хранилище не захватывается. */
export function oneCTypeName(kind: MetaKind): string | undefined {
  return ONE_C_TYPE_NAMES[kind];
}

export function isChildLikeKind(kind: string): boolean {
  return CHILD_LIKE_KINDS.has(kind);
}

export function toSelectionNodes(selection: RepositoryNodeSelection): readonly RepositoryNodeRef[] {
  return isNodeList(selection) ? selection : [selection];
}

function isNodeList(selection: RepositoryNodeSelection): selection is readonly RepositoryNodeRef[] {
  return Array.isArray(selection);
}

/**
 * Корень — одна запись и первой (так его пишет платформа в смешанной выборке, Э33.2); объекты дедуплицируются
 * по `fullName` без учёта регистра — дочерний узел уже сведён к владельцу, и «объект + его реквизит» в списке
 * дают одно имя. Сохраняется первое написание и порядок появления.
 */
export function mergeSelectionEntries(entries: readonly RepositorySelectionEntry[]): RepositorySelectionEntry[] {
  const seen = new Set<string>();
  const objects: RepositorySelectionEntry[] = [];
  let hasRoot = false;
  for (const entry of entries) {
    if (entry.kind === 'root') {
      hasRoot = true;
      continue;
    }
    const key = entry.fullName.toLocaleLowerCase('ru');
    if (!seen.has(key)) {
      seen.add(key);
      objects.push(entry);
    }
  }
  return hasRoot ? [{ kind: 'root' }, ...objects] : objects;
}

/** XML выбора; для одной записи — байт-в-байт прежний вывод (формат принимает платформа). */
export function buildObjectsSelectionXml(entries: readonly RepositorySelectionEntry[], recursive: boolean): string {
  const flag = recursive ? 'true' : 'false';
  const lines = [`<Objects xmlns="${REPOSITORY_NAMESPACE}" version="1.0">`];
  for (const entry of entries) {
    if (entry.kind === 'root') {
      lines.push(`  <Configuration includeChildObjects="${flag}"/>`);
      continue;
    }
    lines.push(`  <Object fullName="${escapeXml(entry.fullName)}" includeChildObjects="${flag}">`);
    if (entry.subsystem) {
      lines.push(`    <Subsystem includeObjectsFromSubordinateSubsystems="${flag}"/>`);
    }
    lines.push('  </Object>');
  }
  // Завершающий перевод строки — как в прежнем файле выбора.
  lines.push('</Objects>', '');
  return lines.join('\n');
}

/** Имена для учёта захватов: служебное имя корня (в логе его нет — см. RepositoryLockLog) первым, затем объекты. */
export function selectionFullNames(entries: readonly RepositorySelectionEntry[], rootLockName: string): string[] {
  return entries.map((entry) => (entry.kind === 'root' ? rootLockName : entry.fullName));
}

/**
 * Захваченные (по учёту) объекты, которые попадут в выборку. Состав подсистемы здесь не разрешается, а элемент
 * `<Subsystem>` включает её объекты и без рекурсии (Э33.5) — поэтому ЛЮБАЯ подсистема, как и рекурсивный корень,
 * считается покрывающей все захваты цели: лишний вопрос о перезаписи дешевле молча потерянной правки.
 */
export function selectLockedInSelection(
  locked: readonly string[],
  entries: readonly RepositorySelectionEntry[],
  recursive: boolean,
  rootLockName: string
): string[] {
  const coversAll = entries.some((entry) => (entry.kind === 'root' ? recursive : entry.subsystem));
  if (coversAll) {
    return [...locked];
  }
  const names = new Set(selectionFullNames(entries, rootLockName));
  return locked.filter((name) => names.has(name));
}
