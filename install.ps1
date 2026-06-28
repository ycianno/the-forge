<#
  The Forge — Windows installer (PowerShell).

    irm https://raw.githubusercontent.com/ycianno/the-forge/main/install.ps1 | iex

  or, from inside a cloned repo:   .\install.ps1

  Parameters (only when run as a downloaded file, not via irm | iex):
    -Service        register a Scheduled Task so The Forge starts at logon
    -Dir <path>     install location (default: %USERPROFILE%\the-forge)

  No Docker, no WSL, no Visual Studio required: better-sqlite3 ships prebuilt
  binaries for current Node LTS on Windows x64.
#>
[CmdletBinding()]
param(
  [switch]$Service,
  [string]$Dir
)

$ErrorActionPreference = 'Stop'
$Repo = 'https://github.com/ycianno/the-forge.git'
$DefaultDir = Join-Path $env:USERPROFILE 'the-forge'

function Step($m) { Write-Host "> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "+ $m" -ForegroundColor Green }
function Die($m)  { Write-Host "x $m" -ForegroundColor Yellow; exit 1 }

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

Write-Host ''
Write-Host '   The Forge' -ForegroundColor DarkYellow
Write-Host '   ---------------------------------------' -ForegroundColor DarkGray
Write-Host '   Self-hosted habit tracker - Windows installer' -ForegroundColor DarkGray
Write-Host ''

# ---- 1. Node.js 20+ (offer to install via winget) ----
function Get-NodeMajor {
  if (Get-Command node -ErrorAction SilentlyContinue) {
    return [int](node -p "process.versions.node.split('.')[0]")
  }
  return 0
}

$nodeMajor = Get-NodeMajor
if ($nodeMajor -lt 20) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Step 'Node.js 20+ not found - installing the LTS via winget...'
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    Refresh-Path
    $nodeMajor = Get-NodeMajor
  } else {
    Die 'Node.js 20+ is required. Install it from https://nodejs.org (LTS), then re-run.'
  }
}
if ($nodeMajor -lt 20) {
  Die 'Node.js 20+ still not detected. Close and reopen PowerShell (so PATH refreshes), then re-run.'
}
Ok "Node $(node -v) detected"

# ---- 2. locate the source (install in place, or clone) ----
$inPlace = (Test-Path package.json) -and (Select-String -Path package.json -Pattern '"name":\s*"the-forge"' -Quiet)
if ($inPlace) {
  $Dir = (Get-Location).Path
  Step 'Installing in the current directory'
} else {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      Step 'git not found - installing via winget...'
      winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
      Refresh-Path
    }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
      Die 'git is required to download The Forge. Install it from https://git-scm.com, then re-run.'
    }
  }
  if (-not $Dir) { $Dir = $DefaultDir }
  if (Test-Path (Join-Path $Dir '.git')) {
    Step "Updating existing install at $Dir"
    git -C $Dir pull --ff-only --quiet
  } else {
    Step "Downloading into $Dir"
    git clone --depth 1 --quiet $Repo $Dir
  }
  Set-Location $Dir
}
$Dir = (Get-Location).Path

# ---- 3. dependencies (prebuilt native module, no compiler needed) ----
Step 'Installing dependencies (~1 min)...'
npm install --omit=dev --no-audit --no-fund --silent
if ($LASTEXITCODE -ne 0) { Die 'npm install failed.' }
Ok 'Dependencies installed'

# ---- 4. password / .env ----
if (Test-Path .env) {
  Ok '.env already present - keeping your settings'
} else {
  Write-Host ''
  Write-Host 'Choose a password to protect your dashboard:' -ForegroundColor White
  $pw = ''
  while (-not $pw) {
    $secure = Read-Host '  Password' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  "APP_PASSWORD=$pw`r`nPORT=3007" | Set-Content -Path .env -Encoding ascii
  Ok 'Saved .env'
}

# ---- 5. Start Menu shortcut ----
try {
  $nodeExe  = (Get-Command node).Source
  $programs = [Environment]::GetFolderPath('Programs')
  $lnk      = Join-Path $programs 'The Forge.lnk'
  $ws       = New-Object -ComObject WScript.Shell
  $sc       = $ws.CreateShortcut($lnk)
  $sc.TargetPath       = $nodeExe
  $sc.Arguments        = 'server.js'
  $sc.WorkingDirectory = $Dir
  $sc.Description       = 'The Forge'
  $iconPng = Join-Path $Dir 'public\favicon.ico'
  if (Test-Path $iconPng) { $sc.IconLocation = $iconPng }
  $sc.Save()
  Ok 'Start Menu shortcut created ("The Forge")'
} catch {
  Write-Host "  (Could not create Start Menu shortcut: $($_.Exception.Message))" -ForegroundColor DarkGray
}

# ---- 6. optional: run at logon via Scheduled Task ----
if ($Service) {
  try {
    $nodeExe = (Get-Command node).Source
    $action  = New-ScheduledTaskAction -Execute $nodeExe -Argument 'server.js' -WorkingDirectory $Dir
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName 'The Forge' -Action $action -Trigger $trigger -Settings $set -Force | Out-Null
    Start-ScheduledTask -TaskName 'The Forge'
    Ok 'Scheduled Task "The Forge" registered - starts at logon and is running now'
    Write-Host ''
    Write-Host '+ The Forge is installed and running.' -ForegroundColor Green
    Write-Host '  Then open:  http://localhost:3007' -ForegroundColor Cyan
    Write-Host '  Manage:     Task Scheduler -> "The Forge"' -ForegroundColor White
    Write-Host ''
    exit 0
  } catch {
    Write-Host "  (Could not register Scheduled Task: $($_.Exception.Message))" -ForegroundColor Yellow
    Write-Host '  You can still start it manually below.' -ForegroundColor DarkGray
  }
}

# ---- 7. done ----
Write-Host ''
Write-Host '+ The Forge is installed.' -ForegroundColor Green
Write-Host ''
Write-Host "  Start it:   cd `"$Dir`"; npm start" -ForegroundColor White
Write-Host '  Then open:  http://localhost:3007' -ForegroundColor Cyan
Write-Host '  At logon:   re-run with -Service (or use the Start Menu shortcut)' -ForegroundColor White
Write-Host ''

$ans = Read-Host 'Start The Forge now? [Y/n]'
if ($ans -match '^[Nn]') {
  Write-Host '  Run "npm start" when you are ready.' -ForegroundColor DarkGray
} else {
  Write-Host ''
  npm start
}
