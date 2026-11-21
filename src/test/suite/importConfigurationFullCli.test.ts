/**
 * Вектор Конфигуратора у `import-configuration -Mode Full` — запасной путь «загрузки без обновления БД» в
 * batch-режиме (`buildBatchLoadSteps(...).fallback` при `updateDatabase=false`).
 *
 * Платформа молча принимает неизвестные ключи, поэтому корректность вектора доказывается только точным argv
 * заглушки `1cv8` (POSIX-заглушка и настоящий собранный CLI — как в `cfeBatchCliRun.test.ts`; на Windows
 * POSIX-шебанг не исполняется, сьют пропускается). Инвариант: `/LoadConfigFromFiles` есть, `/UpdateDBCfg` НЕТ
 * (применение — отдельный шаг); `sync-configuration-full` для контраста делает и то и другое.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  IS_WINDOWS,
  connectionCliArgs,
  createBatchWorkspace,
  expectedConnectionPrefix,
  readInvocations,
  runCli,
  type BatchWorkspace,
} from './support/cfeBatchFixtures';

suite('CLI import-configuration -Mode Full: загрузка без /UpdateDBCfg', function () {
  this.timeout(120_000);
  let ws: BatchWorkspace;

  suiteSetup(function () {
    if (IS_WINDOWS) {
      this.skip();
    }
  });
  setup(() => { ws = createBatchWorkspace(); });
  teardown(() => { ws.dispose(); });

  function makeConfigDir(...segments: string[]): string {
    const dir = path.join(ws.root, 'src', ...segments);
    fs.mkdirSync(path.join(dir, 'Catalogs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Configuration.xml'), '<MetaDataObject/>', 'utf-8');
    fs.writeFileSync(path.join(dir, 'Catalogs', 'Товары.xml'), '<Catalog/>', 'utf-8');
    return dir;
  }

  test('cf: ровно один запуск, вектор — подключение, /LoadConfigFromFiles <каталог>, -Format Hierarchical; без /UpdateDBCfg, -partial и -Extension', async () => {
    const configDir = makeConfigDir('cf');

    const result = await runCli(['import-configuration', '-ProjectRoot', ws.root, '-Target', 'cf', '-ConfigDir', configDir, '-Mode', 'Full', ...connectionCliArgs(ws)]);

    assert.strictEqual(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    const invocations = readInvocations(ws);
    assert.strictEqual(invocations.length, 1, 'один запуск Конфигуратора: загрузка');
    const [argv] = invocations;
    assert.deepStrictEqual(argv.slice(0, expectedConnectionPrefix(ws).length), expectedConnectionPrefix(ws));
    assert.ok(argv.includes('/LoadConfigFromFiles'), argv.join(' '));
    assert.strictEqual(argv[argv.indexOf('/LoadConfigFromFiles') + 1], configDir);
    assert.ok(!argv.includes('/UpdateDBCfg'), 'применение в базе не выполняется');
    assert.ok(!argv.includes('-partial') && !argv.includes('-Extension'), argv.join(' '));
    assert.strictEqual(argv[argv.indexOf('-Format') + 1], 'Hierarchical');
  });

  test('cfe: -Extension <имя> в векторе, /UpdateDBCfg по-прежнему нет', async () => {
    const configDir = makeConfigDir('cfe', 'Расш');

    const result = await runCli(['import-configuration', '-ProjectRoot', ws.root, '-Target', 'cfe', '-ConfigDir', configDir, '-Extension', 'Расш', '-Mode', 'Full', ...connectionCliArgs(ws)]);

    assert.strictEqual(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    const invocations = readInvocations(ws);
    assert.strictEqual(invocations.length, 1);
    const [argv] = invocations;
    assert.ok(argv.includes('/LoadConfigFromFiles'));
    assert.strictEqual(argv[argv.indexOf('-Extension') + 1], 'Расш');
    assert.ok(!argv.includes('/UpdateDBCfg'));
  });

  test('контраст: sync-configuration-full — те же аргументы, но ДВА запуска: загрузка и /UpdateDBCfg', async () => {
    const configDir = makeConfigDir('cf');

    const result = await runCli(['sync-configuration-full', '-ProjectRoot', ws.root, '-Target', 'cf', '-ConfigDir', configDir, ...connectionCliArgs(ws)]);

    assert.strictEqual(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    const invocations = readInvocations(ws);
    assert.strictEqual(invocations.length, 2);
    assert.ok(invocations[0].includes('/LoadConfigFromFiles'));
    assert.ok(invocations[1].includes('/UpdateDBCfg'));
  });

  test('сбой загрузки платформой (код ≠ 0): CLI возвращает ненулевой код, /UpdateDBCfg не запускается', async () => {
    const configDir = path.join(ws.root, 'src', 'нет-такого');

    const result = await runCli(['import-configuration', '-ProjectRoot', ws.root, '-Target', 'cf', '-ConfigDir', configDir, '-Mode', 'Full', ...connectionCliArgs(ws)]);

    assert.notStrictEqual(result.exitCode, 0, 'каталога нет — загрузка не начинается');
    assert.strictEqual(readInvocations(ws).length, 0, 'платформа не запускалась');
  });
});
