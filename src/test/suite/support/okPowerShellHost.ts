/**
 * Заглушка хоста PowerShell для тестов, где удалённая часть НЕ предмет проверки (она проверяется в
 * remotePowerShellCheck/powerShellRemoteHost*): хост всегда «исправен», 1cv8 «найден». Нужна, чтобы старые
 * тесты проверки подключения (SSH/SFTP, Э8) не зависели от наличия WinRM после появления PS-части (Э9).
 */
import type { HostRunResult } from '../../../infra/process/remote/PowerShellRemoteHost';
import type { RegistryHost } from '../../../ui/commands/ext/designerExecutorRegistry';

export function createOkPowerShellHost(v8Path = 'C:\\1c\\1cv8.exe'): RegistryHost {
  return {
    ping: () => Promise.resolve({ pid: 1 }),
    mktemp: () => Promise.resolve('C:\\Temp\\v8vscedit-ok'),
    put: () => Promise.resolve(),
    rmtemp: () => Promise.resolve(),
    fetch: () => Promise.resolve(false),
    resolveV8: () => Promise.resolve(v8Path),
    run: (): Promise<HostRunResult> => Promise.resolve({ exitCode: 0, interrupted: false, logBytes: Buffer.alloc(0), pid: 1 }),
    dispose: () => Promise.resolve(),
  };
}
