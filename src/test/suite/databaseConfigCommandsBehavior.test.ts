/**
 * Поведение команд загрузки без обновления БД (обработчики из `CommandRegistry.registerCommands`):
 * `updateChangedConfigurations` (настройка и аргумент `{ updateDatabase }`, «изменений нет, но цель отстаёт»),
 * `updateConfigurationInDb` (всегда с обновлением), `loadConfigurationChangesInDb`, `updateDatabaseConfiguration`,
 * `databaseLag.showActions`.
 *
 * Внешняя недоступная система — платформа 1С: раннеры (`runUpdate*`/`runApplyDatabaseConfiguration`) подменены
 * и фиксируют аргументы; признак отставания и замок операции — настоящие. Окна — приёмники строк.
 */
import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChangedConfiguration } from '../../infra/fs/ConfigurationChangeDetector';
import type { CommandServices } from '../../ui/commands/_shared';
import { registerCommands } from '../../ui/commands/CommandRegistry';
import * as extensionRunner from '../../ui/commands/ext/ExtensionCommandRunner';
import { endConfigurationOperation, isConfigurationOperationRunning, tryBeginConfigurationOperation } from '../../ui/commands/ext/configurationOperationLock';
import { FakeLagRecorder } from './support/databaseLagFakes';

type Handler = (...args: unknown[]) => unknown;
type PickAnswer = (items: readonly vscode.QuickPickItem[]) => vscode.QuickPickItem | undefined;

const ID = {
  changed: 'v8vscedit.updateChangedConfigurations',
  inDb: 'v8vscedit.updateConfigurationInDb',
  load: 'v8vscedit.loadConfigurationChangesInDb',
  updateDb: 'v8vscedit.updateDatabaseConfiguration',
  lagActions: 'v8vscedit.databaseLag.showActions',
} as const;

suite('Команды загрузки без обновления БД: поведение', function () {
  this.timeout(60_000);
  const w = vscode.window as unknown as Record<string, unknown>;
  const runnerRef = extensionRunner as unknown as Record<string, unknown>;
  const commandsRef = vscode.commands as unknown as { registerCommand: unknown };
  const RUNNERS = ['runUpdateMainConfiguration', 'runUpdateExtension', 'runApplyDatabaseConfiguration'] as const;
  const saved: Record<string, unknown> = {};

  const root = path.join(os.tmpdir(), 'v8-db-cmd-project');
  const cfRoot = path.join(root, 'src', 'cf');
  const aRoot = path.join(root, 'src', 'cfe', 'А');

  let handlers: Map<string, Handler>;
  let lag: FakeLagRecorder;
  let changed: ChangedConfiguration[];
  let cleaned: string[][];
  let infos: string[];
  let warnings: string[];
  let picks: PickAnswer[];
  let pickItems: (readonly vscode.QuickPickItem[])[];
  /** Журнал раннеров: `kind:name:режим`. */
  let calls: string[];
  let optionsSeen: { updateDatabase: boolean; lag: unknown }[];
  let applyArgs: unknown[][];
  let runnerResult: boolean;

  const cfChanged = (): ChangedConfiguration => ({ kind: 'cf', name: 'Основная', rootPath: cfRoot, changedFilesCount: 2 });
  const lagCf = () => ({ kind: 'cf' as const, name: 'Основная', rootPath: cfRoot });
  const lagCfe = (name: string, rootPath: string) => ({ kind: 'cfe' as const, name, rootPath, extensionName: name });
  const nodeOf = (kind: 'configuration' | 'extension', label: string, dir: string) =>
    ({ nodeKind: kind, label, xmlPath: path.join(dir, 'Configuration.xml') });
  const handler = (id: string): Handler => {
    const found = handlers.get(id);
    assert.ok(found, `${id} не зарегистрирована`);
    return found;
  };
  const setSetting = (value: boolean | undefined): Thenable<void> =>
    vscode.workspace.getConfiguration('v8vscedit.configuration').update('updateDatabaseAfterLoad', value, vscode.ConfigurationTarget.Global);

  setup(async () => {
    lag = new FakeLagRecorder();
    changed = [];
    cleaned = [];
    infos = [];
    warnings = [];
    picks = [];
    pickItems = [];
    calls = [];
    optionsSeen = [];
    applyArgs = [];
    runnerResult = true;
    await setSetting(undefined);

    for (const key of ['showInformationMessage', 'showWarningMessage', 'showErrorMessage', 'showQuickPick']) {
      saved[key] = w[key];
    }
    for (const key of RUNNERS) {
      saved[key] = runnerRef[key];
    }
    w.showInformationMessage = (message: string) => { infos.push(message); return Promise.resolve(undefined); };
    w.showWarningMessage = (message: string) => { warnings.push(message); return Promise.resolve(undefined); };
    w.showErrorMessage = () => Promise.resolve(undefined);
    w.showQuickPick = (items: readonly vscode.QuickPickItem[]) => {
      pickItems.push(items);
      const answer = picks.shift();
      assert.ok(answer, 'неожиданный showQuickPick');
      return Promise.resolve(answer(items));
    };
    const record = (kind: string, args: unknown[]): boolean => {
      const options = args[6] as { updateDatabase: boolean; lag: unknown };
      optionsSeen.push(options);
      calls.push(`${kind}:${String(args[0])}:${options.updateDatabase ? 'load-and-update' : 'load'}`);
      return runnerResult;
    };
    runnerRef.runUpdateMainConfiguration = (...args: unknown[]) => Promise.resolve(record('cf', args));
    runnerRef.runUpdateExtension = (...args: unknown[]) => Promise.resolve(record('cfe', args));
    runnerRef.runApplyDatabaseConfiguration = (...args: unknown[]) => {
      const target = args[0] as { kind: string; name: string };
      applyArgs.push(args);
      calls.push(`${target.kind}:${target.name}:update-only`);
      return Promise.resolve(runnerResult);
    };

    const services = {
      workspaceFolder: { uri: vscode.Uri.file(root), name: 'db-cmd', index: 0 },
      outputChannel: { appendLine: () => undefined, show: () => undefined } as unknown as vscode.OutputChannel,
      setTreeProcessingState: () => undefined,
      refreshActionsView: () => undefined,
      standaloneServerService: { refreshHealth: () => Promise.resolve({ configured: false, state: 'stopped', pid: null }) },
      getChangedConfigurations: () => Promise.resolve(changed),
      markConfigurationsClean: (roots: string[]) => { cleaned.push(roots); },
      reloadEntries: () => Promise.resolve(),
      databaseConfigLag: lag,
    } as unknown as CommandServices;

    handlers = new Map();
    saved.registerCommand = commandsRef.registerCommand;
    commandsRef.registerCommand = (id: string, callback: Handler) => {
      handlers.set(id, callback);
      return { dispose: () => undefined };
    };
    try {
      registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext, services);
    } finally {
      commandsRef.registerCommand = saved.registerCommand;
    }
  });

  teardown(async () => {
    if (isConfigurationOperationRunning()) {
      await endConfigurationOperation();
    }
    for (const key of ['showInformationMessage', 'showWarningMessage', 'showErrorMessage', 'showQuickPick']) {
      w[key] = saved[key];
    }
    for (const key of RUNNERS) {
      runnerRef[key] = saved[key];
    }
    await setSetting(undefined);
  });

  suite('updateChangedConfigurations: режим загрузки', () => {
    const cases: { title: string; setting: boolean | undefined; args: unknown[]; expected: boolean }[] = [
      { title: 'настройка не задана (true)', setting: undefined, args: [], expected: true },
      { title: 'настройка true', setting: true, args: [], expected: true },
      { title: 'настройка false', setting: false, args: [], expected: false },
      { title: 'аргумент { updateDatabase: true } побеждает настройку false (тонкий клиент)', setting: false, args: [{ updateDatabase: true }], expected: true },
      { title: 'аргумент { updateDatabase: false } побеждает настройку true', setting: true, args: [{ updateDatabase: false }], expected: false },
      { title: 'пустой объект аргументов — как настройка (false)', setting: false, args: [{}], expected: false },
    ];
    for (const row of cases) {
      test(`${row.title}: updateDatabase=${String(row.expected)}, раннер получает services.databaseConfigLag`, async () => {
        await setSetting(row.setting);
        changed = [cfChanged()];

        await handler(ID.changed)(...row.args);

        assert.deepStrictEqual(calls, [`cf:Основная:${row.expected ? 'load-and-update' : 'load'}`]);
        assert.strictEqual(optionsSeen[0].lag, lag);
        assert.deepStrictEqual(cleaned, [[cfRoot]]);
      });
    }

    test('изменений нет, цель ОТСТАЁТ, updateDatabase=true: применение БД (update-only), «изменений не обнаружено» не показывается', async () => {
      lag.markBehind(lagCf(), 'load-without-update');

      await handler(ID.changed)({ updateDatabase: true });

      assert.deepStrictEqual(calls, ['cf:Основная:update-only']);
      assert.strictEqual(applyArgs[0][3], lag, 'раннер применения получает признак');
      assert.ok(!infos.includes('Изменений в конфигурациях не обнаружено.'), infos.join('|'));
    });

    test('изменений нет, цель отстаёт, настройка false: ничего не запускается, «изменений не обнаружено»', async () => {
      await setSetting(false);
      lag.markBehind(lagCf(), 'load-without-update');

      await handler(ID.changed)();

      assert.deepStrictEqual(calls, []);
      assert.ok(infos.includes('Изменений в конфигурациях не обнаружено.'), infos.join('|'));
    });

    test('изменений нет и никто не отстаёт: сообщение, раннеры не вызываются, замок освобождён', async () => {
      await handler(ID.changed)();

      assert.deepStrictEqual(calls, []);
      assert.ok(infos.includes('Изменений в конфигурациях не обнаружено.'), infos.join('|'));
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });

    test('сбой раннера: цель не помечается чистой, остановка на ней', async () => {
      changed = [cfChanged()];
      runnerResult = false;

      const result = await handler(ID.changed)();

      assert.strictEqual(result, false);
      assert.deepStrictEqual(cleaned.flat(), []);
    });

    test('замок занят: ни один раннер не вызывается', async () => {
      assert.strictEqual(await tryBeginConfigurationOperation(), true);
      changed = [cfChanged()];

      await handler(ID.changed)();

      assert.deepStrictEqual(calls, []);
    });
  });

  suite('updateConfigurationInDb / loadConfigurationChangesInDb', () => {
    for (const setting of [true, false]) {
      test(`updateConfigurationInDb (cf) при настройке ${String(setting)}: ВСЕГДА с обновлением БД — явная команда от настройки не зависит`, async () => {
        await setSetting(setting);

        await handler(ID.inDb)(nodeOf('configuration', 'Основная', cfRoot));

        assert.deepStrictEqual(calls, ['cf:Основная:load-and-update']);
        assert.strictEqual(optionsSeen[0].lag, lag);
      });

      test(`updateConfigurationInDb (расширение) при настройке ${String(setting)}: с обновлением БД`, async () => {
        await setSetting(setting);

        await handler(ID.inDb)(nodeOf('extension', 'А', aRoot));

        assert.deepStrictEqual(calls, ['cfe:А:load-and-update']);
      });

      test(`loadConfigurationChangesInDb (cf) при настройке ${String(setting)}: ВСЕГДА без обновления БД; проект помечается чистым`, async () => {
        await setSetting(setting);

        await handler(ID.load)(nodeOf('configuration', 'Основная', cfRoot));

        assert.deepStrictEqual(calls, ['cf:Основная:load']);
        assert.deepStrictEqual(cleaned, [[cfRoot]]);
      });

      test(`loadConfigurationChangesInDb (расширение) при настройке ${String(setting)}: без обновления БД`, async () => {
        await setSetting(setting);

        await handler(ID.load)(nodeOf('extension', 'А', aRoot));

        assert.deepStrictEqual(calls, ['cfe:А:load']);
        assert.deepStrictEqual(cleaned, [[aRoot]]);
      });
    }

    test('loadConfigurationChangesInDb: сбой загрузки — проект не помечается чистым', async () => {
      runnerResult = false;
      await handler(ID.load)(nodeOf('configuration', 'Основная', cfRoot));
      assert.deepStrictEqual(cleaned, []);
    });

    test('loadConfigurationChangesInDb: не корень (объект) — предупреждение, раннер не вызывается', async () => {
      await handler(ID.load)({ nodeKind: 'Catalog', label: 'Товары', xmlPath: path.join(cfRoot, 'Catalogs', 'Товары.xml') });
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(warnings.length, 1);
    });

    test('loadConfigurationChangesInDb: замок занят — раннер не вызывается', async () => {
      assert.strictEqual(await tryBeginConfigurationOperation(), true);
      await handler(ID.load)(nodeOf('configuration', 'Основная', cfRoot));
      assert.deepStrictEqual(calls, []);
    });
  });

  suite('updateDatabaseConfiguration', () => {
    test('узел основной конфигурации: применение без загрузки с признаком; файлы проекта не менялись — «чистым» не помечается', async () => {
      await handler(ID.updateDb)(nodeOf('configuration', 'Основная', cfRoot));

      assert.strictEqual(calls.length, 1);
      const target = applyArgs[0][0] as { kind: string; rootPath: string };
      assert.deepStrictEqual([target.kind, target.rootPath], ['cf', cfRoot]);
      assert.strictEqual(applyArgs[0][3], lag);
      assert.deepStrictEqual(cleaned, []);
    });

    test('узел расширения: цель cfe с extensionName', async () => {
      await handler(ID.updateDb)(nodeOf('extension', 'А', aRoot));

      const target = applyArgs[0][0] as { kind: string; rootPath: string; extensionName?: string };
      assert.deepStrictEqual([target.kind, target.rootPath, target.extensionName], ['cfe', aRoot, 'А']);
    });

    test('не корень (объект): предупреждение, применения нет', async () => {
      await handler(ID.updateDb)({ nodeKind: 'Catalog', label: 'Товары', xmlPath: path.join(cfRoot, 'Catalogs', 'Товары.xml') });
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(warnings.length, 1);
    });

    test('без узла, отстают две цели: QuickPick по ним; выбор расширения → применяется именно оно', async () => {
      lag.markBehind(lagCf(), 'load-without-update');
      lag.markBehind(lagCfe('А', aRoot), 'cf-file-load');
      picks.push((items) => items.find((item) => item.label.includes('А')));

      await handler(ID.updateDb)();

      assert.strictEqual(pickItems.length, 1);
      assert.ok(pickItems[0].some((item) => item.label.includes('Основная')), pickItems[0].map((item) => item.label).join('|'));
      const target = applyArgs[0][0] as { kind: string; extensionName?: string };
      assert.deepStrictEqual([target.kind, target.extensionName], ['cfe', 'А']);
    });

    test('без узла, Esc в выборе: ничего не применяется', async () => {
      lag.markBehind(lagCf(), 'load-without-update');
      lag.markBehind(lagCfe('А', aRoot), 'cf-file-load');
      picks.push(() => undefined);

      await handler(ID.updateDb)();

      assert.deepStrictEqual(calls, []);
    });

    test('замок занят: применение не запускается', async () => {
      assert.strictEqual(await tryBeginConfigurationOperation(), true);
      await handler(ID.updateDb)(nodeOf('configuration', 'Основная', cfRoot));
      assert.deepStrictEqual(calls, []);
    });

    test('отказ применения: false', async () => {
      runnerResult = false;
      assert.strictEqual(await handler(ID.updateDb)(nodeOf('configuration', 'Основная', cfRoot)), false);
    });
  });

  suite('databaseLag.showActions (клик по статус-бару)', () => {
    const behindTwo = (): void => {
      lag.markBehind(lagCf(), 'load-without-update');
      lag.markBehind(lagCfe('А', aRoot), 'update-failed');
    };
    const labels = (): string[] => pickItems[0].map((item) => item.label);

    test('пункты: «Обновить конфигурацию БД: <имя>» по каждой цели, «Обновить все», «Отметить как обновлённую (обновлено вне расширения)»', async () => {
      behindTwo();
      picks.push(() => undefined);

      await handler(ID.lagActions)();

      assert.ok(labels().includes('$(database) Обновить конфигурацию БД: Основная'), labels().join('|'));
      assert.ok(labels().includes('$(database) Обновить конфигурацию БД: А'), labels().join('|'));
      assert.ok(labels().includes('$(database) Обновить все'), labels().join('|'));
      assert.ok(labels().some((label) => label.startsWith('$(check) Отметить как обновлённую')), labels().join('|'));
      assert.deepStrictEqual(calls, []);
    });

    test('«Обновить конфигурацию БД: А» → применяется только А', async () => {
      behindTwo();
      picks.push((items) => items.find((item) => item.label === '$(database) Обновить конфигурацию БД: А'));

      await handler(ID.lagActions)();

      assert.deepStrictEqual(calls, ['cfe:А:update-only']);
    });

    test('«Обновить все» → применяются все отстающие цели (cf первой)', async () => {
      behindTwo();
      picks.push((items) => items.find((item) => item.label === '$(database) Обновить все'));

      await handler(ID.lagActions)();

      assert.deepStrictEqual(calls, ['cf:Основная:update-only', 'cfe:А:update-only']);
    });

    test('«Отметить как обновлённую» → выбор цели и markCurrent без запуска платформы', async () => {
      behindTwo();
      picks.push(
        (items) => items.find((item) => item.label.startsWith('$(check) Отметить как обновлённую')),
        (items) => items.find((item) => item.label.includes('А'))
      );

      await handler(ID.lagActions)();

      assert.deepStrictEqual(calls, []);
      assert.strictEqual(lag.isBehind(lagCfe('А', aRoot)), false);
      assert.strictEqual(lag.isBehind(lagCf()), true);
    });

    test('Esc: ничего не меняется', async () => {
      behindTwo();
      picks.push(() => undefined);
      await handler(ID.lagActions)();
      assert.strictEqual(lag.list().length, 2);
    });

    test('нет отстающих целей: команда безвредна (без окон выбора и без запусков)', async () => {
      await handler(ID.lagActions)();
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(pickItems.length, 0);
    });
  });

  suite('updateChangedConfigurations: несколько целей, сбой и отказ выбора', () => {
    const bRoot = path.join(root, 'src', 'cfe', 'Б');
    const several = (): void => {
      changed = [cfChanged(), { kind: 'cfe', name: 'Б', rootPath: bRoot, changedFilesCount: 1 }];
      lag.markBehind(lagCfe('А', aRoot), 'cf-file-load');
    };

    type PickItem = vscode.QuickPickItem & { readonly selectAll?: boolean };
    /**
     * Подставное окно множественного выбора (`createQuickPick`): присваивание `selectedItems` шлёт событие
     * выбора, как настоящее окно, — так проверяется и защита от рекурсии при программной отметке «Все».
     */
    function fakeQuickPick(script: (pick: FakePick) => void): { opened: FakePick[] } {
      const opened: FakePick[] = [];
      w.createQuickPick = () => {
        const pick = new FakePick(script);
        opened.push(pick);
        return pick;
      };
      return { opened };
    }
    class FakePick {
      items: PickItem[] = [];
      canSelectMany = false;
      title = '';
      placeholder = '';
      disposed = false;
      private selection: PickItem[] = [];
      private onSelect: (items: PickItem[]) => void = () => undefined;
      private onAccept: () => void = () => undefined;
      private onHide: () => void = () => undefined;
      constructor(private readonly script: (pick: FakePick) => void) {}
      get selectedItems(): PickItem[] { return this.selection; }
      set selectedItems(items: PickItem[]) { this.selection = items; this.onSelect(items); }
      onDidChangeSelection(listener: (items: PickItem[]) => void): void { this.onSelect = listener; }
      onDidAccept(listener: () => void): void { this.onAccept = listener; }
      onDidHide(listener: () => void): void { this.onHide = listener; }
      /** Действие пользователя: выбор в окне (без программной отметки). */
      choose(items: PickItem[]): void { this.selection = items; this.onSelect(items); }
      accept(): void { this.onAccept(); }
      show(): void { this.script(this); }
      hide(): void { this.onHide(); }
      dispose(): void { this.disposed = true; }
    }

    setup(() => { saved.createQuickPick = w.createQuickPick; });
    teardown(() => { w.createQuickPick = saved.createQuickPick; });

    test('целей больше одной: ничего не отмечено, пункт «Все изменённые», у цели число изменённых файлов; «Все» → все цели по порядку', async () => {
      several();
      const { opened } = fakeQuickPick((pick) => {
        const [all, ...targets] = pick.items;
        pick.choose([all]); // «Все» отмечает все цели
        pick.choose(pick.selectedItems.slice(0, -1)); // снята одна цель — «Все» снимается
        pick.choose(targets); // отмечены все цели вручную — «Все» отмечается сам
        pick.choose([...pick.selectedItems]); // повтор того же выбора ничего не меняет
        pick.accept();
      });

      assert.strictEqual(await handler(ID.changed)({ updateDatabase: true }), true);

      const pick = opened[0];
      assert.strictEqual(pick.canSelectMany, true);
      assert.deepStrictEqual(pick.items.map((item) => [item.label, item.description, item.detail]), [
        ['$(check-all) Все изменённые', '3', undefined],
        ['$(database) Основная', 'Основная конфигурация', '2 изменённых файлов'],
        ['$(extensions) А', 'Расширение', 'только обновление конфигурации БД'],
        ['$(extensions) Б', 'Расширение', '1 изменённых файлов'],
      ]);
      assert.strictEqual(pick.disposed, true);
      assert.deepStrictEqual(calls, ['cf:Основная:load-and-update', 'cfe:А:update-only', 'cfe:Б:load-and-update']);
      assert.deepStrictEqual(cleaned, [[cfRoot, bRoot]], 'цель update-only файлов проекта не меняла — «чистой» не помечается');
      assert.ok(infos.includes('Обновлено конфигураций: 3.'), infos.join('|'));
    });

    test('выбрана часть целей: запускаются только выбранные', async () => {
      several();
      fakeQuickPick((pick) => {
        pick.choose([pick.items[3]]);
        pick.accept();
      });

      assert.strictEqual(await handler(ID.changed)({ updateDatabase: true }), true);

      assert.deepStrictEqual(calls, ['cfe:Б:load-and-update']);
    });

    test('окно выбора закрыто без подтверждения: ничего не запускается, false, замок освобождён', async () => {
      several();
      fakeQuickPick((pick) => { pick.hide(); });

      assert.strictEqual(await handler(ID.changed)({ updateDatabase: true }), false);

      assert.deepStrictEqual(calls, []);
      assert.strictEqual(isConfigurationOperationRunning(), false);
    });

    test('исключение раннера: сообщение об ошибке, false, проект не помечается чистым', async () => {
      changed = [cfChanged()];
      runnerRef.runUpdateMainConfiguration = () => Promise.reject(new Error('сбой процесса'));
      const errors: string[] = [];
      w.showErrorMessage = (message: string) => { errors.push(message); return Promise.resolve(undefined); };

      assert.strictEqual(await handler(ID.changed)(), false);

      assert.ok(errors.some((message) => message.includes('сбой процесса')), errors.join('|'));
      assert.deepStrictEqual(cleaned.flat(), []);
    });
  });

  suite('updateDatabaseConfiguration без узла и без отстающих целей', () => {
    test('loadConfigurationChangesInDb без узла (палитра команд): предупреждение, без исключения и запуска', async () => {
      assert.strictEqual(await handler(ID.load)(), false);
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(warnings.length, 1);
    });

    test('сообщение «нет отстающих», выбора и применения нет', async () => {
      assert.strictEqual(await handler(ID.updateDb)(), false);

      assert.deepStrictEqual(calls, []);
      assert.strictEqual(pickItems.length, 0);
      assert.ok(infos.some((message) => message.includes('Нет конфигураций, отмеченных как не обновлённые в БД')), infos.join('|'));
    });
  });
});
