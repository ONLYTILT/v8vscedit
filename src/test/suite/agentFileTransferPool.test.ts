import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentTransferError,
  forEachConcurrent,
  statFiles,
} from '../../infra/agent/files/AgentFileTransfer';
import type { AgentFileEntry } from '../../infra/agent/files/AgentFileStore';
import { LocalAgentFileStore } from '../../infra/agent/files/LocalAgentFileStore';

/**
 * Пул одновременных операций (plan-archive-avoid.md §3.5): `forEachConcurrent` — ТОТ ЖЕ пул, что у
 * `downloadFiles`/`uploadFiles` (новой реализации нет), `statFiles` — поверх него. Нужен дельте без
 * буфера и с ограниченной конкурентностью: STAT/LIST по SFTP последовательно — это минуты на тысячах
 * владельцев. Тайминги не угадываются: параллельность проверяется числом одновременно «живых» вызовов.
 */

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class MeteredStore extends LocalAgentFileStore {
  inFlight = 0;
  maxInFlight = 0;
  override async stat(rel: string): Promise<AgentFileEntry | undefined> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await tick();
      return await super.stat(rel);
    } finally {
      this.inFlight -= 1;
    }
  }
}

suite('AgentFileTransfer: forEachConcurrent', () => {
  const items = (count: number): string[] => Array.from({ length: count }, (_, i) => `item-${String(i).padStart(2, '0')}`);

  test('каждый элемент обрабатывается ровно один раз, старт — в порядке массива; результат — число и отсутствие отмены', async () => {
    const started: string[] = [];
    const result = await forEachConcurrent(items(7), async (item) => { started.push(item); await tick(); }, { concurrency: 3 });
    assert.deepStrictEqual(started, items(7));
    assert.deepStrictEqual(result, { transferred: 7, cancelled: false });
  });

  for (const concurrency of [1, 2, 3, 16]) {
    test(`concurrency=${String(concurrency)}: одновременно не более лимита, и лимит достигается, если элементов хватает`, async () => {
      let inFlight = 0;
      let max = 0;
      await forEachConcurrent(items(20), async () => {
        inFlight += 1;
        max = Math.max(max, inFlight);
        await tick();
        inFlight -= 1;
      }, { concurrency });
      assert.strictEqual(max, concurrency);
    });
  }

  test('по умолчанию — 16 одновременных', async () => {
    let inFlight = 0;
    let max = 0;
    await forEachConcurrent(items(40), async () => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await tick();
      inFlight -= 1;
    });
    assert.strictEqual(max, 16);
  });

  test('пустой список: функция не вызывается', async () => {
    const result = await forEachConcurrent([], () => assert.fail('не должна вызываться'));
    assert.deepStrictEqual(result, { transferred: 0, cancelled: false });
  });

  test('первая ошибка: новые элементы не стартуют, отказ — AgentTransferError с путём элемента', async () => {
    const started: string[] = [];
    await assert.rejects(
      forEachConcurrent(items(6), (item) => {
        started.push(item);
        return item === 'item-01' ? Promise.reject(new Error('сбой элемента')) : Promise.resolve();
      }, { concurrency: 1 }),
      (error: unknown) => error instanceof AgentTransferError
        && error.failures.length === 1
        && error.failures[0].path === 'item-01'
        && error.message.includes('сбой элемента')
    );
    assert.deepStrictEqual(started, ['item-00', 'item-01']);
  });

  test('отмена посередине: оставшиеся не стартуют, cancelled=true', async () => {
    const cancellation = { isCancellationRequested: false };
    const seen: string[] = [];
    const result = await forEachConcurrent(items(5), (item) => {
      seen.push(item);
      if (seen.length === 2) {
        cancellation.isCancellationRequested = true;
      }
      return Promise.resolve();
    }, { concurrency: 1, cancellation });
    assert.deepStrictEqual(seen, items(5).slice(0, 2));
    assert.deepStrictEqual(result, { transferred: 2, cancelled: true });
  });

  test('отмена до старта: ни одного вызова', async () => {
    const result = await forEachConcurrent(items(3), () => assert.fail('не должна вызываться'), {
      cancellation: { isCancellationRequested: true },
    });
    assert.deepStrictEqual(result, { transferred: 0, cancelled: true });
  });

  for (const bad of [0, -1, 1.5, Number.NaN]) {
    test(`некорректная конкурентность ${String(bad)} → RangeError (общая проверка пула)`, async () => {
      await assert.rejects(forEachConcurrent(items(2), () => Promise.resolve(), { concurrency: bad }), RangeError);
    });
  }
});

suite('AgentFileTransfer: statFiles', () => {
  let base: string;
  let store: MeteredStore;

  setup(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-stat-files-'));
    store = new MeteredStore(base);
    fs.mkdirSync(path.join(base, 'dir', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(base, 'dir', 'a.txt'), 'abc');
    fs.writeFileSync(path.join(base, 'dir', 'Кириллица.txt'), 'д');
  });
  teardown(() => { fs.rmSync(base, { recursive: true, force: true }); });

  test('файл, каталог и отсутствующий путь: запись или undefined по каждому запрошенному пути', async () => {
    const map = await statFiles(store, ['dir/a.txt', 'dir/sub', 'dir/нет.txt', 'dir/Кириллица.txt']);
    assert.deepStrictEqual([...map.keys()], ['dir/a.txt', 'dir/sub', 'dir/нет.txt', 'dir/Кириллица.txt']);
    assert.deepStrictEqual(map.get('dir/a.txt'), { path: 'dir/a.txt', type: 'file', size: 3 });
    assert.strictEqual(map.get('dir/sub')?.type, 'dir');
    assert.ok(map.has('dir/нет.txt') && map.get('dir/нет.txt') === undefined);
    assert.strictEqual(map.get('dir/Кириллица.txt')?.type, 'file');
  });

  test('пустой список → пустая карта, обращений к хранилищу нет', async () => {
    const map = await statFiles(store, []);
    assert.strictEqual(map.size, 0);
    assert.strictEqual(store.maxInFlight, 0);
  });

  test('конкурентность: одновременно не более лимита STAT', async () => {
    const rels = Array.from({ length: 30 }, (_, i) => `dir/нет-${String(i)}.txt`);
    await statFiles(store, rels, { concurrency: 4 });
    assert.strictEqual(store.maxInFlight, 4);
  });

  test('отмена до старта: карта без записей, обращений нет', async () => {
    const map = await statFiles(store, ['dir/a.txt'], { cancellation: { isCancellationRequested: true } });
    assert.strictEqual(map.size, 0);
    assert.strictEqual(store.maxInFlight, 0);
  });
});
