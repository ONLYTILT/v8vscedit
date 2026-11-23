import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigurationScaffoldService } from '../../../infra/xml';

/**
 * Синтетические Rights.xml для тестов правки ролей: независимы от корпуса `example/`, но
 * повторяют его раскладку (табы, `xsi:type="Rights"`, CRLF + BOM + без хвостового перевода строки).
 * Строки собираются здесь вручную, а не через продакшн-рендер, чтобы ожидания были независимыми.
 */

export interface RightsFileVariant {
  readonly eol: string;
  readonly bom: boolean;
  readonly trailing: boolean;
}

/** Раскладка эталона 2.20: CRLF, BOM, без хвостового перевода строки. */
export const REFERENCE_VARIANT: RightsFileVariant = { eol: '\r\n', bom: true, trailing: false };

export const RIGHTS_ROOT = '<Rights xmlns="http://v8.1c.ru/8.2/roles" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Rights" version="2.20">';

export const RIGHTS_FLAGS: readonly string[] = [
  '\t<setForNewObjects>false</setForNewObjects>',
  '\t<setForAttributesByDefault>true</setForAttributesByDefault>',
  '\t<independentRightsOfChildObjects>true</independentRightsOfChildObjects>',
];

export function rightLines(name: string, value: 'true' | 'false', conditionLines?: readonly string[]): string[] {
  return [
    '\t\t<right>',
    `\t\t\t<name>${name}</name>`,
    `\t\t\t<value>${value}</value>`,
    ...(conditionLines ? ['\t\t\t<restrictionByCondition>', ...conditionLines, '\t\t\t</restrictionByCondition>'] : []),
    '\t\t</right>',
  ];
}

/** Права объекта: `[имя права, значение]`; имя объекта подставляется как есть (уже экранированное). */
export function objectLines(name: string, rights: readonly (readonly [string, 'true' | 'false'])[]): string[] {
  return ['\t<object>', `\t\t<name>${name}</name>`, ...rights.flatMap(([right, value]) => rightLines(right, value)), '\t</object>'];
}

export function templateLines(name: string, condition: string): string[] {
  return ['\t<restrictionTemplate>', `\t\t<name>${name}</name>`, `\t\t<condition>${condition}</condition>`, '\t</restrictionTemplate>'];
}

export function rightsFileText(
  body: readonly string[],
  variant: RightsFileVariant = REFERENCE_VARIANT,
  head: readonly string[] = ['<?xml version="1.0" encoding="UTF-8"?>', RIGHTS_ROOT, ...RIGHTS_FLAGS],
): string {
  const lines = [...head, ...body, '</Rights>'];
  return (variant.bom ? '﻿' : '') + lines.join(variant.eol) + (variant.trailing ? variant.eol : '');
}

export function makeTempRoot(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Создаёт в `root` минимальную конфигурацию (`Configuration.xml` с `<Name>`). */
export function scaffoldConfiguration(root: string, name = 'Основа'): void {
  new ConfigurationScaffoldService().createConfiguration({ name, outputDir: root, compatibilityMode: 'Version8_3_24' });
}

/** Записывает `Roles/<роль>/Ext/Rights.xml` байт-в-байт (в т.ч. с BOM) и возвращает путь. */
export function writeRights(root: string, roleName: string, text: string): string {
  const rightsPath = path.join(root, 'Roles', roleName, 'Ext', 'Rights.xml');
  fs.mkdirSync(path.dirname(rightsPath), { recursive: true });
  fs.writeFileSync(rightsPath, text, 'utf-8');
  return rightsPath;
}
