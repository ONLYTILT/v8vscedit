import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DatabaseConfigLagStore } from '../../infra/database/DatabaseConfigLag';
import { DatabaseLagStatusBar } from '../../ui/database/DatabaseLagStatusBar';
import { describeDatabaseLag } from '../../ui/database/databaseLagPresentation';
import { removeTreeSync } from './support/tempTree';

/**
 * Адаптер индикатора «БД не обновлена» (`ui/database/DatabaseLagStatusBar.ts`) поверх настоящего
 * `DatabaseConfigLagStore` во временном каталоге. Подменяются только фабрика `StatusBarItem` (видимость
 * настоящего элемента API не отдаёт) и `executeCommand` (контекст-ключ пишется в общий контекст окна тестов).
 */
suite('DatabaseLagStatusBar', () => {
  const windowRef = vscode.window as unknown as Record<string, unknown>;
  const commandsRef = vscode.commands as unknown as Record<string, unknown>;
  let saved: { createStatusBarItem: unknown; executeCommand: unknown };
  let root: string;
  let store: DatabaseConfigLagStore;
  let item: {
    name: string; text: string; tooltip: string; command: string; backgroundColor: unknown;
    shown: boolean; disposed: boolean; show(): void; hide(): void; dispose(): void;
  };
  let contexts: unknown[][];

  setup(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-db-lag-bar-')));
    store = new DatabaseConfigLagStore(root, { appendLine: () => undefined });
    contexts = [];
    item = {
      name: '', text: '', tooltip: '', command: '', backgroundColor: undefined, shown: false, disposed: false,
      show() { this.shown = true; },
      hide() { this.shown = false; },
      dispose() { this.disposed = true; },
    };
    saved = { createStatusBarItem: windowRef.createStatusBarItem, executeCommand: commandsRef.executeCommand };
    windowRef.createStatusBarItem = () => item;
    commandsRef.executeCommand = (command: string, ...args: unknown[]) => {
      if (command === 'setContext') {
        contexts.push(args);
      }
      return Promise.resolve(undefined);
    };
  });
  teardown(() => {
    windowRef.createStatusBarItem = saved.createStatusBarItem;
    commandsRef.executeCommand = saved.executeCommand;
    removeTreeSync(root);
  });

  const cf = () => ({ kind: 'cf' as const, name: 'Основная', rootPath: path.join(root, 'src', 'cf') });

  test('без отстающих целей: элемент скрыт, контекст-ключ false, клик — действия индикатора, фон предупреждения', () => {
    const bar = new DatabaseLagStatusBar(store);

    assert.strictEqual(item.shown, false);
    assert.strictEqual(item.command, 'v8vscedit.databaseLag.showActions');
    assert.strictEqual(item.name, '1С: конфигурация БД не обновлена', 'имя элемента — в меню скрытия статус-бара');
    assert.ok(item.backgroundColor instanceof vscode.ThemeColor);
    assert.deepStrictEqual(contexts, [['v8vscedit.databaseConfigurationBehind', false]]);
    bar.dispose();
  });

  test('отметка в хранилище → элемент показан с текстом и tooltip из describeDatabaseLag, контекст-ключ true; снятие — скрыт', () => {
    const bar = new DatabaseLagStatusBar(store);

    store.markBehind(cf(), 'load-without-update');

    const expected = describeDatabaseLag(store.list(), new Date());
    assert.strictEqual(item.shown, true);
    assert.strictEqual(item.text, '$(database) БД не обновлена: Основная');
    assert.strictEqual(item.tooltip, expected.tooltip);
    assert.deepStrictEqual(contexts.at(-1), ['v8vscedit.databaseConfigurationBehind', true]);

    store.markCurrent(cf());

    assert.strictEqual(item.shown, false);
    assert.deepStrictEqual(contexts.at(-1), ['v8vscedit.databaseConfigurationBehind', false]);
    bar.dispose();
  });

  test('отметка, сохранённая до старта (перезапуск VS Code), показывается сразу', () => {
    store.markBehind(cf(), 'update-failed');

    const bar = new DatabaseLagStatusBar(new DatabaseConfigLagStore(root, { appendLine: () => undefined }));

    assert.strictEqual(item.shown, true);
    assert.deepStrictEqual(contexts, [['v8vscedit.databaseConfigurationBehind', true]]);
    bar.dispose();
  });

  test('dispose: элемент освобождён, подписка снята — дальнейшие изменения не отображаются', () => {
    const bar = new DatabaseLagStatusBar(store);
    bar.dispose();
    const before = contexts.length;

    store.markBehind(cf(), 'load-without-update');

    assert.strictEqual(item.disposed, true);
    assert.strictEqual(contexts.length, before);
    assert.strictEqual(item.shown, false);
  });
});
