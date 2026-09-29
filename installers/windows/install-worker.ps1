<#
.SYNOPSIS
  Installs the Agent Orchestration worker for the current Windows user and starts it at logon.

.DESCRIPTION
  1. Validates dependencies (Node.js >= 20, Git).
  2. Copies the packaged worker (from -SourceDir, or packages it from this repository).
  3. Registers a per-user Scheduled Task that starts the worker at logon and restarts it on failure.
     The worker runs as YOU because agent logins, Git credentials and repositories are per-user.
  4. Starts the worker, opens the local UI (http://127.0.0.1:47821) to begin pairing, runs diagnostics.

.PARAMETER SourceDir   Packaged worker directory (default: <repo>\.deploy\worker, built if missing).
.PARAMETER InstallDir  Where to install (default: %LOCALAPPDATA%\AgentOrchestration\worker-app).
.PARAMETER NoService   Install files only; do not register or start the scheduled task.
.PARAMETER NoBrowser   Do not open the local UI.
.PARAMETER NoPath      Do not add the agentctl shim directory to the user PATH.
#>
[CmdletBinding()]
param(
  [string]$SourceDir,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'AgentOrchestration\worker-app'),
  [switch]$NoService,
  [switch]$NoBrowser,
  [switch]$NoPath
)
$ErrorActionPreference = 'Stop'
$TaskName = 'AgentOrchestrationWorker'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

Step 'Checking dependencies'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js 20+ is required. Install it from https://nodejs.org and re-run.' }
$nodeMajor = [int]((& node -p 'process.versions.node').Split('.')[0])
if ($nodeMajor -lt 20) { Fail "Node.js 20+ is required (found $(& node -v))." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Warning 'Git was not found on PATH. Git policies will be skipped until Git is installed.' }
Write-Host "    node $(& node -v) at $($node.Source)"

if (-not $SourceDir) {
  $SourceDir = Join-Path $RepoRoot '.deploy\worker'
  if (-not (Test-Path (Join-Path $SourceDir 'dist\main.js'))) {
    Step 'Packaging the worker from this repository'
    & node (Join-Path $RepoRoot 'scripts\package-worker.mjs')
    if ($LASTEXITCODE -ne 0) { Fail 'Packaging failed.' }
  }
}
if (-not (Test-Path (Join-Path $SourceDir 'dist\main.js'))) { Fail "No packaged worker found in $SourceDir" }

$Version = (Get-Content -Raw (Join-Path $SourceDir 'VERSION')).Trim()
if (-not $Version) { Fail "No VERSION file in $SourceDir" }

# Layout (see docs/DECISIONS.md D-017): launcher.js + state.json + app\<version>\ per installed version.
Step "Installing version $Version to $InstallDir"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$StateFile = Join-Path $InstallDir 'state.json'
if ((Test-Path (Join-Path $InstallDir 'dist\main.js')) -and -not (Test-Path $StateFile)) {
  # Older flat layout: replace it (configuration and credentials live in the data directory, not here).
  Get-ChildItem -Force $InstallDir | Remove-Item -Recurse -Force
}
$AppDir = Join-Path $InstallDir "app\$Version"
& robocopy $SourceDir $AppDir /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "Copy failed (robocopy exit $LASTEXITCODE)" }
Copy-Item -Force (Join-Path $SourceDir 'dist\launcher.js') (Join-Path $InstallDir 'launcher.js')
$Launcher = Join-Path $InstallDir 'launcher.js'

# Make this version current; the one it replaces stays as "previous" for rollback.
& node $Launcher record-install $Version
if ($LASTEXITCODE -ne 0) { Fail 'Could not record the installed version.' }

# agentctl shim for the current user (always runs the current version's CLI)
$Bin = Join-Path $InstallDir 'bin'
New-Item -ItemType Directory -Force -Path $Bin | Out-Null
Set-Content -Encoding ascii -Path (Join-Path $Bin 'agentctl.cmd') -Value "@echo off`r`n`"$($node.Source)`" `"$Launcher`" agentctl %*"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $NoPath -and -not ($userPath -split ';' | Where-Object { $_ -eq $Bin })) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$Bin", 'User')
  Write-Host "    Added $Bin to your user PATH (open a new terminal to use agentctl)"
}

if (-not $NoService) {
  Step "Registering scheduled task '$TaskName' (runs at logon as $env:USERNAME, started again within a minute if it stops)"
  $action = New-ScheduledTaskAction -Execute $node.Source -Argument "`"$Launcher`"" -WorkingDirectory $InstallDir
  # At logon, and every minute: Task Scheduler's restart-on-failure only covers a task that fails to
  # start, not a process that dies later. With MultipleInstances IgnoreNew the minute trigger does nothing
  # while the worker runs, and starts it again within a minute if it stopped.
  $trigger = @(
    (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1))
  )
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Agent Orchestration worker (local UI on 127.0.0.1:47821)' -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Step 'Waiting for the worker to start'
  $ok = $false
  foreach ($i in 1..30) {
    try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:47821/' -TimeoutSec 2 | Out-Null; $ok = $true; break } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $ok) { Write-Warning 'The worker did not answer on 127.0.0.1:47821 yet. Check Task Scheduler and the worker data directory for logs.' }
}

$urlOut = & node $Launcher --print-ui-url | Select-Object -Last 1
if ($LASTEXITCODE -ne 0 -or -not $urlOut) { Fail "The installed worker failed to run (node `"$Launcher`" --print-ui-url). See the error above." }
$url = "$urlOut".Trim()
if (-not $NoBrowser -and -not $NoService) {
  Step 'Opening the local UI to connect this worker'
  Start-Process $url
}
Step 'Diagnostics'
if (-not $NoService) { & node $Launcher agentctl doctor }
Write-Host ''
Write-Host "Installed. Local UI: http://127.0.0.1:47821 (use the link above or run: agentctl worker status)" -ForegroundColor Green
Write-Host "Uninstall with: installers\windows\uninstall-worker.ps1"
