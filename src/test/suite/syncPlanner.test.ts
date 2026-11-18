import * as assert from 'assert';
import type { DumpChangeSet } from '../../domain/agent/DumpChangesParser';
import {
  planImport,
  planLoad,
  type ImportPlanInput,
  type LoadPlanInput,
  type SyncStoreKind,
} from '../../infra/agent/sync/SyncPlanner';
import type { SyncMirrorState } from '../../infra/agent/sync/SyncManifest';

/**
 * Э7: SyncPlanner — чистый планировщик поверх данных (B, текущий P, разбор --get-changes, состояние M,
 * порог). Решения таблицы плана §1.1. Локальное хранилище — стратегия полного сравнения M и P
 * (разбор списка изменений и архив не используются); удалённое (sftp) — дельта/архив.
 */

const objects = (...fullNames: string[]): DumpChangeSet => ({
  kind: 'objects',
  objects: fullNames.map((fullName) => {
    const [kind, name, ...parts] = fullName.split('.');
    return { change: 'modified' as const, fullName, kind, name, parts };
  }),
});

function importInput(overrides: Partial<ImportPlanInput> = {}): ImportPlanInput {
  return {
    storeKind: 'sftp',
    mirrorState: 'fresh',
    changeSet: objects('Catalog.А'),
    changedFiles: ['Catalogs/А.xml'],
    unresolvedObjects: [],
    dirtyFiles: [],
    // Новые поля плана разреженного зеркала: по умолчанию M полный, как до их появления.
    mirrorCoverage: 'full',
    dirtyAddedFiles: [],
    unrestorableDirtyFiles: [],
    archiveThresholdFiles: 300,
    ...overrides,
  };
}

suite('SyncPlanner.planImport (Э7)', () => {
  suite('локальное хранилище: полное сравнение M и P', () => {
    const states: SyncMirrorState[] = ['empty', 'stale', 'fresh'];
    const sets: (DumpChangeSet | undefined)[] = [
      undefined,
      { kind: 'fullDump' },
      { kind: 'unrecognized', reason: 'x' },
      objects('Catalog.А'),
    ];
    for (const mirrorState of states) {
      for (const [index, changeSet] of sets.entries()) {
        test(`M ${mirrorState} × набор #${String(index)} → compare (порог и D не важны)`, () => {
          assert.deepStrictEqual(
            planImport(importInput({
              storeKind: 'local',
              mirrorState,
              changeSet,
              changedFiles: Array.from({ length: 1000 }, (_, i) => `f${String(i)}.xml`),
              dirtyFiles: ['x.xml'],
              unresolvedObjects: ['Foo.Bar'],
              archiveThresholdFiles: 1,
            })),
            { action: 'compare' }
          );
        });
      }
    }
  });

  suite('sftp: состояние M × набор изменений', () => {
    test('M empty → архив (mirror-empty), список не нужен', () => {
      assert.deepStrictEqual(
        planImport(importInput({ mirrorState: 'empty', changeSet: undefined, changedFiles: [] })),
        { action: 'archive', reason: 'mirror-empty' }
      );
    });

    test('M empty побеждает любой набор (даже если он передан)', () => {
      assert.deepStrictEqual(
        planImport(importInput({ mirrorState: 'empty', changeSet: objects('Catalog.А') })),
        { action: 'archive', reason: 'mirror-empty' }
      );
    });

    for (const mirrorState of ['fresh', 'stale'] as const) {
      test(`M ${mirrorState} × fullDump → архив full-dump`, () => {
        assert.deepStrictEqual(
          planImport(importInput({ mirrorState, changeSet: { kind: 'fullDump' }, changedFiles: [] })),
          { action: 'archive', reason: 'full-dump' }
        );
      });

      test(`M ${mirrorState} × unrecognized → архив unrecognized`, () => {
        assert.deepStrictEqual(
          planImport(importInput({ mirrorState, changeSet: { kind: 'unrecognized', reason: 'x' }, changedFiles: [] })),
          { action: 'archive', reason: 'unrecognized' }
        );
      });

      test(`M ${mirrorState} × objects → дельта по C ∪ D`, () => {
        assert.deepStrictEqual(
          planImport(importInput({ mirrorState, changedFiles: ['Catalogs/А.xml'], dirtyFiles: [] })),
          { action: 'delta', files: ['Catalogs/А.xml'], deletableIfAbsent: ['Catalogs/А.xml'] }
        );
      });
    }

    test('объекты, не сопоставленные файлам (unresolved) → архив unresolved-objects', () => {
      assert.deepStrictEqual(
        planImport(importInput({ unresolvedObjects: ['Foo.Bar'] })),
        { action: 'archive', reason: 'unresolved-objects' }
      );
    });

    test('пустой список изменений и чистый P → дельта без файлов (ничего не качаем)', () => {
      assert.deepStrictEqual(
        planImport(importInput({ changeSet: { kind: 'objects', objects: [] }, changedFiles: [], dirtyFiles: [] })),
        { action: 'delta', files: [], deletableIfAbsent: [] }
      );
    });

    test('локальные правки D добавляются к C, дубликаты схлопываются, результат отсортирован', () => {
      assert.deepStrictEqual(
        planImport(importInput({
          changedFiles: ['Catalogs/Б.xml', 'Catalogs/А.xml'],
          dirtyFiles: ['Roles/Я.xml', 'Catalogs/А.xml'],
        })),
        { action: 'delta', files: ['Catalogs/А.xml', 'Catalogs/Б.xml', 'Roles/Я.xml'].sort(), deletableIfAbsent: ['Catalogs/А.xml', 'Catalogs/Б.xml', 'Roles/Я.xml'].sort() }
      );
    });

    test('чистый P, но список изменений пуст, при непустом D — дельта из одних локальных правок (перетереть)', () => {
      assert.deepStrictEqual(
        planImport(importInput({ changeSet: { kind: 'objects', objects: [] }, changedFiles: [], dirtyFiles: ['x.bsl'] })),
        { action: 'delta', files: ['x.bsl'], deletableIfAbsent: ['x.bsl'] }
      );
    });
  });

  suite('порог archiveThresholdFiles: |C ∪ D| строго больше → архив', () => {
    const files = (count: number): string[] => Array.from({ length: count }, (_, i) => `Catalogs/О${String(i).padStart(3, '0')}.xml`);

    test('ровно порог → дельта; порог+1 → архив over-threshold', () => {
      assert.strictEqual(planImport(importInput({ changedFiles: files(3), archiveThresholdFiles: 3 })).action, 'delta');
      assert.deepStrictEqual(
        planImport(importInput({ changedFiles: files(4), archiveThresholdFiles: 3 })),
        { action: 'archive', reason: 'over-threshold' }
      );
    });

    test('в счёт идёт объединение C и D без дубликатов', () => {
      assert.strictEqual(
        planImport(importInput({ changedFiles: files(3), dirtyFiles: files(3), archiveThresholdFiles: 3 })).action,
        'delta'
      );
      assert.strictEqual(
        planImport(importInput({ changedFiles: files(3), dirtyFiles: ['x.bsl'], archiveThresholdFiles: 3 })).action,
        'archive'
      );
    });

    test('порог 0: любое изменение → архив, нет изменений → дельта без файлов', () => {
      assert.strictEqual(planImport(importInput({ changedFiles: files(1), archiveThresholdFiles: 0 })).action, 'archive');
      assert.deepStrictEqual(
        planImport(importInput({ changedFiles: [], archiveThresholdFiles: 0, changeSet: { kind: 'objects', objects: [] } })),
        { action: 'delta', files: [], deletableIfAbsent: [] }
      );
    });
  });

  suite('приоритет причин', () => {
    test('fullDump и unrecognized важнее порога и unresolved', () => {
      const huge = Array.from({ length: 10 }, (_, i) => `f${String(i)}.xml`);
      assert.deepStrictEqual(
        planImport(importInput({ changeSet: { kind: 'fullDump' }, changedFiles: huge, archiveThresholdFiles: 1, unresolvedObjects: ['X.Y'] })),
        { action: 'archive', reason: 'full-dump' }
      );
      assert.deepStrictEqual(
        planImport(importInput({ changeSet: { kind: 'unrecognized', reason: '' }, changedFiles: huge, archiveThresholdFiles: 1, unresolvedObjects: ['X.Y'] })),
        { action: 'archive', reason: 'unrecognized' }
      );
    });

    test('unresolved важнее порога', () => {
      assert.deepStrictEqual(
        planImport(importInput({ unresolvedObjects: ['X.Y'], changedFiles: ['a', 'b', 'c'], archiveThresholdFiles: 1 })),
        { action: 'archive', reason: 'unresolved-objects' }
      );
    });
  });

  test('sftp с непустым M без разобранного списка — нарушение контракта вызывающего: исключение, а не молчаливая дельта', () => {
    assert.throws(
      () => planImport(importInput({ mirrorState: 'fresh', changeSet: undefined })),
      /changeSet|список изменений/i
    );
  });
});

function loadInput(overrides: Partial<LoadPlanInput> = {}): LoadPlanInput {
  return {
    storeKind: 'sftp',
    mirrorState: 'fresh',
    base: { 'Catalogs/А.xml': '1', 'Catalogs/Б.xml': '1', 'Configuration.xml': '1' },
    current: { 'Catalogs/А.xml': '1', 'Catalogs/Б.xml': '1', 'Configuration.xml': '1' },
    archiveThresholdFiles: 300,
    ...overrides,
  };
}

suite('SyncPlanner.planLoad (Э7)', () => {
  const stores: SyncStoreKind[] = ['local', 'sftp'];

  for (const storeKind of stores) {
    const via = storeKind === 'local' ? 'dir' : 'archive';

    suite(`хранилище ${storeKind}: общие решения`, () => {
      test('B = P → skip (no-changes)', () => {
        assert.deepStrictEqual(planLoad(loadInput({ storeKind })), { action: 'skip', reason: 'no-changes' });
      });

      test('B пуст и P пуст → skip, а не «нет базовой линии»', () => {
        assert.deepStrictEqual(planLoad(loadInput({ storeKind, base: {}, current: {} })), { action: 'skip', reason: 'no-changes' });
      });

      test('B пуст, P непуст → полная загрузка no-baseline', () => {
        assert.deepStrictEqual(
          planLoad(loadInput({ storeKind, base: {}, current: { 'a.xml': '1' } })),
          { action: 'full', reason: 'no-baseline', via }
        );
      });

      test('удаление файла → полная загрузка deletion', () => {
        assert.deepStrictEqual(
          planLoad(loadInput({ storeKind, current: { 'Catalogs/А.xml': '1', 'Configuration.xml': '1' } })),
          { action: 'full', reason: 'deletion', via }
        );
      });

      test('переименование объекта (удалён и добавлен XML того же раздела) → rename, приоритетнее deletion', () => {
        assert.deepStrictEqual(
          planLoad(loadInput({
            storeKind,
            base: { 'Catalogs/Старый.xml': 'h1', 'Configuration.xml': '1' },
            current: { 'Catalogs/Новый.xml': 'h2', 'Configuration.xml': '1' },
          })),
          { action: 'full', reason: 'rename', via }
        );
      });

      test('переименование по совпадению хэша (файл переехал в другой раздел)', () => {
        assert.deepStrictEqual(
          planLoad(loadInput({
            storeKind,
            base: { 'Catalogs/А/Ext/ObjectModule.bsl': 'same', 'Configuration.xml': '1' },
            current: { 'Documents/Я/Ext/Module.bsl': 'same', 'Configuration.xml': '1' },
          })),
          { action: 'full', reason: 'rename', via }
        );
      });

      test('изменённые и добавленные файлы → частичная загрузка: files по умолчанию = changed, порядок added затем modified', () => {
        const plan = planLoad(loadInput({
          storeKind,
          base: { 'a.xml': '1', 'b.xml': '1' },
          current: { 'a.xml': '2', 'b.xml': '1', 'c.xml': '1' },
        }));
        assert.ok(plan.action === 'partial', plan.action);
        assert.deepStrictEqual(plan.changed, ['c.xml', 'a.xml']);
        assert.deepStrictEqual(plan.files, ['c.xml', 'a.xml']);
      });

      test('selectLoadFiles получает changed и определяет файлы загрузки', () => {
        const received: string[][] = [];
        const plan = planLoad(loadInput({
          storeKind,
          base: { 'a.xml': '1' },
          current: { 'a.xml': '2', 'img.png': '1' },
          selectLoadFiles: (changed) => {
            received.push([...changed]);
            return changed.filter((f) => f.endsWith('.xml'));
          },
        }));
        assert.deepStrictEqual(received, [['img.png', 'a.xml']]);
        assert.ok(plan.action === 'partial');
        assert.deepStrictEqual(plan.files, ['a.xml']);
        assert.deepStrictEqual(plan.changed, ['img.png', 'a.xml']);
      });

      test('selectLoadFiles вернул пусто → skip (no-loadable-files)', () => {
        assert.deepStrictEqual(
          planLoad(loadInput({
            storeKind,
            base: { 'a.xml': '1' },
            current: { 'a.xml': '1', 'img.png': '1' },
            selectLoadFiles: () => [],
          })),
          { action: 'skip', reason: 'no-loadable-files' }
        );
      });

      test('удаление приоритетнее «нет загружаемых файлов»', () => {
        assert.strictEqual(
          planLoad(loadInput({
            storeKind,
            base: { 'a.xml': '1', 'gone.xml': '1' },
            current: { 'a.xml': '2' },
            selectLoadFiles: () => [],
          })).action,
          'full'
        );
      });
    });
  }

  suite('локальное хранилище: каркас M и порог', () => {
    test('M есть (fresh) → partial без подготовки зеркала', () => {
      const plan = planLoad(loadInput({ storeKind: 'local', mirrorState: 'fresh', current: { 'Catalogs/А.xml': '2', 'Catalogs/Б.xml': '1', 'Configuration.xml': '1' } }));
      assert.ok(plan.action === 'partial');
      assert.strictEqual(plan.prepareMirror, 'none');
    });

    test('M пуст (нет каркаса) → partial c полным копированием P в M (прежнее поведение)', () => {
      const plan = planLoad(loadInput({ storeKind: 'local', mirrorState: 'empty', current: { 'Catalogs/А.xml': '2', 'Catalogs/Б.xml': '1', 'Configuration.xml': '1' } }));
      assert.ok(plan.action === 'partial');
      assert.strictEqual(plan.prepareMirror, 'full-copy');
    });

    test('порог локально не применяется: тысяча изменённых файлов — всё равно partial', () => {
      const current: Record<string, string> = {};
      for (let i = 0; i < 1000; i += 1) {
        current[`f${String(i)}.xml`] = 'new';
      }
      const base: Record<string, string> = {};
      for (let i = 0; i < 1000; i += 1) {
        base[`f${String(i)}.xml`] = 'old';
      }
      assert.strictEqual(planLoad(loadInput({ storeKind: 'local', base, current, archiveThresholdFiles: 1 })).action, 'partial');
    });
  });

  suite('sftp: состояние M и порог', () => {
    const changedCurrent = { 'Catalogs/А.xml': '2', 'Catalogs/Б.xml': '1', 'Configuration.xml': '1' };

    test('M fresh → partial без подготовки', () => {
      const plan = planLoad(loadInput({ mirrorState: 'fresh', current: changedCurrent }));
      assert.ok(plan.action === 'partial');
      assert.strictEqual(plan.prepareMirror, 'none');
    });

    test('M stale → partial, но сначала dump --update без скачивания (refresh-dump)', () => {
      const plan = planLoad(loadInput({ mirrorState: 'stale', current: changedCurrent }));
      assert.ok(plan.action === 'partial');
      assert.strictEqual(plan.prepareMirror, 'refresh-dump');
    });

    // Н47 (Э8): при известной B база ≡ B, поэтому пустой M восстанавливается полной выгрузкой БД на
    // сервере без скачивания, и правка одного файла не гонит по сети весь P архивом.
    const emptyMirrorTable: { threshold: number; current: Record<string, string>; expected: 'full-dump' | 'over-threshold' }[] = [
      { threshold: 300, current: changedCurrent, expected: 'full-dump' },
      { threshold: 1, current: changedCurrent, expected: 'full-dump' },
      { threshold: 1, current: { 'Catalogs/А.xml': '2', 'Catalogs/Б.xml': '2', 'Configuration.xml': '1' }, expected: 'over-threshold' },
      { threshold: 2, current: { 'Catalogs/А.xml': '2', 'Catalogs/Б.xml': '2', 'Configuration.xml': '1' }, expected: 'full-dump' },
      { threshold: 2, current: { 'Catalogs/А.xml': '2', 'Catalogs/Б.xml': '2', 'Catalogs/В.xml': '1', 'Configuration.xml': '1' }, expected: 'over-threshold' },
    ];
    for (const { threshold, current, expected } of emptyMirrorTable) {
      const changed = Object.keys(current).filter((rel) => current[rel] !== loadInput().base[rel]).length;
      test(`M empty при известной B: ${String(changed)} изм. при пороге ${String(threshold)} → ${expected}`, () => {
        const plan = planLoad(loadInput({ mirrorState: 'empty', current, archiveThresholdFiles: threshold }));
        if (expected === 'full-dump') {
          assert.ok(plan.action === 'partial', JSON.stringify(plan));
          assert.strictEqual(plan.prepareMirror, 'full-dump');
          assert.deepStrictEqual(plan.files, plan.changed);
        } else {
          assert.deepStrictEqual(plan, { action: 'full', reason: 'over-threshold', via: 'archive' });
        }
      });
    }

    test('при пустом M deletion и no-baseline по-прежнему дают полную загрузку архивом', () => {
      assert.deepStrictEqual(
        planLoad(loadInput({ mirrorState: 'empty', current: { 'Configuration.xml': '1' } })),
        { action: 'full', reason: 'deletion', via: 'archive' }
      );
      assert.deepStrictEqual(
        planLoad(loadInput({ mirrorState: 'empty', base: {}, current: { 'a.xml': '1' } })),
        { action: 'full', reason: 'no-baseline', via: 'archive' }
      );
    });

    test('порог: ровно порог файлов → partial; порог+1 → полная архивом (over-threshold)', () => {
      const base = { 'a.xml': '1', 'b.xml': '1', 'c.xml': '1' };
      const two = { 'a.xml': '2', 'b.xml': '2', 'c.xml': '1' };
      const three = { 'a.xml': '2', 'b.xml': '2', 'c.xml': '2' };
      assert.strictEqual(planLoad(loadInput({ base, current: two, archiveThresholdFiles: 2 })).action, 'partial');
      assert.deepStrictEqual(
        planLoad(loadInput({ base, current: three, archiveThresholdFiles: 2 })),
        { action: 'full', reason: 'over-threshold', via: 'archive' }
      );
    });

    test('порог считается по файлам загрузки (после selectLoadFiles), а не по числу изменений', () => {
      const base = { 'a.xml': '1', 'p1.png': '1', 'p2.png': '1', 'p3.png': '1' };
      const current = { 'a.xml': '2', 'p1.png': '2', 'p2.png': '2', 'p3.png': '2' };
      const plan = planLoad(loadInput({
        base,
        current,
        archiveThresholdFiles: 1,
        selectLoadFiles: (changed) => changed.filter((f) => f.endsWith('.xml')),
      }));
      assert.strictEqual(plan.action, 'partial');
    });
  });
});

/**
 * Полнота зеркала M (`mirrorCoverage`): `full` — в M все файлы выгрузки, `sparse` — только часть (посев из
 * архива/проекта: файл версий, Configuration.xml и файлы изменённых после посева владельцев). Присутствующий
 * в разреженном M файл равен БД, ОТСУТСТВУЮЩИЙ НИЧЕГО НЕ ОЗНАЧАЕТ: удалять из P по отсутствию в M можно только
 * файлы, добавленные локально (D.added — их нет и в базовой линии B, и в БД). Правки (D.modified/D.deleted)
 * файлов неизменённых владельцев в разреженном M не восстановить — только архив `sparse-mirror-dirty`.
 */
suite('SyncPlanner.planImport: полнота зеркала M (mirrorCoverage)', () => {
  const COVERAGES = ['full', 'sparse'] as const;

  suite('full: прежние правила, любое отсутствие в M допускает удаление', () => {
    test('deletableIfAbsent совпадает с files (C ∪ D, отсортировано), dirtyAddedFiles на него не влияют', () => {
      assert.deepStrictEqual(
        planImport(importInput({
          mirrorCoverage: 'full',
          changedFiles: ['Catalogs/Б.xml', 'Catalogs/А.xml'],
          dirtyFiles: ['Roles/Я.xml'],
          dirtyAddedFiles: ['Roles/Я.xml'],
        })),
        {
          action: 'delta',
          files: ['Catalogs/А.xml', 'Catalogs/Б.xml', 'Roles/Я.xml'],
          deletableIfAbsent: ['Catalogs/А.xml', 'Catalogs/Б.xml', 'Roles/Я.xml'],
        }
      );
    });

    test('полный M, пустой список изменений, локальные правки → дельта по D, всё удаляемо', () => {
      assert.deepStrictEqual(
        planImport(importInput({ mirrorCoverage: 'full', changeSet: { kind: 'objects', objects: [] }, changedFiles: [], dirtyFiles: ['x.bsl'] })),
        { action: 'delta', files: ['x.bsl'], deletableIfAbsent: ['x.bsl'] }
      );
    });
  });

  suite('sparse: удаление только для файлов, добавленных локально', () => {
    test('deletableIfAbsent = files ∩ dirtyAddedFiles', () => {
      assert.deepStrictEqual(
        planImport(importInput({
          mirrorCoverage: 'sparse',
          changedFiles: ['Catalogs/А.xml', 'Catalogs/Б.xml'],
          dirtyFiles: ['Catalogs/Б.xml', 'Roles/Я.xml'],
          dirtyAddedFiles: ['Roles/Я.xml'],
        })),
        {
          action: 'delta',
          files: ['Catalogs/А.xml', 'Catalogs/Б.xml', 'Roles/Я.xml'],
          deletableIfAbsent: ['Roles/Я.xml'],
        }
      );
    });

    test('файл C, который одновременно D.added, удаляем; файл D.added вне files в deletableIfAbsent не попадает', () => {
      assert.deepStrictEqual(
        planImport(importInput({
          mirrorCoverage: 'sparse',
          changedFiles: ['Catalogs/Z.xml'],
          dirtyFiles: [],
          dirtyAddedFiles: ['Catalogs/Z.xml', 'Q.xml'],
        })),
        { action: 'delta', files: ['Catalogs/Z.xml'], deletableIfAbsent: ['Catalogs/Z.xml'] }
      );
    });

    test('нет локально добавленных файлов → ничего не удаляемо', () => {
      assert.deepStrictEqual(
        planImport(importInput({ mirrorCoverage: 'sparse', changedFiles: ['Catalogs/А.xml'], dirtyAddedFiles: [] })),
        { action: 'delta', files: ['Catalogs/А.xml'], deletableIfAbsent: [] }
      );
    });

    test('пустой список изменений и чистый P → дельта без файлов', () => {
      assert.deepStrictEqual(
        planImport(importInput({ mirrorCoverage: 'sparse', changeSet: { kind: 'objects', objects: [] }, changedFiles: [] })),
        { action: 'delta', files: [], deletableIfAbsent: [] }
      );
    });

    test('unrestorableDirtyFiles непуст → архив sparse-mirror-dirty (правку неизменённого владельца из разреженного M не восстановить)', () => {
      assert.deepStrictEqual(
        planImport(importInput({ mirrorCoverage: 'sparse', dirtyFiles: ['Catalogs/Клиенты.xml'], unrestorableDirtyFiles: ['Catalogs/Клиенты.xml'] })),
        { action: 'archive', reason: 'sparse-mirror-dirty' }
      );
    });

    test('unrestorable при пустом списке изменений тоже ведёт в архив', () => {
      assert.deepStrictEqual(
        planImport(importInput({
          mirrorCoverage: 'sparse',
          changeSet: { kind: 'objects', objects: [] },
          changedFiles: [],
          dirtyFiles: ['x.bsl'],
          unrestorableDirtyFiles: ['x.bsl'],
        })),
        { action: 'archive', reason: 'sparse-mirror-dirty' }
      );
    });
  });

  suite('приоритет: пустой M, fullDump, unrecognized, unresolved и порог важнее unrestorable (при любой полноте)', () => {
    for (const mirrorCoverage of COVERAGES) {
      const unrestorable = { dirtyFiles: ['x.bsl'], unrestorableDirtyFiles: ['x.bsl'] };

      test(`[${mirrorCoverage}] M empty → mirror-empty`, () => {
        assert.deepStrictEqual(
          planImport(importInput({ mirrorCoverage, mirrorState: 'empty', changeSet: undefined, changedFiles: [], ...unrestorable })),
          { action: 'archive', reason: 'mirror-empty' }
        );
      });

      test(`[${mirrorCoverage}] fullDump → full-dump`, () => {
        assert.deepStrictEqual(
          planImport(importInput({ mirrorCoverage, changeSet: { kind: 'fullDump' }, changedFiles: [], ...unrestorable })),
          { action: 'archive', reason: 'full-dump' }
        );
      });

      test(`[${mirrorCoverage}] unrecognized → unrecognized`, () => {
        assert.deepStrictEqual(
          planImport(importInput({ mirrorCoverage, changeSet: { kind: 'unrecognized', reason: 'x' }, changedFiles: [], ...unrestorable })),
          { action: 'archive', reason: 'unrecognized' }
        );
      });

      test(`[${mirrorCoverage}] unresolved → unresolved-objects`, () => {
        assert.deepStrictEqual(
          planImport(importInput({ mirrorCoverage, unresolvedObjects: ['Foo.Bar'], ...unrestorable })),
          { action: 'archive', reason: 'unresolved-objects' }
        );
      });

      test(`[${mirrorCoverage}] |C ∪ D| больше порога → over-threshold`, () => {
        assert.deepStrictEqual(
          planImport(importInput({ mirrorCoverage, changedFiles: ['a', 'b', 'c'], archiveThresholdFiles: 1, ...unrestorable })),
          { action: 'archive', reason: 'over-threshold' }
        );
      });
    }
  });

  test('локальное хранилище: compare при любой полноте (полное сравнение M и P, зеркало там всегда полное)', () => {
    for (const mirrorCoverage of COVERAGES) {
      assert.deepStrictEqual(
        planImport(importInput({ storeKind: 'local', mirrorCoverage, unrestorableDirtyFiles: ['x'], dirtyFiles: ['x'] })),
        { action: 'compare' }
      );
    }
  });
});
