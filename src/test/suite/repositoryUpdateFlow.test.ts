import * as assert from 'assert';
import {
  describeImportFailureAfterReceive,
  describeLoadFailureAfterReceive,
  describeLockedOverwrite,
  describeProjectBehindAfterReceive,
  planRepositoryUpdate,
  shouldImportAfterReceive,
  type UpdateLocalChangesChoice,
} from '../../ui/commands/repository/repositoryUpdateFlow';

suite('repositoryUpdateFlow: решение команды «Получить из хранилища»', () => {
  suite('planRepositoryUpdate: незагруженные правки проекта', () => {
    for (const dirtyFilesCount of [0, -1]) {
      for (const choice of [undefined, 'receive-then-load', 'receive-without-import', 'cancel'] as (UpdateLocalChangesChoice | undefined)[]) {
        test(`нет незагруженных правок (${String(dirtyFilesCount)}), choice=${String(choice)}: только получение и импорт, вопроса нет`, () => {
          assert.deepStrictEqual(
            planRepositoryUpdate({ dirtyFilesCount, lockedInSelection: [], choice }),
            { loadChangesAfterReceive: false, importAfterReceive: true }
          );
        });
      }
    }

    test('правки есть, ответа нет: ask-local-changes', () => {
      assert.strictEqual(planRepositoryUpdate({ dirtyFilesCount: 3, lockedInSelection: [] }), 'ask-local-changes');
    });

    test('правки есть, receive-then-load: загрузка правок ПОСЛЕ получения (Э24: получение затёрло бы загруженное до него), импорт разрешён', () => {
      assert.deepStrictEqual(
        planRepositoryUpdate({ dirtyFilesCount: 3, lockedInSelection: [], choice: 'receive-then-load' }),
        { loadChangesAfterReceive: true, importAfterReceive: true }
      );
    });

    test('правки есть, receive-without-import: без загрузки и без импорта', () => {
      assert.deepStrictEqual(
        planRepositoryUpdate({ dirtyFilesCount: 3, lockedInSelection: [], choice: 'receive-without-import' }),
        { loadChangesAfterReceive: false, importAfterReceive: false }
      );
    });

    test('правки есть, cancel: cancel', () => {
      assert.strictEqual(planRepositoryUpdate({ dirtyFilesCount: 3, lockedInSelection: [], choice: 'cancel' }), 'cancel');
    });
  });

  suite('planRepositoryUpdate: захваченные объекты в выборке', () => {
    const locked = ['Справочник.Товары'];

    test('захват в выборке, подтверждения нет: ask-locked-overwrite (даже при чистом проекте)', () => {
      assert.strictEqual(planRepositoryUpdate({ dirtyFilesCount: 0, lockedInSelection: locked }), 'ask-locked-overwrite');
    });

    test('вопрос о захвате задаётся РАНЬШЕ вопроса о правках проекта', () => {
      assert.strictEqual(planRepositoryUpdate({ dirtyFilesCount: 3, lockedInSelection: locked }), 'ask-locked-overwrite');
    });

    test('отказ от перезаписи захваченных: cancel', () => {
      assert.strictEqual(
        planRepositoryUpdate({ dirtyFilesCount: 0, lockedInSelection: locked, lockedOverwriteConfirmed: false }),
        'cancel'
      );
    });

    test('подтверждено, проект чист: получение и импорт', () => {
      assert.deepStrictEqual(
        planRepositoryUpdate({ dirtyFilesCount: 0, lockedInSelection: locked, lockedOverwriteConfirmed: true }),
        { loadChangesAfterReceive: false, importAfterReceive: true }
      );
    });

    test('подтверждено, правки есть: дальше вопрос о правках', () => {
      assert.strictEqual(
        planRepositoryUpdate({ dirtyFilesCount: 2, lockedInSelection: locked, lockedOverwriteConfirmed: true }),
        'ask-local-changes'
      );
    });

    test('подтверждено, правки есть, receive-then-load: загрузка после получения', () => {
      assert.deepStrictEqual(
        planRepositoryUpdate({ dirtyFilesCount: 2, lockedInSelection: locked, lockedOverwriteConfirmed: true, choice: 'receive-then-load' }),
        { loadChangesAfterReceive: true, importAfterReceive: true }
      );
    });
  });

  suite('shouldImportAfterReceive', () => {
    for (const importAfterReceive of [true, false]) {
      for (const receivedFromRepository of [true, false]) {
        test(`importAfterReceive=${String(importAfterReceive)}, received=${String(receivedFromRepository)}: ${String(importAfterReceive && receivedFromRepository)}`, () => {
          assert.strictEqual(
            shouldImportAfterReceive({ loadChangesAfterReceive: false, importAfterReceive }, { receivedFromRepository }),
            importAfterReceive && receivedFromRepository
          );
        });
      }
    }
  });

  suite('тексты', () => {
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

    test('сбой загрузки после получения: имя, импорт не выполнялся, «Обновить БД» затем «Импорт конфигурации»', () => {
      const text = describeLoadFailureAfterReceive('Основная');
      assert.ok(text.includes('"Основная"'), text);
      assert.ok(text.includes('импорт не выполнялся'), text);
      const update = text.indexOf('Обновить БД');
      const imp = text.indexOf('Импорт конфигурации');
      assert.ok(update >= 0 && imp > update, `сначала «Обновить БД», затем «Импорт конфигурации»: ${text}`);
    });

    test('перезапись захваченных: все имена, служебные имена корня — человеческой подписью', () => {
      const text = describeLockedOverwrite(['Справочник.Товары', '__configuration_root__', '__extension_root__']);
      assert.ok(text.includes('Справочник.Товары'), text);
      assert.ok(text.includes('корень конфигурации'), text);
      assert.ok(text.includes('корень расширения'), text);
      assert.ok(!text.includes('__'), text);
    });

    test('перезапись захваченных: больше пяти имён — первые пять и «и ещё N»', () => {
      const names = ['Справочник.А', 'Справочник.Б', 'Справочник.В', 'Справочник.Г', 'Справочник.Д', 'Справочник.Е', 'Справочник.Ж'];
      const text = describeLockedOverwrite(names);
      assert.ok(text.includes('Справочник.Д'), text);
      assert.ok(!text.includes('Справочник.Е'), text);
      assert.ok(text.includes('и ещё 2'), text);
    });
  });
});
