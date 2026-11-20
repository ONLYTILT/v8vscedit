/**
 * Хранилище событий MCP-сессии — основа возобновляемости SSE (`Last-Event-ID`).
 *
 * Без `eventStore` транспорт SDK не пишет priming-событие, и клиент после обрыва POST-потока не
 * переподключается: ответ долгого вызова теряется («response presumed lost»). Пример SDK
 * (`InMemoryEventStore`) — без TTL и лимитов и ломается на `_GET_stream`, поэтому свой store.
 *
 * Сознательно НЕ реализован необязательный `getStreamIdForEventId`: устаревшая запись от
 * оборванного replay-потока даёт `409 Conflict` при втором переподключении (SDK 1.29). Без метода
 * SDK берёт `streamId`, возвращённый `replayEventsAfter`.
 *
 * Очистка ленивая (на `storeEvent`/`replayEventsAfter`), без таймеров: хранилище не держит процесс и
 * не требует остановки. Экземпляр — на сессию, `clear()` — из `transport.onclose`.
 */
import type { EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** Интервал переподключения клиента (`retry:` priming): окно потери ответа SDK ≈ этому значению. */
export const MCP_SSE_RETRY_INTERVAL_MS = 1_000;

export interface McpEventStoreLimits {
  maxEventsPerStream: number;
  maxStreams: number;
  maxBytes: number;
  completedStreamTtlMs: number;
}

export const DEFAULT_MCP_EVENT_STORE_LIMITS: McpEventStoreLimits = {
  maxEventsPerStream: 1000,
  maxStreams: 64,
  maxBytes: 16 * 1024 * 1024,
  completedStreamTtlMs: 15 * 60_000,
};

export function formatEventId(streamId: string, seq: number): string {
  return `${streamId}:${String(seq)}`;
}

/** Разделитель — ПОСЛЕДНЕЕ двоеточие: id потока SDK может содержать «:», seq — нет. */
export function parseEventId(eventId: string): { streamId: string; seq: number } | undefined {
  const separator = eventId.lastIndexOf(':');
  if (separator <= 0) {
    return undefined;
  }
  const rawSeq = eventId.slice(separator + 1);
  if (!/^\d+$/.test(rawSeq)) {
    return undefined;
  }
  return { streamId: eventId.slice(0, separator), seq: Number(rawSeq) };
}

interface StoredEvent {
  readonly seq: number;
  readonly message: JSONRPCMessage;
  readonly size: number;
  readonly isResponse: boolean;
}

interface StreamState {
  readonly id: string;
  readonly events: StoredEvent[];
  /** Счётчик активности, а не время: порядок вытеснения не зависит от разрешения часов. */
  activity: number;
  completedAt?: number;
}

function isJsonRpcMessage(message: unknown): boolean {
  return typeof message === 'object' && message !== null && (message as { jsonrpc?: unknown }).jsonrpc === '2.0';
}

/** Ответ JSON-RPC завершает поток вызова: после него в поток ничего не придёт. */
function isJsonRpcResponse(message: JSONRPCMessage): boolean {
  return 'id' in message && ('result' in message || 'error' in message) && !('method' in message);
}

export class McpSessionEventStore implements EventStore {
  private readonly streams = new Map<string, StreamState>();
  private seq = 0;
  private activityCounter = 0;
  private bytes = 0;

  constructor(
    private readonly limits: McpEventStoreLimits = DEFAULT_MCP_EVENT_STORE_LIMITS,
    private readonly now: () => number = Date.now
  ) {}

  storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    this.pruneExpired();
    let stream = this.streams.get(streamId);
    if (!stream) {
      this.evictStreamsForNew();
      stream = { id: streamId, events: [], activity: 0 };
      this.streams.set(streamId, stream);
    }
    this.seq += 1;
    const event: StoredEvent = {
      seq: this.seq,
      message,
      size: JSON.stringify(message).length,
      isResponse: isJsonRpcResponse(message),
    };
    stream.events.push(event);
    this.bytes += event.size;
    stream.activity = ++this.activityCounter;
    if (event.isResponse) {
      stream.completedAt = this.now();
    }
    this.enforceEventsPerStream(stream, event);
    this.enforceBytes(stream, event);
    return Promise.resolve(formatEventId(streamId, event.seq));
  }

  async replayEventsAfter(
    lastEventId: string,
    handler: { send(eventId: string, message: JSONRPCMessage): Promise<void> }
  ): Promise<string> {
    // Очистка до поиска: просроченный поток должен отвечать как неизвестный.
    this.pruneExpired();
    const parsed = parseEventId(lastEventId);
    if (!parsed) {
      throw new Error(`Некорректный идентификатор события: ${lastEventId}`);
    }
    const stream = this.streams.get(parsed.streamId);
    if (!stream) {
      throw new Error(`Поток событий не найден: ${parsed.streamId}`);
    }
    stream.activity = ++this.activityCounter;
    // Копия: отправка асинхронна, а за это время store может вытеснить события потока.
    for (const event of [...stream.events]) {
      // Priming SDK хранится как «{}» — клиенту он не нужен и ломал бы разбор.
      if (event.seq > parsed.seq && isJsonRpcMessage(event.message)) {
        await handler.send(formatEventId(stream.id, event.seq), event.message);
      }
    }
    return stream.id;
  }

  clear(): void {
    this.streams.clear();
    this.bytes = 0;
  }

  stats(): { streams: number; events: number; bytes: number } {
    let events = 0;
    for (const stream of this.streams.values()) {
      events += stream.events.length;
    }
    return { streams: this.streams.size, events, bytes: this.bytes };
  }

  /** Завершённые потоки живут TTL с момента ответа; открытые по TTL не истекают — вызов ещё идёт. */
  private pruneExpired(): void {
    const now = this.now();
    for (const stream of [...this.streams.values()]) {
      if (stream.completedAt !== undefined && now - stream.completedAt > this.limits.completedStreamTtlMs) {
        this.removeStream(stream);
      }
    }
  }

  private evictStreamsForNew(): void {
    while (this.streams.size >= this.limits.maxStreams) {
      const victim = this.oldestStream(undefined, true) ?? this.oldestStream(undefined, false);
      /* c8 ignore next 3 -- защитная ветка: при size >= maxStreams >= 1 кандидат есть всегда */
      if (!victim) {
        return;
      }
      this.removeStream(victim);
    }
  }

  /** Сверх лимита — старейшее не-ответное событие потока; ответ не вытесняется никогда (его ждёт клиент). */
  private enforceEventsPerStream(stream: StreamState, fresh: StoredEvent): void {
    while (stream.events.length > this.limits.maxEventsPerStream) {
      const index = stream.events.findIndex((event) => !event.isResponse && event !== fresh);
      if (index < 0) {
        return;
      }
      this.bytes -= stream.events[index].size;
      stream.events.splice(index, 1);
    }
  }

  /**
   * Сначала целиком завершённые потоки (старые первыми), затем старейшие не-ответы открытых.
   * Только что записанное событие не вытесняется: одиночное сообщение больше лимита хранится.
   */
  private enforceBytes(current: StreamState, fresh: StoredEvent): void {
    while (this.bytes > this.limits.maxBytes) {
      const completed = this.oldestStream(current, true);
      if (completed) {
        this.removeStream(completed);
        continue;
      }
      const victim = this.oldestNonResponse(fresh);
      if (!victim) {
        return;
      }
      this.bytes -= victim.stream.events[victim.index].size;
      victim.stream.events.splice(victim.index, 1);
    }
  }

  private oldestStream(exclude: StreamState | undefined, completedOnly: boolean): StreamState | undefined {
    let best: StreamState | undefined;
    for (const stream of this.streams.values()) {
      if (stream === exclude || (completedOnly && stream.completedAt === undefined)) {
        continue;
      }
      if (!best || stream.activity < best.activity) {
        best = stream;
      }
    }
    return best;
  }

  private oldestNonResponse(fresh: StoredEvent): { stream: StreamState; index: number } | undefined {
    let best: { stream: StreamState; index: number; seq: number } | undefined;
    for (const stream of this.streams.values()) {
      const index = stream.events.findIndex((event) => !event.isResponse && event !== fresh);
      if (index >= 0 && (!best || stream.events[index].seq < best.seq)) {
        best = { stream, index, seq: stream.events[index].seq };
      }
    }
    return best;
  }

  private removeStream(stream: StreamState): void {
    for (const event of stream.events) {
      this.bytes -= event.size;
    }
    this.streams.delete(stream.id);
  }
}
