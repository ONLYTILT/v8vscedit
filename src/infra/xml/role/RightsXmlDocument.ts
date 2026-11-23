import { escapeXmlText, rootLocalNamePattern, sliceToRootElement, unescapeXml } from '../XmlUtils';
import {
  RIGHTS_FLAG_ORDER,
  renderConditionLines,
  renderFlagLine,
  renderObjectBlock,
  renderRightBlock,
  renderTemplateBlock,
  type RightsFlagName,
} from './RightsXmlRender';

/**
 * Модель Rights.xml для ТОЧЕЧНОЙ правки (edit_role).
 *
 * Почему не «разобрать → изменить → пересобрать»: эталонные роли до 24 МБ, а
 * пересборка меняла байты всего файла (терялись `xsi:type`, `<field>`, `<condition/>`,
 * сущности, отсутствие хвостового перевода строки) даже при повторе уже выданного права.
 * Здесь файл режется ОДНИМ линейным проходом на куски (шапка с флагами, блоки
 * `<object>`, блоки `<restrictionTemplate>`, промежутки, хвост с `</Rights>`); нетронутые
 * куски копируются в `render()` как есть, а внутри затронутого блока меняется только
 * нужный поддиапазон. Права объекта разбираются лениво — только у затронутых объектов.
 */

export interface RightsXmlRightInfo {
  readonly name: string;
  readonly value: string;
  /** Условие RLS после unescape; пустое для `<condition/>`, `undefined` — ограничения нет. */
  readonly condition?: string;
}

export interface RightsXmlDocument {
  /** Права объекта (первое вхождение имени) или `undefined`, если объекта нет. */
  getObjectRights(objectName: string): RightsXmlRightInfo[] | undefined;
  /** Имена объектов документа в порядке файла (по первому вхождению). */
  objectNames(): string[];
  setRight(objectName: string, rightName: string, value: 'true' | 'false'): boolean;
  removeRight(objectName: string, rightName: string): boolean;
  removeObject(objectName: string): boolean;
  setCondition(objectName: string, rightName: string, condition: string | undefined): boolean;
  setFlag(flag: RightsFlagName, value: boolean): boolean;
  setTemplate(name: string, condition: string): boolean;
  removeTemplate(name: string): boolean;
  render(): string;
}

/** Кусок исходного текста. `before` — новые блоки, вставляемые перед ним (порядок вызовов). */
interface Chunk {
  text: string;
  before?: Chunk[];
}

interface NamedChunk extends Chunk {
  readonly name: string;
}

interface ClosingChunk extends Chunk {
  /** Новые шаблоны: всегда после новых объектов, которые тоже могут стоять перед `</Rights>`. */
  templatesBefore?: Chunk[];
}

interface TagRange {
  readonly start: number;
  readonly end: number;
}

/** Разобранное право внутри текста объекта; смещения — относительно этого текста. */
interface ParsedRight {
  readonly name: string;
  readonly block: TagRange;
  readonly value?: { readonly inner: TagRange; readonly lineEnd: number };
  readonly restriction?: {
    readonly block: TagRange;
    readonly hasField: boolean;
    readonly closeTagStart: number;
    /** `<condition>…</condition>` (inner задан) или `<condition/>` (inner не задан). */
    readonly condition?: { readonly element: TagRange; readonly inner?: TagRange };
  };
}

const RIGHTS_ROOT = rootLocalNamePattern('Rights');
const OBJECT_OPEN = '<object>';
const OBJECT_CLOSE = '</object>';
const TEMPLATE_OPEN = '<restrictionTemplate>';
const TEMPLATE_CLOSE = '</restrictionTemplate>';
const RIGHTS_CLOSE = '</Rights>';

export function parseRightsXmlDocument(xml: string): RightsXmlDocument | { error: string } {
  const root = sliceToRootElement(xml);
  if (root === null || !RIGHTS_ROOT.test(root)) {
    return { error: 'Корневой элемент документа — не <Rights>.' };
  }
  const rootStart = xml.length - root.length;
  const rootOpenEnd = xml.indexOf('>', rootStart);
  if (rootOpenEnd < 0) {
    return { error: 'Открывающий тег <Rights> не закрыт.' };
  }
  if (xml[rootOpenEnd - 1] === '/') {
    return { error: 'Корень <Rights/> пуст: нет закрывающего </Rights>.' };
  }
  const closeTag = xml.lastIndexOf(RIGHTS_CLOSE);
  if (closeTag <= rootOpenEnd) {
    return { error: 'Нет закрывающего тега </Rights>.' };
  }
  const blocks = scanBlocks(xml, rootOpenEnd + 1, closeTag);
  if ('error' in blocks) {
    return blocks;
  }
  return new SplicedRightsDocument(xml, rootOpenEnd + 1, closeTag, blocks.list);
}

interface ScannedBlock {
  readonly kind: 'object' | 'template';
  readonly range: TagRange;
  readonly name: string;
}

/** Линейный проход по блокам `<object>`/`<restrictionTemplate>` между корнем и `</Rights>`. */
function scanBlocks(xml: string, from: number, to: number): { list: ScannedBlock[] } | { error: string } {
  const list: ScannedBlock[] = [];
  let pos = from;
  let nextObject = xml.indexOf(OBJECT_OPEN, pos);
  let nextTemplate = xml.indexOf(TEMPLATE_OPEN, pos);
  for (;;) {
    const objectAt = nextObject >= 0 && nextObject < to ? nextObject : -1;
    const templateAt = nextTemplate >= 0 && nextTemplate < to ? nextTemplate : -1;
    if (objectAt < 0 && templateAt < 0) {
      return { list };
    }
    const isObject = objectAt >= 0 && (templateAt < 0 || objectAt < templateAt);
    const open = isObject ? objectAt : templateAt;
    const openTag = isObject ? OBJECT_OPEN : TEMPLATE_OPEN;
    const closeTag = isObject ? OBJECT_CLOSE : TEMPLATE_CLOSE;
    const close = xml.indexOf(closeTag, open + openTag.length);
    const following = xml.indexOf(openTag, open + openTag.length);
    if (close < 0 || close > to || (following >= 0 && following < close)) {
      return { error: `Незакрытый ${openTag} (смещение ${String(open)}).` };
    }
    const closeEnd = close + closeTag.length;
    list.push({
      kind: isObject ? 'object' : 'template',
      range: { start: lineStartOf(xml, open, pos), end: lineEndAfter(xml, closeEnd) },
      name: readFirstName(xml, open, close),
    });
    pos = list[list.length - 1].range.end;
    if (isObject) {
      nextObject = following;
      if (nextTemplate >= 0 && nextTemplate < pos) {
        nextTemplate = xml.indexOf(TEMPLATE_OPEN, pos);
      }
    } else {
      nextTemplate = following;
      if (nextObject >= 0 && nextObject < pos) {
        nextObject = xml.indexOf(OBJECT_OPEN, pos);
      }
    }
  }
}

/** Начало строки, если перед тегом на ней только отступ; иначе сам тег (не раньше `floor`). */
function lineStartOf(text: string, tagStart: number, floor = 0): number {
  let i = tagStart;
  while (i > floor && (text[i - 1] === '\t' || text[i - 1] === ' ')) {
    i -= 1;
  }
  return i === floor || text[i - 1] === '\n' ? i : tagStart;
}

/** Конец строки после тега: хвостовые пробелы и перевод строки, если строка на теге кончается. */
function lineEndAfter(text: string, tagEnd: number): number {
  let i = tagEnd;
  while (text[i] === '\t' || text[i] === ' ') {
    i += 1;
  }
  if (text[i] === '\r' && text[i + 1] === '\n') {
    return i + 2;
  }
  if (text[i] === '\n') {
    return i + 1;
  }
  return tagEnd;
}

function readFirstName(text: string, from: number, to: number): string {
  const open = text.indexOf('<name>', from);
  if (open < 0 || open > to) {
    return '';
  }
  const close = text.indexOf('</name>', open);
  return close < 0 || close > to ? '' : unescapeXml(text.slice(open + 6, close));
}

/** Условие в виде для сравнения: unescape + EOL к `\n` (файл в CRLF, вход агента в LF). */
function normalizeCondition(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

class SplicedRightsDocument implements RightsXmlDocument {
  private readonly eol: string;
  private readonly head: Chunk;
  private readonly closing: ClosingChunk;
  private readonly chunks: Chunk[] = [];
  private readonly objects = new Map<string, NamedChunk>();
  /** Повторные вхождения имени: становятся действующими после удаления первого. */
  private readonly duplicateObjects = new Map<string, NamedChunk[]>();
  private readonly templates = new Map<string, NamedChunk>();
  private readonly objectOrder: string[] = [];
  private objectAnchor: Chunk;

  constructor(xml: string, bodyStart: number, closeTag: number, blocks: readonly ScannedBlock[]) {
    this.eol = xml.includes('\r\n') ? '\r\n' : '\n';
    const headEnd = blocks.length > 0 ? blocks[0].range.start : lineStartOf(xml, closeTag, bodyStart);
    this.head = { text: xml.slice(0, headEnd) };
    this.chunks.push(this.head);
    let pos = headEnd;
    let firstTemplate: Chunk | undefined;
    for (const block of blocks) {
      if (block.range.start > pos) {
        this.chunks.push({ text: xml.slice(pos, block.range.start) });
      }
      const chunk: NamedChunk = { text: xml.slice(block.range.start, block.range.end), name: block.name };
      this.chunks.push(chunk);
      if (block.kind === 'object') {
        this.registerObject(chunk);
      } else {
        firstTemplate ??= chunk;
        if (!this.templates.has(chunk.name)) {
          this.templates.set(chunk.name, chunk);
        }
      }
      pos = block.range.end;
    }
    const closingStart = Math.max(pos, lineStartOf(xml, closeTag, pos));
    if (closingStart > pos) {
      this.chunks.push({ text: xml.slice(pos, closingStart) });
    }
    this.closing = { text: xml.slice(closingStart) };
    this.chunks.push(this.closing);
    this.objectAnchor = firstTemplate ?? this.closing;
  }

  getObjectRights(objectName: string): RightsXmlRightInfo[] | undefined {
    const chunk = this.objects.get(objectName);
    if (!chunk) {
      return undefined;
    }
    return parseRights(chunk.text).map((right) => ({
      name: right.name,
      value: right.value ? chunk.text.slice(right.value.inner.start, right.value.inner.end).trim() : '',
      condition: readCondition(chunk.text, right),
    }));
  }

  objectNames(): string[] {
    return this.objectOrder.filter((name) => this.objects.has(name));
  }

  setRight(objectName: string, rightName: string, value: 'true' | 'false'): boolean {
    const chunk = this.objects.get(objectName);
    if (!chunk) {
      const created: NamedChunk = {
        text: renderObjectBlock({ name: objectName, rights: [{ name: rightName, value }] }, this.eol),
        name: objectName,
      };
      this.insertBefore(this.objectAnchor, created);
      this.registerObject(created);
      return true;
    }
    const right = findRight(chunk.text, rightName);
    if (!right) {
      const closeAt = chunk.text.lastIndexOf(OBJECT_CLOSE);
      chunk.text = insertBeforeTag(chunk.text, closeAt, renderRightBlock({ name: rightName, value }, this.eol), this.eol);
      return true;
    }
    if (!right.value) {
      throw new Error(`У права ${rightName} объекта ${objectName} нет элемента <value>.`);
    }
    const current = chunk.text.slice(right.value.inner.start, right.value.inner.end).trim();
    if (current === value) {
      return false;
    }
    chunk.text = splice(chunk.text, right.value.inner, value);
    return true;
  }

  removeRight(objectName: string, rightName: string): boolean {
    const chunk = this.objects.get(objectName);
    const right = chunk ? findRight(chunk.text, rightName) : undefined;
    if (!chunk || !right) {
      return false;
    }
    chunk.text = splice(chunk.text, right.block, '');
    return true;
  }

  removeObject(objectName: string): boolean {
    const chunk = this.objects.get(objectName);
    if (!chunk) {
      return false;
    }
    chunk.text = '';
    const next = this.duplicateObjects.get(objectName)?.shift();
    if (next) {
      this.objects.set(objectName, next);
    } else {
      this.objects.delete(objectName);
    }
    return true;
  }

  setCondition(objectName: string, rightName: string, condition: string | undefined): boolean {
    const chunk = this.objects.get(objectName);
    const right = chunk ? findRight(chunk.text, rightName) : undefined;
    if (!chunk || !right) {
      return false;
    }
    const next = applyCondition(chunk.text, right, condition ?? '', this.eol);
    if (next === null) {
      return false;
    }
    chunk.text = next;
    return true;
  }

  setFlag(flag: RightsFlagName, value: boolean): boolean {
    const text = this.head.text;
    const found = findFlag(text, flag);
    const wanted = String(value);
    if (found) {
      if (text.slice(found.inner.start, found.inner.end).trim() === wanted) {
        return false;
      }
      this.head.text = splice(text, found.inner, wanted);
      return true;
    }
    this.head.text = insertFlag(text, flag, renderFlagLine(flag, value, this.eol), this.eol);
    return true;
  }

  setTemplate(name: string, condition: string): boolean {
    const chunk = this.templates.get(name);
    if (!chunk) {
      const created: NamedChunk = { text: renderTemplateBlock({ name, condition }, this.eol), name };
      (this.closing.templatesBefore ??= []).push(created);
      this.templates.set(name, created);
      return true;
    }
    const inner = findInner(chunk.text, '<condition>', '</condition>', 0, chunk.text.length);
    if (!inner) {
      throw new Error(`У шаблона ограничения ${name} нет элемента <condition>.`);
    }
    if (normalizeCondition(unescapeXml(chunk.text.slice(inner.start, inner.end))) === normalizeCondition(condition)) {
      return false;
    }
    chunk.text = splice(chunk.text, inner, this.escapeMultiline(condition));
    return true;
  }

  removeTemplate(name: string): boolean {
    const chunk = this.templates.get(name);
    if (!chunk) {
      return false;
    }
    chunk.text = '';
    this.templates.delete(name);
    return true;
  }

  render(): string {
    const parts: string[] = [];
    for (const chunk of this.chunks) {
      if (chunk.before) {
        for (const inserted of chunk.before) {
          parts.push(inserted.text);
        }
      }
      if (chunk === this.closing && this.closing.templatesBefore) {
        for (const inserted of this.closing.templatesBefore) {
          parts.push(inserted.text);
        }
      }
      parts.push(chunk.text);
    }
    return parts.join('');
  }

  private registerObject(chunk: NamedChunk): void {
    if (this.objects.has(chunk.name)) {
      const list = this.duplicateObjects.get(chunk.name) ?? [];
      list.push(chunk);
      this.duplicateObjects.set(chunk.name, list);
      return;
    }
    this.objects.set(chunk.name, chunk);
    this.objectOrder.push(chunk.name);
  }

  private insertBefore(anchor: Chunk, chunk: Chunk): void {
    (anchor.before ??= []).push(chunk);
  }

  private escapeMultiline(value: string): string {
    return escapeXmlText(value).replace(/\r?\n/g, this.eol);
  }
}

function splice(text: string, range: TagRange, replacement: string): string {
  return text.slice(0, range.start) + replacement + text.slice(range.end);
}

/**
 * Вставка блока (оканчивается переводом строки) перед строкой закрывающего тега. Тег
 * не в начале строки (однострочная запись) — блок уходит на новую строку.
 */
function insertBeforeTag(text: string, tagStart: number, block: string, eol: string): string {
  const at = lineStartOf(text, tagStart);
  return at === tagStart && at > 0 && text[at - 1] !== '\n'
    ? text.slice(0, at) + eol + block + text.slice(at)
    : text.slice(0, at) + block + text.slice(at);
}

function findInner(text: string, open: string, close: string, from: number, to: number): TagRange | undefined {
  const start = text.indexOf(open, from);
  if (start < 0 || start >= to) {
    return undefined;
  }
  const end = text.indexOf(close, start + open.length);
  return end < 0 || end > to ? undefined : { start: start + open.length, end };
}

function findRight(objectText: string, rightName: string): ParsedRight | undefined {
  return parseRights(objectText).find((right) => right.name === rightName);
}

/** Ленивый разбор прав ОДНОГО объекта; ошибка структуры — исключение (сервис вернёт отказ). */
function parseRights(text: string): ParsedRight[] {
  const result: ParsedRight[] = [];
  let pos = 0;
  for (;;) {
    const open = text.indexOf('<right>', pos);
    if (open < 0) {
      return result;
    }
    const close = text.indexOf('</right>', open);
    const following = text.indexOf('<right>', open + 7);
    if (close < 0 || (following >= 0 && following < close)) {
      throw new Error(`Незакрытый <right> в объекте ${readFirstName(text, 0, text.length)}.`);
    }
    const closeEnd = close + 8;
    const block = { start: lineStartOf(text, open), end: lineEndAfter(text, closeEnd) };
    const valueInner = findInner(text, '<value>', '</value>', open, close);
    result.push({
      name: readFirstName(text, open, close),
      block,
      value: valueInner && { inner: valueInner, lineEnd: lineEndAfter(text, valueInner.end + 8) },
      restriction: parseRestriction(text, open, close),
    });
    pos = closeEnd;
  }
}

function parseRestriction(text: string, from: number, to: number): ParsedRight['restriction'] {
  const open = text.indexOf('<restrictionByCondition>', from);
  if (open < 0 || open > to) {
    return undefined;
  }
  const close = text.indexOf('</restrictionByCondition>', open);
  if (close < 0 || close > to) {
    throw new Error('Незакрытый <restrictionByCondition>.');
  }
  const field = text.indexOf('<field>', open);
  const inner = findInner(text, '<condition>', '</condition>', open, close);
  const empty = text.indexOf('<condition/>', open);
  let condition: { element: TagRange; inner?: TagRange } | undefined;
  if (inner && (empty < 0 || empty > close || inner.start < empty)) {
    condition = { element: { start: inner.start - 11, end: inner.end + 12 }, inner };
  } else if (empty >= 0 && empty < close) {
    condition = { element: { start: empty, end: empty + 12 } };
  }
  return {
    block: { start: lineStartOf(text, open), end: lineEndAfter(text, close + 25) },
    hasField: field >= 0 && field < close,
    closeTagStart: close,
    condition,
  };
}

function readCondition(text: string, right: ParsedRight): string | undefined {
  const condition = right.restriction?.condition;
  if (!right.restriction) {
    return undefined;
  }
  return condition?.inner ? unescapeXml(text.slice(condition.inner.start, condition.inner.end)) : '';
}

/**
 * Новое состояние текста объекта после установки условия или `null`, если менять нечего.
 * Пусто + `<field>` → `<condition/>` (поля — часть ограничения, их не трогаем); пусто без
 * полей → блок ограничения удаляется; непусто → замена внутренности или вставка блока
 * сразу после строки `<value>`.
 */
function applyCondition(text: string, right: ParsedRight, condition: string, eol: string): string | null {
  const restriction = right.restriction;
  const escaped = escapeXmlText(condition).replace(/\r?\n/g, eol);
  if (condition === '') {
    if (!restriction?.condition?.inner) {
      return null;
    }
    return restriction.hasField
      ? splice(text, restriction.condition.element, '<condition/>')
      : splice(text, restriction.block, '');
  }
  if (!restriction) {
    if (!right.value) {
      throw new Error(`У права ${right.name} нет элемента <value>.`);
    }
    const block = renderConditionLines(condition).join(eol) + eol;
    const at = right.value.lineEnd;
    const needsBreak = at === right.value.inner.end + 8;
    return text.slice(0, at) + (needsBreak ? eol : '') + block.replace(/\r?\n/g, eol) + text.slice(at);
  }
  const current = restriction.condition;
  if (current?.inner) {
    const existing = unescapeXml(text.slice(current.inner.start, current.inner.end));
    return normalizeCondition(existing) === normalizeCondition(condition) ? null : splice(text, current.inner, escaped);
  }
  if (current) {
    return splice(text, current.element, `<condition>${escaped}</condition>`);
  }
  return insertBeforeTag(text, restriction.closeTagStart, `\t\t\t\t<condition>${escaped}</condition>${eol}`, eol);
}

function findFlag(head: string, flag: RightsFlagName): { line: TagRange; inner: TagRange } | undefined {
  const inner = findInner(head, `<${flag}>`, `</${flag}>`, 0, head.length);
  if (!inner) {
    return undefined;
  }
  const tagStart = inner.start - flag.length - 2;
  return { line: { start: lineStartOf(head, tagStart), end: lineEndAfter(head, inner.end + flag.length + 3) }, inner };
}

/** Отсутствующий флаг — в каноническом порядке: после предыдущего, иначе перед следующим, иначе после корня. */
function insertFlag(head: string, flag: RightsFlagName, line: string, eol: string): string {
  const index = RIGHTS_FLAG_ORDER.indexOf(flag);
  for (let i = index - 1; i >= 0; i -= 1) {
    const previous = findFlag(head, RIGHTS_FLAG_ORDER[i]);
    if (previous) {
      return insertAtLineBoundary(head, previous.line.end, line, eol);
    }
  }
  for (let i = index + 1; i < RIGHTS_FLAG_ORDER.length; i += 1) {
    const following = findFlag(head, RIGHTS_FLAG_ORDER[i]);
    if (following) {
      return head.slice(0, following.line.start) + line + head.slice(following.line.start);
    }
  }
  // head — начало документа, уже прошедшего parseRightsXmlDocument с корнем <Rights>, поэтому
  // sliceToRootElement здесь не возвращает null; `?? ''` нужен только типу.
  /* c8 ignore next */
  const rootStart = head.length - (sliceToRootElement(head) ?? '').length;
  const rootEnd = head.indexOf('>', rootStart) + 1;
  return insertAtLineBoundary(head, lineEndAfter(head, rootEnd), line, eol);
}

/** Вставка строки в позицию; если позиция не в начале строки — сначала перевод строки. */
function insertAtLineBoundary(text: string, at: number, line: string, eol: string): string {
  const atLineStart = at === 0 || text[at - 1] === '\n';
  return text.slice(0, at) + (atLineStart ? '' : eol) + line + text.slice(at);
}
