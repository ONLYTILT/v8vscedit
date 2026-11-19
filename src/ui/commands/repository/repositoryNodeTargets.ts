import * as vscode from 'vscode';
import type { RepositoryNodeRef, RepositoryService, RepositoryTarget } from '../../../infra/repository/RepositoryService';
import type { CommandServices, NodeArg } from '../_shared';
import type { RepositoryCliServices } from './RepositoryCommandRunner';

/**
 * Разрешение узла дерева в цель хранилища и проверки подключения — общие для всех команд
 * хранилища, в том числе вынесенных из RepositoryCommands (захват).
 */

export type RepositoryCommandNode = NodeArg & RepositoryNodeRef;

export function toCliServices(services: CommandServices): RepositoryCliServices {
  return {
    workspaceFolder: services.workspaceFolder,
    outputChannel: services.outputChannel,
    repositoryService: services.repositoryService,
    projectSecretStorage: services.projectSecretStorage,
    createDesignerExecutor: services.createDesignerExecutor,
    designerExecutorDeps: services.designerExecutorDeps,
  };
}

export function requireRootTarget(services: CommandServices, node: NodeArg): RepositoryTarget | null {
  const repositoryNode = node as RepositoryCommandNode | undefined;
  if (!repositoryNode?.xmlPath || (repositoryNode.nodeKind !== 'configuration' && repositoryNode.nodeKind !== 'extension')) {
    void vscode.window.showWarningMessage('Команда хранилища доступна только для корня основной конфигурации или расширения.');
    return null;
  }

  return services.repositoryService.resolveTargetByXmlPath(repositoryNode.xmlPath);
}

export function requireConnectedRootTarget(services: CommandServices, node: NodeArg): RepositoryTarget | null {
  const target = requireRootTarget(services, node);
  if (!target || !ensureConnected(services.repositoryService, target)) {
    return null;
  }
  return target;
}

export function requireRepositoryNode(services: CommandServices, node: NodeArg): RepositoryCommandNode | null {
  return resolveRepositoryNode(services, node)?.node ?? null;
}

/** Узел вместе с его подключённой целью: команде, которой нужна цель, не придётся разрешать её второй раз. */
export function resolveRepositoryNode(
  services: CommandServices,
  node: NodeArg
): { readonly node: RepositoryCommandNode; readonly target: RepositoryTarget } | null {
  const repositoryNode = node as RepositoryCommandNode | undefined;
  if (!repositoryNode?.xmlPath) {
    void vscode.window.showWarningMessage('Команда хранилища доступна только для узлов конфигурации с XML.');
    return null;
  }

  const target = services.repositoryService.resolveTargetByXmlPath(repositoryNode.xmlPath);
  if (!target || !ensureConnected(services.repositoryService, target)) {
    return null;
  }

  return { node: repositoryNode, target };
}

function ensureConnected(repositoryService: RepositoryService, target: RepositoryTarget): boolean {
  if (!repositoryService.hasBinding(target) || !repositoryService.isConnected(target)) {
    void vscode.window.showWarningMessage(`Для "${target.displayName}" нет активного подключения к хранилищу.`);
    return false;
  }
  return true;
}
