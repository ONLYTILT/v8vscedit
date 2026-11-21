import * as fs from 'fs';
import * as path from 'path';
import { buildDumpConfigToFilesCommand, buildLoadConfigFromFilesCommand } from '../../../domain/agent/AgentCommand';
import { collectConfigFilesForLoad } from '../ConfigLoadFileCollector';
import { uploadFiles } from '../files/AgentFileTransfer';
import { packDirectoryFilesToFile } from './ArchiveCodec';
import { confirmFullDumpOrThrow } from './FullDumpConsent';
import { CONFIG_DUMP_INFO_XML, CONFIGURATION_XML, listProjectFiles, toProjectPath } from './ProjectFiles';
import {
  EXCHANGE_ARCHIVE,
  exchangeDirOf,
  throwIfCancelled,
  withTransferCancellation,
  type SyncOperationContext,
} from './SyncContext';
import { buildSyncManifestFiles, type SyncMirrorCoverage, type SyncMirrorState } from './SyncManifest';
import { planLoad, type LoadFullReason } from './SyncPlanner';

/**
 * Загрузка P → БД (таблица плана §1.1). Решение принимает SyncPlanner; здесь — исполнение плана:
 * подготовка M, передача файлов, команда агента. B обновляется вызывающим только после успеха.
 */

export type AgentLoadMode = 'full' | 'changed';

export interface AgentLoadResult {
  readonly changedProjectFiles: string[];
  readonly skipped?: boolean;
  readonly strategy: 'skipped' | 'full' | 'partial';
  readonly reason?: LoadFullReason | 'requested' | 'no-changes' | 'no-loadable-files';
  readonly via?: 'dir' | 'archive';
}

export interface AgentLoadOutcome {
  readonly result: AgentLoadResult;
  /** Хэши P, по которым шла загрузка, — новая B. */
  readonly files: Record<string, string>;
  /** Состояние M после операции. */
  readonly mirrorState: SyncMirrorState;
  /**
   * Полнота M после операции: разреженность снимает только полная выгрузка в M без `--update`
   * (`full-dump`); `refresh-dump` после полной загрузки консервативно её сохраняет.
   */
  readonly mirrorCoverage: SyncMirrorCoverage;
}

/** Сообщения прежнего AgentOperationService сохраняются дословно: на них опираются пользователи и тесты. */
const FULL_REASON_MESSAGES: Readonly<Record<LoadFullReason, string>> = {
  'no-baseline': 'Кэш изменений не найден, выполняется полная загрузка.',
  rename: 'Обнаружено переименование объектов, выполняется полная загрузка.',
  deletion: 'Обнаружено удаление файлов, выполняется полная загрузка.',
  'over-threshold': 'Изменённых файлов больше порога, выполняется полная загрузка архивом.',
};

export async function runLoad(context: SyncOperationContext, mode: AgentLoadMode): Promise<AgentLoadOutcome> {
  const outcome = await loadWithPlan(context, mode);
  return { ...outcome, mirrorCoverage: context.mirror.coverage };
}

async function loadWithPlan(context: SyncOperationContext, mode: AgentLoadMode): Promise<Omit<AgentLoadOutcome, 'mirrorCoverage'>> {
  const projectDir = context.target.rootPath;
  if (!fs.existsSync(projectDir)) {
    throw new Error(`${mode === 'full' ? 'Каталог источника не найден' : 'Каталог исходников не найден'}: ${projectDir}`);
  }
  const files = await buildSyncManifestFiles(projectDir, context.projectRoot, context.hashScan);
  const storeKind = context.store.kind;
  const fullVia = storeKind === 'local' ? 'dir' : 'archive';
  if (mode === 'full') {
    const mirrorState = await loadFull(context, fullVia);
    return { result: { changedProjectFiles: [], strategy: 'full', reason: 'requested', via: fullVia }, files, mirrorState };
  }

  const mirrorState = await effectiveMirrorState(context);
  const plan = planLoad({
    storeKind,
    mirrorState,
    base: context.manifest.files,
    current: files,
    archiveThresholdFiles: context.archiveThresholdFiles,
    selectLoadFiles: (changed) => collectConfigFilesForLoad(projectDir, changed, false),
  });
  if (plan.action === 'skip') {
    return {
      result: { changedProjectFiles: [], skipped: true, strategy: 'skipped', reason: plan.reason },
      files,
      mirrorState,
    };
  }
  if (plan.action === 'full') {
    context.hooks?.onMessage?.(FULL_REASON_MESSAGES[plan.reason]);
    const nextState = await loadFull(context, plan.via);
    return { result: { changedProjectFiles: [], strategy: 'full', reason: plan.reason, via: plan.via }, files, mirrorState: nextState };
  }

  context.hooks?.onMessage?.(`Подготовка частичной загрузки: ${String(plan.files.length)} файл(ов).`);
  const mirror = context.workspace.targetAgentDir;
  switch (plan.prepareMirror) {
    case 'full-copy':
      // Без каркаса в `--dir` агент на `--partial` валится в пустой UnknownError. Достаточно файла
      // версий, Configuration.xml и файлов списка (пилот, эксперименты 9/10), но локальный M
      // копируется из P целиком: так он остаётся полным, и локальный импорт сравнивает его с P.
      context.markMirrorMutated();
      await mirrorProjectToAgent(context);
      break;
    case 'refresh-dump':
      // После загрузки архивом БД ≡ P, поэтому каркасу M достаточно `--update` без скачивания.
      context.markMirrorMutated();
      await context.exec.execute(buildDumpConfigToFilesCommand(mirror, { extensionName: context.extensionName, update: true, force: true }));
      break;
    case 'full-dump':
      // Вопрос — ДО любой мутации M: отказ не должен ни очищать M, ни менять манифест.
      await confirmFullDumpOrThrow(context, 'mirror-empty', 'load');
      // M на сервере нет, но БД ≡ B: полная выгрузка базы в M — на сервере, без скачивания (Н47).
      // M очищается заранее, как в первом импорте: остаток недостоверного M не должен пережить выгрузку.
      context.hooks?.onMessage?.('Зеркало выгрузки на стороне агента не подготовлено: выгрузка конфигурации в него на сервере.');
      context.markMirrorMutated();
      await context.store.remove(mirror, { recursive: true });
      await context.exec.execute(buildDumpConfigToFilesCommand(mirror, { extensionName: context.extensionName, force: true }));
      context.mirror.coverage = 'full';
      break;
    case 'none':
      break;
  }
  context.markMirrorMutated();
  await uploadProjectFiles(context, plan.files);
  throwIfCancelled(context);
  const listFile = await context.workspaceService.writeListFile(context.operationId, plan.files);
  context.hooks?.onMessage?.('Частичная загрузка изменённых файлов.');
  // На частичной загрузке `--update-config-dump-info` передавать нельзя: конфигуратор
  // перезаписывает файл версий «срезом» только из списка и на следующей частичной загрузке
  // уходит во внутреннее UnknownError с пустым телом.
  context.hooks?.onConfigurationLoadStarting?.();
  await context.exec.execute(buildLoadConfigFromFilesCommand(mirror, {
    extensionName: context.extensionName,
    listFile,
    partial: true,
    noCheck: true,
  }));
  return { result: { changedProjectFiles: [], strategy: 'partial' }, files, mirrorState: 'fresh' };
}

function loadFull(context: SyncOperationContext, via: 'dir' | 'archive'): Promise<SyncMirrorState> {
  return via === 'dir' ? loadFullFromMirror(context) : loadFullByArchive(context);
}

/**
 * M без Configuration.xml — не каркас: частичная загрузка в такой `--dir` невозможна, поэтому он
 * считается пустым независимо от флага манифеста. Локальному агенту флаг не нужен вовсе: его M
 * проверяется напрямую, а `empty` после миграции с HashCache иначе заставил бы зеркалить весь P.
 */
async function effectiveMirrorState(context: SyncOperationContext): Promise<SyncMirrorState> {
  const skeleton = await context.store.stat(`${context.workspace.targetAgentDir}/${CONFIGURATION_XML}`);
  if (skeleton?.type !== 'file') {
    return 'empty';
  }
  return context.store.kind === 'local' ? 'fresh' : context.manifest.mirrorState;
}

/** Локальный агент: M становится копией P и грузится каталогом с обновлением файла версий. */
async function loadFullFromMirror(context: SyncOperationContext): Promise<SyncMirrorState> {
  context.hooks?.onMessage?.('Подготовка файлов для полной загрузки.');
  context.markMirrorMutated();
  await mirrorProjectToAgent(context);
  throwIfCancelled(context);
  context.hooks?.onMessage?.('Полная загрузка конфигурации из файлов.');
  context.hooks?.onConfigurationLoadStarting?.();
  await context.exec.execute(buildLoadConfigFromFilesCommand(context.workspace.targetAgentDir, {
    extensionName: context.extensionName,
    updateConfigDumpInfo: true,
  }));
  return 'fresh';
}

/**
 * Удалённый агент: весь P одним архивом в каталог обмена; M при этом не трогается и отстаёт от
 * БД (`stale`), что следующая частичная загрузка исправит `dump --update` без скачивания.
 */
async function loadFullByArchive(context: SyncOperationContext): Promise<SyncMirrorState> {
  context.hooks?.onMessage?.('Подготовка архива для полной загрузки.');
  const projectDir = context.target.rootPath;
  // Файл версий проекта может быть устаревшим, а загрузке он не нужен.
  const files = listProjectFiles(projectDir).filter((rel) => rel !== CONFIG_DUMP_INFO_XML);
  const exchangeDir = exchangeDirOf(context);
  const cancellation = context.hooks?.cancellation;
  // Архив собирается потоком в локальный файл и закачивается потоком: P большой конфигурации —
  // гигабайты XML, и ни архив, ни его содержимое целиком в памяти не держатся.
  const zipPath = await context.localExchange.file(EXCHANGE_ARCHIVE);
  await withTransferCancellation(async () => {
    await packDirectoryFilesToFile(projectDir, files, zipPath, cancellation);
    throwIfCancelled(context);
    await context.store.uploadFromFile(zipPath, `${exchangeDir}/${EXCHANGE_ARCHIVE}`, { cancellation });
  });
  throwIfCancelled(context);
  context.hooks?.onMessage?.('Полная загрузка конфигурации из архива.');
  context.hooks?.onConfigurationLoadStarting?.();
  await context.exec.execute(buildLoadConfigFromFilesCommand(exchangeDir, {
    extensionName: context.extensionName,
    archive: EXCHANGE_ARCHIVE,
  }));
  return 'stale';
}

/**
 * P → M целиком: лишнее в M удаляется, все файлы P записываются. Содержимое не сравнивается —
 * так вёл себя прежний локальный `mirrorDirectorySnapshot`.
 */
async function mirrorProjectToAgent(context: SyncOperationContext): Promise<void> {
  const { store } = context;
  const mirror = context.workspace.targetAgentDir;
  const localFiles = listProjectFiles(context.target.rootPath);
  const keepFiles = new Set(localFiles);
  const keepDirs = new Set(localFiles.flatMap((rel) => ancestorsOf(rel)));
  for (const entry of await store.list(mirror, { recursive: true })) {
    const rel = entry.path.slice(mirror.length + 1);
    if (!(entry.type === 'dir' ? keepDirs.has(rel) : keepFiles.has(rel))) {
      // Потомки уже удалённого каталога идут в листинге следом; их удаление — no-op по контракту.
      await store.remove(entry.path, { recursive: true });
    }
  }
  await uploadProjectFiles(context, localFiles);
}

async function uploadProjectFiles(context: SyncOperationContext, relativeFiles: readonly string[]): Promise<void> {
  const prefix = `${context.workspace.targetAgentDir}/`;
  await uploadFiles(
    context.store,
    relativeFiles.map((rel) => prefix + rel),
    (agentRel) => fs.readFileSync(toProjectPath(context.target.rootPath, agentRel.slice(prefix.length))),
    { concurrency: context.transferConcurrency }
  );
}

function ancestorsOf(rel: string): string[] {
  const parts = rel.split(path.posix.sep);
  return parts.slice(1).map((_part, index) => parts.slice(0, index + 1).join('/'));
}
