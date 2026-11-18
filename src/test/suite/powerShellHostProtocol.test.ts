/**
 * Э9: протокол хоста PowerShell (infra/process/remote/PowerShellHostProtocol.ts, чистый модуль без vscode)
 * и доставка host-скрипта (infra/process/remote/PowerShellHostScript.ts).
 *
 * Контракт PowerShellHostProtocol.ts:
 *   export const HOST_LINE_MARKER = '@@V8VSC@@';
 *   export type HostAuthentication = 'Default' | 'Negotiate' | 'Kerberos';
 *   export type HostRequestBody =
 *     | { op: 'connect'; computerName: string; user: string; passwordB64: string;
 *         authentication: HostAuthentication; useSsl: boolean; port: number }
 *     | { op: 'mktemp' }
 *     | { op: 'put'; dir: string; name: string; contentB64: string }
 *     | { op: 'resolveV8'; v8Path?: string; v8Version?: string }
 *     | { op: 'run'; exe: string; commandLine: string; logPath: string }
 *     | { op: 'cancel'; target: number }              // target — id запроса `run`; идёт в обход очереди
 *     | { op: 'fetch'; remotePath: string; localPath: string }
 *     | { op: 'rmtemp'; dir: string }
 *     | { op: 'ping' };
 *   encodeHostRequest(id: number, body: HostRequestBody): string
 *       // ОДНА строка JSON `{"id":…,"op":…,…}` + '\n'; только ASCII (всё, что вне ASCII, — \uXXXX), чтобы
 *       // кодировка stdin PowerShell не могла исказить кириллицу в путях и именах; пароль — только в `connect`.
 *   export type HostEvent =
 *     | { id: number; event: 'ok'; [field: string]: unknown }            // результат операции: mktemp → dir, resolveV8 → path (строка | null),
 *                                                                          // fetch → exists (boolean), ping → pid
 *     | { id: number; event: 'started'; pid: number }
 *     | { id: number; event: 'output'; stream: 'stdout' | 'stderr'; textB64: string }   // одна строка вывода процесса
 *     | { id: number; event: 'exit'; code: number; logB64: string; interrupted?: boolean }
 *     | { id: number; event: 'error'; message: string }
 *     | { id: number; event: 'sessionBroken'; message: string };
 *   export type HostLine = { kind: 'event'; event: HostEvent } | { kind: 'noise'; text: string };
 *   parseHostLine(line: string): HostLine       // строка с маркером В НАЧАЛЕ (допустим BOM перед ним) → event, иначе noise;
 *                                               // битый JSON/не объект/нет id/неизвестный event/нет обязательных полей → HostProtocolError
 *   class HostProtocolError extends Error
 *   class HostOutputParser { push(chunk: Buffer | string): HostLine[]; flush(): HostLine[] }
 *       // склейка фрагментов stdout по '\n' (CRLF допустим), пустые строки отбрасываются, многобайтный UTF-8
 *       // на границе Buffer-кусков не портится (StringDecoder), flush отдаёт хвост без перевода строки.
 *
 * Контракт PowerShellHostScript.ts:
 *   export const POWERSHELL_HOST_SCRIPT: string
 *   export function buildPowerShellHostArgs(script?: string): string[]
 *       // ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand', <base64 UTF-16LE скрипта>]
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import {
  HOST_LINE_MARKER,
  HostOutputParser,
  HostProtocolError,
  encodeHostRequest,
  parseHostLine,
  type HostRequestBody,
} from '../../infra/process/remote/PowerShellHostProtocol';
import { POWERSHELL_HOST_SCRIPT, buildPowerShellHostArgs } from '../../infra/process/remote/PowerShellHostScript';
import { windowsPowerShellAvailable } from './support/powerShellTestEnv';

const REQUESTS: readonly { title: string; body: HostRequestBody }[] = [
  {
    title: 'connect',
    body: { op: 'connect', computerName: 'srv-1c.corp', user: 'CORP\\админ', passwordB64: 'cGFzcw==', authentication: 'Kerberos', useSsl: true, port: 5986 },
  },
  { title: 'mktemp', body: { op: 'mktemp' } },
  { title: 'put', body: { op: 'put', dir: 'C:\\Users\\Иван\\AppData\\Local\\Temp\\v8vscedit-1', name: 'объекты.xml', contentB64: 'PD94bWw=' } },
  { title: 'resolveV8 по пути', body: { op: 'resolveV8', v8Path: 'C:\\Program Files\\1cv8\\8.3.27.2130\\bin\\1cv8.exe' } },
  { title: 'resolveV8 по версии', body: { op: 'resolveV8', v8Version: '8.3.27.2130' } },
  { title: 'run', body: { op: 'run', exe: 'C:\\1c\\1cv8.exe', commandLine: 'DESIGNER /F "C:\\Тест База" /P"пароль"', logPath: 'C:\\Temp\\v8vscedit-1\\out.log' } },
  { title: 'cancel', body: { op: 'cancel', target: 7 } },
  { title: 'fetch', body: { op: 'fetch', remotePath: 'C:\\Temp\\v8vscedit-1\\dump.cf', localPath: 'C:\\Users\\me\\tmp\\v8batch-out-1\\dump.cf' } },
  { title: 'rmtemp', body: { op: 'rmtemp', dir: 'C:\\Temp\\v8vscedit-1' } },
  { title: 'ping', body: { op: 'ping' } },
];

suite('Э9: PowerShellHostProtocol — кодирование запросов', () => {
  for (const row of REQUESTS) {
    test(`${row.title}: одна строка, оканчивается переводом строки, JSON возвращает id и тело без потерь`, () => {
      const line = encodeHostRequest(12, row.body);
      assert.ok(line.endsWith('\n'));
      assert.strictEqual(line.indexOf('\n'), line.length - 1, 'внутри запроса не должно быть переводов строки');
      assert.deepStrictEqual(JSON.parse(line.trimEnd()), { id: 12, ...row.body });
    });

    test(`${row.title}: только ASCII — кодировка stdin PowerShell не может исказить пути и имена`, () => {
      const line = encodeHostRequest(1, row.body);
      // eslint-disable-next-line no-control-regex
      assert.ok(/^[\x00-\x7f]*$/.test(line), `не-ASCII в строке запроса: ${line}`);
    });
  }

  test('суррогатные пары, разделители строк U+2028/2029 и управляющие символы переживают кодирование', () => {
    const name = 'файл 😀\u2028\u2029\t"\\.txt';
    const line = encodeHostRequest(3, { op: 'put', dir: 'C:\\d', name, contentB64: '' });
    assert.strictEqual(line.indexOf('\n'), line.length - 1);
    assert.strictEqual((JSON.parse(line.trimEnd()) as { name: string }).name, name);
  });

  test('id — число запроса: разные id дают разные строки', () => {
    assert.notStrictEqual(encodeHostRequest(1, { op: 'ping' }), encodeHostRequest(2, { op: 'ping' }));
  });

  test('пароль присутствует только в connect: остальные запросы его поля не содержат', () => {
    for (const row of REQUESTS.filter((item) => item.body.op !== 'connect')) {
      assert.ok(!/password/i.test(encodeHostRequest(1, row.body)), row.title);
    }
  });
});

suite('Э9: PowerShellHostProtocol — разбор строк ответа', () => {
  test('маркер — константа @@V8VSC@@', () => {
    assert.strictEqual(HOST_LINE_MARKER, '@@V8VSC@@');
  });

  test('строка с маркером → событие с телом из JSON', () => {
    const line = parseHostLine(`${HOST_LINE_MARKER}{"id":3,"event":"ok","dir":"C:\\\\Temp\\\\v8vscedit-1"}`);
    assert.deepStrictEqual(line, { kind: 'event', event: { id: 3, event: 'ok', dir: 'C:\\Temp\\v8vscedit-1' } });
  });

  test('хвостовой \\r (CRLF) и ведущий BOM не мешают', () => {
    const line = parseHostLine(`\uFEFF${HOST_LINE_MARKER}{"id":1,"event":"ok"}\r`);
    assert.deepStrictEqual(line, { kind: 'event', event: { id: 1, event: 'ok' } });
  });

  test('строка без маркера — шум (уходит в лог), включая похожий текст и маркер не в начале', () => {
    for (const text of ['Предупреждение: что-то', 'WARNING: x', `prefix ${HOST_LINE_MARKER}{"id":1,"event":"ok"}`, '{"id":1,"event":"ok"}']) {
      assert.deepStrictEqual(parseHostLine(text), { kind: 'noise', text });
    }
  });

  test('пустая строка — шум с пустым текстом', () => {
    assert.deepStrictEqual(parseHostLine(''), { kind: 'noise', text: '' });
  });

  const VALID_EVENTS: readonly { title: string; json: string }[] = [
    { title: 'started', json: '{"id":4,"event":"started","pid":1234}' },
    { title: 'output', json: '{"id":4,"event":"output","stream":"stdout","textB64":"cmVhZHk="}' },
    { title: 'exit', json: '{"id":4,"event":"exit","code":0,"logB64":"AAEC"}' },
    { title: 'exit с interrupted', json: '{"id":4,"event":"exit","code":-1,"logB64":"","interrupted":true}' },
    { title: 'error', json: '{"id":4,"event":"error","message":"Не удалось"}' },
    { title: 'error с признаком отказа аутентификации', json: '{"id":4,"event":"error","message":"Отказано в доступе","auth":true}' },
    { title: 'sessionBroken', json: '{"id":4,"event":"sessionBroken","message":"сеанс закрыт"}' },
    { title: 'ok без полей', json: '{"id":4,"event":"ok"}' },
  ];
  for (const row of VALID_EVENTS) {
    test(`допустимое событие ${row.title} принимается`, () => {
      const parsed = parseHostLine(HOST_LINE_MARKER + row.json);
      assert.ok(parsed.kind === 'event', 'ожидалось событие');
      assert.deepStrictEqual(parsed.event, JSON.parse(row.json));
    });
  }

  const INVALID: readonly { title: string; line: string }[] = [
    { title: 'битый JSON', line: `${HOST_LINE_MARKER}{"id":1,` },
    { title: 'пусто после маркера', line: HOST_LINE_MARKER },
    { title: 'не объект (массив)', line: `${HOST_LINE_MARKER}[1,2]` },
    { title: 'не объект (число)', line: `${HOST_LINE_MARKER}5` },
    { title: 'null', line: `${HOST_LINE_MARKER}null` },
    { title: 'нет id', line: `${HOST_LINE_MARKER}{"event":"ok"}` },
    { title: 'id не число', line: `${HOST_LINE_MARKER}{"id":"1","event":"ok"}` },
    { title: 'id не целое', line: `${HOST_LINE_MARKER}{"id":1.5,"event":"ok"}` },
    { title: 'нет event', line: `${HOST_LINE_MARKER}{"id":1}` },
    { title: 'неизвестный event', line: `${HOST_LINE_MARKER}{"id":1,"event":"boom"}` },
    { title: 'started без pid', line: `${HOST_LINE_MARKER}{"id":1,"event":"started"}` },
    { title: 'exit без кода', line: `${HOST_LINE_MARKER}{"id":1,"event":"exit","logB64":""}` },
    { title: 'exit без лога', line: `${HOST_LINE_MARKER}{"id":1,"event":"exit","code":0}` },
    { title: 'error без message', line: `${HOST_LINE_MARKER}{"id":1,"event":"error"}` },
    { title: 'sessionBroken без message', line: `${HOST_LINE_MARKER}{"id":1,"event":"sessionBroken"}` },
    { title: 'output без textB64', line: `${HOST_LINE_MARKER}{"id":1,"event":"output","stream":"stdout"}` },
    { title: 'output с неизвестным потоком', line: `${HOST_LINE_MARKER}{"id":1,"event":"output","stream":"stdin","textB64":""}` },
  ];
  for (const row of INVALID) {
    test(`некорректная строка (${row.title}) → HostProtocolError`, () => {
      assert.throws(() => parseHostLine(row.line), (error: unknown) => error instanceof HostProtocolError && error instanceof Error);
    });
  }

  test('сообщение HostProtocolError на русском и называет проблемную строку', () => {
    try {
      parseHostLine(`${HOST_LINE_MARKER}{"id":1,`);
      assert.fail('ожидалось исключение');
    } catch (error) {
      assert.ok(error instanceof HostProtocolError);
      assert.match(error.message, /[А-Яа-яЁё]/);
      assert.ok(error.message.includes('{"id":1,'), error.message);
    }
  });
});

suite('Э9: PowerShellHostProtocol — склейка фрагментов stdout (HostOutputParser)', () => {
  const ok = (id: number): string => `${HOST_LINE_MARKER}{"id":${String(id)},"event":"ok"}`;

  test('целая строка в одном куске', () => {
    const parser = new HostOutputParser();
    assert.deepStrictEqual(parser.push(`${ok(1)}\n`), [{ kind: 'event', event: { id: 1, event: 'ok' } }]);
  });

  test('строка, разорванная на фрагменты (в том числе посреди JSON и маркера), собирается', () => {
    const parser = new HostOutputParser();
    const whole = `${ok(2)}\n`;
    const lines = [];
    for (const piece of [whole.slice(0, 3), whole.slice(3, 20), whole.slice(20)]) {
      lines.push(...parser.push(piece));
    }
    assert.deepStrictEqual(lines, [{ kind: 'event', event: { id: 2, event: 'ok' } }]);
  });

  test('несколько строк в одном куске, шум между событиями сохраняется порядком', () => {
    const parser = new HostOutputParser();
    const lines = parser.push(`шум до\n${ok(1)}\nещё шум\n${ok(2)}\n`);
    assert.deepStrictEqual(lines.map((line) => (line.kind === 'event' ? line.event.id : line.text)), ['шум до', 1, 'ещё шум', 2]);
  });

  test('CRLF-переводы строк и пустые строки: пустые отбрасываются', () => {
    const parser = new HostOutputParser();
    const lines = parser.push(`${ok(1)}\r\n\r\n\nтекст\r\n`);
    assert.deepStrictEqual(lines.map((line) => line.kind), ['event', 'noise']);
  });

  test('многобайтный UTF-8 на границе Buffer-кусков не портится', () => {
    const parser = new HostOutputParser();
    const bytes = Buffer.from('Предупреждение: кириллица 😀\n', 'utf-8');
    const lines = [];
    for (let index = 0; index < bytes.length; index += 1) {
      lines.push(...parser.push(bytes.subarray(index, index + 1)));
    }
    assert.deepStrictEqual(lines, [{ kind: 'noise', text: 'Предупреждение: кириллица 😀' }]);
  });

  test('flush отдаёт хвост без перевода строки; после flush разбор начинается заново', () => {
    const parser = new HostOutputParser();
    assert.deepStrictEqual(parser.push('хвост без конца'), []);
    assert.deepStrictEqual(parser.flush(), [{ kind: 'noise', text: 'хвост без конца' }]);
    assert.deepStrictEqual(parser.flush(), []);
    assert.deepStrictEqual(parser.push(`${ok(5)}\n`).length, 1);
  });

  test('flush пустого парсера — пусто', () => {
    assert.deepStrictEqual(new HostOutputParser().flush(), []);
  });

  test('некорректная строка с маркером бросает HostProtocolError из push', () => {
    const parser = new HostOutputParser();
    assert.throws(() => parser.push(`${HOST_LINE_MARKER}{oops\n`), HostProtocolError);
  });
});

suite('Э9: PowerShellHostScript — доставка host-скрипта', () => {
  const ARGS_PREFIX = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];

  test('вектор запуска: без профиля и интерактива, политика Bypass, скрипт — в -EncodedCommand', () => {
    const args = buildPowerShellHostArgs();
    assert.deepStrictEqual(args.slice(0, -1), ARGS_PREFIX);
    assert.strictEqual(args.length, ARGS_PREFIX.length + 1);
  });

  test('-EncodedCommand — base64 от UTF-16LE текста скрипта', () => {
    const encoded = buildPowerShellHostArgs().at(-1) ?? '';
    assert.strictEqual(Buffer.from(encoded, 'base64').toString('utf16le'), POWERSHELL_HOST_SCRIPT);
    assert.match(encoded, /^[A-Za-z0-9+/]+=*$/);
  });

  test('произвольный скрипт кодируется тем же способом', () => {
    const encoded = buildPowerShellHostArgs('Write-Output "Привет"').at(-1) ?? '';
    assert.strictEqual(Buffer.from(encoded, 'base64').toString('utf16le'), 'Write-Output "Привет"');
  });

  test('длина -EncodedCommand меньше 30 000 символов (предел командной строки Windows — 32 767)', () => {
    const encoded = buildPowerShellHostArgs().at(-1) ?? '';
    assert.ok(encoded.length < 30_000, `слишком длинный скрипт: ${String(encoded.length)}`);
  });

  test('скрипт: UTF-8 без BOM на вводе и выводе, без прогресс-вывода, маркер протокола', () => {
    assert.match(POWERSHELL_HOST_SCRIPT, /InputEncoding/);
    assert.match(POWERSHELL_HOST_SCRIPT, /OutputEncoding/);
    assert.match(POWERSHELL_HOST_SCRIPT, /UTF8Encoding/);
    assert.match(POWERSHELL_HOST_SCRIPT, /\$ProgressPreference\s*=\s*['"]SilentlyContinue['"]/);
    assert.ok(POWERSHELL_HOST_SCRIPT.includes(HOST_LINE_MARKER));
  });

  test('скрипт: PSSession с IdleTimeout (Н61), удалённая сессия с ErrorActionPreference=Stop (Н64), признак отказа аутентификации', () => {
    assert.match(POWERSHELL_HOST_SCRIPT, /New-PSSessionOption\s+-IdleTimeout\s+\d+/);
    assert.match(POWERSHELL_HOST_SCRIPT, /\$global:ErrorActionPreference\s*=\s*'Stop'/);
    assert.match(POWERSHELL_HOST_SCRIPT, /auth\s*=/);
  });

  test('скрипт не содержит ни паролей, ни учётных данных (они приходят только запросом connect по stdin)', () => {
    assert.ok(!/ConvertTo-SecureString\s+['"][^'"]+['"]\s+-AsPlainText/.test(POWERSHELL_HOST_SCRIPT), 'открытый пароль в тексте скрипта');
  });

  test('скрипт синтаксически корректен (парсер PowerShell: ноль ошибок)', function () {
    if (!windowsPowerShellAvailable()) {
      this.skip();
    }
    const probe = [
      '[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)',
      '$src = [Console]::In.ReadToEnd()',
      '$errors = $null; $tokens = $null',
      '[void][System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$tokens, [ref]$errors)',
      'if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 3 }',
      'exit 0',
    ].join('; ');
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', probe], {
      input: POWERSHELL_HOST_SCRIPT,
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 60_000,
    });
    assert.strictEqual(result.status, 0, `ошибки разбора скрипта: ${result.stderr}`);
  });
});
