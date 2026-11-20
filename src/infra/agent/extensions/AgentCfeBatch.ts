/**
 * Пакеты «все расширения базы» через агента (plan-remote-extensions §4.4/§4.5, ФАКТ Э29). Цикл — здесь, поверх
 * шагов одиночного обмена; решения и формат результата — те же, что у CLI (`planCfeDumpFiles`,
 * `validateCfeDumpDirectory`, манифест, `planCfeLoad`, `CfeBatchReport`).
 *
 * Политики отказа как у CLI: выгрузка ПРОДОЛЖАЕТСЯ после сбоя элемента, загрузка ОСТАНАВЛИВАЕТСЯ на первом.
 * Потеря связи с агентом обрывает прогон (`abortReason`): сессия мертва, дальше идти некуда. Отмена — только
 * МЕЖДУ элементами: начатый элемент доводится до конца.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  planCfeLoadTarget,
  splitDumpableExtensions,
  stubDumpRefusedText,
  verifyNewExtensionLoad,
  type AgentExtensionInfo,
} from '../../../domain/agent';
import { readCfeManifest, writeCfeManifest, type CfeManifestItem } from '../../cfFile/CfeBatchManifest';
import { cfeFileNameForExtension, planCfeDumpFiles } from '../../cfFile/CfeBatchNaming';
import { planCfeLoad, validateCfeDirectory, validateCfeDumpDirectory, type CfeLoadPlan } from '../../cfFile/CfeBatchPlan';
import type { CfeBatchFailedAt, CfeBatchReport, CfeBatchReportItem } from '../../cfFile/CfeBatchReport';
import { isDumpStagingFileName } from '../../cfFile/CfFileValidation';
import { readCfeDirectoryEntries, readDirectoryFileNames } from '../../cfFile/CfeDirectoryListing';
import { AgentConnectionLostError, describeAgentCommandFailure } from '../AgentTransport';
import { createSyncProgress, type SyncProgress } from '../sync/SyncProgress';
import {
  AgentCommandStepError,
  applyNewExtensionViaAgent,
  dumpOneViaAgent,
  pruneCfExchangeLeftovers,
  reconnectQuietly,
  targetNameOf,
  uploadAndLoadViaAgent,
  type AgentCfFileContext,
} from './AgentCfFileExchange';
import { listDatabaseExtensions, withoutName } from './AgentExtensionList';
import { verificationFailedText, verificationWarningOf } from './AgentExtensionMessages';

export interface AgentCfeDumpAllRequest {
  readonly outputDir: string;
  readonly overwrite: boolean;
}

export interface AgentCfeLoadAllRequest {
  readonly inputDir: string;
  readonly createMissing: boolean;
}

export async function dumpAllExtensionsViaAgent(ctx: AgentCfFileContext, request: AgentCfeDumpAllRequest): Promise<CfeBatchReport> {
  // Сам каталог проверяет validateCfeDumpDirectory ниже (вместе с конфликтами имён плана).
  await pruneCfExchangeLeftovers(ctx.store, ctx.projectId);
  const progress = createSyncProgress(ctx.hooks, ctx.now);
  progress.step('Получение списка расширений базы…');
  const { dumpable, stubs } = splitDumpableExtensions(await listDatabaseExtensions(ctx.exec));
  const plan = planCfeDumpFiles(dumpable, readDirectoryFileNames(request.outputDir));
  const validationError = validateCfeDumpDirectory(request.outputDir, plan.items.map((item) => item.fileName), request.overwrite);
  if (validationError) {
    // Отказ до первой команды выгрузки: каталог и манифест не тронуты.
    return dumpRefused(validationError);
  }
  await removeStagingLeftovers(ctx, request.outputDir);

  const items: CfeBatchReportItem[] = [];
  const manifest: CfeManifestItem[] = [];
  let abortReason: string | undefined;
  let interrupted = false;
  for (const [index, planItem] of plan.items.entries()) {
    if (abortReason !== undefined || isCancelled(ctx)) {
      interrupted = true;
      items.push({ ...planItem, status: 'notAttempted' });
      continue;
    }
    const outputFile = path.join(request.outputDir, planItem.fileName);
    try {
      const sizeBytes = await dumpOneViaAgent(ctx, {
        outputFile,
        extensionName: planItem.extensionName,
        cancellation: undefined,
        progress,
        prefix: itemPrefix(index, plan.items.length, planItem.extensionName),
      });
      items.push({ ...planItem, status: 'ok', sizeBytes });
      manifest.push({ ...planItem, status: 'ok', sizeBytes });
    } catch (error) {
      const message = describeAgentCommandFailure(error);
      items.push({ ...planItem, status: 'failed', message });
      manifest.push({ ...planItem, status: 'failed' });
      if (error instanceof AgentConnectionLostError) {
        abortReason = message;
      } else if (error instanceof AgentCommandStepError) {
        // Пустой UnknownError может оставить агента в плохом состоянии (Э28); без подключённой ИБ дальше идти некуда.
        abortReason = await reconnectAfter(ctx, error);
      }
    }
  }
  // Заглушку выгружать нельзя — агент падает (Э28): элемент отказа без команды, в отчёт и манифест.
  for (const name of stubs) {
    const fileName = cfeFileNameForExtension(name);
    items.push({ extensionName: name, fileName, status: 'failed', message: stubDumpRefusedText(name) });
    manifest.push({ extensionName: name, fileName, status: 'failed' });
  }

  writeCfeManifest(request.outputDir, { version: 1, createdAt: new Date(ctx.now()).toISOString(), items: manifest });
  return {
    version: 1,
    operation: 'dump',
    interrupted,
    items,
    ...(abortReason === undefined ? {} : { abortReason }),
  };
}

export async function loadAllExtensionsViaAgent(ctx: AgentCfFileContext, request: AgentCfeLoadAllRequest): Promise<CfeBatchReport> {
  const directoryError = validateCfeDirectory(request.inputDir, 'load');
  if (directoryError) {
    return loadRefused(undefined, [directoryError]);
  }
  await pruneCfExchangeLeftovers(ctx.store, ctx.projectId);
  const progress = createSyncProgress(ctx.hooks, ctx.now);
  progress.step('Получение списка расширений базы…');
  const before = await listDatabaseExtensions(ctx.exec);
  const plan = planCfeLoad(
    readCfeDirectoryEntries(request.inputDir),
    readCfeManifest(request.inputDir),
    before.map((info) => info.name),
    { createMissing: request.createMissing }
  );
  if (plan.errors.length > 0) {
    // Отказ до первой загрузки останавливает ВСЁ: частично загруженный набор — база в состоянии, которого не было.
    return loadRefused(plan, plan.errors);
  }

  const items: CfeBatchReportItem[] = [];
  const applied: string[] = [];
  let failedAt: CfeBatchFailedAt | undefined;
  let abortReason: string | undefined;
  let interrupted = false;
  for (const [index, planItem] of plan.items.entries()) {
    const entry = { extensionName: planItem.extensionName, fileName: planItem.fileName };
    if (failedAt !== undefined) {
      items.push({ ...entry, status: 'notAttempted' });
      continue;
    }
    if (isCancelled(ctx)) {
      interrupted = true;
      items.push({ ...entry, status: 'notAttempted' });
      continue;
    }
    const decision = planCfeLoadTarget(before, planItem.extensionName);
    const name = targetNameOf(decision, planItem.extensionName);
    const prefix = itemPrefix(index, plan.items.length, name);
    try {
      await uploadAndLoadViaAgent(ctx, {
        inputFile: path.join(request.inputDir, planItem.fileName),
        extensionName: name,
        cancellation: undefined,
        progress,
        prefix,
      });
      if (decision.kind === 'existing') {
        items.push({ ...entry, status: 'ok' });
        continue;
      }
      // Новое имя (или заглушка): применение сразу, без проверки отмены между командами (Э28).
      await applyNewExtensionViaAgent(ctx, name, progress, prefix);
      applied.push(name);
      items.push({ ...entry, status: 'ok', appliedToDatabase: true });
    } catch (error) {
      const message = describeAgentCommandFailure(error);
      failedAt = { ...entry, stateUncertain: true };
      if (error instanceof AgentConnectionLostError) {
        abortReason = message;
        interrupted = true;
        items.push({ ...entry, status: 'failed', message });
        continue;
      }
      items.push({ ...entry, status: 'failed', message: `${message}; состояние расширения в базе неопределённо` });
      abortReason = await reconnectAfter(ctx, error);
    }
  }

  const verificationWarnings = abortReason === undefined && applied.length > 0
    ? await verifyApplied(ctx, progress, before, applied)
    : undefined;
  return {
    version: 1,
    operation: 'load',
    interrupted,
    items,
    ...(failedAt === undefined ? {} : { failedAt }),
    ...planLists(plan),
    ...(abortReason === undefined ? {} : { abortReason }),
    ...(verificationWarnings === undefined ? {} : { verificationWarnings }),
  };
}

/**
 * Сверка по списку после цикла (ФАКТ Э29, П4: имя в базе берётся из файла). Элемент не перекрашивается —
 * команда прошла, — расхождение становится явным предупреждением.
 */
async function verifyApplied(
  ctx: AgentCfFileContext,
  progress: SyncProgress,
  before: readonly AgentExtensionInfo[],
  applied: readonly string[]
): Promise<string[]> {
  progress.step('Проверка результата по списку расширений…');
  let after: AgentExtensionInfo[];
  try {
    after = await listDatabaseExtensions(ctx.exec);
  } catch (error) {
    // База уже изменена: сбой проверки не должен терять отчёт прогона.
    return [verificationFailedText(applied.join(', '), describeAgentCommandFailure(error))];
  }
  const warnings: string[] = [];
  for (const name of applied) {
    // Остальные применённые этим прогоном имена — не «появившиеся» для этого элемента.
    const others = new Set(applied.filter((other) => other !== name).map((other) => other.toLowerCase()));
    const baseline = [...withoutName(before, name), ...after.filter((info) => others.has(info.name.toLowerCase()))];
    const warning = verificationWarningOf(verifyNewExtensionLoad(baseline, after, name), name);
    if (warning) {
      warnings.push(warning);
    }
  }
  return warnings;
}

/**
 * Staging-остатки ПРОШЛЫХ прогонов (обрыв не выполняет `finally`). Трогаются только файлы нашего формата
 * имени; удаление — `unlink` (запрет №19: в имени staging есть имя расширения).
 */
async function removeStagingLeftovers(ctx: AgentCfFileContext, outputDir: string): Promise<void> {
  const leftovers = readDirectoryFileNames(outputDir).filter(isDumpStagingFileName);
  for (const fileName of leftovers) {
    await fs.promises.unlink(path.join(outputDir, fileName));
  }
  if (leftovers.length > 0) {
    ctx.hooks?.onMessage?.(`Убраны остатки прерванной выгрузки: ${leftovers.join(', ')}`);
  }
}

/**
 * Переподключение ИБ после отказа элемента (если шаг его ещё не сделал). Отказ — причина обрыва прогона
 * (`abortReason`): продолжать с неподключённой ИБ значит получить отказ на каждом следующем элементе.
 */
async function reconnectAfter(ctx: AgentCfFileContext, error: unknown): Promise<string | undefined> {
  const failure = error instanceof AgentCommandStepError && error.reconnect !== undefined
    ? error.reconnect.failure
    : await reconnectQuietly(ctx);
  return failure === undefined ? undefined : `Не удалось переподключить информационную базу после ошибки: ${failure}`;
}

function isCancelled(ctx: AgentCfFileContext): boolean {
  return ctx.hooks?.cancellation?.isCancellationRequested === true;
}

function itemPrefix(index: number, total: number, name: string): string {
  return `(${String(index + 1)} из ${String(total)}) «${name}»: `;
}

function dumpRefused(error: string): CfeBatchReport {
  return { version: 1, operation: 'dump', interrupted: false, items: [], errors: [error] };
}

function loadRefused(plan: CfeLoadPlan | undefined, errors: string[]): CfeBatchReport {
  return { version: 1, operation: 'load', interrupted: false, items: [], ...planLists(plan), errors };
}

function planLists(plan: CfeLoadPlan | undefined): Pick<CfeBatchReport, 'missingInDb' | 'notInDirectory' | 'ignoredFiles' | 'restoredByFileName'> {
  return {
    missingInDb: plan?.missingInDb ?? [],
    notInDirectory: plan?.notInDirectory ?? [],
    ignoredFiles: plan?.ignoredFiles ?? [],
    restoredByFileName: (plan?.items ?? []).filter((item) => item.manifestMissing).map((item) => item.fileName),
  };
}
