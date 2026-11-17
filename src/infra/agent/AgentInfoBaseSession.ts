import { getAgentMessageText } from '../../domain/agent';
import type { AgentOperationHooks, DesignerAgentInfoBaseSession } from './AgentOperationService';
import {
  AgentCommandError,
  type AgentCommandHooks,
  type AgentCommandResult,
  type DesignerAgentTransport,
  type DesignerAgentTransportFactory,
  type ResettableDesignerAgentTransportFactory,
} from './AgentTransport';

/** Таймеры внедряются, чтобы idle-отключение проверялось без реального времени. */
export interface TimerApi {
  setTimeout(callback: () => void | Promise<void>, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Исполнитель команд агента внутри одной операции: подключение ИБ уже гарантировано сессией. */
export interface AgentCommandExecutor {
  execute(command: string): Promise<AgentCommandResult>;
}

export interface AgentInfoBaseSessionOptions {
  /** 0 и меньше — idle-отключение выключено, база держится до явного release. */
  readonly idleDisconnectMs: number;
  readonly timers: TimerApi;
  /**
   * Источник времени сессии. Сейчас им отмечается момент последней успешной операции
   * (`getLastActivityAt`) — для диагностики «сколько база держится подключённой».
   */
  readonly clock: () => number;
}

/**
 * Реальные таймеры процесса. Колбэк idle-отключения по контракту не отклоняется,
 * поэтому `void` здесь не теряет ошибок.
 */
export const SYSTEM_TIMERS: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(() => { void callback(); }, ms),
  clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

const SESSION_KEY = 'default';
const CONNECT_COMMAND = 'common connect-ib';
const DISCONNECT_COMMAND = 'common disconnect-ib';
const DISCONNECT_MESSAGE = 'Отключение информационной базы от агента конфигуратора.';

/**
 * Жизненный цикл подключения информационной базы к агенту конфигуратора.
 *
 * Подключение ИБ держится МЕЖДУ операциями: цикл «загрузить → обновить → загрузить» платит
 * `connect-ib` один раз. Подключение не переживает закрытие SSH-сессии (замер пилота, план §5b
 * п.1), поэтому SSH тоже живёт между операциями, а любой сброс SSH обязан сбрасывать и
 * состояние «подключено». Все обращения к агенту сериализуются одной очередью: агент
 * однопоточен, а release перед пакетной операцией не должен вклиниться в середину операции.
 */
export class AgentInfoBaseSession implements DesignerAgentInfoBaseSession {
  // Транспорт, на котором выполнен connect-ib. Подключение ИБ привязано к SSH-сессии
  // (не переживает её закрытие, план §5b п.1): если фабрика отдала ДРУГОЙ транспорт (старый
  // потерял соединение), состояние «подключено» неизвестно и connect-ib повторяется.
  private connectedTransport: DesignerAgentTransport | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private pendingRuns = 0;
  private idleHandle: unknown;
  private idleArmed = false;
  // Поколение idle-таймера: колбэк, снятый clearTimeout, но успевший попасть в очередь
  // событий (или вызванный после dispose), по поколению распознаёт, что устарел.
  private idleGeneration = 0;
  private disposed = false;
  private lastActivityAt: number | undefined;

  constructor(
    private readonly transports: DesignerAgentTransportFactory | ResettableDesignerAgentTransportFactory,
    private readonly options: AgentInfoBaseSessionOptions
  ) {}

  isInfoBaseConnected(): boolean {
    return this.connectedTransport !== undefined;
  }

  /** Момент (по внедрённым часам) завершения последней успешной операции. */
  getLastActivityAt(): number | undefined {
    return this.lastActivityAt;
  }

  async run<T>(op: (exec: AgentCommandExecutor) => Promise<T>, hooks?: AgentOperationHooks): Promise<T> {
    // Таймер снимается синхронно: операция уже стоит в очереди, отключать базу под ней нельзя.
    this.cancelIdle();
    this.pendingRuns += 1;
    try {
      return await this.enqueue(() => this.runExclusive(op, hooks));
    } finally {
      this.pendingRuns -= 1;
      if (this.pendingRuns === 0) {
        this.scheduleIdle();
      }
    }
  }

  disconnectInfoBase(hooks?: AgentOperationHooks, options?: { readonly force?: boolean }): Promise<boolean> {
    return this.enqueue(async () => {
      this.cancelIdle();
      if (!this.isInfoBaseConnected() && options?.force !== true) {
        return false;
      }
      hooks?.onMessage?.(DISCONNECT_MESSAGE);
      try {
        const transport = await this.transports.create(SESSION_KEY);
        await transport.execute(DISCONNECT_COMMAND, toCommandHooks(hooks));
      } catch (error) {
        if (!isInfoBaseNotConnectedError(error)) {
          // Агент не ответил на отключение: сбрасываем SSH (это само отпускает базу) и
          // состояние. Ошибка пробрасывается — текущая пакетная операция не стартует, но
          // следующий release уже не упрётся в тот же мёртвый агент и не заблокирует всё.
          await this.resetTransport(hooks);
          throw error;
        }
      }
      this.connectedTransport = undefined;
      return true;
    });
  }

  /** Подключение «про запас» — та же операция, что и обычная, только без команд. */
  async reconnectInfoBase(hooks?: AgentOperationHooks): Promise<void> {
    await this.run(() => Promise.resolve(), hooks);
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.cancelIdle();
    return Promise.resolve();
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    // Хвост очереди никогда не отклоняется (catch ниже), поэтому обработчик ошибки не нужен.
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async runExclusive<T>(op: (exec: AgentCommandExecutor) => Promise<T>, hooks?: AgentOperationHooks): Promise<T> {
    const commandHooks = toCommandHooks(hooks);
    let transport: DesignerAgentTransport;
    try {
      transport = await this.transports.create(SESSION_KEY);
      await this.ensureConnected(transport, commandHooks);
    } catch (error) {
      // База не подключена — отключать нечего; канал сбрасываем, чтобы следующая попытка
      // не ушла в возможно мёртвое соединение.
      await this.resetTransport(hooks);
      throw error;
    }

    try {
      const result = await op({ execute: (command) => transport.execute(command, commandHooks) });
      this.lastActivityAt = this.options.clock();
      return result;
    } catch (error) {
      await this.releaseAfterFailure(transport, commandHooks, hooks);
      throw error;
    }
  }

  private async ensureConnected(transport: DesignerAgentTransport, commandHooks: AgentCommandHooks): Promise<void> {
    if (this.connectedTransport === transport) {
      return;
    }
    commandHooks.onMessage?.({ type: 'log', message: 'Подключение информационной базы к агенту конфигуратора.' });
    try {
      await transport.execute(CONNECT_COMMAND, commandHooks);
    } catch (error) {
      if (!isInfoBaseAlreadyConnectedError(error)) {
        throw error;
      }
    }
    this.connectedTransport = transport;
  }

  /**
   * Консервативный путь после ошибки операции: отпустить базу и сбросить SSH. Сам Н13
   * (команда между `error` и `close` SSH-клиента) закрыт в транспорте — он помечает себя
   * потерянным уже по `error`, а менеджер сессий пересоздаёт такой транспорт с `options set`;
   * сброс здесь гарантирует, что после ЛЮБОЙ ошибки следующая операция начнёт с чистого канала.
   */
  private async releaseAfterFailure(
    transport: DesignerAgentTransport,
    commandHooks: AgentCommandHooks,
    hooks: AgentOperationHooks | undefined
  ): Promise<void> {
    hooks?.onMessage?.(DISCONNECT_MESSAGE);
    try {
      await transport.execute(DISCONNECT_COMMAND, commandHooks);
    } catch (error) {
      if (!isInfoBaseNotConnectedError(error)) {
        hooks?.onMessage?.(`Не удалось отключить информационную базу после ошибки операции: ${describeError(error)}`);
      }
    }
    await this.resetTransport(hooks);
  }

  private async resetTransport(hooks?: AgentOperationHooks): Promise<void> {
    this.connectedTransport = undefined;
    if (!isResettableTransportFactory(this.transports)) {
      return;
    }
    try {
      await this.transports.reset(SESSION_KEY);
    } catch (error) {
      hooks?.onMessage?.(`Не удалось сбросить SSH-сессию агента: ${describeError(error)}`);
    }
  }

  private scheduleIdle(): void {
    if (this.options.idleDisconnectMs <= 0 || this.disposed || !this.isInfoBaseConnected()) {
      return;
    }
    this.cancelIdle();
    const generation = this.idleGeneration;
    this.idleHandle = this.options.timers.setTimeout(() => this.onIdle(generation), this.options.idleDisconnectMs);
    this.idleArmed = true;
  }

  private cancelIdle(): void {
    this.idleGeneration += 1;
    if (!this.idleArmed) {
      return;
    }
    this.idleArmed = false;
    this.options.timers.clearTimeout(this.idleHandle);
    this.idleHandle = undefined;
  }

  /**
   * Срабатывание idle-таймера. Ошибка наружу не уходит (некому её показать). Сброс SSH и
   * состояния при отказе делает сам `disconnectInfoBase` внутри своей задачи очереди: сброс
   * отпускает базу (подключение не переживает закрытие сессии), а следующая операция начнёт
   * с `connect-ib` на свежем канале.
   */
  private async onIdle(generation: number): Promise<void> {
    // dispose и любое снятие таймера сдвигают поколение — отдельная проверка disposed не нужна.
    if (generation !== this.idleGeneration) {
      return;
    }
    this.idleArmed = false;
    this.idleHandle = undefined;
    await this.disconnectInfoBase().catch(() => undefined);
  }
}

function toCommandHooks(hooks?: AgentOperationHooks): AgentCommandHooks {
  return {
    onQuestion: hooks?.onQuestion,
    onMessage: (message) => {
      const text = getAgentMessageText(message);
      if (text) {
        hooks?.onMessage?.(text);
      }
    },
  };
}

function isResettableTransportFactory(
  factory: DesignerAgentTransportFactory | ResettableDesignerAgentTransportFactory
): factory is ResettableDesignerAgentTransportFactory {
  return typeof (factory as Partial<ResettableDesignerAgentTransportFactory>).reset === 'function';
}

/** Текст ошибки для журнала/уведомления: транспорт может отклонить промис не-Error значением. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Машинный код ответа агента `{"type":"error","error-type":…}`, если он есть. */
function agentErrorType(error: unknown): string | undefined {
  return error instanceof AgentCommandError ? error.finalMessage?.['error-type'] : undefined;
}

/**
 * «Уже подключено». Машинный код агента авторитетен; текст — только фолбэк для ответа без
 * `error-type` (транспорт, не разобравший JSON, или иная версия платформы).
 */
function isInfoBaseAlreadyConnectedError(error: unknown): boolean {
  const errorType = agentErrorType(error);
  if (errorType !== undefined) {
    return errorType === 'DesignerAlreadyConnectedToInfoBase';
  }
  return isInfoBaseAlreadyConnectedMessage(describeError(error));
}

function isInfoBaseNotConnectedError(error: unknown): boolean {
  const errorType = agentErrorType(error);
  if (errorType !== undefined) {
    return errorType === 'DesignerNotConnectedToInfoBase';
  }
  return isInfoBaseNotConnectedMessage(describeError(error));
}

function normalizeAgentErrorMessage(message: string): string {
  return message.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isInfoBaseAlreadyConnectedMessage(message: string): boolean {
  const normalized = normalizeAgentErrorMessage(message);
  return /designeralreadyconnectedtoinfobase/i.test(message) ||
    normalized.includes('already connected') ||
    normalized.includes('уже установлено') ||
    /соединение.*информационн.*баз.*уже.*установлен/.test(normalized) ||
    /подключ.*уже.*установлен/.test(normalized);
}

export function isInfoBaseNotConnectedMessage(message: string): boolean {
  const normalized = normalizeAgentErrorMessage(message);
  return normalized.includes('not connected') ||
    normalized.includes('не подключ') ||
    normalized.includes('не установлено') ||
    /соединение.*информационн.*баз.*не.*установлен/.test(normalized);
}
