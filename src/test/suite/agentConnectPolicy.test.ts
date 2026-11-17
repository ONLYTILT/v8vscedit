import * as assert from 'assert';
import {
  decideAgentConnectRetry,
  type AgentConnectContext,
  type AgentConnectDecision,
  type AgentConnectPolicyOptions,
  type SshConnectFailureKind,
} from '../../domain/agent';

/**
 * Табличные тесты чистой политики повторов подключения к агенту (Э3).
 * Главное правило: «на границе» (now === предел окна) — уже отказ, окно строго открытое справа;
 * auth без опорной точки — сразу credentials (защита от серии неверных входов под логином 1С).
 */

const OPTS: AgentConnectPolicyOptions = { startupTimeoutMs: 15_000, authWarmupMs: 90_000, retryDelayMs: 1_000 };
const FIRST = 1_000;

type Reason = 'credentials' | 'unreachable' | 'timeout' | 'other';
const retry: AgentConnectDecision = { action: 'retry', delayMs: OPTS.retryDelayMs };
const fail = (reason: Reason): AgentConnectDecision => ({ action: 'fail', reason });

interface Row {
  readonly title: string;
  readonly kind: SshConnectFailureKind;
  readonly agentStartedAt?: number;
  readonly lastRefusedAt?: number;
  readonly now: number;
  readonly expected: AgentConnectDecision;
}

function ctx(row: Row): AgentConnectContext {
  return {
    attempt: 1,
    now: row.now,
    firstAttemptAt: FIRST,
    ...(row.agentStartedAt !== undefined ? { agentStartedAt: row.agentStartedAt } : {}),
    ...(row.lastRefusedAt !== undefined ? { lastRefusedAt: row.lastRefusedAt } : {}),
  };
}

// Для refused окно считается от agentStartedAt, иначе от firstAttemptAt (lastRefusedAt не участвует).
const rows: Row[] = [
  // refused: agentStartedAt=500 -> предел 15_500
  { title: 'refused, agentStartedAt: внутри окна', kind: 'refused', agentStartedAt: 500, now: 15_499, expected: retry },
  { title: 'refused, agentStartedAt: ровно на границе', kind: 'refused', agentStartedAt: 500, now: 15_500, expected: fail('unreachable') },
  { title: 'refused, agentStartedAt: после окна', kind: 'refused', agentStartedAt: 500, now: 15_501, expected: fail('unreachable') },
  // refused без agentStartedAt: предел FIRST + 15_000 = 16_000
  { title: 'refused, без опоры: внутри окна от firstAttemptAt', kind: 'refused', now: 15_999, expected: retry },
  { title: 'refused, без опоры: ровно на границе', kind: 'refused', now: 16_000, expected: fail('unreachable') },
  { title: 'refused, без опоры: после окна', kind: 'refused', now: 16_001, expected: fail('unreachable') },
  { title: 'refused, только lastRefusedAt: окно всё равно от firstAttemptAt (внутри)', kind: 'refused', lastRefusedAt: 9_000, now: 15_999, expected: retry },
  { title: 'refused, только lastRefusedAt: окно от firstAttemptAt (граница)', kind: 'refused', lastRefusedAt: 9_000, now: 16_000, expected: fail('unreachable') },
  { title: 'refused, оба: приоритет agentStartedAt (после его окна, хотя от firstAttemptAt ещё внутри)', kind: 'refused', agentStartedAt: 500, lastRefusedAt: 9_000, now: 15_500, expected: fail('unreachable') },

  // auth: окно authWarmupMs от anchor
  { title: 'auth, agentStartedAt=2000: внутри окна', kind: 'auth', agentStartedAt: 2_000, now: 91_999, expected: retry },
  { title: 'auth, agentStartedAt=2000: ровно на границе', kind: 'auth', agentStartedAt: 2_000, now: 92_000, expected: fail('credentials') },
  { title: 'auth, agentStartedAt=2000: после окна', kind: 'auth', agentStartedAt: 2_000, now: 92_001, expected: fail('credentials') },
  { title: 'auth, lastRefusedAt=3000: внутри окна', kind: 'auth', lastRefusedAt: 3_000, now: 92_999, expected: retry },
  { title: 'auth, lastRefusedAt=3000: ровно на границе', kind: 'auth', lastRefusedAt: 3_000, now: 93_000, expected: fail('credentials') },
  { title: 'auth, lastRefusedAt=3000: после окна', kind: 'auth', lastRefusedAt: 3_000, now: 93_001, expected: fail('credentials') },
  { title: 'auth, оба: приоритет agentStartedAt (окно от lastRefusedAt ещё открыто, от старта уже закрыто)', kind: 'auth', agentStartedAt: 2_000, lastRefusedAt: 50_000, now: 92_000, expected: fail('credentials') },
  { title: 'auth, оба: приоритет agentStartedAt (внутри)', kind: 'auth', agentStartedAt: 80_000, lastRefusedAt: 2_000, now: 100_000, expected: retry },
  { title: 'auth, без опоры: сразу credentials сразу после первой попытки', kind: 'auth', now: FIRST, expected: fail('credentials') },
  { title: 'auth, без опоры: credentials и на любом now', kind: 'auth', now: 5, expected: fail('credentials') },

  // timeout / network: окно startupTimeoutMs от anchor, без anchor — fail timeout
  ...(['timeout', 'network'] as const).flatMap((kind): Row[] => [
    { title: `${kind}, agentStartedAt=2000: внутри окна`, kind, agentStartedAt: 2_000, now: 16_999, expected: retry },
    { title: `${kind}, agentStartedAt=2000: ровно на границе`, kind, agentStartedAt: 2_000, now: 17_000, expected: fail('timeout') },
    { title: `${kind}, agentStartedAt=2000: после окна`, kind, agentStartedAt: 2_000, now: 17_001, expected: fail('timeout') },
    { title: `${kind}, lastRefusedAt=3000: внутри окна`, kind, lastRefusedAt: 3_000, now: 17_999, expected: retry },
    { title: `${kind}, lastRefusedAt=3000: ровно на границе`, kind, lastRefusedAt: 3_000, now: 18_000, expected: fail('timeout') },
    { title: `${kind}, lastRefusedAt=3000: после окна`, kind, lastRefusedAt: 3_000, now: 18_001, expected: fail('timeout') },
    { title: `${kind}, оба: приоритет agentStartedAt (граница его окна)`, kind, agentStartedAt: 2_000, lastRefusedAt: 10_000, now: 17_000, expected: fail('timeout') },
    { title: `${kind}, без опоры: fail timeout`, kind, now: FIRST, expected: fail('timeout') },
  ]),

  // other: всегда отказ, независимо от опор и времени
  { title: 'other, без опоры', kind: 'other', now: FIRST, expected: fail('other') },
  { title: 'other, внутри всех окон', kind: 'other', agentStartedAt: 900, lastRefusedAt: 950, now: 1_001, expected: fail('other') },
];

suite('Агент: decideAgentConnectRetry (табличный)', () => {
  for (const row of rows) {
    test(row.title, () => {
      assert.deepStrictEqual(decideAgentConnectRetry(row.kind, ctx(row), OPTS), row.expected);
    });
  }

  test('delayMs берётся из retryDelayMs настроек, а не константа', () => {
    const decision = decideAgentConnectRetry('refused', { attempt: 1, now: FIRST, firstAttemptAt: FIRST }, { ...OPTS, retryDelayMs: 250 });
    assert.deepStrictEqual(decision, { action: 'retry', delayMs: 250 });
  });

  test('номер попытки сам по себе не ограничивает повторы — только окна времени', () => {
    const decision = decideAgentConnectRetry('refused', { attempt: 10_000, now: FIRST, firstAttemptAt: FIRST }, OPTS);
    assert.deepStrictEqual(decision, retry);
  });
});
