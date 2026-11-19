/**
 * Скриптуемый поддельный ПРОЦЕСС хоста PowerShell (Node-скрипт на месте `powershell.exe`),
 * подключаемый через шов `PowerShellRemoteHostOptions.spawn`. Нужен для детерминированной
 * проверки поведения TypeScript-стороны (очередь запросов, шум в stdout, фрагментация,
 * `sessionBroken`, падение процесса, отмена в обход очереди), которое на настоящем
 * `powershell.exe` не воспроизвести точно. Сам протокол хоста и скрипт `powershell.exe`
 * проверяются отдельно — на настоящем PowerShell (powerShellRemoteHost.local.test.ts).
 *
 * Допущение теста: хост PowerShell на сервере — внешняя система; здесь подменяется только
 * ОН, а код `PowerShellRemoteHost`/`PowerShellHostProtocol` — настоящий.
 *
 * Сценарий — JSON в `FAKE_HOST_CONFIG`: `spawns[n]` описывает n-й запущенный процесс (последний
 * повторяется), `ops[op]` — список ответов на последовательные вызовы операции (последний
 * повторяется); ответ — список шагов:
 *   { send: {...} }          строка с маркером; поле `id` проставляется автоматически;
 *   { noise: 'текст' }       строка без маркера;
 *   { stderr: 'текст' }      текст в stderr процесса (как есть, затем перевод строки);
 *   { raw: 'строка' }        произвольная строка как есть;
 *   { split: [..] }          строка с маркером, записанная несколькими кусками с паузами;
 *   { wait: мс }             пауза;
 *   { exit: код }            завершить процесс;
 *   { holdUntilCancel: true } не отвечать, пока не придёт `cancel` на этот запрос (тогда — шаги `onCancel`).
 * `spawns[n].ignoreStdinEnd: true` — процесс НЕ завершается по закрытию stdin (зависший хост: проверка
 * принудительного завершения в dispose).
 * Без сценария: connect/mktemp/put/rmtemp/fetch/ping отвечают `ok`, run — `started` и `exit`.
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { HostSpawn } from '../../../infra/process/remote/PowerShellRemoteHost';

const FAKE_HOST_SCRIPT = `
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_HOST_CONFIG, 'utf8'));
const MARK = '@@V8VSC@@';
const append = (o) => fs.appendFileSync(cfg.logFile, JSON.stringify(Object.assign({ t: Date.now() }, o)) + '\\n');
const previous = fs.existsSync(cfg.logFile) ? fs.readFileSync(cfg.logFile, 'utf8').split('\\n').filter((l) => l.includes('"ev":"start"')).length : 0;
const spawnCfg = (cfg.spawns || [{}])[Math.min(previous, (cfg.spawns || [{}]).length - 1)] || {};
const counters = {};
const pendingHolds = {};
append({ ev: 'start', index: previous, argv: process.argv.slice(2), pid: process.pid });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const write = (text) => process.stdout.write(text);
const sendLine = (id, obj) => write(MARK + JSON.stringify(Object.assign({ id }, obj)) + '\\n');

const defaults = {
  connect: [{ send: { event: 'ok' } }],
  mktemp: [{ send: { event: 'ok', dir: 'C:\\\\Temp\\\\v8vscedit-fake' } }],
  put: [{ send: { event: 'ok' } }],
  rmtemp: [{ send: { event: 'ok' } }],
  fetch: [{ send: { event: 'ok', exists: true } }],
  resolveV8: [{ send: { event: 'ok', path: null } }],
  ping: [{ send: { event: 'ok', pid: process.pid } }],
  run: [{ send: { event: 'started', pid: 4242 } }, { send: { event: 'exit', code: 0, logB64: '' } }],
};

async function play(id, steps, req) {
  for (const step of steps) {
    if (step.split) {
      const text = MARK + JSON.stringify(Object.assign({ id }, step.send || {})) + '\\n';
      const parts = step.split;
      for (let i = 0; i < parts; i += 1) {
        const size = Math.ceil(text.length / parts);
        write(text.slice(i * size, (i + 1) * size));
        await sleep(30);
      }
    } else if (step.send) sendLine(id, step.send);
    else if (step.noise !== undefined) write(step.noise + '\\n');
    else if (step.stderr !== undefined) process.stderr.write(step.stderr + '\\n');
    else if (step.raw !== undefined) write(step.raw + '\\n');
    else if (step.wait) await sleep(step.wait);
    else if (step.exit !== undefined) { append({ ev: 'exit-by-script', code: step.exit }); process.exit(step.exit); }
    else if (step.holdUntilCancel) {
      await new Promise((resolve) => { pendingHolds[id] = resolve; });
      await play(id, step.onCancel || [], req);
    }
  }
}

async function handle(line) {
  let req;
  try { req = JSON.parse(line); } catch (e) { append({ ev: 'bad-json', line }); return; }
  append({ ev: 'recv', req });
  if (req.op === 'cancel') {
    const resume = pendingHolds[req.target];
    if (resume) { delete pendingHolds[req.target]; resume(); }
    return;
  }
  const list = (spawnCfg.ops || {})[req.op] || [defaults[req.op] || [{ send: { event: 'ok' } }]];
  const index = Math.min(counters[req.op] || 0, list.length - 1);
  counters[req.op] = (counters[req.op] || 0) + 1;
  await play(req.id, list[index], req);
  append({ ev: 'replied', op: req.op, id: req.id });
}

let buffer = '';
let chain = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).replace(/\\r$/, '');
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    // Запросы обрабатываются параллельно: очередь — забота клиента, и тест это проверяет по журналу.
    void handle(line);
  }
});
process.stdin.on('end', () => {
  append({ ev: 'stdin-end' });
  if (spawnCfg.ignoreStdinEnd) { setInterval(() => {}, 1000); return; }
  process.exit(0);
});
`;

export interface FakeHostStep {
  send?: Record<string, unknown>;
  noise?: string;
  stderr?: string;
  raw?: string;
  split?: number;
  wait?: number;
  exit?: number;
  holdUntilCancel?: boolean;
  onCancel?: FakeHostStep[];
}

export interface FakeHostSpawnScenario {
  ops?: Record<string, FakeHostStep[][]>;
  ignoreStdinEnd?: boolean;
}

export interface FakeHostLogEntry {
  t: number;
  ev: 'start' | 'recv' | 'replied' | 'stdin-end' | 'bad-json' | 'exit-by-script';
  index?: number;
  argv?: string[];
  pid?: number;
  req?: { id: number; op: string; [key: string]: unknown };
  op?: string;
  id?: number;
}

export class FakeHostRig {
  readonly logFile: string;
  /** Что передано `spawn`: команда и вектор (без скрипта подмены). */
  readonly spawnCalls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  readonly spawn: HostSpawn;
  private readonly scriptPath: string;
  private readonly configPath: string;

  constructor(dir: string, scenario: { spawns?: FakeHostSpawnScenario[] } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    this.scriptPath = path.join(dir, 'fake-host.js');
    this.configPath = path.join(dir, 'fake-host-config.json');
    this.logFile = path.join(dir, 'fake-host-log.jsonl');
    fs.writeFileSync(this.scriptPath, FAKE_HOST_SCRIPT, 'utf-8');
    fs.writeFileSync(this.configPath, JSON.stringify({ ...scenario, logFile: this.logFile }), 'utf-8');
    this.spawn = (command, args, options) => {
      this.spawnCalls.push({ command, args: [...args], env: options.env });
      return childProcess.spawn(process.execPath, [this.scriptPath, ...args], {
        ...options,
        env: { ...options.env, ELECTRON_RUN_AS_NODE: '1', FAKE_HOST_CONFIG: this.configPath },
        windowsHide: true,
      });
    };
  }

  log(): FakeHostLogEntry[] {
    if (!fs.existsSync(this.logFile)) {
      return [];
    }
    return fs.readFileSync(this.logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeHostLogEntry);
  }

  starts(): FakeHostLogEntry[] {
    return this.log().filter((entry) => entry.ev === 'start');
  }

  /** Запросы, полученные процессом с индексом `spawnIndex`, в порядке прихода. */
  received(spawnIndex = 0): { id: number; op: string; [key: string]: unknown }[] {
    const result: { id: number; op: string; [key: string]: unknown }[] = [];
    let current = -1;
    for (const entry of this.log()) {
      if (entry.ev === 'start') {
        current = entry.index ?? current + 1;
      } else if (entry.ev === 'recv' && current === spawnIndex && entry.req) {
        result.push(entry.req);
      }
    }
    return result;
  }
}
