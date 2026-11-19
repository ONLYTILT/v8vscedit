import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { decodeDesignerLogBytes } from '../OutputDecoder';
import { describeProcessInterruption, runProcess } from '../ProcessRunner';
import {
  DESIGNER_LOG_FILE_NAME,
  validateDesignerFileNames,
  type DesignerArg,
  type DesignerBatchExecutor,
  type DesignerBatchRequest,
  type DesignerBatchResult,
} from './DesignerBatchExecutor';

export interface LocalDesignerBatchExecutorOptions {
  /** Рабочий каталог процесса; по умолчанию — текущий каталог процесса расширения/CLI. */
  readonly cwd?: string;
  /** Где создавать рабочие и staging-каталоги; по умолчанию — временный каталог ОС. */
  readonly tempRoot?: string;
}

/**
 * Исполнитель пакетного конфигуратора на этой машине.
 *
 * Каждый запуск получает свой рабочий каталог: входные файлы (`-Objects` и т.п.)
 * и лог `/Out` живут ровно столько, сколько процесс, и удаляются в `finally` —
 * в том числе при отмене и ошибке запуска. Выходные файлы переносятся в отдельный
 * staging-каталог, переживающий `run`: вызывающий переносит их на целевой путь
 * только при успехе, а не забранные убирает `dispose`.
 */
export class LocalDesignerBatchExecutor implements DesignerBatchExecutor {
  private readonly stagingDirs = new Set<string>();

  constructor(
    private readonly exePath: string,
    private readonly options: LocalDesignerBatchExecutorOptions = {}
  ) {}

  async run(request: DesignerBatchRequest): Promise<DesignerBatchResult> {
    // Проверка имён — до создания каталога, чтобы отказ не оставлял следов.
    validateDesignerFileNames(request.args);
    const tempRoot = this.options.tempRoot ?? os.tmpdir();
    const workDir = fs.mkdtempSync(path.join(tempRoot, 'v8batch-'));
    try {
      const outputNames: string[] = [];
      const args = request.args.map((arg) => this.materialize(arg, workDir, outputNames));
      const logPath = path.join(workDir, DESIGNER_LOG_FILE_NAME);
      args.push('/Out', logPath, '/DisableStartupDialogs');

      // shell: false — пароль в аргументе не должен проходить через разбор оболочки.
      const result = await runProcess({
        command: this.exePath,
        args,
        cwd: this.options.cwd,
        shell: false,
        cancellationToken: request.cancellation,
        onStdout: (line) => request.onOutput?.(line),
        onStderr: (line) => request.onOutput?.(line),
      });

      const interrupted = describeProcessInterruption(result);
      return {
        exitCode: result.exitCode,
        ...(interrupted ? { interrupted } : {}),
        log: readLog(logPath),
        outputs: this.stageOutputs(workDir, outputNames, tempRoot),
      };
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  dispose(): Promise<void> {
    for (const dir of this.stagingDirs) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
    this.stagingDirs.clear();
    return Promise.resolve();
  }

  private materialize(arg: DesignerArg, workDir: string, outputNames: string[]): string {
    if (typeof arg === 'string') {
      return arg;
    }
    const filePath = path.join(workDir, arg.name);
    if (arg.kind === 'inputFile') {
      // Строка — UTF-8 без BOM: BOM, если нужен формату, вызывающий кладёт в content сам.
      fs.writeFileSync(filePath, typeof arg.content === 'string' ? Buffer.from(arg.content, 'utf-8') : arg.content);
    } else {
      outputNames.push(arg.name);
    }
    return filePath;
  }

  private stageOutputs(workDir: string, names: readonly string[], tempRoot: string): Map<string, string> {
    const outputs = new Map<string, string>();
    let stagingDir: string | undefined;
    for (const name of names) {
      const produced = path.join(workDir, name);
      if (!fs.existsSync(produced)) {
        continue;
      }
      if (!stagingDir) {
        stagingDir = fs.mkdtempSync(path.join(tempRoot, 'v8batch-out-'));
        this.stagingDirs.add(stagingDir);
      }
      const staged = path.join(stagingDir, name);
      fs.renameSync(produced, staged);
      outputs.set(name, staged);
    }
    return outputs;
  }
}

function readLog(logPath: string): string {
  try {
    return decodeDesignerLogBytes(fs.readFileSync(logPath)).trim();
  } catch {
    // Платформа не создаёт лог, если упала до начала работы: это не ошибка исполнителя.
    return '';
  }
}
