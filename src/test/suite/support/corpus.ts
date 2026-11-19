import * as fs from 'fs';
import * as path from 'path';

/**
 * ЕДИНСТВЕННЫЙ источник правды о наличии эталонного корпуса `example/`.
 *
 * Почему корпуса может не быть: `example/` — локальные выгрузки реальных
 * конфигураций 1С, они не отслеживаются git (см. `.gitignore` и CLAUDE.md),
 * поэтому на чистом клоне каталога просто НЕТ.
 *
 * Почему пропуск, а не падение: «корпуса нет» — свойство машины, а не дефект
 * кода. Красный прогон в этом случае неотличим от настоящего регресса и делает
 * `npm test` бесполезным для любого, кто клонировал репозиторий. Ослаблением
 * ассертов пропуск не является: когда корпус есть, все проверки его полноты
 * (`files.length > 1000` и т.п.) работают в полную силу.
 *
 * Почему один helper: знание «корпус на месте» размножилось было по трём
 * копиям (`formFixtures`, `typedFieldCorpus`, локальный `requireExampleCorpus`),
 * и часть сьютов гейта не получила вовсе. Параллельных реализаций одного знания
 * быть не должно (CLAUDE.md, запрет №2), поэтому все прежние helper'ы теперь
 * тонкие обёртки над этим модулем.
 */

// Компилированный `out/test/suite/support/corpus.js` лежит на 4 уровня глубже
// корня проекта (support→suite→test→out→корень). Ошибка в числе `../` уже
// случалась: лишний уровень уводил на СУЩЕСТВУЮЩИЙ чужой `example/` рядом с
// проектом, и корпус тихо становился пустым (см. историю typedFieldCorpus.ts).
export const EXAMPLE_ROOT = path.resolve(__dirname, '../../../../example');

/** Корни поколений формата внутри корпуса — обе генерации, cf и cfe. */
export const EXAMPLE_GENERATIONS = {
  cf20: path.join(EXAMPLE_ROOT, '2.20/src/cf'),
  cf21: path.join(EXAMPLE_ROOT, '2.21/src/cf'),
  cfe21: path.join(EXAMPLE_ROOT, '2.21/src/cfe/EVOLC'),
} as const;

/**
 * Маркеры ЭТАЛОННОГО корпуса: корни всех трёх поколений и по файлу-образцу в
 * каждом, на которые опираются корпусные тесты (golden-сверки, пины замеров).
 *
 * Почему мало корня `example/`: каталог может существовать, но содержать НЕ
 * эталон — неполный (только одно поколение) или вовсе выгрузку другой
 * конфигурации под тем же именем `2.20`. Тесты корпуса пиннят точные числа и
 * конкретные объекты эталона, поэтому на чужом корпусе они падают ENOENT и
 * расхождением замеров — то есть сообщают о свойстве машины, а не о дефекте кода.
 * Отсутствие любого маркера трактуется как «корпуса нет»; на полном эталоне все
 * проверки работают в прежнюю силу.
 */
export const REFERENCE_CORPUS_MARKERS: readonly string[] = [
  path.join(EXAMPLE_GENERATIONS.cf20, 'Configuration.xml'),
  path.join(EXAMPLE_GENERATIONS.cf20, 'Catalogs', 'Регионы.xml'),
  path.join(EXAMPLE_GENERATIONS.cf20, 'ExchangePlans', 'Мобильные.xml'),
  path.join(EXAMPLE_GENERATIONS.cf21, 'Configuration.xml'),
  path.join(EXAMPLE_GENERATIONS.cf21, 'HTTPServices', 'ServiceEntry.xml'),
  path.join(EXAMPLE_GENERATIONS.cf21, 'Catalogs', 'ПричиныВозврата.xml'),
  path.join(EXAMPLE_GENERATIONS.cfe21, 'Configuration.xml'),
];

// Наличие эталона не меняется за время прогона — проверяем один раз.
let referenceCorpusPresent: boolean | undefined;

function isReferenceCorpusPresent(): boolean {
  if (referenceCorpusPresent === undefined) {
    const missing = REFERENCE_CORPUS_MARKERS.filter((marker) => !fs.existsSync(marker));
    referenceCorpusPresent = missing.length === 0;
    // Каталог есть, а эталона нет — пропуск корпусных гейтов (порядок свойств, формат, golden) иначе
    // виден лишь как «pending», и зелёный прогон выглядел бы полным. Чистый клон (нет example/) — не повод.
    if (!referenceCorpusPresent && fs.existsSync(EXAMPLE_ROOT)) {
      console.warn(
        `[corpus] example/ есть, но это не эталонный корпус — корпусные сьюты пропущены. Нет: ${missing
          .map((marker) => path.relative(EXAMPLE_ROOT, marker))
          .join(', ')}`
      );
    }
  }
  return referenceCorpusPresent;
}

/**
 * Доступен ли эталонный корпус (см. {@link REFERENCE_CORPUS_MARKERS});
 * дополнительные пути позволяют сьюту потребовать конкретный файл/каталог.
 */
export function hasCorpus(...requiredPaths: readonly string[]): boolean {
  return isReferenceCorpusPresent() && requiredPaths.every((candidate) => fs.existsSync(candidate));
}

/**
 * Пропускает сьют/тест, если корпуса нет. Вызывается из `suiteSetup`/тела
 * теста: `suiteSetup(function () { skipWithoutCorpus(this); })`.
 *
 * ВАЖНО: обход корпуса нельзя делать на этапе ЗАГРУЗКИ модуля (в теле файла или
 * в теле `suite(...)`, в т.ч. для генерации тестов циклом по файлам) — там
 * `this.skip()` ещё не отработал, а необработанный ENOENT рушит ВЕСЬ прогон
 * Mocha, а не помечает тесты упавшими, и никакой `MOCHA_GREP` от этого не
 * спасает. Список файлов корпуса вычисляется лениво — внутри теста или
 * `suiteSetup`.
 */
export function skipWithoutCorpus(context: Mocha.Context, ...requiredPaths: readonly string[]): void {
  if (!hasCorpus(...requiredPaths)) {
    context.skip();
  }
}
