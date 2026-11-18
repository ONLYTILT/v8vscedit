import { PowerShellHostError, describeHostError } from './PowerShellRemoteHost';

/**
 * Вторая половина проверки подключения к серверу 1С (первая — SSH/SFTP агента): PowerShell-сессия
 * и путь к 1cv8 на сервере. Другой транспорт и другая учётка, поэтому проверяется независимо от
 * SSH-части. Одна попытка на часть; любой сбой превращается в отчёт, а не в исключение.
 */

export type RemotePsPartId = 'powershell' | 'v8';
export type RemotePsFailureReason = 'host-start' | 'session' | 'temp-write' | 'v8-not-found' | 'v8-config';

export interface RemotePsPart {
  readonly id: RemotePsPartId;
  readonly status: 'ok' | 'failed' | 'skipped';
  readonly reason?: RemotePsFailureReason;
  readonly message: string;
}

export interface RemotePowerShellReport {
  readonly ok: boolean;
  /** Всегда две части в порядке: powershell, v8. */
  readonly parts: readonly RemotePsPart[];
}

export interface RemotePsCheckHost {
  ping(): Promise<{ pid: number }>;
  mktemp(): Promise<string>;
  put(dir: string, name: string, content: Uint8Array | string): Promise<void>;
  rmtemp(dir: string): Promise<void>;
  resolveV8(target: { v8Path?: string; v8Version?: string }): Promise<string | undefined>;
}

export interface RemotePsCheckTarget {
  readonly computerName: string;
  readonly v8Path?: string;
  readonly v8Version?: string;
}

const PROBE_FILE = 'v8vscedit-check.txt';

export async function checkRemotePowerShell(host: RemotePsCheckHost, target: RemotePsCheckTarget): Promise<RemotePowerShellReport> {
  const server = target.computerName;
  try {
    await host.ping();
  } catch (error) {
    const reason: RemotePsFailureReason = error instanceof PowerShellHostError && error.code === 'spawn-failed' ? 'host-start' : 'session';
    return report([
      { id: 'powershell', status: 'failed', reason, message: `PowerShell-сессия с сервером ${server} не открылась: ${describeHostError(error)}` },
      { id: 'v8', status: 'skipped', message: 'Путь к 1cv8 не проверялся: нет PowerShell-сессии с сервером.' },
    ]);
  }
  return report([await checkTempWrite(host, server), await checkV8(host, target)]);
}

/** Пробная запись во временный каталог сервера: права на запись и уборку — то, что нужно каждой операции. */
async function checkTempWrite(host: RemotePsCheckHost, server: string): Promise<RemotePsPart> {
  let dir: string | undefined;
  try {
    dir = await host.mktemp();
    await host.put(dir, PROBE_FILE, 'v8vscedit');
    await host.rmtemp(dir);
    dir = undefined;
    return { id: 'powershell', status: 'ok', message: `PowerShell-сессия с сервером ${server} открыта, запись во временный каталог сервера работает.` };
  } catch (error) {
    if (dir !== undefined) {
      // Best effort: пробный каталог не должен остаться, даже если запись не удалась.
      await host.rmtemp(dir).catch(() => undefined);
    }
    return {
      id: 'powershell',
      status: 'failed',
      reason: 'temp-write',
      message: `Сессия с сервером ${server} открыта, но запись во временный каталог сервера не удалась: ${describeHostError(error)}`,
    };
  }
}

async function checkV8(host: RemotePsCheckHost, target: RemotePsCheckTarget): Promise<RemotePsPart> {
  const server = target.computerName;
  const query = target.v8Path ? { v8Path: target.v8Path } : target.v8Version ? { v8Version: target.v8Version } : undefined;
  if (!query) {
    return {
      id: 'v8',
      status: 'failed',
      reason: 'v8-config',
      message: 'Путь к 1cv8 на сервере не задан: заполните v8vscedit.remote.v8Path или --v8version в env.json.',
    };
  }
  const subject = query.v8Path ? `1cv8 по пути ${query.v8Path}` : `1cv8 платформы версии ${String(query.v8Version)}`;
  try {
    const found = await host.resolveV8(query);
    if (!found) {
      return { id: 'v8', status: 'failed', reason: 'v8-not-found', message: `На сервере ${server} не найден ${subject}.` };
    }
    return { id: 'v8', status: 'ok', message: `1cv8 на сервере: ${found}.` };
  } catch (error) {
    return { id: 'v8', status: 'failed', reason: 'session', message: `Не удалось проверить ${subject} на сервере ${server}: ${describeHostError(error)}` };
  }
}

function report(parts: RemotePsPart[]): RemotePowerShellReport {
  return { ok: parts.every((part) => part.status === 'ok'), parts };
}

const STATUS_LABEL: Record<RemotePsPart['status'], string> = { ok: '[OK]', failed: '[ОШИБКА]', skipped: '[ПРОПУЩЕНО]' };
const PART_LABEL: Record<RemotePsPartId, string> = { powershell: 'PowerShell', v8: '1cv8' };

export function formatRemotePowerShellReport(result: RemotePowerShellReport): string[] {
  return result.parts.map((part) => `${STATUS_LABEL[part.status]} ${PART_LABEL[part.id]}: ${part.message}`);
}
