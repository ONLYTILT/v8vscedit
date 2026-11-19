import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildHashSnapshot, isSupportedConfigFile, isTemplateContentConfigFile } from '../../infra/cache/HashCache';
import { scanHashSnapshot } from '../../infra/cache/HashScanner';
import { EXAMPLE_GENERATIONS, skipWithoutCorpus } from './support/corpus';
import { countingFs, futureNow } from './support/hashScanFixtures';

/**
 * Быстрая проверка на реальной выгрузке (БП 3.0 из `example/2.20`). Полный корпус (≈100 тыс.
 * файлов, 7,5 ГБ) в тесте не хешируется — копируется ограниченная выборка в mkdtemp, в `example/`
 * ничего не пишется (CLAUDE.md, TDD п.4). Без корпуса сьют пропускается.
 */
suite('HashScanner на эталоне', function () {
  this.timeout(120_000);
  const SAMPLE_SIZE = 300;
  let tempRoot: string;
  let configDir: string;

  suiteSetup(function () {
    skipWithoutCorpus(this, path.join(EXAMPLE_GENERATIONS.cf20, 'Configuration.xml'));
  });

  setup(function () {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-hash-scanner-corpus-'));
    configDir = path.join(tempRoot, 'src', 'cf');
    copySample(EXAMPLE_GENERATIONS.cf20, configDir, SAMPLE_SIZE);
  });
  teardown(() => {
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('scanHashSnapshot == buildHashSnapshot на выборке; второй проход — 0 чтений; правка копии обнаруживается', async () => {
    const counting = countingFs();
    const first = await scanHashSnapshot(tempRoot, 'cf::corpus', configDir, { fs: counting, now: futureNow });
    const reference = buildHashSnapshot('cf::corpus', configDir).files;
    assert.deepStrictEqual(first.files, reference);
    assert.ok(Object.keys(first.files).length > 1);
    assert.ok('Configuration.xml' in first.files);

    counting.reset();
    const second = await scanHashSnapshot(tempRoot, 'cf::corpus', configDir, { fs: counting, now: futureNow });
    assert.strictEqual(counting.counts.readFile, 0);
    assert.deepStrictEqual(second.files, reference);

    const victim = Object.keys(reference).find((rel) => rel !== 'Configuration.xml') ?? 'Configuration.xml';
    fs.appendFileSync(path.join(configDir, ...victim.split('/')), '\n<!-- правка -->');
    counting.reset();
    const third = await scanHashSnapshot(tempRoot, 'cf::corpus', configDir, { fs: counting, now: futureNow });
    assert.strictEqual(counting.counts.readFile, 1);
    assert.notStrictEqual(third.files[victim], reference[victim]);
  });
});

/**
 * Копирует `Configuration.xml`, все файлы содержимого макетов из первых встреченных и первые
 * `limit` отслеживаемых файлов в детерминированном (отсортированном) порядке обхода.
 */
function copySample(sourceRoot: string, targetRoot: string, limit: number): void {
  const picked: string[] = ['Configuration.xml'];
  let templates = 0;
  const walk = (dir: string): void => {
    if (picked.length >= limit) {
      return;
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (picked.length >= limit) {
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(sourceRoot, full).replace(/\\/g, '/');
      if (rel === 'Configuration.xml' || !isSupportedConfigFile(rel)) {
        continue;
      }
      if (isTemplateContentConfigFile(rel)) {
        if (templates >= 5) {
          continue;
        }
        templates += 1;
      }
      picked.push(rel);
    }
  };
  walk(sourceRoot);
  for (const rel of picked) {
    const target = path.join(targetRoot, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, ...rel.split('/')), target);
  }
}
