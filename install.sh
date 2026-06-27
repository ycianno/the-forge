#!/usr/bin/env bash
#
# The Forge — bare-metal installer.
#
#   curl -fsSL https://raw.githubusercontent.com/ycianno/the-forge/main/install.sh | bash
#
# or, from inside a cloned repo:   ./install.sh
#
# Options:
#   --service        install + enable a systemd service so it runs on boot (Linux)
#   <target-dir>     install location (default: ~/the-forge)
#
set -euo pipefail

REPO="https://github.com/ycianno/the-forge.git"
DEFAULT_DIR="${HOME}/the-forge"

# ---- colors (only when attached to a terminal) ----
if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; A=$'\033[38;5;208m'; C=$'\033[36m'; Y=$'\033[33m'; G=$'\033[32m'; R=$'\033[0m'
else
  B=''; D=''; A=''; C=''; Y=''; G=''; R=''
fi
step() { printf '%s▸%s %s\n' "$B" "$R" "$1"; }
ok()   { printf '%s✓%s %s\n' "$G" "$R" "$1"; }
die()  { printf '%s✗ %s%s\n' "$Y" "$1" "$R" >&2; exit 1; }

# read from the real terminal even when run via `curl | bash`
TTY="/dev/tty"
[ -e "$TTY" ] || TTY=""

# ---- 0. parse args ----
WANT_SERVICE=0
DIR_ARG=""
for arg in "$@"; do
  case "$arg" in
    --service) WANT_SERVICE=1 ;;
    -h|--help) printf 'Usage: install.sh [--service] [target-dir]\n'; exit 0 ;;
    -*) die "Unknown option: $arg" ;;
    *)  DIR_ARG="$arg" ;;
  esac
done

# ---- install + enable a systemd unit so The Forge runs on boot ----
install_service() {
  command -v systemctl >/dev/null 2>&1 || die "--service needs systemd (Linux); systemctl not found."
  [ -f .env ] || die "No .env found in ${DIR} — set a password first, then re-run."
  NODE_BIN="$(command -v node)"
  SVC_USER="${SUDO_USER:-$(id -un)}"
  step "Installing systemd service ${C}the-forge.service${R} (user: ${SVC_USER})"
  sudo tee /etc/systemd/system/the-forge.service >/dev/null <<EOF
[Unit]
Description=The Forge
After=network.target

[Service]
WorkingDirectory=${DIR}
ExecStart=${NODE_BIN} server.js
Restart=always
User=${SVC_USER}

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now the-forge
  ok "Service enabled and started"
  printf '  %sStatus:%s  sudo systemctl status the-forge\n' "$B" "$R"
  printf '  %sLogs:%s    journalctl -u the-forge -f\n' "$B" "$R"
}

printf '\n'
printf '%s   ⚒  T H E   F O R G E%s\n' "$A" "$R"
printf '%s   ─────────────────────────────────────%s\n' "$D" "$R"
printf '%s   Self-hosted habit tracker — terminal installer%s\n\n' "$D" "$R"

# ---- 1. prerequisites ----
command -v node >/dev/null 2>&1 || die "Node.js 20+ is required. Get it from https://nodejs.org, then re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20+ required (found $(node -v)). Please upgrade."
command -v npm  >/dev/null 2>&1 || die "npm is required (it ships with Node.js)."
ok "Node $(node -v) detected"

# ---- 2. locate the source (install in place, or clone) ----
if [ -f package.json ] && grep -q '"name": "the-forge"' package.json 2>/dev/null; then
  DIR="$(pwd)"
  step "Installing in the current directory"
else
  command -v git >/dev/null 2>&1 || die "git is required to download The Forge."
  DIR="${DIR_ARG:-$DEFAULT_DIR}"
  if [ -d "$DIR/.git" ]; then
    step "Updating existing install at ${C}${DIR}${R}"
    git -C "$DIR" pull --ff-only --quiet
  else
    step "Downloading into ${C}${DIR}${R}"
    git clone --depth 1 --quiet "$REPO" "$DIR"
  fi
  cd "$DIR"
fi
DIR="$(pwd -P)"   # normalize to an absolute path for the systemd unit

# ---- 3. dependencies ----
step "Installing dependencies (compiles a small native module, ~1 min)…"
npm install --omit=dev --no-audit --no-fund --silent
ok "Dependencies installed"

# ---- 4. password / .env ----
if [ -f .env ]; then
  ok ".env already present — keeping your settings"
elif [ -n "$TTY" ]; then
  printf '\n%sChoose a password to protect your dashboard:%s\n' "$B" "$R"
  PW=""
  while [ -z "$PW" ]; do
    printf '  Password: '
    IFS= read -rs PW < "$TTY"; printf '\n'
  done
  printf 'APP_PASSWORD=%s\nPORT=3007\n' "$PW" > .env
  ok "Saved .env"
else
  printf 'APP_PASSWORD=changeme\nPORT=3007\n' > .env
  printf '%s⚠  No terminal for input — set a password in %s/.env before exposing this.%s\n' "$Y" "$DIR" "$R"
fi

# ---- 5. optional: run on boot via systemd ----
if [ "$WANT_SERVICE" -eq 1 ]; then
  printf '\n'
  install_service
  printf '\n%s✓ The Forge is installed and running on boot.%s\n' "$G" "$R"
  printf '  %sThen open:%s  %shttp://localhost:3007%s\n\n' "$B" "$R" "$C" "$R"
  exit 0
fi

# ---- 6. done ----
printf '\n%s✓ The Forge is installed.%s\n\n' "$G" "$R"
printf '  %sStart it:%s   cd %s && npm start\n' "$B" "$R" "$DIR"
printf '  %sThen open:%s  %shttp://localhost:3007%s\n' "$B" "$R" "$C" "$R"
printf '  %sOn boot:%s    re-run with %s--service%s, or see the systemd example in the README\n\n' "$B" "$R" "$C" "$R"

if [ -n "$TTY" ]; then
  printf '  Start The Forge now? [Y/n] '
  read -r ANS < "$TTY" || ANS="n"
  case "${ANS:-Y}" in
    [Nn]*) printf '  %sRun "npm start" when you are ready.%s\n\n' "$D" "$R" ;;
    *)     printf '\n'; exec npm start ;;
  esac
fi
