/**
 * Общие приспособления Э5: персональный корень агента из agentbasedir.json.
 *
 * Имя пользователя и каталог выбраны так, чтобы не совпасть с прежним хардкодом '0':
 * тест падает, если путь персонального корня где-то вычисляется не по индексу.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AgentOperationService } from '../../../infra/agent';
import { buildAgentProjectId } from '../../../infra/agent/AgentWorkspaceService';

export const AGENT_USER = 'ТестовыйПользователь';
export const USER_DIR = '7';

/** Каталог агента проекта (`--basedir`): здесь лежит agentbasedir.json. */
export function agentBaseDirOf(root: string): string {
  return path.join(root, '.v8vscedit', 'agent');
}

/** Персональный корень пользователя: <agentBaseDir>/<dir из json>. */
export function userRootOf(root: string): string {
  return path.join(agentBaseDirOf(root), USER_DIR);
}

/** Серверное зеркало M цели cf: <корень пользователя>/workspace/<projectId>/cf. */
export function mirrorDirOf(root: string): string {
  return path.join(userRootOf(root), 'workspace', buildAgentProjectId(root), 'cf');
}

/** Серверное зеркало M цели cfe: <корень пользователя>/workspace/<projectId>/cfe/<имя>. */
export function cfeMirrorDirOf(root: string, extensionName: string): string {
  return path.join(userRootOf(root), 'workspace', buildAgentProjectId(root), 'cfe', extensionName);
}

export function writeAgentIndex(
  root: string,
  users: { name: string; dir: string }[] = [{ name: AGENT_USER, dir: USER_DIR }]
): void {
  fs.mkdirSync(agentBaseDirOf(root), { recursive: true });
  fs.writeFileSync(path.join(agentBaseDirOf(root), 'agentbasedir.json'), JSON.stringify({ usersInfo: users }), 'utf-8');
}

/** Сервис с локальным хранилищем; индекс пользователей досевается, если его ещё нет. */
export function newService(
  root: string,
  factory: ConstructorParameters<typeof AgentOperationService>[1],
  sessionOptions: ConstructorParameters<typeof AgentOperationService>[2] = {}
): AgentOperationService {
  if (!fs.existsSync(path.join(agentBaseDirOf(root), 'agentbasedir.json'))) {
    writeAgentIndex(root);
  }
  return new AgentOperationService(root, factory, sessionOptions, { userName: AGENT_USER });
}
