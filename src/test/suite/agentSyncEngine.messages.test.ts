import * as assert from 'assert';
import type { AgentOperationHooks } from '../../infra/agent/AgentOperationService';
import { createHarness, type HarnessKind, type SyncHarness } from './support/agentSyncHarness';

/**
 * Э7: сообщения загрузки (`hooks.onMessage`) на всех ветках исполнения плана — частичная, полная
 * (каталогом M локально, архивом удалённо), полная по причине удаления — и те же ветки, когда
 * хуки переданы без `onMessage` (вызывающий подписан только на файлы или отмену): сообщение
 * необязательно и не должно ни ронять операцию, ни менять её исход.
 */
const EXPECTED: Record<HarnessKind, { full: string[] }> = {
  local: { full: ['Подготовка файлов для полной загрузки.', 'Полная загрузка конфигурации из файлов.'] },
  sftp: { full: ['Подготовка архива для полной загрузки.', 'Полная загрузка конфигурации из архива.'] },
};

for (const kind of ['local', 'sftp'] as HarnessKind[]) {
  suite(`AgentSyncEngine (Э7): сообщения загрузки, хранилище ${kind}`, function () {
    this.timeout(60_000);
    let h: SyncHarness;

    setup(async () => {
      h = await createHarness(kind);
      h.seedDb();
      await h.engine.importTarget(h.target, h.exec);
    });
    teardown(async () => { await h.dispose(); });

    function collecting(): { messages: string[]; hooks: AgentOperationHooks } {
      const messages: string[] = [];
      return { messages, hooks: { onMessage: (message) => { messages.push(message); } } };
    }

    test('частичная загрузка: сообщения подготовки и загрузки', async () => {
      h.writeP('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
      const { messages, hooks } = collecting();
      const result = await h.engine.loadTarget(h.target, 'changed', h.exec, hooks);
      assert.strictEqual(result.strategy, 'partial');
      assert.deepStrictEqual(messages, ['Подготовка частичной загрузки: 1 файл(ов).', 'Частичная загрузка изменённых файлов.']);
    });

    test('полная загрузка (mode full): сообщения своей ветки', async () => {
      const { messages, hooks } = collecting();
      const result = await h.engine.loadTarget(h.target, 'full', h.exec, hooks);
      assert.strictEqual(result.strategy, 'full');
      assert.deepStrictEqual(messages, EXPECTED[kind].full);
    });

    test('полная загрузка по удалению: сначала причина, затем сообщения ветки', async () => {
      h.removeP('Catalogs/Клиенты.xml');
      const { messages, hooks } = collecting();
      await h.engine.loadTarget(h.target, 'changed', h.exec, hooks);
      assert.deepStrictEqual(messages, ['Обнаружено удаление файлов, выполняется полная загрузка.', ...EXPECTED[kind].full]);
    });

    test('хуки без onMessage: частичная и обе полные загрузки проходят с тем же исходом', async () => {
      const hooks: AgentOperationHooks = { cancellation: { isCancellationRequested: false } };
      h.writeP('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
      assert.strictEqual((await h.engine.loadTarget(h.target, 'changed', h.exec, hooks)).strategy, 'partial');
      assert.strictEqual((await h.engine.loadTarget(h.target, 'full', h.exec, hooks)).strategy, 'full');
      h.removeP('Catalogs/Клиенты.xml');
      const deletion = await h.engine.loadTarget(h.target, 'changed', h.exec, hooks);
      assert.strictEqual(deletion.reason, 'deletion');
      assert.strictEqual(h.emulator.dbTrackedFiles()['Catalogs/Клиенты.xml'], undefined);
    });
  });
}
