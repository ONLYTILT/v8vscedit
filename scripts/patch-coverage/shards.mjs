// Планирование шардов прогона и проверка их отчётов.
//
// Зачем дробление: замерено на сыром NODE_V8_COVERAGE (поле
// functions[].isBlockCoverage) — долгоживущий процесс тестов теряет поблочную
// детализацию ЦЕЛИКОМ (полный прогон: 615 скриптов, 0 блочных; короткий: 1224
// скрипта, 1219 блочных). Прогон, разбитый на несколько свежих процессов,
// удерживает долю блочного покрытия на 0.994–0.995 в каждой порции.
//
// Цена дробления — новый класс ошибки: «часть тестов молча не прогналась».
// Поэтому каждый шард обязан отчитаться, а verifyShardReports сверяет отчёты
// между собой и с ожидаемым полным набором файлов.

/**
 * Разбиение списка тестовых файлов на непересекающиеся непрерывные порции.
 *
 * Порядок файлов сохраняется, конкатенация порций точно воспроизводит вход,
 * пустых порций не бывает: пустой шард дал бы прогон с нулём тестов, то есть
 * гарантированное ложное «тесты не найдены» на ровном месте.
 */
export function planShards(files, total) {
  if (files.length === 0) {
    return [];
  }
  const count = Math.min(Math.max(total, 1), files.length);
  const base = Math.floor(files.length / count);
  const remainder = files.length % count;
  const shards = [];
  let offset = 0;
  for (let i = 0; i < count; i += 1) {
    const size = base + (i < remainder ? 1 : 0);
    shards.push(files.slice(offset, offset + size));
    offset += size;
  }
  return shards;
}

/**
 * Отбор тестовых файлов гейта по регулярному выражению пути (`COVERAGE_TESTS`).
 *
 * Полный прогон — ~30 минут, а задаче нужны тесты её модулей: гейт остаётся строгим
 * (100% на изменённых файлах, дробление на свежие процессы), но покрытие засчитывается
 * только от отобранных тестов — это и требование к задаче («её тесты покрывают её код»).
 * Пустой шаблон — весь набор (прежнее поведение). Ошибочный шаблон и пустой отбор —
 * исключение: молча прогнать ноль тестов значило бы получить вердикт без данных.
 */
export function selectGateTestFiles(files, pattern) {
  if (pattern === undefined || pattern === '') {
    return files;
  }
  let matcher;
  try {
    matcher = new RegExp(pattern);
  } catch (error) {
    throw new Error(`COVERAGE_TESTS: некорректное регулярное выражение «${pattern}»: ${error.message}`, { cause: error });
  }
  // Разделитель пути нормализуется: шаблон пишется одинаково на Windows и POSIX.
  const selected = files.filter((file) => matcher.test(file.replace(/\\/g, '/')));
  if (selected.length === 0) {
    throw new Error(`COVERAGE_TESTS: шаблон «${pattern}» не выбрал ни одного тестового файла из ${files.length}`);
  }
  return selected;
}

/**
 * Семь видов рассогласования отчётов шардов. Возвращает список проблем
 * (пустой — всё согласовано); любая проблема обязана останавливать гейт ДО
 * сборки отчёта c8, иначе частичный lcov выглядит валидным.
 */
export function verifyShardReports(reports, expected) {
  const problems = [];
  const seen = new Map();
  const duplicates = new Set();

  for (let i = 0; i < reports.length; i += 1) {
    const report = reports[i];
    if (report === undefined) {
      problems.push(`Шард ${i}: нет отчёта о прогоне (процесс не записал файл отчёта)`);
      continue;
    }
    if (report.shardTotal !== expected.shardTotal) {
      problems.push(`Шард ${i}: shardTotal=${report.shardTotal} не совпал с запрошенным ${expected.shardTotal}`);
    }
    // allFilesCount — сколько файлов раннер НАШЁЛ (весь набор), а allFiles — сколько гейт ВЫБРАЛ;
    // при отборе COVERAGE_TESTS это разные числа, без отбора — одно (discoveredCount не задан).
    const discovered = expected.discoveredCount ?? expected.allFiles.length;
    if (report.allFilesCount !== discovered) {
      problems.push(
        `Шард ${i}: расхождение allFilesCount=${report.allFilesCount} с ожидаемым количеством файлов ${discovered}`
      );
    }
    if (report.stats.failures > 0) {
      problems.push(`Шард ${i}: провалов тестов ${report.stats.failures}`);
    }
    if (report.stats.tests === 0) {
      problems.push(`Шард ${i}: прогнано 0 тестов (пустой шард)`);
    }
    for (const file of report.selectedFiles) {
      if (seen.has(file)) {
        duplicates.add(file);
      }
      seen.set(file, i);
    }
  }

  for (const file of duplicates) {
    problems.push(`Файл ${file} попал в несколько шардов (дубль) — покрытие и счёт тестов искажены`);
  }
  const missing = expected.allFiles.filter((file) => !seen.has(file));
  if (missing.length > 0) {
    problems.push(`Объединение шардов неполно: отсутствуют файлы ${missing.join(', ')}`);
  }
  return problems;
}
