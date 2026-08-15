<#
  The Forge - Windows uninstaller (PowerShell).

    .\uninstall.ps1

  Parameters:
    -Purge      Delete configuration (.env) and user database (data\)
    -NoPause    Do not wait for a keypress at the end
#>
[CmdletBinding()]
param(
  [switch]$Purge,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$script:Dir = $PSScriptRoot
if (-not $script:Dir) { $script:Dir = (Get-Location).Path }

function Step($m) { Write-Host "> $m"  -ForegroundColor Cyan }
function Ok($m)   { Write-Host "+ $m"  -ForegroundColor Green }
function Warn($m) { Write-Host "! $m"  -ForegroundColor Yellow }

function Finish([int]$code) {
  if (-not $NoPause) {
    Write-Host ''
    try { Read-Host 'Press Enter to close this window' | Out-Null } catch {}
  }
  exit $code
}

try {
  Write-Host ''
  Write-Host '   The Forge' -ForegroundColor DarkYellow
  Write-Host '   ---------------------------------------' -ForegroundColor DarkGray
  Write-Host '   Self-hosted habit tracker - Windows uninstaller' -ForegroundColor DarkGray
  Write-Host ''

  Set-Location $script:Dir

  # 1. Scheduled Task cleanup
  try {
    $task = Get-ScheduledTask -TaskName 'The Forge' -ErrorAction SilentlyContinue
    if ($task) {
      Step 'Removing Scheduled Task "The Forge"...'
      Unregister-ScheduledTask -TaskName 'The Forge' -Confirm:$false
      Ok 'Scheduled Task removed'
    }
  } catch {
    Warn "Could not remove Scheduled Task: $($_.Exception.Message)"
  }

  # 2. Start Menu shortcut cleanup
  try {
    $programs = [Environment]::GetFolderPath('Programs')
    $lnk = Join-Path $programs 'The Forge.lnk'
    if (Test-Path $lnk) {
      Step 'Removing Start Menu shortcut...'
      Remove-Item -Path $lnk -Force
      Ok 'Start Menu shortcut removed'
    }
  } catch {
    Warn "Could not remove Start Menu shortcut: $($_.Exception.Message)"
  }

  # 3. node_modules cleanup
  if (Test-Path 'node_modules') {
    Step 'Removing node_modules directory...'
    Remove-Item -Path 'node_modules' -Recurse -Force -ErrorAction SilentlyContinue
    Ok 'node_modules removed'
  }

  # 4. Handle configuration & database files
  if (-not $Purge) {
    if ((Test-Path '.env') -or (Test-Path '.env.sync') -or (Test-Path 'data')) {
      Write-Host ''
      $ans = Read-Host 'Do you also want to delete your configuration (.env) and database (data\)? [y/N]'
      if ($ans -match '^[Yy]') {
        $Purge = $true
      }
    }
  }

  if ($Purge) {
    Step 'Purging configuration and data files...'
    if (Test-Path '.env') { Remove-Item -Path '.env' -Force }
    if (Test-Path '.env.sync') { Remove-Item -Path '.env.sync' -Force }
    if (Test-Path 'data') { Remove-Item -Path 'data' -Recurse -Force -ErrorAction SilentlyContinue }
    Ok 'Configuration and database deleted'
  } else {
    Ok 'Preserved .env, .env.sync, and data\ directory'
  }

  Write-Host ''
  Write-Host '+ The Forge has been uninstalled.' -ForegroundColor Green
  Write-Host ''
  Finish 0
} catch {
  Write-Host ''
  Write-Host '============================================================' -ForegroundColor Red
  Write-Host '  The Forge uninstaller hit an error.' -ForegroundColor Red
  Write-Host '============================================================' -ForegroundColor Red
  Write-Host ("  {0}" -f $_.Exception.Message) -ForegroundColor Yellow
  Write-Host ''
  Finish 1
}
