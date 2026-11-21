import type { AgentMessage, AgentMessageType } from '../../domain/agent';
import { isEmptyUnknownAgentMessage } from '../../domain/agent';

export interface AgentCommandHooks {
  readonly onMessage?: (message: AgentMessage) => void;
  readonly onQuestion?: (message: AgentMessage) => Promise<string | undefined>;
}

export interface AgentCommandResult {
  readonly messages: AgentMessage[];
}

export interface AgentExecuteOptions {
  /**
   * Срок ответа для КОРОТКИХ команд (список расширений) — общая защита от неответа: процесс, переставший
   * отвечать, канал не закрывает, поэтому признак — только срок: по его истечении транспорт сбрасывается, а
   * команда отклоняется {@link AgentConnectionLostError} с причиной `no-response`. Долгим командам срок не
   * задаётся: агент не отвечает и на keepalive во время команды (эксперимент 22).
   */
  readonly deadlineMs?: number;
  /**
   * Типы сообщений ВЕРХНЕГО уровня, завершающие ответ этой команды, кроме `success`/`error`/`canceled`.
   * Узко, по команде: при ОДНОМ расширении `properties get` агент шлёт одно `extension-properties` без `success`
   * (ФАКТ Э30–Э31); «любой массив завершает ответ» нельзя — у долгих команд бывают промежуточные `progress`.
   * Риск: если бы агент вслед прислал запоздалый `success`, тот не должен завершить СЛЕДУЮЩУЮ команду — поэтому
   * транспорт перед отправкой команды сбрасывает недочитанный остаток буфера разбора. Целое сообщение, пришедшее
   * после отправки новой команды, отличить от её ответа нельзя (протокол без идентификаторов); в Э30–Э31
   * запоздалого `success` не наблюдалось.
   */
  readonly terminalTypes?: readonly AgentMessageType[];
}

export interface DesignerAgentTransport {
  execute(command: string, hooks?: AgentCommandHooks, options?: AgentExecuteOptions): Promise<AgentCommandResult>;
  reset?(): Promise<void>;
  dispose(): Promise<void>;
  /**
   * Транспорт непригоден для команд (соединение потеряно или выброшено). Фабрика сессий
   * по этому признаку пересоздаёт транспорт вместо повторного использования мёртвого.
   */
  isClosed?(): boolean;
}

export interface DesignerAgentTransportFactory {
  create(sessionKey: string): Promise<DesignerAgentTransport>;
}

export interface ResettableDesignerAgentTransportFactory extends DesignerAgentTransportFactory {
  reset(sessionKey: string): Promise<void>;
}

/**
 * Ошибка выполнения команды агента. Хранит саму команду и финальное сообщение конфигуратора,
 * чтобы верхние слои могли отличить «пустой UnknownError» от обычной ошибки и принять
 * решение о перезапуске процесса конфигуратора.
 */
export class AgentCommandError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly finalMessage?: AgentMessage,
    /** Все сообщения команды: `log`-строки перед `error` объясняют пустой `UnknownError` (Э28). */
    public readonly messages: readonly AgentMessage[] = []
  ) {
    super(message);
    this.name = 'AgentCommandError';
  }
}

export type AgentConnectionLossKind = 'closed' | 'error' | 'no-response';

export interface AgentConnectionLostOptions {
  readonly deadlineMs?: number;
  readonly subject?: string;
}

/** Секунд в сроке для текста E2. */
function deadlineSeconds(deadlineMs: number | undefined): string {
  return deadlineMs === undefined ? '' : ` за ${String(Math.round(deadlineMs / 1000))} с`;
}

/**
 * Связь с агентом потеряна ВО ВРЕМЯ команды. `closed`/`error` — канал оборвался. Это не доказывает падение
 * процесса 1cv8: на стенде сервер сбрасывал SSH-соединения (командное и SFTP) посреди `update-db-cfg`, а агент
 * оставался жив и принимал следующую сессию, — поэтому текст говорит о потере соединения и неизвестном
 * результате, а не об аварии агента. `no-response` — ответа нет за срок короткой команды. Известного триггера
 * неответа нет (ФАКТ Э30–Э31: «зависание» на списке расширений оказалось иной формой ответа), срок — общая защита.
 *
 * Вид потери — `lossKind`, а не `cause`: стандартное `Error.cause` несёт исходную ошибку. `message` транспорта
 * для `closed` начинается фразой «SSH-соединение с агентом закрыто» — на неё опираются журнал и тесты; текст для
 * человека (E1/E2) — {@link operatorText}. Операция, знающая предмет (расширение или основная конфигурация),
 * уточняет текст через {@link withSubject}.
 */
export class AgentConnectionLostError extends Error {
  readonly deadlineMs?: number;
  readonly subject?: string;

  constructor(
    readonly commandVerb: string,
    readonly lossKind: AgentConnectionLossKind,
    readonly detail?: string,
    options: AgentConnectionLostOptions = {}
  ) {
    super('');
    this.name = 'AgentConnectionLostError';
    this.deadlineMs = options.deadlineMs;
    this.subject = options.subject;
    this.message = options.subject === undefined && lossKind !== 'no-response' ? this.transportText() : this.operatorText;
  }

  /** E1 (обрыв) или E2 (нет ответа за срок). Подробность ssh2 (`ECONNRESET` и т. п.) сохраняется в тексте. */
  get operatorText(): string {
    if (this.lossKind === 'no-response') {
      return `Агент конфигуратора не ответил${deadlineSeconds(this.deadlineMs)} на команду «${this.commandVerb}»: ` +
        'процесс 1cv8 агента, вероятно, перестал отвечать. Соединение сброшено; перезапустите агента и повторите.';
    }
    const state = this.subject === undefined ? 'базы' : `${this.subject} в базе`;
    const detail = this.detail === undefined ? '' : ` (${this.detail})`;
    const mutation = MUTATING_AGENT_COMMAND_VERBS.has(this.commandVerb)
      ? ' Команда меняет базу: изменения могли примениться — проверьте их в Конфигураторе; автоматически команда ' +
        'не повторяется.'
      : '';
    return `Соединение с агентом конфигуратора потеряно во время команды «${this.commandVerb}»${detail}. ` +
      `Результат команды неизвестен: проверьте состояние ${state}.${mutation} Если агент не отвечает — ` +
      'перезапустите его (1cv8 /AgentMode).';
  }

  /** Та же потеря связи с предметом операции в тексте: «расширения «X»» или «основной конфигурации». */
  withSubject(subject: string): AgentConnectionLostError {
    return new AgentConnectionLostError(this.commandVerb, this.lossKind, this.detail, { deadlineMs: this.deadlineMs, subject });
  }

  /**
   * `closed` — фраза про закрытие канала без кода: ssh2 при закрытии канала кода не сообщает, а выдуманное
   * число вводило бы в заблуждение; `error` — текст ошибки клиента, без «закрыто»: причиной отказа должна
   * читаться она, а не последующий `close`. Об аварии агента транспорт не судит — обрыв не доказывает её.
   */
  private transportText(): string {
    if (this.lossKind === 'error') {
      return `Ошибка SSH-соединения с агентом во время команды «${this.commandVerb}»: ${String(this.detail)}; ` +
        'результат команды неизвестен.';
    }
    return `SSH-соединение с агентом закрыто во время команды «${this.commandVerb}»; результат команды неизвестен.`;
  }
}

/**
 * Глаголы команд, меняющих базу. Обрыв на них оставляет базу в неизвестном состоянии (на стенде `update-db-cfg`
 * применился, хотя ответ не дошёл), поэтому текст обрыва явно требует проверки в Конфигураторе.
 */
const MUTATING_AGENT_COMMAND_VERBS: ReadonlySet<string> = new Set([
  'config update-db-cfg',
  'config load-cfg',
  'config load-config-from-files',
]);

/** Первые слова команды без аргументов (`config load-cfg`) — в тексты ошибок, без путей и значений. */
export function agentCommandVerb(command: string): string {
  const words: string[] = [];
  for (const word of command.trim().split(/\s+/)) {
    if (word.startsWith('--')) {
      break;
    }
    words.push(word);
  }
  return words.join(' ');
}

/**
 * Текст отказа для человека. Пустой `UnknownError` агент объясняет только предшествующей `log`-строкой
 * (Э28) — берётся последняя непустая; без неё — E10. Потеря связи — E1/E2.
 */
export function describeAgentCommandFailure(error: unknown): string {
  if (error instanceof AgentConnectionLostError) {
    return error.operatorText;
  }
  if (error instanceof AgentCommandError && error.finalMessage && isEmptyAgentErrorText(error.finalMessage)) {
    const logText = [...error.messages]
      .reverse()
      .map((message) => (message.type === 'log' ? message.message?.trim() : undefined))
      .find((text): text is string => Boolean(text));
    return logText ?? `Агент конфигуратора вернул ошибку без описания (UnknownError) на команду ` +
      `«${agentCommandVerb(error.command)}»; подробности — в журнале «1С Редактор».`;
  }
  return error instanceof Error ? error.message : String(error);
}

function isEmptyAgentErrorText(message: AgentMessage): boolean {
  return isEmptyUnknownAgentMessage(message) && !message.message?.trim();
}
