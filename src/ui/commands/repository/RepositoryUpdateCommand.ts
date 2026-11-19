import * as vscode from 'vscode';
import type { RepositoryTarget } from '../../../infra/repository/RepositoryService';
import type { CommandServices, NodeArg } from '../_shared';
import { runWithConfigurationOperationLock } from '../ext/configurationOperationLock';
import { runRepositoryUpdateAction } from './RepositoryCommandRunner';
import { normalizeUpdateVersion } from './repositoryOperationBuilders';
import { resolveRepositoryNode, toCliServices, type RepositoryCommandNode } from './repositoryNodeTargets';
import { findChangedConfiguration, importTargetFromDatabase, refreshRepositoryUi, updateTargetDatabase } from './repositoryPostSync';
import { askRecursiveMode, pickBoolean } from './repositoryPrompts';
import {
  describeImportFailureAfterReceive,
  describeProjectBehindAfterReceive,
  planRepositoryUpdate,
  shouldImportAfterReceive,
  type RepositoryUpdatePlan,
  type UpdateLocalChangesChoice,
} from './repositoryUpdateFlow';

interface UpdateRequest {
  readonly recursive: boolean;
  readonly force: boolean;
  readonly version: string | undefined;
}

/**
 * Команда `v8vscedit.repository.update`: получение из хранилища и, если получены новые версии,
 * импорт изменившихся объектов в проект — та же схема, что у захвата (RepositoryLockCommand).
 */
export function registerRepositoryUpdateCommand(context: vscode.ExtensionContext, services: CommandServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('v8vscedit.repository.update', (node: NodeArg) => runUpdateCommand(services, node))
  );
}

async function runUpdateCommand(services: CommandServices, node: NodeArg): Promise<void> {
  const resolved = resolveRepositoryNode(services, node);
  if (!resolved) {
    return;
  }
  const { node: repositoryNode, target } = resolved;

  const request = await askUpdateRequest(repositoryNode);
  if (!request) {
    return;
  }

  const plan = await resolveUpdatePlan(services, target);
  if (plan === 'cancel') {
    return;
  }

  const ok = await runWithConfigurationOperationLock(
    () => runUpdateChain(services, target, repositoryNode, request, plan)
  );
  if (ok === true) {
    refreshRepositoryUi(services);
  }
}

async function askUpdateRequest(node: RepositoryCommandNode): Promise<UpdateRequest | undefined> {
  const recursive = await askRecursiveMode('Получение из хранилища', node.label ?? 'выбранный узел');
  if (recursive === undefined) {
    return undefined;
  }
  const force = await pickBoolean('Получение из хранилища', 'Выполнять принудительное получение?', 'С force', 'Без force');
  if (force === undefined) {
    return undefined;
  }
  const version = await vscode.window.showInputBox({
    title: 'Получение из хранилища',
    prompt: 'Версия хранилища для получения. Оставьте пустым для актуальной.',
    placeHolder: 'Например: 125',
    ignoreFocusOut: true,
  });
  if (version === undefined) {
    return undefined;
  }
  return { recursive, force, version: normalizeUpdateVersion(version) };
}

/** Вопрос задаётся ДО замка: ожидание ответа пользователя не должно держать базу занятой. */
async function resolveUpdatePlan(services: CommandServices, target: RepositoryTarget): Promise<RepositoryUpdatePlan | 'cancel'> {
  const dirtyFilesCount = (await findChangedConfiguration(services, target))?.changedFilesCount ?? 0;
  let choice: UpdateLocalChangesChoice | undefined;
  // Таблица решения одна: после ответа она сама скажет, что делать (при ответе 'ask' не возвращается).
  for (;;) {
    const plan = planRepositoryUpdate({ dirtyFilesCount, choice });
    if (plan !== 'ask') {
      return plan;
    }
    choice = await promptUpdateWithLocalChanges(target, dirtyFilesCount);
  }
}

interface UpdateChoiceItem extends vscode.QuickPickItem {
  readonly id: UpdateLocalChangesChoice;
}

/**
 * Импорт после получения перезаписывает файлы проекта из базы, поэтому незагруженные правки иначе
 * пропали бы молча. Вопрос с ответом — запрет №18 его не касается.
 */
async function promptUpdateWithLocalChanges(target: RepositoryTarget, dirtyFilesCount: number): Promise<UpdateLocalChangesChoice> {
  const items: UpdateChoiceItem[] = [
    {
      id: 'update-then-receive',
      label: '$(sync) Загрузить правки в базу, затем получить',
      detail: 'Правки должны относиться к захваченным объектам: незахваченный объект платформа загрузить не даст',
    },
    {
      id: 'receive-without-import',
      label: '$(cloud-download) Получить, проект не обновлять',
      detail: 'База получит новые версии, а файлы проекта останутся прежними',
    },
    {
      id: 'cancel',
      label: '$(close) Отменить получение',
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Получение из хранилища: в проекте есть незагруженные правки',
    placeHolder: `${target.displayName}: изменённых файлов ${String(dirtyFilesCount)}, они ещё не загружены в базу`,
    ignoreFocusOut: true,
  });
  return picked?.id ?? 'cancel';
}

/** Вся цепочка — одна секция замка: между получением и импортом не должна вклиниться другая операция. */
async function runUpdateChain(
  services: CommandServices,
  target: RepositoryTarget,
  node: RepositoryCommandNode,
  request: UpdateRequest,
  plan: RepositoryUpdatePlan
): Promise<boolean> {
  if (plan.updateDatabaseFirst && !await updateTargetDatabase(target, services)) {
    return false;
  }
  const outcome = await runRepositoryUpdateAction(toCliServices(services), node, request);
  if (outcome === undefined) {
    return false;
  }
  if (shouldImportAfterReceive(plan, outcome)) {
    if (!await importTargetFromDatabase(target, services)) {
      // Без await (запрет №18): иначе замок держался бы до закрытия уведомления.
      void vscode.window.showWarningMessage(describeImportFailureAfterReceive(target.displayName));
    }
  } else if (!plan.importAfterReceive && outcome.receivedFromRepository) {
    void vscode.window.showWarningMessage(describeProjectBehindAfterReceive(target.displayName));
  }
  return true;
}
