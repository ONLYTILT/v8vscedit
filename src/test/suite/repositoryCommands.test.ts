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
import { registerRepositoryCommands } from '../../ui/commands/repository/RepositoryCommands';
import { disposeRepositoryCommandStatusBar } from '../../ui/commands/repository/RepositoryCommandRunner';
import {
  endConfigurationOperation,
  isConfigurationOperationRunning,
  tryBeginConfigurationOperation,
} from '../../ui/commands/ext/configurationOperationLock';

/**
 * Обработчики команд хранилища, вызванные настоящим `registerRepositoryCommands`:
 * колбэки перехватываются на время регистрации (id уже занят самим расширением).
 *
 * Подмены (внешние/недоступные системы):
 *  - диалоги vscode.window — присваиванием, с восстановлением в teardown;
 *  - исполнитель Конфигуратора — через штатный шов `CommandServices.createDesignerExecutor`
 *    (платформа 1С недоступна); вектор, ушедший в исполнитель, проверяется буквально;
 *  - webview-формы подключения/помещения — объекты с `show`, возвращающие заданные данные.
 * RepositoryService, env.json и выгрузка — настоящие, во временном каталоге.
 */

type Handler = (node?: unknown) => Promise<void>;

function fakeSecretStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { map.delete(key); return Promise.resolve(); },
  };
}

const CONFIGURATION_XML =
  '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Configuration uuid="11111111-1111-1111-1111-111111111111"><Properties><Name>Основная</Name></Properties></Configuration></MetaDataObject>';

type PickAnswer = (items: readonly vscode.QuickPickItem[]) => unknown;

suite('RepositoryCommands — обработчики команд', () => {
  let root: string;
  let service: RepositoryService;
  let handlers: Map<string, Handler>;
  let rootNode: RepositoryNodeRef;
  let catalogNode: RepositoryNodeRef;
  let runs: DesignerBatchRequest[];
  let runResult: (request: DesignerBatchRequest) => DesignerBatchResult;
  let errors: string[];
  let warnings: string[];
  let infos: string[];
  let inputs: (string | undefined)[];
  let picks: PickAnswer[];
  let saveAnswers: (vscode.Uri | undefined)[];
  let saveOptions: vscode.SaveDialogOptions[];
  let connectionForm: { calls: unknown[][]; answer: unknown };
  let commitForm: { calls: unknown[][]; answer: unknown };
  let refreshes: number;
  let executorCalls: { v8Path: string; cwd: string }[];
  let lockDuringRun: boolean[];
  let changedConfigs: { rootPath: string; name: string; changedFilesCount: number }[];
  let outputLog: { line: string; locked: boolean }[];

  const w = vscode.window as unknown as Record<string, unknown>;
  const commandsRef = vscode.commands as unknown as { registerCommand: unknown };
  const saved: Record<string, unknown> = {};

  function rootXml(): string {
    assert.ok(rootNode.xmlPath);
    return rootNode.xmlPath;
  }

  function pickLabel(label: string): PickAnswer {
    return (items) => items.find((item) => item.label === label);
  }

  function pickMany(labels: string[]): PickAnswer {
    return (items) => items.filter((item) => labels.includes(item.label));
  }

  const PICK_CANCEL: PickAnswer = () => undefined;

  async function call(id: string, node: unknown = rootNode): Promise<void> {
    const handler = handlers.get(id);
    assert.ok(handler, `команда ${id} не зарегистрирована`);
    await handler(node);
  }

  function strings(request: DesignerBatchRequest): string[] {
    return request.args.filter((a): a is string => typeof a === 'string');
  }

  function valueAfter(request: DesignerBatchRequest, key: string): string | undefined {
    const args = strings(request);
    const idx = args.indexOf(key);
    return idx < 0 ? undefined : args[idx + 1];
  }

  setup(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-repo-cmds-')));
    const v8Path = path.join(root, process.platform === 'win32' ? '1cv8.exe' : '1cv8');
    fs.writeFileSync(v8Path, '');
    const cfRoot = path.join(root, 'src', 'cf');
    fs.mkdirSync(path.join(cfRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(cfRoot, 'Configuration.xml'), CONFIGURATION_XML);
    const catalogPath = path.join(cfRoot, 'Catalogs', 'Товары.xml');
    fs.writeFileSync(
      catalogPath,
      '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Catalog uuid="33333333-3333-3333-3333-333333333333"><Properties><Name>Товары</Name></Properties></Catalog></MetaDataObject>'
    );
    rootNode = { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(cfRoot, 'Configuration.xml') };
    catalogNode = { nodeKind: 'Catalog', label: 'Товары', xmlPath: catalogPath };

    fs.writeFileSync(path.join(root, 'env.json'), JSON.stringify({
      default: { '--ibconnection': `/F${path.join(root, 'base')}`, '--path': v8Path },
    }), 'utf-8');
    service = new RepositoryService(root, new ProjectSecretStorage(fakeSecretStore(), root));
    const target = service.resolveTargetByXmlPath(rootXml());
    assert.ok(target);
    await service.saveBinding(target, { repoPath: 'C:\\repo', repoUser: 'u', repoPassword: 'p' });

    runs = [];
    runResult = (request) => {
      const outputs = new Map<string, string>();
      for (const arg of request.args) {
        if (typeof arg !== 'string' && arg.kind === 'outputFile') {
          const staging = path.join(root, `staging-${arg.name}`);
          fs.writeFileSync(staging, `содержимое ${arg.name}`);
          outputs.set(arg.name, staging);
        }
      }
      return { exitCode: 0, log: '', outputs };
    };
    executorCalls = [];
    lockDuringRun = [];
    changedConfigs = [];
    outputLog = [];
    const fakeExecutor: DesignerBatchExecutor = {
      run: (request) => { runs.push(request); lockDuringRun.push(isConfigurationOperationRunning()); return Promise.resolve(runResult(request)); },
      dispose: () => Promise.resolve(),
    };

    errors = []; warnings = []; infos = [];
    inputs = []; picks = []; saveAnswers = []; saveOptions = [];
    refreshes = 0;
    connectionForm = { calls: [], answer: undefined };
    commitForm = { calls: [], answer: undefined };

    for (const key of ['showErrorMessage', 'showWarningMessage', 'showInformationMessage', 'showInputBox', 'showQuickPick', 'showSaveDialog']) {
      saved[key] = w[key];
    }
    w.showErrorMessage = (m: string) => { errors.push(m); return Promise.resolve(undefined); };
    w.showWarningMessage = (m: string) => { warnings.push(m); return Promise.resolve(undefined); };
    w.showInformationMessage = (m: string) => { infos.push(m); return Promise.resolve(undefined); };
    w.showInputBox = () => Promise.resolve(inputs.shift());
    w.showQuickPick = (items: readonly vscode.QuickPickItem[]) => {
      const answer = picks.shift();
      assert.ok(answer, 'неожиданный showQuickPick');
      return Promise.resolve(answer(items));
    };
    w.showSaveDialog = (options: vscode.SaveDialogOptions) => {
      saveOptions.push(options);
      return Promise.resolve(saveAnswers.shift());
    };

    const services = {
      workspaceFolder: { uri: vscode.Uri.file(root), name: 'cmds', index: 0 },
      outputChannel: {
        appendLine: (line: string) => { outputLog.push({ line, locked: isConfigurationOperationRunning() }); },
        show: () => undefined,
      } as unknown as vscode.OutputChannel,
      repositoryService: service,
      projectSecretStorage: new ProjectSecretStorage(fakeSecretStore(), root),
      treeProvider: { refresh: () => { refreshes += 1; } },
      refreshActionsView: () => undefined,
      getChangedConfigurations: () => Promise.resolve(changedConfigs),
      repositoryConnectionViewProvider: {
        show: (...args: unknown[]) => { connectionForm.calls.push(args); return Promise.resolve(connectionForm.answer); },
      },
      repositoryCommitViewProvider: {
        show: (...args: unknown[]) => { commitForm.calls.push(args); return Promise.resolve(commitForm.answer); },
      },
      createDesignerExecutor: (v8: string, cwd: string) => { executorCalls.push({ v8Path: v8, cwd }); return fakeExecutor; },
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
    for (const key of ['showErrorMessage', 'showWarningMessage', 'showInformationMessage', 'showInputBox', 'showQuickPick', 'showSaveDialog']) {
      w[key] = saved[key];
    }
    disposeRepositoryCommandStatusBar();
    fs.rmSync(root, { recursive: true, force: true });
  });

  suite('подключение и создание', () => {
    test('connect: узел не корень — предупреждение, исполнитель не вызван', async () => {
      await call('v8vscedit.repository.connect', catalogNode);
      assert.strictEqual(warnings.length, 1);
      assert.strictEqual(runs.length, 0);
    });

    test('connect: форма закрыта — ничего не запускается; форма получает сохранённую привязку', async () => {
      await call('v8vscedit.repository.connect');
      assert.strictEqual(connectionForm.calls.length, 1);
      assert.strictEqual(connectionForm.calls[0][0], 'connect');
      assert.deepStrictEqual(connectionForm.calls[0][2], { repoPath: 'C:\\repo', repoUser: 'u', repoPasswordSet: true });
      assert.strictEqual(runs.length, 0);
    });

    test('connect: невалидная форма — showErrorMessage, исполнитель не вызван', async () => {
      connectionForm.answer = { repoPath: '  ', repoUser: 'u', repoPassword: '' };
      await call('v8vscedit.repository.connect');
      assert.deepStrictEqual(errors, ['Нужно указать путь к хранилищу или адрес сервера.']);
      assert.strictEqual(runs.length, 0);
    });

    test('connect: флаги формы и привязка формы уходят в вектор (исполнитель вернул ошибку)', async () => {
      connectionForm.answer = {
        repoPath: ' \\\\srv\\repo ', repoUser: ' dev ', repoPassword: 'пароль',
        forceBindAlreadyBindedUser: true, forceReplaceCfg: true,
      };
      runResult = () => ({ exitCode: 1, log: '', outputs: new Map() });
      await call('v8vscedit.repository.connect');
      assert.strictEqual(runs.length, 1);
      // Фабрика из CommandServices дошла до раннера: исполнитель создан ровно один раз,
      // в каталоге проекта (а не в cwd процесса Extension Host).
      assert.deepStrictEqual(executorCalls.map((c) => c.cwd), [vscode.Uri.file(root).fsPath]);
      assert.strictEqual(path.basename(executorCalls[0].v8Path), process.platform === 'win32' ? '1cv8.exe' : '1cv8');
      const request = runs[0];
      assert.ok(strings(request).includes('/ConfigurationRepositoryBindCfg'));
      assert.ok(strings(request).includes('-forceBindAlreadyBindedUser'));
      assert.ok(strings(request).includes('-forceReplaceCfg'));
      assert.strictEqual(valueAfter(request, '/ConfigurationRepositoryF'), '\\\\srv\\repo');
      assert.strictEqual(valueAfter(request, '/ConfigurationRepositoryN'), 'dev');
      assert.strictEqual(valueAfter(request, '/ConfigurationRepositoryP'), 'пароль');
      assert.strictEqual(errors.length, 1);
    });

    test('create: форма закрыта и невалидная форма', async () => {
      await call('v8vscedit.repository.create');
      assert.strictEqual(connectionForm.calls[0][0], 'create');
      connectionForm.answer = { repoPath: 'p', repoUser: '', repoPassword: '' };
      await call('v8vscedit.repository.create');
      assert.deepStrictEqual(errors, ['Нужно указать пользователя хранилища.']);
      assert.strictEqual(runs.length, 0);
    });

    test('create: правила и noBind уходят в вектор; привязка сохраняется, подключение не включается', async () => {
      connectionForm.answer = {
        repoPath: 'NEW', repoUser: 'adm', repoPassword: 'pw',
        allowConfigurationChanges: true, changesAllowedRule: 'A', changesNotRecommendedRule: 'B', noBind: true,
      };
      await call('v8vscedit.repository.create');
      const request = runs[0];
      const args = strings(request);
      assert.ok(args.includes('/ConfigurationRepositoryCreate'));
      for (const key of ['-AllowConfigurationChanges', '-NoBind']) {
        assert.ok(args.includes(key), key);
      }
      assert.strictEqual(valueAfter(request, '-ChangesAllowedRule'), 'A');
      assert.strictEqual(valueAfter(request, '-ChangesNotRecommendedRule'), 'B');
      const target = service.resolveTargetByXmlPath(rootXml());
      assert.ok(target);
      assert.strictEqual(service.isConnected(target), false);
      assert.ok(refreshes > 0);
    });
  });

  suite('отключение и операции над узлом', () => {
    test('disconnect: отмена выбора — не запускается; force и штатно', async () => {
      picks.push(PICK_CANCEL);
      await call('v8vscedit.repository.disconnect');
      assert.strictEqual(runs.length, 0);

      picks.push(pickLabel('Принудительно'));
      await call('v8vscedit.repository.disconnect');
      assert.ok(strings(runs[0]).includes('/ConfigurationRepositoryUnbindCfg'));
      assert.ok(strings(runs[0]).includes('-force'));
      const target = service.resolveTargetByXmlPath(rootXml());
      assert.ok(target);
      assert.strictEqual(service.hasBinding(target), false);
    });

    test('disconnect: штатно — без -force', async () => {
      picks.push(pickLabel('Штатно'));
      await call('v8vscedit.repository.disconnect');
      assert.ok(!strings(runs[0]).includes('-force'));
    });

    test('disconnect: нет подключения — предупреждение', async () => {
      const target = service.resolveTargetByXmlPath(rootXml());
      assert.ok(target);
      await service.clearBinding(target);
      await call('v8vscedit.repository.disconnect');
      assert.strictEqual(warnings.length, 1);
      assert.strictEqual(runs.length, 0);
    });

    test('lock: узел без xmlPath, отмена, успех с обновлением UI', async () => {
      await call('v8vscedit.repository.lock', { nodeKind: 'Catalog' });
      assert.strictEqual(warnings.length, 1);
      picks.push(PICK_CANCEL);
      await call('v8vscedit.repository.lock', catalogNode);
      assert.strictEqual(runs.length, 0);
      picks.push(pickLabel('Рекурсивно'));
      await call('v8vscedit.repository.lock', catalogNode);
      assert.ok(strings(runs[0]).includes('/ConfigurationRepositoryLock'));
      // UI собирает список объектов сам и передаёт его строкой (байты — только у CLI).
      const objectsInput = runs[0].args.find(
        (arg): arg is Extract<typeof arg, { kind: 'inputFile' }> => typeof arg !== 'string' && arg.kind === 'inputFile'
      );
      assert.ok(objectsInput);
      assert.strictEqual(typeof objectsInput.content, 'string');
      assert.ok(String(objectsInput.content).includes('Товары'));
      assert.ok(refreshes > 0);
    });

    test('unlock: отмены на каждом шаге и успех с force', async () => {
      picks.push(PICK_CANCEL);
      await call('v8vscedit.repository.unlock', catalogNode);
      picks.push(pickLabel('Только выбранный объект'), PICK_CANCEL);
      await call('v8vscedit.repository.unlock', catalogNode);
      assert.strictEqual(runs.length, 0);
      picks.push(pickLabel('Только выбранный объект'), pickLabel('С force'));
      await call('v8vscedit.repository.unlock', catalogNode);
      assert.ok(strings(runs[0]).includes('-force'));
      await call('v8vscedit.repository.unlock', { nodeKind: 'Catalog' });
      assert.strictEqual(runs.length, 1);
    });

    test('commit: форма закрыта, пустой комментарий, успех', async () => {
      await call('v8vscedit.repository.commit', { nodeKind: 'Catalog' });
      assert.strictEqual(commitForm.calls.length, 0);
      await call('v8vscedit.repository.commit', catalogNode);
      assert.strictEqual(commitForm.calls.length, 1);
      assert.strictEqual(runs.length, 0);

      commitForm.answer = { recursive: false, comment: '   ', keepLocked: false, force: false };
      await call('v8vscedit.repository.commit', catalogNode);
      assert.ok(warnings.includes('Для помещения требуется комментарий.'));
      assert.strictEqual(runs.length, 0);

      commitForm.answer = { recursive: true, comment: 'Правка', keepLocked: true, force: false };
      await call('v8vscedit.repository.commit', catalogNode);
      assert.ok(strings(runs[0]).includes('/ConfigurationRepositoryCommit'));
      assert.strictEqual(valueAfter(runs[0], '-comment'), 'Правка');
      assert.ok(strings(runs[0]).includes('-keepLocked'));
    });

    test('update: отмены и версия с обрезкой пробелов; пустая версия не попадает в вектор', async () => {
      // Лог без «получен»: импорт в проект не запускается (он требует платформы 1С; сценарии импорта — repositoryUpdateCommand.test.ts).
      runResult = () => ({
        exitCode: 0,
        log: ['---- Начало операции с хранилищем конфигурации ----', '---- Операция с хранилищем конфигурации завершена ----'].join('\r\n'),
        outputs: new Map(),
      });
      picks.push(PICK_CANCEL);
      await call('v8vscedit.repository.update', catalogNode);
      picks.push(pickLabel('Рекурсивно'), PICK_CANCEL);
      await call('v8vscedit.repository.update', catalogNode);
      picks.push(pickLabel('Рекурсивно'), pickLabel('Без force'));
      inputs.push(undefined);
      await call('v8vscedit.repository.update', catalogNode);
      assert.strictEqual(runs.length, 0);

      picks.push(pickLabel('Рекурсивно'), pickLabel('С force'));
      inputs.push(' 125 ');
      await call('v8vscedit.repository.update', catalogNode);
      assert.strictEqual(valueAfter(runs[0], '-v'), '125');
      assert.ok(strings(runs[0]).includes('-force'));

      picks.push(pickLabel('Рекурсивно'), pickLabel('Без force'));
      inputs.push('   ');
      await call('v8vscedit.repository.update', catalogNode);
      assert.ok(!strings(runs[1]).includes('-v'));
      await call('v8vscedit.repository.update', { nodeKind: 'Catalog' });
      assert.strictEqual(runs.length, 2);
    });
  });

  suite('пользователи', () => {
    test('addUser: отмены на каждом шаге', async () => {
      await call('v8vscedit.repository.addUser', catalogNode);
      assert.strictEqual(warnings.length, 1);

      inputs.push(undefined);
      await call('v8vscedit.repository.addUser');
      inputs.push('user', undefined);
      await call('v8vscedit.repository.addUser');
      inputs.push('user', 'pwd');
      picks.push(PICK_CANCEL);
      await call('v8vscedit.repository.addUser');
      inputs.push('user', 'pwd');
      picks.push(pickLabel('ReadOnly'), PICK_CANCEL);
      await call('v8vscedit.repository.addUser');
      assert.strictEqual(runs.length, 0);
    });

    test('addUser: вектор операции; пароль не попадает в журнал вектора как открытый', async () => {
      inputs.push(' user ', ' pwd ');
      picks.push(pickLabel('LockObjects'), pickLabel('Да, восстановить'));
      await call('v8vscedit.repository.addUser');
      const request = runs[0];
      assert.ok(strings(request).includes('/ConfigurationRepositoryAddUser'));
      assert.strictEqual(valueAfter(request, '-User'), 'user');
      assert.strictEqual(valueAfter(request, '-Pwd'), 'pwd');
      assert.strictEqual(valueAfter(request, '-Rights'), 'LockObjects');
      assert.ok(strings(request).includes('-RestoreDeletedUser'));
      assert.ok(request.secrets.includes('pwd'));
    });

    test('copyUsers: отмены на каждом шаге и успех', async () => {
      await call('v8vscedit.repository.copyUsers', catalogNode);
      inputs.push(undefined);
      await call('v8vscedit.repository.copyUsers');
      inputs.push('src', undefined);
      await call('v8vscedit.repository.copyUsers');
      inputs.push('src', 'usr', undefined);
      await call('v8vscedit.repository.copyUsers');
      inputs.push('src', 'usr', 'pwd');
      picks.push(PICK_CANCEL);
      await call('v8vscedit.repository.copyUsers');
      assert.strictEqual(runs.length, 0);

      inputs.push('C:\\src-repo', 'usr', 'pwd');
      picks.push(pickLabel('Нет'));
      await call('v8vscedit.repository.copyUsers');
      const request = runs[0];
      assert.ok(strings(request).includes('/ConfigurationRepositoryCopyUsers'));
      assert.strictEqual(valueAfter(request, '-Path'), 'C:\\src-repo');
      assert.strictEqual(valueAfter(request, '-User'), 'usr');
      assert.ok(!strings(request).includes('-RestoreDeletedUser'));
    });
  });

  suite('выгрузка, отчёт, метка', () => {
    test('dump: отмены, имя файла по умолчанию без запрещённых символов, перенос на выбранный путь', async () => {
      await call('v8vscedit.repository.dump', catalogNode);
      saveAnswers.push(undefined);
      await call('v8vscedit.repository.dump');
      assert.ok(saveOptions[0].defaultUri?.fsPath.endsWith('Основная.cf'));

      const targetPath = path.join(root, 'выгрузка.cf');
      saveAnswers.push(vscode.Uri.file(targetPath));
      inputs.push(undefined);
      await call('v8vscedit.repository.dump');
      assert.strictEqual(runs.length, 0);

      saveAnswers.push(vscode.Uri.file(targetPath));
      inputs.push(' 7 ');
      await call('v8vscedit.repository.dump');
      assert.ok(strings(runs[0]).includes('/ConfigurationRepositoryDumpCfg'));
      assert.strictEqual(valueAfter(runs[0], '-v'), '7');
      assert.strictEqual(fs.readFileSync(targetPath, 'utf-8'), 'содержимое dump.cf');
      assert.ok(infos.some((m) => m.includes(vscode.Uri.file(targetPath).fsPath)));
    });

    test('report: отмены на каждом шаге', async () => {
      await call('v8vscedit.repository.report', catalogNode);
      picks.push(PICK_CANCEL);
      await call('v8vscedit.repository.report');

      const target = path.join(root, 'rep.txt');
      const steps: (() => void)[] = [
        () => { saveAnswers.push(undefined); },
        () => { saveAnswers.push(vscode.Uri.file(target)); inputs.push(undefined); },
        () => { saveAnswers.push(vscode.Uri.file(target)); inputs.push('1', undefined); },
        () => { saveAnswers.push(vscode.Uri.file(target)); inputs.push('1', '2', undefined); },
        () => { saveAnswers.push(vscode.Uri.file(target)); inputs.push('1', '2', 'd1', undefined); },
        () => { saveAnswers.push(vscode.Uri.file(target)); inputs.push('1', '2', 'd1', 'd2', undefined); },
        () => { saveAnswers.push(vscode.Uri.file(target)); inputs.push('1', '2', 'd1', 'd2', 'v'); },
      ];
      for (const [index, step] of steps.entries()) {
        picks.push(pickLabel('txt'));
        if (index === steps.length - 1) {
          picks.push(PICK_CANCEL);
        }
        step();
        await call('v8vscedit.repository.report');
      }
      assert.strictEqual(runs.length, 0);
    });

    for (const format of ['txt', 'mxl'] as const) {
      test(`report (${format}): расширение по умолчанию, флаги и перенос файла отчёта`, async () => {
        const targetPath = path.join(root, `отчёт.${format}`);
        picks.push(pickLabel(format), pickMany(['Группировать по объектам', 'Включить только версии с метками']));
        saveAnswers.push(vscode.Uri.file(targetPath));
        inputs.push(' 1 ', '2', 'd1', 'd2', ' ver ');
        await call('v8vscedit.repository.report');
        assert.ok(saveOptions[0].defaultUri?.fsPath.endsWith(`.${format}`));
        const request = runs[0];
        const args = strings(request);
        assert.ok(args.includes('/ConfigurationRepositoryReport'));
        assert.strictEqual(valueAfter(request, '-ReportFormat'), format);
        assert.strictEqual(valueAfter(request, '-NBegin'), '1');
        assert.strictEqual(valueAfter(request, '-ConfigurationVersion'), 'ver');
        assert.ok(args.includes('-GroupByObject'));
        assert.ok(args.includes('-IncludeOnlyVersionsWithLabels'));
        assert.ok(!args.includes('-GroupByComment'));
        // Staging-файл назван по формату (платформа видит то же расширение, что и раньше),
        // а пользователь получает файл по выбранному им пути.
        assert.ok(request.args.some((arg) => typeof arg !== 'string' && arg.kind === 'outputFile' && arg.name === `report.${format}`));
        assert.strictEqual(fs.readFileSync(targetPath, 'utf-8'), `содержимое report.${format}`);
      });
    }

    test('setLabel: отмены на каждом шаге и вектор', async () => {
      await call('v8vscedit.repository.setLabel', catalogNode);
      inputs.push(undefined);
      await call('v8vscedit.repository.setLabel');
      inputs.push('Метка', undefined);
      await call('v8vscedit.repository.setLabel');
      inputs.push('Метка', ' 3 ', undefined);
      await call('v8vscedit.repository.setLabel');
      assert.strictEqual(runs.length, 0);

      inputs.push('Метка', ' 3 ', ' коммент ');
      await call('v8vscedit.repository.setLabel');
      const request = runs[0];
      assert.ok(strings(request).includes('/ConfigurationRepositorySetLabel'));
      assert.strictEqual(valueAfter(request, '-name'), 'Метка');
      assert.strictEqual(valueAfter(request, '-v'), '3');
      assert.strictEqual(valueAfter(request, '-comment'), 'коммент');
    });
  });

  suite('Э4: общий замок операций над конфигурацией', () => {
    interface Scenario { readonly id: string; readonly node?: unknown; readonly prepare: () => void }
    // Каждая команда, доходящая до пакетного Конфигуратора. connect и update в успешной ветке запускают
    // фоновую пост-синхронизацию, поэтому сценарии ниже используют отказ исполнителя (exitCode 1):
    // замок и так должен сниматься и при отказе.
    const scenarios = (): Scenario[] => [
      { id: 'v8vscedit.repository.connect', prepare: () => { connectionForm.answer = { repoPath: 'p', repoUser: 'u', repoPassword: 'w' }; } },
      { id: 'v8vscedit.repository.create', prepare: () => { connectionForm.answer = { repoPath: 'p', repoUser: 'u', repoPassword: 'w' }; } },
      { id: 'v8vscedit.repository.disconnect', prepare: () => { picks.push(pickLabel('Штатно')); } },
      { id: 'v8vscedit.repository.lock', node: catalogNode, prepare: () => { picks.push(pickLabel('Рекурсивно')); } },
      { id: 'v8vscedit.repository.unlock', node: catalogNode, prepare: () => { picks.push(pickLabel('Только выбранный объект'), pickLabel('Без force')); } },
      { id: 'v8vscedit.repository.commit', node: catalogNode, prepare: () => { commitForm.answer = { recursive: true, comment: 'Правка', keepLocked: false, force: false }; } },
      { id: 'v8vscedit.repository.update', node: catalogNode, prepare: () => { picks.push(pickLabel('Рекурсивно'), pickLabel('Без force')); inputs.push(''); } },
      { id: 'v8vscedit.repository.addUser', prepare: () => { inputs.push('user', 'pwd'); picks.push(pickLabel('ReadOnly'), pickLabel('Нет')); } },
      { id: 'v8vscedit.repository.copyUsers', prepare: () => { inputs.push('C:\\src-repo', 'usr', 'pwd'); picks.push(pickLabel('Нет')); } },
      { id: 'v8vscedit.repository.dump', prepare: () => { saveAnswers.push(vscode.Uri.file(path.join(root, 'd.cf'))); inputs.push(''); } },
      { id: 'v8vscedit.repository.report', prepare: () => { picks.push(pickLabel('txt'), pickMany([])); saveAnswers.push(vscode.Uri.file(path.join(root, 'r.txt'))); inputs.push('', '', '', '', ''); } },
      { id: 'v8vscedit.repository.setLabel', prepare: () => { inputs.push('Метка', '3', 'к'); } },
    ];
    const ids = scenarios().map((s) => s.id);

    for (const id of ids) {
      test(`${id}: замок занят на время запуска и освобождён после (при отказе исполнителя тоже)`, async () => {
        runResult = () => ({ exitCode: 1, log: '', outputs: new Map() });
        const scenario = scenarios().find((s) => s.id === id);
        assert.ok(scenario);
        scenario.prepare();
        await call(id, scenario.node);
        assert.strictEqual(runs.length, 1, 'сценарий не дошёл до запуска исполнителя — подготовка теста неверна');
        assert.deepStrictEqual(lockDuringRun, [true], 'на время работы Конфигуратора замок должен быть занят');
        assert.strictEqual(isConfigurationOperationRunning(), false, 'после завершения замок обязан быть свободен');
      });

      test(`${id}: замок уже занят другой операцией — исполнитель не запускается, чужой замок не снимается, пользователь уведомлён`, async () => {
        const scenario = scenarios().find((s) => s.id === id);
        assert.ok(scenario);
        scenario.prepare();
        assert.strictEqual(await tryBeginConfigurationOperation(), true);
        await call(id, scenario.node);
        assert.strictEqual(runs.length, 0);
        assert.strictEqual(isConfigurationOperationRunning(), true, 'чужой замок не должен быть снят');
        assert.ok([...infos, ...warnings].some((m) => m.includes('уже выполняется')), [...infos, ...warnings].join('|'));
      });
    }

    test('замок освобождается и когда исполнитель бросает исключение', async () => {
      runResult = () => { throw new Error('исполнитель упал'); };
      const scenario = scenarios().find((s) => s.id === 'v8vscedit.repository.lock');
      assert.ok(scenario);
      scenario.prepare();
      await call(scenario.id, scenario.node);
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });

    test('успешная операция тоже освобождает замок (lock)', async () => {
      picks.push(pickLabel('Рекурсивно'));
      await call('v8vscedit.repository.lock', catalogNode);
      assert.deepStrictEqual(lockDuringRun, [true]);
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });

    test('B3: ошибка операции не держит замок, пока открыта нотификация об ошибке', async () => {
      runResult = () => ({ exitCode: 1, log: '', outputs: new Map() });
      let errorShown = false;
      // Нотификация «висит», пока пользователь её не закроет: промис не резолвится никогда.
      w.showErrorMessage = () => { errorShown = true; return new Promise(() => undefined); };
      picks.push(pickLabel('Рекурсивно'));
      await call('v8vscedit.repository.lock', catalogNode);
      assert.strictEqual(errorShown, true);
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });

    test('commit: форма помещения показывается ДО замка; узел без подписи и без полного имени', async () => {
      const lockWhileForm: boolean[] = [];
      commitForm.answer = undefined;
      const unlabeledRoot = { ...rootNode, label: undefined };
      const original = commitForm;
      commitForm = {
        calls: original.calls,
        get answer() { lockWhileForm.push(isConfigurationOperationRunning()); return undefined; },
      };
      await call('v8vscedit.repository.commit', unlabeledRoot);
      assert.deepStrictEqual(lockWhileForm, [false], 'форма не должна открываться под замком');
      // Подпись — имя конфигурации; у корня нет полного имени объекта → «не захвачен».
      assert.deepStrictEqual(original.calls[0], ['Основная', false]);
      assert.strictEqual(runs.length, 0);
    });

    test('commit: отказ от обязательного обновления перед помещением — ни формы, ни запуска, замок свободен', async () => {
      changedConfigs = [{ rootPath: path.dirname(rootXml()), name: 'Основная', changedFilesCount: 2 }];
      picks.push(pickLabel('$(close) Отменить помещение'));
      await call('v8vscedit.repository.commit', catalogNode);
      assert.strictEqual(commitForm.calls.length, 0);
      assert.strictEqual(runs.length, 0);
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });

    test('отмена в диалоге (до запуска) замок не занимает и не оставляет занятым', async () => {
      picks.push(PICK_CANCEL);
      await call('v8vscedit.repository.lock', catalogNode);
      assert.strictEqual(runs.length, 0);
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });
  });

  // Составные сценарии держат замок ОДНОЙ секцией: между шагами не может вклиниться другая
  // операция над той же базой. Шаг обновления/пост-синхронизации идёт через настоящий
  // внутренний CLI (платформа — пустая заглушка, поэтому CLI завершается отказом); момент его
  // старта наблюдается по строке журнала `[actions] Старт`, записанной под замком.
  suite('Э4: составные сценарии — один замок на весь сценарий', function () {
    this.timeout(120_000);

    function cliStarts(): { line: string; locked: boolean }[] {
      return outputLog.filter((entry) => entry.line.startsWith('[actions] Старт'));
    }

    test('commit с предварительным обновлением БД: обновление и помещение под одним замком', async () => {
      changedConfigs = [{ rootPath: path.dirname(rootXml()), name: 'Основная', changedFilesCount: 1 }];
      picks.push(pickLabel('$(sync) Обновить и продолжить'));
      commitForm.answer = { recursive: true, comment: 'Правка', keepLocked: false, force: false };

      await call('v8vscedit.repository.commit', catalogNode);

      assert.ok(cliStarts().length >= 1, 'шаг обновления БД не запускался');
      assert.ok(cliStarts().every((entry) => entry.locked), 'обновление перед помещением шло без замка');
      assert.ok(lockDuringRun.every((locked) => locked));
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });

    test('connect: подключение и пост-синхронизация с базой — под одним замком', async () => {
      connectionForm.answer = { repoPath: 'p', repoUser: 'u', repoPassword: 'w' };

      await call('v8vscedit.repository.connect');

      assert.deepStrictEqual(lockDuringRun, [true]);
      assert.ok(cliStarts().length >= 1, 'пост-синхронизация не запускалась');
      assert.ok(cliStarts().every((entry) => entry.locked), 'пост-синхронизация шла без замка');
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });

    test('create с подключением: пост-синхронизация под тем же замком; с noBind — без неё', async () => {
      connectionForm.answer = { repoPath: 'p', repoUser: 'u', repoPassword: 'w' };
      await call('v8vscedit.repository.create');
      assert.ok(cliStarts().length >= 1);
      assert.ok(cliStarts().every((entry) => entry.locked));
      assert.strictEqual(isConfigurationOperationRunning(), false);

      outputLog.length = 0;
      connectionForm.answer = { repoPath: 'p', repoUser: 'u', repoPassword: 'w', noBind: true };
      await call('v8vscedit.repository.create');
      assert.strictEqual(cliStarts().length, 0);
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });
  });
});
