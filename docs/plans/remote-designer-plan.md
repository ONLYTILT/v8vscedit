# Архитектурный план: удалённый сервер 1С (агент по SSH/SFTP, хранилище через PSSession)

## Состояние (2026-11-18)

Этапы Э1–Э10 закрыты. Ветка `feature/remote-designer`, коммиты этапов: Э1 `220f0b9`, Э2 `2ee93a4`, Э3 `a859dbb`, Э4 `ba4845a`, Э5 `a4b1bad`, Э6 `e58d160`, Э7 `b01eff9`, Э8 `28ce4b8`, Э9 `9351c6b`; Э10 (документация: `docs/architecture.md` «Удалённый сервер 1С», `docs/remote-designer.md`, CLAUDE.md, README) — `c2eaae0`. Дополнительно: `b0dbcda` (гейт покрытия на Windows), `75e3821` (POSIX-тесты SIGTERM), `979cded` (скрытый прогон тестов).

**Открытые гейты до слияния в `main`:**
1. **Н50** — проверка ключа хоста SSH (TOFU); пароль ИБ по сети сейчас уходит без проверки сервера.
2. **Пилот на стенде пользователя** — чек-лист в [remote-designer.md](./../remote-designer.md#8-чек-лист-пилота-на-стенде) (Н34, Н35, Н46, Н50 и «Пилот Э9»: PSSession, `Copy-Item -FromSession`, текст лога захвата, отмена/обрыв). Удалённая ветка PS-хоста (Н58) тестами не исполняется.

**Задача «потоковый архив и посев зеркала M» (2026-11-18, не закоммитирована):** на стенде БП КОРП (104 тыс. файлов) первый импорт падал «Array buffer allocation failed» на `readFile(full.zip)` и делал две полные серверные выгрузки. Исправлено: потоковый архив (`downloadToFile`/`uploadFromFile`, `ZipByteSource`/`ZipStreamWriter`), одна серверная выгрузка, посев разреженного зеркала M (из архива или из выгрузки проекта по согласию), полнота M `mirrorCoverage`. Устройство — [architecture.md](./../architecture.md#модель-синхронизации-m--p--b); факты экспериментов — §5b п.19–20. Ручная проверка на БП КОРП — в чек-листе пилота ([remote-designer.md](./../remote-designer.md#8-чек-лист-пилота-на-стенде), пункт про первый импорт).

Остальной бэклог (§6) — не блокирует слияние. Устройство и ограничения — [architecture.md](./../architecture.md#удалённый-сервер-1с).


План сверен с CLAUDE.md (слои, «Инвариант изменений», запреты №6/7/9/17, TDD и 100% `coverage:changed`), с docs/architecture.md и docs/vscode-extension-best-practices.md. Код изучен: `infra/agent/*`, `domain/agent/*`, `ExtensionCommandRunner.ts`, `ExtensionCommands.ts`, `configurationOperationLock.ts`, `RepositoryCommandRunner.ts`, `RepositoryCommands.ts`, `RepositoryService.ts`, `cli/commands/repositoryCommands.ts`, `cli/core/onecCommon.ts`, `HashCache.ts`, `AtomicFileWriter.ts`, справка `tmp/Команды config агента конфигуратора.txt`, `tmp/agentbasedir.json`.

---

## 0. Что нашлось в коде сверх брифа (влияет на план)

1. **Пакетные запуски конфигуратора не согласованы с агентом нигде, не только в хранилище.** Сейчас всё работает только потому, что `AgentOperationService.runInfoBaseOperation` в `finally` всегда делает `disconnect-ib` и сбрасывает SSH. Если подключение ИБ станет постоянным, сломаются все пакетные запуски:
   - `RepositoryCommandRunner.runRepositoryCliCommand` (`runProcess`);
   - `runInternalCliCommand` в `ExtensionCommandRunner` (через него идут `CfFileCommandRunner`, `CfeBatchCommandRunner`, список расширений и batch-импорт/обновление);
   - `DbRunCommandRunner` (интерактивный конфигуратор). Он уже согласован через `launchInteractiveDesignerWithAgentPause`.
2. **Команды хранилища не берут `configurationOperationLock`.** Внутри команд вызываются агентские операции (`ensureTargetUpdatedBeforeCommit` → `runUpdate*`, `runPostRepositorySync` → `runApplyDatabaseConfiguration` + `runDecompile*`). Сами раннеры замок не берут, его берут команды верхнего уровня. Поэтому если замок взять на уровне команды хранилища, вложенного захвата не будет.
3. **`mirrorDirectorySnapshot(workspace → проект)` пишет в выгрузку через `fs.copyFileSync`**, а не через `writeFileAtomic`. Это нарушает правило CLAUDE.md «Любой писатель файла выгрузки». Новый движок синхронизации должен писать в проект через `writeFileAtomic`.
4. **`writeFileAtomic(targetPath, data: string)` принимает только строку.** Выгрузка содержит бинарные файлы (`Template.bin`, картинки, `*.png` в `Ext/`), значит нужна перегрузка `string | Uint8Array`.
5. **`HashCache` отслеживает только `*.xml|*.bsl|Template.*`.** Это детектор для частичной загрузки (его использует и CLI). Для «что лежит на сервере» он не годится: картинки, справка и прочее в него не попадают. Нужен отдельный манифест синхронизации по всем файлам. Это файл другого назначения, а не дублирующий реестр.
6. **`RepositoryService.createObjectsFileForNode` пишет `.v8vscedit/repository/objects/*.xml` и никогда не удаляет** — это утечка. Кроме того, в UI вектор хранилища собирается через псевдо-CLI: `extraArgs: ['-ObjectsFile', …]` → `parseExtraArgs` → `buildCommandDesignerArgs`. CLI собирает тот же вектор своим кодом (`cli/commands/repositoryCommands.ts` + `appendRepositoryArgs`). Порядок аргументов в двух местах разный.
7. **`connectAttempts: 8 × 1000 мс` повторяет попытку на любую ошибку**, включая неверный пароль: 8 неудачных входов подряд под 1С-логином.
8. **`AgentWorkspaceService.getAgentFileRoot` жёстко прошит `'0'`; `toAgentPath` считает путь от локального корня.** Удалённый режим это ломает.
9. **Готовой библиотеки для работы с zip в зависимостях нет** (`dependencies`: ssh2, iconv-lite, fast-xml-parser и т.д.).

---

## 1. Целевая архитектура

### 1.1. Модель синхронизации (основа решений b/c)

На каждую цель (cf или cfe/<имя>) в каждом проекте есть четыре сущности:

- **БД** — конфигурация в базе.
- **M** — серверное зеркало: полный каталог выгрузки в персональном корне агента `workspace/<projectId>/cf` или `…/cfe/<имя>`, содержит `ConfigDumpInfo.xml`. Это прямой аналог нынешнего локального `workspace/…`. Сегмент `projectId` (короткий хэш корня проекта) нужен потому, что персональный корень у пользователя один на агента, а одну базу могут открыть два окна или проекта.
- **P** — выгрузка в проекте (`src/cf`, `src/cfe/<имя>`).
- **B** — базовая линия: манифест «отн. путь → sha1» всех файлов P на момент последней успешной синхронизации. Инвариант после любой успешной операции импорта или загрузки: P ≡ M по отслеживаемым файлам, и B = hash(P). Хранится в `.v8vscedit/agent-sync/<sha1(scope)>.json` через `writeFileAtomic` — вне каталога агента по умолчанию `.v8vscedit/agent` (решение Н38).
- Флаг состояния M: `fresh | stale | empty`. Он хранится в том же файле манифеста.

**Импорт (БД → P):**

| Состояние | Действие |
|---|---|
| M `empty` (первый раз) | **Уточнено задачей «потоковый архив и посев».** Одна серверная выгрузка: `dump --archive=exchange/<op>.zip` → скачивание в локальный файл → потоковая распаковка в P через `writeFileAtomic`, исчезнувшие файлы P удаляются. M засевается из архива (`ConfigDumpInfo.xml` + `Configuration.xml`, M `fresh` и `sparse`), B = hash(P). Если в P есть пригодный `ConfigDumpInfo.xml` и пользователь согласился («Использовать выгрузку проекта») — серверной выгрузки нет вовсе: M засевается из проекта, дельта `--get-changes` относительно него, B = hash(P) (ручные правки P после той выгрузки в загрузку «по изменениям» не попадут). Исходная редакция — две выгрузки (полная в M и архивом) — снята. |
| M есть | `dump --dir=M --update --get-changes=exchange/<op>.changes`. Набор C = разбор списка изменений, D = diff(B, P) — локальные правки, которые импорт обязан перетереть, как сейчас перетирает `mirrorDirectorySnapshot`. Получить C∪D из M параллельно (SFTP get, ограничение конкурентности); удалить у себя удалённые объекты из C; файлы, добавленные локально и отсутствующие в M (проверка `stat`), тоже удалить. B = hash(P). |
| \|C∪D\| > `archiveThresholdFiles`, или разбор вернул `unrecognized` / `full` | Ветка архива: `dump --archive` → get → распаковка с удалением исчезнувших. M при этом уже обновлён через `--update`. |

**Загрузка (P → БД):**

| Состояние | Действие |
|---|---|
| diff(B, P) пуст | `skipped` (как сейчас) |
| M `empty` или изменений больше порога | zip всего P локально → SFTP put → `load-config-from-files --archive=exchange/<op>.zip` → `update-db-cfg`; M = `stale`, B = hash(P) |
| M `stale` перед частичной загрузкой | Сначала `dump --dir=M --update` на сервере без скачивания: после загрузки архивом БД ≡ P, поэтому достаточно обновить каркас M. Затем M = `fresh`. |
| обычная частичная | Изменённые и добавленные файлы → SFTP put в M, удалённые → unlink в M; список → `lists/<op>.txt`; `load --partial --list-file --no-check` (без `--update-config-dump-info`: сохраняется существующее решение из комментария в `loadChanged`). Правила «удаление / переименование ⇒ полная загрузка» и `collectConfigFilesForLoad` переиспользуются. Полная загрузка при этом — `load --dir=M` после синхронизации M по манифесту (без архива). |

Для **локального агента** работает тот же движок над локальным хранилищем файлов. Чтобы не получить регресс, пока не подтверждён формат `--get-changes`, локальный режим использует стратегию полного сравнения M и P (хэширование локально дёшево) вместо разбора списка изменений. Нынешнее поведение «импорт = полное зеркалирование» сохраняется по смыслу, но запись идёт через `writeFileAtomic` и только по реально изменённым файлам.

### 1.2. Слои и файлы

#### domain/agent (чистые функции, без fs/path/vscode)

- **`AgentCommand.ts`** (изменение). В `AgentCommandOptions` добавить `archive`, `getChanges`, `configDumpInfoForChanges`, `configDumpInfoOnly`. Добавить построители `buildDisconnectInfoBaseCommand`/`buildConnectInfoBaseCommand` (сейчас это строковые литералы в сервисе). Добавить guard: `update` вместе с `archive` → исключение, потому что в паре они не работают (факт пилота).
- **`AgentBaseDirIndex.ts`** (новый): `parseAgentBaseDirIndex(jsonText): AgentUserDir[]` (снятие BOM, валидация) и `resolveAgentUserDir(index, userName): string | undefined`. Сравнение имён без учёта регистра (`toLocaleLowerCase('ru')`), `dir` проверяется как безопасный сегмент без `..` и разделителей.
- **`AgentConnectPolicy.ts`** (новый, вопрос e):
  ```ts
  type SshConnectFailureKind = 'refused' | 'auth' | 'timeout' | 'network' | 'other';
  interface AgentConnectPolicyOptions { startupTimeoutMs: number; authWarmupMs: number; retryDelayMs: number }
  interface AgentConnectContext {
    attempt: number; now: number; firstAttemptAt: number;
    agentStartedAt?: number;   // t0, известен для локально запущенного агента
    lastRefusedAt?: number;    // последнее наблюдение «порт закрыт» (свидетельство рестарта внешнего агента)
  }
  type AgentConnectDecision =
    | { action: 'retry'; delayMs: number }
    | { action: 'fail'; reason: 'credentials' | 'unreachable' | 'timeout' | 'other' };
  function decideAgentConnectRetry(kind: SshConnectFailureKind, ctx: AgentConnectContext, opts: AgentConnectPolicyOptions): AgentConnectDecision;
  ```
  Правила. Опорная точка `anchor = agentStartedAt ?? lastRefusedAt`.
  - `refused` — повторять, пока `now < (agentStartedAt ?? firstAttemptAt) + startupTimeoutMs`, иначе `unreachable`.
  - `auth` — повторять, только если `anchor` есть и `now < anchor + authWarmupMs`, иначе сразу `credentials` без повторов.
  - `timeout` / `network` — повторять в окне `startupTimeoutMs`, только если `anchor` есть, иначе `timeout`.
  - `other` — сразу ошибка.

  Для внешнего (серверного) агента t0 неизвестен. Окно «прогрева» открывается только тогда, когда мы сами видели `refused`, то есть агент только что поднялся. Если первая же попытка даёт `auth`, это неверные учётные данные: одна попытка, без повторов. Время передаётся параметром, тесты детерминированы.
- **`DumpChangesParser.ts`** (новый, допущение): `parseDumpChanges(text): DumpChangeSet`, где
  `DumpChangeSet = { kind: 'files'; files: {path, change}[] } | { kind: 'objects'; objects: {fullName, change: 'added'|'modified'|'deleted'}[] } | { kind: 'unrecognized' }`.
  До получения образца парсер распознаёт только явно заданную грамматику и для всего остального возвращает `unrecognized`, а движок уходит в ветку архива. Это точка подтверждения образцом: тест фиксирует реальный образец как фикстуру `src/test/fixtures/agent/get-changes-*.txt`.
- **`SyncPlanner.ts`** (новый, чистый): `planImport(input): ImportPlan` и `planLoad(input): LoadPlan` поверх данных: B, текущий P (словари хэшей), `DumpChangeSet`, состояние M, порог. Переименования и удаления в загрузке — через существующую `detectPotentialRename`. Она сейчас в `infra/agent/ConfigLoadFileCollector.ts` и чистая; перенос не нужен, планировщик может жить в `infra/agent/sync/` и импортировать её оттуда.

#### infra/agent (развитие существующей подсистемы, без «v2»)

**Транспорт и готовность**
- **`SshConnectErrorClassifier.ts`** (новый): `classifySshConnectError(error): SshConnectFailureKind`. Признаки ssh2: `level === 'client-authentication'` → `auth`; `code === 'ECONNREFUSED'` → `refused`; `level === 'client-timeout'` → `timeout`; `ECONNRESET`/`EHOSTUNREACH`/`ETIMEDOUT` → `network`.
- **`ProcessDesignerAgentTransport.ts`** (изменение).
  - Фабрика заменяет цикл `connectAttempts` на `decideAgentConnectRetry`. Внедряются `clock: () => number` и `sleep`. Фабрика хранит `lastRefusedAt` (состояние на конечную точку) и принимает `agentStartedAt` от `DesignerAgentProcess`.
  - Новый метод транспорта `openSftp(): Promise<SFTPWrapper>` на том же `Client`: shell-канал и подсистема sftp в одном соединении, без второго входа. Запасной вариант — отдельное соединение, если пилот покажет, что агент не даёт sftp в той же сессии.
  - `DesignerAgentConnectionOptions`: `connectAttempts`/`connectRetryDelayMs` → `policy: AgentConnectPolicyOptions`.
- **`DesignerAgentProcess.ts`** (изменение): запоминать `startedAt` в `start()` и отдавать его через `getStartedAt()`.

**Жизненный цикл подключения ИБ (вопрос d)**
- **`AgentInfoBaseSession.ts`** (новый, выносится из `AgentOperationService`, реализует уже существующий `DesignerAgentInfoBaseSession`).
  ```ts
  class AgentInfoBaseSession implements DesignerAgentInfoBaseSession {
    constructor(transports: ResettableDesignerAgentTransportFactory, options: { idleDisconnectMs: number; timers: TimerApi; clock: () => number })
    run<T>(op: (exec: AgentCommandExecutor) => Promise<T>, hooks?): Promise<T>; // сериализация, ленивый connect-ib, БЕЗ disconnect после успеха
    disconnectInfoBase(hooks?, { force? }): Promise<boolean>;                    // явная точка «отпустить базу»
    reconnectInfoBase(hooks?): Promise<void>;
    isInfoBaseConnected(): boolean;
    dispose(): Promise<void>;
  }
  ```
  - После успешной операции соединение остаётся (SSH и ИБ), запускается idle-таймер.
  - При ошибке поведение консервативное, как сейчас: попытка `disconnect-ib` (ошибка «не подключено» проглатывается), затем сброс SSH-сессии, состояние `disconnected`.
  - При неожиданном закрытии канала состояние становится `unknown`; следующий `connect-ib` переносит ответ «уже подключено» (`isInfoBaseAlreadyConnectedMessage` уже есть).
- **`BatchDesignerGuard.ts`** (новый): `runWithInfoBaseReleased<T>(session: DesignerAgentInfoBaseSession | undefined, op, hooks)`. Делает `disconnect-ib` (с `force` для внешнего агента, состояние которого неизвестно после перезапуска VS Code), выполняет пакетную операцию и **не** переподключает: переподключение ленивое, при следующей агентской операции. Это единственная функция, которую вызывают все пакетные исполнители.
- **`AgentOperationService.ts`** (изменение, остаётся тонким фасадом). `importFromDatabase` / `loadFullAndUpdate` / `loadChangedAndUpdate` / `updateDatabaseConfiguration` делегируют в `AgentInfoBaseSession.run` и `AgentSyncEngine`. Убрать `runInfoBaseOperation` с `finally`-disconnect, флаг `connected` и `ensureWorkspaceMirrored` (переезжают в движок).
- **`InteractiveDesignerLauncher.ts`** — без изменения контракта. Переподключение после интерактивного конфигуратора делать не нужно: оно станет ленивым. Тест закрепляет новое поведение (сейчас там «reconnect on exit»). Решение: оставить reconnect-on-exit как есть, потому что он совместим.

**Хранилище файлов рабочей области агента (вопрос a)**
- **`files/AgentFileStore.ts`** (новый интерфейс; все пути — относительные POSIX-пути от персонального корня):
  ```ts
  interface AgentFileEntry { readonly path: string; readonly type: 'file' | 'dir'; readonly size: number }
  interface AgentFileStore {
    readonly kind: 'local' | 'sftp';
    stat(rel: string): Promise<AgentFileEntry | undefined>;
    readFile(rel: string): Promise<Buffer>;
    writeFile(rel: string, data: Uint8Array | string): Promise<void>;   // mkdir -p внутри; запись temp+rename на стороне хранилища
    remove(rel: string, options?: { recursive?: boolean }): Promise<void>;
    list(relDir: string, options?: { recursive?: boolean }): Promise<AgentFileEntry[]>;
    mkdirp(rel: string): Promise<void>;
    dispose(): Promise<void>;
  }
  ```
- **`files/LocalAgentFileStore.ts`** (новый): корень `<AgentBaseDir>/<dir>`. `dir` берётся из `agentbasedir.json` через `resolveLocalAgentUserRoot(agentBaseDir, userName)`; файл читается после первого успешного SSH-входа, потому что индекс назначается при первом входе. Если пользователь не найден — явная ошибка с путём к файлу и логином.
- **`files/SftpAgentFileStore.ts`** (новый): поверх `SFTPWrapper`. SFTP-корень уже персональный, индекс не нужен. Особенности SFTP v3: `rename` не перезаписывает — пишем во временное имя, удаляем цель, переименовываем; если пилот покажет, что агент не поддерживает rename, пишем прямо в цель. `mkdirp` поэлементно с кэшем созданных каталогов.
- **`files/AgentFileTransfer.ts`** (новый): `downloadFiles(store, rels, sink, { concurrency, onProgress, cancellation })` и `uploadFiles(...)` с ограничением конкурентности. На пинге 80 мс по умолчанию 16 одновременных запросов.
- **`AgentWorkspaceService.ts`** (изменение): становится чистой раскладкой относительных путей (`workspace/<projectId>/cf|cfe/<имя>`, `lists/`, `exchange/`). `ensureWorkspace` → `store.mkdirp`, `writeListFile` → `store.writeFile('lists/<op>.txt', BOM+строки через \n)`. `getAgentFileRoot`/`toAgentPath` и хардкод `'0'` удаляются. `normalizeRelativeFilePath`/`sanitizePathPart` остаются.
- **`DirectorySnapshot.ts`** — остаётся локальной утилитой (её используют и другие места), из агентского пути больше не вызывается. `collectSnapshotProjectFiles` заменяется результатом планировщика (список изменённых файлов проекта для `onProjectFilesWillChange`).

**Движок синхронизации**
- **`sync/SyncManifest.ts`** (новый): `buildSyncManifest(dir)` (все файлы, sha1) и `load`/`save` манифеста в `.v8vscedit/agent-sync/<sha1(scope)>.json` через `writeFileAtomic`, вместе с флагом состояния M.
- **`sync/SyncPlanner.ts`** (новый, чистый, см. выше).
- **`sync/ChangedObjectFiles.ts`** (новый): если формат `--get-changes` окажется «по объектам», полное имя переводится в папку через `META_TYPES` (`englishKind`/`folder`), без параллельного словаря; затем `store.list` поддерева объекта и `<Folder>/<Имя>.xml`.
- **`sync/ArchiveCodec.ts`** (новый): потоковая распаковка zip в приёмник (каждый элемент → `writeFileAtomic`) и упаковка каталога в zip. Нужна новая зависимость — см. открытые вопросы. Имена элементов декодируются с учётом флага UTF-8 (бит 11), иначе cp866 через iconv-lite — кириллица в именах файлов выгрузки.
- **`sync/AgentSyncEngine.ts`** (новый): `importTarget(target, exec, hooks)` и `loadTarget(target, mode, exec, hooks)`. Исполняет планы через `AgentFileStore`, команды агента и `writeFileAtomic`. Перед записью в проект вызывает `onProjectFilesWillChange(changed)` — сохраняется существующий механизм подавления своих файловых событий. Затем обновляет HashCache и MetadataCache (как `refreshCaches`).

**infra/fs**
- **`AtomicFileWriter.ts`** (изменение): `writeFileAtomic(targetPath, data: string | Uint8Array)`. Семантика temp+rename не меняется.

#### infra/process и infra/repository (вопрос f)

- **`infra/process/designer/DesignerBatchExecutor.ts`** (новый интерфейс):
  ```ts
  type DesignerArg = string | { kind: 'inputFile'; name: string; content: string | Uint8Array } | { kind: 'outputFile'; name: string };
  interface DesignerBatchRequest {
    readonly args: readonly DesignerArg[];        // БЕЗ исполняемого файла и БЕЗ /Out — их добавляет исполнитель
    readonly secrets: readonly string[];          // значения для маскирования в логе
    readonly cancellation?: CancellationLike;
    readonly onOutput?: (line: string) => void;
  }
  interface DesignerBatchResult {
    readonly exitCode: number; readonly interrupted?: string; readonly log: string;
    readonly outputs: ReadonlyMap<string, string>;   // имя → ЛОКАЛЬНЫЙ staging-путь выходного файла
  }
  interface DesignerBatchExecutor { run(request: DesignerBatchRequest): Promise<DesignerBatchResult>; dispose(): Promise<void> }
  ```
- **`infra/process/designer/LocalDesignerBatchExecutor.ts`** (новый): временный каталог, входные файлы пишутся туда, `/Out <tmp>/out.log /DisableStartupDialogs`, `runProcess`, декодирование лога, удаление временного каталога в `finally`.
- **`infra/process/OutputDecoder.ts`** (изменение): сюда переезжает `decodeLogFile` из `RepositoryCommandRunner` (BOM UTF-16LE/BE/UTF-8, эвристика cp866/1251) — `decodeDesignerLogBytes`.
- **`infra/process/WindowsCommandLine.ts`** (новый, чистый): `quoteWindowsCommandLineArg` по алгоритму libuv (`quote_cmd_arg`). Это тот же алгоритм, что применяет Node `spawn` локально, поэтому удалённый 1cv8 получит байт-в-байт ту же командную строку, что локальный.
- **`infra/repository/RepositoryDesignerArgs.ts`** (новый, **единый построитель**, устраняет дубль UI/CLI):
  ```ts
  type RepositoryOperation =
    | { kind: 'create'; allowConfigurationChanges?; changesAllowedRule?; changesNotRecommendedRule?; noBind? }
    | { kind: 'bind'; forceBindAlreadyBindedUser?; forceReplaceCfg? } | { kind: 'unbind'; force? }
    | { kind: 'lock'; objectsXml?: string; revised? } | { kind: 'unlock'; objectsXml?: string; force? }
    | { kind: 'commit'; objectsXml?: string; comment?; keepLocked?; force? }
    | { kind: 'update'; objectsXml?: string; version?; force? }
    | { kind: 'addUser'; user; password?; rights?; restoreDeletedUser? }
    | { kind: 'copyUsers'; path; user; password?; restoreDeletedUser? }
    | { kind: 'dump'; version? } | { kind: 'report'; …; reportFormat? } | { kind: 'setLabel'; name; version?; comment? };
  function buildRepositoryDesignerRequest(connection: InfoBaseConnection, binding: RepositoryBinding, op: RepositoryOperation, extensionName?: string): DesignerBatchRequest;
  ```
  - `ObjectsFile` передаётся **содержимым**: `{kind:'inputFile', name:'objects.xml', content}`.
  - У `dump`/`report` выходной `-File` объявлен как `{kind:'outputFile'}`; вызывающий переносит staging-файл на выбранный путь только при `exitCode === 0` (паттерн `resolveDumpStagingPath`).
  - `secrets` — пароль БД, пароль хранилища, `-Pwd` пользователя.
  - Сюда же переезжает общая функция аргументов подключения к ИБ (`/S|/F`, `/N`, `/P`) — сейчас она продублирована (`appendConnectionDesignerArgs` в UI и `appendConnectionArgs` в CLI).
- **`RepositoryService.ts`** (изменение): `createObjectsFileForNode` → `buildObjectsSelectionForNode(node, recursive): { xml: string; fullNames: string[] }` без записи на диск. Это устраняет утечку `.v8vscedit/repository/objects`.
- **`cli/commands/repositoryCommands.ts`** + **`cli/core/onecCommon.ts`** (изменение): CLI разбирает свои аргументы в `RepositoryOperation`; `-ObjectsFile <path>` читается в `objectsXml`. Запуск — через `LocalDesignerBatchExecutor`. `appendRepositoryArgs` либо становится тонким re-export, либо удаляется.

**Удалённый исполнитель (PowerShell Remoting)** — `infra/process/remote/`:
- **`PowerShellHostScript.ts`**: текст host-скрипта как TS-константа. Доставляется через `-EncodedCommand` (UTF-16LE base64); тест закрепляет длину меньше 30 000 символов. Запуск:
  `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand …`.
  Что делает скрипт:
  - выставляет `[Console]::InputEncoding/OutputEncoding = UTF8 без BOM`, `$ProgressPreference='SilentlyContinue'`;
  - читает stdin построчно через `ReadLineAsync`, поэтому во время ожидания процесса может опрашивать строку отмены;
  - на `connect` делает `New-PSSession` (`-ComputerName`, `-Authentication`, `-UseSSL`, `-Port`, `-Credential`, если передан). Если `computerName` пуст, сессии нет, скрипт-блоки исполняются в процессе. **Это режим для тестов**: без WinRM тот же протокол работает на локальном `powershell.exe`.
- **`PowerShellHostProtocol.ts`** (чистый): кодирование запросов и разбор ответов. Каждая строка ответа имеет префикс-маркер `@@V8VSC@@`, всё остальное считается шумом и уходит в лог. Тело — JSON `{id, event, …}`. Операции:
  - `connect{computerName,user,passwordB64,authentication,useSsl,port}` — пароль передаётся только через stdin, не в командной строке;
  - `mktemp → {dir}` — `%TEMP%\v8vscedit-<guid>` на сервере, при `connect` заодно чистятся «осиротевшие» каталоги старше суток;
  - `put{dir,name,contentB64}`;
  - `resolveV8{v8Path|v8Version} → {path}` — `Test-Path`;
  - `run{exe, commandLine}` → `started{pid}` … `exit{code, logB64}`; `Process.Start` с уже собранной в TS командной строкой; ожидание порциями `WaitForExit(1000)` с проверкой строки `cancel{id}`; при отмене — `Stop-Process -Id pid -Force`;
  - `fetch{remotePath, localPath}` — `Copy-Item -FromSession` в локальный staging;
  - `rmtemp{dir}`;
  - `ping`.

  Ошибки возвращаются как `error{message}`. При разрыве сессии — `sessionBroken`.
- **`PowerShellRemoteHost.ts`**: долгоживущий процесс. Запускается лениво, запросы идут последовательной очередью. При `sessionBroken` или выходе процесса — один перезапуск на следующем запросе. `dispose` закрывает stdin и сессию (`Remove-PSSession`).
- **`RemoteDesignerBatchExecutor.ts`**: реализует `DesignerBatchExecutor` так:
  1. `mktemp`;
  2. `put` входных файлов;
  3. подстановка серверных путей вместо `inputFile`/`outputFile` и `/Out <dir>\out.log`;
  4. `quoteWindowsCommandLineArg` → `run`;
  5. `fetch` выходных файлов;
  6. в `finally` — `rmtemp`.

  Лог локально: `formatCommandLineForLog(exe, args, secrets)` — то же маскирование, что сейчас.

#### ui

- **`ui/commands/ext/agent/`** (новый подкаталог, вынос из God-файла `ExtensionCommandRunner.ts`, ~1940 строк). Без изменения поведения на первом шаге:
  - `agentSettings.ts` — `readAgentCommandSettings`, `splitAgentModeArgs`, чтение `v8vscedit.remote.*`;
  - `AgentServiceRegistry.ts` — кэш `agentServices`, `ensureAgentService`, `getCachedAgentOperationService`, `getAgentOperationServiceForInteractiveDesigner`, `startAgentOperationService`, `createAgentOperationServiceEntry`, `disposeCachedAgentOperationServices`;
  - `ExtensionCommandRunner.ts` реэкспортирует публичный API, чтобы импорты потребителей не менялись.
  - Новое в реестре: выбор `AgentFileStore` (local/sftp) и функция `releaseAgentInfoBaseForBatch(workspaceFolder, output)`. Если сервис закэширован — `disconnectInfoBase`. Иначе, если режим agent и порт агента открыт (внешний агент), — создать сервис и `disconnectInfoBase({force:true})`. Обобщается нынешний `getAgentOperationServiceForInteractiveDesigner`.
- **`ui/commands/ext/designerExecutorRegistry.ts`** (новый): `getDesignerBatchExecutor(workspaceFolder)` возвращает `LocalDesignerBatchExecutor` или (при `agent.location=remote`) закэшированный `RemoteDesignerBatchExecutor`. Освобождение — в `disposeCachedAgentOperationServices`.
- **`RepositoryCommandRunner.ts`** (изменение):
  - `runRepositoryCliCommand` строит `RepositoryOperation` → `buildRepositoryDesignerRequest` → `runWithInfoBaseReleased(...)` → `executor.run(...)`;
  - `withProgress` и отмена через `cancellation` сохраняются;
  - `buildCommandDesignerArgs`/`parseExtraArgs`/`appendConnectionDesignerArgs`/`appendRepositoryDesignerArgs`/`decodeLogFile` удаляются; файл заметно похудеет.
- **`RepositoryCommands.ts`** (изменение): каждая мутирующая команда хранилища берёт `configurationOperationLock`, а составные сценарии (`ensureTargetUpdatedBeforeCommit` + commit; update + `runPostRepositorySync`) — как одну критическую секцию. Уведомления внутри секции — без `await` (запрет №18). `dump`/`report` переносят staging-файл на выбранный путь.
- **`ExtensionCommandRunner.runInternalCliCommand`** (изменение): перед спавном CLI с пакетным конфигуратором — `releaseAgentInfoBaseForBatch`. Это покрывает `CfFileCommandRunner`, `CfeBatchCommandRunner`, список расширений и batch-импорт.
- **`DbRunCommandRunner.ts`** (изменение): если идёт операция (`isConfigurationOperationRunning()`), сообщить и отказать, вместо того чтобы отключать агента посреди операции.
- **Новые команды:**
  - `v8vscedit.agent.releaseInfoBase` — «Отключить агента конфигуратора от базы»: явная точка отключения;
  - `v8vscedit.remote.checkConnection` — «Проверить подключение к серверу 1С»: SSH-вход, SFTP запись/чтение/удаление пробного файла в `exchange/`, PS-сессия, путь к 1cv8, `ping`.

  Каждая — класс в `ui/commands/...` + `CommandRegistry.registerAll` + `package.json → contributes.commands`.
- **`Container.ts`**: `onDidChangeConfiguration` по `v8vscedit.agent.*` / `v8vscedit.remote.*` сбрасывает кэши сервисов и исполнителей (`disposeCachedAgentOperationServices`).

### 1.3. Настройки и секреты (вопрос g)

Существующие `v8vscedit.agent.*` сохраняются. Новое:

| Ключ | Тип / по умолчанию | Смысл |
|---|---|---|
| `v8vscedit.agent.location` | `local`\|`remote`, `local` | `remote`: агент работает на сервере, `autoStart` игнорируется, файлы — SFTP, пакетные операции — через PSSession |
| `v8vscedit.agent.authWarmupMs` | 90000 | окно повтора auth-ошибок после старта агента или после наблюдения `refused` |
| `v8vscedit.agent.idleDisconnectMinutes` | 0 (выкл.) | авто-`disconnect-ib` после простоя |
| `v8vscedit.agent.transferConcurrency` | 16 | параллельные SFTP-передачи |
| `v8vscedit.agent.archiveThresholdFiles` | 300 | порог «по файлам / архивом» |
| `v8vscedit.remote.computerName` | `""` (= `agent.host`) | WinRM-хост |
| `v8vscedit.remote.authentication` | `Default`\|`Negotiate`\|`Kerberos`, `Default` | `-Authentication` |
| `v8vscedit.remote.user` | `""` (= текущий пользователь Windows) | при заполнении пароль берётся из SecretStorage |
| `v8vscedit.remote.useSsl`, `v8vscedit.remote.port` | false, 0 | WinRM HTTPS / порт |
| `v8vscedit.remote.v8Path` | `""` | путь к `1cv8.exe` **на сервере**; если пусто — выводится из `--v8version` из env.json и проверяется на сервере через `Test-Path` |
| `v8vscedit.remote.ibConnection` | `""` | необязательная замена `--ibconnection`, если с сервера кластер адресуется иначе |

- Режим выбирается так: `configuration.operationMode=agent` + `agent.location=remote`. При `operationMode=batch` + `location=remote` выводится явная ошибка конфигурации, а не молчаливый откат на локальный режим.
- Секреты:
  - пароль SSH агента = пароль БД (как сейчас, `resolveDbPassword`);
  - пароль PS-учётки — новые методы `ProjectSecretStorage.getRemotePassword/setRemotePassword` с префиксом ключа `remote-`;
  - пароли хранилища — как сейчас.

  В `settings.json`/env.json ничего не пишется. Описания настроек — на русском.

### 1.4. Решение по MCP (вопрос h)

- **Новых MCP-инструментов в этой задаче нет.**
  - Существующие инструменты `McpConfigLifecycleTools` (импорт / обновление / применение) идут через те же раннеры и автоматически получают удалённый режим, новый жизненный цикл и замок — это и есть «один и тот же код».
  - Хранилище в MCP не публикуется, обоснование фиксируется в `docs/architecture.md` (раздел про удалённый сервер). Операции хранилища меняют **общий для команды** внешний ресурс: захваты блокируют коллег, помещение необратимо пишет в историю. Им нужны интерактивный комментарий и подтверждение «обновить перед помещением». Кроме того, они требуют пароль хранилища, который MCP-клиент передавать не должен.
  - Отключение агента — служебное действие, не мутация конфигурации.
- Если пользователь захочет, следующим этапом можно добавить read-only `repository_status` (локальный учёт захватов).

---

## 2. Этапы (каждый проходит test-writer → developer → qa-e2e → reviewer; система после каждого рабочая)

**Э0. Пилот-сбор образцов (пользователь, вне конвейера; блокирует Э7 частично и Э9 частично).** Снять на реальном сервере:
1. файл `--get-changes` для cf и cfe с добавлением, изменением и удалением объекта, плюс формы и макета;
2. архив `dump --archive`: формат (zip?), кодировка кириллических имён, есть ли внутри `ConfigDumpInfo.xml`;
3. работает ли `dump --update` в каталоге с `ConfigDumpInfo.xml` после `load --archive`;
4. переживает ли подключение ИБ сброс SSH-сессии (если нет — SSH обязан жить между операциями, что план и так делает);
5. даёт ли агент подсистему `sftp` в том же соединении, что и shell, и работают ли SFTP `rename`, `mkdir`, `remove` и кириллица в путях;
6. принимает ли `--list-file` BOM UTF-8 + LF;
7. есть ли на сервере PS 5.1 / WinRM и какой `-Authentication` проходит.

**Э1. Единый построитель аргументов хранилища + интерфейс пакетного исполнителя (локальный).**
- Файлы: `infra/repository/RepositoryDesignerArgs.ts`, `infra/process/designer/{DesignerBatchExecutor,LocalDesignerBatchExecutor}.ts`, `infra/process/OutputDecoder.ts` (`decodeDesignerLogBytes`), `RepositoryService.buildObjectsSelectionForNode`, `RepositoryCommandRunner.ts`, `cli/commands/repositoryCommands.ts`, `cli/core/onecCommon.ts`.
- Поведение для пользователя не меняется, кроме устранения утечки `objects/*.xml` и единого порядка аргументов.
- Почему первым: это низкорисковый рефакторинг. Он создаёт шов `DesignerBatchExecutor` для Э9 и точку для guard в Э4.

**Э2. Декомпозиция агентской части `ExtensionCommandRunner` (без изменения поведения).**
- Сначала characterization-тесты на `splitAgentModeArgs`, чтение настроек (в т.ч. значения по умолчанию) и кэш сервисов (TOCTOU, удаление ключа при отказе). Затем перенос в `ui/commands/ext/agent/{agentSettings,AgentServiceRegistry}.ts` с реэкспортом.
- Почему здесь: дальше этот код будет расти (location, хранилище, release). Наращивать God-файл запрещено (запрет №17).

**Э3. Политика готовности SSH.**
- `domain/agent/AgentConnectPolicy.ts`, `infra/agent/SshConnectErrorClassifier.ts`, фабрика в `ProcessDesignerAgentTransport.ts`, `DesignerAgentProcess.getStartedAt`, настройка `agent.authWarmupMs`, `AgentServiceRegistry` передаёт `agentStartedAt`.
- Сразу снимает реальную боль: 8 входов с неверным паролем и «Permission denied» после старта.

**Э4. Жизненный цикл подключения ИБ + согласование с пакетными операциями.**
- `infra/agent/{AgentInfoBaseSession,BatchDesignerGuard}.ts`, `AgentOperationService.ts` (убрать `finally`-disconnect), `AgentServiceRegistry.releaseAgentInfoBaseForBatch`.
- Guard подключается в `RepositoryCommandRunner`, `runInternalCliCommand`, `DbRunCommandRunner`.
- Замок `configurationOperationLock` — в `RepositoryCommands`.
- Idle-таймер и настройка `agent.idleDisconnectMinutes`; команда `v8vscedit.agent.releaseInfoBase`.
- Цикл «загрузить → обновить БД → загрузить» перестаёт платить connect-ib уже в **локальном** режиме агента — выгода до удалённой части.

**Э5. `AgentFileStore` + локальная реализация + персональный корень из `agentbasedir.json`.**
- `domain/agent/AgentBaseDirIndex.ts`, `infra/agent/files/{AgentFileStore,LocalAgentFileStore,AgentFileTransfer}.ts`, `AgentWorkspaceService.ts` поверх хранилища, сегмент `projectId`.
- `AgentOperationService` пока использует хранилище в существующем алгоритме (полное зеркалирование), поведение сохраняется. Хардкод `'0'` удаляется.

**Э6. SFTP-хранилище.**
- `infra/agent/files/SftpAgentFileStore.ts`, `ProcessDesignerAgentTransport.openSftp()`.
- Тесты на in-process `ssh2.Server` с настоящим SFTP.
- В продукт пока не подключается (используется только в Э8), но полностью протестировано.

**Э7. Движок синхронизации (дельта-импорт / дельта-загрузка / архив).**
- `infra/fs/AtomicFileWriter.ts` (Uint8Array), `domain/agent/DumpChangesParser.ts`, `infra/agent/sync/{SyncManifest,SyncPlanner,ChangedObjectFiles,ArchiveCodec,AgentSyncEngine}.ts`, `AgentCommand.ts` (archive/getChanges + guard update×archive), `AgentOperationService` → движок.
- Локальный режим переходит на движок со стратегией полного сравнения M и P. Запись в проект теперь через `writeFileAtomic`, что закрывает долг из п.0.3.
- Если образца `--get-changes` ещё нет, парсер возвращает `unrecognized`, а удалённый импорт всегда идёт архивом. Это корректно, только медленнее. Когда образец появится, отдельным коротким проходом добавляется грамматика и фикстура.

**Э8. Удалённый режим агента (подключение к UI).**
- Настройки `agent.location`, `agent.transferConcurrency`, `agent.archiveThresholdFiles`.
- `AgentServiceRegistry`: при `remote` — без `autoStart`, хранилище SFTP, `agentStartedAt` неизвестен (политика из Э3).
- `Container` подписан на изменение настроек. Команда `v8vscedit.remote.checkConnection` (часть SSH/SFTP).

**Э9. PowerShell-хост и удалённые операции хранилища.**
- `infra/process/WindowsCommandLine.ts`, `infra/process/remote/{PowerShellHostScript,PowerShellHostProtocol,PowerShellRemoteHost,RemoteDesignerBatchExecutor}.ts`, `ui/commands/ext/designerExecutorRegistry.ts`, настройки `remote.*`, `ProjectSecretStorage.get/setRemotePassword`, вторая половина `checkConnection` (PS + путь к 1cv8).
- `RepositoryCommands`: staging выходных файлов `dump`/`report`.

**Э10. Документатор. — ВЫПОЛНЕНО (2026-11-18).**
- `docs/architecture.md`: раздел «Удалённый сервер 1С» — модель M/P/B, жизненный цикл ИБ, guard, обоснование «нет MCP для хранилища», протокол PS-хоста.
- CLAUDE.md: пункт «Инварианта изменений» — «Новая пакетная операция Конфигуратора обязана идти через `DesignerBatchExecutor` + `runWithInfoBaseReleased`», раскладка `infra/agent/files|sync`, `infra/process/designer|remote`.
- Фактически: раздел архитектуры + пользовательская инструкция `docs/remote-designer.md` (настройка, команды, ошибки, чек-лист пилота) + ссылки из README/architecture. В CLAUDE.md пункт сформулирован через `DesignerBatchExecutor` + `releaseAgentInfoBaseForBatch` (не `runWithInfoBaseReleased`, Н17), добавлен запрет №19 (`rmSync` и кириллица, §5b п.17). Расхождения плана с кодом: ветка `FullDump` импорта идёт архивом (рекомендация §5b п.9 про скачивание только `ConfigDumpInfo.xml` не реализована); CF/CFE и интерактивный Конфигуратор в remote остаются локальными (Н51), а не через `DesignerBatchExecutor`.

**Обоснование порядка.** Сначала рефакторинги-швы без смены поведения (Э1, Э2). Затем изменения, полезные и в локальном режиме (Э3, Э4) — их проще проверить у пользователя локально. Потом инфраструктура файлов (Э5, Э6), которая не трогает UI до готовности. Затем самое рискованное и зависящее от образцов (Э7). Удалённая проводка (Э8) — после того как все части протестированы. PS-хост (Э9) последним: он независим по коду, но без удалённого агента смысла не имеет (disconnect удалённого агента нужен из Э8). Э9 можно вести параллельно с Э7, если два потока конвейера допустимы.

---

## 3. Риски и их снятие

| Риск | Снятие | Где проверяется |
|---|---|---|
| Неизвестен формат `--get-changes` | Парсер за интерфейсом, `unrecognized` → архив; фикстура из образца | Э0 пилот, затем unit |
| Архив не zip или кириллица в именах в cp866 | `ArchiveCodec` учитывает флаг UTF-8 и падает в cp866; тест на zip с обоими вариантами имён | Э0 + unit |
| SFTP агента не поддерживает rename / sftp в общем соединении | Запасные режимы в `SftpAgentFileStore` (прямая запись; отдельное соединение), выбор настройкой или автоопределением по первой ошибке `OP_UNSUPPORTED` | Э0 + тест на `ssh2.Server`, где rename отключён |
| Постоянный connect-ib держит сеанс и лицензию, блокирует коллег | Явная команда release, idle-таймер, авто-release перед любым пакетным запуском | unit на таймеры (внедрённые timers/clock) |
| Подключение ИБ не переживает сброс SSH | SSH живёт между операциями; при неожиданном закрытии — состояние `unknown`, `connect-ib` терпит «уже подключено» | Э0 + unit |
| После перезапуска VS Code внешний агент остаётся подключённым к ИБ | `releaseAgentInfoBaseForBatch` с `force` при открытом порте | unit + пилот |
| Два окна VS Code (замок только внутри процесса) | Сегмент `projectId` в M; межпроцессная блокировка — вне объёма, фиксируется как известное ограничение | doc |
| Кавычки в паролях в командной строке 1cv8 на сервере | Один алгоритм квотирования (libuv) локально и удалённо; табличный тест на `"`, `\`, пробелы, кириллицу | unit + пилот |
| «Осиротевший» 1cv8 на сервере при отмене или разрыве | pid в `started`, `Stop-Process` при отмене; уборка `%TEMP%\v8vscedit-*` при `connect` | тест на локальном powershell + пилот |
| WinRM MaxEnvelopeSize и большие файлы `.cf` | Выходные файлы — через `Copy-Item -FromSession` (передача кусками), а не base64 в ответе; base64 только для лога и ObjectsFile | пилот на `.cf` 100+ МБ |
| Кодировки PS stdin/stdout | UTF-8 выставляется явно в host-скрипте, JSON + маркер, лог 1cv8 передаётся байтами (base64) и декодируется существующей эвристикой | тест на локальном powershell с кириллицей |
| Регресс локального режима агента на Э7 | Стратегия полного сравнения для локального хранилища; существующие тесты `agentOperationService.test.ts` адаптируются, а не удаляются | qa-e2e |
| Пароль виден в списке процессов сервера | Так же, как локально сегодня (ограничение платформы); фиксируется в doc | — |

### Как тестировать без моков (CLAUDE.md п.3 TDD)

- **SSH/SFTP — по-настоящему.** Вспомогательный модуль `src/test/suite/support/agentSshTestServer.ts`: in-process `ssh2.Server` на `127.0.0.1:0`, ключ хоста генерируется `ssh2.utils.generateKeyPairSync`, SFTP-обработчики (OPEN/READ/WRITE/CLOSE/STAT/LSTAT/MKDIR/RMDIR/REMOVE/RENAME/OPENDIR/READDIR/REALPATH) отображаются на временный каталог `fs.mkdtempSync`.
  - Shell-канал — **эмулятор агента 1С** (сам агент — внешняя недоступная система, эмулятор допустим, обоснование в шапке модуля). Он отвечает JSON-протоколом на `options set`, `common connect-ib`/`disconnect-ib`, `config dump-config-to-files` (пишет файлы в тот же временный корень, поддерживает `--update`/`--get-changes` по формату фикстуры и `--archive`), `load-config-from-files` (фиксирует принятый список), `update-db-cfg`.
  - Сценарии аутентификации: отказ в окне N мс после старта сервера; всегда отказ; `ECONNREFUSED` — сервер ещё не слушает.
- **Политика готовности** — чистая функция плюс один интеграционный тест на `ssh2.Server` с отказом в первые 300 мс и внедрёнными часами.
- **PowerShell-хост** — настоящий `powershell.exe` без удалённой сессии (`computerName=''`, скрипт-блоки исполняются в процессе) и поддельный `1cv8` в виде `.cmd` во временном каталоге. `.cmd` пишет свои аргументы в файл `/Out` (вариантами UTF-16LE с BOM и cp1251), создаёт выходной файл `-File` и выходит с заданным кодом. Сьют только для Windows (`suiteSetup` → `this.skip()` на других платформах, с обоснованием). Удалённая часть (`New-PSSession`, Kerberos, `Copy-Item -FromSession` через сеть) проверяется только пилотом.
- **Жизненный цикл ИБ** — через существующий паттерн `FakeTransportFactory` (внешний агент), с записью последовательности команд.

---

## 4. Критерии приёмки и тесты по этапам (один проход test-writer на этап)

**Э1**
- Точный регресс-тест вектора `buildRepositoryDesignerRequest` по каждому `kind` из 12 и по всем комбинациям флагов: параметризация по таблице «операция × флаги → ожидаемый вектор», включая `-Extension`, отсутствие `/P`, если пароль пуст, отсутствие `-Objects`, если `objectsXml` не задан, и ошибку для `dump`/`report` без выходного файла.
- `secrets` содержит ровно пароль БД, пароль хранилища и `-Pwd`; маскирование в `formatCommandLineForLog` — проверка, что значения не утекают.
- `LocalDesignerBatchExecutor` на реальном поддельном `.cmd` (Windows):
  - входной файл создан с нужным содержимым и удалён после выполнения;
  - `/Out` прочитан и декодирован (UTF-16LE BOM / UTF-8 BOM / cp1251);
  - выходной файл попадает в staging;
  - ненулевой код → `exitCode`; отмена → `interrupted`;
  - временный каталог удаляется и на ошибке.
- `buildObjectsSelectionForNode` ничего не пишет на диск (тест на временном проекте); XML совпадает с прежним `createObjectsFileForNode` (golden на 3 видах узлов: корень, объект, рекурсивный).
- CLI `repository-*` строит тот же вектор, что UI, при эквивалентных аргументах; `-ObjectsFile` читается в содержимое.
- `decodeDesignerLogBytes`: 4 ветки BOM + эвристика.

**Э2**
- Characterization: `splitAgentModeArgs` (кавычки, экранирование, незакрытая кавычка → ошибка); `readAgentCommandSettings` (значения по умолчанию, `user` из env); `ensureAgentService` (параллельный вызов → один старт; отказ → ключ удалён); `getCachedAgentOperationService` до и после резолва.
- Публичные экспорты `ExtensionCommandRunner` не изменились (тест импорта символов).

**Э3**
- `decideAgentConnectRetry` — таблица: `kind ∈ {refused, auth, timeout, network, other}` × `anchor ∈ {agentStartedAt, lastRefusedAt, нет}` × `now ∈ {внутри окна, на границе, после окна}` → ожидаемое решение.
- `classifySshConnectError` — по каждому признаку ssh2 и неизвестный объект или строка.
- Фабрика на `ssh2.Server`:
  - auth-отказ в окне прогрева → успех со второй попытки;
  - auth-отказ без опорной точки → ровно одна попытка и ошибка `credentials` (счётчик входов на сервере = 1);
  - `refused` → повтор до открытия порта;
  - `refused` дольше `startupTimeoutMs` → `unreachable`.

**Э4**
- Последовательность команд на фейковом транспорте:
  - load → update → load → update даёт ровно **один** `connect-ib`, ноль `disconnect-ib` и ноль сбросов SSH;
  - ошибка операции → `disconnect-ib` + сброс, следующая операция → `connect-ib`;
  - «уже подключено» / «не подключено» проглатываются.
- `runWithInfoBaseReleased`: подключено → disconnect перед операцией, после операции reconnect не вызывается; не подключено → без команд; `force` → disconnect без кэша; ошибка disconnect → пакетная операция **не** запускается.
- Idle-таймер: срабатывает через N минут простоя (внедрённые таймеры); новая операция переносит таймер; 0 → таймера нет; `dispose` чистит таймер.
- Интеграционные тесты UI:
  - команда хранилища берёт и освобождает замок (в т.ч. при отказе);
  - при занятом замке операция не запускается;
  - `runInternalCliCommand` вызывает release перед спавном;
  - `DbRunCommandRunner` отказывает во время операции.
- Регистрация команды `agent.releaseInfoBase` в `package.json`/`CommandRegistry` (существующий тест манифеста).

**Э5**
- `parseAgentBaseDirIndex` и `resolveAgentUserDir`: BOM, регистр кириллицы, несколько пользователей, отсутствующий пользователь, небезопасный `dir` (`..`, `a/b`, пусто), битый JSON.
- `LocalAgentFileStore` на временном каталоге: все методы, выход за корень → ошибка, `writeFile` с mkdir -p, `list` рекурсивный.
- `AgentWorkspaceService`: раскладка cf / cfe / `projectId`, санитизация, list-файл (BOM, `\n`, нормализация, запрет `..` и абсолютных путей).
- `AgentOperationService` в локальном режиме: прежние сценарии зелёные, файлы рабочей области лежат в `<AgentBaseDir>/<dir из json>`.

**Э6**
- `SftpAgentFileStore` на `ssh2.Server`: каждый метод, включая кириллицу в путях, перезапись существующего файла (путь temp+remove+rename и запасной путь без rename), `stat` несуществующего пути → `undefined`, `remove` рекурсивный, `list` рекурсивный, ошибка SFTP → исключение с путём.
- `AgentFileTransfer`: соблюдение лимита конкурентности (сервер считает максимум одновременно открытых дескрипторов), прогресс, отмена посередине (оставшиеся не стартуют), ошибка одного файла → общий отказ с перечнем.

**Э7**
- `SyncPlanner`, таблично: состояния M (`empty`/`stale`/`fresh`) × `DumpChangeSet` (`files`/`objects`/`unrecognized`) × размер относительно порога × D (пусто / непусто) × «локально добавленные». Для загрузки: пусто / изменения / удаления / переименование / нет кэша.
- `DumpChangesParser`: образцы-фикстуры (после Э0), пустой файл, мусор → `unrecognized`.
- `ChangedObjectFiles`: перевод полного имени в папку через `META_TYPES` для нескольких видов, включая вложенные формы.
- `ArchiveCodec`: упаковка и распаковка на реальном каталоге из `example/src/cf` (копия в tmp), имена UTF-8 и cp866, бинарные файлы байт-в-байт, повреждённый архив → ошибка без частичной записи в проект (распаковка в staging и применение после валидации).
- `writeFileAtomic(Uint8Array)` — байт-в-байт.
- E2E движка на эмуляторе агента поверх `ssh2.Server` (SFTP-хранилище) и поверх локального хранилища:
  - первый импорт → архив, P заполнен, B сохранён;
  - изменение объекта в «БД» эмулятора → дельта-импорт скачивает только его;
  - удаление объекта → локальные файлы удалены;
  - локальная правка без загрузки перетирается импортом;
  - частичная загрузка кладёт в M ровно изменённые файлы и передаёт верный list-файл;
  - загрузка архивом → M `stale` → следующая частичная сначала делает `dump --update`;
  - `onProjectFilesWillChange` вызывается до записи с точным списком.
- Guard в `AgentCommand`: `update` + `archive` → исключение; построители `getChanges`/`archive`/`configDumpInfoOnly`.

**Э8**
- `agentSettings`: таблица `location ∈ {local, remote}` × `operationMode ∈ {batch, agent}` → режим или ошибка конфигурации; значения по умолчанию новых ключей.
- `AgentServiceRegistry` при `remote`: процесс не стартует, хранилище SFTP, `agentStartedAt` не передаётся.
- `checkConnection` на `ssh2.Server`: успех; auth-ошибка; SFTP запрещает запись → понятная причина.
- Смена настройки сбрасывает кэш (интеграционный тест через `onDidChangeConfiguration`).

**Э9**
- `quoteWindowsCommandLineArg` — табличный тест на векторах libuv: пусто, пробел, `"`, `\` перед `"`, хвостовые `\`, кириллица, `/P` с кавычкой.
- `PowerShellHostProtocol`: кодирование каждой операции; разбор строк с маркером и без (шум); склейка фрагментов stdout; некорректный JSON → ошибка протокола.
- Длина `EncodedCommand` меньше лимита.
- Интеграция с настоящим `powershell.exe` (Windows), `computerName=''`:
  - `connect`, `mktemp`, `put` (кириллица и бинарное содержимое), `resolveV8` (есть / нет);
  - `run` поддельного `.cmd`: код 0 / ненулевой, лог в UTF-16LE / cp1251;
  - `cancel` во время работы — процесс убит, событие `exit` с `interrupted`;
  - `fetch` выходного файла; `rmtemp`; уборка старых `v8vscedit-*`;
  - падение процесса хоста → перезапуск на следующем запросе;
  - `dispose` закрывает процесс.
- `RemoteDesignerBatchExecutor`: подстановка серверных путей вместо `inputFile`/`outputFile`/`/Out`, `rmtemp` и на ошибке, маскирование секретов в логе.
- `RepositoryCommands` в удалённом режиме: вызывается удалённый исполнитель, `dump` переносит staging на выбранный путь только при коде 0.
- `ProjectSecretStorage`: `remote`-ключ не пересекается с `db`/`repo`.

**Гейт каждого этапа:** `npm run compile`, `npm run lint`, `npm test` один раз на qa, `npm run coverage:changed` = 100% на изменённых файлах. Недостижимые защитные ветки — `/* c8 ignore */` с обоснованием.

---

## 5. Решения пользователя (2026-11-16)

- Ветка работы — `feature/remote-designer` (от `main`).
- Zip — зависимость **`fflate`** (имена cp866 декодируются через уже имеющийся `iconv-lite`).
- PSSession — **явная учётка**: `v8vscedit.remote.user` обязателен для удалённого режима, пароль — в SecretStorage (`ProjectSecretStorage.get/setRemotePassword`), диалог ввода пароля при отсутствии секрета; `-Credential` всегда передаётся в `New-PSSession`. Вариант «текущий пользователь Windows» не реализуется.
- `ssh2` — уже в зависимостях, используется.
- Формат `--get-changes` — первый образец получен (`tmp/changes.txt`; в Э7 скопировать в фикстуру `src/test/fixtures/agent/get-changes-*.txt`). Сценарий: в пустой модуль набора записей регистра сведений добавлен пробел. Содержимое (UTF-8 с BOM, CRLF):
  ```
  New: InformationRegister.МК_ОчередьОбработкиДополнительнойИнформации.RecordSetModule
  Modified: InformationRegister.МК_ОчередьОбработкиДополнительнойИнформации
  ```
  Выводы: грамматика строки `<Change>: <EnglishKind>.<Name>[.<Part>]`; формат — ПО ОБЪЕКТАМ (`DumpChangeSet.kind = 'objects'`), не по файлам; часть (`RecordSetModule`) — имя слота модуля → путь через `MetaPathResolver`, вид → папка через `META_TYPES.englishKind/folder`; одно изменение даёт строку части (`New` — пустой модуль ранее не выгружался) И строку владельца (`Modified`). Значения `Change` подтверждены: `New`, `Modified`; `Deleted` (или иное имя удаления) и вложенные части (формы, макеты, реквизиты, ТЧ), корень `Configuration`, расширения — ещё НЕ подтверждены: неизвестный `Change`/часть → `unrecognized` для всего файла (консервативно → архив). Для `Modified` владельца без части — безопасная политика: перечитать XML объекта и сверить поддерево объекта через `store.list` (а не только один XML).
- `dump-config-to-files --update` и `--archive` вместе НЕ работают (пилот) — guard в `AgentCommand`.

## 5b. Факты локального пилота агента (2026-11-16, 8.3.27.2130, файловая база, скрипты — scratchpad, вне репозитория)

ОБЯЗАТЕЛЬНЫ к учёту в Э3/Э4/Э6/Э7 — часть пунктов ОПРОВЕРГАЕТ допущения разделов 1–4:

1. **Подключение ИБ НЕ переживает закрытие SSH-сессии**: после нового входа `config generation-id` → `DesignerNotConnectedToInfoBase`. SSH-shell обязан жить между операциями (Э4), сброс SSH = обязательный повторный `connect-ib`.
2. **SFTP и shell — РАЗНЫЕ SSH-соединения.** Агент даёт один канал на соединение: `sftp` вторым каналом рядом с shell → «Unable to start subsystem: sftp»; shell вторым каналом после sftp → «Unable to open shell». План п.1.2 («`openSftp()` на том же `Client`») заменить на отдельное соединение (фабрика соединений, своя политика готовности для каждого). Параллельно открытые shell- и SFTP-соединения работают (connect-ib при открытом SFTP — успех).
3. **Машинные коды ошибок**: ответ `{"type":"error","error-type":"…","message":"…"}`; наблюдались `DesignerAlreadyConnectedToInfoBase`, `DesignerNotConnectedToInfoBase`, `ConfigFilesError`, `UnknownError`, `CommandFormatError`. Распознавать по `error-type`, а не регулярками по тексту (`isInfoBaseAlreadyConnectedMessage` и др. — оставить фолбэком). `config generation-id` → `{"type":"success","body":"<40 hex>"}`.
4. **`--get-changes` вместе с `--update` НИЧЕГО НЕ ВЫГРУЖАЕТ** — только пишет список (хэши зеркала до/после совпадают). Дельта-импорт = ДВА шага: `dump --dir=M --update --get-changes=F` (список) → `dump --dir=M --update` (запись). `--get-changes` требует существующего `M/ConfigDumpInfo.xml` (иначе `ConfigFilesError` «Не удалось найти файл версий»), даже без `--update`.
5. **Агент не создаёт родительские каталоги** файлов `--get-changes`/`--list-file` («Каталог не обнаружен») — создавать через SFTP `mkdir` до команды. Каталог `--dir` при выгрузке создаёт сам (вложенно).
6. **`--archive=<имя>` разрешается ОТНОСИТЕЛЬНО `--dir`**, а не корня: `--dir=arch1 --archive=full.zip` → `arch1/full.zip`; путь с подкаталогом в несуществующий каталог и абсолютный путь → `UnknownError` «Неправильное имя файла архива». `--dir` обязателен (без него `CommandFormatError` + вывод справки потоком `log`). При `--archive` в `--dir` кладётся ТОЛЬКО архив.
7. **Формат архива**: стандартный zip, deflate (method 8), флаг UTF-8 (бит 11) выставлен у всех записей, кириллица корректна, внутри есть `ConfigDumpInfo.xml`.
8. **Грамматика `--get-changes`** (UTF-8 BOM, CRLF; нет изменений → файл из одного BOM):
   - строки `New: <Path>` / `Modified: <Path>`; `Path` = `<EnglishKind>.<Name>[.<PartKind>[.<PartName>[.<SubPart>]]]`;
   - наблюдённые пути: `Document.X` (→ `Documents/X.xml`), `Document.X.ObjectModule` (→ `Ext/ObjectModule.bsl`), `Document.X.Form.Y` (→ `Forms/Y.xml`), `Document.X.Form.Y.Form` (→ `Forms/Y/Ext/Form.xml` И `Forms/Y/Ext/Form/Module.bsl` — новый модуль формы отдельной строкой НЕ появился), `Document.X.Template.Y` (→ `Templates/Y.xml`), `Role.X.Rights` (→ `Roles/X/Ext/Rights.xml`), `Configuration.Конфигурация` (→ `Configuration.xml`), `Language.X`, `Catalog.X`, `InformationRegister.X.RecordSetModule` (сервер);
   - **любое удаление или переименование → файл из ОДНОЙ строки `FullDump`** (удаление модуля, удаление реквизита, переименование объекта). Строки `Deleted` не существует;
   - **после ПОЛНОЙ загрузки (`load` без `--partial`) список — сверхприближение**: `Modified` у всех объектов (полная загрузка меняет `configVersion` всех объектов), хотя `--update` фактически меняет только реально изменённые файлы. После частичной загрузки объекта — `Modified` у объекта и ВСЕХ его частей. Для сценария «получить из хранилища» (UpdateCfg меняет версии только затронутых объектов) список точный (серверный образец — 2 строки).
9. **`ConfigDumpInfo.xml` — альтернативный точный источник дельты**: `<Metadata name="Catalog.X" id="<uuid>" configVersion="<hash>">` на объект и его части (вложенные `Metadata` реквизитов/ТЧ без `configVersion`). Сравнение старого и нового файла по `name → configVersion` даёт added/modified/REMOVED, в т.ч. там, где `--get-changes` отвечает `FullDump`. Рекомендация для Э7: стратегия импорта — список `--get-changes`, а при `FullDump` — скачать новый `ConfigDumpInfo.xml` (один файл) и сравнить с сохранённой копией в манифесте B; архив — только для первой выгрузки или неразборчивых случаев. **Замер на сервере пользователя: 33,7 МБ (35 385 522 байт)** — каждый импорт качать нельзя, только при `FullDump`.
   - **Файл версий отдаётся архивом без полной выгрузки:** `dump --dir=cdi --config-dump-info-only --archive=cdi.zip` → в `cdi/` только `cdi.zip` с единственной записью `ConfigDumpInfo.xml` (проверено; на тестовой базе 2483→1049 байт). Без `--archive` — `cdi/ConfigDumpInfo.xml`. **Замер на сервере: `cdi.zip` = 6,10 МБ (6 401 695 байт), 18% от XML** — приемлемо для ветки `FullDump`; серверный скрипт через PSSession как основной путь НЕ нужен.
   - **`--config-dump-info-for-changes=<старый файл>` НЕ спасает от `FullDump`**: при удалении реквизита и `--get-changes` относительно зеркала, и с явным старым файлом версий → `FullDump`. Дельту при удалениях даёт только собственное сравнение двух файлов версий (или серверный скрипт через PSSession — альтернатива, если архив окажется велик).
10. **Гранулярность перевода строки → файлы**: безопасная политика — по ВЛАДЕЛЬЦУ верхнего уровня (`<EnglishKind>.<Name>`): `<Folder>/<Name>.xml` + всё поддерево `<Folder>/<Name>/` (SFTP-листинг), удалить локальные файлы владельца, которых нет на сервере. Точное сопоставление частей — оптимизация, не требование.
11. **`--list-file` с BOM UTF-8 + LF принят** (`load --partial --list-file … --no-check` — успех).
12. **SFTP агента** (корень `/` = персональный каталог): `mkdir` создаёт промежуточные каталоги одним вызовом; `rename` ПЕРЕЗАПИСЫВАЕТ существующую цель (нестандартно для SFTP v3 — temp+remove+rename не нужен); `writeFile` поверх существующего — успех; `stat` отсутствующего → code 2 (NO_SUCH_FILE); выход за корень (`..`, `C:/`) → code 3 (PERMISSION_DENIED); кириллица в путях работает; **`rmdir` НЕПУСТОГО каталога удаляет его РЕКУРСИВНО без ошибки** — опасно: `AgentFileStore.remove` без `recursive` обязан сам проверять пустоту (readdir) перед `rmdir`.
13. **Готовность**: на почти пустой базе SSH принимает вход через ~650 мс после старта, `refused` до этого, auth-отказов не наблюдалось (гонка «Permission denied» воспроизводится только на тяжёлой серверной конфигурации — политику Э3 не меняет). `connect-ib`/`disconnect-ib` ~30 мс на пустой базе; повторный `connect-ib` → `DesignerAlreadyConnectedToInfoBase`, повторный `disconnect-ib` → `DesignerNotConnectedToInfoBase`.
14. Для запуска агента из Git Bash (MSYS) аргументы `/AgentMode` и т.п. переписываются как POSIX-пути — запускать из PowerShell/Node `spawn` (к коду расширения не относится, замечание для ручных пилотов).
15. **(2026-11-17, проверка оркестратора на 8.3.27.2130)** `load-config-from-files --dir=X --archive=full.zip` разрешает имя архива ОТНОСИТЕЛЬНО `--dir` (как и выгрузка); архива нет → `ConfigFilesError` «Файл не обнаружен '<basedir>\<dir>\full.zip'».
16. **(2026-11-17)** `dump --dir=M --update --force` удаляет из M файлы объекта, исчезнувшего из базы (проверено на удалённом справочнике); `--get-changes` в том же сценарии — ровно `FullDump`.
17. **(2026-11-17)** На Windows системный Node v24.11.1: `fs.rmSync` МОЛЧА (без исключения) не удаляет файл с кириллицей в имени — ни файлом, ни рекурсивно каталог; `fs.unlinkSync` и асинхронный `fs.promises.rm` удаляют. В коде синхронизации Э7 удаление файлов выгрузки — только `unlink`/`rmdir` своим обходом.
18. **(2026-11-18)** Настоящий агент 8.3.27.2130 принимает архив, собранный нашим `ArchiveCodec`: `load-config-from-files --dir=X --archive=full.zip` → success и конфигурация применена — и для обычного zip (бит 11 UTF-8, кириллица в именах), и для zip64 (65 600 записей, EOCD64 + локатор + extra 0x0001; посторонние файлы вне структуры выгрузки агент молча игнорирует). Драйвер — scratchpad `agent/exp8.js`.
19. **(2026-11-18, эксперимент 9)** Каталог, где лежат ТОЛЬКО `ConfigDumpInfo.xml` и `Configuration.xml` старой выгрузки, даёт `dump --update --get-changes` ровно по объектам, изменённым в базе после неё; `dump --update --force` пишет в такой каталог только файлы этих объектов (побайтно равны полной выгрузке), `ConfigDumpInfo.xml` после него идентичен файлу полной выгрузки, второй цикл снова точен. Это основание посева разреженного M (`MirrorSeed`).
20. **(2026-11-18, эксперимент 10)** `load-config-from-files --partial --list-file … --no-check` из РАЗРЕЖЕННОГО каталога работает и для корневого XML объекта, и для модуля формы при каркасе из `ConfigDumpInfo.xml` + `Configuration.xml` + самого файла. **Ловушка методики:** полная `load-config-from-files` без `--partial` обновляет версии ВСЕХ объектов — `--get-changes` после неё перечисляет всё; замеры «точной дельты» нужно делать после частичной загрузки. Стенд пользователя (БП КОРП, 104 тыс. файлов): первый импорт падал «Array buffer allocation failed» на `readFile(full.zip)` и делал две полные серверные выгрузки.
21. **(2026-11-18, эксперименты 11 и 12, агент 8.3.27.2130, InfoBase1)** `dump-config-to-files --list-file`: (а) ключ принимает ИМЕНА объектов (`Catalog.X`, русские формы тоже), не пути файлов; путь файла и вложенный подобъект в списке — ошибки; (б) несовместим с `--update` («Ключ -listFile не может использоваться совместно с ключами инкрементальной выгрузки»); (в) несуществующее имя → `ConfigFilesError`, не выгружено ничего (частичного результата нет); (г) выгрузка в ПУСТОЙ каталог работает, `ConfigDumpInfo.xml` НЕ создаётся; поддерево владельца выгружается побайтно как при полной выгрузке; (д) в `ConfigDumpInfo.xml` файловая запись — `<Metadata>` с `configVersion`; модули — отдельные файловые записи (`X.ObjectModule`, `X.ManagerModule`, `X.Command.К.CommandModule`, `X.Form.Ф`/`X.Form.Ф.Form`, `X.Template.М`, `Configuration.N.*Module`), т.е. список перечисляет все файловые наборы владельца; (е) строки списка — имена английские или русские. Для расширения (`--extension`) не проверено. Вывод: вариант А «точечная выгрузка в каталог обмена» реализован (`SparseRestore`), M не трогается.
22. **(эксперимент 13)** Занятая другим держателем ИБ даёт на `connect-ib` финальный `error` с `error-type: DesignerAlreadyStarted` («Ошибка блокировки информационной базы для конфигурирования»); на файловой базе база освобождается через 34 мс после завершения держателя. Повтор в окне 15 с (0,5 → 1 → 2 с) — `InfoBaseLockRetryPolicy`; окно на клиент-серверной базе не замерено (Э15).
23. **(2026-11-19, Э14, 8.3.27.2130, файловые базы, файловое хранилище)** Лог `/ConfigurationRepositoryLock`: `---- Начало операции с хранилищем конфигурации ----`, строки `Объект получен из хранилища: <Рус.Имя>` (по объекту и файловому подобъекту с новой версией в хранилище) и `Объект захвачен для редактирования: <Рус.Имя>`, `---- Операция с хранилищем конфигурации завершена ----`, «Захват объектов в хранилище успешно завершен», exit 0. Захват БЕЗ `-revised` объекта, изменённого в хранилище, ТОЖЕ получает его версию — менять ли базу, решает платформа, а не ключ; `-revised` объекта, не изменённого в хранилище, даёт только «захвачен». Тот же процесс агента после `disconnect-ib` → пакетный захват → `connect-ib` видит новую версию без `/UpdateDBCfg` (`--get-changes` точный, `dump --update` пишет модуль из хранилища); пакетный `/DumpConfigToFiles -listFile` тоже. В подключённой к хранилищу базе `/LoadConfigFromFiles -partial` незахваченного объекта — отказ (exit 1, «Загрузка невозможна: объект метаданных … не захвачен в хранилище!»): молчаливой потери правок проекта при `-revised` не существует.
24. **(пилот 8, стенд пользователя)** `remote.v8Path` указывал на стартер `1cestart.exe`: стартер сразу выходит, пакетная операция хранилища «завершалась» раньше реального конца, и следующий `connect-ib` агента падал на блокировке («Ошибка блокировки информационной базы для конфигурирования»). Стартер отвергается `V8ExecutableGuard` до запуска; повтор `connect-ib` закрывает остаточную задержку освобождения.
25. **(2026-11-19, Э16, копии InfoBase1, файловое хранилище)** Лог `/ConfigurationRepositoryUpdateCfg` — тот же формат, что у захвата (маркеры операции, «Объект получен из хранилища: <Рус.Имя>»), итог «Обновление конфигурации из хранилища успешно завершено». Удалённый в хранилище объект — ОТДЕЛЬНАЯ строка «Объект удален из конфигурации: <Рус.Имя>»; удаление выполняется и БЕЗ `-force` (с `-force` после этого получать уже нечего). Удаление объекта меняет корень, поэтому при получении всей конфигурации рядом стоит «получен: Конфигурация», но при поддереве без корня строка удаления может быть единственной. В подключённой к хранилищу базе запрещена и ПОЛНАЯ `/LoadConfigFromFiles` («Загрузка невозможна: текущая конфигурация помещена в хранилище»), не только частичная загрузка незахваченного объекта; удалить объект можно частичной загрузкой `Configuration.xml` при захваченной конфигурации.
26. **(2026-11-19, Э17/Э17b/Э17c, копии InfoBase1)** При удалении объекта (`--get-changes` = `FullDump`) `dump --update` переписывает на сервере ВСЕ файлы зеркала (содержимое верное, но по времени это полная выгрузка). Сравнение старого и нового `ConfigDumpInfo.xml` по `name → configVersion` даёт точную дельту (сценарий «коллега удалил объект и поместил корень»: removed — удалённый владелец, added — новый модуль, modified — изменённый объект и корень, больше ничего). **Главное:** если ДО `--update` удалить из `ConfigDumpInfo.xml` зеркала записи верхнего уровня удалённого владельца (имя или префикс `<имя>.`) и его файлы, `--get-changes` отвечает точным списком `New`/`Modified` вместо `FullDump`, а `--update` инкрементален (нетронутые файлы не переписываются), и зеркало побайтно совпадает с полной выгрузкой. Имена удалённых владельцев дают строки лога хранилища «Объект удален из конфигурации». Ловушка методики: частичная загрузка `Configuration.xml` поднимает `configVersion` ВСЕХ объектов (Э17 без хранилища показал «изменено всё»).
27. **(2026-11-19, Э18/Э19/Э19b, копии InfoBase1)** `dump --config-dump-info-only --archive=cdi.zip --force` в пустом каталоге: успех, в каталоге только `cdi.zip` (~6 МБ против ~34 МБ XML) — свежий `ConfigDumpInfo.xml` базы без выгрузки конфигурации. Сравнение с файлом версий M даёт removed (владельца нет в базе) и записи пропавших частей. Живой владелец с удалённой частью (форма) очищается ЦЕЛИКОМ (все его записи в CDI M + XML и поддерево в M): повторный `--get-changes` = `New: <Владелец>` и отдельными строками `New: <Владелец>.Template.Макет` (файловые подобъекты тоже приходят как New), `--update` выгружает владельца целиком, остальные файлы не тронуты, M побайтно = полной выгрузке. Точечная очистка записей части без удаления владельца `FullDump` не снимает. **Переименование** объекта: лог не пишет «удален» про старое имя, признак только `FullDump` и исчезновение записи в свежем CDI. **Удаление формы** — `FullDump`; пакетное помещение удаления формы в хранилище не проходит (удаляется через корень/объект). Переименование только регистром на Windows: старый и новый пути — один физический файл.
28. **(2026-11-19, стенд пользователя, копии InfoBase1)** Переименование реквизита табличной части → `--get-changes` = `FullDump`: из файла версий пропала только встроенная запись без `configVersion` (отражено в `ConfigDumpInfoIndex.embeddedNames`/`ConfigDumpInfoDiff.removedEmbedded`). Эксперимент 20 (копия InfoBase1): переименование реквизита справочника, очистка владельца целиком из M → повторный `--get-changes` даёт `New: <владелец>`, инкрементальный `--update` проходит, M совпадает с полной выгрузкой.
29. **(2026-11-19, эксперименты 21 и 22, SSH keepalive)** Эксперимент 21: keepalive на простаивающем канале — агент переносит. Эксперимент 22: во время выполнения команды агент на keepalive НЕ отвечает (допуск 3 → обрыв через 4 с долгой загрузки; огромный допуск → 25 мин и ~1500 запросов без ответа, соединение цело). Не проверено: отвечает ли соединение после долгой команды (команда не успела закончиться за 25 мин). Следствие в продукте: keepalive 15 с / допуск 2880, обнаружить мёртвое соединение им нельзя ([architecture.md](./../architecture.md#keepalive-ssh)).
30. **(2026-11-19, Э23, локальный агент 8.3.27.2130, копия InfoBase1, SFTP)** Метка пишется через SFTP (отдельное соединение) после изменения базы и ДО `dump --update --force`; после него READDIR по SFTP: mtime ≥ метки ровно у изменённых файлов (`Catalogs/Справочник1.xml`, `Catalogs/Справочник1/Ext/ObjectModule.bsl`, `ConfigDumpInfo.xml`), остальные 10 файлов M — младше метки. Допущение «`--update` переписывает только изменённые файлы с новым mtime» ПОДТВЕРЖДЕНО (на удалении объекта `--update` переписывает весь M — п.26, там отбор не применяется). Важно: mtime по SFTP агента сдвинут на ~1 ч относительно UTC клиента (`Date.now()/1000 − marker = −3597`: локальное время сервера, выданное как UTC), поэтому сравнивать ТОЛЬКО с меткой на сервере, никогда с часами клиента. Следствие в продукте: дельта импорта скачивает только файлы с mtime ≥ метки − 2 с (`MirrorChangeWindow`, константа-выключатель `MIRROR_MTIME_SELECTION_ENABLED`, по умолчанию включена; [architecture.md](./../architecture.md#модель-синхронизации-m--p--b)). НЕ проверено: клиент-серверная база стенда (пункт 21 чек-листа [remote-designer.md](./../remote-designer.md#8-чек-лист-пилота-на-стенде)).
31. **(2026-11-20, Э24, пакетный 1cv8 8.3.27.2130, две копии InfoBase1, файловое хранилище, пользователи UserA — администратор, UserB — `LockObjects`)** Семантика `-force` операций хранилища (для MCP-инструментов). Изменения в базу вносились только частичной загрузкой модуля формы захваченного `Документ.Документ1`, состояние проверялось точечной выгрузкой модуля до и после операции; ключевой сценарий (п. «получение») повторён на свежем хранилище.
    - **`/ConfigurationRepositoryUnLock` изменённого объекта БЕЗ `-force`** — отказ, exit 1: «Объект '…Форма.ФормаДокумента' был изменен», «Ошибка отмены захвата объектов в хранилище»; правка в базе и захват сохраняются.
    - **То же С `-force`** — exit 0, в логе «Объект получен из хранилища: <изменённый подобъект>» и «Захват объекта отменен: …»; **правка в базе ПОТЕРЯНА** (модуль откатился к версии хранилища).
    - **`UnLock` (с `-force` и без) чужого захвата** — и от администратора, и от `LockObjects`: exit 0, «Отмена захвата объектов в хранилище успешно завершена», в логе «Объект захвачен для редактирования другим пользователем: <имя> (<пользователь>)», но **захват НЕ снимается** (последующий захват вторым пользователем — отказ). Успех по `exitCode` не означает, что захват отпущен: верить можно только строкам «Захват объекта отменен».
    - **`/ConfigurationRepositoryUpdateCfg` захваченного объекта, изменённого в базе, — БЕЗ `-force` и с ним одинаково:** exit 0, «Объект получен из хранилища: <подобъект>», **правка в базе ПОТЕРЯНА**, захват сохраняется. Различия поведения `-force` у получения не найдено (удаление объектов проходит и без него — п.25).
    - **`/ConfigurationRepositoryCommit -force` объекта, захваченного ДРУГИМ** — отказ, exit 1, «Ошибка помещения…»; чужие правки и захват не тронуты. `-force` не позволяет поместить без собственного захвата.
    - **`Commit` объекта со ссылками на удалённое** (форма убрана из `ChildObjects`, `DefaultObjectForm` осталась): без `-force` — exit 1 «Объект 'Документ.Документ1' содержит ссылки на удаленные объекты: обнаружены ссылки на удаленные реквизиты»; с `-force` — exit 0, «Очистка объектов от некорректных ссылок выполнена», объект помещён. **`-force` помещения = молчаливая правка объекта платформой** (очистка ссылок), не обход прав. Второй пользователь получает «Объект удален из конфигурации: …Форма…» + «получен: Документ.Документ1».
    - **`/UpdateDBCfg` в базе, подключённой к хранилищу,** после получения — exit 0, обычная реструктуризация; повторный — exit 0 с пустым логом. Особых условий подключение к хранилищу не добавляет.
    - Следствия: (а) в MCP `force` у освобождения и получения смысла не несёт либо означает потерю правок — агенту не открывать, а у помещения допускать только с `confirm` и с предупреждением об очистке ссылок; (б) **получение из хранилища затирает незакоммиченные правки захваченных объектов БАЗЫ** — `planRepositoryUpdate` смотрит только на правки ПРОЕКТА, поэтому вариант «Загрузить правки в базу, затем получить» загружает правки и тут же теряет их, если в выборку попал захваченный изменённый объект (дефект продукта; исправлен 2026-11-20: загрузка правок перенесена ПОСЛЕ получения, при захваченных объектах в выборке — подтверждение со списком); (в) успех освобождения/помещения определять по строкам лога, а не по `exitCode` (как захват — п.23, Н10).
32. **(2026-11-20, Э25, то же окружение, свежее хранилище)** Лог `/ConfigurationRepositoryCommit`: между маркерами операции строки `Объект помещен в хранилище: <Рус.Имя>` (по объекту/файловому подобъекту с изменениями) и `Объект не был изменен: <Рус.Имя>`, итог «Помещение изменений объектов в хранилище успешно завершено», exit 0. Помещение без правок — тоже exit 0, все строки «не был изменен» (успех без помещённых версий). **Снятие захвата после помещения (без `-keepLocked`) в лог НЕ пишется** — строк «Захват объекта отменен» нет, но захват снят (второй пользователь захватывает); с `-keepLocked` захват сохраняется. Признак снятия — `exit 0` и отсутствие `-keepLocked`. **`-force` с очисткой ссылок меняет основную конфигурацию базы помещающего:** из XML объекта исчезла ссылка `<DefaultObjectForm>` (на удалённую форму, по uuid) и объект пересериализован — после такого помещения проект отстаёт от базы, нужен импорт.

33. **(2026-11-20, Э26, локальный агент 8.3.27.2130 через TCP-прокси +40 мс в каждую сторону)** Скорость SFTP-чтения. STAT/FSTAT возвращают точный размер; один READ на 256 КиБ возвращает 256 КиБ; сервер агента параллельные READ держит. Чтение 8 МБ: окно 1 — 0,36 МБ/с, 4 — 1,42, 16 — 5,05, 64 — 6,33, 4 дескриптора × 16 — 5,46 (выигрыша нет). Код уже читает окном 16. Вывод: на стенде узкое место — ПРОПУСКНАЯ СПОСОБНОСТЬ КАНАЛА (~300 КБ/с суммарно: 19.11 — 37 файлов ~9 МБ за 27 с, 20.11 — приём сети ~290 КБ/с), а не протокол. Ускорение чтения не делалось (окно не трогали, `expectedSize` не нужен — размер есть в FSTAT). Причина задачи: после получения из хранилища импорт качал `Ext/ParentConfigurations/БухгалтерияПредприятияКОРП.cf` (1,18 ГБ, конфигурация поставщика — часть корня) около часа при ~290 КБ/с целиком в память, журнал показывал «27 из 28 (96%)». Следствие в продукте: шлюз поставщика, потоковые большие файлы, прогресс по весу ([architecture.md](./../architecture.md#модель-синхронизации-m--p--b), «Конфигурация поставщика и большие файлы»).
34. **(2026-11-20, Э27, локальный агент, копии InfoBase1)** Поставить базу на поддержку пакетным режимом НЕ удалось: `/MergeCfg v1.cf -EnableSupport -force` → «Возможность объединения с постановкой на поддержку отсутствует» (и с заполненными Vendor/Version); `/LoadCfg` cf поставщика поддержку не создаёт (`Ext/ParentConfigurations` в выгрузке нет). Проверка шлюза на реальном обновлении поставщика переносится в чек-лист стенда ([п. 23](./../remote-designer.md#8-чек-лист-пилота-на-стенде)). Побочный факт: правка модуля корня (частичная загрузка только `Ext/SessionModule.bsl`) → `--get-changes` = `New: Configuration.X.SessionModule` + `Modified: Configuration.X`; `--update` переписал ТОЛЬКО `Configuration.xml` и новый модуль, не весь корень. Решение: шлюз включён по умолчанию (`VENDOR_CONFIGURATION_GATE_ENABLED`), его безопасность не держится на одном списке изменений — изменившийся/пропавший `ParentConfigurations.bin` (обновление поставщика всегда его меняет) снимает шлюз, плюс «нет в P / размер в P ≠ M → качать». Допущение: `.cf`/`.bin` вне манифеста B — локальная правка `.cf` того же размера не обнаруживается (файл генерирует платформа).

35. **(2026-11-20, Э28-Э31, агент 8.3.27.2130, копии InfoBase1; план `.v8vscedit/plan-remote-extensions.md`)** CF/CFE, пакеты расширений и список расширений переведены на агента (`operationMode = agent`, local и remote); Н51 уточнён: через `runInternalCliCommand` остались только batch-режим и CLI. Факты: (а) `properties get --all-extensions` отвечает `success` с `body` из `extension-properties` (булевы свойства - JSON boolean, `version` - строка, у созданных пустая; 0 расширений - `body: []`); (б) при ОДНОМ расширении ответ - одиночное `extension-properties` верхнего уровня без `success` (Э30-Э31 отменили вывод Э29 про «зависание»: все наблюдавшиеся зависания - эта форма, агент после неё работоспособен); транспорт завершает ответ узко по `terminalTypes`; (в) `load-cfg` берёт имя, префикс и назначение из файла; после `update-db-cfg` расширение переименовывается во внутреннее имя файла (E11, цель `cfe/X` исчезает); `update-db-cfg` несуществующего - молчаливый success (guard E6); (г) заглушка - `hash-sum` `AAAAAAAAAAAAAAAAAAAAAAAAAAA=` (нулевой SHA-1), `version` признаком не служит; загрузка в имя заглушки в той же сессии допустима: load, update, сверка; (д) `dump-cfg` в несуществующий каталог - пустой `UnknownError` с текстом в log-строке; progress-сообщений нет; (е) коллизия имени при `update-db-cfg` («Расширение с таким именем уже существует!») сессию не ломает; (ж) агент держит одну shell-сессию («Unable to open shell» при втором соединении); синоним в create обязателен. Не проверено, перенесено на стенд: `dump-cfg` на ГБ, `load-cfg` при пользователях, старая платформа (`CommandFormatError`, E13). Чек-лист - remote-designer.md, пункты 24-28; устройство - architecture.md, «CF/CFE-файлы и список расширений через агента».

36. **(2026-11-21, Э32, агент 8.3.27.2130, копии InfoBase1)** Загрузка без обновления БД и признак отставания.
    `config generation-id` основной конфигурации МЕНЯЕТСЯ после `load-config-from-files --partial` без обновления
    БД и НЕ меняется после `update-db-cfg` (поколение основной конфигурации, не БД); у расширения
    (`--extension=X`) наоборот. Несимметрично и не замерено на сервере, поэтому индикатор отставания -
    только локальный признак (`lag.json`). Ответ `update-db-cfg` несёт `generation-id` и `dbstru`-сообщения (можно
    логировать, не опираться). Повторный `update-db-cfg` без изменений быстрый. `load-config-from-files
    --extension=N` в ОТСУТСТВУЮЩЕЕ расширение - success и заглушка с нулевым хешем: проверка E6 ДО загрузки.

## 5a. Открытые вопросы к пользователю (исходная редакция архитектора)

1. **Можно ли добавить зависимость для zip** (потоковая распаковка и упаковка; кандидаты: `yauzl` + `yazl`, либо `fflate`)? Без неё нужна распаковка через локальный `powershell` (`System.IO.Compression.ZipFile`) — только Windows и медленнее на применении через `writeFileAtomic`. Блокирует Э7.
2. **Образцы из пилота (Э0):** файл `--get-changes` (cf + cfe, с добавлением, изменением и удалением) и пример `--archive`. Без них Э7 выйдет с удалённым импортом только через архив. Это рабочий, но медленный путь.
3. **Как аутентифицироваться в PSSession:** текущий пользователь Windows (Kerberos / Negotiate) или нужна явная учётка? Поддерживается и то и другое, но от ответа зависит значение по умолчанию `remote.authentication` и нужен ли диалог ввода пароля в Э9.

Решения, принятые без вопросов (пользователь может переопределить): `idleDisconnectMinutes = 0` по умолчанию (база отпускается перед пакетными операциями и явной командой); MCP для хранилища не публикуется (обоснование в п.1.4); порог архива — 300 файлов.

---

### Ключевые файлы для реализации
- c:\projects\v8vscedit\src\infra\agent\AgentOperationService.ts (фасад; вынос жизненного цикла в `AgentInfoBaseSession.ts`, синхронизации — в `sync/AgentSyncEngine.ts`)
- c:\projects\v8vscedit\src\infra\agent\ProcessDesignerAgentTransport.ts (политика готовности, `openSftp`)
- c:\projects\v8vscedit\src\infra\agent\AgentWorkspaceService.ts (переход на `AgentFileStore`, удаление хардкода `'0'`)
- c:\projects\v8vscedit\src\ui\commands\repository\RepositoryCommandRunner.ts (единый построитель + `DesignerBatchExecutor` + guard)
- c:\projects\v8vscedit\src\ui\commands\ext\ExtensionCommandRunner.ts (вынос в `ui/commands/ext/agent/`, release перед `runInternalCliCommand`)
- c:\projects\v8vscedit\src\ui\commands\repository\RepositoryCommands.ts (замок, staging выходных файлов)
- c:\projects\v8vscedit\src\cli\commands\repositoryCommands.ts и c:\projects\v8vscedit\src\cli\core\onecCommon.ts (устранение дубля аргументов)
- c:\projects\v8vscedit\src\infra\fs\AtomicFileWriter.ts (перегрузка `Uint8Array`)
- c:\projects\v8vscedit\src\domain\agent\AgentCommand.ts (новые опции dump/load, guard update×archive)

---

## 6. Бэклог по итогам ревью Э1 (2026-11-16)

Вердикт reviewer по Э1 — APPROVE. Н1–Н3 закрываются до коммита Э1; остальное — сюда.

- **Н4** `infra/fs/StagingFile.ts`: цель удаляется ДО переноса; в ветке EXDEV сбой `copyFileSync` (диск заполнен) оставит пользователя без старого и без нового файла. Копировать во временный файл рядом с целью (`resolveAtomicTempPath`) и переименовывать; удалять старую цель только после успешного копирования.
- **Н5 — ЗАКРЫТ в Э9** (`infra/process/designer/InfoBaseConnectionArgs.ts`; `RepositoryDesignerArgs` реэкспортирует, `cli/core/onecCommon.ts` импортирует новый путь). Исходная формулировка: `buildInfoBaseConnectionArgs` живёт в `infra/repository`, но им пользуются все CLI-команды конфигуратора — при Э9 перенести в `infra/process/designer/`.
- **Н6** `RepositoryCommandRunner.ts`: `ConnectionParams` выразить как `InfoBaseConnection & { v8Path?: string }`; текст ошибки отсутствия подключения в UI потерял подсказку про `--ibconnection` в env.json.
- **Н7** Пропуск двух POSIX-тестов SIGTERM в `cliProcess.test.ts` на win32 — отдельным коммитом `test(cli): …`, не смешивать с Э1.
- **Н8** У существующих пользователей остаются накопленные `.v8vscedit/repository/objects/*.xml` — разовая уборка (отдельная задача).
- **Н9** Следить за EOL: `.gitattributes eol=lf`, рабочие копии не сохранять с CRLF.

- **Н10 — ЗАКРЫТ (формат лога снят в Э14, 2026-11-19; открыта только сверка `ONE_C_TYPE_NAMES` по всем видам)**: разбор лога теперь строится на реальном тексте (см. §5b п.23), допущение снято. `infra/repository/RepositoryLockLog.ts` (`parseRepositoryLockLog`/`resolveLockedFullNames`), `runRepositoryLockAction` помечает только объекты, которые лог называет захваченными; нераспознанный лог — прежнее поведение (все). Формы строк — из описания пилота, точный текст лога реального захвата ещё не снят (ДОПУЩЕНИЕ в шапке `repositoryLockOutcome.test.ts`); сверка `ONE_C_TYPE_NAMES` с платформой по всем видам — открыта. Исходная формулировка: **(пилот 8.3.27.2130, файловое хранилище): частичный захват — успех.** `/ConfigurationRepositoryLock` со списком, где один объект не существует, → `exit=0` и «Захват объектов в хранилище успешно завершен»; несуществующие перечисляются в логе строкой «Объекты, отсутствующие в обеих конфигурациях: …», остальные захватываются. `RepositoryService.setLocked` после успеха помечает захваченными ВСЕ `fullNames` → при ошибке построения полного имени (`ONE_C_TYPE_NAMES`) локальный учёт покажет захват, которого в хранилище нет. Разбирать лог (строки «Объект захвачен для редактирования: <имя>» / «Захват объекта отменен: <имя>») и помечать только реально затронутые; сверить `ONE_C_TYPE_NAMES` с платформой по всем видам.

- **Н11 (мелочь)** UI (`RepositoryCommands.ts` dump/report) берёт ключ выходного файла напрямую (`REPOSITORY_DUMP_OUTPUT`, `repositoryReportOutputName`), а не через общую `repositoryOperationOutputName`, как CLI. Ключи не расходятся (вектор строится той же функцией, закреплено тестом), но точку расчёта стоит свести к одной.

- **Н12 (Э3)** Мёртвые ветки, сохранённые при дословном переносе Э2 под `c8 ignore`: `agentSettings.ts` — `rawValue[index] ?? ''` и хвостовой `if (escaped)` в `splitAgentModeArgs`; `AgentServiceRegistry.ts` — `agentProcess?.hasExited() ?? false`. Убрать вместе с `c8 ignore` при первой содержательной правке этих модулей (Э3). Там же: убрать лишний экспорт `AgentPortNotOpenError`; помнить, что `Uri.fsPath` даёт строчную букву диска, а `os.tmpdir()` — заглавную (сравнение путей — без учёта регистра).

- **Н13 (Э4)** `ProcessDesignerAgentTransport`: команда, вызванная между событием `error` SSH-клиента и его `close`, уходит в ещё не сброшенный канал и отклоняется «SSH-соединение с агентом закрыто с кодом 255» без переподключения; переподключение происходит только после `close`. Не зависание, но лишний отказ — `AgentInfoBaseSession` (Э4) должен сбрасывать канал по `error` (или повторять команду один раз после переподключения, если она точно не дошла до агента).
- **Н14 (Э3+)** Лимит числа auth-повторов при известном `agentStartedAt`: сейчас auth-отказ повторяется всё окно `authWarmupMs` с шагом `retryDelayMs` — при неверном пароле и автозапуске это до ~85 неверных входов за 90 с, риск блокировки учётной записи 1С. Поле `attempt` в `AgentConnectContext` политикой (`decideAgentConnectRetry`) не используется — ввести предел числа auth-повторов (или растущую паузу).
- **Н15 (Э3+)** `DISCONNECT` с числовым `code` ≠ `BY_APPLICATION` (например 14 — `NO_MORE_AUTH_METHODS_AVAILABLE`) `classifySshConnectError` относит к `other`: без повтора даже в окне прогрева. Пилот такого не наблюдал; при появлении — снять реальный код с агента и завести явное правило классификации.
- **Н16 (Э4)** `agentConnectWiring.test.ts` читает приватные `innerFactory.options` через приведение типа — при выносе `AgentInfoBaseSession` в Э4 заменить на проверку через публичный контракт (или явный геттер), иначе рефакторинг молча сломает тест.
- **Н17 (Э4 → решить в Э9)** Отклонение от плана: `runWithInfoBaseReleased` в продуктовом коде не используется — пакетные исполнители (`runInternalCliCommand`, `RepositoryCommandRunner`) зовут `releaseAgentInfoBaseForBatch` (→ `releaseInfoBase`) и запускают операцию отдельно; `AgentInfoBaseSession.getLastActivityAt` тоже не используется (только диагностика в тестах). В Э9 (PS-хост) либо перевести исполнителей на `runWithInfoBaseReleased`, либо удалить его и `getLastActivityAt` вместе с опцией `clock`.
- **Н18 (Э4 → документация Э10)** `releaseAgentInfoBaseForBatch` при пустом кэше в агентском режиме проверяет порт агента (до 500 мс) перед КАЖДОЙ пакетной операцией. Принудительный `disconnect-ib` найденного внешнего агента по §5b п.1 избыточен (подключение ИБ не переживает закрытие SSH-сессии, а свежая сессия заведомо не подключена) — оставлен как безопасный по умолчанию; отметить в документации Э10, решить, нужен ли.
- **Н19 (Э4)** `DbRunCommandRunner`: проверка `isConfigurationOperationRunning()` и запуск Конфигуратора не атомарны — операция, стартовавшая между проверкой и `disconnectInfoBase`, встанет в очередь сессии за ним (данные не портятся, но база окажется отключённой под стартующей операцией до её ленивого `connect-ib`).
- **Н20 (Э4)** `AgentInfoBaseSession.dispose` не ждёт очередь и не запрещает `run` после dispose (снимает только idle-таймер); корректно лишь потому, что dispose вызывается на deactivate вместе с закрытием SSH-сессий.
- **Н21 (Э4)** Явный `disconnectInfoBase`, когда транспорт подключения уже потерян (`connectedTransport.isClosed?.()`), шлёт лишний `disconnect-ib` в новый SSH и получает «не подключено». Безвредно; можно сразу сбрасывать состояние без команды.
- **Н22 (Э4)** `DesignerAgentSessionManager` выбрасывает потерянный транспорт без явного `dispose()` — опирается на то, что ssh2 всегда закрывает соединение после `error`. Для надёжности звать `dispose()` при пересоздании.
- **Н23 (Э4)** Помещение в хранилище: при сбое обновления перед помещением введённый в форму комментарий теряется (UX).
- **Н24 (Э5 → Э8) — ЗАКРЫТ в Э8** подсказкой в сообщении `resolveLocalAgentUserRoot` (ключ `/AgentBaseDir` в `v8vscedit.agent.agentModeArgs`); для удалённого агента agentbasedir.json не нужен — корень SFTP уже персональный. Исходная формулировка: Внешний (не автозапущенный расширением) локальный агент: его `/AgentBaseDir` неизвестен, сервис ищет `agentbasedir.json` в каталоге по умолчанию (`<проект>/.v8vscedit/agent`) или по `/AgentBaseDir` из `agentModeArgs` и при другом каталоге падает с «не удалось прочитать индекс» без подсказки. В Э8 — явная настройка каталога агента либо подсказка в сообщении `resolveLocalAgentUserRoot` (`LocalAgentFileStore.ts`).
- **Н25 (Э5 → Э7)** Первый проход `mirrorAgentToProject` читает всё M ради сравнения, второй — повторно изменённые файлы: для SFTP это двойная передача. Не подключать SFTP-хранилище к этому зеркалу до движка Э7 (манифест + план).
- **Н26 (Э5 → Э7)** `AgentTransferResult.cancelled` зеркало не использует и отмену не передаёт (операции агента пока не отменяемы) — учесть в Э7 при прокидывании `CancellationToken`.
- **Н27 (Э5)** После обновления на старой раскладке на диске остаются `<AgentBaseDir>/0/workspace/cf/cf` и `workspace/cfe-*` (прежний хардкод `'0'` и ключ сессии вместо `projectId`), а `lists/` копит по файлу на каждую частичную загрузку. Нужна уборка: удаление list-файла после операции и разовая чистка старой раскладки.
- **Н28 (Э5)** `LocalAgentFileStore.assertInside` на каждый вызов дважды делает `realpath`, включая неизменный корень; на тысячах файлов выгрузки — лишние системные вызовы. Кэшировать реальный корень при первой проверке.
- **Н29 (Э6 → Э7/Э8)** `SftpAgentFileStore` кэширует известные каталоги, чтобы не делать STAT на каждой записи. Кэш сбрасывается собственным `remove` и полностью — после любого отказа записи. Гонка «каталог создан другим клиентом между STAT и MKDIR» закрыта: после отказа MKDIR — повторный STAT. Остаётся случай, когда каталог удалили помимо хранилища (агент пересоздал выгрузку): первая запись в него падает с NO_SUCH_FILE, повтор проходит. Нужен один автоповтор внутри `writeFile` после NO_SUCH_FILE на OPEN, когда родитель взят из кэша, либо повтор силами движка Э7.
- **Н30 (Э6)** Перезапись в режимах `atomic`/`auto`: сначала RENAME временного файла прямо в цель. На агенте (rename перезаписывает, §5b п.12) это один запрос, без STAT и без окна, когда цели нет. Резервная схема (цель → `.<имя>.<tag>.v8bak`, RENAME, удаление резерва) включается только при FAILURE на существующем файле, то есть на стандартном SFTP v3; при отказе второго RENAME прежний файл возвращается. Если не удался и возврат, ошибка называет путь `.v8bak` с прежним содержимым, но сам файл никто не убирает. В режиме `direct` обрыв посреди записи оставляет цель усечённой — без RENAME атомарности нет.
- **Н31 (Э6)** План называет точку входа `ProcessDesignerAgentTransport.openSftp()`, а реализовано отдельное `connectSftpAgentFileStore(options, deps)`: у SFTP своё SSH-соединение (§5b), shell-транспорт его не открывает. Политика повторов Э3 вынесена в `infra/agent/AgentConnectRetry.ts` и общая для обоих соединений. Состояние `lastRefusedAt` у них раздельное (у каждого свой экземпляр цикла). В Э8 решить, нужен ли общий экземпляр на одну конечную точку.
- **Н32 (Э6 → ОБЯЗАТЕЛЬНО до Э7)** `SftpAgentFileStore` читает и пишет последовательно, порциями по ~32 КБ, по одной в полёте: при задержке 80 мс это около 400 КБ/с. Архив `dump --archive` так передавать нельзя. Нужен конвейерный обмен (несколько порций в полёте, как `fastGet`/`fastPut` ssh2) или потоковый API хранилища.
- **Н33 (Э6)** `createDir` делает STAT поэлементно по предкам, хотя `mkdir` агента сам создаёт промежуточные каталоги (§5b п.12): первый проход по новому дереву платит лишние запросы. На агенте можно сначала пробовать MKDIR полного пути, а поэлементный путь оставить запасным для стандартного SFTP.
- **Н34 (Э6)** `readFile` делает лишний READ ради EOF; можно ориентироваться на размер из FSTAT. Проверить на стенде, что агент на `stat` пути с файлом в середине отвечает NO_SUCH_FILE: эмулятор отвечает так, а агент может дать FAILURE — тогда `stat` бросит вместо `undefined`. Нет таймаута на открытие подсистемы SFTP (как и на shell в транспорте) — общий пункт для обоих соединений.
- **Н35 (Э6)** Проверить на стенде, что RENAME агента НЕ заменяет существующий **каталог** (пилот §5b п.12 проверял только файл): предварительного STAT больше нет, защиту от записи файла поверх каталога даёт только сервер. Вместе со стендовой проверкой Н34.
- **Н36 (Э6, косметика)** В схеме с резервом при отказе прицеплять исходную FAILURE RENAME в `cause`; в `removeRecursive` переходить на обход дерева только при FAILURE (сейчас — при любой ошибке RMDIR, при PERMISSION_DENIED обход успевает удалить часть файлов).
- **Окружение (скрытый прогон)** `schtasks /End` гасит только `powershell` исполнителя, а дочерние `Code.exe` от SYSTEM остаются сиротами в сессии 0 и держат single-instance — следующий `test:hidden` падает «only supported if no other instance of Code is running», убить их можно только от администратора. Исполнителю нужно запускать npm в Job-объекте (или `taskkill /T /F` по дереву при остановке) и чистить сирот при старте. **Частично исправлено:** `runner.ps1` до и после прогона убивает `Code.exe` из `.vscode-test` репозитория в сессии 0 (`Stop-OrphanTestCode`); сироты живут до следующего запуска, Job-объект — не сделан.
- **Окружение (утечка заглушки)** Упавший `beforeEach` в `metadataChangesViewProvider.test.ts` (нет `example/2.21`) не восстанавливает заглушку `vscode.commands.executeCommand`, и она протекает в тесты замков `cfeBatchCommandsRegistration` и `agentBatchRelease` при широком прогоне. Восстановление заглушки — в `teardown`/`finally`, а не в конце `setup`.
- **Окружение (флейк)** `repositoryCommandRunner.test.ts` «привязка / нет привязки — исключение» зависит от `env.json`, оставленного предыдущим тестом (в сборном прогоне получает «отсутствует --ibconnection»); тест должен сам готовить своё окружение.
- **Окружение** Сборный прогон с сьютами `MetadataCache`/`CfeBatch`/`CfeBorrow` зависает (>580 с) — вероятно, тот же корпус `example/2.20`, что вешает полный `npm test`; выяснить. **Уточнено 2026-11-18:** `MetadataCache` виснет на тесте «HTTP-сервис: URL-шаблоны и методы висят прямо на узлах… (flatChildren)» — он падает (нет `example/2.21`), затем «Extension host is unresponsive»; файлов не пишет, с изменениями `AtomicFileWriter` не связан.

- **Н37 (Э7)** Аудит оставшихся ~20 вызовов `fs.rmSync` в production `src` (`rg "rmSync\(" src` без тестов: `cli/core/onecCommon.ts`, `infra/fs/StagingFile.ts`, `infra/xml/MetadataXmlRemover.ts`, `infra/agent/DirectorySnapshot.ts`, `infra/git/GitWriteService.ts`, `ui/commands/ext/*` и др.) на кириллицу в именах (§5b п.17): CLI `dist/cli` может запускаться системным Node 24. Выяснить версию Node в Electron VS Code и воспроизводится ли дефект там. Исправлено в Э7: `AtomicFileWriter` (уборка temp), `LocalAgentFileStore.remove` (recursive), запись в проект движка.
- **Н38 (Э7) — ЗАКРЫТ** Манифест B был в `.v8vscedit/agent/sync/` — внутри каталога агента по умолчанию (`/AgentBaseDir` = `.v8vscedit/agent`), где агент свой каталог может чистить или расширять, а пользовательский `/AgentBaseDir` может указывать куда угодно. Решение оркестратора: `<projectRoot>/.v8vscedit/agent-sync/<sha1(scopeKey)>.json`; проверка Э5 «в agentBaseDir только `<dir>` и `agentbasedir.json`» работает без исключений.
- **Н39 (Э7, покрытие) — ЗАКРЫТ** Защитные ветки закрыты тестами: `ArchiveCodec` (центральный каталог вне архива и zip64, битая запись центрального каталога и нехватка записей, битый локальный заголовок, данные за пределами архива, неподдерживаемый метод, несовпадение размера, длинный буфер без конца каталога), `SftpAgentFileStore.readAll` (короткие ответы READ — `readResponseLimit` эмулятора; EOF раньше размера FSTAT), сбой уборки `exchange`, исчезновение владельца «конфигурация» из M при дельте. Под `c8 ignore` с обоснованием: упаковка > 4 ГБ (нужна выгрузка такого размера в памяти теста) и ветка `compare` в удалённом импорте (недостижима по контракту планировщика).
- **Н40 (Э7)** Распаковка архива держит в памяти весь zip и делает четыре прохода инфляции (валидация + сравнение, валидация + запись) — цена «всё или ничего» без staging на диске. Zip64 (> 4 ГБ) не поддерживается — явная `ArchiveFormatError`. На очень больших выгрузках рассмотреть staging во временный каталог и одну инфляцию.
- **Н41 (Э7)** Закрыты: Н25 (дельта держит файлы в памяти, двойной передачи нет; `AgentWorkspaceMirror` удалён), Н26 (`hooks.cancellation` → `AgentSyncCancelledError`, отмена до первой записи в P), Н32 (окно 16 порций READ/WRITE по смещениям в `SftpAgentFileStore`). Н27 (накопление `lists/<op>.txt`) остаётся: тесты Э7 читают list-файл после операции; каталог обмена `exchange/<op>` убирается в `finally`.
- **Н42 (Э7 → Э10, документация)** После дельта-импорта `ConfigDumpInfo.xml` в P устаревает: дельта его не скачивает (33,7 МБ на сервере пользователя), обновляют его только архивная ветка и локальное сравнение. Инвариант «P ≡ M» нарушен ровно на одном неотслеживаемом файле; для пакетного режима безопасно (он файл версий проекта не использует, загрузка архивом его не берёт). Описать в Э10.
- **Н43 (Э7, было и до Э7)** B отслеживает только `*.xml`/`*.bsl`/`Template.*` (`isSupportedConfigFile`): дельта-импорт не откатывает локальные правки картинок, справки, `.bin` и прочих неотслеживаемых файлов, а частичная загрузка их не передаёт. Решить, расширять ли набор отслеживаемых файлов (вместе с HashCache — критерий один).
- **Н44 (Э7) — ЗАКРЫТО 2026-11-18** пилотом §5b п.18: агент принимает и обычный архив `packArchive`, и zip64.
- **Н45 (Э7)** Пределы распаковки: запись > 1 ГБ (по заголовку, до выделения памяти) и коэффициент сжатия > 500:1 у записей > 16 МБ — отказ. Суммарного предела распакованного размера нет: архив целиком в памяти, распаковка по записям; при необходимости добавить вместе с Н40.
- **Н46 (Э7, стенд пользователя)** Чтение архива, который сама платформа выдаёт `dump --archive` на конфигурации > 65 535 файлов (zip64 от 1С), на реальном агенте не проверено — тестовая база мала. Риск — только отказ (`ArchiveFormatError`, P не трогается), не потеря данных. Проверить одним замером на базе разработки: `config dump-config-to-files --dir=X --archive=full.zip`, затем прочитать `full.zip` нашим `extractArchive`.
- **Н47 (Э8, движок Э7) — ЗАКРЫТ в Э8** вариантом (а): `planLoad` для удалённого агента при пустом M и известной B (без удалений/переименований, не выше порога) даёт `partial` с подготовкой `full-dump` — очистка M и `dump --dir=M --force` без `--update` и без скачивания (БД ≡ B), затем частичная загрузка; причина `mirror-empty` у загрузки упразднена. Тесты: таблица `syncPlanner.test.ts`, `agentSyncEngine.sftp.test.ts`, цикл без импорта в `agentRemoteWiring.test.ts`. Исходная формулировка: Удалённый агент: полная загрузка архивом (`loadFullByArchive`) M не наполняет, и у проекта, который ни разу не импортировался, M на сервере пуст — каждая следующая загрузка «по изменениям» снова идёт полной архивом (`mirror-empty`), пока не будет импорта. Тест цикла в `agentRemoteWiring.test.ts` поэтому начинается с импорта. Варианты: после полной загрузки архивом делать полную выгрузку в M без скачивания (БД ≡ P) либо документировать «сначала импорт».
- **Н48 (Э8)** Сброс кэша сервисов агента при смене `v8vscedit.agent.*`/`v8vscedit.remote.*` откладывается до освобождения `configurationOperationLock` (`runWhenConfigurationOperationIdle`). Защищены только операции под замком; агентская операция вне замка (если появится — например, MCP-инструмент без замка) потеряет SSH при смене настроек. В локальном режиме сброс останавливает автозапущенный процесс агента — следующая операция запустит его с новыми настройками.
- **Н49 (Э8, решение по Н31)** Общий экземпляр цикла повторов на конечную точку не заведён: shell и SFTP операций держат свои экземпляры (как в Э6), проверка подключения — свою нулевую политику (одна попытка на часть). Причина отказа подключения теперь поле `AgentConnectFailedError.reason`, а «нет подсистемы SFTP» — код `SFTP_SUBSYSTEM_UNAVAILABLE_CODE`: диагностика не разбирает тексты.
- **Н50 (Э8 → ОБЯЗАТЕЛЬНЫЙ ГЕЙТ ДО СЛИЯНИЯ В MAIN)** Нет проверки ключа хоста SSH: `buildSshConnectConfig` (`ProcessDesignerAgentTransport.ts`) не задаёт `hostVerifier`, и пароль ИБ по сети уйдёт любому MITM. Нужен TOFU: отпечаток SHA256 по `host:port` в `globalState`, модальное подтверждение при первом подключении, блокирующий отказ при смене ключа с явным действием «доверять новому ключу»; `checkConnection` показывает отпечаток. Плюс стендовый замер: сохраняет ли агент ключ хоста между перезапусками (`/AgentSSHHostKeyAuto` против `/AgentSSHHostKey`).
- **Н51 — ЗАКРЫТ в Э9 решением оркестратора (2026-11-18)**: хранилище в remote идёт через удалённый исполнитель (`RemoteDesignerBatchExecutor`). Остальные операции локального 1cv8 (`runInternalCliCommand` — CF/CFE-файлы, пакеты расширений, список расширений; `DbRunCommandRunner` в режиме DESIGNER) решают по ВИДУ базы `--ibconnection` env.json (чистая `classifyInfoBaseConnection`, `infra/process/designer/InfoBaseConnectionArgs.ts`; политика — `ui/commands/ext/agent/remoteLocalDesigner.ts`): файловая (`/F`, `File=`) — явный отказ до побочных эффектов (путь указан для сервера, локальному 1cv8 недоступен или ведёт в другую базу); клиент-серверная (`/S`, `Srvr=`) — выполняются локально как раньше (та же база по сети, медленнее), одна строка журнала о локальном Конфигураторе, без уведомлений; клиент-серверная с ПЕТЛЕВЫМ адресом сервера (`localhost`, `127.x.x.x`, `.`, `::1`, с портом) — вид `server-loopback`, отказ как для файловой (строка записана с точки зрения сервера, локальный 1cv8 ушёл бы в кластер на машине пользователя; ревью Э9, B3); вид не распознан (нет env.json) — как раньше. ENTERPRISE не меняется. Причина: у пользователя база клиент-серверная, тотальный отказ лишил бы его загрузки CF/CFE, пакетов расширений и интерактивного Конфигуратора без замены. Исходная формулировка: В `remote` + `agent` чисто пакетные операции (CF/CFE-файлы, пакеты расширений, список расширений, хранилище, интерактивный Конфигуратор) до Э9 запускают ЛОКАЛЬНЫЙ 1cv8 по `--ibconnection` из env.json — для `/F` с серверным путём это ошибка или другая база. До Э9 — отказ или предупреждение в `runInternalCliCommand` / `runRepositoryCliCommand` / `DbRunCommandRunner`.
- **Н52 (Э8)** Локальный внешний (не автозапущенный) агент при `dispose` реестра получает `common shutdown`; вероятно, `shutdownOnDispose` должен быть `ownProcess !== undefined`.
- **Н53 (Э8)** Local: отложенный сброс кэша асинхронный — новый автозапуск может застать старый агент ещё на порту.
- **Н54 (Э8)** `resetConfigurationOperationStatus` внутри отложенного сброса (`disposeCachedAgentOperationServices`) стирает итоговый статус только что завершившейся операции.
- **Н55 (Э8)** Смена пароля ИБ в SecretStorage не сбрасывает кэш сервисов агента: до перезапуска/смены настроек используется прежний пароль.
- **Н56 (Э8)** После ветки загрузки `full-dump` (пустой M на сервере) правки базы мимо расширения (интерактивный Конфигуратор, другой разработчик) скрыты от инкрементального импорта: объект X, изменённый в базе и не изменённый в P, попадает в свежий M, но не в P; B = hash(P), M — fresh, и следующий `--get-changes` X уже не покажет. Данные в базе не теряются (частичная загрузка не трогает X — лучше прежней полной). Исправление: флаг манифеста «следующий импорт — полный» (ставит `full-dump`, снимает успешный импорт архивом) либо документирование в Э10.
- **Н57 (Э9)** Хост PowerShell декодирует stdout/stderr дочернего процесса как UTF-8 (`StandardOutputEncoding`); 1cv8 в пакетном режиме почти ничего не печатает (результат — лог `/Out`, он передаётся байтами и декодируется `decodeDesignerLogBytes`), но OEM-вывод (например `cmd`) придёт кракозябрами в журнал. При появлении значимого вывода — передавать байты строки и декодировать на стороне TS (`decodeProcessOutput`).
- **Н58 (Э9, стенд пользователя)** Удалённая ветка хоста (`New-PSSession`, `Invoke-Command -Session`, `Copy-Item -FromSession`, `sessionBroken` по `$S.State`) тестами не исполняется — в тестах `computerName=''` (тот же протокол в процессе хоста). Проверить на сервере пользователя: `v8vscedit.remote.checkConnection`, захват/выгрузка из хранилища; отдельно — `-ArgumentList` с `$null`-элементами (`resolveV8` по версии) и опрос `run` (раз в 250 мс через `Invoke-Command`).
- **Н59 (Э9)** `PowerShellRemoteHost.dispose` ждёт штатного выхода хоста после закрытия stdin до 5 с и только затем убивает процесс; ветка принудительного завершения тестом не покрыта (поддельный хост выходит по закрытию stdin сам).
- **Н60 (Э9)** Таймаутов на запросы хоста нет: зависшая WinRM-сессия (сеть) держит очередь до отмены пользователем (`run`) или навсегда (`connect`/`fetch`/`put`). Ввести таймаут на `connect` и служебные операции при первом наблюдении на стенде.
- **Н17 (Э4 → Э9) — не решён в Э9**: удалённый исполнитель подключён тем же путём, что локальный (`releaseAgentInfoBaseForBatch` перед запуском), `runWithInfoBaseReleased` по-прежнему не используется; решить вместе с документацией Э10.

- **Н61 (ревью Э9) — ЗАКРЫТ в Э9**: `New-PSSession -SessionOption (New-PSSessionOption -IdleTimeout 600000)` — если powershell.exe клиента убит, сессия и 1cv8 на сервере живут не дольше 10 мин простоя (а не ~2 ч по умолчанию), не держа базу. Следствие (после простоя > 10 мин сессия закрыта сервером) закрыто Н62: безопасный запрос повторяется на новом процессе.
- **Н62 — ЗАКРЫТ в Э9**: `PowerShellRemoteHost.call` повторяет `ping`/`resolveV8`/`mktemp`/`rmtemp`/`fetch` ОДИН раз на новом процессе при `session-broken`/`host-exited` (журнал «повтор … на новом процессе хоста»); `put` и `run` не повторяются, `remote-error`/`auth-failed`/`protocol` — тоже. Отдельный ping перед `run` не нужен: исполнитель всегда начинает с `mktemp`, который переподнимает сессию. Тест «перезапуск ровно один на запрос» переведён на `put`. Исходная формулировка: Повтор БЕЗОПАСНЫХ (идемпотентных) запросов `resolveV8`/`mktemp`/`ping` один раз при `session-broken`/`host-exited` — особенно важен вместе с Н61: первая операция после простоя иначе падает с разрывом сессии. Учесть тест «перезапуск ровно один на запрос» (сейчас закрепляет отказ без повтора для `ping`).
- **Н63 (ревью Э9)** `put` передаёт содержимое base64 через `Invoke-Command`: объект целиком в памяти, предел квоты MaxReceivedObjectSizeMB и разбор `ConvertFrom-Json` строки запроса. Для ObjectsFile (КБ) достаточно; крупные входы (CF/CFE для загрузки) — только `Copy-Item -ToSession`. Неточный комментарий про MaxEnvelopeSize в `PowerShellHostScript.ts` исправлен в Э9.
- **Н64 (ревью Э9) — ЗАКРЫТ в Э9**: `$global:ErrorActionPreference = 'Stop'` выставляется в удалённой сессии (`$Init`), иначе ошибки командлетов там не прерывали бы скрипт-блок; `$global:V8R` обнуляется в начале запуска — сбой `Process.Start` не оставляет данных прошлого запуска.
- **Н65 (ревью Э9)** `ExtensionCommandRunner.ts` — 1250 строк (порог ~800, запрет №17): в Э9 добавлен только вызов политики Н51; декомпозиция — отдельный долг.
- **Н66 (ревью Э9)** `parseIbConnection` в `RepositoryCommandRunner` (и копии в `connectionSettings`/`DbRunCommandRunner`) не понимает `File=`/`Srvr=` и `/S srv\base` — свести к одному разбору поверх `classifyInfoBaseConnection` (`infra/process/designer/InfoBaseConnectionArgs.ts`).
- **Н67 (ревью Э9)** stderr и шум хоста PowerShell пишутся в журнал (`[remote-ps]`) без маскирования секретов; сам хост пароль не печатает, но текст ошибки PowerShell может процитировать командную строку `run` (пароль БД в `/P…`). Маскировать значениями `request.secrets` активного запроса.
- **Н68 (повторное ревью Э9)** `auth-failed` вне `obtainHost` не стирает пароль: пароль сменили в домене, хост уже в кэше, переподключение идёт при повторе/после разрыва → каждая следующая операция делает один неудачный вход. Общий обработчик `auth-failed` (стереть пароль, закрыть хост) и подсказка про `v8vscedit.remote.resetPassword` в тексте ошибок входа.
- **Н69 (повторное ревью Э9)** Распознавание отказа аутентификации — только `ErrorCode` 5/1326/1909/1311; добавить HRESULT-формы `0x8007052E` (-2147023570) и `SEC_E_LOGON_DENIED` `0x8009030C` (-2146893044); 1311 (нет контроллера домена) — не неверный пароль, стирает верный зря (безопасно). Окончательный набор — по пилоту.
- **Н70 (повторное ревью Э9)** `classifyInfoBaseConnection` не видит петлю в форме с внутренней кавычкой `/S"localhost\base"` (хост `"localhost` → `server`); снимать кавычки внутри `isLoopbackAddress`.
- **Бэклог по итогам задачи «дельта по mtime и прогресс» (2026-11-19):**
  - **Н71** Тот же отбор по mtime в `importByCompare` (локальный агент: сейчас 97 тыс. чтений и сравнений). `mtimeMs` у `LocalAgentFileStore` уже есть.
  - **Н72** Сохранять в манифесте владельцев незавершённой операции (`pendingOwners`), чтобы сбой или отмена после `--update` не переводили M в `empty` (цена отмены — следующий импорт через посев).
  - **Н73** Кнопка «Отмена» у загрузки (`updateDatabaseConfiguration`): после аудита `AgentLoadFlow` — проверки отмены стоят только до команды `load`, но нужны отдельные тесты.
  - **Н74** Не сбрасывать транспорт и не делать `disconnect-ib` при отмене пользователем вне `execute` (канал здоров).
  - **Н75** Счётчик в `buildSyncManifestFiles`/`scanHashSnapshot` (97 тыс. файлов: сейчас шаг «Проверка локальных изменений проекта…» без счётчика); параллельная очистка зеркала.
  - **Н76** Полоса `increment` для доминирующего этапа (скачивание), если появится понятная модель весов этапов; сейчас полоса неопределённая, процент в тексте.
  - **Н77** Переход часов сервера (летнее время, откат NTP > 2 с) между меткой и `--update` может сделать переписанные файлы «старше» метки; растяжка ловит только «ни одного свежего». Страховка: вторая метка после LIST, при `end < start` — полное сравнение. Для серверов без перехода на летнее время риск мал.
  - **Н78** Сила растяжки зависит от состава кандидатов: свежий `Configuration.xml` при изменении корня её отключает, даже если платформа частично сохранила mtime.
  - **Н79** Правку P с тем же размером и mtime, не замеченную stat-мемо, теперь ловит только сверка размера (раньше файлы изменённых владельцев сравнивались по содержимому всегда).
  - **Н80** В журнал пишется ответ на вопрос агента о логине (пароль скрыт `isSecretQuestion`); решить, считать ли логин чувствительным.
  - Стенд: проверка отбора по mtime на клиент-серверной базе (п.30, пункт 21 чек-листа); номера Н71–Н76 соответствуют Б1–Б6 плана `.v8vscedit/plan-delta-progress.md` §8.
- **Пилот Э9 (дополнение)** Снять `ErrorCode` и текст отказа New-PSSession при неверном пароле (Negotiate и Kerberos), заблокированной учётке, недоступном контроллере домена; убедиться, что на одно действие пользователя сервер фиксирует ровно один неудачный вход. Простой дольше IdleTimeout (10 мин) → операция: `mktemp` проходит повтором на новом процессе, `run` — штатно.

- **Точечное восстановление грязных файлов при разреженном M** — РЕАЛИЗОВАНО (задача «полная выгрузка — только когда без неё нельзя»): `dump --list-file` проверен на агенте (§5b п.21), `SparseRestore` выгружает файлы в каталог обмена; архив `sparse-mirror-dirty` — только запасной путь. Не проверено: `--list-file` для расширения (`--extension`).
- **Посев на пути загрузки** (`prepareMirror: 'full-dump'`): отложен решением оркестратора, в задачу посева не вошёл; сейчас там по-прежнему полная серверная выгрузка в M.
- **Бэклог из ревью задачи «полная выгрузка — только когда без неё нельзя»:**
  - **ЗАКРЫТ (задача «захват с получением версий», 2026-11-19):** Вложенный пул LIST: владельцы × файлы внутри пула дают до `transferConcurrency × 8` одновременных OPENDIR на SFTP агента — проверить на пилоте или ограничить общим бюджетом запросов.
  - **ЗАКРЫТ (задача «захват с получением версий», 2026-11-19):** Вопрос `confirmFullDump` на пути загрузки: `AgentLoadFlow` (`prepareMirror: 'full-dump'`, полная загрузка) вопроса не задаёт.
  - **ЗАКРЫТ (задача «захват с получением версий», 2026-11-19):** Текст отказа после посева `project-replaced` при отмене в фазе 2 (манифест `empty`) не объясняет, что зеркало уже обновлено.
  - **ЗАКРЫТ (задача «захват с получением версий», 2026-11-19):** Явная проверка вместо `restorePrefix='/'` в дельте (`AgentImportFlow`): пустой каталог восстановления кодируется косвенно.
  - **ЗАКРЫТ (задача «захват с получением версий», 2026-11-19):** Текст `AgentTransferError` для STAT/LIST (`forEachConcurrent`) говорит о «передаче файла»; нужен нейтральный `describe`.
  - **ЗАКРЫТ (задача «захват с получением версий», 2026-11-19):** Лишнее хеширование `ConfigDumpInfo.xml` при отсутствии хука `confirmMirrorSeed`/сирот (отпечаток считается всегда).
  - Дельта при `FullDump` сравнением двух CDI (§5b п.9, п.16: `--update` инкрементален и при удалениях), `--list-file` для `unresolved`, отдельный порог загрузки, сироты уровня подобъекта.
- **Бэклог по итогам задачи «захват с получением версий» (2026-11-19):**
  - Отмена во время паузы повтора `connect-ib` замечается только после следующей попытки (до 2 с).
  - «Проверить подключение» не ловит `1cv8c.exe` (только стартер `1cestart.exe`).
  - Дубль `requireTarget` в `RepositoryCommandRunner` и `repositoryNodeTargets` — свести к одному.
  - **ЗАКРЫТ (2026-11-19):** «Получение из хранилища» импортирует изменённые объекты в проект (`RepositoryUpdateCommand`, признак — строки «получен»/«удален», §5b п.25).
  - Цепочка «загрузка → операция хранилища → импорт по логу» почти построчно повторена в `RepositoryLockCommand` и `RepositoryUpdateCommand` — вынести в общую функцию (`repositoryPostSync`), если появится третья такая команда.
  - **ЗАКРЫТ (2026-11-19):** импорт после удаления/переименования объекта и удаления формы (основная конфигурация, `cf`) идёт без полной выгрузки: свежий CDI → очистка владельцев в M → повторный `--get-changes` → дельта; запасной путь — перезапись зеркала (§5b п.26–27, [architecture.md](../architecture.md#модель-синхронизации-m--p--b)). Для `cfe` прежний путь (архив).
  - **Бэклог по итогам:** (1) тексты отказа на вопросе `mirror-rewrite` не разведены по `download` — советуют ручную выгрузку, хотя архив не скачивается; (2) манифест не помечается `empty` до блока мутации (`pruneMirror`): при убийстве процесса после закачки CDI файлы удалённых владельцев могут остаться в P; (3) CDI проекта после дельты содержит записи удалённых объектов — выяснить, кто его читает (`ProjectDumpInfo`, посев/сироты) и не вводит ли это в заблуждение.
  - **Пилоты по итогам:** П1 — расширения: `--config-dump-info-only` с `--extension`, имя корня в CDI, снимает ли очистка `FullDump` (до этого `cfe` — архив); П2 — становится ли разреженный M полным после перезаписи (тогда `sparse-removed-parts` не нужен); П4 — время `--config-dump-info-only --archive` на БП КОРП и нужен ли повторный `--get-changes` на больших базах.
  - Если появится MCP-инструмент хранилища, он обязан вызывать ту же цепочку с импортом, а не голый `runRepository*Action`, иначе проект молча отстанет от базы.
  - Формы помещения/подключения (`RepositoryCommitViewProvider`/`RepositoryConnectionViewProvider`): повторный `show()` при открытой панели перезаписывает `resolvePromise`, не разрешив прежний, — первый вызов команды висит. Исправлено в фиксе формы помещения: служебное `ready` webview больше не закрывает форму (раньше помещение молча прекращалось).
  - Пакетный режим: импорт после захвата — частичный (`export-configuration -Mode Partial -Objects` захваченных и замена поддеревьев владельцев в проекте) вместо полной выгрузки.
  - Нестабильный тест `RepositoryCommandRunner › нет привязки` (кэш `env.json` по mtime) — дефект теста, вернуть автору.
  - Э15 (ручной пилот): сколько повторов `connect-ib` на клиент-серверной базе 1cDev после пакетной операции хранилища через удалённый исполнитель; при выходе за 15 с — пересмотреть окно.
- **Запись zip64 > 4 ГБ**: `ZipStreamWriter` не пишет 64-битные смещения, архив > 4 ГБ отвергается (7,5 ГБ XML ≈ 1 ГБ в zip).
- **Связь с Н42 и посевом:** устаревший или чужой `ConfigDumpInfo.xml` проекта при посеве даёт безопасное сверхприближение (`Modified`/`FullDump` → порог/архив), но сам файл версий проекта после дельта-импорта по-прежнему не обновляется (Н42).

### Пилот Э9 (на сервере пользователя, вне конвейера)

1. Аутентификация PSSession: `Default`/`Negotiate`, подключение по IP, `useSsl` и нестандартный порт; при НЕВЕРНОМ пароле — сколько неудачных входов фиксирует контроллер домена за одну операцию (ожидается ровно один) и какой `ErrorCode` у PSRemotingTransportException (скрипт помечает `auth: true` для 5, 1326, 1909, 1311 — сверить).
2. `Copy-Item -FromSession` выгрузки `.cf` 100+ МБ: время, память, отсутствие обрыва по квотам.
3. Хранилище по UNC-пути и двойной прыжок Kerberos (сессия → общий ресурс); хранилище по `tcp://`.
4. 1cv8 `DESIGNER` в WinRM-сессии без рабочего стола: запускается ли, не ждёт ли диалогов, пишет ли `/Out`.
5. Отмена: убийство дерева `taskkill /T /F` на сервере; убитый powershell.exe клиента во время `run` — живёт ли 1cv8 на сервере и сколько (IdleTimeout, Н61).
6. Разрыв сети/WinRM посреди операции и после простоя > 10 мин: `session-broken`, перезапуск хоста, понятность сообщения.
7. Кириллица в путях и аргументах, большой лог `/Out` (сотни КБ) — base64 ответа без искажений.
8. Нагрузка опроса `run` раз в 250 мс через `Invoke-Command` на сервере и сети за долгую операцию.
9. Реальный текст лога `/ConfigurationRepositoryLock` (Н10) — СНЯТ в Э14 (§5b п.23); осталось: вид имени по всем видам объектов, захват корня конфигурации, строка «Захват объекта отменен».
10. Удалённая операция хранилища сразу после `disconnect-ib` агента: база действительно свободна для 1cv8 на сервере.

### Пилот формата отчёта и кодировки ObjectsFile (2026-11-16, 8.3.27.2130)

- `/ConfigurationRepositoryReport`: формат определяется ТОЛЬКО `-ReportFormat` (`mxl` → `MOXCEL…`, `txt` → текст UTF-8 с BOM); без `-ReportFormat` — ВСЕГДА MXL, расширение файла (`.mxl`/`.txt`/`.out`) игнорируется.
- ObjectsFile (`-Objects`): принимаются UTF-8 с BOM и без, UTF-16LE с BOM; cp1251 без XML-декларации отвергается (`Input is not proper UTF-8`, exit 1) — передача байтов как есть (Н2) корректна.

### Бэклог по итогам стенда 2026-11-19 (keepalive, переименование реквизита ТЧ)

- Обнаружение мёртвого SSH-соединения таймаутом команды по отсутствию прогресса (keepalive агента во время команды не отвечает, §5b п.29).
- **ЗАКРЫТ (задача «дельта по mtime и прогресс», 2026-11-19):** У прогресса импорта нет кнопки отмены: при зависании выход только перезагрузка окна, а она теряет in-memory отметку `mutated` — манифест пришлось править вручную. Теперь у импорта `withProgress` с «Отмена»; отмена после мутации M пишет манифест `empty` и предупреждение в журнал (у загрузки кнопки нет — Н73).
- **ЗАКРЫТ (та же задача):** Журнал молчал между «Агент сообщил FullDump: зеркало очищается…» и концом операции (повторный `--get-changes`, `--update`, LIST, хеш проекта, STAT, скачивание, запись): десятиминутное скачивание совпадающих файлов выглядело зависанием. Теперь один источник прогресса (`SyncProgress`) с этапами и счётчиками, строки ожидания ответа пользователя; скачивание сокращено отбором по mtime (п.30 §5b).
- После пакетного получения из хранилища агент не принял SSH-подключение («не отвечает») — разобрать.
- Возможные дефекты продукта: `GitStatusReader.resolveGitRoot` отдаёт путь с прямыми слэшами (`C:/…`); `RepositoryService.readEnvFile` кэширует `env.json` только по mtime (нужен ключ mtime+size); нет правила eol в `.gitattributes` для `src/test/fixtures/**/*.info`; потерянное SFTP-хранилище остаётся в `AgentOperationService.files` до `dispose`.
- Тест `resolveFullDump`/`planPrune` на пропавшую встроенную запись (и встроенную запись корня → `rewrite-mirror`).

### Бэклог по итогам задачи «большие файлы» (2026-11-20, Э26/Э27)

- Прогресс скачивания АРХИВА перевести на `TransferProgress` (1 файл, байты из FSTAT, скорость и ETA): сейчас у архива прежний счётчик «каждые 10% / 16 МБ».
- Потоковая распаковка архива: записи архива больше порога сейчас обрабатываются прежним путём, без `writeTo`.
- Полная загрузка P → БД везёт `.cf` поставщика архивом: большой файл идёт в архив целиком (шлюза на пути загрузки нет).
- Несколько SFTP-соединений для скачивания: Э26 показал, что на стенде упирается канал, окно запросов не помогает — вернуться, если появится стенд с быстрым каналом.
- Таймауты MCP-инструментов на долгих операциях (час скачивания больше любого разумного таймаута клиента).
- Проверка шлюза поставщика на реальном обновлении поставщика (БП КОРП) — пункт 23 чек-листа; при опровержении допущения — `VENDOR_CONFIGURATION_GATE_ENABLED = false`.
- Попутный фикс сделан в `applyProjectChanges` (путь, исчезнувший к моменту удаления — переименование регистром на Windows, пропускается); системный разбор `caseCollisions` не менялся.

### Бэклог по итогам задачи «расширения и CF/CFE через агента» (2026-11-20, Э28-Э31)

- Тексты E3/E5 (`stubDumpRefusedText`, `extensionMissingText`) лежат в `domain/agent/AgentExtensionPlan.ts`, а не рядом с остальными в `infra/agent/extensions/AgentExtensionMessages.ts` - вынести.
- `pruneCfExchangeLeftovers` и два окна VS Code на одном проекте: уборка остатков обмена одного окна может задеть живой обмен другого.
- `fs.rmSync` в `StagingFile.moveStagingToTarget` (`infra/fs/StagingFile.ts`) - частный случай Н37 (кириллица в имени).
- `runUpdateExtension`/`runCompileExtension` через цепочки хранилища не silent: тост E11 появляется и в MCP-хранилище.
- Декомпозиция по порогу ~800 строк: `ExtensionCommands.ts` (998) и `ExtensionCommandRunner.ts` (1223).
- Запоздалое сообщение предыдущей команды при `terminalTypes` неотличимо от ответа (в протоколе нет id сообщений).
- `refreshConfigurationHashCache` по-прежнему идёт через `runInternalCliCommand` (локальный CLI) даже в агентском режиме.
- Таймаут по отсутствию прогресса для ДЛИННЫХ команд агента (`dump-cfg`/`load-cfg` на ГБ) - по-прежнему открыт; срок 30 с защищает только короткие команды.

### Бэклог по итогам задачи «быстрая базовая линия» (2026-11-21)

- Двойной полный снимок P при посеве из проекта (`ProjectSeed.ts` и снимок №0 в `AgentImportFlow.importPhase2`): между ними модальный вопрос, поэтому второй снимок пока оправдан. Кандидат: переиспользовать первый, если по stat-мемо между вопросом и фазой 2 изменений нет.
- Хешировать P во время `compare` (локальный агент), чтобы и он собирал B инкрементально, а не полным проходом.
- Сигнал отмены внутрь потокового `hashFile`: сейчас `discard()` обрывает проход между файлами, начатый большой файл дочитывается.
- Ложный полный проход `case-mismatch` на регистрозависимой ФС: там `A.xml` и `a.xml` - разные файлы, а проверка регистра по `readdir` всё равно откатывается на полный проход.
- Флейки-таймауты 2000 мс: сьюты `ChangesHistorySection` (синхронный setup git-репозитория) и `ChangedObjectFiles` `collectOwnerFiles` под нагрузкой. Дефект тестов (поднять срок/вынести setup), не окружения.
**Бэклог по итогам переподключения SFTP (2026-11-21):**
- `ProcessDesignerAgentTransport.handleClose` обнуляет клиент без `client.end()`, и `reset()` при пустом клиенте ничего не делает: при закрытии только shell-канала ssh2-клиент и SSH-сессия на сервере могут остаться — проверить на стенде, держит ли такая сессия базу.
- `AgentOperationService.dispose()` не ставится в очередь сессии: во время операции `getFiles` может открыть хранилище после dispose.
- `MUTATING_AGENT_COMMAND_VERBS` (AgentTransport.ts) — литералы глаголов отдельно от построителей команд (domain/agent, AgentInfoBaseSession): вывести из них.
- `AgentConnectionLostError.message` без предмета не содержит подсказки для мутирующих команд (она только в `operatorText`) — оговорить в JSDoc или добавить.

### Бэклог по итогам задачи «загрузка без обновления БД» (2026-11-21, Э32)

- Загрузка cfe с обновлением строит список расширений дважды (guard E6 до загрузки и сверка после): кандидат на один запрос.
- Синхронизация признака между окнами VS Code на одном проекте: `lag.json` читается при старте, живой синхронизации нет (кандидат - `FileSystemWatcher` на файл).
- Сбой загрузки CF/CFE ставит признак, даже если отказ случился до запуска `/LoadCfg` (валидация, `decideLocalDesignerInRemote`, нет настроек подключения): признак можно сузить условием «процесс запускался».
- В batch `v8vscedit_load_configuration_changes` при отказе частичной загрузки показывает модальный `confirmFullSyncFallback`, хотя вызов silent: нужно отвечать отказом с подсказкой.
- Batch-предпроверка `hasPendingHashChanges` даёт ложное «есть изменения», когда изменены только незагружаемые файлы (вторая отсечка CLI «No configuration files found in changes»); следствие - лишний признак, сторона безопасная.
- Отклонения developer: в цепочках хранилища тексты «Обновить БД» остались прежними; в `showConfigActions` новых пунктов нет (они только в `getNodeActions`); `updateDatabaseConfiguration` без узла и без отстающих целей показывает сообщение вместо запуска.

### Окружение и инструмент (не блокирует этапы, отдельные задачи)

1. ~~**Гейт `coverage:changed` на Windows неработоспособен:**~~ ИСПРАВЛЕНО коммитом b0dbcda (`lcovKeyRelativeToRoot`, проверено на реальном lcov 187/187). Остаётся зависание полного прогона на корпусе (п.2). ключи lcov с обратными слэшами (`src\infra\…`) не сопоставляются с путями git → «нет данных покрытия» у всех файлов (честный код 2, не ложный GREEN). Нормализовать пути в `scripts/patch-coverage/*` + фикстура lcov с Windows-путями. До исправления вердикт на Windows снимается копией гейта с нормализацией (так сделано на Э1 — scratchpad, `scripts/**` не тронут).
2. **Полный `npm test` на Windows не завершается** на корпусе БП КОРП (104 тыс. файлов): Extension Host перестаёт отвечать на сканах корпуса; плюс платформенные падения (git EPERM, `DesignerAgentProcess` EACCES/код выхода). Корпус на машине пользователя — только `example/2.20/src/cf` (другая конфигурация, чем та, по которой пиннились числа корпусных тестов): нет `2.21`, нет `cfe`, нет `example/2.20/env.json`. Нужен таймаут/фильтр корпусных сьютов или отдельный режим + классификация известных Windows-падений в «Известных технических долгах».
4. **Флейк `CfeBatchCommands: регистрируют РОВНО две команды`** (замечен на QA Э2): в список зарегистрированных команд попала посторонняя `workbench.action.output.show.TypeScriptTeam.jsts-chat-features…` из окружения тестового VS Code. Тест должен фильтровать команды по префиксу расширения (`v8vscedit.`), а не считать все.
3. **POSIX-семантика сигналов в тестах `cliProcess`:** Windows-вариант проверки гонки `forceKill` или конвенция пометки платформы.
