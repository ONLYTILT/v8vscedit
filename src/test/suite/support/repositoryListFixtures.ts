/**
 * Фикстуры тестов списков объектов хранилища (`paths`, docs/plans/mcp-repository-paths-plan.md): дополнительные
 * объекты поверх `createRepoProject` (во временном каталоге проекта, в `example/` ничего не пишется) и логи
 * платформы, ДОСЛОВНО снятые экспериментом Э33 (8.3.27.2130): хвостовой пробел строки чужого захвата,
 * имена в одинарных кавычках у «был изменен».
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RepositoryNodeRef } from '../../../infra/repository/RepositoryService';
import { MetadataNode } from '../../../ui/tree/TreeNode';
import { BEGIN, COMMIT_DONE, LOCK_DONE, UNLOCK_DONE, UPDATE_DONE, opLog, type RepoProject } from './repositoryMcpFixtures';

/** Полные имена объектов Э33. */
export const C1 = 'Справочник.Справочник1';
export const C3 = 'Справочник.Справочник3';
export const D1 = 'Документ.Документ1';
export const SUBSYSTEM = 'Подсистема.П';
export const EXT_X = 'Справочник.Э33_X';
export const EXT_Y = 'Справочник.Э33_Y';

export const FOREIGN_PREFIX = 'Объект захвачен для редактирования другим пользователем: ';
/** Строка чужого захвата как в логе платформы: с хвостовым пробелом. */
export const foreignLine = (name: string, user: string): string => `${FOREIGN_PREFIX}${name} (${user}) `;
export const lockedLine = (name: string): string => `Объект захвачен для редактирования: ${name}`;
export const cancelledLine = (name: string): string => `Захват объекта отменен: ${name}`;
export const notLockedLine = (name: string): string => `Объект не захвачен для редактирования: ${name}`;
export const receivedLine = (name: string): string => `Объект получен из хранилища: ${name}`;
export const committedLine = (name: string): string => `Объект помещен в хранилище: ${name}`;
export const unchangedLine = (name: string): string => `Объект не был изменен: ${name}`;
export const changedLine = (name: string): string => `Объект '${name}' был изменен`;

/** Э33.1: Lock [С1, С3, Д1], Д1 у UserB — exit 1, С1 и С3 захвачены. */
export const E33_1_LOG = opLog('Захват объектов не выполнен', lockedLine(C1), lockedLine(C3), foreignLine(D1, 'UserB'));
/** Э33.1 с полученными версиями: захват мог получить версии до отказа. */
export const E33_1_RECEIVED_LOG = opLog(
  'Захват объектов не выполнен', lockedLine(C1), receivedLine(C1), lockedLine(C3), foreignLine(D1, 'UserB')
);
/** Э33.3: UnLock без -force [С1 изменён, С3] — exit 1, строк «отменен» нет, не освобождён никто. */
export const E33_3_LOG = opLog('Отмена захвата не выполнена', changedLine(C1));

const OBJECT_XML = (tag: string, name: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><${tag} uuid="55555555-5555-5555-5555-555555555555"><Properties><Name>${name}</Name></Properties></${tag}></MetaDataObject>`;

export interface ListNode {
  readonly ref: RepositoryNodeRef;
  readonly node: MetadataNode;
}

export interface ListObjects {
  readonly catalog1: ListNode;
  readonly catalog1Child: ListNode;
  readonly catalog3: ListNode;
  readonly document1: ListNode;
  readonly subsystem: ListNode;
  readonly extX: ListNode;
  readonly extY: ListNode;
}

/** Создаёт файлы дополнительных объектов в cf и cfe проекта и узлы на них (для раннера и для MCP). */
export function addListObjects(p: RepoProject): ListObjects {
  const make = (
    dir: string, folder: string, tag: string, nodeKind: string, name: string, metaContext?: RepositoryNodeRef['metaContext']
  ): ListNode => {
    const xmlPath = path.join(dir, folder, `${name}.xml`);
    if (!fs.existsSync(xmlPath)) {
      fs.mkdirSync(path.dirname(xmlPath), { recursive: true });
      fs.writeFileSync(xmlPath, OBJECT_XML(tag, name), 'utf-8');
    }
    const model = { label: name, nodeKind, xmlPath, ...(metaContext ? { metaContext } : {}) };
    return {
      ref: { nodeKind, label: name, xmlPath, ...(metaContext ? { metaContext } : {}) },
      node: new MetadataNode(model as never, vscode.TreeItemCollapsibleState.None),
    };
  };
  const catalog1 = make(p.cfRoot, 'Catalogs', 'Catalog', 'Catalog', 'Справочник1');
  const owner = catalog1.ref.xmlPath ?? '';
  return {
    catalog1,
    catalog1Child: make(p.cfRoot, 'Catalogs', 'Catalog', 'Attribute', 'Справочник1', { rootMetaKind: 'Catalog', ownerObjectXmlPath: owner }),
    catalog3: make(p.cfRoot, 'Catalogs', 'Catalog', 'Catalog', 'Справочник3'),
    document1: make(p.cfRoot, 'Documents', 'Document', 'Document', 'Документ1'),
    subsystem: make(p.cfRoot, 'Subsystems', 'Subsystem', 'Subsystem', 'П'),
    extX: make(p.cfeRoot, 'Catalogs', 'Catalog', 'Catalog', 'Э33_X'),
    extY: make(p.cfeRoot, 'Catalogs', 'Catalog', 'Catalog', 'Э33_Y'),
  };
}

export { BEGIN, COMMIT_DONE, LOCK_DONE, UNLOCK_DONE, UPDATE_DONE, opLog };
