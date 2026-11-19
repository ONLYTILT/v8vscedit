import type { SshConnectFailureKind } from '../../domain/agent';

/**
 * Признак «SSH-соединение закрыто до готовности». ssh2 при обрыве во время KEX/auth (или при
 * DISCONNECT BY_APPLICATION) не эмитит 'error', только 'close' — код ставит сам транспорт, чтобы
 * классификация шла по признаку, а не по тексту сообщения.
 */
export const SSH_CLOSED_BEFORE_READY_CODE = 'ERR_AGENT_SSH_CLOSED_BEFORE_READY';

// Обрыв до готовности — сетевой класс: в окне прогрева при известной опорной точке повторяется,
// без неё — одна попытка, как и прочие сетевые отказы.
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET', 'EHOSTUNREACH', 'ETIMEDOUT', 'ENETUNREACH', SSH_CLOSED_BEFORE_READY_CODE,
]);

/**
 * Сводит ошибку ssh2/сокета к классу отказа для политики повторов. `level` проверяется раньше
 * `code`: auth-отказ ssh2 может нести посторонний сетевой код, но остаётся auth-отказом.
 */
export function classifySshConnectError(error: unknown): SshConnectFailureKind {
  if (typeof error !== 'object' || error === null) {
    return 'other';
  }
  const { level, code } = error as { level?: unknown; code?: unknown };
  if (level === 'client-authentication') {
    return 'auth';
  }
  if (level === 'client-timeout') {
    return 'timeout';
  }
  if (code === 'ECONNREFUSED') {
    return 'refused';
  }
  if (typeof code === 'string' && NETWORK_CODES.has(code)) {
    return 'network';
  }
  return 'other';
}
