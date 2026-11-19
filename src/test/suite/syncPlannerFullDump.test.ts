import * as assert from 'assert';
import type { DumpChangedObject, DumpChangeSet } from '../../domain/agent/DumpChangesParser';
import type { DumpInfoOwnerChanges } from '../../infra/xml/dumpInfo/ConfigDumpInfoDiff';
import {
  ARCHIVE_REASON_POLICY,
  FULL_DUMP_AVOIDANCE_BY_TARGET,
  SERVER_DUMP_POLICY,
  planBeforeUpdate,
  planPrune,
  planRemoteImport,
  verifyRetryChanges,
  type ImportArchiveReason,
  type ImportPlanInput,
  type ServerDumpReason,
} from '../../infra/agent/sync/SyncPlanner';
import type { SyncMirrorCoverage } from '../../infra/agent/sync/SyncManifest';

/**
 * Планировщик импорта при `FullDump` без архива (plan-fulldump-avoid.md, Т4): развилка фазы 1 «очистить
 * зеркало по свежему CDI / перезаписать зеркало / архив», решение `planPrune`, сверка повторного
 * `--get-changes`, новые входы `planRemoteImport` и политика причин серверной выгрузки.
 */

const COVERAGES: readonly SyncMirrorCoverage[] = ['full', 'sparse'];
const STAGES = ['initial', 'after-prune'] as const;

function change(kind: 'added' | 'modified', fullName: string): DumpChangedObject {
  const [objectKind, name, ...parts] = fullName.split('.');
  return { change: kind, fullName, kind: objectKind, name, parts };
}

const objectsOf = (...lines: DumpChangedObject[]): DumpChangeSet => ({ kind: 'objects', objects: lines });

function importInput(overrides: Partial<ImportPlanInput> = {}): ImportPlanInput {
  return {
    storeKind: 'sftp',
    mirrorState: 'fresh',
    changeSet: objectsOf(change('modified', 'Catalog.А')),
    changedFiles: ['Catalogs/А.xml'],
    unresolvedObjects: [],
    dirtyFiles: [],
    mirrorCoverage: 'full',
    dirtyAddedFiles: [],
    dirtyAbsentFromMirror: [],
    archiveThresholdFiles: 300,
    fullDumpAvoidance: false,
    fullDumpStage: 'initial',
    removedOwnerFiles: [],
    replacedOwnerFiles: [],
    updateKind: 'incremental',
    rewriteOwnersWithRemovedParts: [],
    ...overrides,
  };
}

function ownerChanges(overrides: Partial<DumpInfoOwnerChanges> = {}): DumpInfoOwnerChanges {
  return {
    removedOwners: [],
    ownersWithRemovedParts: [],
    changedOwners: [],
    configurationMissing: false,
    ...overrides,
  };
}

suite('FULL_DUMP_AVOIDANCE_BY_TARGET', () => {
  test('cf — очистка по свежему CDI включена, cfe — прежний путь (архив full-dump)', () => {
    assert.deepStrictEqual({ ...FULL_DUMP_AVOIDANCE_BY_TARGET }, { cf: true, cfe: false });
  });
});

suite('planBeforeUpdate: FullDump × avoidance × stage', () => {
  for (const mirrorState of ['fresh', 'stale'] as const) {
    for (const fullDumpStage of STAGES) {
      test(`M ${mirrorState}, avoidance=false, stage=${fullDumpStage} → архив full-dump (прежнее поведение, цель cfe)`, () => {
        assert.deepStrictEqual(
          planBeforeUpdate({ mirrorState, changeSet: { kind: 'fullDump' }, fullDumpAvoidance: false, fullDumpStage }),
          { action: 'archive', reason: 'full-dump' }
        );
      });
    }

    test(`M ${mirrorState}, avoidance=true, stage=initial → prune (очистка зеркала по свежему CDI)`, () => {
      assert.strictEqual(
        planBeforeUpdate({ mirrorState, changeSet: { kind: 'fullDump' }, fullDumpAvoidance: true, fullDumpStage: 'initial' }).action,
        'prune'
      );
    });

    test(`M ${mirrorState}, avoidance=true, stage=after-prune (повторный FullDump после очистки) → rewrite-mirror`, () => {
      assert.strictEqual(
        planBeforeUpdate({ mirrorState, changeSet: { kind: 'fullDump' }, fullDumpAvoidance: true, fullDumpStage: 'after-prune' }).action,
        'rewrite-mirror'
      );
    });

    for (const fullDumpAvoidance of [false, true]) {
      for (const fullDumpStage of STAGES) {
        test(`M ${mirrorState}, unrecognized (avoidance=${String(fullDumpAvoidance)}, ${fullDumpStage}) → архив unrecognized`, () => {
          assert.deepStrictEqual(
            planBeforeUpdate({ mirrorState, changeSet: { kind: 'unrecognized', reason: 'x' }, fullDumpAvoidance, fullDumpStage }),
            { action: 'archive', reason: 'unrecognized' }
          );
        });

        test(`M ${mirrorState}, объекты (avoidance=${String(fullDumpAvoidance)}, ${fullDumpStage}): пусто → skip-update, иначе update с теми же объектами`, () => {
          assert.deepStrictEqual(
            planBeforeUpdate({ mirrorState, changeSet: { kind: 'objects', objects: [] }, fullDumpAvoidance, fullDumpStage }),
            { action: 'skip-update', objects: [] }
          );
          const set = objectsOf(change('added', 'Document.Заказ'), change('added', 'Document.Заказ.Template.Макет'));
          assert.ok(set.kind === 'objects');
          assert.deepStrictEqual(
            planBeforeUpdate({ mirrorState, changeSet: set, fullDumpAvoidance, fullDumpStage }),
            { action: 'update', objects: set.objects }
          );
        });
      }
    }
  }

  test('M empty → архив mirror-empty при любых avoidance и stage', () => {
    for (const fullDumpAvoidance of [false, true]) {
      for (const fullDumpStage of STAGES) {
        assert.deepStrictEqual(
          planBeforeUpdate({ mirrorState: 'empty', changeSet: { kind: 'fullDump' }, fullDumpAvoidance, fullDumpStage }),
          { action: 'archive', reason: 'mirror-empty' }
        );
      }
    }
  });
});

suite('planPrune', () => {
  test('свежий CDI не получен (failed) → rewrite-mirror, даже если набор очистки задан', () => {
    assert.strictEqual(
      planPrune({ freshDumpInfo: 'failed', changes: ownerChanges({ removedOwners: ['Document.Заказ'] }), unresolved: [] }),
      'rewrite-mirror'
    );
    assert.strictEqual(planPrune({ freshDumpInfo: 'failed', unresolved: [] }), 'rewrite-mirror');
  });

  test('набор очистки пуст (FullDump есть, а объяснить его нечем) → rewrite-mirror', () => {
    assert.strictEqual(planPrune({ freshDumpInfo: 'ok', changes: ownerChanges(), unresolved: [] }), 'rewrite-mirror');
    assert.strictEqual(
      planPrune({
        freshDumpInfo: 'ok',
        changes: ownerChanges({ changedOwners: [{ fullName: 'Catalog.А', change: 'modified' }] }),
        unresolved: [],
      }),
      'rewrite-mirror',
      'одни изменённые владельцы очищать нечем'
    );
  });

  // Ревью: перезапись M не помогла бы — тот же владелец после неё дал бы архив unresolved-objects (две полные
  // серверные выгрузки и два вопроса). Поэтому сразу архив до мутаций, причём раньше проверки части корня.
  test('есть владельцы, которых нельзя перевести в файлы (unresolved) → archive (одна полная выгрузка вместо двух)', () => {
    assert.strictEqual(
      planPrune({ freshDumpInfo: 'ok', changes: ownerChanges({ removedOwners: ['Foo.Bar'] }), unresolved: ['Foo.Bar'] }),
      'archive'
    );
    assert.strictEqual(
      planPrune({
        freshDumpInfo: 'ok',
        changes: ownerChanges({ removedOwners: ['Foo.Bar'], ownersWithRemovedParts: ['Configuration.Конфигурация'] }),
        unresolved: ['Foo.Bar'],
      }),
      'archive'
    );
  });

  test('ok без сравнения (changes не передан) → rewrite-mirror: очищать не по чему', () => {
    assert.strictEqual(planPrune({ freshDumpInfo: 'ok', unresolved: [] }), 'rewrite-mirror');
  });

  test('часть корня конфигурации удалена (Configuration.* в ownersWithRemovedParts) → rewrite-mirror: корень чистить нельзя', () => {
    assert.strictEqual(
      planPrune({
        freshDumpInfo: 'ok',
        changes: ownerChanges({ ownersWithRemovedParts: ['Configuration.Конфигурация'] }),
        unresolved: [],
      }),
      'rewrite-mirror'
    );
    assert.strictEqual(
      planPrune({
        freshDumpInfo: 'ok',
        changes: ownerChanges({ removedOwners: ['Catalog.А'], ownersWithRemovedParts: ['Document.Б', 'Configuration.Конфигурация'] }),
        unresolved: [],
      }),
      'rewrite-mirror',
      'корень среди прочих тоже отправляет весь набор в запасной путь'
    );
  });

  const prunable: [string, Partial<DumpInfoOwnerChanges>][] = [
    ['удалённый владелец', { removedOwners: ['Document.Заказ'] }],
    ['живой владелец с удалённой частью', { ownersWithRemovedParts: ['Document.Заказ'] }],
    ['и то и другое', { removedOwners: ['Catalog.А'], ownersWithRemovedParts: ['Document.Заказ'] }],
    ['с изменёнными владельцами рядом', { removedOwners: ['Catalog.А'], changedOwners: [{ fullName: 'Catalog.Б', change: 'added' }] }],
  ];
  for (const [label, overrides] of prunable) {
    test(`ok, ${label}, unresolved пуст → prune`, () => {
      assert.strictEqual(planPrune({ freshDumpInfo: 'ok', changes: ownerChanges(overrides), unresolved: [] }), 'prune');
    });
  }
});

suite('verifyRetryChanges: сверка повторного --get-changes', () => {
  test('каждый владелец с удалённой частью пришёл строкой New: <владелец> → ok', () => {
    assert.deepStrictEqual(
      verifyRetryChanges([change('added', 'Document.Заказ'), change('added', 'Catalog.Клиенты')], ['Document.Заказ', 'Catalog.Клиенты']),
      { ok: true }
    );
  });

  test('строки подобъектов владельца (New: Владелец.Template.Макет) допустимы и ожидаемы (ФАКТ П3b)', () => {
    assert.deepStrictEqual(
      verifyRetryChanges(
        [change('added', 'Document.Заказ.Template.Макет'), change('added', 'Document.Заказ')],
        ['Document.Заказ']
      ),
      { ok: true }
    );
  });

  test('владельцев с удалёнными частями нет → ok на любом списке', () => {
    assert.deepStrictEqual(verifyRetryChanges([], []), { ok: true });
    assert.deepStrictEqual(verifyRetryChanges([change('modified', 'Catalog.А')], []), { ok: true });
  });

  test('владелец пришёл только как Modified → missingNew (допущение «New + полная выгрузка» не подтвердилось)', () => {
    assert.deepStrictEqual(
      verifyRetryChanges([change('modified', 'Document.Заказ')], ['Document.Заказ']),
      { ok: false, missingNew: ['Document.Заказ'] }
    );
  });

  test('владельца нет в списке вовсе → missingNew', () => {
    assert.deepStrictEqual(verifyRetryChanges([], ['Document.Заказ']), { ok: false, missingNew: ['Document.Заказ'] });
  });

  test('New-строка подобъекта БЕЗ строки владельца не засчитывается', () => {
    assert.deepStrictEqual(
      verifyRetryChanges([change('added', 'Document.Заказ.Template.Макет')], ['Document.Заказ']),
      { ok: false, missingNew: ['Document.Заказ'] }
    );
  });

  test('часть владельцев в порядке, часть нет → missingNew содержит только недостающих', () => {
    assert.deepStrictEqual(
      verifyRetryChanges([change('added', 'Document.Заказ'), change('modified', 'Catalog.Клиенты')], ['Document.Заказ', 'Catalog.Клиенты']),
      { ok: false, missingNew: ['Catalog.Клиенты'] }
    );
  });
});

suite('planRemoteImport: владельцы очистки, перезапись и порог', () => {
  for (const mirrorCoverage of COVERAGES) {
    suite(`полнота M: ${mirrorCoverage}`, () => {
      const REMOVED = ['Documents/Д.xml', 'Documents/Д/Ext/ObjectModule.bsl'];

      test('removedOwnerFiles: входят в files, удаляемы при любой полноте, не уходят в точечную выгрузку (даже будучи грязными и отсутствующими в M)', () => {
        const plan = planRemoteImport(importInput({
          mirrorCoverage,
          removedOwnerFiles: REMOVED,
          dirtyFiles: ['Documents/Д.xml'],
          dirtyAbsentFromMirror: ['Documents/Д.xml'],
        }));

        assert.ok(plan.action === 'delta', JSON.stringify(plan));
        assert.deepStrictEqual(plan.files, ['Catalogs/А.xml', ...REMOVED].sort());
        for (const rel of REMOVED) {
          assert.ok(plan.deletableIfAbsent.includes(rel), `${rel} удаляем`);
        }
        assert.deepStrictEqual(plan.restoreFromDatabase, [], 'удалённого в базе владельца из базы не восстановить');
      });

      test('removedOwnerFiles не считаются в порог: порог 1 при одном изменённом файле → дельта; сверх порога по прочим — архив', () => {
        const within = planRemoteImport(importInput({ mirrorCoverage, archiveThresholdFiles: 1, removedOwnerFiles: REMOVED }));
        assert.strictEqual(within.action, 'delta');

        const over = planRemoteImport(importInput({
          mirrorCoverage,
          archiveThresholdFiles: 1,
          changedFiles: ['Catalogs/А.xml', 'Catalogs/Б.xml'],
          removedOwnerFiles: REMOVED,
        }));
        assert.deepStrictEqual(over, { action: 'archive', reason: 'over-threshold' });
      });

      test('replacedOwnerFiles: входят в files и удаляемы при отсутствии в M — при любой полноте', () => {
        const replaced = ['Documents/Заказ/Forms/Форма.xml', 'Documents/Заказ/Forms/Форма/Ext/Form.xml'];
        const plan = planRemoteImport(importInput({ mirrorCoverage, replacedOwnerFiles: replaced }));

        assert.ok(plan.action === 'delta', JSON.stringify(plan));
        for (const rel of replaced) {
          assert.ok(plan.files.includes(rel), `${rel} в files`);
          assert.ok(plan.deletableIfAbsent.includes(rel), `${rel} удаляем даже в разреженном M`);
        }
      });

      test('прочие файлы в sparse остаются неудаляемыми, в full — удаляемыми: removed/replaced этого правила не меняют', () => {
        const plan = planRemoteImport(importInput({ mirrorCoverage, removedOwnerFiles: REMOVED }));
        assert.ok(plan.action === 'delta');
        assert.strictEqual(plan.deletableIfAbsent.includes('Catalogs/А.xml'), mirrorCoverage === 'full');
      });

      test('updateKind=rewrite: порог не применяется (серверная выгрузка уже выполнена); incremental с теми же входами — over-threshold', () => {
        const input = { mirrorCoverage, archiveThresholdFiles: 1, changedFiles: ['Catalogs/А.xml', 'Catalogs/Б.xml', 'Catalogs/В.xml'] };

        assert.strictEqual(planRemoteImport(importInput({ ...input, updateKind: 'rewrite' })).action, 'delta');
        assert.deepStrictEqual(
          planRemoteImport(importInput({ ...input, updateKind: 'incremental' })),
          { action: 'archive', reason: 'over-threshold' }
        );
      });

      test('rewrite и порог 0: изменения по-прежнему дельта', () => {
        assert.strictEqual(planRemoteImport(importInput({ mirrorCoverage, archiveThresholdFiles: 0, updateKind: 'rewrite' })).action, 'delta');
      });

      test(`rewrite + непустые rewriteOwnersWithRemovedParts → ${mirrorCoverage === 'sparse' ? 'архив sparse-removed-parts' : 'дельта (полный M уже полон)'}`, () => {
        const plan = planRemoteImport(importInput({
          mirrorCoverage,
          updateKind: 'rewrite',
          rewriteOwnersWithRemovedParts: ['Document.Заказ'],
        }));
        if (mirrorCoverage === 'sparse') {
          assert.deepStrictEqual(plan, { action: 'archive', reason: 'sparse-removed-parts' });
        } else {
          assert.strictEqual(plan.action, 'delta');
        }
      });

      test('rewrite + пустые rewriteOwnersWithRemovedParts → дельта', () => {
        assert.strictEqual(planRemoteImport(importInput({ mirrorCoverage, updateKind: 'rewrite' })).action, 'delta');
      });

      test('incremental + непустые rewriteOwnersWithRemovedParts → поле не действует (не перезапись): дельта', () => {
        assert.strictEqual(
          planRemoteImport(importInput({ mirrorCoverage, updateKind: 'incremental', rewriteOwnersWithRemovedParts: ['Document.Заказ'] })).action,
          'delta'
        );
      });
    });
  }

  test('нераспознанные объекты важнее остальных входов: unresolved-objects и при перезаписи', () => {
    assert.deepStrictEqual(
      planRemoteImport(importInput({ updateKind: 'rewrite', unresolvedObjects: ['Foo.Bar'] })),
      { action: 'archive', reason: 'unresolved-objects' }
    );
  });
});

suite('SERVER_DUMP_POLICY и новая причина sparse-removed-parts', () => {
  const ARCHIVE_REASONS: ImportArchiveReason[] = [
    'mirror-empty', 'full-dump', 'unrecognized', 'unresolved-objects', 'over-threshold', 'sparse-mirror-dirty', 'sparse-removed-parts',
  ];

  test('полнота ключей: все причины архива и mirror-rewrite', () => {
    const expected: ServerDumpReason[] = [...ARCHIVE_REASONS, 'mirror-rewrite'];
    assert.deepStrictEqual(Object.keys(SERVER_DUMP_POLICY).sort(), [...expected].sort());
    assert.deepStrictEqual(Object.keys(ARCHIVE_REASON_POLICY).sort(), [...ARCHIVE_REASONS].sort());
  });

  for (const reason of ARCHIVE_REASONS) {
    test(`${reason}: download=true, текст — из ARCHIVE_REASON_POLICY`, () => {
      assert.strictEqual(SERVER_DUMP_POLICY[reason].download, true);
      assert.strictEqual(SERVER_DUMP_POLICY[reason].text, ARCHIVE_REASON_POLICY[reason].text);
    });
  }

  test('mirror-rewrite: скачивания нет (download=false), текст не пуст и отличается от причин архива', () => {
    assert.strictEqual(SERVER_DUMP_POLICY['mirror-rewrite'].download, false);
    assert.ok(SERVER_DUMP_POLICY['mirror-rewrite'].text.trim().length > 0);
    for (const reason of ARCHIVE_REASONS) {
      assert.notStrictEqual(SERVER_DUMP_POLICY['mirror-rewrite'].text, ARCHIVE_REASON_POLICY[reason].text);
    }
  });

  test('sparse-removed-parts: после --update, засева M из архива нет', () => {
    const policy = ARCHIVE_REASON_POLICY['sparse-removed-parts'];
    assert.strictEqual(policy.phase, 'after-update');
    assert.strictEqual(policy.reseedMirror, false);
    assert.ok(policy.text.trim().length > 0);
  });
});
