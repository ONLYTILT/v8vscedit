import * as assert from 'assert';
import { SSH_CLOSED_BEFORE_READY_CODE, classifySshConnectError } from '../../infra/agent/SshConnectErrorClassifier';
import type { SshConnectFailureKind } from '../../domain/agent';

function withProps(message: string, props: Record<string, unknown>): Error {
  return Object.assign(new Error(message), props);
}

suite('Агент: classifySshConnectError', () => {
  const cases: [string, unknown, SshConnectFailureKind][] = [
    ['level client-authentication -> auth', withProps('All configured authentication methods failed', { level: 'client-authentication' }), 'auth'],
    ['code ECONNREFUSED -> refused', withProps('connect ECONNREFUSED 127.0.0.1:1543', { code: 'ECONNREFUSED' }), 'refused'],
    ['level client-timeout -> timeout', withProps('Timed out while waiting for handshake', { level: 'client-timeout' }), 'timeout'],
    ['ECONNRESET -> network', withProps('read ECONNRESET', { code: 'ECONNRESET' }), 'network'],
    ['EHOSTUNREACH -> network', withProps('x', { code: 'EHOSTUNREACH' }), 'network'],
    ['ETIMEDOUT -> network', withProps('x', { code: 'ETIMEDOUT' }), 'network'],
    ['ENETUNREACH -> network', withProps('x', { code: 'ENETUNREACH' }), 'network'],
    // Закрытие до готовности ssh2 сообщает только событием 'close'; признак ставит транспорт.
    ['закрыто до готовности -> network', withProps('x', { code: SSH_CLOSED_BEFORE_READY_CODE }), 'network'],
    ['неизвестный code -> other', withProps('x', { code: 'EACCES' }), 'other'],
    ['неизвестный level (client-socket) -> other', withProps('x', { level: 'client-socket' }), 'other'],
    ['обычный Error без признаков -> other', new Error('boom'), 'other'],
    ['строка -> other', 'ECONNREFUSED', 'other'],
    ['null -> other', null, 'other'],
    ['undefined -> other', undefined, 'other'],
    ['число -> other', 42, 'other'],
    ['простой объект без признаков -> other', { message: 'x' }, 'other'],
  ];

  for (const [title, error, expected] of cases) {
    test(title, () => {
      assert.strictEqual(classifySshConnectError(error), expected);
    });
  }

  test('level имеет приоритет над code (auth-отказ с посторонним code остаётся auth)', () => {
    assert.strictEqual(
      classifySshConnectError(withProps('x', { level: 'client-authentication', code: 'ECONNRESET' })),
      'auth'
    );
  });
});
