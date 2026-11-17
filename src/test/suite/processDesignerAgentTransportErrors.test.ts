import * as assert from 'assert';
import * as net from 'net';
import { Client } from 'ssh2';
import type { AgentConnectPolicyOptions } from '../../domain/agent';
import {
  ProcessDesignerAgentTransport,
  ProcessDesignerAgentTransportFactory,
  type DesignerAgentConnectionOptions,
  type DesignerAgentTransport,
} from '../../infra/agent';
import { SSH_CLOSED_BEFORE_READY_CODE } from '../../infra/agent/SshConnectErrorClassifier';
import { AgentSshTestServer } from './support/agentSshTestServer';

/**
 * Ошибки SSH-клиента после успешного connect() (обработчик client.on('error') транспорта).
 * Настоящий ssh2-клиент против настоящего сервера через TCP-прокси: «ошибку клиента» даёт мусор
 * в потоке от сервера (ssh2 эмитит 'error' на невалидный пакет) — так выполняется ветка, где
 * у output есть слушатель 'error' (выполняющаяся команда), и ветка без слушателя.
 */

interface Proxy {
  readonly port: number;
  /** Пишет мусор клиентам и ждёт, пока они закроют сокеты. */
  corruptClients(): Promise<void>;
  close(): Promise<void>;
}

async function startProxy(targetPort: number): Promise<Proxy> {
  const sockets = new Set<net.Socket>();
  const clientSides = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    sockets.add(client);
    sockets.add(upstream);
    clientSides.add(client);
    client.pipe(upstream);
    upstream.pipe(client);
    const drop = () => { client.destroy(); upstream.destroy(); };
    client.on('error', drop);
    upstream.on('error', drop);
    client.on('close', () => { upstream.destroy(); clientSides.delete(client); });
    upstream.on('close', () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    async corruptClients() {
      const closed = [...clientSides].map((s) => new Promise<void>((resolve) => s.once('close', () => resolve())));
      for (const s of clientSides) {
        // Отрыв от upstream, чтобы реальные пакеты сервера не перемешались с мусором.
        s.unpipe();
        s.write(Buffer.alloc(256, 0xff));
        // Мусор может расшифроваться в правдоподобную длину пакета, и ssh2 станет ждать «остаток»:
        // закрытие стороны гарантирует 'close' клиента вместо ожидания до таймаута теста.
        s.end();
      }
      await Promise.all(closed);
    },
    async close() {
      for (const s of sockets) { s.destroy(); }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

suite('ProcessDesignerAgentTransport: ошибки клиента после connect (реальный SSH)', function () {
  this.timeout(30_000);
  let server: AgentSshTestServer;
  let proxy: Proxy;
  const transports: DesignerAgentTransport[] = [];

  // Реальный ssh2-клиент, у которого мы заранее вешаем свой 'close': он срабатывает раньше слушателя
  // транспорта (тот вешается в connect()), поэтому после await этого промиса состояние транспорта
  // ещё не сброшено, а после следующего такта — уже сброшено. Без этого — гонка с закрытием сокета.
  let clientClosed: Promise<void>;
  function transport(): ProcessDesignerAgentTransport {
    const t = new ProcessDesignerAgentTransport({
      host: '127.0.0.1', port: proxy.port, user: 'admin', password: 'secret', connectTimeoutSeconds: 5,
    }, () => {
      const client = new Client();
      clientClosed = new Promise<void>((resolve) => client.once('close', () => resolve()));
      return client;
    });
    transports.push(t);
    return t;
  }

  setup(async () => {
    server = await AgentSshTestServer.start();
    proxy = await startProxy(server.port);
  });

  teardown(async () => {
    await Promise.all(transports.splice(0).map((t) => t.dispose()));
    await proxy.close();
    await server.close();
  });

  test('ошибка клиента во время выполняющейся команды отклоняет execute этой ошибкой', async () => {
    const t = transport();
    await t.connect();
    const input = server.nextShellInput();
    const pending = t.execute('common connect-ib');
    // Команда дошла до сервера, ответа нет: слушатель 'error' у output уже висит.
    assert.strictEqual(await input, 'common connect-ib\n');
    const outcome = assert.rejects(pending, (error: Error) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /закрыто с кодом/, 'причиной должна быть ошибка клиента, а не close');
      return true;
    });
    await proxy.corruptClients();
    await outcome;
  });

  test('ошибка клиента без активной команды не бросается; следующая команда переподключается', async () => {
    const t = transport();
    await t.connect();
    // Нет слушателей 'error': обработчик не должен бросить uncaught из emit.
    await proxy.corruptClients();
    // Ошибка без команды не роняет процесс; сброс канала делает последующий 'close' клиента —
    // дожидаемся его (и слушателя транспорта, идущего следом в том же emit).
    await clientClosed;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const input = server.nextShellInput();
    const pending = t.execute('common shutdown');
    // Фактическое поведение: канал сброшен, execute поднимает новое соединение и шлёт команду.
    assert.strictEqual(await input, 'common shutdown\n');
    const outcome = assert.rejects(pending, Error);
    await proxy.corruptClients();
    await outcome;
  });
});

/**
 * Сервер прислал заголовок SSH и закрыл TCP посреди KEX: ssh2 1.17 в этом случае эмитит только
 * 'close' (без 'error'), а readyTimeout при close снимает. Без отказа на 'close' connect() висел бы
 * вечно вместе с factory.create(). Сервер читает всё, что шлёт клиент, и закрывается через FIN
 * (end, а не destroy): непрочитанные данные дали бы RST, т.е. ECONNRESET — другую ветку.
 */
suite('ProcessDesignerAgentTransportFactory: закрытие соединения до готовности (реальный ssh2)', function () {
  this.timeout(30_000);
  const POLICY: AgentConnectPolicyOptions = { startupTimeoutMs: 5_000, authWarmupMs: 90_000, retryDelayMs: 1_000 };
  const T0 = 1_000;
  let server: net.Server;
  let port: number;
  let connections: number;
  const sockets = new Set<net.Socket>();

  setup(async () => {
    connections = 0;
    server = net.createServer((socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
      socket.resume();
      socket.end('SSH-2.0-x\r\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  });

  teardown(async () => {
    for (const s of sockets) { s.destroy(); }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function factory(extra: Partial<DesignerAgentConnectionOptions>): {
    factory: ProcessDesignerAgentTransportFactory;
    sleeps: number[];
  } {
    let now = T0;
    const sleeps: number[] = [];
    return {
      sleeps,
      factory: new ProcessDesignerAgentTransportFactory({
        host: '127.0.0.1', port, user: 'admin', password: 'secret', connectTimeoutSeconds: 5, policy: POLICY, ...extra,
      }, {
        clock: () => now,
        sleep: (ms) => { sleeps.push(ms); now += ms; return Promise.resolve(); },
      }),
    };
  }

  function assertClosedBeforeReady(error: Error): true {
    assert.match(error.message, /SSH-соединение с агентом закрыто до готовности/);
    assert.strictEqual((error.cause as { code?: unknown }).code, SSH_CLOSED_BEFORE_READY_CODE);
    assert.ok(!error.message.includes('secret'), 'пароль не должен попадать в сообщение');
    return true;
  }

  test('без опорной точки: create() отклоняется после одной попытки, а не висит', async () => {
    const { factory: f, sleeps } = factory({});

    await assert.rejects(f.create(), assertClosedBeforeReady);
    assert.strictEqual(connections, 1);
    assert.deepStrictEqual(sleeps, []);
  });

  test('agentStartedAt в окне прогрева: обрыв повторяется до startupTimeoutMs, затем отказ', async () => {
    const { factory: f, sleeps } = factory({ agentStartedAt: T0 });

    await assert.rejects(f.create(), assertClosedBeforeReady);
    assert.deepStrictEqual(sleeps, [1_000, 1_000, 1_000, 1_000, 1_000]);
    assert.strictEqual(connections, 6);
  });
});
