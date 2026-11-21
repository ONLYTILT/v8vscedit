import * as assert from 'assert';
import type { DatabaseLagEntry, DatabaseLagSource } from '../../infra/database/DatabaseConfigLag';
import { describeDatabaseLag } from '../../ui/database/databaseLagPresentation';

/**
 * Чистое представление индикатора «БД не обновлена» (`ui/database/databaseLagPresentation.ts`, без `vscode`):
 * текст статус-бара, tooltip и видимость. Время в tooltip форматируется по ЛОКАЛЬНЫМ полям даты, поэтому
 * тестовые отметки строятся из локальных компонентов (`new Date(y, m, d, h, min)`), а `now` передаётся явно.
 */
suite('databaseLagPresentation: describeDatabaseLag', () => {
  const NOW = new Date(2026, 10, 21, 12, 0);
  const entry = (
    kind: 'cf' | 'cfe', name: string, source: DatabaseLagSource, since = new Date(2026, 10, 21, 9, 5)
  ): DatabaseLagEntry => ({
    kind, name, rootPath: `C:/p/src/${kind}/${name}`, extensionName: kind === 'cfe' ? name : undefined, since: since.toISOString(), source,
  });

  test('нет отстающих целей: элемент скрыт, контекст «не отстаёт»', () => {
    const view = describeDatabaseLag([], NOW);
    assert.strictEqual(view.visible, false);
    assert.strictEqual(view.text, '');
    assert.strictEqual(view.tooltip, '');
  });

  test('одна цель cf: текст с именем конфигурации', () => {
    const view = describeDatabaseLag([entry('cf', 'Основная', 'load-without-update')], NOW);
    assert.strictEqual(view.visible, true);
    assert.strictEqual(view.text, '$(database) БД не обновлена: Основная');
  });

  test('одна цель cfe: текст с именем расширения', () => {
    const view = describeDatabaseLag([entry('cfe', 'Расш', 'update-failed')], NOW);
    assert.strictEqual(view.text, '$(database) БД не обновлена: Расш');
  });

  test('несколько целей: текст с числом', () => {
    const view = describeDatabaseLag([
      entry('cf', 'Основная', 'load-without-update'),
      entry('cfe', 'Расш', 'update-failed'),
    ], NOW);
    assert.strictEqual(view.text, '$(database) БД не обновлена: 2');
    const three = describeDatabaseLag([
      entry('cf', 'Основная', 'load-without-update'), entry('cfe', 'А', 'cf-file-load'), entry('cfe', 'Б', 'repository-receive'),
    ], NOW);
    assert.strictEqual(three.text, '$(database) БД не обновлена: 3');
  });

  const REASONS: [DatabaseLagSource, string][] = [
    ['load-without-update', 'загрузка без обновления БД'],
    ['update-failed', 'обновление БД не завершено'],
    ['cf-file-load', 'загружен CF/CFE-файл'],
    ['repository-receive', 'получены версии из хранилища'],
  ];
  for (const [source, reason] of REASONS) {
    test(`tooltip, источник ${source}: строка цели «• имя — с дд.мм чч:мм, ${reason}»`, () => {
      const view = describeDatabaseLag([entry('cf', 'Основная', source)], NOW);
      assert.ok(view.tooltip.includes(`• Основная — с 21.11 09:05, ${reason}`), view.tooltip);
    });
  }

  test('tooltip: заголовок, все цели по строкам и честная оговорка про обновление вне расширения', () => {
    const view = describeDatabaseLag([
      entry('cf', 'Основная', 'load-without-update', new Date(2026, 0, 2, 3, 4)),
      entry('cfe', 'Расш', 'update-failed', new Date(2026, 11, 31, 23, 59)),
    ], NOW);
    const lines = view.tooltip.split('\n');
    assert.strictEqual(lines[0], 'Конфигурация БД отстаёт от основной (по данным расширения):');
    assert.ok(lines.includes('• Основная — с 02.01 03:04, загрузка без обновления БД'), view.tooltip);
    assert.ok(lines.includes('• Расш — с 31.12 23:59, обновление БД не завершено'), view.tooltip);
    assert.ok(view.tooltip.includes('Расширение не видит обновление БД, выполненное в Конфигураторе или другим пользователем'), view.tooltip);
    assert.ok(view.tooltip.includes('отметьте цель как обновлённую'), view.tooltip);
  });

  test('детерминизм: два вызова с одинаковыми аргументами дают равный результат', () => {
    const entries = [entry('cf', 'Основная', 'load-without-update')];
    assert.deepStrictEqual(describeDatabaseLag(entries, NOW), describeDatabaseLag(entries, NOW));
  });

  test('входной массив не мутируется', () => {
    const entries = [entry('cfe', 'Б', 'update-failed'), entry('cfe', 'А', 'update-failed')];
    describeDatabaseLag(entries, NOW);
    assert.deepStrictEqual(entries.map((item) => item.name), ['Б', 'А']);
  });
});
