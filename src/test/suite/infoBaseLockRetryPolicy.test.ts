import * as assert from 'assert';
import {
  DEFAULT_INFO_BASE_LOCK_RETRY,
  decideInfoBaseLockRetry,
  type InfoBaseLockRetryOptions,
} from '../../domain/agent/InfoBaseLockRetryPolicy';

suite('InfoBaseLockRetryPolicy: повтор connect-ib при блокировке ИБ другим Конфигуратором', () => {
  test('умолчание: окно 15 с, задержки 0,5 → 1 → 2 с', () => {
    assert.deepStrictEqual(DEFAULT_INFO_BASE_LOCK_RETRY, { windowMs: 15_000, delaysMs: [500, 1_000, 2_000] });
  });

  const delays: [number, number][] = [[1, 500], [2, 1_000], [3, 2_000], [4, 2_000], [5, 2_000], [20, 2_000]];
  for (const [failures, delayMs] of delays) {
    test(`отказ №${String(failures)} при elapsed 0: повтор через ${String(delayMs)} мс`, () => {
      assert.deepStrictEqual(
        decideInfoBaseLockRetry({ failures, elapsedMs: 0 }, DEFAULT_INFO_BASE_LOCK_RETRY),
        { action: 'retry', delayMs }
      );
    });
  }

  test('граница окна открыта справа: elapsed + delay === windowMs — отказ', () => {
    assert.deepStrictEqual(
      decideInfoBaseLockRetry({ failures: 1, elapsedMs: 14_500 }, DEFAULT_INFO_BASE_LOCK_RETRY),
      { action: 'fail' }
    );
  });

  test('на миллисекунду раньше границы — ещё повтор', () => {
    assert.deepStrictEqual(
      decideInfoBaseLockRetry({ failures: 1, elapsedMs: 14_499 }, DEFAULT_INFO_BASE_LOCK_RETRY),
      { action: 'retry', delayMs: 500 }
    );
  });

  test('за границей окна — отказ', () => {
    assert.deepStrictEqual(
      decideInfoBaseLockRetry({ failures: 3, elapsedMs: 20_000 }, DEFAULT_INFO_BASE_LOCK_RETRY),
      { action: 'fail' }
    );
  });

  test('граница считается с учётом задержки конкретного отказа (2 с)', () => {
    assert.deepStrictEqual(
      decideInfoBaseLockRetry({ failures: 4, elapsedMs: 12_999 }, DEFAULT_INFO_BASE_LOCK_RETRY),
      { action: 'retry', delayMs: 2_000 }
    );
    assert.deepStrictEqual(
      decideInfoBaseLockRetry({ failures: 4, elapsedMs: 13_000 }, DEFAULT_INFO_BASE_LOCK_RETRY),
      { action: 'fail' }
    );
  });

  test('пользовательские опции: последняя задержка повторяется, окно свое', () => {
    const options: InfoBaseLockRetryOptions = { windowMs: 3_000, delaysMs: [100] };
    for (const failures of [1, 2, 7]) {
      assert.deepStrictEqual(decideInfoBaseLockRetry({ failures, elapsedMs: 0 }, options), { action: 'retry', delayMs: 100 });
    }
    assert.deepStrictEqual(decideInfoBaseLockRetry({ failures: 2, elapsedMs: 2_900 }, options), { action: 'fail' });
  });

  test('failures = 0 — RangeError (ошибка программиста)', () => {
    assert.throws(() => decideInfoBaseLockRetry({ failures: 0, elapsedMs: 0 }, DEFAULT_INFO_BASE_LOCK_RETRY), RangeError);
  });

  test('отрицательное число отказов — RangeError', () => {
    assert.throws(() => decideInfoBaseLockRetry({ failures: -1, elapsedMs: 0 }, DEFAULT_INFO_BASE_LOCK_RETRY), RangeError);
  });

  test('пустой delaysMs — RangeError', () => {
    assert.throws(() => decideInfoBaseLockRetry({ failures: 1, elapsedMs: 0 }, { windowMs: 1_000, delaysMs: [] }), RangeError);
  });
});
