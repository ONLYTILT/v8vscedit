# Задача: запуск расширения блокируется полным перехешированием выгрузки

Статус: **выполнена, ручная проверка на tlc_buh пройдена** (2026-11-18, см. «Ручная проверка»). Трек: **FULL** (architect → test-writer →
developer → qa-e2e → reviewer → documenter), reviewer — APPROVE.
Затрагивает формат хеш-кэша (`infra/cache/HashCache.ts`), `infra/fs/ConfigurationChangeDetector.ts`,
`Container.ts` и потребителей кэша в CLI и синхронизации агента. Это несколько слоёв и общий контракт.

## Симптом

Проект `C:\projects\tlc_buh` содержит Бухгалтерию предприятия КОРП 3.0.202:

- выгрузка `src\cf`: 104 238 файлов, 7,5 ГБ;
- ровно та же конфигурация лежит в корпусе `example/2.20/src/cf`, на ней можно воспроизводить.

После открытия окна навигатор показывает загрузку **4+ минуты**. Весь Extension Host в это время не
отвечает: висят Git, Copilot, Claude Code и другие расширения.

## Диагностика (2026-11-18, окно `window6`, pid Extension Host 21676)

| Наблюдение | Значение |
|---|---|
| Активация `macegor.v8vscedit` | 17:22:51.410 |
| `renderer.log`: «Extension host … is unresponsive» | 17:22:55.417, через 4 с |
| Прочитано процессом Extension Host к 17:33 (`Win32_Process.ReadTransferCount`) | 5,4 ГБ |
| Скорость чтения / CPU процесса | ~47 МБ/с, 0,4 с CPU за 10 с: процесс ждёт диск, а не считает |
| Дочерние процессы Extension Host | нет; `bsl-analyzer` не запущен, т.е. `bootstrap` не дошёл до `wireLsp()` |
| `loadMetadataCache` для tlc_buh (кэш дерева) | 0,6 с, кэш валиден: **дерево ни при чём** |
| `ConfigurationChangeDetector.detect` отдельным процессом на tlc_buh | **41,1 с**, результат «0 изменённых»; файлы уже были в кеше ОС после чтения окном |
| Холодная сборка дерева (`buildMetadataCacheSnapshot`) на `example/2.20` | ~25 с, снимок 111 МБ; к симптому не относится, кэш был валиден |

Скрипты замеров — read-only, на скомпилированном `out/`. Лежат в scratchpad прошлой сессии и могут
быть очищены, поэтому суть приведена здесь:

```js
// detect.js <projectRoot>
const { findConfigurations } = require('out/infra/fs/ConfigLocator.js');
const { ConfigurationChangeDetector } = require('out/infra/fs/ConfigurationChangeDetector.js');
new ConfigurationChangeDetector(root).detect(findConfigurations(root)); // замерить время
```

## Причина

Цепочка вызовов при старте выполняется синхронно на потоке активации:

`Container.bootstrap` → `reloadEntries()` ([Container.ts:372](../../src/Container.ts)) →
`refreshChangedConfigurationState()` ([Container.ts:768](../../src/Container.ts)) →
`ConfigurationChangeDetector.detect()` ([ConfigurationChangeDetector.ts:67](../../src/infra/fs/ConfigurationChangeDetector.ts)) →
`buildHashSnapshot()` ([HashCache.ts:64](../../src/infra/cache/HashCache.ts)).

`buildHashSnapshot` обходит все `*.xml`/`*.bsl` и содержимое макетов. Для каждого файла он делает
`fs.readFileSync` и SHA-1 (`computeFileHash`). Быстрой проверки по `mtime`/`size` нет: хеш-кэш хранит
только `Record<relativePath, sha1>`, и сравнить без чтения содержимого не с чем. Поэтому каждый старт
стоит O(размер выгрузки) байт ввода-вывода, а не O(число файлов) вызовов `stat`.

Комментарий в [Container.ts:698-700](../../src/Container.ts) уже фиксирует проблему для пути наблюдателя
за файлами: «полный пересчёт (detect обходит и хеширует всю выгрузку) на каждое из тысяч событий
заблокировал бы Extension Host на минуты». Обошли её только там, окном тишины, а старт остался без
защиты.

### Все места, где выполняется полный пересчёт

Расширение, потоком Extension Host:

- `Container.reloadEntries` → `refreshChangedConfigurationState`: старт, а также каждый вызов
  `reloadEntries` (команда обновления, наблюдатель состава конфигураций);
- `Container.scheduleChangedConfigurationStateRefresh`: таймер 1 с после событий файлов
  ([Container.ts:711-714](../../src/Container.ts));
- `Container.markConfigurationsClean`: по закрытии окна тишины после импорта или обновления
  ([Container.ts:819](../../src/Container.ts));
- `ConfigurationChangeDetector.ensureCaches`: первичное создание кэша, допустимо один раз;
- проброс `refreshChangedConfigurationState` в сервисы ([Container.ts:500](../../src/Container.ts)).

CLI и синхронизация агента используют тот же `buildHashSnapshot`, отдельным процессом:

- `cli/commands/importConfiguration.ts:109`;
- `cli/commands/importGitChanges.ts:40`;
- `cli/commands/refreshHashCache.ts:19`;
- `infra/agent/sync/SyncManifest.ts:45` — `buildSyncManifestFiles`, манифест B синхронизации агента;
- `AgentOperationService`.

Попутная мелочь: `ensureCaches` вызывает `loadMetadataCache` (снимок 111 МБ, ~0,6 с) только ради
проверки «есть ли». Затем `MetadataTreeProvider` грузит тот же снимок повторно. Не блокер, но
архитектору стоит учесть.

## Требования к решению

1. **Неизменённые файлы не читаются.** Повторная проверка выгрузки без изменений стоит
   O(число файлов) вызовов `stat`. Содержимое и SHA-1 считаются только для файлов, у которых
   изменились `mtime` или `size`, и для новых файлов.
2. **Семантика «изменено» сохраняется.** Решение по-прежнему принимается по хешу содержимого. Файл,
   у которого после `git checkout` или перезаписи изменился `mtime`, но содержимое прежнее, не
   считается изменённым. Его хеш пересчитывается, а `mtime` в кэше обновляется.
3. **Поток активации не блокируется на O(выгрузка).** Дерево показывается из кэша сразу, отметка
   «конфигурация изменена» (`v8vscedit.hasChangedConfigurations`) выставляется после фоновой проверки.
   Механизм — асинхронный обход или worker — на выбор архитектора.
   - Порядок «кэши готовы → detect» не нарушать: комментарий в
     [Container.ts:382-386](../../src/Container.ts) объясняет, почему `ensureHashCaches` пока
     синхронный.
   - Повторные запросы проверки во время идущей схлопываются в одну, а не множат параллельные проходы.
4. **Совместимость формата кэша.** `HashCacheSnapshot.files` (`Record<string, string>`) читают CLI,
   `SyncManifest` (манифест B агента) и `patchHashSnapshot`.
   - Расширение формата (например, параллельное поле со `stat`-отпечатками и новая `schemaVersion`)
     не должно ломать этих потребителей.
   - Старый кэш (`schemaVersion: 1`) мигрирует без ложного «всё изменено». Допустимо один раз
     дочитать хеши для файлов без `stat`-записи, сравнивая их с сохранённым sha1.
   - Запись кэша — только через `writeFileAtomic` (CLAUDE.md).
5. **CLI-пути получают ту же быструю проверку**, где она применима (`importGitChanges`,
   `importConfiguration`, `SyncManifest`). Отказ для какого-либо потребителя — с обоснованием в плане.
6. **Точность `mtime`.** На NTFS `mtime` миллисекундный, у части ФС он грубее. Запись файла в ту же
   единицу времени, что и снятие отпечатка, не должна давать пропуск изменения. Способ защиты
   выбирает архитектор, например не доверять отпечатку, снятому с `mtime`, близким к моменту снятия
   (racy-git).

## Критерии приёмки

- Тест: повторный `detect` на неизменённой выгрузке не читает содержимое файлов. Проверка — по
  поведению (счётчик через шов ФС либо по отсутствию пересчёта хеша), а не по времени.
- Тест: изменение содержимого с сохранением размера обнаруживается; `touch` без изменения содержимого
  изменением не считается; удаление и добавление обнаруживаются.
- Тест миграции кэша `schemaVersion: 1`: нет ложных изменений, после проверки записан новый формат.
- Тест совместимости `SyncManifest` и CLI-импорта с новым форматом.
- Тест на корпусе `example/` (если доступен; на чистом клоне пропускается) или на временной копии.
  **Тесты не пишут в `example/`**: мутации — только во временной копии (`fs.mkdtempSync`).
- Ручная проверка на tlc_buh: окно открывается, навигатор показывает дерево за секунды,
  `renderer.log` не содержит «Extension host … is unresponsive» от старта расширения, отметка
  изменений появляется после фоновой проверки.
- `coverage:changed` — 100% на изменённых файлах; тесты агентов — только через
  `npm run test:hidden -- …`.

## Итог решения

Полное описание — [architecture.md, «Хеш-кэш: базовая линия и stat-мемо»](../architecture.md#хеш-кэш-базовая-линия-и-stat-мемо).

- Stat-мемо отдельным файлом `.v8vscedit/hash-stat/` (`infra/cache/HashStatMemo.ts`): отпечаток
  mtime+ctime+size → sha1. Базовая линия `.v8vscedit/cache/` (`schemaVersion: 1`) не менялась, её
  потребители не тронуты; миграция — один фоновый перехеш без ложных изменений.
- `infra/cache/HashScanner.ts` (`scanHashSnapshot`): асинхронный обход с пулом 16, неизменённые файлы
  не читаются; racy-окно 3 с от старта прохода; `ENOENT`/`ENOTDIR` — отсутствие файла, прочие ошибки
  пробрасываются.
- `infra/fs/ChangeDetectionRunner.ts`: single-flight фоновой проверки в `Container`; `detect` стал
  async и сам инициализирует базовую линию; `ensureCaches`/`ensureHashCaches` удалены;
  `getChangedConfigurations` ждёт `whenIdle()`.
- CLI (`importGitChanges`, `importConfiguration` Full, `refreshHashCache`) и `SyncManifest` агента
  переведены на `scanHashSnapshot`; `collectCurrentHashes`/`patchHashSnapshot` — без изменений (уже
  O(изменения)).

## Ручная проверка (2026-11-18, tlc_buh, сборка `v8vscedit-0.5.0-startup-hash.vsix`)

| Наблюдение | До | После |
|---|---|---|
| Старт окна | навигатор грузится 4+ мин, Extension Host не отвечает | дерево и `bsl-analyzer` поднимаются сразу |
| Первый старт (миграция, мемо нет) | — | `[hash-cache] …: файлов 97256, перехешировано 97256 (racy 0), 32744 мс` — в фоне, один раз; мемо 19,4 МБ, базовая линия не тронута |
| Повторный старт | `detect` 41,1 с синхронно, читается всё содержимое | `[hash-cache] …: файлов 97256, перехешировано 0 (racy 0), 3862 мс` — в фоне |
| `renderer.log`: «Extension host … is unresponsive» | через 4 с после активации | нет после запусков новой сборки |

Оставшиеся ~3,9 с повторной проверки — `stat` 97 тыс. файлов и синхронный `JSON.parse` базовой линии
(15 МБ) и мемо (19 МБ). Если понадобится ускорить — держать разобранный мемо в памяти детектора между
проверками (отдельная задача, риск 2 плана архитектора).

## Известные хвосты

- `src/Container.ts` — больше 1000 строк (ориентир 800, запрет №17); превышение унаследовано, дифф
  задачи добавил нетто +14. Отдельная задача на декомпозицию.
- `cliHashCache.test.ts` ждёт ~3,3 с выхода из racy-окна: у CLI-пути нет шва `now`. Добавить шов —
  тест станет мгновенным.
- Teardown новых тестов (`hashScanner`, `configurationChangeDetector`, `cliHashCache`) удаляет
  временные каталоги с кириллицей через `fs.rmSync` — на Node 24 может молча оставить мусор в `%TEMP%`
  (запрет №19 касается файлов выгрузки, но поведение то же).
- `coverageEdges.test.ts` исключён из выборки `coverage:changed`: холодная сборка дерева по всему
  корпусу под c8 не укладывается в 240 с. Ветки детектора покрывает `configurationChangeDetector.test.ts`.
- `ExtensionCommands` «Обновить конфигурации» при первой миграции большой выгрузки держит флаг
  занятости до конца фоновой проверки (осознанно, см. architecture.md).

## Вне рамок

- Ленивая (по раскрытию) сборка дерева метаданных: холодная сборка ~25 с на БП — отдельная задача.
- Индексация `bsl-analyzer`: это внешний процесс, к симптому не относится.
