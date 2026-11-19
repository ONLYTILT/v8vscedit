import { StringDecoder } from 'string_decoder';

/**
 * Протокол обмена с host-скриптом PowerShell (чистый модуль, без vscode и процессов).
 *
 * Запрос — одна строка JSON в stdin хоста; ответ — строки stdout с маркером в начале. Всё,
 * что без маркера, — шум PowerShell (предупреждения профиля, вывод модулей) и уходит в журнал,
 * не ломая разбор: маркер отделяет протокол от любого текста, который хост может напечатать сам.
 */

export const HOST_LINE_MARKER = '@@V8VSC@@';

export type HostAuthentication = 'Default' | 'Negotiate' | 'Kerberos';

export type HostRequestBody =
  | {
    op: 'connect';
    computerName: string;
    user: string;
    passwordB64: string;
    authentication: HostAuthentication;
    useSsl: boolean;
    port: number;
  }
  | { op: 'mktemp' }
  | { op: 'put'; dir: string; name: string; contentB64: string }
  | { op: 'resolveV8'; v8Path?: string; v8Version?: string }
  | { op: 'run'; exe: string; commandLine: string; logPath: string }
  /** `target` — id запроса `run`; идёт в обход очереди и ответа не имеет. */
  | { op: 'cancel'; target: number }
  | { op: 'fetch'; remotePath: string; localPath: string }
  | { op: 'rmtemp'; dir: string }
  | { op: 'ping' };

export type HostEvent =
  | { id: number; event: 'ok'; [field: string]: unknown }
  | { id: number; event: 'started'; pid: number }
  | { id: number; event: 'output'; stream: 'stdout' | 'stderr'; textB64: string }
  | { id: number; event: 'exit'; code: number; logB64: string; interrupted?: boolean }
  /** `auth: true` — сервер отклонил учётные данные при `connect`. */
  | { id: number; event: 'error'; message: string; auth?: boolean }
  | { id: number; event: 'sessionBroken'; message: string };

export type HostLine = { kind: 'event'; event: HostEvent } | { kind: 'noise'; text: string };

export class HostProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostProtocolError';
  }
}

/**
 * Одна строка JSON + `\n`, только ASCII: всё вне ASCII экранируется `\uXXXX`. Кодировку stdin
 * хоста задаёт консоль сервера (OEM-кодовая страница), и кириллица в путях могла бы исказиться
 * до того, как скрипт переключит кодировку; ASCII не искажается ни в одной из них. Экранирование
 * заодно убирает U+2028/U+2029, которые некоторые читатели считают переводом строки.
 */
export function encodeHostRequest(id: number, body: HostRequestBody): string {
  const json = JSON.stringify({ id, ...body });
  return `${json.replace(/[^ -~]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
}

const STRING_FIELDS: Record<HostEvent['event'], readonly string[]> = {
  ok: [],
  started: [],
  output: ['textB64'],
  exit: ['logB64'],
  error: ['message'],
  sessionBroken: ['message'],
};

const BOM = String.fromCharCode(0xfeff);

export function parseHostLine(line: string): HostLine {
  const clean = (line.startsWith(BOM) ? line.slice(1) : line).replace(/\r$/, '');
  if (!clean.startsWith(HOST_LINE_MARKER)) {
    return { kind: 'noise', text: line };
  }
  const payload = clean.slice(HOST_LINE_MARKER.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw protocolError('некорректный JSON', clean);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw protocolError('ответ не является объектом', clean);
  }
  const record = parsed as Record<string, unknown>;
  if (!Number.isInteger(record.id)) {
    throw protocolError('нет целого id', clean);
  }
  const event = record.event;
  if (typeof event !== 'string' || !Object.prototype.hasOwnProperty.call(STRING_FIELDS, event)) {
    throw protocolError('неизвестное событие', clean);
  }
  const kind = event as HostEvent['event'];
  for (const field of STRING_FIELDS[kind]) {
    if (typeof record[field] !== 'string') {
      throw protocolError(`нет поля ${field}`, clean);
    }
  }
  if ((kind === 'started' && typeof record.pid !== 'number') || (kind === 'exit' && typeof record.code !== 'number')) {
    throw protocolError('нет числового поля события', clean);
  }
  if (kind === 'output' && record.stream !== 'stdout' && record.stream !== 'stderr') {
    throw protocolError('неизвестный поток вывода', clean);
  }
  return { kind: 'event', event: record as HostEvent };
}

function protocolError(problem: string, line: string): HostProtocolError {
  return new HostProtocolError(`Нарушен протокол хоста PowerShell (${problem}): ${line}`);
}

/**
 * Склейка фрагментов stdout в строки. `StringDecoder` держит неполный многобайтный символ
 * UTF-8 до следующего куска: процесс пишет блоками, и граница может прийтись посреди буквы.
 */
export class HostOutputParser {
  private decoder = new StringDecoder('utf8');
  private buffer = '';

  push(chunk: Buffer | string): HostLine[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const lines: HostLine[] = [];
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        lines.push(parseHostLine(line));
      }
      index = this.buffer.indexOf('\n');
    }
    return lines;
  }

  flush(): HostLine[] {
    const tail = (this.buffer + this.decoder.end()).replace(/\r$/, '');
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    return tail ? [parseHostLine(tail)] : [];
  }
}
