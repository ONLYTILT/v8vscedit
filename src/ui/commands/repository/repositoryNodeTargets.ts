import * as vscode from 'vscode';
import type { RepositoryNodeRef, RepositoryService, RepositoryTarget } from '../../../infra/repository/RepositoryService';
import type { CommandServices, NodeArg } from '../_shared';
import type { RepositoryCliServices } from './RepositoryCommandRunner';
import type { RepositoryChainServices } from './repositoryPostSync';

/**
 * Разрешение узла дерева в цель хранилища и проверки подключения — общие для всех команд
 * хранилища, в том числе вынесенных из RepositoryCommands (захват) и MCP-инструментов.
 */

export type RepositoryCommandNode = NodeArg & RepositoryNodeRef;

export function toCliServices(services: RepositoryChainServices): RepositoryCliServices {
  return {
    workspaceFolder: services.workspaceFolder,
    outputChannel: services.outputChannel,
    repositoryService: services.repositoryService,
    projectSecretStorage: services.projectSecretStorage,
    createDesignerExecutor: services.createDesignerExecutor,
    designerExecutorDeps: services.designerExecutorDeps,
  };
}

/**
 * Узел → подключённая цель без UI: отказ возвращается видом, а показывает его вызывающий (UI —
 * предупреждением, MCP — ошибкой инструмента). `no-target` UI исторически не сопровождает сообщением.
 */
export type ConnectedTargetResolution =
  | { readonly kind: 'ok'; readonly target: RepositoryTarget }
  | { readonly kind: 'no-xml' | 'no-target' }
  | { readonly kind: 'not-connected'; readonly target: RepositoryTarget; readonly message: string };

export function resolveConnectedTarget(repositoryService: RepositoryService, node: RepositoryNodeRef): ConnectedTargetResolution {
  if (!node.xmlPath) {
    return { kind: 'no-xml' };
  }
  const target = repositoryService.resolveTargetByXmlPath(node.xmlPath);
  if (!target) {
    return { kind: 'no-target' };
  }
  if (!repositoryService.hasBinding(target) || !repositoryService.isConnected(target)) {
    return { kind: 'not-connected', target, message: describeNotConnected(target) };
  }
  return { kind: 'ok', target };
}

export function describeNotConnected(target: RepositoryTarget): string {
  return `Для "${target.displayName}" нет активного подключения к хранилищу.`;
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
  if (!target) {
    return null;
  }
  if (!services.repositoryService.hasBinding(target) || !services.repositoryService.isConnected(target)) {
    void vscode.window.showWarningMessage(describeNotConnected(target));
    return null;
  }
  return target;
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

  const resolution = resolveConnectedTarget(services.repositoryService, repositoryNode);
  if (resolution.kind === 'ok') {
    return { node: repositoryNode, target: resolution.target };
  }
  if (resolution.kind === 'not-connected') {
    void vscode.window.showWarningMessage(resolution.message);
  }
  return null;
}
