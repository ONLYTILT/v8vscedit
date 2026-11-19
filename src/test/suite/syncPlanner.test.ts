import * as assert from 'assert';
import type { DumpChangeSet } from '../../domain/agent/DumpChangesParser';
import {
  ARCHIVE_REASON_POLICY,
  planBeforeUpdate,
  planImport,
  planLoad,
  planRemoteImport,
  type ImportArchiveReason,
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
    dirtyAbsentFromMirror: [],
    archiveThresholdFiles: 300,
    // План «FullDump без полной выгрузки»: прежние ожидания `full-dump → архив` снимаются при выключенной очистке
    // (так ведёт себя цель cfe), остальные входы по умолчанию нейтральны.
    fullDumpAvoidance: false,
    fullDumpStage: 'initial',
    removedOwnerFiles: [],
    replacedOwnerFiles: [],
    updateKind: 'incremental',
    rewriteOwnersWithRemovedParts: [],
    ...overrides,
  };
}

/** Фаза 1 без очистки по свежему CDI: FullDump уходит в архив, как до плана. */
const NO_AVOIDANCE = { fullDumpAvoidance: false, fullDumpStage: 'initial' } as const;

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
          { action: 'delta', files: ['Catalogs/А.xml'], deletableIfAbsent: ['Catalogs/А.xml'], restoreFromDatabase: [] }
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
        { action: 'delta', files: [], deletableIfAbsent: [], restoreFromDatabase: [] }
      );
    });

    test('локальные правки D добавляются к C, дубликаты схлопываются, результат отсортирован', () => {
      assert.deepStrictEqual(
        planImport(importInput({
          changedFiles: ['Catalogs/Б.xml', 'Catalogs/А.xml'],
          dirtyFiles: ['Roles/Я.xml', 'Catalogs/А.xml'],
        })),
        { action: 'delta', files: ['Catalogs/А.xml', 'Catalogs/Б.xml', 'Roles/Я.xml'].sort(), deletableIfAbsent: ['Catalogs/А.xml', 'Catalogs/Б.xml', 'Roles/Я.xml'].sort(), restoreFromDatabase: [] }
      );
    });

    test('чистый P, но список изменений пуст, при непустом D — дельта из одних локальных правок (перетереть)', () => {
      assert.deepStrictEqual(
        planImport(importInput({ changeSet: { kind: 'objects', objects: [] }, changedFiles: [], dirtyFiles: ['x.bsl'] })),
        { action: 'delta', files: ['x.bsl'], deletableIfAbsent: ['x.bsl'], restoreFromDatabase: [] }
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
        { action: 'delta', files: [], deletableIfAbsent: [], restoreFromDatabase: [] }
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
 * файлов неизменённых владельцев в разреженном M дельтой не восстановить — их берёт из базы точечная выгрузка
 * (`restoreFromDatabase`), а не архив (`sparse-mirror-dirty` — только запасная причина движка).
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
          restoreFromDatabase: [],
        }
      );
    });

    test('полный M, пустой список изменений, локальные правки → дельта по D, всё удаляемо', () => {
      assert.deepStrictEqual(
        planImport(importInput({ mirrorCoverage: 'full', changeSet: { kind: 'objects', objects: [] }, changedFiles: [], dirtyFiles: ['x.bsl'] })),
        { action: 'delta', files: ['x.bsl'], deletableIfAbsent: ['x.bsl'], restoreFromDatabase: [] }
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
          restoreFromDatabase: [],
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
        { action: 'delta', files: ['Catalogs/Z.xml'], deletableIfAbsent: ['Catalogs/Z.xml'], restoreFromDatabase: [] }
      );
    });

    test('нет локально добавленных файлов → ничего не удаляемо', () => {
      assert.deepStrictEqual(
        planImport(importInput({ mirrorCoverage: 'sparse', changedFiles: ['Catalogs/А.xml'], dirtyAddedFiles: [] })),
        { action: 'delta', files: ['Catalogs/А.xml'], deletableIfAbsent: [], restoreFromDatabase: [] }
      );
    });

    test('пустой список изменений и чистый P → дельта без файлов', () => {
      assert.deepStrictEqual(
        planImport(importInput({ mirrorCoverage: 'sparse', changeSet: { kind: 'objects', objects: [] }, changedFiles: [] })),
        { action: 'delta', files: [], deletableIfAbsent: [], restoreFromDatabase: [] }
      );
    });

    test('dirtyAbsentFromMirror непуст → ДЕЛЬТА с restoreFromDatabase, а не архив: правку неизменённого владельца восстановит точечная выгрузка', () => {
      assert.deepStrictEqual(
        planImport(importInput({
          mirrorCoverage: 'sparse',
          changedFiles: ['Catalogs/А.xml'],
          dirtyFiles: ['Catalogs/Клиенты.xml'],
          dirtyAbsentFromMirror: ['Catalogs/Клиенты.xml'],
        })),
        {
          action: 'delta',
          files: ['Catalogs/А.xml', 'Catalogs/Клиенты.xml'],
          deletableIfAbsent: [],
          restoreFromDatabase: ['Catalogs/Клиенты.xml'],
        }
      );
    });

    test('то же при пустом списке изменений: дельта из одних локальных правок, всё — из базы', () => {
      assert.deepStrictEqual(
        planImport(importInput({
          mirrorCoverage: 'sparse',
          changeSet: { kind: 'objects', objects: [] },
          changedFiles: [],
          dirtyFiles: ['x.bsl'],
          dirtyAbsentFromMirror: ['x.bsl'],
        })),
        { action: 'delta', files: ['x.bsl'], deletableIfAbsent: [], restoreFromDatabase: ['x.bsl'] }
      );
    });

    test('restoreFromDatabase — подмножество files: файлы, которые в M есть, туда не попадают', () => {
      const plan = planImport(importInput({
        mirrorCoverage: 'sparse',
        changedFiles: ['Catalogs/А.xml'],
        dirtyFiles: ['Catalogs/А.xml', 'Roles/Админ.xml'],
        dirtyAbsentFromMirror: ['Roles/Админ.xml'],
      }));
      assert.ok(plan.action === 'delta');
      assert.deepStrictEqual(plan.restoreFromDatabase, ['Roles/Админ.xml']);
      assert.ok(plan.restoreFromDatabase.every((file) => plan.files.includes(file)));
    });

    test('restoreFromDatabase и локально добавленный файл независимы: D.added удаляем, D.modified восстанавливаем', () => {
      assert.deepStrictEqual(
        planImport(importInput({
          mirrorCoverage: 'sparse',
          changedFiles: [],
          changeSet: { kind: 'objects', objects: [] },
          dirtyFiles: ['Catalogs/Клиенты.xml', 'Catalogs/Лишний.xml'],
          dirtyAddedFiles: ['Catalogs/Лишний.xml'],
          dirtyAbsentFromMirror: ['Catalogs/Клиенты.xml'],
        })),
        {
          action: 'delta',
          files: ['Catalogs/Клиенты.xml', 'Catalogs/Лишний.xml'],
          deletableIfAbsent: ['Catalogs/Лишний.xml'],
          restoreFromDatabase: ['Catalogs/Клиенты.xml'],
        }
      );
    });

    test('при ПОЛНОМ M restoreFromDatabase пуст, даже если вызывающий передал dirtyAbsentFromMirror (в полном M файл есть)', () => {
      assert.deepStrictEqual(
        planImport(importInput({
          mirrorCoverage: 'full',
          dirtyFiles: ['Catalogs/Клиенты.xml'],
          dirtyAbsentFromMirror: ['Catalogs/Клиенты.xml'],
        })),
        {
          action: 'delta',
          files: ['Catalogs/А.xml', 'Catalogs/Клиенты.xml'],
          deletableIfAbsent: ['Catalogs/А.xml', 'Catalogs/Клиенты.xml'],
          restoreFromDatabase: [],
        }
      );
    });

    test('sparse-mirror-dirty планировщик больше не возвращает ни на одном входе (причина осталась запасной у движка)', () => {
      const states: SyncMirrorState[] = ['empty', 'stale', 'fresh'];
      const sets: (DumpChangeSet | undefined)[] = [undefined, { kind: 'fullDump' }, { kind: 'unrecognized', reason: 'x' }, objects('Catalog.А'), { kind: 'objects', objects: [] }];
      for (const mirrorState of states) {
        for (const changeSet of sets) {
          for (const mirrorCoverage of COVERAGES) {
            for (const dirtyAbsentFromMirror of [[], ['x.bsl']]) {
              for (const unresolvedObjects of [[], ['Foo.Bar']]) {
                for (const archiveThresholdFiles of [0, 300]) {
                  let plan: ReturnType<typeof planImport> | undefined;
                  try {
                    plan = planImport(importInput({
                      mirrorState,
                      changeSet,
                      mirrorCoverage,
                      dirtyFiles: ['x.bsl'],
                      dirtyAbsentFromMirror,
                      unresolvedObjects,
                      archiveThresholdFiles,
                    }));
                  } catch {
                    continue; // контракт «нужен changeSet» — отдельный тест
                  }
                  assert.ok(plan.action !== 'archive' || plan.reason !== 'sparse-mirror-dirty', JSON.stringify({ mirrorState, changeSet, mirrorCoverage, dirtyAbsentFromMirror }));
                }
              }
            }
          }
        }
      }
    });
  });

  suite('приоритет: пустой M, fullDump, unrecognized, unresolved и порог важнее dirtyAbsentFromMirror (при любой полноте)', () => {
    for (const mirrorCoverage of COVERAGES) {
      const absent = { dirtyFiles: ['x.bsl'], dirtyAbsentFromMirror: ['x.bsl'] };

      test(`[${mirrorCoverage}] M empty → mirror-empty`, () => {
        assert.deepStrictEqual(
          planImport(importInput({ mirrorCoverage, mirrorState: 'empty', changeSet: undefined, changedFiles: [], ...absent })),
          { action: 'archive', reason: 'mirror-empty' }
        );
      });

      test(`[${mirrorCoverage}] fullDump → full-dump`, () => {
        assert.deepStrictEqual(
          planImport(importInput({ mirrorCoverage, changeSet: { kind: 'fullDump' }, changedFiles: [], ...absent })),
          { action: 'archive', reason: 'full-dump' }
        );
      });

      test(`[${mirrorCoverage}] unrecognized → unrecognized`, () => {
        assert.deepStrictEqual(
          planImport(importInput({ mirrorCoverage, changeSet: { kind: 'unrecognized', reason: 'x' }, changedFiles: [], ...absent })),
          { action: 'archive', reason: 'unrecognized' }
        );
      });

      test(`[${mirrorCoverage}] unresolved → unresolved-objects`, () => {
        assert.deepStrictEqual(
          planImport(importInput({ mirrorCoverage, unresolvedObjects: ['Foo.Bar'], ...absent })),
          { action: 'archive', reason: 'unresolved-objects' }
        );
      });

      test(`[${mirrorCoverage}] |C ∪ D| больше порога → over-threshold`, () => {
        assert.deepStrictEqual(
          planImport(importInput({ mirrorCoverage, changedFiles: ['a', 'b', 'c'], archiveThresholdFiles: 1, ...absent })),
          { action: 'archive', reason: 'over-threshold' }
        );
      });
    }
  });

  test('локальное хранилище: compare при любой полноте (полное сравнение M и P, зеркало там всегда полное)', () => {
    for (const mirrorCoverage of COVERAGES) {
      assert.deepStrictEqual(
        planImport(importInput({ storeKind: 'local', mirrorCoverage, dirtyAbsentFromMirror: ['x'], dirtyFiles: ['x'] })),
        { action: 'compare' }
      );
    }
  });
});

/**
 * Фаза 1 импорта (plan-archive-avoid.md §3.1, строки 2, 5–8): решение ДО `dump --update` по состоянию M и
 * списку изменений. `full-dump`/`unrecognized` уходят в архив БЕЗ предшествующей полной перезаписи M
 * командой `--update` (раньше на одно удаление объекта шло ДВЕ полные серверные выгрузки).
 */
suite('SyncPlanner.planBeforeUpdate (фаза 1 импорта)', () => {
  test('M empty → архив mirror-empty при любом changeSet (в т.ч. без него)', () => {
    for (const changeSet of [undefined, { kind: 'fullDump' } as const, objects('Catalog.А'), { kind: 'objects', objects: [] } as const]) {
      assert.deepStrictEqual(planBeforeUpdate({ ...NO_AVOIDANCE, mirrorState: 'empty', changeSet }), { action: 'archive', reason: 'mirror-empty' });
    }
  });

  for (const mirrorState of ['fresh', 'stale'] as const) {
    suite(`M ${mirrorState}`, () => {
      test('fullDump → архив full-dump (до --update)', () => {
        assert.deepStrictEqual(planBeforeUpdate({ ...NO_AVOIDANCE, mirrorState, changeSet: { kind: 'fullDump' } }), { action: 'archive', reason: 'full-dump' });
      });

      test('unrecognized → архив unrecognized (до --update)', () => {
        assert.deepStrictEqual(
          planBeforeUpdate({ ...NO_AVOIDANCE, mirrorState, changeSet: { kind: 'unrecognized', reason: 'x' } }),
          { action: 'archive', reason: 'unrecognized' }
        );
      });

      test('пустой список объектов → skip-update (M и так совпадает с базой)', () => {
        assert.deepStrictEqual(planBeforeUpdate({ ...NO_AVOIDANCE, mirrorState, changeSet: { kind: 'objects', objects: [] } }), { action: 'skip-update', objects: [] });
      });

      test('непустой список объектов → update', () => {
        // Объекты списка — в решении плана: движок берёт их оттуда, а не сужает список повторно.
        for (const changeSet of [objects('Catalog.А'), objects('Catalog.А', 'Document.Б.Form.В')]) {
          assert.ok(changeSet.kind === 'objects');
          assert.deepStrictEqual(planBeforeUpdate({ ...NO_AVOIDANCE, mirrorState, changeSet }), { action: 'update', objects: changeSet.objects });
        }
      });

      test('нет changeSet при непустом M — нарушение контракта: исключение, а не молчаливый update', () => {
        assert.throws(() => planBeforeUpdate({ ...NO_AVOIDANCE, mirrorState }), /changeSet|список изменений/i);
      });
    });
  }

  test('planRemoteImport использует ту же таблицу: решения фазы 1 совпадают (одна таблица для тестов)', () => {
    const cases: [DumpChangeSet, ImportArchiveReason][] = [
      [{ kind: 'fullDump' }, 'full-dump'],
      [{ kind: 'unrecognized', reason: 'x' }, 'unrecognized'],
    ];
    for (const [changeSet, reason] of cases) {
      const before = planBeforeUpdate({ ...NO_AVOIDANCE, mirrorState: 'fresh', changeSet });
      assert.deepStrictEqual(before, { action: 'archive', reason });
      assert.deepStrictEqual(planRemoteImport(importInput({ changeSet, changedFiles: [] })), { action: 'archive', reason });
    }
  });
});

/**
 * Таблица политики причин архива — ДАННЫЕ, а не ветки по коду: новая причина полной выгрузки — строка
 * таблицы (CLAUDE.md, «Инвариант изменений»).
 */
suite('ARCHIVE_REASON_POLICY (политика причин полной выгрузки)', () => {
  const ALL: ImportArchiveReason[] = ['mirror-empty', 'full-dump', 'unrecognized', 'unresolved-objects', 'over-threshold', 'sparse-mirror-dirty', 'sparse-removed-parts'];
  const BEFORE: ImportArchiveReason[] = ['mirror-empty', 'full-dump', 'unrecognized'];

  test('полнота ключей: ровно все ImportArchiveReason', () => {
    assert.deepStrictEqual(Object.keys(ARCHIVE_REASON_POLICY).sort(), [...ALL].sort());
  });

  for (const reason of ALL) {
    const before = BEFORE.includes(reason);
    test(`${reason}: фаза ${before ? 'before-update' : 'after-update'}, самопосев M из архива ${before ? 'да' : 'нет'}, текст непуст`, () => {
      const policy = ARCHIVE_REASON_POLICY[reason];
      assert.strictEqual(policy.phase, before ? 'before-update' : 'after-update');
      // До `--update` M не мутирован и после архива засевается заново; после — M уже обновлён, засевать нечем.
      assert.strictEqual(policy.reseedMirror, before);
      assert.ok(policy.text.trim().length > 0);
    });
  }

  test('before-update ⇔ reseedMirror для всех причин', () => {
    for (const reason of ALL) {
      assert.strictEqual(ARCHIVE_REASON_POLICY[reason].phase === 'before-update', ARCHIVE_REASON_POLICY[reason].reseedMirror, reason);
    }
  });

  test('тексты причин (журнал и вопрос пользователю) закреплены', () => {
    assert.deepStrictEqual(Object.fromEntries(ALL.filter((reason) => reason !== 'sparse-removed-parts').map((reason) => [reason, ARCHIVE_REASON_POLICY[reason].text])), {
      'mirror-empty': 'зеркало агента пусто',
      'full-dump': 'в базе удалены или переименованы объекты (агент сообщил FullDump)',
      'unrecognized': 'список изменений агента не распознан',
      'unresolved-objects': 'изменённые объекты не удалось сопоставить файлам выгрузки',
      'over-threshold': 'изменено больше файлов, чем порог v8vscedit.agent.archiveThresholdFiles',
      'sparse-mirror-dirty': 'локально изменённые файлы не удалось восстановить из базы точечно',
    }, 'тексты прежних причин не меняются; текст sparse-removed-parts задаётся отдельно (syncPlannerFullDump.test.ts)');
  });
});
