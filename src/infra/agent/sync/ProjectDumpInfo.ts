import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG_DUMP_INFO_XML } from './ProjectFiles';
import type { ProjectDumpInfoFingerprint } from './SyncManifest';

/**
 * Отпечаток `ConfigDumpInfo.xml` проекта — признак ручной замены выгрузки проекта (план «полная
 * выгрузка — только когда без неё нельзя», §3.7). Файл версий меняется только внешней выгрузкой: наш
 * импорт пишет его лишь в архивной ветке и сразу запоминает новый отпечаток.
 *
 * Файл версий большой конфигурации — десятки мегабайт, поэтому при совпадении `size`+`mtimeMs` sha1 не
 * пересчитывается (файл не читается). Компромисс осознанный: подмена содержимого с тем же размером и
 * восстановленным mtime не обнаруживается — для новой выгрузки это практически невозможно (версии в
 * файле меняются).
 */

/** `undefined` — файла нет (поле в манифесте убирается). */
export async function fingerprintProjectDumpInfo(
  projectDir: string,
  previous?: ProjectDumpInfoFingerprint
): Promise<ProjectDumpInfoFingerprint | undefined> {
  const filePath = path.join(projectDir, CONFIG_DUMP_INFO_XML);
  const stat = await statFile(filePath);
  if (stat === undefined) {
    return undefined;
  }
  if (previous !== undefined && sameStat(previous, stat)) {
    return previous;
  }
  return { sha1: await sha1OfFile(filePath), size: stat.size, mtimeMs: stat.mtimeMs };
}

/**
 * Заменена ли выгрузка проекта после запомненного отпечатка. Нет отпечатка (старый манифест, первый
 * импорт) или нет файла (посев всё равно невозможен) — `false`: ложное срабатывание хуже пропуска.
 * Другой mtime при том же содержимом (копирование, checkout) — тоже `false`: решает sha1.
 */
export async function isProjectDumpReplaced(
  projectDir: string,
  stored: ProjectDumpInfoFingerprint | undefined
): Promise<boolean> {
  if (stored === undefined) {
    return false;
  }
  const filePath = path.join(projectDir, CONFIG_DUMP_INFO_XML);
  const stat = await statFile(filePath);
  if (stat === undefined || sameStat(stored, stat)) {
    return false;
  }
  return (await sha1OfFile(filePath)) !== stored.sha1;
}

function sameStat(fingerprint: ProjectDumpInfoFingerprint, stat: fs.Stats): boolean {
  return fingerprint.size === stat.size && fingerprint.mtimeMs === stat.mtimeMs;
}

async function statFile(filePath: string): Promise<fs.Stats | undefined> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() ? stat : undefined;
  } catch {
    return undefined;
  }
}

/** Потоком: файл версий в десятки мегабайт не держится в памяти целиком. */
function sha1OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}
