import * as assert from 'assert';
import {
  describeImportFailureAfterCommit,
  planRepositoryCommit,
  shouldImportAfterCommit,
  type CommitLocalChangesChoice,
} from '../../ui/commands/repository/repositoryCommitFlow';

/**
 * Чистое решение «Поместить в хранилище» (`ui/commands/repository/repositoryCommitFlow.ts`):
 * таблица `planRepositoryCommit` (правки проекта → вопрос → шаги), `shouldImportAfterCommit`
 * (Э25: импорт после помещения нужен ТОЛЬКО при очистке ссылок — `-force` меняет базу помещающего),
 * тексты. Образец — `repositoryUpdateFlow.test.ts`.
 */
suite('repositoryCommitFlow: planRepositoryCommit', () => {
  const DIRTY: readonly number[] = [0, -1, 3];
  const CHOICES: readonly (CommitLocalChangesChoice | undefined)[] = [undefined, 'load-first', 'cancel'];

  // updateDatabaseAfterLoad управляет только режимом шага загрузки; сам шаг решает таблица правок проекта.
  for (const updateDatabaseAfterLoad of [true, false]) {
    for (const dirty of DIRTY) {
      for (const choice of CHOICES) {
        test(`dirty=${String(dirty)}, choice=${String(choice)}, updateDatabaseAfterLoad=${String(updateDatabaseAfterLoad)}`, () => {
          const decision = planRepositoryCommit({ dirtyFilesCount: dirty, choice, updateDatabaseAfterLoad });
          if (dirty <= 0) {
            assert.deepStrictEqual(
              decision,
              { updateDatabaseFirst: false, updateDatabaseOnLoad: false },
              'чистый проект: вопроса нет, шага загрузки нет — updateDatabaseOnLoad=false при любой настройке'
            );
          } else if (choice === undefined) {
            assert.strictEqual(decision, 'ask');
          } else if (choice === 'load-first') {
            assert.deepStrictEqual(decision, { updateDatabaseFirst: true, updateDatabaseOnLoad: updateDatabaseAfterLoad });
          } else {
            assert.strictEqual(decision, 'cancel');
          }
        });
      }
    }
  }
});

suite('repositoryCommitFlow: shouldImportAfterCommit и тексты', () => {
  const ROWS: readonly { cleaned: boolean; committed: string[] }[] = [
    { cleaned: true, committed: ['Документ.Документ1'] },
    { cleaned: true, committed: [] },
    { cleaned: false, committed: ['Документ.Документ1'] },
    { cleaned: false, committed: [] },
  ];
  for (const row of ROWS) {
    test(`referencesCleaned=${String(row.cleaned)}, помещено ${String(row.committed.length)} → импорт ${String(row.cleaned)}`, () => {
      assert.strictEqual(
        shouldImportAfterCommit({ committedFullNames: row.committed, referencesCleaned: row.cleaned }),
        row.cleaned
      );
    });
  }

  test('describeImportFailureAfterCommit: имя цели, причина (очистка ссылок изменила базу), «Импорт конфигурации» до любой загрузки в базу', () => {
    const text = describeImportFailureAfterCommit('Основная');
    assert.ok(text.includes('"Основная"'), text);
    assert.ok(text.includes('очистк'), text);
    assert.ok(text.includes('Импорт конфигурации'), text);
    assert.ok(text.includes('Обновить БД'), text);
  });
});
