# Исполнитель скрытого прогона: работает ОТ SYSTEM внутри задачи планировщика.
# Читает запрос, оставленный scripts/test-hidden.mjs, и запускает npm-скрипт репозитория.
#
# ГРАНИЦА ДОВЕРИЯ (честно): задача исполняет код репозитория (package.json, node_modules,
# out/, тесты) с правами SYSTEM. Любой процесс пользователя, способный писать в репозиторий,
# получает SYSTEM без UAC. Белые списки ниже защищают ТОЛЬКО от подмены команды/аргументов
# через request.json, а копия исполнителя в C:\ProgramData\v8vscedit (см. register.ps1) —
# от подмены самого этого файла. Риск принят осознанно для однопользовательской машины
# разработчика.

# Корень репозитория передаёт register.ps1 аргументом: исполнитель лежит вне репозитория.
param([Parameter(Mandatory = $true)][string]$RepoRoot)

$ErrorActionPreference = 'Stop'

$stateDir = Join-Path $RepoRoot '.v8vscedit\hidden-tests'
$requestPath = Join-Path $stateDir 'request.json'
$logPath = Join-Path $stateDir 'run.log'
$resultPath = Join-Path $stateDir 'result.json'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

$allowedScripts = @('test', 'test:fast', 'coverage:changed')
# Белый список не только имён, но и ЗНАЧЕНИЙ: COVERAGE_BASE уходит в `git diff <base>`,
# и значение вида `--output=…` git принял бы как опцию — запись произвольного файла от SYSTEM.
# Якорь \z, а не $: в .NET `$` совпадает и перед завершающим переводом строки («1\n» прошёл бы
# как «1»); [0-9], а не \d: \d в .NET совпадает с цифрами любых письменностей.
$allowedEnv = @{
  'MOCHA_GREP'            = '\A[^\r\n\x00]{0,500}\z'
  'COVERAGE_SHARDS'       = '\A[0-9]{1,3}\z'
  'COVERAGE_BASE'         = '\A[A-Za-z0-9._/~^@{}][A-Za-z0-9._/~^@{}-]{0,199}\z'
  'COVERAGE_ALLOW_EMPTY'  = '\A[01]\z'
  'COVERAGE_MAX_DEGRADED' = '\A(0(\.[0-9]{1,4})?|1(\.0{1,4})?)\z'
  'VSCODE_TEST_VERSION'   = '\A(stable|insiders|[0-9]+\.[0-9]+\.[0-9]+)\z'
}

$requestId = ''

# schtasks /End гасит только этот powershell: дочерние Code.exe тестового VS Code остаются
# сиротами в сессии 0, держат single-instance и роняют следующий прогон, а пользователь без
# прав администратора убить их не может. Поэтому исполнитель сам убирает их до и после прогона.
# Фильтр — только исполняемые файлы из .vscode-test этого репозитория: рабочий VS Code
# пользователя (другой путь, другая сессия) не затрагивается.
function Stop-OrphanTestCode {
  $testRoot = (Join-Path $RepoRoot '.vscode-test') + '\'
  Get-CimInstance Win32_Process -Filter "Name='Code.exe'" |
    Where-Object { $_.SessionId -eq 0 -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($testRoot, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Write-Result([int]$code) {
  # Через временный файл: наблюдатель ждёт result.json и не должен прочитать его недописанным.
  # id запроса в результате — защита от чужого результата при гонке двух запусков.
  $tmp = "$resultPath.tmp"
  [IO.File]::WriteAllText($tmp, (@{ id = $requestId; exitCode = $code } | ConvertTo-Json -Compress), $utf8NoBom)
  Move-Item -LiteralPath $tmp -Destination $resultPath -Force
}

try {
  $raw = [IO.File]::ReadAllText($requestPath, $utf8NoBom)
  # Запрос одноразовый: ручной перезапуск задачи не должен повторить прошлый прогон.
  Remove-Item -LiteralPath $requestPath -Force
  $request = $raw | ConvertFrom-Json
  # id попадает в result.json только проверенным: иначе наблюдатель получил бы сырое значение.
  $candidateId = [string]$request.id
  if (-not ($candidateId -cmatch '\A[A-Za-z0-9-]{8,64}\z')) { throw 'Некорректный id запроса.' }
  $requestId = $candidateId
  if (-not ($request.script -is [string]) -or -not ($allowedScripts -ccontains $request.script)) {
    throw "Скрипт '$($request.script)' не входит в белый список: $($allowedScripts -join ', ')"
  }
  if ($request.env) {
    foreach ($p in $request.env.PSObject.Properties) {
      if (-not $allowedEnv.ContainsKey($p.Name)) { throw "Переменная '$($p.Name)' не входит в белый список." }
      $value = [string]$p.Value
      if ($value -cnotmatch $allowedEnv[$p.Name]) { throw "Недопустимое значение переменной '$($p.Name)'." }
      [Environment]::SetEnvironmentVariable($p.Name, $value, 'Process')
    }
  }

  # Git от SYSTEM откажется работать с репозиторием пользователя («dubious ownership»);
  # доверяем ровно этому каталогу и только в этом процессе — глобальный конфиг не трогаем.
  $env:GIT_CONFIG_COUNT = '1'
  $env:GIT_CONFIG_KEY_0 = 'safe.directory'
  $env:GIT_CONFIG_VALUE_0 = ($RepoRoot -replace '\\', '/')
  # Ограничение: у SYSTEM свой PATH; node берётся из стандартной установки (nvm/volta не поддержаны).
  $env:PATH = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;$env:PATH"

  Set-Location -LiteralPath $RepoRoot
  Stop-OrphanTestCode
  [IO.File]::WriteAllText($logPath, "[hidden-tests] npm run $($request.script)`r`n", $utf8NoBom)
  # chcp 65001: собственные сообщения cmd иначе ушли бы в лог в OEM-кодировке среди UTF-8.
  & cmd.exe /d /s /c "chcp 65001 >nul & npm.cmd run $($request.script) >> `"$logPath`" 2>&1"
  $exitCode = $LASTEXITCODE
  # Сбой уборки после прогона не должен подменять настоящий код выхода тестов на 3.
  try { Stop-OrphanTestCode } catch {
    [IO.File]::AppendAllText($logPath, "[hidden-tests][warn] уборка Code.exe: $($_.Exception.Message)`r`n", $utf8NoBom)
  }
  Write-Result $exitCode
} catch {
  [IO.File]::AppendAllText($logPath, "[hidden-tests][error] $($_.Exception.Message)`r`n", $utf8NoBom)
  Write-Result 3
}
