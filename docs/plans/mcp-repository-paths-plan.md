> **Статус: план архитектора (2026-11-23), обновлён по Э33 (2026-11-23), не реализован.** Трек FULL: меняются
> контракты четырёх MCP-инструментов, общие цепочки хранилища, разбор лога и infra-слой выборки объектов.
> Решение пользователя: `lockedOverwritten` — имя сохранить, смысл сузить до реально перезаписанных.

## Бэклог ревьюера

1. `unlock` объектов «не захвачены вами»: успех с пустыми `unlockedObjects`/`notUnlocked` без предупреждения — добавить предупреждение «освобождать нечего: X» и фразу в описание unlock.
2. `describeUnlockBlockedByChanges` при рекурсивном корне выбирает короткий текст (`requestedCount=1`) — выбирать по корню/рекурсии.
3. `lock` корня с объектами при exit≠0: неподтверждённый корень не попадает ни в `lockedObjects`, ни в `notLocked` — назвать его в предупреждении.
4. `requestedObjects` в `commit` считать до операции, как в `lock` (`repositoryChains.ts` ~519).
5. Условие подключения продублировано в трёх местах (`repositoryNodeTargets` ×2, `McpRepositoryTools.ts:120`) — вынести `isRepositoryTargetConnected`.
6. `RepositoryService.ts` 852 строки (> 800, запрет №17) — декомпозиция: учёт захватов (`setLocked`/`listLocked`/state) в отдельный модуль; `RepositoryCommandRunner.ts` 794 — близко к порогу.
7. `findLockedInSelectionForNodes` глушит любое исключение (`catch {}` → `[]`) — сузить до ожидаемых отказов выборки.
8. Описание `update`: любая подсистема в выборке считается покрывающей все захваты цели (Э33.5).
9. `<Subsystem>` в выборке только при `recursive`? Нерекурсивная подсистема с `<Subsystem>` захватывает и её состав (Э33.5) — нужен замер.
10. Имя корня в логе («Конфигурация»/имя расширения) попадает в `unlockedObjects` как «отменённое вне запроса» — засоряет ответ.
    Там же: сопоставить служебное имя корня с этим именем лога — тогда `resolveUnlockedFullNames` перестанет считать
    снятым корень, захваченный другим пользователем (известное ограничение в architecture.md).

# План: список объектов (`paths`) в MCP-операциях хранилища

Задача пользователя: «paths для всех команд» хранилища. Инструменты `v8vscedit_repository_lock` / `_unlock` /
`_commit` / `_update` сейчас принимают один канонический `path`. Нужен список `paths: string[]`, который
выполняется ОДНИМ запуском пакетного Конфигуратора (один файл `-Objects` с несколькими объектами), одним
шагом загрузки/импорта и возвращает один ответ.

Опорные документы: [mcp-repository-tools-plan.md](./mcp-repository-tools-plan.md) (контракты инструментов и
бэклог ревьюера), [architecture.md](../architecture.md#операции-хранилища-как-mcp-инструменты), факты
платформы — [remote-designer-plan.md](./remote-designer-plan.md) §5b п.23, 25, 31 (Э24), 32 (Э25), Н10 и Э33
(ниже, §2; вносится туда же п.37).

## 0. Что найдено в коде (влияет на план)

1. Выбор объектов строит `RepositoryService.buildObjectsSelectionForNode(node, recursive)`: XML в памяти
   (`<Objects xmlns="http://v8.1c.ru/8.3/config/objects" version="1.0">` + `<Configuration
   includeChildObjects/>` ИЛИ `<Object fullName includeChildObjects>[<Subsystem
   includeObjectsFromSubordinateSubsystems/>]</Object>`), исполнитель кладёт его входным файлом `objects.xml`
   (`-Objects`). Вектор аргументов от числа объектов НЕ зависит — меняется только содержимое файла. Эталоны
   XML — `repositoryObjectsSelection.test.ts` (байт-в-байт, менять нельзя).
2. Дочерний узел уже сводится к владельцу: `resolveFullName` по `CHILD_LIKE_KINDS` →
   `metaContext.ownerObjectXmlPath`. «Объект и его подчинённый» в списке = одинаковые `fullName` →
   дедупликация.
3. Учёт по логу уже принимает список (`resolveLockedFullNames`/`resolveUnlockedFullNames`/
   `resolveCommittedFullNames(fullNames: readonly string[], log)`). Служебное имя корня
   (`__configuration_root__`/`__extension_root__`) сохраняется правилом «не `Тип.Имя`».
4. **Захват при exit≠0 лог НЕ применяет**: у `lockAction` есть только `afterSuccess`
   (`afterPlatformFailure` — только у `unlockAction`). Э33.1 показал, что захват списка неатомарен: при exit 1
   часть объектов захвачена — без правки учёт их теряет, а импорт полученных версий не выполняется.
5. **Дефект `lockedOverwritten`** (`McpRepositoryTools.ts`, update): возвращается `lockedInSelection`,
   снятый ДО получения, — захваченные в выборке, а не перезаписанные; отдаётся и при
   `receivedFromRepository: false`.
6. **Дефект (а) Э33**: повторный захват уже захваченного этим пользователем объекта строки не пишет
   (Э33.7: A держит X, Lock [X, Y] → только «захвачен: Y», exit 0). `resolveLockedFullNames` X отбрасывает →
   MCP ответил бы «X не захвачен».
7. **Дефект (б) Э33**: рекурсивный UnLock корня пишет «Захват объекта отменен:» по ВСЕМ объектам выборки,
   затем «Объект не захвачен для редактирования: <имя>» для незахваченных и «…другим пользователем: <имя>
   (<польз>) » для чужих. `resolveUnlockedFullNames` считает только «отменен» → ложное «освобождён» чужого
   захвата (дефект Э24 через рекурсию). Префикса «Объект не захвачен для редактирования:» в распознаваемых нет.
8. `findLockedInSelection(node, recursive)` — один узел; рекурсивная подсистема и рекурсивный корень дают
   «все захваты цели».
9. `run*Action` (UI-обёртки с тостом) в production не вызываются, но их зовут 4 тестовых файла; сигнатуры
   меняются так, чтобы существующие тесты не правились (§1.4).
10. `RepositoryService.ts` — 907 строк (> ~800): сборка XML выбора выносится в новый модуль.
11. Прецедент `path`/`paths` — `v8vscedit_validate_metadata` ([mcp-paths.md §5.1](../mcp-paths.md#51-общий-аргумент-path));
    там `paths` молча побеждает `path`, здесь — взаимоисключение (операции мутирующие).

## 1. Контракты

### 1.1. Вход (все четыре инструмента)

`path?: string`, `paths?: string[]` (zod `z.array(z.string()).optional()`; `path` становится `optional` — для
старых вызовов ничего не меняется). Остальные параметры прежние и применяются ко всему списку:
`configuration` (один на вызов), `recursive` (к КАЖДОМУ элементу), `localChanges`, `confirm`,
`overwriteLocked`, `comment`, `keepLocked`, `force`, `updateDatabase`. `v8vscedit_repository_status` не
меняется.

Проверка — чистая `normalizeRepositoryPathsInput` (`McpRepositoryDecisions.ts`), ДО резолвинга и замка:

| Условие | Текст ошибки |
|---|---|
| заданы оба `path` и `paths` | `Передайте либо path (один объект), либо paths (список объектов), но не оба.` |
| не задано ни одно | `Укажите path (канонический путь объекта) или paths (список канонических путей).` |
| `paths: []` | `Список paths пуст: передайте хотя бы один канонический путь.` |
| элемент пуст после `trim()` | `Пустой элемент в paths (позиция N).` (N с 1) |
| длина > `MCP_REPOSITORY_PATHS_LIMIT` (100) | `В paths N путей; за один вызов допускается не более 100. Для крупной выборки используйте рекурсивную операцию над подсистемой или корнем (recursive: true) либо разбейте список.` |
| буквальные повторы (после `trim`, регистр `ru`) | `Повторяющиеся пути в paths: "X", "Y".` |

`paths` из одного элемента эквивалентен `path` по поведению, но ответ эхом несёт `paths`.

**Лимит 100 — обоснование.** Технических ограничений на этом масштабе нет (~120 байт XML на объект; удалённый
исполнитель передаёт `objects.xml` base64 — КБ-порядок, Н63). Лимит — защита от ошибочной выборки агентом:
операция держит общий замок и захватывает объекты для всей команды; 100 явных объектов — уже «подсистема»,
для которой есть `recursive: true`.

**Повторы.** Буквальный повтор — ошибка агента (отказ без побочных эффектов). Разные пути к одному объекту
(`Справочники.X` и `Справочники.X.Реквизит.Y`) — молча дедуплицируются (§1.3).

### 1.2. Одна цель хранилища

Локальный `resolveConnectedSelection` в `McpRepositoryTools.ts`, без побочных эффектов, до замка:

1. каждый путь → `deps.paths.resolveNode(p, configuration)` → `toRepositoryNodeRef` (ошибка резолвера —
   как есть);
2. каждый ref → `resolveTargetByXmlPath`; `null` → `Не удалось определить конфигурацию для узла "<p>".`;
3. `assertSingleRepositoryTarget(items: readonly { path: string; target: RepositoryTarget }[]): RepositoryTarget`
   (чистая, `McpRepositoryDecisions.ts`): сравнение по `configRoot` (`path.resolve(...).toLowerCase()`).
   Разные → `Все пути paths должны относиться к одной цели хранилища (основной конфигурации или одному
   расширению), а получено несколько: "<displayName1>" (<path>), "<displayName2>" (<path>). Выполните операцию
   отдельным вызовом для каждой цели.` (по одному примеру пути на цель, в порядке появления);
4. подключение проверяется ОДИН раз (`resolveConnectedTarget(repositoryService, refs[0])`, текст прежний);
5. предпроверка: `repositoryService.resolveSelectionEntry(ref)` для каждого; ошибка → `Путь "<p>": <текст>`;
6. lock: `assertRootRecursiveLockConfirmed` для КАЖДОГО ref — корень где угодно в списке + `recursive: true` +
   `confirm !== true` → прежний текст.

Списки работают и в расширении (Э33.7) — отдельного отказа для cfe нет. Защита в глубину:
`buildObjectsSelectionForNodes` бросает `Узлы выборки относятся к разным конфигурациям хранилища: …` и
`Выборка объектов хранилища пуста.`

### 1.3. Единый файл выбора `-Objects`

Новый модуль **`src/infra/repository/RepositoryObjectsSelection.ts`** (чистый):

```ts
export type RepositorySelectionEntry =
  | { readonly kind: 'root' }
  | { readonly kind: 'object'; readonly fullName: string; readonly subsystem: boolean };

/** Узел или список: существующие вызовы (UI, тесты) передают один узел без изменений. */
export type RepositoryNodeSelection = RepositoryNodeRef | readonly RepositoryNodeRef[];
export function toSelectionNodes(selection: RepositoryNodeSelection): readonly RepositoryNodeRef[];

/** Корень — один и первым; объекты — по fullName (toLocaleLowerCase('ru')), первое написание, порядок появления. */
export function mergeSelectionEntries(entries: readonly RepositorySelectionEntry[]): RepositorySelectionEntry[];

/** XML выбора; для одной записи — байт-в-байт прежний вывод buildObjectsSelectionForNode. */
export function buildObjectsSelectionXml(entries: readonly RepositorySelectionEntry[], recursive: boolean): string;

/** fullNames для учёта: служебное имя корня (если корень есть) первым, затем объекты. */
export function selectionFullNames(entries: readonly RepositorySelectionEntry[], rootLockName: string): string[];

/** Захваченные в выборке (порядок — как в `locked`): рекурсивный корень или любая подсистема — все захваты цели. */
export function selectLockedInSelection(
  locked: readonly string[], entries: readonly RepositorySelectionEntry[], recursive: boolean, rootLockName: string
): string[];
```

Формат XML списка — обобщение текущего (корень, затем объекты; строки, отступы и завершающий `\n` как сейчас):

```xml
<Objects xmlns="http://v8.1c.ru/8.3/config/objects" version="1.0">
  <Configuration includeChildObjects="false"/>
  <Object fullName="Справочник.Товары" includeChildObjects="false">
  </Object>
  <Object fullName="Подсистема.Продажи" includeChildObjects="true">
    <Subsystem includeObjectsFromSubordinateSubsystems="true"/>
  </Object>
</Objects>
```

Правила объединения (Э33.2 и Э33.5 подтвердили допустимость смешения):

- дочерний → владелец, затем дедупликация по `fullName`; корень повторно — одна запись `<Configuration>`;
- корень вместе с объектами принимается (Э33.2: «захвачен: Конфигурация» + «захвачен: Справочник.Справочник3»);
- рекурсивная подсистема вместе со своим объектом принимается, дубль платформа схлопывает сама (Э33.5, lock и
  UpdateCfg). Пересечения расширение НЕ схлопывает: объект в `fullNames` нужен для учёта по логу.

**Известное поведение (не чинится, в бэклог):** элемент `<Subsystem>` включает объекты состава подсистемы
даже при `includeChildObjects="false"` (Э33.5: нерекурсивный Lock [П, С3] захватил П, Справочник1 и С3), а
`buildObjectsSelectionForNode` пишет `<Subsystem>` для вида Subsystem всегда. Поэтому
`selectLockedInSelection` считает ЛЮБУЮ подсистему (не только рекурсивную) покрывающей все захваты цели —
это расширение текущего правила (`Subsystem && recursive`) ради честного вопроса `overwriteLocked`
(лишний вопрос дешевле потерянной правки). Учёт после захвата верен и так — он идёт по строкам лога.
Пункт бэклога: «нерекурсивная операция над подсистемой затрагивает её состав — решить, писать ли
`<Subsystem>` только при `recursive`; замерить, что тогда делает платформа».

`RepositoryService` (уменьшается): `resolveSelectionEntry(node)` (тексты ошибок прежние),
`buildObjectsSelectionForNodes(nodes, recursive): { xml; fullNames; target }`,
`findLockedInSelectionForNodes(nodes, recursive)`; прежние `buildObjectsSelectionForNode`/
`findLockedInSelection` — однострочные делегаты. Для одного узла-подсистемы без `recursive`
`findLockedInSelection` теперь возвращает все захваты цели — единственное изменение его поведения
(тест `repositoryLockedSelection.test.ts`, если пиннит прежнее, правится с пометкой «Э33.5»).

### 1.4. Разбор лога (`RepositoryLockLog.ts`)

- `parseRepositoryLockLog` возвращает дополнительно `notLockedByYou: string[]` (префикс
  `Объект не захвачен для редактирования:`, добавляется в `RECOGNIZED_PREFIXES`; с `LOCKED_PREFIX` не
  пересекается — начинается с «Объект не») и `changedInDatabase: string[]` (строка `Объект '<имя>' был
  изменен`, Э33.3; в распознаваемые НЕ входит — это строка отказа, а не учёта). Хвостовой пробел строки чужого
  захвата (Э33.1/7) уже снимает `splitLines` (trim) — закрепить тестом.
- **Дефект (а):** `resolveLockedFullNames(fullNames, log, alreadyLocked: readonly string[] = [])`: при
  распознанном логе запрошенный `Тип.Имя` захвачен, если его называет строка «захвачен для редактирования:»
  ИЛИ он уже был в локальном учёте до операции (`alreadyLocked`) и не назван строкой чужого захвата или
  отсутствующих. Правило одно для exit 0 и exit≠0: неудачный захват чужой захват не снимает. Третий параметр
  необязателен — существующие тесты `repositoryLockOutcome.test.ts` (Н10) не меняются. Сознательное
  ограничение: объект, захваченный этим пользователем мимо учёта расширения (интерактивный Конфигуратор), без
  строки остаётся «не подтверждён» (`notLocked`), а не «захвачен» — лучше лишнее предупреждение, чем учёт
  захвата, которого нет.
- **Дефект (б):** `resolveUnlockedFullNames` → освобождено = «отменен» − «не захвачен для редактирования» −
  «другим пользователем» (сравнение по ключу `ru`). Правило применяется и к объектному списку (двойных строк
  в Э33.7 не было — правило их не требует, но и не ломается без них). `unlockAction.applyLog`: учёт снимается
  у «отменен» − «другим пользователем» (объект «не захвачен вами» в учёте — устаревшая запись, её снятие
  верно), а `notUnlocked` = запрошенные − освобождённые − «не захвачен вами» (нечего освобождать — не
  «захват не отменён»).
- `resolveOverwrittenLocked(locked, log)` (новая): лог без маркера начала операции → все `locked`
  (консервативно, как `hasReceivedFromRepository`); иначе `Тип.Имя` включается, если строка «Объект получен
  из хранилища:» или «Объект удален из конфигурации:» называет его самого или подобъект (`<имя>.` префиксом,
  регистр `ru`); служебное имя корня — если есть хоть одна такая строка. ПОДТВЕРЖДЕНО Э33.6: «получен» пишется
  и для перезаписи захваченного без новой версии в хранилище (6б), незатронутый объект не упоминается (6в).
  Переиспользует `BASE_CHANGED_PREFIXES`.
- `resolveNotCommittedFullNames(fullNames, log)` (новая): распознанный лог → запрошенные `Тип.Имя`, не
  названные ни «помещен», ни «не был изменен» (Э33.4б/в: незахваченный и чужой объект пропускаются МОЛЧА,
  exit 0); нераспознанный → `[]` (согласовано с «консервативно всё помещено»). Служебное имя корня — никогда.

### 1.5. Раннер и цепочки — одна цепочка для UI и MCP

Параметр `node: RepositoryNodeRef` в `execute*Action`/`run*Action` (`RepositoryCommandRunner.ts`) и
`runLockChain`/`runUpdateChain`/`runCommitChain`/`runUnlockChain` (`repositoryChains.ts`) получает тип
`selection: RepositoryNodeSelection`; порядок параметров прежний. **Почему объединение типов:** ~130 вызовов
в тестах и все UI-вызовы остаются как есть — их неизменность и есть регресс-доказательство; нормализация —
одна `toSelectionNodes` в infra. UI-команды не правятся.

- `requireTarget` → цель из `buildObjectsSelectionForNodes(...).target`; `nodeLabel` → `selectionLabel(nodes,
  target)`: один узел — прежнее `node.label ?? target.displayName` (тексты UI байт-в-байт), несколько —
  `<подпись первого> и ещё N`.
- **lock, `afterPlatformFailure` (новое, Э33.1):** `lockAction` до запуска снимает `alreadyLocked =
  listLockedFullNames(target)`; и `afterSuccess`, и `afterPlatformFailure` (при распознанном логе) применяют
  `resolveLockedFullNames(fullNames, log, alreadyLocked)` к учёту и запоминают исход.
  `executeRepositoryLockAction` при `RepositoryCliError` с `exitCode !== undefined` и исходом, где захвачено
  хоть что-то НОВОЕ по строкам лога, возвращает **частичный исход** `{ ...outcome, platformFailure: message }`
  вместо исключения; если по логу не захвачено ничего — исключение как сейчас. Причина: захват мог получить
  версии (`hasReceivedFromRepository` по тому же логу) — без продолжения цепочки проект молча отстал бы.
  Тип исхода раннера — `RepositoryLockActionOutcome extends RepositoryLockOutcome { lockedByOthers;
  platformFailure?: string }` (тип плана `repositoryLockFlow.ts` не трогается).
- **update:** `updateAction` до запуска берёт `findLockedInSelectionForNodes`, в `afterSuccess` —
  `resolveOverwrittenLocked(lockedInSelection, log)`; исход `RepositoryUpdateActionOutcome extends
  RepositoryUpdateOutcome { lockedOverwritten }`.
- **commit:** `afterPlatformFailure` НЕ нужен (Э33.4: помещение не падает из-за незахваченных/чужих). Исход +
  `notCommitted: resolveNotCommittedFullNames(...)`. Снятие учёта без `keepLocked` — у всех запрошенных, как
  сейчас (незахваченный/чужой объект в учёте — устаревшая запись).
- **unlock:** без `-force` список атомарен (Э33.3: изменённый объект → exit 1, не освобождён НИ ОДИН, строк
  «отменен» нет) — `afterPlatformFailure` уже есть и при отсутствии строк учёт не меняет. `runUnlockChain`
  ловит `RepositoryCliError`, у лога которого `changedInDatabase` непуст, и бросает `RepositoryCliError` с тем
  же `title`/`log`/`exitCode` и текстом `describeUnlockBlockedByChanges(names, requestedCount)`:
  `Захват не отменён ни у одного объекта: платформа отменяет захват списка целиком, а изменены в базе: X, Y.`
  (для одного объекта — `Захват не отменён: объект X изменён в базе.`). MCP добавляет прежнюю подсказку
  `UNLOCK_FAILURE_HINT` («…поместите изменения (v8vscedit_repository_commit)»); `force` агенту не открыт и не
  предлагается. UI получает тот же текст через `showRepositoryCliFailure`.

### 1.6. Результаты (поля добавляются, существующие не переименовываются)

Эхо: при `paths` — `{ paths: <нормализованный список>, ...result }`, при `path` — `{ path, ...result }`.
`refreshRepositoryUi` — один раз (в `finally`); `dirtyFilesCount` и `databaseLagFields` — один раз по цели.

**lock** (`LockChainResult`): + `notLocked: string[]` (запрошенные `Тип.Имя` вне `lockedObjects`; служебное
имя корня не попадает), + `lockedByOthers: LockedByOther[]`. Предупреждения: при непустом `notLocked` —
`describeLockNotComplete(notLocked, lockedByOthers)`: `Захвачены не все объекты: <имена>[; захвачено другим
пользователем: X (User)].`; при частичном исходе exit≠0 — ещё и текст отказа платформы (`platformFailure`).
Ошибкой частичный захват не делается: захват мог получить версии и импорт уже выполнен (закрывает пункт
бэклога «предупреждение при пустом `lockedObjects`»). Ничего не захвачено и exit≠0 — ошибка, как сейчас.

**update** (`UpdateChainResult`): + `lockedOverwritten: string[]` (из исхода раннера, §1.4) и
`requestedObjects`. Локальный спред `lockedOverwritten: lockedInSelection` в MCP удаляется. Имя и тип поля
сохранены (решение пользователя), смысл — «захваченные вами объекты выборки, которые получение реально
перезаписало (по журналу платформы)»; при `receivedFromRepository: false` → `[]`.

**commit** (`CommitChainResult`): + `requestedObjects`, + `notCommitted: string[]`; при непустом —
предупреждение `Не помещены: <имена> — не захвачены вами или захвачены другим пользователем (платформа
пропускает такие объекты без ошибки).` Предупреждение «нечего помещать» — только если `committedObjects`
пуст и `notCommitted` пуст (иначе причина уже названа).

**unlock** (`UnlockChainResult`): поля прежние. Ничего не освобождено → прежняя ошибка
`describeUnlockNotDone`. Частично (`unlockedObjects` и `notUnlocked` непусты) → предупреждение тем же текстом
(сейчас агент видит только поле). Атомарный отказ из-за изменённых объектов — §1.5.

## 2. Э33 — факты платформы (выполнен 2026-11-23)

8.3.27.2130, две копии InfoBase1 + подсистема П{Справочник1} + расширение РасшЭ33{Э33_X, Э33_Y}, два файловых
хранилища, UserA/UserB; драйвер и полные логи — scratchpad оркестратора `e33/` (`run.js`, `s1.log`,
`s2-7.log`). documenter переносит в remote-designer-plan.md §5b п.37.

| № | Сценарий | Итог | Решение в плане |
|---|---|---|---|
| 1 | Lock [С1, С3, Д1], Д1 у UserB | exit 1, С1 и С3 захвачены; строки «захвачен: …» и «…другим пользователем: Документ.Документ1 (UserB) » | захват неатомарен → `afterPlatformFailure` + частичный исход (§1.5) |
| 2 | Lock [`<Configuration false/>`, С3] | exit 0, «захвачен: Конфигурация», «захвачен: Справочник.Справочник3» | смешение корня принимается |
| 3 | UnLock без `-force` [С1 изменён, С3] | exit 1, только «Объект 'Справочник.Справочник1' был изменен», не освобождён никто | атомарен; разбор `changedInDatabase` → понятный текст (§1.5) |
| 4а | Commit [С1 изменён, С3 без правок] | exit 0, «помещен: С1», «не был изменен: С3», оба освобождены | как сейчас |
| 4б/в | Commit [С1, Д1 не захвачен / у UserB] | exit 0, только «помещен: С1», про Д1 ничего | `notCommitted` + предупреждение; `afterPlatformFailure` не нужен |
| 5 | Lock/UpdateCfg [П рекурсивно, Справочник1 ∈ П] | exit 0, дубль схлопнут платформой | смешение принимается; попутно: `<Subsystem>` включает состав и нерекурсивно → бэклог |
| 6 | UpdateCfg [С1 захвачен+изменён, Д1 изменён в хранилище, С3] | «получен: С1», «получен: Д1»; правка С1 затёрта; 6б — «получен: С1» и без новой версии; 6в — нет строк | правило `resolveOverwrittenLocked` подтверждено |
| 7 | расширение: Lock [X, Y у UserB]; Commit -keepLocked; UnLock [X, Y] | как в основной; UnLock — «отменен» по обоим | списки в cfe работают |
| (а) | Lock [X уже у A, Y] | exit 0, только «захвачен: Y» | `alreadyLocked` в `resolveLockedFullNames` |
| (б) | UnLock корня рекурсивно `-force` | «отменен» по всем + «не захвачен для редактирования: …» + «…другим пользователем: …» | освобождено = «отменен» − «не захвачен» − «чужой» |

Побочное наблюдение для будущей работы (в задачу не входит): в логе имя корня — «Конфигурация», корня
расширения — имя расширения («РасшЭ33»); по нему `resolveOverwrittenLocked` мог бы перестать считать корень
консервативно — оставлено консервативным.

## 3. Шаги (не более одного слоя за шаг)

1. **infra/repository.**
   - Новый `RepositoryObjectsSelection.ts` (§1.3); сборка XML переносится из `RepositoryService.ts` без
     изменения вывода; `resolveSelectionEntry`, `buildObjectsSelectionForNodes`,
     `findLockedInSelectionForNodes` + делегаты прежних методов; `selectLockedInSelection` — любая подсистема
     покрывает все захваты.
   - `RepositoryLockLog.ts` (§1.4): префикс «не захвачен для редактирования», `changedInDatabase`,
     `resolveLockedFullNames(..., alreadyLocked)`, исправленный `resolveUnlockedFullNames`,
     `resolveOverwrittenLocked`, `resolveNotCommittedFullNames`.
2. **ui/commands/repository.**
   - `RepositoryCommandRunner.ts`: `selection: RepositoryNodeSelection`, `selectionLabel`; lock —
     `alreadyLocked`, `afterPlatformFailure`, частичный исход; update — `lockedOverwritten`; commit —
     `notCommitted`; unlock — `applyLog` по новому правилу.
   - `repositoryChains.ts`: тот же тип параметра; поля и предупреждения §1.6; `describeLockNotComplete`,
     `describeUnlockBlockedByChanges` (рядом с `describeUnlockNotDone`); перехват атомарного отказа unlock.
   - UI-команды — БЕЗ правок. Видимые изменения UI (через `repositoryChainUi.ts`/`showRepositoryCliFailure`):
     предупреждения частичного захвата/освобождения/помещения, частичный захват при exit 1 — предупреждение
     вместо тоста ошибки, понятный текст отказа освобождения изменённых объектов. Все — исправления
     честности ответа (бэклог ревьюера).
3. **ui/mcp/registration.**
   - `McpRepositoryDecisions.ts`: `MCP_REPOSITORY_PATHS_LIMIT`, `normalizeRepositoryPathsInput`,
     `assertSingleRepositoryTarget`.
   - `McpRepositoryTools.ts`: схемы (`path` optional, `paths`); `resolveConnectedSelection(input)` → `{ refs,
     target, echo }` вместо `resolveConnected`; `lockedOverwritten` — из цепочки. Description каждого
     инструмента: «Принимает канонический путь (`path`) или список путей одной конфигурации/расширения
     (`paths`, до 100) — операция выполняется одним запуском Конфигуратора; `recursive` применяется к каждому
     элементу; дочерний элемент обрабатывает владельца». Плюс: lock — `notLocked`/`lockedByOthers`, частичный
     захват — успех с предупреждением; update — смысл `lockedOverwritten`; commit — `notCommitted` (незахваченные
     вами объекты платформа пропускает молча); unlock — «без force список освобождается целиком или никак:
     изменённый в базе объект блокирует освобождение всех».
4. **infra/ai.** `AiMcpToolCatalog.ts`: четыре записи — `description` «объекта или списка объектов (paths)»,
   `requirement` с префиксом «path или paths (до 100, одна цель); …». Число инструментов прежнее.

## 4. Тесты (ОДИН бриф test-writer, все ветки до 100% `coverage:changed`)

Реальные временные структуры выгрузки (`support/repositoryMcpFixtures.ts`: `createRepoProject` — cf + cfe во
временном каталоге; техника `repositoryObjectsSelection.test.ts`), в `example/` не писать; подменяется только
исполнитель Конфигуратора (фейк `createDesignerExecutor` из фикстур) и, как в существующих сьютах, шаги
загрузки/импорта и окна. Логи фейка — ДОСЛОВНЫЕ строки Э33 (с хвостовым пробелом у чужого захвата, именами в
кавычках у «был изменен»). Существующие тесты не правятся, кроме оговорённого в §1.3 (подсистема без
`recursive` в `findLockedInSelection`, пометка «Э33.5»).

**A. Выборка (`repositoryObjectsSelectionList.test.ts`, новый):**
- `buildObjectsSelectionXml`: одна запись каждого вида × `recursive {false,true}` — совпадение с прежними
  эталонами-литералами; список корень+объект+подсистема — эталон-литерал §1.3;
- `mergeSelectionEntries`: дубликат объекта, дубликат в другом регистре (первое написание), два корня, корень
  не первым → первым, порядок появления;
- `selectionFullNames`: cf/cfe с корнем и без;
- `selectLockedInSelection`: корень ± recursive, подсистема ± recursive (обе → все захваты), объект
  захвачен/нет, два объекта, пустой `locked`;
- `toSelectionNodes`: узел и массив;
- `RepositoryService`: реквизит + владелец → один `fullName`; cf-узел + cfe-узел → ошибка; пустой список →
  ошибка; на диск ничего не пишется (`snapshotTree`/`diffSnapshots`); три ветки ошибок `resolveSelectionEntry`;
  `findLockedInSelectionForNodes` на двух узлах.

**B. Разбор лога (`repositoryLockLogPaths.test.ts`, новый; логи Э33 дословно):**
- `parseRepositoryLockLog`: `notLockedByYou`, `changedInDatabase` (кавычки, кириллица, CRLF), хвостовой пробел
  чужого захвата;
- `resolveLockedFullNames` с `alreadyLocked`: Э33.(а) (X уже в учёте, строки нет → захвачен); X в учёте, но
  назван «другим пользователем»/«отсутствующие» → не захвачен; X без строки и не в учёте → не захвачен;
  Э33.1 (exit-1-лог: С1, С3 захвачены, Д1 нет); корень;
- `resolveUnlockedFullNames`: Э33.(б) (рекурсивный корень: «отменен» по всем + «не захвачен» + «чужой» →
  только реально освобождённые); Э33.7 (оба «отменен»); прежние сценарии Э24 без изменений;
- `resolveOverwrittenLocked`: нет маркера → все; Э33.6 (С1 захвачен и назван, Д1 назван, но не захвачен, С3
  захвачен и не назван); 6б; 6в (нет строк → []); подобъект (`X.Форма.Ф`); префикс-ловушка
  (`Справочник.Товар` vs `Справочник.Товары`); строка «удален»; регистр; корень при наличии/отсутствии строк;
- `resolveNotCommittedFullNames`: Э33.4а ([]), 4б/4в (Д1), нераспознанный лог ([]), корень.

**C. Раннер (`repositoryExecuteActionsList.test.ts`, новый, техника `repositoryExecuteActions.test.ts`):**
параметризация по `kind ∈ {lock, unlock, commit, update}` — два узла дают ОДИН запуск, вектор поэлементно как
у одиночного, `objects.xml` — эталон списка; `selectionLabel` одного (прежние тексты) и нескольких узлов в
`progressTitle`/`errorTitle`. lock: exit 0 с Э33.(а) — X не теряется в учёте; exit 1 с логом Э33.1 — частичный
исход с `platformFailure`, учёт С1/С3 записан, `receivedFromRepository` по логу; exit 1 без строк «захвачен» —
`RepositoryCliError`, учёт не тронут. update: `lockedOverwritten` (6, 6б, 6в). commit: `notCommitted` (4б).
unlock: лог Э33.(б) — учёт снят только у реально освобождённых и «не захвачен» (не у чужого), `notUnlocked`
без «не захвачен»; exit 1 Э33.3 — учёт не тронут.

**D. Цепочки (`repositoryChainsList.test.ts`, новый, техника `repositoryChains.test.ts`):** по каждой цепочке с
двумя узлами — один запуск, одна загрузка до/после, один импорт, `databaseLagFields` один раз; новые поля;
частичный захват exit 1 с полученными версиями → импорт выполнен, предупреждения (неполный захват + отказ
платформы); частичный захват exit 0 → предупреждение; помещение с `notCommitted` → предупреждение, без
«нечего помещать»; только «не был изменен» → прежнее «нечего помещать»; unlock Э33.3 → `RepositoryCliError`
с текстом `describeUnlockBlockedByChanges` (один объект / несколько) и прежними `title`/`log`/`exitCode`;
частичное освобождение → предупреждение.

**E. `McpRepositoryDecisions` (`mcpRepositoryDecisions.test.ts` дополнить):** каждая строка таблицы §1.1
(точный текст), граница 100/101, `paths` из одного элемента; `assertSingleRepositoryTarget` (одна цель; две —
по одному примеру на цель; корень в другом регистре = та же цель).

**F. MCP-интеграция (`mcpRepositoryToolsPaths.test.ts`, новый, техника `mcpRepositoryTools.test.ts`),
параметризация по `CALLS = ['lock','update','commit','unlock']`:**
- схема: `path` и `paths` optional у всех четырёх; status без изменений;
- все отказы входа (§1.1), разные цели (cf+cfe в одном `paths`), неподключённая цель, неразрешимый
  `fullName` (`Путь "<p>": …`) — без запуска исполнителя (`runs.length === 0`), замок свободен, тостов нет;
- успех `paths` из 2–3 путей (дочерний элемент и его владелец, корень вместе с объектом, рекурсивная подсистема
  вместе со своим объектом): один запуск, эхо `paths` без `path`; при `path` — эхо `path` без `paths`;
- cfe: `paths` двух объектов расширения → `-Extension` в векторе, учёт по логу Э33.7;
- lock: рекурсивный корень в списке без `confirm` → отказ; Э33.1 (exit 1 частичный) → успех с `notLocked`,
  `lockedByOthers`, предупреждениями; Э33.(а) → X в `lockedObjects`;
- update: `ask-locked-overwrite` по объединённой выборке двух узлов; `lockedOverwritten` по Э33.6 и `[]` при
  `receivedFromRepository: false` (регресс-тест дефекта: раньше было `lockedInSelection`);
- commit: порядок проверок — `assertCommitArgs` первым, затем `normalizeRepositoryPathsInput` (без `confirm` и
  с `path`+`paths` — текст про `confirm`); Э33.4б → `notCommitted` + предупреждение;
- unlock: Э33.3 → `isError`, текст с именами изменённых + `UNLOCK_FAILURE_HINT`; Э33.(б) рекурсивный корень →
  чужой объект не в `unlockedObjects`; частичное освобождение → предупреждение; ничего → ошибка;
- `refreshRepositoryUi` один раз, `markChangedConfigurationByFiles`/`suppressConfigurationReloadForFiles` не
  вызваны.

**G. Каталог (`mcpToolsCatalog.test.ts`):** число без изменений; ожидания текстов `requirement`, если сверяются.

`COVERAGE_TESTS='repository|mcpRepository|mcpToolsCatalog|aiMcpConfiguration'`

## 5. Риски и что сознательно не делаем

- **Частичный захват при exit≠0 теперь не ошибка** (если по логу что-то захвачено) — меняется поведение UI
  (предупреждение вместо тоста ошибки) и MCP (успех с `platformFailure` в предупреждениях). Обоснование —
  Э33.1: иначе учёт теряет реальные захваты, а полученные версии не импортируются.
- **Освобождение списка без `force` — «всё или ничего»** (Э33.3): один изменённый объект блокирует все.
  Расширение не разбивает список и не повторяет поштучно (повтор мутирующей операции хранилища без решения
  агента опасен) — агент получает имена мешающих объектов.
- **`alreadyLocked` опирается на локальный учёт**: захват мимо расширения без строки лога остаётся «не
  подтверждён» — консервативно.
- **Не делаем:** списки для `v8vscedit_repository_status` и `v8vscedit_update_database_configuration`; разные
  цели в одном вызове; сопоставление `path → объект` в ответе (видно по `requestedObjects`); разрешение состава
  подсистем; изменение записи `<Subsystem>` для нерекурсивной подсистемы (бэклог, §1.3); изменения UI-команд и
  мультивыбора; удаление `run*Action` (бэклог); декомпозицию `RepositoryService.ts` сверх выноса выборки;
  неконсервативное имя корня в `resolveOverwrittenLocked`.
- **Совместимость ответа:** поля только добавляются; `path` в схеме становится optional; смысл
  `lockedOverwritten` сужается до правды (решение пользователя) — отмечается в architecture.md.

## 6. Документация (documenter)

`architecture.md` «Операции хранилища как MCP-инструменты» (`paths`, одна цель, единый `-Objects`, частичный
захват при exit≠0, атомарное освобождение, молчаливый пропуск при помещении, `lockedOverwritten` по логу,
правило освобождения «отменен − не захвачен − чужой»), `mcp-paths.md` §5.1 (инструменты хранилища — второй
пример `paths`; взаимоисключение `path`/`paths` у мутирующих), remote-designer-plan.md §5b п.37 (Э33, таблица
§2) и бэклог (`<Subsystem>` при нерекурсивной подсистеме), CLAUDE.md «Новая операция хранилища в MCP»
(выборка — `RepositoryObjectsSelection`, `RepositoryNodeSelection` в цепочках), раскладка `infra/repository/`.
