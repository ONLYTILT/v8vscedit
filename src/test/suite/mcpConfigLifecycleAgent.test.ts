/**
 * MCP-инструменты `v8vscedit_dump_cf` / `v8vscedit_load_cf` / `v8vscedit_dump_all_cfe` / `v8vscedit_load_all_cfe`
 * в агентском режиме (plan-remote-extensions §5.3, §7.4: сценарии 61–65, 67). Параметризация `location`
 * (remote — RemoteHarness, local — реестр с эмулятором). Инструменты логики не дублируют: зовут те же раннеры.
 *
 *  - отказ раннера → исключение с `failureReason` ДОСЛОВНО (агент получает E1/E3/…, а не «смотрите журнал»);
 *  - `load_cf` нового расширения: `databaseConfigurationUpdated: true` и `createdInDatabase: true` БЕЗ applyToDatabase,
 *    повторного `update-db-cfg` при applyToDatabase нет;
 *  - `load_all_cfe` с applyToDatabase применяет ТОЛЬКО элементы без `appliedToDatabase` (журнал команд: нет второго
 *    update-db-cfg у новых); `abortReason` — исключение;
 *  - `dump_all_cfe`: частичный отказ — успех со списком `failed`; `abortReason` — исключение;
 *  - замок: при занятой конфигурации — прежний отказ MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE;
 *  - описания инструментов упоминают режим agent (страж от возврата старого текста).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { writeCfeManifest } from '../../infra/cfFile/CfeBatchManifest';
import { cfeFileNameForExtension } from '../../infra/cfFile/CfeBatchNaming';
import { registerConfigLifecycleTools } from '../../ui/mcp/registration/McpConfigLifecycleTools';
import { McpMutationGate } from '../../ui/mcp/registration/McpMutationGate';
import type { McpRegistrationDeps } from '../../ui/mcp/registration/McpRegistrationDeps';
import {
  MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE,
  endConfigurationOperation,
  tryBeginConfigurationOperation,
} from '../../ui/commands/ext/configurationOperationLock';
import { cfFile, cfeFile, emulatedFailure } from './support/agentExtensionsEmulator';
import { fakeExtra } from './support/mcpFakeExtra';
import { REMOTE_DB_PASSWORD, assertNoSecrets } from './support/agentRemoteHarness';
import { openLocal, openRemote, type UiStand } from './support/agentUiStands';

interface RegisteredTool {
  readonly description: string;
  readonly handler: (args: Record<string, unknown>, extra?: unknown) => unknown;
}

function createMockServer(): { tools: Map<string, RegisteredTool>; registerTool: (name: string, config: { description: string }, handler: RegisteredTool['handler']) => void } {
  const tools = new Map<string, RegisteredTool>();
  return {
    tools,
    registerTool: (name, config, handler) => { tools.set(name, { description: config.description, handler }); },
  };
}

const text = (result: unknown): string => {
  const part = (result as CallToolResult).content[0];
  return part.type === 'text' ? part.text : '';
};
const isError = (result: unknown): boolean => (result as CallToolResult).isError === true;
const parse = (result: unknown): Record<string, unknown> => {
  assert.ok(!isError(result), `ожидался успех, реально: ${text(result)}`);
  return JSON.parse(text(result)) as Record<string, unknown>;
};

const TOOLS = ['v8vscedit_dump_cf', 'v8vscedit_load_cf', 'v8vscedit_dump_all_cfe', 'v8vscedit_load_all_cfe'];

suite('MCP: описания инструментов CF/CFE упоминают агентский режим', () => {
  test('все четыре инструмента: «(режим batch)» и «агента конфигуратора (режим agent»; загрузки — про автоприменение нового расширения', () => {
    const server = createMockServer();
    registerConfigLifecycleTools(server as never, { services: {}, gate: new McpMutationGate({} as never) } as unknown as McpRegistrationDeps);
    for (const name of TOOLS) {
      const description = server.tools.get(name)?.description ?? '';
      assert.ok(description.includes('(режим batch)') && description.includes('агента конфигуратора (режим agent'), `${name}: ${description}`);
    }
    for (const name of ['v8vscedit_load_cf', 'v8vscedit_load_all_cfe']) {
      const description = server.tools.get(name)?.description ?? '';
      assert.ok(description.includes('сразу применя') && description.includes('НОВОЕ расширение'), `${name}: ${description}`);
    }
  });
});

for (const location of ['remote', 'local'] as const) {
  suite(`MCP CF/CFE-инструменты в агентском режиме [${location}]`, function () {
    this.timeout(120_000);
    let ui: UiStand;
    let server: ReturnType<typeof createMockServer>;

    setup(async () => {
      ui = location === 'remote' ? await openRemote() : await openLocal();
      server = createMockServer();
      registerConfigLifecycleTools(server as never, {
        services: { workspaceFolder: ui.folder, outputChannel: ui.channel },
        xmlEditor: {}, paths: {}, properties: {}, mutations: {},
        gate: new McpMutationGate({} as never),
      } as unknown as McpRegistrationDeps);
    });
    teardown(async () => {
      await endConfigurationOperation();
      await ui.dispose();
    });

    const call = (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const tool = server.tools.get(name);
      assert.ok(tool, `инструмент ${name} не зарегистрирован`);
      // Долгие инструменты обёрнуты в wrapLongRunning: ему нужен настоящий `extra` (signal, sendNotification).
      return Promise.resolve(tool.handler(args, fakeExtra()));
    };
    const file = (name: string, content: string): string => {
      const target = path.join(ui.workDir, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      return target;
    };
    const updates = (): string[] => ui.commandLog().filter((line) => line.startsWith('config update-db-cfg'));

    function writeCatalog(dir: string, names: { name: string; payload?: string }[]): void {
      fs.mkdirSync(dir, { recursive: true });
      const items = names.map((entry) => {
        const fileName = cfeFileNameForExtension(entry.name);
        const content = cfeFile(entry.name, entry.payload ?? 'п');
        fs.writeFileSync(path.join(dir, fileName), content);
        return { extensionName: entry.name, fileName, status: 'ok' as const, sizeBytes: Buffer.byteLength(content) };
      });
      writeCfeManifest(dir, { version: 1, createdAt: '2020-01-01T00:00:00.000Z', items });
    }

    // ── load_cf ─────────────────────────────────────────────────────────

    test('load_cf: новое расширение без applyToDatabase → databaseConfigurationUpdated:true, createdInDatabase:true; один update-db-cfg', async () => {
      const inputFile = file('Расш.cfe', cfeFile('Расш'));

      const data = parse(await call('v8vscedit_load_cf', { inputFile, extensionName: 'Расш', confirm: true }));

      assert.strictEqual(data.databaseConfigurationUpdated, true);
      assert.strictEqual(data.createdInDatabase, true);
      assert.strictEqual(data.projectSourcesOutdated, true);
      assert.strictEqual(updates().length, 1);
      assertNoSecrets(ui.everythingShown(), [REMOTE_DB_PASSWORD]);
    });

    test('load_cf: новое расширение + applyToDatabase:true → применение НЕ повторяется (по-прежнему один update-db-cfg)', async () => {
      const inputFile = file('Расш.cfe', cfeFile('Расш'));

      const data = parse(await call('v8vscedit_load_cf', { inputFile, extensionName: 'Расш', confirm: true, applyToDatabase: true }));

      assert.strictEqual(data.databaseConfigurationUpdated, true);
      assert.strictEqual(updates().length, 1);
    });

    test('load_cf: расширение под другим внутренним именем → extensionNameInDatabase и warnings в ответе', async () => {
      const inputFile = file('X.cfe', cfeFile('Z'));

      const data = parse(await call('v8vscedit_load_cf', { inputFile, extensionName: 'X', confirm: true }));

      assert.strictEqual(data.extensionNameInDatabase, 'Z');
      assert.ok(Array.isArray(data.warnings) && (data.warnings as string[]).some((warning) => warning.includes('«Z»')), JSON.stringify(data.warnings));
    });

    test('load_cf: существующее расширение + applyToDatabase:true → применяется отдельным шагом (guard: список перед update)', async () => {
      ui.emulator.extensions.addExtension('Расш', 'старое');
      const inputFile = file('Расш.cfe', cfeFile('Расш', 'новое'));

      const data = parse(await call('v8vscedit_load_cf', { inputFile, extensionName: 'Расш', confirm: true, applyToDatabase: true }));

      assert.strictEqual(data.databaseConfigurationUpdated, true);
      assert.notStrictEqual(data.createdInDatabase, true);
      assert.strictEqual(ui.emulator.extensions.payloadOf('Расш'), 'новое');
      assert.strictEqual(updates().length, 1);
    });

    test('load_cf: отказ раннера → isError, сообщение = failureReason дословно (текст агента из log)', async () => {
      ui.emulator.extensions.emptyUnknownErrorOn((command) => command.command === 'config load-cfg', 'Файл расширения повреждён');
      const inputFile = file('Расш.cfe', cfeFile('Расш'));

      const result = await call('v8vscedit_load_cf', { inputFile, extensionName: 'Расш', confirm: true });

      assert.ok(isError(result));
      assert.ok(text(result).includes('Файл расширения повреждён'), text(result));
      assert.ok(text(result).includes('неопределённо'), text(result));
      assert.deepStrictEqual(ui.errors, [], 'MCP silent: раннер не показывает всплывающих окон');
    });

    test('load_cf: основная конфигурация — поля createdInDatabase/extensionNameInDatabase не заданы', async () => {
      const data = parse(await call('v8vscedit_load_cf', { inputFile: file('main.cf', cfFile('м')), confirm: true }));
      assert.notStrictEqual(data.createdInDatabase, true);
      assert.strictEqual(data.extensionNameInDatabase, undefined);
      assert.strictEqual(data.databaseConfigurationUpdated, false);
    });

    test('load_cf: основная конфигурация + applyToDatabase:true → применение отдельным шагом (update-db-cfg без --extension)', async () => {
      const data = parse(await call('v8vscedit_load_cf', { inputFile: file('main.cf', cfFile('м')), confirm: true, applyToDatabase: true }));
      assert.strictEqual(data.databaseConfigurationUpdated, true);
      assert.deepStrictEqual(updates(), ['config update-db-cfg']);
    });

    // ── dump_cf ─────────────────────────────────────────────────────────

    test('dump_cf: отказ E3 (заглушка) приходит агенту ДОСЛОВНО', async () => {
      ui.emulator.extensions.addStub('Заглушка');

      const result = await call('v8vscedit_dump_cf', { outputFile: path.join(ui.workDir, 'З.cfe'), extensionName: 'Заглушка' });

      assert.ok(isError(result));
      assert.ok(text(result).includes('«Заглушка»') && text(result).includes('не применено') && text(result).includes('выгружать нельзя'), text(result));
      assert.ok(!text(result).includes('Подробности — в журнале'), `не прежняя отписка: ${text(result)}`);
      assert.deepStrictEqual(ui.errors, [], 'MCP silent: раннер не показывает всплывающих окон');
    });

    test('dump_cf: успех — файл создан, ответ прежней формы', async () => {
      ui.emulator.extensions.addExtension('Расш', 'п');
      const outputFile = path.join(ui.workDir, 'Расш.cfe');

      const data = parse(await call('v8vscedit_dump_cf', { outputFile, extensionName: 'Расш' }));

      assert.strictEqual(data.outputFile, outputFile);
      assert.strictEqual(data.extensionName, 'Расш');
      assert.ok(fs.existsSync(outputFile));
    });

    // ── load_all_cfe ────────────────────────────────────────────────────

    test('load_all_cfe + applyToDatabase: применяются только элементы без appliedToDatabase; у новых нет второго update-db-cfg', async () => {
      ui.emulator.extensions.addExtension('Старое', 'старое');
      const inputDir = path.join(ui.workDir, 'вход');
      writeCatalog(inputDir, [{ name: 'Старое', payload: 'новое-старое' }, { name: 'Новое', payload: 'н' }]);

      const data = parse(await call('v8vscedit_load_all_cfe', { inputDir, confirm: true, createMissing: true, applyToDatabase: true }));

      assert.deepStrictEqual((data.loaded as string[]).slice().sort(), ['Новое', 'Старое']);
      assert.deepStrictEqual(data.appliedAutomatically, ['Новое']);
      assert.deepStrictEqual(data.applied, ['Старое']);
      assert.deepStrictEqual(
        updates().map((line) => line.replace('config update-db-cfg --extension=', '')).sort(),
        ['Новое', 'Старое'],
        'по одному update-db-cfg на расширение'
      );
    });

    test('load_all_cfe: обрыв агента (abortReason) → исключение с причиной', async () => {
      const inputDir = path.join(ui.workDir, 'вход');
      writeCatalog(inputDir, [{ name: 'Новое' }]);
      ui.emulator.extensions.crashOn((command) => command.command === 'config load-cfg', 'drop');

      const result = await call('v8vscedit_load_all_cfe', { inputDir, confirm: true, createMissing: true });

      assert.ok(isError(result));
      assert.ok(text(result).includes('аварийно завершился') || text(result).includes('остановлена'), text(result));
    });

    test('load_all_cfe: verificationWarnings попадают в ответ', async () => {
      const inputDir = path.join(ui.workDir, 'вход');
      fs.mkdirSync(inputDir, { recursive: true });
      const fileName = cfeFileNameForExtension('Новое');
      const content = cfeFile('Другое');
      fs.writeFileSync(path.join(inputDir, fileName), content);
      writeCfeManifest(inputDir, { version: 1, createdAt: '2020-01-01T00:00:00.000Z', items: [{ extensionName: 'Новое', fileName, status: 'ok', sizeBytes: Buffer.byteLength(content) }] });

      const data = parse(await call('v8vscedit_load_all_cfe', { inputDir, confirm: true, createMissing: true }));

      assert.ok(Array.isArray(data.verificationWarnings) && (data.verificationWarnings as string[]).some((warning) => warning.includes('«Другое»')), JSON.stringify(data.verificationWarnings));
    });

    test('load_cf: существующее расширение под другим внутренним именем + applyToDatabase → E11 сверки применения в warnings', async () => {
      ui.emulator.extensions.addExtension('Расш', 'старое');
      const inputFile = file('Расш.cfe', cfeFile('Другое', 'новое'));

      const data = parse(await call('v8vscedit_load_cf', { inputFile, extensionName: 'Расш', confirm: true, applyToDatabase: true }));

      assert.strictEqual(data.databaseConfigurationUpdated, true);
      assert.ok(Array.isArray(data.warnings) && (data.warnings as string[]).some((warning) => warning.includes('«Другое»') && warning.includes('«Расш»')), JSON.stringify(data.warnings));
      assert.ok(!ui.warnings.some((warning) => warning.includes('«Другое»')), 'MCP silent: E11 — в ответе, без уведомления');
    });

    test('load_all_cfe + applyToDatabase: E11 сверки применения существующего — в warnings ответа', async () => {
      ui.emulator.extensions.addExtension('Старое', 'с');
      const inputDir = path.join(ui.workDir, 'вход');
      fs.mkdirSync(inputDir, { recursive: true });
      const fileName = cfeFileNameForExtension('Старое');
      const content = cfeFile('Переименованное', 'н');
      fs.writeFileSync(path.join(inputDir, fileName), content);
      writeCfeManifest(inputDir, { version: 1, createdAt: '2020-01-01T00:00:00.000Z', items: [{ extensionName: 'Старое', fileName, status: 'ok', sizeBytes: Buffer.byteLength(content) }] });

      const data = parse(await call('v8vscedit_load_all_cfe', { inputDir, confirm: true, applyToDatabase: true }));

      assert.ok(Array.isArray(data.warnings) && (data.warnings as string[]).some((warning) => warning.includes('«Переименованное»')), JSON.stringify(data.warnings));
    });

    test('load_all_cfe: остановка на сбое ПОСЛЕ применённого нового (failedAt) → сообщение перечисляет уже применённые, без «не обновлялась»', async () => {
      const inputDir = path.join(ui.workDir, 'вход');
      writeCatalog(inputDir, [{ name: 'Альфа' }, { name: 'Бета' }]);
      ui.emulator.extensions.emptyUnknownErrorOn(
        (command) => command.command === 'config load-cfg' && command.options.extension === 'Бета',
        'Файл повреждён'
      );

      const result = await call('v8vscedit_load_all_cfe', { inputDir, confirm: true, createMissing: true });

      assert.ok(isError(result));
      assert.ok(text(result).includes('Уже созданы в базе и применены') && text(result).includes('Альфа'), text(result));
      assert.ok(!text(result).includes('не обновлялась'), text(result));
    });

    test('load_all_cfe: остановка на первом же (failedAt) без применённых → прежняя фраза «не обновлялась»', async () => {
      ui.emulator.extensions.addExtension('Альфа');
      const inputDir = path.join(ui.workDir, 'вход');
      writeCatalog(inputDir, [{ name: 'Альфа' }]);
      ui.emulator.extensions.emptyUnknownErrorOn((command) => command.command === 'config load-cfg', 'Файл повреждён');

      const result = await call('v8vscedit_load_all_cfe', { inputDir, confirm: true });

      assert.ok(isError(result));
      assert.ok(text(result).includes('конфигурация базы не обновлялась'), text(result));
    });

    test('load_all_cfe + applyToDatabase: отказ применения существующего → isError «применение к базе не выполнено»', async () => {
      ui.emulator.extensions.addExtension('Старое', 'с');
      const inputDir = path.join(ui.workDir, 'вход');
      writeCatalog(inputDir, [{ name: 'Старое', payload: 'н' }]);
      ui.emulator.extensions.failOn((command) => command.command === 'config update-db-cfg', emulatedFailure('UnknownError', 'Ошибка применения'));

      const result = await call('v8vscedit_load_all_cfe', { inputDir, confirm: true, applyToDatabase: true });

      assert.ok(isError(result));
      assert.ok(text(result).includes('применение к базе не выполнено на "Старое"'), text(result));
    });

    test('load_all_cfe: обрыв ПОСЛЕ применённых новых (abortReason) → в исключении перечислены уже применённые', async () => {
      const inputDir = path.join(ui.workDir, 'вход');
      writeCatalog(inputDir, [{ name: 'Альфа' }, { name: 'Бета' }, { name: 'Гамма' }]);
      ui.emulator.extensions.crashOn((command) => command.command === 'config load-cfg' && command.options.extension === 'Гамма', 'drop');

      const result = await call('v8vscedit_load_all_cfe', { inputDir, confirm: true, createMissing: true });

      assert.ok(isError(result));
      assert.ok(text(result).includes('аварийно завершился'), text(result));
      assert.ok(text(result).includes('Уже созданы в базе и применены') && text(result).includes('Альфа, Бета'), text(result));
    });

    test('update_database_configuration: применение расширения, загруженного файлом с другим внутренним именем → E11 в warnings', async () => {
      ui.emulator.extensions.addExtension('Расш', 'старое');
      parse(await call('v8vscedit_load_cf', { inputFile: file('Z.cfe', cfeFile('Другое', 'новое')), extensionName: 'Расш', confirm: true }));
      const extensionRoot = path.join(ui.folder.uri.fsPath, 'src', 'cfe', 'Расш');
      const node = { nodeKind: 'extension', label: 'Расш', xmlPath: path.join(extensionRoot, 'Configuration.xml') };
      const updateServer = createMockServer();
      registerConfigLifecycleTools(updateServer as never, {
        services: {
          workspaceFolder: ui.folder,
          outputChannel: ui.channel,
          repositoryService: { resolveTargetByConfigRoot: () => undefined },
        },
        xmlEditor: {}, properties: {}, mutations: {},
        paths: { resolveNode: () => node },
        gate: new McpMutationGate({} as never),
      } as unknown as McpRegistrationDeps);
      const tool = updateServer.tools.get('v8vscedit_update_database_configuration');
      assert.ok(tool);

      const data = parse(await Promise.resolve(tool.handler({ path: 'Расширение.Расш' }, fakeExtra())));

      assert.strictEqual(data.databaseConfigurationUpdated, true);
      assert.ok(Array.isArray(data.warnings) && (data.warnings as string[]).some((warning) => warning.includes('«Другое»') && warning.includes('«Расш»')), JSON.stringify(data));
      assert.ok(!ui.warnings.some((warning) => warning.includes('«Другое»')), 'MCP: предупреждения — в ответе, без уведомлений');
    });

    test('load_all_cfe: отказ агента до отчёта (список расширений) → isError с причиной агента дословно', async () => {
      const inputDir = path.join(ui.workDir, 'вход');
      writeCatalog(inputDir, [{ name: 'Новое' }]);
      ui.emulator.extensions.emptyUnknownErrorOn((command) => command.command === 'config extensions', 'Нет прав на список расширений');

      const result = await call('v8vscedit_load_all_cfe', { inputDir, confirm: true, createMissing: true });

      assert.ok(isError(result));
      assert.ok(text(result).includes('Нет прав на список расширений'), text(result));
      assert.ok(!text(result).includes('Подробности — в журнале'), text(result));
    });

    // ── dump_all_cfe ────────────────────────────────────────────────────

    test('dump_all_cfe: частичный отказ — УСПЕХ со списком failed (прежний контракт)', async () => {
      ui.emulator.extensions.addExtension('Альфа', 'a');
      ui.emulator.extensions.addExtension('Бета', 'b');
      ui.emulator.extensions.emptyUnknownErrorOn((command) => command.command === 'config dump-cfg' && command.options.extension === 'Бета', 'Объект занят');
      const outputDir = path.join(ui.workDir, 'выход');
      fs.mkdirSync(outputDir, { recursive: true });

      const data = parse(await call('v8vscedit_dump_all_cfe', { outputDir }));

      assert.deepStrictEqual((data.dumped as { extensionName: string }[]).map((item) => item.extensionName), ['Альфа']);
      assert.deepStrictEqual((data.failed as { extensionName: string }[]).map((item) => item.extensionName), ['Бета']);
    });

    test('dump_all_cfe: обрыв агента (abortReason, interrupted) → исключение', async () => {
      ui.emulator.extensions.addExtension('Альфа', 'a');
      ui.emulator.extensions.addExtension('Бета', 'b');
      ui.emulator.extensions.crashOn((command) => command.command === 'config dump-cfg' && command.options.extension === 'Бета', 'drop');
      const outputDir = path.join(ui.workDir, 'выход');
      fs.mkdirSync(outputDir, { recursive: true });

      const result = await call('v8vscedit_dump_all_cfe', { outputDir });

      assert.ok(isError(result));
      assert.ok(text(result).includes('аварийно завершился'), text(result));
    });

    // ── замок ───────────────────────────────────────────────────────────

    test('замок конфигурации занят — прежний отказ MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE, команд агента нет', async () => {
      assert.strictEqual(await tryBeginConfigurationOperation(), true);
      const inputFile = file('вход.cf', cfFile('x'));

      const dump = await call('v8vscedit_dump_cf', { outputFile: path.join(ui.workDir, 'main.cf') });
      const load = await call('v8vscedit_load_cf', { inputFile, confirm: true });

      for (const result of [dump, load]) {
        assert.ok(isError(result) && text(result).includes(MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE), text(result));
      }
      assert.deepStrictEqual(ui.commandLog(), []);
    });
  });
}
