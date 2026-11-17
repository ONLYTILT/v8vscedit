import type { AgentConnectPolicyOptions } from '../../domain/agent';
import { decideAgentConnectRetry } from '../../domain/agent';
import { classifySshConnectError } from './SshConnectErrorClassifier';

/** Конечная точка, о которой говорит текст отказа подключения. */
export interface AgentConnectEndpoint {
  readonly host: string;
  readonly port: number;
  readonly user: string;
}

/** Параметры политики повторов одной конечной точки (план §5b, Э3). */
export interface AgentConnectRetryOptions extends AgentConnectEndpoint {
  readonly policy: AgentConnectPolicyOptions;
  /** Момент старта локально запущенного агента: открывает окно прогрева для auth-отказов. */
  readonly agentStartedAt?: number;
}

export interface AgentConnectRetryDeps {
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Цикл подключения к SSH агента по политике Э3 — общий для shell-транспорта и SFTP-хранилища,
 * чтобы оба соединения одной конечной точки одинаково переживали прогрев агента и одинаково
 * описывали отказ. Экземпляр хранит состояние конечной точки между вызовами `run()`: refused в
 * прошлой попытке означает, что агент только что поднимался, и auth-отказ вскоре после этого —
 * ещё прогрев, а не пароль.
 */
export class AgentConnectRetryLoop {
  private lastRefusedAt: number | undefined;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: AgentConnectRetryOptions, deps: AgentConnectRetryDeps = {}) {
    this.clock = deps.clock ?? Date.now;
    this.sleep = deps.sleep ?? delay;
  }

  /**
   * `attempt` — одна попытка; при отказе она сама освобождает свои ресурсы (соединение), цикл
   * решает только «повторить или сдаться».
   */
  async run<T>(attempt: () => Promise<T>): Promise<T> {
    const firstAttemptAt = this.clock();
    for (let attemptNo = 1; ; attemptNo += 1) {
      try {
        return await attempt();
      } catch (error) {
        const kind = classifySshConnectError(error);
        const now = this.clock();
        if (kind === 'refused') {
          this.lastRefusedAt = now;
        }
        const decision = decideAgentConnectRetry(kind, {
          attempt: attemptNo,
          now,
          firstAttemptAt,
          agentStartedAt: this.options.agentStartedAt,
          lastRefusedAt: this.lastRefusedAt,
        }, this.options.policy);
        if (decision.action === 'fail') {
          throw new Error(describeConnectFailure(decision.reason, this.options, error), { cause: error });
        }
        await this.sleep(decision.delayMs);
      }
    }
    /* c8 ignore start */
    // Цикл выходит только через return или throw, но V8 считает неявный return после него отдельным блоком.
  }
  /* c8 ignore stop */
}

/** Текст отказа подключения: пароль сюда не попадает никогда — только хост, порт и имя пользователя. */
export function describeConnectFailure(
  reason: 'credentials' | 'unreachable' | 'timeout' | 'other',
  options: AgentConnectEndpoint,
  error: unknown
): string {
  const endpoint = `${options.host}:${String(options.port)}`;
  // Попытка отклоняется только объектами Error (события 'error' ssh2, колбэки shell/sftp, закрытая сессия).
  const original = (error as Error).message;
  switch (reason) {
    case 'credentials':
      return `Не удалось подключиться к ${endpoint}: неверный логин или пароль агента конфигуратора для пользователя «${options.user}».`;
    case 'unreachable':
      return `Не удалось подключиться: агент конфигуратора не отвечает на ${endpoint}.`;
    case 'timeout':
      return `Не удалось подключиться: агент конфигуратора на ${endpoint} не ответил вовремя (${original}).`;
    default:
      return `Не удалось подключиться к агенту конфигуратора на ${endpoint}: ${original}`;
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}
