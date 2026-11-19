/**
 * Э4 (B1): неожиданный обрыв SSH между операциями — на настоящем стеке
 * AgentInfoBaseSession → DesignerAgentSessionManager → ProcessDesignerAgentTransport(Factory) → ssh2.
 *
 * Агент 1С (внешняя система) эмулируется in-process ssh2-сервером (support/agentSshTestServer.ts),
 * отвечающим `[{"type":"success"}]` на каждую команду. Обрыв делает сервер, закрывая соединения.
 * Ожидание: следующая операция идёт по НОВОМУ SSH-соединению, на котором заново выполнены
 * `options set` (иначе ответы не JSON) и `connect-ib` (подключение ИБ не переживает закрытие SSH).
 */
import * as assert from 'assert';
import { Client } from 'ssh2';
import {
  AgentInfoBaseSession,
  DesignerAgentSessionManager,
  ProcessDesignerAgentTransportFactory,
} from '../../infra/agent';
import { FakeTimers } from './support/agentInfoBaseFakes';
import { AgentSshTestServer } from './support/agentSshTestServer';

const OPTIONS_SET = 'options set --output-format=json --show-prompt=no --notify-progress=yes --notify-progress-interval=0.5';

suite('AgentInfoBaseSession: обрыв SSH между операциями (реальный ssh2)', function () {
  this.timeout(30_000);
  let server: AgentSshTestServer;
  let sessions: DesignerAgentSessionManager | undefined;

  setup(async () => {
    server = await AgentSshTestServer.start();
    server.enableJsonReplies();
  });

  teardown(async () => {
    await sessions?.disposeAll();
    sessions = undefined;
    await server.close();
  });

  test('после обрыва следующая операция — новый SSH с options set и connect-ib', async () => {
    const clientsClosed: Promise<void>[] = [];
    const factory = new ProcessDesignerAgentTransportFactory({
      host: '127.0.0.1',
      port: server.port,
      user: 'admin',
      password: 'secret',
      connectTimeoutSeconds: 5,
      policy: { startupTimeoutMs: 5_000, authWarmupMs: 0, retryDelayMs: 100 },
    }, {
      createClient: () => {
        const client = new Client();
        clientsClosed.push(new Promise<void>((resolve) => client.once('close', () => resolve())));
        return client;
      },
    });
    sessions = new DesignerAgentSessionManager(factory);
    const session = new AgentInfoBaseSession(sessions, { idleDisconnectMs: 0, timers: new FakeTimers(), clock: () => 0 });

    await session.run((exec) => exec.execute('config op-1'));
    assert.deepStrictEqual(server.shellLog, [[OPTIONS_SET, 'common connect-ib', 'config op-1']]);
    assert.strictEqual(session.isInfoBaseConnected(), true);

    server.dropClients();
    await clientsClosed[0];
    // Слушатель транспорта на 'close' клиента вешается после тестового — даём ему отработать.
    await new Promise<void>((resolve) => setImmediate(resolve));

    await session.run((exec) => exec.execute('config op-2'));
    assert.strictEqual(server.shellLog.length, 2, 'вторая операция должна идти по новому SSH-соединению');
    assert.deepStrictEqual(server.shellLog[1], [OPTIONS_SET, 'common connect-ib', 'config op-2']);
    assert.deepStrictEqual(server.shellLog[0], [OPTIONS_SET, 'common connect-ib', 'config op-1'], 'в мёртвый канал команд нет');
  });
});
