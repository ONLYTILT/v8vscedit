/**
 * Возобновляемость SSE в реальном `V8McpServer` (план mcp-long-running, 1.7): capability `logging`,
 * priming-событие с `retry: 1000` для клиентов протокола >= 2025-11-25 (и его отсутствие для старых),
 * очистка хранилища событий при закрытии сессии. Реальный loopback-сервер и реальный HTTP, без моков
 * транспорта (образец — `v8McpServerLifecycle.test.ts`).
 */
import * as assert from 'assert';
import * as http from 'http';
import * as net from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ConfigurationXmlEditor } from '../../infra/xml';
import type { CommandServices } from '../../ui/commands/_shared';
import { V8McpServer } from '../../ui/mcp/V8McpServer';
import { deferred } from './support/manualScheduler';
import { McpSessionEventStore, parseEventId } from '../../infra/mcp/McpSessionEventStore';

const HOST = '127.0.0.1';

function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close((error) => {
        if (error || port === undefined) {
          reject(error ?? new Error('не удалось определить свободный порт'));
          return;
        }
        resolve(port);
      });
    });
  });
}

function createServer(): V8McpServer {
  const services = {
    treeProvider: { getAutomationRoots: () => [], getEntries: () => [] },
    outputChannel: { appendLine: () => undefined },
  } as unknown as CommandServices;
  return new V8McpServer(services, new ConfigurationXmlEditor(), 'C:/resumability-test', '0.0.0-test');
}

/** Сырой POST initialize: тело SSE-ответа читается целиком (поток закрывается после ответа на initialize). */
function postInitialize(port: number, protocolVersion: string): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'resumability-test', version: '1' } },
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: HOST, port, path: '/mcp', method: 'POST',
        headers: {
          host: `${HOST}:${String(port)}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

suite('V8McpServer — возобновляемость SSE', function () {
  this.timeout(30_000);

  let server: V8McpServer;
  let port: number;
  const clients: Client[] = [];

  setup(async () => {
    port = await reserveFreePort();
    server = createServer();
    const started = await server.start({ host: HOST, port });
    assert.strictEqual(started.kind, 'started');
  });

  teardown(async () => {
    for (const client of clients.splice(0)) {
      await client.close().catch(() => undefined);
    }
    await server.stop();
  });

  async function connect(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
    const transport = new StreamableHTTPClientTransport(new URL(`http://${HOST}:${String(port)}/mcp`));
    const client = new Client({ name: 'resumability-test', version: '1' });
    clients.push(client);
    await client.connect(transport);
    return { client, transport };
  }

  test('сервер объявляет capability logging (без неё notifications/message пульса бросает)', async () => {
    const { client } = await connect();
    const capabilities = client.getServerCapabilities();
    assert.ok(capabilities?.logging, `capabilities: ${JSON.stringify(capabilities)}`);
    assert.ok(capabilities.tools, 'инструменты по-прежнему объявлены');
  });

  test('POST initialize с протоколом 2025-11-25: первым идёт priming-событие с id и «retry: 1000»', async () => {
    const { status, body } = await postInitialize(port, '2025-11-25');
    assert.strictEqual(status, 200);
    assert.match(body, /^id: \S+\r?\nretry: 1000\r?\ndata: *\r?\n\r?\n/, `начало потока: ${JSON.stringify(body.slice(0, 120))}`);
    assert.ok(body.indexOf('retry: 1000') < body.indexOf('event: message'), 'priming раньше ответа на initialize');
    assert.ok(body.includes('"serverInfo"'), 'ответ на initialize доставлен');
  });

  test('id события из priming разбирается хранилищем сессии (формат «<streamId>:<seq>»)', async () => {
    const { body } = await postInitialize(port, '2025-11-25');
    const id = /^id: (\S+)/m.exec(body)?.[1];
    assert.ok(id, body);
    const parsed = parseEventId(id);
    assert.ok(parsed && parsed.streamId.length > 0, `id=${id}`);
  });

  test('POST initialize с протоколом 2025-06-18: priming нет (нет «retry:» и событий с пустыми данными)', async () => {
    const { status, body } = await postInitialize(port, '2025-06-18');
    assert.strictEqual(status, 200);
    assert.ok(!body.includes('retry:'), body);
    assert.ok(!/^data: *\r?$/m.test(body), `пустое событие данных: ${body}`);
    assert.ok(body.includes('"serverInfo"'), 'ответ на initialize доставлен');
  });

  test('закрытие сессии клиентом (DELETE) очищает хранилище событий сессии', async () => {
    const cleared = deferred();
    const proto = McpSessionEventStore.prototype;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- патч прототипа: оригинал вызывается через call(this)
    const original = proto.clear;
    let clears = 0;
    const clearsSoFar = (): number => clears;
    proto.clear = function patched(this: typeof proto) {
      clears += 1;
      cleared.resolve();
      original.call(this);
    };
    try {
      const { transport } = await connect();
      assert.strictEqual(clearsSoFar(), 0, 'пока сессия жива, хранилище не чистится');
      await transport.terminateSession();
      await cleared.promise;
      assert.ok(clearsSoFar() >= 1);
    } finally {
      proto.clear = original;
    }
  });

  test('остановка сервера закрывает сессии и очищает их хранилища', async () => {
    const cleared = deferred();
    const proto = McpSessionEventStore.prototype;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- патч прототипа: оригинал вызывается через call(this)
    const original = proto.clear;
    proto.clear = function patched(this: typeof proto) {
      cleared.resolve();
      original.call(this);
    };
    try {
      await connect();
      await server.stop();
      await cleared.promise;
    } finally {
      proto.clear = original;
    }
  });
});
