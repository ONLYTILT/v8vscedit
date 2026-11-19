/**
 * Э4: AgentInfoBaseSession — жизненный цикл подключения ИБ к агенту конфигуратора.
 *
 * Ожидаемый контракт (infra/agent/AgentInfoBaseSession.ts, экспорт через infra/agent/index.ts):
 *   interface TimerApi { setTimeout(cb: () => void | Promise<void>, ms: number): unknown; clearTimeout(handle: unknown): void }
 *   interface AgentCommandExecutor { execute(command: string): Promise<AgentCommandResult> }
 *   interface AgentInfoBaseSessionOptions { idleDisconnectMs: number; timers: TimerApi; clock: () => number }
 *   class AgentInfoBaseSession implements DesignerAgentInfoBaseSession {
 *     constructor(transports: DesignerAgentTransportFactory | ResettableDesignerAgentTransportFactory, options: AgentInfoBaseSessionOptions)
 *     run<T>(op: (exec: AgentCommandExecutor) => Promise<T>, hooks?: AgentOperationHooks): Promise<T>
 *     disconnectInfoBase(hooks?, options?: { force?: boolean }): Promise<boolean>
 *     reconnectInfoBase(hooks?): Promise<void>
 *     isInfoBaseConnected(): boolean
 *     dispose(): Promise<void>
 *   }
 * Колбэк, переданный в timers.setTimeout, ОБЯЗАН возвращать промис отключения (тест ждёт его через
 * `await timers.fireAll()`), и не должен отклоняться: ошибка idle-отключения не уходит наружу.
 */
import * as assert from 'assert';
import * as os from 'os';
import {
  AgentInfoBaseSession,
  SYSTEM_TIMERS,
  isInfoBaseAlreadyConnectedMessage,
  isInfoBaseNotConnectedMessage,
  AgentCommandError,
  AgentInfoBaseLockedError,
  AgentOperationService,
  isInfoBaseLockedByDesignerError,
  type TimerApi,
  type DesignerAgentTransportFactory,
} from '../../infra/agent';
import { FakeTimers, ScriptedFactory, ScriptedTransport, agentError, deferred, type TransportBehavior } from './support/agentInfoBaseFakes';

const CONNECT = 'common connect-ib';
const DISCONNECT = 'common disconnect-ib';

function make(options: { idleMs?: number; behavior?: TransportBehavior } = {}) {
  const factory = new ScriptedFactory(options.behavior);
  const timers = new FakeTimers();
  const session = new AgentInfoBaseSession(factory, {
    idleDisconnectMs: options.idleMs ?? 0,
    timers,
    clock: () => 0,
  });
  return { factory, timers, session };
}

const sendCommand = (command: string) => (exec: { execute(c: string): Promise<unknown> }) => exec.execute(command);

suite('AgentInfoBaseSession: подключение и повторное использование', () => {
  test('первая операция подключает ИБ и выполняет команду; соединение остаётся', async () => {
    const { session, factory } = make();
    assert.strictEqual(session.isInfoBaseConnected(), false);
    const result = await session.run(async (exec) => {
      await exec.execute('config update-db-cfg');
      return 42;
    });
    assert.strictEqual(result, 42);
    assert.deepStrictEqual(factory.log, [CONNECT, 'config update-db-cfg']);
    assert.strictEqual(session.isInfoBaseConnected(), true);
    assert.strictEqual(factory.resetCount, 0);
  });

  test('цепочка из четырёх операций: один connect-ib, ноль disconnect-ib, ноль сбросов SSH', async () => {
    const { session, factory } = make();
    for (const command of ['load-1', 'update-1', 'load-2', 'update-2']) {
      await session.run(sendCommand(command));
    }
    assert.deepStrictEqual(factory.log, [CONNECT, 'load-1', 'update-1', 'load-2', 'update-2']);
    assert.strictEqual(factory.count(DISCONNECT), 0);
    assert.strictEqual(factory.resetCount, 0);
    assert.strictEqual(factory.createCount, 1);
  });

  test('«уже подключено» распознаётся по машинному error-type, а не по тексту', async () => {
    const { session, factory } = make({
      behavior: (command) => command === CONNECT ? agentError('DesignerAlreadyConnectedToInfoBase') : undefined,
    });
    await session.run(sendCommand('op'));
    assert.deepStrictEqual(factory.log, [CONNECT, 'op']);
    assert.strictEqual(session.isInfoBaseConnected(), true);
    // дальше connect-ib не повторяется
    await session.run(sendCommand('op2'));
    assert.strictEqual(factory.count(CONNECT), 1);
  });

  test('«уже подключено» по тексту (фолбэк без error-type) тоже проглатывается', async () => {
    const { session, factory } = make({
      behavior: (command) => command === CONNECT ? new Error('Соединение с информационной базой уже\nустановлено') : undefined,
    });
    await session.run(sendCommand('op'));
    assert.strictEqual(session.isInfoBaseConnected(), true);
    assert.deepStrictEqual(factory.log, [CONNECT, 'op']);
  });

  test('иной отказ connect-ib: операция отклоняется, disconnect-ib не шлётся, SSH сброшен, следующая операция снова подключает', async () => {
    let failConnect = true;
    const { session, factory } = make({
      behavior: (command) => command === CONNECT && failConnect ? agentError('InfoBaseNotFound', 'база недоступна') : undefined,
    });
    await assert.rejects(session.run(sendCommand('op')), /база недоступна/);
    assert.strictEqual(session.isInfoBaseConnected(), false);
    assert.strictEqual(factory.count(DISCONNECT), 0);
    assert.strictEqual(factory.resetCount, 1);

    failConnect = false;
    await session.run(sendCommand('op'));
    assert.strictEqual(factory.count(CONNECT), 2);
    assert.strictEqual(session.isInfoBaseConnected(), true);
  });

  test('сообщения агента доходят до hooks.onMessage текстом; onQuestion пробрасывается транспорту', async () => {
    const { session, factory } = make();
    const messages: string[] = [];
    const onQuestion = () => Promise.resolve('да');
    await session.run(sendCommand('op'), { onMessage: (m) => messages.push(m), onQuestion });
    assert.ok(messages.some((m) => m.includes('Подключение информационной базы')));
    assert.ok(messages.some((m) => m === 'выполнено: op'));
    const hooks = factory.transports[0].lastHooks;
    assert.ok(hooks?.onQuestion);
    assert.strictEqual(await hooks.onQuestion({ type: 'question' }), 'да');
  });

  test('операции сериализуются: вторая не стартует, пока не завершилась первая', async () => {
    const gate = deferred();
    const events: string[] = [];
    const { session } = make();
    const first = session.run(async (exec) => {
      events.push('first:start');
      await exec.execute('a');
      await gate.promise;
      events.push('first:end');
    });
    const second = session.run(async (exec) => {
      events.push('second:start');
      await exec.execute('b');
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(events, ['first:start']);
    gate.resolve();
    await Promise.all([first, second]);
    assert.deepStrictEqual(events, ['first:start', 'first:end', 'second:start']);
  });

  test('ошибка первой операции не блокирует очередь: вторая выполняется', async () => {
    const { session } = make({ behavior: (command) => command === 'bad' ? new Error('сбой') : undefined });
    const first = session.run(sendCommand('bad'));
    const second = session.run(sendCommand('good'));
    await assert.rejects(first, /сбой/);
    await second;
  });
});

suite('AgentInfoBaseSession: ошибка операции', () => {
  test('ошибка операции → disconnect-ib и сброс SSH; следующая операция подключает заново', async () => {
    let fail = true;
    const { session, factory } = make({
      behavior: (command) => command === 'op' && fail ? new Error('операция упала') : undefined,
    });
    await assert.rejects(session.run(sendCommand('op')), /операция упала/);
    assert.deepStrictEqual(factory.log, [CONNECT, 'op', DISCONNECT]);
    assert.strictEqual(factory.resetCount, 1);
    assert.strictEqual(session.isInfoBaseConnected(), false);

    fail = false;
    await session.run(sendCommand('op'));
    assert.strictEqual(factory.count(CONNECT), 2);
    assert.strictEqual(factory.createCount, 2);
  });

  test('«не подключено» при отключении после ошибки распознаётся по error-type и проглатывается', async () => {
    const { session, factory } = make({
      behavior: (command) => {
        if (command === 'op') { return new Error('операция упала'); }
        if (command === DISCONNECT) { return agentError('DesignerNotConnectedToInfoBase'); }
        return undefined;
      },
    });
    const messages: string[] = [];
    await assert.rejects(session.run(sendCommand('op'), { onMessage: (m) => messages.push(m) }), /операция упала/);
    assert.strictEqual(factory.resetCount, 1);
    assert.ok(!messages.some((m) => m.includes('Не удалось отключить')));
  });

  test('иной отказ disconnect-ib после ошибки: сообщение в hooks, исходная ошибка сохраняется, SSH всё равно сброшен', async () => {
    const { session, factory } = make({
      behavior: (command) => {
        if (command === 'op') { return new Error('операция упала'); }
        if (command === DISCONNECT) { return new Error('канал мёртв'); }
        return undefined;
      },
    });
    const messages: string[] = [];
    await assert.rejects(session.run(sendCommand('op'), { onMessage: (m) => messages.push(m) }), /операция упала/);
    assert.ok(messages.some((m) => m.includes('Не удалось отключить информационную базу после ошибки операции: канал мёртв')));
    assert.strictEqual(factory.resetCount, 1);
    assert.strictEqual(session.isInfoBaseConnected(), false);
  });

  test('сбой сброса SSH: сообщение в hooks, исходная ошибка операции сохраняется', async () => {
    const { session, factory } = make({ behavior: (command) => command === 'op' ? new Error('операция упала') : undefined });
    factory.resetError = new Error('reset не удался');
    const messages: string[] = [];
    await assert.rejects(session.run(sendCommand('op'), { onMessage: (m) => messages.push(m) }), /операция упала/);
    assert.ok(messages.some((m) => m.includes('Не удалось сбросить SSH-сессию агента: reset не удался')));
  });

  test('фабрика без reset (не Resettable): ошибка операции не падает на сбросе', async () => {
    const { factory } = make({ behavior: (command) => command === 'op' ? new Error('операция упала') : undefined });
    const plain: DesignerAgentTransportFactory = { create: () => factory.create() };
    const session = new AgentInfoBaseSession(plain, { idleDisconnectMs: 0, timers: new FakeTimers(), clock: () => 0 });
    await assert.rejects(session.run(sendCommand('op')), /операция упала/);
    assert.strictEqual(factory.resetCount, 0);
  });

  test('Н13: команда после обрыва между error и close уходит на НОВЫЙ транспорт с connect-ib, а не в мёртвый канал', async () => {
    let dead = false;
    const { session, factory } = make({
      behavior: (command) => {
        // Моделируем транспорт, у которого сработал 'error' SSH-клиента, а 'close' ещё не пришёл:
        // канал мёртв, любая команда на нём отклоняется «закрыто с кодом 255».
        if (dead) { return new Error('SSH-соединение с агентом закрыто с кодом 255.'); }
        return command === 'op-dies' ? (dead = true, new Error('read ECONNRESET')) : undefined;
      },
    });
    await session.run(sendCommand('ok'));
    await assert.rejects(session.run(sendCommand('op-dies')), /ECONNRESET/);
    assert.strictEqual(factory.resetCount, 1);

    const firstTransport = factory.transports[0];
    const commandsOnDeadChannel = firstTransport.commands.length;
    // Следующий транспорт «живой».
    dead = false;
    await session.run(sendCommand('after'));
    assert.strictEqual(factory.createCount, 2);
    assert.strictEqual(firstTransport.commands.length, commandsOnDeadChannel, 'в мёртвый канал новых команд быть не должно');
    assert.deepStrictEqual(factory.transports[1].commands, [CONNECT, 'after']);
  });
});

suite('AgentInfoBaseSession: disconnectInfoBase / reconnectInfoBase', () => {
  test('не подключено и без force: false, транспорт даже не создаётся', async () => {
    const { session, factory } = make();
    assert.strictEqual(await session.disconnectInfoBase(), false);
    assert.strictEqual(factory.createCount, 0);
    assert.deepStrictEqual(factory.log, []);
  });

  test('подключено: disconnect-ib, true, состояние сброшено; SSH не сбрасывается; сообщение в hooks', async () => {
    const { session, factory } = make();
    await session.run(sendCommand('op'));
    const messages: string[] = [];
    assert.strictEqual(await session.disconnectInfoBase({ onMessage: (m) => messages.push(m) }), true);
    assert.strictEqual(factory.log.at(-1), DISCONNECT);
    assert.strictEqual(session.isInfoBaseConnected(), false);
    assert.strictEqual(factory.resetCount, 0);
    assert.ok(messages.includes('Отключение информационной базы от агента конфигуратора.'));
  });

  test('force без кэша подключения: disconnect-ib всё равно шлётся', async () => {
    const { session, factory } = make();
    assert.strictEqual(await session.disconnectInfoBase(undefined, { force: true }), true);
    assert.deepStrictEqual(factory.log, [DISCONNECT]);
  });

  test('«не подключено» по error-type проглатывается, результат true', async () => {
    const { session } = make({ behavior: (command) => command === DISCONNECT ? agentError('DesignerNotConnectedToInfoBase') : undefined });
    assert.strictEqual(await session.disconnectInfoBase(undefined, { force: true }), true);
  });

  test('«не подключено» по тексту (фолбэк) проглатывается', async () => {
    const { session } = make({ behavior: (command) => command === DISCONNECT ? new Error('database is not connected') : undefined });
    assert.strictEqual(await session.disconnectInfoBase(undefined, { force: true }), true);
  });

  test('иной отказ disconnect-ib пробрасывается', async () => {
    const { session } = make({ behavior: (command) => command === DISCONNECT ? new Error('канал мёртв') : undefined });
    await assert.rejects(session.disconnectInfoBase(undefined, { force: true }), /канал мёртв/);
  });

  test('reconnectInfoBase: не подключено → connect-ib; подключено → без команд', async () => {
    const { session, factory } = make();
    await session.reconnectInfoBase();
    assert.deepStrictEqual(factory.log, [CONNECT]);
    assert.strictEqual(session.isInfoBaseConnected(), true);
    await session.reconnectInfoBase();
    assert.deepStrictEqual(factory.log, [CONNECT]);
  });

  test('reconnectInfoBase: «уже подключено» по error-type принимается как успех', async () => {
    const { session } = make({ behavior: (command) => command === CONNECT ? agentError('DesignerAlreadyConnectedToInfoBase') : undefined });
    await session.reconnectInfoBase();
    assert.strictEqual(session.isInfoBaseConnected(), true);
  });

  test('после disconnect следующая операция подключает заново (reconnect ленивый)', async () => {
    const { session, factory } = make();
    await session.run(sendCommand('a'));
    await session.disconnectInfoBase();
    await session.run(sendCommand('b'));
    assert.strictEqual(factory.count(CONNECT), 2);
  });
});

suite('AgentInfoBaseSession: idle-таймер', () => {
  const IDLE = 300_000;

  test('после успешной операции ставится таймер на idleDisconnectMs; срабатывание отправляет disconnect-ib без сброса SSH', async () => {
    const { session, factory, timers } = make({ idleMs: IDLE });
    await session.run(sendCommand('op'));
    assert.deepStrictEqual(timers.setCalls, [IDLE]);
    assert.strictEqual(timers.pending.size, 1);

    await timers.fireAll();
    assert.strictEqual(factory.log.at(-1), DISCONNECT);
    assert.strictEqual(session.isInfoBaseConnected(), false);
    assert.strictEqual(factory.resetCount, 0);

    await session.run(sendCommand('next'));
    assert.strictEqual(factory.count(CONNECT), 2);
  });

  test('новая операция переносит таймер: старый снят, поставлен новый', async () => {
    const { session, timers } = make({ idleMs: IDLE });
    await session.run(sendCommand('a'));
    const [oldId] = [...timers.pending.keys()];
    await session.run(sendCommand('b'));
    assert.ok(!timers.pending.has(oldId), 'старый таймер должен быть снят');
    assert.strictEqual(timers.pending.size, 1);
    assert.strictEqual(timers.setCalls.length, 2);
    assert.ok(timers.clearCalls >= 1);
  });

  test('пока операция выполняется, таймера нет (idle не отключит базу посреди операции)', async () => {
    const gate = deferred();
    const { session, timers } = make({ idleMs: IDLE });
    await session.run(sendCommand('a'));
    assert.strictEqual(timers.pending.size, 1);
    const running = session.run(async (exec) => {
      await exec.execute('b');
      await gate.promise;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(timers.pending.size, 0);
    gate.resolve();
    await running;
    assert.strictEqual(timers.pending.size, 1);
  });

  test('idleDisconnectMs = 0: таймер не ставится вовсе', async () => {
    const { session, timers } = make({ idleMs: 0 });
    await session.run(sendCommand('a'));
    await session.run(sendCommand('b'));
    assert.deepStrictEqual(timers.setCalls, []);
    assert.strictEqual(timers.pending.size, 0);
  });

  test('после ошибки операции таймер не ставится (база уже отключена)', async () => {
    const { session, timers } = make({ idleMs: IDLE, behavior: (command) => command === 'op' ? new Error('упала') : undefined });
    await assert.rejects(session.run(sendCommand('op')), /упала/);
    assert.strictEqual(timers.pending.size, 0);
  });

  test('явный disconnectInfoBase снимает таймер', async () => {
    const { session, timers } = make({ idleMs: IDLE });
    await session.run(sendCommand('a'));
    await session.disconnectInfoBase();
    assert.strictEqual(timers.pending.size, 0);
  });

  test('сбой idle-отключения не уходит наружу; состояние консервативно «не подключено», следующая операция подключает заново', async () => {
    let failDisconnect = true;
    const { session, factory, timers } = make({
      idleMs: IDLE,
      behavior: (command) => command === DISCONNECT && failDisconnect ? new Error('канал мёртв') : undefined,
    });
    await session.run(sendCommand('a'));
    await timers.fireAll();
    assert.strictEqual(session.isInfoBaseConnected(), false);

    failDisconnect = false;
    await session.run(sendCommand('b'));
    assert.strictEqual(factory.count(CONNECT), 2);
  });

  test('dispose снимает таймер; запоздалое срабатывание после dispose ничего не отправляет', async () => {
    const { session, factory, timers } = make({ idleMs: IDLE });
    await session.run(sendCommand('a'));
    const stale = timers.onlyCallback();
    await session.dispose();
    assert.strictEqual(timers.pending.size, 0);
    const before = factory.log.length;
    await stale();
    assert.strictEqual(factory.log.length, before);
  });

  test('dispose без таймера и повторный dispose не бросают', async () => {
    const { session } = make({ idleMs: IDLE });
    await session.dispose();
    await session.dispose();
  });
});

suite('AgentInfoBaseSession: часы, реальные таймеры, работа после dispose', () => {
  test('getLastActivityAt: undefined до первой операции, время успешной операции, ошибка его не сдвигает', async () => {
    let now = 100;
    const factory = new ScriptedFactory((command) => command === 'bad' ? new Error('сбой') : undefined);
    const session = new AgentInfoBaseSession(factory, { idleDisconnectMs: 0, timers: new FakeTimers(), clock: () => now });
    assert.strictEqual(session.getLastActivityAt(), undefined);
    await session.run(sendCommand('ok'));
    assert.strictEqual(session.getLastActivityAt(), 100);
    now = 200;
    await assert.rejects(session.run(sendCommand('bad')), /сбой/);
    assert.strictEqual(session.getLastActivityAt(), 100);
  });

  test('после dispose операция выполняется, но idle-таймер больше не ставится', async () => {
    const { session, timers } = make({ idleMs: 300_000 });
    await session.dispose();
    await session.run(sendCommand('a'));
    assert.deepStrictEqual(timers.setCalls, []);
  });

  test('SYSTEM_TIMERS: настоящий таймер отпускает базу после простоя', async () => {
    const released = deferred();
    const factory = new ScriptedFactory((command) => { if (command === DISCONNECT) { released.resolve(); } return undefined; });
    const session = new AgentInfoBaseSession(factory, { idleDisconnectMs: 1, timers: SYSTEM_TIMERS, clock: Date.now });
    await session.run(sendCommand('a'));
    await released.promise;
    // Очередь сессии сериализует обращения: этот вызов выполнится после idle-отключения.
    assert.strictEqual(await session.disconnectInfoBase(), false);
    assert.strictEqual(session.isInfoBaseConnected(), false);
    assert.strictEqual(factory.resetCount, 0);
  });

  test('SYSTEM_TIMERS: dispose снимает настоящий таймер, база остаётся подключённой', async () => {
    const factory = new ScriptedFactory();
    const session = new AgentInfoBaseSession(factory, { idleDisconnectMs: 60_000, timers: SYSTEM_TIMERS, clock: Date.now });
    await session.run(sendCommand('a'));
    await session.dispose();
    assert.strictEqual(session.isInfoBaseConnected(), true);
    assert.strictEqual(factory.count(DISCONNECT), 0);
  });
});

suite('AgentInfoBaseSession: отказ транспорта не-Error значением', () => {
  test('отказ disconnect-ib строкой после ошибки операции попадает в hooks текстом', async () => {
    const transport = {
      execute: (command: string) => {
        if (command === 'op') { return Promise.reject(new Error('операция упала')); }
        // Транспорт не обязан отклонять промис объектом Error.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        if (command === DISCONNECT) { return Promise.reject('канал закрыт'); }
        return Promise.resolve({ messages: [] });
      },
      dispose: () => Promise.resolve(),
    };
    const session = new AgentInfoBaseSession({ create: () => Promise.resolve(transport) }, {
      idleDisconnectMs: 0, timers: new FakeTimers(), clock: () => 0,
    });
    const messages: string[] = [];
    await assert.rejects(session.run(sendCommand('op'), { onMessage: (m) => messages.push(m) }), /операция упала/);
    assert.ok(messages.includes('Не удалось отключить информационную базу после ошибки операции: канал закрыт'), messages.join('|'));
  });
});

suite('AgentInfoBaseSession: Э4-доработка (ревью B1/B2)', () => {
  test('B2: отказ явного disconnect-ib → SSH сброшен, состояние «не подключено», ошибка проброшена; повторный release без команд', async () => {
    let failDisconnect = true;
    const { session, factory } = make({
      behavior: (command) => command === DISCONNECT && failDisconnect ? new Error('агент умер') : undefined,
    });
    await session.run(sendCommand('op'));
    await assert.rejects(session.disconnectInfoBase(), /агент умер/);
    assert.strictEqual(factory.resetCount, 1);
    assert.strictEqual(session.isInfoBaseConnected(), false);

    failDisconnect = false;
    const before = factory.log.length;
    assert.strictEqual(await session.disconnectInfoBase(), false, 'следующий release не должен упираться в тот же агент');
    assert.strictEqual(factory.log.length, before);
  });

  test('B2: агент недоступен (создание транспорта падает) — тоже сброс и «не подключено»', async () => {
    const { factory } = make();
    let createFails = false;
    const flaky = {
      create: () => createFails ? Promise.reject(new Error('порт закрыт')) : factory.create(),
      reset: () => factory.reset(),
    };
    const session = new AgentInfoBaseSession(flaky, { idleDisconnectMs: 0, timers: new FakeTimers(), clock: () => 0 });
    await session.run(sendCommand('op'));
    createFails = true;
    await assert.rejects(session.disconnectInfoBase(), /порт закрыт/);
    assert.strictEqual(session.isInfoBaseConnected(), false);
    assert.strictEqual(factory.resetCount, 1);
  });

  test('B1: фабрика отдала ДРУГОЙ транспорт (старый потерял SSH) — connect-ib повторяется на новом', async () => {
    const log: string[] = [];
    let current = new ScriptedTransport(log);
    const first = current;
    const swapping = { create: () => Promise.resolve(current) };
    const session = new AgentInfoBaseSession(swapping, { idleDisconnectMs: 0, timers: new FakeTimers(), clock: () => 0 });

    await session.run(sendCommand('op-1'));
    current = new ScriptedTransport(log);
    await session.run(sendCommand('op-2'));

    assert.deepStrictEqual(first.commands, [CONNECT, 'op-1']);
    assert.deepStrictEqual(current.commands, [CONNECT, 'op-2']);
    assert.strictEqual(session.isInfoBaseConnected(), true);
  });

  test('B1: на новом транспорте «уже подключено» (состояние было неизвестно) принимается как успех', async () => {
    const log: string[] = [];
    let current = new ScriptedTransport(log);
    const swapping = { create: () => Promise.resolve(current) };
    const session = new AgentInfoBaseSession(swapping, { idleDisconnectMs: 0, timers: new FakeTimers(), clock: () => 0 });
    await session.run(sendCommand('op-1'));
    current = new ScriptedTransport(log, (command) => command === CONNECT ? agentError('DesignerAlreadyConnectedToInfoBase') : undefined);
    await session.run(sendCommand('op-2'));
    assert.deepStrictEqual(current.commands, [CONNECT, 'op-2']);
  });
});

suite('AgentInfoBaseSession: текстовый фолбэк распознавания ответов агента', () => {
  const already: readonly [string, boolean][] = [
    ['DesignerAlreadyConnectedToInfoBase', true],
    ['Database is already connected', true],
    ['Подключение уже установлено', true],
    ['Соединение с информационной базой уже было установлено', true],
    ['Подключение к базе уже было установлено ранее', true],
    ['Соединение разорвано', false],
  ];
  for (const [text, expected] of already) {
    test(`isInfoBaseAlreadyConnectedMessage(«${text}») = ${String(expected)}`, () => {
      assert.strictEqual(isInfoBaseAlreadyConnectedMessage(text), expected);
    });
  }

  const notConnected: readonly [string, boolean][] = [
    ['database is not connected', true],
    ['Конфигуратор не подключен к информационной базе', true],
    ['Соединение не установлено', true],
    ['Соединение с информационной базой не было установлено', true],
    ['Неизвестная ошибка', false],
  ];
  for (const [text, expected] of notConnected) {
    test(`isInfoBaseNotConnectedMessage(«${text}») = ${String(expected)}`, () => {
      assert.strictEqual(isInfoBaseNotConnectedMessage(text), expected);
    });
  }
});

const LOCK_TEXT = 'Ошибка блокировки информационной базы для конфигурирования';
const lockedError = (): AgentCommandError => agentError('DesignerAlreadyStarted', LOCK_TEXT);

/** Таймеры повтора: срабатывают сразу (микрозадачей) и сдвигают внедрённые часы на запрошенную задержку. */
class AutoTimers implements TimerApi {
  readonly delays: number[] = [];
  now = 0;
  setTimeout(callback: () => void | Promise<void>, ms: number): unknown {
    this.delays.push(ms);
    this.now += ms;
    void Promise.resolve().then(callback);
    return this.delays.length;
  }
  clearTimeout(): void { /* нечего снимать */ }
}

/** connect-ib отказывает с `failure` первые `times` раз (Infinity — всегда), затем отвечает успехом. */
function lockedConnect(times: number, failure: () => Error = lockedError): TransportBehavior {
  let left = times;
  return (command) => {
    if (command === CONNECT && left > 0) {
      left -= 1;
      return failure();
    }
    return undefined;
  };
}

function makeRetry(behavior: TransportBehavior, retry?: { windowMs: number; delaysMs: number[] }) {
  const factory = new ScriptedFactory(behavior);
  const timers = new AutoTimers();
  const session = new AgentInfoBaseSession(factory, {
    idleDisconnectMs: 0,
    timers,
    clock: () => timers.now,
    ...(retry ? { infoBaseLockRetry: retry } : {}),
  });
  return { factory, timers, session };
}

suite('isInfoBaseLockedByDesignerError: классификация блокировки ИБ', () => {
  test('error-type DesignerAlreadyStarted → true', () => {
    assert.strictEqual(isInfoBaseLockedByDesignerError(lockedError()), true);
  });

  for (const errorType of ['DesignerAlreadyConnectedToInfoBase', 'UnknownError']) {
    test(`иной error-type ${errorType}, даже с текстом блокировки → false (машинный код авторитетен)`, () => {
      assert.strictEqual(isInfoBaseLockedByDesignerError(agentError(errorType, LOCK_TEXT)), false);
    });
  }

  test('без error-type: текст с лишними пробелами, переводом строки и другим регистром → true', () => {
    const error = new AgentCommandError('ОШИБКА  блокировки\nинформационной базы для конфигурирования', 'cmd');
    assert.strictEqual(isInfoBaseLockedByDesignerError(error), true);
  });

  test('обычный Error с текстом блокировки (фолбэк по тексту) → true', () => {
    assert.strictEqual(isInfoBaseLockedByDesignerError(new Error(LOCK_TEXT)), true);
  });

  test('Error с посторонним текстом → false', () => {
    assert.strictEqual(isInfoBaseLockedByDesignerError(new Error('другое')), false);
  });

  test('не-Error значение (строка) классифицируется по тексту', () => {
    assert.strictEqual(isInfoBaseLockedByDesignerError(LOCK_TEXT), true);
    assert.strictEqual(isInfoBaseLockedByDesignerError('что-то иное'), false);
  });
});

suite('AgentInfoBaseSession: повтор connect-ib при блокировке ИБ', () => {
  test('два отказа DesignerAlreadyStarted и успех: ровно 3 connect-ib, задержки [500, 1000], одно сообщение «База занята»', async () => {
    const { session, factory, timers } = makeRetry(lockedConnect(2));
    const messages: string[] = [];
    const result = await session.run(async (exec) => { await exec.execute('op'); return 7; }, { onMessage: (m) => messages.push(m) });
    assert.strictEqual(result, 7);
    assert.strictEqual(factory.count(CONNECT), 3);
    assert.deepStrictEqual(timers.delays, [500, 1_000]);
    assert.strictEqual(factory.log.at(-1), 'op');
    assert.strictEqual(messages.filter((m) => m.includes('База занята')).length, 1);
    assert.strictEqual(session.isInfoBaseConnected(), true);
  });

  test('отказы до конца окна: AgentInfoBaseLockedError с описанием, waitedMs, сброс транспорта, база не подключена', async () => {
    const { session, factory, timers } = makeRetry(lockedConnect(Infinity));
    await assert.rejects(
      session.run(sendCommand('op')),
      (error: unknown) => {
        assert.ok(error instanceof AgentInfoBaseLockedError);
        assert.ok(error instanceof AgentCommandError);
        assert.strictEqual(error.command, CONNECT);
        assert.strictEqual(error.finalMessage?.['error-type'], 'DesignerAlreadyStarted');
        assert.strictEqual(error.waitedMs, 13_500);
        assert.ok(error.message.includes('1cestart.exe'), error.message);
        assert.ok(error.message.includes(LOCK_TEXT), error.message);
        return true;
      }
    );
    // 0,5 + 1 + 2×6 с = 13,5 с; следующая пауза 2 с вышла бы за окно 15 с.
    assert.deepStrictEqual(timers.delays, [500, 1_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000]);
    assert.strictEqual(factory.count(CONNECT), 9);
    assert.ok(factory.resetCount >= 1, 'транспорт сброшен');
    assert.strictEqual(session.isInfoBaseConnected(), false);
    assert.ok(!factory.log.includes('op'));
  });

  test('без error-type (фолбэк по тексту) за окном: AgentInfoBaseLockedError без finalMessage', async () => {
    const { session } = makeRetry(lockedConnect(Infinity, () => new Error(LOCK_TEXT)));
    await assert.rejects(
      session.run(sendCommand('op')),
      (error: unknown) => error instanceof AgentInfoBaseLockedError && error.finalMessage === undefined && error.message.includes(LOCK_TEXT)
    );
  });

  test('прочая ошибка connect-ib (UnknownError): без повторов, исходная ошибка', async () => {
    const original = agentError('UnknownError', 'сбой');
    const { session, factory, timers } = makeRetry(lockedConnect(1, () => original));
    await assert.rejects(session.run(sendCommand('op')), (error: unknown) => error === original);
    assert.strictEqual(factory.count(CONNECT), 1);
    assert.deepStrictEqual(timers.delays, []);
  });

  test('DesignerAlreadyConnectedToInfoBase после одного DesignerAlreadyStarted → подключено', async () => {
    let calls = 0;
    const { session, factory } = makeRetry((command) => {
      if (command !== CONNECT) { return undefined; }
      calls += 1;
      return calls === 1 ? lockedError() : agentError('DesignerAlreadyConnectedToInfoBase');
    });
    await session.run(sendCommand('op'));
    assert.strictEqual(factory.count(CONNECT), 2);
    assert.strictEqual(session.isInfoBaseConnected(), true);
  });

  test('отмена: после первого отказа сразу исходная ошибка, таймер не взведён', async () => {
    const { session, factory, timers } = makeRetry(lockedConnect(Infinity));
    await assert.rejects(
      session.run(sendCommand('op'), { cancellation: { isCancellationRequested: true } }),
      (error: unknown) => error instanceof AgentCommandError && !(error instanceof AgentInfoBaseLockedError) && error.finalMessage?.['error-type'] === 'DesignerAlreadyStarted'
    );
    assert.strictEqual(factory.count(CONNECT), 1);
    assert.deepStrictEqual(timers.delays, []);
  });

  test('reconnectInfoBase тоже повторяет', async () => {
    const { session, factory, timers } = makeRetry(lockedConnect(1));
    await session.reconnectInfoBase();
    assert.strictEqual(factory.count(CONNECT), 2);
    assert.deepStrictEqual(timers.delays, [500]);
    assert.strictEqual(session.isInfoBaseConnected(), true);
  });

  test('пользовательские опции окна: короткое окно — быстрый отказ', async () => {
    const { session, factory, timers } = makeRetry(lockedConnect(Infinity), { windowMs: 1_000, delaysMs: [600] });
    await assert.rejects(session.run(sendCommand('op')), AgentInfoBaseLockedError);
    assert.deepStrictEqual(timers.delays, [600]);
    assert.strictEqual(factory.count(CONNECT), 2);
  });

  test('очередь: вторая run, поставленная во время ожидания повтора, выполняется после первой', async () => {
    const factory = new ScriptedFactory(lockedConnect(1));
    const timers = new FakeTimers();
    const session = new AgentInfoBaseSession(factory, { idleDisconnectMs: 0, timers, clock: () => 0 });
    const first = session.run(sendCommand('first'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(timers.pending.size, 1, 'первая операция ждёт повтора');
    const second = session.run(sendCommand('second'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(factory.log, [CONNECT]);
    await timers.fireAll();
    await Promise.all([first, second]);
    assert.deepStrictEqual(factory.log, [CONNECT, CONNECT, 'first', 'second']);
  });
});

suite('AgentOperationService: infoBaseLockRetry пробрасывается в сессию', () => {
  test('короткое окно из опций → быстрый отказ AgentInfoBaseLockedError', async () => {
    const factory = new ScriptedFactory(lockedConnect(Infinity));
    const timers = new AutoTimers();
    const service = new AgentOperationService(
      os.tmpdir(),
      factory,
      { timers, clock: () => timers.now, infoBaseLockRetry: { windowMs: 1_000, delaysMs: [600] } }
    );
    await assert.rejects(service.reconnectInfoBase(), AgentInfoBaseLockedError);
    assert.strictEqual(factory.count(CONNECT), 2);
    assert.deepStrictEqual(timers.delays, [600]);
  });
});
