import * as fs from 'fs';
import {
  buildDumpConfigToFilesCommand,
  buildLoadConfigFromFilesCommand,
  buildUpdateDbCfgCommand,
  type AgentConfigurationTarget,
  type AgentMessage,
} from '../../domain/agent';
import {
  buildHashSnapshot,
  buildScopeKey,
  collectCurrentHashes,
  diffHashSnapshots,
  loadHashCache,
  patchHashSnapshot,
  saveHashCache,
} from '../cache/HashCache';
import { saveMetadataCacheForEntry } from '../cache/MetadataCache';
import { AgentWorkspaceService, buildAgentProjectId } from './AgentWorkspaceService';
import {
  hasAgentConfigurationDump,
  mirrorAgentToProject,
  mirrorProjectToAgent,
  uploadProjectFiles,
} from './AgentWorkspaceMirror';
import { collectConfigFilesForLoad, detectPotentialRename } from './ConfigLoadFileCollector';
import { resolveDefaultAgentBaseDir } from './DesignerAgentProcess';
import type { AgentFileStore } from './files/AgentFileStore';
import { createLocalAgentFileStore } from './files/LocalAgentFileStore';
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
  readonly workspace: AgentWorkspaceService;
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
      const { store, workspace: workspaceService } = await this.getFiles(filesOptions);
      const workspace = await workspaceService.ensureWorkspace(toWorkspaceTarget(target));
      const command = buildDumpConfigToFilesCommand(workspace.targetAgentDir, {
        extensionName: target.kind === 'cfe' ? target.extensionName ?? target.name : undefined,
        format: 'hierarchical',
        update: (await store.stat(`${workspace.targetAgentDir}/ConfigDumpInfo.xml`)) !== undefined,
        force: true,
      });

      await exec.execute(command);
      // M остаётся полным снимком базы (копирование, а не перенос): частичной загрузке
      // `load-config-from-files --partial` нужен целостный каркас выгрузки в `--dir`.
      const changedProjectFiles = await mirrorAgentToProject(
        store,
        workspace.targetAgentDir,
        target.rootPath,
        hooks?.onProjectFilesWillChange
      );
      this.refreshCaches(target);
      return { changedProjectFiles };
    }, hooks);
  }

  async loadFullAndUpdate(target: AgentConfigurationOperationTarget, hooks?: AgentOperationHooks): Promise<AgentOperationResult> {
    this.requireFilesOptions();
    return this.session.run(async (exec) => {
      await this.loadFull(target, exec, hooks);
      return this.updateDatabaseConfigurationConnected(target, exec, hooks);
    }, hooks);
  }

  async loadChangedAndUpdate(target: AgentConfigurationOperationTarget, hooks?: AgentOperationHooks): Promise<AgentOperationResult> {
    this.requireFilesOptions();
    return this.session.run(async (exec) => {
      const loaded = await this.loadChanged(target, exec, hooks);
      if (loaded.skipped) {
        hooks?.onMessage?.('изменений для загрузки нет');
        return loaded;
      }
      await this.updateDatabaseConfigurationConnected(target, exec, hooks);
      return loaded;
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

  private async loadFull(
    target: AgentConfigurationOperationTarget,
    exec: AgentCommandExecutor,
    hooks?: AgentOperationHooks
  ): Promise<AgentOperationResult> {
    const { store, workspace: workspaceService } = await this.getFiles(this.requireFilesOptions());
    const workspace = await workspaceService.ensureWorkspace(toWorkspaceTarget(target));
    hooks?.onMessage?.('Подготовка файлов для полной загрузки.');
    await mirrorProjectToAgent(store, target.rootPath, workspace.targetAgentDir);
    hooks?.onMessage?.('Полная загрузка конфигурации из файлов.');
    await exec.execute(
      buildLoadConfigFromFilesCommand(workspace.targetAgentDir, {
        extensionName: target.kind === 'cfe' ? target.extensionName ?? target.name : undefined,
        format: 'hierarchical',
        updateConfigDumpInfo: true,
      })
    );
    this.refreshHashCache(target);
    return { changedProjectFiles: [] };
  }

  private async loadChanged(
    target: AgentConfigurationOperationTarget,
    exec: AgentCommandExecutor,
    hooks?: AgentOperationHooks
  ): Promise<AgentOperationResult> {
    if (!fs.existsSync(target.rootPath)) {
      throw new Error(`Каталог исходников не найден: ${target.rootPath}`);
    }

    const extensionName = target.kind === 'cfe' ? target.extensionName ?? target.name : '';
    const commandExtensionName = target.kind === 'cfe' ? extensionName : undefined;
    const scopeKey = buildScopeKey(target.kind, target.rootPath, extensionName);
    const previousSnapshot = loadHashCache(this.projectRoot, scopeKey);
    const currentSnapshot = buildHashSnapshot(scopeKey, target.rootPath);
    const diff = diffHashSnapshots(previousSnapshot, currentSnapshot);
    const changedFiles = [...diff.added, ...diff.modified];

    if (changedFiles.length === 0 && diff.deleted.length === 0) {
      return { changedProjectFiles: [], skipped: true };
    }

    if (Object.keys(previousSnapshot.files).length === 0) {
      hooks?.onMessage?.('Кэш изменений не найден, выполняется полная загрузка.');
      return this.loadFull(target, exec, hooks);
    }

    // Переименование проверяется ДО удаления: оно всегда содержит удалённые файлы, и в
    // обратном порядке ветка переименования была недостижима (сообщение — всегда «удаление»).
    const forceFullLoad = detectPotentialRename(previousSnapshot.files, currentSnapshot.files, diff.added, diff.deleted);
    if (forceFullLoad) {
      hooks?.onMessage?.('Обнаружено переименование объектов, выполняется полная загрузка.');
      return this.loadFull(target, exec, hooks);
    }

    if (diff.deleted.length > 0) {
      hooks?.onMessage?.('Обнаружено удаление файлов, выполняется полная загрузка.');
      return this.loadFull(target, exec, hooks);
    }

    const filesForLoad = collectConfigFilesForLoad(target.rootPath, changedFiles, false);
    if (filesForLoad.length === 0) {
      return { changedProjectFiles: [], skipped: true };
    }

    const { store, workspace: workspaceService } = await this.getFiles(this.requireFilesOptions());
    const workspace = await workspaceService.ensureWorkspace(toWorkspaceTarget(target));
    hooks?.onMessage?.(`Подготовка частичной загрузки: ${String(filesForLoad.length)} файл(ов).`);
    // Конфигуратору на `load-config-from-files --partial` нужен целостный каркас
    // выгрузки в `--dir`: Configuration.xml, родительские XML для модулей форм и т.д.
    // Без каркаса (проект только что заведён, M очищено) зеркалим проект целиком —
    // иначе агент валится в пустой UnknownError, не имея контекста для частичной загрузки.
    if (!(await hasAgentConfigurationDump(store, workspace.targetAgentDir))) {
      await mirrorProjectToAgent(store, target.rootPath, workspace.targetAgentDir);
    }
    await uploadProjectFiles(store, target.rootPath, workspace.targetAgentDir, filesForLoad);
    const operationId = `${buildSessionKey(target)}-${String(Date.now())}`;
    const agentListFile = await workspaceService.writeListFile(operationId, filesForLoad);

    hooks?.onMessage?.('Частичная загрузка изменённых файлов.');
    // ConfigDumpInfo.xml для расширения/конфигурации поддерживается на стороне `loadFull`.
    // На частичной загрузке передавать `--update-config-dump-info` нельзя:
    // конфигуратор перезаписывает файл «срезом» только из переданного списка и при
    // повторных частичных загрузках уходит во внутреннее `UnknownError` с пустым телом.
    await exec.execute(
      buildLoadConfigFromFilesCommand(workspace.targetAgentDir, {
        extensionName: commandExtensionName,
        format: 'hierarchical',
        listFile: agentListFile,
        partial: true,
        noCheck: true,
      })
    );

    const changedHashes = collectCurrentHashes(target.rootPath, changedFiles);
    saveHashCache(this.projectRoot, patchHashSnapshot(previousSnapshot, changedHashes, diff.deleted));
    return { changedProjectFiles: [] };
  }

  private refreshCaches(target: AgentConfigurationOperationTarget): void {
    const extensionName = target.kind === 'cfe' ? target.extensionName ?? target.name : '';
    const scopeKey = buildScopeKey(target.kind, target.rootPath, extensionName);
    saveHashCache(this.projectRoot, buildHashSnapshot(scopeKey, target.rootPath));
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
      this.files = { store, workspace: new AgentWorkspaceService(store, buildAgentProjectId(this.projectRoot)) };
    }
    return this.files;
  }

  private refreshHashCache(target: AgentConfigurationOperationTarget): void {
    const extensionName = target.kind === 'cfe' ? target.extensionName ?? target.name : '';
    const scopeKey = buildScopeKey(target.kind, target.rootPath, extensionName);
    saveHashCache(this.projectRoot, buildHashSnapshot(scopeKey, target.rootPath));
  }
}

function buildSessionKey(target: AgentConfigurationOperationTarget): string {
  return target.kind === 'cf' ? 'cf' : `cfe-${target.extensionName ?? target.name}`;
}

/** Без явного `extensionName` расширение называется по имени цели — как и в командах агента. */
function toWorkspaceTarget(target: AgentConfigurationOperationTarget): AgentConfigurationTarget {
  return target.kind === 'cf' ? { kind: 'cf' } : { kind: 'cfe', extensionName: target.extensionName ?? target.name };
}
