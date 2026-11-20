/**
 * Общие фейки Э4 (жизненный цикл подключения ИБ к агенту конфигуратора).
 *
 * Подменяется только внешний агент 1С (SSH-транспорт): настоящий агент в CI недоступен.
 * Фабрика повторяет контракт `DesignerAgentSessionManager`: после `reset()` следующий
 * `create()` отдаёт НОВЫЙ транспорт — на этом держатся проверки «следующая команда
 * переподключается, а не уходит в мёртвый канал».
 * Таймеры — детерминированные: срабатывание только явным `fireAll()`, реального времени нет.
 */
import type { AgentMessage } from '../../../domain/agent';
import {
  AgentCommandError,
  type AgentCommandHooks,
  type AgentCommandResult,
  type DesignerAgentTransport,
  type ResettableDesignerAgentTransportFactory,
} from '../../../infra/agent';

export type TransportBehavior = (command: string, hooks?: AgentCommandHooks) => Error | Promise<void> | undefined;

/** Ответ агента на команду: сообщения результата (например `success` с `body` списка расширений). */
export type TransportResponder = (command: string) => AgentMessage[] | undefined;

export class ScriptedTransport implements DesignerAgentTransport {
  readonly commands: string[] = [];
  lastHooks: AgentCommandHooks | undefined;

  constructor(
    private readonly log: string[],
    private readonly behavior?: TransportBehavior,
    private readonly responder?: TransportResponder
  ) {}

  execute(command: string, hooks?: AgentCommandHooks): Promise<AgentCommandResult> {
    this.commands.push(command);
    this.log.push(command);
    this.lastHooks = hooks;
    const outcome = this.behavior?.(command, hooks);
    if (outcome instanceof Error) {
      return Promise.reject(outcome);
    }
    hooks?.onMessage?.({ type: 'log', message: `выполнено: ${command}` });
    const messages = this.responder?.(command) ?? [];
    if (outcome) {
      return outcome.then(() => ({ messages }));
    }
    return Promise.resolve({ messages });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

export class ScriptedFactory implements ResettableDesignerAgentTransportFactory {
  /** Все команды всех транспортов в порядке вызова. */
  readonly log: string[] = [];
  readonly transports: ScriptedTransport[] = [];
  resetCount = 0;
  resetError: Error | undefined;
  private current: ScriptedTransport | undefined;

  constructor(private readonly behavior?: TransportBehavior, private readonly responder?: TransportResponder) {}

  get createCount(): number {
    return this.transports.length;
  }

  count(command: string): number {
    return this.log.filter((item) => item === command).length;
  }

  create(): Promise<DesignerAgentTransport> {
    if (!this.current) {
      this.current = new ScriptedTransport(this.log, this.behavior, this.responder);
      this.transports.push(this.current);
    }
    return Promise.resolve(this.current);
  }

  reset(): Promise<void> {
    this.resetCount += 1;
    this.current = undefined;
    return this.resetError ? Promise.reject(this.resetError) : Promise.resolve();
  }
}

/** Ответ агента `{type:"error","error-type":…}` с текстом, который НЕ распознаётся регулярками. */
export function agentError(errorType: string, message = 'непрозрачный текст 0x1'): AgentCommandError {
  return new AgentCommandError(message, 'cmd', { type: 'error', 'error-type': errorType, message });
}

export type FakeTimerCallback = () => void | Promise<void>;

export class FakeTimers {
  readonly pending = new Map<number, { callback: FakeTimerCallback; ms: number }>();
  readonly setCalls: number[] = [];
  clearCalls = 0;
  private nextId = 1;

  setTimeout(callback: FakeTimerCallback, ms: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.setCalls.push(ms);
    this.pending.set(id, { callback, ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.clearCalls += 1;
    this.pending.delete(handle as number);
  }

  /** Срабатывание всех ожидающих таймеров; ждёт завершения возвращённых колбэками промисов. */
  async fireAll(): Promise<void> {
    const items = [...this.pending.values()];
    this.pending.clear();
    for (const item of items) {
      await item.callback();
    }
  }

  /** Колбэк единственного ожидающего таймера без его снятия (для проверки «устаревшего» срабатывания). */
  onlyCallback(): FakeTimerCallback {
    const items = [...this.pending.values()];
    if (items.length !== 1) {
      throw new Error(`ожидался ровно один таймер, ожидает: ${String(items.length)}`);
    }
    return items[0].callback;
  }
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
