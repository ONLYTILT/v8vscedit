import { CHILD_TAG_CONFIG } from '../../domain/ChildTag';
import { META_TYPES } from '../../domain/MetaTypes';

/**
 * Каталог прав ролей и перевод имён объектов Rights.xml — ЕДИНСТВЕННЫЙ источник для
 * edit_role, compile_role и validate_role.
 *
 * Права сняты с эталона 2.20 (826 Rights.xml) сканом всех пар «вид объекта × право»:
 * таблица — это то, что платформа реально выгружает, а не перечень из документации.
 * Режима «вид не каталогизирован → разрешено всё» больше нет: через него в файл
 * попадали права, которых у вида не бывает, и платформа отказывалась загружать роль.
 */

const DATA_HISTORY_RIGHTS = [
  'ReadDataHistory', 'ViewDataHistory', 'UpdateDataHistory', 'UpdateDataHistoryOfMissingData',
  'ReadDataHistoryOfMissingData', 'UpdateDataHistorySettings', 'UpdateDataHistoryVersionComment',
  'EditDataHistoryVersionComment', 'SwitchToDataHistoryVersion',
] as const;

export const KNOWN_RIGHTS: Readonly<Partial<Record<string, readonly string[]>>> = {
  Configuration: [
    'Administration', 'DataAdministration', 'UpdateDataBaseConfiguration', 'ConfigurationExtensionsAdministration',
    'ActiveUsers', 'EventLog', 'ViewEventLog', 'ExclusiveMode', 'ThinClient', 'ThickClient', 'WebClient', 'MobileClient',
    'ExternalConnection', 'Automation', 'Output', 'OutputToPrinterFileClipboard', 'SaveUserData',
    'TechnicalSpecialistMode', 'InteractiveOpenExtDataProcessors', 'InteractiveOpenExtReports',
    'AllFunctionsMode', 'AnalyticsSystemClient', 'CollaborationSystemInfoBaseRegistration',
    'MainWindowModeNormal', 'MainWindowModeWorkplace', 'MainWindowModeEmbeddedWorkplace',
    'MainWindowModeFullscreenWorkplace', 'MainWindowModeKiosk',
    'StartAutomation', 'StartThickClient', 'StartThinClient', 'StartWebClient',
    'StartExternalConnection', 'StartMobileClient',
    // Эталон 2.20: есть в Configuration.* ролей, в прежнем перечне отсутствовало.
    'ExclusiveModeTerminationAtSessionStart',
  ],
  Catalog: [
    'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'InteractiveInsert',
    'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete', 'InteractiveDeleteMarked',
    'InteractiveDeletePredefinedData', 'InteractiveSetDeletionMarkPredefinedData',
    'InteractiveClearDeletionMarkPredefinedData', 'InteractiveDeleteMarkedPredefinedData',
    ...DATA_HISTORY_RIGHTS,
  ],
  Document: [
    'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'Posting', 'UndoPosting',
    'InteractiveInsert', 'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete',
    'InteractiveDeleteMarked', 'InteractivePosting', 'InteractivePostingRegular', 'InteractiveUndoPosting',
    'InteractiveChangeOfPosted', ...DATA_HISTORY_RIGHTS,
  ],
  InformationRegister: ['Read', 'Update', 'View', 'Edit', 'TotalsControl', ...DATA_HISTORY_RIGHTS],
  AccumulationRegister: ['Read', 'Update', 'View', 'Edit', 'TotalsControl'],
  AccountingRegister: ['Read', 'Update', 'View', 'Edit', 'TotalsControl'],
  CalculationRegister: ['Read', 'View'],
  Constant: ['Read', 'Update', 'View', 'Edit', 'ReadDataHistory', 'ViewDataHistory', 'UpdateDataHistory', 'UpdateDataHistorySettings', 'UpdateDataHistoryVersionComment', 'EditDataHistoryVersionComment', 'SwitchToDataHistoryVersion'],
  ChartOfAccounts: [
    'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'InteractiveInsert',
    'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete',
    'InteractiveDeletePredefinedData', 'InteractiveSetDeletionMarkPredefinedData',
    'InteractiveClearDeletionMarkPredefinedData', 'InteractiveDeleteMarkedPredefinedData',
    'ReadDataHistory', 'ReadDataHistoryOfMissingData', 'UpdateDataHistory', 'UpdateDataHistoryOfMissingData',
    'UpdateDataHistorySettings', 'UpdateDataHistoryVersionComment',
    // Эталон 2.20: встречаются в ролях, в прежнем перечне отсутствовали.
    'InteractiveDeleteMarked', 'EditDataHistoryVersionComment', 'SwitchToDataHistoryVersion', 'ViewDataHistory',
  ],
  ChartOfCharacteristicTypes: [
    'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'InteractiveInsert',
    'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete', 'InteractiveDeleteMarked',
    'InteractiveDeletePredefinedData', 'InteractiveSetDeletionMarkPredefinedData',
    'InteractiveClearDeletionMarkPredefinedData', 'InteractiveDeleteMarkedPredefinedData', ...DATA_HISTORY_RIGHTS,
  ],
  ChartOfCalculationTypes: [
    'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'InteractiveInsert',
    'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete',
    'InteractiveDeletePredefinedData', 'InteractiveSetDeletionMarkPredefinedData',
    'InteractiveClearDeletionMarkPredefinedData', 'InteractiveDeleteMarkedPredefinedData',
    // Эталон 2.20: история данных и удаление помеченных — в прежнем перечне отсутствовали.
    ...DATA_HISTORY_RIGHTS, 'InteractiveDeleteMarked',
  ],
  ExchangePlan: [
    'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'InteractiveInsert',
    'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete', 'InteractiveDeleteMarked',
    ...DATA_HISTORY_RIGHTS,
  ],
  BusinessProcess: [
    'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'Start', 'InteractiveInsert',
    'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete', 'InteractiveActivate',
    'InteractiveStart',
    // Эталон 2.20: история данных и удаление помеченных — в прежнем перечне отсутствовали.
    ...DATA_HISTORY_RIGHTS, 'InteractiveDeleteMarked',
  ],
  Task: [
    'Read', 'Insert', 'Update', 'Delete', 'View', 'Edit', 'InputByString', 'Execute', 'InteractiveInsert',
    'InteractiveSetDeletionMark', 'InteractiveClearDeletionMark', 'InteractiveDelete', 'InteractiveActivate',
    'InteractiveExecute',
    // Эталон 2.20: история данных и удаление помеченных — в прежнем перечне отсутствовали.
    ...DATA_HISTORY_RIGHTS, 'InteractiveDeleteMarked',
  ],
  DataProcessor: ['Use', 'View'],
  Report: ['Use', 'View'],
  CommonForm: ['View'],
  CommonCommand: ['View'],
  Subsystem: ['View'],
  FilterCriterion: ['View'],
  DocumentJournal: ['Read', 'View'],
  Sequence: ['Read', 'Update'],
  WebService: ['Use'],
  HTTPService: ['Use'],
  IntegrationService: ['Use'],
  SessionParameter: ['Get', 'Set'],
  CommonAttribute: ['View', 'Edit'],
};

const VIEW_EDIT = ['View', 'Edit'] as const;

/**
 * Права вложенного объекта по его виду — ПРЕДПОСЛЕДНЕМУ сегменту имени
 * (`Catalog.X.Attribute.Y` → `Attribute`; колонка ТЧ `…TabularSection.Т.Attribute.Р` →
 * тоже `Attribute`). Эталон 2.20: Operation:Use 816, Method:Use 119,
 * IntegrationServiceChannel:Use 8, остальные виды — только View/Edit (Command и
 * вложенная Subsystem — только View).
 */
export const NESTED_KIND_RIGHTS: Readonly<Partial<Record<string, readonly string[]>>> = {
  Attribute: VIEW_EDIT,
  StandardAttribute: VIEW_EDIT,
  TabularSection: VIEW_EDIT,
  StandardTabularSection: VIEW_EDIT,
  Dimension: VIEW_EDIT,
  Resource: VIEW_EDIT,
  AccountingFlag: VIEW_EDIT,
  ExtDimensionAccountingFlag: VIEW_EDIT,
  AddressingAttribute: VIEW_EDIT,
  Command: ['View'],
  Subsystem: ['View'],
  Operation: ['Use'],
  Method: ['Use'],
  IntegrationServiceChannel: ['Use'],
};

/**
 * Виды, внутри которых бывают свои вложенные объекты (эталон 2.20:
 * Document›TabularSection 153 125, HTTPService›URLTemplate 119, Subsystem›Subsystem 1232).
 * `URLTemplate` прав не имеет — это только контейнер методов.
 */
export const NESTED_CONTAINER_KINDS: ReadonlySet<string> = new Set([
  'TabularSection', 'StandardTabularSection', 'URLTemplate', 'Subsystem',
]);

/**
 * Единственное число корня (`Справочник.X`), принимаемое наряду с каноном MCP
 * (`Справочники.X`). Осознанное исключение из запрета №2 по решению пользователя:
 * агенты пишут так по привычке, а отказ ломал рабочий сценарий. Из `META_TYPES`
 * не выводится: `label` содержит пробелы («Регистр сведений»), букву «ё»/«Отчёт» и
 * дефис («Web-сервис»), а в Rights.xml и у агентов принято слитное написание.
 */
export const LEGACY_SINGULAR_ROOT_ALIASES: Readonly<Record<string, string>> = {
  Справочник: 'Catalog',
  Документ: 'Document',
  РегистрСведений: 'InformationRegister',
  РегистрНакопления: 'AccumulationRegister',
  РегистрБухгалтерии: 'AccountingRegister',
  РегистрРасчета: 'CalculationRegister',
  Константа: 'Constant',
  ПланСчетов: 'ChartOfAccounts',
  ПланВидовХарактеристик: 'ChartOfCharacteristicTypes',
  ПланВидовРасчета: 'ChartOfCalculationTypes',
  ПланОбмена: 'ExchangePlan',
  БизнесПроцесс: 'BusinessProcess',
  Задача: 'Task',
  Обработка: 'DataProcessor',
  Отчет: 'Report',
  ОбщаяФорма: 'CommonForm',
  ОбщаяКоманда: 'CommonCommand',
  КритерийОтбора: 'FilterCriterion',
  ЖурналДокументов: 'DocumentJournal',
  Последовательность: 'Sequence',
  ВебСервис: 'WebService',
  HTTPСервис: 'HTTPService',
  СервисИнтеграции: 'IntegrationService',
  ПараметрСеанса: 'SessionParameter',
  ОбщийРеквизит: 'CommonAttribute',
};

const CONFIGURATION = 'Configuration';
const SUBSYSTEM = 'Subsystem';
// `pathSegment` в MetaTypeDef необязателен по типу, но у `configuration` задан всегда ('Конфигурация');
// правая часть `??` нужна только компилятору и исполниться не может.
/* c8 ignore next */
const CONFIGURATION_TOKENS: ReadonlySet<string> = new Set([CONFIGURATION, META_TYPES.configuration.pathSegment ?? CONFIGURATION]);
const ROOT_GROUPS: ReadonlySet<string> = new Set(['common', 'top', 'documents-branch']);

/** Корень имени → английский вид: канон MCP (`pathSegment`), сам английский вид, единственное число. */
const ROOT_TOKENS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const def of Object.values(META_TYPES)) {
    if (!ROOT_GROUPS.has(def.group) || !def.pathSegment) {
      continue;
    }
    // Контракт MetaTypeDef: englishKind по умолчанию = kind. Все текущие корни с pathSegment задают его явно,
    // поэтому фолбэк сейчас не исполняется, но остаётся для нового вида без englishKind.
    /* c8 ignore next */
    const english = def.englishKind ?? def.kind;
    map.set(def.pathSegment, english);
    map.set(english, english);
  }
  for (const [singular, english] of Object.entries(LEGACY_SINGULAR_ROOT_ALIASES)) {
    map.set(singular, english);
  }
  return map;
})();

/** Русский корень подсистем: в каноне MCP вложенность пишется без повтора вида (`Подсистема.A.B.C`). */
// У Subsystem `pathSegment` задан всегда ('Подсистема'); фолбэк нужен только типу `string | undefined`.
/* c8 ignore next */
const SUBSYSTEM_CANON = META_TYPES.Subsystem.pathSegment ?? SUBSYSTEM;

/** Вид вложенного объекта → английский тег: `CHILD_TAG_CONFIG.pathSegment` и английские ключи таблиц прав. */
const NESTED_TOKENS: ReadonlyMap<string, string> = (() => {
  const known = new Set<string>([...Object.keys(NESTED_KIND_RIGHTS), ...NESTED_CONTAINER_KINDS]);
  const map = new Map<string, string>();
  for (const kind of known) {
    map.set(kind, kind);
  }
  for (const config of Object.values(CHILD_TAG_CONFIG)) {
    if (known.has(config.tag)) {
      map.set(config.pathSegment, config.tag);
    }
  }
  return map;
})();

/** ЕДИНСТВЕННЫЙ предикат допустимости права для edit_role, compile_role и validate_role. */
export function isAllowedRight(objectName: string, rightName: string): boolean {
  const parts = objectName.split('.');
  const allowed = parts.length >= 3 ? NESTED_KIND_RIGHTS[parts[parts.length - 2]] : KNOWN_RIGHTS[parts[0]];
  return allowed?.includes(rightName) ?? false;
}

export interface RoleNameContext {
  readonly configurationName?: string;
}

export type RoleNameMode = 'strict' | 'lenient';

/**
 * Имя объекта, как его пишет платформа в Rights.xml (`Catalog.X.Attribute.Y`), по любой
 * принятой форме: английской, канону MCP (`Справочники.X.Реквизит.Y`) или единственному
 * числу (`Справочник.X`).
 *
 * Перевод ПОЗИЦИОННЫЙ: вид стоит только в сегментах 0, 2, 4…, имена — в 1, 3, 5…;
 * иначе справочник «Задачи» превращался в `Catalog.Task`. `strict` (grant/compile)
 * отбивает всё, что платформа не примет; `lenient` (revoke/setRls) никогда не
 * возвращает ошибку — переводит что может, чтобы можно было удалить мусор, записанный
 * старым дефектом.
 */
export function resolveRoleObjectName(raw: string, ctx: RoleNameContext, mode: RoleNameMode): { name: string } | { error: string } {
  const strict = mode === 'strict';
  const trimmed = raw.trim();
  const parts = trimmed.split('.');
  if (trimmed === '' || parts.some((part) => part.trim() === '')) {
    return strict ? { error: `Пустое имя объекта или пустой сегмент: "${raw}".` } : { name: trimmed };
  }
  if (CONFIGURATION_TOKENS.has(parts[0]) && parts.length <= 2) {
    if (ctx.configurationName) {
      return { name: `${CONFIGURATION}.${ctx.configurationName}` };
    }
    return strict
      ? { error: `Не удалось определить имя конфигурации для "${raw}": нет Configuration.xml и объекта Configuration.* в роли.` }
      : { name: CONFIGURATION };
  }
  const root = ROOT_TOKENS.get(parts[0]);
  if (!root) {
    return strict
      ? { error: `Неизвестный тип объекта "${parts[0]}" в "${raw}". Используй канон MCP (Справочники.X), единственное число (Справочник.X) или имя 1С (Catalog.X).` }
      : { name: trimmed };
  }
  if (parts[0] === SUBSYSTEM_CANON && parts.length > 2) {
    return { name: parts.slice(1).map((name) => `${SUBSYSTEM}.${name}`).join('.') };
  }
  if (parts.length === 1) {
    return strict ? { error: `Не указано имя объекта: "${raw}" (ожидается ${parts[0]}.Имя).` } : { name: root };
  }
  const translated = [root, parts[1]];
  for (let i = 2; i < parts.length; i += 2) {
    const kind = NESTED_TOKENS.get(parts[i]);
    if (i + 1 >= parts.length) {
      if (strict) {
        return { error: kind ? `Не указано имя вложенного объекта после "${parts[i]}" в "${raw}".` : oddSegmentsError(raw, parts) };
      }
      translated.push(kind ?? parts[i]);
      break;
    }
    if (!kind) {
      if (strict) {
        return { error: `Неизвестный вид вложенного объекта "${parts[i]}" в "${raw}". Ожидается Реквизит, ТабличнаяЧасть, Измерение, Ресурс, Команда и т.п.` };
      }
      translated.push(parts[i], parts[i + 1]);
      continue;
    }
    translated.push(kind, parts[i + 1]);
  }
  return { name: translated.join('.') };
}

function oddSegmentsError(raw: string, parts: readonly string[]): string {
  const last = parts[parts.length - 1];
  const hint = [...parts.slice(0, -1), CHILD_TAG_CONFIG.Attribute.pathSegment, last].join('.');
  return `Нечётное число сегментов в "${raw}": вложенный объект задаётся парой «вид.имя». Например: ${hint} (Реквизит.${last}).`;
}
