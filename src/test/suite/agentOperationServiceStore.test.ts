import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentOperationService } from '../../infra/agent';
import { buildAgentProjectId } from '../../infra/agent/AgentWorkspaceService';
import { buildHashSnapshot, buildScopeKey, loadHashCache, saveHashCache } from '../../infra/cache/HashCache';
import { PROPERTIES_GET_ALL, extensionListMessages } from './support/agentExtensionsEmulator';
import { ScriptedFactory } from './support/agentInfoBaseFakes';
import {
  AGENT_USER,
  USER_DIR,
  agentBaseDirOf,
  cfeMirrorDirOf,
  mirrorDirOf,
  newService,
  userRootOf,
  writeAgentIndex,
} from './support/agentWorkspaceFixtures';

suite('AgentOperationService: Э5, файлы рабочей области через AgentFileStore и персональный корень', () => {
  let tempRoot: string;
  let configRoot: string;
  const cf = () => ({ kind: 'cf' as const, name: 'Основная', rootPath: configRoot });
  const relative = (files: readonly string[]): string[] =>
    files.map((f) => path.relative(configRoot, f).replace(/\\/g, '/')).sort();

  setup(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-e5-'));
    configRoot = path.join(tempRoot, 'src', 'cf');
    fs.mkdirSync(path.join(configRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'Configuration.xml'), '<MetaDataObject/>', 'utf-8');
    fs.writeFileSync(path.join(configRoot, 'Catalogs', 'Товары.xml'), '<Catalog>Товары</Catalog>', 'utf-8');
  });
  teardown(() => { fs.rmSync(tempRoot, { recursive: true, force: true }); });

  test('полная загрузка кладёт зеркало в <AgentBaseDir>/<dir из json>/workspace/<projectId>/cf, а не в каталог "0"', async () => {
    const factory = new ScriptedFactory();
    await newService(tempRoot, factory).loadFullAndUpdate(cf());

    const mirror = mirrorDirOf(tempRoot);
    assert.strictEqual(fs.readFileSync(path.join(mirror, 'Catalogs', 'Товары.xml'), 'utf-8'), '<Catalog>Товары</Catalog>');
    assert.strictEqual(fs.readFileSync(path.join(mirror, 'Configuration.xml'), 'utf-8'), '<MetaDataObject/>');
    assert.strictEqual(fs.existsSync(path.join(agentBaseDirOf(tempRoot), '0')), false);
    assert.deepStrictEqual(fs.readdirSync(agentBaseDirOf(tempRoot)).sort(), [USER_DIR, 'agentbasedir.json']);
    const load = factory.log.find((c) => c.startsWith('config load-config-from-files'));
    assert.ok(load?.includes(`workspace/${buildAgentProjectId(tempRoot)}/cf`), load);
  });

  test('сегмент projectId отделяет проекты: два корня → два независимых зеркала в одном персональном корне', async () => {
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-e5-other-'));
    try {
      const otherConfig = path.join(otherRoot, 'src', 'cf');
      fs.mkdirSync(otherConfig, { recursive: true });
      fs.writeFileSync(path.join(otherConfig, 'Configuration.xml'), '<Other/>', 'utf-8');
      // Один и тот же агент (общий agentBaseDir): второй проект указывает на каталог первого.
      writeAgentIndex(tempRoot);
      const shared = { userName: AGENT_USER, agentBaseDir: agentBaseDirOf(tempRoot) };
      await new AgentOperationService(tempRoot, new ScriptedFactory(), {}, shared).loadFullAndUpdate(cf());
      await new AgentOperationService(otherRoot, new ScriptedFactory(), {}, shared)
        .loadFullAndUpdate({ kind: 'cf', name: 'Основная', rootPath: otherConfig });

      const workspaces = fs.readdirSync(path.join(userRootOf(tempRoot), 'workspace')).sort();
      assert.deepStrictEqual(workspaces, [buildAgentProjectId(tempRoot), buildAgentProjectId(otherRoot)].sort());
      assert.strictEqual(fs.readFileSync(path.join(mirrorDirOf(tempRoot), 'Configuration.xml'), 'utf-8'), '<MetaDataObject/>');
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  test('cfe: зеркало workspace/<projectId>/cfe/<имя>, расширение уходит в команду', async () => {
    // Guard применения cfe запрашивает список расширений: агент «знает» загружаемое расширение.
    const factory = new ScriptedFactory(undefined, (command) =>
      command === PROPERTIES_GET_ALL ? extensionListMessages(['Расш']) : undefined
    );
    await newService(tempRoot, factory).loadFullAndUpdate({ kind: 'cfe', name: 'Узел', extensionName: 'Расш', rootPath: configRoot });
    assert.ok(fs.existsSync(path.join(cfeMirrorDirOf(tempRoot, 'Расш'), 'Configuration.xml')));
    const load = factory.log.find((c) => c.startsWith('config load-config-from-files'));
    assert.ok(load?.includes(`workspace/${buildAgentProjectId(tempRoot)}/cfe/Расш`), load);
    assert.ok(load?.includes('--extension=Расш'), load);
  });

  test('индекс читается ПОСЛЕ первого входа: agentbasedir.json, появившийся при connect-ib, подхватывается', async () => {
    const factory = new ScriptedFactory((command) => {
      if (command === 'common connect-ib') { writeAgentIndex(tempRoot); }
      return undefined;
    });
    assert.strictEqual(fs.existsSync(path.join(agentBaseDirOf(tempRoot), 'agentbasedir.json')), false);
    const service = new AgentOperationService(tempRoot, factory, {}, { userName: AGENT_USER });
    await service.loadFullAndUpdate(cf());
    assert.ok(fs.existsSync(path.join(mirrorDirOf(tempRoot), 'Configuration.xml')));
  });

  test('регистр логина в индексе не важен', async () => {
    writeAgentIndex(tempRoot, [{ name: AGENT_USER.toUpperCase(), dir: USER_DIR }]);
    await newService(tempRoot, new ScriptedFactory()).loadFullAndUpdate(cf());
    assert.ok(fs.existsSync(path.join(mirrorDirOf(tempRoot), 'Configuration.xml')));
  });

  test('пользователя нет в индексе → операция падает с путём к файлу и логином; ИБ отпущена, загрузка не выполнена', async () => {
    writeAgentIndex(tempRoot, [{ name: 'Другой', dir: '0' }]);
    const factory = new ScriptedFactory();
    const service = new AgentOperationService(tempRoot, factory, {}, { userName: 'ghost' });
    await assert.rejects(
      service.loadFullAndUpdate(cf()),
      (error: Error) => error.message.includes('agentbasedir.json') && error.message.includes('ghost')
    );
    assert.strictEqual(service.isInfoBaseConnected(), false);
    assert.ok(!factory.log.some((c) => c.startsWith('config load-config-from-files')));
  });

  test('не задан пользователь агента: операции без файлов работают, с файлами — понятная ошибка', async () => {
    const factory = new ScriptedFactory();
    const service = new AgentOperationService(tempRoot, factory);
    await service.updateDatabaseConfiguration(cf());
    await assert.rejects(service.loadFullAndUpdate(cf()), /пользовател/);
    await assert.rejects(service.importFromDatabase(cf()), /пользовател/);
  });

  test('частичная загрузка: list-файл лежит в персональном корне (lists/) и в команде указан относительный путь агента', async () => {
    saveHashCache(tempRoot, buildHashSnapshot(buildScopeKey('cf', configRoot), configRoot));
    fs.writeFileSync(path.join(configRoot, 'Catalogs', 'Товары.xml'), '<Catalog>Изменён</Catalog>', 'utf-8');

    const factory = new ScriptedFactory();
    await newService(tempRoot, factory).loadChangedAndUpdate(cf());

    const lists = fs.readdirSync(path.join(userRootOf(tempRoot), 'lists'));
    assert.strictEqual(lists.length, 1);
    const listName = lists[0] ?? '';
    const listText = fs.readFileSync(path.join(userRootOf(tempRoot), 'lists', listName), 'utf-8');
    assert.ok(listText.startsWith('﻿'));
    assert.ok(listText.includes('Catalogs/Товары.xml'), listText);
    const load = factory.log.find((c) => c.includes('--partial')) ?? '';
    assert.ok(load.includes(`lists/${listName}`), load);
    assert.ok(!/[A-Za-z]:[\\/]/.test(load), 'в команде нет абсолютных локальных путей: ' + load);
    assert.strictEqual(
      fs.readFileSync(path.join(mirrorDirOf(tempRoot), 'Catalogs', 'Товары.xml'), 'utf-8'),
      '<Catalog>Изменён</Catalog>'
    );
  });

  test('частичная загрузка: зеркало с Configuration.xml не пересоздаётся (посторонний файл остаётся), без него — зеркалится заново', async () => {
    saveHashCache(tempRoot, buildHashSnapshot(buildScopeKey('cf', configRoot), configRoot));
    fs.writeFileSync(path.join(configRoot, 'Catalogs', 'Товары.xml'), '<Catalog>v2</Catalog>', 'utf-8');
    const mirror = mirrorDirOf(tempRoot);
    fs.mkdirSync(mirror, { recursive: true });
    fs.writeFileSync(path.join(mirror, 'Configuration.xml'), '<Старая/>', 'utf-8');
    fs.writeFileSync(path.join(mirror, 'Stray.xml'), '<stray/>', 'utf-8');

    await newService(tempRoot, new ScriptedFactory()).loadChangedAndUpdate(cf());
    assert.ok(fs.existsSync(path.join(mirror, 'Stray.xml')), 'каркас уже есть — полное зеркалирование не нужно');
    assert.strictEqual(fs.readFileSync(path.join(mirror, 'Configuration.xml'), 'utf-8'), '<Старая/>');

    fs.rmSync(path.join(mirror, 'Configuration.xml'));
    saveHashCache(tempRoot, buildHashSnapshot(buildScopeKey('cf', configRoot), configRoot));
    fs.writeFileSync(path.join(configRoot, 'Catalogs', 'Товары.xml'), '<Catalog>v3</Catalog>', 'utf-8');
    await newService(tempRoot, new ScriptedFactory()).loadChangedAndUpdate(cf());
    assert.ok(!fs.existsSync(path.join(mirror, 'Stray.xml')), 'без Configuration.xml зеркало пересоздаётся целиком');
    assert.strictEqual(fs.readFileSync(path.join(mirror, 'Configuration.xml'), 'utf-8'), '<MetaDataObject/>');
  });

  suite('importFromDatabase: зеркало M → проект P', () => {
    const OLD_CONFIG = '<MetaDataObject/>';
    const bomCrlf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<Config>\r\n  <Новая/>\r\n</Config>\r\n', 'utf-8')]);

    function dumpInto(files: Record<string, Buffer | string>): ScriptedFactory {
      return new ScriptedFactory((command) => {
        if (command.startsWith('config dump-config-to-files')) {
          for (const [rel, data] of Object.entries(files)) {
            const target = path.join(mirrorDirOf(tempRoot), rel);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, data);
          }
        }
        return undefined;
      });
    }

    test('добавленные и изменённые файлы копируются байт-в-байт, исчезнувшие в M удаляются из P', async () => {
      fs.writeFileSync(path.join(configRoot, 'Catalogs', 'Старый.xml'), '<old/>', 'utf-8');
      const factory = dumpInto({
        'Configuration.xml': bomCrlf,
        'Catalogs/Товары.xml': '<Catalog>Товары</Catalog>',
        'Catalogs/Новый.xml': '<new/>',
        'Catalogs/Новый/Ext/ObjectModule.bsl': 'Процедура А() КонецПроцедуры',
      });
      const result = await newService(tempRoot, factory).importFromDatabase(cf());

      assert.deepStrictEqual([...fs.readFileSync(path.join(configRoot, 'Configuration.xml'))], [...bomCrlf]);
      assert.strictEqual(fs.readFileSync(path.join(configRoot, 'Catalogs', 'Новый.xml'), 'utf-8'), '<new/>');
      assert.strictEqual(
        fs.readFileSync(path.join(configRoot, 'Catalogs', 'Новый', 'Ext', 'ObjectModule.bsl'), 'utf-8'),
        'Процедура А() КонецПроцедуры'
      );
      assert.strictEqual(fs.existsSync(path.join(configRoot, 'Catalogs', 'Старый.xml')), false);
      assert.deepStrictEqual(relative(result.changedProjectFiles), [
        'Catalogs/Новый.xml',
        'Catalogs/Новый/Ext/ObjectModule.bsl',
        'Catalogs/Старый.xml',
        'Configuration.xml',
      ]);
    });

    test('неизменённые файлы проекта не перезаписываются (mtime цел) и не попадают в changedProjectFiles', async () => {
      const unchanged = path.join(configRoot, 'Catalogs', 'Товары.xml');
      const past = new Date('2001-02-03T04:05:06Z');
      fs.utimesSync(unchanged, past, past);
      const factory = dumpInto({ 'Configuration.xml': OLD_CONFIG, 'Catalogs/Товары.xml': '<Catalog>Товары</Catalog>' });

      const result = await newService(tempRoot, factory).importFromDatabase(cf());

      assert.strictEqual(fs.statSync(unchanged).mtime.getTime(), past.getTime());
      assert.deepStrictEqual(result.changedProjectFiles, []);
    });

    test('onProjectFilesWillChange: до первой записи, перед Configuration.xml (он пишется последним) и после всех записей', async () => {
      // Хук открывает окно подавления reload (Container.suppressConfigurationReloadForFiles) на время
      // от вызова: при долгой асинхронной записи окно, открытое только в начале, истекло бы раньше,
      // чем придёт событие watcher на Configuration.xml.
      fs.writeFileSync(path.join(configRoot, 'Catalogs', 'Старый.xml'), '<old/>', 'utf-8');
      const factory = dumpInto({
        'Configuration.xml': '<Новый/>',
        'Catalogs/Товары.xml': '<Catalog>v2</Catalog>',
        'Catalogs/Новый.xml': '<new/>',
      });
      const snapshots: { files: string[]; config: string; oldThere: boolean; goods: string; newThere: boolean }[] = [];

      await newService(tempRoot, factory).importFromDatabase(cf(), {
        onProjectFilesWillChange: (files) => {
          snapshots.push({
            files: [...files],
            config: fs.readFileSync(path.join(configRoot, 'Configuration.xml'), 'utf-8'),
            oldThere: fs.existsSync(path.join(configRoot, 'Catalogs', 'Старый.xml')),
            goods: fs.readFileSync(path.join(configRoot, 'Catalogs', 'Товары.xml'), 'utf-8'),
            newThere: fs.existsSync(path.join(configRoot, 'Catalogs', 'Новый.xml')),
          });
        },
      });

      const expectedFiles = ['Catalogs/Новый.xml', 'Catalogs/Старый.xml', 'Catalogs/Товары.xml', 'Configuration.xml'];
      for (const snapshot of snapshots) {
        assert.deepStrictEqual(relative(snapshot.files), expectedFiles);
      }
      assert.deepStrictEqual(snapshots.map(({ config, oldThere, goods, newThere }) => ({ config, oldThere, goods, newThere })), [
        // до первой записи и удаления: проект нетронут
        { config: OLD_CONFIG, oldThere: true, goods: '<Catalog>Товары</Catalog>', newThere: false },
        // перед Configuration.xml: все остальные изменения уже применены, он — ещё нет
        { config: OLD_CONFIG, oldThere: false, goods: '<Catalog>v2</Catalog>', newThere: true },
        // после последней записи
        { config: '<Новый/>', oldThere: false, goods: '<Catalog>v2</Catalog>', newThere: true },
      ]);
    });

    test('onProjectFilesWillChange без изменения Configuration.xml: ровно до первой записи и после последней', async () => {
      const factory = dumpInto({ 'Configuration.xml': OLD_CONFIG, 'Catalogs/Товары.xml': '<Catalog>v2</Catalog>' });
      const goods: string[] = [];
      await newService(tempRoot, factory).importFromDatabase(cf(), {
        onProjectFilesWillChange: (files) => {
          assert.deepStrictEqual(relative(files), ['Catalogs/Товары.xml']);
          goods.push(fs.readFileSync(path.join(configRoot, 'Catalogs', 'Товары.xml'), 'utf-8'));
        },
      });
      assert.deepStrictEqual(goods, ['<Catalog>Товары</Catalog>', '<Catalog>v2</Catalog>']);
    });

    test('флаг --update появляется только когда в зеркале уже есть ConfigDumpInfo.xml', async () => {
      const first = dumpInto({ 'Configuration.xml': OLD_CONFIG, 'ConfigDumpInfo.xml': '<dump/>' });
      await newService(tempRoot, first).importFromDatabase(cf());
      const firstDump = first.log.find((c) => c.startsWith('config dump-config-to-files')) ?? '';
      assert.ok(!/\s--update(\s|$)/.test(firstDump), firstDump);
      assert.ok(firstDump.includes(`workspace/${buildAgentProjectId(tempRoot)}/cf`), firstDump);

      const second = dumpInto({});
      await newService(tempRoot, second).importFromDatabase(cf());
      const secondDump = second.log.find((c) => c.startsWith('config dump-config-to-files')) ?? '';
      assert.ok(/\s--update(\s|$)/.test(secondDump), secondDump);
    });

    test('cfe: выгрузка в cfe/<имя>, имя расширения в команде, проект получает файлы', async () => {
      const mirror = cfeMirrorDirOf(tempRoot, 'Расш');
      const factory = new ScriptedFactory((command) => {
        if (command.startsWith('config dump-config-to-files')) {
          fs.mkdirSync(mirror, { recursive: true });
          fs.writeFileSync(path.join(mirror, 'Configuration.xml'), '<Ext/>', 'utf-8');
        }
        return undefined;
      });
      await newService(tempRoot, factory).importFromDatabase({ kind: 'cfe', name: 'Расш', rootPath: configRoot });
      const dump = factory.log.find((c) => c.startsWith('config dump-config-to-files')) ?? '';
      assert.ok(dump.includes('--extension=Расш'), dump);
      assert.ok(dump.includes(`workspace/${buildAgentProjectId(tempRoot)}/cfe/Расш`), dump);
      assert.strictEqual(fs.readFileSync(path.join(configRoot, 'Configuration.xml'), 'utf-8'), '<Ext/>');
    });

    test('после импорта обновлён кэш хэшей проекта', async () => {
      const factory = dumpInto({ 'Configuration.xml': OLD_CONFIG, 'Catalogs/Новый.xml': '<new/>' });
      await newService(tempRoot, factory).importFromDatabase(cf());
      const snapshot = loadHashCache(tempRoot, buildScopeKey('cf', configRoot));
      assert.ok('Catalogs/Новый.xml' in snapshot.files, Object.keys(snapshot.files).join(','));
    });

    test('агент не создал каталог зеркала → ошибка, проект не тронут', async () => {
      await assert.rejects(newService(tempRoot, new ScriptedFactory()).importFromDatabase(cf()));
      assert.strictEqual(fs.readFileSync(path.join(configRoot, 'Configuration.xml'), 'utf-8'), OLD_CONFIG);
      assert.ok(fs.existsSync(path.join(configRoot, 'Catalogs', 'Товары.xml')));
    });

    test('первый импорт в ещё не существующий каталог проекта: все файлы новые, каталог создаётся', async () => {
      fs.rmSync(configRoot, { recursive: true, force: true });
      const factory = dumpInto({ 'Configuration.xml': OLD_CONFIG, 'Catalogs/Товары.xml': '<Catalog>Товары</Catalog>' });
      const result = await newService(tempRoot, factory).importFromDatabase(cf());
      assert.deepStrictEqual(relative(result.changedProjectFiles), ['Catalogs/Товары.xml', 'Configuration.xml']);
      assert.strictEqual(fs.readFileSync(path.join(configRoot, 'Configuration.xml'), 'utf-8'), OLD_CONFIG);
    });

    test('исчезнувший в M объект с подкаталогами: файлы удалены, опустевшие каталоги убраны, непустые оставлены', async () => {
      const module = path.join(configRoot, 'Catalogs', 'Старый', 'Ext', 'ObjectModule.bsl');
      fs.mkdirSync(path.dirname(module), { recursive: true });
      fs.writeFileSync(module, 'Процедура Б() КонецПроцедуры', 'utf-8');
      const factory = dumpInto({ 'Configuration.xml': OLD_CONFIG, 'Catalogs/Товары.xml': '<Catalog>Товары</Catalog>' });
      const result = await newService(tempRoot, factory).importFromDatabase(cf());
      assert.deepStrictEqual(relative(result.changedProjectFiles), ['Catalogs/Старый/Ext/ObjectModule.bsl']);
      assert.strictEqual(fs.existsSync(path.join(configRoot, 'Catalogs', 'Старый')), false);
      assert.ok(fs.existsSync(path.join(configRoot, 'Catalogs', 'Товары.xml')));
    });
    test('корень проекта с хвостовым разделителем: уборка опустевших каталогов не поднимается выше проекта', async () => {
      // Все файлы проекта исчезают из M: после удаления корень проекта пуст, и без нормализации
      // путей уборка удалила бы сам корень и его опустевших родителей.
      fs.rmSync(configRoot, { recursive: true, force: true });
      fs.mkdirSync(path.join(configRoot, 'Old', 'Ext'), { recursive: true });
      fs.writeFileSync(path.join(configRoot, 'Old', 'Ext', 'x.bsl'), 'x', 'utf-8');
      const factory = dumpInto({ 'Configuration.xml': OLD_CONFIG });
      const rootSeen: boolean[] = [];
      await newService(tempRoot, factory).importFromDatabase(
        { kind: 'cf', name: 'Основная', rootPath: configRoot + path.sep },
        { onProjectFilesWillChange: () => { rootSeen.push(fs.existsSync(configRoot)); } }
      );
      assert.deepStrictEqual(rootSeen, [true, true, true]);
      assert.deepStrictEqual(fs.readdirSync(configRoot), ['Configuration.xml']);
    });
  });

  test('полная загрузка: лишние файлы и каталоги в M удаляются, файлы проекта остаются', async () => {
    const mirror = mirrorDirOf(tempRoot);
    fs.mkdirSync(path.join(mirror, 'Old', 'Ext'), { recursive: true });
    fs.writeFileSync(path.join(mirror, 'Old', 'Ext', 'x.bsl'), 'x', 'utf-8');
    fs.writeFileSync(path.join(mirror, 'Old.xml'), '<old/>', 'utf-8');
    fs.mkdirSync(path.join(mirror, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(mirror, 'Catalogs', 'Удалён.xml'), '<gone/>', 'utf-8');

    await newService(tempRoot, new ScriptedFactory()).loadFullAndUpdate(cf());

    assert.deepStrictEqual(fs.readdirSync(mirror).sort(), ['Catalogs', 'Configuration.xml']);
    assert.deepStrictEqual(fs.readdirSync(path.join(mirror, 'Catalogs')), ['Товары.xml']);
  });

  test('полная загрузка без каталога исходников → ошибка, загрузка не выполнена', async () => {
    const factory = new ScriptedFactory();
    const missing = path.join(tempRoot, 'src', 'нет');
    await assert.rejects(
      newService(tempRoot, factory).loadFullAndUpdate({ kind: 'cf', name: 'Основная', rootPath: missing }),
      /Каталог источника не найден/
    );
    assert.ok(!factory.log.some((c) => c.startsWith('config load-config-from-files')));
  });

  test('хранилище переиспользуется между операциями и освобождается при dispose сервиса', async () => {
    const service = newService(tempRoot, new ScriptedFactory());
    await service.loadFullAndUpdate(cf());
    fs.rmSync(path.join(agentBaseDirOf(tempRoot), 'agentbasedir.json'));
    // Индекс уже прочитан: повторная операция не перечитывает его.
    await service.loadFullAndUpdate(cf());
    await service.dispose();
  });

  test('dispose при сбое остановки сессии всё равно отпускает хранилище: следующая операция перечитывает индекс', async () => {
    const timers = {
      setTimeout: (): unknown => 1,
      clearTimeout: (): void => { throw new Error('сбой снятия таймера'); },
    };
    const service = newService(tempRoot, new ScriptedFactory(), { idleDisconnectMs: 60_000, timers });
    await service.loadFullAndUpdate(cf());
    await assert.rejects(service.dispose(), /сбой снятия таймера/);
    fs.rmSync(path.join(agentBaseDirOf(tempRoot), 'agentbasedir.json'));
    await assert.rejects(service.loadFullAndUpdate(cf()), /agentbasedir\.json/);
  });

  test('неудачное чтение индекса не кэшируется: следующая операция подхватывает появившийся индекс', async () => {
    const service = new AgentOperationService(tempRoot, new ScriptedFactory(), {}, { userName: AGENT_USER });
    await assert.rejects(service.loadFullAndUpdate(cf()), /agentbasedir\.json/);
    writeAgentIndex(tempRoot);
    await service.loadFullAndUpdate(cf());
    assert.ok(fs.existsSync(path.join(mirrorDirOf(tempRoot), 'Configuration.xml')));
  });
});
