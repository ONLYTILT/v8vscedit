import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ConfigEntry } from '../../domain/Configuration';
import {
  buildHashSnapshot,
  buildScopeKey,
  loadHashCache,
  saveHashCache,
} from '../../infra/cache/HashCache';
import { scanHashSnapshot } from '../../infra/cache/HashScanner';
import { loadHashStatMemo, resolveHashStatMemoPath } from '../../infra/cache/HashStatMemo';
import { ConfigurationChangeDetector } from '../../infra/fs/ConfigurationChangeDetector';
import { buildMinimalConfigXml, countingFs, futureNow, writeRel, type CountingFs } from './support/hashScanFixtures';

/**
 * Детектор изменений поверх быстрой проверки: базовая линия (`.v8vscedit/cache`) — «что загружено
 * в БД», её детектор пишет ТОЛЬКО при первичной инициализации (бывший ensureCaches), а stat-мемо —
 * отдельный файл ускорения. Критерий «неизменённые не читаются» проверяется счётчиком над реальной ФС.
 */
suite('ConfigurationChangeDetector (быстрая проверка)', function () {
  this.timeout(30_000);
  let projectRoot: string;
  let cfRoot: string;
  let cf: ConfigEntry;
  let counting: CountingFs;
  let logLines: string[];

  const cfScope = (): string => buildScopeKey('cf', cfRoot);
  /** Путь базовой линии — как `HashCache.getCacheFilePath` (формат базовой линии не меняется). */
  const baselineFile = (scopeKey: string): string =>
    path.join(projectRoot, '.v8vscedit', 'cache', `${createHash('sha1').update(scopeKey).digest('hex')}.json`);

  function newDetector(): ConfigurationChangeDetector {
    return new ConfigurationChangeDetector(projectRoot, {
      scan: { fs: counting, now: futureNow },
      log: (line) => { logLines.push(line); },
    });
  }

  function seedCf(): void {
    writeRel(cfRoot, 'Configuration.xml', buildMinimalConfigXml('Бухгалтерия'));
    writeRel(cfRoot, 'Catalogs/Товары.xml', '<Catalog>Товары</Catalog>');
    writeRel(cfRoot, 'Catalogs/Товары/Ext/ObjectModule.bsl', 'Процедура А() КонецПроцедуры');
    writeRel(cfRoot, 'Documents/Заказ.xml', '<Document>Заказ</Document>');
  }
  const TRACKED_CF = 4;

  setup(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-change-detector-'));
    cfRoot = path.join(projectRoot, 'src', 'cf');
    cf = { rootPath: cfRoot, kind: 'cf' };
    counting = countingFs();
    logLines = [];
    seedCf();
  });
  teardown(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

  suite('первичная инициализация (бывший ensureCaches)', () => {
    test('базовой линии нет → detect возвращает [], базовая линия создана, в логе «Инициализация хеш-кэша»', async () => {
      const changed = await newDetector().detect([cf]);
      assert.deepStrictEqual(changed, []);
      const baseline = loadHashCache(projectRoot, cfScope());
      assert.deepStrictEqual(baseline.files, buildHashSnapshot(cfScope(), cfRoot).files);
      assert.ok(baseline.generatedAt);
      assert.ok(logLines.some((l) => l.includes('Инициализация хеш-кэша') && l.includes('Бухгалтерия')), logLines.join('\n'));
    });

    test('после инициализации правка обнаруживается', async () => {
      const detector = newDetector();
      await detector.detect([cf]);
      writeRel(cfRoot, 'Catalogs/Новый.xml', '<Catalog/>');
      const changed = await detector.detect([cf]);
      assert.strictEqual(changed.length, 1);
      assert.strictEqual(changed[0].changedFilesCount, 1);
    });

    test('битый JSON базовой линии → считается отсутствующей и инициализируется', async () => {
      const file = baselineFile(cfScope());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{ битый');
      const changed = await newDetector().detect([cf]);
      assert.deepStrictEqual(changed, []);
      assert.deepStrictEqual(loadHashCache(projectRoot, cfScope()).files, buildHashSnapshot(cfScope(), cfRoot).files);
    });

    test('базовая линия появилась во время прохода («записал CLI») → не перезаписывается', async () => {
      const cliSnapshot = { schemaVersion: 1 as const, scopeKey: cfScope(), generatedAt: '2026-01-01T00:00:00.000Z', files: { 'Catalogs/Товары.xml': 'от-CLI' } };
      let written = false;
      counting.beforeReaddir = () => {
        if (!written) {
          written = true;
          saveHashCache(projectRoot, cliSnapshot);
        }
      };
      const result = await newDetector().detect([cf]);
      assert.deepStrictEqual(result, [], 'проход, начатый без базовой линии, изменений не сообщает');
      assert.deepStrictEqual(loadHashCache(projectRoot, cfScope()), cliSnapshot);
      assert.ok(!logLines.some((l) => l.includes('Инициализация хеш-кэша')));
    });
  });

  suite('быстрая повторная проверка', () => {
    test('повторный detect на неизменённой выгрузке не читает содержимое файлов (критерий приёмки 1)', async () => {
      const detector = newDetector();
      await detector.detect([cf]);
      counting.reset();
      const changed = await detector.detect([cf]);
      assert.deepStrictEqual(changed, []);
      assert.strictEqual(counting.counts.readFile, 0);
      assert.strictEqual(counting.counts.stat, TRACKED_CF);
    });

    test('лог прохода: «[hash-cache] <имя>: …» с числом перехешированных', async () => {
      const detector = newDetector();
      await detector.detect([cf]);
      logLines.length = 0;
      await detector.detect([cf]);
      const line = logLines.find((l) => l.startsWith('[hash-cache] Бухгалтерия:'));
      assert.ok(line, logLines.join('\n'));
      assert.ok(line.includes(String(TRACKED_CF)), line);
    });

    test('изменение содержимого с тем же размером → 1 конфигурация, 1 файл', async () => {
      const rel = 'Catalogs/Товары.xml';
      const file = path.join(cfRoot, ...rel.split('/'));
      fs.utimesSync(file, 1_000_000_000, 1_000_000_000);
      const detector = newDetector();
      await detector.detect([cf]);
      const content = Buffer.from(fs.readFileSync(file));
      content[1] = content[1] === 0x43 ? 0x44 : 0x43;
      fs.writeFileSync(file, content);
      const changed = await detector.detect([cf]);
      assert.deepStrictEqual(changed, [{ kind: 'cf', rootPath: cfRoot, name: 'Бухгалтерия', changedFilesCount: 1 }]);
    });

    test('touch без изменения содержимого → изменений нет', async () => {
      const detector = newDetector();
      await detector.detect([cf]);
      fs.utimesSync(path.join(cfRoot, 'Documents', 'Заказ.xml'), 1_000_000_000, 1_000_000_000);
      counting.reset();
      assert.deepStrictEqual(await detector.detect([cf]), []);
      assert.strictEqual(counting.counts.readFile, 1);
    });

    test('удаление и добавление → changedFilesCount 2', async () => {
      const detector = newDetector();
      await detector.detect([cf]);
      fs.unlinkSync(path.join(cfRoot, 'Documents', 'Заказ.xml'));
      writeRel(cfRoot, 'Roles/Админ.xml', '<Role/>');
      const changed = await detector.detect([cf]);
      assert.strictEqual(changed.length, 1);
      assert.strictEqual(changed[0].changedFilesCount, 2);
    });
  });

  suite('миграция с кэша schemaVersion 1 (мемо ещё нет)', () => {
    test('нет ложных изменений; один раз перечитано всё; мемо записан; базовая линия байт-в-байт прежняя; далее — 0 чтений', async () => {
      saveHashCache(projectRoot, buildHashSnapshot(cfScope(), cfRoot));
      const file = baselineFile(cfScope());
      assert.ok(fs.existsSync(file), 'путь базовой линии в тесте совпадает с HashCache');
      const bytesBefore = fs.readFileSync(file);
      assert.ok(!fs.existsSync(resolveHashStatMemoPath(projectRoot, cfRoot)));

      const detector = newDetector();
      assert.deepStrictEqual(await detector.detect([cf]), []);
      assert.strictEqual(counting.counts.readFile, TRACKED_CF);
      assert.ok(fs.existsSync(resolveHashStatMemoPath(projectRoot, cfRoot)), 'записан новый файл мемо');
      assert.strictEqual(Object.keys((await loadHashStatMemo(projectRoot, cfRoot)).entries).length, TRACKED_CF);
      assert.deepStrictEqual(fs.readFileSync(file), bytesBefore, 'detect базовую линию не переписывает');

      counting.reset();
      assert.deepStrictEqual(await detector.detect([cf]), []);
      assert.strictEqual(counting.counts.readFile, 0);
    });

    test('изменения относительно старой базовой линии по-прежнему видны при миграции', async () => {
      saveHashCache(projectRoot, buildHashSnapshot(cfScope(), cfRoot));
      writeRel(cfRoot, 'Catalogs/Товары.xml', '<Catalog>правка</Catalog>');
      const changed = await newDetector().detect([cf]);
      assert.strictEqual(changed.length, 1);
      assert.strictEqual(changed[0].changedFilesCount, 1);
    });
  });

  suite('несколько конфигураций', () => {
    function seedCfe(name: string): ConfigEntry {
      const root = path.join(projectRoot, 'src', 'cfe', name);
      writeRel(root, 'Configuration.xml', buildMinimalConfigXml(name, true));
      writeRel(root, 'Catalogs/Расш_Товары.xml', `<Catalog>${name}</Catalog>`);
      const scopeKey = buildScopeKey('cfe', root, name);
      saveHashCache(projectRoot, { schemaVersion: 1, scopeKey, generatedAt: 'x', files: { 'нет.xml': 'x' } });
      return { rootPath: root, kind: 'cfe' };
    }

    test('cf и несколько cfe изменены → cf первым, расширения по имени', async () => {
      const extB = seedCfe('Бэта');
      const extA = seedCfe('Альфа');
      saveHashCache(projectRoot, { schemaVersion: 1, scopeKey: cfScope(), generatedAt: 'x', files: { 'нет.xml': 'x' } });
      const changed = await newDetector().detect([extB, cf, extA]);
      assert.deepStrictEqual(changed.map((c) => `${c.kind}:${c.name}`), ['cf:Бухгалтерия', 'cfe:Альфа', 'cfe:Бэта']);
      assert.strictEqual(changed[0].changedFilesCount, TRACKED_CF + 1, 'все файлы добавлены + один удалён');
    });

    test('одна конфигурация без изменений в выдачу не попадает', async () => {
      const ext = seedCfe('Альфа');
      saveHashCache(projectRoot, buildHashSnapshot(cfScope(), cfRoot));
      const changed = await newDetector().detect([cf, ext]);
      assert.deepStrictEqual(changed.map((c) => c.name), ['Альфа']);
    });

    test('пустой список конфигураций → []', async () => {
      assert.deepStrictEqual(await newDetector().detect([]), []);
    });
  });

  suite('прерывание прохода (signal)', () => {
    const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

    function seedCfe(name: string): ConfigEntry {
      const root = path.join(projectRoot, 'src', 'cfe', name);
      writeRel(root, 'Configuration.xml', buildMinimalConfigXml(name, true));
      writeRel(root, 'Catalogs/Расш_Товары.xml', `<Catalog>${name}</Catalog>`);
      return { rootPath: root, kind: 'cfe' };
    }

    test('D1 abort в первой конфигурации без базовой линии → отклонение; базовая линия не создана, мемо побайтно прежний', async () => {
      await scanHashSnapshot(projectRoot, '', cfRoot, { now: futureNow });
      const memoPath = resolveHashStatMemoPath(projectRoot, cfRoot);
      const memoBefore = fs.readFileSync(memoPath);
      writeRel(cfRoot, 'Catalogs/Товары.xml', '<Catalog>другое</Catalog>');
      const controller = new AbortController();
      let statCalls = 0;
      counting.beforeStat = () => {
        statCalls += 1;
        if (statCalls === 2) {
          controller.abort();
        }
      };

      await assert.rejects(newDetector().detect([cf], controller.signal), isAbort);

      assert.ok(!fs.existsSync(baselineFile(cfScope())), 'базовая линия не инициализирована прерванным проходом');
      assert.ok(memoBefore.equals(fs.readFileSync(memoPath)), 'частичный мемо не записан');
    });

    test('D1б abort после прохода, но до первичной записи базовой линии → отклонение, базовой линии нет', async () => {
      const controller = new AbortController();
      const detector = new ConfigurationChangeDetector(projectRoot, {
        scan: { fs: counting, now: futureNow },
        // Проход первой конфигурации уже отчитался, остался только шаг записи базовой линии.
        log: (line) => { if (line.startsWith('[hash-cache]')) { controller.abort(); } },
      });

      await assert.rejects(detector.detect([cf], controller.signal), isAbort);

      assert.ok(!fs.existsSync(baselineFile(cfScope())));
    });

    test('D2 abort между конфигурациями (после первой) → отклонение, вторая область не тронута и не инициализирована', async () => {
      const ext = seedCfe('Альфа');
      saveHashCache(projectRoot, buildHashSnapshot(cfScope(), cfRoot));
      const controller = new AbortController();
      const detector = new ConfigurationChangeDetector(projectRoot, {
        scan: { fs: counting, now: futureNow },
        log: (line) => { if (line.includes('Бухгалтерия')) { controller.abort(); } },
      });

      await assert.rejects(detector.detect([cf, ext], controller.signal), isAbort);

      assert.ok(!fs.existsSync(baselineFile(buildScopeKey('cfe', ext.rootPath, 'Альфа'))), 'вторая область не инициализирована');
      assert.ok(!counting.readPaths.some((file) => file.startsWith(ext.rootPath)), 'файлы второй области не читались');
    });

    test('D2б abort во время обхода второй конфигурации (readdir её корня) → отклонение, базовая линия второй не создана', async () => {
      const ext = seedCfe('Бэта');
      saveHashCache(projectRoot, buildHashSnapshot(cfScope(), cfRoot));
      const controller = new AbortController();
      counting.beforeReaddir = (dir) => { if (dir === ext.rootPath) { controller.abort(); } };

      await assert.rejects(newDetector().detect([cf, ext], controller.signal), isAbort);

      assert.ok(!fs.existsSync(baselineFile(buildScopeKey('cfe', ext.rootPath, 'Бэта'))));
    });

    test('D3 непрерванный сигнал: поведение как без сигнала (инициализация, затем видна правка)', async () => {
      const signal = new AbortController().signal;
      const detector = newDetector();

      assert.deepStrictEqual(await detector.detect([cf], signal), []);
      assert.ok(fs.existsSync(baselineFile(cfScope())), 'базовая линия создана');

      writeRel(cfRoot, 'Catalogs/Ещё.xml', '<Catalog/>');
      const changed = await detector.detect([cf], signal);
      assert.strictEqual(changed[0]?.changedFilesCount, 1);
    });
  });

  test('describe: вид, путь, имя из Configuration.xml и переданное число файлов', () => {
    assert.deepStrictEqual(newDetector().describe(cf, 7), {
      kind: 'cf',
      rootPath: cfRoot,
      name: 'Бухгалтерия',
      changedFilesCount: 7,
    });
  });

  test('детектор без опций (реальная ФС, без лога) работает', async () => {
    const detector = new ConfigurationChangeDetector(projectRoot);
    assert.deepStrictEqual(await detector.detect([cf]), []);
    writeRel(cfRoot, 'Catalogs/Ещё.xml', '<Catalog/>');
    const changed = await detector.detect([cf]);
    assert.strictEqual(changed[0]?.changedFilesCount, 1);
  });
});
