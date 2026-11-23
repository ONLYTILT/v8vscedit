import * as fs from 'fs';
import * as path from 'path';
import { XMLValidator } from 'fast-xml-parser';
import { extractSimpleTag, extractSynonym } from '../xml/XmlUtils';
import { KNOWN_RIGHTS, isAllowedRight } from './RoleRightsCatalog';
import {
  RIGHTS_NS,
  asArray,
  escapeTextSearch,
  getObjectType,
  inferRoleFolderName,
  parseRightsRoot,
  readRoleMetadata,
  resolveRightsXmlPath,
  resolveRoleMetadataPath,
} from './RoleRightsXml';
import type { RoleValidationIssue, RoleValidationOptions, RoleValidationResult } from './types';

export class RoleValidateService {
  validate(options: RoleValidationOptions): RoleValidationResult {
    const rightsPath = resolveRightsXmlPath(options.rightsPath);
    const issues: RoleValidationIssue[] = [];
    let errors = 0;
    let warnings = 0;
    let okCount = 0;
    const maxErrors = Math.max(1, options.maxErrors ?? 30);
    const ok = (message: string) => {
      okCount += 1;
      if (options.detailed) {
        issues.push({ severity: 'ok', message });
      }
    };
    const warn = (message: string) => {
      warnings += 1;
      issues.push({ severity: 'warning', message });
    };
    const error = (message: string) => {
      if (errors >= maxErrors) {
        return;
      }
      errors += 1;
      issues.push({ severity: 'error', message });
    };

    if (!rightsPath) {
      error(`Rights.xml не найден: ${options.rightsPath}`);
      return buildValidationResult(options.rightsPath, undefined, '', issues, errors, warnings, okCount);
    }

    const metadataPath = resolveRoleMetadataPath(rightsPath);
    const roleName = metadataPath ? readRoleMetadata(metadataPath).name : inferRoleFolderName(rightsPath);
    const raw = fs.readFileSync(rightsPath, 'utf-8');
    const validation = XMLValidator.validate(raw);
    if (validation !== true) {
      error(`XML parse error: ${validation.err.msg}`);
      return buildValidationResult(rightsPath, metadataPath, roleName, issues, errors, warnings, okCount);
    }
    ok('XML well-formed');

    const root = parseRightsRoot(raw);
    if (!root) {
      error('Корневой элемент Rights не найден.');
      return buildValidationResult(rightsPath, metadataPath, roleName, issues, errors, warnings, okCount);
    }
    if (root['@_xmlns'] && root['@_xmlns'] !== RIGHTS_NS) {
      warn(`Namespace "${root['@_xmlns']}", ожидается "${RIGHTS_NS}".`);
    } else {
      ok('Root element: <Rights>');
    }

    for (const flag of ['setForNewObjects', 'setForAttributesByDefault', 'independentRightsOfChildObjects'] as const) {
      const value = root[flag];
      if (value === undefined) {
        warn(`Отсутствует глобальный флаг ${flag}.`);
      } else if (value !== 'true' && value !== 'false') {
        warn(`${flag} = "${value}", ожидается true/false.`);
      }
    }

    let rightCount = 0;
    let rlsCount = 0;
    for (const object of asArray(root.object)) {
      const objectName = object.name ?? '';
      if (!objectName) {
        error('object без name.');
        continue;
      }
      const objectType = getObjectType(objectName);
      const nested = isNestedObject(objectName);
      if (!nested && !KNOWN_RIGHTS[objectType]) {
        warn(`${objectName}: неизвестный тип объекта "${objectType}".`);
      }
      for (const right of asArray(object.right)) {
        const rightName = right.name ?? '';
        const value = right.value ?? '';
        if (!rightName) {
          error(`${objectName}: right без name.`);
          continue;
        }
        if (value !== 'true' && value !== 'false') {
          error(`${objectName}: право "${rightName}" имеет значение "${value}", ожидается true/false.`);
          continue;
        }
        rightCount += 1;
        validateRightName(objectName, rightName, warn);
        if (right.restrictionByCondition) {
          rlsCount += 1;
          if (!right.restrictionByCondition.condition) {
            warn(`${objectName}: пустое RLS-условие для "${rightName}".`);
          }
        }
      }
    }
    ok(`${String(asArray(root.object).length)} objects, ${String(rightCount)} rights`);
    if (rlsCount > 0) {
      ok(`${String(rlsCount)} RLS restrictions`);
    }

    for (const template of asArray(root.restrictionTemplate)) {
      if (!template.name) {
        warn('Шаблон ограничения без name.');
      }
      if (!template.condition) {
        warn(`Шаблон "${template.name ?? ''}": пустое condition.`);
      }
    }

    if (metadataPath && fs.existsSync(metadataPath)) {
      validateRoleMetadata(metadataPath, ok, warn, error);
      validateConfigurationRegistration(metadataPath, roleName, ok, warn);
    }
    return buildValidationResult(rightsPath, metadataPath, roleName, issues, errors, warnings, okCount);
  }
}

function buildValidationResult(
  rightsPath: string,
  metadataPath: string | undefined,
  name: string,
  issues: readonly RoleValidationIssue[],
  errors: number,
  warnings: number,
  okCount: number
): RoleValidationResult {
  const roleName = name || inferRoleNameFromPath(rightsPath);
  const lines = errors === 0 && warnings === 0 && issues.every((issue) => issue.severity === 'ok')
    ? [`=== Validation OK: Role.${roleName} (${String(okCount + errors + warnings)} checks) ===`]
    : [
        `=== Validation: Role.${roleName} ===`,
        ...issues.map((issue) => `[${issue.severity.toUpperCase()}] ${issue.message}`),
        '',
        `=== Result: ${String(errors)} errors, ${String(warnings)} warnings (${String(okCount + errors + warnings)} checks) ===`,
      ];
  return {
    rightsPath,
    metadataPath,
    name: roleName,
    errors,
    warnings,
    checks: okCount + errors + warnings,
    issues,
    lines,
  };
}

function inferRoleNameFromPath(inputPath: string): string {
  return path.basename(path.dirname(path.dirname(inputPath)));
}

function isNestedObject(objectName: string): boolean {
  return objectName.split('.').length >= 3;
}

/** Критерий — общий с edit/compile (`isAllowedRight`); тексты предупреждений прежние. */
function validateRightName(objectName: string, rightName: string, warn: (message: string) => void): void {
  if (isAllowedRight(objectName, rightName)) {
    return;
  }
  if (isNestedObject(objectName)) {
    const parts = objectName.split('.');
    const nestedKind = parts[parts.length - 2];
    if (nestedKind === 'Command') {
      warn(`${objectName}: "${rightName}" не является правом команды.`);
    } else if (nestedKind === 'IntegrationServiceChannel') {
      warn(`${objectName}: "${rightName}" не является правом канала сервиса интеграции.`);
    } else {
      warn(`${objectName}: "${rightName}" не является правом дочернего объекта.`);
    }
    return;
  }
  const valid = KNOWN_RIGHTS[getObjectType(objectName)];
  if (valid) {
    const similar = valid.filter((item) => item.includes(rightName) || rightName.includes(item)).slice(0, 3);
    warn(`${objectName}: неизвестное право "${rightName}".${similar.length > 0 ? ` Возможно: ${similar.join(', ')}.` : ''}`);
  }
}

function validateRoleMetadata(
  metadataPath: string,
  ok: (message: string) => void,
  warn: (message: string) => void,
  error: (message: string) => void
): void {
  const xml = fs.readFileSync(metadataPath, 'utf-8');
  const uuid = /<Role\b[^>]*uuid="([^"]+)"/.exec(xml)?.[1] ?? '';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    ok(`Metadata: UUID valid (${uuid})`);
  } else {
    error(`Metadata: invalid UUID "${uuid}"`);
  }
  const name = extractSimpleTag(xml, 'Name');
  if (name) {
    ok(`Metadata: Name = ${name}`);
  } else {
    error('Metadata: Name не задан.');
  }
  if (extractSynonym(xml)) {
    ok('Metadata: Synonym present');
  } else {
    warn('Metadata: Synonym пустой.');
  }
}

function validateConfigurationRegistration(
  metadataPath: string,
  roleName: string,
  ok: (message: string) => void,
  warn: (message: string) => void
): void {
  const configXmlPath = path.join(path.dirname(path.dirname(metadataPath)), 'Configuration.xml');
  if (!fs.existsSync(configXmlPath)) {
    return;
  }
  const xml = fs.readFileSync(configXmlPath, 'utf-8');
  if (xml.includes(`<Role>${escapeTextSearch(roleName)}</Role>`)) {
    ok(`Configuration.xml: Role.${roleName} зарегистрирована`);
  } else {
    warn(`Configuration.xml: <Role>${roleName}</Role> не найден.`);
  }
}
