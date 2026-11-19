import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentStreamOptions } from '../../infra/agent/files/AgentFileStore';
import { fetchFreshDumpInfo } from '../../infra/agent/sync/FreshDumpInfo';
import {
  AgentSyncCancelledError,
  EXCHANGE_CHANGES_RETRY_SUFFIX,
  EXCHANGE_DUMP_INFO_ARCHIVE,
  EXCHANGE_DUMP_INFO_DIR,
  EXCHANGE_RESTORE_LIST_SUFFIX,
  EXCHANGE_SIDE_SUFFIXES,
} from '../../infra/agent/sync/SyncContext';
import { parseConfigDumpInfoIndex } from '../../infra/xml/dumpInfo/ConfigDumpInfoIndex';
import { hasOption } from './support/agentConfigEmulator';
import { agentError } from './support/agentInfoBaseFakes';
import { createHarness, type HarnessKind, type SyncHarness } from './support/agentSyncHarness';
import { makeContext } from './support/archiveAvoidFixtures';
import { dumpsFrom } from './support/fullDumpAvoidFixtures';
import { DelegatingAgentFileStore } from './support/delegatingAgentFileStore';
import { summarizeIndex } from './support/dumpInfoFixtures';
import { buildZip, readZipAsMap } from './support/zipFixtures';

/**
 * Свежий файл версий базы (plan-fulldump-avoid.md, Т5): `dump --dir=exchange/<op>/cdi --config-dump-info-only
 * --archive=cdi.zip` → скачать zip → прочитать из него CDI → стражи → убрать каталог. M функция НЕ мутирует.
 * Агент — эмулятор, хранилище — настоящее (локальное и SFTP).
 */

const OPERATION = 'cf-fresh-1';
const CDI = 'ConfigDumpInfo.xml';
const KINDS: readonly HarnessKind[] = ['local', 'sftp'];

/** Хранилище, у которого скачивание после `armed = true` обрывается транспортным сбоем. */
class BrokenDownloadStore extends DelegatingAgentFileStore {
  armed = false;
  override downloadToFile(rel: string, localPath: string, options?: AgentStreamOptions): Promise<void> {
    return this.armed ? Promise.reject(new Error(`обрыв скачивания ${rel}`)) : super.downloadToFile(rel, localPath, options);
  }
}

/** Подменяет текст CDI внутри zip так, чтобы архив оставался корректным (CRC сходится). */
function rewriteCdiInZip(zip: Buffer, transform: (text: string) => string): Buffer {
  const entries = readZipAsMap(zip);
  return buildZip([...entries].map(([name, data]) => ({
    name,
    data: name === CDI ? Buffer.from(transform(data.toString('utf-8')), 'utf-8') : data,
  })));
}

for (const kind of KINDS) {
  suite(`fetchFreshDumpInfo: ${kind}`, function () {
    this.timeout(60_000);
    let h: SyncHarness;

    async function start(): Promise<void> {
      h = await createHarness(kind);
      h.seedDb();
      h.emulator.setConfiguration('Основная', 'cf');
      await h.importTarget();
    }
    teardown(async () => { await h.dispose(); });

    const mirrorIndex = (): ReturnType<typeof parseConfigDumpInfoIndex> => parseConfigDumpInfoIndex(h.readM(CDI));
    const cdiDirAbs = (): string => path.join(h.userRoot, 'exchange', OPERATION, EXCHANGE_DUMP_INFO_DIR);

    test('ok: команда --config-dump-info-only --archive=cdi.zip в exchange/<op>/cdi без --update; индекс ≡ CDI базы; каталог cdi убран', async () => {
      await start();
      h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>Клиенты v2</Catalog>');
      h.emulator.removeFiles(['Documents/Заказ/Forms/Форма.xml', 'Documents/Заказ/Forms/Форма/Ext/Form.xml']);
      const { context, localExchange } = await makeContext(h, { operationId: OPERATION });
      const from = h.emulator.commands.length;

      const result = await fetchFreshDumpInfo(context, mirrorIndex());

      assert.ok(result.ok);
      assert.deepStrictEqual(
        summarizeIndex(result.index),
        summarizeIndex(parseConfigDumpInfoIndex(h.emulator.dbFiles()[CDI].toString('utf-8')))
      );
      const dumps = dumpsFrom(h.emulator, from);
      assert.strictEqual(dumps.length, 1, 'ровно одна команда выгрузки');
      const [dump] = dumps;
      assert.strictEqual(dump.options.dir, `exchange/${OPERATION}/${EXCHANGE_DUMP_INFO_DIR}`);
      assert.strictEqual(dump.options.archive, EXCHANGE_DUMP_INFO_ARCHIVE);
      assert.strictEqual(dump.options['config-dump-info-only'], true);
      assert.ok(!dump.options.update && !hasOption(dump, 'get-changes') && !hasOption(dump, 'list-file'));
      assert.strictEqual(dump.options.format, 'hierarchical');
      assert.strictEqual(h.emulator.infoOnlyDumps, 1);
      assert.ok(!fs.existsSync(cdiDirAbs()), 'каталог cdi на сервере убран');
      await localExchange.dispose();
    });

    test('M побайтно не тронут, markMirrorMutated не вызван', async () => {
      await start();
      const mBefore = h.snapshotM();
      const { context, mutations } = await makeContext(h, { operationId: OPERATION });

      const result = await fetchFreshDumpInfo(context, mirrorIndex());

      assert.ok(result.ok);
      assert.deepStrictEqual(h.snapshotM(), mBefore);
      assert.strictEqual(mutations.count, 0);
    });

    test('AgentCommandError на --config-dump-info-only → { ok: false } с причиной; M не тронут', async () => {
      await start();
      const mBefore = h.snapshotM();
      h.emulator.failWhen = (cmd) => (hasOption(cmd, 'config-dump-info-only') ? agentError('UnknownError', 'не удалось выгрузить') : undefined);
      const { context, mutations } = await makeContext(h, { operationId: OPERATION });

      const result = await fetchFreshDumpInfo(context, mirrorIndex());

      assert.ok(!result.ok);
      assert.ok(result.reason.trim().length > 0);
      assert.deepStrictEqual(h.snapshotM(), mBefore);
      assert.strictEqual(mutations.count, 0);
    });

    test('испорченный zip (усечён) → { ok: false }', async () => {
      await start();
      h.emulator.nextArchiveTamper = (zip) => zip.subarray(0, zip.length - 40);
      const { context } = await makeContext(h, { operationId: OPERATION });

      const result = await fetchFreshDumpInfo(context, mirrorIndex());

      assert.ok(!result.ok);
    });

    test('в zip нет ConfigDumpInfo.xml → { ok: false }', async () => {
      await start();
      h.emulator.nextArchiveTamper = () => buildZip([{ name: 'Другой.xml', data: Buffer.from('<x/>') }]);
      const { context } = await makeContext(h, { operationId: OPERATION });

      assert.ok(!(await fetchFreshDumpInfo(context, mirrorIndex())).ok);
    });

    test('корень ConfigDumpInfo не разобрался (текст не CDI) → { ok: false }', async () => {
      await start();
      h.emulator.nextArchiveTamper = (zip) => rewriteCdiInZip(zip, () => 'это не файл версий');
      const { context } = await makeContext(h, { operationId: OPERATION });

      assert.ok(!(await fetchFreshDumpInfo(context, mirrorIndex())).ok);
    });

    const guards: [string, (text: string) => string][] = [
      ['чужой configurationOwner (другое имя корня конфигурации)', (text) => text.split('Configuration.Конфигурация').join('Configuration.Чужая')],
      ['другая версия формата', (text) => text.replace('version="2.20"', 'version="2.21"')],
      ['формат не Hierarchical', (text) => text.replace('format="Hierarchical"', 'format="Plain"')],
    ];
    for (const [label, transform] of guards) {
      test(`страж: ${label} → { ok: false }; zip корректен, M не тронут`, async () => {
        await start();
        const mBefore = h.snapshotM();
        h.emulator.nextArchiveTamper = (zip) => rewriteCdiInZip(zip, transform);
        const { context, mutations } = await makeContext(h, { operationId: OPERATION });

        const result = await fetchFreshDumpInfo(context, mirrorIndex());

        assert.ok(!result.ok);
        assert.ok(result.reason.trim().length > 0);
        assert.deepStrictEqual(h.snapshotM(), mBefore);
        assert.strictEqual(mutations.count, 0);
      });
    }

    test('страж пропускает корректный CDI с другими версиями записей (изменения базы — не повод отказа)', async () => {
      await start();
      h.emulator.putFile('Catalogs/Товары.xml', '<Catalog>Товары v2</Catalog>');
      const { context } = await makeContext(h, { operationId: OPERATION });

      assert.ok((await fetchFreshDumpInfo(context, mirrorIndex())).ok);
    });

    test('отмена после команды → AgentSyncCancelledError (не { ok: false })', async () => {
      await start();
      const cancellation = { isCancellationRequested: false };
      h.emulator.onCommand = (cmd) => {
        if (hasOption(cmd, 'config-dump-info-only')) {
          cancellation.isCancellationRequested = true;
        }
      };
      const { context } = await makeContext(h, { operationId: OPERATION, hooks: { cancellation } });

      await assert.rejects(fetchFreshDumpInfo(context, mirrorIndex()), AgentSyncCancelledError);
    });
  });
}

suite('fetchFreshDumpInfo: транспортный сбой', function () {
  this.timeout(60_000);
  let h: SyncHarness;
  teardown(async () => { await h.dispose(); });

  for (const kind of KINDS) {
    test(`${kind}: сбой скачивания zip — исключение (не { ok: false }): повтор запасным путём не поможет`, async () => {
      let store: BrokenDownloadStore | undefined;
      h = await createHarness(kind, { wrapStore: (inner) => { store = new BrokenDownloadStore(inner); return store; } });
      h.seedDb();
      h.emulator.setConfiguration('Основная', 'cf');
      await h.importTarget();
      assert.ok(store);
      store.armed = true;
      const mirrorIndex = parseConfigDumpInfoIndex(h.readM(CDI));
      const { context, mutations } = await makeContext(h, { operationId: OPERATION });

      await assert.rejects(fetchFreshDumpInfo(context, mirrorIndex), /обрыв скачивания/);

      assert.strictEqual(mutations.count, 0);
    });
  }
});

suite('константы обмена: каталог cdi и повторный список изменений', () => {
  test('имена каталога/архива свежего CDI и суффикс повторного списка', () => {
    assert.strictEqual(EXCHANGE_DUMP_INFO_DIR, 'cdi');
    assert.strictEqual(EXCHANGE_DUMP_INFO_ARCHIVE, 'cdi.zip');
    assert.strictEqual(EXCHANGE_CHANGES_RETRY_SUFFIX, '.changes-retry');
  });

  test('EXCHANGE_SIDE_SUFFIXES — единый список для уборки: .changes, .changes-retry и список точечной выгрузки', () => {
    for (const suffix of ['.changes', EXCHANGE_CHANGES_RETRY_SUFFIX, EXCHANGE_RESTORE_LIST_SUFFIX]) {
      assert.ok(EXCHANGE_SIDE_SUFFIXES.includes(suffix), suffix);
    }
    assert.strictEqual(new Set(EXCHANGE_SIDE_SUFFIXES).size, EXCHANGE_SIDE_SUFFIXES.length, 'без дублей');
    assert.strictEqual(EXCHANGE_RESTORE_LIST_SUFFIX, '.objects.txt');
  });
});
