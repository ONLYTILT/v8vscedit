import {
  buildUpdateDbCfgCommand,
  type AgentMessage,
} from '../../domain/agent';
import { buildScopeKey } from '../cache/HashCache';
import { saveMetadataCacheForEntry } from '../cache/MetadataCache';
import { AgentWorkspaceService, buildAgentProjectId } from './AgentWorkspaceService';
import { resolveDefaultAgentBaseDir } from './DesignerAgentProcess';
import type { AgentFileStore } from './files/AgentFileStore';
import type { AgentTransferCancellation } from './files/AgentFileTransfer';
import { createLocalAgentFileStore } from './files/LocalAgentFileStore';
import { AgentSyncEngine } from './sync/AgentSyncEngine';
import type {
  DesignerAgentTransportFactory,
  ResettableDesignerAgentTransportFactory,
} from './AgentTransport';
import {
  AgentInfoBaseSession,
  SYSTEM_TIMERS,
  type AgentCommandExecutor,
  type AgentInfoBaseSessionOptions,
} from './AgentInfoBaseSession';

export interface AgentConfigurationOperationTarget {
  readonly kind: 'cf' | 'cfe';
  readonly name: string;
  readonly rootPath: string;
  readonly extensionName?: string;
}

export interface AgentOperationHooks {
  readonly onMessage?: (message: string) => void;
  readonly onProjectFilesWillChange?: (filePaths: string[]) => void;
  readonly onQuestion?: (message: AgentMessage) => Promise<string | undefined>;
  /** Отмена синхронизации (структурно совместима с `vscode.CancellationToken`). */
  readonly cancellation?: AgentTransferCancellation;
}

export interface AgentOperationResult {
  readonly changedProjectFiles: string[];
  readonly skipped?: boolean;
}

/**
 * Кто работает с файлами агента. Персональный корень пользователя агент назначает при
 * первом SSH-входе (`agentbasedir.json`), поэтому без логина файловые операции невозможны.
 */
export interface AgentOperationFilesOptions {
  readonly userName: string;
  /** `/AgentBaseDir` агента; по умолчанию — служебный каталог агента проекта. */
  readonly agentBaseDir?: string;
}

interface AgentFiles {
  readonly store: AgentFileStore;
  readonly engine: AgentSyncEngine;
}

export interface DesignerAgentInfoBaseSession {
  isInfoBaseConnected(): boolean;
  disconnectInfoBase(hooks?: AgentOperationHooks, options?: { readonly force?: boolean }): Promise<boolean>;
  reconnectInfoBase(hooks?: AgentOperationHooks): Promise<void>;
}

/**
 * Фасад агентских операций над конфигурацией. Жизненный цикл подключения ИБ (ленивый
 * `connect-ib`, удержание между операциями, release, idle) — в {@link AgentInfoBaseSession};
 * здесь только алгоритмы выгрузки/загрузки поверх исполнителя команд сессии.
 */
export class AgentOperationService implements DesignerAgentInfoBaseSession {
  private readonly session: AgentInfoBaseSession;
  private files: AgentFiles | undefined;

  constructor(
    private readonly projectRoot: string,
    transportFactory: DesignerAgentTransportFactory | ResettableDesignerAgentTransportFactory,
    sessionOptions: Partial<AgentInfoBaseSessionOptions> = {},
    private readonly filesOptions?: AgentOperationFilesOptions
  ) {
    this.session = new AgentInfoBaseSession(transportFactory, {
      // По умолчанию база держится до явного release (план: idleDisconnectMinutes = 0).
      idleDisconnectMs: sessionOptions.idleDisconnectMs ?? 0,
      timers: sessionOptions.timers ?? SYSTEM_TIMERS,
      clock: sessionOptions.clock ?? Date.now,
    });
  }

  isInfoBaseConnected(): boolean {
    return this.session.isInfoBaseConnected();
  }

  disconnectInfoBase(hooks?: AgentOperationHooks, options?: { readonly force?: boolean }): Promise<boolean> {
    return this.session.disconnectInfoBase(hooks, options);
  }

  reconnectInfoBase(hooks?: AgentOperationHooks): Promise<void> {
    return this.session.reconnectInfoBase(hooks);
  }

  /** Снимает idle-таймер; SSH-сессии закрывает владелец фабрики транспорта (реестр сервисов). */
  async dispose(): Promise<void> {
    const files = this.files;
    this.files = undefined;
    try {
      await this.session.dispose();
    } finally {
      // Хранилище (в Э6 — SFTP-канал) освобождается и при сбое остановки сессии.
      await files?.store.dispose();
    }
  }

  async importFromDatabase(target: AgentConfigurationOperationTarget, hooks?: AgentOperationHooks): Promise<AgentOperationResult> {
    const filesOptions = this.requireFilesOptions();
    return this.session.run(async (exec) => {
      const { engine } = await this.getFiles(filesOptions);
      const { changedProjectFiles } = await engine.importTarget(target, exec, hooks);
      this.refreshMetadataCache(target);
      return { changedProjectFiles };
    }, hooks);
  }

  async loadFullAndUpdate(target: AgentConfigurationOperationTarget, hooks?: AgentOperationHooks): Promise<AgentOperationResult> {
    const filesOptions = this.requireFilesOptions();
    return this.session.run(async (exec) => {
      const { engine } = await this.getFiles(filesOptions);
      await engine.loadTarget(target, 'full', exec, hooks);
      return this.updateDatabaseConfigurationConnected(target, exec, hooks);
    }, hooks);
  }

  async loadChangedAndUpdate(target: AgentConfigurationOperationTarget, hooks?: AgentOperationHooks): Promise<AgentOperationResult> {
    const filesOptions = this.requireFilesOptions();
    return this.session.run(async (exec) => {
      const { engine } = await this.getFiles(filesOptions);
      const loaded = await engine.loadTarget(target, 'changed', exec, hooks);
      if (loaded.skipped) {
        hooks?.onMessage?.('изменений для загрузки нет');
        return { changedProjectFiles: [], skipped: true };
      }
      await this.updateDatabaseConfigurationConnected(target, exec, hooks);
      return { changedProjectFiles: [] };
    }, hooks);
  }

  async updateDatabaseConfiguration(target: AgentConfigurationOperationTarget, hooks?: AgentOperationHooks): Promise<AgentOperationResult> {
    return this.session.run((exec) => this.updateDatabaseConfigurationConnected(target, exec, hooks), hooks);
  }

  private async updateDatabaseConfigurationConnected(
    target: AgentConfigurationOperationTarget,
    exec: AgentCommandExecutor,
    hooks?: AgentOperationHooks
  ): Promise<AgentOperationResult> {
    hooks?.onMessage?.('Обновление конфигурации базы данных.');
    await exec.execute(
      buildUpdateDbCfgCommand({ extensionName: target.kind === 'cfe' ? target.extensionName ?? target.name : undefined })
    );
    return { changedProjectFiles: [] };
  }

  /** Кэш метаданных дерева строится по новому P; B и кэш хэшей уже сохранил движок. */
  private refreshMetadataCache(target: AgentConfigurationOperationTarget): void {
    const extensionName = target.kind === 'cfe' ? target.extensionName ?? target.name : '';
    const scopeKey = buildScopeKey(target.kind, target.rootPath, extensionName);
    saveMetadataCacheForEntry(this.projectRoot, scopeKey, { kind: target.kind, rootPath: target.rootPath });
  }

  /** Проверка до подключения ИБ: без пользователя файловую операцию незачем и начинать. */
  private requireFilesOptions(): AgentOperationFilesOptions {
    if (!this.filesOptions) {
      throw new Error(
        'Не задан пользователь агента конфигуратора: операции с файлами рабочей области агента недоступны.'
      );
    }
    return this.filesOptions;
  }

  /**
   * Хранилище создаётся лениво, внутри операции — уже ПОСЛЕ `connect-ib`: персональный корень
   * агент назначает при первом SSH-входе пользователя, до него индекса может не быть.
   * Неудачная попытка не кэшируется — следующая операция перечитает индекс.
   */
  private async getFiles(options: AgentOperationFilesOptions): Promise<AgentFiles> {
    if (!this.files) {
      const store = await createLocalAgentFileStore(
        options.agentBaseDir ?? resolveDefaultAgentBaseDir(this.projectRoot),
        options.userName
      );
      const workspace = new AgentWorkspaceService(store, buildAgentProjectId(this.projectRoot));
      this.files = { store, engine: new AgentSyncEngine({ projectRoot: this.projectRoot, store, workspace }) };
    }
    return this.files;
  }
}
