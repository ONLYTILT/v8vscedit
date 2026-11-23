import { escapeXmlAttribute, escapeXmlText } from '../XmlUtils';

/**
 * Текстовая раскладка блоков Rights.xml — ЕДИНСТВЕННОЕ место, где она живёт.
 * И полная сборка файла (`compile_role` через `serializeRightsXml`), и точечная
 * вставка нового блока в существующий файл (`edit_role` через `RightsXmlDocument`)
 * берут строки отсюда, иначе вставленный блок разошёлся бы по отступам с соседями.
 * Табы — как в эталоне `example/`; перевод строки задаёт вызывающий (EOL файла).
 */

export const RIGHTS_NS = 'http://v8.1c.ru/8.2/roles';

export interface SerializableRoleRight {
  readonly name: string;
  readonly value: 'true' | 'false';
  readonly condition?: string;
}

export interface SerializableRoleObject {
  readonly name: string;
  readonly rights: readonly SerializableRoleRight[];
}

export interface SerializableRoleTemplate {
  readonly name: string;
  readonly condition: string;
}

export interface SerializableRoleRights {
  readonly setForNewObjects: boolean;
  readonly setForAttributesByDefault: boolean;
  readonly independentRightsOfChildObjects: boolean;
  readonly objects: readonly SerializableRoleObject[];
  readonly templates: readonly SerializableRoleTemplate[];
  readonly formatVersion: string;
}

/** Порядок флагов в корне — по эталону; им же пользуется вставка отсутствующего флага. */
export const RIGHTS_FLAG_ORDER = ['setForNewObjects', 'setForAttributesByDefault', 'independentRightsOfChildObjects'] as const;
export type RightsFlagName = typeof RIGHTS_FLAG_ORDER[number];

function lines(eol: string, items: readonly string[]): string {
  return items.map((line) => line + eol).join('');
}

/** Строки блока `<restrictionByCondition>` (без перевода строки после последней). */
export function renderConditionLines(condition: string): string[] {
  return [
    '\t\t\t<restrictionByCondition>',
    `\t\t\t\t<condition>${escapeXmlText(condition)}</condition>`,
    '\t\t\t</restrictionByCondition>',
  ];
}

export function renderRightBlock(right: SerializableRoleRight, eol: string): string {
  return lines(eol, [
    '\t\t<right>',
    `\t\t\t<name>${escapeXmlText(right.name)}</name>`,
    `\t\t\t<value>${right.value}</value>`,
    ...(right.condition ? renderConditionLines(right.condition) : []),
    '\t\t</right>',
  ]);
}

export function renderObjectBlock(object: SerializableRoleObject, eol: string): string {
  return lines(eol, ['\t<object>', `\t\t<name>${escapeXmlText(object.name)}</name>`])
    + object.rights.map((right) => renderRightBlock(right, eol)).join('')
    + lines(eol, ['\t</object>']);
}

export function renderTemplateBlock(template: SerializableRoleTemplate, eol: string): string {
  return lines(eol, [
    '\t<restrictionTemplate>',
    `\t\t<name>${escapeXmlText(template.name)}</name>`,
    `\t\t<condition>${escapeXmlText(template.condition)}</condition>`,
    '\t</restrictionTemplate>',
  ]);
}

export function renderFlagLine(flag: RightsFlagName, value: boolean | string, eol: string): string {
  return lines(eol, [`\t<${flag}>${String(value)}</${flag}>`]);
}

/**
 * Новый файл целиком. `xsi:type="Rights"` обязателен: он есть у 826 из 826 ролей
 * эталона 2.20. Хвостовой перевод строки и отсутствие BOM — формат нового файла
 * генератора (golden `metadataXmlCreatorGolden`), существующие файлы этим не
 * пересобираются.
 */
export function renderRightsDocument(rights: SerializableRoleRights, eol = '\n'): string {
  return lines(eol, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Rights xmlns="${RIGHTS_NS}" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Rights" version="${escapeXmlAttribute(rights.formatVersion)}">`,
  ])
    + renderFlagLine('setForNewObjects', rights.setForNewObjects, eol)
    + renderFlagLine('setForAttributesByDefault', rights.setForAttributesByDefault, eol)
    + renderFlagLine('independentRightsOfChildObjects', rights.independentRightsOfChildObjects, eol)
    + rights.objects.map((object) => renderObjectBlock(object, eol)).join('')
    + rights.templates.map((template) => renderTemplateBlock(template, eol)).join('')
    + lines(eol, ['</Rights>']);
}
