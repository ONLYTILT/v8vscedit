/**
 * Единый post-mutation шлюз и общие формат-хелперы MCP-инструментов.
 *
 * Выделено из `V8McpServer` при декомпозиции God-класса `registerTools`:
 * все доменные модули регистрации (`registration/*`) используют ОДИН и тот же
 * gate, а не собственные копии проверок блокировки и пост-мутационного пути.
 *
 * `McpMutationGate` держит ссылку на `services` и повторяет поведение, ранее
 * жившее в приватных методах `V8McpServer` (`afterMutation`,
 * `afterMutationIfSucceeded`, `assertMetadataEditable`, `assertNodeEditable`,
 * `ok`/`wrap`/`wrapAsync`/`toolError`) — байт-в-байт по логике.
 */
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { McpOperationOutcomeRegistry, type OperationOutcome } from '../../../infra/mcp/McpOperationOutcome';
import {
  MCP_PULSE_INTERVAL_MS,
  buildPulseNotification,
  formatPulseText,
  realPulseScheduler,
  runWithRequestPulse,
  type PulseScheduler,
} from '../../../infra/mcp/McpRequestPulse';
import type { OperationStage } from '../../../infra/progress/OperationStageFeed';
import { SupportMode } from '../../../infra/support/SupportInfoService';
import type { CommandServices } from '../../commands/_shared';
import { operationStageFeed } from '../../commands/ext/configurationOperationStatus';
import type { MetadataNode } from '../../tree/TreeNode';

type McpCommandServices = Omit<CommandServices, 'aiMcpViewProvider'>;

/** Часть `extra` обработчика инструмента, нужная пульсу: токен прогресса, отправка в поток вызова, отмена. */
export type McpToolExtra = Pick<RequestHandlerExtra<ServerRequest, ServerNotification>, '_meta' | 'sendNotification' | 'signal'>;

export interface McpPulseDeps {
  readonly scheduler: PulseScheduler;
  readonly intervalMs: number;
  readonly readStage: () => OperationStage | undefined;
  /**
   * Пульс в GET-поток сессии на время долгого вызова: клиент рвёт молчащий GET-поток, и POST вызова
   * гибнет вместе с ним (журнал Claude Code). Без GET-потока SDK с eventStore не отказывает, а молча
   * копит события в `_GET_stream` (поток не завершается, под TTL не попадает) — их сдерживает только
   * лимит событий потока store; отказ транспорта при этом всё равно возможен и глотается.
   */
  readonly sendSessionPulse?: (text: string) => Promise<void>;
}

const DEFAULT_PULSE_DEPS: McpPulseDeps = {
  scheduler: realPulseScheduler,
  intervalMs: MCP_PULSE_INTERVAL_MS,
  readStage: () => operationStageFeed.current(),
};

const ABORTED_SUMMARY = 'прервано клиентом';

/**
 * Общий шлюз мутаций и формат-хелперы, разделяемые всеми доменными модулями
 * регистрации MCP-инструментов.
 */
export class McpMutationGate {
  /**
   * `outcomes` — реестр исходов СЕРВЕРА (переживает сессию: обрыв может её закрыть, а исход нужен
   * новому клиенту); без него шлюз заводит собственный.
   */
  constructor(
    private readonly services: McpCommandServices,
    private readonly pulse: McpPulseDeps = DEFAULT_PULSE_DEPS,
    private readonly outcomes: McpOperationOutcomeRegistry = new McpOperationOutcomeRegistry()
  ) {}

  /** Исход последней долгой операции (`lastOperation` статуса). */
  lastOperation(): OperationOutcome | undefined {
    return this.outcomes.last();
  }

  ok(data: unknown): CallToolResult {
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  }

  wrap(fn: () => unknown): CallToolResult {
    try {
      return this.ok(fn());
    } catch (error) {
      return this.toolError(error);
    }
  }

  async wrapAsync(fn: () => Promise<unknown>): Promise<CallToolResult> {
    try {
      return this.ok(await fn());
    } catch (error) {
      return this.toolError(error);
    }
  }

  /**
   * Обёртка долгого инструмента: `wrapAsync` + пульс в поток вызова (и GET-поток сессии) + исход в
   * `lastOperation`. Без `extra` (прямой вызов обработчика) — ровно `wrapAsync`. Тостов нет (запрет №18):
   * обёртка работает и под замком операции.
   */
  async wrapLongRunning(toolName: string, extra: McpToolExtra | undefined, fn: () => Promise<unknown>): Promise<CallToolResult> {
    if (!extra) {
      return this.wrapAsync(fn);
    }
    const startedAt = Date.now();
    const sendSessionPulse = this.pulse.sendSessionPulse;
    let logged = false;
    let value: unknown;
    let result: CallToolResult | undefined;
    try {
      result = await this.wrapAsync(async () => {
        value = await runWithRequestPulse({
          scheduler: this.pulse.scheduler,
          intervalMs: this.pulse.intervalMs,
          readStage: this.pulse.readStage,
          signal: extra.signal,
          send: async (tick) => {
            // Отказ сессионного пульса (закрытый транспорт) глотается здесь: он не должен ни мешать
            // пульсу вызова, ни писать журнал.
            const session = sendSessionPulse
              ? Promise.resolve().then(() => sendSessionPulse(formatPulseText(toolName, tick))).catch(() => undefined)
              : undefined;
            await Promise.all([
              extra.sendNotification(buildPulseNotification(toolName, tick, extra._meta?.progressToken)),
              session,
            ]);
          },
          onSendError: (error) => {
            // Один раз за вызов: при закрытом потоке отказ повторялся бы каждые 20 с.
            if (logged) {
              return;
            }
            logged = true;
            const message = error instanceof Error ? error.message : String(error);
            appendToOptionalLog(this.services.outputChannel, `[mcp][pulse] ${toolName}: ${message}`);
          },
        }, fn);
        return value;
      });
      return result;
    } finally {
      this.outcomes.record({
        tool: toolName,
        startedAt,
        finishedAt: Date.now(),
        ...describeOutcome(extra.signal.aborted, result, value),
      });
    }
  }

  toolError(error: unknown): CallToolResult {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{ type: 'text', text: message }],
    };
  }

  /**
   * Перед мутацией существующего объекта повторяет проверки UI: объект на
   * поддержке без права редактирования (`SupportMode.Locked`) или не захвачен
   * в подключённом хранилище конфигурации блокируется. Защищает .cf-объекты;
   * для объектов вне поддержки/хранилища обе проверки возвращают «разрешено».
   *
   * `objectXmlPath` — XML-файл объекта-владельца (для дочерних элементов это
   * `metaContext.ownerObjectXmlPath`), как и в `RemoveMetadataCommand` /
   * `PropertiesViewController`.
   */
  assertMetadataEditable(objectXmlPath: string | undefined): void {
    if (!objectXmlPath) {
      throw new Error('Не удалось определить XML-файл объекта для проверки блокировки изменения.');
    }
    if (this.services.supportService?.getSupportMode(objectXmlPath) === SupportMode.Locked) {
      throw new Error('Объект защищён от изменения: находится на поддержке с запретом редактирования.');
    }
    if (this.services.repositoryService.isEditRestricted(objectXmlPath)) {
      throw new Error('Объект защищён от изменения: не захвачен в хранилище конфигурации.');
    }
  }

  /**
   * Резолвит путь объекта-владельца у узла дерева так же, как UI
   * (`metaContext.ownerObjectXmlPath ?? xmlPath`) и проверяет блокировку.
   */
  assertNodeEditable(node: MetadataNode): void {
    this.assertMetadataEditable(node.metaContext?.ownerObjectXmlPath ?? node.xmlPath);
  }

  afterMutation(filePaths: readonly string[]): void {
    if (filePaths.length === 0) {
      return;
    }
    this.services.suppressConfigurationReloadForFiles([...filePaths]);
    this.services.markChangedConfigurationByFiles([...filePaths]);
    // refreshCacheForFiles сам эмитит onDidChangeTreeData (точечно для изменённых
    // узлов или полным refresh внутри). Дополнительный refresh() дублировал бы
    // работу — десятки тысяч new MetadataNode на больших конфигурациях. Делаем
    // его только если refreshCacheForFiles ничего не обновил (нет совпавших
    // конфигураций — например, файлы вне дерева).
    const refreshed = this.services.treeProvider.refreshCacheForFiles([...filePaths]);
    if (!refreshed) {
      this.services.treeProvider.refresh();
    }
    this.services.refreshActionsView();
  }

  /**
   * Единый guarded-шлюз post-mutation (Волна 5b, M8). Гейт по факту успеха
   * мутации: если результат помечен неуспешным (`succeeded === false`),
   * конфигурация НЕ помечается изменённой и дерево НЕ рефрешится — иначе при
   * частичном провале UI зря считал бы конфигурацию грязной. Формы результата,
   * не несущие явного `success` (сервис сигналит провал исключением внутри
   * `wrap`/`wrapAsync`), проходят с `succeeded=true`, а фактический гейт для них
   * даёт пустой список изменённых файлов (см. `afterMutation`).
   */
  afterMutationIfSucceeded(changedFiles: readonly string[] | undefined, succeeded = true): void {
    if (!succeeded) {
      return;
    }
    const files = changedFiles ?? [];
    if (files.length === 0) {
      return;
    }
    this.afterMutation([...files]);
  }
}

/**
 * Краткий исход для `lastOperation`: первая строка текста ошибки либо компактный JSON результата
 * (обрезку до предела делает реестр). Отмена клиентом — ошибка для агента, но итог самой операции
 * (она шла под замком до конца) дописывается: ради него `lastOperation` и существует.
 */
function describeOutcome(
  aborted: boolean,
  result: CallToolResult | undefined,
  value: unknown
): Pick<OperationOutcome, 'isError' | 'summary'> {
  const failed = result?.isError === true;
  const first = result?.content[0];
  // `ok(undefined)` даёт text: undefined (JSON.stringify), а исключение отсюда, из finally обёртки,
  // подменило бы результат вызова, поэтому проверяется тип строки, а не только вид содержимого.
  const errorLine = first?.type === 'text' && typeof first.text === 'string' ? first.text.split(/\r?\n/, 1)[0] : '';
  const done = failed ? `ошибка: ${errorLine}` : summarizeValue(value);
  if (aborted) {
    return { isError: true, summary: `${ABORTED_SUMMARY}; итог операции — ${done}` };
  }
  return failed ? { isError: true, summary: errorLine } : { isError: false, summary: done };
}

function summarizeValue(value: unknown): string {
  // Для undefined (инструмент без результата) JSON.stringify вернул бы undefined, хотя тип обещает string.
  return value === undefined ? 'выполнено' : JSON.stringify(value);
}

/**
 * Журнал может отсутствовать у урезанных наборов сервисов (тесты, служебные шлюзы): отказ пульса не
 * должен превращаться в отказ вызова.
 */
function appendToOptionalLog(channel: { appendLine(line: string): void } | undefined, line: string): void {
  channel?.appendLine(line);
}
