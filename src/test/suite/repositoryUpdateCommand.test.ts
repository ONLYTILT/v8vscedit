import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type {
  DesignerBatchExecutor,
  DesignerBatchRequest,
  DesignerBatchResult,
} from '../../infra/process/designer/DesignerBatchExecutor';
import { RepositoryService, type RepositoryNodeRef } from '../../infra/repository/RepositoryService';
import type { CommandServices } from '../../ui/commands/_shared';
import * as extensionRunner from '../../ui/commands/ext/ExtensionCommandRunner';
import {
  endConfigurationOperation,
  isConfigurationOperationRunning,
  tryBeginConfigurationOperation,
} from '../../ui/commands/ext/configurationOperationLock';
import { disposeRepositoryCommandStatusBar } from '../../ui/commands/repository/RepositoryCommandRunner';
import { registerRepositoryCommands } from '../../ui/commands/repository/RepositoryCommands';
import {
  describeImportFailureAfterReceive,
  describeProjectBehindAfterReceive,
} from '../../ui/commands/repository/repositoryUpdateFlow';

/**
 * Команда `v8vscedit.repository.update` целиком: настоящие `registerRepositoryCommands`, RepositoryService,
 * env.json и выгрузка во временном каталоге. Подменяются только внешние системы: диалоги, исполнитель
 * Конфигуратора (шов `createDesignerExecutor`) и шаги «загрузка/импорт через агент или CLI»
 * (`runUpdate*`/`runDecompile*` — им нужна платформа 1С). Порядок вызовов фиксируется журналом `events`.
 */

type Handler = (node?: unknown) => Promise<void>;
type PickAnswer = (items: readonly vscode.QuickPickItem[]) => unknown;

const BEGIN = '---- Начало операции с хранилищем конфигурации ----';
const END = '---- Операция с хранилищем конфигурации завершена ----';
const DONE = 'Обновление конфигурации из хранилища успешно завершено';
const LOG_RECEIVED = [BEGIN, 'Объект получен из хранилища: Справочник.Товары', 'Объект получен из хранилища: ОбщийМодуль.Общий', END, DONE].join('\r\n');
const LOG_NOTHING_RECEIVED = [BEGIN, END, DONE].join('\r\n');

function fakeSecretStore(): SecretStore {
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

suite('v8vscedit.repository.update: получение, импорт по логу, вопрос при незагруженных правках', function () {
  this.timeout(60_000);
  const w = vscode.window as unknown as Record<string, unknown>;
  const commandsRef = vscode.commands as unknown as { registerCommand: unknown };
  const runnerRef = extensionRunner as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  const RUNNER_FUNCTIONS = ['runDecompileMainConfiguration', 'runDecompileExtension', 'runUpdateMainConfiguration', 'runUpdateExtension'];
  const WINDOW_FUNCTIONS = ['showErrorMessage', 'showWarningMessage', 'showInformationMessage', 'showQuickPick', 'showInputBox'];

  let root: string;
  let cfRoot: string;
  let cfeRoot: string;
  let service: RepositoryService;
  let handlers: Map<string, Handler>;
  let catalogNode: RepositoryNodeRef;
  let cfeCatalogNode: RepositoryNodeRef;
  let runs: DesignerBatchRequest[];
  let runResult: DesignerBatchResult;
  let events: string[];
  let lockHeldAt: Record<string, boolean>;
  let updateResult: boolean;
  let importResult: boolean;
  let warnings: string[];
  let infos: string[];
  let errors: string[];
  let picks: PickAnswer[];
  let pickItems: (readonly vscode.QuickPickItem[])[];
  let inputs: (string | undefined)[];
  let changed: { rootPath: string; name: string; changedFilesCount: number }[];
  let cleaned: string[][];
  let reloads: number;
  let refreshes: number;
  let warningNeverResolves: boolean;
  let importCalls: unknown[][];

  const pickLabel = (label: string): PickAnswer => (items) => items.find((item) => item.label === label);
  const pickById = (id: string): PickAnswer => (items) => items.find((item) => (item as { id?: string }).id === id);
  const PICK_ESC: PickAnswer = () => undefined;
  const RECURSIVE = pickLabel('Рекурсивно');
  const NO_FORCE = pickLabel('Без force');
  const WITH_FORCE = pickLabel('С force');

  const receiveArgs = (): string[] => runs[0].args.filter((arg): arg is string => typeof arg === 'string');

  /** Стандартные ответы на вопросы: рекурсия, force, версия (по умолчанию пустая), затем дополнительные. */
  function answerRequest(extra: PickAnswer[] = [], version: string | undefined = ''): void {
    picks.push(RECURSIVE, NO_FORCE, ...extra);
    inputs.push(version);
  }

  async function update(node: RepositoryNodeRef = catalogNode): Promise<void> {
    const handler = handlers.get('v8vscedit.repository.update');
    assert.ok(handler, 'команда update не зарегистрирована');
    await handler(node);
  }

  function setLog(log: string, exitCode = 0): void {
    runResult = { exitCode, log, outputs: new Map() };
  }

  setup(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-update-cmd-')));
    const v8Path = path.join(root, process.platform === 'win32' ? '1cv8.exe' : '1cv8');
    fs.writeFileSync(v8Path, '');
    cfRoot = path.join(root, 'src', 'cf');
    cfeRoot = path.join(root, 'src', 'cfe', 'Расш');
    for (const [dir, xml] of [[cfRoot, CF_XML], [cfeRoot, CFE_XML]] as const) {
      fs.mkdirSync(path.join(dir, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'Configuration.xml'), xml);
      fs.writeFileSync(path.join(dir, 'Catalogs', 'Товары.xml'), CATALOG_XML);
    }
    catalogNode = { nodeKind: 'Catalog', label: 'Товары', xmlPath: path.join(cfRoot, 'Catalogs', 'Товары.xml') };
    cfeCatalogNode = { nodeKind: 'Catalog', label: 'Товары', xmlPath: path.join(cfeRoot, 'Catalogs', 'Товары.xml') };
    fs.writeFileSync(path.join(root, 'env.json'), JSON.stringify({
      default: { '--ibconnection': `/F${path.join(root, 'base')}`, '--path': v8Path },
    }), 'utf-8');
    service = new RepositoryService(root, new ProjectSecretStorage(fakeSecretStore(), root));
    for (const dir of [cfRoot, cfeRoot]) {
      const target = service.resolveTargetByConfigRoot(dir);
      assert.ok(target);
      await service.saveBinding(target, { repoPath: 'C:\\repo', repoUser: 'u', repoPassword: 'p' });
    }

    runs = [];
    events = [];
    lockHeldAt = {};
    updateResult = true;
    importResult = true;
    warnings = []; infos = []; errors = [];
    picks = []; pickItems = []; inputs = [];
    changed = [];
    cleaned = [];
    reloads = 0;
    refreshes = 0;
    warningNeverResolves = false;
    importCalls = [];
    setLog(LOG_RECEIVED);

    const executor: DesignerBatchExecutor = {
      run: (request) => {
        runs.push(request);
        events.push('receive');
        lockHeldAt.receive = isConfigurationOperationRunning();
        return Promise.resolve(runResult);
      },
      dispose: () => Promise.resolve(),
    };

    for (const key of WINDOW_FUNCTIONS) {
      saved[key] = w[key];
    }
    for (const key of RUNNER_FUNCTIONS) {
      saved[key] = runnerRef[key];
    }
    w.showErrorMessage = (m: string) => { errors.push(m); return Promise.resolve(undefined); };
    w.showWarningMessage = (m: string) => {
      warnings.push(m);
      return warningNeverResolves ? new Promise(() => undefined) : Promise.resolve(undefined);
    };
    w.showInformationMessage = (m: string) => { infos.push(m); return Promise.resolve(undefined); };
    w.showInputBox = () => Promise.resolve(inputs.shift());
    w.showQuickPick = (items: readonly vscode.QuickPickItem[]) => {
      pickItems.push(items);
      const answer = picks.shift();
      assert.ok(answer, 'неожиданный showQuickPick');
      return Promise.resolve(answer(items));
    };
    runnerRef.runUpdateMainConfiguration = () => {
      events.push('update:cf');
      lockHeldAt['update:cf'] = isConfigurationOperationRunning();
      return Promise.resolve(updateResult);
    };
    runnerRef.runUpdateExtension = (...args: unknown[]) => {
      events.push(`update:cfe:${String(args[0])}`);
      lockHeldAt['update:cfe'] = isConfigurationOperationRunning();
      return Promise.resolve(updateResult);
    };
    runnerRef.runDecompileMainConfiguration = (...args: unknown[]) => {
      events.push('import:cf');
      lockHeldAt['import:cf'] = isConfigurationOperationRunning();
      importCalls.push(args);
      return Promise.resolve(importResult);
    };
    runnerRef.runDecompileExtension = (...args: unknown[]) => {
      events.push(`import:cfe:${String(args[0])}`);
      lockHeldAt['import:cfe'] = isConfigurationOperationRunning();
      importCalls.push(args);
      return Promise.resolve(importResult);
    };

    const services = {
      workspaceFolder: { uri: vscode.Uri.file(root), name: 'update-cmd', index: 0 },
      outputChannel: { appendLine: () => undefined, show: () => undefined } as unknown as vscode.OutputChannel,
      repositoryService: service,
      projectSecretStorage: new ProjectSecretStorage(fakeSecretStore(), root),
      treeProvider: { refresh: () => { refreshes += 1; } },
      refreshActionsView: () => undefined,
      getChangedConfigurations: () => Promise.resolve(changed),
      markConfigurationsClean: (roots: string[]) => { cleaned.push(roots); },
      reloadEntries: () => { reloads += 1; return Promise.resolve(); },
      createDesignerExecutor: () => executor,
    } as unknown as CommandServices;

    handlers = new Map();
    saved.registerCommand = commandsRef.registerCommand;
    commandsRef.registerCommand = (id: string, callback: Handler) => {
      handlers.set(id, callback);
      return { dispose: () => undefined };
    };
    try {
      registerRepositoryCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext, services);
    } finally {
      commandsRef.registerCommand = saved.registerCommand;
    }
  });

  teardown(async () => {
    await endConfigurationOperation();
    for (const key of WINDOW_FUNCTIONS) {
      w[key] = saved[key];
    }
    for (const key of RUNNER_FUNCTIONS) {
      runnerRef[key] = saved[key];
    }
    disposeRepositoryCommandStatusBar();
    fs.rmSync(root, { recursive: true, force: true });
  });

  suite('чистый проект', () => {
    test('в логе «получен»: получение, затем импорт цели cf в той же секции замка; проект помечен чистым, дерево перезагружено', async () => {
      answerRequest();

      await update();

      assert.deepStrictEqual(events, ['receive', 'import:cf']);
      assert.deepStrictEqual(lockHeldAt, { receive: true, 'import:cf': true });
      assert.strictEqual(importCalls.length, 1);
      assert.strictEqual(importCalls[0][0], 'Основная');
      assert.strictEqual(importCalls[0][1], cfRoot);
      assert.deepStrictEqual(cleaned, [[cfRoot]]);
      assert.strictEqual(reloads, 1);
      assert.ok(refreshes > 0);
      assert.deepStrictEqual(warnings, []);
      assert.strictEqual(pickItems.length, 2, 'вопросов только рекурсия и force');
      assert.strictEqual(isConfigurationOperationRunning(), false, 'замок освобождён');
    });

    test('цель cfe: импорт расширения с его именем', async () => {
      answerRequest();

      await update(cfeCatalogNode);

      assert.deepStrictEqual(events, ['receive', 'import:cfe:Расш']);
      assert.strictEqual(importCalls[0][1], cfeRoot);
      assert.deepStrictEqual(cleaned, [[cfeRoot]]);
    });

    test('лог без «получен»: импорта нет, тост успеха от раннера показан', async () => {
      setLog(LOG_NOTHING_RECEIVED);
      answerRequest();

      await update();

      assert.deepStrictEqual(events, ['receive']);
      assert.deepStrictEqual(cleaned, []);
      assert.strictEqual(infos.length, 1);
      assert.deepStrictEqual(warnings, []);
    });

    test('лог не распознан (иная версия платформы): импорт консервативно выполняется', async () => {
      setLog('');
      answerRequest();

      await update();

      assert.deepStrictEqual(events, ['receive', 'import:cf']);
    });

    test('получение упало (exit≠0): импорта нет, отметки нет, ошибка показана', async () => {
      setLog('Нет доступа к хранилищу', 1);
      answerRequest();

      await update();

      assert.deepStrictEqual(events, ['receive']);
      assert.deepStrictEqual(cleaned, []);
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });
  });

  suite('вопросы и вектор аргументов', () => {
    test('Esc на рекурсии: ничего не запускается', async () => {
      picks.push(PICK_ESC);

      await update();

      assert.deepStrictEqual(events, []);
    });

    test('Esc на force: ничего не запускается', async () => {
      picks.push(RECURSIVE, PICK_ESC);

      await update();

      assert.deepStrictEqual(events, []);
    });

    test('Esc на версии: ничего не запускается', async () => {
      picks.push(RECURSIVE, NO_FORCE);
      inputs.push(undefined);

      await update();

      assert.deepStrictEqual(events, []);
    });

    test('-force и -v <версия> попадают в вектор; версия обрезается по пробелам', async () => {
      picks.push(RECURSIVE, WITH_FORCE);
      inputs.push(' 125 ');

      await update();

      const args = receiveArgs();
      assert.ok(args.includes('/ConfigurationRepositoryUpdateCfg'));
      assert.ok(args.includes('-force'));
      assert.strictEqual(args[args.indexOf('-v') + 1], '125');
    });

    test('пустая версия и «Без force»: ни -v, ни -force в векторе', async () => {
      answerRequest([], '   ');

      await update();

      const args = receiveArgs();
      assert.ok(!args.includes('-v'));
      assert.ok(!args.includes('-force'));
    });

    test('узел без подписи: вопрос о рекурсии задаётся (подпись по умолчанию), Esc — ничего не запускается', async () => {
      picks.push(PICK_ESC);

      await update({ nodeKind: catalogNode.nodeKind, xmlPath: catalogNode.xmlPath });

      assert.strictEqual(pickItems.length, 1);
      assert.deepStrictEqual(events, []);
    });
  });

  suite('незагруженные правки проекта — вопрос до замка', () => {
    const dirty = (): void => { changed = [{ rootPath: cfRoot, name: 'Основная', changedFilesCount: 2 }]; };

    test('вопрос из трёх пунктов (update-then-receive, receive-without-import, cancel) в этом порядке; замок во время вопроса свободен; cancel — ничего не запущено', async () => {
      dirty();
      answerRequest([(items) => {
        assert.strictEqual(isConfigurationOperationRunning(), false, 'вопрос задаётся ДО замка');
        return items.find((item) => (item as { id?: string }).id === 'cancel');
      }]);

      await update();

      assert.strictEqual(pickItems.length, 3);
      const items = pickItems[2];
      assert.deepStrictEqual(items.map((item) => (item as { id?: string }).id), ['update-then-receive', 'receive-without-import', 'cancel']);
      assert.ok(items[0].label.startsWith('$(sync) Загрузить правки в базу, затем получить'), items[0].label);
      assert.ok(items[1].label.startsWith('$(cloud-download) Получить, проект не обновлять'), items[1].label);
      assert.deepStrictEqual(events, []);
    });

    test('Esc в вопросе: ничего не запущено', async () => {
      dirty();
      answerRequest([PICK_ESC]);

      await update();

      assert.deepStrictEqual(events, []);
    });

    test('update-then-receive: порядок update → receive → import; всё под одним замком', async () => {
      dirty();
      answerRequest([pickById('update-then-receive')]);

      await update();

      assert.deepStrictEqual(events, ['update:cf', 'receive', 'import:cf']);
      assert.deepStrictEqual(lockHeldAt, { 'update:cf': true, receive: true, 'import:cf': true });
      // Чистым корень помечают и загрузка в базу, и импорт после получения.
      assert.deepStrictEqual(cleaned, [[cfRoot], [cfRoot]]);
    });

    test('update-then-receive, цель cfe: загрузка и импорт расширения', async () => {
      changed = [{ rootPath: cfeRoot, name: 'Расш', changedFilesCount: 1 }];
      answerRequest([pickById('update-then-receive')]);

      await update(cfeCatalogNode);

      assert.deepStrictEqual(events, ['update:cfe:Расш', 'receive', 'import:cfe:Расш']);
    });

    test('update-then-receive, сбой загрузки в базу: получения нет, импорта нет', async () => {
      dirty();
      updateResult = false;
      answerRequest([pickById('update-then-receive')]);

      await update();

      assert.deepStrictEqual(events, ['update:cf']);
      assert.strictEqual(runs.length, 0);
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });

    test('receive-without-import и «получен» в логе: импорта нет, предупреждение «проект не обновлён» без await', async () => {
      dirty();
      warningNeverResolves = true;
      answerRequest([pickById('receive-without-import')]);

      await update();

      assert.deepStrictEqual(events, ['receive']);
      assert.deepStrictEqual(warnings, [describeProjectBehindAfterReceive('Основная')]);
      assert.strictEqual(isConfigurationOperationRunning(), false, 'команда завершилась, хотя предупреждение «открыто» (запрет №18)');
    });

    test('receive-without-import, лог без «получен»: предупреждения нет', async () => {
      dirty();
      setLog(LOG_NOTHING_RECEIVED);
      answerRequest([pickById('receive-without-import')]);

      await update();

      assert.deepStrictEqual(events, ['receive']);
      assert.deepStrictEqual(warnings, []);
    });

    test('проект чист у этой цели: вопроса нет, даже если изменена другая конфигурация', async () => {
      changed = [{ rootPath: cfeRoot, name: 'Расш', changedFilesCount: 5 }];
      answerRequest();

      await update();

      assert.strictEqual(pickItems.length, 2);
      assert.deepStrictEqual(events, ['receive', 'import:cf']);
    });
  });

  suite('сбой импорта, замок, разрешение узла', () => {
    test('импорт вернул false: предупреждение describeImportFailureAfterReceive без await, проект не помечен чистым', async () => {
      importResult = false;
      warningNeverResolves = true;
      answerRequest();

      await update();

      assert.deepStrictEqual(events, ['receive', 'import:cf']);
      assert.deepStrictEqual(warnings, [describeImportFailureAfterReceive('Основная')]);
      assert.deepStrictEqual(cleaned, []);
      assert.strictEqual(reloads, 0);
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });

    test('замок удерживается на импорте: параллельная секция получает отказ', async () => {
      const attempts: boolean[] = [];
      runnerRef.runDecompileMainConfiguration = async () => {
        events.push('import:cf');
        attempts.push(await tryBeginConfigurationOperation());
        return true;
      };
      answerRequest();

      await update();

      assert.deepStrictEqual(attempts, [false]);
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });

    test('замок занят другой операцией: получение не запускается', async () => {
      assert.strictEqual(await tryBeginConfigurationOperation(), true);
      answerRequest();

      await update();

      assert.deepStrictEqual(events, []);
      assert.strictEqual(isConfigurationOperationRunning(), true, 'чужой замок не снят');
    });

    test('узел без xmlPath: предупреждение, ничего не запускается', async () => {
      await update({ nodeKind: 'Catalog' });

      assert.strictEqual(warnings.length, 1);
      assert.deepStrictEqual(events, []);
      assert.strictEqual(pickItems.length, 0);
    });

    test('xmlPath вне корней конфигураций: ничего не запускается, вопросов нет', async () => {
      await update({ nodeKind: 'Catalog', label: 'Чужой', xmlPath: path.join(os.tmpdir(), 'вне-проекта', 'Catalogs', 'Чужой.xml') });

      assert.deepStrictEqual(events, []);
      assert.strictEqual(pickItems.length, 0);
    });

    test('хранилище не подключено: предупреждение о подключении, ничего не запускается', async () => {
      const bareRoot = path.join(root, 'src', 'cfe', 'Безхранилища');
      fs.mkdirSync(path.join(bareRoot, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(bareRoot, 'Configuration.xml'), CFE_XML.replace('Расш', 'Безхранилища'));
      fs.writeFileSync(path.join(bareRoot, 'Catalogs', 'Товары.xml'), CATALOG_XML);

      await update({ nodeKind: 'Catalog', label: 'Товары', xmlPath: path.join(bareRoot, 'Catalogs', 'Товары.xml') });

      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes('нет активного подключения к хранилищу'), warnings[0]);
      assert.deepStrictEqual(events, []);
      assert.strictEqual(pickItems.length, 0);
    });
  });
});
