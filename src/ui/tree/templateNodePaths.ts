import { resolveChildTemplateBody, resolveChildTemplateDescriptor, resolveTemplateBodyByDescriptor } from '../../infra/fs/MetaPathResolver';
import type { TemplateType } from '../../infra/xml/MetadataXmlCreator';
import { inspectTemplateDescriptor } from '../../infra/xml/TemplateXml';
import type { MetadataNode } from './TreeNode';

/**
 * Деривация «узел дерева макета → файлы макета». ОДНА на всех потребителей —
 * MCP-резолверы (`ui/mcp/McpPathResolvers`) и команды навигатора
 * (`ui/commands/template/TemplateToolsCommands`); образец — `formNodePaths`.
 *
 * Зачем: `node.xmlPath` у макета объекта — дескриптор `Templates/<Имя>.xml`, а при
 * его отсутствии дерево подставляет XML ВЛАДЕЛЬЦА (`resolveLeafXmlPath`). Сервисы
 * MXL/СКД принимали этот путь за тело, и `compile_*` затирали им метаданные. Поэтому
 * у узла `Template` арифметика идёт только от владельца и имени узла.
 */

/**
 * Тип макета, с которым работает потребитель: сейчас MXL (`SpreadsheetDocument`) и СКД
 * (`DataCompositionSchema`), но контракт — любой тип макета платформы.
 */
export type ExpectedTemplateType = TemplateType;

/** Намерение потребителя: запись требует, чтобы макет был описан дескриптором. */
export type TemplateBodyIntent = 'read' | 'write';

/** Файлы макета по узлу: дескриптор (метаданные) и тело (`…/Ext/Template.xml`). */
export interface TemplateNodeParts {
  readonly descriptorPath: string;
  readonly bodyPath: string;
}

/**
 * Дескриптор и тело макета по узлу дерева. `label` — как называть узел в ошибке
 * (канонический путь у MCP, имя узла у команды навигатора).
 */
export function resolveTemplateNodeParts(node: MetadataNode, label: string): TemplateNodeParts {
  if (node.nodeKind === 'CommonTemplate') {
    if (!node.xmlPath) {
      throw new Error(`Макет "${label}" не имеет XML-файла.`);
    }
    return { descriptorPath: node.xmlPath, bodyPath: resolveTemplateBodyByDescriptor(node.xmlPath) };
  }
  if (node.nodeKind === 'Template') {
    const ownerObjectXmlPath = node.metaContext?.ownerObjectXmlPath;
    if (!ownerObjectXmlPath) {
      throw new Error(
        `У макета "${label}" не определён объект-владелец (ownerObjectXmlPath): ` +
        'путь к телу макета построить нечем.',
      );
    }
    return {
      descriptorPath: resolveChildTemplateDescriptor(ownerObjectXmlPath, node.textLabel),
      bodyPath: resolveChildTemplateBody(ownerObjectXmlPath, node.textLabel),
    };
  }
  throw new Error(
    `Путь "${label}" должен указывать на макет (Справочники.X.Макет.Y или ОбщиеМакеты.X), ` +
    `получено ${node.nodeKind}.`,
  );
}

/**
 * Путь к ТЕЛУ макета по узлу с проверкой типа по дескриптору. Нераспознанный тип —
 * проверка пропускается (ложный отказ дороже); отсутствующий дескриптор при записи —
 * отказ: тело без метаданных платформа не загрузит, а чтение такого макета безвредно.
 */
export function resolveTemplateBodyFromNode(
  node: MetadataNode,
  label: string,
  expected: ExpectedTemplateType | undefined,
  intent: TemplateBodyIntent,
): string {
  const { descriptorPath, bodyPath } = resolveTemplateNodeParts(node, label);
  const descriptor = inspectTemplateDescriptor(descriptorPath);
  if (!descriptor.exists) {
    if (intent === 'write') {
      throw new Error(
        `Макет "${label}" не описан дескриптором (${descriptorPath}) — ` +
        'создай его через v8vscedit_add_template.',
      );
    }
    return bodyPath;
  }
  if (expected && descriptor.type && descriptor.type !== expected) {
    throw new Error(`Макет ${label} имеет тип ${descriptor.type}; инструмент работает с ${expected}.`);
  }
  return bodyPath;
}
