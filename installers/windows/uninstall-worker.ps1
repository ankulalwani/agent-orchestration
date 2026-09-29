<#
.SYNOPSIS  Removes the Agent Orchestrator worker for the current user.
.PARAMETER RemoveData  Also delete worker data (configuration, event buffer, encrypted credentials file) and
                       the worker entries in Windows Credential Manager. Project directories are never touched.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'AgentOrchestrator\worker-app'),
  [switch]$RemoveData
)
$ErrorActionPreference = 'Stop'
$TaskName = 'AgentOrchestratorWorker'
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task $TaskName"
}
# The launcher first (it would restart the worker), then the worker itself.
foreach ($pattern in @("*$InstallDir*launcher.js*", "*$InstallDir*main.js*")) {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like $pattern } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue }
}
if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir; Write-Host "Removed $InstallDir" }
$Bin = Join-Path $InstallDir 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
[Environment]::SetEnvironmentVariable('Path', (($userPath -split ';') | Where-Object { $_ -and $_ -ne $Bin }) -join ';', 'User')
if ($RemoveData) {
  $data = Join-Path $env:APPDATA 'AgentOrchestrator\worker'
  if (Test-Path $data) { Remove-Item -Recurse -Force $data; Write-Host "Removed worker data $data" }
  $creds = cmdkey /list | Select-String 'agent-orchestrator-worker' | ForEach-Object { ($_ -split 'target=')[1].Trim() }
  foreach ($c in $creds) { cmdkey /delete:$c | Out-Null }
  Write-Host 'Removed worker credentials from Windows Credential Manager'
} else {
  Write-Host 'Worker data and credentials were kept (use -RemoveData to delete them).'
}
# The AgentOrchestrator folders the installer created, once nothing is left in them.
foreach ($parent in @((Split-Path $InstallDir -Parent), (Join-Path $env:APPDATA 'AgentOrchestrator'))) {
  if ((Test-Path $parent) -and -not (Get-ChildItem -Force $parent)) { Remove-Item $parent }
}
