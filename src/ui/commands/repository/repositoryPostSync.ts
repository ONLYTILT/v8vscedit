import * as path from 'path';
import type { DatabaseLagTarget } from '../../../infra/database/DatabaseConfigLag';
import type { ChangedConfiguration } from '../../../infra/fs/ConfigurationChangeDetector';
import type { RepositoryTarget } from '../../../infra/repository/RepositoryService';
import type { CommandServices } from '../_shared';
import type { ConfigurationImportOptions, OperationInteraction } from '../ext/configurationOperationTypes';
import type { DatabaseLoadOptions } from '../ext/databaseLoadPlan';
import {
  runApplyDatabaseConfiguration,
  runDecompileExtension,
  runDecompileMainConfiguration,
  runUpdateExtension,
  runUpdateMainConfiguration,
} from '../ext/ExtensionCommandRunner';

/**
 * Синхронизация базы и файлов проекта вокруг операций хранилища: загрузка правок перед
 * помещением/захватом, импорт после получения версий. Общая для нескольких команд, поэтому живёт
 * отдельно от регистрации: вторая копия «decompile → clean → reload» не должна появиться.
 */

/**
 * Сервисы, которые нужны цепочкам хранилища (`repositoryChains`): UI-команды и MCP-инструменты
 * передают один и тот же `CommandServices`, а Pick держит зависимость цепочек узкой и явной.
 */
export type RepositoryChainServices = Pick<
  CommandServices,
  | 'workspaceFolder'
  | 'outputChannel'
  | 'repositoryService'
  | 'projectSecretStorage'
  | 'createDesignerExecutor'
  | 'designerExecutorDeps'
  | 'treeProvider'
  | 'refreshActionsView'
  | 'getChangedConfigurations'
  | 'markConfigurationsClean'
  | 'reloadEntries'
  | 'databaseConfigLag'
>;

/** Имя расширения цели хранилища: без явного `extensionName` — отображаемое имя. */
function extensionNameOf(target: RepositoryTarget): string {
  return target.extensionName ?? target.displayName;
}

/** Цель признака «БД отстаёт» по цели хранилища: ключ тот же, что у раннеров загрузки. */
export function toDatabaseLagTarget(target: RepositoryTarget): DatabaseLagTarget {
  return target.configKind === 'cfe'
    ? { kind: 'cfe', name: target.displayName, rootPath: target.configRoot, extensionName: extensionNameOf(target) }
    : { kind: 'cf', name: target.displayName, rootPath: target.configRoot };
}

export function refreshRepositoryUi(services: RepositoryChainServices): void {
  services.treeProvider.refresh();
  services.refreshActionsView();
}

/** Незагруженные правки цели — тот же источник, что у индикатора «конфигурация изменена». */
export async function findChangedConfiguration(
  services: RepositoryChainServices,
  target: RepositoryTarget
): Promise<ChangedConfiguration | undefined> {
  const root = path.resolve(target.configRoot).toLowerCase();
  return (await services.getChangedConfigurations()).find((item) => path.resolve(item.rootPath).toLowerCase() === root);
}

/**
 * Режим вызова цепочки — обязательный: компилятор показывает каждый вызов, и забытый MCP-путь становится
 * ошибкой сборки, а не модальным окном. `onFailure` получает причину отказа раннера.
 */
interface ChainStepOptions {
  readonly interaction: OperationInteraction;
  readonly onFailure?: (reason: string) => void;
}

/**
 * Загрузка правок проекта в базу (`false` — сбой или отмена; в interactive ошибку уже показал раннер).
 * Обновление конфигурации БД — по `options.updateDatabase` (настройка `updateDatabaseAfterLoad` или
 * параметр MCP); признак отставания ставит и снимает сам раннер.
 */
export async function loadTargetChangesIntoDatabase(
  target: RepositoryTarget,
  services: RepositoryChainServices,
  options: ChainStepOptions & { readonly updateDatabase: boolean }
): Promise<boolean> {
  const loadOptions: DatabaseLoadOptions = {
    updateDatabase: options.updateDatabase,
    lag: services.databaseConfigLag,
    interaction: options.interaction,
    onFailure: options.onFailure,
  };
  const updated = target.configKind === 'cfe'
    ? await runUpdateExtension(
        extensionNameOf(target),
        target.configRoot,
        services.workspaceFolder,
        services.outputChannel,
        false,
        undefined,
        loadOptions
      )
    : await runUpdateMainConfiguration(
        target.displayName,
        target.configRoot,
        services.workspaceFolder,
        services.outputChannel,
        false,
        undefined,
        loadOptions
      );
  if (!updated) {
    return false;
  }

  services.markConfigurationsClean([target.configRoot]);
  refreshRepositoryUi(services);
  return true;
}

/**
 * Импорт основной конфигурации базы в файлы проекта. Проект помечается чистым только при успехе:
 * иначе «Обновить БД» из устаревших файлов перезаписала бы полученные из хранилища версии.
 */
export async function importTargetFromDatabase(
  target: RepositoryTarget,
  services: RepositoryChainServices,
  options: ChainStepOptions
): Promise<boolean> {
  const importOptions: ConfigurationImportOptions = {
    interaction: options.interaction,
    onOutcome: (outcome) => {
      if (!outcome.success && outcome.reason) {
        options.onFailure?.(outcome.reason);
      }
    },
  };
  const imported = target.configKind === 'cfe'
    ? await runDecompileExtension(
        target.extensionName ?? target.displayName,
        target.configRoot,
        services.workspaceFolder,
        services.outputChannel,
        undefined,
        importOptions
      )
    : await runDecompileMainConfiguration(
        target.displayName,
        target.configRoot,
        services.workspaceFolder,
        services.outputChannel,
        undefined,
        importOptions
      );
  if (!imported) {
    return false;
  }

  services.markConfigurationsClean([target.configRoot]);
  await services.reloadEntries();
  refreshRepositoryUi(services);
  return true;
}

/** После подключения/создания хранилища: применить конфигурацию к БД и импортировать её в проект. */
export async function runPostRepositorySync(target: RepositoryTarget, services: RepositoryChainServices): Promise<void> {
  try {
    const updated = await runApplyDatabaseConfiguration({
      kind: target.configKind,
      name: target.displayName,
      rootPath: target.configRoot,
      extensionName: target.extensionName,
    }, services.workspaceFolder, services.outputChannel, services.databaseConfigLag, false);
    if (!updated) {
      return;
    }
    await importTargetFromDatabase(target, services, { interaction: 'interactive' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.outputChannel.appendLine(`[repository][post-sync][error] ${message}`);
  }
}
