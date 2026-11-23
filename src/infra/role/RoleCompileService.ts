import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../fs/AtomicFileWriter';
import { ConfigurationXmlEditor } from '../xml/ConfigurationXmlEditor';
import { isAllowedRight, resolveRoleObjectName, type RoleNameContext } from './RoleRightsCatalog';
import {
  PRESETS,
  detectFormatVersion,
  escapeXml,
  getObjectType,
  readConfigurationName,
  serializeRightsXml,
  translateRightName,
  type SerializableRoleObject,
} from './RoleRightsXml';
import type {
  RoleCompileOptions,
  RoleCompileResult,
  RoleDefinition,
  RoleObjectDefinition,
} from './types';

interface ParsedObjectDefinition {
  readonly name: string;
  readonly rights: readonly ParsedRightDefinition[];
}

interface ParsedRightDefinition {
  readonly name: string;
  readonly value: 'true' | 'false';
  readonly condition?: string;
}

export class RoleCompileService {
  constructor(private readonly configEditor: ConfigurationXmlEditor = new ConfigurationXmlEditor()) {}

  compile(options: RoleCompileOptions): RoleCompileResult {
    const definition = options.definition;
    const name = definition.name.trim();
    if (!name || !/^[\p{L}_][\p{L}\p{Nd}_]*$/u.test(name)) {
      throw new Error('JSON роли должен содержать корректное поле name.');
    }
    const outputDir = path.resolve(options.outputDir);
    const rolesDir = path.basename(outputDir) === 'Roles' ? outputDir : path.join(outputDir, 'Roles');
    const configDir = path.basename(outputDir) === 'Roles' ? path.dirname(outputDir) : outputDir;
    const metadataPath = path.join(rolesDir, `${name}.xml`);
    const rightsPath = path.join(rolesDir, name, 'Ext', 'Rights.xml');
    if (fs.existsSync(metadataPath) || fs.existsSync(rightsPath)) {
      throw new Error(`Роль "${name}" уже существует.`);
    }

    const formatVersion = detectFormatVersion(configDir);
    const warnings: string[] = [];
    // Имена разбираются строго и ДО любой записи: роль с именем, которого платформа не
    // знает, не загрузится, а наполовину созданная роль осталась бы мусором в выгрузке.
    const errors: string[] = [];
    const objects = parseRoleObjects(
      definition.objects ?? definition.rights ?? [],
      { configurationName: readConfigurationName(configDir) },
      warnings,
      errors,
    );
    if (errors.length > 0) {
      throw new Error(errors.join('\n'));
    }
    fs.mkdirSync(path.dirname(rightsPath), { recursive: true });
    fs.mkdirSync(rolesDir, { recursive: true });
    writeFileAtomic(metadataPath, buildRoleMetadataXml(definition, formatVersion));
    writeFileAtomic(rightsPath, buildRightsXml(definition, objects, formatVersion));
    const changedFiles = [metadataPath, rightsPath];

    const configXmlPath = path.join(configDir, 'Configuration.xml');
    if (fs.existsSync(configXmlPath)) {
      const registration = this.configEditor.addChildObject(configXmlPath, `Role.${name}`);
      if (registration.success || registration.changed) {
        changedFiles.push(...registration.changedFiles);
      }
      warnings.push(...registration.warnings);
      if (registration.errors.length > 0) {
        throw new Error(registration.errors.join('\n'));
      }
    } else {
      warnings.push(`Configuration.xml не найден, роль не зарегистрирована: ${configXmlPath}`);
    }

    return { name, metadataPath, rightsPath, changedFiles, warnings };
  }
}

function parseRoleObjects(
  entries: readonly RoleObjectDefinition[],
  ctx: RoleNameContext,
  warnings: string[],
  errors: string[],
): ParsedObjectDefinition[] {
  return entries
    .map((entry) => parseRoleObject(entry, ctx, warnings, errors))
    .filter((item): item is ParsedObjectDefinition => Boolean(item));
}

function resolveObjectName(raw: string, ctx: RoleNameContext, errors: string[]): string | null {
  const resolved = resolveRoleObjectName(raw, ctx, 'strict');
  if ('error' in resolved) {
    errors.push(resolved.error);
    return null;
  }
  return resolved.name;
}

/** Неизвестное право известного вида — предупреждение и пропуск, как у edit_role. */
function keepAllowed(objectName: string, rightName: string, warnings: string[]): boolean {
  if (isAllowedRight(objectName, rightName)) {
    return true;
  }
  warnings.push(`${objectName}: право "${rightName}" не существует в платформе 1С 8.3 и пропущено.`);
  return false;
}

function parseRoleObject(
  entry: RoleObjectDefinition,
  ctx: RoleNameContext,
  warnings: string[],
  errors: string[],
): ParsedObjectDefinition | null {
  if (typeof entry === 'string') {
    const index = entry.indexOf(':');
    if (index === -1) {
      warnings.push(`Некорректная строка прав: ${entry}`);
      return null;
    }
    const objectName = resolveObjectName(entry.slice(0, index).trim(), ctx, errors);
    if (!objectName) {
      return null;
    }
    const rightsText = entry.slice(index + 1).trim();
    const rightNames = rightsText.startsWith('@')
      ? resolvePreset(getObjectType(objectName), rightsText, warnings)
      : rightsText.split(',').map((item) => translateRightName(item.trim())).filter(Boolean);
    return {
      name: objectName,
      rights: rightNames.filter((name) => keepAllowed(objectName, name, warnings)).map((name) => ({ name, value: 'true' })),
    };
  }
  const rawName = (entry.name ?? '').trim();
  if (!rawName) {
    warnings.push('Объект прав без поля name пропущен.');
    return null;
  }
  const objectName = resolveObjectName(rawName, ctx, errors);
  if (!objectName) {
    return null;
  }
  const rights = new Map<string, ParsedRightDefinition>();
  for (const presetRight of entry.preset ? resolvePreset(getObjectType(objectName), entry.preset, warnings) : []) {
    rights.set(presetRight, { name: presetRight, value: 'true' });
  }
  if (Array.isArray(entry.rights)) {
    const items: readonly string[] = entry.rights;
    for (const item of items) {
      const rightName = translateRightName(item);
      if (keepAllowed(objectName, rightName, warnings)) {
        rights.set(rightName, { name: rightName, value: 'true' });
      }
    }
  } else if (entry.rights) {
    for (const [rawRight, value] of Object.entries(entry.rights)) {
      const rightName = translateRightName(rawRight);
      if (keepAllowed(objectName, rightName, warnings)) {
        rights.set(rightName, { name: rightName, value: value ? 'true' : 'false' });
      }
    }
  }
  for (const [rawRight, condition] of Object.entries(entry.rls ?? {})) {
    const rightName = translateRightName(rawRight);
    const existing = rights.get(rightName);
    if (!existing) {
      warnings.push(`${objectName}: RLS задано для отсутствующего права ${rightName}.`);
      continue;
    }
    rights.set(rightName, { ...existing, condition });
  }
  return { name: objectName, rights: [...rights.values()] };
}

function resolvePreset(objectType: string, rawPreset: string, warnings: string[]): string[] {
  const preset = rawPreset.replace(/^@/, '');
  const rights = PRESETS[preset]?.[objectType];
  if (!rights) {
    warnings.push(`Пресет @${preset} не определён для типа ${objectType}.`);
    return [];
  }
  return [...rights];
}

function buildRoleMetadataXml(definition: RoleDefinition, formatVersion: string): string {
  const synonym = definition.synonym ?? definition.name;
  const comment = definition.comment ?? '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="' + escapeXml(formatVersion) + '">',
    `\t<Role uuid="${crypto.randomUUID()}">`,
    '\t\t<Properties>',
    `\t\t\t<Name>${escapeXml(definition.name)}</Name>`,
    '\t\t\t<Synonym>',
    '\t\t\t\t<v8:item>',
    '\t\t\t\t\t<v8:lang>ru</v8:lang>',
    `\t\t\t\t\t<v8:content>${escapeXml(synonym)}</v8:content>`,
    '\t\t\t\t</v8:item>',
    '\t\t\t</Synonym>',
    comment ? `\t\t\t<Comment>${escapeXml(comment)}</Comment>` : '\t\t\t<Comment/>',
    '\t\t</Properties>',
    '\t</Role>',
    '</MetaDataObject>',
    '',
  ].join('\n');
}

function buildRightsXml(
  definition: RoleDefinition,
  objects: readonly ParsedObjectDefinition[],
  formatVersion: string
): string {
  const serializable: SerializableRoleObject[] = objects.map((object) => ({
    name: object.name,
    rights: object.rights.map((right) => ({ name: right.name, value: right.value, condition: right.condition })),
  }));
  return serializeRightsXml({
    setForNewObjects: definition.setForNewObjects ?? false,
    setForAttributesByDefault: definition.setForAttributesByDefault ?? true,
    independentRightsOfChildObjects: definition.independentRightsOfChildObjects ?? false,
    objects: serializable,
    templates: (definition.templates ?? []).map((template) => ({ name: template.name, condition: template.condition })),
    formatVersion,
  });
}
