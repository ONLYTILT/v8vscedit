> **Статус: реализовано (2026-11-20).** Отступления разработчика: добавлен `RepositoryStepFailedError`
> (сбой шага цепочки после побочных эффектов); прочие сбои после старта оборачиваются в `RepositoryCliError`;
> статус-бар вынесен в `repositoryStatusBar.ts`; изменения UI: «Захват не отменён» вместо ложного успеха,
> «нечего помещать» при помещении без правок, вопрос перед помещением только при `changedFilesCount > 0`.
> Бэклог ревьюера: удалить неиспользуемые обёртки `run*Action` в `RepositoryCommandRunner` (у
> `runRepositoryUnlockAction` при чужом захвате остался тост «освобождены» — ловушка); двойной разбор лога в
> `resolveUnlockedFullNames`; предупреждение MCP `lock` при пустом `lockedObjects`; UI `unlock` не сообщает
> `notUnlocked`/`lockedByOthers` при частичном освобождении; двойной тост UI `commit` без правок;
> переименовать `repositoryCoverageGaps.test.ts`; декомпозиция `RepositoryService.ts` (907 строк).

# План: MCP-инструменты хранилища 1С и `/UpdateDBCfg`

Трек FULL. План архитектора (2026-11-20) с решениями пользователя и поправками по эксперименту Э25.
Факты платформы, на которых он стоит, — [remote-designer-plan.md](./remote-designer-plan.md) §5b п.23, 25,
31 (Э24) и 32 (Э25).

## Решения пользователя

- Рекурсивный захват КОРНЯ (`configuration`/`extension` + `recursive: true`) требует `confirm: true`.
- `v8vscedit_update_database_configuration` — без `confirm` (паритет с «Обновить БД» в UI), предупреждение о
  реструктуризации — в description.
- Допущения о логе помещения сняты Э25 до тестов (см. ниже).

## Поправки по Э25 (обязательны, заменяют допущения архитектора)

- `committedObjects` — по строкам `Объект помещен в хранилище: <имя>` (а не по exit 0). Помещение без правок
  (все строки «Объект не был изменен») — успех с пустым `committedObjects` и предупреждением «нечего
  помещать». Нераспознанный лог (нет маркера начала операции) — консервативно все запрошенные.
- Снятие захвата после помещения в лог не пишется: при exit 0 и без `keepLocked` учёт снимается у
  запрошенных объектов (текущее поведение UI верно).
- `-force` с очисткой ссылок МЕНЯЕТ базу помещающего — импорт после помещения при строке
  «Очистка объектов от некорректных ссылок выполнена» обязателен (UI и MCP).

## Что найдено в коде (влияет на план)

1. В `docs/architecture.md` раздел «Почему операции хранилища не публикуются как MCP-инструменты»
   противоречит ТЗ — переписывает documenter (доводы закрыты: `confirm`, обязательный `comment`, явный
   `localChanges`, пароль из SecretStorage через `resolveBindingForCommand`, агент его не передаёт).
2. `runRepositoryUnlockAction.afterSuccess` снимает учёт у всех `fullNames` по exit 0, а освобождение
   чужого захвата даёт exit 0 без снятия (Э24) — дефект и UI; исправляется общим кодом (учёт по строкам
   «Захват объекта отменен:»).
3. Сверки «зарегистрированные ⊆ `EXTENSION_MCP_TOOLS`» нет (`mcpToolsCatalog.test.ts` считает число) —
   отсюда 5 ролевых инструментов вне каталога.
4. `MetadataNode.label` — `string | TreeItemLabel`: нужен адаптер `toRepositoryNodeRef(node)` с
   `label: node.textLabel`.
5. `updateTargetDatabase`/`importTargetFromDatabase` в агентном режиме открывают окна согласия человека
   (`promptFullDump`/`promptMirrorSeed`/`promptOrphanRemoval`) — оставить: согласие даёт человек, MCP-вызов
   ждёт. Задокументировать.
6. `RepositoryService.ts` — 903 строки (> ~800): в задаче только публичный метод, декомпозиция — бэклог.
7. `buildCfApplyTarget` выводит корень из раскладки `src/cf`; для MCP корень брать из реального
   `Configuration.xml` узла (`rootPath` участвует в резолвинге подключения).

## 1. Контракты

Общее: `path` (канон, [mcp-paths.md](../mcp-paths.md)) + `configuration?`. Дочерний узел разрешается во
владельца (`resolveFullName`). Порядок: валидация аргументов без побочных эффектов → узел/цель
(`resolveConnectedTarget`) → бросающий замок → ПОД ЗАМКОМ число изменённых файлов и
`findLockedInSelection` → `planRepository*` (`ask`/`cancel` → ошибка без побочных эффектов) → цепочка.
Ошибки — `gate.toolError`/`wrapAsync`; занятый замок — `CONFIGURATION_OPERATION_BUSY_MESSAGE`; нет
привязки/подключения — `Для "<имя>" нет активного подключения к хранилищу.` + «(состояние —
v8vscedit_repository_status)»; сбой платформы — `Ошибка при <операции>: <причина>`
(`extractFailureReason`); «Отмена» — «Операция прервана пользователем». **`gate.afterMutation` НЕ
вызывается** (комментарий у регистрации: меняются база и учёт захватов, файлы проекта меняет только
импорт, сам делая `markConfigurationsClean` + `reloadEntries`; пометка «изменено» заставила бы залить
старые файлы поверх полученного — отклонение как у `load_cf`); после успеха — `refreshRepositoryUi`.
Тостов у MCP нет; статус-бар и `withProgress` с «Отмена» остаются.

### `v8vscedit_repository_status` (read-only, `readOnlyHint: true`, без замка)
Вход `{ path, configuration? }`. Выход `{ path, target: {displayName, kind, extensionName?}, binding:
{repoPath, repoUser} | null (без пароля), passwordStored, connected, lockedObjects: {name, label}[]
(formatRepositoryLockName), lockAccounting: 'local', unloadedChangedFilesCount, node?: {fullName|null,
locked, editRestricted} }`. Платформу не вызывает.

### `v8vscedit_repository_lock` (`destructiveHint: false`)
Вход `{ path, configuration?, recursive? (false), localChanges?: 'loadFirst'|'keepProjectBehind'|'abort',
confirm? }`. `loadFirst`→`'update-then-lock'`, `keepProjectBehind`→`'lock-without-import'`,
`abort`→`'cancel'`; `revised` — настройка `v8vscedit.repository.getRevisedOnLock` тем же хелпером, что UI.
Рекурсивный корень без `confirm: true` → «Рекурсивный захват корня захватывает всю конфигурацию и
блокирует её для всей команды. Передайте confirm: true.» Изменённые файлы без `localChanges` → ошибка с
перечнем вариантов; `abort` → «Захват не выполнен: …». Выход `{ path, lockedObjects, requestedObjects,
receivedFromRepository, databaseLoadedBefore, projectImported, projectBehind, warnings }`. Сбой загрузки
до захвата → «Загрузка правок проекта в базу не выполнена; захват не выполнялся. Подробности — в журнале
«1С Редактор».»

### `v8vscedit_repository_update` (`destructiveHint: true`)
Вход `{ path, configuration?, recursive?, localChanges?: 'loadAfter'|'keepProjectBehind'|'abort',
overwriteLocked? }`. `-force` и `version` не открываются (Э24: различий нет; откат версии — действие
человека). Та же `planRepositoryUpdate`: `overwriteLocked`→`lockedOverwriteConfirmed`,
`loadAfter`→`'receive-then-load'`, `keepProjectBehind`→`'receive-without-import'`, `abort`→`'cancel'`;
`ask-locked-overwrite` → `describeLockedOverwrite(names)` + « Передайте overwriteLocked: true, чтобы
подтвердить, или сначала поместите правки (v8vscedit_repository_commit).»; `overwriteLocked: false` →
«Получение не выполнено: в выборке есть захваченные вами объекты (overwriteLocked: false).». Выход
`{ path, receivedFromRepository, changesLoadedAfter, projectImported, projectBehind, lockedOverwritten,
warnings }`; сбой загрузки после получения — успех с `describeLoadFailureAfterReceive` и
`projectBehind: true`.

### `v8vscedit_repository_commit` (`destructiveHint: true`)
Вход `{ path, configuration?, recursive?, comment: string, keepLocked? (false), force?, localChanges?:
'loadFirst'|'abort', confirm: boolean }`. `confirm !== true` → «Помещение необратимо записывает версию в
общее хранилище команды. Передайте confirm: true.»; пустой `comment.trim()` → «Для помещения требуется
непустой комментарий (comment).»; изменённые файлы без `localChanges` → «В проекте N незагруженных
изменённых файлов; помещение без предварительной загрузки запрещено. Передайте localChanges: 'loadFirst'
…»; `abort` → ошибка. Description `force`: «платформа сама удалит из объекта ссылки на удалённые объекты
(молчаливая правка объекта в базе и в хранилище), захват не обходит». Выход `{ path, committedObjects,
keptLocked, referencesCleaned, databaseLoadedBefore, projectImported, warnings }`.

### `v8vscedit_repository_unlock` (`destructiveHint: false`)
Вход `{ path, configuration?, recursive? }`; `force` не открывается (Э24: теряет правки). Выход
`{ path, unlockedObjects, lockedByOthers: {name, user}[], notUnlocked, warnings }`; при незагруженных
правках — предупреждение «после отмены захвата загрузить их в базу по освобождённым объектам будет
нельзя». Ничего не освобождено и есть `notUnlocked` → ошибка «Захват не отменён: <имена>[; захвачено
другим пользователем: X (User)]». exit 1 → причина платформы + «Если объект изменён в базе, отменить
захват без потери правок нельзя: поместите изменения (v8vscedit_repository_commit).»; строки «отменен» из
лога всё равно применяются к учёту.

### `v8vscedit_update_database_configuration` (в `McpConfigLifecycleTools.ts`, `destructiveHint: true`)
Вход `{ path, configuration? }`, `path` — корень; не корень → ошибка (текст `resolveConfigurationXmlByCanonical`).
Цель `resolveApplyTargetFromNode(node)`, под бросающим замком → `runApplyDatabaseConfiguration`. Выход
`{ path, kind, name, databaseConfigurationUpdated: true, unloadedChangedFilesCount, note? }`; при
`count > 0` note: «/UpdateDBCfg не загружает файлы проекта: правки применятся только после
v8vscedit_execute_command v8vscedit.updateChangedConfigurations». `false` → «Обновление конфигурации БД
не выполнено. Подробности — в журнале «1С Редактор».» `afterMutation` не вызывается.

## 2. Шаги (не более одного слоя за шаг)

1. **infra.** `RepositoryLockLog.ts`: префикс «Объект захвачен для редактирования другим пользователем:»
   → `lockedByOthers` (`<имя> (<пользователь>)`, распознанная строка; не пересекается с `LOCKED_PREFIX`);
   `resolveUnlockedFullNames(fullNames, log)` (нераспознанный → все; распознанный → все из «Захват
   объекта отменен:», включая вне `fullNames`, + не-«Тип.Имя» из `fullNames`); `parseRepositoryCommitLog`
   / `resolveCommittedFullNames` по «Объект помещен в хранилище:» (Э25); `hasReferencesCleaned(log)`.
   `RepositoryService`: `getLockedFullNames` → публичный `listLockedFullNames(target)`.
   **1b (отдельный коммит):** данные `EXTENSION_MCP_TOOLS`/`BSL_ANALYZER_MCP_TOOLS` из
   `infra/ai/AiMcpConfiguration.ts` (817 строк) байт-в-байт в `infra/ai/AiMcpToolCatalog.ts` + re-export;
   `aiMcpConfiguration.test.ts` без правок.
2. **ui/commands/ext.** `configurationOperationLock.ts`: `runWithConfigurationOperationLockOrThrow`
   (локальная копия в `McpConfigLifecycleTools.ts` удаляется на шаге 4). `CfFileTarget.ts`:
   `resolveApplyTargetFromNode(node)`.
3. **ui/commands/repository.** `RepositoryCommandRunner.ts`: `executeRepositoryCliCommand` (без тостов,
   бросает `RepositoryCliError {title, message, log?, exitCode?}` / `RepositoryCliInterruptedError`) +
   прежняя UI-обёртка `runRepositoryCliCommand` (тексты и запрет №18 не меняются); `execute*Action`
   (бросают, возвращают исход: commit `{committedFullNames, referencesCleaned}`, unlock `{unlocked,
   lockedByOthers, notUnlocked}`) и прежние `run*Action` = try/catch с тостом. Новый чистый
   `repositoryCommitFlow.ts` (`planRepositoryCommit`, `shouldImportAfterCommit` = `referencesCleaned`,
   тексты). `repositoryNodeTargets.ts`: `resolveConnectedTarget` без vscode, UI-обёртки с прежним
   предупреждением. `repositoryPostSync.ts`: `services` → `RepositoryChainServices` (Pick из
   `CommandServices`). Новый `repositoryChains.ts`: `runLockChain`/`runUpdateChain`/`runCommitChain`/
   `runUnlockChain` (решённый план → структурный результат с `warnings`, тостов нет; порядок шагов UI
   сохраняется; commit при `referencesCleaned` — импорт). UI-команды собирают ответы до замка и зовут
   цепочки, `warnings` — через `void`.
4. **ui/mcp.** `registration/McpRepositoryDecisions.ts` (чистый: enum → ответы планировщика,
   `resolveMcp*Plan`, `assertCommitArgs`, `assertRootRecursiveLockConfirmed`, `toRepositoryNodeRef`);
   `registration/McpRepositoryTools.ts` (5 инструментов, `registerRepositoryTools`); в
   `McpConfigLifecycleTools.ts` — `update_database_configuration` и общий бросающий замок; вызов в
   `V8McpServer.ts`.
5. **infra/ai.** Каталог: 6 новых записей + 5 пропущенных ролевых (`edit_role`, `list_default_roles`,
   `add_default_role`, `remove_default_role`, `set_default_roles`) + устаревшие по обратной сверке.

## 3. Тесты (один бриф test-writer)

A. Чистые (100% веток): разбор лога (чужой захват, `resolveUnlockedFullNames`, лог помещения Э25,
`hasReferencesCleaned`, CRLF, регистр `ru`); `listLockedFullNames`; `planRepositoryCommit` (таблица);
`McpRepositoryDecisions` (каждое значение enum × dirty {0,3}; update × locked {[],[1],[7 → «и ещё 2»]} ×
overwriteLocked {undefined,true,false}; точные тексты; `assertCommitArgs`; захват корня; адаптер узла);
бросающий замок (свободен/занят/op бросает); `resolveApplyTargetFromNode`.
B. Раннер: `executeRepositoryCliCommand` (exit≠0 → `RepositoryCliError` без тоста; прерывание; нет
выходного файла; `dispose` всегда); освобождение по логу (частичное, чужой захват, exit 1 со строкой
«отменен»); помещение по логу Э25.
C. Цепочки (`repositoryChains.test.ts`, техника `repositoryUpdateCommand.test.ts`): порядок шагов,
сбои загрузки/импорта, `referencesCleaned` → импорт (cf, cfe), `keepLocked`.
D. MCP-интеграция (`mcpRepositoryTools.test.ts`, `mcpUpdateDatabaseConfiguration.test.ts`): точный вектор
поэлементно (`-Objects` с XML, `-revised` по настройке, `-keepLocked`, `-force` только у commit,
`-comment`, `-Extension` у cfe); лог → поля результата и учёт; exit≠0/прерывание → `isError`; все
защиты без запуска исполнителя (`runs.length === 0`, замок свободен); неканонический путь; не вызваны
`markChangedConfigurationByFiles`/`suppressConfigurationReloadForFiles`, вызваны `treeProvider.refresh` +
`refreshActionsView`; нет тостов; дочерний узел → владелец; status; update_database_configuration (cf/cfe
цель, `false`, note, не корень, замок).
E. Регресс UI без правки эталонов (кроме теста, фиксировавшего «освобождение помечает всё» при
распознанном логе с чужим захватом — оправданный фикс Э24, отметить в тесте).
F. Каталог: 61 → 67 прямых в `mcpToolsCatalog.test.ts` + `EXPECTED_TOOLS`; прямая и обратная сверка
каталога с регистрацией.

`COVERAGE_TESTS='repository|mcpRepository|mcpUpdateDatabase|mcpToolsCatalog|mcpConfigLifecycle|mcpCfeBatch|configurationOperationLock|aiMcpConfiguration|mcpAddTools|cfFile'`

## 4. Документация (documenter)

`architecture.md` (переписать раздел «Почему операции хранилища не публикуются…», MCP-цепочки,
`RepositoryCliError`, освобождение и помещение по логу, долгие вызовы и тайм-аут MCP-клиента),
`remote-designer.md` (MCP-операции идут тем же исполнителем), CLAUDE.md «Инвариант изменений» (новая
операция хранилища в MCP: цепочка в `repositoryChains`, решение — `planRepository*`, вопросы диалога —
явные параметры, без `afterMutation`), раскладка `infra/ai`.
