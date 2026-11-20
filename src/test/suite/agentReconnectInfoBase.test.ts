/**
 * `exec.reconnectInfoBase()` внутри операции (plan-remote-extensions §3.2, правило Э28: перед повторной
 * загрузкой в имя после сбоя/удаления — переподключение ИБ на ТОМ ЖЕ транспорте):
 * `disconnect-ib` (ответ «не подключено» проглатывается) и `connect-ib` с повтором блокировки базы.
 */
import * as assert from 'assert';
import { AgentCommandError, AgentInfoBaseSession, type TimerApi } from '../../infra/agent';
import { ScriptedFactory, agentError, type TransportBehavior } from './support/agentInfoBaseFakes';

const CONNECT = 'common connect-ib';
const DISCONNECT = 'common disconnect-ib';
const LOCK_TEXT = 'Ошибка блокировки информационной базы для конфигурирования';

/** Таймеры повтора срабатывают сразу и сдвигают внедрённые часы на запрошенную задержку. */
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

function make(behavior?: TransportBehavior) {
  const factory = new ScriptedFactory(behavior);
  const timers = new AutoTimers();
  const session = new AgentInfoBaseSession(factory, { idleDisconnectMs: 0, timers, clock: () => timers.now });
  return { factory, timers, session };
}

suite('AgentInfoBaseSession: exec.reconnectInfoBase', () => {
  test('порядок команд: connect-ib (вход операции), disconnect-ib, connect-ib, затем команда; транспорт тот же', async () => {
    const { factory, session } = make();

    await session.run(async (exec) => {
      await exec.reconnectInfoBase();
      await exec.execute('config op');
    });

    assert.deepStrictEqual(factory.log, [CONNECT, DISCONNECT, CONNECT, 'config op']);
    assert.strictEqual(factory.createCount, 1, 'переподключение ИБ не пересоздаёт SSH-транспорт');
    assert.strictEqual(session.isInfoBaseConnected(), true);
  });

  test('«не подключено» на disconnect-ib проглатывается: connect-ib выполняется, ошибки нет', async () => {
    const { factory, session } = make((command) => (command === DISCONNECT ? agentError('DesignerNotConnectedToInfoBase') : undefined));

    await session.run(async (exec) => { await exec.reconnectInfoBase(); });

    assert.deepStrictEqual(factory.log, [CONNECT, DISCONNECT, CONNECT]);
    assert.strictEqual(session.isInfoBaseConnected(), true);
  });

  test('блокировка базы на connect-ib при переподключении: повтор по политике (задержки 500, 1000), затем успех', async () => {
    let connects = 0;
    const { factory, timers, session } = make((command) => {
      if (command !== CONNECT) {
        return undefined;
      }
      connects += 1;
      // Первый connect-ib (вход операции) проходит; второй и третий — база занята Конфигуратором.
      return connects === 2 || connects === 3 ? agentError('DesignerAlreadyStarted', LOCK_TEXT) : undefined;
    });

    await session.run(async (exec) => {
      await exec.reconnectInfoBase();
      await exec.execute('config op');
    });

    assert.strictEqual(factory.count(CONNECT), 4);
    assert.deepStrictEqual(timers.delays, [500, 1_000]);
    assert.strictEqual(factory.log.at(-1), 'config op');
  });

  test('иной отказ connect-ib при переподключении → операция падает, база считается неподключённой', async () => {
    let connects = 0;
    const { session } = make((command) => {
      if (command !== CONNECT) {
        return undefined;
      }
      connects += 1;
      return connects === 2 ? agentError('InfoBaseNotFound', 'нет такой базы') : undefined;
    });

    await assert.rejects(
      session.run(async (exec) => { await exec.reconnectInfoBase(); }),
      (error: unknown) => error instanceof AgentCommandError && error.finalMessage?.['error-type'] === 'InfoBaseNotFound'
    );
    assert.strictEqual(session.isInfoBaseConnected(), false);
  });
  test('иной отказ disconnect-ib при переподключении (не «не подключено») → операция падает, connect-ib не отправлен', async () => {
    const { factory, session } = make((command) => (command === DISCONNECT ? agentError('UnknownError', 'агент сломан') : undefined));

    await assert.rejects(
      session.run(async (exec) => { await exec.reconnectInfoBase(); }),
      (error: unknown) => error instanceof AgentCommandError && error.finalMessage?.['error-type'] === 'UnknownError'
    );
    assert.strictEqual(factory.count(CONNECT), 1, 'повторного connect-ib после отказа отключения нет');
    assert.strictEqual(session.isInfoBaseConnected(), false);
  });
});
