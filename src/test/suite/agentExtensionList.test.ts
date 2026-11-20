/**
 * Список расширений базы через агента и guard применения (infra/agent/extensions/AgentExtensionList.ts).
 *
 *  - `properties get --all-extensions` ВСЕГДА со сроком (`AGENT_SHORT_COMMAND_DEADLINE_MS`): зависание агента
 *    (ФАКТ Э29, П2) распознаётся только по сроку короткой команды;
 *  - результат отсортирован `compareExtensionNames`, заглушки остаются в списке (делит их адаптер UI);
 *  - ответ без body — `ExtensionPropertiesFormatError` (fail closed);
 *  - guard `requireExtensionInDatabase`: агент на `update-db-cfg --extension=<нет>` отвечает успехом молча (Э28),
 *    поэтому наличие проверяется заранее (E6); заглушка — «есть».
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExtensionPropertiesFormatError } from '../../domain/agent';
import { AgentConnectionLostError } from '../../infra/agent';
import type { AgentCommandExecutor } from '../../infra/agent/AgentInfoBaseSession';
import {
  AGENT_SHORT_COMMAND_DEADLINE_MS,
  listDatabaseExtensions,
  requireExtensionInDatabase,
} from '../../infra/agent/extensions/AgentExtensionList';
import { AgentConfigEmulator } from './support/agentConfigEmulator';
import { PROPERTIES_GET_ALL, ZERO_HASH } from './support/agentExtensionsEmulator';
import { EmulatorExecutor } from './support/agentExtensionsStands';
import { removeTreeSync } from './support/tempTree';

suite('AgentExtensionList: список расширений базы и guard применения', () => {
  let userRoot: string;
  let emulator: AgentConfigEmulator;
  let exec: EmulatorExecutor;

  setup(() => {
    userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-ext-list-'));
    emulator = new AgentConfigEmulator(userRoot);
    exec = new EmulatorExecutor(emulator);
  });
  teardown(() => { removeTreeSync(userRoot); });

  test('срок команды: константа положительна, список запрашивается ТОЛЬКО --all-extensions и со сроком', async () => {
    const deadline: number = AGENT_SHORT_COMMAND_DEADLINE_MS;
    assert.ok(deadline > 0 && deadline <= 60_000);
    await listDatabaseExtensions(exec);
    assert.deepStrictEqual(exec.log, [PROPERTIES_GET_ALL]);
    assert.deepStrictEqual(exec.deadlines, [AGENT_SHORT_COMMAND_DEADLINE_MS]);
  });

  test('пустая база → []', async () => {
    assert.deepStrictEqual(await listDatabaseExtensions(exec), []);
  });

  test('несколько расширений → отсортированы по compareExtensionNames, поля разобраны', async () => {
    emulator.extensions.addExtension('Вторая', 'p2', { purpose: 'patch' });
    emulator.extensions.addExtension('арбуз', 'p1');
    emulator.extensions.addExtension('Банан', 'p3');

    const infos = await listDatabaseExtensions(exec);

    assert.deepStrictEqual(infos.map((info) => info.name), ['арбуз', 'Банан', 'Вторая']);
    assert.strictEqual(infos[2].purpose, 'patch');
    assert.strictEqual(infos[0].active, true);
    assert.strictEqual(infos[0].safeMode, false);
  });

  test('заглушки остаются в списке, их хеш — нулевой', async () => {
    emulator.extensions.addExtension('Применённое');
    emulator.extensions.addStub('Заглушка');
    const infos = await listDatabaseExtensions(exec);
    assert.deepStrictEqual(infos.map((info) => [info.name, info.hashSum === ZERO_HASH]), [['Заглушка', true], ['Применённое', false]]);
  });

  test('ответ без body → ExtensionPropertiesFormatError', async () => {
    const silent: AgentCommandExecutor = {
      execute: () => Promise.resolve({ messages: [{ type: 'success' }] }),
      reconnectInfoBase: () => Promise.resolve(),
    };
    await assert.rejects(listDatabaseExtensions(silent), ExtensionPropertiesFormatError);
  });

  test('зависание агента: ответа нет за срок → AgentConnectionLostError(no-response); команда без повтора', async () => {
    emulator.extensions.crashOn((command) => command.raw === PROPERTIES_GET_ALL, 'hang');

    await assert.rejects(
      listDatabaseExtensions(exec),
      (error: unknown) => error instanceof AgentConnectionLostError && error.lossKind === 'no-response'
    );
    assert.deepStrictEqual(exec.log, [PROPERTIES_GET_ALL], 'повтора по сроку нет');
  });

  test('обрыв канала на списке → AgentConnectionLostError(closed)', async () => {
    emulator.extensions.crashOn((command) => command.raw === PROPERTIES_GET_ALL, 'drop');
    await assert.rejects(
      listDatabaseExtensions(exec),
      (error: unknown) => error instanceof AgentConnectionLostError && error.lossKind === 'closed'
    );
  });

  test('requireExtensionInDatabase: расширения нет → ошибка E6, список запрошен, больше команд нет', async () => {
    emulator.extensions.addExtension('A');
    await assert.rejects(requireExtensionInDatabase(exec, 'X'), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('«X»') && error.message.includes('нет в базе') && error.message.includes('применять нечего'), error.message);
      return true;
    });
    assert.deepStrictEqual(exec.log, [PROPERTIES_GET_ALL]);
  });

  test('requireExtensionInDatabase: есть (другой регистр) и заглушка — проходит', async () => {
    emulator.extensions.addExtension('РасШ');
    emulator.extensions.addStub('Заглушка');
    await requireExtensionInDatabase(exec, 'расш');
    await requireExtensionInDatabase(exec, 'заглушка');
  });
});
