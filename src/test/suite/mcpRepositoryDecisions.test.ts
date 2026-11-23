import * as assert from 'assert';
import * as vscode from 'vscode';
import { describeLockedOverwrite } from '../../ui/commands/repository/repositoryUpdateFlow';
import * as path from 'path';
import type { RepositoryTarget } from '../../infra/repository/RepositoryService';
import {
  MCP_REPOSITORY_PATHS_LIMIT,
  assertCommitArgs,
  assertRootRecursiveLockConfirmed,
  assertSingleRepositoryTarget,
  normalizeRepositoryPathsInput,
  resolveMcpCommitPlan,
  resolveMcpLockPlan,
  resolveMcpUpdatePlan,
  toRepositoryNodeRef,
  type McpCommitLocalChanges,
  type McpLockLocalChanges,
  type McpUpdateLocalChanges,
} from '../../ui/mcp/registration/McpRepositoryDecisions';
import { MetadataNode } from '../../ui/tree/TreeNode';

/**
 * Чистые решения MCP-инструментов хранилища (`ui/mcp/registration/McpRepositoryDecisions.ts`):
 * enum агента → ответы планировщиков `planRepository*`; `resolveMcp*Plan` БРОСАЮТ Error вместо
 * 'ask'/'cancel' (агент не видит диалогов — вопрос диалога превращается в явный параметр).
 */

const CONFIRM_ROOT =
  'Рекурсивный захват корня захватывает всю конфигурацию и блокирует её для всей команды. Передайте confirm: true.';
const CONFIRM_COMMIT = 'Помещение необратимо записывает версию в общее хранилище команды. Передайте confirm: true.';
const EMPTY_COMMENT = 'Для помещения требуется непустой комментарий (comment).';
const OVERWRITE_FALSE = 'Получение не выполнено: в выборке есть захваченные вами объекты (overwriteLocked: false).';
const OVERWRITE_HINT = ' Передайте overwriteLocked: true, чтобы подтвердить, или сначала поместите правки (v8vscedit_repository_commit).';

const names = (count: number): string[] => Array.from({ length: count }, (_, i) => `Справочник.Объект${String(i + 1)}`);

suite('McpRepositoryDecisions: resolveMcpLockPlan', () => {
  const REVISED: readonly boolean[] = [true, false];
  const CHOICES: readonly (McpLockLocalChanges | undefined)[] = [undefined, 'loadFirst', 'keepProjectBehind', 'abort'];

  for (const revisedSetting of REVISED) {
    for (const localChanges of CHOICES) {
      test(`dirty=0, revised=${String(revisedSetting)}, localChanges=${String(localChanges)}: ответ не нужен, значение игнорируется`, () => {
        assert.deepStrictEqual(
          resolveMcpLockPlan({ revisedSetting, dirtyFilesCount: 0, localChanges, updateDatabaseAfterLoad: true }),
          { revised: revisedSetting, updateDatabaseFirst: false, updateDatabaseOnLoad: false, importAfterLock: true }
        );
      });
    }

    test(`dirty=3, revised=${String(revisedSetting)}, loadFirst → update-then-lock`, () => {
      assert.deepStrictEqual(
        resolveMcpLockPlan({ revisedSetting, dirtyFilesCount: 3, localChanges: 'loadFirst', updateDatabaseAfterLoad: true }),
        { revised: revisedSetting, updateDatabaseFirst: true, updateDatabaseOnLoad: true, importAfterLock: true }
      );
    });

    test(`dirty=3, revised=${String(revisedSetting)}, keepProjectBehind → lock-without-import (-revised отключается)`, () => {
      assert.deepStrictEqual(
        resolveMcpLockPlan({ revisedSetting, dirtyFilesCount: 3, localChanges: 'keepProjectBehind', updateDatabaseAfterLoad: true }),
        { revised: false, updateDatabaseFirst: false, updateDatabaseOnLoad: false, importAfterLock: false }
      );
    });
  }

  test('dirty=3, localChanges не задан → ошибка с числом файлов и перечнем вариантов', () => {
    assert.throws(
      () => resolveMcpLockPlan({ revisedSetting: true, dirtyFilesCount: 3, updateDatabaseAfterLoad: true }),
      (error: Error) => error.message.includes('3')
        && ['loadFirst', 'keepProjectBehind', 'abort'].every((option) => error.message.includes(option))
        && error.message.includes('localChanges')
    );
  });

  test('dirty=3, abort → «Захват не выполнен: …»', () => {
    assert.throws(
      () => resolveMcpLockPlan({ revisedSetting: true, dirtyFilesCount: 3, localChanges: 'abort', updateDatabaseAfterLoad: true }),
      (error: Error) => error.message.startsWith('Захват не выполнен:')
    );
  });
});

suite('McpRepositoryDecisions: resolveMcpUpdatePlan', () => {
  const DIRTY: readonly number[] = [0, 3];
  const LOCKED = [names(0), names(1), names(7)];
  const OVERWRITE: readonly (boolean | undefined)[] = [undefined, true, false];
  const CHOICES: readonly (McpUpdateLocalChanges | undefined)[] = [undefined, 'loadAfter', 'keepProjectBehind', 'abort'];

  for (const dirtyFilesCount of DIRTY) {
    for (const lockedInSelection of LOCKED) {
      for (const overwriteLocked of OVERWRITE) {
        for (const localChanges of CHOICES) {
          const title = `dirty=${String(dirtyFilesCount)}, locked=${String(lockedInSelection.length)}, overwriteLocked=${String(overwriteLocked)}, localChanges=${String(localChanges)}`;
          test(title, () => {
            const run = (): unknown => resolveMcpUpdatePlan({ dirtyFilesCount, lockedInSelection, overwriteLocked, localChanges, updateDatabaseAfterLoad: true });
            // Оракул — порядок вопросов планировщика: сначала захваченные, потом правки проекта.
            if (lockedInSelection.length > 0 && overwriteLocked === undefined) {
              assert.throws(run, (error: Error) => error.message === `${describeLockedOverwrite(lockedInSelection)}${OVERWRITE_HINT}`);
              return;
            }
            if (lockedInSelection.length > 0 && overwriteLocked === false) {
              assert.throws(run, (error: Error) => error.message === OVERWRITE_FALSE);
              return;
            }
            if (dirtyFilesCount === 0) {
              assert.deepStrictEqual(run(), { loadChangesAfterReceive: false, updateDatabaseOnLoad: false, importAfterReceive: true });
              return;
            }
            switch (localChanges) {
              case undefined:
                assert.throws(run, (error: Error) => error.message.includes('3') && error.message.includes('localChanges')
                  && ['loadAfter', 'keepProjectBehind', 'abort'].every((option) => error.message.includes(option)));
                return;
              case 'loadAfter':
                assert.deepStrictEqual(run(), { loadChangesAfterReceive: true, updateDatabaseOnLoad: true, importAfterReceive: true });
                return;
              case 'keepProjectBehind':
                assert.deepStrictEqual(run(), { loadChangesAfterReceive: false, updateDatabaseOnLoad: false, importAfterReceive: false });
                return;
              case 'abort':
                assert.throws(run, (error: Error) => error.message.startsWith('Получение не выполнено:'));
            }
          });
        }
      }
    }
  }

  test('описание захваченных: 7 объектов → пять имён и «и ещё 2» (текст формирует describeLockedOverwrite)', () => {
    assert.throws(
      () => resolveMcpUpdatePlan({ dirtyFilesCount: 0, lockedInSelection: names(7), updateDatabaseAfterLoad: true }),
      (error: Error) => error.message.includes('и ещё 2') && error.message.endsWith(OVERWRITE_HINT)
    );
  });
});

suite('McpRepositoryDecisions: resolveMcpCommitPlan', () => {
  const CHOICES: readonly (McpCommitLocalChanges | undefined)[] = [undefined, 'loadFirst', 'abort'];

  for (const localChanges of CHOICES) {
    test(`dirty=0, localChanges=${String(localChanges)}: помещать без загрузки можно`, () => {
      assert.deepStrictEqual(
        resolveMcpCommitPlan({ dirtyFilesCount: 0, localChanges, updateDatabaseAfterLoad: true }),
        { updateDatabaseFirst: false, updateDatabaseOnLoad: false }
      );
    });
  }

  test('dirty=3, loadFirst → загрузка перед помещением', () => {
    assert.deepStrictEqual(
      resolveMcpCommitPlan({ dirtyFilesCount: 3, localChanges: 'loadFirst', updateDatabaseAfterLoad: true }),
      { updateDatabaseFirst: true, updateDatabaseOnLoad: true }
    );
  });

  test('dirty=3 без localChanges → точный текст с числом файлов и подсказкой loadFirst', () => {
    assert.throws(
      () => resolveMcpCommitPlan({ dirtyFilesCount: 3, updateDatabaseAfterLoad: true }),
      (error: Error) => error.message.startsWith(
        'В проекте 3 незагруженных изменённых файлов; помещение без предварительной загрузки запрещено. Передайте localChanges: \'loadFirst\''
      )
    );
  });

  test('dirty=3, abort → «Помещение не выполнено: …»', () => {
    assert.throws(
      () => resolveMcpCommitPlan({ dirtyFilesCount: 3, localChanges: 'abort', updateDatabaseAfterLoad: true }),
      (error: Error) => error.message.startsWith('Помещение не выполнено:')
    );
  });
});

suite('McpRepositoryDecisions: assertCommitArgs, захват корня, адаптер узла', () => {
  const NOT_CONFIRMED: readonly (boolean | undefined)[] = [undefined, false];

  for (const confirm of NOT_CONFIRMED) {
    test(`assertCommitArgs: confirm=${String(confirm)} → точный текст про необратимость (раньше проверки комментария)`, () => {
      assert.throws(
        () => assertCommitArgs({ confirm, comment: '' }),
        (error: Error) => error.message === CONFIRM_COMMIT
      );
    });
  }

  const BLANK_COMMENTS = ['', '   ', '\t\n'];
  for (const comment of BLANK_COMMENTS) {
    test(`assertCommitArgs: confirm=true, comment=${JSON.stringify(comment)} → «непустой комментарий»`, () => {
      assert.throws(
        () => assertCommitArgs({ confirm: true, comment }),
        (error: Error) => error.message === EMPTY_COMMENT
      );
    });
  }

  test('assertCommitArgs: confirm=true и содержательный комментарий — молча проходит', () => {
    assert.doesNotThrow(() => assertCommitArgs({ confirm: true, comment: 'Правка' }));
  });

  const ROOT_KINDS = ['configuration', 'extension'];
  for (const nodeKind of ROOT_KINDS) {
    for (const confirm of [undefined, false]) {
      test(`assertRootRecursiveLockConfirmed: корень ${nodeKind}, recursive=true, confirm=${String(confirm)} → точный текст`, () => {
        assert.throws(
          () => assertRootRecursiveLockConfirmed({ nodeKind, recursive: true, confirm }),
          (error: Error) => error.message === CONFIRM_ROOT
        );
      });
    }
    test(`assertRootRecursiveLockConfirmed: корень ${nodeKind}: confirm=true или recursive=false проходят`, () => {
      assert.doesNotThrow(() => assertRootRecursiveLockConfirmed({ nodeKind, recursive: true, confirm: true }));
      assert.doesNotThrow(() => assertRootRecursiveLockConfirmed({ nodeKind, recursive: false }));
    });
  }

  test('assertRootRecursiveLockConfirmed: не корень (Catalog/undefined) рекурсивно без confirm — проходит', () => {
    assert.doesNotThrow(() => assertRootRecursiveLockConfirmed({ nodeKind: 'Catalog', recursive: true }));
    assert.doesNotThrow(() => assertRootRecursiveLockConfirmed({ recursive: true }));
  });

  test('toRepositoryNodeRef: label берётся из textLabel (label узла может быть TreeItemLabel), остальное — как есть', () => {
    const metaContext = { rootMetaKind: 'Catalog', ownerObjectXmlPath: 'C:\\p\\Catalogs\\Товары.xml' };
    const ref = toRepositoryNodeRef({
      nodeKind: 'Attribute',
      label: { label: 'ИГНОРИРУЕТСЯ' },
      textLabel: 'Артикул',
      xmlPath: 'C:\\p\\Catalogs\\Товары.xml',
      metaContext,
    });
    assert.strictEqual(ref.label, 'Артикул');
    assert.strictEqual(ref.nodeKind, 'Attribute');
    assert.strictEqual(ref.xmlPath, 'C:\\p\\Catalogs\\Товары.xml');
    assert.deepStrictEqual(ref.metaContext, metaContext);
  });

  test('toRepositoryNodeRef: настоящий MetadataNode без metaContext/xmlPath', () => {
    const node = new MetadataNode({ label: 'Группа', nodeKind: 'group-type' }, vscode.TreeItemCollapsibleState.None);
    const ref = toRepositoryNodeRef(node);
    assert.strictEqual(ref.label, 'Группа');
    assert.strictEqual(ref.nodeKind, 'group-type');
    assert.strictEqual(ref.xmlPath, undefined);
    assert.strictEqual(ref.metaContext, undefined);
  });
});

/**
 * `updateDatabase` (необязательный параметр инструментов lock/update/commit): режим шага загрузки, а не
 * вопрос диалога, поэтому значение по умолчанию допустимо — им служит настройка `updateDatabaseAfterLoad`.
 * Явное значение побеждает настройку в обе стороны; без шага загрузки `updateDatabaseOnLoad=false` всегда.
 */
suite('McpRepositoryDecisions: updateDatabase (undefined → настройка) для lock/update/commit', () => {
  const MATRIX: readonly { updateDatabase: boolean | undefined; setting: boolean; effective: boolean }[] = [
    { updateDatabase: undefined, setting: true, effective: true },
    { updateDatabase: undefined, setting: false, effective: false },
    { updateDatabase: true, setting: false, effective: true },
    { updateDatabase: true, setting: true, effective: true },
    { updateDatabase: false, setting: true, effective: false },
    { updateDatabase: false, setting: false, effective: false },
  ];

  for (const row of MATRIX) {
    const tag = `updateDatabase=${String(row.updateDatabase)}, настройка=${String(row.setting)} → ${String(row.effective)}`;

    test(`lock, шаг загрузки есть (loadFirst): ${tag}`, () => {
      const plan = resolveMcpLockPlan({
        revisedSetting: true, dirtyFilesCount: 2, localChanges: 'loadFirst',
        updateDatabase: row.updateDatabase, updateDatabaseAfterLoad: row.setting,
      });
      assert.deepStrictEqual(plan, { revised: true, updateDatabaseFirst: true, updateDatabaseOnLoad: row.effective, importAfterLock: true });
    });

    test(`lock, шага загрузки нет (чистый проект и keepProjectBehind): ${tag} → updateDatabaseOnLoad=false`, () => {
      assert.strictEqual(
        resolveMcpLockPlan({
          revisedSetting: true, dirtyFilesCount: 0, updateDatabase: row.updateDatabase, updateDatabaseAfterLoad: row.setting,
        }).updateDatabaseOnLoad,
        false
      );
      assert.strictEqual(
        resolveMcpLockPlan({
          revisedSetting: true, dirtyFilesCount: 2, localChanges: 'keepProjectBehind',
          updateDatabase: row.updateDatabase, updateDatabaseAfterLoad: row.setting,
        }).updateDatabaseOnLoad,
        false
      );
    });

    test(`update, шаг загрузки есть (loadAfter): ${tag}`, () => {
      const plan = resolveMcpUpdatePlan({
        dirtyFilesCount: 2, lockedInSelection: [], localChanges: 'loadAfter',
        updateDatabase: row.updateDatabase, updateDatabaseAfterLoad: row.setting,
      });
      assert.deepStrictEqual(plan, { loadChangesAfterReceive: true, updateDatabaseOnLoad: row.effective, importAfterReceive: true });
    });

    test(`update, шага загрузки нет (чистый проект и keepProjectBehind): ${tag} → updateDatabaseOnLoad=false`, () => {
      assert.strictEqual(
        resolveMcpUpdatePlan({
          dirtyFilesCount: 0, lockedInSelection: [], updateDatabase: row.updateDatabase, updateDatabaseAfterLoad: row.setting,
        }).updateDatabaseOnLoad,
        false
      );
      assert.strictEqual(
        resolveMcpUpdatePlan({
          dirtyFilesCount: 2, lockedInSelection: [], localChanges: 'keepProjectBehind',
          updateDatabase: row.updateDatabase, updateDatabaseAfterLoad: row.setting,
        }).updateDatabaseOnLoad,
        false
      );
    });

    test(`commit, шаг загрузки есть (loadFirst): ${tag}`, () => {
      const plan = resolveMcpCommitPlan({
        dirtyFilesCount: 2, localChanges: 'loadFirst', updateDatabase: row.updateDatabase, updateDatabaseAfterLoad: row.setting,
      });
      assert.deepStrictEqual(plan, { updateDatabaseFirst: true, updateDatabaseOnLoad: row.effective });
    });

    test(`commit, шага загрузки нет (чистый проект): ${tag} → updateDatabaseOnLoad=false`, () => {
      assert.deepStrictEqual(
        resolveMcpCommitPlan({ dirtyFilesCount: 0, updateDatabase: row.updateDatabase, updateDatabaseAfterLoad: row.setting }),
        { updateDatabaseFirst: false, updateDatabaseOnLoad: false }
      );
    });
  }
});

suite('McpRepositoryDecisions: normalizeRepositoryPathsInput (path/paths, план mcp-repository-paths §1.1)', () => {
  const BOTH = 'Передайте либо path (один объект), либо paths (список объектов), но не оба.';
  const NONE = 'Укажите path (канонический путь объекта) или paths (список канонических путей).';
  const EMPTY_LIST = 'Список paths пуст: передайте хотя бы один канонический путь.';
  const tooMany = (count: number): string =>
    `В paths ${String(count)} путей; за один вызов допускается не более 100. Для крупной выборки используйте ` +
    'рекурсивную операцию над подсистемой или корнем (recursive: true) либо разбейте список.';
  const many = (count: number): string[] => Array.from({ length: count }, (_, i) => `Справочники.Объект${String(i + 1)}`);
  const message = (text: string) => (error: Error): boolean => error.message === text;
  const startsWith = (text: string) => (error: Error): boolean => error.message.startsWith(text);

  test('лимит — 100', () => {
    assert.strictEqual(MCP_REPOSITORY_PATHS_LIMIT, 100);
  });

  test('оба path и paths — отказ; paths: [] вместе с path — тоже «оба»', () => {
    assert.throws(() => normalizeRepositoryPathsInput({ path: 'Справочники.А', paths: ['Справочники.Б'] }), message(BOTH));
    assert.throws(() => normalizeRepositoryPathsInput({ path: 'Справочники.А', paths: [] }), message(BOTH));
  });

  test('не задано ни одно — отказ', () => {
    assert.throws(() => normalizeRepositoryPathsInput({}), message(NONE));
  });

  test('paths: [] — отказ', () => {
    assert.throws(() => normalizeRepositoryPathsInput({ paths: [] }), message(EMPTY_LIST));
  });

  test('пустой элемент после trim: позиция считается с 1', () => {
    assert.throws(() => normalizeRepositoryPathsInput({ paths: [''] }), message('Пустой элемент в paths (позиция 1).'));
    assert.throws(() => normalizeRepositoryPathsInput({ paths: ['Справочники.А', '   '] }), message('Пустой элемент в paths (позиция 2).'));
    assert.throws(
      () => normalizeRepositoryPathsInput({ paths: ['Справочники.А', 'Справочники.Б', '\t'] }),
      message('Пустой элемент в paths (позиция 3).')
    );
  });

  test('граница лимита: 100 допускается, 101 — отказ с числом путей', () => {
    assert.deepStrictEqual(normalizeRepositoryPathsInput({ paths: many(100) }), many(100));
    assert.throws(() => normalizeRepositoryPathsInput({ paths: many(101) }), message(tooMany(101)));
    assert.throws(() => normalizeRepositoryPathsInput({ paths: many(150) }), message(tooMany(150)));
  });

  test('буквальные повторы (после trim, регистр ru) — отказ с перечнем повторяющихся', () => {
    assert.throws(
      () => normalizeRepositoryPathsInput({ paths: ['Справочники.А', 'Справочники.Б', 'Справочники.А', 'Справочники.Б'] }),
      message('Повторяющиеся пути в paths: "Справочники.А", "Справочники.Б".')
    );
    assert.throws(
      () => normalizeRepositoryPathsInput({ paths: ['Справочники.А', 'Справочники.А', 'Справочники.А'] }),
      message('Повторяющиеся пути в paths: "Справочники.А".')
    );
    assert.throws(() => normalizeRepositoryPathsInput({ paths: ['Справочники.А', '  Справочники.А  '] }), startsWith('Повторяющиеся пути в paths: '));
    assert.throws(() => normalizeRepositoryPathsInput({ paths: ['Справочники.Товары', 'справочники.ТОВАРЫ'] }), startsWith('Повторяющиеся пути в paths: '));
  });

  test('порядок проверок: пустой элемент раньше повторов, длина раньше повторов', () => {
    assert.throws(() => normalizeRepositoryPathsInput({ paths: ['', ''] }), message('Пустой элемент в paths (позиция 1).'));
    assert.throws(
      () => normalizeRepositoryPathsInput({ paths: Array.from({ length: 101 }, () => 'Справочники.А') }),
      message(tooMany(101))
    );
  });

  test('успех: path → список из одного пути; paths из одного элемента; список сохраняет порядок', () => {
    assert.deepStrictEqual(normalizeRepositoryPathsInput({ path: 'Справочники.Товары' }), ['Справочники.Товары']);
    assert.deepStrictEqual(normalizeRepositoryPathsInput({ paths: ['Справочники.Товары'] }), ['Справочники.Товары']);
    assert.deepStrictEqual(
      normalizeRepositoryPathsInput({ paths: ['Справочники.Б', 'Справочники.А', 'Конфигурация'] }),
      ['Справочники.Б', 'Справочники.А', 'Конфигурация']
    );
  });

  test('разные пути к одному объекту — не повтор (дедупликация позже, по fullName)', () => {
    assert.deepStrictEqual(
      normalizeRepositoryPathsInput({ paths: ['Справочники.Товары', 'Справочники.Товары.Артикул'] }),
      ['Справочники.Товары', 'Справочники.Товары.Артикул']
    );
  });
});

suite('McpRepositoryDecisions: assertSingleRepositoryTarget (одна цель хранилища, §1.2)', () => {
  const cfRoot = path.resolve('проект', 'src', 'cf');
  const target = (configRoot: string, displayName: string, kind: 'cf' | 'cfe' = 'cf'): RepositoryTarget =>
    ({ configRoot, configKind: kind, displayName });
  const cf = target(cfRoot, 'Основная');
  const cfe1 = target(path.resolve('проект', 'src', 'cfe', 'Расш1'), 'Расш1', 'cfe');
  const cfe2 = target(path.resolve('проект', 'src', 'cfe', 'Расш2'), 'Расш2', 'cfe');
  const message = (text: string) => (error: Error): boolean => error.message === text;

  test('одна цель: возвращается она', () => {
    assert.strictEqual(assertSingleRepositoryTarget([{ path: 'Справочники.А', target: cf }]), cf);
  });

  test('несколько путей одной цели: возвращается цель', () => {
    const result = assertSingleRepositoryTarget([
      { path: 'Справочники.А', target: cf }, { path: 'Конфигурация', target: cf }, { path: 'Документы.Б', target: cf },
    ]);
    assert.strictEqual(result, cf);
  });

  test('корень в другом регистре — та же цель', () => {
    const sameRoot = target(cfRoot.toUpperCase(), 'Основная');
    assert.strictEqual(
      assertSingleRepositoryTarget([{ path: 'Справочники.А', target: cf }, { path: 'Справочники.Б', target: sameRoot }]),
      cf
    );
  });

  test('две цели: сообщение с ОДНИМ примером пути на цель, в порядке появления', () => {
    assert.throws(
      () => assertSingleRepositoryTarget([
        { path: 'Справочники.А', target: cf },
        { path: 'Справочники.Б', target: cf },
        { path: 'Расш1.Справочники.В', target: cfe1 },
        { path: 'Расш1.Справочники.Г', target: cfe1 },
      ]),
      message(
        'Все пути paths должны относиться к одной цели хранилища (основной конфигурации или одному расширению), ' +
        'а получено несколько: "Основная" (Справочники.А), "Расш1" (Расш1.Справочники.В). ' +
        'Выполните операцию отдельным вызовом для каждой цели.'
      )
    );
  });

  test('три цели: три примера', () => {
    assert.throws(
      () => assertSingleRepositoryTarget([
        { path: 'А', target: cfe2 }, { path: 'Б', target: cf }, { path: 'В', target: cfe1 },
      ]),
      message(
        'Все пути paths должны относиться к одной цели хранилища (основной конфигурации или одному расширению), ' +
        'а получено несколько: "Расш2" (А), "Основная" (Б), "Расш1" (В). ' +
        'Выполните операцию отдельным вызовом для каждой цели.'
      )
    );
  });
});
