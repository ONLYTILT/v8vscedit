import * as assert from 'assert';
import * as path from 'path';
import { importEsmModule, isModuleNotFoundError } from './support/importEsm';

/**
 * Тесты `scripts/patch-coverage/shards.mjs` — планировщик шардов
 * (`planShards`) и валидатор их отчётов (`verifyShardReports`). ЕЩЁ НЕ
 * СУЩЕСТВУЕТ на фазе «красный».
 *
 * `planShards` НЕ фиксирует конкретный алгоритм разбиения (какой файл в каком
 * шарде) — тесты проверяют ИНВАРИАНТЫ (полнота/непересекаемость/
 * детерминированность/нормализация), а не порядок конкретных файлов внутри
 * шарда, чтобы не навязывать разработчику одну конкретную реализацию
 * partition-алгоритма сверх того, что реально требуется по ТЗ.
 */

interface ShardStats {
  readonly tests: number;
  readonly passes: number;
  readonly failures: number;
}

interface ShardReport {
  readonly shardIndex: number;
  readonly shardTotal: number;
  readonly allFilesCount: number;
  readonly selectedFiles: string[];
  readonly stats: ShardStats;
}

interface ShardsModule {
  planShards(files: string[], total: number): string[][];
  verifyShardReports(
    reports: (ShardReport | undefined)[],
    expected: { shardTotal: number; allFiles: string[]; discoveredCount?: number }
  ): string[];
  selectGateTestFiles(files: string[], pattern: string | undefined): string[];
}

const MODULE_PATH = path.resolve(__dirname, '../../../scripts/patch-coverage/shards.mjs');

suite('shards.mjs — planShards/verifyShardReports (T-coverage-gate)', () => {
  let mod: ShardsModule | undefined;
  let loadError: unknown;

  suiteSetup(async () => {
    try {
      mod = await importEsmModule<ShardsModule>(MODULE_PATH);
    } catch (err) {
      if (!isModuleNotFoundError(err)) {
        throw err;
      }
      loadError = err;
    }
  });

  test('модуль scripts/patch-coverage/shards.mjs существует и экспортирует planShards/verifyShardReports', () => {
    assert.ok(mod, `shards.mjs ещё не реализован (ожидаемо на фазе «красный» TDD): ${String(loadError)}`);
  });

  function m(): ShardsModule {
    if (!mod) {
      assert.fail('shards.mjs не реализован — см. первый тест');
    }
    return mod;
  }

  function fileList(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `file${String(i).padStart(4, '0')}.test.js`);
  }

  // ---- planShards: матрица total ∈ {1,2,4,6,8} × files.length ∈ {0,1,7,153} ----

  const TOTALS = [1, 2, 4, 6, 8];
  const FILE_COUNTS = [0, 1, 7, 153];

  for (const total of TOTALS) {
    for (const n of FILE_COUNTS) {
      test(`planShards(files.length=${String(n)}, total=${String(total)}) — полнота/непересекаемость/детерминированность/нормализация`, () => {
        const files = fileList(n);
        const shards = m().planShards(files, total);

        // Нормализация: при files.length===0 шардов быть не должно (иначе
        // пустой шард дал бы tests===0 — гарантированный ложный «нет тестов»);
        // иначе шардов ровно min(total, files.length) — total>files.length
        // не должен порождать пустые «хвостовые» шарды.
        const expectedShardCount = n === 0 ? 0 : Math.min(total, n);
        assert.strictEqual(shards.length, expectedShardCount, 'количество шардов обязано быть нормализовано к min(total, files.length)');

        // Полнота + сохранение порядка: конкатенация шардов = исходный список.
        assert.deepStrictEqual(shards.flat(), files, 'объединение шардов обязано точно воспроизводить исходный список файлов');

        // Непересекаемость: ни один файл не должен встретиться в двух шардах.
        const flatSet = new Set(shards.flat());
        assert.strictEqual(flatSet.size, files.length, 'шарды не должны пересекаться (дублировать файлы)');

        // Ни один шард не пуст (при files.length>0) — пустой шард недопустим
        // структурно, а не только по внешнему отчёту verifyShardReports.
        for (const shard of shards) {
          assert.ok(shard.length > 0, 'ни один спланированный шард не должен быть пустым при непустом списке файлов');
        }

        // Детерминированность: повторный вызов с теми же аргументами даёт
        // идентичный результат (гейт покрытия не должен зависеть от порядка
        // выполнения или скрытого состояния).
        const again = m().planShards(files, total);
        assert.deepStrictEqual(again, shards, 'planShards обязан быть детерминированным при одинаковых аргументах');
      });
    }
  }

  // ---- verifyShardReports: позитив + семь негативов ----------------------

  const ALL_FILES = ['a.test.js', 'b.test.js', 'c.test.js'];
  const EXPECTED = { shardTotal: 2, allFiles: ALL_FILES };

  function positiveReports(): ShardReport[] {
    return [
      { shardIndex: 0, shardTotal: 2, allFilesCount: 3, selectedFiles: ['a.test.js', 'b.test.js'], stats: { tests: 10, passes: 10, failures: 0 } },
      { shardIndex: 1, shardTotal: 2, allFilesCount: 3, selectedFiles: ['c.test.js'], stats: { tests: 5, passes: 5, failures: 0 } },
    ];
  }

  test('verifyShardReports: позитивный сценарий — согласованные отчёты обоих шардов → нет проблем', () => {
    const problems = m().verifyShardReports(positiveReports(), EXPECTED);
    assert.deepStrictEqual(problems, []);
  });

  test('НЕГАТИВ 1/7: нет отчёта шарда (report undefined)', () => {
    const reports: (ShardReport | undefined)[] = positiveReports();
    reports[1] = undefined;
    const problems = m().verifyShardReports(reports, EXPECTED);
    assert.ok(problems.some((p) => p.includes('отчёт') || p.toLowerCase().includes('report')), `не найдена проблема «нет отчёта»: ${JSON.stringify(problems)}`);
  });

  test('НЕГАТИВ 2/7: failures > 0 в одном из шардов', () => {
    const reports = positiveReports();
    reports[0] = { ...reports[0], stats: { tests: 10, passes: 9, failures: 1 } };
    const problems = m().verifyShardReports(reports, EXPECTED);
    assert.ok(problems.some((p) => p.includes('провал') || p.toLowerCase().includes('fail')), `не найдена проблема «есть провалы»: ${JSON.stringify(problems)}`);
  });

  test('НЕГАТИВ 3/7: tests === 0 в одном из шардов (пустой шард по факту прогона)', () => {
    const reports = positiveReports();
    reports[1] = { ...reports[1], stats: { tests: 0, passes: 0, failures: 0 } };
    const problems = m().verifyShardReports(reports, EXPECTED);
    assert.ok(problems.some((p) => p.includes('0 тест') || p.toLowerCase().includes('пуст')), `не найдена проблема «0 тестов»: ${JSON.stringify(problems)}`);
  });

  test('НЕГАТИВ 4/7: расхождение allFilesCount между шардами', () => {
    const reports = positiveReports();
    reports[1] = { ...reports[1], allFilesCount: 4 };
    const problems = m().verifyShardReports(reports, EXPECTED);
    assert.ok(
      problems.some((p) => p.toLowerCase().includes('allfilescount') || p.includes('расхожден') || p.includes('количеств')),
      `не найдена проблема «расхождение allFilesCount»: ${JSON.stringify(problems)}`
    );
  });

  test('НЕГАТИВ 5/7: объединение selectedFiles НЕ равно полному набору (файл потерян)', () => {
    const reports = positiveReports();
    reports[1] = { ...reports[1], selectedFiles: [] };
    const problems = m().verifyShardReports(reports, EXPECTED);
    assert.ok(
      problems.some((p) => p.includes('полн') || p.includes('отсутств') || p.includes('потер')),
      `не найдена проблема «объединение не равно полному набору»: ${JSON.stringify(problems)}`
    );
  });

  test('НЕГАТИВ 6/7: объединение selectedFiles содержит дубли (файл в двух шардах одновременно)', () => {
    const reports = positiveReports();
    reports[1] = { ...reports[1], selectedFiles: ['b.test.js', 'c.test.js'] };
    const problems = m().verifyShardReports(reports, EXPECTED);
    assert.ok(problems.some((p) => p.includes('дубл')), `не найдена проблема «дубли»: ${JSON.stringify(problems)}`);
  });

  test('НЕГАТИВ 7/7: shardTotal в отчёте не совпал с запрошенным', () => {
    const reports = positiveReports();
    reports[0] = { ...reports[0], shardTotal: 3 };
    const problems = m().verifyShardReports(reports, EXPECTED);
    assert.ok(
      problems.some((p) => p.toLowerCase().includes('shardtotal') || p.includes('запрошенн')),
      `не найдена проблема «shardTotal не совпал»: ${JSON.stringify(problems)}`
    );
  });

  // ---- COVERAGE_TESTS: отбор тестов задачи ------------------------------

  const DISCOVERED = ['agentSync.test.js', 'nested\\repo.test.js', 'nested/form.test.js', 'other.test.js'];

  for (const empty of [undefined, '']) {
    test(`selectGateTestFiles: шаблон ${JSON.stringify(empty)} — весь набор без изменений (прежнее поведение)`, () => {
      assert.deepStrictEqual(m().selectGateTestFiles(DISCOVERED, empty), DISCOVERED);
    });
  }

  test('selectGateTestFiles: отбирает по регулярному выражению пути, порядок сохраняется', () => {
    assert.deepStrictEqual(m().selectGateTestFiles(DISCOVERED, 'agent|form'), ['agentSync.test.js', 'nested/form.test.js']);
  });

  test('selectGateTestFiles: разделитель пути нормализуется — шаблон с / находит путь с обратным слэшем', () => {
    assert.deepStrictEqual(m().selectGateTestFiles(DISCOVERED, '^nested/repo'), ['nested\\repo.test.js']);
  });

  test('selectGateTestFiles: некорректное регулярное выражение — исключение с шаблоном в тексте', () => {
    assert.throws(() => m().selectGateTestFiles(DISCOVERED, '(unclosed'), /COVERAGE_TESTS.*\(unclosed/);
  });

  test('selectGateTestFiles: шаблон без совпадений — исключение (ноль тестов дал бы вердикт без данных)', () => {
    assert.throws(() => m().selectGateTestFiles(DISCOVERED, 'нетТакого'), /не выбрал ни одного.*из 4/);
  });

  test('verifyShardReports: при отборе allFilesCount сверяется с discoveredCount, полнота — с отобранными', () => {
    const reports: ShardReport[] = [
      { shardIndex: 0, shardTotal: 1, allFilesCount: 10, selectedFiles: ['a.test.js', 'c.test.js'], stats: { tests: 3, passes: 3, failures: 0 } },
    ];
    const expected = { shardTotal: 1, allFiles: ['a.test.js', 'c.test.js'], discoveredCount: 10 };
    assert.deepStrictEqual(m().verifyShardReports(reports, expected), []);
    const mismatch = m().verifyShardReports(reports, { ...expected, discoveredCount: 11 });
    assert.ok(mismatch.some((p) => p.includes('allFilesCount=10') && p.includes('11')), JSON.stringify(mismatch));
    const lost = m().verifyShardReports(reports, { ...expected, allFiles: ['a.test.js', 'b.test.js', 'c.test.js'] });
    assert.ok(lost.some((p) => p.includes('b.test.js')), JSON.stringify(lost));
  });
});
