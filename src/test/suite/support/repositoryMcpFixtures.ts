/**
 * Общая обвязка тестов цепочек хранилища и MCP-инструментов хранилища: настоящие RepositoryService,
 * env.json, выгрузки cf/cfe и state.json во временном каталоге. Подменяются только внешние системы:
 * исполнитель Конфигуратора (шов `createDesignerExecutor`), шаги «загрузка/импорт/применение к базе»
 * (`runUpdate*`/`runDecompile*`/`runApplyDatabaseConfiguration` — им нужна платформа 1С) и окна
 * сообщений (в тестовом хосте не закрываются, а их отсутствие — проверяемый контракт MCP).
 * Порядок вызовов фиксирует журнал `events`.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SecretStore } from '../../../infra/ai/AiSecretStorage';
import { ProjectSecretStorage } from '../../../infra/environment/ProjectSecretStorage';
import type {
  DesignerBatchExecutor,
  DesignerBatchRequest,
  DesignerBatchResult,
} from '../../../infra/process/designer/DesignerBatchExecutor';
import { RepositoryService, type RepositoryNodeRef, type RepositoryTarget } from '../../../infra/repository/RepositoryService';
import type { CommandServices } from '../../../ui/commands/_shared';
import * as extensionRunner from '../../../ui/commands/ext/ExtensionCommandRunner';
import { endConfigurationOperation, isConfigurationOperationRunning } from '../../../ui/commands/ext/configurationOperationLock';
import { disposeRepositoryCommandStatusBar } from '../../../ui/commands/repository/RepositoryCommandRunner';
import { MetadataNode } from '../../../ui/tree/TreeNode';
import { removeTreeSync } from './tempTree';

export const BEGIN = '---- Начало операции с хранилищем конфигурации ----';
export const END = '---- Операция с хранилищем конфигурации завершена ----';

/** Лог операции хранилища: маркеры начала/конца и итоговая строка платформы между ними. */
export function opLog(done: string, ...lines: string[]): string {
  return [BEGIN, ...lines, END, done].join('\r\n');
}
export const LOCK_DONE = 'Захват объектов в хранилище успешно завершен';
export const UNLOCK_DONE = 'Отмена захвата объектов в хранилище успешно завершена';
export const COMMIT_DONE = 'Помещение изменений объектов в хранилище успешно завершено';
export const UPDATE_DONE = 'Обновление конфигурации из хранилища успешно завершено';

export function fakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

const CF_XML =
  '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Configuration uuid="11111111-1111-1111-1111-111111111111"><Properties><Name>Основная</Name></Properties></Configuration></MetaDataObject>';
const CFE_XML =
  '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Configuration uuid="22222222-2222-2222-2222-222222222222"><Properties><Name>Расш</Name><ConfigurationExtensionPurpose>Customization</ConfigurationExtensionPurpose></Properties></Configuration></MetaDataObject>';
const CATALOG_XML =
  '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Catalog uuid="33333333-3333-3333-3333-333333333333"><Properties><Name>Товары</Name></Properties></Catalog></MetaDataObject>';

export const ROOT_LOCK_CF = '__configuration_root__';
export const ROOT_LOCK_CFE = '__extension_root__';

export interface ChangedConfigurationStub {
  rootPath: string;
  name: string;
  changedFilesCount: number;
}

export interface RepoProject {
  readonly root: string;
  readonly cfRoot: string;
  readonly cfeRoot: string;
  readonly service: RepositoryService;
  readonly cfTarget: RepositoryTarget;
  readonly cfeTarget: RepositoryTarget;
  readonly services: CommandServices;
  /** Плоские ссылки на узлы (для chains/runner). */
  readonly refs: {
    readonly catalog: RepositoryNodeRef;
    readonly cfeCatalog: RepositoryNodeRef;
    readonly cfRoot: RepositoryNodeRef;
    readonly cfeRoot: RepositoryNodeRef;
  };
  /** Узлы дерева (для MCP; `label` — строка, `textLabel` совпадает). */
  readonly nodes: {
    readonly catalog: MetadataNode;
    readonly cfeCatalog: MetadataNode;
    readonly cfRoot: MetadataNode;
    readonly cfeRoot: MetadataNode;
    readonly child: MetadataNode;
  };
  runs: DesignerBatchRequest[];
  events: string[];
  /** Удерживался ли общий замок в момент события (`repo:lock`, `import:cf`, …). */
  lockHeldAt: Record<string, boolean>;
  changed: ChangedConfigurationStub[];
  cleaned: string[][];
  reloads: number;
  refreshes: number;
  actionViewRefreshes: number;
  suppressCalls: string[][];
  markChangedCalls: string[][];
  disposedExecutors: number;
  importCalls: unknown[][];
  applyCalls: unknown[][];
  /** Результат исполнителя для ЛЮБОЙ операции хранилища. */
  result: DesignerBatchResult;
  updateResult: boolean;
  importResult: boolean;
  applyResult: boolean;
  toasts: { readonly kind: string; readonly message: string }[];
  setResult(log: string, exitCode?: number, extra?: Partial<DesignerBatchResult>): void;
  /** Вектор аргументов первого запуска (только строки; файлы -Objects заменены на их структуру). */
  args(index?: number): DesignerBatchRequest['args'];
  /** Захват из учёта: `service.setLocked(target, names, true)`. */
  lock(names: string[], target?: RepositoryTarget): void;
  /** Подключённое хранилище без привязки: каталог расширения БЕЗ `--repo-path`. */
  addUnboundExtension(name: string): { node: MetadataNode; ref: RepositoryNodeRef; target: RepositoryTarget };
  dispose(): Promise<void>;
}

const RUNNER_FUNCTIONS = [
  'runDecompileMainConfiguration',
  'runDecompileExtension',
  'runUpdateMainConfiguration',
  'runUpdateExtension',
  'runApplyDatabaseConfiguration',
  'runApplyDatabaseConfigurationWithOutcome',
] as const;
const WINDOW_FUNCTIONS = ['showErrorMessage', 'showWarningMessage', 'showInformationMessage', 'showQuickPick', 'showInputBox'] as const;

function repositoryOperationOf(args: readonly unknown[]): string {
  // Прочие операции хранилища (выгрузка версии и т.п.) журналируются своим именем: раннер общий для всех.
  // Ключи подключения к хранилищу (F/N/P) операцией не являются.
  const marker = args.find((arg): arg is string => typeof arg === 'string' && /^\/ConfigurationRepository(?![FNP]$)\w+$/.test(arg));
  assert.ok(marker, 'в векторе нет операции хранилища');
  const map: Partial<Record<string, string>> = {
    '/ConfigurationRepositoryLock': 'lock',
    '/ConfigurationRepositoryUnLock': 'unlock',
    '/ConfigurationRepositoryCommit': 'commit',
    '/ConfigurationRepositoryUpdateCfg': 'update',
  };
  return map[marker] ?? marker.slice('/ConfigurationRepository'.length).toLowerCase();
}

export async function createRepoProject(): Promise<RepoProject> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-repo-mcp-')));
  const v8Path = path.join(root, process.platform === 'win32' ? '1cv8.exe' : '1cv8');
  fs.writeFileSync(v8Path, '');
  const cfRoot = path.join(root, 'src', 'cf');
  const cfeRoot = path.join(root, 'src', 'cfe', 'Расш');
  for (const [dir, xml] of [[cfRoot, CF_XML], [cfeRoot, CFE_XML]] as const) {
    fs.mkdirSync(path.join(dir, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Configuration.xml'), xml);
    fs.writeFileSync(path.join(dir, 'Catalogs', 'Товары.xml'), CATALOG_XML);
  }
  fs.writeFileSync(path.join(root, 'env.json'), JSON.stringify({
    default: { '--ibconnection': `/F${path.join(root, 'base')}`, '--path': v8Path },
  }), 'utf-8');

  const secrets = new ProjectSecretStorage(fakeSecretStore(), root);
  const service = new RepositoryService(root, secrets);
  const cfTarget = service.resolveTargetByConfigRoot(cfRoot);
  const cfeTarget = service.resolveTargetByConfigRoot(cfeRoot);
  assert.ok(cfTarget && cfeTarget);
  for (const target of [cfTarget, cfeTarget]) {
    await service.saveBinding(target, { repoPath: 'C:\\repo', repoUser: 'u', repoPassword: 'p' });
  }

  const catalogXml = path.join(cfRoot, 'Catalogs', 'Товары.xml');
  const cfeCatalogXml = path.join(cfeRoot, 'Catalogs', 'Товары.xml');
  const node = (model: ConstructorParameters<typeof MetadataNode>[0]): MetadataNode =>
    new MetadataNode(model, vscode.TreeItemCollapsibleState.None);

  const project: RepoProject = {
    root, cfRoot, cfeRoot, service, cfTarget, cfeTarget,
    services: undefined as unknown as CommandServices,
    refs: {
      catalog: { nodeKind: 'Catalog', label: 'Товары', xmlPath: catalogXml },
      cfeCatalog: { nodeKind: 'Catalog', label: 'Товары', xmlPath: cfeCatalogXml },
      cfRoot: { nodeKind: 'configuration', label: 'Основная', xmlPath: path.join(cfRoot, 'Configuration.xml') },
      cfeRoot: { nodeKind: 'extension', label: 'Расш', xmlPath: path.join(cfeRoot, 'Configuration.xml') },
    },
    nodes: {
      catalog: node({ label: 'Товары', nodeKind: 'Catalog', xmlPath: catalogXml }),
      cfeCatalog: node({ label: 'Товары', nodeKind: 'Catalog', xmlPath: cfeCatalogXml }),
      cfRoot: node({ label: 'Основная', nodeKind: 'configuration', xmlPath: path.join(cfRoot, 'Configuration.xml') }),
      cfeRoot: node({ label: 'Расш', nodeKind: 'extension', xmlPath: path.join(cfeRoot, 'Configuration.xml') }),
      child: node({
        label: 'Артикул',
        nodeKind: 'Attribute',
        xmlPath: catalogXml,
        metaContext: { rootMetaKind: 'Catalog', ownerObjectXmlPath: catalogXml },
      } as never),
    },
    runs: [], events: [], lockHeldAt: {}, changed: [], cleaned: [],
    reloads: 0, refreshes: 0, actionViewRefreshes: 0, suppressCalls: [], markChangedCalls: [],
    disposedExecutors: 0, importCalls: [], applyCalls: [],
    result: { exitCode: 0, log: '', outputs: new Map() },
    updateResult: true, importResult: true, applyResult: true,
    toasts: [],
    setResult(log, exitCode = 0, extra = {}) {
      project.result = { exitCode, log, outputs: new Map(), ...extra };
    },
    args(index = 0) {
      return project.runs[index].args;
    },
    lock(names, target = cfTarget) {
      service.setLocked(target, names, true);
    },
    addUnboundExtension(name) {
      const dir = path.join(root, 'src', 'cfe', name);
      fs.mkdirSync(path.join(dir, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'Configuration.xml'), CFE_XML.replace('<Name>Расш</Name>', `<Name>${name}</Name>`));
      const xml = path.join(dir, 'Configuration.xml');
      const target = service.resolveTargetByConfigRoot(dir);
      assert.ok(target);
      return {
        node: node({ label: name, nodeKind: 'extension', xmlPath: xml }),
        ref: { nodeKind: 'extension', label: name, xmlPath: xml },
        target,
      };
    },
    async dispose() {
      if (isConfigurationOperationRunning()) {
        await endConfigurationOperation();
      }
      for (const key of WINDOW_FUNCTIONS) {
        w[key] = saved[key];
      }
      for (const key of RUNNER_FUNCTIONS) {
        runnerRef[key] = saved[key];
      }
      disposeRepositoryCommandStatusBar();
      removeTreeSync(root);
    },
  };

  const executor: DesignerBatchExecutor = {
    run: (request) => {
      const op = repositoryOperationOf(request.args);
      project.runs.push(request);
      project.events.push(`repo:${op}`);
      project.lockHeldAt[`repo:${op}`] = isConfigurationOperationRunning();
      return Promise.resolve(project.result);
    },
    dispose: () => { project.disposedExecutors += 1; return Promise.resolve(); },
  };

  const w = vscode.window as unknown as Record<string, unknown>;
  const runnerRef = extensionRunner as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  for (const key of WINDOW_FUNCTIONS) {
    saved[key] = w[key];
  }
  for (const key of RUNNER_FUNCTIONS) {
    saved[key] = runnerRef[key];
  }
  const toast = (kind: string) => (message: string) => { project.toasts.push({ kind, message }); return Promise.resolve(undefined); };
  w.showErrorMessage = toast('error');
  w.showWarningMessage = toast('warning');
  w.showInformationMessage = toast('info');
  w.showInputBox = () => { throw new Error('неожиданный showInputBox'); };
  w.showQuickPick = () => { throw new Error('неожиданный showQuickPick'); };

  const held = (event: string): void => { project.lockHeldAt[event] = isConfigurationOperationRunning(); };
  runnerRef.runUpdateMainConfiguration = () => { project.events.push('update:cf'); held('update:cf'); return Promise.resolve(project.updateResult); };
  runnerRef.runUpdateExtension = (...args: unknown[]) => {
    const event = `update:cfe:${String(args[0])}`;
    project.events.push(event); held(event);
    return Promise.resolve(project.updateResult);
  };
  runnerRef.runDecompileMainConfiguration = (...args: unknown[]) => {
    project.events.push('import:cf'); held('import:cf'); project.importCalls.push(args);
    return Promise.resolve(project.importResult);
  };
  runnerRef.runDecompileExtension = (...args: unknown[]) => {
    const event = `import:cfe:${String(args[0])}`;
    project.events.push(event); held(event); project.importCalls.push(args);
    return Promise.resolve(project.importResult);
  };
  runnerRef.runApplyDatabaseConfiguration = (...args: unknown[]) => {
    const target = args[0] as { kind: string; extensionName?: string };
    const event = target.kind === 'cfe' ? `apply:cfe:${String(target.extensionName)}` : 'apply:cf';
    project.events.push(event); held(event); project.applyCalls.push(args);
    return Promise.resolve(project.applyResult);
  };
  // MCP `update_database_configuration` берёт исход применения (предупреждения сверки): та же запись событий.
  runnerRef.runApplyDatabaseConfigurationWithOutcome = async (...args: unknown[]) => ({
    success: await (runnerRef.runApplyDatabaseConfiguration as (...a: unknown[]) => Promise<boolean>)(...args),
    warnings: [],
  });

  (project as { services: CommandServices }).services = {
    workspaceFolder: { uri: vscode.Uri.file(root), name: 'repo-mcp', index: 0 },
    outputChannel: { appendLine: () => undefined, show: () => undefined } as unknown as vscode.OutputChannel,
    repositoryService: service,
    projectSecretStorage: secrets,
    treeProvider: { refresh: () => { project.refreshes += 1; } },
    refreshActionsView: () => { project.actionViewRefreshes += 1; },
    getChangedConfigurations: () => Promise.resolve(project.changed),
    markConfigurationsClean: (roots: string[]) => { project.cleaned.push(roots); },
    reloadEntries: () => { project.reloads += 1; return Promise.resolve(); },
    suppressConfigurationReloadForFiles: (files: string[]) => { project.suppressCalls.push(files); },
    markChangedConfigurationByFiles: (files: string[]) => { project.markChangedCalls.push(files); },
    createDesignerExecutor: () => executor,
  } as unknown as CommandServices;

  return project;
}

/** Хвост вектора, начиная с операции хранилища (`/ConfigurationRepository…` без F/N/P). */
export function operationTail(args: readonly unknown[]): unknown[] {
  const index = args.findIndex((arg) => typeof arg === 'string' && /^\/ConfigurationRepository(Lock|UnLock|Commit|UpdateCfg)$/.test(arg));
  assert.ok(index >= 0, 'в векторе нет операции хранилища');
  return args.slice(index);
}
