import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentSyncCancelledError } from '../../infra/agent/sync/AgentSyncEngine';
import {
  buildSyncManifestFiles,
  loadSyncManifest,
  resolveSyncManifestPath,
  saveSyncManifest,
} from '../../infra/agent/sync/SyncManifest';
import { buildHashSnapshot, buildScopeKey, saveHashCache } from '../../infra/cache/HashCache';
import { ScriptedFactory } from './support/agentInfoBaseFakes';
import { mirrorDirOf, newService } from './support/agentWorkspaceFixtures';

/**
 * Э7: AgentOperationService делегирует в AgentSyncEngine (локальное хранилище). Проверяется
 * проводка: манифест B сохраняется по пути плана, миграция B из HashCache, приоритет манифеста,
 * отмена через hooks.cancellation, отсутствие `--get-changes`/`--archive` в локальном режиме.
 * Сообщения прежних тестов (rename/удаление/нет кэша) остаются в agentOperationService.test.ts.
 */
suite('AgentOperationService → AgentSyncEngine (Э7)', () => {
  let tempRoot: string;
  let configRoot: string;
  const cf = () => ({ kind: 'cf' as const, name: 'Основная', rootPath: configRoot });
  const scope = (): string => buildScopeKey('cf', configRoot);

  setup(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agent-sync-svc-'));
    configRoot = path.join(tempRoot, 'src', 'cf');
    fs.mkdirSync(path.join(configRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'Configuration.xml'), '<MetaDataObject/>', 'utf-8');
    fs.writeFileSync(path.join(configRoot, 'Catalogs', 'Товары.xml'), '<Catalog>Товары</Catalog>', 'utf-8');
  });
  teardown(() => { fs.rmSync(tempRoot, { recursive: true, force: true }); });

  test('после полной загрузки манифест лежит в .v8vscedit/agent-sync/<sha1(scope)>.json и равен hash(P)', async () => {
    await newService(tempRoot, new ScriptedFactory()).loadFullAndUpdate(cf());
    const file = resolveSyncManifestPath(tempRoot, scope());
    assert.ok(file.includes(path.join('.v8vscedit', 'agent-sync')));
    assert.ok(fs.existsSync(file));
    assert.deepStrictEqual(loadSyncManifest(tempRoot, scope()).files, await buildSyncManifestFiles(configRoot));
  });

  test('после частичной загрузки B подтянут к новому P; следующая загрузка без правок — skipped', async () => {
    const service = newService(tempRoot, new ScriptedFactory());
    await service.loadFullAndUpdate(cf());
    fs.writeFileSync(path.join(configRoot, 'Catalogs', 'Товары.xml'), '<Catalog>v2</Catalog>', 'utf-8');
    await service.loadChanged(cf(), { updateDatabase: true });
    assert.deepStrictEqual(loadSyncManifest(tempRoot, scope()).files, await buildSyncManifestFiles(configRoot));
    const again = await service.loadChanged(cf(), { updateDatabase: true });
    assert.strictEqual(again.skipped, true);
  });

  test('после импорта манифест = hash(P) и HashCache обновлён (CLI и дерево читают его)', async () => {
    const dump = new ScriptedFactory((command) => {
      if (command.startsWith('config dump-config-to-files')) {
        const mirror = mirrorDirOf(tempRoot);
        fs.mkdirSync(path.join(mirror, 'Catalogs'), { recursive: true });
        fs.writeFileSync(path.join(mirror, 'Configuration.xml'), '<MetaDataObject/>');
        fs.writeFileSync(path.join(mirror, 'Catalogs', 'Новый.xml'), '<new/>');
      }
      return undefined;
    });
    await newService(tempRoot, dump).importFromDatabase(cf());
    assert.ok('Catalogs/Новый.xml' in loadSyncManifest(tempRoot, scope()).files);
    assert.deepStrictEqual(loadSyncManifest(tempRoot, scope()).files, await buildSyncManifestFiles(configRoot));
  });

  test('манифеста нет, есть только HashCache (обновление с прежней версии) → B берётся из него: правка даёт частичную, а не полную загрузку', async () => {
    saveHashCache(tempRoot, buildHashSnapshot(scope(), configRoot));
    fs.writeFileSync(path.join(configRoot, 'Catalogs', 'Товары.xml'), '<Catalog>v2</Catalog>', 'utf-8');
    const factory = new ScriptedFactory();
    await newService(tempRoot, factory).loadChanged(cf(), { updateDatabase: true });
    const load = factory.log.find((c) => c.startsWith('config load-config-from-files')) ?? '';
    assert.ok(load.includes('--partial'), load);
  });

  test('манифест приоритетнее HashCache: HashCache устарел, манифест = текущий P → изменений нет', async () => {
    saveHashCache(tempRoot, { ...buildHashSnapshot(scope(), configRoot), files: { 'Catalogs/Товары.xml': 'устарело' } });
    saveSyncManifest(tempRoot, {
      schemaVersion: 1,
      scopeKey: scope(),
      mirrorState: 'fresh',
      files: await buildSyncManifestFiles(configRoot),
    });
    const factory = new ScriptedFactory();
    const result = await newService(tempRoot, factory).loadChanged(cf(), { updateDatabase: true });
    assert.strictEqual(result.skipped, true);
    assert.ok(!factory.log.some((c) => c.startsWith('config load-config-from-files')));
  });

  test('hooks.cancellation: заранее отменённая операция → AgentSyncCancelledError, команд конфигурации нет, база отпускается как при ошибке', async () => {
    const factory = new ScriptedFactory();
    const service = newService(tempRoot, factory);
    await assert.rejects(
      service.loadFullAndUpdate(cf(), { cancellation: { isCancellationRequested: true } }),
      AgentSyncCancelledError
    );
    assert.ok(!factory.log.some((c) => c.startsWith('config ')), factory.log.join(' | '));
    assert.ok(!fs.existsSync(mirrorDirOf(tempRoot)) || fs.readdirSync(mirrorDirOf(tempRoot)).length === 0);
  });

  test('локальный режим: в командах нет --get-changes и --archive (импорт, загрузки)', async () => {
    const factory = new ScriptedFactory((command) => {
      if (command.startsWith('config dump-config-to-files')) {
        const mirror = mirrorDirOf(tempRoot);
        fs.mkdirSync(mirror, { recursive: true });
        fs.writeFileSync(path.join(mirror, 'Configuration.xml'), '<MetaDataObject/>');
        fs.writeFileSync(path.join(mirror, 'ConfigDumpInfo.xml'), '<dump/>');
      }
      return undefined;
    });
    const service = newService(tempRoot, factory);
    await service.importFromDatabase(cf());
    await service.importFromDatabase(cf());
    // Импорт привёл P к «базе» без справочников: опустевший Catalogs/ убран вместе с Товары.xml.
    fs.mkdirSync(path.join(configRoot, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'Catalogs', 'Товары.xml'), '<Catalog>v2</Catalog>', 'utf-8');
    await service.loadChanged(cf(), { updateDatabase: true });
    await service.loadFullAndUpdate(cf());
    for (const command of factory.log) {
      assert.ok(!command.includes('--get-changes') && !command.includes('--archive'), command);
    }
  });
});
