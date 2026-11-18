import type { AgentCommandExecutor } from '../AgentInfoBaseSession';
import type { AgentConfigurationOperationTarget, AgentOperationHooks } from '../AgentOperationService';
import { sanitizePathPart, type AgentWorkspaceService } from '../AgentWorkspaceService';
import type { AgentFileStore } from '../files/AgentFileStore';
import { DEFAULT_AGENT_TRANSFER_CONCURRENCY } from '../files/AgentFileTransfer';
import { buildScopeKey, saveHashCache } from '../../cache/HashCache';
import { runImport, type AgentImportResult } from './AgentImportFlow';
import { runLoad, type AgentLoadMode, type AgentLoadResult } from './AgentLoadFlow';
import { throwIfCancelled, type SyncOperationContext } from './SyncContext';
import { buildSyncManifestFiles, loadSyncManifest, saveSyncManifest, type SyncManifest, type SyncMirrorState } from './SyncManifest';

export { AgentSyncCancelledError } from './SyncContext';
export type { AgentImportResult } from './AgentImportFlow';
export type { AgentLoadMode, AgentLoadResult } from './AgentLoadFlow';

/** Порог архива по умолчанию (план, «решения без вопросов»): больше файлов — один архив вместо дельты. */
export const DEFAULT_ARCHIVE_THRESHOLD_FILES = 300;

export interface AgentSyncEngineOptions {
  readonly projectRoot: string;
  readonly store: AgentFileStore;
  readonly workspace: AgentWorkspaceService;
  readonly archiveThresholdFiles?: number;
  readonly transferConcurrency?: number;
  /** Источник уникальной части имени операции (по умолчанию — `Date.now`). */
  readonly now?: () => number;
}

/**
 * Движок синхронизации цели (cf или cfe/<имя>) с агентом конфигуратора: модель M/P/B плана §1.1.
 * Здесь — жизненный цикл операции (манифест B, состояние M, каталог обмена, отмена); стратегии
 * импорта и загрузки — в `AgentImportFlow`/`AgentLoadFlow`, запись в проект — в `ProjectFiles`.
 */
export class AgentSyncEngine {
  private readonly archiveThresholdFiles: number;
  private readonly transferConcurrency: number;
  private readonly now: () => number;

  constructor(private readonly options: AgentSyncEngineOptions) {
    this.archiveThresholdFiles = options.archiveThresholdFiles ?? DEFAULT_ARCHIVE_THRESHOLD_FILES;
    this.transferConcurrency = options.transferConcurrency ?? DEFAULT_AGENT_TRANSFER_CONCURRENCY;
    this.now = options.now ?? Date.now;
  }

  /** БД → P. После успеха P ≡ M по отслеживаемым файлам, B = hash(P), M — `fresh`. */
  importTarget(
    target: AgentConfigurationOperationTarget,
    exec: AgentCommandExecutor,
    hooks?: AgentOperationHooks
  ): Promise<AgentImportResult> {
    return this.runOperation(target, exec, hooks, async (context) => {
      const result = await runImport(context);
      return { result, baseline: { files: await buildSyncManifestFiles(target.rootPath, this.options.projectRoot), mirrorState: 'fresh' } };
    });
  }

  /** P → БД. B обновляется только после успешной загрузки; пропуск B не трогает. */
  loadTarget(
    target: AgentConfigurationOperationTarget,
    mode: AgentLoadMode,
    exec: AgentCommandExecutor,
    hooks?: AgentOperationHooks
  ): Promise<AgentLoadResult> {
    return this.runOperation(target, exec, hooks, async (context) => {
      const outcome = await runLoad(context, mode);
      return outcome.result.skipped
        ? { result: outcome.result }
        : { result: outcome.result, baseline: { files: outcome.files, mirrorState: outcome.mirrorState } };
    });
  }

  private async runOperation<T>(
    target: AgentConfigurationOperationTarget,
    exec: AgentCommandExecutor,
    hooks: AgentOperationHooks | undefined,
    run: (context: SyncOperationContext) => Promise<{
      result: T;
      /** Новая B и состояние M; без неё (пропуск загрузки) манифест не трогается. */
      baseline?: { files: Record<string, string>; mirrorState: SyncMirrorState };
    }>
  ): Promise<T> {
    throwIfCancelled({ hooks });
    const { projectRoot, store, workspace: workspaceService } = this.options;
    const extensionName = target.kind === 'cfe' ? target.extensionName ?? target.name : undefined;
    const scopeKey = buildScopeKey(target.kind, target.rootPath, extensionName ?? '');
    const manifest = loadSyncManifest(projectRoot, scopeKey);
    const workspace = await workspaceService.ensureWorkspace(
      extensionName === undefined ? { kind: 'cf' } : { kind: 'cfe', extensionName }
    );
    const operationId = sanitizePathPart(`${extensionName === undefined ? 'cf' : `cfe-${extensionName}`}-${String(this.now())}`);
    // Объект, а не локальная переменная: флаг меняет колбэк, который вызывают стратегии.
    const mirror = { mutated: false };
    const context: SyncOperationContext = {
      projectRoot,
      store,
      exec,
      target,
      hooks,
      workspace,
      workspaceService,
      extensionName,
      manifest,
      operationId,
      archiveThresholdFiles: this.archiveThresholdFiles,
      transferConcurrency: this.transferConcurrency,
      markMirrorMutated: () => { mirror.mutated = true; },
    };

    // Уборка обмена явно на обоих путях, а не в finally: removeExchange не бросает, и исход
    // операции (результат или исходная ошибка) не зависит от неё.
    try {
      const outcome = await run(context);
      if (outcome.baseline) {
        this.saveBaseline(manifest, outcome.baseline.files, outcome.baseline.mirrorState);
      }
      await this.removeExchange(context);
      return outcome.result;
    } catch (error) {
      if (mirror.mutated && manifest.mirrorState !== 'empty') {
        // M уже изменён, а P и B — нет: следующий импорт обязан идти полным путём.
        saveSyncManifest(projectRoot, { ...manifest, mirrorState: 'empty' });
      }
      await this.removeExchange(context);
      throw error;
    }
  }

  /** B и кэш хэшей пишутся вместе: загрузка «по изменениям» и CLI читают одно и то же. */
  private saveBaseline(manifest: SyncManifest, files: Record<string, string>, mirrorState: SyncMirrorState): void {
    saveSyncManifest(this.options.projectRoot, { ...manifest, mirrorState, files });
    saveHashCache(this.options.projectRoot, {
      schemaVersion: 1,
      scopeKey: manifest.scopeKey,
      generatedAt: new Date().toISOString(),
      files,
    });
  }

  /** Служебные файлы обмена убираются всегда; сбой уборки не должен заслонить исход операции. */
  private async removeExchange(context: SyncOperationContext): Promise<void> {
    const base = `${context.workspace.exchangeRoot}/${context.operationId}`;
    for (const rel of [base, `${base}.changes`]) {
      try {
        await context.store.remove(rel, { recursive: true });
      } catch {
        // остаток обмена безвреден: следующая операция использует другое имя
      }
    }
  }
}
