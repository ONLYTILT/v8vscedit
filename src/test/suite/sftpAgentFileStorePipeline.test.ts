import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentConnectPolicyOptions } from '../../domain/agent';
import { connectSftpAgentFileStore, type SftpAgentFileStore } from '../../infra/agent/files/SftpAgentFileStore';
import { AgentSshTestServer } from './support/agentSshTestServer';
import { patternBytes } from './support/zipFixtures';

/**
 * Н32 (обязательно до Э7): конвейерный обмен SFTP. Раньше хранилище читало и писало порциями по
 * ~32 КБ строго по одной в полёте: при задержке 80 мс это ≈400 КБ/с, архив `dump --archive` так
 * передавать нельзя. Требование: при чтении и записи ОДНОГО большого файла одновременно в полёте
 * несколько порций (как `fastGet`/`fastPut` у ssh2); содержимое — байт-в-байт на любых размерах
 * (границы порции, не кратные размеры, пустой файл). Удержание ответов (`hold`/`pendingCount`)
 * эмулятора делает проверку детерминированной: ждём событие «≥ N запросов придержано».
 */

const POLICY: AgentConnectPolicyOptions = { startupTimeoutMs: 5_000, authWarmupMs: 90_000, retryDelayMs: 1_000 };
const CHUNK = 32 * 1024;
/** Минимум одновременных порций, который считается конвейером (последовательный обмен даёт 1). */
const MIN_IN_FLIGHT = 4;
const BIG = 40 * CHUNK + 7;

suite('SftpAgentFileStore: конвейерный обмен (Н32)', function () {
  this.timeout(60_000);
  let base: string;
  let root: string;
  let server: AgentSshTestServer;
  let store: SftpAgentFileStore;

  setup(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-sftp-pipeline-'));
    root = path.join(base, 'user-root');
    fs.mkdirSync(root);
    server = await AgentSshTestServer.start({ sftpRoot: root });
    store = await connectSftpAgentFileStore({
      host: '127.0.0.1',
      port: server.port,
      user: 'admin',
      password: 'secret',
      connectTimeoutSeconds: 5,
      policy: POLICY,
    });
  });
  teardown(async () => {
    await store.dispose();
    await server.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  function backend(): NonNullable<AgentSshTestServer['sftp']> {
    assert.ok(server.sftp);
    return server.sftp;
  }

  /** Ждёт, пока сервер придержит `count` запросов; вместо вечного ожидания (последовательный код) — внятный отказ. */
  async function expectInFlight(gate: { waitForPending(n: number): Promise<void>; pendingCount(): number }, count: number, what: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), 4_000); });
    const outcome = await Promise.race([gate.waitForPending(count).then(() => 'ok' as const), timeout]);
    if (timer) {
      clearTimeout(timer);
    }
    assert.strictEqual(outcome, 'ok', `${what}: одновременно в полёте ${String(gate.pendingCount())} запросов, ожидалось ≥ ${String(count)} (обмен последовательный?)`);
  }

  suite('чтение', () => {
    test(`один большой файл читается с ≥ ${String(MIN_IN_FLIGHT)} порциями в полёте; содержимое байт-в-байт`, async () => {
      const data = patternBytes(BIG, 41);
      fs.writeFileSync(path.join(root, 'big.bin'), data);
      const gate = backend().hold('READ');

      const reading = store.readFile('big.bin');
      await expectInFlight(gate, MIN_IN_FLIGHT, 'чтение');
      assert.ok(gate.pendingCount() >= MIN_IN_FLIGHT);
      gate.release();

      const result = await reading;
      assert.strictEqual(result.length, data.length);
      assert.ok(data.equals(result));
    });

    for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, 8 * CHUNK + 13, 1_000_003]) {
      test(`размер ${String(size)} байт: байт-в-байт (границы порции, не кратные размеры, пустой файл)`, async () => {
        const data = patternBytes(size, size + 1);
        fs.writeFileSync(path.join(root, 'f.bin'), data);
        const result = await store.readFile('f.bin');
        assert.strictEqual(result.length, size);
        assert.ok(data.equals(result));
      });
    }

    test('несколько больших файлов читаются параллельно друг с другом и не путаются', async () => {
      const files = [11, 12, 13].map((seed) => ({ rel: `m/${String(seed)}.bin`, data: patternBytes(300_000 + seed, seed) }));
      fs.mkdirSync(path.join(root, 'm'));
      for (const file of files) {
        fs.writeFileSync(path.join(root, ...file.rel.split('/')), file.data);
      }
      const results = await Promise.all(files.map((file) => store.readFile(file.rel)));
      results.forEach((result, index) => assert.ok(files[index].data.equals(result), files[index].rel));
    });

    test('отказ сервера на одной порции: readFile отклоняется с путём, дескриптор закрыт, хранилище остаётся рабочим', async () => {
      fs.writeFileSync(path.join(root, 'big.bin'), patternBytes(BIG, 42));
      backend().failNext({ op: 'READ', times: 1, code: 'FAILURE' });
      const closesBefore = backend().ops('CLOSE').length;

      await assert.rejects(store.readFile('big.bin'), /big\.bin/);

      assert.ok(backend().ops('CLOSE').length > closesBefore, 'после сбоя дескриптор файла закрыт');
      fs.writeFileSync(path.join(root, 'ok.txt'), 'жив');
      assert.strictEqual((await store.readFile('ok.txt')).toString('utf-8'), 'жив');
    });

    test('обрыв соединения посреди чтения большого файла: отказ, а не зависание', async () => {
      fs.writeFileSync(path.join(root, 'big.bin'), patternBytes(BIG, 43));
      backend().dropConnectionOn('READ', () => server.dropClients());
      await assert.rejects(store.readFile('big.bin'));
    });

    test('файла нет → отказ с путём, без зависания конвейера', async () => {
      await assert.rejects(store.readFile('нет/такого.bin'), /такого\.bin/);
    });
  });

  suite('запись', () => {
    test(`один большой файл пишется с ≥ ${String(MIN_IN_FLIGHT)} порциями в полёте; файл на диске байт-в-байт, временных остатков нет`, async () => {
      const data = patternBytes(BIG, 51);
      const gate = backend().hold('WRITE');

      const writing = store.writeFile('out/big.bin', data);
      await expectInFlight(gate, MIN_IN_FLIGHT, 'запись');
      assert.ok(gate.pendingCount() >= MIN_IN_FLIGHT);
      gate.release();
      await writing;

      assert.ok(data.equals(fs.readFileSync(path.join(root, 'out', 'big.bin'))));
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'out')), ['big.bin']);
    });

    for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, 8 * CHUNK + 13, 1_000_003]) {
      test(`размер ${String(size)} байт: запись байт-в-байт и чтение обратно`, async () => {
        const data = patternBytes(size, size + 2);
        await store.writeFile('w/f.bin', data);
        assert.ok(data.equals(fs.readFileSync(path.join(root, 'w', 'f.bin'))));
        assert.ok(data.equals(await store.readFile('w/f.bin')));
      });
    }

    test('перезапись существующего файла большим содержимым: итог — только новое содержимое', async () => {
      fs.mkdirSync(path.join(root, 'o'));
      fs.writeFileSync(path.join(root, 'o', 'f.bin'), patternBytes(2_000_000, 1));
      const next = patternBytes(BIG, 61);
      await store.writeFile('o/f.bin', next);
      assert.ok(next.equals(fs.readFileSync(path.join(root, 'o', 'f.bin'))));
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'o')), ['f.bin']);
    });

    test('строка пишется как UTF-8 без BOM и через конвейер (кириллица на границе порции)', async () => {
      const text = 'я'.repeat(CHUNK) + 'Ж'; // 2 байта на символ: граница порции приходится на середину потока
      await store.writeFile('t/text.txt', text);
      assert.strictEqual(fs.readFileSync(path.join(root, 't', 'text.txt'), 'utf-8'), text);
    });

    test('отказ сервера на одной порции: writeFile отклоняется, прежний файл цел, временный файл убран', async () => {
      fs.mkdirSync(path.join(root, 'k'));
      const old = patternBytes(1_000, 2);
      fs.writeFileSync(path.join(root, 'k', 'f.bin'), old);
      backend().failNext({ op: 'WRITE', times: 1, code: 'FAILURE' });

      await assert.rejects(store.writeFile('k/f.bin', patternBytes(BIG, 71)), /f\.bin/);

      assert.ok(old.equals(fs.readFileSync(path.join(root, 'k', 'f.bin'))), 'цель не тронута');
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'k')), ['f.bin']);
      await store.writeFile('k/after.txt', 'жив');
      assert.strictEqual(fs.readFileSync(path.join(root, 'k', 'after.txt'), 'utf-8'), 'жив');
    });

    test('обрыв соединения посреди записи большого файла: отказ, а не зависание', async () => {
      backend().dropConnectionOn('WRITE', () => server.dropClients());
      await assert.rejects(store.writeFile('d/big.bin', patternBytes(BIG, 72)));
    });
  });

  suite('чтение: ответы сервера короче запроса (Н39)', () => {
    test('сервер отвечает на READ не более 1000 байт: остаток каждой порции дочитывается, результат байт-в-байт', async () => {
      const data = patternBytes(3 * CHUNK + 11, 81);
      fs.writeFileSync(path.join(root, 'short.bin'), data);
      backend().readResponseLimit = 1000;
      const result = await store.readFile('short.bin');
      assert.ok(data.equals(result));
      assert.ok(backend().ops('READ').length > Math.ceil(data.length / CHUNK), 'порции дочитывались несколькими READ');
    });

    test('файл укоротили после FSTAT (EOF раньше размера): отказ с путём, а не обрезанное содержимое', async () => {
      const file = path.join(root, 'shrink.bin');
      fs.writeFileSync(file, patternBytes(BIG, 82));
      const gate = backend().hold('READ');

      const reading = store.readFile('shrink.bin');
      await expectInFlight(gate, 1, 'чтение');
      fs.truncateSync(file, CHUNK);
      gate.release();

      await assert.rejects(reading, /shrink\.bin.*изменился во время чтения/);
    });
  });

  suite('чтение: FSTAT без размера', () => {
    test('сервер не сообщает размер в FSTAT: последовательное чтение до EOF, байт-в-байт, без TypeError', async () => {
      const data = patternBytes(3 * CHUNK + 5, 91);
      fs.writeFileSync(path.join(root, 'nosize.bin'), data);
      fs.writeFileSync(path.join(root, 'empty.bin'), Buffer.alloc(0));
      backend().fstatWithoutSize = true;
      assert.ok(data.equals(await store.readFile('nosize.bin')));
      assert.strictEqual((await store.readFile('empty.bin')).length, 0);
    });
  });
});
