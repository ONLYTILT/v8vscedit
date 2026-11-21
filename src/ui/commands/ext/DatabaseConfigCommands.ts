import * as vscode from 'vscode';
import type { DatabaseLagEntry, DatabaseLagTarget } from '../../../infra/database/DatabaseConfigLag';
import type { CommandServices, NodeArg } from '../_shared';
import {
  runApplyDatabaseConfiguration,
  runUpdateExtension,
  runUpdateMainConfiguration,
  type ConfigurationProgressHooks,
} from './ExtensionCommandRunner';
import {
  beginConfigurationProgress,
  clearConfigurationProgress,
  createProgressHooks,
  extractRootConfigurationTarget,
  runExclusiveConfigurationOperation,
  runWithStandaloneServerStopped,
  setConfigurationProgress,
  showConfigurationCommandError,
  showOperationAlreadyRunningMessage,
  yieldToUi,
} from './ExtensionCommands';
import { endConfigurationOperation, tryBeginConfigurationOperation } from './configurationOperationLock';
import { planUpdateTargets, type UpdateTargetItem } from './databaseLoadPlan';
import { readUpdateDatabaseAfterLoad } from './databaseSettings';

/**
 * Команды загрузки в базу с обновлением конфигурации БД и без него, применения отставания и действий
 * индикатора «БД не обновлена». Вынесены из `ExtensionCommands` (порог размера файла); общие помощники
 * прогресса и замка импортируются оттуда же — второй копии нет.
 */

const ROOT_ONLY_WARNING = 'Команда доступна только для корневого узла конфигурации или расширения.';
const NO_CHANGES_MESSAGE = 'Изменений в конфигурациях не обнаружено.';
const NO_BEHIND_MESSAGE =
  'Нет конфигураций, отмеченных как не обновлённые в БД. Чтобы обновить конфигурацию БД, выберите корень ' +
  'конфигурации или расширения в навигаторе.';

interface UpdateChangedArgs {
  readonly updateDatabase?: unknown;
}

interface TargetPickItem extends vscode.QuickPickItem {
  readonly item?: UpdateTargetItem;
  readonly selectAll?: boolean;
}

interface LagActionItem extends vscode.QuickPickItem {
  readonly action: 'update' | 'update-all' | 'mark-current';
  readonly target?: DatabaseLagTarget;
}

export function registerDatabaseConfigCommands(context: vscode.ExtensionContext, services: CommandServices): void {
  context.subscriptions.push(
    // Аргумент `{ updateDatabase }` передаёт тонкий клиент (запуску Предприятия нужна конфигурация БД);
    // без него действует настройка updateDatabaseAfterLoad — это неявная загрузка.
    vscode.commands.registerCommand('v8vscedit.updateChangedConfigurations', (args?: UpdateChangedArgs) => {
      const updateDatabase = typeof args?.updateDatabase === 'boolean' ? args.updateDatabase : readUpdateDatabaseAfterLoad();
      return updateChangedConfigurations(services, updateDatabase);
    }),

    // Без узла (палитра команд) цели нет: команда относится к корню конфигурации или расширения.
    vscode.commands.registerCommand('v8vscedit.loadConfigurationChangesInDb', async (node?: NodeArg) => {
      const target = node ? extractRootConfigurationTarget(node) : null;
      if (!target) {
        void vscode.window.showWarningMessage(ROOT_ONLY_WARNING);
        return false;
      }
      return runExclusiveConfigurationOperation(
        {
          title: `Загрузка ${target.name} в базу`,
          startMessage: 'подготовка',
          cleanRootPath: target.rootPath,
          services,
        },
        () => runLoadItem(
          services,
          { target, action: 'load' },
          true,
          createProgressHooks(services, `Загрузка ${target.name} в базу`)
        )
      );
    }),

    vscode.commands.registerCommand('v8vscedit.updateDatabaseConfiguration', async (node?: NodeArg) => {
      const target = node ? extractRootConfigurationTarget(node) : await pickBehindTarget(services);
      if (!target) {
        if (node) {
          void vscode.window.showWarningMessage(ROOT_ONLY_WARNING);
        }
        return false;
      }
      return applyDatabaseConfiguration(services, [target]);
    }),

    vscode.commands.registerCommand('v8vscedit.databaseLag.showActions', () => showDatabaseLagActions(services))
  );
}

async function updateChangedConfigurations(services: CommandServices, updateDatabase: boolean): Promise<boolean> {
  const title = updateDatabase ? 'Обновление конфигураций' : 'Загрузка изменений в базу';
  if (!await tryBeginConfigurationOperation()) {
    await showOperationAlreadyRunningMessage();
    return false;
  }
  beginConfigurationProgress(services, title, 'проверка изменений');
  await yieldToUi();
  const completedRootPaths: string[] = [];
  try {
    const plan = planUpdateTargets(await services.getChangedConfigurations(), services.databaseConfigLag.list(), updateDatabase);
    if (plan.length === 0) {
      setConfigurationProgress(services, title, 'изменений нет', false);
      // Без await: внутри критической секции ожидание закрытия уведомления держало бы замок (запрет №18).
      void vscode.window.showInformationMessage(NO_CHANGES_MESSAGE);
      return true;
    }
    const selected = plan.length === 1 ? plan : await pickUpdateTargets(plan);
    if (selected.length === 0) {
      setConfigurationProgress(services, title, 'отменено', false);
      return false;
    }
    return await runWithStandaloneServerStopped(services, title, async () => {
      for (let index = 0; index < selected.length; index += 1) {
        const item = selected[index];
        const prefix = `${String(index + 1)}/${String(selected.length)}: ${item.target.name}`;
        setConfigurationProgress(services, title, prefix, true);
        const ok = await runLoadItem(services, item, selected.length === 1, createProgressHooks(services, title, prefix));
        if (!ok) {
          setConfigurationProgress(services, title, `остановлено на "${item.target.name}"`, false);
          return false;
        }
        // Применение без загрузки файлов проекта не меняло — «чистой» цель помечать незачем.
        if (item.action !== 'update-only') {
          completedRootPaths.push(item.target.rootPath);
        }
      }
      if (selected.length > 1) {
        void vscode.window.showInformationMessage(`Обновлено конфигураций: ${String(selected.length)}.`);
      }
      setConfigurationProgress(services, title, 'завершено', false);
      return true;
    });
  } catch (error) {
    setConfigurationProgress(services, title, 'ошибка', false);
    showConfigurationCommandError('Ошибка обновления конфигураций.', error, services);
    return false;
  } finally {
    await endConfigurationOperation();
    services.markConfigurationsClean(completedRootPaths);
    clearConfigurationProgress(services);
  }
}

/** Один элемент плана: загрузка (с обновлением БД или без) либо только UpdateDBCfg отстающей цели. */
function runLoadItem(
  services: CommandServices,
  item: UpdateTargetItem,
  showSuccessMessage: boolean,
  hooks: ConfigurationProgressHooks
): Promise<boolean> {
  const { target } = item;
  if (item.action === 'update-only') {
    return runApplyDatabaseConfiguration(target, services.workspaceFolder, services.outputChannel, services.databaseConfigLag, showSuccessMessage);
  }
  const options = { updateDatabase: item.action === 'load-and-update', lag: services.databaseConfigLag };
  return target.kind === 'cf'
    ? runUpdateMainConfiguration(target.name, target.rootPath, services.workspaceFolder, services.outputChannel, showSuccessMessage, hooks, options)
    // У расширения имя цели плана и есть имя расширения (изменённые — по Configuration.xml, отстающие — из раннера).
    : runUpdateExtension(
        target.name, target.rootPath, services.workspaceFolder, services.outputChannel, showSuccessMessage, hooks, options
      );
}

/**
 * Несколько целей: окно выбора как прежде у «Обновить изменённые конфигурации» — ничего не отмечено, пункт
 * «Все изменённые» отмечает/снимает все, у цели — число изменённых файлов (у отстающей без изменений — что
 * будет выполнено только обновление БД).
 */
function pickUpdateTargets(plan: readonly UpdateTargetItem[]): Promise<UpdateTargetItem[]> {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<TargetPickItem>();
    let resolved = false;
    const selectAllItem: TargetPickItem = { label: '$(check-all) Все изменённые', description: String(plan.length), selectAll: true };
    const targetItems = plan.map((item): TargetPickItem => ({
      label: `${item.target.kind === 'cf' ? '$(database)' : '$(extensions)'} ${item.target.name}`,
      description: item.target.kind === 'cf' ? 'Основная конфигурация' : 'Расширение',
      detail: item.action === 'update-only'
        ? 'только обновление конфигурации БД'
        : `${String(item.changedFilesCount)} изменённых файлов`,
      item,
    }));
    let applyingSelectAll = false;
    let selectAllActive = false;
    const select = (items: TargetPickItem[], allActive: boolean): void => {
      applyingSelectAll = true;
      quickPick.selectedItems = items;
      selectAllActive = allActive;
      applyingSelectAll = false;
    };
    quickPick.canSelectMany = true;
    quickPick.title = 'Что обновлять';
    quickPick.placeholder = 'Выберите конфигурации для обновления';
    quickPick.items = [selectAllItem, ...targetItems];
    quickPick.selectedItems = [];

    quickPick.onDidChangeSelection((selection) => {
      if (applyingSelectAll) {
        return;
      }
      const hasSelectAll = selection.some((entry) => entry.selectAll === true);
      const selectedTargets = selection.filter((entry) => entry.item !== undefined);
      if (hasSelectAll && !selectAllActive) {
        select([selectAllItem, ...targetItems], true);
      } else if (hasSelectAll && selectedTargets.length < targetItems.length) {
        select(selectedTargets, false);
      } else if (!hasSelectAll && selectedTargets.length === targetItems.length) {
        select([selectAllItem, ...targetItems], true);
      } else {
        selectAllActive = hasSelectAll;
      }
    });
    quickPick.onDidAccept(() => {
      resolved = true;
      const items = quickPick.selectedItems.some((entry) => entry.selectAll === true)
        ? [...plan]
        : quickPick.selectedItems.map((entry) => entry.item).filter((item): item is UpdateTargetItem => item !== undefined);
      quickPick.hide();
      resolve(items);
    });
    quickPick.onDidHide(() => {
      quickPick.dispose();
      if (!resolved) {
        resolve([]);
      }
    });
    quickPick.show();
  });
}

/** Применение UpdateDBCfg к целям по порядку; файлы проекта не менялись — `cleanRootPath` не нужен. */
function applyDatabaseConfiguration(services: CommandServices, targets: readonly DatabaseLagTarget[]): Promise<boolean> {
  const title = targets.length === 1 ? `Обновление конфигурации БД: ${targets[0].name}` : 'Обновление конфигурации БД';
  return runExclusiveConfigurationOperation({ title, startMessage: 'подготовка', services }, async () => {
    for (const target of targets) {
      if (!await runApplyDatabaseConfiguration(target, services.workspaceFolder, services.outputChannel, services.databaseConfigLag, true)) {
        return false;
      }
    }
    return true;
  });
}

function behindTargets(services: CommandServices): DatabaseLagTarget[] {
  return planUpdateTargets([], services.databaseConfigLag.list(), true).map((item) => item.target);
}

function lagTargetPickItems(entries: readonly DatabaseLagTarget[]): (vscode.QuickPickItem & { readonly target: DatabaseLagTarget })[] {
  return entries.map((target) => ({
    label: `${target.kind === 'cf' ? '$(database)' : '$(extensions)'} ${target.name}`,
    description: target.kind === 'cf' ? 'Основная конфигурация' : 'Расширение',
    target,
  }));
}

async function pickBehindTarget(services: CommandServices): Promise<DatabaseLagTarget | undefined> {
  const targets = behindTargets(services);
  if (targets.length === 0) {
    void vscode.window.showInformationMessage(NO_BEHIND_MESSAGE);
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(lagTargetPickItems(targets), {
    title: 'Обновить конфигурацию БД',
    placeHolder: 'Конфигурация БД не обновлена после загрузки изменений',
  });
  return picked?.target;
}

/** Клик по индикатору: обновить одну цель, все, либо снять отметку вручную (обновлено вне расширения). */
async function showDatabaseLagActions(services: CommandServices): Promise<void> {
  const targets = behindTargets(services);
  if (targets.length === 0) {
    return;
  }
  const items: LagActionItem[] = [
    ...targets.map((target): LagActionItem => ({ label: `$(database) Обновить конфигурацию БД: ${target.name}`, action: 'update', target })),
    { label: '$(database) Обновить все', action: 'update-all' },
    { label: '$(check) Отметить как обновлённую (обновлено вне расширения)', action: 'mark-current' },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Конфигурация БД не обновлена',
    placeHolder: describeLagPlaceholder(services.databaseConfigLag.list()),
  });
  // Цель есть только у пунктов «Обновить конфигурацию БД: <имя>».
  if (picked?.target) {
    await applyDatabaseConfiguration(services, [picked.target]);
  } else if (picked?.action === 'update-all') {
    await applyDatabaseConfiguration(services, targets);
  } else if (picked?.action === 'mark-current') {
    const chosen = await vscode.window.showQuickPick(lagTargetPickItems(targets), {
      title: 'Отметить как обновлённую',
      placeHolder: 'Конфигурация БД этой цели обновлена вне расширения',
    });
    if (chosen) {
      services.databaseConfigLag.markCurrent(chosen.target);
    }
  }
}

function describeLagPlaceholder(entries: readonly DatabaseLagEntry[]): string {
  return `Не обновлено конфигураций: ${String(entries.length)}`;
}
