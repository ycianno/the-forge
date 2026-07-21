#!/bin/bash
set -e

# Color definitions for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}==> Installing The Forge Apple Reminders sync service...${NC}"

# 1. Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed. Please install Node.js to use sync service.${NC}"
    exit 1
fi

NODE_PATH=$(which node)

# 2. Determine absolute path to the script's directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.sync"
PLIST_PATH="${HOME}/Library/LaunchAgents/com.theforge.sync.plist"

# 3. Check for .env.sync; prompt user if it does not exist
if [ ! -f "${ENV_FILE}" ]; then
    echo -e "${YELLOW}.env.sync not found. Setting up configuration...${NC}"

    # Prompt for FORGE_URL (default: http://localhost:3007)
    echo -ne "${YELLOW}Enter FORGE_URL [http://localhost:3007]: ${NC}"
    read -r FORGE_URL
    FORGE_URL="${FORGE_URL:-http://localhost:3007}"

    # Prompt for FORGE_SYNC_TOKEN (required, no default)
    FORGE_SYNC_TOKEN=""
    while [ -z "${FORGE_SYNC_TOKEN}" ]; do
        echo -ne "${YELLOW}Enter FORGE_SYNC_TOKEN (required): ${NC}"
        read -r FORGE_SYNC_TOKEN
        if [ -z "${FORGE_SYNC_TOKEN}" ]; then
            echo -e "${RED}Error: FORGE_SYNC_TOKEN cannot be empty.${NC}"
        fi
    done

    # Write configuration file
    cat <<EOF > "${ENV_FILE}"
FORGE_URL=${FORGE_URL}
FORGE_SYNC_TOKEN=${FORGE_SYNC_TOKEN}
EOF
    echo -e "${GREEN}✓ Created configuration file: ${ENV_FILE}${NC}"
fi

# 4. Ensure LaunchAgents directory exists
mkdir -p "${HOME}/Library/LaunchAgents"

# 5. Create launchd plist file
cat <<EOF > "${PLIST_PATH}"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.theforge.sync</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${SCRIPT_DIR}/sync-reminders.js</string>
    </array>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${SCRIPT_DIR}</string>
    <key>StandardOutPath</key>
    <string>/tmp/forge-sync.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/forge-sync.log</string>
</dict>
</plist>
EOF

# 6. Unload old plist if it exists (ignore errors)
launchctl unload "${PLIST_PATH}" 2>/dev/null || true

# 7. Load new plist
launchctl load "${PLIST_PATH}"

# 8. Print success message and instructions
echo -e "${GREEN}✓ Launchd sync job successfully installed and started!${NC}"
echo -e "${GREEN}  Sync runs automatically every 5 minutes (300 seconds).${NC}"
echo -e "  Logs: ${YELLOW}tail -f /tmp/forge-sync.log${NC}"
echo -e "  Uninstall: ${YELLOW}${SCRIPT_DIR}/uninstall-sync.sh${NC}"
