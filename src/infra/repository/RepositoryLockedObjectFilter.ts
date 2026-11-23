import { isChildLikeKind } from './RepositoryObjectsSelection';
import type { RepositoryNodeRef, RepositoryService } from './RepositoryService';

/**
 * Решение отбора по одному узлу дерева:
 * - `locked` — объект захвачен, узел остаётся целиком (со всем составом);
 * - `descend` — сам не захвачен, но среди потомков могут быть захваченные (группы, подсистемы);
 * - `skip` — дочерний элемент объекта: захват учитывается по владельцу, глубже искать нечего.
 */
export type LockedNodeVerdict = 'locked' | 'descend' | 'skip';

export interface LockedObjectFilter {
  /** Захвачен корень конфигурации/расширения (служебное имя корня в учёте). */
  readonly rootLocked: boolean;
  classify(node: RepositoryNodeRef): LockedNodeVerdict;
}

type LockedFilterSource = Pick<
  RepositoryService,
  'resolveTargetByXmlPath' | 'hasBinding' | 'isConnected' | 'listLockedFullNames' | 'getRootLockName' | 'resolveFullName'
>;

/**
 * Срез локального учёта захватов одной цели для отбора дерева «только захваченные».
 *
 * Учёт читается ОДИН раз на построение отбора, а не `isLocked` на каждый узел: на больших
 * конфигурациях отбор обходит десятки тысяч узлов, и поузловой запрос — это stat файла
 * состояния на каждый. Дочерние элементы отклоняются по виду ДО `resolveFullName`: для них
 * полное имя — это имя владельца, вычисляемое разбором его XML.
 *
 * `null` — у цели нет привязки к хранилищу или оно отключено: так же решает индикатор
 * захвата в дереве (`MetadataTreeProvider.resolveRepositoryState`), иначе отбор показывал бы
 * объекты без замка.
 */
export function createLockedObjectFilter(
  repository: LockedFilterSource,
  configurationXmlPath: string
): LockedObjectFilter | null {
  const target = repository.resolveTargetByXmlPath(configurationXmlPath);
  if (!target || !repository.hasBinding(target) || !repository.isConnected(target)) {
    return null;
  }

  const locked = new Set(repository.listLockedFullNames(target));
  return {
    rootLocked: locked.has(repository.getRootLockName(target)),
    classify(node: RepositoryNodeRef): LockedNodeVerdict {
      if (node.nodeKind && isChildLikeKind(node.nodeKind)) {
        return 'skip';
      }
      const fullName = repository.resolveFullName(node);
      return fullName !== null && locked.has(fullName) ? 'locked' : 'descend';
    },
  };
}
