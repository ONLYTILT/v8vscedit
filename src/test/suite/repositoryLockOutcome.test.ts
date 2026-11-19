/**
 * Н10 (пилот 8.3.27.2130, файловое хранилище): частичный захват — УСПЕХ платформы (`exit=0`).
 * `/ConfigurationRepositoryLock` со списком, где объекта не существует, даёт exit 0 и «Захват объектов в хранилище
 * успешно завершен»; несуществующие перечисляются строкой «Объекты, отсутствующие в обеих конфигурациях: …», остальные
 * захватываются. Раньше `setLocked` после успеха помечал захваченными ВСЕ `fullNames` → локальный учёт показывал
 * захват, которого в хранилище нет. Лог теперь разбирается, помечаются только реально захваченные.
 *
 * Контракт infra/repository/RepositoryLockLog.ts (без vscode):
 *   export interface RepositoryLockLogResult {
 *     locked: string[];       // «Объект захвачен для редактирования: <имя>»
 *     cancelled: string[];    // «Захват объекта отменен: <имя>»
 *     absent: string[];       // «Объекты, отсутствующие в обеих конфигурациях: <имя1>, <имя2>»
 *     recognized: boolean;    // в логе была хотя бы одна из трёх форм
 *   }
 *   export function parseRepositoryLockLog(log: string): RepositoryLockLogResult;
 *   export function resolveLockedFullNames(fullNames: readonly string[], log: string): string[];
 *       // recognized → fullNames, чьё имя есть в locked (без учёта регистра, порядок fullNames);
 *       // не распознан (формат лога другой версии платформы, пустой лог) → ВСЕ fullNames (прежнее поведение, без регресса).
 *   RepositoryCliRunOptions.afterSuccess получает DesignerBatchResult: `afterSuccess?: (result: DesignerBatchResult) => void | Promise<void>`.
 *   runRepositoryLockAction ставит отметки через resolveLockedFullNames(objects.fullNames, result.log).
 *
 * ДОПУЩЕНИЕ (снять образцом реального лога на пилоте): формы строк и вид имени (`Справочник.Товары`) взяты из описания
 * пилота; если платформа печатает имя иначе, тест fixture-строк нужно поправить по реальному логу — механика не меняется.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SecretStore } from '../../infra/ai/AiSecretStorage';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import type {
  DesignerBatchExecutor,
  DesignerBatchResult,
} from '../../infra/process/designer/DesignerBatchExecutor';
import { hasReceivedFromRepository, parseRepositoryLockLog, resolveLockedFullNames } from '../../infra/repository/RepositoryLockLog';
import { RepositoryService, type RepositoryNodeRef } from '../../infra/repository/RepositoryService';
import {
  disposeRepositoryCommandStatusBar,
  resolveRepositoryTarget,
  runRepositoryLockAction,
  type RepositoryCliServices,
} from '../../ui/commands/repository/RepositoryCommandRunner';


const BEGIN = '---- Начало операции с хранилищем конфигурации ----';
const END = '---- Операция с хранилищем конфигурации завершена ----';
const DONE = 'Захват объектов в хранилище успешно завершен';
/** Реальный лог Э14: объект изменён в хранилище — получен и захвачен. */
const LOG_RECEIVED = [BEGIN, 'Объект получен из хранилища: Справочник.Товары', 'Объект захвачен для редактирования: Справочник.Товары', END, DONE].join('\r\n');
/** Реальный лог Э14: объект в хранилище не менялся — только захват. */
const LOG_LOCKED_ONLY = [BEGIN, 'Объект захвачен для редактирования: Справочник.Товары', END, DONE].join('\r\n');
/** Реальный лог Э14: объект со вложенными частями (макет, форма). */
const LOG_RECEIVED_PARTS = [
  BEGIN,
  'Объект получен из хранилища: Документ.Документ1',
  'Объект получен из хранилища: Документ.Документ1.Макет.Макет',
  'Объект получен из хранилища: Документ.Документ1.Форма.ФормаДокумента',
  'Объект захвачен для редактирования: Документ.Документ1',
  'Объект захвачен для редактирования: Документ.Документ1.Макет.Макет',
  'Объект захвачен для редактирования: Документ.Документ1.Форма.ФормаДокумента',
  END, DONE,
].join('\r\n');

suite('Н10: parseRepositoryLockLog — разбор лога захвата', () => {
  test('все три формы строк: захвачен, отменён, отсутствует (CRLF, отступы по краям)', () => {
    const log = [
      '  Объект захвачен для редактирования: Справочник.Товары  ',
      'Захват объекта отменен: Документ.Заказ',
      'Объекты, отсутствующие в обеих конфигурациях: Справочник.Нет1, Справочник.Нет2',
      'Захват объектов в хранилище успешно завершен',
    ].join('\r\n');
    assert.deepStrictEqual(parseRepositoryLockLog(log), {
      locked: ['Справочник.Товары'],
      cancelled: ['Документ.Заказ'],
      absent: ['Справочник.Нет1', 'Справочник.Нет2'],
      recognized: true,
    });
  });

  test('несколько захваченных — в порядке лога', () => {
    const log = 'Объект захвачен для редактирования: А.Один\nОбъект захвачен для редактирования: Б.Два\n';
    assert.deepStrictEqual(parseRepositoryLockLog(log).locked, ['А.Один', 'Б.Два']);
  });

  test('только строка об отсутствующих: recognized, locked пуст', () => {
    const parsed = parseRepositoryLockLog('Объекты, отсутствующие в обеих конфигурациях: Справочник.Нет');
    assert.strictEqual(parsed.recognized, true);
    assert.deepStrictEqual(parsed.locked, []);
    assert.deepStrictEqual(parsed.absent, ['Справочник.Нет']);
  });

  const unrecognized: [string, string][] = [
    ['пустой лог', ''],
    ['только перевод строки', '\r\n'],
    ['посторонний текст', 'Захват объектов в хранилище успешно завершен'],
    ['похожая, но другая фраза', 'Объект захвачен: Справочник.Товары'],
  ];
  for (const [title, log] of unrecognized) {
    test(`не распознан: ${title}`, () => {
      assert.deepStrictEqual(parseRepositoryLockLog(log), { locked: [], cancelled: [], absent: [], recognized: false });
    });
  }
});

suite('Н10: resolveLockedFullNames — какие объекты помечать захваченными', () => {
  const names = ['Справочник.Товары', 'Документ.Заказ'];

  test('распознан: помечаются только захваченные, порядок как в fullNames', () => {
    const log = 'Объект захвачен для редактирования: Документ.Заказ\nОбъекты, отсутствующие в обеих конфигурациях: Справочник.Товары';
    assert.deepStrictEqual(resolveLockedFullNames(names, log), ['Документ.Заказ']);
  });

  test('сравнение имён без учёта регистра', () => {
    assert.deepStrictEqual(
      resolveLockedFullNames(names, 'Объект захвачен для редактирования: справочник.ТОВАРЫ'),
      ['Справочник.Товары']
    );
  });

  test('распознан, но ничего не захвачено (все отсутствуют) — не помечается ничего', () => {
    assert.deepStrictEqual(
      resolveLockedFullNames(names, 'Объекты, отсутствующие в обеих конфигурациях: Справочник.Товары, Документ.Заказ'),
      []
    );
  });

  test('захвачен объект, которого нет среди запрошенных, — игнорируется', () => {
    assert.deepStrictEqual(resolveLockedFullNames(names, 'Объект захвачен для редактирования: Роль.Посторонняя'), []);
  });

  test('служебные имена корня (без вида «Тип.Имя») не фильтруются по логу: захват корня отмечается и при распознанном логе', () => {
    const log = 'Объект захвачен для редактирования: Конфигурация.Основная';
    assert.deepStrictEqual(resolveLockedFullNames(['__configuration_root__'], log), ['__configuration_root__']);
    assert.deepStrictEqual(resolveLockedFullNames(['__extension_root__'], 'Объекты, отсутствующие в обеих конфигурациях: Справочник.Нет'), ['__extension_root__']);
  });

  test('смешанный список: корень сохраняется, объекты фильтруются по логу', () => {
    const log = 'Объект захвачен для редактирования: Документ.Заказ';
    assert.deepStrictEqual(resolveLockedFullNames(['__configuration_root__', 'Справочник.Товары', 'Документ.Заказ'], log), ['__configuration_root__', 'Документ.Заказ']);
  });

  for (const log of ['', 'Захват объектов в хранилище успешно завершен', 'неизвестный формат другой версии платформы']) {
    test(`лог не распознан (${JSON.stringify(log)}) — прежнее поведение: помечаются все`, () => {
      assert.deepStrictEqual(resolveLockedFullNames(names, log), names);
    });
  }
});

suite('Н10: runRepositoryLockAction — локальный учёт захватов по логу платформы', () => {
  type WindowRef = Record<string, unknown>;
  const windowRef = vscode.window as unknown as WindowRef;
  let root: string;
  let service: RepositoryService;
  let services: RepositoryCliServices;
  let result: DesignerBatchResult;
  let catalogNode: RepositoryNodeRef;
  let target: NonNullable<ReturnType<typeof resolveRepositoryTarget>>;
  let origError: unknown;
  let origInfo: unknown;
  let requests: { args: readonly unknown[] }[];
  let infos: string[];
  let errors: string[];

  function fakeSecretStore(): SecretStore {
    const map = new Map<string, string>();
    return {
      get: (key: string) => Promise.resolve(map.get(key)),
      store: (key: string, value: string) => { map.set(key, value); return Promise.resolve(); },
      delete: (key: string) => { map.delete(key); return Promise.resolve(); },
    };
  }

  setup(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lock-outcome-')));
    const v8Path = path.join(root, process.platform === 'win32' ? '1cv8.exe' : '1cv8');
    fs.writeFileSync(v8Path, '');
    const cfRoot = path.join(root, 'src', 'cf');
    fs.mkdirSync(path.join(cfRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(
      path.join(cfRoot, 'Configuration.xml'),
      '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Configuration uuid="11111111-1111-1111-1111-111111111111"><Properties><Name>Основная</Name></Properties></Configuration></MetaDataObject>'
    );
    const catalogPath = path.join(cfRoot, 'Catalogs', 'Товары.xml');
    fs.writeFileSync(
      catalogPath,
      '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Catalog uuid="33333333-3333-3333-3333-333333333333"><Properties><Name>Товары</Name></Properties></Catalog></MetaDataObject>'
    );
    catalogNode = { nodeKind: 'Catalog', label: 'Товары', xmlPath: catalogPath };
    fs.writeFileSync(path.join(root, 'env.json'), JSON.stringify({
      default: { '--ibconnection': `/F${path.join(root, 'base')}`, '--path': v8Path, '--repo-path': 'C:\\repo', '--repo-user': 'u' },
    }), 'utf-8');
    service = new RepositoryService(root, new ProjectSecretStorage(fakeSecretStore(), root));
    const resolved = resolveRepositoryTarget(service, catalogNode);
    assert.ok(resolved);
    target = resolved;
    await service.saveBinding(target, { repoPath: 'C:\\repo', repoUser: 'u', repoPassword: 'p' });

    result = { exitCode: 0, log: '', outputs: new Map() };
    requests = [];
    infos = [];
    errors = [];
    const executor: DesignerBatchExecutor = {
      run: (request) => { requests.push({ args: request.args }); return Promise.resolve(result); },
      dispose: () => Promise.resolve(),
    };
    services = {
      workspaceFolder: { uri: vscode.Uri.file(root), name: 'h10', index: 0 },
      outputChannel: { appendLine: () => undefined } as unknown as vscode.OutputChannel,
      repositoryService: service,
      projectSecretStorage: new ProjectSecretStorage(fakeSecretStore(), root),
      createDesignerExecutor: () => executor,
    };
    origError = windowRef.showErrorMessage;
    origInfo = windowRef.showInformationMessage;
    windowRef.showErrorMessage = (message: string) => { errors.push(message); return Promise.resolve(undefined); };
    windowRef.showInformationMessage = (message: string) => { infos.push(message); return Promise.resolve(undefined); };
  });

  teardown(() => {
    windowRef.showErrorMessage = origError;
    windowRef.showInformationMessage = origInfo;
    disposeRepositoryCommandStatusBar();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('exit 0, объект захвачен (строка в логе): отметка стоит', async () => {
    result = { ...result, log: LOG_LOCKED_ONLY };
    assert.deepStrictEqual(
      await runRepositoryLockAction(services, catalogNode, false, { revised: false }),
      { lockedFullNames: ['Справочник.Товары'], receivedFromRepository: false }
    );
    assert.strictEqual(service.isLocked(target, 'Справочник.Товары'), true);
  });

  test('exit 0, но платформа сообщила «отсутствует в обеих конфигурациях»: операция успешна, отметки нет (учёт не врёт)', async () => {
    result = { ...result, log: [BEGIN, 'Объекты, отсутствующие в обеих конфигурациях: Справочник.Товары', END].join('\r\n') };
    const outcome = await runRepositoryLockAction(services, catalogNode, false, { revised: false });
    assert.deepStrictEqual(outcome, { lockedFullNames: [], receivedFromRepository: false });
    assert.strictEqual(service.isLocked(target, 'Справочник.Товары'), false);
  });

  test('захват КОРНЯ конфигурации с распознанным логом: корень отмечен захваченным (регресс Н10: служебное имя корня не отбрасывается)', async () => {
    result = { ...result, log: 'Объект захвачен для редактирования: Конфигурация.Основная\nЗахват объектов в хранилище успешно завершен' };
    const rootNode: RepositoryNodeRef = { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(root, 'src', 'cf', 'Configuration.xml') };
    const outcome = await runRepositoryLockAction(services, rootNode, false, { revised: false });
    assert.deepStrictEqual(outcome?.lockedFullNames, ['__configuration_root__']);
    assert.strictEqual(service.isRootLocked(target), true);
  });

  test('лог не распознан (пустой): прежнее поведение — отметка стоит, receivedFromRepository консервативно true', async () => {
    assert.deepStrictEqual(
      await runRepositoryLockAction(services, catalogNode, false, { revised: false }),
      { lockedFullNames: ['Справочник.Товары'], receivedFromRepository: true }
    );
    assert.strictEqual(service.isLocked(target, 'Справочник.Товары'), true);
  });

  test('revised=true, лог Э14 с «получен»: вектор с -revised после -Objects, receivedFromRepository=true, тост успеха показан', async () => {
    result = { ...result, log: LOG_RECEIVED };
    const outcome = await runRepositoryLockAction(services, catalogNode, false, { revised: true });
    assert.deepStrictEqual(outcome, { lockedFullNames: ['Справочник.Товары'], receivedFromRepository: true });
    const args = requests[0].args;
    assert.ok(args.includes('/ConfigurationRepositoryLock'));
    assert.ok(args.includes('-revised'));
    assert.ok(args.indexOf('-revised') > args.indexOf('-Objects'), 'ключ -revised идёт после -Objects');
    // Импорт своего тоста не показывает, а захват — самый частый исход без импорта: тост нужен всегда.
    assert.strictEqual(infos.length, 1);
    assert.strictEqual(service.isLocked(target, 'Справочник.Товары'), true);
  });

  test('revised=true, объект в хранилище не менялся: только «захвачен» → receivedFromRepository=false', async () => {
    result = { ...result, log: LOG_LOCKED_ONLY };
    const outcome = await runRepositoryLockAction(services, catalogNode, false, { revised: true });
    assert.deepStrictEqual(outcome, { lockedFullNames: ['Справочник.Товары'], receivedFromRepository: false });
  });

  test('revised=false, но платформа сама получила версию (Э14): receivedFromRepository=true', async () => {
    result = { ...result, log: LOG_RECEIVED };
    const outcome = await runRepositoryLockAction(services, catalogNode, false, { revised: false });
    assert.strictEqual(outcome?.receivedFromRepository, true);
    assert.ok(!requests[0].args.includes('-revised'));
  });

  test('лог с вложенными частями (макет, форма): «получен» распознан', async () => {
    result = { ...result, log: LOG_RECEIVED_PARTS };
    const outcome = await runRepositoryLockAction(services, catalogNode, false, { revised: true });
    assert.strictEqual(outcome?.receivedFromRepository, true);
  });

  test('revised=false: без -revised, тост успеха показан', async () => {
    result = { ...result, log: LOG_LOCKED_ONLY };
    await runRepositoryLockAction(services, catalogNode, false, { revised: false });
    assert.ok(!requests[0].args.includes('-revised'));
    assert.strictEqual(infos.length, 1);
  });

  for (const revised of [true, false]) {
    test(`exit≠0 (revised=${String(revised)}): undefined, отметка не ставится, ошибка показана`, async () => {
      result = { exitCode: 1, log: 'Объект захвачен другим пользователем', outputs: new Map() };
      assert.strictEqual(await runRepositoryLockAction(services, catalogNode, false, { revised }), undefined);
      assert.strictEqual(service.isLocked(target, 'Справочник.Товары'), false);
      assert.strictEqual(errors.length, 1);
    });
  }
});

suite('hasReceivedFromRepository — получила ли база новые версии из хранилища', () => {
  test('лог не распознан (нет маркера начала операции): true — лучше лишний импорт, чем отстающий проект', () => {
    assert.strictEqual(hasReceivedFromRepository(''), true);
    assert.strictEqual(hasReceivedFromRepository('неизвестный формат другой версии платформы'), true);
    assert.strictEqual(hasReceivedFromRepository('Объект захвачен для редактирования: Справочник.Товары'), true);
  });

  test('реальный лог Э14 с «получен»: true', () => {
    assert.strictEqual(hasReceivedFromRepository(LOG_RECEIVED), true);
    assert.strictEqual(hasReceivedFromRepository(LOG_RECEIVED_PARTS), true);
  });

  test('реальный лог Э14 без «получен» (объект в хранилище не менялся): false', () => {
    assert.strictEqual(hasReceivedFromRepository(LOG_LOCKED_ONLY), false);
  });

  test('распознанный лог без строк захвата и получения: false', () => {
    assert.strictEqual(hasReceivedFromRepository([BEGIN, 'Объекты, отсутствующие в обеих конфигурациях: Справочник.Нет', END].join('\r\n')), false);
  });

  test('строка «получен» — только как отдельная строка с маркером (LF вместо CRLF тоже)', () => {
    assert.strictEqual(hasReceivedFromRepository(LOG_RECEIVED.replace(/\r\n/g, '\n')), true);
  });

  // Э16: получение поддерева без корня — удаление может быть единственной строкой изменения базы.
  test('лог получения Э16 только с удалением объекта: true', () => {
    assert.strictEqual(
      hasReceivedFromRepository([BEGIN, 'Объект удален из конфигурации: Справочник.Справочник3', END,
        'Обновление конфигурации из хранилища успешно завершено'].join('\r\n')),
      true
    );
  });
});
