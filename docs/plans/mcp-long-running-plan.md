# План: пульс долгих MCP-вызовов, возобновляемость SSE, видимость операции

**Статус: реализовано (2026-11-20).** Итоговая документация — [mcp-server-lifecycle.md](../mcp-server-lifecycle.md).

Отступления разработчика от плана: `summary` при abort несёт итог операции; `summary` успеха — JSON;
`pulseDeps` шлюза имеют дефолты; вытеснение потоков в store — по счётчику активности. Найденный и
исправленный дефект: `ok(undefined)` приводил к `TypeError` в `describeOutcome`.

Бэклог ревьюера:
- не записывать в `lastOperation` мгновенные отказы до входа в операцию (BUSY/валидация) — сейчас они
  перезаписывают исход настоящей операции;
- «прервано клиентом» неточно при закрытии сессии;
- `ok(undefined)` даёт `text: undefined` у ~60 инструментов на `gate.wrap` — заменить на
  `JSON.stringify(data ?? null)` с тестом;
- дублирование pulse-зависимостей в `V8McpServer`;
- пилот на реальном Claude Code с собранным VSIX (см. п. 5).

Трек FULL. План архитектора (2026-11-20) + решения пользователя + факты журнала клиента.

## Проблема и факты

Фидбек агента из реального проекта: `v8vscedit_repository_update` (полное получение БП КОРП с импортом,
> 5 мин) — клиент Claude Code: «SSE stream disconnected: TimeoutError: The operation timed out», затем
«response presumed lost»; операция в расширении продолжилась под общим замком.

Журнал клиента (`%LOCALAPPDATA%\claude-cli-nodejs\Cache\<проект>\mcp-logs-mcp-src\*.jsonl`, claude-code
2.1.329, Node 26):
- `negotiatedProtocolVersion: "2025-11-25"` — priming-событие будет отправлено, клиент SDK умеет
  переподключаться к POST-потоку по `Last-Event-ID` (`hasPrimingEvent`).
- Транспорт клиента — `StreamableHTTPClientTransport` SDK (строка «SSE stream disconnected: …» из
  `client/streamableHttp.js`), `timeoutMs: 60000` (тайм-аут запроса SDK).
- Обрывы идут с периодом РОВНО 6 мин (15:30:30, 15:36:30, 15:42:30), в том числе без активного вызова;
  в 15:30:30 одновременно (одна миллисекунда) оборвались ДВА потока — POST вызова (через 5:10 после старта)
  и отдельный GET-поток сессии. Вывод: клиент периодически рвёт молчащий GET-поток, POST гибнет вместе с
  ним; `TimeoutError` — DOMException от `AbortSignal.timeout`, а не `UND_ERR_BODY_TIMEOUT` undici. Какой
  именно таймер (простой или абсолютный) — подтверждается только пилотом на собранном VSIX.
- Между обрывом и «presumed lost» 109 с: клиент ждал переподключения, которого не было (нет eventStore →
  нет priming → нет переподключения).

Следствие: главное лечение — возобновление (п.2); пульс — в поток вызова И в GET-поток сессии на время
долгого вызова (решение пользователя), плюс `lastOperation` для исхода после обрыва.

## Решения пользователя

1. Все три пункта ТЗ (пульс, возобновление, видимость операции).
2. `lastOperation` в `v8vscedit_repository_status` — в этой задаче.
3. Пульс в GET-поток сессии — ТОЛЬКО пока идёт долгий вызов (в простое сессия молчит, как сейчас).

## Находки по SDK 1.29.0 (влияют на реализацию)

1. Priming пишется сервером только при `eventStore` и протоколе клиента ≥ `2025-11-25`.
2. Возобновление POST-ответа работает: GET с `Last-Event-ID` → `replayEventsAfter` → новый controller;
   ответ, готовый ПОСЛЕ переподключения, уходит в новый поток. **Окно потери ≈ `retryInterval`:** если
   ответ готов до GET-переподключения, `send()` не находит поток, событие НЕ сохраняется
   (`storeEvent` только внутри `if (stream?.controller)`), ответ теряется, `_requestToStreamMapping`
   утекает. Известное ограничение SDK — закрывается `lastOperation`.
3. **Ловушка 409:** НЕ реализовывать необязательный `getStreamIdForEventId` (устаревшая запись от
   оборванного replay-потока даёт `409 Conflict` при втором переподключении).
4. Priming сохраняется в store как `{}` — при replay пропускать всё, что не JSON-RPC.
5. Пульс в поток ВЫЗОВА — только `extra.sendNotification(...)` (ставит `relatedRequestId`).
   `server.sendLoggingMessage` уходит в GET-поток сессии — его и использовать для пульса в GET.
   `notifications/message` без capability `logging` бросает. После abort `extra.sendNotification` молча
   возвращается. `logging/setLevel` учесть нельзя (`isMessageIgnored` приватный) — уровень `info`,
   задокументировать.
6. `InMemoryEventStore` есть только в `examples` (без TTL/лимитов, ломается на `_GET_stream`) — свой store.
7. Клиент: `maxRetries: 2`, успешно переподключённый поток сбрасывает счётчик; `retry:` сервера заменяет
   backoff.

## 1. Контракты

### 1.1 `src/infra/progress/OperationStageFeed.ts` (новый, чистый)
```ts
export type OperationStagePhase = 'begin' | 'update' | 'end';
export interface OperationStage { readonly title: string; readonly stage: string; readonly phase: OperationStagePhase; readonly at: number }
export const MAX_STAGE_LENGTH = 200;
export class OperationStageFeed {
  constructor(now?: () => number);
  publish(phase: OperationStagePhase, title: string, stage: string): void; // одна строка, схлопнутые пробелы, обрезка до 200 с «…»
  current(): OperationStage | undefined;
}
export interface RunningOperationView {
  readonly operationRunning: boolean;
  readonly currentOperation: null | { startedAt: string; elapsedSeconds: number; title?: string; stage?: string; stageUpdatedAt?: string };
}
export function describeRunningOperation(input: { running: boolean; startedAt?: number; stage?: OperationStage; now: number }): RunningOperationView;
```
title/stage — только если `stage.at >= startedAt`; running без startedAt → `currentOperation: null`.
Единственный экземпляр: `export const operationStageFeed = new OperationStageFeed()` в
`ui/commands/ext/configurationOperationStatus.ts`. Источник этапов — статус-бары
(`begin/update/endConfigurationOperationStatus`, `begin/update/endRepositoryOperationStatus`): через них
уже идут `RepositoryCommandRunner.onOutput`, `ExtensionCommandRunner.onStdout/onStderr`,
`agentConfigurationOperation.showStatus`, `ExtensionCommands`.

### 1.2 `src/infra/mcp/McpRequestPulse.ts` (новый, чистый, без SDK/vscode)
```ts
export const MCP_PULSE_INTERVAL_MS = 20_000;
export interface PulseScheduler { now(): number; setTimeout(cb: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
export const realPulseScheduler: PulseScheduler;
export interface PulseTick { readonly sequence: number; readonly progress: number; readonly elapsedMs: number; readonly stage?: { title: string; stage: string } }
export interface RequestPulseOptions {
  readonly scheduler: PulseScheduler; readonly intervalMs: number;
  readonly readStage: () => OperationStage | undefined;   // этап с at < startedAt отбрасывается
  readonly send: (tick: PulseTick) => Promise<void>;
  readonly onSendError?: (error: unknown, tick: PulseTick) => void;
  readonly signal?: AbortSignal;
}
export interface RequestPulse { stop(): void }             // идемпотентен
export function startRequestPulse(o: RequestPulseOptions): RequestPulse;
export async function runWithRequestPulse<T>(o: RequestPulseOptions, fn: () => Promise<T>): Promise<T>;
export type McpPulseNotification =
  | { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; message: string } }
  | { method: 'notifications/message'; params: { level: 'info'; logger: 'v8vscedit'; data: string } };
export function buildPulseNotification(toolName: string, tick: PulseTick, progressToken: string | number | undefined): McpPulseNotification;
export function formatPulseText(toolName: string, tick: PulseTick): string; // «<tool>: выполняется 5 мин 20 с — <title>: <stage>»
export function formatElapsed(ms: number): string;        // «45 с», «5 мин 20 с», «1 ч 02 мин»
```
Первый тик через `intervalMs` (короткие вызовы молчат); следующий таймер взводится только после
завершения `send` (без наложения); после `stop()`/abort — ни отправок, ни таймеров (тик «в полёте» не
перевзводит); `progress = max(prev + 1, floor(elapsedMs/1000))`; токен проверяется `!== undefined` (0
допустим); signal уже прерван — ничего не планируется; ошибка `send` → `onSendError` (или глотается),
пульс продолжается. 20 с: запас ×15 к ~300 с, < 30 с «still running», три пульса на окно 60 с
`resetTimeoutOnProgress`.

### 1.3 `src/infra/mcp/McpSessionEventStore.ts` (новый; type-only импорт `EventStore`, `JSONRPCMessage`)
```ts
export const MCP_SSE_RETRY_INTERVAL_MS = 1_000;
export interface McpEventStoreLimits { maxEventsPerStream: number; maxStreams: number; maxBytes: number; completedStreamTtlMs: number }
export const DEFAULT_MCP_EVENT_STORE_LIMITS = { maxEventsPerStream: 1000, maxStreams: 64, maxBytes: 16 * 1024 * 1024, completedStreamTtlMs: 15 * 60_000 };
export function formatEventId(streamId: string, seq: number): string;   // `${streamId}:${seq}`
export function parseEventId(eventId: string): { streamId: string; seq: number } | undefined; // lastIndexOf(':'), seq — целое ≥ 0, streamId непустой
export class McpSessionEventStore implements EventStore {             // экземпляр на сессию
  constructor(limits?: McpEventStoreLimits, now?: () => number);
  storeEvent(streamId: string, message: JSONRPCMessage): Promise<string>;
  replayEventsAfter(lastEventId: string, h: { send(id: string, m: JSONRPCMessage): Promise<void> }): Promise<string>;
  clear(): void;
  stats(): { streams: number; events: number; bytes: number };
  // getStreamIdForEventId НЕ реализуется (ловушка 409)
}
```
`seq` — монотонный на store; размер — `JSON.stringify(message).length`; поток завершён, когда сохранён
JSON-RPC-ответ (`id` + `result`/`error`, без `method`) → `completedAt`. Очистка ленивая (на
`storeEvent`/`replay`, без таймеров): (1) завершённые с `now - completedAt > ttl` удаляются, открытые по TTL
нет; (2) `maxStreams` — вытесняется самый старый по активности, завершённые первыми; (3) `maxBytes` —
сначала завершённые (старые), затем старые не-ответы открытых; одиночное сообщение больше лимита всё равно
хранится; (4) `maxEventsPerStream` — удаляется старейшее не-ответное событие потока, ответ никогда. Replay:
невалидный id / неизвестный поток → `Error`; иначе по порядку события с `seq > lastSeq`, пропуская не-JSON-RPC;
обновляет активность; возвращает `streamId`. `clear()` — из `transport.onclose`.

### 1.4 `McpMutationGate.wrapLongRunning` (`src/ui/mcp/registration/McpMutationGate.ts`)
```ts
export type McpToolExtra = Pick<RequestHandlerExtra<ServerRequest, ServerNotification>, '_meta' | 'sendNotification' | 'signal'>;
export interface McpPulseDeps {
  readonly scheduler: PulseScheduler; readonly intervalMs: number;
  readonly readStage: () => OperationStage | undefined;
  /** Пульс в GET-поток сессии на время долгого вызова (решение пользователя); ошибки — как у пульса вызова. */
  readonly sendSessionPulse?: (text: string) => Promise<void>;
}
async wrapLongRunning(toolName: string, extra: McpToolExtra | undefined, fn: () => Promise<unknown>): Promise<CallToolResult>
```
`extra === undefined` → ровно `wrapAsync(fn)` (старые тесты с фейковым сервером не меняются). Иначе
`wrapAsync(() => runWithRequestPulse({ …, signal: extra.signal, send: (t) => Promise.all([
extra.sendNotification(buildPulseNotification(toolName, t, extra._meta?.progressToken)),
sendSessionPulse?.(formatPulseText(toolName, t)) ]) }, fn))`. Сессионный пульс — через
`server.sendLoggingMessage({ level: 'info', logger: 'v8vscedit', data })` своей сессии (передаётся из
`V8McpServer` при сборке gate/deps сессии); его отказ («нет GET-потока» — нормальная ситуация) не
мешает пульсу вызова и не пишет журнал повторно. `onSendError` пишет в `services.outputChannel` ОДИН
раз за вызов: `[mcp][pulse] <tool>: <ошибка>` (через `?.`). Плюс `lastOperation` (1.6) фиксируется в
`finally` обёртки. Без тостов (запрет №18).

### 1.5 Обёртку получают 10 инструментов
`McpRepositoryTools`: `repository_lock/update/commit/unlock`; `McpConfigLifecycleTools`:
`update_database_configuration`, `dump_cf`, `load_cf` (ветка после `confirm`), `dump_all_cfe`,
`load_all_cfe`, `execute_command`. Обработчик → `(args, extra) => gate.wrapLongRunning('<имя>', extra, …)`.

### 1.6 `lastOperation` (решение пользователя)
Чистый реестр исходов в `src/infra/mcp/McpOperationOutcome.ts` (или рядом с лентой этапов — на выбор
разработчика, без vscode): `record({ tool, startedAt, finishedAt, isError, summary })`, `last()`. Один
экземпляр на сервер (живёт дольше сессии — обрыв может закрыть сессию). `summary` — первая строка
текста ошибки либо краткое описание результата (≤ 300 символов; полный результат не хранить). Заполняет
`wrapLongRunning` в `finally` (успех/ошибка/abort — `isError` и summary «прервано»). В
`v8vscedit_repository_status`: `lastOperation: null | { tool, startedAt, finishedAt, isError, summary }`.

### 1.7 `V8McpServer.createSession`
`new McpServer({ name, version }, { capabilities: { logging: {} } })`; `const eventStore = new
McpSessionEventStore()`; транспорт `{ sessionIdGenerator, onsessioninitialized, eventStore, retryInterval:
MCP_SSE_RETRY_INTERVAL_MS }`; в `transport.onclose` первой строкой `eventStore.clear()`.
`enableJsonResponse` НЕ включать.

### 1.8 Видимость операции и текст «занято»
`configurationOperationLock.ts`: `tryBegin` запоминает `operationStartedAt`, `end` сбрасывает;
`getConfigurationOperationStartedAt()`; `MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE =
\`${CONFIGURATION_OPERATION_BUSY_MESSAGE} Состояние идущей операции — v8vscedit_repository_status
(operationRunning, currentOperation, lastOperation); повторите вызов после её завершения.\`` — бросает ТОЛЬКО
`runWithConfigurationOperationLockOrThrow`. `CONFIGURATION_OPERATION_BUSY_MESSAGE` и литералы UI
(`CfFileCommands:323`, `CfeBatchCommands:271`, `ExtensionCommands:993`, `DbRunCommandRunner:51`) не трогать.
Статус-бары публикуют в `operationStageFeed` (`endConfigurationOperationStatus()` без аргументов — нет).
`v8vscedit_repository_status` дописывает `describeRunningOperation(...)` + `lastOperation`; описание
инструмента дополняется. `v8vscedit_execute_command` для `importConfigurations`/`updateChangedConfigurations`
при занятом замке — сразу `throw new Error(MCP_CONFIGURATION_OPERATION_BUSY_MESSAGE)` (закрывает висящий
`await showInformationMessage` UI-команды в MCP-вызове и ложный «успех» `{result:false}`; TOCTOU —
остаточный риск, задокументировать); `refresh` не блокируется.

## 2. Шаги (один слой за шаг)
1. infra: `infra/progress/OperationStageFeed.ts`, `infra/mcp/McpRequestPulse.ts`,
   `infra/mcp/McpSessionEventStore.ts`, `infra/mcp/McpOperationOutcome.ts`; описание
   `v8vscedit_repository_status` в `infra/ai/AiMcpToolCatalog.ts`.
2. ui/commands: `configurationOperationStatus.ts` (лента + публикация), `repositoryStatusBar.ts`
   (публикация), `configurationOperationLock.ts` (startedAt, MCP-текст).
3. ui/mcp: `McpMutationGate.ts` (`wrapLongRunning`, `McpPulseDeps`, сессионный пульс, `lastOperation`),
   `McpRepositoryTools.ts` (4 инструмента, поля статуса, описание), `McpConfigLifecycleTools.ts`
   (6 инструментов, проверка `execute_command`), `V8McpServer.ts` (capability, eventStore, retryInterval,
   clear, сессионный пульс в deps).
4. Документация: `docs/mcp-server-lifecycle.md` (модули, пульс, возобновление, окно потери, ловушка 409,
   лимиты, журнал клиента), `docs/architecture.md`, CLAUDE.md (дерево `infra/mcp/`, `infra/progress/`,
   пункт «Изменение жизненного цикла… MCP-сервера»).

## 3. Риски
Утечка таймеров (stop в finally и по abort; store без таймеров); отправка после ответа/закрытия → в
`onSendError`; окно потери ≈1 с (SDK) — закрыто `lastOperation`; клиенты < 2025-11-25 — только пульс;
replay завершённого потока держит GET до закрытия сессии (SDK); память store — 16 МиБ/64 потока на
сессию, брошенные сессии держат потолок до `stop()`; `logging/setLevel` не учитывается; этапы — строки,
уже видимые человеку (маскирование секретов раньше); смена ожиданий BUSY в `mcpRepositoryTools`,
`mcpUpdateDatabaseConfiguration`, `repositoryMcpSupport` — смена контракта; в golden каталога меняется
только описание `repository_status`.

## 4. Тесты (один бриф test-writer)
Общий фейк `support/manualScheduler.ts` (`now`, `advance`, `setTimeout`, `clearTimeout`, `pendingCount`,
`fireNext(): Promise<void>`), без реального sleep.
1. `mcpRequestPulse.test.ts` — тайминг тиков, отсутствие наложения, stop (до тика, идемпотентно, во время
   send), signal (на старте, позже), ошибки send с/без обработчика, рост progress при стоячих часах,
   свежесть этапа, `runWithRequestPulse` (значение/ошибка, `pendingCount()===0`), `buildPulseNotification`
   (токен строка/число/0/undefined), `formatElapsed` (0, 59, 60, 3599, 3600, 3661 с), `formatPulseText`.
2. `mcpSessionEventStore.test.ts` — `formatEventId`/`parseEventId` (валидный, `_GET_stream`, без `:`,
   нечисловой/отрицательный seq, пустой streamId), порядок replay при чередовании потоков, пропуск `{}`,
   replay после последнего, ошибки (невалидный/неизвестный/вытесненный), все четыре лимита, TTL (внедрённые
   часы, открытый не истекает), распознавание ответа (result/error; запрос с id+method и уведомление — нет),
   `clear`/`stats`, страж: нет метода `getStreamIdForEventId`.
3. `operationStageFeed.test.ts` — нормализация, `current`, все ветки `describeRunningOperation`, публикация
   из обоих статус-баров, `end…()` без аргументов не публикует.
4. `mcpOperationOutcome.test.ts` — запись/последний, обрезка summary, abort.
5. `configurationOperationLock.test.ts` (дополнить) — startedAt, MCP-текст в OrThrow, UI-текст прежний;
   правка ожиданий BUSY в `repositoryMcpSupport`/`mcpRepositoryTools`/`mcpUpdateDatabaseConfiguration`.
6. `mcpLongRunningTools.test.ts` — без extra = wrapAsync; с токеном progress, без — message; сессионный
   пульс вызывается с тем же текстом, его отказ не мешает пульсу вызова; fn бросает → toolError и
   `pendingCount()===0`; три отказа отправки → успех, одна строка `[mcp][pulse]`; abort; таблица по всем 10
   инструментам при занятом замке (MCP-текст, пульс взведён и погашен; `confirm: true` у load-ов);
   `execute_command` import/updateChanged при занятом замке; `lastOperation` после успеха/ошибки/abort;
   сквозной путь `RepositoryCommandRunner.onOutput` → `repositoryStatusBar` → лента → текст пульса.
7. `mcpRepositoryTools.test.ts` (статус) — свободен/занят/устаревший этап; `lastOperation` null и
   заполненный.
8. `mcpToolsCatalog.test.ts` — golden-описание `repository_status`.
9. `v8McpServerResumability.test.ts` (реальный `V8McpServer` на loopback) — capability `logging`; POST с
   `mcp-protocol-version: 2025-11-25` → priming `id:` и `retry: 1000`; с 2025-06-18 priming нет;
   `terminateSession` → `clear`.
10. `mcpResumableTransport.test.ts` (реальный HTTP, продакшн-store и `wrapLongRunning`, `retryInterval:
    10`, ручной планировщик) — уведомления до результата (message без onprogress, progress с ним);
    переподключение: обёртка fetch рвёт тело POST `DOMException('The operation timed out.',
    'TimeoutError')` после первого пульса → GET с `Last-Event-ID` → release → `callTool` получает
    результат, без ошибки разбора `{}`; отмена `AbortSignal` → `pendingCount()===0`. Ожидания — через
    promise событий, не тайминги.

`COVERAGE_TESTS='mcpRequestPulse|mcpSessionEventStore|operationStageFeed|mcpOperationOutcome|configurationOperationLock|repositoryMcpSupport|mcpLongRunningTools|mcpRepositoryTools|mcpUpdateDatabaseConfiguration|mcpConfigLifecycleCfTools|mcpCfeBatchTools|mcpToolsCatalog|v8McpServerResumability|v8McpServerLifecycle|mcpResumableTransport'`

## 5. После реализации
Пилот на реальном Claude Code с собранным VSIX: в журнале клиента — priming и GET-переподключение после
обрыва, долгий `repository_update` доходит до результата; уточнить, какой таймер истекает (простой или
абсолютный, период 6 мин).
