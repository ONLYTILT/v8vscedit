/**
 * Хуки агентских операций без участия человека (`ui/commands/ext/agent/unattendedAgentHooks.ts`, чистые):
 * отказ от полной выгрузки, ответ «Отмена» на вопрос агента, тексты причин отказа и предупреждений.
 */
import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import type { AgentMessage } from '../../domain/agent';
import type { AgentFullDumpRequest } from '../../infra/agent/AgentOperationService';
import {
  UNATTENDED_QUESTION_ANSWER,
  createUnattendedAgentHooks,
  describeUnattendedFullDumpRefusal,
  describeUnattendedQuestion,
  resolveUnattendedFailure,
  unattendedWarnings,
  type UnattendedInteractionLog,
} from '../../ui/commands/ext/agent/unattendedAgentHooks';

function fullDump(overrides: Partial<AgentFullDumpRequest> = {}): AgentFullDumpRequest {
  return {
    targetKind: 'cf', targetName: 'Бухгалтерия КОРП', projectDir: path.join(os.tmpdir(), 'p'), operation: 'import',
    reason: 'mirror-empty', reasonText: 'зеркало агента пусто', download: true, ...overrides,
  };
}

const question = (message: string): AgentMessage => ({ type: 'question', message });

suite('unattendedAgentHooks: хуки', () => {
  test("confirmFullDump всегда 'cancel'; последний запрос сохранён в log; report получил причину", async () => {
    const lines: string[] = [];
    const hooks = createUnattendedAgentHooks((line) => { lines.push(line); });
    const first = fullDump({ reasonText: 'первая причина' });
    const second = fullDump({ reasonText: 'вторая причина', download: false });

    assert.strictEqual(await hooks.confirmFullDump(first), 'cancel');
    assert.strictEqual(await hooks.confirmFullDump(second), 'cancel');

    assert.strictEqual(hooks.log.fullDumpRequest, second);
    assert.strictEqual(lines.length, 2);
    assert.ok(lines[0].includes('без участия человека'), lines[0]);
    assert.ok(lines[0].includes('первая причина'), lines[0]);
    assert.ok(lines[1].includes('вторая причина'), lines[1]);
  });

  const questions: [string, string][] = [
    ['обычный', 'Продолжить операцию?\nПодробности'],
    ['секретный (пароль)', 'Введите пароль пользователя'],
    ['логинный', 'Введите логин пользователя'],
  ];
  for (const [title, text] of questions) {
    test(`onQuestion (${title}) → '${UNATTENDED_QUESTION_ANSWER}'; в log — первая строка вопроса`, async () => {
      const lines: string[] = [];
      const hooks = createUnattendedAgentHooks((line) => { lines.push(line); });

      assert.strictEqual(await hooks.onQuestion(question(text)), UNATTENDED_QUESTION_ANSWER);
      assert.strictEqual(UNATTENDED_QUESTION_ANSWER, 'cancel');

      assert.deepStrictEqual(hooks.log.questions, [text.split('\n')[0]]);
      assert.strictEqual(lines.length, 1);
      assert.ok(lines[0].includes('без участия человека'), lines[0]);
      assert.ok(lines[0].includes(text.split('\n')[0]), lines[0]);
    });
  }

  test('секретный вопрос: в журнале нет ответа-секрета и никакого пользовательского ввода', async () => {
    const lines: string[] = [];
    const hooks = createUnattendedAgentHooks((line) => { lines.push(line); });
    await hooks.onQuestion(question('Пароль для Admin'));
    assert.ok(!lines.join('\n').includes('введён'), lines.join('\n'));
  });
});

suite('unattendedAgentHooks: describeUnattendedFullDumpRefusal', () => {
  const importDownload = (name: string, reason: string): string =>
    `Импорт «${name}» требует полной выгрузки конфигурации на сервере: ${reason}. Без подтверждения человека она не ` +
    'запускается (для большой конфигурации — десятки минут и сотни мегабайт). Выполните импорт из интерфейса VS Code ' +
    '(команда «Импортировать конфигурации из базы») и подтвердите выгрузку. Проект не изменён.';
  const importRewrite = (name: string, reason: string): string =>
    `Импорт «${name}» требует перезаписи зеркала агента выгрузкой на сервере: ${reason}. Без подтверждения человека она ` +
    'не запускается. Выполните импорт из интерфейса VS Code и подтвердите выгрузку. Проект не изменён.';
  const load = (name: string, reason: string): string =>
    `Загрузка «${name}» требует выгрузки конфигурации на сервере для подготовки зеркала агента: ${reason}. Без ` +
    'подтверждения человека она не запускается. Выполните загрузку из интерфейса VS Code («Обновить в базе») и ' +
    'подтвердите выгрузку. База и проект не изменены.';

  for (const operation of ['import', 'load'] as const) {
    for (const download of [true, false]) {
      test(`operation=${operation}, download=${String(download)}: точный текст по плану`, () => {
        const request = fullDump({ operation, download, targetName: 'Расш', reasonText: 'причина X' });
        const expected = operation === 'load'
          ? load('Расш', 'причина X')
          : (download ? importDownload('Расш', 'причина X') : importRewrite('Расш', 'причина X'));
        const actual = describeUnattendedFullDumpRefusal(request);
        assert.strictEqual(actual, expected);
        assert.ok(actual.includes('интерфейса VS Code'));
        assert.ok(actual.includes(operation === 'load' ? 'База и проект не изменены' : 'Проект не изменён'));
      });
    }
  }
});

suite('unattendedAgentHooks: describeUnattendedQuestion, resolveUnattendedFailure, unattendedWarnings', () => {
  test('describeUnattendedQuestion: текст по плану', () => {
    assert.strictEqual(
      describeUnattendedQuestion('Продолжить?'),
      'Агент конфигуратора запросил ответ («Продолжить?»), а вызов идёт без участия человека: дан ответ «Отмена».'
    );
  });

  test('есть запрос полной выгрузки → его текст, requiresUserAction: true (fallback игнорируется)', () => {
    const request = fullDump();
    const log: UnattendedInteractionLog = { fullDumpRequest: request, questions: ['вопрос'] };
    assert.deepStrictEqual(resolveUnattendedFailure(log, 'Ошибка агента'), {
      reason: describeUnattendedFullDumpRefusal(request),
      requiresUserAction: true,
    });
  });

  test('нет полной выгрузки, есть вопросы → описание вопроса, инструкция и fallback, requiresUserAction: true', () => {
    const log: UnattendedInteractionLog = { questions: ['Продолжить?'] };
    const result = resolveUnattendedFailure(log, 'Ошибка агента');
    assert.strictEqual(result.requiresUserAction, true);
    assert.strictEqual(
      result.reason,
      `${describeUnattendedQuestion('Продолжить?')} Выполните операцию из интерфейса VS Code. Ошибка агента`
    );
  });

  test('пусто → fallback, requiresUserAction: false', () => {
    assert.deepStrictEqual(resolveUnattendedFailure({ questions: [] }, 'Просто ошибка'), {
      reason: 'Просто ошибка',
      requiresUserAction: false,
    });
  });

  test('unattendedWarnings: пусто → []; два вопроса → два предупреждения', () => {
    assert.deepStrictEqual(unattendedWarnings({ questions: [] }), []);
    assert.deepStrictEqual(unattendedWarnings({ questions: ['Один?', 'Два?'] }), [
      describeUnattendedQuestion('Один?'),
      describeUnattendedQuestion('Два?'),
    ]);
  });
});
