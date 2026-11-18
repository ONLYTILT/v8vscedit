import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentConnectPolicyOptions } from '../../domain/agent';
import { AgentTransferCancelledError } from '../../infra/agent/files/AgentFileTransfer';
import { IO_CHUNK, IO_WINDOW } from '../../infra/agent/files/SftpChunkedIo';
import {
  connectSftpAgentFileStore,
  type SftpAgentFileStore,
  type SftpWriteMode,
} from '../../infra/agent/files/SftpAgentFileStore';
import { AgentSshTestServer } from './support/agentSshTestServer';
import type { SftpGate } from './support/agentSftpTestBackend';
import { patternBytes } from './support/zipFixtures';

/**
 * Потоковые `downloadToFile`/`uploadFromFile` SFTP-хранилища на настоящем in-process ssh2.Server.
 * Общий контракт (байты на границах порции, отмена, атомарность, границы корня) гоняется в
 * `defineAgentFileStoreContract`; здесь — то, что зависит от сервера: короткие ответы READ, FSTAT без
 * размера, усечение файла во время чтения, отказ порции, режимы записи atomic/direct/auto, окно
 * конвейера и размер порции. Детерминизм — через `hold`/`waitForPending` эмулятора (ждём событие
 * «придержано N запросов»), а не паузы.
 */

const POLICY: AgentConnectPolicyOptions = { startupTimeoutMs: 5_000, authWarmupMs: 90_000, retryDelayMs: 1_000 };
const BIG = IO_CHUNK * 64 + 7;

suite('SftpAgentFileStore: потоковые downloadToFile / uploadFromFile', function () {
  this.timeout(120_000);
  let base: string;
  let root: string;
  let localDir: string;
  let server: AgentSshTestServer;
  const stores: SftpAgentFileStore[] = [];

  async function open(writeMode?: SftpWriteMode): Promise<SftpAgentFileStore> {
    const store = await connectSftpAgentFileStore(
      { host: '127.0.0.1', port: server.port, user: 'admin', password: 'secret', connectTimeoutSeconds: 5, policy: POLICY },
      writeMode === undefined ? {} : { writeMode }
    );
    stores.push(store);
    return store;
  }

  let store: SftpAgentFileStore;

  setup(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-sftp-stream-'));
    root = path.join(base, 'user-root');
    localDir = path.join(base, 'local');
    fs.mkdirSync(root);
    fs.mkdirSync(localDir);
    server = await AgentSshTestServer.start({ sftpRoot: root });
    store = await open();
  });
  teardown(async () => {
    await Promise.all(stores.splice(0).map((s) => s.dispose()));
    await server.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  function backend(): NonNullable<AgentSshTestServer['sftp']> {
    assert.ok(server.sftp);
    return server.sftp;
  }
  const local = (name: string): string => path.join(localDir, name);
  const remoteFile = (rel: string): string => path.join(root, ...rel.split('/'));

  async function expectPending(gate: SftpGate, count: number, what: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), 10_000); });
    const outcome = await Promise.race([gate.waitForPending(count).then(() => 'ok' as const), timeout]);
    if (timer) {
      clearTimeout(timer);
    }
    assert.strictEqual(outcome, 'ok', `${what}: придержано ${String(gate.pendingCount())} из ожидаемых ${String(count)}`);
  }

  suite('особенности сервера при скачивании', () => {
    test('сервер отвечает на READ короче запроса (readResponseLimit): файл собирается без дыр', async () => {
      const data = patternBytes(100_003, 11);
      fs.writeFileSync(remoteFile('short.bin'), data);
      backend().readResponseLimit = 1_000;
      await store.downloadToFile('short.bin', local('dst.bin'));
      assert.ok(data.equals(fs.readFileSync(local('dst.bin'))));
    });

    test('FSTAT без размера (fstatWithoutSize): чтение до EOF с дозаписью, прогресс без общего размера', async () => {
      const data = patternBytes(IO_CHUNK * 5 + 123, 12);
      fs.writeFileSync(remoteFile('nosize.bin'), data);
      backend().fstatWithoutSize = true;
      const totals: (number | undefined)[] = [];
      await store.downloadToFile('nosize.bin', local('dst.bin'), { onProgress: (_done, total) => { totals.push(total); } });
      assert.ok(data.equals(fs.readFileSync(local('dst.bin'))));
      assert.ok(totals.length > 0 && totals.every((total) => total === undefined));
    });

    test('FSTAT без размера и пустой файл: пустой локальный файл', async () => {
      fs.writeFileSync(remoteFile('empty.bin'), '');
      backend().fstatWithoutSize = true;
      await store.downloadToFile('empty.bin', local('dst.bin'));
      assert.strictEqual(fs.statSync(local('dst.bin')).size, 0);
    });

    test('файл укорочен во время чтения (EOF раньше размера): отказ «изменился во время чтения», локального файла нет', async () => {
      fs.writeFileSync(remoteFile('big.bin'), patternBytes(BIG, 13));
      const gate = backend().hold('READ');
      const download = store.downloadToFile('big.bin', local('dst.bin'));
      const outcome = download.then(() => undefined, (error: unknown) => error);
      await expectPending(gate, IO_WINDOW, 'скачивание');
      fs.truncateSync(remoteFile('big.bin'), IO_CHUNK);
      gate.release();

      const error = await outcome;
      assert.ok(error instanceof Error, 'отказ ожидался');
      assert.match(error.message, /изменил/);
      assert.strictEqual(fs.existsSync(local('dst.bin')), false);
    });

    test('отказ порции после первых 16 (середина файла): отказ с путём, локальный и удалённый дескрипторы закрыты, файла нет, хранилище живо', async () => {
      fs.writeFileSync(remoteFile('big.bin'), patternBytes(BIG, 14));
      const gate = backend().hold('READ');
      const download = store.downloadToFile('big.bin', local('dst.bin')).then(() => undefined, (error: unknown) => error);
      await expectPending(gate, IO_WINDOW, 'скачивание');
      // Следующий READ после первого окна провалится; уже придержанные доходят успешно.
      backend().failNext({ op: 'READ', pathIncludes: 'big.bin', times: 1, code: 'FAILURE' });
      const closesBefore = backend().ops('CLOSE').length;
      gate.release();

      const error = await download;
      assert.ok(error instanceof Error);
      assert.match(error.message, /big\.bin/);
      assert.strictEqual(fs.existsSync(local('dst.bin')), false);
      assert.ok(backend().ops('CLOSE').length > closesBefore, 'удалённый дескриптор закрыт после сбоя');
      fs.unlinkSync(remoteFile('big.bin'));
      fs.writeFileSync(remoteFile('ok.txt'), 'жив');
      assert.strictEqual((await store.readFile('ok.txt')).toString('utf-8'), 'жив');
    });

    test('обрыв соединения посреди скачивания: отказ, а не зависание; локального файла нет', async () => {
      fs.writeFileSync(remoteFile('big.bin'), patternBytes(BIG, 15));
      backend().dropConnectionOn('READ', () => server.dropClients());
      await assert.rejects(store.downloadToFile('big.bin', local('dst.bin')));
      assert.strictEqual(fs.existsSync(local('dst.bin')), false);
    });

    test('локальный файл уже есть: отказ, удалённый дескриптор не утёк (каждый OPEN закрыт)', async () => {
      fs.writeFileSync(remoteFile('src.bin'), 'данные');
      fs.writeFileSync(local('dst.bin'), 'прежнее');
      await assert.rejects(store.downloadToFile('src.bin', local('dst.bin')));
      assert.strictEqual(fs.readFileSync(local('dst.bin'), 'utf-8'), 'прежнее');
      assert.ok(backend().ops('CLOSE').length >= backend().ops('OPEN').length);
    });

    test('отмена посреди скачивания (после первого окна READ): AgentTransferCancelledError, далее порции не читаются, локального файла нет', async () => {
      fs.writeFileSync(remoteFile('big.bin'), patternBytes(BIG, 16));
      const cancellation = { isCancellationRequested: false };
      const gate = backend().hold('READ');
      const download = store.downloadToFile('big.bin', local('dst.bin'), { cancellation }).then(() => undefined, (error: unknown) => error);
      await expectPending(gate, IO_WINDOW, 'скачивание');
      cancellation.isCancellationRequested = true;
      gate.release();

      assert.ok((await download) instanceof AgentTransferCancelledError);
      assert.strictEqual(fs.existsSync(local('dst.bin')), false);
      assert.ok(backend().ops('READ').length <= IO_WINDOW * 2, `после отмены прочитано ещё ${String(backend().ops('READ').length - IO_WINDOW)} порций`);
    });

    test('после dispose потоковые методы отказывают понятным сообщением', async () => {
      await store.dispose();
      await assert.rejects(store.downloadToFile('x', local('dst.bin')), /закрыт/);
      fs.writeFileSync(local('src.bin'), 'x');
      await assert.rejects(store.uploadFromFile(local('src.bin'), 'x'), /закрыт/);
    });
  });

  suite('окно конвейера и размер порции (страж памяти)', () => {
    test('скачивание: каждый READ ≤ IO_CHUNK, в полёте не больше IO_WINDOW (и окно действительно заполняется)', async () => {
      const data = patternBytes(BIG, 21);
      fs.writeFileSync(remoteFile('big.bin'), data);
      const gate = backend().hold('READ');
      const download = store.downloadToFile('big.bin', local('dst.bin'));
      await expectPending(gate, IO_WINDOW, 'скачивание');
      gate.release();
      await download;

      assert.ok(data.equals(fs.readFileSync(local('dst.bin'))));
      const reads = backend().ops('READ');
      assert.ok(reads.length >= Math.ceil(BIG / IO_CHUNK));
      assert.ok(reads.every((entry) => (entry.length ?? 0) <= IO_CHUNK), 'порция не больше IO_CHUNK');
      assert.ok(backend().maxConcurrent.READ <= IO_WINDOW, `в полёте до ${String(backend().maxConcurrent.READ)}`);
      assert.ok(backend().maxConcurrent.READ >= IO_WINDOW, 'окно заполняется: конвейер, а не последовательный обмен');
    });

    test('закачка: каждый WRITE ≤ IO_CHUNK, в полёте не больше IO_WINDOW', async () => {
      const data = patternBytes(BIG, 22);
      fs.writeFileSync(local('src.bin'), data);
      const gate = backend().hold('WRITE');
      const upload = store.uploadFromFile(local('src.bin'), 'up/dst.bin');
      await expectPending(gate, IO_WINDOW, 'закачка');
      gate.release();
      await upload;

      assert.ok(data.equals(fs.readFileSync(remoteFile('up/dst.bin'))));
      const writes = backend().ops('WRITE');
      assert.ok(writes.length >= Math.ceil(BIG / IO_CHUNK));
      assert.ok(writes.every((entry) => (entry.length ?? 0) <= IO_CHUNK));
      assert.ok(backend().maxConcurrent.WRITE <= IO_WINDOW);
    });
  });

  suite('закачка: режимы записи и атомарность', () => {
    const data = patternBytes(100_000, 31);
    const modes: SftpWriteMode[] = ['atomic', 'direct', 'auto'];

    for (const renameOverwrites of [true, false]) {
      for (const mode of modes) {
        test(`режим ${mode}, rename ${renameOverwrites ? 'перезаписывает (агент)' : 'не перезаписывает (SFTP v3)'}: перезапись цели, остатков нет`, async () => {
          backend().renameOverwrites = renameOverwrites;
          const target = await open(mode);
          await target.writeFile('m/f.xml', 'старое');
          fs.writeFileSync(local('src.bin'), data);
          const before = backend().log.length;

          await target.uploadFromFile(local('src.bin'), 'm/f.xml');

          assert.ok(data.equals(fs.readFileSync(remoteFile('m/f.xml'))));
          assert.deepStrictEqual(fs.readdirSync(remoteFile('m')), ['f.xml']);
          const ops = backend().log.slice(before);
          const opens = ops.filter((entry) => entry.op === 'OPEN').map((entry) => entry.path ?? '');
          if (mode === 'direct') {
            assert.deepStrictEqual(opens, ['m/f.xml'], 'direct открывает саму цель');
            assert.strictEqual(ops.filter((entry) => entry.op === 'RENAME').length, 0);
          } else {
            assert.ok(opens[0].startsWith('m/') && opens[0] !== 'm/f.xml', `временное имя: ${opens[0]}`);
            assert.ok(!opens[0].endsWith('.xml'), 'временный файл не должен подходить под watcher src/**/*.xml');
            assert.ok(ops.some((entry) => entry.op === 'RENAME'));
          }
        });
      }
    }

    test('режим auto, сервер без rename: запасная прямая запись, остатков нет, rename пробуется один раз', async () => {
      backend().renameUnsupported = true;
      const target = await open('auto');
      fs.writeFileSync(local('src.bin'), data);
      await target.uploadFromFile(local('src.bin'), 'm/a.bin');
      await target.uploadFromFile(local('src.bin'), 'm/b.bin');
      assert.ok(data.equals(fs.readFileSync(remoteFile('m/a.bin'))));
      assert.ok(data.equals(fs.readFileSync(remoteFile('m/b.bin'))));
      assert.deepStrictEqual(fs.readdirSync(remoteFile('m')).sort(), ['a.bin', 'b.bin']);
      assert.strictEqual(backend().ops('RENAME').length, 1);
    });

    test('режим atomic, сервер без rename: запасного пути нет — отказ с путём, временный файл убран', async () => {
      backend().renameUnsupported = true;
      const target = await open('atomic');
      fs.writeFileSync(local('src.bin'), data);
      await assert.rejects(target.uploadFromFile(local('src.bin'), 'aa/f.bin'), /aa\/f\.bin/);
      assert.deepStrictEqual(fs.readdirSync(remoteFile('aa')), []);
    });

    test('обрыв записи (отказ WRITE): прежнее содержимое цели цело, временного файла нет', async () => {
      await store.writeFile('keep.bin', 'old');
      fs.writeFileSync(local('src.bin'), data);
      backend().failNext({ op: 'WRITE', code: 'PERMISSION_DENIED' });
      await assert.rejects(store.uploadFromFile(local('src.bin'), 'keep.bin'), /keep\.bin/);
      assert.strictEqual(fs.readFileSync(remoteFile('keep.bin'), 'utf-8'), 'old');
      assert.deepStrictEqual(fs.readdirSync(root), ['keep.bin']);
    });

    test('отказ rename временного файла: ошибка с путём цели, прежнее содержимое цело, временный файл убран', async () => {
      await store.writeFile('r/t.bin', 'old');
      fs.writeFileSync(local('src.bin'), data);
      backend().failNext({ op: 'RENAME', code: 'PERMISSION_DENIED' });
      await assert.rejects(store.uploadFromFile(local('src.bin'), 'r/t.bin'), /r\/t\.bin/);
      assert.strictEqual(fs.readFileSync(remoteFile('r/t.bin'), 'utf-8'), 'old');
      assert.deepStrictEqual(fs.readdirSync(remoteFile('r')), ['t.bin']);
    });

    test('отмена посреди закачки (после первого окна WRITE): AgentTransferCancelledError, цель прежняя, временный файл удалён, далее порции не пишутся', async () => {
      await store.writeFile('keep.bin', 'old');
      fs.writeFileSync(local('src.bin'), patternBytes(BIG, 32));
      const cancellation = { isCancellationRequested: false };
      const gate = backend().hold('WRITE');
      const upload = store.uploadFromFile(local('src.bin'), 'keep.bin', { cancellation }).then(() => undefined, (error: unknown) => error);
      await expectPending(gate, IO_WINDOW, 'закачка');
      cancellation.isCancellationRequested = true;
      gate.release();

      assert.ok((await upload) instanceof AgentTransferCancelledError);
      assert.strictEqual(fs.readFileSync(remoteFile('keep.bin'), 'utf-8'), 'old');
      assert.deepStrictEqual(fs.readdirSync(root), ['keep.bin']);
      assert.ok(backend().ops('WRITE').length <= IO_WINDOW * 2);
    });

    test('прямая запись (direct), отмена посреди закачки: AgentTransferCancelledError', async () => {
      const direct = await open('direct');
      fs.writeFileSync(local('src.bin'), patternBytes(BIG, 33));
      const cancellation = { isCancellationRequested: false };
      const gate = backend().hold('WRITE');
      const upload = direct.uploadFromFile(local('src.bin'), 'd/f.bin', { cancellation }).then(() => undefined, (error: unknown) => error);
      await expectPending(gate, IO_WINDOW, 'закачка');
      cancellation.isCancellationRequested = true;
      gate.release();
      assert.ok((await upload) instanceof AgentTransferCancelledError);
    });

    test('две одновременные закачки в ОДИН путь не сталкиваются на временном имени (блокировка записи по пути)', async () => {
      fs.writeFileSync(local('a.bin'), patternBytes(70_000, 41));
      fs.writeFileSync(local('b.bin'), patternBytes(70_000, 42));
      await Promise.all([store.uploadFromFile(local('a.bin'), 'same.bin'), store.uploadFromFile(local('b.bin'), 'same.bin')]);
      const result = fs.readFileSync(remoteFile('same.bin'));
      assert.ok(result.equals(fs.readFileSync(local('a.bin'))) || result.equals(fs.readFileSync(local('b.bin'))), 'итог — целиком один из двух файлов');
      assert.deepStrictEqual(fs.readdirSync(root), ['same.bin']);
    });
  });
});
