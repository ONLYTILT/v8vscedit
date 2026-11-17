import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentTransferError,
  DEFAULT_AGENT_TRANSFER_CONCURRENCY,
  downloadFiles,
  uploadFiles,
  type AgentTransferProgress,
} from '../../infra/agent/files/AgentFileTransfer';
import { LocalAgentFileStore } from '../../infra/agent/files/LocalAgentFileStore';
import type { AgentFileStore } from '../../infra/agent/files/AgentFileStore';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Настоящее локальное хранилище с измерением максимума одновременных обращений. */
class MeteredStore extends LocalAgentFileStore {
  inFlight = 0;
  maxInFlight = 0;
  readonly started: string[] = [];
  onRead?: (rel: string) => Promise<void>;

  override async readFile(rel: string): Promise<Buffer> {
    this.started.push(rel);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await tick();
      await this.onRead?.(rel);
      return await super.readFile(rel);
    } finally {
      this.inFlight -= 1;
    }
  }

  override async writeFile(rel: string, data: Uint8Array | string): Promise<void> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await tick();
      await super.writeFile(rel, data);
    } finally {
      this.inFlight -= 1;
    }
  }
}

suite('AgentFileTransfer', () => {
  let base: string;
  let store: MeteredStore;

  setup(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-transfer-'));
    store = new MeteredStore(base);
  });
  teardown(() => { fs.rmSync(base, { recursive: true, force: true }); });

  async function seed(count: number): Promise<string[]> {
    const rels: string[] = [];
    for (let i = 0; i < count; i++) {
      const rel = `files/f${String(i).padStart(3, '0')}.txt`;
      await LocalAgentFileStore.prototype.writeFile.call(store, rel, `содержимое-${String(i)}`);
      rels.push(rel);
    }
    return rels;
  }

  test('константа конкурентности по умолчанию = 16', () => {
    assert.strictEqual(DEFAULT_AGENT_TRANSFER_CONCURRENCY, 16);
  });

  suite('downloadFiles', () => {
    test('каждый файл отдаётся в sink с содержимым; результат — число и отсутствие отмены', async () => {
      const rels = await seed(5);
      const got = new Map<string, string>();
      const result = await downloadFiles(store, rels, (rel, data) => { got.set(rel, data.toString('utf-8')); });
      assert.deepStrictEqual(result, { transferred: 5, cancelled: false });
      assert.strictEqual(got.size, 5);
      assert.strictEqual(got.get('files/f003.txt'), 'содержимое-3');
    });

    test('асинхронный sink ожидается', async () => {
      const rels = await seed(2);
      const done: string[] = [];
      await downloadFiles(store, rels, async (rel) => { await tick(); done.push(rel); });
      assert.strictEqual(done.length, 2);
    });

    test('по умолчанию одновременно не более 16 запросов (и 16 достигается)', async () => {
      const rels = await seed(40);
      await downloadFiles(store, rels, () => undefined);
      assert.strictEqual(store.maxInFlight, 16);
    });

    test('явный лимит соблюдается', async () => {
      const rels = await seed(10);
      await downloadFiles(store, rels, () => undefined, { concurrency: 3 });
      assert.strictEqual(store.maxInFlight, 3);
    });

    test('лимит больше числа файлов не создаёт лишнего параллелизма', async () => {
      const rels = await seed(2);
      await downloadFiles(store, rels, () => undefined, { concurrency: 16 });
      assert.strictEqual(store.maxInFlight, 2);
    });

    test('пустой список: ничего не вызывается, результат нулевой', async () => {
      const progress: AgentTransferProgress[] = [];
      const result = await downloadFiles(store, [], () => assert.fail('sink не должен вызываться'), {
        onProgress: (p) => progress.push(p),
      });
      assert.deepStrictEqual(result, { transferred: 0, cancelled: false });
      assert.deepStrictEqual(progress, []);
    });

    test('прогресс: по одному событию на файл, done растёт 1..N, total = N', async () => {
      const rels = await seed(6);
      const progress: AgentTransferProgress[] = [];
      await downloadFiles(store, rels, () => undefined, { concurrency: 2, onProgress: (p) => progress.push(p) });
      assert.deepStrictEqual(progress.map((p) => p.done), [1, 2, 3, 4, 5, 6]);
      assert.ok(progress.every((p) => p.total === 6));
      assert.deepStrictEqual([...progress.map((p) => p.path)].sort(), [...rels].sort());
    });

    test('отмена посередине: оставшиеся не стартуют, результат cancelled=true', async () => {
      const rels = await seed(5);
      const cancellation = { isCancellationRequested: false };
      const seen: string[] = [];
      const result = await downloadFiles(store, rels, (rel) => { seen.push(rel); }, {
        concurrency: 1,
        cancellation,
        onProgress: (p) => { if (p.done === 2) { cancellation.isCancellationRequested = true; } },
      });
      assert.deepStrictEqual(result, { transferred: 2, cancelled: true });
      assert.deepStrictEqual(seen, rels.slice(0, 2));
      assert.deepStrictEqual(store.started, rels.slice(0, 2));
    });

    test('отмена до старта: ни одного обращения к хранилищу', async () => {
      const rels = await seed(3);
      const result = await downloadFiles(store, rels, () => assert.fail('не должен вызываться'), {
        cancellation: { isCancellationRequested: true },
      });
      assert.deepStrictEqual(result, { transferred: 0, cancelled: true });
      assert.deepStrictEqual(store.started, []);
    });

    test('ошибка файла: новые не стартуют, AgentTransferError с перечнем и причиной', async () => {
      const rels = await seed(4);
      rels.splice(1, 0, 'files/missing.txt');
      const error = await downloadFiles(store, rels, () => undefined, { concurrency: 1 }).then(
        () => undefined,
        (e: unknown) => e
      );
      assert.ok(error instanceof AgentTransferError);
      assert.deepStrictEqual(error.failures.map((f) => f.path), ['files/missing.txt']);
      assert.ok(error.failures[0].error instanceof Error);
      assert.match(error.message, /files\/missing\.txt/);
      assert.deepStrictEqual(store.started, [rels[0], 'files/missing.txt']);
    });

    test('несколько одновременных ошибок попадают в перечень все', async () => {
      const rels = ['files/m1.txt', 'files/m2.txt', 'files/m3.txt', 'files/m4.txt', 'files/m5.txt'];
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      store.onRead = async () => {
        arrived += 1;
        if (arrived === 3) { release(); }
        await gate;
      };
      const error = await downloadFiles(store, rels, () => undefined, { concurrency: 3 }).then(
        () => undefined,
        (e: unknown) => e
      );
      assert.ok(error instanceof AgentTransferError);
      assert.deepStrictEqual(error.failures.map((f) => f.path).sort(), ['files/m1.txt', 'files/m2.txt', 'files/m3.txt']);
      for (const rel of ['m1', 'm2', 'm3']) {
        assert.match(error.message, new RegExp(`files/${rel}\\.txt`));
      }
      assert.strictEqual(store.started.length, 3);
    });

    test('исключение sink (в т.ч. не Error) считается ошибкой файла', async () => {
      const rels = await seed(2);
      // Бросается не Error намеренно: проверяется нормализация произвольного исключения sink.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      const error = await downloadFiles(store, rels, () => { throw 'строка вместо Error'; }, { concurrency: 1 }).then(
        () => undefined,
        (e: unknown) => e
      );
      assert.ok(error instanceof AgentTransferError);
      assert.deepStrictEqual(error.failures.map((f) => f.path), [rels[0]]);
      assert.ok(error.failures[0].error instanceof Error);
      assert.match(error.failures[0].error.message, /строка вместо Error/);
    });

    test('некорректная конкурентность → RangeError', async () => {
      for (const concurrency of [0, -1, 1.5, Number.NaN]) {
        await assert.rejects(
          downloadFiles(store, ['x'], () => undefined, { concurrency }),
          (e: unknown) => e instanceof RangeError && /конкурентност/i.test(e.message),
          String(concurrency)
        );
      }
    });
  });

  suite('uploadFiles', () => {
    test('источник читается по rel, результат записан в хранилище байт-в-байт', async () => {
      const rels = ['up/a.bin', 'up/Б/в.txt', 'up/c.xml'];
      const payload = (rel: string): Uint8Array => new TextEncoder().encode(`данные ${rel}`);
      const result = await uploadFiles(store, rels, payload);
      assert.deepStrictEqual(result, { transferred: 3, cancelled: false });
      for (const rel of rels) {
        assert.deepStrictEqual([...fs.readFileSync(path.join(base, rel))], [...payload(rel)]);
      }
    });

    test('асинхронный источник; лимит конкурентности соблюдается', async () => {
      const rels = Array.from({ length: 12 }, (_, i) => `up/f${String(i)}.txt`);
      await uploadFiles(store, rels, async (rel) => { await tick(); return new TextEncoder().encode(rel); }, { concurrency: 4 });
      assert.strictEqual(store.maxInFlight, 4);
      assert.strictEqual(fs.readdirSync(path.join(base, 'up')).length, 12);
    });

    test('прогресс и отмена работают так же, как при скачивании', async () => {
      const rels = ['u/1', 'u/2', 'u/3', 'u/4'];
      const cancellation = { isCancellationRequested: false };
      const progress: number[] = [];
      const result = await uploadFiles(store, rels, () => new Uint8Array([1]), {
        concurrency: 1,
        cancellation,
        onProgress: (p) => {
          progress.push(p.done);
          if (p.done === 1) { cancellation.isCancellationRequested = true; }
        },
      });
      assert.deepStrictEqual(result, { transferred: 1, cancelled: true });
      assert.deepStrictEqual(progress, [1]);
      assert.strictEqual(fs.existsSync(path.join(base, 'u', '2')), false);
    });

    test('ошибка источника или хранилища → AgentTransferError с путём файла', async () => {
      const error = await uploadFiles(store, ['u/ok', 'u/bad', 'u/never'], (rel) => {
        if (rel === 'u/bad') { throw new Error('источник недоступен'); }
        return new Uint8Array([1]);
      }, { concurrency: 1 }).then(() => undefined, (e: unknown) => e);
      assert.ok(error instanceof AgentTransferError);
      assert.deepStrictEqual(error.failures.map((f) => f.path), ['u/bad']);
      assert.match(error.message, /u\/bad/);
      assert.match(error.message, /источник недоступен/);
      assert.strictEqual(fs.existsSync(path.join(base, 'u', 'never')), false);

      const escaping = await uploadFiles(store, ['../outside.txt'], () => new Uint8Array([1])).then(() => undefined, (e: unknown) => e);
      assert.ok(escaping instanceof AgentTransferError);
    });

    test('некорректная конкурентность → RangeError', async () => {
      await assert.rejects(uploadFiles(store, ['x'], () => new Uint8Array(), { concurrency: 0 }), RangeError);
    });

    test('пустой список', async () => {
      assert.deepStrictEqual(await uploadFiles(store, [], () => new Uint8Array()), { transferred: 0, cancelled: false });
    });
  });

  test('функции принимают любое реализующее контракт хранилище (тип AgentFileStore)', async () => {
    const asContract: AgentFileStore = store;
    await asContract.writeFile('c/x.txt', '1');
    const got: string[] = [];
    await downloadFiles(asContract, ['c/x.txt'], (rel) => { got.push(rel); });
    assert.deepStrictEqual(got, ['c/x.txt']);
  });
});
