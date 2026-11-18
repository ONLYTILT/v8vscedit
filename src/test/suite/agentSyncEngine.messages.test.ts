import * as assert from 'assert';
import type { AgentOperationHooks } from '../../infra/agent/AgentOperationService';
import { createHarness, type HarnessKind, type SyncHarness } from './support/agentSyncHarness';
import { patternBytes } from './support/zipFixtures';

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

/**
 * Сообщения импорта архивом и посева зеркала (`hooks.onMessage`): пользователь видит этапы долгой
 * операции — скачивание и распаковку архива выгрузки, подготовку зеркала из выгрузки проекта. Причина
 * отказа посева (проверки не прошли) сообщается текстом самой проверки — он покрыт в сьюте посева.
 */
suite('AgentSyncEngine: сообщения импорта архивом и посева (sftp)', function () {
  this.timeout(60_000);
  let h: SyncHarness;

  setup(async () => {
    h = await createHarness('sftp');
    h.seedDb();
    h.emulator.setConfiguration('Основная', 'cf');
  });
  teardown(async () => { await h.dispose(); });

  function collecting(decision?: 'seed' | 'full' | 'cancel'): { messages: string[]; hooks: AgentOperationHooks } {
    const messages: string[] = [];
    return {
      messages,
      hooks: {
        onMessage: (message) => { messages.push(message); },
        ...(decision === undefined ? {} : { confirmMirrorSeed: () => Promise.resolve(decision) }),
      },
    };
  }

  test('первый импорт (самопосев из архива): скачивание, затем распаковка архива — в этом порядке', async () => {
    const { messages, hooks } = collecting();
    await h.importTarget(hooks);
    const download = messages.indexOf('Скачивание архива выгрузки…');
    const unpack = messages.indexOf('Распаковка архива выгрузки.');
    assert.ok(download >= 0, messages.join(' | '));
    assert.ok(unpack > download, messages.join(' | '));
    assert.ok(!messages.includes('Зеркало агента подготовлено из выгрузки проекта.'));
  });

  test('прогресс скачивания архива: по десяткам процентов, не на каждую порцию; последнее — 100%, между скачиванием и распаковкой', async () => {
    h.emulator.setObject('CommonPicture.Большой', {
      'CommonPictures/Большой.xml': '<CommonPicture>Большой</CommonPicture>',
      'CommonPictures/Большой/Ext/Picture/Picture.png': patternBytes(3_000_000, 5),
    });
    const { messages, hooks } = collecting();
    await h.importTarget(hooks);
    const progress = messages.filter((message) => message.startsWith('Скачано '));
    const percents = progress.map((message) => Number(/^Скачано (\d+)%/.exec(message)?.[1]));
    assert.ok(progress.length >= 2 && progress.length <= 10, progress.join(' | '));
    assert.deepStrictEqual([...percents].sort((a, b) => a - b), percents, 'проценты растут');
    assert.strictEqual(new Set(percents.map((p) => Math.floor(p / 10))).size, percents.length, 'не больше одного сообщения на десяток процентов');
    assert.strictEqual(percents.at(-1), 100);
    assert.match(progress.at(-1) ?? '', /МБ\)\.$/);
    const first = messages.indexOf(progress[0]);
    assert.ok(first > messages.indexOf('Скачивание архива выгрузки…') && first < messages.indexOf('Распаковка архива выгрузки.'));
  });

  test('прогресс без размера от сервера (FSTAT без size): сообщения по 16 МБ скачанного', async function () {
    this.timeout(120_000);
    assert.ok(h.sftp);
    h.sftp.fstatWithoutSize = true;
    h.emulator.setObject('CommonPicture.Огромный', {
      'CommonPictures/Огромный.xml': '<CommonPicture>Огромный</CommonPicture>',
      'CommonPictures/Огромный/Ext/Picture/Picture.png': patternBytes(17 * 1024 * 1024, 6),
    });
    const { messages, hooks } = collecting();
    await h.importTarget(hooks);
    const progress = messages.filter((message) => message.startsWith('Скачано '));
    assert.strictEqual(progress.length, 1, progress.join(' | '));
    assert.match(progress[0], /^Скачано 16\.\d МБ архива выгрузки\.$/);
  });

  test('посев из выгрузки проекта: сообщение о подготовленном зеркале; архива нет — сообщений о нём тоже', async () => {
    h.emulator.snapshotToProject(h.configRoot);
    h.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
    const { messages, hooks } = collecting('seed');
    await h.importTarget(hooks);
    assert.ok(messages.includes('Зеркало агента подготовлено из выгрузки проекта.'), messages.join(' | '));
    assert.ok(!messages.includes('Скачивание архива выгрузки…'));
  });

  test('хуки без onMessage: импорт с самопосевом и посев с согласием проходят с тем же исходом', async () => {
    const first = await h.engine.importTarget(h.target, h.exec, { cancellation: { isCancellationRequested: false } });
    assert.strictEqual(first.seededFrom, 'archive');

    const second = await createHarness('sftp');
    try {
      second.seedDb();
      second.emulator.setConfiguration('Основная', 'cf');
      second.emulator.snapshotToProject(second.configRoot);
      second.emulator.putFile('Catalogs/Клиенты.xml', '<Catalog>v2</Catalog>');
      const result = await second.engine.importTarget(second.target, second.exec, { confirmMirrorSeed: () => Promise.resolve('seed') });
      assert.strictEqual(result.seededFrom, 'project');
    } finally {
      await second.dispose();
    }
  });
});
