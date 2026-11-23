import type { MetadataFileTarget } from '../../infra/fs/MetadataFileTarget';
import type { MetadataTreeProvider } from './MetadataTreeProvider';
import type { MetadataNode } from './TreeNode';

type TreeSource = Pick<MetadataTreeProvider, 'findNode' | 'getChildren'>;

/**
 * Узел дерева метаданных для цели, разобранной из пути файла (`resolveMetadataFileTarget`).
 * Ищет в ПОЛНОМ дереве (без фильтров поиска/захватов): видимость под фильтром решает панель.
 *
 * Спуск не заходит внутрь чужих объектов: группы (без `xmlPath`) раскрываются, а объект
 * сверяется по виду и имени и пропускается целиком, если это не он. Иначе поиск обходил бы
 * реквизиты, формы и макеты всех объектов конфигурации до нужного.
 *
 * Дочерний узел (форма/макет/команда), которого нет в дереве (кэш не успел обновиться),
 * заменяется своим объектом — пользователь всё равно попадает рядом с файлом.
 */
export function findMetadataNodeForTarget(tree: TreeSource, target: MetadataFileTarget): MetadataNode | undefined {
  const root = tree.findNode(isConfigRoot, target.configRoot);
  if (!root || !target.object) {
    return root;
  }

  const { kind, names, child } = target.object;
  let owner: MetadataNode | undefined = root;
  for (const name of names) {
    owner = owner ? findObject(tree, owner, kind, name) : undefined;
  }
  if (!owner || !child) {
    return owner;
  }

  // Владелец не сверяется: поиск идёт только в поддереве найденного объекта. Метка формы,
  // макета и команды — её имя (особое представление бывает лишь у стандартных реквизитов).
  return findInSubtree(tree, owner, (node) => node.nodeKind === child.kind && node.textLabel === child.name) ?? owner;
}

function isConfigRoot(node: MetadataNode): boolean {
  return node.nodeKind === 'configuration' || node.nodeKind === 'extension';
}

/** Объект метаданных (в отличие от группы и дочернего элемента): свой XML и нет владельца. */
function isMetadataObject(node: MetadataNode): boolean {
  return Boolean(node.xmlPath) && !node.metaContext;
}

function findObject(tree: TreeSource, start: MetadataNode, kind: string, name: string): MetadataNode | undefined {
  for (const node of tree.getChildren(start)) {
    if (isMetadataObject(node)) {
      if (node.nodeKind === kind && node.textLabel === name) {
        return node;
      }
      continue;
    }
    const found = findObject(tree, node, kind, name);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function findInSubtree(
  tree: TreeSource,
  start: MetadataNode,
  predicate: (node: MetadataNode) => boolean
): MetadataNode | undefined {
  for (const node of tree.getChildren(start)) {
    if (predicate(node)) {
      return node;
    }
    const found = findInSubtree(tree, node, predicate);
    if (found) {
      return found;
    }
  }
  return undefined;
}
