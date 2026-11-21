/**
 * Эмулятор КОМАНД агента конфигуратора для расширений и CF/CFE-файлов (план plan-remote-extensions, §7 + ФАКТ Э29).
 *
 * Внешняя система здесь — только процесс агента; файлы обмена — НАСТОЯЩАЯ файловая система под `userRoot`
 * (локально напрямую, по SFTP — через настоящий ssh2.Server с тем же корнем). Модель базы — список записей
 * `{applied?, pending?}`; формат содержимого файлов — только для теста: `CFE1:{"name","prefix","purpose","payload"}`
 * и `CF1:<payload>`. Поведение сверено с фактами Э28/Э29:
 *  - `load-cfg --extension=X` НОВОГО имени создаёт ЗАГЛУШКУ (запись без применённого состояния, хеш из нулей,
 *    `version` пуст); применяет её только `update-db-cfg --extension=X`;
 *  - после `update-db-cfg` запись получает ВНУТРЕННЕЕ имя из файла: запись под запрошенным именем исчезает
 *    (заглушка S + файл X → X; применённое X + файл Z → Z); если Z уже занято ДРУГОЙ записью — отказ
 *    «Расширение с таким именем уже существует!», запрошенная запись остаётся заглушкой;
 *  - `update-db-cfg --extension=<нет в базе>` отвечает успехом без изменений;
 *  - ответ `properties get` при ОДНОМ расширении в ответе — одно сообщение `extension-properties` верхнего уровня
 *    БЕЗ `success` (ФАКТ Э30–Э31; так же отвечает `--extension=<имя>`); при 0 и ≥2 — `success` с массивом `body`;
 *  - `dump-cfg` заглушки роняет процесс (обрыв соединения);
 *  - ответ списка (0 или ≥2): `success.body = [{type:'extension-properties', body:{…}}]`, пустая база — `[]`.
 * Ловушки включаются флагами; журнал команд ведёт `AgentConfigEmulator.commands`.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentMessage } from '../../../domain/agent';
import type { ParsedAgentCommand } from './agentConfigEmulator';

export const PROPERTIES_GET_ALL = 'config extensions properties get --all-extensions';
/** Хеш неприменённой заглушки: base64 от 20 нулевых байт (ФАКТ Э29, П8). */
export const ZERO_HASH = 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const GARBAGE_BYTES = 16;

export function cfFile(payload: string): string {
  return `CF1:${payload}`;
}

export function cfeFile(name: string, payload = 'p', extra: { prefix?: string; purpose?: string } = {}): string {
  return `CFE1:${JSON.stringify({ name, prefix: extra.prefix ?? `${name}_`, purpose: extra.purpose ?? 'customization', payload })}`;
}

interface ParsedCfe {
  readonly name: string;
  readonly prefix: string;
  readonly purpose: string;
  readonly payload: string;
}

function parseCfe(content: string): ParsedCfe | undefined {
  if (!content.startsWith('CFE1:')) {
    return undefined;
  }
  try {
    return JSON.parse(content.slice('CFE1:'.length)) as ParsedCfe;
  } catch {
    return undefined;
  }
}

/** Отказ агента: итоговое сообщение и `log`-строки ПЕРЕД ним (как в одном ответе настоящего агента). */
export class EmulatedAgentFailure extends Error {
  constructor(
    message: string,
    readonly finalMessage: AgentMessage,
    readonly precedingMessages: AgentMessage[] = []
  ) {
    super(message);
    this.name = 'EmulatedAgentFailure';
  }
}

export function emulatedFailure(errorType: string, message: string, logLines: readonly string[] = []): EmulatedAgentFailure {
  return new EmulatedAgentFailure(
    message,
    { type: 'error', 'error-type': errorType, message, body: [] },
    logLines.map((line) => ({ type: 'log' as const, message: line }))
  );
}

/** Пустой `UnknownError` (сообщение пусто) с пояснением в предшествующей `log`-строке — ФАКТ Э28. */
export function emptyUnknownError(logLine: string | undefined): EmulatedAgentFailure {
  return emulatedFailure('UnknownError', '', logLine === undefined ? [] : [logLine]);
}

export type CrashMode = 'drop' | 'hang';

export type ExtensionsOutcome =
  | { readonly kind: 'messages'; readonly messages: AgentMessage[] }
  | { readonly kind: 'crash'; readonly mode: CrashMode };

interface AppliedState {
  readonly name: string;
  readonly version: string;
  readonly purpose: string;
  readonly prefix: string;
  readonly payload: string;
  readonly hashSum: string;
}

interface Entry {
  name: string;
  applied?: AppliedState;
  /** Файл, загруженный `load-cfg`, но ещё не применённый; `''` — заглушка от упавшей загрузки. */
  pending?: string;
}

interface Trap {
  readonly predicate: (command: ParsedAgentCommand) => boolean;
  readonly action: { readonly crash: CrashMode } | { readonly fail: EmulatedAgentFailure };
  left: number;
}

/** Что делает `dump-cfg` при успехе агента: нормально / «забыть» создать файл / создать пустой. */
export type DumpMode = 'normal' | 'no-file' | 'empty-file';
/** Что делает `update-db-cfg --extension`: применяет / отвечает успехом, ничего не меняя / удаляет запись. */
export type UpdateMode = 'apply' | 'ignore' | 'vanish';

function sha1Base64(content: string): string {
  return createHash('sha1').update(content).digest('base64');
}

export class AgentExtensionsEmulator {
  /** Содержимое основной конфигурации (`dump-cfg` без `--extension`). */
  mainPayload = 'main';
  mainPending: string | undefined;
  dumpMode: DumpMode = 'normal';
  updateMode: UpdateMode = 'apply';
  /** При упавшей `dump-cfg` (ловушка `failOn`) в `--file` остаётся 16 байт мусора (замер пилота). */
  dumpLeavesGarbage = false;
  /** При упавшей `load-cfg` нового имени запись-заглушка всё равно появляется (ФАКТ Э28). */
  stubOnFailedLoad = false;
  /** Хук обрыва соединений (`drop`): стенды SSH подключают `server.dropClients()`. */
  onDrop: (() => void) | undefined;
  /** Подмена поведения падения/зависания (исполнитель без SSH превращает его в `AgentConnectionLostError`). */
  crashHandler: ((mode: CrashMode, rawCommand: string) => Promise<never>) | undefined;

  /** Имена заглушек, созданных `load-config-from-files` (Э32). */
  readonly stubsCreatedByFileLoad: string[] = [];
  private readonly entries: Entry[] = [];
  private readonly traps: Trap[] = [];

  constructor(private readonly userRoot: string) {}

  // ── Модель базы ─────────────────────────────────────────────────────────

  /** Применённое расширение (как после успешной загрузки и применения). */
  addExtension(name: string, payload = 'p', options: { purpose?: string; version?: string; hashSum?: string } = {}): void {
    const content = cfeFile(name, payload, { purpose: options.purpose });
    this.entries.push({
      name,
      applied: {
        name,
        version: options.version ?? '',
        purpose: options.purpose ?? 'customization',
        prefix: `${name}_`,
        payload,
        hashSum: options.hashSum ?? sha1Base64(content),
      },
    });
  }

  /** Неприменённая заглушка (хеш из нулей) — остаток прерванной загрузки. */
  addStub(name: string): void {
    this.entries.push({ name, pending: '' });
  }

  names(): string[] {
    return this.entries.map((entry) => entry.name);
  }

  has(name: string): boolean {
    return this.find(name) !== undefined;
  }

  isStub(name: string): boolean {
    const entry = this.find(name);
    return entry !== undefined && entry.applied === undefined;
  }

  payloadOf(name: string): string | undefined {
    return this.find(name)?.applied?.payload;
  }

  /** Файл, ожидающий применения (`load-cfg` без `update-db-cfg`). */
  pendingOf(name: string): string | undefined {
    const pending = this.find(name)?.pending;
    return pending === '' ? undefined : pending;
  }

  /**
   * ФАКТ Э32: `load-config-from-files --extension=N` в ОТСУТСТВУЮЩЕЕ расширение отвечает успехом и создаёт
   * заглушку N (нулевой хеш), как `load-cfg` по Э28. Существующее расширение запись не меняет: хеш применённого
   * состояния обновляет только `update-db-cfg`. Журнал имён заглушек — для проверки «загрузка не создала лишнего».
   */
  noteLoadFromFiles(extension: string | undefined): void {
    if (extension === undefined || this.find(extension)) {
      return;
    }
    this.entries.push({ name: extension, pending: '' });
    this.stubsCreatedByFileLoad.push(extension);
  }

  // ── Ловушки ──────────────────────────────────────────────────────────────

  /** Процесс агента падает (`drop` — соединение обрывается) или зависает (`hang`) на подходящих командах. */
  crashOn(predicate: (command: ParsedAgentCommand) => boolean, mode: CrashMode, times = 1): void {
    this.traps.push({ predicate, action: { crash: mode }, left: times });
  }

  failOn(predicate: (command: ParsedAgentCommand) => boolean, failure: EmulatedAgentFailure, times = 1): void {
    this.traps.push({ predicate, action: { fail: failure }, left: times });
  }

  emptyUnknownErrorOn(predicate: (command: ParsedAgentCommand) => boolean, logLine: string | undefined, times = 1): void {
    this.failOn(predicate, emptyUnknownError(logLine), times);
  }

  // ── Исполнитель ──────────────────────────────────────────────────────────

  crash(mode: CrashMode, rawCommand: string): Promise<never> {
    if (this.crashHandler) {
      return this.crashHandler(mode, rawCommand);
    }
    if (mode === 'drop') {
      this.onDrop?.();
    }
    return new Promise<never>(() => undefined);
  }

  /** `undefined` — команда не относится к расширениям/CF-файлам (обрабатывает основной эмулятор). */
  handle(command: ParsedAgentCommand): ExtensionsOutcome | undefined {
    const kind = classify(command);
    if (kind === undefined) {
      return undefined;
    }
    const trapped = this.applyTrap(command, kind);
    if (trapped) {
      return trapped;
    }
    switch (kind) {
      case 'properties':
        return this.propertiesGet(command);
      case 'dump':
        return this.dumpCfg(command);
      case 'load':
        return this.loadCfg(command);
      default:
        return this.updateDb(command);
    }
  }

  private applyTrap(command: ParsedAgentCommand, kind: CommandKind): ExtensionsOutcome | undefined {
    const trap = this.traps.find((candidate) => candidate.left > 0 && candidate.predicate(command));
    if (!trap) {
      return undefined;
    }
    trap.left -= 1;
    if ('crash' in trap.action) {
      return { kind: 'crash', mode: trap.action.crash };
    }
    if (kind === 'dump' && this.dumpLeavesGarbage) {
      this.writeGarbage(command);
    }
    const extension = optionOf(command, 'extension');
    if (kind === 'load' && this.stubOnFailedLoad && extension !== undefined && !this.find(extension)) {
      this.entries.push({ name: extension, pending: '' });
    }
    throw trap.action.fail;
  }

  private propertiesGet(command: ParsedAgentCommand): ExtensionsOutcome {
    const requested = optionOf(command, 'extension');
    const entries = requested === undefined ? this.entries : this.entries.filter((entry) => entry.name.toLowerCase() === requested.toLowerCase());
    const elements = entries.map((entry) => ({ type: 'extension-properties' as const, body: propertiesOf(entry) }));
    // ФАКТ Э30–Э31: ровно одно расширение — единственное сообщение верхнего уровня, без завершающего success.
    if (elements.length === 1) {
      return { kind: 'messages', messages: elements };
    }
    return { kind: 'messages', messages: [{ type: 'success', body: elements }] };
  }

  private dumpCfg(command: ParsedAgentCommand): ExtensionsOutcome {
    const file = this.requireFile(command);
    const target = this.abs(file);
    if (!fs.existsSync(path.dirname(target))) {
      throw emulatedFailure('UnknownError', `Каталог не обнаружен: ${path.dirname(file)}`);
    }
    const extension = optionOf(command, 'extension');
    let content: string;
    if (extension === undefined) {
      content = cfFile(this.mainPayload);
    } else {
      const entry = this.find(extension);
      if (!entry) {
        throw emulatedFailure('ExtensionNotFound', `Расширение не найдено: ${extension}`);
      }
      if (!entry.applied) {
        return { kind: 'crash', mode: 'drop' };
      }
      content = cfeFile(entry.applied.name, entry.applied.payload, { purpose: entry.applied.purpose });
    }
    if (this.dumpMode === 'empty-file') {
      fs.writeFileSync(target, '');
    } else if (this.dumpMode === 'normal') {
      fs.writeFileSync(target, content);
    }
    return { kind: 'messages', messages: [{ type: 'success' }] };
  }

  private loadCfg(command: ParsedAgentCommand): ExtensionsOutcome {
    const file = this.requireFile(command);
    const source = this.abs(file);
    if (!fs.existsSync(source)) {
      throw emulatedFailure('ConfigFilesError', `Файл не найден: ${file}`);
    }
    const content = fs.readFileSync(source, 'utf-8');
    const extension = optionOf(command, 'extension');
    if (extension === undefined) {
      if (!content.startsWith('CF1:')) {
        throw emulatedFailure('UnknownError', 'Файл не является конфигурацией');
      }
      this.mainPending = content;
      return { kind: 'messages', messages: [{ type: 'success' }] };
    }
    if (parseCfe(content) === undefined) {
      throw emulatedFailure('UnknownError', 'Файл не является расширением');
    }
    const entry = this.find(extension);
    if (entry) {
      entry.pending = content;
    } else {
      this.entries.push({ name: extension, pending: content });
    }
    return { kind: 'messages', messages: [{ type: 'success' }] };
  }

  private updateDb(command: ParsedAgentCommand): ExtensionsOutcome {
    const extension = optionOf(command, 'extension');
    if (extension === undefined) {
      if (this.mainPending !== undefined) {
        this.mainPayload = this.mainPending.slice('CF1:'.length);
        this.mainPending = undefined;
      }
      return { kind: 'messages', messages: [{ type: 'success' }] };
    }
    const entry = this.find(extension);
    // Факт Э28: применение несуществующего расширения — успех без изменений.
    if (!entry?.pending) {
      return { kind: 'messages', messages: [{ type: 'success' }] };
    }
    if (this.updateMode === 'ignore') {
      return { kind: 'messages', messages: [{ type: 'success' }] };
    }
    if (this.updateMode === 'vanish') {
      this.entries.splice(this.entries.indexOf(entry), 1);
      return { kind: 'messages', messages: [{ type: 'success' }] };
    }
    const parsed = parseCfe(entry.pending);
    if (parsed === undefined) {
      throw emulatedFailure('UnknownError', 'Повреждённое содержимое расширения');
    }
    const holder = this.find(parsed.name);
    if (holder && holder !== entry) {
      throw emulatedFailure('UnknownError', 'Расширение с таким именем уже существует!');
    }
    const applied: AppliedState = {
      name: parsed.name,
      version: '',
      purpose: parsed.purpose,
      prefix: parsed.prefix,
      payload: parsed.payload,
      hashSum: sha1Base64(entry.pending),
    };
    // Имя берётся ИЗ ФАЙЛА: запись под запрошенным именем исчезает, если оно отличалось (ФАКТ Э29, П3/П4).
    entry.name = parsed.name;
    entry.applied = applied;
    entry.pending = undefined;
    return { kind: 'messages', messages: [{ type: 'success' }] };
  }

  private writeGarbage(command: ParsedAgentCommand): void {
    const file = optionOf(command, 'file');
    if (file === undefined) {
      return;
    }
    const target = this.abs(file);
    if (fs.existsSync(path.dirname(target))) {
      fs.writeFileSync(target, Buffer.alloc(GARBAGE_BYTES, 0x7f));
    }
  }

  private find(name: string): Entry | undefined {
    const lower = name.toLowerCase();
    return this.entries.find((entry) => entry.name.toLowerCase() === lower);
  }

  private requireFile(command: ParsedAgentCommand): string {
    const file = optionOf(command, 'file');
    if (file === undefined) {
      throw emulatedFailure('CommandFormatError', 'не задан --file');
    }
    return file;
  }

  private abs(rel: string): string {
    return path.join(this.userRoot, ...rel.split('/').filter((segment) => segment !== ''));
  }
}

type CommandKind = 'properties' | 'dump' | 'load' | 'update';

function classify(command: ParsedAgentCommand): CommandKind | undefined {
  if (command.command === 'config dump-cfg') {
    return 'dump';
  }
  if (command.command === 'config load-cfg') {
    return 'load';
  }
  if (command.command === 'config update-db-cfg') {
    return 'update';
  }
  if (command.command === 'config extensions' && command.raw.includes(' properties get')) {
    return 'properties';
  }
  return undefined;
}

function optionOf(command: ParsedAgentCommand, name: string): string | undefined {
  const value = command.options[name];
  return typeof value === 'string' ? value : undefined;
}

function propertiesOf(entry: Entry): Record<string, unknown> {
  const applied = entry.applied;
  return {
    name: entry.name,
    version: applied?.version ?? '',
    active: true,
    purpose: applied?.purpose ?? 'customization',
    'safe-mode': false,
    'security-profile-name': '',
    'unsafe-action-protection': true,
    'used-in-distributed-infobase': false,
    scope: 'infobase',
    'hash-sum': applied?.hashSum ?? ZERO_HASH,
  };
}

/** Ответ `success` со списком расширений — для фейков транспорта, не использующих эмулятор целиком. */
export function extensionListMessages(names: readonly string[]): AgentMessage[] {
  const body = names.map((name) => ({
    type: 'extension-properties',
    body: propertiesOf({ name, applied: { name, version: '', purpose: 'customization', prefix: '', payload: '', hashSum: sha1Base64(name) } }),
  }));
  // Одно расширение — элемент верхнего уровня без success (ФАКТ Э30–Э31), как у настоящего агента.
  return body.length === 1 ? body as AgentMessage[] : [{ type: 'success', body }];
}
