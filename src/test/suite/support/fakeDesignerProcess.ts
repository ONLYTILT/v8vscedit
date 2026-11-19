/**
 * Поддельный «1cv8» для тестов пакетных исполнителей (локального и удалённого).
 *
 * Платформа 1С — внешняя недоступная система, подменяется только она. Это НЕ `.cmd`/`.bat`
 * для локального исполнителя: Node ≥ 18.20 отказывает `spawn(*.cmd, { shell: false })` (EINVAL),
 * а исполнитель обязан запускать процесс без оболочки (пароль в аргументе не должен проходить
 * через разбор cmd). Поэтому «1cv8» — сам исполняемый файл тест-хоста в режиме Node
 * (`ELECTRON_RUN_AS_NODE=1`), а роль скрипта играет файл, ПУТЬ К КОТОРОМУ — первый аргумент
 * вектора (`args[0]` запроса исполнителю). Скрипт получает остальные аргументы ровно так,
 * как их получил бы 1cv8 (проходит реальный разбор командной строки Windows), пишет их в
 * файл-запись, копирует входные файлы, создаёт `/Out`-лог в заданной кодировке и выходные
 * файлы, выходит с заданным кодом или «зависает» до отмены. Поведение задаёт JSON из
 * `FAKE_1C_CONFIG`; переменные окружения наследуют и дочерние процессы (в том числе
 * `powershell.exe` удалённого хоста), поэтому поддельный 1cv8 одинаково виден обоим исполнителям.
 */
import * as fs from 'fs';
import * as path from 'path';

const FAKE_SCRIPT = `
const fs = require('fs');
const cp = require('child_process');
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_1C_CONFIG, 'utf8'));
const argv = process.argv.slice(2);
const valueAfter = (key) => { const i = argv.indexOf(key); return i < 0 ? undefined : argv[i + 1]; };
const record = { argv, inputs: {}, pid: process.pid };
for (const item of cfg.copyInputAfter || []) {
  const p = valueAfter(item.key);
  const existed = p !== undefined && fs.existsSync(p);
  record.inputs[item.key] = { path: p, existed };
  if (existed) fs.writeFileSync(item.dest, fs.readFileSync(p));
}
if (cfg.spawnChild) {
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: process.env });
  child.unref(); record.childPid = child.pid;
}
const out = valueAfter('/Out');
if (out !== undefined && cfg.logBase64 !== undefined) fs.writeFileSync(out, Buffer.from(cfg.logBase64, 'base64'));
for (const item of cfg.outputsAfter || []) {
  fs.writeFileSync(valueAfter(item.key), Buffer.from(item.contentBase64, 'base64'));
}
fs.writeFileSync(cfg.recordFile, JSON.stringify(record));
if (cfg.stdout) console.log(cfg.stdout);
if (cfg.stderr) console.error(cfg.stderr);
if (cfg.hang) { console.log('ready'); setInterval(() => {}, 1000); } else { process.exitCode = cfg.exitCode || 0; }
`;

export interface FakeDesignerConfig {
  exitCode?: number;
  logBase64?: string;
  stdout?: string;
  stderr?: string;
  hang?: boolean;
  /** Породить дочерний процесс (внук для процесса хоста), pid — в записи: проверка убийства дерева. */
  spawnChild?: boolean;
  copyInputAfter?: { key: string; dest: string }[];
  outputsAfter?: { key: string; contentBase64: string }[];
}

export interface FakeDesignerRecord {
  argv: string[];
  inputs: Record<string, { path: string | undefined; existed: boolean }>;
  pid: number;
  childPid?: number;
}

export class FakeDesigner {
  /** Путь к скрипту: ПЕРВЫЙ элемент вектора запроса (исполняемый файл — `process.execPath`). */
  readonly scriptPath: string;
  readonly recordFile: string;
  private readonly configPath: string;
  private readonly savedElectronMode: string | undefined;
  private readonly savedConfigEnv: string | undefined;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.scriptPath = path.join(dir, 'fake-1cv8.js');
    this.recordFile = path.join(dir, 'record.json');
    this.configPath = path.join(dir, 'config.json');
    fs.writeFileSync(this.scriptPath, FAKE_SCRIPT, 'utf-8');
    this.savedElectronMode = process.env.ELECTRON_RUN_AS_NODE;
    this.savedConfigEnv = process.env.FAKE_1C_CONFIG;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    process.env.FAKE_1C_CONFIG = this.configPath;
  }

  /** Задаёт поведение СЛЕДУЮЩЕГО запуска и стирает запись предыдущего. */
  configure(config: FakeDesignerConfig): void {
    fs.rmSync(this.recordFile, { force: true });
    fs.writeFileSync(this.configPath, JSON.stringify({ ...config, recordFile: this.recordFile }), 'utf-8');
  }

  hasRecord(): boolean {
    return fs.existsSync(this.recordFile);
  }

  readRecord(): FakeDesignerRecord {
    return JSON.parse(fs.readFileSync(this.recordFile, 'utf-8')) as FakeDesignerRecord;
  }

  /** Окружение для процессов, которые тест запускает сам (хост PowerShell наследует process.env). */
  restoreEnv(): void {
    restoreEnvVar('ELECTRON_RUN_AS_NODE', this.savedElectronMode);
    restoreEnvVar('FAKE_1C_CONFIG', this.savedConfigEnv);
  }
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = value;
  }
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Живой ли процесс (без отправки сигнала): ESRCH — мёртв. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`не дождались: ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Убирает процесс, оставшийся от упавшего теста: иначе «зависший» поддельный 1cv8 переживёт прогон. */
export function killQuietly(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(pid);
  } catch {
    // уже завершён
  }
}
