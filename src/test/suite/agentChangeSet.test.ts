import * as assert from 'assert';
import { fetchChangeSet } from '../../infra/agent/sync/ChangeSet';
import { EXCHANGE_CHANGES_RETRY_SUFFIX } from '../../infra/agent/sync/SyncContext';
import { createHarness, type HarnessKind, type SyncHarness } from './support/agentSyncHarness';
import { makeContext } from './support/archiveAvoidFixtures';
import { BOM } from './support/fullDumpAvoidFixtures';

/**
 * `fetchChangeSet(context, suffix)` (plan-fulldump-avoid.md, Т7: вынесен из AgentImportFlow): `dump --update
 * --get-changes=exchange/<op><suffix>` и разбор файла. Суффикс выбирает файл: `.changes` — первый список,
 * `.changes-retry` — повторный после очистки зеркала; файлы не мешают друг другу.
 */

const OPERATION = 'cf-changes-1';

for (const kind of ['sftp', 'local'] as const satisfies readonly HarnessKind[]) {
  suite(`fetchChangeSet: ${kind}`, function () {
    this.timeout(60_000);
    let h: SyncHarness;

    setup(async () => {
      h = await createHarness(kind);
      h.seedDb();
      h.emulator.setConfiguration('Основная', 'cf');
      await h.importTarget();
    });
    teardown(async () => { await h.dispose(); });

    for (const suffix of ['.changes', EXCHANGE_CHANGES_RETRY_SUFFIX]) {
      test(`суффикс ${suffix}: команда пишет список в exchange/<op>${suffix}, результат разобран`, async () => {
        h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>Клиенты v2</Catalog>');
        const { context } = await makeContext(h, { operationId: OPERATION });
        const from = h.emulator.commands.length;

        const changeSet = await fetchChangeSet(context, suffix);

        assert.ok(changeSet.kind === 'objects');
        assert.deepStrictEqual(changeSet.objects.map((o) => [o.change, o.fullName]), [['modified', 'Catalog.Клиенты']]);
        const dump = h.emulator.commands.slice(from).find((c) => c.command === 'config dump-config-to-files');
        assert.ok(dump);
        assert.strictEqual(dump.options['get-changes'], `exchange/${OPERATION}${suffix}`);
        assert.strictEqual(dump.options.update, true);
        assert.strictEqual(dump.options.dir, h.mirrorDir);
        assert.ok((await h.store.stat(`exchange/${OPERATION}${suffix}`)) !== undefined, 'файл списка создан агентом');
      });
    }

    test('FullDump и «нет изменений» разбираются; два суффикса — два независимых файла', async () => {
      const { context } = await makeContext(h, { operationId: OPERATION });
      assert.deepStrictEqual(await fetchChangeSet(context, '.changes'), { kind: 'objects', objects: [] });

      h.emulator.nextChangesText = `${BOM}FullDump\r\n`;
      assert.deepStrictEqual(await fetchChangeSet(context, EXCHANGE_CHANGES_RETRY_SUFFIX), { kind: 'fullDump' });

      assert.strictEqual((await h.store.readFile(`exchange/${OPERATION}.changes`)).toString('utf-8'), BOM);
      assert.ok((await h.store.readFile(`exchange/${OPERATION}.changes-retry`)).toString('utf-8').includes('FullDump'));
    });
  });
}
