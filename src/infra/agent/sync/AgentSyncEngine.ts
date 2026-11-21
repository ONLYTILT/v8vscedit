import * as path from 'path';
import type { AgentCommandExecutor } from '../AgentInfoBaseSession';
import type { AgentConfigurationOperationTarget, AgentOperationHooks } from '../AgentOperationService';
import { sanitizePathPart, type AgentWorkspaceService } from '../AgentWorkspaceService';
import type { AgentFileStore } from '../files/AgentFileStore';
import { DEFAULT_AGENT_TRANSFER_CONCURRENCY } from '../files/AgentFileTransfer';
import { buildScopeKey, saveHashCache } from '../../cache/HashCache';
import type { HashScanOptions } from '../../cache/HashScanner';
import { freeDiskSpaceOf } from '../../fs/FreeDiskSpace';
import { runImport, type AgentImportResult } from './AgentImportFlow';
import { runLoad, type AgentLoadMode, type AgentLoadResult } from './AgentLoadFlow';
import { createLocalExchange, pruneStaleLocalExchanges } from './LocalExchange';
import { fingerprintProjectDumpInfo } from './ProjectDumpInfo';
import { AgentSyncCancelledError, EXCHANGE_SIDE_SUFFIXES, throwIfCancelled, type SyncOperationContext } from './SyncContext';
import { createSyncProgress } from './SyncProgress';
import {
  buildSyncBaselineAfterImport,
  loadSyncManifest,
  mirrorCoverageOf,
  saveSyncManifest,
  type ProjectDumpInfoFingerprint,
  type SyncBaselineFullReason,
  type SyncBaselineResult,
  type SyncManifest,
  type SyncMirrorCoverage,
  type SyncMirrorState,
} from './SyncManifest';

export { AgentSyncCancelledError };
export type { AgentImportResult } from './AgentImportFlow';
export type { AgentLoadMode, AgentLoadResult } from './AgentLoadFlow';

/**
 * Порог архива по умолчанию: больше изменённых файлов — полная выгрузка/загрузка архивом вместо дельты.
 * Читают его только удалённые ветки. 20000 ≈ 20% БП КОРП: дельта ≈ 20 мс/файл по SFTP (окно 16 при
 * 80 мс), т.е. ~7 мин, а архив большой конфигурации — десятки минут серверной выгрузки; точка
 * безубыточности ≈ 60–100 тыс. файлов, порог взят с запасом (plan-archive-avoid.md §2).
 */
export const DEFAULT_ARCHIVE_THRESHOLD_FILES = 20_000;

/**
 * Порог «большого» файла дельты и сравнения, байт: с него файл идёт потоком через staging на диске, а не
 * буфером в памяти. Пул из 16 малых файлов держит в худшем случае 16 × 16 МиБ = 256 МиБ; файл версий большой
 * конфигурации (~33 МБ) уже уходит в большую полосу.
 */
export const DEFAULT_LARGE_FILE_THRESHOLD_BYTES = 16 * 1024 * 1024;

/** С этого размера файл называется в журнале заранее: скачивание займёт заметное время. */
export const DEFAULT_LARGE_FILE_WARN_BYTES = 100 * 1024 * 1024;

export interface AgentSyncEngineOptions {
  readonly projectRoot: string;
  readonly store: AgentFileStore;
  readonly workspace: AgentWorkspaceService;
  readonly archiveThresholdFiles?: number;
  readonly transferConcurrency?: number;
  /** Источник уникальной части имени операции (по умолчанию — `Date.now`). */
  readonly now?: () => number;
  /**
   * Локальный каталог обмена потокового архива (по умолчанию `<projectRoot>/.v8vscedit/agent-exchange`:
   * тот же диск, что у P, и `.zip` не попадает под watcher `src/**\/*.xml`).
   */
  readonly localExchangeRoot?: string;
  /**
   * Часы троттлинга прогресса (по умолчанию `Date.now`). Не `now`: тот — источник имени операции, и
   * тестовый стенд тикает его на каждый вызов, а прогресс тестам нужен с постоянными часами.
   */
  readonly progressClock?: () => number;
  /** Порог большого файла (по умолчанию {@link DEFAULT_LARGE_FILE_THRESHOLD_BYTES}). */
  readonly largeFileThresholdBytes?: number;
  /** Порог предупреждения о большом файле (по умолчанию {@link DEFAULT_LARGE_FILE_WARN_BYTES}). */
  readonly largeFileWarnBytes?: number;
  /** Свободное место тома каталога (по умолчанию — `fs.statfs`); подменяется в тестах. */
  readonly freeDiskSpace?: (dir: string) => Promise<number | undefined>;
  /** Шов ФС/часов быстрой проверки P: передаётся всем снимкам P операции и построению B (тесты считают обращения). */
  readonly hashScan?: Omit<HashScanOptions, 'onReport' | 'signal'>;
  /** Часы времени построения B в журнале (по умолчанию `Date.now`). */
  readonly baselineClock?: () => number;
}

const FULL_BASELINE_REASON_TEXT: Record<SyncBaselineFullReason, string> = {
  compare: 'полное сравнение с локальным зеркалом',
  archive: 'импорт архивом',
  'no-project-snapshot': 'нет снимка проекта операции',
  'case-mismatch': 'пути, отличающиеся только регистром',
  'foreign-path': 'файл вне каталога выгрузки',
};

/** Итог построения B одной строкой журнала: режим, объём и время (plan-fast-baseline.md §2.3). */
function describeBaseline({ mode, elapsedMs }: SyncBaselineResult): string {
  const elapsed = `${String(elapsedMs)} мс`;
  if (mode.kind === 'incremental') {
    return `Базовая линия синхронизации: по изменённым файлам — перехешировано ${String(mode.rehashed)}, ` +
      `удалено ${String(mode.removed)}, ${elapsed}`;
  }
  const { files, hashed, racy } = mode.report;
  return `Базовая линия синхронизации: полный проход (${FULL_BASELINE_REASON_TEXT[mode.reason]}) — файлов ${String(files)}, ` +
    `перехешировано ${String(hashed)} (racy ${String(racy)}), ${elapsed}`;
}

type OperationKind = 'import' | 'load';

const INTERRUPTED_TEXT: Record<OperationKind, string> = {
  import: 'Импорт прерван',
  load: 'Загрузка прервана',
};

interface OperationBaseline {
  files: Record<string, string>;
  mirrorState: SyncMirrorState;
  mirrorCoverage: SyncMirrorCoverage;
  /**
   * Отпечаток файла версий проекта (`current: undefined` — файла нет, поле убирается). Нет поля
   * (загрузка) — в манифесте остаётся прежнее: загрузка P не меняет, а перезапись скрыла бы его замену.
   */
  projectDumpInfo?: { readonly current: ProjectDumpInfoFingerprint | undefined };
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

  /**
   * БД → P. После успеха P ≡ M по отслеживаемым файлам, M — `fresh`, B = hash(P) по снимку операции:
   * правки P во время операции в файлах, которые импорт не трогал, в B не поглощаются.
   */
  importTarget(
    target: AgentConfigurationOperationTarget,
    exec: AgentCommandExecutor,
    hooks?: AgentOperationHooks
  ): Promise<AgentImportResult> {
    return this.runOperation('import', target, exec, hooks, async (context) => {
      const { result, mirrorCoverage, projectSnapshot } = await runImport(context);
      context.progress.step('Сохранение базовой линии синхронизации…');
      const baseline = await buildSyncBaselineAfterImport({
        configDir: target.rootPath,
        projectRoot: this.options.projectRoot,
        projectSnapshot,
        fullReason: result.strategy === 'delta' ? undefined : result.strategy,
        changedFiles: result.changedProjectFiles,
        scan: this.options.hashScan,
        clock: this.options.baselineClock,
      });
      context.progress.step(describeBaseline(baseline));
      return {
        result,
        baseline: {
          files: baseline.files,
          mirrorState: 'fresh',
          mirrorCoverage,
          projectDumpInfo: { current: await fingerprintProjectDumpInfo(target.rootPath, context.manifest.projectDumpInfo) },
        },
      };
    });
  }

  /** P → БД. B обновляется только после успешной загрузки; пропуск B не трогает. */
  loadTarget(
    target: AgentConfigurationOperationTarget,
    mode: AgentLoadMode,
    exec: AgentCommandExecutor,
    hooks?: AgentOperationHooks
  ): Promise<AgentLoadResult> {
    return this.runOperation('load', target, exec, hooks, async (context) => {
      const outcome = await runLoad(context, mode);
      return outcome.result.skipped
        ? { result: outcome.result }
        : {
          result: outcome.result,
          baseline: { files: outcome.files, mirrorState: outcome.mirrorState, mirrorCoverage: outcome.mirrorCoverage },
        };
    });
  }

  private async runOperation<T>(
    kind: OperationKind,
    target: AgentConfigurationOperationTarget,
    exec: AgentCommandExecutor,
    hooks: AgentOperationHooks | undefined,
    run: (context: SyncOperationContext) => Promise<{
      result: T;
      /** Новая B и состояние M; без неё (пропуск загрузки) манифест не трогается. */
      baseline?: OperationBaseline;
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
    const operationPrefix = sanitizePathPart(`${extensionName === undefined ? 'cf' : `cfe-${extensionName}`}-`);
    const operationId = sanitizePathPart(`${operationPrefix}${String(this.now())}`);
    const exchangeRoot = this.options.localExchangeRoot ?? path.join(projectRoot, '.v8vscedit', 'agent-exchange');
    // Остатки упавших (убитых) операций той же цели: на штатных путях каталог убирает dispose.
    await pruneStaleLocalExchanges(exchangeRoot, operationPrefix, operationId);
    const localExchange = createLocalExchange(exchangeRoot, operationId);
    // Объект, а не локальная переменная: флаг меняет колбэк, который вызывают стратегии.
    const mirror = { mutated: false };
    const context: SyncOperationContext = {
      projectRoot,
      store,
      exec,
      target,
      hooks,
      progress: createSyncProgress(hooks, this.options.progressClock ?? Date.now),
      workspace,
      workspaceService,
      extensionName,
      manifest,
      operationId,
      archiveThresholdFiles: this.archiveThresholdFiles,
      transferConcurrency: this.transferConcurrency,
      largeFileThresholdBytes: this.options.largeFileThresholdBytes ?? DEFAULT_LARGE_FILE_THRESHOLD_BYTES,
      largeFileWarnBytes: this.options.largeFileWarnBytes ?? DEFAULT_LARGE_FILE_WARN_BYTES,
      freeDiskSpace: this.options.freeDiskSpace ?? freeDiskSpaceOf,
      localExchange,
      // Локальный M всегда полный: импорт сравнивает его с P целиком, посева там нет.
      mirror: { coverage: store.kind === 'local' ? 'full' : mirrorCoverageOf(manifest) },
      markMirrorMutated: () => { mirror.mutated = true; },
      hashScan: this.options.hashScan,
    };

    // Уборка обмена явно на обоих путях, а не в finally: removeExchange не бросает, и исход
    // операции (результат или исходная ошибка) не зависит от неё.
    try {
      const outcome = await run(context);
      if (outcome.baseline) {
        this.saveBaseline(manifest, outcome.baseline);
      }
      await this.removeExchange(context);
      return outcome.result;
    } catch (error) {
      if (mirror.mutated && error instanceof AgentSyncCancelledError) {
        // Отмена после мутации M стоит дорого (переподготовка зеркала): пользователь должен знать почему.
        context.progress.step(
          `${INTERRUPTED_TEXT[kind]} после изменения зеркала агента: следующий импорт заново подготовит зеркало ` +
          '(посев из выгрузки проекта или полная выгрузка).'
        );
      }
      if (mirror.mutated) {
        // M уже изменён, а P и B — нет: следующий импорт обязан идти полным путём. Полнота — текущая,
        // а не из старого манифеста: начатый посев делает M разреженным, и прежнее `full` позволило бы
        // следующим операциям удалять из P файлы по их отсутствию в M. Пишется и при уже `empty`:
        // иначе полнота так и осталась бы прежней.
        saveSyncManifest(projectRoot, { ...manifest, mirrorState: 'empty', mirrorCoverage: context.mirror.coverage });
      }
      await this.removeExchange(context);
      throw error;
    }
  }

  /** B и кэш хэшей пишутся вместе: загрузка «по изменениям» и CLI читают одно и то же. */
  private saveBaseline(manifest: SyncManifest, { files, mirrorState, mirrorCoverage, projectDumpInfo }: OperationBaseline): void {
    const { projectDumpInfo: previous, ...rest } = manifest;
    const fingerprint = projectDumpInfo === undefined ? previous : projectDumpInfo.current;
    saveSyncManifest(this.options.projectRoot, {
      ...rest,
      mirrorState,
      files,
      mirrorCoverage,
      ...(fingerprint === undefined ? {} : { projectDumpInfo: fingerprint }),
    });
    saveHashCache(this.options.projectRoot, {
      schemaVersion: 1,
      scopeKey: manifest.scopeKey,
      generatedAt: new Date().toISOString(),
      files,
    });
  }

  /** Служебные файлы обмена (серверные и локальные) убираются всегда; сбой уборки не должен заслонить исход. */
  private async removeExchange(context: SyncOperationContext): Promise<void> {
    await context.localExchange.dispose();
    const base = `${context.workspace.exchangeRoot}/${context.operationId}`;
    for (const rel of [base, ...EXCHANGE_SIDE_SUFFIXES.map((suffix) => `${base}${suffix}`)]) {
      try {
        await context.store.remove(rel, { recursive: true });
      } catch {
        // остаток обмена безвреден: следующая операция использует другое имя
      }
    }
  }
}
