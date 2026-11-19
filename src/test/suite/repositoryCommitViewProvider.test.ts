import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  RepositoryCommitViewProvider,
  resolveRepositoryCommitAnswer,
  type RepositoryCommitFormData,
} from '../../ui/views/RepositoryCommitViewProvider';

const FORM: RepositoryCommitFormData = { comment: 'правка', recursive: true, keepLocked: false, force: false };

suite('RepositoryCommitViewProvider: ответ формы помещения', () => {
  const notAnswers: readonly { readonly title: string; readonly message: { type: string; command?: string } }[] = [
    { title: 'служебное ready сразу после загрузки webview', message: { type: 'ready' } },
    { title: 'иной тип сообщения', message: { type: 'status' } },
    { title: 'неизвестная команда', message: { type: 'command', command: 'refresh' } },
    { title: 'submit без данных формы', message: { type: 'command', command: 'submit' } },
  ];
  for (const { title, message } of notAnswers) {
    test(`${title} — не ответ, форма остаётся открытой`, () => {
      assert.strictEqual(resolveRepositoryCommitAnswer(message), null);
    });
  }

  test('submit с данными — ответ с данными формы', () => {
    assert.deepStrictEqual(
      resolveRepositoryCommitAnswer({ type: 'command', command: 'submit', payload: FORM }),
      { kind: 'submit', data: FORM }
    );
  });

  test('cancel — отмена', () => {
    assert.deepStrictEqual(resolveRepositoryCommitAnswer({ type: 'command', command: 'cancel' }), { kind: 'cancel' });
  });

  suite('панель', () => {
    let provider: RepositoryCommitViewProvider;
    // Приватный обработчик — та же точка, куда приходят сообщения webview; настоящий webview из теста сообщение не пошлёт.
    const deliver = (message: unknown): void => {
      (provider as unknown as { handleMessage(m: unknown): void }).handleMessage(message);
    };
    const isOpen = (): boolean => (provider as unknown as { panel: unknown }).panel !== undefined;

    setup(() => {
      provider = new RepositoryCommitViewProvider(vscode.Uri.file(path.resolve(__dirname, '..', '..', '..')));
    });

    teardown(() => {
      provider.dispose();
    });

    test('ready не закрывает форму и не завершает ожидание; submit возвращает данные и закрывает панель', async () => {
      let settled = false;
      const answer = provider.show('Справочник.Товары', false).then((value) => { settled = true; return value; });

      deliver({ type: 'ready' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(settled, false, 'ready не должен считаться ответом');
      assert.strictEqual(isOpen(), true, 'панель после ready открыта');

      deliver({ type: 'command', command: 'submit', payload: FORM });
      assert.deepStrictEqual(await answer, FORM);
      assert.strictEqual(isOpen(), false);
    });

    test('cancel завершает ожидание с undefined', async () => {
      const answer = provider.show('Справочник.Товары', true);
      deliver({ type: 'command', command: 'cancel' });
      assert.strictEqual(await answer, undefined);
      assert.strictEqual(isOpen(), false);
    });
  });
});
