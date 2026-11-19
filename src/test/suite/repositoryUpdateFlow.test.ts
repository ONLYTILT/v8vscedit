import * as assert from 'assert';
import {
  describeImportFailureAfterReceive,
  describeProjectBehindAfterReceive,
  planRepositoryUpdate,
  shouldImportAfterReceive,
  type UpdateLocalChangesChoice,
} from '../../ui/commands/repository/repositoryUpdateFlow';

suite('repositoryUpdateFlow: решение команды «Получить из хранилища»', () => {
  suite('planRepositoryUpdate', () => {
    for (const dirtyFilesCount of [0, -1]) {
      for (const choice of [undefined, 'update-then-receive', 'receive-without-import', 'cancel'] as (UpdateLocalChangesChoice | undefined)[]) {
        test(`нет незагруженных правок (${String(dirtyFilesCount)}), choice=${String(choice)}: только получение и импорт, вопроса нет`, () => {
          assert.deepStrictEqual(
            planRepositoryUpdate({ dirtyFilesCount, choice }),
            { updateDatabaseFirst: false, importAfterReceive: true }
          );
        });
      }
    }

    test('правки есть, ответа нет: ask', () => {
      assert.strictEqual(planRepositoryUpdate({ dirtyFilesCount: 3 }), 'ask');
    });

    test('правки есть, update-then-receive: сначала загрузка в базу, затем получение с импортом', () => {
      assert.deepStrictEqual(
        planRepositoryUpdate({ dirtyFilesCount: 3, choice: 'update-then-receive' }),
        { updateDatabaseFirst: true, importAfterReceive: true }
      );
    });

    test('правки есть, receive-without-import: без загрузки и без импорта', () => {
      assert.deepStrictEqual(
        planRepositoryUpdate({ dirtyFilesCount: 3, choice: 'receive-without-import' }),
        { updateDatabaseFirst: false, importAfterReceive: false }
      );
    });

    test('правки есть, cancel: cancel', () => {
      assert.strictEqual(planRepositoryUpdate({ dirtyFilesCount: 3, choice: 'cancel' }), 'cancel');
    });
  });

  suite('shouldImportAfterReceive', () => {
    for (const importAfterReceive of [true, false]) {
      for (const receivedFromRepository of [true, false]) {
        test(`importAfterReceive=${String(importAfterReceive)}, received=${String(receivedFromRepository)}: ${String(importAfterReceive && receivedFromRepository)}`, () => {
          assert.strictEqual(
            shouldImportAfterReceive({ updateDatabaseFirst: false, importAfterReceive }, { receivedFromRepository }),
            importAfterReceive && receivedFromRepository
          );
        });
      }
    }
  });

  suite('тексты предупреждений', () => {
    test('сбой импорта: имя, «Импорт конфигурации», «Обновить БД»', () => {
      const text = describeImportFailureAfterReceive('Основная');
      assert.ok(text.includes('"Основная"'), text);
      assert.ok(text.includes('Импорт конфигурации'), text);
      assert.ok(text.includes('Обновить БД'), text);
    });

    test('проект отстаёт: имя, «Импорт конфигурации», «Обновить БД»', () => {
      const text = describeProjectBehindAfterReceive('Расш');
      assert.ok(text.includes('"Расш"'), text);
      assert.ok(text.includes('Импорт конфигурации'), text);
      assert.ok(text.includes('Обновить БД'), text);
    });
  });
});
