import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  describeImportFailureAfterLock,
  describeProjectBehindAfterLock,
  planRepositoryLock,
  shouldImportAfterLock,
  type LockLocalChangesChoice,
  type RepositoryLockPlan,
} from '../../ui/commands/repository/repositoryLockFlow';

suite('repositoryLockFlow: planRepositoryLock (поправки Э14)', () => {
  for (const revisedSetting of [true, false]) {
    for (const updateDatabaseAfterLoad of [true, false]) {
      const tag = `revisedSetting=${String(revisedSetting)}, updateDatabaseAfterLoad=${String(updateDatabaseAfterLoad)}`;

      test(`чистый проект, ${tag}: revised = настройка, шага загрузки нет (updateDatabaseOnLoad=false), импорт по логу разрешён`, () => {
        assert.deepStrictEqual(
          planRepositoryLock({ revisedSetting, dirtyFilesCount: 0, updateDatabaseAfterLoad }),
          { revised: revisedSetting, updateDatabaseFirst: false, updateDatabaseOnLoad: false, importAfterLock: true }
        );
      });

      test(`грязный проект без ответа, ${tag}: вопрос задаётся при любом значении настройки`, () => {
        assert.strictEqual(planRepositoryLock({ revisedSetting, dirtyFilesCount: 3, updateDatabaseAfterLoad }), 'ask');
      });

      test(`update-then-lock, ${tag}: сначала загрузка в базу (с обновлением БД — по настройке), revised = настройка`, () => {
        assert.deepStrictEqual(
          planRepositoryLock({ revisedSetting, dirtyFilesCount: 3, choice: 'update-then-lock', updateDatabaseAfterLoad }),
          { revised: revisedSetting, updateDatabaseFirst: true, updateDatabaseOnLoad: updateDatabaseAfterLoad, importAfterLock: true }
        );
      });

      test(`lock-without-import, ${tag}: без -revised, без загрузки (updateDatabaseOnLoad=false) и без импорта`, () => {
        assert.deepStrictEqual(
          planRepositoryLock({ revisedSetting, dirtyFilesCount: 3, choice: 'lock-without-import', updateDatabaseAfterLoad }),
          { revised: false, updateDatabaseFirst: false, updateDatabaseOnLoad: false, importAfterLock: false }
        );
      });

      test(`cancel, ${tag}: 'cancel'`, () => {
        assert.strictEqual(planRepositoryLock({ revisedSetting, dirtyFilesCount: 3, choice: 'cancel', updateDatabaseAfterLoad }), 'cancel');
      });

      test(`dirty=0 и choice задан (${tag}): choice не используется — вопрос не задавался`, () => {
        const choices: LockLocalChangesChoice[] = ['update-then-lock', 'lock-without-import', 'cancel'];
        for (const choice of choices) {
          assert.deepStrictEqual(
            planRepositoryLock({ revisedSetting, dirtyFilesCount: 0, choice, updateDatabaseAfterLoad }),
            { revised: revisedSetting, updateDatabaseFirst: false, updateDatabaseOnLoad: false, importAfterLock: true }
          );
        }
      });
    }
  }
});

suite('repositoryLockFlow: shouldImportAfterLock', () => {
  const plan = (importAfterLock: boolean): RepositoryLockPlan => ({ revised: true, updateDatabaseFirst: false, updateDatabaseOnLoad: false, importAfterLock });
  const table: { importAfterLock: boolean; received: boolean; expected: boolean }[] = [
    { importAfterLock: true, received: true, expected: true },
    { importAfterLock: true, received: false, expected: false },
    { importAfterLock: false, received: true, expected: false },
    { importAfterLock: false, received: false, expected: false },
  ];
  for (const row of table) {
    test(`plan.importAfterLock=${String(row.importAfterLock)}, receivedFromRepository=${String(row.received)} → ${String(row.expected)}`, () => {
      assert.strictEqual(
        shouldImportAfterLock(plan(row.importAfterLock), { lockedFullNames: ['Справочник.Товары'], receivedFromRepository: row.received }),
        row.expected
      );
    });
  }

  test('импорт решает лог (receivedFromRepository), а не число захваченных объектов', () => {
    assert.strictEqual(shouldImportAfterLock(plan(true), { lockedFullNames: [], receivedFromRepository: true }), true);
    assert.strictEqual(shouldImportAfterLock(plan(true), { lockedFullNames: ['Справочник.Товары'], receivedFromRepository: false }), false);
  });
});

suite('repositoryLockFlow: тексты предупреждений', () => {
  test('describeImportFailureAfterLock: имя, «Импорт конфигурации», «Обновить БД»', () => {
    const text = describeImportFailureAfterLock('Основная');
    assert.ok(text.includes('Основная'));
    assert.ok(text.includes('Импорт конфигурации'));
    assert.ok(text.includes('Обновить БД'));
  });

  test('describeProjectBehindAfterLock: имя, «не обновлены», «Импорт конфигурации», «Обновить БД»', () => {
    const text = describeProjectBehindAfterLock('Основная');
    assert.ok(text.includes('Основная'));
    assert.match(text, /не обновлены/);
    assert.ok(text.includes('Импорт конфигурации'));
    assert.ok(text.includes('Обновить БД'));
  });
});

suite('package.json: настройки захвата и пути к 1cv8 на сервере', () => {
  interface Property { type?: string; default?: unknown; description?: string }
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf-8')) as {
    contributes: { configuration: { properties: Record<string, Property> } };
  };
  const properties = manifest.contributes.configuration.properties;

  test('v8vscedit.repository.getRevisedOnLock: boolean, умолчание true, русское описание про -revised', () => {
    const property = properties['v8vscedit.repository.getRevisedOnLock'];
    assert.ok(property, 'настройка не объявлена');
    assert.strictEqual(property.type, 'boolean');
    assert.strictEqual(property.default, true);
    assert.match(property.description ?? '', /[А-Яа-яЁё]/);
    assert.ok((property.description ?? '').includes('-revised'));
  });

  test('v8vscedit.remote.v8Path: в описании сказано «только 1cv8.exe» и про стартер 1cestart.exe', () => {
    const description = properties['v8vscedit.remote.v8Path'].description ?? '';
    assert.ok(description.includes('1cv8.exe'), description);
    assert.ok(description.includes('1cestart.exe'), description);
  });
});
