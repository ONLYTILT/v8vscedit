/**
 * Host-скрипт PowerShell: долгоживущий процесс `powershell.exe` на машине пользователя, который
 * исполняет операции протокола (PowerShellHostProtocol) либо в удалённой PSSession (`connect` с
 * непустым `computerName`), либо прямо в себе (пустой `computerName` — режим тестов: тот же протокол
 * на локальном powershell.exe без WinRM).
 *
 * Почему именно так (решения, которые легко «упростить» обратно):
 *  - доставка `-EncodedCommand` (base64 UTF-16LE): скрипт не пишется на диск и не зависит от
 *    ExecutionPolicy и кавычек командной строки; лимит командной строки Windows — 32 767 символов,
 *    поэтому скрипт держится компактным (тест закрепляет < 30 000 символов base64);
 *  - пароль PSSession приходит ТОЛЬКО запросом `connect` по stdin и собирается в SecureString
 *    посимвольно: в командной строке powershell (видна в списке процессов) его нет никогда;
 *  - stdin читается `StreamReader.ReadLineAsync` над `OpenStandardInput`, а не `[Console]::In`:
 *    у консольного читателя асинхронное чтение синхронно, и строку `cancel` во время работы
 *    процесса было бы не прочитать;
 *  - операции с файлами — ТОЛЬКО внутри `<TEMP>\v8vscedit-*` (проверка `V8W` на стороне исполнения):
 *    хост исполняется с правами учётки сервера, и протокол не должен давать писать/читать/удалять
 *    что-либо ещё; каталоги-сироты старше суток убираются на `connect`;
 *  - выходные файлы забираются копированием (`Copy-Item -FromSession` передаёт файл потоком порциями),
 *    а не base64 в ответе `Invoke-Command`: объект ответа целиком собирается в памяти и ограничен
 *    квотой MaxReceivedObjectSizeMB, base64 раздувает его на треть, а выгрузка CF — сотни мегабайт.
 *    Base64 через `Invoke-Command` — только для небольших лога и входных файлов (ObjectsFile, единицы КБ);
 *    крупные входы потребуют `Copy-Item -ToSession` (бэклог Н63);
 *  - сессия открывается с `IdleTimeout` 10 мин: если powershell.exe клиента убит, сервер закрывает
 *    сессию (и не держит базу 1cv8-процессом) через 10 мин, а не через умолчание около 2 ч;
 *  - отказ аутентификации при `connect` помечается `auth: true` (коды Windows 5, 1326, 1909, 1311 у
 *    PSRemotingTransportException): клиент не повторяет вход сам и стирает сохранённый пароль;
 *  - в удалённой сессии выставляется `$global:ErrorActionPreference = 'Stop'`: иначе ошибки командлетов
 *    там не прерывали бы скрипт-блок и операция «успешно» продолжалась бы после сбоя;
 *  - отмена убивает ДЕРЕВО процессов (`taskkill /T /F`): 1cv8 порождает дочерние процессы;
 *  - stdin дочернего процесса перенаправлен и закрыт: иначе он унаследовал бы канал протокола;
 *  - временный каталог — `$env:TEMP`, и только без него `GetTempPath()`: процессу от SYSTEM Windows 11
 *    `GetTempPath()` отдаёт `C:\Windows\SystemTemp`, не глядя на TEMP окружения.
 *
 * Скрипт хранится строкой (`String.raw`, обратные косые без экранирования); в нём нет обратных
 * апострофов и подстановок шаблона — их TypeScript интерпретировал бы сам. Имена переменных
 * PowerShell регистронезависимы: `$S` (сессия) и любая `$s` — одна переменная, отсюда `$pr`.
 */
export const POWERSHELL_HOST_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$U = New-Object System.Text.UTF8Encoding($false)
try { [Console]::InputEncoding = $U; [Console]::OutputEncoding = $U } catch { }
$In = New-Object IO.StreamReader([Console]::OpenStandardInput(), $U)
$Out = New-Object IO.StreamWriter([Console]::OpenStandardOutput(), $U)
$Out.AutoFlush = $true
$S = $null
$Pend = New-Object Collections.Queue
$RT = $In.ReadLineAsync()

function E($id, $h) { $h.id = $id; $Out.Write('@@V8VSC@@' + (ConvertTo-Json $h -Compress -Depth 4) + [char]10) }
function X($sb, [object[]]$a = @()) {
  if ($S) {
    if ($a.Count) { Invoke-Command -Session $S -ScriptBlock $sb -ArgumentList $a } else { Invoke-Command -Session $S -ScriptBlock $sb }
  } else { & $sb @a }
}
function NL {
  if ($Pend.Count) { return $Pend.Dequeue() }
  $l = $script:RT.Result
  if ($null -ne $l) { $script:RT = $In.ReadLineAsync() }
  return $l
}

$Init = {
  $global:ErrorActionPreference = 'Stop'
  function global:V8T { $t = $env:TEMP; if (-not $t) { $t = [IO.Path]::GetTempPath() }; [IO.Path]::GetFullPath($t).TrimEnd('\') }
  function global:V8W([string]$p, [bool]$d) {
    $t = V8T
    $f = [IO.Path]::GetFullPath($p).TrimEnd('\')
    $r = @()
    if ($f.StartsWith($t + '\', [StringComparison]::OrdinalIgnoreCase)) { $r = $f.Substring($t.Length + 1).Split('\') }
    if ($r.Count -lt 1 -or $r[0] -notlike 'v8vscedit-*' -or ($d -and $r.Count -ne 1) -or (-not $d -and $r.Count -lt 2)) {
      throw ('Путь вне рабочего каталога хоста (' + $t + '\v8vscedit-*): ' + $p)
    }
    $f
  }
}
$Clean = {
  $t = V8T
  $lim = [DateTime]::UtcNow.AddDays(-1)
  if ([IO.Directory]::Exists($t)) {
    foreach ($d in [IO.Directory]::GetDirectories($t, 'v8vscedit-*')) {
      if ([IO.Path]::GetFileName($d) -like 'v8vscedit-*' -and [IO.Directory]::GetLastWriteTimeUtc($d) -lt $lim) {
        try { [IO.Directory]::Delete($d, $true) } catch { }
      }
    }
  }
}
$Mk = { $d = [IO.Path]::Combine((V8T), 'v8vscedit-' + [guid]::NewGuid().ToString()); [void][IO.Directory]::CreateDirectory($d); $d }
$Put = {
  param($d, $n, $b)
  $d = V8W $d $true
  if (-not $n -or $n -eq '.' -or $n -eq '..' -or $n.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) { throw ('Недопустимое имя файла: ' + $n) }
  [IO.File]::WriteAllBytes([IO.Path]::Combine($d, $n), [Convert]::FromBase64String($b))
}
$Rm = { param($d) $d = V8W $d $true; if ([IO.Directory]::Exists($d)) { [IO.Directory]::Delete($d, $true) } }
$Has = { param($p) $f = V8W $p $false; if ([IO.File]::Exists($f)) { $f } else { $null } }
$V8 = {
  param($p, $v)
  if ($p) { if ([IO.File]::Exists($p)) { return [IO.Path]::GetFullPath($p) }; return $null }
  if ($v -notmatch '^\d+(\.\d+){1,3}$') { return $null }
  foreach ($b in @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))) {
    if ($b) { $c = [IO.Path]::Combine($b, '1cv8', $v, 'bin', '1cv8.exe'); if ([IO.File]::Exists($c)) { return $c } }
  }
  return $null
}
$Start = {
  param($e, $c)
  $global:V8R = $null
  $i = New-Object Diagnostics.ProcessStartInfo
  $i.FileName = $e; $i.Arguments = $c; $i.UseShellExecute = $false; $i.CreateNoWindow = $true
  $i.RedirectStandardInput = $true; $i.RedirectStandardOutput = $true; $i.RedirectStandardError = $true
  $i.StandardOutputEncoding = New-Object Text.UTF8Encoding($false); $i.StandardErrorEncoding = $i.StandardOutputEncoding
  $p = [Diagnostics.Process]::Start($i)
  $p.StandardInput.Close()
  $global:V8R = @{ p = $p; o = $p.StandardOutput.ReadLineAsync(); e = $p.StandardError.ReadLineAsync() }
  $p.Id
}
$Poll = {
  $r = $global:V8R
  $l = New-Object Collections.ArrayList
  foreach ($k in 'o', 'e') {
    while ($r[$k] -and $r[$k].IsCompleted) {
      $t = $r[$k].Result
      if ($null -eq $t) { $r[$k] = $null } else {
        [void]$l.Add(@($k, $t))
        if ($k -eq 'o') { $r[$k] = $r.p.StandardOutput.ReadLineAsync() } else { $r[$k] = $r.p.StandardError.ReadLineAsync() }
      }
    }
  }
  @{ l = $l.ToArray(); x = $r.p.HasExited; d = ((-not $r['o']) -and (-not $r['e'])) }
}
$Kill = { param($n) $ErrorActionPreference = 'SilentlyContinue'; & taskkill.exe /T /F /PID $n *> $null }
$Fin = {
  param($lp)
  $r = $global:V8R
  $c = $r.p.ExitCode
  $b = ''
  try { $f = V8W $lp $false; if ([IO.File]::Exists($f)) { $b = [Convert]::ToBase64String([IO.File]::ReadAllBytes($f)) } } catch { }
  $r.p.Dispose()
  $global:V8R = $null
  @{ c = $c; b = $b }
}

function Run($q) {
  $id = [int]$q.id
  $cp = [int](X $Start @($q.exe, $q.commandLine))
  E $id @{ event = 'started'; pid = $cp }
  $cx = $false
  $dl = $null
  while ($true) {
    $pr = X $Poll
    foreach ($x in $pr.l) {
      $st = 'stderr'; if ($x[0] -eq 'o') { $st = 'stdout' }
      E $id @{ event = 'output'; stream = $st; textB64 = [Convert]::ToBase64String($U.GetBytes([string]$x[1])) }
    }
    if ($pr.x) {
      if ($pr.d) { break }
      if ($null -eq $dl) { $dl = [DateTime]::UtcNow.AddSeconds(3) } elseif ([DateTime]::UtcNow -gt $dl) { break }
    }
    if ($script:RT.IsCompleted) {
      $l = $script:RT.Result
      if ($null -eq $l) {
        if (-not $cx) { $cx = $true; X $Kill @($cp) }
      } else {
        $script:RT = $In.ReadLineAsync()
        $c = $null
        try { $c = ConvertFrom-Json $l } catch { }
        if ($c -and $c.op -eq 'cancel') {
          if ([int]$c.target -eq $id -and -not $cx) { $cx = $true; X $Kill @($cp) }
        } else { $Pend.Enqueue($l) }
      }
    }
    if ($S) { Start-Sleep -Milliseconds 250 } else { Start-Sleep -Milliseconds 50 }
  }
  $f = X $Fin @($q.logPath)
  E $id @{ event = 'exit'; code = [int]$f.c; logB64 = [string]$f.b; interrupted = $cx }
}

while ($true) {
  $line = NL
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = 0
  try {
    $q = ConvertFrom-Json $line
    $id = [int]$q.id
    switch ([string]$q.op) {
      'connect' {
        if ($q.computerName) {
          $o = @{ ComputerName = [string]$q.computerName; Authentication = [string]$q.authentication; ErrorAction = 'Stop' }
          if ($q.useSsl) { $o.UseSSL = $true }
          if ([int]$q.port -gt 0) { $o.Port = [int]$q.port }
          if ($q.user) {
            $ss = New-Object Security.SecureString
            foreach ($ch in $U.GetString([Convert]::FromBase64String([string]$q.passwordB64)).ToCharArray()) { $ss.AppendChar($ch) }
            $o.Credential = New-Object Management.Automation.PSCredential([string]$q.user, $ss)
          }
          $o.SessionOption = New-PSSessionOption -IdleTimeout 600000
          $script:S = New-PSSession @o
        }
        X $Init
        X $Clean
        E $id @{ event = 'ok' }
      }
      'ping' { E $id @{ event = 'ok'; pid = $PID } }
      'mktemp' { E $id @{ event = 'ok'; dir = [string](X $Mk) } }
      'put' { X $Put @($q.dir, $q.name, $q.contentB64); E $id @{ event = 'ok' } }
      'rmtemp' { X $Rm @($q.dir); E $id @{ event = 'ok' } }
      'resolveV8' {
        $r = X $V8 @($q.v8Path, $q.v8Version)
        if ($r) { E $id @{ event = 'ok'; path = [string]$r } } else { E $id @{ event = 'ok'; path = $null } }
      }
      'fetch' {
        $f = X $Has @($q.remotePath)
        if ($f) {
          $lp = [IO.Path]::GetFullPath([string]$q.localPath)
          [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($lp))
          if ($S) { Copy-Item -FromSession $S -LiteralPath ([string]$f) -Destination $lp -Force } else { Copy-Item -LiteralPath ([string]$f) -Destination $lp -Force }
        }
        E $id @{ event = 'ok'; exists = [bool]$f }
      }
      'run' { Run $q }
      'cancel' { }
      default { throw ('Неизвестная операция хоста: ' + $q.op) }
    }
  } catch {
    $m = $_.Exception.Message
    $x = $_.Exception
    $au = ($x -is [System.Management.Automation.Remoting.PSRemotingTransportException]) -and (@(5, 1326, 1909, 1311) -contains $x.ErrorCode)
    if ($S -and $S.State -ne 'Opened') { E $id @{ event = 'sessionBroken'; message = $m } } else { E $id @{ event = 'error'; message = $m; auth = $au } }
  }
}
if ($S) { try { Remove-PSSession $S } catch { } }
`;

/** Вектор запуска хоста: без профиля и интерактива, политика Bypass, скрипт — в `-EncodedCommand`. */
export function buildPowerShellHostArgs(script: string = POWERSHELL_HOST_SCRIPT): string[] {
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ];
}
