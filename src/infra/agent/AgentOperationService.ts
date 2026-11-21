import {
  buildUpdateDbCfgCommand,
  hasExtension,
  type AgentExtensionInfo,
  type AgentMessage,
} from '../../domain/agent';
import type { CfeBatchReport } from '../cfFile/CfeBatchReport';
import { buildScopeKey } from '../cache/HashCache';
import { saveMetadataCacheForEntry } from '../cache/MetadataCache';
import { AgentWorkspaceService, buildAgentProjectId } from './AgentWorkspaceService';
import { resolveDefaultAgentBaseDir } from './DesignerAgentProcess';
import type { AgentFileStore } from './files/AgentFileStore';
import type { AgentTransferCancellation } from './files/AgentFileTransfer';
import { createLocalAgentFileStore } from './files/LocalAgentFileStore';
import { connectSftpAgentFileStore } from './files/SftpAgentFileStore';
import type { DesignerAgentConnectionOptions } from './ProcessDesignerAgentTransport';
import {
  dumpCfFileViaAgent,
  loadCfFileViaAgent,
  type AgentCfFileContext,
  type AgentCfFileDumpRequest,
  type AgentCfFileDumpResult,
  type AgentCfFileLoadRequest,
  type AgentCfFileLoadResult,
} from './extensions/AgentCfFileExchange';
import { dumpAllExtensionsViaAgent, loadAllExtensionsViaAgent, type AgentCfeDumpAllRequest, type AgentCfeLoadAllRequest } from './extensions/AgentCfeBatch';
import { listDatabaseExtensions, requireExtensionInDatabase, verifyAppliedExtension } from './extensions/AgentExtensionList';
import { AgentSyncEngine } from './sync/AgentSyncEngine';
import type { MirrorSeedCandidate } from './sync/MirrorSeed';
import type { AgentProgressEvent } from './sync/SyncProgress';
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
  /**
   * Этап и счётчик для живого UI (уведомление). Тот же текст, что в `onMessage`, но чаще: журнал получает
   * только вехи (`SyncProgress`). Сообщения вне `SyncProgress` идут только в `onMessage`.
   */
  readonly onProgress?: (event: AgentProgressEvent) => void;
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
  /**
   * Основная конфигурация цели изменена загрузкой (не skipped), `update-db-cfg` ещё не отправлен. Вызывается
   * ДО обновления БД сознательно: обрыв или ошибка на реструктуризации оставляют признак «БД отстаёт»
   * выставленным, и раннеру UI не нужно угадывать, на каком шаге оборвалась операция.
   */
  readonly onConfigurationLoaded?: () => void;
  /**
   * Команда загрузки из файлов (`load-config-from-files`) сейчас уйдёт агенту — вызывается движком прямо перед
   * ней, после подготовки зеркала и передачи файлов. Сбой ПОСЛЕ этой точки раннер трактует консервативно
   * (основная конфигурация могла измениться: атомарность частичной загрузки не замерена), сбой ДО неё
   * (подключение, guard наличия расширения, обрыв SFTP при передаче) признак отставания не трогает.
   */
  readonly onConfigurationLoadStarting?: () => void;
}

/** Режим загрузки изменений: с обновлением конфигурации БД или только в основную конфигурацию. */
export interface AgentLoadOptions {
  readonly updateDatabase: boolean;
  /**
   * Изменений нет, но цель отмечена отстающей: при `updateDatabase` выполнить одно `update-db-cfg`,
   * иначе «Обновить в базе» молча закончилась бы «изменений нет», а отставание осталось бы.
   */
  readonly updateWhenUnchanged?: boolean;
}

/** Журнал загрузки без обновления: пользователь видит, что реструктуризации не было намеренно. */
export const AGENT_LOAD_WITHOUT_UPDATE_MESSAGE = 'Конфигурация БД не обновлялась (загрузка без обновления).';

export interface AgentOperationResult {
  readonly changedProjectFiles: string[];
  readonly skipped?: boolean;
  /** Предупреждения сверки после применения расширения (E11: имя в базе взято из файла). Нет — поля нет. */
  readonly warnings?: readonly string[];
  /** Выполнено ли `update-db-cfg` (только у `loadChanged`). */
  readonly databaseUpdated?: boolean;
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

/** Имя расширения цели: без явного `extensionName` — имя цели (узел дерева расширения). */
function extensionNameOf(target: AgentConfigurationOperationTarget): string {
  return target.extensionName ?? target.name;
}

/**
 * Фасад агентских операций над конфигурацией. Жизненный цикл подключения ИБ (ленивый
 * `connect-ib`, удержание между операциями, release, idle) — в {@link AgentInfoBaseSession};
 * здесь только алгоритмы выгрузки/загрузки поверх исполнителя команд сессии.
 */

export class AgentOperationService implements DesignerAgentInfoBaseSession {
  private readonly session: AgentInfoBaseSession;
  private readonly clock: () => number;
  private files: AgentFiles | undefined;

  constructor(
    private readonly projectRoot: string,
    transportFactory: DesignerAgentTransportFactory | ResettableDesignerAgentTransportFactory,
    sessionOptions: Partial<AgentInfoBaseSessionOptions> = {},
    private readonly filesOptions?: AgentOperationFilesOptions,
    private readonly syncOptions: AgentOperationSyncOptions = {}
  ) {
    this.clock = sessionOptions.clock ?? Date.now;
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
      await this.guardExtensionBeforeFileLoad(target, exec, true);
      await engine.loadTarget(target, 'full', exec, hooks);
      hooks?.onConfigurationLoaded?.();
      return this.updateDatabaseConfigurationConnected(target, exec, hooks);
    }, hooks);
  }

  /**
   * Загрузка изменённых файлов в основную конфигурацию; `update-db-cfg` — только при `options.updateDatabase`.
   * Для cfe наличие расширения проверяется ДО загрузки в обоих режимах (ФАКТ Э32): загрузка из файлов в
   * отсутствующее имя отвечает успехом и оставляет неприменённую заглушку.
   */
  async loadChanged(
    target: AgentConfigurationOperationTarget,
    options: AgentLoadOptions,
    hooks?: AgentOperationHooks
  ): Promise<AgentOperationResult> {
    const filesOptions = this.requireFilesOptions();
    return this.session.run(async (exec) => {
      const { engine } = await this.getFiles(filesOptions);
      await this.guardExtensionBeforeFileLoad(target, exec, options.updateDatabase);
      const loaded = await engine.loadTarget(target, 'changed', exec, hooks);
      if (loaded.skipped) {
        hooks?.onMessage?.('изменений для загрузки нет');
        if (options.updateDatabase && options.updateWhenUnchanged === true) {
          const updated = await this.updateDatabaseConfigurationConnected(target, exec, hooks);
          return { ...updated, databaseUpdated: true };
        }
        return { changedProjectFiles: [], skipped: true };
      }
      hooks?.onConfigurationLoaded?.();
      if (!options.updateDatabase) {
        hooks?.onMessage?.(AGENT_LOAD_WITHOUT_UPDATE_MESSAGE);
        return { changedProjectFiles: [], databaseUpdated: false };
      }
      // Предупреждения сверки (E11) не теряются: их показывает UI и отдаёт MCP.
      const updated = await this.updateDatabaseConfigurationConnected(target, exec, hooks);
      return { ...updated, databaseUpdated: true };
    }, hooks);
  }

  /**
   * Guard Э32 до загрузки из файлов. Текст отказа зависит от режима: без обновления E6 иначе не прозвучал бы
   * вовсе, а «применять нечего» вводило бы в заблуждение — применять никто и не собирался.
   */
  private async guardExtensionBeforeFileLoad(
    target: AgentConfigurationOperationTarget,
    exec: AgentCommandExecutor,
    updateDatabase: boolean
  ): Promise<void> {
    if (target.kind !== 'cfe') {
      return;
    }
    const extensionName = extensionNameOf(target);
    if (updateDatabase) {
      await requireExtensionInDatabase(exec, extensionName);
      return;
    }
    if (!hasExtension(await listDatabaseExtensions(exec), extensionName)) {
      throw new Error(
        `Расширения "${extensionName}" нет в базе. Загрузка без обновления конфигурации БД оставила бы ` +
        'неприменённую заглушку — выполните «Обновить в базе».'
      );
    }
  }

  async updateDatabaseConfiguration(target: AgentConfigurationOperationTarget, hooks?: AgentOperationHooks): Promise<AgentOperationResult> {
    return this.session.run((exec) => this.updateDatabaseConfigurationConnected(target, exec, hooks), hooks);
  }

  /** Список расширений базы (`properties get --all-extensions`); файлы агента не нужны. */
  listDatabaseExtensions(hooks?: AgentOperationHooks): Promise<AgentExtensionInfo[]> {
    return this.session.run((exec) => listDatabaseExtensions(exec), hooks);
  }

  dumpCfFile(request: AgentCfFileDumpRequest, hooks?: AgentOperationHooks): Promise<AgentCfFileDumpResult> {
    return this.runWithFiles((ctx) => dumpCfFileViaAgent(ctx, request), hooks);
  }

  loadCfFile(request: AgentCfFileLoadRequest, hooks?: AgentOperationHooks): Promise<AgentCfFileLoadResult> {
    return this.runWithFiles((ctx) => loadCfFileViaAgent(ctx, request), hooks);
  }

  dumpAllExtensionsToCfe(request: AgentCfeDumpAllRequest, hooks?: AgentOperationHooks): Promise<CfeBatchReport> {
    return this.runWithFiles((ctx) => dumpAllExtensionsViaAgent(ctx, request), hooks);
  }

  loadAllExtensionsFromCfe(request: AgentCfeLoadAllRequest, hooks?: AgentOperationHooks): Promise<CfeBatchReport> {
    return this.runWithFiles((ctx) => loadAllExtensionsViaAgent(ctx, request), hooks);
  }

  private runWithFiles<T>(operation: (ctx: AgentCfFileContext) => Promise<T>, hooks?: AgentOperationHooks): Promise<T> {
    const filesOptions = this.requireFilesOptions();
    return this.session.run(async (exec) => {
      const { store } = await this.getFiles(filesOptions);
      return operation({ exec, store, projectId: buildAgentProjectId(this.projectRoot), hooks, now: this.clock });
    }, hooks);
  }

  /**
   * Для cfe — guard Э28: агент на `update-db-cfg` отсутствующего расширения отвечает успехом молча, поэтому
   * наличие проверяется заранее (E6). После применения — сверка списком (`verifyAppliedExtension`): имя из файла
   * (ФАКТ Э29, П4) — предупреждение E11 (цель проекта `cfe/<имя>` могла перестать существовать); заглушка или
   * отсутствие имени — ошибка E12, как у загрузки нового расширения.
   */
  private async updateDatabaseConfigurationConnected(
    target: AgentConfigurationOperationTarget,
    exec: AgentCommandExecutor,
    hooks?: AgentOperationHooks
  ): Promise<AgentOperationResult> {
    const extensionName = target.kind === 'cfe' ? extensionNameOf(target) : undefined;
    const before = extensionName === undefined ? undefined : await requireExtensionInDatabase(exec, extensionName);
    hooks?.onMessage?.('Обновление конфигурации базы данных.');
    await exec.execute(buildUpdateDbCfgCommand({ extensionName }));
    if (extensionName === undefined || before === undefined) {
      return { changedProjectFiles: [] };
    }
    const { warnings } = await verifyAppliedExtension(exec, before, extensionName, 'apply');
    if (warnings.length === 0) {
      return { changedProjectFiles: [] };
    }
    for (const warning of warnings) {
      hooks?.onMessage?.(warning);
    }
    return { changedProjectFiles: [], warnings };
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
   *
   * Потерянное хранилище (сервер сбросил SFTP-соединение, в том числе во время прошлой операции) заменяется
   * вместе с движком в начале СЛЕДУЮЩЕЙ операции; внутри операции, где соединение упало, повтора нет — она
   * завершается ошибкой. Закрытие старого только рвёт SSH-соединение и не бросает: файлы обмена на сервере
   * остаются, их убирают сами операции.
   */
  private async getFiles(options: AgentOperationFilesOptions): Promise<AgentFiles> {
    if (this.files?.store.isUsable?.() === false) {
      const lost = this.files;
      this.files = undefined;
      await lost.store.dispose();
    }
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
