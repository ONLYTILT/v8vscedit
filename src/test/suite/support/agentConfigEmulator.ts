/**
 * Эмулятор КОМАНД агента конфигуратора 1С для тестов движка синхронизации (Э7).
 *
 * Внешняя система здесь — только сам агент: «база» — модель в памяти (владельцы верхнего уровня
 * с файлами и версиями), а каталоги выгрузки (M, обмен) — НАСТОЯЩАЯ файловая система под
 * персональным корнем (`userRoot`), по которой работает и хранилище (локальное напрямую, SFTP — через
 * настоящий ssh2.Server с тем же корнем). Поведение сверено с фактами пилота (план §5b):
 *  - `dump --get-changes` вместе с `--update` ТОЛЬКО пишет список, M не меняется; нужен существующий
 *    `<dir>/ConfigDumpInfo.xml` (иначе ConfigFilesError); родительский каталог файла списка агент не
 *    создаёт; формат — `New:`/`Modified: <EnglishKind>.<Name>[.<Part>]`, UTF-8 BOM + CRLF, «нет
 *    изменений» — один BOM, любое удаление/переименование — одна строка `FullDump`;
 *  - `--archive` разрешается ОТНОСИТЕЛЬНО `--dir` (имя с подкаталогом/абсолютный путь — UnknownError),
 *    при нём в `--dir` кладётся только архив; `--update` вместе с `--archive` не работает
 *    (CommandFormatError); архив — zip, deflate, бит 11, внутри есть ConfigDumpInfo.xml;
 *  - `--update` без `--get-changes` выгружает только объекты с изменившейся версией и убирает файлы
 *    исчезнувших объектов (подтверждено пилотом 2026-11-17, §5b п.16);
 *  - полная загрузка (`load` без `--partial`) и загрузка архивом меняют версию ВСЕХ объектов
 *    (после неё список изменений — сверхприближение), частичная — только владельцев файлов списка;
 *  - `load --partial` вместе с `--update-config-dump-info` падает UnknownError (решение из
 *    комментария `loadChanged`), `--list-file` читается как UTF-8 (BOM допустим) с разделителем `\n`.
 *
 *  - `dump --list-file` (эксперимент 12, агент 8.3.27.2130): строки списка — ИМЕНА объектов (не пути), список —
 *    UTF-8 с BOM и `\n`; несовместим с `--update`; сначала проверяются ВСЕ строки (всё или ничего); имя
 *    владельца даёт только его XML, файловый подобъект (запись CDI с `configVersion`) — свои файлы,
 *    вложенный (без `configVersion`) — ошибка; в `--dir` пишутся только файлы, `ConfigDumpInfo.xml` не
 *    создаётся и не меняется, прочие файлы каталога не трогаются.
 *
 * `load --archive` разрешает имя архива относительно `--dir`, как и выгрузка (подтверждено пилотом
 * 2026-11-17, §5b п.15). Эмулятор принимает именно эту форму.
 */
import * as fs from 'fs';
import * as path from 'path';
import { META_TYPES } from '../../../domain/MetaTypes';
import { agentError } from './agentInfoBaseFakes';
import { buildZip, readZipAsMap } from './zipFixtures';

const BOM = String.fromCharCode(0xfeff);
const CONFIGURATION_OWNER = 'Configuration.Конфигурация';
const CDI = 'ConfigDumpInfo.xml';

/** folder → EnglishKind: строится из META_TYPES, чтобы эмулятор и движок говорили на одном языке. */
const FOLDER_TO_ENGLISH = new Map<string, string>();
for (const def of Object.values(META_TYPES)) {
  if (def.folder) {
    FOLDER_TO_ENGLISH.set(def.folder, def.englishKind ?? def.kind);
  }
}

export interface ParsedAgentCommand {
  readonly raw: string;
  /** `config dump-config-to-files`, `common connect-ib`, … */
  readonly command: string;
  readonly options: Readonly<Record<string, string | true>>;
}

/** Задан ли ключ команды (`options` — запись без `undefined`, поэтому сравнение со значением линтер отвергает). */
export function hasOption(command: ParsedAgentCommand, name: string): boolean {
  return name in command.options;
}

export function parseAgentCommandLine(raw: string): ParsedAgentCommand {
  const match = /^(config [\w-]+|common [\w-]+)\s*(.*)$/.exec(raw);
  if (!match) {
    return { raw, command: raw, options: {} };
  }
  const options: Record<string, string | true> = {};
  for (const option of match[2].matchAll(/--([\w-]+)(?:=("(?:[^"\\]|\\.)*"|\S*))?/g)) {
    const value = option.at(2);
    if (value === undefined) {
      options[option[1]] = true;
    } else if (value.startsWith('"')) {
      options[option[1]] = value.slice(1, -1).replace(/\\(.)/g, '$1');
    } else {
      options[option[1]] = value;
    }
  }
  return { raw, command: match[1], options };
}

interface EmulatedObject {
  files: Map<string, Buffer>;
  /** Версия владельца в ConfigDumpInfo.xml = наибольшая из версий его файлов. */
  version: number;
  /** Версия КАЖДОГО файла: настоящий агент при `--update` пишет только файлы, изменившиеся после известной версии. */
  fileVersions: Map<string, number>;
  parts: string[];
  /**
   * Вложенные (встроенные) подобъекты без `configVersion` — реквизиты, ТЧ: в XML родителя, а не в
   * отдельном файле. `undefined` — по умолчанию один реквизит (кроме корня конфигурации).
   */
  inline?: string[];
}

/**
 * Гранулярность `dump --update`: `owner` — переписывается ВЕСЬ владелец с изменившейся версией (прежнее
 * поведение эмулятора); `changed-files` — только файлы владельца с версией новее известной по
 * ConfigDumpInfo.xml каталога (поведение настоящего агента, пилот §5b п.9: «только файлы с версиями,
 * отличающимися от версий в ConfigDumpInfo.xml»). Второй режим нужен проверке разреженного M: файлы
 * неизменённых частей владельца в такой M не попадают.
 */
export type EmulatorUpdateGranularity = 'owner' | 'changed-files';

export interface EmulatedLoad {
  readonly mode: 'dir' | 'partial' | 'archive';
  /** Файлы, которые агент взял из каталога/списка/архива (относительные пути). */
  readonly files: string[];
}

export class AgentConfigEmulator {
  readonly commands: ParsedAgentCommand[] = [];
  readonly loads: EmulatedLoad[] = [];
  updateDbCalls = 0;
  /** Сколько раз агент получал `dump --list-file` (включая отклонённые). */
  listDumpCalls = 0;
  /** Списки имён всех `dump --list-file` по порядку (последний — `lastListNames`). */
  readonly listDumpNames: string[][] = [];
  /** Файлы (относительные пути), которые `--list-file` «не выгружает»: моделирует недовыгрузку агента. */
  listDumpMissingFiles = new Set<string>();
  /** Вызывается в начале каждой команды (после журналирования, до исполнения): точка для отмены/гонок. */
  onCommand: ((command: ParsedAgentCommand) => void) | undefined;
  /** Подменяет содержимое СЛЕДУЮЩЕГО файла `--get-changes` (однократно); текст отдаётся как есть. */
  nextChangesText: string | undefined;
  /** Искажает байты архива, который агент собирается отдать (однократно). */
  nextArchiveTamper: ((zip: Buffer) => Buffer) | undefined;
  updateGranularity: EmulatorUpdateGranularity = 'owner';
  /** Версия формата в заголовке ConfigDumpInfo.xml и `MetaDataObject version` Configuration.xml. */
  formatVersion = '2.20';
  /** Если возвращает Error — команда падает с ним. */
  failWhen: ((command: ParsedAgentCommand) => Error | undefined) | undefined;

  get lastListNames(): readonly string[] | undefined {
    return this.listDumpNames.at(-1);
  }

  private readonly objects = new Map<string, EmulatedObject>();
  private versionCounter = 1;

  constructor(private readonly userRoot: string) {}

  // ── Модель базы ─────────────────────────────────────────────────────────

  /** Добавляет или целиком заменяет владельца верхнего уровня (его файлы и версию). */
  setObject(fullName: string, files: Record<string, string | Buffer>, parts: string[] = []): void {
    this.versionCounter += 1;
    const version = this.versionCounter;
    const entries = Object.entries(files);
    this.objects.set(fullName, {
      files: new Map(entries.map(([rel, data]) => [rel, Buffer.from(data)])),
      version,
      fileVersions: new Map(entries.map(([rel]) => [rel, version])),
      parts,
    });
  }

  /**
   * Реалистичный `Configuration.xml` (Name, для cfe — `ConfigurationExtensionPurpose`, версия формата в
   * `MetaDataObject`): по нему `ConfigXmlReader` и проверки посева узнают вид и имя. Заменяет только этот
   * файл владельца-конфигурации, остальное (Ext/…) сохраняется.
   */
  setConfiguration(name: string, kind: 'cf' | 'cfe'): void {
    const purpose = kind === 'cfe' ? '<ConfigurationExtensionPurpose>Patch</ConfigurationExtensionPurpose>' : '';
    this.putFile('Configuration.xml', [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="${this.formatVersion}">`,
      '<Configuration uuid="00000000-0000-0000-0000-000000000001">',
      '<Properties>',
      `<Name>${name}</Name>${purpose}`,
      '</Properties>',
      '</Configuration>',
      '</MetaDataObject>',
      '',
    ].join('\n'));
  }

  /** Полная выгрузка базы (с ConfigDumpInfo.xml) в каталог проекта: посев «старой выгрузкой». */
  snapshotToProject(dir: string): void {
    this.writeFiles(dir, this.dbFiles());
  }

  /** Меняет один файл владельца (владелец определяется по пути); версия владельца растёт. */
  putFile(rel: string, content: string | Buffer, parts: string[] = []): void {
    const owner = ownerOfPath(rel);
    if (!owner) {
      throw new Error(`эмулятор: не определён владелец файла ${rel}`);
    }
    const object = this.objects.get(owner) ?? { files: new Map<string, Buffer>(), version: 0, fileVersions: new Map<string, number>(), parts: [] };
    this.versionCounter += 1;
    object.files.set(rel, Buffer.from(content));
    object.fileVersions.set(rel, this.versionCounter);
    object.version = this.versionCounter;
    object.parts = parts;
    this.objects.set(owner, object);
  }

  removeObject(fullName: string): void {
    this.objects.delete(fullName);
  }

  hasObject(fullName: string): boolean {
    return this.objects.has(fullName);
  }

  /** Добавляет встроенный подобъект (`Attribute.Имя`, `TabularSection.Имя`) к уже заданному владельцу. */
  addInlineChild(owner: string, child: string): void {
    const object = this.requireObject(owner);
    object.inline = [...(object.inline ?? defaultInline(owner)), child];
  }

  /** Полностью задаёт набор встроенных подобъектов владельца (в т.ч. пустой). */
  setInlineChildren(owner: string, children: string[]): void {
    this.requireObject(owner).inline = [...children];
  }

  /** Имена записей CDI владельца: сам владелец, встроенные, файловые подобъекты (порядок файла). */
  cdiNamesOf(owner: string): string[] {
    const object = this.requireObject(owner);
    return [
      owner,
      ...(object.inline ?? defaultInline(owner)).map((child) => `${owner}.${child}`),
      ...fileSubobjects(owner, object).filter(([suffix]) => suffix !== '').map(([suffix]) => `${owner}${suffix}`),
    ];
  }

  private requireObject(owner: string): EmulatedObject {
    const object = this.objects.get(owner);
    if (!object) {
      throw new Error(`эмулятор: нет владельца ${owner}`);
    }
    return object;
  }

  /** Все файлы выгрузки «базы», включая сгенерированный ConfigDumpInfo.xml. */
  dbFiles(): Record<string, Buffer> {
    const result: Record<string, Buffer> = {};
    for (const object of this.objects.values()) {
      for (const [rel, data] of object.files) {
        result[rel] = data;
      }
    }
    result[CDI] = this.buildConfigDumpInfo();
    return result;
  }

  /** То же без ConfigDumpInfo.xml: то, что отслеживается в проекте. */
  dbTrackedFiles(): Record<string, Buffer> {
    return Object.fromEntries(Object.entries(this.dbFiles()).filter(([rel]) => rel !== CDI));
  }

  // ── Исполнитель команд ─────────────────────────────────────────────────

  /** Контракт `AgentCommandExecutor`: ошибки агента — отклонённый промис. */
  execute(commandLine: string): Promise<{ messages: [] }> {
    const parsed = parseAgentCommandLine(commandLine);
    this.commands.push(parsed);
    try {
      this.onCommand?.(parsed);
      const failure = this.failWhen?.(parsed);
      if (failure) {
        throw failure;
      }
      this.run(parsed);
      return Promise.resolve({ messages: [] });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Команды выгрузки, разобранные: `dump` в журнале. */
  dumps(): ParsedAgentCommand[] {
    return this.commands.filter((c) => c.command === 'config dump-config-to-files');
  }

  private run(cmd: ParsedAgentCommand): void {
    switch (cmd.command) {
      case 'config dump-config-to-files':
        this.dump(cmd);
        return;
      case 'config load-config-from-files':
        this.load(cmd);
        return;
      case 'config update-db-cfg':
        this.updateDbCalls += 1;
        return;
      default:
        // connect-ib, disconnect-ib и прочие команды жизненного цикла: ответ «успешно».
        return;
    }
  }

  private abs(rel: string): string {
    return path.join(this.userRoot, ...rel.split('/').filter((segment) => segment !== ''));
  }

  private option(cmd: ParsedAgentCommand, name: string): string | undefined {
    const value = cmd.options[name];
    return typeof value === 'string' ? value : undefined;
  }

  private requireOption(cmd: ParsedAgentCommand, name: string): string {
    const value = this.option(cmd, name);
    if (value === undefined) {
      throw agentError('CommandFormatError', `не задан --${name}`);
    }
    return value;
  }

  private checkFormat(cmd: ParsedAgentCommand): void {
    const format = this.option(cmd, 'format');
    if (format !== undefined && format !== 'hierarchical') {
      throw agentError('CommandFormatError', `формат ${format}`);
    }
  }

  // ── dump ──────────────────────────────────────────────────────────────

  private dump(cmd: ParsedAgentCommand): void {
    this.checkFormat(cmd);
    const dir = this.requireOption(cmd, 'dir');
    const dirAbs = this.abs(dir);
    const archive = this.option(cmd, 'archive');
    const getChanges = this.option(cmd, 'get-changes');
    const update = cmd.options.update === true;
    const infoOnly = cmd.options['config-dump-info-only'] === true;

    const listFile = this.option(cmd, 'list-file');
    if (listFile !== undefined) {
      this.dumpByList(dirAbs, listFile, update);
      return;
    }

    if (archive !== undefined) {
      if (update) {
        throw agentError('CommandFormatError', '--update и --archive вместе не поддерживаются');
      }
      if (/[\\/:]/.test(archive)) {
        throw agentError('UnknownError', 'Неправильное имя файла архива');
      }
      fs.mkdirSync(dirAbs, { recursive: true });
      const files = infoOnly ? { [CDI]: this.buildConfigDumpInfo() } : this.dbFiles();
      let zip = buildZip(Object.entries(files).map(([name, data]) => ({ name, data })));
      if (this.nextArchiveTamper) {
        zip = this.nextArchiveTamper(zip);
        this.nextArchiveTamper = undefined;
      }
      fs.writeFileSync(path.join(dirAbs, archive), zip);
      return;
    }

    if (getChanges !== undefined) {
      const known = this.readConfigDumpInfo(dirAbs);
      if (!known) {
        throw agentError('ConfigFilesError', 'Не удалось найти файл версий');
      }
      const target = this.abs(getChanges);
      if (!fs.existsSync(path.dirname(target))) {
        throw agentError('ConfigFilesError', 'Каталог не обнаружен');
      }
      const text = this.nextChangesText ?? this.computeChangesText(known);
      this.nextChangesText = undefined;
      fs.writeFileSync(target, text, 'utf-8');
      return;
    }

    if (infoOnly) {
      fs.mkdirSync(dirAbs, { recursive: true });
      fs.writeFileSync(path.join(dirAbs, CDI), this.buildConfigDumpInfo());
      return;
    }

    const known = update ? this.readConfigDumpInfo(dirAbs) : undefined;
    if (!known) {
      removeTree(dirAbs);
      this.writeFiles(dirAbs, this.dbFiles());
      return;
    }
    for (const [name] of known) {
      if (!this.objects.has(name)) {
        this.removeOwnerFiles(dirAbs, name);
      }
    }
    for (const [name, object] of this.objects) {
      const knownVersion = known.get(name);
      if (knownVersion === object.version) {
        continue;
      }
      if (this.updateGranularity === 'changed-files') {
        const changed = [...object.files].filter(([rel]) => (object.fileVersions.get(rel) ?? 0) > (knownVersion ?? 0));
        this.writeFiles(dirAbs, Object.fromEntries(changed));
        continue;
      }
      this.removeOwnerFiles(dirAbs, name);
      this.writeFiles(dirAbs, Object.fromEntries(object.files));
    }
    fs.writeFileSync(path.join(dirAbs, CDI), this.buildConfigDumpInfo());
  }

  /** `dump --list-file`: имена из списка → файлы в `--dir` (CDI не пишется). */
  private dumpByList(dirAbs: string, listFile: string, update: boolean): void {
    this.listDumpCalls += 1;
    if (update) {
      throw agentError('CommandFormatError', 'Ключ -listFile не может использоваться совместно с ключами инкрементальной выгрузки.');
    }
    const listAbs = this.abs(listFile);
    if (!fs.existsSync(listAbs)) {
      throw agentError('ConfigFilesError', 'Файл не обнаружен');
    }
    const text = fs.readFileSync(listAbs, 'utf-8');
    const names = (text.startsWith(BOM) ? text.slice(1) : text).split('\n').filter((line) => line.trim() !== '');
    this.listDumpNames.push(names);

    const records = this.cdiRecords();
    // Сначала проверяются ВСЕ строки: при ошибке не пишется ничего.
    const toWrite = new Map<string, Buffer>();
    for (const name of names) {
      const record = name.includes('/') || name.endsWith('.xml') ? undefined : records.get(name);
      if (!record) {
        throw agentError('ConfigFilesError', `Объект метаданных ${name} не существует в конфигурации.`);
      }
      if (record.kind === 'inline') {
        throw agentError(
          'ConfigFilesError',
          `Невозможно сохранить объект метаданых ${name} в отдельный XML-файл. Вы можете сохранить его как часть родительского объекта.`
        );
      }
      for (const [rel, data] of record.files) {
        if (!this.listDumpMissingFiles.has(rel)) {
          toWrite.set(rel, data);
        }
      }
    }
    fs.mkdirSync(dirAbs, { recursive: true });
    this.writeFiles(dirAbs, Object.fromEntries(toWrite));
  }

  /** Все имена CDI → что агент выгрузит по такому имени (владелец — его XML, файловый — свои файлы). */
  private cdiRecords(): Map<string, { kind: 'owner' | 'file' | 'inline'; files: Map<string, Buffer> }> {
    const records = new Map<string, { kind: 'owner' | 'file' | 'inline'; files: Map<string, Buffer> }>();
    const filesOf = (object: EmulatedObject, rels: string[]): Map<string, Buffer> =>
      new Map(rels.map((rel) => [rel, object.files.get(rel) ?? Buffer.alloc(0)] as const));
    for (const [owner, object] of this.objects) {
      for (const [suffix, rels] of fileSubobjects(owner, object)) {
        records.set(`${owner}${suffix}`, { kind: suffix === '' ? 'owner' : 'file', files: filesOf(object, rels) });
      }
      if (!records.has(owner)) {
        records.set(owner, { kind: 'owner', files: new Map() });
      }
      for (const child of object.inline ?? defaultInline(owner)) {
        records.set(`${owner}.${child}`, { kind: 'inline', files: new Map() });
      }
    }
    return records;
  }

  private computeChangesText(known: Map<string, number>): string {
    for (const name of known.keys()) {
      if (!this.objects.has(name)) {
        return `${BOM}FullDump\r\n`;
      }
    }
    const lines: string[] = [];
    for (const name of [...this.objects.keys()].sort()) {
      const object = this.objects.get(name);
      const version = known.get(name);
      if (!object || version === object.version) {
        continue;
      }
      const change = version === undefined ? 'New' : 'Modified';
      for (const part of object.parts) {
        lines.push(`${change}: ${name}.${part}`);
      }
      lines.push(`${change}: ${name}`);
    }
    return BOM + lines.map((line) => `${line}\r\n`).join('');
  }

  // ── load ──────────────────────────────────────────────────────────────

  private load(cmd: ParsedAgentCommand): void {
    this.checkFormat(cmd);
    const dir = this.requireOption(cmd, 'dir');
    const dirAbs = this.abs(dir);
    const archive = this.option(cmd, 'archive');

    if (archive !== undefined) {
      const zipPath = path.join(dirAbs, archive);
      if (!fs.existsSync(zipPath)) {
        throw agentError('UnknownError', 'Архив не найден');
      }
      const entries = readZipAsMap(fs.readFileSync(zipPath));
      const files: Record<string, Buffer> = {};
      for (const [name, data] of entries) {
        if (name !== CDI) {
          files[name] = data;
        }
      }
      this.replaceAll(files);
      this.loads.push({ mode: 'archive', files: Object.keys(files) });
      return;
    }

    if (cmd.options.partial === true) {
      if (cmd.options['update-config-dump-info'] === true) {
        throw agentError('UnknownError', '');
      }
      const listFile = this.abs(this.requireOption(cmd, 'list-file'));
      if (!fs.existsSync(listFile)) {
        throw agentError('ConfigFilesError', 'Файл списка не найден');
      }
      const listText = fs.readFileSync(listFile, 'utf-8');
      const listed = (listText.startsWith(BOM) ? listText.slice(1) : listText).split(/\r?\n/).filter((line) => line.trim() !== '');
      for (const rel of listed) {
        if (!fs.existsSync(path.join(dirAbs, ...rel.split('/')))) {
          throw agentError('ConfigFilesError', `Файл не найден: ${rel}`);
        }
      }
      for (const rel of listed) {
        this.putFile(rel, fs.readFileSync(path.join(dirAbs, ...rel.split('/'))));
      }
      this.loads.push({ mode: 'partial', files: listed });
      return;
    }

    const files: Record<string, Buffer> = {};
    walkFiles(dirAbs, '', (rel, data) => {
      if (rel !== CDI) {
        files[rel] = data;
      }
    });
    this.replaceAll(files);
    if (cmd.options['update-config-dump-info'] === true) {
      fs.writeFileSync(path.join(dirAbs, CDI), this.buildConfigDumpInfo());
    }
    this.loads.push({ mode: 'dir', files: Object.keys(files) });
  }

  private replaceAll(files: Record<string, Buffer>): void {
    this.objects.clear();
    for (const [rel, data] of Object.entries(files)) {
      this.putFile(rel, data);
    }
    // Полная загрузка/загрузка архивом меняет версию КАЖДОГО объекта (факт пилота §5b п.8).
    this.versionCounter += 1;
    for (const object of this.objects.values()) {
      object.version = this.versionCounter;
      object.fileVersions = new Map([...object.files.keys()].map((rel) => [rel, this.versionCounter]));
      object.parts = [];
    }
  }

  // ── ConfigDumpInfo.xml ────────────────────────────────────────────────

  private buildConfigDumpInfo(): Buffer {
    const lines: string[] = [];
    let idCounter = 0;
    const id = (): string => `id="00000000-0000-0000-0000-${String(++idCounter).padStart(12, '0')}"`;
    for (const [name, object] of [...this.objects.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      // Как у платформы: тег владельца открывающий, внутри — встроенные (без configVersion) и файловые
      // подобъекты (с configVersion), `</Metadata>`; порядок атрибутов `name`, `id`, `configVersion`.
      const children: string[] = [
        ...(object.inline ?? defaultInline(name)).map((child) => `    <Metadata name="${name}.${child}" ${id()}/>`),
        ...fileSubobjects(name, object)
          .filter(([suffix]) => suffix !== '')
          .map(([suffix, rels]) => {
            const version = Math.max(...rels.map((rel) => object.fileVersions.get(rel) ?? object.version));
            return `    <Metadata name="${name}${suffix}" ${id()} configVersion="${String(version)}"/>`;
          }),
      ];
      const open = `  <Metadata name="${name}" ${id()} configVersion="${String(object.version)}"`;
      if (children.length === 0) {
        lines.push(`${open}/>`);
      } else {
        lines.push(`${open}>`, ...children, '  </Metadata>');
      }
    }
    // Заголовок как у платформы: пространство имён, `format="Hierarchical"` и версия формата — по ним
    // проверяется пригодность файла версий проекта для посева зеркала.
    const header = `<ConfigDumpInfo xmlns="http://v8.1c.ru/8.3/xcf/dumpinfo" format="Hierarchical" version="${this.formatVersion}">`;
    return Buffer.from(`${BOM}${header}\n${lines.join('\n')}\n</ConfigDumpInfo>\n`, 'utf-8');
  }

  /** Версии владельцев верхнего уровня (имена из двух сегментов); вложенные записи эмулятору не нужны. */
  private readConfigDumpInfo(dirAbs: string): Map<string, number> | undefined {
    const file = path.join(dirAbs, CDI);
    if (!fs.existsSync(file)) {
      return undefined;
    }
    const result = new Map<string, number>();
    for (const tag of fs.readFileSync(file, 'utf-8').matchAll(/<Metadata\b[^>]*>/g)) {
      const name = /\bname="([^"]+)"/.exec(tag[0])?.[1];
      const version = /\bconfigVersion="(\d+)"/.exec(tag[0])?.[1];
      if (name !== undefined && version !== undefined && name.split('.').length === 2) {
        result.set(name, Number(version));
      }
    }
    return result;
  }

  private writeFiles(dirAbs: string, files: Record<string, Buffer | string>): void {
    for (const [rel, data] of Object.entries(files)) {
      const target = path.join(dirAbs, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
  }

  private removeOwnerFiles(dirAbs: string, owner: string): void {
    const toRemove: string[] = [];
    walkFiles(dirAbs, '', (rel) => {
      if (ownerOfPath(rel) === owner) {
        toRemove.push(rel);
      }
    });
    for (const rel of toRemove) {
      fs.unlinkSync(path.join(dirAbs, ...rel.split('/')));
    }
  }
}

/**
 * `Catalogs/Товары/Ext/ObjectModule.bsl` → `Catalog.Товары`; `Configuration.xml` и `Ext/*` (модули и
 * интерфейс конфигурации) → владелец конфигурации.
 */
export function ownerOfPath(rel: string): string | undefined {
  if (rel === 'Configuration.xml' || rel.startsWith('Ext/')) {
    return CONFIGURATION_OWNER;
  }
  const parts = rel.split('/');
  const english = FOLDER_TO_ENGLISH.get(parts[0]);
  if (!english || parts.length < 2) {
    return undefined;
  }
  return `${english}.${parts[1].replace(/\.xml$/, '')}`;
}

function defaultInline(owner: string): string[] {
  return owner === CONFIGURATION_OWNER ? [] : ['Attribute.Реквизит'];
}

const stemOf = (fileName: string): string => fileName.replace(/\.[^.]+$/, '');

/**
 * Суффикс имени записи CDI, которой принадлежит файл владельца (`''` — XML самого владельца), или
 * `undefined`, если у файла нет своей записи. Карта — ДЕТАЛЬ СТЕНДА, снятая с эксперимента 12; продакшн
 * её не знает (имена он берёт из CDI проекта).
 */
export function cdiSuffixOfFile(owner: string, rel: string): string | undefined {
  const parts = rel.split('/');
  if (owner === CONFIGURATION_OWNER) {
    if (rel === 'Configuration.xml') {
      return '';
    }
    return parts.length === 2 && parts[0] === 'Ext' ? `.${stemOf(parts[1])}` : undefined;
  }
  if (parts.length === 2 && parts[1].endsWith('.xml')) {
    return '';
  }
  const rest = parts.slice(2);
  switch (rest[0]) {
    case 'Forms':
      if (rest.length === 2 && rest[1].endsWith('.xml')) {
        return `.Form.${stemOf(rest[1])}`;
      }
      return rest[2] === 'Ext' && (rest[3] === 'Form.xml' || rest[3] === 'Form') ? `.Form.${rest[1]}.Form` : undefined;
    case 'Templates':
      if (rest.length === 2 && rest[1].endsWith('.xml')) {
        return `.Template.${stemOf(rest[1])}`;
      }
      return rest[2] === 'Ext' ? `.Template.${rest[1]}.Template` : undefined;
    case 'Commands':
      return rest[2] === 'Ext' && rest[3] === 'CommandModule.bsl' ? `.Command.${rest[1]}.CommandModule` : undefined;
    case 'Ext':
      return rest.length === 2 ? `.${stemOf(rest[1])}` : undefined;
    default:
      return undefined;
  }
}

/** Записи CDI владельца с файлами: `[суффикс, файлы]`, владелец первым (`''`), далее по порядку файлов. */
function fileSubobjects(owner: string, object: EmulatedObject): [string, string[]][] {
  const groups = new Map<string, string[]>();
  for (const rel of object.files.keys()) {
    const suffix = cdiSuffixOfFile(owner, rel);
    if (suffix !== undefined) {
      groups.set(suffix, [...(groups.get(suffix) ?? []), rel]);
    }
  }
  return [...groups].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : 0));
}

/** Удаление дерева без fs.rmSync: на Windows с Node 24 rmSync молча не удаляет файлы с кириллицей в имени. */
function removeTree(dir: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removeTree(abs);
    } else {
      fs.unlinkSync(abs);
    }
  }
  fs.rmdirSync(dir);
}

function walkFiles(rootAbs: string, rel: string, visit: (rel: string, data: Buffer) => void): void {
  const dir = rel ? path.join(rootAbs, ...rel.split('/')) : rootAbs;
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkFiles(rootAbs, childRel, visit);
    } else {
      visit(childRel, fs.readFileSync(path.join(dir, entry.name)));
    }
  }
}
