import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentWorkspaceService, buildAgentProjectId } from '../../infra/agent/AgentWorkspaceService';
import { LocalAgentFileStore } from '../../infra/agent/files/LocalAgentFileStore';
import { mirrorDirectorySnapshot } from '../../infra/agent/DirectorySnapshot';

suite('buildAgentProjectId', () => {
  test('короткий стабильный хэш: 8 hex-символов, детерминирован', () => {
    const id = buildAgentProjectId('C:/projects/demo');
    assert.match(id, /^[0-9a-f]{8}$/);
    assert.strictEqual(buildAgentProjectId('C:/projects/demo'), id);
  });

  test('разные корни проектов дают разные сегменты', () => {
    assert.notStrictEqual(buildAgentProjectId('C:/projects/a'), buildAgentProjectId('C:/projects/b'));
  });

  test('форма записи корня не влияет: обратные слэши и хвостовой разделитель', () => {
    const id = buildAgentProjectId('C:/projects/demo');
    assert.strictEqual(buildAgentProjectId('C:\\projects\\demo'), id);
    assert.strictEqual(buildAgentProjectId('C:/projects/demo/'), id);
    assert.strictEqual(buildAgentProjectId('C:\\projects\\demo\\'), id);
  });

  test('кириллица в пути — тоже валидный сегмент', () => {
    assert.match(buildAgentProjectId('D:/Проекты/Учёт'), /^[0-9a-f]{8}$/);
  });
});

suite('AgentWorkspaceService (поверх AgentFileStore)', () => {
  let base: string;
  let store: LocalAgentFileStore;
  let service: AgentWorkspaceService;

  setup(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-ws-'));
    store = new LocalAgentFileStore(base);
    service = new AgentWorkspaceService(store, 'abc12345');
  });
  teardown(() => { fs.rmSync(base, { recursive: true, force: true }); });

  suite('resolveWorkspace — чистая раскладка относительных POSIX-путей', () => {
    test('cf: workspace/<projectId>/cf', () => {
      const ws = service.resolveWorkspace({ kind: 'cf' });
      assert.strictEqual(ws.projectId, 'abc12345');
      assert.strictEqual(ws.workspaceRoot, 'workspace/abc12345');
      assert.strictEqual(ws.targetAgentDir, 'workspace/abc12345/cf');
      assert.strictEqual(ws.listsRoot, 'lists');
      assert.strictEqual(ws.exchangeRoot, 'exchange');
    });

    test('cfe: workspace/<projectId>/cfe/<имя>', () => {
      assert.strictEqual(
        service.resolveWorkspace({ kind: 'cfe', extensionName: 'EVOLC' }).targetAgentDir,
        'workspace/abc12345/cfe/EVOLC'
      );
    });

    test('разные projectId дают разные M одной и той же цели в одном персональном корне', () => {
      const other = new AgentWorkspaceService(store, 'ffff0000');
      assert.notStrictEqual(
        other.resolveWorkspace({ kind: 'cf' }).targetAgentDir,
        service.resolveWorkspace({ kind: 'cf' }).targetAgentDir
      );
    });

    test('имя расширения санитизируется (кириллица сохраняется, спецсимволы → _) и тримится', () => {
      assert.strictEqual(
        service.resolveWorkspace({ kind: 'cfe', extensionName: '  Моё расш/ирение  ' }).targetAgentDir,
        'workspace/abc12345/cfe/Моё_расш_ирение'
      );
    });

    test('cfe без имени или с пустым/пробельным именем → ошибка', () => {
      assert.throws(() => service.resolveWorkspace({ kind: 'cfe' }), /имя расширения/);
      assert.throws(() => service.resolveWorkspace({ kind: 'cfe', extensionName: '   ' }), /имя расширения/);
    });

    test('имя расширения "." / ".." → ошибка сегмента', () => {
      assert.throws(() => service.resolveWorkspace({ kind: 'cfe', extensionName: '..' }), /Некорректный сегмент/);
      assert.throws(() => service.resolveWorkspace({ kind: 'cfe', extensionName: '.' }), /Некорректный сегмент/);
    });

    test('projectId проверяется конструктором как сегмент пути', () => {
      assert.throws(() => new AgentWorkspaceService(store, '..'), /Некорректный сегмент/);
      assert.throws(() => new AgentWorkspaceService(store, '  '), /Некорректный сегмент/);
    });

    test('локальных/«хардкодных» понятий больше нет: getAgentFileRoot и toAgentPath удалены', () => {
      assert.strictEqual('getAgentFileRoot' in service, false);
      assert.strictEqual('toAgentPath' in service, false);
      assert.strictEqual('getAgentRoot' in service, false);
    });
  });

  suite('ensureWorkspace', () => {
    test('создаёт каталог цели, lists и exchange в хранилище', async () => {
      const ws = await service.ensureWorkspace({ kind: 'cfe', extensionName: 'EVOLC' });
      assert.strictEqual(ws.targetAgentDir, 'workspace/abc12345/cfe/EVOLC');
      assert.strictEqual((await store.stat('workspace/abc12345/cfe/EVOLC'))?.type, 'dir');
      assert.strictEqual((await store.stat('lists'))?.type, 'dir');
      assert.strictEqual((await store.stat('exchange'))?.type, 'dir');
    });

    test('идемпотентен и не трогает уже лежащее в M содержимое', async () => {
      await service.ensureWorkspace({ kind: 'cf' });
      await store.writeFile('workspace/abc12345/cf/Configuration.xml', '<x/>');
      await service.ensureWorkspace({ kind: 'cf' });
      assert.strictEqual((await store.readFile('workspace/abc12345/cf/Configuration.xml')).toString(), '<x/>');
    });

    test('ничего не создаёт вне переданного корня хранилища', async () => {
      await service.ensureWorkspace({ kind: 'cf' });
      assert.deepStrictEqual(fs.readdirSync(base).sort(), ['exchange', 'lists', 'workspace']);
    });
  });

  suite('writeListFile', () => {
    test('пишет lists/<op>.txt: UTF-8 BOM, пути через \\n без завершающего перевода; возвращает путь агента', async () => {
      const agentPath = await service.writeListFile('operation-1', ['Configuration.xml', 'Catalogs/Контрагенты.xml']);
      assert.strictEqual(agentPath, 'lists/operation-1.txt');
      const data = fs.readFileSync(path.join(base, 'lists', 'operation-1.txt'));
      assert.deepStrictEqual([...data.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      assert.strictEqual(data.subarray(3).toString('utf-8'), 'Configuration.xml\nCatalogs/Контрагенты.xml');
      assert.ok(!data.includes(0x0d));
    });

    test('нормализует разделители и повторные слэши', async () => {
      await service.writeListFile('op', ['Catalogs\\Товары.xml', 'a//b///c.bsl']);
      const text = fs.readFileSync(path.join(base, 'lists', 'op.txt'), 'utf-8');
      assert.strictEqual(text, '\uFEFFCatalogs/Товары.xml\na/b/c.bsl');
    });

    test('пустой список → файл из одного BOM', async () => {
      await service.writeListFile('empty', []);
      assert.deepStrictEqual([...fs.readFileSync(path.join(base, 'lists', 'empty.txt'))], [0xef, 0xbb, 0xbf]);
    });

    test('идентификатор операции санитизируется', async () => {
      assert.strictEqual(await service.writeListFile('cfe-Расш 1/..x', ['a.xml']), 'lists/cfe-Расш_1_..x.txt');
      assert.ok(fs.existsSync(path.join(base, 'lists', 'cfe-Расш_1_..x.txt')));
    });

    test('идентификатор ".." или пустой → ошибка, файл не создан', async () => {
      await assert.rejects(service.writeListFile('..', ['a.xml']), /Некорректный сегмент/);
      await assert.rejects(service.writeListFile('  ', ['a.xml']), /Некорректный сегмент/);
      assert.strictEqual(await store.stat('lists'), undefined);
    });

    test('повторная запись той же операции заменяет файл', async () => {
      await service.writeListFile('op', ['a.xml', 'b.xml']);
      await service.writeListFile('op', ['c.xml']);
      assert.strictEqual(fs.readFileSync(path.join(base, 'lists', 'op.txt'), 'utf-8'), '\uFEFFc.xml');
    });

    test('запрещает абсолютные пути, пустые элементы и выход из каталога; ничего не пишет', async () => {
      await assert.rejects(service.writeListFile('bad-abs', ['/tmp/Configuration.xml']), /относительными/);
      await assert.rejects(service.writeListFile('bad-abs2', ['\\tmp\\Configuration.xml']), /относительными/);
      await assert.rejects(service.writeListFile('bad-drive', ['C:\\cf\\Configuration.xml']), /относительными/);
      await assert.rejects(service.writeListFile('bad-drive2', ['c:Configuration.xml']), /относительными/);
      await assert.rejects(service.writeListFile('bad-empty', ['a.xml', '  ']), /относительными/);
      await assert.rejects(service.writeListFile('bad-parent', ['../Configuration.xml']), /выходить за пределы/);
      await assert.rejects(service.writeListFile('bad-parent2', ['a/../../x.xml']), /выходить за пределы/);
      assert.strictEqual(await store.stat('lists/bad-abs.txt'), undefined);
      assert.strictEqual(await store.stat('lists/bad-parent.txt'), undefined);
    });
  });
});

suite('DirectorySnapshot: копирующая синхронизация остаётся локальной утилитой', () => {
  test('mirrorDirectorySnapshot не перемещает исходники проекта и удаляет лишнее в цели', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-agent-test-'));
    try {
      const source = path.join(root, 'src', 'cf');
      const target = path.join(root, 'mirror', 'cf');
      fs.mkdirSync(source, { recursive: true });
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(source, 'Configuration.xml'), '<new/>', 'utf-8');
      fs.writeFileSync(path.join(target, 'Old.xml'), '<old/>', 'utf-8');

      mirrorDirectorySnapshot(source, target);

      assert.ok(fs.existsSync(path.join(source, 'Configuration.xml')));
      assert.ok(fs.existsSync(path.join(target, 'Configuration.xml')));
      assert.ok(!fs.existsSync(path.join(target, 'Old.xml')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
