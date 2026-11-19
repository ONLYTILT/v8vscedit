import { CONFIGURATION_PREFIX, dumpInfoOwnerOf } from './ConfigDumpInfoIndex';

/**
 * Правка файла версий выгрузки (`ConfigDumpInfo.xml`) зеркала агента: из него убираются ВСЕ записи
 * владельцев, чтобы повторный `--get-changes` увидел их как новые (`New: <владелец>`), а `--update`
 * выгрузил их целиком (Э18/Э19, ФАКТ П3b плана plan-fulldump-avoid.md). Так снимается `FullDump` после
 * удаления, переименования объекта или удаления его части — без полной выгрузки конфигурации.
 *
 * Правка — вырезание целых строк исходного текста: BOM, переводы строк, отступы и порядок атрибутов
 * остальных записей остаются байт-в-байт (запрет №12), а файл после правки равен тому, что платформа
 * выгрузила бы без этих владельцев. Разбор и правка CDI живут только в `infra/xml/dumpInfo/` (запрет №1).
 */

/** Файл версий нельзя править построчно: теги `<Metadata>` не сбалансированы. */
export class ConfigDumpInfoFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigDumpInfoFormatError';
  }
}

export interface ConfigDumpInfoRemoval {
  readonly text: string;
  /** Имена всех вырезанных записей (владельцы и вложенные), в порядке файла. */
  readonly removedNames: string[];
  /** Владельцы из запроса, у которых нет ни одной записи верхнего уровня (в порядке запроса). */
  readonly missingOwners: string[];
}

/**
 * Открывающий, самозакрытый или закрывающий тег `<Metadata>`; имя — необязательная группа: порядок
 * атрибутов в файле не фиксирован, а тег без имени просто ни с каким владельцем не совпадёт.
 */
const METADATA_TAG = /<(\/?)Metadata\b(?:[^>]*?\sname="([^"]*)")?[^>]*?(\/?)>/g;

interface TopLevelRecord {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Удаляет записи верхнего уровня с `name === owner` или с префиксом `owner.` вместе со всем вложенным.
 * Корень конфигурации чистить нельзя (без него зеркало перестаёт быть выгрузкой) — обычная ошибка,
 * это нарушение контракта вызывающего, а не испорченный файл.
 */
export function removeConfigDumpInfoOwners(text: string, owners: readonly string[]): ConfigDumpInfoRemoval {
  const root = owners.find((owner) => owner.startsWith(CONFIGURATION_PREFIX));
  if (root !== undefined) {
    throw new Error(`Корень конфигурации (${root}) из файла версий зеркала не удаляется: Configuration.* чистить нельзя.`);
  }
  const wanted = new Set(owners);
  const records = scanTopLevelRecords(text).filter((record) => wanted.has(dumpInfoOwnerOf(record.name)));
  const found = new Set(records.map((record) => dumpInfoOwnerOf(record.name)));

  const pieces: string[] = [];
  const removedNames: string[] = [];
  let cursor = 0;
  for (const record of records) {
    const lineStart = text.lastIndexOf('\n', record.start - 1) + 1;
    // Строка записи вырезается вместе с её переводом строки; запись в последней строке без перевода —
    // до конца текста. Без конкатенации: копия десятков мегабайт на каждую запись сделала бы правку
    // квадратичной.
    const newline = text.indexOf('\n', record.end);
    const lineEnd = newline < 0 ? text.length : newline + 1;
    pieces.push(text.slice(cursor, Math.max(cursor, lineStart)));
    removedNames.push(...namesIn(text.slice(Math.max(cursor, lineStart), lineEnd)));
    cursor = Math.max(cursor, lineEnd);
  }
  pieces.push(text.slice(cursor));
  const result = pieces.join('');
  // Платформа пишет по тегу на строку. Если в строке удаляемой записи оказалось что-то ещё, вырезание
  // целыми строками могло разорвать соседнюю запись: такой результат в зеркало не попадает.
  scanTopLevelRecords(result);
  return {
    text: result,
    removedNames,
    missingOwners: owners.filter((owner) => !found.has(owner)),
  };
}

/** Записи верхнего уровня с их границами; заодно проверяется сбалансированность ВСЕГО файла. */
function scanTopLevelRecords(text: string): TopLevelRecord[] {
  const records: TopLevelRecord[] = [];
  let depth = 0;
  let top = { name: '', start: 0 };
  for (const match of text.matchAll(METADATA_TAG)) {
    const [tag, closing, name = '', selfClosing] = match;
    const end = match.index + tag.length;
    if (closing === '/') {
      depth -= 1;
      if (depth < 0) {
        throw new ConfigDumpInfoFormatError(`Файл версий: лишний закрывающий тег </Metadata> (позиция ${String(match.index)}).`);
      }
      if (depth === 0) {
        records.push({ ...top, end });
      }
      continue;
    }
    if (depth === 0) {
      top = { name, start: match.index };
    }
    if (selfClosing === '/') {
      if (depth === 0) {
        records.push({ ...top, end });
      }
    } else {
      depth += 1;
    }
  }
  if (depth !== 0) {
    throw new ConfigDumpInfoFormatError('Файл версий: запись <Metadata> без закрывающего тега.');
  }
  return records;
}

function namesIn(fragment: string): string[] {
  // Группа имени необязательна: у закрывающего тега и тега без имени её нет.
  return [...fragment.matchAll(METADATA_TAG)]
    .map(([, , name = '']) => name)
    .filter((name) => name.length > 0);
}
