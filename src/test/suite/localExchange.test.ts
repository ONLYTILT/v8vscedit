import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLocalExchange, pruneStaleLocalExchanges } from '../../infra/agent/sync/LocalExchange';

/**
 * Локальный каталог обмена операции (`<root>/<operationId>`): место потокового архива на ЭТОЙ машине.
 * Каталог создаётся лениво (операция без архива его не оставляет), убирается на обоих путях
 * `runOperation`, а остатки упавших операций той же цели вычищаются в начале следующей. Удаление — свой
 * обход `unlink`/`rmdir`, не `fs.rmSync` (запрет №19: на Windows `rmSync` молча не удаляет файл с
 * кириллицей в имени), поэтому тесты кладут кириллицу и проверяют, что файл ДЕЙСТВИТЕЛЬНО исчез.
 */
suite('LocalExchange', () => {
  let base: string;
  let root: string;

  setup(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-local-exchange-'));
    root = path.join(base, 'agent-exchange');
  });
  teardown(() => { fs.rmSync(base, { recursive: true, force: true }); });

  function populate(dir: string): void {
    fs.mkdirSync(path.join(dir, 'Каталог', 'Вложенный'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'full.zip'), 'zip');
    fs.writeFileSync(path.join(dir, 'Файл с кириллицей.xml'), '1');
    fs.writeFileSync(path.join(dir, 'Каталог', 'Вложенный', 'Модуль.bsl'), '2');
  }

  suite('createLocalExchange', () => {
    test('каталог создаётся лениво: до file() ни корня, ни каталога операции', () => {
      createLocalExchange(root, 'cf-1');
      assert.strictEqual(fs.existsSync(root), false);
    });

    test('file(): путь внутри <root>/<operationId>, каталог создан, сам файл — нет; повторный вызов даёт тот же путь', async () => {
      const exchange = createLocalExchange(root, 'cf-1');
      const first = await exchange.file('full.zip');
      assert.strictEqual(path.resolve(first), path.resolve(root, 'cf-1', 'full.zip'));
      assert.ok(fs.statSync(path.dirname(first)).isDirectory());
      assert.strictEqual(fs.existsSync(first), false, 'файл создаёт владелец потока, а не обмен');
      assert.strictEqual(await exchange.file('full.zip'), first);
      assert.strictEqual(path.dirname(await exchange.file('other.zip')), path.dirname(first));
    });

    test('dispose удаляет каталог со всем содержимым — файлы и вложенные каталоги с кириллицей реально исчезают (запрет №19)', async () => {
      const exchange = createLocalExchange(root, 'cf-1');
      const dir = path.dirname(await exchange.file('full.zip'));
      populate(dir);

      await exchange.dispose();

      assert.strictEqual(fs.existsSync(path.join(dir, 'Файл с кириллицей.xml')), false);
      assert.strictEqual(fs.existsSync(path.join(dir, 'Каталог', 'Вложенный', 'Модуль.bsl')), false);
      assert.strictEqual(fs.existsSync(dir), false);
      assert.ok(fs.existsSync(root), 'корень обмена остаётся: в нём могут лежать каталоги других операций');
    });

    test('dispose не трогает соседей по корню', async () => {
      const neighbour = path.join(root, 'cf-2');
      fs.mkdirSync(neighbour, { recursive: true });
      fs.writeFileSync(path.join(neighbour, 'full.zip'), 'zip');
      const exchange = createLocalExchange(root, 'cf-1');
      await exchange.file('full.zip');
      await exchange.dispose();
      assert.ok(fs.existsSync(path.join(neighbour, 'full.zip')));
    });

    test('повторный dispose и dispose без создания каталога — без ошибок и без побочных каталогов', async () => {
      const exchange = createLocalExchange(root, 'cf-1');
      await exchange.dispose();
      assert.strictEqual(fs.existsSync(root), false, 'dispose без file() ничего не создаёт');
      await exchange.file('full.zip');
      await exchange.dispose();
      await exchange.dispose();
    });

    test('ошибка уборки проглатывается (остаток безвреден), dispose не бросает', async () => {
      const exchange = createLocalExchange(root, 'cf-1');
      const dir = path.dirname(await exchange.file('full.zip'));
      // Вместо каталога операции — файл: обход каталога обязан упасть (ENOTDIR), а dispose — нет.
      fs.rmdirSync(dir);
      fs.writeFileSync(dir, 'не каталог');
      await exchange.dispose();
      assert.ok(fs.existsSync(dir));
    });
  });

  suite('pruneStaleLocalExchanges', () => {
    test('удаляет каталоги своей цели (по префиксу operationId), кроме текущего; чужие цели и посторонние каталоги остаются', async () => {
      for (const name of ['cf-1', 'cf-2', 'cf-3', 'cfe-Расш-1', 'cfe-Другое-5', 'постороннее']) {
        populate(path.join(root, name));
      }

      await pruneStaleLocalExchanges(root, 'cf-', 'cf-3');

      assert.deepStrictEqual(fs.readdirSync(root).sort(), ['cf-3', 'cfe-Другое-5', 'cfe-Расш-1', 'постороннее']);
      assert.ok(fs.existsSync(path.join(root, 'cf-3', 'Каталог', 'Вложенный', 'Модуль.bsl')), 'текущая операция не тронута');
    });

    test('расширение: префикс cfe-<имя>- не задевает основную конфигурацию и другие расширения', async () => {
      for (const name of ['cf-1', 'cfe-Расш-1', 'cfe-Расш-2', 'cfe-Расширение-1']) {
        populate(path.join(root, name));
      }

      await pruneStaleLocalExchanges(root, 'cfe-Расш-', 'cfe-Расш-2');

      assert.deepStrictEqual(fs.readdirSync(root).sort(), ['cf-1', 'cfe-Расш-2', 'cfe-Расширение-1']);
    });

    test('расширения «X» и «X-Y»: префикс cfe-X- не задевает каталоги cfe-X-Y-<время> (хвост — только число)', async () => {
      for (const name of ['cfe-X-1', 'cfe-X-2', 'cfe-X-Y-3', 'cfe-X-Y-4']) {
        populate(path.join(root, name));
      }

      await pruneStaleLocalExchanges(root, 'cfe-X-', 'cfe-X-2');
      assert.deepStrictEqual(fs.readdirSync(root).sort(), ['cfe-X-2', 'cfe-X-Y-3', 'cfe-X-Y-4']);

      await pruneStaleLocalExchanges(root, 'cfe-X-Y-', 'cfe-X-Y-4');
      assert.deepStrictEqual(fs.readdirSync(root).sort(), ['cfe-X-2', 'cfe-X-Y-4']);
    });

    test('содержимое удаляемых каталогов (кириллица) действительно исчезает', async () => {
      const stale = path.join(root, 'cf-1');
      populate(stale);
      await pruneStaleLocalExchanges(root, 'cf-', 'cf-9');
      assert.strictEqual(fs.existsSync(path.join(stale, 'Файл с кириллицей.xml')), false);
      assert.strictEqual(fs.existsSync(stale), false);
    });

    test('корня обмена нет → без ошибки и без создания', async () => {
      await pruneStaleLocalExchanges(root, 'cf-', 'cf-1');
      assert.strictEqual(fs.existsSync(root), false);
    });

    test('ошибка удаления одного остатка проглатывается, остальные остатки убираются', async () => {
      populate(path.join(root, 'cf-1'));
      fs.writeFileSync(path.join(root, 'cf-2'), 'файл вместо каталога');
      populate(path.join(root, 'cf-3'));

      await pruneStaleLocalExchanges(root, 'cf-', 'cf-9');

      assert.strictEqual(fs.existsSync(path.join(root, 'cf-1')), false);
      assert.strictEqual(fs.existsSync(path.join(root, 'cf-3')), false);
    });
  });
});
