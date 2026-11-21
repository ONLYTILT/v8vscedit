import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ChangedConfiguration } from '../../infra/fs/ConfigurationChangeDetector';
import type { CommandServices } from '../../ui/commands/_shared';
import { confirmUpdateBeforeThinClient } from '../../ui/commands/db/DbCommands';
import { FakeLagRecorder } from './support/databaseLagFakes';

/**
 * Вопрос «обновить перед запуском тонкого клиента» опирается на `getChangedConfigurations`, который
 * теперь асинхронный: он ждёт окончания фоновой проверки изменений, иначе в окне после старта ответ
 * был бы ложным «изменений нет». Диалог VS Code — внешняя система, подменяется на время теста.
 */
suite('DbCommands: подтверждение обновления перед тонким клиентом', () => {
  const changed: ChangedConfiguration = { kind: 'cf', rootPath: 'c:/x', name: 'Конф', changedFilesCount: 1 };

  function services(list: ChangedConfiguration[]): CommandServices {
    // Вопрос учитывает и отстающие цели (признак «БД отстаёт»): здесь их нет.
    return { getChangedConfigurations: () => Promise.resolve(list), databaseConfigLag: new FakeLagRecorder() } as unknown as CommandServices;
  }

  async function withQuickPick<T>(answer: { id: string } | undefined, action: () => Promise<T>): Promise<{ result: T; asked: number }> {
    const w = vscode.window as unknown as { showQuickPick: unknown };
    const original = w.showQuickPick;
    let asked = 0;
    w.showQuickPick = () => { asked += 1; return Promise.resolve(answer); };
    try {
      return { result: await action(), asked };
    } finally {
      w.showQuickPick = original;
    }
  }

  test('изменений нет → запуск без вопроса', async () => {
    const { result, asked } = await withQuickPick(undefined, () => confirmUpdateBeforeThinClient(services([])));
    assert.strictEqual(result, true);
    assert.strictEqual(asked, 0);
  });

  test('изменения есть, выбрано «Запустить без обновления» → true', async () => {
    const { result, asked } = await withQuickPick({ id: 'run' }, () => confirmUpdateBeforeThinClient(services([changed])));
    assert.strictEqual(result, true);
    assert.strictEqual(asked, 1);
  });

  test('изменения есть, диалог закрыт → false', async () => {
    const { result } = await withQuickPick(undefined, () => confirmUpdateBeforeThinClient(services([changed])));
    assert.strictEqual(result, false);
  });
});
