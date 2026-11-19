# Разовая регистрация задачи планировщика для скрытого прогона тестов.
# Запускать из PowerShell «от имени администратора» (повторно — после изменения runner.ps1):
#   powershell -ExecutionPolicy Bypass -File scripts\hidden-tests\register.ps1
#
# Почему SYSTEM: процесс в неинтерактивной сессии создаёт окна на рабочем столе, которого
# никто не видит, — окна тестового VS Code перестают всплывать.
#
# ГРАНИЦА ДОВЕРИЯ (честно): задача исполняет код репозитория (package.json, node_modules, out/,
# тесты) с правами SYSTEM, поэтому любой процесс пользователя, способный писать в репозиторий,
# получает SYSTEM без UAC. Риск принят осознанно для однопользовательской машины разработчика.
# Защита, которая есть: исполнитель копируется в C:\ProgramData\v8vscedit (писать туда могут
# только администраторы и SYSTEM) — подменить сам исполнитель из-под пользователя нельзя;
# исполнитель принимает только белый список скриптов и значений переменных.

$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Нужен PowerShell, запущенный от имени администратора.'
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$taskName = 'v8vscedit-hidden-tests'
$installDir = Join-Path $env:ProgramData 'v8vscedit'
$runner = Join-Path $installDir 'runner.ps1'

# Каталог исполнителя: наследование отключено, доступ только BA/SY на запись, пользователям — чтение.
# Пользователь может создать подкаталог ProgramData заранее (и стать его владельцем) или подложить
# ссылку — поэтому: отказ на точке повторной обработки, явный владелец «Администраторы», старая
# копия удаляется, права на самом файле сбрасываются. Иначе «подменить исполнитель нельзя» — ложь.
if (Test-Path -LiteralPath $installDir) {
  if ((Get-Item -LiteralPath $installDir -Force).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
    throw "$installDir — точка повторной обработки (ссылка). Удалите её и запустите регистрацию снова."
  }
} else {
  New-Item -ItemType Directory $installDir | Out-Null
}
$adminsSid = New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($adminsSid)
$acl.SetAccessRuleProtection($true, $false)
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$none = [Security.AccessControl.PropagationFlags]::None
foreach ($sid in @('S-1-5-32-544', 'S-1-5-18')) {
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $sid), 'FullControl', $inherit, $none, 'Allow')))
}
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545'), 'ReadAndExecute', $inherit, $none, 'Allow')))
Set-Acl -LiteralPath $installDir -AclObject $acl
if (Test-Path -LiteralPath $runner) { Remove-Item -LiteralPath $runner -Force }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runner.ps1') -Destination $runner
# На файле — только наследуемые от каталога права и владелец «Администраторы».
$fileAcl = New-Object Security.AccessControl.FileSecurity
$fileAcl.SetOwner($adminsSid)
$fileAcl.SetAccessRuleProtection($false, $false)
Set-Acl -LiteralPath $runner -AclObject $fileAcl

# Пользователь, которому разрешаем запуск: тот, кто вошёл в систему.
$userName = if ($env:V8VSCEDIT_HIDDEN_TESTS_USER) { $env:V8VSCEDIT_HIDDEN_TESTS_USER } else { "$env:USERDOMAIN\$env:USERNAME" }
$userSid = (New-Object Security.Principal.NTAccount($userName)).Translate([Security.Principal.SecurityIdentifier]).Value

$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')

$def = $service.NewTask(0)
$def.RegistrationInfo.Description = "Скрытый прогон тестов v8vscedit ($repoRoot). Исполнитель: $runner (белый список скриптов и значений)."
$def.Settings.Enabled = $true
$def.Settings.AllowDemandStart = $true
$def.Settings.DisallowStartIfOnBatteries = $false
$def.Settings.StopIfGoingOnBatteries = $false
$def.Settings.ExecutionTimeLimit = 'PT3H'
$def.Settings.MultipleInstances = 2 # TASK_INSTANCES_IGNORE_NEW: второй запуск не стартует поверх идущего
$def.Principal.UserId = 'SYSTEM'
$def.Principal.LogonType = 5 # TASK_LOGON_SERVICE_ACCOUNT
$def.Principal.RunLevel = 1  # TASK_RUNLEVEL_HIGHEST

$action = $def.Actions.Create(0) # TASK_ACTION_EXEC
$action.Path = 'powershell.exe'
$action.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`" -RepoRoot `"$repoRoot`""
$action.WorkingDirectory = $installDir

# BA/SY — полный доступ к задаче, пользователю — чтение и запуск.
$sddl = "D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;GRGX;;;$userSid)"
$folder.RegisterTaskDefinition($taskName, $def, 6, 'SYSTEM', $null, 5, $sddl) | Out-Null # 6 = CREATE_OR_UPDATE

Write-Host "Задача '$taskName' зарегистрирована (SYSTEM), исполнитель: $runner, запуск разрешён: $userName"
Write-Host "Дальше: npm run test:hidden -- test:fast   (MOCHA_GREP берётся из окружения)"
