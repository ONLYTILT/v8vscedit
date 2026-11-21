import * as vscode from 'vscode';
import type { RepositoryTarget } from '../../../infra/repository/RepositoryService';
import type { CommandServices, NodeArg } from '../_shared';
import { runWithConfigurationOperationLock } from '../ext/configurationOperationLock';
import { readUpdateDatabaseAfterLoad, withLoadModeNote } from '../ext/databaseSettings';
import { describeRepositoryActionSuccess } from './RepositoryCommandRunner';
import { runUpdateChain } from './repositoryChains';
import { showRepositoryChainFailure, showRepositoryChainWarnings } from './repositoryChainUi';
import { normalizeUpdateVersion } from './repositoryOperationBuilders';
import { resolveRepositoryNode, type RepositoryCommandNode } from './repositoryNodeTargets';
import { findChangedConfiguration, refreshRepositoryUi } from './repositoryPostSync';
import { askRecursiveMode, pickBoolean } from './repositoryPrompts';
import {
  describeLockedOverwrite,
  planRepositoryUpdate,
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

  const lockedInSelection = services.repositoryService.findLockedInSelection(repositoryNode, request.recursive);
  const plan = await resolveUpdatePlan(services, target, lockedInSelection);
  if (plan === 'cancel') {
    return;
  }

  const ok = await runWithConfigurationOperationLock(
    () => runUpdateChainWithUi(services, target, repositoryNode, request, plan)
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

/** Вопросы задаются ДО замка: ожидание ответа пользователя не должно держать базу занятой. */
async function resolveUpdatePlan(
  services: CommandServices,
  target: RepositoryTarget,
  lockedInSelection: readonly string[]
): Promise<RepositoryUpdatePlan | 'cancel'> {
  const dirtyFilesCount = (await findChangedConfiguration(services, target))?.changedFilesCount ?? 0;
  const updateDatabaseAfterLoad = readUpdateDatabaseAfterLoad();
  let lockedOverwriteConfirmed: boolean | undefined;
  let choice: UpdateLocalChangesChoice | undefined;
  // Таблица решения одна: после каждого ответа она сама скажет, что делать дальше.
  for (;;) {
    const plan = planRepositoryUpdate({ dirtyFilesCount, lockedInSelection, lockedOverwriteConfirmed, choice, updateDatabaseAfterLoad });
    if (plan === 'ask-locked-overwrite') {
      lockedOverwriteConfirmed = await promptOverwriteLocked(lockedInSelection);
    } else if (plan === 'ask-local-changes') {
      choice = await promptUpdateWithLocalChanges(target, dirtyFilesCount, updateDatabaseAfterLoad);
    } else {
      return plan;
    }
  }
}

interface OverwriteLockedItem extends vscode.QuickPickItem {
  readonly id: 'receive' | 'cancel';
}

/**
 * Платформа не бережёт захваченные объекты при получении (Э24), а вернуть потерянные правки базы
 * расширению нечем, поэтому решает человек. Вопрос с ответом — запрет №18 его не касается.
 */
async function promptOverwriteLocked(lockedInSelection: readonly string[]): Promise<boolean> {
  const items: OverwriteLockedItem[] = [
    {
      id: 'receive',
      label: '$(warning) Получить, вернув захваченные объекты к версии хранилища',
      detail: 'Незагруженные правки проекта будут загружены после получения, если вы выберете это на следующем шаге',
    },
    {
      id: 'cancel',
      label: '$(close) Отменить получение',
      detail: 'Сначала поместите правки захваченных объектов в хранилище или получите другой узел',
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Получение из хранилища: в выборке есть захваченные вами объекты',
    placeHolder: describeLockedOverwrite(lockedInSelection),
    ignoreFocusOut: true,
  });
  return picked?.id === 'receive';
}

interface UpdateChoiceItem extends vscode.QuickPickItem {
  readonly id: UpdateLocalChangesChoice;
}

/**
 * Импорт после получения перезаписывает файлы проекта из базы, поэтому незагруженные правки иначе
 * пропали бы молча. Вопрос с ответом — запрет №18 его не касается.
 */
async function promptUpdateWithLocalChanges(
  target: RepositoryTarget,
  dirtyFilesCount: number,
  updateDatabaseAfterLoad: boolean
): Promise<UpdateLocalChangesChoice> {
  const items: UpdateChoiceItem[] = [
    {
      id: 'receive-then-load',
      label: '$(sync) Получить, затем загрузить правки в базу',
      detail: withLoadModeNote(
        'Правки должны относиться к захваченным объектам: незахваченный объект платформа загрузить не даст',
        updateDatabaseAfterLoad
      ),
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

/**
 * Вся цепочка — одна секция замка: между получением, загрузкой и импортом не должна вклиниться другая
 * операция. Загрузка правок — после получения (Э24): загруженное до него получение затёрло бы.
 */
async function runUpdateChainWithUi(
  services: CommandServices,
  target: RepositoryTarget,
  node: RepositoryCommandNode,
  request: UpdateRequest,
  plan: RepositoryUpdatePlan
): Promise<boolean> {
  try {
    const result = await runUpdateChain(services, target, node, request, plan);
    void vscode.window.showInformationMessage(describeRepositoryActionSuccess('update', node.label ?? target.displayName));
    showRepositoryChainWarnings(result.warnings);
    return true;
  } catch (error) {
    showRepositoryChainFailure(error);
    return false;
  }
}
