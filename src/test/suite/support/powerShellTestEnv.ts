/**
 * Окружение тестов хоста PowerShell на НАСТОЯЩЕМ `powershell.exe` без удалённой сессии
 * (`computerName: ''` — скрипт-блоки исполняются в процессе хоста; настоящий WinRM/Kerberos
 * проверяется только пилотом на сервере пользователя).
 *
 * Сьюты требуют Windows PowerShell 5.1: `Copy-Item -FromSession`, `Process.Start`,
 * `taskkill` и пути `%TEMP%` — Windows-специфика, на других платформах смысла не имеют
 * (`this.skip()` с обоснованием). Прогон идёт и от SYSTEM (скрытый запуск через планировщик):
 * поэтому `%TEMP%`/`%TMP%` дочернего хоста ПЕРЕОПРЕДЕЛЯЮТСЯ на каталог внутри песочницы теста
 * (реальный %TEMP% пользователя не засоряется и не зависит от профиля SYSTEM), а запуск идёт с
 * `-NoProfile -ExecutionPolicy Bypass` (это обязан обеспечить сам хост).
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { PowerShellHostConnection } from '../../../infra/process/remote/PowerShellRemoteHost';

export const IN_PROCESS_CONNECTION: PowerShellHostConnection = {
  computerName: '',
  user: '',
  password: '',
  authentication: 'Default',
  useSsl: false,
  port: 0,
};

export const WINDOWS_POWERSHELL_SKIP_REASON =
  'Хост PowerShell использует Windows-специфику (powershell.exe 5.1, Process.Start, taskkill, %TEMP%); на этой платформе проверять нечего.';

let availability: boolean | undefined;

export function windowsPowerShellAvailable(): boolean {
  if (availability === undefined) {
    if (process.platform !== 'win32') {
      availability = false;
    } else {
      const probe = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
        windowsHide: true,
        timeout: 30_000,
      });
      availability = probe.status === 0;
    }
  }
  return availability;
}

/** Окружение дочернего хоста: временный каталог — внутри песочницы. */
export function sandboxedHostEnv(tempDir: string): NodeJS.ProcessEnv {
  fs.mkdirSync(tempDir, { recursive: true });
  return { ...process.env, TEMP: tempDir, TMP: tempDir };
}

/** Серверные рабочие каталоги хоста (`v8vscedit-*`) во временном каталоге песочницы. */
export function listHostWorkDirs(tempDir: string): string[] {
  if (!fs.existsSync(tempDir)) {
    return [];
  }
  return fs.readdirSync(tempDir).filter((name) => name.startsWith('v8vscedit-')).map((name) => path.join(tempDir, name));
}
