/**
 * Тонкий клиент (`confirmUpdateBeforeThinClient`): запуску Предприятия нужна КОНФИГУРАЦИЯ БД, поэтому загрузка
 * перед запуском — всегда С обновлением (`{ updateDatabase: true }`, настройка не учитывается). Если изменений
 * нет, но есть отстающие цели — тот же вопрос: «Обновить конфигурацию БД и запустить» / «Запустить без
 * обновления» / отмена.
 */
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ChangedConfiguration } from '../../infra/fs/ConfigurationChangeDetector';
import type { CommandServices } from '../../ui/commands/_shared';
import { confirmUpdateBeforeThinClient } from '../../ui/commands/db/DbCommands';
import { FakeLagRecorder } from './support/databaseLagFakes';

type PickAnswer = (items: readonly vscode.QuickPickItem[]) => vscode.QuickPickItem | undefined;

suite('Тонкий клиент: загрузка с обновлением БД и отстающие цели', () => {
  const w = vscode.window as unknown as Record<string, unknown>;
  const commandsRef = vscode.commands as unknown as { executeCommand: unknown };
  const saved: Record<string, unknown> = {};
  let lag: FakeLagRecorder;
  let changed: ChangedConfiguration[];
  let pickItems: (readonly vscode.QuickPickItem[])[];
  let picks: PickAnswer[];
  let executed: { command: string; args: unknown[] }[];
  let executeResult: unknown;

  const services = (): CommandServices => ({
    getChangedConfigurations: () => Promise.resolve(changed),
    databaseConfigLag: lag,
  }) as unknown as CommandServices;
  const idOf = (item: vscode.QuickPickItem): string | undefined => (item as { id?: string }).id;
  const pickId = (id: string): PickAnswer => (items) => items.find((item) => idOf(item) === id);

  setup(() => {
    lag = new FakeLagRecorder();
    changed = [];
    pickItems = [];
    picks = [];
    executed = [];
    executeResult = true;
    saved.showQuickPick = w.showQuickPick;
    saved.executeCommand = commandsRef.executeCommand;
    w.showQuickPick = (items: readonly vscode.QuickPickItem[]) => {
      pickItems.push(items);
      const answer = picks.shift();
      assert.ok(answer, 'неожиданный showQuickPick');
      return Promise.resolve(answer(items));
    };
    commandsRef.executeCommand = (command: string, ...args: unknown[]) => {
      executed.push({ command, args });
      return Promise.resolve(executeResult);
    };
  });
  teardown(() => {
    w.showQuickPick = saved.showQuickPick;
    commandsRef.executeCommand = saved.executeCommand;
  });

  const cfChanged = (): ChangedConfiguration => ({ kind: 'cf', name: 'Основная', rootPath: '/p/src/cf', changedFilesCount: 2 });
  const behindCf = (): void => lag.markBehind({ kind: 'cf', name: 'Основная', rootPath: '/p/src/cf' }, 'load-without-update');

  test('нет изменений и нет отстающих: вопроса нет, запуск разрешён', async () => {
    assert.strictEqual(await confirmUpdateBeforeThinClient(services()), true);
    assert.strictEqual(pickItems.length, 0);
    assert.deepStrictEqual(executed, []);
  });

  test('есть изменения, «Обновить и запустить»: updateChangedConfigurations с { updateDatabase: true } (настройка не учитывается), результат команды возвращается', async () => {
    changed = [cfChanged()];
    picks.push(pickId('update'));

    assert.strictEqual(await confirmUpdateBeforeThinClient(services()), true);

    assert.deepStrictEqual(executed, [{ command: 'v8vscedit.updateChangedConfigurations', args: [{ updateDatabase: true }] }]);
    assert.deepStrictEqual(pickItems[0].map(idOf), ['update', 'run']);
  });

  test('«Обновить и запустить», загрузка не удалась: запуск отменяется (false)', async () => {
    changed = [cfChanged()];
    picks.push(pickId('update'));
    executeResult = false;
    assert.strictEqual(await confirmUpdateBeforeThinClient(services()), false);
  });

  test('есть изменения, «Запустить без обновления»: запуск без команд', async () => {
    changed = [cfChanged()];
    picks.push(pickId('run'));
    assert.strictEqual(await confirmUpdateBeforeThinClient(services()), true);
    assert.deepStrictEqual(executed, []);
  });

  test('Esc в вопросе: запуск отменён, команд нет', async () => {
    changed = [cfChanged()];
    picks.push(() => undefined);
    assert.strictEqual(await confirmUpdateBeforeThinClient(services()), false);
    assert.deepStrictEqual(executed, []);
  });

  test('изменений нет, цель отстаёт: вопрос «Обновить конфигурацию БД и запустить» / «Запустить без обновления»', async () => {
    behindCf();
    picks.push(pickId('run'));

    assert.strictEqual(await confirmUpdateBeforeThinClient(services()), true);

    assert.deepStrictEqual(pickItems[0].map(idOf), ['update-database', 'run']);
    assert.ok(pickItems[0][0].label.includes('Обновить конфигурацию БД и запустить'), pickItems[0][0].label);
    assert.deepStrictEqual(executed, []);
  });

  test('изменений нет, цель отстаёт, «Обновить конфигурацию БД и запустить»: запускается команда обновления БД; её итог — итог вопроса', async () => {
    behindCf();
    picks.push(pickId('update-database'));

    assert.strictEqual(await confirmUpdateBeforeThinClient(services()), true);

    assert.strictEqual(executed.length, 1);
    assert.ok(
      ['v8vscedit.updateDatabaseConfiguration', 'v8vscedit.updateChangedConfigurations'].includes(executed[0].command),
      executed[0].command
    );
  });

  test('изменений нет, отстающая цель, обновление БД не удалось: запуск отменяется', async () => {
    behindCf();
    picks.push(pickId('update-database'));
    executeResult = false;
    assert.strictEqual(await confirmUpdateBeforeThinClient(services()), false);
  });

  test('есть и изменения, и отстающие: пункт «update» (загрузка с обновлением покрывает обе группы)', async () => {
    changed = [cfChanged()];
    lag.markBehind({ kind: 'cfe', name: 'Расш', rootPath: '/p/src/cfe/Расш', extensionName: 'Расш' }, 'cf-file-load');
    picks.push(pickId('update'));

    await confirmUpdateBeforeThinClient(services());

    assert.deepStrictEqual(pickItems[0].map(idOf), ['update', 'run']);
    assert.deepStrictEqual(executed, [{ command: 'v8vscedit.updateChangedConfigurations', args: [{ updateDatabase: true }] }]);
  });
});
