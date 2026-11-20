/**
 * Транспорт агента: все сообщения команды в ошибке, обрыв канала посреди команды и срок короткой команды
 * (plan-remote-extensions §3.2, ФАКТ Э29, П2).
 *
 *  - `AgentCommandError.messages` — ВСЕ сообщения команды (`log`-строки перед `error`): по ним пустой
 *    `UnknownError` получает человеческий текст (`describeAgentCommandFailure`);
 *  - обрыв канала (`close`/`error` посреди команды) — `AgentConnectionLostError('closed'|'error')`, текст
 *    начинается фразой «SSH-соединение с агентом закрыто» (без выдуманного кода) и говорит про аварийное завершение;
 *  - зависание (процесс жив, ответа и `close` нет — ФАКТ Э29) распознаётся ТОЛЬКО по сроку короткой команды:
 *    `deadlineMs` → `AgentConnectionLostError('no-response')`, транспорт сброшен, следующая операция — на новом
 *    транспорте с `connect-ib`. Срок в тестах — малый, ответ «не приходит» никогда: результат не зависит от гонки.
 *  - ответ ДО срока снимает таймер: следующая команда без срока, отвечающая позже, не обрывается.
 */
import * as assert from 'assert';
import { EventEmitter } from 'events';
import type { ClientChannel } from 'ssh2';
import {
  AgentCommandError,
  AgentConnectionLostError,
  AgentInfoBaseSession,
  DesignerAgentSessionManager,
  ProcessDesignerAgentTransport,
  ProcessDesignerAgentTransportFactory,
  agentCommandVerb,
  describeAgentCommandFailure,
  type DesignerAgentSshClient,
} from '../../infra/agent';
import { FakeTimers } from './support/agentInfoBaseFakes';
import { AgentSshTestServer, neverAnswer } from './support/agentSshTestServer';

const OPTIONS_SET = 'options set --output-format=json --show-prompt=no --notify-progress=yes --notify-progress-interval=0.5';
const GET_ALL = 'config extensions properties get --all-extensions';

suite('describeAgentCommandFailure и agentCommandVerb (чистые)', () => {
  const unknownEmpty = { type: 'error' as const, 'error-type': 'UnknownError', message: '', body: [] };
  const withMessages = (...messages: { type: 'log' | 'error'; message?: string }[]): AgentCommandError =>
    new AgentCommandError('Ошибка агента: пустой ответ (UnknownError)', 'config load-cfg --file=x', unknownEmpty, [
      ...messages,
      unknownEmpty,
    ]);

  test('пустой UnknownError + log-строка → текст log-строки', () => {
    assert.strictEqual(describeAgentCommandFailure(withMessages({ type: 'log', message: 'Каталог не найден' })), 'Каталог не найден');
  });

  test('несколько log → последняя НЕПУСТАЯ (пустые и пробельные пропускаются)', () => {
    const error = withMessages(
      { type: 'log', message: 'первая' },
      { type: 'log', message: 'вторая, значимая' },
      { type: 'log', message: '' },
      { type: 'log', message: '   ' }
    );
    assert.strictEqual(describeAgentCommandFailure(error), 'вторая, значимая');
  });

  test('пустой UnknownError без log → E10: «ошибку без описания», UnknownError и глагол команды без аргументов', () => {
    const text = describeAgentCommandFailure(withMessages());
    assert.ok(text.includes('без описания') && text.includes('UnknownError'), text);
    assert.ok(text.includes('«config load-cfg»'), text);
    assert.ok(!text.includes('--file'), `аргументы и пути в текст не попадают: ${text}`);
  });

  test('UnknownError с НЕпустым message → message (log не подменяет текст агента)', () => {
    const final = { type: 'error' as const, 'error-type': 'UnknownError', message: 'Расширение с таким именем уже существует!', body: [] };
    const error = new AgentCommandError(final.message, 'config update-db-cfg', final, [{ type: 'log', message: 'шум' }, final]);
    assert.strictEqual(describeAgentCommandFailure(error), 'Расширение с таким именем уже существует!');
  });

  test('потеря связи с подробностью ssh2 → текст E1 сохраняет подробность (ECONNRESET)', () => {
    const text = describeAgentCommandFailure(new AgentConnectionLostError('config dump-cfg', 'error', 'read ECONNRESET'));
    assert.ok(text.includes('аварийно завершился') && text.includes('read ECONNRESET'), text);
  });

  test('обычная ошибка (не AgentCommandError) → её message', () => {
    assert.strictEqual(describeAgentCommandFailure(new Error('обычный сбой')), 'обычный сбой');
  });

  test('AgentCommandError без messages/finalMessage → message', () => {
    assert.strictEqual(describeAgentCommandFailure(new AgentCommandError('текст', 'cmd')), 'текст');
  });

  test('не-Error значение → строка', () => {
    assert.strictEqual(describeAgentCommandFailure('просто строка'), 'просто строка');
    assert.strictEqual(describeAgentCommandFailure(42), '42');
  });

  test('AgentCommandError: messages по умолчанию — пустой массив', () => {
    assert.deepStrictEqual(new AgentCommandError('m', 'c').messages, []);
  });

  const verbs: [string, string][] = [
    ['config load-cfg --file=exchange/cffile-p-1/payload.cfe --extension=Расш', 'config load-cfg'],
    ['config dump-cfg --file=exchange/x/payload.cf', 'config dump-cfg'],
    ['config update-db-cfg --extension="Моё расш"', 'config update-db-cfg'],
    [GET_ALL, 'config extensions properties get'],
    ['common connect-ib', 'common connect-ib'],
    ['options set --output-format=json', 'options set'],
  ];
  for (const [command, expected] of verbs) {
    test(`agentCommandVerb(${command}) = «${expected}» — без аргументов, путей и значений`, () => {
      assert.strictEqual(agentCommandVerb(command), expected);
    });
  }
});

suite('ProcessDesignerAgentTransport: сообщения команды, обрыв и срок (реальный ssh2)', function () {
  this.timeout(30_000);
  let server: AgentSshTestServer;
  let transport: ProcessDesignerAgentTransport | undefined;
  let sessions: DesignerAgentSessionManager | undefined;

  const endpoint = () => ({ host: '127.0.0.1', port: server.port, user: 'admin', password: 'secret', connectTimeoutSeconds: 5 });

  setup(async () => {
    server = await AgentSshTestServer.start();
  });

  teardown(async () => {
    await transport?.dispose();
    transport = undefined;
    await sessions?.disposeAll();
    sessions = undefined;
    await server.close();
  });

  async function connected(): Promise<ProcessDesignerAgentTransport> {
    transport = new ProcessDesignerAgentTransport({ ...endpoint(), shutdownOnDispose: false });
    await transport.connect();
    return transport;
  }

  test('AgentCommandError.messages: log-строки ПЕРЕД error приходят в ошибке, последнее сообщение — error', async () => {
    server.setShellResponder((line) => {
      if (line.startsWith('config load-cfg')) {
        return Promise.reject(Object.assign(new Error('boom'), {
          finalMessage: { type: 'error', 'error-type': 'UnknownError', message: '', body: [] },
          precedingMessages: [{ type: 'log', message: 'Не удалось прочитать файл' }, { type: 'log', message: 'Формат не поддерживается' }],
        }));
      }
      return Promise.resolve([]);
    });
    const t = await connected();

    await assert.rejects(t.execute('config load-cfg --file=x'), (error: unknown) => {
      assert.ok(error instanceof AgentCommandError);
      assert.deepStrictEqual(error.messages.map((message) => message.type), ['log', 'log', 'error']);
      assert.deepStrictEqual(error.messages.slice(0, 2).map((message) => message.message), ['Не удалось прочитать файл', 'Формат не поддерживается']);
      assert.strictEqual(error.finalMessage?.['error-type'], 'UnknownError');
      assert.strictEqual(describeAgentCommandFailure(error), 'Формат не поддерживается');
      return true;
    });
  });

  test('прежние сообщения ошибки без preceding: messages содержит только error', async () => {
    server.setShellResponder(() => Promise.reject(Object.assign(new Error('x'), { finalMessage: { type: 'error', message: 'Простой отказ' } })));
    const t = await connected();
    await assert.rejects(t.execute('config update-db-cfg'), (error: unknown) => {
      assert.ok(error instanceof AgentCommandError);
      assert.deepStrictEqual(error.messages.map((message) => message.type), ['error']);
      return true;
    });
  });

  test('обрыв канала во время команды → AgentConnectionLostError(closed): прежняя фраза, «аварийно», глагол команды', async () => {
    server.setShellResponder(() => {
      server.dropClients();
      return neverAnswer();
    });
    const t = await connected();

    await assert.rejects(t.execute('config dump-cfg --file=exchange/x/payload.cf'), (error: unknown) => {
      assert.ok(error instanceof AgentConnectionLostError);
      assert.strictEqual(error.lossKind, 'closed');
      assert.strictEqual(error.commandVerb, 'config dump-cfg');
      assert.ok(error.message.startsWith('SSH-соединение с агентом закрыто во время команды'), error.message);
      assert.ok(!error.message.includes('кодом'), `кода закрытия ssh2 не сообщает — числа в тексте нет: ${error.message}`);
      assert.ok(error.message.includes('аварийно'), error.message);
      assert.ok(error.message.includes('«config dump-cfg»'), error.message);
      assert.ok(!error.message.includes('exchange/x'), `пути в тексте нет: ${error.message}`);
      return true;
    });
    assert.strictEqual(t.isClosed(), true);
  });

  test('срок короткой команды: ответа нет → AgentConnectionLostError(no-response), транспорт закрыт', async () => {
    server.setShellResponder((line) => (line === GET_ALL ? neverAnswer() : Promise.resolve([])));
    const t = await connected();

    await assert.rejects(t.execute(GET_ALL, undefined, { deadlineMs: 50 }), (error: unknown) => {
      assert.ok(error instanceof AgentConnectionLostError);
      assert.strictEqual(error.lossKind, 'no-response');
      assert.strictEqual(error.commandVerb, 'config extensions properties get');
      return true;
    });
    assert.strictEqual(t.isClosed(), true);
  });

  test('после зависания следующая операция идёт новым транспортом: options set и connect-ib заново', async () => {
    server.setShellResponder((line) => (line === GET_ALL ? neverAnswer() : Promise.resolve([])));
    const factory = new ProcessDesignerAgentTransportFactory({
      ...endpoint(),
      shutdownOnDispose: false,
      policy: { startupTimeoutMs: 5_000, authWarmupMs: 0, retryDelayMs: 50 },
    });
    sessions = new DesignerAgentSessionManager(factory);
    const session = new AgentInfoBaseSession(sessions, { idleDisconnectMs: 0, timers: new FakeTimers(), clock: () => 0 });

    await assert.rejects(
      session.run((exec) => exec.execute(GET_ALL, { deadlineMs: 50 })),
      (error: unknown) => error instanceof AgentConnectionLostError && error.lossKind === 'no-response'
    );
    assert.strictEqual(session.isInfoBaseConnected(), false, 'после зависания база считается неподключённой');

    await session.run((exec) => exec.execute('config op-2'));

    assert.strictEqual(server.shellLog.length, 2, 'вторая операция — на НОВОМ соединении');
    assert.deepStrictEqual(server.shellLog[0].slice(0, 3), [OPTIONS_SET, 'common connect-ib', GET_ALL]);
    assert.deepStrictEqual(server.shellLog[1], [OPTIONS_SET, 'common connect-ib', 'config op-2']);
  });

  test('ответ до срока снимает таймер: следующая команда БЕЗ срока, отвечающая позже срока первой, не обрывается', async () => {
    server.setShellResponder(async (line) => {
      if (line === 'config slow') {
        // Запас под медленную машину (скрытый прогон под SYSTEM): срок первой команды 2 с, вторая отвечает через 2,5 с.
        await new Promise<void>((resolve) => setTimeout(resolve, 2_500));
      }
      return [];
    });
    const t = await connected();

    await t.execute('config fast', undefined, { deadlineMs: 2_000 });
    const slow = await t.execute('config slow');

    assert.strictEqual(slow.messages.at(-1)?.type, 'success');
    assert.strictEqual(t.isClosed(), false);
  });

  test('terminalTypes: одно extension-properties верхнего уровня без success завершает ответ (ФАКТ Э30–Э31)', async () => {
    const element = { type: 'extension-properties', body: { name: 'X', 'hash-sum': 'h' } };
    server.setShellResponder((line) => Promise.resolve(line === GET_ALL ? [element] : []));
    const t = await connected();

    const result = await t.execute(GET_ALL, undefined, { deadlineMs: 2_000, terminalTypes: ['extension-properties'] });
    const next = await t.execute('config op');

    assert.deepStrictEqual(result.messages.map((message) => message.type), ['extension-properties']);
    assert.strictEqual(next.messages.at(-1)?.type, 'success', 'агент исправен: следующая команда выполняется');
    assert.strictEqual(t.isClosed(), false);
  });

  test('команда без deadlineMs срока не имеет: медленный ответ приходит', async () => {
    server.setShellResponder(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      return [];
    });
    const t = await connected();
    const result = await t.execute('config slow');
    assert.strictEqual(result.messages.at(-1)?.type, 'success');
  });
});

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  write(): boolean { return true; }
  end(): this { return this; }
}

class SilentSshClient extends EventEmitter implements DesignerAgentSshClient {
  readonly channel = new FakeChannel();
  connect(): void { queueMicrotask(() => this.emit('ready')); }
  shell(_windows: false, callback: (error: Error | undefined, channel: ClientChannel) => void): void {
    callback(undefined, this.channel as unknown as ClientChannel);
  }
  end(): void { /* закрывать нечего */ }
}

suite('ProcessDesignerAgentTransport: error клиента посреди команды', () => {
  test('error SSH-клиента во время команды → AgentConnectionLostError(error), транспорт закрыт', async () => {
    const client = new SilentSshClient();
    const transport = new ProcessDesignerAgentTransport({ host: 'h', port: 1, user: 'u' }, () => client);
    await transport.connect();

    const pending = transport.execute('config load-cfg --file=x --extension=Расш');
    // Команда уходит в канал через очередь транспорта: ошибка клиента должна прийти ПОСЛЕ отправки команды.
    await new Promise<void>((resolve) => setImmediate(resolve));
    client.emit('error', new Error('read ECONNRESET'));

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof AgentConnectionLostError);
      assert.strictEqual(error.lossKind, 'error');
      assert.strictEqual(error.commandVerb, 'config load-cfg');
      assert.ok(error.message.includes('аварийно'), error.message);
      assert.ok(error.message.includes('ECONNRESET'), error.message);
      return true;
    });
    assert.strictEqual(transport.isClosed(), true);
  });
});
