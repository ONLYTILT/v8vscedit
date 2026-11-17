# Архитектурный план: удалённый сервер 1С (агент по SSH/SFTP, хранилище через PSSession)

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
- **B** — базовая линия: манифест «отн. путь → sha1» всех файлов P на момент последней успешной синхронизации. Инвариант после любой успешной операции импорта или загрузки: P ≡ M по отслеживаемым файлам, и B = hash(P). Хранится в `.v8vscedit/agent/sync/<scope>.json` через `writeFileAtomic`.
- Флаг состояния M: `fresh | stale | empty`. Он хранится в том же файле манифеста.

**Импорт (БД → P):**

| Состояние | Действие |
|---|---|
| M `empty` (первый раз) | `dump --dir=M` (полный, только на сервере), затем `dump --archive=exchange/<op>.zip` → SFTP get → потоковая распаковка в P через `writeFileAtomic`, исчезнувшие файлы P удаляются. B = hash(P), M = `fresh`. Две выгрузки на сервере — разовая цена первого раза; оптимизация через упаковку на сервере средствами PS — см. риски. |
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
- **`sync/SyncManifest.ts`** (новый): `buildSyncManifest(dir)` (все файлы, sha1) и `load`/`save` манифеста в `.v8vscedit/agent/sync/<sha1(scope)>.json` через `writeFileAtomic`, вместе с флагом состояния M.
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

**Э10. Документатор.**
- `docs/architecture.md`: раздел «Удалённый сервер 1С» — модель M/P/B, жизненный цикл ИБ, guard, обоснование «нет MCP для хранилища», протокол PS-хоста.
- CLAUDE.md: пункт «Инварианта изменений» — «Новая пакетная операция Конфигуратора обязана идти через `DesignerBatchExecutor` + `runWithInfoBaseReleased`», раскладка `infra/agent/files|sync`, `infra/process/designer|remote`.

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
- **Н5** `buildInfoBaseConnectionArgs` живёт в `infra/repository`, но им пользуются все CLI-команды конфигуратора — при Э9 перенести в `infra/process/designer/`.
- **Н6** `RepositoryCommandRunner.ts`: `ConnectionParams` выразить как `InfoBaseConnection & { v8Path?: string }`; текст ошибки отсутствия подключения в UI потерял подсказку про `--ibconnection` в env.json.
- **Н7** Пропуск двух POSIX-тестов SIGTERM в `cliProcess.test.ts` на win32 — отдельным коммитом `test(cli): …`, не смешивать с Э1.
- **Н8** У существующих пользователей остаются накопленные `.v8vscedit/repository/objects/*.xml` — разовая уборка (отдельная задача).
- **Н9** Следить за EOL: `.gitattributes eol=lf`, рабочие копии не сохранять с CRLF.

- **Н10 (пилот 8.3.27.2130, файловое хранилище): частичный захват — успех.** `/ConfigurationRepositoryLock` со списком, где один объект не существует, → `exit=0` и «Захват объектов в хранилище успешно завершен»; несуществующие перечисляются в логе строкой «Объекты, отсутствующие в обеих конфигурациях: …», остальные захватываются. `RepositoryService.setLocked` после успеха помечает захваченными ВСЕ `fullNames` → при ошибке построения полного имени (`ONE_C_TYPE_NAMES`) локальный учёт покажет захват, которого в хранилище нет. Разбирать лог (строки «Объект захвачен для редактирования: <имя>» / «Захват объекта отменен: <имя>») и помечать только реально затронутые; сверить `ONE_C_TYPE_NAMES` с платформой по всем видам.

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
- **Н24 (Э5 → Э8)** Внешний (не автозапущенный расширением) локальный агент: его `/AgentBaseDir` неизвестен, сервис ищет `agentbasedir.json` в каталоге по умолчанию (`<проект>/.v8vscedit/agent`) или по `/AgentBaseDir` из `agentModeArgs` и при другом каталоге падает с «не удалось прочитать индекс» без подсказки. В Э8 — явная настройка каталога агента либо подсказка в сообщении `resolveLocalAgentUserRoot` (`LocalAgentFileStore.ts`).
- **Н25 (Э5 → Э7)** Первый проход `mirrorAgentToProject` читает всё M ради сравнения, второй — повторно изменённые файлы: для SFTP это двойная передача. Не подключать SFTP-хранилище к этому зеркалу до движка Э7 (манифест + план).
- **Н26 (Э5 → Э7)** `AgentTransferResult.cancelled` зеркало не использует и отмену не передаёт (операции агента пока не отменяемы) — учесть в Э7 при прокидывании `CancellationToken`.
- **Н27 (Э5)** После обновления на старой раскладке на диске остаются `<AgentBaseDir>/0/workspace/cf/cf` и `workspace/cfe-*` (прежний хардкод `'0'` и ключ сессии вместо `projectId`), а `lists/` копит по файлу на каждую частичную загрузку. Нужна уборка: удаление list-файла после операции и разовая чистка старой раскладки.
- **Н28 (Э5)** `LocalAgentFileStore.assertInside` на каждый вызов дважды делает `realpath`, включая неизменный корень; на тысячах файлов выгрузки — лишние системные вызовы. Кэшировать реальный корень при первой проверке.
- **Окружение (скрытый прогон)** `schtasks /End` гасит только `powershell` исполнителя, а дочерние `Code.exe` от SYSTEM остаются сиротами в сессии 0 и держат single-instance — следующий `test:hidden` падает «only supported if no other instance of Code is running», убить их можно только от администратора. Исполнителю нужно запускать npm в Job-объекте (или `taskkill /T /F` по дереву при остановке) и чистить сирот при старте.
- **Окружение (флейк)** `repositoryCommandRunner.test.ts` «привязка / нет привязки — исключение» зависит от `env.json`, оставленного предыдущим тестом (в сборном прогоне получает «отсутствует --ibconnection»); тест должен сам готовить своё окружение.
- **Окружение** Сборный прогон с сьютами `MetadataCache`/`CfeBatch`/`CfeBorrow` зависает (>580 с) — вероятно, тот же корпус `example/2.20`, что вешает полный `npm test`; выяснить.

### Пилот формата отчёта и кодировки ObjectsFile (2026-11-16, 8.3.27.2130)

- `/ConfigurationRepositoryReport`: формат определяется ТОЛЬКО `-ReportFormat` (`mxl` → `MOXCEL…`, `txt` → текст UTF-8 с BOM); без `-ReportFormat` — ВСЕГДА MXL, расширение файла (`.mxl`/`.txt`/`.out`) игнорируется.
- ObjectsFile (`-Objects`): принимаются UTF-8 с BOM и без, UTF-16LE с BOM; cp1251 без XML-декларации отвергается (`Input is not proper UTF-8`, exit 1) — передача байтов как есть (Н2) корректна.

### Окружение и инструмент (не блокирует этапы, отдельные задачи)

1. ~~**Гейт `coverage:changed` на Windows неработоспособен:**~~ ИСПРАВЛЕНО коммитом b0dbcda (`lcovKeyRelativeToRoot`, проверено на реальном lcov 187/187). Остаётся зависание полного прогона на корпусе (п.2). ключи lcov с обратными слэшами (`src\infra\…`) не сопоставляются с путями git → «нет данных покрытия» у всех файлов (честный код 2, не ложный GREEN). Нормализовать пути в `scripts/patch-coverage/*` + фикстура lcov с Windows-путями. До исправления вердикт на Windows снимается копией гейта с нормализацией (так сделано на Э1 — scratchpad, `scripts/**` не тронут).
2. **Полный `npm test` на Windows не завершается** на корпусе БП КОРП (104 тыс. файлов): Extension Host перестаёт отвечать на сканах корпуса; плюс платформенные падения (git EPERM, `DesignerAgentProcess` EACCES/код выхода). Корпус на машине пользователя — только `example/2.20/src/cf` (другая конфигурация, чем та, по которой пиннились числа корпусных тестов): нет `2.21`, нет `cfe`, нет `example/2.20/env.json`. Нужен таймаут/фильтр корпусных сьютов или отдельный режим + классификация известных Windows-падений в «Известных технических долгах».
4. **Флейк `CfeBatchCommands: регистрируют РОВНО две команды`** (замечен на QA Э2): в список зарегистрированных команд попала посторонняя `workbench.action.output.show.TypeScriptTeam.jsts-chat-features…` из окружения тестового VS Code. Тест должен фильтровать команды по префиксу расширения (`v8vscedit.`), а не считать все.
3. **POSIX-семантика сигналов в тестах `cliProcess`:** Windows-вариант проверки гонки `forceKill` или конвенция пометки платформы.
