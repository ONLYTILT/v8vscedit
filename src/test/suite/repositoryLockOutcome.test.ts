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
import { parseRepositoryLockLog, resolveLockedFullNames } from '../../infra/repository/RepositoryLockLog';
import { RepositoryService, type RepositoryNodeRef } from '../../infra/repository/RepositoryService';
import {
  disposeRepositoryCommandStatusBar,
  resolveRepositoryTarget,
  runRepositoryLockAction,
  type RepositoryCliServices,
} from '../../ui/commands/repository/RepositoryCommandRunner';

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
    const executor: DesignerBatchExecutor = { run: () => Promise.resolve(result), dispose: () => Promise.resolve() };
    services = {
      workspaceFolder: { uri: vscode.Uri.file(root), name: 'h10', index: 0 },
      outputChannel: { appendLine: () => undefined } as unknown as vscode.OutputChannel,
      repositoryService: service,
      projectSecretStorage: new ProjectSecretStorage(fakeSecretStore(), root),
      createDesignerExecutor: () => executor,
    };
    origError = windowRef.showErrorMessage;
    origInfo = windowRef.showInformationMessage;
    windowRef.showErrorMessage = () => Promise.resolve(undefined);
    windowRef.showInformationMessage = () => Promise.resolve(undefined);
  });

  teardown(() => {
    windowRef.showErrorMessage = origError;
    windowRef.showInformationMessage = origInfo;
    disposeRepositoryCommandStatusBar();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('exit 0, объект захвачен (строка в логе): отметка стоит', async () => {
    result = { ...result, log: 'Объект захвачен для редактирования: Справочник.Товары' };
    assert.strictEqual(await runRepositoryLockAction(services, catalogNode, false), true);
    assert.strictEqual(service.isLocked(target, 'Справочник.Товары'), true);
  });

  test('exit 0, но платформа сообщила «отсутствует в обеих конфигурациях»: операция успешна, отметки нет (учёт не врёт)', async () => {
    result = { ...result, log: 'Объекты, отсутствующие в обеих конфигурациях: Справочник.Товары' };
    assert.strictEqual(await runRepositoryLockAction(services, catalogNode, false), true);
    assert.strictEqual(service.isLocked(target, 'Справочник.Товары'), false);
  });

  test('захват КОРНЯ конфигурации с распознанным логом: корень отмечен захваченным (регресс Н10: служебное имя корня не отбрасывается)', async () => {
    result = { ...result, log: 'Объект захвачен для редактирования: Конфигурация.Основная\nЗахват объектов в хранилище успешно завершен' };
    const rootNode: RepositoryNodeRef = { nodeKind: 'configuration', label: 'Конфигурация', xmlPath: path.join(root, 'src', 'cf', 'Configuration.xml') };
    assert.strictEqual(await runRepositoryLockAction(services, rootNode, false), true);
    assert.strictEqual(service.isRootLocked(target), true);
  });

  test('лог не распознан (пустой): прежнее поведение — отметка стоит', async () => {
    assert.strictEqual(await runRepositoryLockAction(services, catalogNode, false), true);
    assert.strictEqual(service.isLocked(target, 'Справочник.Товары'), true);
  });
});
