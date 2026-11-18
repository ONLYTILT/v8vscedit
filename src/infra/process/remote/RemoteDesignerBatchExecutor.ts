import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { decodeDesignerLogBytes } from '../OutputDecoder';
import { describeProcessInterruption } from '../ProcessRunner';
import { maskSensitiveCliArgs } from '../SensitiveArgs';
import { buildWindowsCommandLine } from '../WindowsCommandLine';
import {
  DESIGNER_LOG_FILE_NAME,
  validateDesignerFileNames,
  type DesignerArg,
  type DesignerBatchExecutor,
  type DesignerBatchRequest,
  type DesignerBatchResult,
} from '../designer/DesignerBatchExecutor';
import { PowerShellHostError, describeHostError, type HostRunRequest, type HostRunResult } from './PowerShellRemoteHost';

/** Подмножество `PowerShellRemoteHost`, нужное исполнителю (шов под тест). */
export interface RemoteDesignerHost {
  mktemp(): Promise<string>;
  put(dir: string, name: string, content: Uint8Array | string): Promise<void>;
  run(request: HostRunRequest): Promise<HostRunResult>;
  fetch(remotePath: string, localPath: string): Promise<boolean>;
  rmtemp(dir: string): Promise<void>;
}

export interface RemoteDesignerBatchExecutorOptions {
  /** ЛОКАЛЬНЫЙ корень staging выходных файлов; по умолчанию — временный каталог ОС. */
  readonly tempRoot?: string;
  /** Диагностика (сбой уборки сервера и т.п.); секретов не содержит. */
  readonly log?: (line: string) => void;
}

/**
 * Исполнитель пакетного Конфигуратора на удалённом сервере через хост PowerShell.
 *
 * Тот же запрос, что у локального исполнителя: файлы объявлены именами, и исполнитель сам
 * решает, где они живут — здесь в `<TEMP сервера>\v8vscedit-*`. Командная строка собирается
 * тем же алгоритмом libuv, каким Node квотирует локальный `spawn`, поэтому 1cv8 на сервере
 * получает байт-в-байт тот же вектор. Выходные файлы забираются в ЛОКАЛЬНЫЙ staging: перенос
 * на путь пользователя по-прежнему делает вызывающий и только при успехе.
 *
 * Хост общий (им владеет реестр исполнителей), поэтому `dispose` убирает только staging.
 */
export class RemoteDesignerBatchExecutor implements DesignerBatchExecutor {
  private readonly stagingDirs = new Set<string>();

  constructor(
    private readonly host: RemoteDesignerHost,
    private readonly exePath: string,
    private readonly options: RemoteDesignerBatchExecutorOptions = {}
  ) {}

  async run(request: DesignerBatchRequest): Promise<DesignerBatchResult> {
    validateDesignerFileNames(request.args);
    try {
      return await this.runOnServer(request);
    } catch (error) {
      // Хост мог процитировать командную строку (с паролями) в тексте ошибки.
      // `cause` намеренно не прикладывается: исходная ошибка несёт немаскированный текст с паролем,
      // и любой журнал, печатающий цепочку причин, раскрыл бы его. Код ошибки хоста сохраняется.
      const masked = maskSecrets(describeHostError(error), request.secrets);
      throw error instanceof PowerShellHostError ? new PowerShellHostError(masked, error.code) : new Error(masked);
    }
  }

  dispose(): Promise<void> {
    for (const dir of this.stagingDirs) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
    this.stagingDirs.clear();
    return Promise.resolve();
  }

  private async runOnServer(request: DesignerBatchRequest): Promise<DesignerBatchResult> {
    if (request.cancellation?.isCancellationRequested) {
      // Как у локального исполнителя: отменённый запрос не трогает ни сервер, ни диск.
      return { exitCode: -1, interrupted: interruptedText(), log: '', outputs: new Map() };
    }
    const dir = await this.host.mktemp();
    let staging: string | undefined;
    // Флаг вместо catch с повторным throw: у V8 хвост catch после throw — отдельный, заведомо
    // неисполнимый блок покрытия, а уборка staging при ошибке в finally выражает то же самое.
    let completed = false;
    try {
      const outputNames: string[] = [];
      const args: string[] = [];
      for (const arg of request.args) {
        args.push(await this.materialize(arg, dir, outputNames));
      }
      const logPath = serverPath(dir, DESIGNER_LOG_FILE_NAME);
      args.push('/Out', logPath, '/DisableStartupDialogs');

      const result = await this.host.run({
        exe: this.exePath,
        commandLine: buildWindowsCommandLine(args),
        logPath,
        cancellation: request.cancellation,
        onOutput: (line) => request.onOutput?.(line),
      });

      const outputs = new Map<string, string>();
      if (!result.interrupted) {
        for (const name of outputNames) {
          staging ??= fs.mkdtempSync(path.join(this.options.tempRoot ?? os.tmpdir(), 'v8batch-out-'));
          const local = path.join(staging, name);
          if (await this.host.fetch(serverPath(dir, name), local)) {
            outputs.set(name, local);
          }
        }
      }
      if (staging && outputs.size === 0) {
        // Процесс ничего не создал — пустой staging не должен пережить запуск.
        fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
      } else if (staging) {
        this.stagingDirs.add(staging);
      }
      const runResult: DesignerBatchResult = {
        exitCode: result.exitCode,
        ...(result.interrupted ? { interrupted: interruptedText() } : {}),
        log: decodeDesignerLogBytes(result.logBytes).trim(),
        outputs,
      };
      completed = true;
      return runResult;
    } finally {
      if (!completed && staging) {
        fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
      }
      await this.cleanupServer(dir, request.secrets);
    }
  }

  private async materialize(arg: DesignerArg, dir: string, outputNames: string[]): Promise<string> {
    if (typeof arg === 'string') {
      return arg;
    }
    if (arg.kind === 'inputFile') {
      await this.host.put(dir, arg.name, arg.content);
    } else {
      outputNames.push(arg.name);
    }
    return serverPath(dir, arg.name);
  }

  /** Сбой уборки не ломает результат и не подменяет исходную ошибку: каталог-сирота уберёт следующий `connect`. */
  private async cleanupServer(dir: string, secrets: readonly string[]): Promise<void> {
    try {
      await this.host.rmtemp(dir);
    } catch (error) {
      const message = describeHostError(error);
      this.options.log?.(maskSecrets(`Не удалось убрать рабочий каталог на сервере ${dir}: ${message}`, secrets));
    }
  }
}

/** Путь на сервере — всегда Windows-путь, независимо от ОС, где работает расширение. */
function serverPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, '')}\\${name}`;
}

function interruptedText(): string | undefined {
  return describeProcessInterruption({ exitCode: 1, lastStdout: '', lastStderr: '', canceled: true });
}

function maskSecrets(text: string, secrets: readonly string[]): string {
  return maskSensitiveCliArgs([text], secrets)[0];
}
