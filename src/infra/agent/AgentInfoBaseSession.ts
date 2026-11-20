import { getAgentMessageText } from '../../domain/agent';
import {
  DEFAULT_INFO_BASE_LOCK_RETRY,
  decideInfoBaseLockRetry,
  type InfoBaseLockRetryOptions,
} from '../../domain/agent/InfoBaseLockRetryPolicy';
import type { AgentOperationHooks, DesignerAgentInfoBaseSession } from './AgentOperationService';
import {
  AgentCommandError,
  type AgentCommandHooks,
  type AgentCommandResult,
  type AgentExecuteOptions,
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
  execute(command: string, options?: AgentExecuteOptions): Promise<AgentCommandResult>;
  /**
   * `disconnect-ib` (ответ «не подключено» проглатывается) и `connect-ib` с повтором блокировки — на ТОМ ЖЕ
   * транспорте. Правило Э28: после сбоя загрузки/выгрузки агент мог остаться в плохом состоянии, а перед
   * повторной загрузкой в имя нужно переподключение ИБ.
   */
  reconnectInfoBase(): Promise<void>;
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
  /** Повтор `connect-ib`, пока ИБ держит другой Конфигуратор; по умолчанию — DEFAULT_INFO_BASE_LOCK_RETRY. */
  readonly infoBaseLockRetry?: InfoBaseLockRetryOptions;
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
export const AGENT_CONNECT_IB_COMMAND = 'common connect-ib';
export const AGENT_DISCONNECT_IB_COMMAND = 'common disconnect-ib';
const INFO_BASE_LOCK_TEXT = 'ошибка блокировки информационной базы для конфигурирования';
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
        await transport.execute(AGENT_DISCONNECT_IB_COMMAND, toCommandHooks(hooks));
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
      await this.ensureConnected(transport, commandHooks, hooks);
    } catch (error) {
      // База не подключена — отключать нечего; канал сбрасываем, чтобы следующая попытка
      // не ушла в возможно мёртвое соединение.
      await this.resetTransport(hooks);
      throw error;
    }

    try {
      const result = await op({
        execute: (command, options) => transport.execute(command, commandHooks, options),
        reconnectInfoBase: () => this.reconnectOnTransport(transport, commandHooks, hooks),
      });
      this.lastActivityAt = this.options.clock();
      return result;
    } catch (error) {
      await this.releaseAfterFailure(transport, commandHooks, hooks);
      throw error;
    }
  }

  private async reconnectOnTransport(
    transport: DesignerAgentTransport,
    commandHooks: AgentCommandHooks,
    hooks: AgentOperationHooks | undefined
  ): Promise<void> {
    this.connectedTransport = undefined;
    hooks?.onMessage?.(DISCONNECT_MESSAGE);
    try {
      await transport.execute(AGENT_DISCONNECT_IB_COMMAND, commandHooks);
    } catch (error) {
      if (!isInfoBaseNotConnectedError(error)) {
        throw error;
      }
    }
    await this.ensureConnected(transport, commandHooks, hooks);
  }

  private async ensureConnected(
    transport: DesignerAgentTransport,
    commandHooks: AgentCommandHooks,
    hooks: AgentOperationHooks | undefined
  ): Promise<void> {
    if (this.connectedTransport === transport) {
      return;
    }
    commandHooks.onMessage?.({ type: 'log', message: 'Подключение информационной базы к агенту конфигуратора.' });
    const retry = this.options.infoBaseLockRetry ?? DEFAULT_INFO_BASE_LOCK_RETRY;
    let failures = 0;
    let firstFailureAt = 0;
    // Цикл идёт внутри задачи очереди: параллельные операции ждут его, а не вклиниваются между попытками.
    for (;;) {
      try {
        await transport.execute(AGENT_CONNECT_IB_COMMAND, commandHooks);
        break;
      } catch (error) {
        if (isInfoBaseAlreadyConnectedError(error)) {
          break;
        }
        if (!isInfoBaseLockedByDesignerError(error)) {
          throw error;
        }
        failures += 1;
        if (failures === 1) {
          firstFailureAt = this.options.clock();
        }
        // Отмена — без ожидания и с исходной ошибкой агента: пользователь сам прервал операцию.
        if (hooks?.cancellation?.isCancellationRequested === true) {
          throw error;
        }
        const elapsedMs = this.options.clock() - firstFailureAt;
        const decision = decideInfoBaseLockRetry({ failures, elapsedMs }, retry);
        if (decision.action === 'fail') {
          throw new AgentInfoBaseLockedError(error, elapsedMs);
        }
        if (failures === 1) {
          hooks?.onMessage?.(
            `База занята другим Конфигуратором — повторяю подключение до ${String(Math.round(retry.windowMs / 1000))} с…`
          );
        }
        await new Promise<void>((resolve) => { this.options.timers.setTimeout(resolve, decision.delayMs); });
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
      await transport.execute(AGENT_DISCONNECT_IB_COMMAND, commandHooks);
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
export function isInfoBaseAlreadyConnectedError(error: unknown): boolean {
  const errorType = agentErrorType(error);
  if (errorType !== undefined) {
    return errorType === 'DesignerAlreadyConnectedToInfoBase';
  }
  return isInfoBaseAlreadyConnectedMessage(describeError(error));
}

/**
 * ИБ заблокирована другим Конфигуратором (`DesignerAlreadyStarted`, эксперимент 13). Машинный код
 * авторитетен; текст — фолбэк только для ответа без `error-type`.
 */
export function isInfoBaseLockedByDesignerError(error: unknown): boolean {
  const errorType = agentErrorType(error);
  if (errorType !== undefined) {
    return errorType === 'DesignerAlreadyStarted';
  }
  return normalizeAgentErrorMessage(describeError(error)).includes(INFO_BASE_LOCK_TEXT);
}

/**
 * Окончательный отказ `connect-ib` по окну повтора. Подкласс AgentCommandError — журнал операции
 * по-прежнему пишет команду, а `finalMessage` сохраняет ответ агента для диагностики.
 */
export class AgentInfoBaseLockedError extends AgentCommandError {
  constructor(source: unknown, readonly waitedMs: number) {
    super(
      'Информационная база занята другим Конфигуратором (интерактивным, пакетной операцией или 1cv8, запущенным ' +
      `стартером 1cestart.exe): агент не смог подключить её в течение ${String(Math.round(waitedMs / 1000))} с. ` +
      `Закройте Конфигуратор этой базы на сервере и повторите. Ответ агента: ${describeError(source)}`,
      AGENT_CONNECT_IB_COMMAND,
      source instanceof AgentCommandError ? source.finalMessage : undefined
    );
    this.name = 'AgentInfoBaseLockedError';
  }
}

export function isInfoBaseNotConnectedError(error: unknown): boolean {
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
