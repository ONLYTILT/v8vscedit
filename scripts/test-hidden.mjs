// Скрытый прогон тестов: окна тестового VS Code не появляются на экране.
// Использование: `npm run test:hidden -- <test|test:fast|coverage:changed>`;
// MOCHA_GREP / COVERAGE_* берутся из окружения.
//
// Сам прогон идёт в задаче планировщика от SYSTEM (регистрируется scripts/hidden-tests/
// register.ps1): у неинтерактивной сессии нет видимого рабочего стола. Этот скрипт оставляет
// запрос с уникальным id, запускает задачу, транслирует лог и возвращает код выхода прогона.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setInterval, clearInterval } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { decideHiddenRunState, HIDDEN_ALLOWED_SCRIPTS } from './hidden-tests/hiddenRunState.mjs';

const TASK_NAME = 'v8vscedit-hidden-tests';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(ROOT, '.v8vscedit', 'hidden-tests');
const REQUEST = path.join(STATE_DIR, 'request.json');
const LOG = path.join(STATE_DIR, 'run.log');
const RESULT = path.join(STATE_DIR, 'result.json');
const LOCK = path.join(STATE_DIR, 'observer.lock');
const ENV_KEYS = ['MOCHA_GREP', 'COVERAGE_SHARDS', 'COVERAGE_BASE', 'COVERAGE_ALLOW_EMPTY', 'COVERAGE_MAX_DEGRADED', 'VSCODE_TEST_VERSION', 'COVERAGE_TESTS'];
const START_GRACE_MS = 15000;
const STATE_POLL_MS = 5000;

if (process.platform !== 'win32') {
  console.error('[test:hidden] Только для Windows; на Linux/macOS используйте xvfb-run или обычный npm test.');
  process.exit(2);
}

const script = process.argv[2] ?? 'test:fast';
if (!HIDDEN_ALLOWED_SCRIPTS.includes(script)) {
  console.error(`[test:hidden] Скрипт '${script}' не поддержан. Допустимо: ${HIDDEN_ALLOWED_SCRIPTS.join(', ')}`);
  process.exit(2);
}

/** Состояние задачи — через enum Get-ScheduledTask: вывод schtasks локализован и в OEM-кодировке. */
function taskState() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue).State`], { encoding: 'utf-8' });
  const value = (r.stdout ?? '').trim();
  return value || undefined;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Lock старше предельного времени задачи (ExecutionTimeLimit = 3 ч) считается брошенным,
 *  даже если его PID переиспользован другим процессом. */
const LOCK_MAX_AGE_MS = 3 * 3600 * 1000;
/** Свежесозданный lock может быть ещё пуст (между open и write) — его не трогаем. */
const LOCK_FRESH_MS = 60 * 1000;

/** Решение о существующем lock: true — он чей-то живой, трогать нельзя. */
function lockIsHeld() {
  let ageMs;
  let owner;
  try {
    ageMs = Date.now() - statSync(LOCK).mtimeMs;
    owner = Number(readFileSync(LOCK, 'utf-8').trim());
  } catch {
    return false; // lock исчез между попытками — можно пробовать занять
  }
  if (ageMs > LOCK_MAX_AGE_MS) {
    return false;
  }
  if (!Number.isInteger(owner) || owner <= 0) {
    return ageMs < LOCK_FRESH_MS;
  }
  return isAlive(owner);
}

/** Эксклюзивный lock наблюдателя: два прогона не должны перезаписать запрос друг друга.
 *  Брошенный lock удаляется один раз, повторная попытка — только через атомарный 'wx'. */
function acquireLock() {
  const tryCreate = () => {
    try {
      const fd = openSync(LOCK, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };
  if (tryCreate()) {
    return true;
  }
  if (lockIsHeld()) {
    return false;
  }
  rmSync(LOCK, { force: true });
  return tryCreate();
}

/** Копия исполнителя в ProgramData молча отстаёт от репозитория после правки runner.ps1. */
function warnIfRunnerStale() {
  try {
    // Без учёта CR: git с autocrlf переводит рабочую копию в CRLF, а это не делает копию устаревшей.
    const hash = (file) => createHash('sha256').update(readFileSync(file, 'utf-8').replace(/\r/g, '')).digest('hex');
    const installed = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'v8vscedit', 'runner.ps1');
    if (hash(installed) !== hash(path.join(ROOT, 'scripts', 'hidden-tests', 'runner.ps1'))) {
      console.error('[test:hidden] ВНИМАНИЕ: копия исполнителя в ProgramData отличается от scripts/hidden-tests/runner.ps1 — перерегистрируйте register.ps1 (от администратора).');
    }
  } catch {
    // нет копии — задача не зарегистрирована; об этом скажет schtasks /Run ниже
  }
}

mkdirSync(STATE_DIR, { recursive: true });
if (!acquireLock()) {
  console.error(`[test:hidden] Идёт другой скрытый прогон (${LOCK}). Дождитесь его завершения или удалите файл, если прогона точно нет.`);
  process.exit(2);
}
warnIfRunnerStale();
const releaseLock = () => rmSync(LOCK, { force: true });
const finish = (code) => {
  releaseLock();
  process.exit(code);
};
if (taskState() === 'Running') {
  console.error(`[test:hidden] Задача уже выполняется. Остановить: schtasks /End /TN ${TASK_NAME}`);
  finish(2);
}

const id = randomUUID();
const env = Object.fromEntries(ENV_KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
rmSync(RESULT, { force: true });
rmSync(LOG, { force: true });
writeFileSync(REQUEST, JSON.stringify({ id, script, env }, null, 2), 'utf-8');

const run = spawnSync('schtasks', ['/Run', '/TN', TASK_NAME], { encoding: 'utf-8' });
if (run.status !== 0) {
  rmSync(REQUEST, { force: true });
  console.error(`[test:hidden] Не удалось запустить задачу '${TASK_NAME}' (код ${String(run.status)}).`);
  console.error('Зарегистрируйте её из PowerShell от имени администратора:');
  console.error('  powershell -ExecutionPolicy Bypass -File scripts\\hidden-tests\\register.ps1');
  finish(2);
}

// Ctrl+C гасит не только наблюдателя, но и прогон: иначе он продолжился бы от SYSTEM, а
// следующий запуск получил бы отказ «уже выполняется».
process.on('SIGINT', () => {
  spawnSync('schtasks', ['/End', '/TN', TASK_NAME]);
  console.error('\n[test:hidden] Прогон остановлен (schtasks /End).');
  finish(130);
});

// Трансляция растущего лога; StringDecoder не рвёт многобайтные символы на границе чанка.
const decoder = new StringDecoder('utf8');
let offset = 0;
let first = true;
const pump = () => {
  if (!existsSync(LOG)) {
    return;
  }
  const size = statSync(LOG).size;
  if (size <= offset) {
    return;
  }
  const fd = openSync(LOG, 'r');
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  offset = size;
  let text = decoder.write(buf);
  if (first) {
    text = text.replace(/^\uFEFF/, '');
    first = false;
  }
  process.stdout.write(text);
};

const readResult = () => {
  if (!existsSync(RESULT)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(RESULT, 'utf-8'));
  } catch {
    return undefined; // файл мог читаться в момент записи — повторим на следующем тике
  }
};

const startedAt = Date.now();
let lastStatePoll = 0;
let lastState;
// Подряд идущие опросы ПОСЛЕ окна старта, где задача не активна; один сбой опроса — не отказ.
let notRunningPolls = 0;
const timer = setInterval(() => {
  pump();
  const now = Date.now();
  const result = readResult();
  if (result === undefined && now - lastStatePoll >= STATE_POLL_MS) {
    lastStatePoll = now;
    lastState = taskState();
    const active = lastState === 'Running' || lastState === 'Queued';
    notRunningPolls = !active && now - startedAt >= START_GRACE_MS ? notRunningPolls + 1 : 0;
  }
  const decision = decideHiddenRunState({
    taskState: lastState,
    result,
    expectedId: id,
    elapsedMs: now - startedAt,
    startGraceMs: START_GRACE_MS,
    notRunningPolls,
  });
  if (decision.action === 'wait') {
    return;
  }
  clearInterval(timer);
  pump();
  process.stdout.write(decoder.end());
  if (decision.action === 'fail') {
    console.error(`[test:hidden] ${decision.reason}`);
    if (taskState() === 'Running') {
      console.error(`[test:hidden] Задача всё ещё выполняется; остановить: schtasks /End /TN ${TASK_NAME}`);
    }
  }
  finish(decision.exitCode);
}, 500);
