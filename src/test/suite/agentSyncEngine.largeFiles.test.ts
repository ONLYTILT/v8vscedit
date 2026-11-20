import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentOperationHooks } from '../../infra/agent/AgentOperationService';
import type { AgentFileStore } from '../../infra/agent/files/AgentFileStore';
import { AgentTransferError } from '../../infra/agent/files/AgentFileTransfer';
import { IO_CHUNK } from '../../infra/agent/files/SftpChunkedIo';
import {
  DEFAULT_LARGE_FILE_THRESHOLD_BYTES,
  DEFAULT_LARGE_FILE_WARN_BYTES,
} from '../../infra/agent/sync/AgentSyncEngine';
import { AgentSyncCancelledError } from '../../infra/agent/sync/SyncContext';
import { ageAgentTree } from './support/agentConfigEmulator';
import { createHarness, dbAsText, type HarnessOptions, type SyncHarness } from './support/agentSyncHarness';
import { assertCommon, startAvoidHarness } from './support/fullDumpAvoidFixtures';
import { assertSubsequence } from './support/deltaMtimeFixtures';
import {
  BIG2_REL,
  BIG_REL,
  DownloadProbeStore,
  LARGE_SIZE,
  LARGE_THRESHOLD,
  SMALL_REL,
  WARN_BYTES,
  agePFile,
  bigBytes,
  bytesInDb,
  bytesInP,
  expectPending,
  holdReadsAfterUpdate,
  mtimeOfP,
  opsAt,
} from './support/largeFilesFixtures';

/**
 * Большие файлы в импорте с удалённого агента (plan-large-files.md §2, §5.3 тесты 11–17, 32–33; SFTP) и локальный
 * агент (§2.5, тесты 29–31). ФАКТ Э26: размер в FSTAT есть, сервер параллельные READ держит, окно 16 работает — про
 * «чтение без размера» тестов нет; обязательны потоковость (файл ≥ порога идёт `downloadToFile` в staging на диске, а не
 * Buffer'ом в память), побайтное сравнение с P, запись в P потоком, проверка места и прогресс по весу.
 *
 * «Не держится в памяти» проверяется поведением, а не замером процесса: по большому пути `readFile` не вызывается
 * вовсе (шпион по пути хранилища), а скачивание — `downloadToFile`. Порог в тестах 64 КиБ, «большой» файл 300 КиБ.
 */

const HARNESS_LARGE = { largeFileThresholdBytes: LARGE_THRESHOLD, largeFileWarnBytes: WARN_BYTES };

suite('AgentSyncEngine: пороги больших файлов по умолчанию', () => {
  test('порог большого файла — 16 МиБ, предупреждение заранее — 100 МиБ', () => {
    assert.strictEqual(DEFAULT_LARGE_FILE_THRESHOLD_BYTES, 16 * 1024 * 1024);
    assert.strictEqual(DEFAULT_LARGE_FILE_WARN_BYTES, 100 * 1024 * 1024);
  });
});

suite('AgentSyncEngine: большие файлы дельты (sftp)', function () {
  this.timeout(180_000);
  let h: SyncHarness;
  let probe: DownloadProbeStore | undefined;
  let from = 0;

  async function begin(options: { readonly wrap?: boolean; readonly harness?: HarnessOptions } = {}): Promise<void> {
    probe = undefined;
    h = await startAvoidHarness({
      coverage: 'full',
      seed: (emulator) => {
        emulator.putFile(BIG_REL, bigBytes(LARGE_SIZE, 1));
        emulator.putFile(SMALL_REL, '<Catalog>Клиенты</Catalog>');
      },
      harness: {
        ...HARNESS_LARGE,
        ...(options.wrap === false ? {} : { wrapStore: (store: AgentFileStore) => { probe = new DownloadProbeStore(store); return probe; } }),
        ...options.harness,
      },
    });
    ageAgentTree(h.mirrorAbs);
    from = h.emulator.commands.length;
    h.sftp?.log.splice(0);
    (probe as DownloadProbeStore | undefined)?.calls.splice(0);
  }
  teardown(async () => { await h.dispose(); });

  const reads = (rel: string): number => opsAt(h, 'READ', rel);

  // ── 11. изменённый большой файл ───────────────────────────────────────────────────────────────

  test('11. изменённый большой файл: downloadToFile (readFile по нему не зовётся), порции READ ≤ 31 КиБ, P побайтно = M, staging убран', async () => {
    await begin();
    const next = bigBytes(LARGE_SIZE, 2);
    h.emulator.putFile(BIG_REL, next);

    const result = await h.importTarget();

    assert.strictEqual(result.strategy, 'delta');
    assert.ok(probe);
    assert.strictEqual(probe.count('downloadToFile', /Данные\.bsl$/), 1, 'большой файл скачан потоком');
    assert.strictEqual(probe.count('readFile', /Данные\.bsl$/), 0, 'буфером размером с файл — ни разу');
    const chunks = h.sftp?.ops('READ').filter((entry) => (entry.path ?? '').endsWith('Данные.bsl')) ?? [];
    assert.ok(chunks.length >= Math.ceil(LARGE_SIZE / IO_CHUNK), 'файл прочитан порциями');
    assert.ok(chunks.every((entry) => (entry.length ?? 0) <= IO_CHUNK), 'порция не больше IO_CHUNK');
    assert.ok(bytesInP(h, BIG_REL).equals(next), 'P побайтно равен M');
    assert.ok(bytesInP(h, BIG_REL).equals(bytesInDb(h, BIG_REL)));
    await assertCommon(h, from, 'full');
  });

  test('11б. окно конвейера внутри большого файла: одновременно придержано несколько READ одного файла', async () => {
    await begin();
    h.emulator.putFile(BIG_REL, bigBytes(LARGE_SIZE, 3));
    const gateReady = holdReadsAfterUpdate(h);
    const run = h.importTarget();
    const gate = await gateReady;

    await expectPending(gate, 2, 'большой файл читается окном');
    assert.ok(gate.pendingCount() > 1, 'в полёте несколько порций');
    gate.release();
    await run;

    assert.ok((h.sftp?.maxConcurrent.READ ?? 0) > 1);
    assert.ok(bytesInP(h, BIG_REL).equals(bytesInDb(h, BIG_REL)));
  });

  test('11в. граница порога: файл размером ровно с порог — потоком, на байт меньше — Buffer (readFile)', async () => {
    await begin();
    const atThreshold = bigBytes(LARGE_THRESHOLD, 4);
    const below = bigBytes(LARGE_THRESHOLD - 1, 5);
    h.emulator.putFile(BIG_REL, atThreshold);
    h.emulator.putFile(BIG2_REL, below);

    await h.importTarget();

    assert.ok(probe);
    assert.strictEqual(probe.count('downloadToFile', /Данные\.bsl$/), 1);
    assert.strictEqual(probe.count('readFile', /Данные\.bsl$/), 0);
    assert.strictEqual(probe.count('readFile', /Данные2\.bsl$/), 1);
    assert.strictEqual(probe.count('downloadToFile', /Данные2\.bsl$/), 0);
    assert.ok(bytesInP(h, BIG_REL).equals(atThreshold));
    assert.ok(bytesInP(h, BIG2_REL).equals(below));
  });

  test('11г. малый файл идёт прежней дорожкой: readFile, без downloadToFile', async () => {
    await begin();
    h.emulator.putFile(SMALL_REL, '<Catalog>Клиенты v2</Catalog>');

    await h.importTarget();

    assert.ok(probe);
    assert.strictEqual(probe.count('readFile', /Клиенты\.xml$/), 1);
    assert.strictEqual(probe.count('downloadToFile', /Клиенты\.xml$/), 0);
    assert.strictEqual(h.readP(SMALL_REL), '<Catalog>Клиенты v2</Catalog>');
  });

  test('11д. большие файлы идут по одному (concurrency 1): два больших файла — не больше одного downloadToFile одновременно; оба в P', async () => {
    await begin({ harness: { transferConcurrency: 8 } });
    const a = bigBytes(LARGE_SIZE, 6);
    const b = bigBytes(LARGE_SIZE + 17, 7);
    h.emulator.putFile(BIG_REL, a);
    h.emulator.putFile(BIG2_REL, b);

    await h.importTarget();

    assert.ok(probe);
    assert.strictEqual(probe.maxDownloadsInFlight, 1, 'большие файлы не делят канал параллельно');
    assert.strictEqual(probe.count('downloadToFile', /Данные\.bsl$/), 1);
    assert.strictEqual(probe.count('downloadToFile', /Данные2\.bsl$/), 1);
    assert.ok(bytesInP(h, BIG_REL).equals(a));
    assert.ok(bytesInP(h, BIG2_REL).equals(b));
  });

  test('11е. полосы идут одновременно: малый и большой файлы читаются, пока ответы придержаны', async () => {
    await begin();
    h.emulator.putFile(BIG_REL, bigBytes(LARGE_SIZE, 8));
    h.emulator.putFile(SMALL_REL, '<Catalog>Клиенты v3</Catalog>');
    const gateReady = holdReadsAfterUpdate(h);
    const run = h.importTarget();
    const gate = await gateReady;

    await expectPending(gate, 2, 'обе полосы начали чтение');
    assert.ok(reads('Данные.bsl') > 0, 'большая полоса стартовала');
    assert.ok(reads('Клиенты.xml') > 0, 'малая полоса стартовала, не дожидаясь большой');
    gate.release();
    await run;

    assert.strictEqual(h.readP(SMALL_REL), '<Catalog>Клиенты v3</Catalog>');
    assert.ok(bytesInP(h, BIG_REL).equals(bytesInDb(h, BIG_REL)));
  });

  // ── 12. большой файл, равный P ────────────────────────────────────────────────────────────────

  test('12. большой файл, равный P (mtime в M свежий): скачан и сравнён, НЕ записан — нет в изменённых, mtime P не тронут; staging убран', async () => {
    await begin();
    const same = Buffer.from(bytesInP(h, BIG_REL));
    const pBefore = agePFile(h, BIG_REL);
    h.emulator.putFile(BIG_REL, same);

    const result = await h.importTarget();

    assert.ok(probe);
    assert.strictEqual(probe.count('downloadToFile', /Данные\.bsl$/), 1, 'скачан');
    assert.deepStrictEqual(result.changedProjectFiles, [], 'не записан');
    assert.strictEqual(mtimeOfP(h, BIG_REL), pBefore, 'файл P не перезаписывался');
    assert.deepStrictEqual(h.localExchangeLeftovers(), []);
    await assertCommon(h, from, 'full');
  });

  test('12б. большой файл, отличающийся от P одним байтом при том же размере: записан', async () => {
    await begin();
    const changed = Buffer.from(bytesInP(h, BIG_REL));
    changed[changed.length - 1] ^= 0xff;
    h.emulator.putFile(BIG_REL, changed);

    const result = await h.importTarget();

    assert.strictEqual(result.changedProjectFiles.length, 1);
    assert.ok(bytesInP(h, BIG_REL).equals(changed));
  });

  // ── 13. смесь ─────────────────────────────────────────────────────────────────────────────────

  test('13. малые и большие вместе: всё записано; Configuration.xml — последним; onWillChange — до записей, перед корнем, после всех', async () => {
    await begin();
    const oldConfiguration = h.readP('Configuration.xml');
    const next = bigBytes(LARGE_SIZE, 9);
    h.emulator.putFile(BIG_REL, next);
    h.emulator.putFile(SMALL_REL, '<Catalog>Клиенты v4</Catalog>');
    h.emulator.putFile('Configuration.xml', '<Configuration v="2"/>');
    const seen: { configuration: string; bigIsNew: boolean }[] = [];
    const hooks: AgentOperationHooks = {
      onProjectFilesWillChange: () => {
        seen.push({ configuration: h.readP('Configuration.xml'), bigIsNew: bytesInP(h, BIG_REL).equals(next) });
      },
    };

    await h.importTarget(hooks);

    assert.strictEqual(seen.length, 3);
    assert.deepStrictEqual(seen[0], { configuration: oldConfiguration, bigIsNew: false }, 'до первой записи');
    assert.deepStrictEqual(seen[1], { configuration: oldConfiguration, bigIsNew: true }, 'перед корнем: большой файл уже записан');
    assert.deepStrictEqual(seen[2], { configuration: '<Configuration v="2"/>', bigIsNew: true }, 'после всех записей');
    assert.strictEqual(h.readP(SMALL_REL), '<Catalog>Клиенты v4</Catalog>');
    await assertCommon(h, from, 'full');
  });

  // ── 14. отмена ────────────────────────────────────────────────────────────────────────────────

  test('14. отмена посреди большого файла: AgentSyncCancelledError, P не тронут, манифест empty, staging и дескрипторы убраны', async () => {
    await begin();
    h.emulator.putFile(BIG_REL, bigBytes(LARGE_SIZE, 10));
    const pBefore = h.snapshotP();
    const cancellation = { isCancellationRequested: false };
    const gateReady = holdReadsAfterUpdate(h);
    const run = h.importTarget({ cancellation });
    const gate = await gateReady;
    await expectPending(gate, 2, 'большой файл в полёте');

    cancellation.isCancellationRequested = true;
    gate.release();

    await assert.rejects(run, (error: unknown) => error instanceof AgentSyncCancelledError);
    assert.deepStrictEqual(h.snapshotP(), pBefore, 'P не тронут');
    assert.strictEqual(h.manifest().mirrorState, 'empty', 'M уже изменён --update: следующий импорт переподготовит зеркало');
    assert.deepStrictEqual(h.localExchangeLeftovers(), [], 'staging убран');
    assert.deepStrictEqual(h.serverExchangeLeftovers(), []);
    assert.ok((h.sftp?.ops('CLOSE').length ?? 0) >= (h.sftp?.ops('OPEN').length ?? 0), 'дескриптор закрыт');
  });

  // ── 15. отказ ─────────────────────────────────────────────────────────────────────────────────

  test('15. отказ READ на большом файле: ошибка с путём файла, P не тронут, staging убран', async () => {
    await begin();
    h.emulator.putFile(BIG_REL, bigBytes(LARGE_SIZE, 11));
    const pBefore = h.snapshotP();
    h.sftp?.failNext({ op: 'READ', pathIncludes: 'Данные.bsl' });

    await assert.rejects(h.importTarget(), (error: unknown) =>
      error instanceof Error && !(error instanceof AgentSyncCancelledError) && error.message.includes('Данные.bsl'));

    assert.deepStrictEqual(h.snapshotP(), pBefore);
    assert.deepStrictEqual(h.localExchangeLeftovers(), []);
  });

  test('15б. отказали обе полосы: одна ошибка AgentTransferError с перечнем и малого, и большого файла', async () => {
    await begin();
    h.emulator.putFile(BIG_REL, bigBytes(LARGE_SIZE, 12));
    h.emulator.putFile(SMALL_REL, '<Catalog>Клиенты v5</Catalog>');
    const pBefore = h.snapshotP();
    h.sftp?.failNext({ op: 'READ', pathIncludes: 'Данные.bsl' });
    h.sftp?.failNext({ op: 'READ', pathIncludes: 'Клиенты.xml' });

    await assert.rejects(h.importTarget(), (error: unknown) => {
      assert.ok(error instanceof AgentTransferError, String(error));
      const paths = error.failures.map((failure) => failure.path);
      assert.ok(paths.some((p) => p.endsWith('Данные.bsl')), paths.join(', '));
      assert.ok(paths.some((p) => p.endsWith('Клиенты.xml')), paths.join(', '));
      return true;
    });

    assert.deepStrictEqual(h.snapshotP(), pBefore);
  });

  test('15в. отказ в большой полосе при удачной малой: ошибка одна, P не тронут (малые правки тоже не применены)', async () => {
    await begin();
    h.emulator.putFile(BIG_REL, bigBytes(LARGE_SIZE, 13));
    h.emulator.putFile(SMALL_REL, '<Catalog>Клиенты v6</Catalog>');
    const pBefore = h.snapshotP();
    h.sftp?.failNext({ op: 'READ', pathIncludes: 'Данные.bsl' });

    await assert.rejects(h.importTarget(), /Данные\.bsl/);

    assert.deepStrictEqual(h.snapshotP(), pBefore);
  });

  test('15г. отказ в малой полосе при удачной большой: P не тронут', async () => {
    await begin();
    h.emulator.putFile(BIG_REL, bigBytes(LARGE_SIZE, 14));
    h.emulator.putFile(SMALL_REL, '<Catalog>Клиенты v7</Catalog>');
    const pBefore = h.snapshotP();
    h.sftp?.failNext({ op: 'READ', pathIncludes: 'Клиенты.xml' });

    await assert.rejects(h.importTarget(), /Клиенты\.xml/);

    assert.deepStrictEqual(h.snapshotP(), pBefore);
    assert.deepStrictEqual(h.localExchangeLeftovers(), []);
  });

  // ── 17. свободное место ───────────────────────────────────────────────────────────────────────

  suite('17. проверка свободного места перед скачиванием больших файлов', () => {
    const NEED = 2 * LARGE_SIZE;
    const probeCalls: string[] = [];
    const withFree = (free: number | undefined) => ({
      freeDiskSpace: (dir: string): Promise<number | undefined> => { probeCalls.push(dir); return Promise.resolve(free); },
    });
    setup(() => { probeCalls.splice(0); });

    test('свободно меньше 2 × суммы больших: отказ ДО первого READ большого файла, текст с «нужно» и «свободно», P не тронут', async () => {
      await begin({ harness: withFree(1000) });
      h.emulator.putFile(BIG_REL, bigBytes(LARGE_SIZE, 15));
      const pBefore = h.snapshotP();

      await assert.rejects(h.importTarget(), (error: unknown) =>
        error instanceof Error && error.message.startsWith('Недостаточно места на диске для скачивания: нужно ~600,0 КБ, свободно 1000 Б'));

      assert.strictEqual(reads('Данные.bsl'), 0, 'большой файл не читался');
      assert.deepStrictEqual(h.snapshotP(), pBefore);
      assert.strictEqual(probeCalls.length, 1);
      assert.ok(probeCalls[0].startsWith(h.localExchangeRoot), `проверяется диск каталога обмена: ${probeCalls[0]}`);
    });

    test('граница: свободно на байт меньше нужного — отказ', async () => {
      await begin({ harness: withFree(NEED - 1) });
      h.emulator.putFile(BIG_REL, bigBytes(LARGE_SIZE, 16));
      await assert.rejects(h.importTarget(), /Недостаточно места на диске/);
    });

    test('граница: свободно ровно столько, сколько нужно, — скачивание идёт', async () => {
      await begin({ harness: withFree(NEED) });
      const next = bigBytes(LARGE_SIZE, 17);
      h.emulator.putFile(BIG_REL, next);
      await h.importTarget();
      assert.ok(bytesInP(h, BIG_REL).equals(next));
    });

    test('проверка недоступна (undefined — нет statfs): пропускается, скачивание идёт', async () => {
      await begin({ harness: withFree(undefined) });
      const next = bigBytes(LARGE_SIZE, 18);
      h.emulator.putFile(BIG_REL, next);
      await h.importTarget();
      assert.ok(bytesInP(h, BIG_REL).equals(next));
      assert.strictEqual(probeCalls.length, 1);
    });

    test('сумма считается по всем большим файлам: два файла по 300 КиБ — нужно ~1,2 МБ', async () => {
      await begin({ harness: withFree(NEED) });
      h.emulator.putFile(BIG_REL, bigBytes(LARGE_SIZE, 19));
      h.emulator.putFile(BIG2_REL, bigBytes(LARGE_SIZE, 20));
      await assert.rejects(h.importTarget(), /нужно ~1,2 МБ/);
    });

    test('малые файлы место не проверяют: проба не вызывается', async () => {
      await begin({ harness: withFree(0) });
      h.emulator.putFile(SMALL_REL, '<Catalog>Клиенты v8</Catalog>');
      await h.importTarget();
      assert.strictEqual(probeCalls.length, 0);
      assert.strictEqual(h.readP(SMALL_REL), '<Catalog>Клиенты v8</Catalog>');
    });

    test('по умолчанию проверка — настоящая statfs каталога обмена: нормальный диск тестов не мешает скачиванию', async () => {
      await begin();
      const next = bigBytes(LARGE_SIZE, 21);
      h.emulator.putFile(BIG_REL, next);
      await h.importTarget();
      assert.ok(bytesInP(h, BIG_REL).equals(next));
    });
  });

  // ── переименование регистром ──────────────────────────────────────────────────────────────────

  test('переименование только регистром (FullDump → очистка): большой файл с тем же содержимым не теряется — путь удаления и записи один физический файл', async () => {
    await begin();
    const data = Buffer.from(bytesInP(h, BIG_REL));
    h.emulator.removeObject('Catalog.Товары');
    h.emulator.setObject('Catalog.товары', {
      'Catalogs/товары.xml': '<Catalog>товары</Catalog>',
      'Catalogs/товары/Ext/Данные.bsl': data,
    });

    await h.importTarget();

    const found = Object.keys(h.snapshotP()).filter((rel) => rel.toLowerCase() === 'catalogs/товары/ext/данные.bsl');
    assert.strictEqual(found.length, 1, `файл на месте под одним именем: ${found.join(', ')}`);
    assert.ok(fs.readFileSync(path.join(h.configRoot, ...found[0].split('/'))).equals(data));
  });
});

suite('AgentSyncEngine: локальный агент — большие файлы без чтения целиком (§2.5)', function () {
  this.timeout(120_000);
  let h: SyncHarness;
  let counting: DownloadProbeStore;

  setup(async () => {
    h = await createHarness('local', {
      ...HARNESS_LARGE,
      wrapStore: (store) => { counting = new DownloadProbeStore(store); return counting; },
    });
    h.seedDb();
    h.emulator.setConfiguration('Основная', 'cf');
    h.emulator.putFile(BIG_REL, bigBytes(LARGE_SIZE, 1));
    await h.importTarget();
    counting.calls.splice(0);
  });
  teardown(async () => { await h.dispose(); });

  test('первый импорт большого файла (его нет в P): записан потоком из M, readFile не звался, байты точны', async () => {
    await h.dispose();
    h = await createHarness('local', {
      ...HARNESS_LARGE,
      wrapStore: (store) => { counting = new DownloadProbeStore(store); return counting; },
    });
    h.seedDb();
    h.emulator.setConfiguration('Основная', 'cf');
    const data = bigBytes(LARGE_SIZE, 30);
    h.emulator.putFile(BIG_REL, data);

    const result = await h.importTarget();

    assert.strictEqual(result.strategy, 'compare');
    assert.strictEqual(counting.count('readFile', /Данные\.bsl$/), 0);
    assert.ok(counting.count('downloadToFile', /Данные\.bsl$/) >= 1);
    assert.ok(bytesInP(h, BIG_REL).equals(data));
    assert.deepStrictEqual(h.localExchangeLeftovers(), []);
  });

  test('29. большой файл равного размера и содержимого: не записан, readFile по нему не вызывался, staging убран', async () => {
    const pBefore = agePFile(h, BIG_REL);

    const result = await h.importTarget();

    assert.strictEqual(counting.count('readFile', /Данные\.bsl$/), 0);
    assert.ok(!result.changedProjectFiles.some((file) => file.endsWith('Данные.bsl')), 'в изменённых его нет');
    assert.strictEqual(mtimeOfP(h, BIG_REL), pBefore, 'mtime P не тронут');
    assert.deepStrictEqual(h.localExchangeLeftovers(), []);
  });

  test('30. большой файл другого размера: записан без сравнения содержимого — downloadToFile только для записи', async () => {
    const next = bigBytes(LARGE_SIZE + 4096, 31);
    h.emulator.putFile(BIG_REL, next);

    await h.importTarget();

    assert.strictEqual(counting.count('readFile', /Данные\.bsl$/), 0);
    assert.strictEqual(counting.count('downloadToFile', /Данные\.bsl$/), 1, 'одно скачивание — сразу в temp записи P');
    assert.ok(bytesInP(h, BIG_REL).equals(next));
    assert.deepStrictEqual(h.localExchangeLeftovers(), []);
  });

  test('31. большой файл того же размера с другим содержимым: записан побайтно точно (скачивание для сравнения + для записи)', async () => {
    const next = bigBytes(LARGE_SIZE, 32);
    h.emulator.putFile(BIG_REL, next);

    await h.importTarget();

    assert.strictEqual(counting.count('readFile', /Данные\.bsl$/), 0);
    assert.strictEqual(counting.count('downloadToFile', /Данные\.bsl$/), 2, 'staging для сравнения и temp для записи');
    assert.ok(bytesInP(h, BIG_REL).equals(next));
    assert.deepStrictEqual(h.localExchangeLeftovers(), []);
  });

  test('31б. отличие в ПОСЛЕДНЕМ байте при равном размере — тоже изменение', async () => {
    const next = Buffer.from(bytesInP(h, BIG_REL));
    next[next.length - 1] ^= 0x55;
    h.emulator.putFile(BIG_REL, next);

    await h.importTarget();

    assert.ok(bytesInP(h, BIG_REL).equals(next));
  });

  test('малые файлы локального агента идут прежним путём (readFile)', async () => {
    h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>Клиенты v2</Catalog>');

    await h.importTarget();

    assert.ok(counting.count('readFile', /Клиенты\.xml$/) >= 1);
    assert.strictEqual(counting.count('downloadToFile', /Клиенты\.xml$/), 0);
    assert.strictEqual(h.readP('Catalogs/Клиенты.xml'), '<Catalog>Клиенты v2</Catalog>');
  });

  test('граница порога: размер ровно с порог — потоком, на байт меньше — буфером', async () => {
    h.emulator.putFile(BIG_REL, bigBytes(LARGE_THRESHOLD, 33));
    h.emulator.putFile(BIG2_REL, bigBytes(LARGE_THRESHOLD - 1, 34));

    await h.importTarget();

    assert.strictEqual(counting.count('readFile', /Данные\.bsl$/), 0);
    assert.ok(counting.count('downloadToFile', /Данные\.bsl$/) >= 1);
    assert.ok(counting.count('readFile', /Данные2\.bsl$/) >= 1);
    assert.strictEqual(counting.count('downloadToFile', /Данные2\.bsl$/), 0);
  });

  test('большой файл удалён в базе: удалён из P без скачивания', async () => {
    h.emulator.removeFiles([BIG_REL]);

    await h.importTarget();

    assert.ok(!h.existsP(BIG_REL));
    assert.strictEqual(counting.count('readFile', /Данные\.bsl$/), 0);
    assert.strictEqual(counting.count('downloadToFile', /Данные\.bsl$/), 0);
  });

  test('переименование только регистром: большой файл с тем же содержимым не пропадает', async () => {
    const data = Buffer.from(bytesInP(h, BIG_REL));
    h.emulator.removeObject('Catalog.Товары');
    h.emulator.setObject('Catalog.товары', {
      'Catalogs/товары.xml': '<Catalog>товары</Catalog>',
      'Catalogs/товары/Ext/Данные.bsl': data,
    });

    await h.importTarget();

    const found = Object.keys(h.snapshotP()).filter((rel) => rel.toLowerCase() === 'catalogs/товары/ext/данные.bsl');
    assert.strictEqual(found.length, 1, found.join(', '));
    assert.ok(fs.readFileSync(path.join(h.configRoot, ...found[0].split('/'))).equals(data));
    assert.deepStrictEqual(Object.keys(h.snapshotP()).filter((rel) => rel !== 'ConfigDumpInfo.xml').map((rel) => rel.toLowerCase()).sort(),
      Object.keys(dbAsText(h.emulator.dbTrackedFiles())).map((rel) => rel.toLowerCase()).sort());
  });
});

// ── 32–33. прогресс по весу ────────────────────────────────────────────────────────────────────────

suite('AgentSyncEngine: прогресс скачивания по весу и предупреждения о больших файлах (sftp)', function () {
  this.timeout(180_000);
  let h: SyncHarness;
  let tick = 0;
  let step = 0;
  const clock = (): number => { tick += step; return tick; };
  const MB1 = 1024 * 1024;

  async function begin(extra: (emulator: SyncHarness['emulator']) => void = () => undefined, size = LARGE_SIZE): Promise<void> {
    tick = 0;
    step = 0;
    h = await startAvoidHarness({
      coverage: 'full',
      seed: (emulator) => { emulator.putFile(BIG_REL, bigBytes(size, 1)); extra(emulator); },
      harness: { ...HARNESS_LARGE, progressClock: clock },
    });
    ageAgentTree(h.mirrorAbs);
    h.sftp?.log.splice(0);
  }
  teardown(async () => { await h.dispose(); });

  function spy(): { journal: string[]; ui: { text: string; done?: number; total?: number }[]; hooks: AgentOperationHooks; readsAtMessage: Map<string, number> } {
    const journal: string[] = [];
    const ui: { text: string; done?: number; total?: number }[] = [];
    const readsAtMessage = new Map<string, number>();
    return {
      journal,
      ui,
      readsAtMessage,
      hooks: {
        onMessage: (message) => {
          journal.push(message);
          readsAtMessage.set(message, opsAt(h, 'READ', 'Данные.bsl'));
        },
        onProgress: (event) => { ui.push(event); },
      },
    };
  }

  test('32. перед первым READ большого файла: «Скачивается N файлов, вес», предупреждение «Среди скачиваемых — файл …», веха старта; затем вехи по байтам', async () => {
    await begin();
    h.emulator.putFile(BIG_REL, bigBytes(LARGE_SIZE, 2));
    const s = spy();

    await h.importTarget(s.hooks);

    const total = s.journal.find((message) => /^Скачивается 1 файл\S*, 300,0 КБ\.$/.test(message));
    assert.ok(total, `итог набора: ${s.journal.join(' | ')}`);
    const warning = `Среди скачиваемых — файл 300,0 КБ: ${BIG_REL}.`;
    const started = `Скачивание большого файла (300,0 КБ): ${BIG_REL}`;
    assert.ok(s.journal.includes(warning), s.journal.join(' | '));
    assert.ok(s.journal.includes(started), s.journal.join(' | '));
    assertSubsequence(s.journal, [total, warning, started, /^Скачивание изменённых файлов: 1 из 1, 300,0 КБ из 300,0 КБ \(100%\)/]);
    assert.strictEqual(s.readsAtMessage.get(total), 0, 'итог набора — до первого чтения большого файла');
    assert.strictEqual(s.readsAtMessage.get(warning), 0, 'предупреждение — до первого чтения большого файла');
  });

  test('32б. файл ниже порога предупреждения (но выше порога большого) не предупреждает; веха старта большого файла — есть', async () => {
    await begin(undefined, LARGE_THRESHOLD + 10);
    h.emulator.putFile(BIG_REL, bigBytes(LARGE_THRESHOLD + 10, 2));
    const s = spy();

    await h.importTarget(s.hooks);

    assert.ok(!s.journal.some((message) => message.startsWith('Среди скачиваемых — файл')), s.journal.join(' | '));
    assert.ok(s.journal.some((message) => message.startsWith('Скачивание большого файла (')), s.journal.join(' | '));
  });

  test('32в. пять файлов выше порога предупреждения: названы первые три, остальные — «и ещё 2»', async () => {
    const extras = ['Catalogs/Ч1/Ext/М.bsl', 'Catalogs/Ч2/Ext/М.bsl', 'Catalogs/Ч3/Ext/М.bsl', 'Catalogs/Ч4/Ext/М.bsl'];
    await begin((emulator) => { for (const [index, rel] of extras.entries()) { emulator.putFile(rel, bigBytes(LARGE_SIZE, 40 + index)); } });
    h.emulator.putFile(BIG_REL, bigBytes(LARGE_SIZE, 2));
    for (const [index, rel] of extras.entries()) {
      h.emulator.putFile(rel, bigBytes(LARGE_SIZE, 60 + index));
    }
    const s = spy();

    await h.importTarget(s.hooks);

    const warnings = s.journal.filter((message) => message.startsWith('Среди скачиваемых — файл '));
    assert.strictEqual(warnings.length, 3, warnings.join(' | '));
    assert.ok(s.journal.some((message) => message.includes('и ещё 2')), s.journal.join(' | '));
    assert.ok(s.journal.some((message) => /^Скачивается 5 файл\S*, 1,5 МБ\.$/.test(message)), s.journal.join(' | '));
  });

  test('33. итог — 100% и полный объём; число строк журнала ограничено вехами, в UI есть промежуточные значения со скоростью и оставшимся временем', async () => {
    await begin(undefined, MB1);
    h.emulator.putFile(BIG_REL, bigBytes(MB1, 2));
    step = 600;
    const s = spy();

    await h.importTarget(s.hooks);

    const isProgress = (text: string): boolean => text.startsWith('Скачивание изменённых файлов: ');
    const journalLines = s.journal.filter(isProgress);
    const uiLines = s.ui.map((event) => event.text).filter(isProgress);
    const chunks = h.sftp?.ops('READ').filter((entry) => (entry.path ?? '').endsWith('Данные.bsl')).length ?? 0;
    assert.ok(chunks >= 30, `файл читался порциями: ${String(chunks)}`);
    assert.ok(journalLines.length <= 14, `в журнале вехи, а не запись на каждую порцию: ${String(journalLines.length)}`);
    assert.ok(uiLines.length >= 25, `UI показывает промежуточные значения: ${String(uiLines.length)}`);
    assert.ok(uiLines.length > journalLines.length);
    assert.match(journalLines.at(-1) ?? '', /^Скачивание изменённых файлов: 1 из 1, 1,0 МБ из 1,0 МБ \(100%\)/);
    assert.match(uiLines.at(-1) ?? '', /\(100%\)/);
    assert.ok(
      uiLines.some((line) => /, \d+(?:,\d+)? (?:Б|КБ|МБ)\/с, осталось ~/.test(line)),
      `скорость и оставшееся время после ≥ 1 с часов: ${uiLines.slice(-3).join(' | ')}`
    );
    const events = s.ui.filter((event) => isProgress(event.text));
    assert.ok(events.every((event) => event.total === undefined || event.total > 0));
    assert.strictEqual(events.at(-1)?.done, events.at(-1)?.total, 'в UI последний done = total');
  });

  test('33б. без часов (постоянные): проценты есть, скорости и «осталось» нет', async () => {
    await begin();
    h.emulator.putFile(BIG_REL, bigBytes(LARGE_SIZE, 3));
    const s = spy();

    await h.importTarget(s.hooks);

    const lines = s.journal.filter((message) => message.startsWith('Скачивание изменённых файлов: '));
    assert.ok(lines.length >= 2);
    assert.ok(lines.every((line) => !/\/с|осталось/.test(line)), lines.join(' | '));
  });
});
