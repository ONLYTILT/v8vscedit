import type { AgentCommandExecutor } from '../AgentInfoBaseSession';
import type { AgentConfigurationOperationTarget, AgentOperationHooks } from '../AgentOperationService';
import type { AgentWorkspacePaths, AgentWorkspaceService } from '../AgentWorkspaceService';
import type { AgentFileStore } from '../files/AgentFileStore';
import type { SyncManifest } from './SyncManifest';

/** Операция синхронизации прервана по запросу пользователя. */
export class AgentSyncCancelledError extends Error {
  constructor() {
    super('Операция агента конфигуратора отменена.');
    this.name = 'AgentSyncCancelledError';
  }
}

/** Общие для одной операции импорта или загрузки данные, которые передаются стратегиям. */
export interface SyncOperationContext {
  readonly store: AgentFileStore;
  readonly exec: AgentCommandExecutor;
  readonly target: AgentConfigurationOperationTarget;
  readonly hooks: AgentOperationHooks | undefined;
  readonly workspace: AgentWorkspacePaths;
  readonly workspaceService: AgentWorkspaceService;
  /** Имя расширения для `--extension` (у основной конфигурации — `undefined`). */
  readonly extensionName: string | undefined;
  readonly manifest: SyncManifest;
  /** Сегмент имён этой операции: `exchange/<operationId>`, `lists/<operationId>.txt`. */
  readonly operationId: string;
  readonly archiveThresholdFiles: number;
  readonly transferConcurrency: number;
  /**
   * Ставится ПЕРЕД командой или записью, меняющей M: при сбое после неё M уже не соответствует
   * B, и следующий импорт обязан идти полным путём (`mirrorState: 'empty'`).
   */
  markMirrorMutated(): void;
}

export function throwIfCancelled(context: Pick<SyncOperationContext, 'hooks'>): void {
  if (context.hooks?.cancellation?.isCancellationRequested) {
    throw new AgentSyncCancelledError();
  }
}

/** `exchange/<operationId>` — каталог обмена архивом (агент разрешает имя архива относительно `--dir`). */
export function exchangeDirOf(context: SyncOperationContext): string {
  return `${context.workspace.exchangeRoot}/${context.operationId}`;
}

/** Имя архива внутри каталога обмена. */
export const EXCHANGE_ARCHIVE = 'full.zip';
