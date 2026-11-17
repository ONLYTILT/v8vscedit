import * as fs from 'fs';
import * as path from 'path';
import {
  buildDumpConfigToFilesCommand,
  buildLoadConfigFromFilesCommand,
  buildUpdateDbCfgCommand,
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
import { AgentWorkspaceService } from './AgentWorkspaceService';
import { collectConfigFilesForLoad, detectPotentialRename } from './ConfigLoadFileCollector';
import {
  collectSnapshotProjectFiles,
  mirrorDirectorySnapshot,
  syncSelectedSnapshotFiles,
} from './DirectorySnapshot';
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
  private readonly workspaceService: AgentWorkspaceService;
  private readonly session: AgentInfoBaseSession;

  constructor(
    private readonly projectRoot: string,
    transportFactory: DesignerAgentTransportFactory | ResettableDesignerAgentTransportFactory,
    sessionOptions: Partial<AgentInfoBaseSessionOptions> = {}
  ) {
    this.workspaceService = new AgentWorkspaceService(projectRoot);
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
  dispose(): Promise<void> {
    return this.session.dispose();
  }

  async importFromDatabase(target: AgentConfigurationOperationTarget, hooks?: AgentOperationHooks): Promise<AgentOperationResult> {
    return this.session.run(async (exec) => {
      const workspace = this.workspaceService.ensureWorkspace(buildSessionKey(target), target);
      const command = buildDumpConfigToFilesCommand(workspace.targetAgentDir, {
        extensionName: target.kind === 'cfe' ? target.extensionName ?? target.name : undefined,
        format: 'hierarchical',
        update: fs.existsSync(path.join(workspace.targetDir, 'ConfigDumpInfo.xml')),
        force: true,
      });

      await exec.execute(command);
      const changedProjectFiles = collectSnapshotProjectFiles(workspace.targetDir, target.rootPath);
      hooks?.onProjectFilesWillChange?.(changedProjectFiles);
      // Раньше тут стоял `syncDirectorySnapshot`, который через `rename` переносил
      // workspace в проект и оставлял workspace.targetDir пустым. После этого
      // первая же `load-config-from-files --partial` валилась с пустым UnknownError,
      // потому что в `--dir=workspace/...` не было целостной структуры конфигурации
      // (Configuration.xml, родительских XML для модулей форм и т.п.).
      // Сейчас зеркалим в проект копированием — workspace остаётся полным
      // снимком текущего состояния БД и пригоден для последующих частичных загрузок.
      mirrorDirectorySnapshot(workspace.targetDir, target.rootPath);
      hooks?.onProjectFilesWillChange?.(changedProjectFiles);
      this.refreshCaches(target);
      return { changedProjectFiles };
    }, hooks);
  }

  async loadFullAndUpdate(target: AgentConfigurationOperationTarget, hooks?: AgentOperationHooks): Promise<AgentOperationResult> {
    return this.session.run(async (exec) => {
      await this.loadFull(target, exec, hooks);
      return this.updateDatabaseConfigurationConnected(target, exec, hooks);
    }, hooks);
  }

  async loadChangedAndUpdate(target: AgentConfigurationOperationTarget, hooks?: AgentOperationHooks): Promise<AgentOperationResult> {
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
    const workspace = this.workspaceService.ensureWorkspace(buildSessionKey(target), target);
    hooks?.onMessage?.('Подготовка файлов для полной загрузки.');
    mirrorDirectorySnapshot(target.rootPath, workspace.targetDir);
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

    const workspace = this.workspaceService.ensureWorkspace(buildSessionKey(target), target);
    hooks?.onMessage?.(`Подготовка частичной загрузки: ${String(filesForLoad.length)} файл(ов).`);
    // Конфигуратору на `load-config-from-files --partial` нужен целостный каркас
    // выгрузки в `--dir`: Configuration.xml, родительские XML для модулей форм и т.д.
    // Если workspace пуст (например, проект только что заведён или каталог был очищен),
    // зеркалим проект целиком. Иначе агент валится в пустой UnknownError, не имея
    // контекста для частичной загрузки.
    this.ensureWorkspaceMirrored(target.rootPath, workspace.targetDir);
    syncSelectedSnapshotFiles(target.rootPath, workspace.targetDir, filesForLoad);
    const operationId = `${buildSessionKey(target)}-${String(Date.now())}`;
    const listFile = this.workspaceService.writeListFile(operationId, filesForLoad);
    const agentListFile = this.workspaceService.toAgentPath(listFile);

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

  /**
   * Гарантирует, что в `workspace.targetDir` лежит полный снимок исходников проекта.
   * Используется перед частичной загрузкой: точечный sync только изменённых файлов
   * требует, чтобы остальной каркас выгрузки уже присутствовал в воркспейсе.
   */
  private ensureWorkspaceMirrored(sourceDir: string, workspaceDir: string): void {
    if (!fs.existsSync(workspaceDir)) {
      mirrorDirectorySnapshot(sourceDir, workspaceDir);
      return;
    }
    const entries = fs.readdirSync(workspaceDir);
    if (entries.length === 0) {
      mirrorDirectorySnapshot(sourceDir, workspaceDir);
      return;
    }
    if (!fs.existsSync(path.join(workspaceDir, 'Configuration.xml'))) {
      mirrorDirectorySnapshot(sourceDir, workspaceDir);
    }
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
