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
import { importTargetFromDatabase, loadTargetChangesIntoDatabase, runPostRepositorySync } from '../../ui/commands/repository/repositoryPostSync';
import { FakeLagRecorder } from './support/databaseLagFakes';
import { describeImportFailureAfterLock, describeProjectBehindAfterLock } from '../../ui/commands/repository/repositoryLockFlow';

/**
 * Команда `v8vscedit.repository.lock` целиком (поправки Э14, plan-repo-lock-revised.md §1.4/§1.8):
 * настоящие `registerRepositoryCommands`, RepositoryService, env.json и выгрузка во временном каталоге.
 * Подменяются только внешние системы: диалоги, исполнитель Конфигуратора (шов `createDesignerExecutor`) и
 * шаги «загрузка/импорт конфигурации через агент или CLI» (`runUpdate*`/`runDecompile*` — им нужна платформа 1С).
 * Порядок вызовов фиксируется общим журналом `events`.
 */

type Handler = (node?: unknown) => Promise<void>;
type PickAnswer = (items: readonly vscode.QuickPickItem[]) => unknown;

const BEGIN = '---- Начало операции с хранилищем конфигурации ----';
const END = '---- Операция с хранилищем конфигурации завершена ----';
const DONE = 'Захват объектов в хранилище успешно завершен';
const LOG_RECEIVED = [BEGIN, 'Объект получен из хранилища: Справочник.Товары', 'Объект захвачен для редактирования: Справочник.Товары', END, DONE].join('\r\n');
const LOG_LOCKED_ONLY = [BEGIN, 'Объект захвачен для редактирования: Справочник.Товары', END, DONE].join('\r\n');
const LOG_EXT_RECEIVED = [BEGIN, 'Объект получен из хранилища: Справочник.Товары', 'Объект захвачен для редактирования: Справочник.Товары', END, DONE].join('\r\n');

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

suite('v8vscedit.repository.lock: захват, импорт по логу, вопрос при незагруженных правках (Э14)', function () {
  this.timeout(60_000);
  const w = vscode.window as unknown as Record<string, unknown>;
  const commandsRef = vscode.commands as unknown as { registerCommand: unknown };
  const runnerRef = extensionRunner as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  const RUNNER_FUNCTIONS = ['runDecompileMainConfiguration', 'runDecompileExtension', 'runUpdateMainConfiguration', 'runUpdateExtension', 'runApplyDatabaseConfiguration'];

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

  const lockArgs = (): string[] => runs[0].args.filter((arg): arg is string => typeof arg === 'string');

  async function setRevisedSetting(value: boolean | undefined): Promise<void> {
    await vscode.workspace.getConfiguration('v8vscedit.repository').update('getRevisedOnLock', value, vscode.ConfigurationTarget.Global);
  }

  async function setUpdateDatabaseSetting(value: boolean | undefined): Promise<void> {
    await vscode.workspace.getConfiguration('v8vscedit.configuration').update('updateDatabaseAfterLoad', value, vscode.ConfigurationTarget.Global);
  }

  async function lock(node: RepositoryNodeRef = catalogNode): Promise<void> {
    const handler = handlers.get('v8vscedit.repository.lock');
    assert.ok(handler, 'команда lock не зарегистрирована');
    await handler(node);
  }

  function setLog(log: string, exitCode = 0): void {
    runResult = { exitCode, log, outputs: new Map() };
  }

  setup(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-lock-cmd-')));
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
    picks = []; pickItems = [];
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
        events.push('lock');
        lockHeldAt.lock = isConfigurationOperationRunning();
        return Promise.resolve(runResult);
      },
      dispose: () => Promise.resolve(),
    };

    for (const key of ['showErrorMessage', 'showWarningMessage', 'showInformationMessage', 'showQuickPick']) {
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
    w.showQuickPick = (items: readonly vscode.QuickPickItem[]) => {
      pickItems.push(items);
      const answer = picks.shift();
      assert.ok(answer, 'неожиданный showQuickPick');
      return Promise.resolve(answer(items));
    };
    runnerRef.runUpdateMainConfiguration = (...args: unknown[]) => {
      events.push('update:cf');
      lockHeldAt['update:cf'] = isConfigurationOperationRunning();
      importCalls.push(args);
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
      workspaceFolder: { uri: vscode.Uri.file(root), name: 'lock-cmd', index: 0 },
      outputChannel: { appendLine: () => undefined, show: () => undefined } as unknown as vscode.OutputChannel,
      repositoryService: service,
      projectSecretStorage: new ProjectSecretStorage(fakeSecretStore(), root),
      treeProvider: { refresh: () => { refreshes += 1; } },
      refreshActionsView: () => undefined,
      getChangedConfigurations: () => Promise.resolve(changed),
      markConfigurationsClean: (roots: string[]) => { cleaned.push(roots); },
      reloadEntries: () => { reloads += 1; return Promise.resolve(); },
      createDesignerExecutor: () => executor,
      databaseConfigLag: new FakeLagRecorder(),
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
    await setRevisedSetting(undefined);
  });

  teardown(async () => {
    await endConfigurationOperation();
    for (const key of ['showErrorMessage', 'showWarningMessage', 'showInformationMessage', 'showQuickPick']) {
      w[key] = saved[key];
    }
    for (const key of RUNNER_FUNCTIONS) {
      runnerRef[key] = saved[key];
    }
    await setRevisedSetting(undefined);
    await setUpdateDatabaseSetting(undefined);
    disposeRepositoryCommandStatusBar();
    fs.rmSync(root, { recursive: true, force: true });
  });

  suite('чистый проект', () => {
    test('настройка по умолчанию (true): вектор с -revised, затем импорт цели cf один раз в той же секции замка; проект помечен чистым, дерево перезагружено', async () => {
      picks.push(RECURSIVE);

      await lock();

      assert.ok(lockArgs().includes('-revised'));
      assert.deepStrictEqual(events, ['lock', 'import:cf']);
      assert.deepStrictEqual(lockHeldAt, { lock: true, 'import:cf': true });
      assert.strictEqual(importCalls.length, 1);
      assert.strictEqual(importCalls[0][0], 'Основная');
      assert.strictEqual(importCalls[0][1], cfRoot);
      assert.deepStrictEqual(cleaned, [[cfRoot]]);
      assert.strictEqual(reloads, 1);
      assert.ok(refreshes > 0);
      assert.deepStrictEqual(warnings, []);
      assert.strictEqual(isConfigurationOperationRunning(), false, 'замок освобождён');
    });

    test('цель cfe: импорт расширения с его именем', async () => {
      setLog(LOG_EXT_RECEIVED);
      picks.push(RECURSIVE);

      await lock(cfeCatalogNode);

      assert.ok(lockArgs().includes('-revised'));
      assert.deepStrictEqual(events, ['lock', 'import:cfe:Расш']);
      assert.strictEqual(importCalls[0][1], cfeRoot);
      assert.deepStrictEqual(cleaned, [[cfeRoot]]);
    });

    test('настройка false, в логе есть «получен» (платформа сама получила версию): без -revised, импорт ЕСТЬ', async () => {
      await setRevisedSetting(false);
      picks.push(RECURSIVE);

      await lock();

      assert.ok(!lockArgs().includes('-revised'));
      assert.deepStrictEqual(events, ['lock', 'import:cf']);
      assert.deepStrictEqual(pickItems.length, 1, 'вопроса нет, спрашивали только про рекурсию');
    });

    test('настройка false, лог без «получен»: без -revised, импорта нет; тост успеха от раннера показан', async () => {
      await setRevisedSetting(false);
      setLog(LOG_LOCKED_ONLY);
      picks.push(RECURSIVE);

      await lock();

      assert.ok(!lockArgs().includes('-revised'));
      assert.deepStrictEqual(events, ['lock']);
      assert.deepStrictEqual(cleaned, []);
      assert.strictEqual(infos.length, 1);
    });

    test('настройка true, лог без «получен» (объект в хранилище не менялся): импорта нет, тост захвата показан', async () => {
      setLog(LOG_LOCKED_ONLY);
      picks.push(RECURSIVE);

      await lock();

      assert.ok(lockArgs().includes('-revised'));
      assert.deepStrictEqual(events, ['lock']);
      assert.deepStrictEqual(cleaned, []);
      assert.strictEqual(infos.length, 1);
    });

    test('лог не распознан (иная версия платформы): импорт консервативно выполняется', async () => {
      setLog('');
      picks.push(RECURSIVE);

      await lock();

      assert.deepStrictEqual(events, ['lock', 'import:cf']);
    });

    test('захват не удался (exit≠0): импорта нет, отметки нет, ошибка показана', async () => {
      setLog('Объект захвачен другим пользователем', 1);
      picks.push(RECURSIVE);

      await lock();

      assert.deepStrictEqual(events, ['lock']);
      assert.strictEqual(errors.length, 1);
      const target = service.resolveTargetByConfigRoot(cfRoot);
      assert.ok(target);
      assert.strictEqual(service.isLocked(target, 'Справочник.Товары'), false);
    });

    test('отмена выбора рекурсии: ничего не запускается', async () => {
      picks.push(PICK_ESC);

      await lock();

      assert.deepStrictEqual(events, []);
    });

    test('узел без xmlPath: предупреждение, ничего не запускается', async () => {
      await lock({ nodeKind: 'Catalog' });

      assert.strictEqual(warnings.length, 1);
      assert.deepStrictEqual(events, []);
    });
  });

  suite('незагруженные правки проекта — вопрос до замка', () => {
    const dirty = (): void => { changed = [{ rootPath: cfRoot, name: 'Основная', changedFilesCount: 2 }]; };

    for (const setting of [true, false]) {
      test(`настройка=${String(setting)}: задаётся вопрос из трёх пунктов (update-then-lock, lock-without-import, cancel); замок во время вопроса свободен`, async () => {
        await setRevisedSetting(setting);
        dirty();
        picks.push(RECURSIVE);
        picks.push((items) => {
          assert.strictEqual(isConfigurationOperationRunning(), false, 'вопрос задаётся ДО замка');
          return items.find((item) => (item as { id?: string }).id === 'cancel');
        });

        await lock();

        assert.strictEqual(pickItems.length, 2);
        const items = pickItems[1];
        assert.deepStrictEqual(items.map((item) => (item as { id?: string }).id), ['update-then-lock', 'lock-without-import', 'cancel']);
        assert.ok(items[0].label.startsWith('$(sync) Загрузить правки в базу, затем захватить'), items[0].label);
        assert.ok(items[1].label.startsWith('$(lock) Захватить, проект не обновлять'), items[1].label);
        assert.deepStrictEqual(events, [], 'cancel — ничего не запущено');
      });
    }

    test('update-then-lock: порядок update → lock → import; всё под одним замком; revised = настройка', async () => {
      dirty();
      picks.push(RECURSIVE, pickById('update-then-lock'));

      await lock();

      assert.deepStrictEqual(events, ['update:cf', 'lock', 'import:cf']);
      assert.deepStrictEqual(lockHeldAt, { 'update:cf': true, lock: true, 'import:cf': true });
      assert.ok(lockArgs().includes('-revised'));
      assert.ok(cleaned.length >= 1);
    });

    test('update-then-lock при отключённой настройке: -revised не передаётся, импорт по логу есть', async () => {
      await setRevisedSetting(false);
      dirty();
      picks.push(RECURSIVE, pickById('update-then-lock'));

      await lock();

      assert.deepStrictEqual(events, ['update:cf', 'lock', 'import:cf']);
      assert.ok(!lockArgs().includes('-revised'));
    });

    test('update-then-lock, цель cfe: обновление и импорт расширения', async () => {
      changed = [{ rootPath: cfeRoot, name: 'Расш', changedFilesCount: 1 }];
      picks.push(RECURSIVE, pickById('update-then-lock'));

      await lock(cfeCatalogNode);

      assert.deepStrictEqual(events, ['update:cfe:Расш', 'lock', 'import:cfe:Расш']);
    });

    test('update-then-lock, сбой загрузки в базу: захвата нет, импорта нет', async () => {
      dirty();
      updateResult = false;
      picks.push(RECURSIVE, pickById('update-then-lock'));

      await lock();

      assert.deepStrictEqual(events, ['update:cf']);
      assert.strictEqual(runs.length, 0);
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });

    test('lock-without-import: без -revised и без обновления БД; при «получен» в логе — предупреждение «проект не обновлён» без await; импорта нет', async () => {
      dirty();
      warningNeverResolves = true;
      picks.push(RECURSIVE, pickById('lock-without-import'));

      await lock();

      assert.deepStrictEqual(events, ['lock']);
      assert.ok(!lockArgs().includes('-revised'));
      assert.deepStrictEqual(warnings, [describeProjectBehindAfterLock('Основная')]);
      assert.strictEqual(isConfigurationOperationRunning(), false, 'команда завершилась, хотя предупреждение «открыто» (запрет №18)');
    });

    test('lock-without-import, лог без «получен»: предупреждения нет', async () => {
      dirty();
      setLog(LOG_LOCKED_ONLY);
      picks.push(RECURSIVE, pickById('lock-without-import'));

      await lock();

      assert.deepStrictEqual(events, ['lock']);
      assert.deepStrictEqual(warnings, []);
    });

    const SETTING_NOTE = 'конфигурация БД не обновляется';
    for (const setting of [true, false]) {
      test(`настройка updateDatabaseAfterLoad=${String(setting)}: в detail пункта загрузки ${setting ? 'нет' : 'есть'} пояснения «${SETTING_NOTE} — настройка updateDatabaseAfterLoad»; пунктов по-прежнему три`, async () => {
        await setUpdateDatabaseSetting(setting);
        dirty();
        picks.push(RECURSIVE, PICK_ESC);

        await lock();

        const items = pickItems[1];
        assert.strictEqual(items.length, 3, 'пунктов не добавлено');
        const detail = items[0].detail ?? '';
        assert.strictEqual(detail.includes(SETTING_NOTE) && detail.includes('updateDatabaseAfterLoad'), !setting, detail);
      });

      test(`update-then-lock при updateDatabaseAfterLoad=${String(setting)}: раннер загрузки получает updateDatabase=${String(setting)} и признак отставания из services`, async () => {
        await setUpdateDatabaseSetting(setting);
        dirty();
        picks.push(RECURSIVE, pickById('update-then-lock'));

        await lock();

        assert.deepStrictEqual(events.slice(0, 2), ['update:cf', 'lock']);
        const options = importCalls[0][6] as { updateDatabase: boolean; lag: unknown };
        assert.strictEqual(options.updateDatabase, setting);
        assert.ok(options.lag instanceof FakeLagRecorder, 'передан services.databaseConfigLag');
      });
    }

    test('Esc в вопросе: ничего не запущено', async () => {
      dirty();
      picks.push(RECURSIVE, PICK_ESC);

      await lock();

      assert.deepStrictEqual(events, []);
    });

    test('проект чист (0 изменённых файлов у этой цели): вопроса нет даже если изменена другая конфигурация', async () => {
      changed = [{ rootPath: cfeRoot, name: 'Расш', changedFilesCount: 5 }];
      picks.push(RECURSIVE);

      await lock();

      assert.strictEqual(pickItems.length, 1);
      assert.deepStrictEqual(events, ['lock', 'import:cf']);
    });
  });

  suite('сбой импорта и замок', () => {
    test('импорт вернул false: отметки захвата сохранены, предупреждение describeImportFailureAfterLock без await, проект не помечен чистым', async () => {
      importResult = false;
      warningNeverResolves = true;
      picks.push(RECURSIVE);

      await lock();

      assert.deepStrictEqual(events, ['lock', 'import:cf']);
      assert.deepStrictEqual(warnings, [describeImportFailureAfterLock('Основная')]);
      assert.deepStrictEqual(cleaned, []);
      assert.strictEqual(reloads, 0);
      const target = service.resolveTargetByConfigRoot(cfRoot);
      assert.ok(target);
      assert.strictEqual(service.isLocked(target, 'Справочник.Товары'), true, 'в хранилище захват есть — отметка остаётся');
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });

    test('замок: во время захвата и импорта параллельная секция получает отказ — одна секция на lock+import', async () => {
      const attempts: boolean[] = [];
      runnerRef.runDecompileMainConfiguration = async () => {
        events.push('import:cf');
        attempts.push(await tryBeginConfigurationOperation());
        return true;
      };
      picks.push(RECURSIVE);

      await lock();

      assert.deepStrictEqual(attempts, [false], 'замок удерживается на импорте');
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });

    test('замок уже занят другой операцией: захват не запускается', async () => {
      assert.strictEqual(await tryBeginConfigurationOperation(), true);
      picks.push(RECURSIVE);

      await lock();

      assert.deepStrictEqual(events, []);
      assert.strictEqual(isConfigurationOperationRunning(), true, 'чужой замок не снят');
    });
  });
  suite('разрешение узла в цель и пост-синхронизация', () => {
    test('xmlPath вне корней конфигураций: цель не разрешается, ничего не запускается, замок не берётся', async () => {
      await lock({ nodeKind: 'Catalog', label: 'Чужой', xmlPath: path.join(os.tmpdir(), 'вне-проекта', 'Catalogs', 'Чужой.xml') });

      assert.deepStrictEqual(events, []);
      assert.strictEqual(pickItems.length, 0, 'про рекурсию не спрашивали');
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });

    test('цель есть, но хранилище не подключено: предупреждение о подключении, ничего не запускается', async () => {
      const bareRoot = path.join(root, 'src', 'cfe', 'Безхранилища');
      fs.mkdirSync(path.join(bareRoot, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(bareRoot, 'Configuration.xml'), CFE_XML.replace('Расш', 'Безхранилища'));
      fs.writeFileSync(path.join(bareRoot, 'Catalogs', 'Товары.xml'), CATALOG_XML);

      await lock({ nodeKind: 'Catalog', label: 'Товары', xmlPath: path.join(bareRoot, 'Catalogs', 'Товары.xml') });

      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes('нет активного подключения к хранилищу'), warnings[0]);
      assert.deepStrictEqual(events, []);
      assert.strictEqual(pickItems.length, 0);
    });

    for (const failure of ['throw-error', 'throw-string'] as const) {
      test(`runPostRepositorySync: сбой применения конфигурации (${failure}) пишется в лог с префиксом и не пробрасывается`, async () => {
        const lines: string[] = [];
        runnerRef.runApplyDatabaseConfiguration = () => {
          events.push('apply');
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- проверяем и нe-Error исключение
          throw failure === 'throw-error' ? new Error('сбой платформы') : 'сбой строкой';
        };
        const target = service.resolveTargetByConfigRoot(cfRoot);
        assert.ok(target);
        const services = {
          workspaceFolder: { uri: vscode.Uri.file(root), name: 'lock-cmd', index: 0 },
          outputChannel: { appendLine: (line: string) => { lines.push(line); } },
        } as unknown as CommandServices;

        await runPostRepositorySync(target, services);

        assert.deepStrictEqual(events, ['apply']);
        assert.deepStrictEqual(lines, [`[repository][post-sync][error] ${failure === 'throw-error' ? 'сбой платформы' : 'сбой строкой'}`]);
      });
    }

    test('runPostRepositorySync: сбой импорта (decompile бросает) тоже логируется, исключение не пробрасывается', async () => {
      const lines: string[] = [];
      runnerRef.runApplyDatabaseConfiguration = () => Promise.resolve(true);
      runnerRef.runDecompileMainConfiguration = () => Promise.reject(new Error('импорт упал'));
      const target = service.resolveTargetByConfigRoot(cfRoot);
      assert.ok(target);
      const services = {
        workspaceFolder: { uri: vscode.Uri.file(root), name: 'lock-cmd', index: 0 },
        outputChannel: { appendLine: (line: string) => { lines.push(line); } },
      } as unknown as CommandServices;

      await runPostRepositorySync(target, services);

      assert.deepStrictEqual(lines, ['[repository][post-sync][error] импорт упал']);
    });

    test('узел без подписи: вопрос о рекурсии всё равно задаётся (подпись по умолчанию), Esc — ничего не запускается', async () => {
      picks.push(PICK_ESC);

      await lock({ nodeKind: catalogNode.nodeKind, xmlPath: catalogNode.xmlPath });

      assert.strictEqual(pickItems.length, 1);
      assert.deepStrictEqual(events, []);
    });

    test('цель cfe без extensionName: обновление и импорт идут по отображаемому имени', async () => {
      const cfeTarget = service.resolveTargetByConfigRoot(cfeRoot);
      assert.ok(cfeTarget);
      const bare = { ...cfeTarget, extensionName: undefined, displayName: 'ПоИмени' };
      updateResult = false;
      importResult = false;
      const services = {
        workspaceFolder: { uri: vscode.Uri.file(root), name: 'lock-cmd', index: 0 },
        outputChannel: { appendLine: () => undefined },
        databaseConfigLag: new FakeLagRecorder(),
      } as unknown as CommandServices;

      assert.strictEqual(await loadTargetChangesIntoDatabase(bare, services, { updateDatabase: true, interaction: 'interactive' }), false);
      assert.strictEqual(await importTargetFromDatabase(bare, services, { interaction: 'interactive' }), false);

      assert.deepStrictEqual(events, ['update:cfe:ПоИмени', 'import:cfe:ПоИмени']);
    });
  });
});
