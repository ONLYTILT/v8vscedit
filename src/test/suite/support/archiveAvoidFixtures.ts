/**
 * Общие стенды задачи «полная выгрузка — только когда без неё нельзя» (plan-archive-avoid.md §8):
 * шпион хуков импорта, «богатый» документ с модулями/формой/макетом/командой (раскладка эксперимента 12),
 * массовые владельцы для проверки дельты без буфера, хранилище-счётчик конкурентности и сборка
 * `SyncOperationContext` для тестов стратегий поверх стенда движка. Подменяется только агент 1С.
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
  AgentFullDumpDecision,
  AgentFullDumpRequest,
  AgentMirrorSeedDecision,
  AgentMirrorSeedRequest,
  AgentOperationHooks,
  AgentOrphanFilesRequest,
} from '../../../infra/agent/AgentOperationService';
import { AgentWorkspaceService, buildAgentProjectId } from '../../../infra/agent/AgentWorkspaceService';
import type { AgentFileEntry } from '../../../infra/agent/files/AgentFileStore';
import { createLocalExchange, type LocalExchange } from '../../../infra/agent/sync/LocalExchange';
import type { SyncOperationContext } from '../../../infra/agent/sync/SyncContext';
import { createSyncProgress } from '../../../infra/agent/sync/SyncProgress';
import type { AgentConfigEmulator } from './agentConfigEmulator';
import { DelegatingAgentFileStore } from './delegatingAgentFileStore';
import { HARNESS_EXTENSION_NAME, type SyncHarness } from './agentSyncHarness';

// ── шпион хуков ───────────────────────────────────────────────────────────────

export interface ImportHookSpyOptions {
  /** Ответ на вопрос о посеве; `undefined` — хука `confirmMirrorSeed` нет вовсе. */
  readonly seed?: AgentMirrorSeedDecision;
  /** Ответ на вопрос о полной выгрузке; `undefined` — хука `confirmFullDump` нет вовсе. */
  readonly fullDump?: AgentFullDumpDecision;
  /** Ответ на вопрос об удалении сирот; `undefined` — хука `confirmOrphanRemoval` нет вовсе. */
  readonly orphans?: boolean;
  readonly extra?: AgentOperationHooks;
}

export interface ImportHookSpy {
  readonly hooks: AgentOperationHooks;
  readonly seedRequests: AgentMirrorSeedRequest[];
  readonly fullDumpRequests: AgentFullDumpRequest[];
  readonly orphanRequests: AgentOrphanFilesRequest[];
  readonly messages: string[];
}

/** Хуки с записью вызовов: порядок вопросов в одной операции проверяется по общему журналу `calls`. */
export function importHookSpy(options: ImportHookSpyOptions = {}): ImportHookSpy & { readonly calls: string[] } {
  const seedRequests: AgentMirrorSeedRequest[] = [];
  const fullDumpRequests: AgentFullDumpRequest[] = [];
  const orphanRequests: AgentOrphanFilesRequest[] = [];
  const messages: string[] = [];
  const calls: string[] = [];
  const { seed, fullDump, orphans, extra = {} } = options;
  const hooks: AgentOperationHooks = {
    ...extra,
    onMessage: (message) => { messages.push(message); extra.onMessage?.(message); },
    ...(seed === undefined ? {} : {
      confirmMirrorSeed: (request: AgentMirrorSeedRequest) => {
        calls.push('seed');
        seedRequests.push(request);
        return Promise.resolve(seed);
      },
    }),
    ...(fullDump === undefined ? {} : {
      confirmFullDump: (request: AgentFullDumpRequest) => {
        calls.push('fullDump');
        fullDumpRequests.push(request);
        return Promise.resolve(fullDump);
      },
    }),
    ...(orphans === undefined ? {} : {
      confirmOrphanRemoval: (request: AgentOrphanFilesRequest) => {
        calls.push('orphans');
        orphanRequests.push(request);
        return Promise.resolve(orphans);
      },
    }),
  };
  return { hooks, seedRequests, fullDumpRequests, orphanRequests, messages, calls };
}

// ── данные «базы» ─────────────────────────────────────────────────────────────

/**
 * Документ с набором подобъектов раскладки эксперимента 12: модули объекта и менеджера, форма с
 * модулем, макет, команда с модулем. Файловые записи CDI эмулятор выводит из путей сам.
 */
export const RICH_DOCUMENT_FILES: Readonly<Record<string, string>> = {
  'Documents/Д.xml': '<Document>Д</Document>',
  'Documents/Д/Ext/ObjectModule.bsl': 'Процедура ОМ() КонецПроцедуры',
  'Documents/Д/Ext/ManagerModule.bsl': 'Процедура ММ() КонецПроцедуры',
  'Documents/Д/Forms/Ф.xml': '<Form>Ф</Form>',
  'Documents/Д/Forms/Ф/Ext/Form.xml': '<FormBody>Ф</FormBody>',
  'Documents/Д/Forms/Ф/Ext/Form/Module.bsl': 'Процедура ФМ() КонецПроцедуры',
  'Documents/Д/Templates/М.xml': '<Template>М</Template>',
  'Documents/Д/Templates/М/Ext/Template.xml': '<Макет/>',
  'Documents/Д/Commands/К/Ext/CommandModule.bsl': 'Процедура КМ() КонецПроцедуры',
};

/** Имена файловых записей CDI для {@link RICH_DOCUMENT_FILES} (по эксперименту 12), владелец первым. */
export const RICH_DOCUMENT_FILE_LEVEL_NAMES: readonly string[] = [
  'Document.Д',
  'Document.Д.ObjectModule',
  'Document.Д.ManagerModule',
  'Document.Д.Form.Ф',
  'Document.Д.Form.Ф.Form',
  'Document.Д.Template.М',
  'Document.Д.Template.М.Template',
  'Document.Д.Command.К.CommandModule',
];

export function seedRichDocument(emulator: AgentConfigEmulator): void {
  emulator.setObject('Document.Д', { ...RICH_DOCUMENT_FILES });
  emulator.addInlineChild('Document.Д', 'TabularSection.ТЧ');
}

/**
 * Файлы массового владельца: XML и `filesPerOwner - 1` модулей `Ext/Ф<n>.bsl` (у каждого в эмуляторе своя
 * файловая запись CDI — такие файлы можно выгрузить точечно по имени).
 */
export function bulkOwnerFiles(index: number, filesPerOwner: number, revision: string): Record<string, string> {
  const files: Record<string, string> = { [`Catalogs/Б${String(index)}.xml`]: `<Catalog>Б${String(index)} ${revision}</Catalog>` };
  for (let i = 1; i < filesPerOwner; i += 1) {
    files[`Catalogs/Б${String(index)}/Ext/Ф${String(i)}.bsl`] = `Б${String(index)}/${String(i)} ${revision}`;
  }
  return files;
}

export function seedBulkOwners(emulator: AgentConfigEmulator, ownerCount: number, filesPerOwner: number, revision = 'v1'): void {
  for (let index = 0; index < ownerCount; index += 1) {
    emulator.setObject(`Catalog.Б${String(index)}`, bulkOwnerFiles(index, filesPerOwner, revision));
  }
}

// ── хранилище-счётчик конкурентности ──────────────────────────────────────────

export type ProbedMethod = 'stat' | 'list' | 'readFile';

/**
 * Считает одновременно выполняющиеся `stat`/`list`/`readFile`. Верхняя граница (`max*` ≤ конкурентность)
 * проверяется всегда; нижняя («параллельность вообще есть») — без таймеров: счётчик растёт синхронно при
 * входе в вызов, до первого `await`, а каждый `stat`/`list` после взведения уступает ход (`setImmediate`).
 * Пул из N исполнителей входит во все N вызовов синхронно, ещё до того как любой из них уступит ход, —
 * перекрытие наблюдается всегда; последовательная реализация никогда не даёт `max > 1`.
 */
export class ConcurrencyProbeStore extends DelegatingAgentFileStore {
  readonly max: Record<ProbedMethod, number> = { stat: 0, list: 0, readFile: 0 };
  readonly total: Record<ProbedMethod, number> = { stat: 0, list: 0, readFile: 0 };
  /** Вызывается перед каждым `readFile` (счётчик промежуточных наблюдений задаёт тест). */
  onReadFile: (() => void) | undefined;

  private readonly inFlight: Record<ProbedMethod, number> = { stat: 0, list: 0, readFile: 0 };
  private armed = false;

  /** Включает уступку хода и обнуляет счётчики: подготовка сценария (первый импорт) замер не искажает. */
  arm(): void {
    this.armed = true;
    for (const method of ['stat', 'list', 'readFile'] as const) {
      this.max[method] = 0;
      this.total[method] = 0;
    }
  }

  override stat(rel: string): Promise<AgentFileEntry | undefined> {
    return this.track('stat', true, () => super.stat(rel));
  }

  override list(relDir: string, options?: { readonly recursive?: boolean }): Promise<AgentFileEntry[]> {
    return this.track('list', true, () => super.list(relDir, options));
  }

  override readFile(rel: string): Promise<Buffer> {
    this.onReadFile?.();
    return this.track('readFile', false, () => super.readFile(rel));
  }

  private async track<T>(method: ProbedMethod, hold: boolean, run: () => Promise<T>): Promise<T> {
    this.total[method] += 1;
    this.inFlight[method] += 1;
    this.max[method] = Math.max(this.max[method], this.inFlight[method]);
    try {
      if (hold && this.armed) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return await run();
    } finally {
      this.inFlight[method] -= 1;
    }
  }
}

// ── контекст стратегий ────────────────────────────────────────────────────────

export interface ContextFixture {
  readonly context: SyncOperationContext;
  readonly localExchange: LocalExchange;
  /** Сколько раз стратегия пометила M изменённым. */
  readonly mutations: { count: number };
}

/**
 * `SyncOperationContext` поверх стенда: для тестов отдельных стратегий (точечная выгрузка, посев,
 * сироты) без прохода через весь `AgentSyncEngine`. Каталог обмена и список, как у движка, —
 * `exchange/<operationId>` и `exchange/<operationId>.objects.txt`.
 */
export async function makeContext(
  h: SyncHarness,
  options: { readonly hooks?: AgentOperationHooks; readonly operationId?: string; readonly coverage?: 'full' | 'sparse' } = {}
): Promise<ContextFixture> {
  const workspaceService = new AgentWorkspaceService(h.store, buildAgentProjectId(h.projectRoot));
  const extensionName = h.targetKind === 'cfe' ? HARNESS_EXTENSION_NAME : undefined;
  const workspace = await workspaceService.ensureWorkspace(extensionName === undefined ? { kind: 'cf' } : { kind: 'cfe', extensionName });
  const operationId = options.operationId ?? `${h.targetKind}-test`;
  const localExchange = createLocalExchange(h.localExchangeRoot, operationId);
  const mutations = { count: 0 };
  const context: SyncOperationContext = {
    projectRoot: h.projectRoot,
    store: h.store,
    exec: h.exec,
    target: h.target,
    hooks: options.hooks,
    progress: createSyncProgress(options.hooks, () => 0),
    workspace,
    workspaceService,
    extensionName,
    manifest: h.manifest(),
    operationId,
    archiveThresholdFiles: 20_000,
    transferConcurrency: 4,
    localExchange,
    mirror: { coverage: options.coverage ?? 'sparse' },
    markMirrorMutated: () => { mutations.count += 1; },
  };
  return { context, localExchange, mutations };
}

// ── снимки каталогов ──────────────────────────────────────────────────────────

/** Путь → base64 содержимого: побайтное сравнение каталога до/после (в т.ч. двоичных файлов). */
export function snapshotDirBytes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string, rel: string): void => {
    if (!fs.existsSync(current)) {
      return;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), childRel);
      } else {
        out[childRel] = fs.readFileSync(path.join(current, entry.name)).toString('base64');
      }
    }
  };
  walk(dir, '');
  return out;
}

/** Файлы по маске имени под корнем (рекурсивно): staging `delta-*` в локальном обмене. */
export function findFilesNamed(root: string, pattern: RegExp): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    if (!fs.existsSync(current)) {
      return;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (pattern.test(entry.name)) {
        found.push(abs);
      }
    }
  };
  walk(root);
  return found;
}
