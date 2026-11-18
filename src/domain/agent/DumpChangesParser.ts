/**
 * Разбор файла `config dump-config-to-files --get-changes` агента конфигуратора.
 *
 * Грамматика снята с пилота (план §5/§5b п.8), а не из документации: строки
 * `New: <Path>` / `Modified: <Path>`, где `Path = <EnglishKind>.<Name>[.<PartKind>[.<PartName>[.<SubPart>]]]`;
 * «нет изменений» — файл из одного BOM; любое удаление/переименование — одна строка `FullDump`.
 * Всё, что не укладывается в грамматику, делает непригодным ВЕСЬ файл: частично понятый список
 * изменений опаснее отсутствия списка (импорт пропустил бы объект), движок в этом случае уходит
 * в архивную ветку.
 */

export type DumpObjectChange = 'added' | 'modified';

export interface DumpChangedObject {
  readonly change: DumpObjectChange;
  /** Путь строки как есть: `Document.Заказ.Form.Форма`. */
  readonly fullName: string;
  /** Английское имя вида: `Document`. */
  readonly kind: string;
  readonly name: string;
  /** Сегменты после имени владельца: `['Form', 'Форма']`. */
  readonly parts: readonly string[];
}

export type DumpChangeSet =
  | { readonly kind: 'objects'; readonly objects: readonly DumpChangedObject[] }
  | { readonly kind: 'fullDump' }
  | { readonly kind: 'unrecognized'; readonly reason: string };

const BOM = '﻿';
const FULL_DUMP = 'FullDump';
const MAX_SEGMENTS = 5;

/** Подтверждённые пилотом значения `Change`; `Deleted` агент не пишет — удаление даёт `FullDump`. */
const CHANGE_BY_TOKEN: Readonly<Record<string, DumpObjectChange>> = {
  New: 'added',
  Modified: 'modified',
};

// Сегмент пути — без пробелов, двоеточий, точек и управляющих символов: иначе строка не из
// наблюдённой грамматики, и угадывать её смысл нельзя.
// eslint-disable-next-line no-control-regex
const SEGMENT_RE = /^[^\s:.\u0000-\u001f]+$/;

export function parseDumpChanges(text: string): DumpChangeSet {
  // Агент всегда пишет хотя бы BOM; совсем пустой текст — признак того, что файл не тот.
  if (text.length === 0) {
    return unrecognized('пустой файл без BOM');
  }
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.includes(FULL_DUMP)) {
    return lines.length === 1
      ? { kind: 'fullDump' }
      : unrecognized('FullDump вместе с другими строками');
  }

  const objects: DumpChangedObject[] = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    if (typeof parsed === 'string') {
      return unrecognized(`${parsed}: "${line}"`);
    }
    objects.push(parsed);
  }
  return { kind: 'objects', objects };
}

function parseLine(line: string): DumpChangedObject | string {
  const colon = line.indexOf(':');
  if (colon < 0) {
    return 'нет двоеточия';
  }
  const token = line.slice(0, colon);
  const change = Object.prototype.hasOwnProperty.call(CHANGE_BY_TOKEN, token) ? CHANGE_BY_TOKEN[token] : undefined;
  if (!change) {
    return `неизвестный вид изменения "${token}"`;
  }
  const fullName = line.slice(colon + 1).trim();
  const segments = fullName.split('.');
  if (segments.length < 2) {
    return 'путь без имени объекта';
  }
  if (segments.length > MAX_SEGMENTS) {
    return 'слишком глубокий путь';
  }
  if (!segments.every((segment) => SEGMENT_RE.test(segment))) {
    return 'недопустимый сегмент пути';
  }
  const [kind, name, ...parts] = segments;
  return { change, fullName, kind, name, parts };
}

function unrecognized(reason: string): DumpChangeSet {
  return { kind: 'unrecognized', reason };
}
