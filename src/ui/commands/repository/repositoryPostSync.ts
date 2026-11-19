import * as path from 'path';
import type { ChangedConfiguration } from '../../../infra/fs/ConfigurationChangeDetector';
import type { RepositoryTarget } from '../../../infra/repository/RepositoryService';
import type { CommandServices } from '../_shared';
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

export function refreshRepositoryUi(services: CommandServices): void {
  services.treeProvider.refresh();
  services.refreshActionsView();
}

/** Незагруженные правки цели — тот же источник, что у индикатора «конфигурация изменена». */
export async function findChangedConfiguration(
  services: CommandServices,
  target: RepositoryTarget
): Promise<ChangedConfiguration | undefined> {
  const root = path.resolve(target.configRoot).toLowerCase();
  return (await services.getChangedConfigurations()).find((item) => path.resolve(item.rootPath).toLowerCase() === root);
}

/** Загрузка правок проекта в базу (`false` — сбой или отмена; ошибку уже показал раннер). */
export async function updateTargetDatabase(target: RepositoryTarget, services: CommandServices): Promise<boolean> {
  const updated = target.configKind === 'cfe'
    ? await runUpdateExtension(
        target.extensionName ?? target.displayName,
        target.configRoot,
        services.workspaceFolder,
        services.outputChannel,
        false
      )
    : await runUpdateMainConfiguration(
        target.displayName,
        target.configRoot,
        services.workspaceFolder,
        services.outputChannel,
        false
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
export async function importTargetFromDatabase(target: RepositoryTarget, services: CommandServices): Promise<boolean> {
  const imported = target.configKind === 'cfe'
    ? await runDecompileExtension(
        target.extensionName ?? target.displayName,
        target.configRoot,
        services.workspaceFolder,
        services.outputChannel
      )
    : await runDecompileMainConfiguration(
        target.displayName,
        target.configRoot,
        services.workspaceFolder,
        services.outputChannel
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
export async function runPostRepositorySync(target: RepositoryTarget, services: CommandServices): Promise<void> {
  try {
    const updated = await runApplyDatabaseConfiguration({
      kind: target.configKind,
      name: target.displayName,
      rootPath: target.configRoot,
      extensionName: target.extensionName,
    }, services.workspaceFolder, services.outputChannel, false);
    if (!updated) {
      return;
    }
    await importTargetFromDatabase(target, services);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.outputChannel.appendLine(`[repository][post-sync][error] ${message}`);
  }
}
