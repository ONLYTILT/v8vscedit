/**
 * Одиночный обмен CF/CFE-файлом через агента конфигуратора (plan-remote-extensions §4.2/§4.3, ФАКТ Э29).
 *
 * Файл обмена на сервере — всегда ASCII `payload.cf|payload.cfe` в `exchange/cffile-<projectId>-<op>`: кириллица
 * остаётся только в `--extension`, где её экранирует `quoteAgentArgument`. Большой `.cf` (до ГБ) идёт только
 * потоком (`downloadToFile`/`uploadFromFile`), выгрузка — через staging рядом с целью с переносом ТОЛЬКО после
 * полного скачивания.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  buildDumpCfgCommand,
  buildLoadCfgCommand,
  buildUpdateDbCfgCommand,
  planCfeDumpTarget,
  planCfeLoadTarget,
  type CfeLoadTargetDecision,
} from '../../../domain/agent';
import { resolveDumpStagingPath, validateCfFileOutputTarget } from '../../cfFile/CfFileValidation';
import { freeDiskSpaceOf } from '../../fs/FreeDiskSpace';
import { moveStagingToTarget } from '../../fs/StagingFile';
import type { AgentCommandExecutor } from '../AgentInfoBaseSession';
import type { AgentOperationHooks } from '../AgentOperationService';
import { AgentConnectionLostError, describeAgentCommandFailure, type AgentCommandResult } from '../AgentTransport';
import type { AgentFileStore } from '../files/AgentFileStore';
import type { AgentTransferCancellation } from '../files/AgentFileTransfer';
import { throwIfCancelled, withTransferCancellation } from '../sync/SyncContext';
import { createSyncProgress, type SyncProgress } from '../sync/SyncProgress';
import { transferFormat } from '../sync/DeltaLanes';
import { listDatabaseExtensions, verifyAppliedExtension } from './AgentExtensionList';
import {
  appliedFailedText,
  cancelledAfterLoadText,
  dumpFileMissingText,
  loadFailedText,
  newLoadFailedText,
  notEnoughSpaceText,
  subjectOf,
} from './AgentExtensionMessages';

export interface AgentCfFileContext {
  readonly exec: AgentCommandExecutor;
  readonly store: AgentFileStore;
  readonly projectId: string;
  readonly hooks?: AgentOperationHooks;
  readonly now: () => number;
  /** Свободное место тома каталога; по умолчанию {@link freeDiskSpaceOf}. `undefined` — не проверяется. */
  readonly freeSpace?: (dir: string) => Promise<number | undefined>;
}

export interface AgentCfFileDumpRequest {
  readonly outputFile: string;
  readonly extensionName?: string;
  readonly overwrite: boolean;
}

export interface AgentCfFileDumpResult {
  readonly outputFile: string;
  readonly sizeBytes: number;
}

export interface AgentCfFileLoadRequest {
  readonly inputFile: string;
  readonly extensionName?: string;
}

export interface AgentCfFileLoadResult {
  /** `''` — основная конфигурация; иначе имя в регистре базы. */
  readonly extensionName: string;
  /** Записи с этим именем в базе не было (или была только заглушка). */
  readonly createdInDatabase: boolean;
  /** Новое расширение применено в той же операции (Э28: иначе остаётся заглушка). */
  readonly appliedToDatabase: boolean;
  /** Имя в базе после применения, если оно взято из файла (ФАКТ Э29, П4). */
  readonly extensionNameInDatabase?: string;
  readonly warnings: readonly string[];
}

/**
 * Отказ шага операции, на котором агент мог остаться в плохом состоянии (отказ команды). Пакет по этому
 * признаку переподключает ИБ; отказ по причине вне агента (место на диске, пустой файл) — нет.
 */
export class AgentCommandStepError extends Error {
  /**
   * @param reconnect — шаг уже переподключил ИБ после отказа (`failure` — текст отказа переподключения): пакет
   * по нему не переподключается повторно и при неудаче обрывает прогон.
   */
  constructor(message: string, cause: unknown, readonly reconnect?: { readonly failure?: string }) {
    super(message, { cause });
    this.name = 'AgentCommandStepError';
  }
}

const EXCHANGE_ROOT = 'exchange';
let operationCounter = 0;

/** Каталог обмена операции: `exchange/cffile-<projectId>-<opId>`. */
export function cfExchangeDir(projectId: string, operationId: string): string {
  return `${EXCHANGE_ROOT}/${cfExchangePrefix(projectId)}${operationId}`;
}

/** Уборка остатков СВОЕГО проекта (`exchange/cffile-<projectId>-*`): обрыв процесса не выполняет `finally`. */
export async function pruneCfExchangeLeftovers(store: AgentFileStore, projectId: string): Promise<void> {
  if (!await store.stat(EXCHANGE_ROOT)) {
    return;
  }
  const prefix = cfExchangePrefix(projectId);
  for (const entry of await store.list(EXCHANGE_ROOT)) {
    if (entry.type === 'dir' && baseName(entry.path).startsWith(prefix)) {
      await store.remove(entry.path, { recursive: true });
    }
  }
}

export async function dumpCfFileViaAgent(ctx: AgentCfFileContext, request: AgentCfFileDumpRequest): Promise<AgentCfFileDumpResult> {
  const requested = request.extensionName?.trim() ?? '';
  // Тот же guard цели, что у UI-раннера: прямой вызов сервиса не должен затирать файл без overwrite.
  const targetError = validateCfFileOutputTarget(request.outputFile, request.overwrite);
  if (targetError) {
    throw new Error(targetError);
  }
  await pruneCfExchangeLeftovers(ctx.store, ctx.projectId);
  let name: string | undefined;
  if (requested) {
    const decision = planCfeDumpTarget(await listDatabaseExtensions(ctx.exec), requested);
    if (decision.kind === 'refuse') {
      throw new Error(decision.reason);
    }
    name = decision.name;
  }
  throwIfCancelled({ hooks: ctx.hooks });
  const sizeBytes = await dumpOneViaAgent(ctx, {
    outputFile: request.outputFile,
    extensionName: name,
    cancellation: ctx.hooks?.cancellation,
    progress: createSyncProgress(ctx.hooks, ctx.now),
    prefix: '',
  });
  return { outputFile: request.outputFile, sizeBytes };
}

export async function loadCfFileViaAgent(ctx: AgentCfFileContext, request: AgentCfFileLoadRequest): Promise<AgentCfFileLoadResult> {
  const requested = request.extensionName?.trim() ?? '';
  await pruneCfExchangeLeftovers(ctx.store, ctx.projectId);
  const before = requested ? await listDatabaseExtensions(ctx.exec) : [];
  const decision = requested ? planCfeLoadTarget(before, requested) : undefined;
  const name = decision === undefined ? undefined : targetNameOf(decision, requested);
  const progress = createSyncProgress(ctx.hooks, ctx.now);
  throwIfCancelled({ hooks: ctx.hooks });
  try {
    await uploadAndLoadViaAgent(ctx, { inputFile: request.inputFile, extensionName: name, cancellation: ctx.hooks?.cancellation, progress, prefix: '' });
  } catch (error) {
    if (!(error instanceof AgentCommandStepError)) {
      throw error;
    }
    if (decision !== undefined && decision.kind !== 'existing') {
      // Отказ load-cfg нового имени мог оставить заглушку: агент переподключается до следующей команды (Э28).
      const failure = await reconnectQuietly(ctx);
      throw new AgentCommandStepError(newLoadFailedText(targetNameOf(decision, requested), error.message), error, { failure });
    }
    throw new AgentCommandStepError(loadFailedText(subjectOf(name), error.message), error);
  }
  if (name === undefined || decision?.kind === 'existing') {
    return { extensionName: name ?? '', createdInDatabase: false, appliedToDatabase: false, warnings: [] };
  }
  // Без проверки отмены между load-cfg и update-db-cfg: иначе в базе остаётся заглушка (Э28).
  await applyNewExtensionViaAgent(ctx, name, progress, '');
  progress.step('Проверка результата по списку расширений…');
  const verification = await verifyAppliedExtension(ctx.exec, before, name, 'load');
  const warnings = [...verification.warnings];
  if (ctx.hooks?.cancellation?.isCancellationRequested) {
    warnings.push(cancelledAfterLoadText(name));
  }
  return {
    extensionName: name,
    createdInDatabase: true,
    appliedToDatabase: true,
    ...(verification.renamedTo === undefined ? {} : { extensionNameInDatabase: verification.renamedTo }),
    warnings,
  };
}

// ── Шаги, общие с пакетами ─────────────────────────────────────────────────

export interface AgentTransferStep {
  /** Токен отмены ВНУТРИ передачи; пакет его не передаёт — он отменяется только между элементами. */
  readonly cancellation: AgentTransferCancellation | undefined;
  readonly progress: SyncProgress;
  /** Префикс этапов пакета `(i из n) «X»: `. */
  readonly prefix: string;
}

/** `dump-cfg` в каталог обмена → проверка файла и места → скачивание в staging → перенос. Размер файла. */
export async function dumpOneViaAgent(
  ctx: AgentCfFileContext,
  step: AgentTransferStep & { readonly outputFile: string; readonly extensionName: string | undefined }
): Promise<number> {
  const exchangeDir = cfExchangeDir(ctx.projectId, nextOperationId(ctx));
  const rel = `${exchangeDir}/${payloadName(step.extensionName)}`;
  let stagingPath: string | undefined;
  try {
    await ctx.store.mkdirp(exchangeDir);
    step.progress.step(`${step.prefix}Выгрузка ${subjectOf(step.extensionName)} на сервере (команда агента)…`);
    await runAgentCommand(ctx.exec, buildDumpCfgCommand(rel, step.extensionName), subjectOf(step.extensionName));
    const entry = await ctx.store.stat(rel);
    if (!entry || entry.size === 0) {
      throw new Error(dumpFileMissingText(rel));
    }
    const targetDir = path.dirname(step.outputFile);
    const free = await (ctx.freeSpace ?? freeDiskSpaceOf)(targetDir);
    if (free !== undefined && free < entry.size) {
      throw new Error(notEnoughSpaceText(entry.size, free, targetDir));
    }
    const staging = resolveDumpStagingPath(step.outputFile, `${ctx.projectId}-${String(ctx.now())}`);
    stagingPath = staging;
    await transferWithProgress(step, `${step.prefix}Скачивание файла`, entry.size, (options) =>
      ctx.store.downloadToFile(rel, staging, options));
    moveStagingToTarget(staging, step.outputFile);
    return entry.size;
  } finally {
    await unlinkIfExists(stagingPath);
    await removeExchangeDir(ctx, exchangeDir);
  }
}

/** Передача файла на сервер → `load-cfg`. Отказ команды — {@link AgentCommandStepError} с текстом агента. */
export async function uploadAndLoadViaAgent(
  ctx: AgentCfFileContext,
  step: AgentTransferStep & { readonly inputFile: string; readonly extensionName: string | undefined }
): Promise<void> {
  const exchangeDir = cfExchangeDir(ctx.projectId, nextOperationId(ctx));
  const rel = `${exchangeDir}/${payloadName(step.extensionName)}`;
  try {
    const { size } = await fs.promises.stat(step.inputFile);
    await transferWithProgress(step, `${step.prefix}Передача файла на сервер`, size, (options) =>
      ctx.store.uploadFromFile(step.inputFile, rel, options));
    // Последняя точка отмены: дальше база меняется.
    if (step.cancellation) {
      throwIfCancelled({ hooks: ctx.hooks });
    }
    step.progress.step(`${step.prefix}Загрузка в базу (команда агента)…`);
    await runAgentCommand(ctx.exec, buildLoadCfgCommand(rel, step.extensionName), subjectOf(step.extensionName));
  } finally {
    await removeExchangeDir(ctx, exchangeDir);
  }
}

/** `update-db-cfg --extension` сразу после `load-cfg` нового имени. Отказ — E7 (+ переподключение ИБ). */
export async function applyNewExtensionViaAgent(ctx: AgentCfFileContext, name: string, progress: SyncProgress, prefix: string): Promise<void> {
  progress.step(`${prefix}Применение расширения «${name}» к базе…`);
  try {
    await runAgentCommand(ctx.exec, buildUpdateDbCfgCommand({ extensionName: name }), subjectOf(name));
  } catch (error) {
    if (!(error instanceof AgentCommandStepError)) {
      throw error;
    }
    const failure = await reconnectQuietly(ctx);
    throw new AgentCommandStepError(appliedFailedText(name, error.message), error, { failure });
  }
}

/** Имя для команд: у нового — запрошенное, у существующего и заглушки — в регистре базы. */
export function targetNameOf(decision: CfeLoadTargetDecision, requested: string): string {
  return decision.kind === 'new' ? requested : decision.name;
}

/**
 * Переподключение ИБ после сбоя команды (Э28). Отказ — строка журнала (исходная причина не подменяется) и
 * возвращаемый текст: пакет по нему обрывает прогон, а не идёт дальше с неподключённой ИБ.
 */
export async function reconnectQuietly(ctx: AgentCfFileContext): Promise<string | undefined> {
  try {
    await ctx.exec.reconnectInfoBase();
    return undefined;
  } catch (error) {
    const reason = describeAgentCommandFailure(error);
    ctx.hooks?.onMessage?.(`Не удалось переподключить информационную базу после ошибки: ${reason}`);
    return reason;
  }
}

/**
 * Команда агента: потеря связи получает предмет операции в тексте (E1), отказ — человеческий текст
 * (`describeAgentCommandFailure`: пустой UnknownError → последняя log-строка).
 */
async function runAgentCommand(exec: AgentCommandExecutor, command: string, subject: string): Promise<AgentCommandResult> {
  try {
    return await exec.execute(command);
  } catch (error) {
    if (error instanceof AgentConnectionLostError) {
      throw error.withSubject(subject);
    }
    throw new AgentCommandStepError(describeAgentCommandFailure(error), error);
  }
}

async function transferWithProgress(
  step: AgentTransferStep,
  title: string,
  size: number,
  run: (options: { cancellation?: AgentTransferCancellation; onProgress: (done: number) => void }) => Promise<void>
): Promise<void> {
  const counter = step.progress.transfer(transferFormat(title), { files: 1, bytes: size });
  let reported = 0;
  await withTransferCancellation(() => run({
    cancellation: step.cancellation,
    onProgress: (done) => {
      counter.addBytes(done - reported);
      reported = done;
    },
  }));
  counter.fileDone();
  counter.finish();
}

async function removeExchangeDir(ctx: AgentCfFileContext, exchangeDir: string): Promise<void> {
  try {
    await ctx.store.remove(exchangeDir, { recursive: true });
  } catch (error) {
    ctx.hooks?.onMessage?.(`Не удалось убрать каталог обмена ${exchangeDir} на сервере агента: ${describeAgentCommandFailure(error)}`);
  }
}

/** `unlink`, а не `rmSync` (запрет №19): в имени staging есть имя расширения, часто кириллическое. */
async function unlinkIfExists(filePath: string | undefined): Promise<void> {
  if (filePath === undefined) {
    return;
  }
  // После переноса или отменённого скачивания файла уже нет (ENOENT) — это штатно; иной отказ уборки не
  // должен подменять собой исход операции.
  await fs.promises.unlink(filePath).catch(() => undefined);
}

function nextOperationId(ctx: AgentCfFileContext): string {
  operationCounter += 1;
  return `${String(ctx.now())}-${String(operationCounter)}`;
}

function payloadName(extensionName: string | undefined): string {
  return extensionName ? 'payload.cfe' : 'payload.cf';
}

function cfExchangePrefix(projectId: string): string {
  return `cffile-${projectId}-`;
}

function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}
