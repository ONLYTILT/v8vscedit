import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildScopeKey } from '../../infra/cache/HashCache';
import {
  DatabaseConfigLagStore,
  lagScopeKey,
  type DatabaseLagEntry,
  type DatabaseLagSource,
  type DatabaseLagTarget,
} from '../../infra/database/DatabaseConfigLag';
import { removeTreeSync } from './support/tempTree';

/**
 * Признак «конфигурация БД отстаёт» (`infra/database/DatabaseConfigLag.ts`): файл
 * `.v8vscedit/database-config/lag.json`, ключ — `buildScopeKey` хеш-кэша, запись только через
 * `writeFileAtomic`. Тесты работают на настоящем временном каталоге; перезапуск VS Code — это новый
 * экземпляр store над тем же каталогом.
 */
suite('DatabaseConfigLagStore', () => {
  let root: string;
  let lines: string[];
  let cfRoot: string;
  let cfeRoot: string;
  const logger = { appendLine: (line: string): void => { lines.push(line); } };
  const lagFile = (): string => path.join(root, '.v8vscedit', 'database-config', 'lag.json');
  const newStore = (): DatabaseConfigLagStore => new DatabaseConfigLagStore(root, logger);
  const cf = (): DatabaseLagTarget => ({ kind: 'cf', name: 'Основная', rootPath: cfRoot });
  const cfe = (extensionName: string, rootPath = cfeRoot): DatabaseLagTarget =>
    ({ kind: 'cfe', name: extensionName, rootPath, extensionName });
  const readFile = (): { version: number; targets: Record<string, Record<string, unknown>> } =>
    JSON.parse(fs.readFileSync(lagFile(), 'utf-8')) as { version: number; targets: Record<string, Record<string, unknown>> };

  setup(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-db-lag-')));
    lines = [];
    cfRoot = path.join(root, 'src', 'cf');
    cfeRoot = path.join(root, 'src', 'cfe', 'Расш');
  });
  teardown(() => { removeTreeSync(root); });

  test('пустое состояние: ничто не отстаёт, list() пуст, файл не создаётся чтением', () => {
    const store = newStore();
    assert.strictEqual(store.isBehind(cf()), false);
    assert.deepStrictEqual(store.list(), []);
    assert.strictEqual(fs.existsSync(lagFile()), false);
  });

  test('markBehind → isBehind и list(): запись с источником, ISO-временем и исходными полями цели', () => {
    const store = newStore();
    store.markBehind(cf(), 'load-without-update');

    assert.strictEqual(store.isBehind(cf()), true);
    const [entry] = store.list();
    assert.strictEqual(store.list().length, 1);
    assert.deepStrictEqual([entry.kind, entry.name, entry.rootPath, entry.source], ['cf', 'Основная', cfRoot, 'load-without-update']);
    assert.strictEqual(new Date(entry.since).toISOString(), entry.since);
  });

  test('markCurrent снимает признак; повторный markCurrent отсутствующей цели безвреден', () => {
    const store = newStore();
    store.markBehind(cf(), 'update-failed');
    store.markCurrent(cf());
    assert.strictEqual(store.isBehind(cf()), false);
    assert.deepStrictEqual(store.list(), []);
    store.markCurrent(cf());
    assert.deepStrictEqual(readFile().targets, {});
  });

  test('cf и каждое cfe — независимые ключи: снятие у одного не трогает остальные', () => {
    const store = newStore();
    const second = cfe('Вторая', path.join(root, 'src', 'cfe', 'Вторая'));
    store.markBehind(cf(), 'load-without-update');
    store.markBehind(cfe('Расш'), 'load-without-update');
    store.markBehind(second, 'update-failed');

    store.markCurrent(cf());

    assert.strictEqual(store.isBehind(cf()), false);
    assert.strictEqual(store.isBehind(cfe('Расш')), true);
    assert.strictEqual(store.isBehind(second), true);
    store.markCurrent(cfe('Расш'));
    assert.strictEqual(store.isBehind(second), true);
    assert.strictEqual(store.list().length, 1);
  });

  test('одно расширение с тем же каталогом, но другим именем — другая цель (ключ включает имя расширения)', () => {
    const store = newStore();
    store.markBehind(cfe('А', cfeRoot), 'load-without-update');
    assert.strictEqual(store.isBehind(cfe('Б', cfeRoot)), false);
  });

  test('повторный markBehind сохраняет первоначальный since и меняет source', () => {
    const store = newStore();
    store.markBehind(cf(), 'load-without-update');
    const first = store.list()[0].since;
    const sources: DatabaseLagSource[] = ['update-failed', 'cf-file-load', 'repository-receive'];
    for (const source of sources) {
      store.markBehind(cf(), source);
      assert.strictEqual(store.list().length, 1);
      assert.strictEqual(store.list()[0].since, first, 'since сохранён');
      assert.strictEqual(store.list()[0].source, source);
    }
  });

  test('персистентность: новый экземпляр (перезапуск) читает то же состояние', () => {
    const store = newStore();
    store.markBehind(cf(), 'load-without-update');
    store.markBehind(cfe('Расш'), 'cf-file-load');
    const before = store.list();

    const restarted = newStore();

    assert.deepStrictEqual(restarted.list(), before);
    assert.strictEqual(restarted.isBehind(cf()), true);
    assert.strictEqual(restarted.isBehind(cfe('Расш')), true);
  });

  test('формат файла: version 1, ключ buildScopeKey, rootPath относительно проекта через "/", extensionName только у cfe', () => {
    const store = newStore();
    store.markBehind(cf(), 'load-without-update');
    store.markBehind(cfe('Расш'), 'repository-receive');

    const data = readFile();

    assert.strictEqual(data.version, 1);
    assert.deepStrictEqual(Object.keys(data.targets).sort(), [buildScopeKey('cf', cfRoot), buildScopeKey('cfe', cfeRoot, 'Расш')].sort());
    const cfEntry = data.targets[buildScopeKey('cf', cfRoot)];
    assert.strictEqual(cfEntry.kind, 'cf');
    assert.strictEqual(cfEntry.name, 'Основная');
    assert.strictEqual(cfEntry.rootPath, 'src/cf');
    assert.strictEqual(cfEntry.source, 'load-without-update');
    assert.ok(!('extensionName' in cfEntry));
    const cfeEntry = data.targets[buildScopeKey('cfe', cfeRoot, 'Расш')];
    assert.strictEqual(cfeEntry.rootPath, 'src/cfe/Расш');
    assert.strictEqual(cfeEntry.extensionName, 'Расш');
    assert.ok(!path.isAbsolute(cfeEntry.rootPath));
  });

  test('после записей в каталоге только lag.json: временных файлов атомарной записи нет', () => {
    const store = newStore();
    store.markBehind(cf(), 'load-without-update');
    store.markBehind(cfe('Расш'), 'update-failed');
    store.markCurrent(cf());

    assert.deepStrictEqual(fs.readdirSync(path.dirname(lagFile())), ['lag.json']);
  });

  suite('битый или чужой файл → пустое состояние + строка в журнал, без исключения', () => {
    const cases: [string, () => string | Buffer][] = [
      ['не JSON', () => '{not json'],
      ['пустой файл', () => ''],
      ['чужая версия', () => JSON.stringify({ version: 2, targets: { x: {} } })],
      ['версии нет', () => JSON.stringify({ targets: {} })],
      ['targets не объект', () => JSON.stringify({ version: 1, targets: [] })],
      ['корень — массив', () => '[]'],
    ];
    for (const [title, content] of cases) {
      test(title, () => {
        fs.mkdirSync(path.dirname(lagFile()), { recursive: true });
        fs.writeFileSync(lagFile(), content());

        const store = newStore();

        assert.deepStrictEqual(store.list(), []);
        assert.strictEqual(store.isBehind(cf()), false);
        assert.strictEqual(lines.length, 1, lines.join('|'));
        assert.ok(lines[0].includes('lag.json'), lines[0]);
        store.markBehind(cf(), 'load-without-update');
        assert.strictEqual(readFile().version, 1, 'после записи файл снова корректен');
      });
    }
  });

  test('запись целей с невалидными полями пропускается, валидные остаются', () => {
    fs.mkdirSync(path.dirname(lagFile()), { recursive: true });
    const good = { kind: 'cf', name: 'Основная', rootPath: 'src/cf', since: '2026-01-01T00:00:00.000Z', source: 'load-without-update' };
    fs.writeFileSync(lagFile(), JSON.stringify({
      version: 1,
      targets: {
        [buildScopeKey('cf', cfRoot)]: good,
        мусор: { kind: 'xx', name: 1 },
        пусто: null,
      },
    }));

    const store = newStore();

    assert.strictEqual(store.list().length, 1);
    assert.strictEqual(store.isBehind(cf()), true);
  });

  suite('onDidChange: только при реальном изменении', () => {
    test('markBehind: новая цель — событие; та же цель с тем же источником — нет; с другим источником — да', () => {
      const store = newStore();
      let events = 0;
      store.onDidChange(() => { events += 1; });

      store.markBehind(cf(), 'load-without-update');
      assert.strictEqual(events, 1);
      store.markBehind(cf(), 'load-without-update');
      assert.strictEqual(events, 1, 'повтор без изменения');
      store.markBehind(cf(), 'update-failed');
      assert.strictEqual(events, 2, 'сменился источник');
    });

    test('markCurrent: существующая — событие; отсутствующая — нет', () => {
      const store = newStore();
      let events = 0;
      store.markBehind(cf(), 'load-without-update');
      store.onDidChange(() => { events += 1; });

      store.markCurrent(cfe('Нет'));
      assert.strictEqual(events, 0);
      store.markCurrent(cf());
      assert.strictEqual(events, 1);
      store.markCurrent(cf());
      assert.strictEqual(events, 1);
    });

    test('dispose подписки: событий больше нет; другие подписчики продолжают получать', () => {
      const store = newStore();
      let first = 0;
      let second = 0;
      const subscription = store.onDidChange(() => { first += 1; });
      store.onDidChange(() => { second += 1; });

      store.markBehind(cf(), 'load-without-update');
      subscription.dispose();
      store.markCurrent(cf());

      assert.deepStrictEqual([first, second], [1, 2]);
    });
  });

  suite('retainOnly', () => {
    test('оставляет только цели с ключами из набора, остальные удаляются; событие и запись файла', () => {
      const store = newStore();
      store.markBehind(cf(), 'load-without-update');
      store.markBehind(cfe('Расш'), 'update-failed');
      let events = 0;
      store.onDidChange(() => { events += 1; });

      store.retainOnly([buildScopeKey('cf', cfRoot)]);

      assert.strictEqual(store.isBehind(cf()), true);
      assert.strictEqual(store.isBehind(cfe('Расш')), false);
      assert.strictEqual(events, 1);
      assert.deepStrictEqual(Object.keys(readFile().targets), [buildScopeKey('cf', cfRoot)]);
    });

    test('все ключи на месте — ничего не меняется, события нет', () => {
      const store = newStore();
      store.markBehind(cf(), 'load-without-update');
      let events = 0;
      store.onDidChange(() => { events += 1; });

      store.retainOnly([buildScopeKey('cf', cfRoot), buildScopeKey('cfe', cfeRoot, 'Расш')]);

      assert.strictEqual(events, 0);
      assert.strictEqual(store.list().length, 1);
    });

    test('пустой набор очищает всё', () => {
      const store = newStore();
      store.markBehind(cf(), 'load-without-update');
      store.retainOnly([]);
      assert.deepStrictEqual(store.list(), []);
      assert.deepStrictEqual(newStore().list(), [], 'очистка сохранена на диск');
    });
  });

  test('ключ расширения без явного extensionName — по имени цели: markCurrent снимает отметку, поставленную с extensionName', () => {
    const store = newStore();
    store.markBehind(cfe('Расш'), 'load-without-update');

    store.markCurrent({ kind: 'cfe', name: 'Расш', rootPath: cfeRoot });

    assert.strictEqual(store.isBehind(cfe('Расш')), false);
    store.markBehind({ kind: 'cfe', name: 'Расш', rootPath: cfeRoot }, 'cf-file-load');
    assert.strictEqual(store.list()[0].extensionName, 'Расш', 'имя расширения сохраняется и без явного поля');
    assert.strictEqual(lagScopeKey({ kind: 'cf', name: 'Основная', rootPath: cfRoot, extensionName: 'игнор' }), buildScopeKey('cf', cfRoot));
  });

  suite('pruneMissingRoots: чистка после перечитывания конфигураций проекта', () => {
    test('цель, корня которой больше нет, снимается; цель с корнем (регистр и разделители не важны) остаётся', () => {
      const store = newStore();
      store.markBehind(cf(), 'load-without-update');
      store.markBehind(cfe('Расш'), 'update-failed');

      store.pruneMissingRoots([{ kind: 'cf', rootPath: cfRoot.toUpperCase().replace(/\\/g, '/') }]);

      assert.strictEqual(store.isBehind(cf()), true);
      assert.strictEqual(store.isBehind(cfe('Расш')), false);
    });

    test('совпадает каталог, но не вид (cf/cfe) — корня нет', () => {
      const store = newStore();
      store.markBehind(cfe('Расш'), 'repository-receive');
      store.pruneMissingRoots([{ kind: 'cf', rootPath: cfeRoot }]);
      assert.deepStrictEqual(store.list(), []);
    });

    test('отметки cf-file-load не снимаются: CF/CFE-файл грузят и в расширение, которого нет в проекте', () => {
      const store = newStore();
      const outside = cfe('ВнеПроекта', path.join(root, 'src', 'cfe', 'ВнеПроекта'));
      store.markBehind(outside, 'cf-file-load');
      store.markBehind(cf(), 'load-without-update');
      let events = 0;
      store.onDidChange(() => { events += 1; });

      store.pruneMissingRoots([]);

      assert.strictEqual(store.isBehind(outside), true);
      assert.strictEqual(store.isBehind(cf()), false);
      assert.strictEqual(events, 1);
    });
  });

  test('сбой записи файла не роняет операцию: признак остаётся в памяти, события идут, причина — в журнале', () => {
    // Путь каталога признака занят файлом — mkdir/запись невозможны.
    fs.mkdirSync(path.join(root, '.v8vscedit'), { recursive: true });
    fs.writeFileSync(path.join(root, '.v8vscedit', 'database-config'), 'не каталог');
    const store = newStore();
    let events = 0;
    store.onDidChange(() => { events += 1; });

    assert.doesNotThrow(() => { store.markBehind(cf(), 'load-without-update'); });

    assert.strictEqual(store.isBehind(cf()), true);
    assert.strictEqual(events, 1);
    assert.strictEqual(lines.length, 1, lines.join('|'));
    assert.ok(lines[0].includes('Не удалось сохранить'), lines[0]);
    assert.ok(lines[0].includes('lag.json'), lines[0]);
  });

  test('list() возвращает стабильные копии: правка результата не меняет состояние', () => {
    const store = newStore();
    store.markBehind(cf(), 'load-without-update');
    const listed = store.list() as DatabaseLagEntry[];
    listed.length = 0;
    assert.strictEqual(store.list().length, 1);
  });
});
