@echo off
REM The Forge - double-clickable Windows uninstaller.
REM This wrapper ensures execution policy bypass and keeps the window open.
setlocal
title The Forge uninstaller
cd /d "%~dp0"

if exist "%~dp0uninstall.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" -NoPause %*
) else (
  echo Could not find uninstall.ps1 script in %~dp0
)

echo.
echo ============================================================
echo   Uninstaller finished.
echo ============================================================
pause
