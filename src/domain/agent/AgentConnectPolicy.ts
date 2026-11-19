/**
 * Политика повторов подключения к SSH-агенту конфигуратора.
 *
 * Агент открывает порт раньше, чем начинает принимать логин, поэтому auth-отказ сразу после
 * старта процесса (или после наблюдаемого refused) — не повод сдаваться. Но без такой опорной
 * точки auth-отказ означает неверный пароль: серия повторов под логином 1С недопустима
 * (блокировки, мусор в журнале), поэтому — сразу ошибка.
 */

export type SshConnectFailureKind = 'refused' | 'auth' | 'timeout' | 'network' | 'other';

export interface AgentConnectPolicyOptions {
  readonly startupTimeoutMs: number;
  readonly authWarmupMs: number;
  readonly retryDelayMs: number;
}

export interface AgentConnectContext {
  readonly attempt: number;
  readonly now: number;
  readonly firstAttemptAt: number;
  /** Момент старта локально запущенного агента; для внешнего агента неизвестен. */
  readonly agentStartedAt?: number;
  /** Последний наблюдавшийся refused по этой конечной точке — признак «агент только поднимается». */
  readonly lastRefusedAt?: number;
}

export type AgentConnectDecision =
  | { readonly action: 'retry'; readonly delayMs: number }
  | { readonly action: 'fail'; readonly reason: 'credentials' | 'unreachable' | 'timeout' | 'other' };

export function decideAgentConnectRetry(
  kind: SshConnectFailureKind,
  ctx: AgentConnectContext,
  opts: AgentConnectPolicyOptions
): AgentConnectDecision {
  const retry: AgentConnectDecision = { action: 'retry', delayMs: opts.retryDelayMs };
  const anchor = ctx.agentStartedAt ?? ctx.lastRefusedAt;
  // Окна открыты справа: на границе уже отказ, иначе лишняя попытка выходит за заявленный таймаут.
  switch (kind) {
    case 'refused':
      // lastRefusedAt здесь не опора: иначе каждый новый refused сдвигал бы окно бесконечно.
      return ctx.now < (ctx.agentStartedAt ?? ctx.firstAttemptAt) + opts.startupTimeoutMs
        ? retry
        : { action: 'fail', reason: 'unreachable' };
    case 'auth':
      return anchor !== undefined && ctx.now < anchor + opts.authWarmupMs
        ? retry
        : { action: 'fail', reason: 'credentials' };
    case 'timeout':
    case 'network':
      return anchor !== undefined && ctx.now < anchor + opts.startupTimeoutMs
        ? retry
        : { action: 'fail', reason: 'timeout' };
    default:
      return { action: 'fail', reason: 'other' };
  }
}
