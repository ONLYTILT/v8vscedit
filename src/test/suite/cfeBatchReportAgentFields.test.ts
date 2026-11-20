/**
 * Расширение отчёта пакета полями агентской ветки (plan-remote-extensions §3.3):
 * `items[].appliedToDatabase`, `abortReason`, `verificationWarnings`. Поля необязательны — отчёт CLI без них
 * читается и пишется ровно как раньше (обратная совместимость), испорченное значение поля не убивает отчёт.
 */
import * as assert from 'assert';
import { parseCfeBatchReport, serializeCfeBatchReport, type CfeBatchReport } from '../../infra/cfFile/CfeBatchReport';

const base: CfeBatchReport = {
  version: 1,
  operation: 'load',
  interrupted: false,
  items: [{ extensionName: 'Расш', fileName: 'Расш.cfe', status: 'ok' }],
};

suite('CfeBatchReport: поля агентской ветки', () => {
  test('round-trip с новыми полями', () => {
    const report: CfeBatchReport = {
      ...base,
      items: [
        { extensionName: 'Новое', fileName: 'Новое.cfe', status: 'ok', appliedToDatabase: true },
        { extensionName: 'Старое', fileName: 'Старое.cfe', status: 'ok', appliedToDatabase: false },
      ],
      interrupted: true,
      abortReason: 'Агент конфигуратора аварийно завершился во время команды «config load-cfg»',
      verificationWarnings: ['Расширение загружено под именем из файла: «Z» (запрошено «X»).', 'вторая'],
    };
    assert.deepStrictEqual(parseCfeBatchReport(serializeCfeBatchReport(report)), report);
  });

  test('обратная совместимость: отчёт без новых полей — round-trip без добавления ключей', () => {
    const text = serializeCfeBatchReport(base);
    const parsed = parseCfeBatchReport(text);
    assert.ok(parsed);
    assert.deepStrictEqual(parsed, base);
    assert.ok(!('abortReason' in parsed));
    assert.ok(!('verificationWarnings' in parsed));
    assert.ok(!('appliedToDatabase' in parsed.items[0]));
    const json = JSON.parse(text) as Record<string, unknown>;
    assert.ok(!('abortReason' in json) && !('verificationWarnings' in json));
  });

  test('отчёт CLI прежнего вида (без полей) читается', () => {
    const legacy = JSON.stringify({
      version: 1, operation: 'dump', interrupted: false,
      items: [{ extensionName: 'A', fileName: 'A.cfe', status: 'ok', sizeBytes: 5 }],
    });
    const parsed = parseCfeBatchReport(legacy);
    assert.ok(parsed);
    assert.strictEqual(parsed.items[0].extensionName, 'A');
    assert.strictEqual(parsed.abortReason, undefined);
  });

  test('испорченные значения новых полей игнорируются, остальной отчёт сохраняется', () => {
    const text = JSON.stringify({
      version: 1, operation: 'load', interrupted: false,
      items: [{ extensionName: 'A', fileName: 'A.cfe', status: 'ok', appliedToDatabase: 'да' }],
      abortReason: 42,
      verificationWarnings: ['ok', 7],
    });
    const parsed = parseCfeBatchReport(text);
    assert.ok(parsed);
    assert.strictEqual(parsed.items[0].appliedToDatabase, undefined);
    assert.strictEqual(parsed.abortReason, undefined);
    assert.strictEqual(parsed.verificationWarnings, undefined);
  });

  test('пустой список verificationWarnings сохраняется как заданный (отличим от «не проверялось»)', () => {
    const parsed = parseCfeBatchReport(serializeCfeBatchReport({ ...base, verificationWarnings: [] }));
    assert.deepStrictEqual(parsed?.verificationWarnings, []);
  });
});
