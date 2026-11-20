/**
 * Сквозная проверка возобновляемости долгого вызова по РЕАЛЬНОМУ HTTP (план mcp-long-running, раздел 4,
 * пункт 10): клиент SDK (`StreamableHTTPClientTransport`) против `StreamableHTTPServerTransport` с
 * продакшн-хранилищем `McpSessionEventStore` (`retryInterval: 10`) и продакшн `wrapLongRunning`.
 *
 * Обрыв имитируется так, как его описывает журнал клиента: обёртка `fetch` рвёт ТЕЛО ответа на POST
 * `tools/call` ошибкой `DOMException('The operation timed out.', 'TimeoutError')`. Тест вызывает обрыв
 * только после того, как клиент ПОЛУЧИЛ пульс (событие), и освобождает работу инструмента только после
 * того, как переподключение (GET с `Last-Event-ID`) получило ответ сервера: иначе сработало бы известное
 * окно потери ответа SDK. Время пульса — ручной планировщик; ожидания — promise, не тайминги.
 */
import * as assert from 'assert';
import * as http from 'http';
import { randomUUID } from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { ManualScheduler, deferred, type Deferred } from './support/manualScheduler';
import { McpOperationOutcomeRegistry, type OperationOutcome } from '../../infra/mcp/McpOperationOutcome';
import { MCP_SSE_RETRY_INTERVAL_MS, McpSessionEventStore, parseEventId } from '../../infra/mcp/McpSessionEventStore';
import { McpMutationGate, type McpToolExtra } from '../../ui/mcp/registration/McpMutationGate';

const HOST = '127.0.0.1';
const INTERVAL = 20_000;
const PULSE_20S = 'slow: выполняется 20 с';

/** Тело ответа POST, которое тест может оборвать «как таймаут клиента» в нужный момент. */
class FlakyNetwork {
  /** Резолвится, когда переподключение (GET с `Last-Event-ID`) получило ответ сервера. */
  readonly reconnected = deferred<{ lastEventId: string }>();
  private cutBody: (() => void) | undefined;

  readonly fetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const method = init?.method ?? 'GET';
    const lastEventId = new Headers(init?.headers).get('last-event-id');
    if (method === 'GET' && lastEventId) {
      this.reconnected.resolve({ lastEventId });
    }
    if (method === 'POST' && typeof init?.body === 'string' && init.body.includes('"tools/call"') && response.body) {
      return new Response(this.wrapBody(response.body), {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
    }
    return response;
  };

  /** Обрывает тело POST-ответа ошибкой тайм-аута и закрывает соединение с сервером. */
  cutPostResponse(): void {
    assert.ok(this.cutBody, 'тело POST tools/call ещё не получено — нечего обрывать');
    this.cutBody();
  }

  private wrapBody(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = upstream.getReader();
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.cutBody = () => {
          try {
            controller.error(new DOMException('The operation timed out.', 'TimeoutError'));
          } catch {
            // поток уже закрыт — обрывать нечего
          }
          void reader.cancel().catch(() => undefined);
        };
        void (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                return;
              }
              controller.enqueue(value);
            }
          } catch {
            try { controller.error(new Error('upstream closed')); } catch { /* уже оборван */ }
          }
        })();
      },
    });
  }
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      resolve(raw ? JSON.parse(raw) as unknown : undefined);
    });
    req.on('error', reject);
  });
}

suite('Возобновляемость долгого вызова по реальному HTTP (SSE + Last-Event-ID)', function () {
  this.timeout(30_000);

  let httpServer: http.Server;
  let mcp: McpServer;
  let serverTransport: StreamableHTTPServerTransport;
  let scheduler: ManualScheduler;
  let outcomes: McpOperationOutcomeRegistry;
  let gate: McpMutationGate;
  let work: Deferred<unknown>;
  let entered: Deferred<void>;
  let outcomeRecorded: Deferred<OperationOutcome>;
  let sessionPulses: string[];
  let url: URL;
  let client: Client | undefined;
  let clientTransport: StreamableHTTPClientTransport | undefined;
  let clientErrors: string[];

  setup(async () => {
    scheduler = new ManualScheduler();
    work = deferred<unknown>();
    entered = deferred();
    outcomeRecorded = deferred<OperationOutcome>();
    sessionPulses = [];
    clientErrors = [];

    outcomes = new McpOperationOutcomeRegistry();
    const record = outcomes.record.bind(outcomes);
    outcomes.record = (outcome) => { record(outcome); outcomeRecorded.resolve(outcome); };
    assert.strictEqual(MCP_SSE_RETRY_INTERVAL_MS, 1_000, 'продакшн-значение; в тесте — 10 мс ниже');
    mcp = new McpServer({ name: 'resumability-test', version: '1' }, { capabilities: { logging: {} } });
    gate = new McpMutationGate(
      { outputChannel: { appendLine: () => undefined } } as never,
      {
        scheduler, intervalMs: INTERVAL, readStage: () => undefined,
        sendSessionPulse: async (data) => {
          sessionPulses.push(data);
          await mcp.sendLoggingMessage({ level: 'info', logger: 'v8vscedit', data });
        },
      },
      outcomes
    );
    mcp.registerTool(
      'slow',
      { description: 'долгий инструмент', inputSchema: z.object({}) },
      (_args, extra) => gate.wrapLongRunning('slow', extra as unknown as McpToolExtra, async () => {
        entered.resolve();
        return work.promise;
      }) as never
    );

    serverTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore: new McpSessionEventStore(),
      retryInterval: 10,
    });
    await mcp.connect(serverTransport);
    httpServer = http.createServer((req, res) => {
      void (async () => {
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        await serverTransport.handleRequest(req, res, body);
      })().catch(() => { res.destroy(); });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, HOST, resolve));
    const address = httpServer.address();
    assert.ok(address && typeof address === 'object');
    url = new URL(`http://${HOST}:${String(address.port)}/mcp`);
  });

  teardown(async () => {
    work.resolve({ teardown: true });
    await client?.close().catch(() => undefined);
    await clientTransport?.close().catch(() => undefined);
    client = undefined;
    clientTransport = undefined;
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await serverTransport.close().catch(() => undefined);
  });

  async function connectClient(network?: FlakyNetwork): Promise<Client> {
    clientTransport = new StreamableHTTPClientTransport(url, network ? { fetch: network.fetch } : undefined);
    client = new Client({ name: 'resumability-client', version: '1' });
    client.onerror = (error) => { clientErrors.push(error.message); };
    await client.connect(clientTransport);
    return client;
  }

  const resultText = (result: unknown): string => {
    const content = (result as { content: { type: string; text?: string }[] }).content;
    return content[0].text ?? '';
  };

  test('уведомления приходят ДО результата: с onprogress — progress с текстом пульса', async () => {
    const connected = await connectClient();
    const gotProgress = deferred<{ progress: number; message?: string }>();
    const call = connected.callTool({ name: 'slow', arguments: {} }, undefined, { onprogress: (progress) => gotProgress.resolve(progress) });

    await entered.promise;
    await scheduler.fireNext();
    const progress = await gotProgress.promise;
    assert.strictEqual(progress.progress, 20);
    assert.strictEqual(progress.message, PULSE_20S);

    work.resolve({ done: true });
    assert.deepStrictEqual(JSON.parse(resultText(await call)), { done: true });
    assert.strictEqual(scheduler.pendingCount(), 0);
  });

  test('без onprogress (нет progressToken) — notifications/message с тем же текстом; сессионный пульс уходит с тем же текстом', async () => {
    const connected = await connectClient();
    const gotMessage = deferred<{ level: string; logger?: string; data: unknown }>();
    connected.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      gotMessage.resolve(notification.params);
    });
    const call = connected.callTool({ name: 'slow', arguments: {} });

    await entered.promise;
    await scheduler.fireNext();
    const message = await gotMessage.promise;
    assert.deepStrictEqual(message, { level: 'info', logger: 'v8vscedit', data: PULSE_20S });
    assert.deepStrictEqual(sessionPulses, [PULSE_20S]);

    work.resolve({ done: true });
    await call;
  });

  test('обрыв тела POST (TimeoutError) после первого пульса: переподключение по Last-Event-ID, результат доходит, ошибки разбора «{}» нет', async () => {
    const network = new FlakyNetwork();
    const connected = await connectClient(network);
    const progress: number[] = [];
    const first = deferred();
    const second = deferred();
    const call = connected.callTool({ name: 'slow', arguments: {} }, undefined, {
      onprogress: (event) => {
        progress.push(event.progress);
        (progress.length === 1 ? first : second).resolve();
      },
    });

    await entered.promise;
    await scheduler.fireNext();
    await first.promise;

    network.cutPostResponse();
    const { lastEventId } = await network.reconnected.promise;
    const parsed = parseEventId(lastEventId);
    assert.ok(parsed, `Last-Event-ID разбирается хранилищем: ${lastEventId}`);

    // Пульс продолжается уже в новый (переподключённый) поток.
    await scheduler.whenPendingCount(1);
    await scheduler.fireNext();
    await second.promise;
    assert.deepStrictEqual(progress, [20, 40]);

    work.resolve({ done: true });
    assert.deepStrictEqual(JSON.parse(resultText(await call)), { done: true });

    const disconnects = clientErrors.filter((message) => message.startsWith('SSE stream disconnected'));
    assert.strictEqual(disconnects.length, 1, JSON.stringify(clientErrors));
    assert.ok(disconnects[0].includes('TimeoutError'), disconnects[0]);
    assert.deepStrictEqual(
      clientErrors.filter((message) => !message.startsWith('SSE stream disconnected')), [],
      'priming «{}» не должен ломать разбор клиента'
    );
    assert.strictEqual(scheduler.pendingCount(), 0);
  });

  test('отмена вызова клиентом (AbortSignal): пульс гасится, таймеров не остаётся, исход — «прервано»', async () => {
    const connected = await connectClient();
    const controller = new AbortController();
    const call = connected.callTool({ name: 'slow', arguments: {} }, undefined, { signal: controller.signal });
    const rejected = assert.rejects(call);

    await entered.promise;
    await scheduler.whenPendingCount(1);
    controller.abort();
    await rejected;
    await scheduler.whenPendingCount(0);
    assert.strictEqual(scheduler.pendingCount(), 0);

    work.resolve({ done: true });
    const outcome = await outcomeRecorded.promise;
    assert.strictEqual(outcome.tool, 'slow');
    assert.strictEqual(outcome.isError, true);
    assert.ok(outcome.summary.includes('прервано'), outcome.summary);
  });
});
