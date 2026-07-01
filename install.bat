@echo off
REM The Forge - double-clickable Windows installer.
REM This wrapper exists so the window NEVER closes before you can read it, and so
REM PowerShell's execution policy can't block the script. Just double-click it.
setlocal
title The Forge installer
cd /d "%~dp0"

if exist "%~dp0install.ps1" (
  REM Running from a cloned/extracted copy - use the local script.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -NoPause %*
) else (
  REM Standalone .bat - fetch the installer and run it.
  echo Downloading The Forge installer...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=(New-Object Net.WebClient).DownloadString('https://raw.githubusercontent.com/ycianno/the-forge/main/install.ps1'); & ([ScriptBlock]::Create($c)) -NoPause"
)

echo.
echo ============================================================
echo   Installer finished. Read any messages above.
echo   This window stays open on purpose - nothing is missed.
echo ============================================================
pause
