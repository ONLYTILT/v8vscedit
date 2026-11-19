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
import { connectSftpAgentFileStore } from './files/SftpAgentFileStore';
import type { DesignerAgentConnectionOptions } from './ProcessDesignerAgentTransport';
import { AgentSyncEngine } from './sync/AgentSyncEngine';
import type { MirrorSeedCandidate } from './sync/MirrorSeed';
import type { ServerDumpReason } from './sync/SyncPlanner';
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

/** Ответ на вопрос о посеве зеркала: из выгрузки проекта, полной выгрузкой (самопосев из архива) или отмена. */
export type AgentMirrorSeedDecision = 'seed' | 'full' | 'cancel';

/** Почему предлагается посев: зеркало пусто или выгрузку проекта заменили извне (файл версий изменился). */
export type AgentMirrorSeedReason = 'mirror-empty' | 'project-replaced';

export interface AgentMirrorSeedRequest extends MirrorSeedCandidate {
  readonly reason: AgentMirrorSeedReason;
  /** Файлов P, изменённых относительно известной B (`undefined` — B нет): эти правки не будут перезаписаны. */
  readonly localEditsSinceBaseline: number | undefined;
}

/** Ответ на вопрос перед полной серверной выгрузкой (импорт или подготовка зеркала для загрузки). */
export type AgentFullDumpDecision = 'dump' | 'cancel';

export interface AgentFullDumpRequest {
  readonly targetKind: 'cf' | 'cfe';
  readonly targetName: string;
  readonly projectDir: string;
  /** Импорт или загрузка: вопрос и текст отказа у них разные. */
  readonly operation: 'import' | 'load';
  readonly reason: ServerDumpReason;
  /** Текст причины из `SERVER_DUMP_POLICY`. */
  readonly reasonText: string;
  /**
   * Скачивается ли выгрузка целиком (архив). `false` — перезапись зеркала на сервере: выгрузка долгая,
   * но скачиваются только изменённые файлы, и ручная выгрузка проекта не нужна.
   */
  readonly download: boolean;
}

/** Файлы выгрузки проекта, владельцев которых нет в базе (после посева из выгрузки проекта). */
export interface AgentOrphanFilesRequest {
  readonly targetName: string;
  /** Полные имена владельцев `<EnglishKind>.<Name>`. */
  readonly owners: readonly string[];
  readonly files: readonly string[];
}

export interface AgentOperationHooks {
  readonly onMessage?: (message: string) => void;
  readonly onProjectFilesWillChange?: (filePaths: string[]) => void;
  readonly onQuestion?: (message: AgentMessage) => Promise<string | undefined>;
  /** Отмена синхронизации (структурно совместима с `vscode.CancellationToken`). */
  readonly cancellation?: AgentTransferCancellation;
  /**
   * Согласие на посев пустого зеркала агента из выгрузки проекта. Нет хука — `'full'`: без
   * человека скрытое расхождение P и БД (ручные правки после выгрузки) принимать нельзя.
   */
  readonly confirmMirrorSeed?: (request: AgentMirrorSeedRequest) => Promise<AgentMirrorSeedDecision>;
  /**
   * Согласие на полную серверную выгрузку импорта (любая причина архива). Нет хука — `'dump'`: прежнее
   * поведение без человека.
   */
  readonly confirmFullDump?: (request: AgentFullDumpRequest) => Promise<AgentFullDumpDecision>;
  /** Удалить «осиротевшие» файлы выгрузки проекта. Нет хука — не удалять, только сообщение. */
  readonly confirmOrphanRemoval?: (request: AgentOrphanFilesRequest) => Promise<boolean>;
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
  /**
   * Удалённый агент: файлы — по SFTP отдельным SSH-соединением с этими параметрами. Корень SFTP
   * агента уже персональный, поэтому `agentBaseDir` и agentbasedir.json тогда не нужны.
   */
  readonly sftp?: DesignerAgentConnectionOptions;
}

/** Параметры движка синхронизации, задаваемые настройками (умолчания — у {@link AgentSyncEngine}). */
export interface AgentOperationSyncOptions {
  readonly archiveThresholdFiles?: number;
  readonly transferConcurrency?: number;
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
    private readonly filesOptions?: AgentOperationFilesOptions,
    private readonly syncOptions: AgentOperationSyncOptions = {}
  ) {
    this.session = new AgentInfoBaseSession(transportFactory, {
      // По умолчанию база держится до явного release (план: idleDisconnectMinutes = 0).
      idleDisconnectMs: sessionOptions.idleDisconnectMs ?? 0,
      timers: sessionOptions.timers ?? SYSTEM_TIMERS,
      clock: sessionOptions.clock ?? Date.now,
      ...(sessionOptions.infoBaseLockRetry ? { infoBaseLockRetry: sessionOptions.infoBaseLockRetry } : {}),
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

  /**
   * Снимает idle-таймер и закрывает хранилище (у удалённого агента — его SFTP-соединение);
   * shell-сессии закрывает владелец фабрики транспорта (реестр сервисов).
   */
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
      const store = await this.openStore(options);
      const workspace = new AgentWorkspaceService(store, buildAgentProjectId(this.projectRoot));
      const engine = new AgentSyncEngine({
        projectRoot: this.projectRoot,
        store,
        workspace,
        archiveThresholdFiles: this.syncOptions.archiveThresholdFiles,
        transferConcurrency: this.syncOptions.transferConcurrency,
      });
      this.files = { store, engine };
    }
    return this.files;
  }

  private openStore(options: AgentOperationFilesOptions): Promise<AgentFileStore> {
    if (options.sftp) {
      return connectSftpAgentFileStore(options.sftp);
    }
    return createLocalAgentFileStore(
      options.agentBaseDir ?? resolveDefaultAgentBaseDir(this.projectRoot),
      options.userName
    );
  }
}
