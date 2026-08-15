#!/usr/bin/env bash
#
# The Forge — bare-metal uninstaller.
#
#   ./uninstall.sh
#
# Options:
#   --purge          Delete configuration (.env, .env.sync) and user database (data/)
#   -h, --help       Show help
#
set -euo pipefail

# ---- colors (only when attached to a terminal) ----
if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; A=$'\033[38;5;208m'; C=$'\033[36m'; Y=$'\033[33m'; G=$'\033[32m'; R=$'\033[0m'
else
  B=''; D=''; A=''; C=''; Y=''; G=''; R=''
fi
step() { printf '%s▸%s %s\n' "$B" "$R" "$1"; }
ok()   { printf '%s✓%s %s\n' "$G" "$R" "$1"; }
warn() { printf '%s!%s %s\n' "$Y" "$R" "$1"; }

TTY="/dev/tty"
[ -e "$TTY" ] || TTY=""

PURGE=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    -h|--help) printf 'Usage: uninstall.sh [--purge]\n'; exit 0 ;;
    *) warn "Unknown option: $arg" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"

printf '\n'
printf '%s   ⚒  T H E   F O R G E%s\n' "$A" "$R"
printf '%s   ─────────────────────────────────────%s\n' "$D" "$R"
printf '%s   Self-hosted habit tracker — uninstaller%s\n\n' "$D" "$R"

# 1. Linux systemd service cleanup
if command -v systemctl >/dev/null 2>&1 && [ -f /etc/systemd/system/the-forge.service ]; then
  step "Removing systemd service ${C}the-forge.service${R}…"
  sudo systemctl stop the-forge 2>/dev/null || true
  sudo systemctl disable the-forge 2>/dev/null || true
  sudo rm -f /etc/systemd/system/the-forge.service
  sudo systemctl daemon-reload
  ok "Systemd service removed"
fi

# 2. macOS launchd sync service cleanup
PLIST_PATH="${HOME}/Library/LaunchAgents/com.theforge.sync.plist"
if [ -f "${PLIST_PATH}" ]; then
  step "Removing macOS sync launchd service…"
  launchctl unload "${PLIST_PATH}" 2>/dev/null || true
  rm -f "${PLIST_PATH}"
  ok "macOS sync launchd service removed"
fi

# 3. Clean dependencies (node_modules)
if [ -d "node_modules" ]; then
  step "Removing ${C}node_modules${R} directory…"
  rm -rf node_modules
  ok "node_modules removed"
fi

# 4. Handle configuration & database files
if [ "$PURGE" -eq 0 ] && [ -n "$TTY" ]; then
  if [ -f ".env" ] || [ -f ".env.sync" ] || [ -d "data" ]; then
    printf '\n%sDo you also want to delete your configuration (.env) and data/database? [y/N]%s ' "$B" "$R"
    read -r ANS < "$TTY" || ANS="n"
    case "${ANS}" in
      [Yy]*) PURGE=1 ;;
      *) PURGE=0 ;;
    esac
  fi
fi

if [ "$PURGE" -eq 1 ]; then
  step "Purging configuration and data files…"
  rm -f .env .env.sync
  rm -rf data
  ok "Configuration and database deleted"
else
  ok "Preserved .env, .env.sync, and data/ directory"
fi

printf '\n%s✓ The Forge has been uninstalled.%s\n\n' "$G" "$R"
