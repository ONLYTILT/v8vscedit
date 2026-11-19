import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  HASH_STAT_MEMO_SCHEMA_VERSION,
  HASH_STAT_RACY_WINDOW_MS,
  emptyHashStatMemo,
  isRacyFingerprint,
  loadHashStatMemo,
  lookupMemoHash,
  normalizeMemoConfigDir,
  resolveHashStatMemoPath,
  saveHashStatMemo,
  type HashStatEntry,
  type HashStatMemo,
} from '../../infra/cache/HashStatMemo';

/**
 * Stat-мемо — отдельный от базовой линии файл фактов «отпечаток (mtime, ctime, size) → sha1».
 * Базовую линию (`.v8vscedit/cache`) он не трогает: её пишут только импорт/синхронизация, а мемо —
 * лишь ускорение, поэтому любой непригодный мемо равен пустому (полное перехеширование), а не ошибке.
 */
suite('HashStatMemo', () => {
  let projectRoot: string;
  let configDir: string;
  const sha1 = (value: string): string => createHash('sha1').update(value).digest('hex');

  setup(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-hash-stat-memo-'));
    configDir = path.join(projectRoot, 'src', 'cf');
  });
  teardown(() => { fs.rmSync(projectRoot, { recursive: true, force: true }); });

  suite('путь и нормализация', () => {
    test('normalizeMemoConfigDir: абсолютный путь, прямые слэши, нижний регистр (как buildScopeKey)', () => {
      const normalized = normalizeMemoConfigDir(configDir);
      assert.strictEqual(normalized, path.resolve(configDir).replace(/\\/g, '/').toLowerCase());
      assert.ok(!normalized.includes('\\'));
    });

    test('resolveHashStatMemoPath: <проект>/.v8vscedit/hash-stat/<sha1("stat::" + нормализованный configDir)>.json', () => {
      const expected = path.join(
        projectRoot,
        '.v8vscedit',
        'hash-stat',
        `${sha1('stat::' + normalizeMemoConfigDir(configDir))}.json`
      );
      assert.strictEqual(resolveHashStatMemoPath(projectRoot, configDir), expected);
    });

    test('регистр и вид разделителей configDir не меняют путь мемо', () => {
      const base = resolveHashStatMemoPath(projectRoot, configDir);
      assert.strictEqual(resolveHashStatMemoPath(projectRoot, configDir.toUpperCase()), base);
      assert.strictEqual(resolveHashStatMemoPath(projectRoot, configDir.replace(/\\/g, '/')), base);
    });

    test('разные каталоги выгрузки — разные файлы мемо', () => {
      assert.notStrictEqual(
        resolveHashStatMemoPath(projectRoot, configDir),
        resolveHashStatMemoPath(projectRoot, path.join(projectRoot, 'src', 'cfe', 'Расш'))
      );
    });

    test('emptyHashStatMemo: текущая схема, нормализованный каталог, нет записей', () => {
      assert.strictEqual(HASH_STAT_MEMO_SCHEMA_VERSION, 1);
      assert.deepStrictEqual(emptyHashStatMemo(configDir), {
        schemaVersion: 1,
        configDir: normalizeMemoConfigDir(configDir),
        entries: {},
      });
    });
  });

  suite('loadHashStatMemo', () => {
    function writeMemoFile(content: string): void {
      const file = resolveHashStatMemoPath(projectRoot, configDir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }

    test('файла нет → пустой мемо', async () => {
      assert.deepStrictEqual(await loadHashStatMemo(projectRoot, configDir), emptyHashStatMemo(configDir));
    });

    const broken: readonly (readonly [string, () => string])[] = [
      ['битый JSON', () => '{ не json'],
      ['null', () => 'null'],
      ['массив', () => '[]'],
      ['строка', () => '"x"'],
      ['чужая схема', () => JSON.stringify({ schemaVersion: 99, configDir: normalizeMemoConfigDir(configDir), entries: {} })],
      ['чужой configDir', () => JSON.stringify({ schemaVersion: 1, configDir: 'c:/другой', entries: {} })],
      ['entries не объект', () => JSON.stringify({ schemaVersion: 1, configDir: normalizeMemoConfigDir(configDir), entries: 'нет' })],
      ['entries — массив', () => JSON.stringify({ schemaVersion: 1, configDir: normalizeMemoConfigDir(configDir), entries: [] })],
      ['entries — null', () => JSON.stringify({ schemaVersion: 1, configDir: normalizeMemoConfigDir(configDir), entries: null })],
    ];
    for (const [label, content] of broken) {
      test(`непригодный файл (${label}) → пустой мемо, без исключения`, async () => {
        writeMemoFile(content());
        assert.deepStrictEqual(await loadHashStatMemo(projectRoot, configDir), emptyHashStatMemo(configDir));
      });
    }

    test('путь мемо занят каталогом (ошибка чтения не ENOENT) → пустой мемо', async () => {
      fs.mkdirSync(resolveHashStatMemoPath(projectRoot, configDir), { recursive: true });
      assert.deepStrictEqual(await loadHashStatMemo(projectRoot, configDir), emptyHashStatMemo(configDir));
    });

    test('валидный файл → записи загружены', async () => {
      const memo: HashStatMemo = {
        schemaVersion: 1,
        configDir: normalizeMemoConfigDir(configDir),
        entries: { 'Catalogs/Товары.xml': [1000, 1001, 12, 'abc'] },
      };
      writeMemoFile(JSON.stringify(memo));
      assert.deepStrictEqual(await loadHashStatMemo(projectRoot, configDir), memo);
    });
  });

  suite('saveHashStatMemo', () => {
    test('round-trip: сохранённое загружается тем же; каталоги создаются', async () => {
      const memo: HashStatMemo = {
        schemaVersion: 1,
        configDir: normalizeMemoConfigDir(configDir),
        entries: {
          'Catalogs/Товары.xml': [1000.5, 1001.25, 12, 'aa'],
          'CommonModules/Общий/Ext/Module.bsl': [2000, 2000, 0, 'bb'],
        },
      };
      assert.ok(!fs.existsSync(path.join(projectRoot, '.v8vscedit')));
      saveHashStatMemo(projectRoot, memo);
      assert.ok(fs.existsSync(resolveHashStatMemoPath(projectRoot, configDir)));
      assert.deepStrictEqual(await loadHashStatMemo(projectRoot, configDir), memo);
    });

    test('повторная запись подменяет файл целиком; временных файлов не остаётся (writeFileAtomic)', async () => {
      const first: HashStatMemo = { ...emptyHashStatMemo(configDir), entries: { 'a.xml': [1, 1, 1, 'one'] } };
      const second: HashStatMemo = { ...emptyHashStatMemo(configDir), entries: { 'b.xml': [2, 2, 2, 'two'] } };
      saveHashStatMemo(projectRoot, first);
      saveHashStatMemo(projectRoot, second);
      assert.deepStrictEqual(await loadHashStatMemo(projectRoot, configDir), second);
      const dir = path.dirname(resolveHashStatMemoPath(projectRoot, configDir));
      assert.deepStrictEqual(fs.readdirSync(dir), [path.basename(resolveHashStatMemoPath(projectRoot, configDir))]);
    });

    test('мемо не пишет в каталог базовой линии .v8vscedit/cache', () => {
      saveHashStatMemo(projectRoot, emptyHashStatMemo(configDir));
      assert.ok(!fs.existsSync(path.join(projectRoot, '.v8vscedit', 'cache')));
    });
  });

  suite('lookupMemoHash', () => {
    const fp = { mtimeMs: 1000, ctimeMs: 1500, size: 42 };
    const memoWith = (entry: unknown): HashStatMemo => ({
      ...emptyHashStatMemo('c:/x'),
      // any-free подмена: невалидная запись имитирует мемо, записанный другой версией/повреждённый.
      entries: { 'a.xml': entry as HashStatEntry },
    });

    test('отпечаток совпал полностью → сохранённый хеш', () => {
      assert.strictEqual(lookupMemoHash(memoWith([1000, 1500, 42, 'h']), 'a.xml', fp), 'h');
    });

    const mismatches: readonly (readonly [string, HashStatEntry])[] = [
      ['mtime', [999, 1500, 42, 'h']],
      ['ctime', [1000, 1499, 42, 'h']],
      ['size', [1000, 1500, 43, 'h']],
    ];
    for (const [field, entry] of mismatches) {
      test(`не совпал ${field} → undefined (файл будет перечитан)`, () => {
        assert.strictEqual(lookupMemoHash(memoWith(entry), 'a.xml', fp), undefined);
      });
    }

    test('записи для пути нет → undefined', () => {
      assert.strictEqual(lookupMemoHash(memoWith([1000, 1500, 42, 'h']), 'b.xml', fp), undefined);
    });

    test('ключ из прототипа Object (toString) не принимается за запись', () => {
      assert.strictEqual(lookupMemoHash(emptyHashStatMemo('c:/x'), 'toString', fp), undefined);
    });

    const invalid: readonly (readonly [string, unknown])[] = [
      ['не массив', { mtimeMs: 1000 }],
      ['null', null],
      ['длина 3', [1000, 1500, 42]],
      ['длина 5', [1000, 1500, 42, 'h', 'x']],
      ['mtime строкой', ['1000', 1500, 42, 'h']],
      ['ctime строкой', [1000, '1500', 42, 'h']],
      ['size строкой', [1000, 1500, '42', 'h']],
      ['sha1 числом', [1000, 1500, 42, 7]],
      ['пустой sha1', [1000, 1500, 42, '']],
    ];
    for (const [label, entry] of invalid) {
      test(`невалидная запись (${label}) → undefined`, () => {
        assert.strictEqual(lookupMemoHash(memoWith(entry), 'a.xml', fp), undefined);
      });
    }
  });

  suite('isRacyFingerprint', () => {
    const start = 1_000_000;

    test('окно по умолчанию — 3000 мс (покрывает FAT32 2 с и HFS+/ext3 1 с)', () => {
      assert.strictEqual(HASH_STAT_RACY_WINDOW_MS, 3000);
    });

    test('max(mtime, ctime) = start − window → не racy (граница включительно доверенная)', () => {
      const t = start - HASH_STAT_RACY_WINDOW_MS;
      assert.strictEqual(isRacyFingerprint({ mtimeMs: t, ctimeMs: t, size: 1 }, start), false);
    });

    test('max(mtime, ctime) = start − window + 1 → racy', () => {
      const t = start - HASH_STAT_RACY_WINDOW_MS + 1;
      assert.strictEqual(isRacyFingerprint({ mtimeMs: t, ctimeMs: t, size: 1 }, start), true);
    });

    test('решает более свежий из mtime/ctime: старый mtime, свежий ctime → racy', () => {
      assert.strictEqual(isRacyFingerprint({ mtimeMs: 0, ctimeMs: start, size: 1 }, start), true);
    });

    test('свежий mtime, старый ctime → racy', () => {
      assert.strictEqual(isRacyFingerprint({ mtimeMs: start - 1, ctimeMs: 0, size: 1 }, start), true);
    });

    test('время в будущем (расхождение часов SMB) → racy', () => {
      assert.strictEqual(isRacyFingerprint({ mtimeMs: start + 10_000, ctimeMs: start + 10_000, size: 1 }, start), true);
    });

    test('давно изменённый файл → не racy', () => {
      assert.strictEqual(isRacyFingerprint({ mtimeMs: 10, ctimeMs: 20, size: 1 }, start), false);
    });

    test('пользовательское окно учитывается', () => {
      const fp = { mtimeMs: start - 500, ctimeMs: start - 500, size: 1 };
      assert.strictEqual(isRacyFingerprint(fp, start, 100), false);
      assert.strictEqual(isRacyFingerprint(fp, start, 1000), true);
    });
  });
});
