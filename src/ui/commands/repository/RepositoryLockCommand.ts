import * as vscode from 'vscode';
import type { RepositoryTarget } from '../../../infra/repository/RepositoryService';
import type { CommandServices, NodeArg } from '../_shared';
import { runWithConfigurationOperationLock } from '../ext/configurationOperationLock';
import { runRepositoryLockAction } from './RepositoryCommandRunner';
import { resolveRepositoryNode, toCliServices, type RepositoryCommandNode } from './repositoryNodeTargets';
import {
  describeImportFailureAfterLock,
  describeProjectBehindAfterLock,
  planRepositoryLock,
  shouldImportAfterLock,
  type LockLocalChangesChoice,
  type RepositoryLockPlan,
} from './repositoryLockFlow';
import { findChangedConfiguration, importTargetFromDatabase, refreshRepositoryUi, updateTargetDatabase } from './repositoryPostSync';
import { askRecursiveMode } from './repositoryPrompts';

/**
 * Команда `v8vscedit.repository.lock`: захват объектов и, если захват получил из хранилища новые
 * версии, импорт изменившихся объектов в проект. Захват меняет основную конфигурацию базы (даже
 * без `-revised`, эксперимент Э14); проект, отстающий от базы, при следующей «Обновить БД»
 * перезаписал бы полученные версии. «Обновить БД» (`/UpdateDBCfg`) в цепочку не входит: импорт
 * читает основную конфигурацию, а конфигурация БД нужна только для запуска Предприятия.
 */
export function registerRepositoryLockCommand(context: vscode.ExtensionContext, services: CommandServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('v8vscedit.repository.lock', (node: NodeArg) => runLockCommand(services, node))
  );
}

async function runLockCommand(services: CommandServices, node: NodeArg): Promise<void> {
  const resolved = resolveRepositoryNode(services, node);
  if (!resolved) {
    return;
  }
  const { node: repositoryNode, target } = resolved;

  const recursive = await askRecursiveMode('Захват объектов', repositoryNode.label ?? 'выбранный узел');
  if (recursive === undefined) {
    return;
  }

  const plan = await resolveLockPlan(services, target);
  if (plan === 'cancel') {
    return;
  }

  const ok = await runWithConfigurationOperationLock(
    () => runLockChain(services, target, repositoryNode, recursive, plan)
  );
  if (ok === true) {
    refreshRepositoryUi(services);
  }
}

/** Вопрос задаётся ДО замка: ожидание ответа пользователя не должно держать базу занятой. */
async function resolveLockPlan(services: CommandServices, target: RepositoryTarget): Promise<RepositoryLockPlan | 'cancel'> {
  const revisedSetting = vscode.workspace.getConfiguration('v8vscedit').get<boolean>('repository.getRevisedOnLock', true);
  const dirtyFilesCount = (await findChangedConfiguration(services, target))?.changedFilesCount ?? 0;
  let choice: LockLocalChangesChoice | undefined;
  // Таблица решения одна: после ответа она сама скажет, что делать (при ответе 'ask' не возвращается).
  for (;;) {
    const plan = planRepositoryLock({ revisedSetting, dirtyFilesCount, choice });
    if (plan !== 'ask') {
      return plan;
    }
    choice = await promptLockWithLocalChanges(target, dirtyFilesCount);
  }
}

interface LockChoiceItem extends vscode.QuickPickItem {
  readonly id: LockLocalChangesChoice;
}

/**
 * Импорт после захвата перезаписывает файлы проекта из базы, поэтому незагруженные правки иначе
 * пропали бы молча. Вопрос с ответом — запрет №18 его не касается.
 */
async function promptLockWithLocalChanges(target: RepositoryTarget, dirtyFilesCount: number): Promise<LockLocalChangesChoice> {
  const items: LockChoiceItem[] = [
    {
      id: 'update-then-lock',
      label: '$(sync) Загрузить правки в базу, затем захватить',
      detail: 'Правки должны относиться к уже захваченным объектам: незахваченный объект платформа загрузить не даст',
    },
    {
      id: 'lock-without-import',
      label: '$(lock) Захватить, проект не обновлять',
      detail: 'Если в хранилище есть новые версии, база получит их, а файлы проекта останутся прежними',
    },
    {
      id: 'cancel',
      label: '$(close) Отменить захват',
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Захват объектов: в проекте есть незагруженные правки',
    placeHolder: `${target.displayName}: изменённых файлов ${String(dirtyFilesCount)}, они ещё не загружены в базу`,
    ignoreFocusOut: true,
  });
  return picked?.id ?? 'cancel';
}

/** Вся цепочка — одна секция замка: между захватом и импортом не должна вклиниться другая операция. */
async function runLockChain(
  services: CommandServices,
  target: RepositoryTarget,
  node: RepositoryCommandNode,
  recursive: boolean,
  plan: RepositoryLockPlan
): Promise<boolean> {
  // Сбой загрузки (в т.ч. отказ платформы загрузить незахваченный объект) — захвата не было.
  if (plan.updateDatabaseFirst && !await updateTargetDatabase(target, services)) {
    return false;
  }
  const outcome = await runRepositoryLockAction(toCliServices(services), node, recursive, { revised: plan.revised });
  if (outcome === undefined) {
    return false;
  }
  if (shouldImportAfterLock(plan, outcome)) {
    if (!await importTargetFromDatabase(target, services)) {
      // Без await (запрет №18): иначе замок держался бы до закрытия уведомления.
      void vscode.window.showWarningMessage(describeImportFailureAfterLock(target.displayName));
    }
  } else if (!plan.importAfterLock && outcome.receivedFromRepository) {
    void vscode.window.showWarningMessage(describeProjectBehindAfterLock(target.displayName));
  }
  return true;
}
