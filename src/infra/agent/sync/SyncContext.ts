import type { AgentCommandExecutor } from '../AgentInfoBaseSession';
import type { AgentConfigurationOperationTarget, AgentOperationHooks } from '../AgentOperationService';
import type { AgentWorkspacePaths, AgentWorkspaceService } from '../AgentWorkspaceService';
import type { AgentFileStore } from '../files/AgentFileStore';
import { AgentTransferCancelledError } from '../files/AgentFileTransfer';
import type { LocalExchange } from './LocalExchange';
import type { SyncManifest, SyncMirrorCoverage } from './SyncManifest';

/** Операция синхронизации прервана по запросу пользователя. */
export class AgentSyncCancelledError extends Error {
  constructor() {
    super('Операция агента конфигуратора отменена.');
    this.name = 'AgentSyncCancelledError';
  }
}

/** Где задан вопрос о полной серверной выгрузке: от этого зависит, что сказать при отказе. */
export type FullDumpConsentContext = 'import' | 'import-after-seed' | 'load';

/**
 * Тексты отказа. Текст `import` дословно прежний — на него опирается документация («Типовые ошибки»).
 * После посева инструкция ручной выгрузки неуместна (выгрузка проекта уже взята за основу), а на загрузке
 * — тем более: нужна не выгрузка, а подготовка зеркала.
 */
const FULL_DUMP_DECLINED_TEXT: Record<FullDumpConsentContext, (reasonText: string) => string> = {
  import: () =>
    'Полная выгрузка на сервере отменена. Выгрузите конфигурацию в файлы вручную (иерархический формат) и ' +
    'замените содержимое каталога выгрузки проекта целиком, включая ConfigDumpInfo.xml; следующий импорт ' +
    'предложит взять её за основу.',
  'import-after-seed': (reasonText) =>
    'Полная выгрузка на сервере отменена; проект не изменён. Зеркало агента уже подготовлено из выгрузки ' +
    `проекта, но изменения базы после неё нельзя получить без полной выгрузки (${reasonText}). Повторите импорт ` +
    'и выберите «Полная выгрузка на сервере»; если выгрузка проекта устарела — выгрузите конфигурацию вручную заново.',
  load: () =>
    'Загрузка отменена; база и проект не изменены. Частичной загрузке нужно зеркало агента: повторите и ' +
    'согласитесь на выгрузку на сервере либо выполните полную загрузку (весь проект архивом).',
};

/**
 * Пользователь отказался от полной серверной выгрузки (вопрос `confirmFullDump`). Подкласс отмены:
 * общий путь отмены (без тоста ошибки) годится, а UI показывает инструкцию из текста.
 */
export class AgentFullDumpDeclinedError extends AgentSyncCancelledError {
  constructor(readonly consent: FullDumpConsentContext = 'import', reasonText = '') {
    super();
    this.message = FULL_DUMP_DECLINED_TEXT[consent](reasonText);
    this.name = 'AgentFullDumpDeclinedError';
  }
}

/** Общие для одной операции импорта или загрузки данные, которые передаются стратегиям. */
export interface SyncOperationContext {
  /** Корень проекта — для stat-мемо быстрой проверки при построении манифеста B. */
  readonly projectRoot: string;
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
  /** Локальный каталог обмена операции (архив выгрузки на этой машине); убирает движок. */
  readonly localExchange: LocalExchange;
  /** Полнота M; меняют стратегии (посев — `sparse`, полная выгрузка в M — `full`). */
  readonly mirror: { coverage: SyncMirrorCoverage };
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

/**
 * Отмена потоковой передачи или распаковки (слой `files/`, свой класс ошибки) — это отмена операции
 * синхронизации: наружу уходит `AgentSyncCancelledError`, прочие отказы — как есть.
 */
export async function withTransferCancellation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw error instanceof AgentTransferCancelledError ? new AgentSyncCancelledError() : error;
  }
}

/** `exchange/<operationId>` — каталог обмена архивом (агент разрешает имя архива относительно `--dir`). */
export function exchangeDirOf(context: SyncOperationContext): string {
  return `${context.workspace.exchangeRoot}/${context.operationId}`;
}

/** Имя архива внутри каталога обмена. */
export const EXCHANGE_ARCHIVE = 'full.zip';

/** Каталог точечной выгрузки внутри каталога обмена: M она не трогает (эксперимент 12, вариант А). */
export const EXCHANGE_RESTORE_DIR = 'restore';

/** Суффикс списка имён точечной выгрузки — рядом с каталогом обмена, как `.changes`; убирает движок. */
export const EXCHANGE_RESTORE_LIST_SUFFIX = '.objects.txt';

/** Каталог выгрузки только файла версий (`--config-dump-info-only`) внутри каталога обмена. */
export const EXCHANGE_DUMP_INFO_DIR = 'cdi';

/** Архив свежего файла версий: zip в разы меньше XML (6 МБ против 34 МБ на большой конфигурации, §5b п.9). */
export const EXCHANGE_DUMP_INFO_ARCHIVE = 'cdi.zip';

/** Суффикс первого списка изменений — рядом с каталогом обмена. */
export const EXCHANGE_CHANGES_SUFFIX = '.changes';

/** Суффикс повторного списка изменений после очистки зеркала: первый список остаётся для разбора сбоев. */
export const EXCHANGE_CHANGES_RETRY_SUFFIX = '.changes-retry';

/** Все файлы обмена рядом с каталогом `exchange/<operationId>`: единый список для уборки движком. */
export const EXCHANGE_SIDE_SUFFIXES: readonly string[] = [
  EXCHANGE_CHANGES_SUFFIX,
  EXCHANGE_CHANGES_RETRY_SUFFIX,
  EXCHANGE_RESTORE_LIST_SUFFIX,
];
