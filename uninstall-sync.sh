#!/bin/bash
set -e

# Color definitions for terminal output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PLIST_PATH="${HOME}/Library/LaunchAgents/com.theforge.sync.plist"

# 1. Unload launchd service (ignore errors if not loaded)
launchctl unload "${PLIST_PATH}" 2>/dev/null || true

# 2. Remove launchd plist file
rm -f "${PLIST_PATH}"

# 3. Print success message
echo -e "${GREEN}✓ Forge sync launchd service successfully uninstalled.${NC}"
echo -e "${YELLOW}Note: .env.sync configuration file was preserved.${NC}"
