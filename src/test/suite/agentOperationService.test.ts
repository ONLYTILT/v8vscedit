import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentOperationService,
  AgentWorkspaceService,
  isInfoBaseAlreadyConnectedMessage,
  type DesignerAgentTransport,
  type DesignerAgentTransportFactory,
  type AgentCommandHooks,
  type AgentCommandResult,
} from '../../infra/agent';
import { buildHashSnapshot, buildScopeKey, saveHashCache } from '../../infra/cache/HashCache';
import { FakeTimers, ScriptedFactory, agentError } from './support/agentInfoBaseFakes';

class FakeTransport implements DesignerAgentTransport {
  readonly commands: string[] = [];

  constructor(
    private readonly connectError?: Error,
    private readonly executeHook?: (command: string) => Error | undefined
  ) {}

  execute(command: string, hooks?: AgentCommandHooks): Promise<AgentCommandResult> {
    this.commands.push(command);
    if (command === 'common connect-ib' && this.connectError) {
      return Promise.reject(this.connectError);
    }
    const error = this.executeHook?.(command);
    if (error) {
      return Promise.reject(error);
    }
    hooks?.onMessage?.({ type: 'log', message: `выполнено: ${command}` });
    return Promise.resolve({ messages: [] });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeTransportFactory implements DesignerAgentTransportFactory {
  constructor(readonly transport: FakeTransport) {}

  create(): Promise<DesignerAgentTransport> {
    return Promise.resolve(this.transport);
  }
}

suite('AgentOperationService', () => {
  test('распознаёт русское сообщение агента о уже установленном соединении с переносами строк', () => {
    assert.strictEqual(
      isInfoBaseAlreadyConnectedMessage('Соединение с информационной базой уже\nустановлено'),
      true
    );
  });

  test('считает уже подключенную базу успешным connect-ib и выполняет команду операции; соединение остаётся', async () => {
    const transport = new FakeTransport(new Error('Соединение с информационной базой уже\nустановлено'));
    const service = new AgentOperationService('/tmp/v8vscedit-test-project', new FakeTransportFactory(transport));
    const messages: string[] = [];

    await service.updateDatabaseConfiguration({
      kind: 'cf',
      name: 'Основная',
      rootPath: '/tmp/v8vscedit-test-project/src/cf',
    }, {
      onMessage: (message) => messages.push(message),
    });

    // Э4: после успешной операции базу не отпускаем — следующая операция не платит connect-ib.
    assert.strictEqual(service.isInfoBaseConnected(), true);
    assert.strictEqual(transport.commands[0], 'common connect-ib');
    assert.match(transport.commands[1], /^config update-db-cfg/);
    assert.strictEqual(transport.commands.length, 2);
    assert.ok(messages.some((message) => message.startsWith('выполнено: config update-db-cfg')));
  });

  suite('Э4: жизненный цикл подключения', () => {
    let tempRoot: string;
    let configRoot: string;
    const target = () => ({ kind: 'cf' as const, name: 'Основная', rootPath: configRoot });

    setup(() => {
      tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-lifecycle-'));
      configRoot = path.join(tempRoot, 'src', 'cf');
      fs.mkdirSync(path.join(configRoot, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(configRoot, 'Configuration.xml'), '<MetaDataObject/>', 'utf-8');
      fs.writeFileSync(path.join(configRoot, 'Catalogs', 'Товары.xml'), '<xml/>', 'utf-8');
    });
    teardown(() => { fs.rmSync(tempRoot, { recursive: true, force: true }); });

    test('load → update → load → update: один connect-ib, ноль disconnect-ib, ноль сбросов SSH', async () => {
      const factory = new ScriptedFactory();
      const service = new AgentOperationService(tempRoot, factory);

      await service.loadFullAndUpdate(target());
      await service.loadFullAndUpdate(target());

      assert.strictEqual(factory.count('common connect-ib'), 1);
      assert.strictEqual(factory.count('common disconnect-ib'), 0);
      assert.strictEqual(factory.resetCount, 0);
      assert.strictEqual(factory.log.filter((c) => c.startsWith('config load-config-from-files')).length, 2);
      assert.strictEqual(factory.log.filter((c) => c.startsWith('config update-db-cfg')).length, 2);
      assert.strictEqual(service.isInfoBaseConnected(), true);
    });

    test('цепочка обновление БД + частичная загрузка с обновлением: connect-ib один раз', async () => {
      const changedModule = path.join(configRoot, 'Catalogs', 'Товары', 'Ext', 'ObjectModule.bsl');
      fs.mkdirSync(path.dirname(changedModule), { recursive: true });
      fs.writeFileSync(changedModule, 'Процедура ДоИзменения() КонецПроцедуры', 'utf-8');
      saveHashCache(tempRoot, buildHashSnapshot(buildScopeKey('cf', configRoot), configRoot));
      fs.writeFileSync(changedModule, 'Процедура ПослеИзменения() КонецПроцедуры', 'utf-8');

      const factory = new ScriptedFactory();
      const service = new AgentOperationService(tempRoot, factory);
      await service.updateDatabaseConfiguration(target());
      await service.loadChangedAndUpdate(target());

      assert.strictEqual(factory.count('common connect-ib'), 1);
      assert.strictEqual(factory.count('common disconnect-ib'), 0);
      assert.strictEqual(factory.resetCount, 0);
      assert.match(factory.log[2], /^config load-config-from-files/);
      assert.match(factory.log[3], /^config update-db-cfg/);
    });

    test('ошибка операции → disconnect-ib и сброс SSH; следующая операция снова подключает ИБ', async () => {
      let failUpdate = true;
      const factory = new ScriptedFactory((command) => (
        command.startsWith('config update-db-cfg') && failUpdate ? new Error('обновление упало') : undefined
      ));
      const service = new AgentOperationService(tempRoot, factory);

      await assert.rejects(service.updateDatabaseConfiguration(target()), /обновление упало/);
      assert.strictEqual(factory.count('common disconnect-ib'), 1);
      assert.strictEqual(factory.resetCount, 1);
      assert.strictEqual(service.isInfoBaseConnected(), false);

      failUpdate = false;
      await service.updateDatabaseConfiguration(target());
      assert.strictEqual(factory.count('common connect-ib'), 2);
    });

    test('«уже подключено» и «не подключено» распознаются по машинному error-type', async () => {
      const factory = new ScriptedFactory((command) => {
        if (command === 'common connect-ib') { return agentError('DesignerAlreadyConnectedToInfoBase'); }
        if (command === 'common disconnect-ib') { return agentError('DesignerNotConnectedToInfoBase'); }
        return undefined;
      });
      const service = new AgentOperationService(tempRoot, factory);
      await service.updateDatabaseConfiguration(target());
      assert.strictEqual(service.isInfoBaseConnected(), true);
      assert.strictEqual(await service.disconnectInfoBase(), true);
      assert.strictEqual(service.isInfoBaseConnected(), false);
    });

    test('disconnectInfoBase(force) без кэша шлёт disconnect-ib; без force и без подключения — ничего', async () => {
      const factory = new ScriptedFactory();
      const service = new AgentOperationService(tempRoot, factory);
      assert.strictEqual(await service.disconnectInfoBase(), false);
      assert.deepStrictEqual(factory.log, []);
      assert.strictEqual(await service.disconnectInfoBase(undefined, { force: true }), true);
      assert.deepStrictEqual(factory.log, ['common disconnect-ib']);
    });

    test('reconnectInfoBase подключает ИБ', async () => {
      const factory = new ScriptedFactory();
      const service = new AgentOperationService(tempRoot, factory);
      await service.reconnectInfoBase();
      assert.deepStrictEqual(factory.log, ['common connect-ib']);
      assert.strictEqual(service.isInfoBaseConnected(), true);
    });

    test('опции idle пробрасываются в сессию: таймер на idleDisconnectMs после операции, срабатывание отпускает базу', async () => {
      const factory = new ScriptedFactory();
      const timers = new FakeTimers();
      const service = new AgentOperationService(tempRoot, factory, { idleDisconnectMs: 60_000, timers });
      await service.updateDatabaseConfiguration(target());
      assert.deepStrictEqual(timers.setCalls, [60_000]);
      await timers.fireAll();
      assert.strictEqual(factory.log.at(-1), 'common disconnect-ib');
      assert.strictEqual(service.isInfoBaseConnected(), false);
    });

    test('по умолчанию (опции не заданы) база остаётся подключённой без таймеров', async () => {
      const factory = new ScriptedFactory();
      const service = new AgentOperationService(tempRoot, factory);
      await service.updateDatabaseConfiguration(target());
      assert.strictEqual(service.isInfoBaseConnected(), true);
    });

    test('dispose сервиса снимает idle-таймер', async () => {
      const factory = new ScriptedFactory();
      const timers = new FakeTimers();
      const service = new AgentOperationService(tempRoot, factory, { idleDisconnectMs: 60_000, timers });
      await service.updateDatabaseConfiguration(target());
      await service.dispose();
      assert.strictEqual(timers.pending.size, 0);
    });
  });

  test('частичная загрузка зеркалит проект в воркспейс и обновляет изменённый файл', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-partial-'));
    try {
      const configRoot = path.join(tempRoot, 'src', 'cf');
      const changedModule = path.join(configRoot, 'Documents', 'Заказ', 'Ext', 'ObjectModule.bsl');
      const unchangedModule = path.join(configRoot, 'Documents', 'Заказ', 'Ext', 'ManagerModule.bsl');
      fs.mkdirSync(path.dirname(changedModule), { recursive: true });
      fs.writeFileSync(
        path.join(configRoot, 'Configuration.xml'),
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<MetaDataObject>',
          '<Configuration>',
          '<Properties><Name>Основная</Name><Version>1.0</Version></Properties>',
          '</Configuration>',
          '</MetaDataObject>',
        ].join(''),
        'utf-8'
      );
      fs.writeFileSync(path.join(configRoot, 'Documents', 'Заказ.xml'), '<xml/>', 'utf-8');
      fs.writeFileSync(changedModule, 'Процедура Старая() КонецПроцедуры', 'utf-8');
      fs.writeFileSync(unchangedModule, 'Процедура НеМенялась() КонецПроцедуры', 'utf-8');

      const scopeKey = buildScopeKey('cf', configRoot);
      saveHashCache(tempRoot, buildHashSnapshot(scopeKey, configRoot));
      fs.writeFileSync(changedModule, 'Процедура Новая() КонецПроцедуры', 'utf-8');

      const transport = new FakeTransport();
      const service = new AgentOperationService(tempRoot, new FakeTransportFactory(transport));

      await service.loadChangedAndUpdate({ kind: 'cf', name: 'Основная', rootPath: configRoot });

      const agentRoot = path.join(tempRoot, '.v8vscedit', 'agent', '0', 'workspace', 'cf', 'cf');
      // Изменённый модуль скопирован.
      assert.strictEqual(fs.existsSync(path.join(agentRoot, 'Documents', 'Заказ', 'Ext', 'ObjectModule.bsl')), true);
      // Раньше тест требовал, чтобы НЕизменённый модуль отсутствовал в воркспейсе — это и приводило
      // к пустому UnknownError, когда конфигуратору в `--dir` не хватало каркаса конфигурации.
      // Теперь воркспейс зеркалит весь проект, поэтому соседние неизменённые файлы присутствуют.
      assert.strictEqual(fs.existsSync(path.join(agentRoot, 'Documents', 'Заказ', 'Ext', 'ManagerModule.bsl')), true);
      assert.strictEqual(fs.existsSync(path.join(agentRoot, 'Configuration.xml')), true);
      assert.strictEqual(
        fs.readFileSync(path.join(agentRoot, 'Documents', 'Заказ', 'Ext', 'ObjectModule.bsl'), 'utf-8'),
        'Процедура Новая() КонецПроцедуры'
      );

      const loadCommand = transport.commands.find((command) => command.startsWith('config load-config-from-files'));
      assert.ok(loadCommand);
      assert.match(loadCommand, /--partial/);
      assert.match(loadCommand, /--no-check/);
      assert.doesNotMatch(loadCommand, /--extension/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('новые XML-элементы загружает частично через list-file', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-structural-partial-'));
    try {
      const configRoot = path.join(tempRoot, 'src', 'cf');
      fs.mkdirSync(path.join(configRoot, 'Catalogs'), { recursive: true });
      fs.writeFileSync(path.join(configRoot, 'Configuration.xml'), '<MetaDataObject/>', 'utf-8');
      const scopeKey = buildScopeKey('cf', configRoot);
      saveHashCache(tempRoot, buildHashSnapshot(scopeKey, configRoot));

      fs.writeFileSync(path.join(configRoot, 'Catalogs', 'Новый.xml'), '<xml/>', 'utf-8');

      const transport = new FakeTransport();
      const service = new AgentOperationService(tempRoot, new FakeTransportFactory(transport));

      await service.loadChangedAndUpdate({ kind: 'cf', name: 'Основная', rootPath: configRoot });

      const loadCommand = transport.commands.find((command) => command.startsWith('config load-config-from-files'));
      assert.ok(loadCommand);
      assert.match(loadCommand, /--partial/);
      assert.match(loadCommand, /--list-file/);
      // На частичной загрузке `--update-config-dump-info` не передаётся: иначе конфигуратор
      // на следующей частичной загрузке падает с пустым UnknownError.
      assert.doesNotMatch(loadCommand, /--update-config-dump-info/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('частичная загрузка восстанавливает каркас в воркспейсе из проекта', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-mirror-'));
    try {
      const configRoot = path.join(tempRoot, 'src', 'cf');
      const changedModule = path.join(configRoot, 'Documents', 'Заказ', 'Forms', 'Форма', 'Ext', 'Form', 'Module.bsl');
      const parentFormXml = path.join(configRoot, 'Documents', 'Заказ', 'Forms', 'Форма.xml');
      const parentObjectXml = path.join(configRoot, 'Documents', 'Заказ.xml');
      fs.mkdirSync(path.dirname(changedModule), { recursive: true });
      fs.writeFileSync(
        path.join(configRoot, 'Configuration.xml'),
        '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Configuration><Properties><Name>Основная</Name></Properties></Configuration></MetaDataObject>',
        'utf-8'
      );
      fs.writeFileSync(parentObjectXml, '<xml/>', 'utf-8');
      fs.writeFileSync(parentFormXml, '<xml/>', 'utf-8');
      fs.writeFileSync(changedModule, 'Процедура Старая() КонецПроцедуры', 'utf-8');

      const scopeKey = buildScopeKey('cf', configRoot);
      saveHashCache(tempRoot, buildHashSnapshot(scopeKey, configRoot));
      fs.writeFileSync(changedModule, 'Процедура Новая() КонецПроцедуры', 'utf-8');

      const transport = new FakeTransport();
      const service = new AgentOperationService(tempRoot, new FakeTransportFactory(transport));
      await service.loadChangedAndUpdate({ kind: 'cf', name: 'Основная', rootPath: configRoot });

      const agentRoot = path.join(tempRoot, '.v8vscedit', 'agent', '0', 'workspace', 'cf', 'cf');
      assert.strictEqual(
        fs.existsSync(path.join(agentRoot, 'Configuration.xml')),
        true,
        'воркспейс должен содержать Configuration.xml для контекста частичной загрузки'
      );
      assert.strictEqual(
        fs.existsSync(path.join(agentRoot, 'Documents', 'Заказ.xml')),
        true,
        'воркспейс должен содержать корневой XML объекта формы'
      );
      assert.strictEqual(
        fs.existsSync(path.join(agentRoot, 'Documents', 'Заказ', 'Forms', 'Форма.xml')),
        true,
        'воркспейс должен содержать XML самой формы для модуля формы'
      );
      assert.strictEqual(
        fs.existsSync(path.join(agentRoot, 'Documents', 'Заказ', 'Forms', 'Форма', 'Ext', 'Form', 'Module.bsl')),
        true,
        'актуальный модуль формы должен быть скопирован в воркспейс'
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

});

suite('AgentOperationService: Э4, все операции идут через сессию (cf/cfe, ветки полной загрузки)', () => {
  let tempRoot: string;
  let configRoot: string;
  const cf = () => ({ kind: 'cf' as const, name: 'Основная', rootPath: configRoot });

  setup(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-ops-'));
    configRoot = path.join(tempRoot, 'src', 'cf');
    fs.mkdirSync(path.join(configRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'Configuration.xml'), '<MetaDataObject/>', 'utf-8');
    fs.writeFileSync(path.join(configRoot, 'Catalogs', 'Товары.xml'), '<Catalog>Товары</Catalog>', 'utf-8');
  });
  teardown(() => { fs.rmSync(tempRoot, { recursive: true, force: true }); });

  function saveCurrentHashes(): void {
    saveHashCache(tempRoot, buildHashSnapshot(buildScopeKey('cf', configRoot), configRoot));
  }

  test('importFromDatabase: connect-ib и dump-config-to-files через сессию, база остаётся подключённой', async () => {
    // Фейковый агент «выгружает базу» в каталог воркспейса — так, как это делает настоящий dump.
    const workspaceDir = new AgentWorkspaceService(tempRoot).ensureWorkspace('cf', cf()).targetDir;
    const factory = new ScriptedFactory((command) => {
      if (command.startsWith('config dump-config-to-files')) {
        fs.cpSync(configRoot, workspaceDir, { recursive: true });
      }
      return undefined;
    });
    const service = new AgentOperationService(tempRoot, factory);
    const result = await service.importFromDatabase(cf());
    assert.strictEqual(factory.log[0], 'common connect-ib');
    assert.match(factory.log[1], /^config dump-config-to-files /);
    assert.doesNotMatch(factory.log[1], /--extension/);
    assert.ok(Array.isArray(result.changedProjectFiles));
    assert.strictEqual(service.isInfoBaseConnected(), true);
  });

  test('cfe: имя расширения уходит в команды; без extensionName — имя цели', async () => {
    const factory = new ScriptedFactory();
    const service = new AgentOperationService(tempRoot, factory);
    await service.updateDatabaseConfiguration({ kind: 'cfe', name: 'Расш1', rootPath: configRoot });
    await service.updateDatabaseConfiguration({ kind: 'cfe', name: 'Узел', extensionName: 'Расш2', rootPath: configRoot });
    await service.loadFullAndUpdate({ kind: 'cfe', name: 'Узел', extensionName: 'Расш3', rootPath: configRoot });
    const updates = factory.log.filter((c) => c.startsWith('config update-db-cfg'));
    assert.match(updates[0], /--extension=Расш1/);
    assert.match(updates[1], /--extension=Расш2/);
    assert.match(updates[2], /--extension=Расш3/);
    assert.ok(factory.log.some((c) => c.startsWith('config load-config-from-files') && c.includes('--extension=Расш3')));
    assert.strictEqual(factory.count('common connect-ib'), 1);
  });

  function messagesOf(run: (hooks: { onMessage: (m: string) => void }) => Promise<unknown>): Promise<string[]> {
    const messages: string[] = [];
    return run({ onMessage: (m) => messages.push(m) }).then(() => messages);
  }

  test('loadChangedAndUpdate без кэша хешей → полная загрузка', async () => {
    const factory = new ScriptedFactory();
    const service = new AgentOperationService(tempRoot, factory);
    const messages = await messagesOf((hooks) => service.loadChangedAndUpdate(cf(), hooks));
    assert.ok(messages.includes('Кэш изменений не найден, выполняется полная загрузка.'));
    assert.ok(factory.log.some((c) => c.startsWith('config load-config-from-files') && !c.includes('--partial')));
  });

  test('loadChangedAndUpdate после удаления файла → полная загрузка с сообщением об удалении', async () => {
    saveCurrentHashes();
    fs.rmSync(path.join(configRoot, 'Catalogs', 'Товары.xml'));
    const factory = new ScriptedFactory();
    const service = new AgentOperationService(tempRoot, factory);
    const messages = await messagesOf((hooks) => service.loadChangedAndUpdate(cf(), hooks));
    assert.ok(messages.includes('Обнаружено удаление файлов, выполняется полная загрузка.'), messages.join('|'));
  });

  test('loadChangedAndUpdate после переименования объекта → полная загрузка с сообщением о переименовании', async () => {
    saveCurrentHashes();
    fs.renameSync(path.join(configRoot, 'Catalogs', 'Товары.xml'), path.join(configRoot, 'Catalogs', 'Номенклатура.xml'));
    const factory = new ScriptedFactory();
    const service = new AgentOperationService(tempRoot, factory);
    const messages = await messagesOf((hooks) => service.loadChangedAndUpdate(cf(), hooks));
    assert.ok(messages.includes('Обнаружено переименование объектов, выполняется полная загрузка.'), messages.join('|'));
  });
});
