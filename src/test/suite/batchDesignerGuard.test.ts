/**
 * Э4: runWithInfoBaseReleased — единственная точка «отпустить базу перед пакетной операцией».
 *
 * Ожидаемый контракт (infra/agent/BatchDesignerGuard.ts, экспорт через infra/agent/index.ts):
 *   runWithInfoBaseReleased<T>(
 *     session: DesignerAgentInfoBaseSession | undefined,
 *     op: () => Promise<T>,
 *     options?: { hooks?: AgentOperationHooks; force?: boolean }
 *   ): Promise<T>
 *   - session === undefined → просто op;
 *   - disconnectInfoBase(hooks, { force }) вызывается ВСЕГДА до op: подключено ли — решает сама
 *     сессия в своей очереди (проверка снаружи гонялась бы с поставленным reconnect, ревью Э4 B4);
 *   - не подключено и без force → сессия возвращает false, агенту команд нет;
 *   - ошибка disconnect → op НЕ запускается, ошибка пробрасывается;
 *   - после op reconnectInfoBase НЕ вызывается (переподключение ленивое).
 */
import * as assert from 'assert';
import {
  AgentInfoBaseSession,
  runWithInfoBaseReleased,
  type AgentOperationHooks,
  type DesignerAgentInfoBaseSession,
} from '../../infra/agent';
import { FakeTimers, ScriptedFactory } from './support/agentInfoBaseFakes';

class RecordingSession implements DesignerAgentInfoBaseSession {
  readonly calls: string[] = [];
  forceSeen: (boolean | undefined)[] = [];
  hooksSeen: (AgentOperationHooks | undefined)[] = [];

  constructor(private connected: boolean, private readonly disconnectError?: Error) {}

  isInfoBaseConnected(): boolean {
    return this.connected;
  }

  disconnectInfoBase(hooks?: AgentOperationHooks, options?: { readonly force?: boolean }): Promise<boolean> {
    this.forceSeen.push(options?.force);
    this.hooksSeen.push(hooks);
    // Как настоящая сессия: без подключения и без force агенту ничего не отправляется.
    if (!this.connected && options?.force !== true) {
      return Promise.resolve(false);
    }
    this.calls.push('disconnect');
    if (this.disconnectError) {
      return Promise.reject(this.disconnectError);
    }
    this.connected = false;
    return Promise.resolve(true);
  }

  reconnectInfoBase(): Promise<void> {
    this.calls.push('reconnect');
    return Promise.resolve();
  }
}

suite('runWithInfoBaseReleased', () => {
  test('подключено: disconnect до операции, после операции reconnect не вызывается, результат возвращается', async () => {
    const session = new RecordingSession(true);
    const result = await runWithInfoBaseReleased(session, () => {
      session.calls.push('op');
      return Promise.resolve('готово');
    });
    assert.strictEqual(result, 'готово');
    assert.deepStrictEqual(session.calls, ['disconnect', 'op']);
  });

  test('не подключено и без force: решение за сессией (без force), команд агенту нет, операция выполняется', async () => {
    const session = new RecordingSession(false);
    await runWithInfoBaseReleased(session, () => { session.calls.push('op'); return Promise.resolve(); });
    assert.deepStrictEqual(session.calls, ['op']);
    assert.deepStrictEqual(session.forceSeen, [undefined]);
  });

  test('force при «не подключено» (внешний агент после перезапуска VS Code): disconnect с force=true', async () => {
    const session = new RecordingSession(false);
    await runWithInfoBaseReleased(session, () => { session.calls.push('op'); return Promise.resolve(); }, { force: true });
    assert.deepStrictEqual(session.calls, ['disconnect', 'op']);
    assert.deepStrictEqual(session.forceSeen, [true]);
  });

  test('подключено без force: disconnect не принудительный', async () => {
    const session = new RecordingSession(true);
    await runWithInfoBaseReleased(session, () => Promise.resolve());
    assert.notStrictEqual(session.forceSeen[0], true);
  });

  test('hooks доходят до disconnectInfoBase', async () => {
    const session = new RecordingSession(true);
    const hooks: AgentOperationHooks = { onMessage: () => undefined };
    await runWithInfoBaseReleased(session, () => Promise.resolve(), { hooks });
    assert.strictEqual(session.hooksSeen[0], hooks);
  });

  test('ошибка disconnect: пакетная операция НЕ запускается, ошибка пробрасывается', async () => {
    const session = new RecordingSession(true, new Error('канал мёртв'));
    let started = false;
    await assert.rejects(
      runWithInfoBaseReleased(session, () => { started = true; return Promise.resolve(); }),
      /канал мёртв/
    );
    assert.strictEqual(started, false);
  });

  test('ошибка операции пробрасывается как есть; reconnect не вызывается', async () => {
    const session = new RecordingSession(true);
    await assert.rejects(
      runWithInfoBaseReleased(session, () => Promise.reject(new Error('пакетная упала'))),
      /пакетная упала/
    );
    assert.ok(!session.calls.includes('reconnect'));
  });

  test('session === undefined (агентского режима нет): просто выполняет операцию', async () => {
    assert.strictEqual(await runWithInfoBaseReleased(undefined, () => Promise.resolve(7)), 7);
    assert.strictEqual(await runWithInfoBaseReleased(undefined, () => Promise.resolve(8), { force: true }), 8);
  });

  test('с настоящей AgentInfoBaseSession: disconnect-ib уходит до операции, connect-ib после неё не шлётся', async () => {
    const factory = new ScriptedFactory();
    const session = new AgentInfoBaseSession(factory, { idleDisconnectMs: 0, timers: new FakeTimers(), clock: () => 0 });
    await session.run((exec) => exec.execute('config update-db-cfg'));
    await runWithInfoBaseReleased(session, () => { factory.log.push('<batch>'); return Promise.resolve(); });
    assert.deepStrictEqual(factory.log, ['common connect-ib', 'config update-db-cfg', 'common disconnect-ib', '<batch>']);
    assert.strictEqual(session.isInfoBaseConnected(), false);
  });

  test('B4: release одновременно с поставленным в очередь reconnect — disconnect-ib уходит ПОСЛЕ connect-ib', async () => {
    const factory = new ScriptedFactory();
    const session = new AgentInfoBaseSession(factory, { idleDisconnectMs: 0, timers: new FakeTimers(), clock: () => 0 });
    // Так переподключается база после закрытия интерактивного Конфигуратора (ReconnectOnceHandler).
    const reconnect = session.reconnectInfoBase();
    // На момент вызова база ещё не подключена: внешняя проверка isInfoBaseConnected() пропустила бы release.
    assert.strictEqual(session.isInfoBaseConnected(), false);
    const released = await runWithInfoBaseReleased(session, () => Promise.resolve('пакет'));
    await reconnect;
    assert.strictEqual(released, 'пакет');
    assert.deepStrictEqual(factory.log, ['common connect-ib', 'common disconnect-ib']);
    assert.strictEqual(session.isInfoBaseConnected(), false);
  });

  test('с настоящей сессией: не подключено → ни одной команды; force → disconnect-ib без кэша', async () => {
    const factory = new ScriptedFactory();
    const session = new AgentInfoBaseSession(factory, { idleDisconnectMs: 0, timers: new FakeTimers(), clock: () => 0 });
    await runWithInfoBaseReleased(session, () => Promise.resolve());
    assert.deepStrictEqual(factory.log, []);
    await runWithInfoBaseReleased(session, () => Promise.resolve(), { force: true });
    assert.deepStrictEqual(factory.log, ['common disconnect-ib']);
  });
});
