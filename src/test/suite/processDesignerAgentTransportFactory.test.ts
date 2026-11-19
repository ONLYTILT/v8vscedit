import * as assert from 'assert';
import * as net from 'net';
import type { AgentConnectPolicyOptions } from '../../domain/agent';
import {
  ProcessDesignerAgentTransportFactory,
  type DesignerAgentConnectionOptions,
  type DesignerAgentSshClient,
  type DesignerAgentTransport,
} from '../../infra/agent';
import { AgentSshTestServer } from './support/agentSshTestServer';

/**
 * Фабрика транспорта (Э3) на реальном in-process SSH-сервере. Часы и sleep внедрены: sleep не
 * ждёт реально, а продвигает фейковые часы — сценарии детерминированы и мгновенны.
 * Сервер — эмулятор внешней системы (агент 1С), см. support/agentSshTestServer.ts.
 */

const POLICY: AgentConnectPolicyOptions = { startupTimeoutMs: 5_000, authWarmupMs: 90_000, retryDelayMs: 1_000 };
const T0 = 1_000;

interface Harness {
  readonly clock: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly sleeps: number[];
  advance(ms: number): void;
  onSleep?: (count: number) => Promise<void>;
}

function makeHarness(): Harness {
  let now = T0;
  const sleeps: number[] = [];
  const harness: Harness = {
    clock: () => now,
    sleeps,
    advance: (ms) => { now += ms; },
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
      await harness.onSleep?.(sleeps.length);
    },
  };
  return harness;
}

function options(port: number, extra: Partial<DesignerAgentConnectionOptions> = {}): DesignerAgentConnectionOptions {
  return {
    host: '127.0.0.1',
    port,
    user: 'admin',
    password: 'secret',
    connectTimeoutSeconds: 5,
    policy: POLICY,
    ...extra,
  };
}

async function closedPort(): Promise<number> {
  const probe = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

suite('ProcessDesignerAgentTransportFactory: политика подключения (реальный SSH)', () => {
  const servers: AgentSshTestServer[] = [];
  const transports: DesignerAgentTransport[] = [];

  async function startServer(opts: Parameters<typeof AgentSshTestServer.start>[0]): Promise<AgentSshTestServer> {
    const server = await AgentSshTestServer.start(opts);
    servers.push(server);
    return server;
  }

  async function create(factory: ProcessDesignerAgentTransportFactory): Promise<DesignerAgentTransport> {
    const transport = await factory.create();
    transports.push(transport);
    return transport;
  }

  teardown(async () => {
    await Promise.all(transports.splice(0).map((t) => t.dispose()));
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  test('agentStartedAt задан: два auth-отказа переживаются, успех с 3-й попытки, sleep с retryDelayMs', async () => {
    const server = await startServer({ behavior: { mode: 'reject-first', count: 2 } });
    const h = makeHarness();
    const factory = new ProcessDesignerAgentTransportFactory(
      options(server.port, { agentStartedAt: T0 }),
      { clock: h.clock, sleep: h.sleep }
    );

    await create(factory);

    assert.strictEqual(server.passwordAttempts, 3);
    assert.deepStrictEqual(h.sleeps, [1_000, 1_000]);
  });

  test('agentStartedAt не задан и refused не было: ровно одна попытка входа и ошибка credentials', async () => {
    const server = await startServer({ behavior: { mode: 'reject-all' } });
    const h = makeHarness();
    const factory = new ProcessDesignerAgentTransportFactory(options(server.port), { clock: h.clock, sleep: h.sleep });

    await assert.rejects(factory.create(), (error: Error) => {
      assert.match(error.message, /неверный логин или пароль агента конфигуратора для пользователя «admin»/);
      assert.ok(!error.message.includes('secret'), 'пароль в сообщении недопустим');
      assert.ok(error.cause, 'исходная ошибка ssh2 должна быть в cause');
      return true;
    });

    assert.strictEqual(server.passwordAttempts, 1, 'серия неверных входов под логином 1С недопустима');
    assert.deepStrictEqual(h.sleeps, []);
  });

  test('agentStartedAt давно в прошлом (вне окна прогрева): auth-отказ — сразу credentials', async () => {
    const server = await startServer({ behavior: { mode: 'reject-all' } });
    const h = makeHarness();
    const factory = new ProcessDesignerAgentTransportFactory(
      options(server.port, { agentStartedAt: T0 - POLICY.authWarmupMs }),
      { clock: h.clock, sleep: h.sleep }
    );

    await assert.rejects(factory.create(), /неверный логин или пароль агента конфигуратора/);
    assert.strictEqual(server.passwordAttempts, 1);
  });

  test('refused -> порт поднялся -> успех; затем auth-отказ той же фабрики повторяется (окно от lastRefusedAt)', async () => {
    const port = await closedPort();
    const h = makeHarness();
    let server: AgentSshTestServer | undefined;
    // Сервер поднимается на том же номере порта после второго sleep: до этого — настоящий ECONNREFUSED.
    h.onSleep = async (count) => {
      if (count === 2) {
        server = await startServer({ port, behavior: { mode: 'accept' } });
      }
    };
    const factory = new ProcessDesignerAgentTransportFactory(options(port), { clock: h.clock, sleep: h.sleep });

    await create(factory);
    assert.deepStrictEqual(h.sleeps, [1_000, 1_000]);
    assert.ok(server);

    // Агент «поднял порт, но логин ещё не принимает»: auth-отказ сразу после refused не фатален.
    server.resetAttempts();
    server.setBehavior({ mode: 'reject-first', count: 1 });
    await create(factory);
    assert.strictEqual(server.passwordAttempts, 2);
    assert.deepStrictEqual(h.sleeps, [1_000, 1_000, 1_000]);
  });

  test('refused давно (lastRefusedAt вне окна прогрева): auth-отказ в той же фабрике — сразу credentials', async () => {
    const port = await closedPort();
    const h = makeHarness();
    let server: AgentSshTestServer | undefined;
    h.onSleep = async (count) => {
      if (count === 1) {
        server = await startServer({ port, behavior: { mode: 'accept' } });
      }
    };
    const factory = new ProcessDesignerAgentTransportFactory(options(port), { clock: h.clock, sleep: h.sleep });
    await create(factory);
    assert.ok(server);

    h.advance(POLICY.authWarmupMs + 10_000);
    server.resetAttempts();
    server.setBehavior({ mode: 'reject-all' });
    await assert.rejects(factory.create(), /неверный логин или пароль агента конфигуратора/);
    assert.strictEqual(server.passwordAttempts, 1);
  });

  test('refused дольше startupTimeoutMs: ошибка unreachable с host:port', async () => {
    const port = await closedPort();
    const h = makeHarness();
    const factory = new ProcessDesignerAgentTransportFactory(options(port), { clock: h.clock, sleep: h.sleep });

    await assert.rejects(factory.create(), (error: Error) => {
      assert.ok(
        error.message.includes(`агент конфигуратора не отвечает на 127.0.0.1:${String(port)}`),
        `неожиданное сообщение: ${error.message}`
      );
      assert.ok(error.cause);
      return true;
    });
    // Окно [T0, T0 + 5000): попытки на 1000..5000 мс по часам, отказ на границе.
    assert.deepStrictEqual(h.sleeps, [1_000, 1_000, 1_000, 1_000, 1_000]);
  });

  test('refused с agentStartedAt: окно отсчитывается от старта процесса, а не от первой попытки', async () => {
    const port = await closedPort();
    const h = makeHarness();
    const factory = new ProcessDesignerAgentTransportFactory(
      options(port, { agentStartedAt: T0 - 3_000 }),
      { clock: h.clock, sleep: h.sleep }
    );

    await assert.rejects(factory.create(), /агент конфигуратора не отвечает/);
    // Предел T0 + 2000: две паузы.
    assert.deepStrictEqual(h.sleeps, [1_000, 1_000]);
  });

  test('успех с первой попытки: sleep не вызывается', async () => {
    const server = await startServer({ behavior: { mode: 'accept' } });
    const h = makeHarness();
    const factory = new ProcessDesignerAgentTransportFactory(options(server.port), { clock: h.clock, sleep: h.sleep });

    await create(factory);

    assert.strictEqual(server.passwordAttempts, 1);
    assert.deepStrictEqual(h.sleeps, []);
  });
});

suite('ProcessDesignerAgentTransportFactory: прочие классы отказа (поддельный клиент)', () => {
  class FailingClient implements DesignerAgentSshClient {
    private errorListener: ((error: Error) => void) | undefined;
    constructor(private readonly error: Error) {}
    on(event: string, listener: (...args: never[]) => void): this {
      if (event === 'error') {
        this.errorListener = listener as (error: Error) => void;
      }
      return this;
    }
    shell(): void { /* до shell дело не доходит */ }
    connect(): void { setImmediate(() => this.errorListener?.(this.error)); }
    end(): void { /* нечего закрывать */ }
  }

  function factoryFailingWith(error: Error, extra: Partial<DesignerAgentConnectionOptions> = {}): {
    factory: ProcessDesignerAgentTransportFactory;
    sleeps: number[];
  } {
    const h = makeHarness();
    return {
      sleeps: h.sleeps,
      factory: new ProcessDesignerAgentTransportFactory(options(1543, extra), {
        clock: h.clock,
        sleep: h.sleep,
        createClient: () => new FailingClient(error),
      }),
    };
  }

  test('other: без повторов, сообщение содержит исходную причину, cause сохранён', async () => {
    const original = Object.assign(new Error('Handshake failed: no matching host key type'), { level: 'client-socket' });
    const { factory, sleeps } = factoryFailingWith(original, { agentStartedAt: T0 });

    await assert.rejects(factory.create(), (error: Error) => {
      assert.ok(error.message.includes('Handshake failed: no matching host key type'));
      assert.strictEqual(error.cause, original);
      return true;
    });
    assert.deepStrictEqual(sleeps, []);
  });

  test('timeout без опорной точки: без повторов, cause сохранён, это не credentials', async () => {
    const original = Object.assign(new Error('Timed out while waiting for handshake'), { level: 'client-timeout' });
    const { factory, sleeps } = factoryFailingWith(original);

    await assert.rejects(factory.create(), (error: Error) => {
      assert.strictEqual(error.cause, original);
      assert.doesNotMatch(error.message, /неверный логин/);
      return true;
    });
    assert.deepStrictEqual(sleeps, []);
  });

  test('network с agentStartedAt: повторы в окне startupTimeoutMs, затем отказ с cause', async () => {
    const original = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const { factory, sleeps } = factoryFailingWith(original, { agentStartedAt: T0 });

    await assert.rejects(factory.create(), (error: Error) => {
      assert.strictEqual(error.cause, original);
      return true;
    });
    assert.deepStrictEqual(sleeps, [1_000, 1_000, 1_000, 1_000, 1_000]);
  });
});
