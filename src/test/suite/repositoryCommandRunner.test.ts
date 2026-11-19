import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import { RepositoryService, type RepositoryNodeRef } from '../../infra/repository/RepositoryService';
import type {
  DesignerBatchExecutor,
  DesignerBatchRequest,
  DesignerBatchResult,
} from '../../infra/process/designer/DesignerBatchExecutor';
import { disposeCachedAgentOperationServices } from '../../ui/commands/ext/agent/AgentServiceRegistry';
import { agentError } from './support/agentInfoBaseFakes';
import { seedCachedAgentService } from './support/agentRegistrySeed';
import {
  disposeRepositoryCommandStatusBar,
  resolveRepositoryTarget,
  runRepositoryCliCommand,
  runRepositoryCommitAction,
  runRepositoryLockAction,
  runRepositoryUnlockAction,
  runRepositoryUpdateAction,
  setRepositoryOperationStatus,
  type RepositoryCliServices,
} from '../../ui/commands/repository/RepositoryCommandRunner';

/**
 * Интеграционные тесты раннера хранилища в Extension Host. Подмены:
 *  - исполнитель пакетного конфигуратора (платформа 1С — внешняя недоступная система);
 *  - OutputChannel — приёмник с настоящим накоплением строк (реальный канал не собрать без панели);
 *  - SecretStorage — in-memory хранилище под настоящим ProjectSecretStorage;
 *  - show*Message — модальные уведомления в тестовом хосте не закрываются, а раннер
 *    делает `await showErrorMessage`, то есть без подмены тест зависнул бы.
 * RepositoryService, env.json, state.json и выгрузка — настоящие, во временном каталоге.
 */

const DB_PASSWORD = 'db-secret-пароль';
const REPO_PASSWORD = 'repo-secret-пароль';
const REPO_USER = 'repo-user-name';

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

function catalogXml(name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Catalog uuid="33333333-3333-3333-3333-333333333333"><Properties><Name>${name}</Name></Properties></Catalog></MetaDataObject>`;
}

type Behavior = (request: DesignerBatchRequest) => Promise<DesignerBatchResult>;

suite('RepositoryCommandRunner', () => {
  let root: string;
  let service: RepositoryService;
  let services: RepositoryCliServices;
  let lines: string[];
  let disposed: number;
  let requests: DesignerBatchRequest[];
  let behavior: Behavior;
  let errors: string[];
  let infos: string[];
  let v8Path: string;
  let fabricatedV8Paths: string[];
  let catalogNode: RepositoryNodeRef;
  let target: NonNullable<ReturnType<typeof resolveRepositoryTarget>>;

  const windowRef = vscode.window as unknown as {
    showErrorMessage: unknown;
    showInformationMessage: unknown;
  };
  let origError: unknown;
  let origInfo: unknown;

  function ok(partial: Partial<DesignerBatchResult> = {}): Promise<DesignerBatchResult> {
    return Promise.resolve({ exitCode: 0, log: '', outputs: new Map(), ...partial });
  }

  function writeEnv(defaults: Record<string, unknown>): void {
    fs.writeFileSync(path.join(root, 'env.json'), JSON.stringify({ default: defaults }), 'utf-8');
  }

  function validEnv(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      '--ibconnection': `/F${path.join(root, 'base')}`,
      '--db-user': 'dbuser',
      '--db-pwd': DB_PASSWORD,
      '--path': v8Path,
      '--repo-path': 'C:\\repo-storage',
      '--repo-user': REPO_USER,
      ...extra,
    };
  }

  function runOptions(overrides: Partial<Parameters<typeof runRepositoryCliCommand>[0]> = {}): Parameters<typeof runRepositoryCliCommand>[0] {
    return {
      operation: { kind: 'unbind' },
      target,
      progressTitle: 'Тест',
      progressStartMessage: 'старт',
      successMessage: 'Готово',
      errorTitle: 'Ошибка теста',
      ...overrides,
    };
  }

  setup(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-repo-runner-')));
    v8Path = path.join(root, process.platform === 'win32' ? '1cv8.exe' : '1cv8');
    fs.writeFileSync(v8Path, '');
    const cfRoot = path.join(root, 'src', 'cf');
    fs.mkdirSync(path.join(cfRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(cfRoot, 'Configuration.xml'), CONFIGURATION_XML);
    const catalogPath = path.join(cfRoot, 'Catalogs', 'Товары.xml');
    fs.writeFileSync(catalogPath, catalogXml('Товары'));
    catalogNode = { nodeKind: 'Catalog', label: 'Товары', xmlPath: catalogPath };

    service = new RepositoryService(root, new ProjectSecretStorage(fakeSecretStore(), root));
    const resolved = resolveRepositoryTarget(service, catalogNode);
    assert.ok(resolved);
    target = resolved;
    await service.saveBinding(target, { repoPath: 'C:\\repo-storage', repoUser: REPO_USER, repoPassword: REPO_PASSWORD });
    writeEnv(validEnv());

    lines = [];
    disposed = 0;
    requests = [];
    fabricatedV8Paths = [];
    behavior = () => ok();
    services = {
      workspaceFolder: { uri: vscode.Uri.file(root), name: 'runner-test', index: 0 },
      outputChannel: { appendLine: (m: string) => { lines.push(m); } } as unknown as vscode.OutputChannel,
      repositoryService: service,
      projectSecretStorage: new ProjectSecretStorage(fakeSecretStore(), root),
      createDesignerExecutor: (p): DesignerBatchExecutor => {
        fabricatedV8Paths.push(p);
        return {
          run: (request) => { requests.push(request); return behavior(request); },
          dispose: () => { disposed += 1; return Promise.resolve(); },
        };
      },
    };

    errors = [];
    infos = [];
    origError = windowRef.showErrorMessage;
    origInfo = windowRef.showInformationMessage;
    windowRef.showErrorMessage = (m: string) => { errors.push(m); return Promise.resolve(undefined); };
    windowRef.showInformationMessage = (m: string) => { infos.push(m); return Promise.resolve(undefined); };
  });

  teardown(() => {
    windowRef.showErrorMessage = origError;
    windowRef.showInformationMessage = origInfo;
    disposeRepositoryCommandStatusBar();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Ошибки подключения к базе: раннер возвращает false через catch? Нет — они бросаются ДО try.

  suite('подключение к базе', () => {
    test('нет env.json', async () => {
      fs.rmSync(path.join(root, 'env.json'));
      await assert.rejects(() => runRepositoryCliCommand(runOptions(), services), /Не найден env\.json/);
      assert.strictEqual(disposed, 0);
    });

    test('нет --ibconnection', async () => {
      writeEnv({ '--repo-path': 'C:\\repo-storage' });
      await assert.rejects(() => runRepositoryCliCommand(runOptions(), services), /отсутствует "--ibconnection"/);
    });

    test('--ibconnection не разбирается', async () => {
      writeEnv(validEnv({ '--ibconnection': 'garbage' }));
      await assert.rejects(() => runRepositoryCliCommand(runOptions(), services), /Не удалось разобрать/);
    });

    test('/S без слэша не разбирается', async () => {
      writeEnv(validEnv({ '--ibconnection': '/Sserver' }));
      await assert.rejects(() => runRepositoryCliCommand(runOptions(), services), /Не удалось разобрать/);
    });

    test('/S со слэшем: серверная база, кавычки по краям снимаются', async () => {
      writeEnv(validEnv({ '--ibconnection': '"/Ssrv/dbname"' }));
      await runRepositoryCliCommand(runOptions(), services);
      const args = requests[0].args;
      const idx = args.indexOf('/S');
      assert.ok(idx > 0);
      assert.strictEqual(args[idx + 1], 'srv/dbname');
    });

    test('/F: файловая база', async () => {
      await runRepositoryCliCommand(runOptions(), services);
      const args = requests[0].args;
      assert.strictEqual(args[args.indexOf('/F') + 1], path.join(root, 'base'));
      assert.ok(args.includes('/Ndbuser'));
    });

    test('v8Path берётся из --v8version, если --path не задан', async () => {
      // Версия платформы без установленной 1С не разрешится в путь — это ожидаемая ошибка поиска.
      writeEnv(validEnv({ '--path': undefined, '--v8version': '8.3.99.9999' }));
      await assert.rejects(() => runRepositoryCliCommand(runOptions(), services));
    });

    test('env.json без секции default: нет --ibconnection', async () => {
      fs.writeFileSync(path.join(root, 'env.json'), '{}', 'utf-8');
      await assert.rejects(() => runRepositoryCliCommand(runOptions(), services), /отсутствует "--ibconnection"/);
    });

    test('ни --path, ни --v8version: платформа ищется по умолчанию', async () => {
      writeEnv(validEnv({ '--path': undefined }));
      // Результат зависит от наличия 1С на машине: найдена — запуск идёт через фабрику,
      // нет — понятная ошибка поиска. Проверяется только отсутствие обращения к --v8version.
      try {
        await runRepositoryCliCommand(runOptions(), services);
        assert.strictEqual(requests.length, 1);
      } catch (error) {
        assert.match((error as Error).message, /исполняемый файл 1С/);
      }
    });

    test('нет --db-user и --db-pwd: подключение без учётных данных', async () => {
      writeEnv(validEnv({ '--db-user': undefined, '--db-pwd': undefined }));
      await runRepositoryCliCommand(runOptions(), services);
      assert.ok(!requests[0].args.some((a) => typeof a === 'string' && /^\/[NP]/.test(a)));
    });
  });

  suite('привязка', () => {
    test('нет привязки — исключение', async () => {
      await service.clearBinding(target);
      await assert.rejects(() => runRepositoryCliCommand(runOptions(), services), /не настроено подключение/);
    });

    test('bindingOverride важнее сохранённой привязки', async () => {
      await runRepositoryCliCommand(
        runOptions({ bindingOverride: { repoPath: 'OVR', repoUser: 'ovr', repoPassword: '' } }),
        services
      );
      const args = requests[0].args;
      assert.strictEqual(args[args.indexOf('/ConfigurationRepositoryF') + 1], 'OVR');
    });

    test('сохранённая привязка с паролем из SecretStorage', async () => {
      await runRepositoryCliCommand(runOptions(), services);
      const args = requests[0].args;
      assert.strictEqual(args[args.indexOf('/ConfigurationRepositoryF') + 1], 'C:\\repo-storage');
    });
  });

  suite('исходы операции', () => {
    test('успех: true, сообщение, dispose, исполнитель создан с путём 1С', async () => {
      const ok1 = await runRepositoryCliCommand(runOptions(), services);
      assert.strictEqual(ok1, true);
      assert.deepStrictEqual(infos, ['Готово']);
      assert.strictEqual(disposed, 1);
      assert.deepStrictEqual(fabricatedV8Paths, [v8Path]);
      assert.ok(lines.some((l) => l.startsWith('[repository] Завершено:')));
    });

    test('showSuccessMessage=false: уведомления нет', async () => {
      await runRepositoryCliCommand(runOptions({ showSuccessMessage: false }), services);
      assert.deepStrictEqual(infos, []);
    });

    test('afterSuccess вызывается', async () => {
      let called = 0;
      await runRepositoryCliCommand(runOptions({ afterSuccess: () => { called += 1; } }), services);
      assert.strictEqual(called, 1);
    });

    test('без внедрённой фабрики используется локальный исполнитель: сбой запуска — false, не исключение', async () => {
      // Пустой файл вместо 1cv8 не запускается ни на одной ОС, поэтому реальная платформа не нужна.
      const withoutFactory: RepositoryCliServices = {
        workspaceFolder: services.workspaceFolder,
        outputChannel: services.outputChannel,
        repositoryService: services.repositoryService,
        projectSecretStorage: services.projectSecretStorage,
      };
      const res = await runRepositoryCliCommand(runOptions(), withoutFactory);
      assert.strictEqual(res, false);
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(requests.length, 0);
    });

    test('прерывание: false, строка в логе, dispose', async () => {
      behavior = () => ok({ interrupted: 'Отменено пользователем' });
      const res = await runRepositoryCliCommand(runOptions(), services);
      assert.strictEqual(res, false);
      assert.ok(lines.includes('[repository] Отменено пользователем'));
      assert.deepStrictEqual(infos, ['Тест: Отменено пользователем']);
      assert.deepStrictEqual(errors, []);
      assert.strictEqual(disposed, 1);
    });

    test('непустой лог попадает в канал', async () => {
      behavior = () => ok({ log: 'лог платформы' });
      await runRepositoryCliCommand(runOptions(), services);
      assert.ok(lines.includes('[repository][log]\nлог платформы'));
    });

    test('onOutput: пустые строки пропускаются, остальные логируются', async () => {
      behavior = (request) => {
        request.onOutput?.('   ');
        request.onOutput?.(`  строка вывода ${'x'.repeat(100)} `);
        return ok();
      };
      await runRepositoryCliCommand(runOptions(), services);
      const outputLines = lines.filter((l) => l.startsWith('[repository][output]'));
      assert.strictEqual(outputLines.length, 1);
      assert.ok(outputLines[0].includes('строка вывода'));
    });

    test('exit != 0 без деталей: причина — код возврата', async () => {
      behavior = () => ok({ exitCode: 7 });
      const res = await runRepositoryCliCommand(runOptions({ failureOperation: 'отключении' }), services);
      assert.strictEqual(res, false);
      assert.deepStrictEqual(errors, ['Ошибка теста\nОшибка при отключении: команда завершилась с кодом 7']);
      assert.strictEqual(disposed, 1);
    });

    test('причина по умолчанию строится из заголовка прогресса', async () => {
      behavior = () => ok({ exitCode: 1 });
      await runRepositoryCliCommand(runOptions(), services);
      assert.ok(errors[0].includes('Ошибка при тест:'));
    });

    test('только служебные строки: причина — код возврата', async () => {
      behavior = () => ok({ exitCode: 4, log: '--- Log ---\n--- End ---' });
      await runRepositoryCliCommand(runOptions(), services);
      assert.ok(errors[0].endsWith('команда завершилась с кодом 4'));
    });

    test('фильтрация служебных строк ошибки: причина — последняя содержательная', async () => {
      behavior = (request) => {
        request.onOutput?.('Реальная причина сбоя');
        request.onOutput?.('Конфигуратор завершился с ошибкой');
        return ok({ exitCode: 1, log: 'Error repository (code: 1)\r\n' });
      };
      await runRepositoryCliCommand(runOptions(), services);
      assert.ok(errors[0].endsWith('Реальная причина сбоя'), errors[0]);
    });

    test('все строки служебные: причина — последняя строка как есть', async () => {
      behavior = () => ok({ exitCode: 1, log: 'Error repository (code: 1)' });
      await runRepositoryCliCommand(runOptions(), services);
      assert.ok(errors[0].endsWith('Error repository (code: 1)'), errors[0]);
    });

    test('исключение из run: false, ошибка показана, dispose', async () => {
      behavior = () => Promise.reject(new Error('упал запуск'));
      const res = await runRepositoryCliCommand(runOptions(), services);
      assert.strictEqual(res, false);
      assert.ok(errors[0].includes('упал запуск'));
      assert.strictEqual(disposed, 1);
    });

    test('не-Error исключение приводится к строке', async () => {
      // Намеренно не Error: проверяется ветка приведения произвольного исключения к строке.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      behavior = () => Promise.reject('строковая причина');
      await runRepositoryCliCommand(runOptions(), services);
      assert.ok(errors[0].includes('строковая причина'));
    });

    test('вектор: расширение уходит ключом -Extension, а в журнале «Старт» нет паролей и пользователей', async () => {
      await runRepositoryCliCommand(runOptions(), services);
      const start = lines.find((l) => l.startsWith('[repository] Старт:'));
      assert.ok(start);
      for (const secret of [DB_PASSWORD, REPO_PASSWORD]) {
        assert.ok(!start.includes(secret), `лог содержит секрет ${secret}`);
      }
      assert.deepStrictEqual(requests[0].secrets.slice().sort(), [DB_PASSWORD, REPO_PASSWORD].sort());
    });
  });

  suite('выходной файл', () => {
    test('конфигуратор не создал файл — ошибка', async () => {
      const res = await runRepositoryCliCommand(
        runOptions({ operation: { kind: 'dump' }, output: { name: 'dump.cf', targetPath: path.join(root, 'o.cf') } }),
        services
      );
      assert.strictEqual(res, false);
      assert.ok(errors[0].includes('конфигуратор не создал выходной файл'));
    });

    test('staging переносится на targetPath', async () => {
      const staging = path.join(root, 'staging.cf');
      fs.writeFileSync(staging, 'бинарь');
      behavior = () => ok({ outputs: new Map([['dump.cf', staging]]) });
      const targetPath = path.join(root, 'o.cf');
      const res = await runRepositoryCliCommand(
        runOptions({ operation: { kind: 'dump' }, output: { name: 'dump.cf', targetPath } }),
        services
      );
      assert.strictEqual(res, true);
      assert.strictEqual(fs.readFileSync(targetPath, 'utf-8'), 'бинарь');
      assert.strictEqual(fs.existsSync(staging), false);
    });
  });

  suite('действия над узлом', () => {
    test('requireTarget: узел без xmlPath', async () => {
      await assert.rejects(
        () => runRepositoryLockAction(services, { nodeKind: 'Catalog', label: 'X' }, false, { revised: false }),
        /Не удалось определить конфигурацию/
      );
    });

    test('захват ставит отметку, освобождение снимает', async () => {
      assert.notStrictEqual(await runRepositoryLockAction(services, catalogNode, false, { revised: false }), undefined);
      assert.strictEqual(service.isLocked(target, 'Справочник.Товары'), true);
      assert.ok(requests[0].args.includes('/ConfigurationRepositoryLock'));

      assert.strictEqual(await runRepositoryUnlockAction(services, catalogNode, false, true), true);
      assert.strictEqual(service.isLocked(target, 'Справочник.Товары'), false);
      assert.ok(requests[1].args.includes('/ConfigurationRepositoryUnLock'));
      assert.ok(requests[1].args.includes('-force'));
    });

    test('помещение снимает захват; keepLocked=true — не снимает', async () => {
      service.setLocked(target, ['Справочник.Товары'], true);
      await runRepositoryCommitAction(services, catalogNode, { recursive: false, comment: 'к', keepLocked: true, force: false });
      assert.strictEqual(service.isLocked(target, 'Справочник.Товары'), true);

      await runRepositoryCommitAction(services, catalogNode, { recursive: true, comment: 'к', keepLocked: false, force: false });
      assert.strictEqual(service.isLocked(target, 'Справочник.Товары'), false);
      assert.ok(requests[1].args.includes('/ConfigurationRepositoryCommit'));
    });

    test('получение: версия попадает в вектор', async () => {
      await runRepositoryUpdateAction(services, catalogNode, { recursive: false, force: true, version: '5' });
      const args = requests[0].args;
      assert.ok(args.includes('/ConfigurationRepositoryUpdateCfg'));
      assert.strictEqual(args[args.indexOf('-v') + 1], '5');
    });

    test('получение: outcome.receivedFromRepository по логу; exit≠0 — undefined', async () => {
      const begin = '---- Начало операции с хранилищем конфигурации ----';
      const end = '---- Операция с хранилищем конфигурации завершена ----';
      const options = { recursive: false, force: false };

      behavior = () => ok({ log: [begin, 'Объект получен из хранилища: Справочник.Товары', end].join('\r\n') });
      assert.deepStrictEqual(await runRepositoryUpdateAction(services, catalogNode, options), { receivedFromRepository: true });

      behavior = () => ok({ log: [begin, end].join('\r\n') });
      assert.deepStrictEqual(await runRepositoryUpdateAction(services, catalogNode, options), { receivedFromRepository: false });

      behavior = () => ok({ log: '' });
      assert.deepStrictEqual(await runRepositoryUpdateAction(services, catalogNode, options), { receivedFromRepository: true }, 'лог не распознан — консервативно true');

      behavior = () => ok({ exitCode: 1 });
      assert.strictEqual(await runRepositoryUpdateAction(services, catalogNode, options), undefined);
    });

    test('метка у узла отсутствует — в заголовках имя цели (получение, захват, освобождение, помещение)', async () => {
      const node: RepositoryNodeRef = { nodeKind: 'Catalog', xmlPath: catalogNode.xmlPath };
      await runRepositoryUpdateAction(services, node, { recursive: false, force: false });
      await runRepositoryLockAction(services, node, false, { revised: false });
      await runRepositoryUnlockAction(services, node, false, false);
      await runRepositoryCommitAction(services, node, { recursive: false, comment: '', keepLocked: false, force: false });
      assert.strictEqual(infos.length, 4);
      for (const info of infos) {
        assert.ok(info.includes('Основная'), info);
      }
    });

    test('ошибки лока без метки: заголовок ошибки несёт имя цели', async () => {
      const node: RepositoryNodeRef = { nodeKind: 'Catalog', xmlPath: catalogNode.xmlPath };
      behavior = () => ok({ exitCode: 1 });
      await runRepositoryLockAction(services, node, false, { revised: false });
      await runRepositoryUnlockAction(services, node, false, false);
      await runRepositoryCommitAction(services, node, { recursive: false, comment: '', keepLocked: false, force: false });
      assert.strictEqual(errors.length, 3);
      for (const message of errors) {
        assert.ok(message.includes('Основная'), message);
      }
    });
  });

  suite('Э4: база отпускается у агента перед пакетной операцией хранилища', () => {
    teardown(() => disposeCachedAgentOperationServices());

    test('подключённая база: disconnect-ib уходит ДО запуска исполнителя; connect-ib после не шлётся', async () => {
      const events: string[] = [];
      const seeded = await seedCachedAgentService(root, {
        connected: true,
        behavior: (command) => { events.push(`agent:${command}`); return undefined; },
      });
      // connect-ib подсева (connected: true) проходит через тот же behavior — это не часть сценария.
      events.length = 0;
      behavior = () => { events.push('run'); return ok(); };

      assert.strictEqual(await runRepositoryCliCommand(runOptions(), services), true);

      assert.deepStrictEqual(events, ['agent:common disconnect-ib', 'run']);
      assert.strictEqual(seeded.factory.count('common connect-ib'), 0);
    });

    test('база не подключена: агенту команд нет, операция выполняется', async () => {
      const seeded = await seedCachedAgentService(root, { connected: false });
      assert.strictEqual(await runRepositoryCliCommand(runOptions(), services), true);
      assert.deepStrictEqual(seeded.factory.log, []);
      assert.strictEqual(requests.length, 1);
    });

    test('ошибка disconnect: пакетная операция НЕ запускается, ошибка показана, результат false, исполнитель освобождён', async () => {
      await seedCachedAgentService(root, {
        connected: true,
        behavior: (command) => command === 'common disconnect-ib' ? agentError('UnknownError', 'агент не отвечает') : undefined,
      });
      assert.strictEqual(await runRepositoryCliCommand(runOptions(), services), false);
      assert.strictEqual(requests.length, 0);
      assert.ok(errors.some((m) => m.includes('агент не отвечает')), errors.join('|'));
      assert.strictEqual(disposed, 1);
    });
  });

  suite('статус-бар', () => {
    test('setRepositoryOperationStatus: begin/end и скрытие по dispose', () => {
      setRepositoryOperationStatus('T', 'старт', true);
      setRepositoryOperationStatus('T', 'конец', false);
      disposeRepositoryCommandStatusBar();
      disposeRepositoryCommandStatusBar();
    });
  });
});
