import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { Stats } from 'ssh2';
import type { AgentConnectPolicyOptions } from '../../domain/agent';
import { ProcessDesignerAgentTransportFactory, type DesignerAgentConnectionOptions } from '../../infra/agent';
import { downloadFiles, uploadFiles } from '../../infra/agent/files/AgentFileTransfer';
import {
  connectSftpAgentFileStore,
  type SftpAgentFileStore,
  type SftpAgentFileStoreDeps,
} from '../../infra/agent/files/SftpAgentFileStore';
import { connectSftp, sftpStatusCode } from '../../infra/agent/files/SftpConnection';
import { AgentSshTestServer, type AgentAuthBehavior } from './support/agentSshTestServer';
import { defineAgentFileStoreContract } from './support/agentFileStoreContract';

/**
 * SFTP-хранилище агента (Э6) на настоящем in-process ssh2.Server с настоящим SFTP поверх
 * временного каталога. Агент 1С — внешняя система, эмулируется только он (support/agentSshTestServer.ts,
 * support/agentSftpTestBackend.ts). SFTP — ОТДЕЛЬНОЕ SSH-соединение от shell (факт пилота §5b).
 */

const POLICY: AgentConnectPolicyOptions = { startupTimeoutMs: 5_000, authWarmupMs: 90_000, retryDelayMs: 1_000 };
const T0 = 1_000;

function endpoint(port: number, extra: Partial<DesignerAgentConnectionOptions> = {}): DesignerAgentConnectionOptions {
  return { host: '127.0.0.1', port, user: 'admin', password: 'secret', connectTimeoutSeconds: 5, policy: POLICY, ...extra };
}

interface Harness {
  readonly clock: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly sleeps: number[];
  onSleep?: (count: number) => Promise<void>;
}

function makeHarness(): Harness {
  let now = T0;
  const sleeps: number[] = [];
  const harness: Harness = {
    clock: () => now,
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
      await harness.onSleep?.(sleeps.length);
    },
  };
  return harness;
}

async function closedPort(): Promise<number> {
  const probe = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Детерминированные «случайные» байты: тот же результат на каждом прогоне. */
function patternBytes(length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let state = 123456789;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    buffer[i] = state >>> 24;
  }
  return buffer;
}

/** Отсортированные имена в каталоге: проверка «нет временных остатков». */
function dirNames(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

interface Env {
  readonly base: string;
  readonly root: string;
  readonly server: AgentSshTestServer;
  open(deps?: SftpAgentFileStoreDeps, extra?: Partial<DesignerAgentConnectionOptions>): Promise<SftpAgentFileStore>;
  dispose(): Promise<void>;
}

async function createEnv(): Promise<Env> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-sftp-'));
  const root = path.join(base, 'user-root');
  fs.mkdirSync(root);
  const server = await AgentSshTestServer.start({ sftpRoot: root });
  const stores: SftpAgentFileStore[] = [];
  return {
    base,
    root,
    server,
    open: async (deps, extra) => {
      const store = await connectSftpAgentFileStore(endpoint(server.port, extra), deps);
      stores.push(store);
      return store;
    },
    dispose: async () => {
      await Promise.all(stores.map((store) => store.dispose()));
      await server.close();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

// Общий контракт: ровно те же тесты, что у LocalAgentFileStore. Рекурсивный rmdir и перезаписывающий
// rename — поведение агента (факт пилота §5b п.12), нерекурсивный rmdir и неперезаписывающий rename —
// обычный SFTP v3: хранилище обязано вести себя одинаково на всех сочетаниях.
for (const recursiveRmdir of [true, false]) {
  for (const renameOverwrites of [true, false]) {
    const label = `sftp, rmdir сервера ${recursiveRmdir ? 'рекурсивен' : 'нерекурсивен'}, ` +
      `rename ${renameOverwrites ? 'перезаписывает' : 'не перезаписывает'}`;
    defineAgentFileStoreContract(label, async () => {
      const env = await createEnv();
      const backend = env.server.sftp;
      assert.ok(backend);
      backend.recursiveRmdir = recursiveRmdir;
      backend.renameOverwrites = renameOverwrites;
      const store = await env.open();
      return {
        store,
        root: env.root,
        parent: env.base,
        requestCount: () => backend.log.length,
        dispose: () => env.dispose(),
      };
    });
  }
}

suite('SftpAgentFileStore', () => {
  let env: Env;
  let store: SftpAgentFileStore;

  setup(async () => {
    env = await createEnv();
    store = await env.open();
  });
  teardown(async () => { await env.dispose(); });

  function backend(): NonNullable<AgentSshTestServer['sftp']> {
    assert.ok(env.server.sftp);
    return env.server.sftp;
  }

  suite('соединение', () => {
    test('kind = sftp; все операции идут по ОДНОМУ SSH-соединению, SFTP-подсистема открыта один раз, shell-канала нет', async () => {
      assert.strictEqual(store.kind, 'sftp');
      await store.writeFile('a/b.txt', '1');
      await store.readFile('a/b.txt');
      await store.list('', { recursive: true });
      await store.remove('a', { recursive: true });
      assert.strictEqual(env.server.clientCount, 1);
      assert.strictEqual(backend().sessionCount, 1);
      assert.strictEqual(env.server.shellLog.length, 0, 'на SFTP-соединении shell открывать нельзя (агент даёт один канал на соединение)');
    });

    test('SFTP и shell — разные соединения: транспорт агента работает параллельно открытому хранилищу', async () => {
      env.server.enableJsonReplies();
      const transport = await new ProcessDesignerAgentTransportFactory(endpoint(env.server.port)).create();
      try {
        const result = await transport.execute('common connect-ib');
        assert.ok(result.messages.length > 0);
        await store.writeFile('still/works.txt', '1');
        assert.strictEqual(env.server.clientCount, 2);
        assert.strictEqual(env.server.shellLog.length, 1);
      } finally {
        await transport.dispose();
      }
    });

    test('dispose закрывает SSH-соединение; повторный dispose — без ошибок; операции после него → понятный отказ', async () => {
      await store.dispose();
      await env.server.whenClientCount(0);
      await store.dispose();
      await assert.rejects(store.stat('x'), /закрыт/);
      await assert.rejects(store.readFile('x'), /закрыт/);
      await assert.rejects(store.writeFile('x', '1'), /закрыт/);
      await assert.rejects(store.list(''), /закрыт/);
      await assert.rejects(store.remove('x'), /закрыт/);
      await assert.rejects(store.mkdirp('x'), /закрыт/);
    });

    test('обрыв соединения сервером между операциями: следующая операция — отказ, а не зависание', async () => {
      await store.writeFile('f.txt', '1');
      env.server.dropClients();
      await env.server.whenClientCount(0);
      await assert.rejects(store.stat('f.txt'), /SFTP|соединени/i);
      await assert.rejects(store.readFile('f.txt'), /SFTP|соединени/i);
      await store.dispose();
    });
  });

  for (const renameOverwrites of [true, false]) {
  suite(`запись: атомарность и запасные режимы (rename ${renameOverwrites ? 'перезаписывает, как агент' : 'не перезаписывает, SFTP v3'})`, () => {
    setup(() => { backend().renameOverwrites = renameOverwrites; });

    test('запись идёт во временное имя в том же каталоге (не .xml) и переименовывается в цель; цель до rename не открывается', async () => {
      await store.writeFile('d/target.xml', 'данные');
      const opens = backend().ops('OPEN').map((entry) => entry.path ?? '');
      assert.strictEqual(opens.length, 1);
      assert.ok(opens[0].startsWith('d/') && opens[0] !== 'd/target.xml', `временное имя: ${opens[0]}`);
      assert.ok(!opens[0].endsWith('.xml'), 'временный файл не должен подходить под watcher src/**/*.xml');
      const renames = backend().ops('RENAME');
      assert.deepStrictEqual(renames.map((entry) => [entry.path, entry.target]), [[opens[0], 'd/target.xml']]);
      assert.deepStrictEqual(dirNames(path.join(env.root, 'd')), ['target.xml']);
    });

    test('перезапись: цель заменяется целиком, остатков нет', async () => {
      await store.writeFile('d/f.txt', 'длинное старое содержимое');
      await store.writeFile('d/f.txt', 'new');
      assert.strictEqual(fs.readFileSync(path.join(env.root, 'd', 'f.txt'), 'utf-8'), 'new');
      assert.deepStrictEqual(dirNames(path.join(env.root, 'd')), ['f.txt']);
    });

    test('обрыв записи (отказ WRITE) при перезаписи: старое содержимое цело, временного файла не остаётся', async () => {
      await store.writeFile('keep.txt', 'old');
      backend().failNext({ op: 'WRITE', code: 'PERMISSION_DENIED' });
      await assert.rejects(store.writeFile('keep.txt', 'new content'), /keep\.txt/);
      assert.strictEqual(fs.readFileSync(path.join(env.root, 'keep.txt'), 'utf-8'), 'old');
      assert.deepStrictEqual(dirNames(env.root), ['keep.txt']);
    });

    test('отказ OPEN временного файла: понятная ошибка с путём цели, ничего не создано', async () => {
      backend().failNext({ op: 'OPEN', code: 'PERMISSION_DENIED' });
      await assert.rejects(store.writeFile('deny/x.txt', '1'), /deny\/x\.txt/);
      assert.deepStrictEqual(fs.existsSync(path.join(env.root, 'deny', 'x.txt')), false);
    });

    test('отказ rename (не OP_UNSUPPORTED): ошибка с путём цели, временный файл убран, прежнее содержимое цело', async () => {
      await store.writeFile('r/t.txt', 'old');
      backend().failNext({ op: 'RENAME', code: 'PERMISSION_DENIED' });
      await assert.rejects(store.writeFile('r/t.txt', 'new'), /r\/t\.txt/);
      assert.strictEqual(fs.readFileSync(path.join(env.root, 'r', 't.txt'), 'utf-8'), 'old');
      assert.deepStrictEqual(dirNames(path.join(env.root, 'r')), ['t.txt']);
    });

    test('mkdir отказан: writeFile и mkdirp — ошибка с путём', async () => {
      backend().failNext({ op: 'MKDIR', code: 'PERMISSION_DENIED', pathIncludes: 'denied' });
      await assert.rejects(store.writeFile('denied/x.txt', '1'), /denied/);
      backend().failNext({ op: 'MKDIR', code: 'PERMISSION_DENIED', pathIncludes: 'denied2' });
      await assert.rejects(store.mkdirp('denied2/sub'), /denied2/);
    });

    test('авто-режим: сервер без rename (OP_UNSUPPORTED) → прямая запись; остатков нет; rename пробуется один раз за жизнь хранилища', async () => {
      backend().renameUnsupported = true;
      await store.writeFile('m/a.txt', 'one');
      await store.writeFile('m/a.txt', 'два');
      await store.writeFile('m/b.txt', 'three');
      assert.strictEqual(fs.readFileSync(path.join(env.root, 'm', 'a.txt'), 'utf-8'), 'два');
      assert.strictEqual(fs.readFileSync(path.join(env.root, 'm', 'b.txt'), 'utf-8'), 'three');
      assert.deepStrictEqual(dirNames(path.join(env.root, 'm')), ['a.txt', 'b.txt']);
      assert.strictEqual(backend().ops('RENAME').length, 1, 'после первого OP_UNSUPPORTED rename больше не пробуется');
      const opens = backend().ops('OPEN').map((entry) => entry.path);
      assert.deepStrictEqual(opens.slice(-2), ['m/a.txt', 'm/b.txt'], 'прямая запись открывает сам целевой файл');
    });

    test('режим direct: temp и rename не используются вовсе; перезапись усекает цель', async () => {
      const direct = await env.open({ writeMode: 'direct' });
      await direct.writeFile('dd/f.txt', 'длинное содержимое');
      await direct.writeFile('dd/f.txt', 'x');
      assert.strictEqual(fs.readFileSync(path.join(env.root, 'dd', 'f.txt'), 'utf-8'), 'x');
      assert.strictEqual(backend().ops('RENAME').length, 0);
      assert.ok(backend().ops('OPEN').every((entry) => entry.path === 'dd/f.txt'));
    });

    test('режим atomic: без rename запасного пути нет — отказ с путём, временный файл убран', async () => {
      const atomic = await env.open({ writeMode: 'atomic' });
      backend().renameUnsupported = true;
      await assert.rejects(atomic.writeFile('aa/f.txt', '1'), /aa\/f\.txt/);
      assert.deepStrictEqual(dirNames(path.join(env.root, 'aa')), []);
    });
    test('RENAME в отсутствующую цель отказан FAILURE: ошибка с путём, временного файла нет, резервная схема не включается', async () => {
      await store.mkdirp('nf');
      backend().failNext({ op: 'RENAME', code: 'FAILURE', times: 1 });
      await assert.rejects(store.writeFile('nf/new.txt', '1'), /nf\/new\.txt/);
      assert.strictEqual(backend().ops('RENAME').length, 1);
      assert.deepStrictEqual(dirNames(path.join(env.root, 'nf')), []);
    });
  });
  }

  suite('запись на агенте: rename перезаписывает цель (§5b п.12)', () => {
    test('перезапись — ровно один RENAME временного файла в цель: без STAT цели и без резервного имени', async () => {
      assert.strictEqual(backend().renameOverwrites, true);
      await store.writeFile('ag/f.txt', 'старое');
      const before = backend().log.length;
      await store.writeFile('ag/f.txt', 'новое');
      const ops = backend().log.slice(before);
      assert.deepStrictEqual(ops.filter((entry) => entry.op === 'RENAME').map((entry) => entry.target), ['ag/f.txt']);
      assert.strictEqual(ops.filter((entry) => entry.op === 'STAT').length, 0, 'цель заранее не проверяется');
      assert.ok(!ops.some((entry) => `${entry.path ?? ''} ${entry.target ?? ''}`.includes('.v8bak')), 'резервное имя не используется');
      assert.strictEqual(fs.readFileSync(path.join(env.root, 'ag', 'f.txt'), 'utf-8'), 'новое');
      assert.deepStrictEqual(dirNames(path.join(env.root, 'ag')), ['f.txt']);
    });
  });

  suite('запись на стандартном SFTP v3: rename не перезаписывает — резервная схема', () => {
    setup(() => { backend().renameOverwrites = false; });

    test('перезапись: RENAME в занятую цель → FAILURE → цель в резерв → RENAME → резерв удалён', async () => {
      await store.writeFile('sv/f.txt', 'старое');
      const before = backend().log.length;
      await store.writeFile('sv/f.txt', 'новое');
      const renames = backend().log.slice(before).filter((entry) => entry.op === 'RENAME');
      assert.strictEqual(renames.length, 3, 'временный → цель (отказ), цель → резерв, временный → цель');
      assert.ok(renames[1].target?.endsWith('.v8bak'));
      assert.strictEqual(fs.readFileSync(path.join(env.root, 'sv', 'f.txt'), 'utf-8'), 'новое');
      assert.deepStrictEqual(dirNames(path.join(env.root, 'sv')), ['f.txt']);
    });

    test('отказ RENAME временного файла ПОСЛЕ ухода прежней цели в резерв: прежний файл возвращается на место, остатков нет', async () => {
      await store.writeFile('rb/t.txt', 'old');
      const renamesBefore = backend().ops('RENAME').length;
      // Оба RENAME временного файла в цель отказаны (первый — как у SFTP v3 на занятой цели), RENAME
      // цели в резерв и обратно проходят: путь временного файла — единственное, чем они различаются.
      backend().failNext({ op: 'RENAME', code: 'FAILURE', pathIncludes: '.v8tmp', times: 2 });
      await assert.rejects(store.writeFile('rb/t.txt', 'new'), /rb\/t\.txt/);
      assert.strictEqual(backend().ops('RENAME').length - renamesBefore, 4, 'временный → цель, цель → резерв, временный → цель, резерв → цель');
      assert.strictEqual(fs.readFileSync(path.join(env.root, 'rb', 't.txt'), 'utf-8'), 'old');
      assert.deepStrictEqual(dirNames(path.join(env.root, 'rb')), ['t.txt']);
    });

    test('не удался и возврат из резерва: ошибка называет резервный файл, прежнее содержимое в нём цело', async () => {
      await store.writeFile('rf/t.txt', 'old');
      backend().failNext({ op: 'RENAME', code: 'FAILURE', pathIncludes: '.v8tmp', times: 2 });
      backend().failNext({ op: 'RENAME', code: 'PERMISSION_DENIED', pathIncludes: '.v8bak', times: 1 });
      let message = '';
      await assert.rejects(store.writeFile('rf/t.txt', 'new'), (error: Error) => { message = error.message; return true; });
      const names = dirNames(path.join(env.root, 'rf'));
      const backup = names.find((name) => name.endsWith('.v8bak'));
      assert.ok(backup, `резерв на месте: ${names.join(', ')}`);
      assert.deepStrictEqual(names, [backup], 'цели нет, временный файл убран');
      assert.ok(message.includes(`rf/${backup}`), message);
      assert.strictEqual(fs.readFileSync(path.join(env.root, 'rf', backup), 'utf-8'), 'old');
    });
  });

  suite('remove: контракт безопаснее rmdir агента', () => {
    test('непустой каталог без recursive: RMDIR серверу не отправляется вовсе (его rmdir рекурсивен и снёс бы всё)', async () => {
      await store.writeFile('dir/sub/f.txt', '1');
      assert.strictEqual(backend().recursiveRmdir, true);
      await assert.rejects(store.remove('dir'), /dir/);
      assert.strictEqual(backend().ops('RMDIR').length, 0);
      assert.ok(fs.existsSync(path.join(env.root, 'dir', 'sub', 'f.txt')));
    });

    test('recursive на агенте (rmdir рекурсивен): один RMDIR без обхода дерева', async () => {
      await store.writeFile('one/a/b.txt', '1');
      await store.writeFile('one/c.txt', '2');
      const before = backend().log.length;
      await store.remove('one', { recursive: true });
      const ops = backend().log.slice(before).map((entry) => entry.op);
      assert.deepStrictEqual(ops, ['LSTAT', 'RMDIR']);
      assert.strictEqual(fs.existsSync(path.join(env.root, 'one')), false);
    });

    test('пустой каталог без recursive: один RMDIR', async () => {
      await store.mkdirp('empty');
      await store.remove('empty');
      assert.deepStrictEqual(backend().ops('RMDIR').map((entry) => entry.path), ['empty']);
    });

    test('recursive на сервере с нерекурсивным rmdir: дерево удаляется обходом (файлы, затем каталоги снизу вверх)', async () => {
      backend().recursiveRmdir = false;
      await store.writeFile('t/a/b/c.txt', '1');
      await store.writeFile('t/a/d.txt', '2');
      await store.writeFile('t/e.txt', '3');
      await store.remove('t', { recursive: true });
      assert.strictEqual(fs.existsSync(path.join(env.root, 't')), false);
    });

    test('отказ удаления файла: ошибка с путём', async () => {
      await store.writeFile('q/f.txt', '1');
      backend().failNext({ op: 'REMOVE', code: 'PERMISSION_DENIED' });
      await assert.rejects(store.remove('q/f.txt'), /q\/f\.txt/);
    });

    test('отказ RMDIR при recursive-удалении: ошибка с путём, соседние каталоги не тронуты', async () => {
      backend().recursiveRmdir = false;
      await store.writeFile('keepdir/k.txt', '1');
      await store.writeFile('gone/x/y.txt', '1');
      backend().failNext({ op: 'RMDIR', code: 'PERMISSION_DENIED', pathIncludes: 'gone' });
      await assert.rejects(store.remove('gone', { recursive: true }), /gone/);
      assert.ok(fs.existsSync(path.join(env.root, 'keepdir', 'k.txt')));
    });
  });

  suite('ошибки сервера и обрывы', () => {
    test('гонка MKDIR: каталог создан другим клиентом между STAT и MKDIR — mkdirp успешен, MKDIR не повторяется', async () => {
      const gate = backend().hold('MKDIR');
      const pending = store.mkdirp('race');
      await gate.waitForPending(1);
      fs.mkdirSync(path.join(env.root, 'race'));
      gate.release();
      await pending;
      assert.strictEqual(backend().ops('MKDIR').length, 1);
      await store.writeFile('race/f.txt', '1');
      assert.strictEqual(backend().ops('MKDIR').length, 1, 'каталог после гонки известен хранилищу');
    });

    test('stat: NO_SUCH_FILE → undefined, а отказ в правах пробрасывается ошибкой с путём', async () => {
      await store.writeFile('secret.txt', '1');
      assert.strictEqual(await store.stat('absent.txt'), undefined);
      backend().failNext({ op: 'STAT', code: 'PERMISSION_DENIED' });
      await assert.rejects(store.stat('secret.txt'), /secret\.txt/);
    });

    test('readFile: отказ чтения — ошибка с путём', async () => {
      await store.writeFile('r.txt', '1');
      backend().failNext({ op: 'OPEN', code: 'PERMISSION_DENIED' });
      await assert.rejects(store.readFile('r.txt'), /r\.txt/);
    });

    test('list: отказ OPENDIR и READDIR — ошибка с путём', async () => {
      await store.writeFile('l/a.txt', '1');
      backend().failNext({ op: 'OPENDIR', code: 'PERMISSION_DENIED' });
      await assert.rejects(store.list('l'), /l/);
      backend().failNext({ op: 'READDIR', code: 'FAILURE' });
      await assert.rejects(store.list('l'), /l/);
    });

    test('обрыв соединения посреди записи большого файла: ошибка с путём, не зависание; хранилище далее отказывает понятно', async () => {
      backend().dropConnectionOn('WRITE', () => env.server.dropClients());
      await assert.rejects(store.writeFile('drop.bin', patternBytes(400_000)), /drop\.bin/);
      await assert.rejects(store.stat('x'), /SFTP|соединени/i);
      await store.dispose();
    });

    test('обрыв соединения посреди чтения: ошибка с путём', async () => {
      fs.writeFileSync(path.join(env.root, 'read.bin'), patternBytes(400_000));
      backend().dropConnectionOn('READ', () => env.server.dropClients());
      await assert.rejects(store.readFile('read.bin'), /read\.bin/);
      await store.dispose();
    });

    test('обрыв соединения посреди листинга: ошибка с путём', async () => {
      await store.writeFile('ld/a.txt', '1');
      backend().dropConnectionOn('READDIR', () => env.server.dropClients());
      await assert.rejects(store.list('ld'), /ld/);
      await store.dispose();
    });

    test('после обрыва операции, поставленные в очередь, тоже получают отказ (ни одна не зависает)', async () => {
      env.server.dropClients();
      await env.server.whenClientCount(0);
      const results = await Promise.allSettled([store.stat('a'), store.readFile('b'), store.list(''), store.mkdirp('c')]);
      assert.ok(results.every((result) => result.status === 'rejected'));
    });
  });

  suite('большие и бинарные файлы', () => {
    test('несколько чанков: 700 000 байт пишутся и читаются байт-в-байт, размер в stat сходится', async () => {
      const data = patternBytes(700_000);
      await store.writeFile('big/data.bin', data);
      assert.strictEqual(Buffer.compare(fs.readFileSync(path.join(env.root, 'big', 'data.bin')), data), 0);
      assert.strictEqual(Buffer.compare(await store.readFile('big/data.bin'), data), 0);
      assert.strictEqual((await store.stat('big/data.bin'))?.size, 700_000);
      assert.ok(backend().ops('WRITE').length > 1, 'запись должна идти несколькими WRITE');
      assert.ok(backend().ops('READ').length > 1, 'чтение должно идти несколькими READ');
    });

    test('Uint8Array-вид (не Buffer) и строка с суррогатными парами', async () => {
      const view = new Uint8Array(patternBytes(70_000));
      await store.writeFile('v.bin', view);
      assert.deepStrictEqual([...await store.readFile('v.bin')], [...view]);
      await store.writeFile('emoji.txt', 'a😀б');
      assert.strictEqual((await store.readFile('emoji.txt')).toString('utf-8'), 'a😀б');
    });

    test('файл ровно по границе чанка (32768 и 65536 байт)', async () => {
      for (const size of [32_768, 65_536, 65_537]) {
        const data = patternBytes(size);
        await store.writeFile(`edge/${String(size)}.bin`, data);
        assert.strictEqual(Buffer.compare(await store.readFile(`edge/${String(size)}.bin`), data), 0, String(size));
      }
    });
  });

  suite('ссылки на сервере', () => {
    test('list не перечисляет ссылки и не заходит в них (рекурсивно тоже)', async () => {
      const outside = path.join(env.base, 'outside');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'секрет', 'utf-8');
      await store.writeFile('w/a.txt', '1');
      fs.symlinkSync(outside, path.join(env.root, 'w', 'inner-link'), process.platform === 'win32' ? 'junction' : 'dir');
      assert.deepStrictEqual((await store.list('w')).map((e) => e.path), ['w/a.txt']);
      assert.deepStrictEqual((await store.list('', { recursive: true })).map((e) => e.path), ['w', 'w/a.txt']);
    });
  });

  suite('конкурентность на одном соединении', () => {
    test('рекурсивный list держит не больше 8 одновременных OPENDIR и ничего не теряет', async () => {
      const names = Array.from({ length: 20 }, (_, index) => `d${String(index).padStart(2, '0')}`);
      for (const name of names) {
        fs.mkdirSync(path.join(env.root, 'many', name), { recursive: true });
        fs.writeFileSync(path.join(env.root, 'many', name, 'f.txt'), '1');
      }
      const first = backend().hold('OPENDIR');
      const listing = store.list('many', { recursive: true });
      await first.waitForPending(1);
      first.release();
      const second = backend().hold('OPENDIR');
      await second.waitForPending(1);
      // SFTP-канал упорядочен: ответ на STAT, отправленный позже, означает, что все ранее
      // отправленные OPENDIR сервер уже принял (и придержал).
      await store.stat('many');
      assert.strictEqual(second.pendingCount(), 8);
      second.release();
      const result = await listing;
      assert.strictEqual(result.length, 40);
    });

    test('несколько одновременных чтений реально идут параллельно на одном соединении (SFTP-запросы мультиплексируются)', async () => {
      const rels = ['p/1.txt', 'p/2.txt', 'p/3.txt', 'p/4.txt'];
      for (const rel of rels) {
        fs.mkdirSync(path.join(env.root, 'p'), { recursive: true });
        fs.writeFileSync(path.join(env.root, ...rel.split('/')), rel, 'utf-8');
      }
      const gate = backend().hold('OPEN');
      const received = new Map<string, string>();
      const transfer = downloadFiles(store, rels, (rel, data) => { received.set(rel, data.toString('utf-8')); }, { concurrency: 4 });
      await gate.waitForPending(4);
      assert.strictEqual(env.server.clientCount, 1);
      gate.release();
      const result = await transfer;
      assert.strictEqual(result.transferred, 4);
      assert.deepStrictEqual([...received.entries()].sort(), rels.map((rel) => [rel, rel]).sort());
    });

    test('uploadFiles поверх SFTP: 40 файлов с concurrency 8 в один новый каталог (гонка mkdirp), содержимое верно, временных остатков нет', async () => {
      const rels = Array.from({ length: 40 }, (_, index) => `up/Каталог/файл-${String(index).padStart(2, '0')}.txt`);
      const progress: number[] = [];
      const result = await uploadFiles(store, rels, (rel) => `содержимое ${rel}`, {
        concurrency: 8,
        onProgress: (p) => { progress.push(p.done); },
      });
      assert.strictEqual(result.transferred, 40);
      assert.strictEqual(progress.length, 40);
      for (const rel of rels) {
        assert.strictEqual(fs.readFileSync(path.join(env.root, ...rel.split('/')), 'utf-8'), `содержимое ${rel}`);
      }
      assert.strictEqual(dirNames(path.join(env.root, 'up', 'Каталог')).length, 40);
      assert.strictEqual(env.server.clientCount, 1);
    });

    test('смешанные одновременные операции (write/read/stat/list/remove) не мешают друг другу', async () => {
      await store.writeFile('mix/seed.txt', 'seed');
      const results = await Promise.all([
        store.writeFile('mix/a.txt', 'a'),
        store.writeFile('mix/b.txt', 'b'),
        store.readFile('mix/seed.txt'),
        store.stat('mix/seed.txt'),
        store.list('mix'),
        store.mkdirp('mix/new/dir'),
        store.remove('nothing/here'),
      ]);
      assert.strictEqual(results[2].toString('utf-8'), 'seed');
      assert.strictEqual((results[3] as { type: string }).type, 'file');
      assert.ok(fs.existsSync(path.join(env.root, 'mix', 'a.txt')));
      assert.ok(fs.existsSync(path.join(env.root, 'mix', 'b.txt')));
      assert.ok(fs.existsSync(path.join(env.root, 'mix', 'new', 'dir')));
    });

    test('одновременные записи в один файл: итог — целиком одна из версий, не смесь; остатков нет', async () => {
      await Promise.all(['A'.repeat(100_000), 'B'.repeat(100_000), 'C'.repeat(100_000)].map((text) => store.writeFile('same.txt', text)));
      const text = fs.readFileSync(path.join(env.root, 'same.txt'), 'utf-8');
      assert.ok(/^(A{100000}|B{100000}|C{100000})$/.test(text));
      assert.deepStrictEqual(dirNames(env.root), ['same.txt']);
    });
  });
});

suite('SftpConnection', () => {
  test('sftpStatusCode: числовой code ssh2 → число; ошибка без числового code → undefined', () => {
    assert.strictEqual(sftpStatusCode(Object.assign(new Error('x'), { code: 2 })), 2);
    assert.strictEqual(sftpStatusCode(Object.assign(new Error('x'), { code: 'ECONNRESET' })), undefined);
    assert.strictEqual(sftpStatusCode(new Error('x')), undefined);
  });

  test('синхронный throw внутри запроса — отказ этого запроса; соединение остаётся рабочим', async () => {
    const env = await createEnv();
    try {
      const connection = await connectSftp(endpoint(env.server.port));
      try {
        await assert.rejects(connection.request(() => { throw new Error('неверные аргументы'); }), /неверные аргументы/);
        const stats = await connection.request<Stats>((sftp, done) => sftp.stat('.', done));
        assert.ok(stats.isDirectory());
      } finally {
        connection.dispose();
      }
    } finally {
      await env.dispose();
    }
  });
});

suite('connectSftpAgentFileStore: подключение и политика Э3', () => {
  const envs: Env[] = [];
  const servers: AgentSshTestServer[] = [];
  const stores: SftpAgentFileStore[] = [];

  teardown(async () => {
    await Promise.all(stores.splice(0).map((s) => s.dispose()));
    await Promise.all(envs.splice(0).map((e) => e.dispose()));
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  async function connect(options: DesignerAgentConnectionOptions, deps?: SftpAgentFileStoreDeps): Promise<SftpAgentFileStore> {
    const store = await connectSftpAgentFileStore(options, deps);
    stores.push(store);
    return store;
  }

  async function startEnv(behavior?: AgentAuthBehavior): Promise<Env> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-sftp-conn-'));
    const root = path.join(base, 'user-root');
    fs.mkdirSync(root);
    const server = await AgentSshTestServer.start({ sftpRoot: root, behavior });
    const env: Env = {
      base,
      root,
      server,
      open: () => Promise.reject(new Error('не используется')),
      dispose: async () => { await server.close(); fs.rmSync(base, { recursive: true, force: true }); },
    };
    envs.push(env);
    return env;
  }

  test('auth-отказ без опорной точки: одна попытка, ошибка credentials без пароля в тексте, cause сохранён', async () => {
    const { server } = await startEnv({ mode: 'reject-all' });
    const h = makeHarness();
    await assert.rejects(connect(endpoint(server.port), { clock: h.clock, sleep: h.sleep }), (error: Error) => {
      assert.match(error.message, /неверный логин или пароль агента конфигуратора для пользователя «admin»/);
      assert.ok(!error.message.includes('secret'));
      assert.ok(error.cause);
      return true;
    });
    assert.strictEqual(server.passwordAttempts, 1);
    assert.deepStrictEqual(h.sleeps, []);
  });

  test('agentStartedAt задан: два auth-отказа (агент ещё не принимает логин) переживаются, SFTP открывается с 3-й попытки', async () => {
    const { server, root } = await startEnv({ mode: 'reject-first', count: 2 });
    const h = makeHarness();
    const store = await connect(endpoint(server.port, { agentStartedAt: T0 }), { clock: h.clock, sleep: h.sleep });
    assert.strictEqual(server.passwordAttempts, 3);
    assert.deepStrictEqual(h.sleeps, [1_000, 1_000]);
    await store.writeFile('ok.txt', '1');
    assert.ok(fs.existsSync(path.join(root, 'ok.txt')));
  });

  test('refused → порт поднялся → успех: SSH ещё не слушает, хранилище дожидается агента по политике', async () => {
    const port = await closedPort();
    const h = makeHarness();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-sftp-late-'));
    const root = path.join(base, 'user-root');
    fs.mkdirSync(root);
    h.onSleep = async (count) => {
      if (count === 2) {
        servers.push(await AgentSshTestServer.start({ port, sftpRoot: root }));
      }
    };
    try {
      const store = await connect(endpoint(port), { clock: h.clock, sleep: h.sleep });
      await store.writeFile('late.txt', '1');
      assert.deepStrictEqual(h.sleeps, [1_000, 1_000]);
      assert.ok(fs.existsSync(path.join(root, 'late.txt')));
    } finally {
      await Promise.all(stores.splice(0).map((s) => s.dispose()));
      await Promise.all(servers.splice(0).map((s) => s.close()));
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('refused дольше startupTimeoutMs: ошибка unreachable с host:port', async () => {
    const port = await closedPort();
    const h = makeHarness();
    await assert.rejects(
      connect(endpoint(port), { clock: h.clock, sleep: h.sleep }),
      (error: Error) => error.message.includes(`агент конфигуратора не отвечает на 127.0.0.1:${String(port)}`) && error.cause !== undefined
    );
    assert.deepStrictEqual(h.sleeps, [1_000, 1_000, 1_000, 1_000, 1_000]);
  });

  test('сервер не поддерживает подсистему sftp: ошибка с упоминанием SFTP и без зависания; соединение закрыто', async () => {
    const server = await AgentSshTestServer.start();
    servers.push(server);
    await assert.rejects(connect(endpoint(server.port)), /SFTP/);
    await server.whenClientCount(0);
  });

  test('ключ из privateKeyPath, которого нет: отказ с путём файла (как у транспорта), не зависание', async () => {
    const { server } = await startEnv();
    await assert.rejects(connect(endpoint(server.port, { privateKeyPath: path.join(os.tmpdir(), 'no-such-key-v8') })), /no-such-key-v8/);
  });

  test('штатные часы и пауза цикла повторов (без внедрения): refused повторяется настоящими короткими паузами до unreachable', async () => {
    const port = await closedPort();
    const startedAt = Date.now();
    await assert.rejects(
      connect(endpoint(port, { policy: { startupTimeoutMs: 40, authWarmupMs: 0, retryDelayMs: 10 } })),
      /агент конфигуратора не отвечает/
    );
    assert.ok(Date.now() - startedAt >= 40, 'цикл обязан реально ждать до истечения окна запуска');
  });

  test('успех с первой попытки: sleep не вызывается; параметры подключения берутся те же, что у транспорта (пользователь/порт)', async () => {
    const { server } = await startEnv();
    const h = makeHarness();
    await connect(endpoint(server.port), { clock: h.clock, sleep: h.sleep });
    assert.strictEqual(server.passwordAttempts, 1);
    assert.deepStrictEqual(h.sleeps, []);
  });
});
