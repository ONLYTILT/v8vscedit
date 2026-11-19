import * as fs from 'fs';
import { parseConfigDumpInfoHeader, type ConfigDumpInfoHeader } from './ConfigDumpInfoHeader';

/**
 * Индекс файла версий выгрузки (`ConfigDumpInfo.xml`): какие объекты описаны и какие из них агент
 * умеет выгрузить ОТДЕЛЬНО по имени (`dump --list-file`).
 *
 * Правило эксперимента 12 (агент 8.3.27.2130): запись `<Metadata>` с атрибутом `configVersion` — файловая
 * (модуль, форма, тело формы, макет, модуль команды, сам владелец), без него — встроенная (реквизит, ТЧ,
 * команда без модуля): она хранится в XML родителя, а её имя в списке даёт ошибку агента. Поэтому
 * классификация берётся из CDI, а не из второй карты «путь файла → имя».
 *
 * Разбор — только здесь (запрет №1): все открывающие теги `<Metadata …>` по порядку, атрибуты
 * по отдельности (порядок атрибутов не фиксирован). Вложенность тегов не важна: владелец имени — его
 * первые два сегмента (`Document.Д.Form.Ф.Form` → `Document.Д`, `Subsystem.A.Subsystem.B` → `Subsystem.A`).
 */
export interface ConfigDumpInfoIndex {
  /** Владельцы верхнего уровня: имена из двух сегментов `<EnglishKind>.<Name>`. */
  readonly rootNames: ReadonlySet<string>;
  /** `Configuration.<Имя>` — корень конфигурации/расширения; нет — undefined. */
  readonly configurationOwner: string | undefined;
  /** Формат и версия формата из корня; нет корня с обоими атрибутами — undefined. */
  readonly header: ConfigDumpInfoHeader | undefined;
  /**
   * Имя файловой записи (с `configVersion`) → версия как строка файла, в порядке файла. По ней свежий файл
   * версий базы сравнивается с файлом версий зеркала: пропавшая запись — удалённый объект или его часть.
   */
  readonly fileLevelVersions: ReadonlyMap<string, string>;
  /** Сам владелец + его подобъекты с `configVersion` (файловые), в порядке файла; неизвестный — []. */
  fileLevelNamesOf(ownerFullName: string): readonly string[];
}

const METADATA_TAG = /<Metadata\b[^>]*>/g;
const NAME_ATTRIBUTE = /\sname="([^"]*)"/;
const CONFIG_VERSION_ATTRIBUTE = /\sconfigVersion="([^"]*)"/;
/** Префикс имени корня конфигурации/расширения в файле версий — общий для разбора, сравнения и правки. */
export const CONFIGURATION_PREFIX = 'Configuration.';
const ROOT_TAG = '<ConfigDumpInfo';

/**
 * Владелец записи файла версий — первые два сегмента имени. Одна функция для разбора, сравнения и
 * редактирования: правило «вложенная подсистема принадлежит верхней» не должно расходиться между ними.
 */
export function dumpInfoOwnerOf(name: string): string {
  return name.split('.').slice(0, 2).join('.');
}

export function parseConfigDumpInfoIndex(text: string): ConfigDumpInfoIndex {
  const rootNames = new Set<string>();
  const fileLevel = new Map<string, string[]>();
  const fileLevelVersions = new Map<string, string>();
  for (const match of text.matchAll(METADATA_TAG)) {
    const tag = match[0];
    const name = NAME_ATTRIBUTE.exec(tag)?.[1];
    if (name === undefined) {
      continue;
    }
    const owner = dumpInfoOwnerOf(name);
    if (name.split('.').length === 2) {
      rootNames.add(name);
    }
    const version = CONFIG_VERSION_ATTRIBUTE.exec(tag)?.[1];
    if (version !== undefined) {
      fileLevelVersions.set(name, version);
      const names = fileLevel.get(owner);
      if (names === undefined) {
        fileLevel.set(owner, [name]);
      } else {
        names.push(name);
      }
    }
  }
  const configurationOwner = [...rootNames].find((name) => name.startsWith(CONFIGURATION_PREFIX));
  return {
    rootNames,
    configurationOwner,
    header: parseConfigDumpInfoHeader(text),
    fileLevelVersions,
    fileLevelNamesOf: (ownerFullName) => fileLevel.get(ownerFullName) ?? [],
  };
}

/**
 * Файл версий большой конфигурации — десятки мегабайт; читается целиком, но только в редких ветках
 * (точечная выгрузка, поиск «осиротевших» файлов), а не на каждый импорт.
 */
export async function readConfigDumpInfoIndex(filePath: string): Promise<ConfigDumpInfoIndex | undefined> {
  let text: string;
  try {
    text = await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
  return text.includes(ROOT_TAG) ? parseConfigDumpInfoIndex(text) : undefined;
}
