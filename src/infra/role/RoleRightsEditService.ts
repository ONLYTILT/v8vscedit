import * as fs from 'fs';
import * as path from 'path';
import { parseRightsXmlDocument, type RightsXmlDocument } from '../xml/role/RightsXmlDocument';
import { writeTextFilePreservingBomAndEol } from '../xml/XmlUtils';
import { isAllowedRight, resolveRoleObjectName, type RoleNameContext } from './RoleRightsCatalog';
import {
  PRESETS,
  getObjectType,
  readConfigurationName,
  resolveRightsXmlPath,
  translateRightName,
} from './RoleRightsXml';
import type {
  RoleRightsEditOperation,
  RoleRightsEditOptions,
  RoleRightsEditResult,
} from './types';

/** Итог одной операции: изменила ли она документ и что сказать агенту. */
interface OperationOutcome {
  readonly changed: boolean;
  readonly warnings: readonly string[];
}

type GrantOperation = Extract<RoleRightsEditOperation, { op: 'grant' }>;
type RevokeOperation = Extract<RoleRightsEditOperation, { op: 'revoke' }>;
type SetRlsOperation = Extract<RoleRightsEditOperation, { op: 'setRls' }>;

/**
 * Точечное редактирование Rights.xml существующей роли (edit_role): выдача и снятие
 * прав, RLS, глобальные флаги и шаблоны ограничений.
 *
 * Файл правится splice'ом по диапазонам (`RightsXmlDocument`), а не пересборкой:
 * повтор уже выданного права не должен трогать файл вовсе — ни байтов, ни mtime, —
 * иначе git показывал бы «изменение» всей роли, а конфигурация помечалась бы
 * изменённой на пустом месте.
 *
 * Файл читается целиком сознательно (эталонные роли — до 24 МБ): порог потоковой
 * обработки 16 МиБ относится к ГБ-файлам выгрузки, которым структура не нужна, а
 * правке XML нужен весь текст.
 */
export class RoleRightsEditService {
  edit(options: RoleRightsEditOptions): RoleRightsEditResult {
    const rightsPath = resolveRightsXmlPath(options.rightsPath);
    if (!rightsPath) {
      return fail(options.rightsPath, `Rights.xml не найден: ${options.rightsPath}`);
    }
    // Исходный текст — отдельной константой: он же эталон BOM/EOL при записи (CLAUDE.md, запрет №12).
    const original = fs.readFileSync(rightsPath, 'utf-8');
    const document = parseRightsXmlDocument(original);
    if ('error' in document) {
      return fail(rightsPath, `Не удалось распарсить Rights.xml: ${document.error}`);
    }

    const ctx = lazyNameContext(document, rightsPath);
    const warnings: string[] = [];
    const errors: string[] = [];
    let applied = 0;
    for (const operation of options.operations) {
      try {
        const outcome = applyOperation(document, operation, ctx);
        warnings.push(...outcome.warnings);
        if (outcome.changed) {
          applied += 1;
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (errors.length > 0) {
      return { success: false, changed: false, rightsPath, applied: 0, changedFiles: [], warnings, errors };
    }
    const next = document.render();
    if (next === original) {
      return { success: true, changed: false, rightsPath, applied, changedFiles: [], warnings, errors };
    }
    writeTextFilePreservingBomAndEol(rightsPath, original, next);
    return { success: true, changed: true, rightsPath, applied, changedFiles: [rightsPath], warnings, errors };
  }
}

/**
 * Имя конфигурации для `Configuration.*` вычисляется лениво: Configuration.xml большой
 * конфигурации читать на каждый edit_role незачем. Приоритет — у объекта
 * `Configuration.<Имя>`, уже записанного в роль (так платформа выгрузила именно эту базу).
 */
function lazyNameContext(document: RightsXmlDocument, rightsPath: string): RoleNameContext {
  let resolved = false;
  let name: string | undefined;
  return {
    get configurationName(): string | undefined {
      if (!resolved) {
        resolved = true;
        const existing = document.objectNames().find((item) => item.startsWith('Configuration.'));
        name = existing
          ? existing.slice('Configuration.'.length)
          : readConfigurationName(path.dirname(path.dirname(path.dirname(path.dirname(rightsPath)))));
      }
      return name;
    },
  };
}

function applyOperation(document: RightsXmlDocument, operation: RoleRightsEditOperation, ctx: RoleNameContext): OperationOutcome {
  switch (operation.op) {
    case 'grant':
      return applyGrant(document, operation, ctx);
    case 'revoke':
      return applyRevoke(document, operation, ctx);
    case 'setRls':
      return applySetRls(document, operation, ctx);
    case 'setFlags': {
      let changed = false;
      for (const flag of ['setForNewObjects', 'setForAttributesByDefault', 'independentRightsOfChildObjects'] as const) {
        const value = operation.flags[flag];
        if (value !== undefined && document.setFlag(flag, value)) {
          changed = true;
        }
      }
      return { changed, warnings: [] };
    }
    case 'addTemplate':
      return { changed: document.setTemplate(operation.name, operation.condition), warnings: [] };
    case 'removeTemplate': {
      const changed = document.removeTemplate(operation.name);
      return { changed, warnings: changed ? [] : [`Шаблон "${operation.name}" отсутствует.`] };
    }
    default: {
      const exhaustive: never = operation;
      throw new Error(`Неизвестная операция: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** grant — строгий: имя, которого платформа не знает, останавливает весь пакет без записи. */
function applyGrant(document: RightsXmlDocument, op: GrantOperation, ctx: RoleNameContext): OperationOutcome {
  const resolved = resolveRoleObjectName(op.object, ctx, 'strict');
  if ('error' in resolved) {
    throw new Error(`grant: ${resolved.error}`);
  }
  const objectName = resolved.name;
  const warnings: string[] = [];
  let changed = false;
  const has = (rightName: string): boolean => document.getObjectRights(objectName)?.some((right) => right.name === rightName) ?? false;

  if (op.preset) {
    const presetName = op.preset.replace(/^@/, '');
    const presetRights = PRESETS[presetName]?.[getObjectType(objectName)];
    if (!presetRights) {
      warnings.push(`Пресет @${presetName} не определён для типа ${getObjectType(objectName)}.`);
    } else {
      // Пресет только добавляет недостающее: явно снятые права (value=false) он не перетирает.
      for (const right of presetRights) {
        if (!has(right) && document.setRight(objectName, right, 'true')) {
          changed = true;
        }
      }
    }
  }

  const requested: [string, 'true' | 'false'][] = Array.isArray(op.rights)
    ? op.rights.map((raw) => [translateRightName(String(raw)), 'true'])
    : Object.entries(op.rights ?? {}).map(([raw, value]) => [translateRightName(raw), value ? 'true' : 'false']);
  for (const [rightName, value] of requested) {
    if (!isAllowedRight(objectName, rightName)) {
      warnings.push(`${objectName}: право "${rightName}" не существует в платформе 1С 8.3 и пропущено — проверь имя или удали его из grant.rights.`);
      continue;
    }
    if (document.setRight(objectName, rightName, value)) {
      changed = true;
    }
  }

  for (const [raw, condition] of Object.entries(op.rls ?? {})) {
    const rightName = translateRightName(raw);
    if (!has(rightName)) {
      warnings.push(`${objectName}: RLS задано для отсутствующего права ${rightName}; добавь его в grant.rights.`);
      continue;
    }
    if (document.setCondition(objectName, rightName, condition || undefined)) {
      changed = true;
    }
  }

  if (!op.preset && requested.length === 0 && !document.getObjectRights(objectName)) {
    warnings.push(`grant ${objectName}: ничего не выдано — укажи rights, preset или rls.`);
  }
  return { changed, warnings };
}

/**
 * Объект для revoke/setRls (нестрогий режим): сначала каноническое имя, затем сырое —
 * так удаляется мусор вроде `Справочники.Банки`, записанный в роль старым дефектом.
 */
function findLenientObject(document: RightsXmlDocument, raw: string, ctx: RoleNameContext): { name: string; nonCanonical: boolean } | undefined {
  const resolved = resolveRoleObjectName(raw, ctx, 'lenient');
  /* c8 ignore next -- lenient-режим ошибок не возвращает (контракт каталога); ветка нужна только типам */
  const name = 'name' in resolved ? resolved.name : raw.trim();
  if (document.getObjectRights(name)) {
    return { name, nonCanonical: false };
  }
  const trimmed = raw.trim();
  if (trimmed !== name && document.getObjectRights(trimmed)) {
    return { name: trimmed, nonCanonical: true };
  }
  return undefined;
}

function applyRevoke(document: RightsXmlDocument, op: RevokeOperation, ctx: RoleNameContext): OperationOutcome {
  const target = findLenientObject(document, op.object, ctx);
  if (!target) {
    return { changed: false, warnings: [`Объект ${op.object} отсутствует в Rights.xml.`] };
  }
  const warnings: string[] = target.nonCanonical
    ? [`${target.name}: удалён объект с неканоническим именем (так его записала прежняя версия инструмента).`]
    : [];
  if (!op.rights || op.rights.length === 0) {
    return { changed: document.removeObject(target.name), warnings };
  }
  let changed = false;
  for (const raw of op.rights) {
    const rightName = translateRightName(raw);
    if (document.removeRight(target.name, rightName)) {
      changed = true;
    } else {
      warnings.push(`${target.name}: право ${rightName} не было задано.`);
    }
  }
  if (changed && document.getObjectRights(target.name)?.length === 0) {
    document.removeObject(target.name);
  }
  return { changed, warnings };
}

function applySetRls(document: RightsXmlDocument, op: SetRlsOperation, ctx: RoleNameContext): OperationOutcome {
  const target = findLenientObject(document, op.object, ctx);
  if (!target) {
    return { changed: false, warnings: [`Объект ${op.object} отсутствует — RLS не применено.`] };
  }
  const rightName = translateRightName(op.right);
  if (!document.getObjectRights(target.name)?.some((right) => right.name === rightName)) {
    return { changed: false, warnings: [`${target.name}: право ${rightName} отсутствует — RLS не применено.`] };
  }
  const condition = op.condition && op.condition.trim().length > 0 ? op.condition : undefined;
  return { changed: document.setCondition(target.name, rightName, condition), warnings: [] };
}

function fail(rightsPath: string, message: string): RoleRightsEditResult {
  return {
    success: false,
    changed: false,
    rightsPath: path.resolve(rightsPath),
    applied: 0,
    changedFiles: [],
    warnings: [],
    errors: [message],
  };
}
