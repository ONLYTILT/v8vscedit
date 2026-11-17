import * as assert from 'assert';
import {
  DesignerAgentSessionManager,
  type AgentCommandHooks,
  type AgentCommandResult,
  type DesignerAgentTransport,
  type DesignerAgentTransportFactory,
} from '../../infra/agent';

suite('DesignerAgentSessionManager', () => {
  test('не кеширует упавшее создание сессии и даёт повторить подключение', async () => {
    const factory = new FlakyFactory();
    const manager = new DesignerAgentSessionManager(factory);

    await assert.rejects(manager.create('default'), /нет связи/);
    const session = await manager.create('default');

    assert.strictEqual(factory.attempts, 2);
    assert.deepStrictEqual((session as FakeTransport).commands, [
      'options set --output-format=json --show-prompt=no --notify-progress=yes --notify-progress-interval=0.5',
    ]);
  });
});

class FlakyFactory implements DesignerAgentTransportFactory {
  attempts = 0;

  create(): Promise<DesignerAgentTransport> {
    this.attempts += 1;
    if (this.attempts === 1) {
      return Promise.reject(new Error('нет связи'));
    }
    return Promise.resolve(new FakeTransport());
  }
}

class FakeTransport implements DesignerAgentTransport {
  readonly commands: string[] = [];

  execute(command: string, hooks?: AgentCommandHooks): Promise<AgentCommandResult> {
    this.commands.push(command);
    hooks?.onMessage?.({ type: 'success', message: command });
    return Promise.resolve({ messages: [] });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

const OPTIONS_SET = 'options set --output-format=json --show-prompt=no --notify-progress=yes --notify-progress-interval=0.5';

/** Транспорт с управляемым признаком «соединение потеряно» (как у ProcessDesignerAgentTransport). */
class ClosableTransport extends FakeTransport {
  closed = false;
  isClosed(): boolean {
    return this.closed;
  }
}

class ClosableFactory implements DesignerAgentTransportFactory {
  readonly created: ClosableTransport[] = [];
  create(): Promise<DesignerAgentTransport> {
    const transport = new ClosableTransport();
    this.created.push(transport);
    return Promise.resolve(transport);
  }
}

suite('DesignerAgentSessionManager: Э4, потерянный транспорт пересоздаётся', () => {
  test('живой транспорт переиспользуется; потерянный — заменяется новым с options set', async () => {
    const factory = new ClosableFactory();
    const manager = new DesignerAgentSessionManager(factory);
    const first = await manager.create('default');
    assert.strictEqual(await manager.create('default'), first);

    factory.created[0].closed = true;
    const second = await manager.create('default');
    assert.notStrictEqual(second, first);
    assert.deepStrictEqual((second as ClosableTransport).commands, [OPTIONS_SET]);
    assert.strictEqual(factory.created.length, 2);
  });

  test('транспорт без признака isClosed считается живым и переиспользуется', async () => {
    const factory = new FlakyFactory();
    factory.attempts = 1;
    const manager = new DesignerAgentSessionManager(factory);
    const first = await manager.create('default');
    assert.strictEqual(await manager.create('default'), first);
    assert.strictEqual(factory.attempts, 2);
  });

  test('параллельные create после потери соединения создают ОДИН новый транспорт', async () => {
    const factory = new ClosableFactory();
    const manager = new DesignerAgentSessionManager(factory);
    await manager.create('default');
    factory.created[0].closed = true;

    const [a, b, c] = await Promise.all([manager.create('default'), manager.create('default'), manager.create('default')]);
    assert.strictEqual(a, b);
    assert.strictEqual(b, c);
    assert.strictEqual(factory.created.length, 2);
  });
});
