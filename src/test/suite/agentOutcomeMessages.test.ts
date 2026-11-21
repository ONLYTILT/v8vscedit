/**
 * Чистые функции UI агентской ветки (plan-remote-extensions §5.2, §7.4 п.66): тексты итогов пакета с причиной
 * прерывания, предупреждения проверки по списку, «применены сразу», и выбор вопросов после загрузки CF/CFE
 * `planPostLoadPrompts` (вынесен из c8-ignore, все ветки под тестом).
 *
 * Контракт, принятый в тестах:
 *  - `buildBatchOutcomeMessage(report, title)` — как прежде + причина прерывания (`abortReason`);
 *  - `buildVerificationWarningsMessage(report)` — `undefined`, если предупреждений нет;
 *  - `buildAppliedImmediatelyMessage(report)` — «применены сразу: A, B» по элементам с `appliedToDatabase: true`;
 *  - `planPostLoadPrompts(outcome, extensionName)` → `{ askApply, info?, warnings }`: применённое сразу расширение
 *    вопроса «Применить к базе?» не вызывает, вместо него — информация «Расширение «X» создано в базе и применено.».
 */
import * as assert from 'assert';
import type { CfeBatchReport } from '../../infra/cfFile/CfeBatchReport';
import {
  buildAppliedImmediatelyMessage,
  buildBatchOutcomeMessage,
  buildVerificationWarningsMessage,
} from '../../ui/commands/ext/CfeBatchCommands';
import { planPostLoadPrompts } from '../../ui/commands/ext/CfFileCommands';

const report = (overrides: Partial<CfeBatchReport> = {}): CfeBatchReport => ({
  version: 1,
  operation: 'load',
  interrupted: false,
  items: [],
  ...overrides,
});

suite('buildBatchOutcomeMessage: причина прерывания (abortReason)', () => {
  test('abortReason попадает в текст вместе с «Операция прервана» и перечнем не обработанных', () => {
    const message = buildBatchOutcomeMessage(
      report({
        interrupted: true,
        abortReason: 'Соединение с агентом конфигуратора потеряно во время команды «config dump-cfg»',
        items: [
          { extensionName: 'А', fileName: 'А.cfe', status: 'ok' },
          { extensionName: 'Б', fileName: 'Б.cfe', status: 'failed' },
          { extensionName: 'В', fileName: 'В.cfe', status: 'notAttempted' },
        ],
      }),
      'Выгружены не все расширения.'
    );
    assert.ok(message);
    assert.ok(message.startsWith('Выгружены не все расширения.'), message);
    assert.ok(message.includes('Не удалось: Б.') && message.includes('Операция прервана.') && message.includes('Не обрабатывались: В.'), message);
    assert.ok(message.includes('потеряно во время команды «config dump-cfg»'), message);
  });

  test('без abortReason текст прежний (регресс): нет лишних фраз', () => {
    const message = buildBatchOutcomeMessage(
      report({ interrupted: true, items: [{ extensionName: 'А', fileName: 'А.cfe', status: 'notAttempted' }] }),
      'Заголовок.'
    );
    assert.strictEqual(message, 'Заголовок. Операция прервана. Не обрабатывались: А.');
  });

  test('abortReason без остальных признаков всё равно даёт сообщение', () => {
    const message = buildBatchOutcomeMessage(report({ abortReason: 'причина' }), 'Заголовок.');
    assert.ok(message?.includes('причина'), message);
  });

  test('нет отчёта и нечего сообщать → undefined', () => {
    assert.strictEqual(buildBatchOutcomeMessage(undefined, 'З'), undefined);
    assert.strictEqual(buildBatchOutcomeMessage(report(), 'З'), undefined);
  });
});

suite('buildVerificationWarningsMessage', () => {
  test('нет отчёта / поле не задано / пустой список → undefined', () => {
    assert.strictEqual(buildVerificationWarningsMessage(undefined), undefined);
    assert.strictEqual(buildVerificationWarningsMessage(report()), undefined);
    assert.strictEqual(buildVerificationWarningsMessage(report({ verificationWarnings: [] })), undefined);
  });

  test('предупреждения перечисляются все до одного', () => {
    const message = buildVerificationWarningsMessage(report({
      verificationWarnings: ['Расширение загружено под именем из файла: «Z» (запрошено «X»).', 'После загрузки расширения «Y» осталась заглушка'],
    }));
    assert.ok(message?.includes('«Z»') && message.includes('«X»') && message.includes('«Y»'), message);
  });
});

suite('buildAppliedImmediatelyMessage', () => {
  test('элементы с appliedToDatabase:true → «применены сразу: A, B»', () => {
    const message = buildAppliedImmediatelyMessage(report({
      items: [
        { extensionName: 'А', fileName: 'А.cfe', status: 'ok', appliedToDatabase: true },
        { extensionName: 'Б', fileName: 'Б.cfe', status: 'ok' },
        { extensionName: 'В', fileName: 'В.cfe', status: 'ok', appliedToDatabase: true },
        { extensionName: 'Г', fileName: 'Г.cfe', status: 'failed', appliedToDatabase: true },
      ],
    }));
    assert.ok(message);
    assert.ok(message.includes('применены сразу: А, В'), message);
    assert.ok(!message.includes('Б') && !message.includes('Г'), message);
  });

  test('нет таких элементов или нет отчёта → undefined', () => {
    assert.strictEqual(buildAppliedImmediatelyMessage(undefined), undefined);
    assert.strictEqual(buildAppliedImmediatelyMessage(report({ items: [{ extensionName: 'А', fileName: 'А.cfe', status: 'ok' }] })), undefined);
  });
});

suite('planPostLoadPrompts: какие вопросы и сообщения после загрузки CF/CFE', () => {
  test('batch-исход без полей агента → спрашиваем «Применить к базе?», без информации и предупреждений', () => {
    assert.deepStrictEqual(planPostLoadPrompts({ success: true }, 'Расш'), { askApply: true, info: undefined, warnings: [] });
  });

  test('основная конфигурация (имя пусто), не применена → спрашиваем', () => {
    assert.strictEqual(planPostLoadPrompts({ success: true, appliedToDatabase: false }, '').askApply, true);
  });

  test('новое расширение применено сразу → вопроса нет, вместо него информация «создано в базе и применено»', () => {
    const plan = planPostLoadPrompts({ success: true, createdInDatabase: true, appliedToDatabase: true }, 'Расш');
    assert.strictEqual(plan.askApply, false);
    assert.strictEqual(plan.info, 'Расширение «Расш» создано в базе и применено.');
    assert.deepStrictEqual(plan.warnings, []);
  });

  test('применено под именем из файла → в информации имя из базы', () => {
    const plan = planPostLoadPrompts(
      { success: true, createdInDatabase: true, appliedToDatabase: true, extensionNameInDatabase: 'Z', warnings: ['Расширение загружено под именем из файла: «Z» (запрошено «X»).'] },
      'X'
    );
    assert.strictEqual(plan.askApply, false);
    assert.ok(plan.info?.includes('«Z»'), plan.info);
    assert.deepStrictEqual(plan.warnings, ['Расширение загружено под именем из файла: «Z» (запрошено «X»).']);
  });

  test('предупреждения при неприменённом результате (существующее расширение) тоже передаются; вопрос задаётся', () => {
    const plan = planPostLoadPrompts({ success: true, appliedToDatabase: false, warnings: ['что-то'] }, 'Расш');
    assert.strictEqual(plan.askApply, true);
    assert.deepStrictEqual(plan.warnings, ['что-то']);
  });
});
