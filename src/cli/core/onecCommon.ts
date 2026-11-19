import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { decodeDesignerLogBytes, resolveV8ExecutablePath, runProcess } from '../../infra/process';
import { buildInfoBaseConnectionArgs } from '../../infra/process/designer/InfoBaseConnectionArgs';
import type { OnecConnection } from './types';

// Перенос staging-файла общий для CLI и расширения, поэтому живёт в infra.
export { moveStagingToTarget } from '../../infra/fs/StagingFile';

export function resolveV8Path(v8Path: string): string {
  return resolveV8ExecutablePath(v8Path);
}

export function appendConnectionArgs(args: string[], connection: OnecConnection): void {
  args.push(...buildInfoBaseConnectionArgs(connection));
}

export function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function safeRemoveDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Ошибка удаления временного каталога не должна ломать выполнение.
  }
}

export function writeUtf8BomLines(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, `\uFEFF${lines.join('\n')}`, 'utf-8');
}

/**
 * Убирает файл, не роняя операцию. Нужен для staging-остатка: при ошибке
 * платформа всё равно создаёт выходной файл (замерено: 16 байт мусора), и он не
 * должен пережить прогон.
 */
export function safeRemoveFile(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Остаток временного файла не должен ломать результат операции.
  }
}

export async function runDesignerAndPrintResult(
  connection: OnecConnection,
  designerArgs: string[],
  successMessage: string,
  errorMessage: string,
  outFilePath?: string
): Promise<number> {
  const args: string[] = ['DESIGNER'];
  appendConnectionArgs(args, connection);
  args.push(...designerArgs);

  const result = await runProcess({ command: connection.v8Path, args });
  if (result.exitCode === 0) {
    console.log(successMessage);
  } else {
    if (outFilePath) {
      printLogFile(outFilePath);
    }
    const processDetails = [result.lastStderr, result.lastStdout]
      .map((item) => item.trim())
      .filter(Boolean);
    for (const detail of processDetails) {
      console.error(detail);
    }
    console.error(`${errorMessage} (code: ${String(result.exitCode)})`);
  }
  return result.exitCode;
}

export function printLogFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }
  try {
    printLogText(decodeDesignerLogBytes(fs.readFileSync(filePath)).trim());
  } catch {
    // Ошибка чтения лога не критична.
  }
}

/** Печать уже декодированного лога `/Out` в формате, который ждут скрипты-потребители CLI. */
export function printLogText(content: string): void {
  if (!content) {
    return;
  }
  console.log('--- Log ---');
  console.log(content);
  console.log('--- End ---');
}
