#!/bin/bash

# Configuration
DB_FILE="/path/to/the-forge/data/database.sqlite"
NEXTCLOUD_URL="https://your-nextcloud-instance.com/remote.php/dav/files/user/Backups"
NEXTCLOUD_USER="your_username"
NEXTCLOUD_PASS="your_app_password"
BACKUP_NAME="life-control-center-$(date +%Y%m%d).sqlite"

# Check if DB exists
if [ ! -f "$DB_FILE" ]; then
    echo "Database file not found at $DB_FILE"
    exit 1
fi

# Upload to Nextcloud
echo "Backing up $DB_FILE to Nextcloud..."
curl -u "$NEXTCLOUD_USER:$NEXTCLOUD_PASS" -T "$DB_FILE" "$NEXTCLOUD_URL/$BACKUP_NAME"

if [ $? -eq 0 ]; then
    echo "Backup successful: $BACKUP_NAME"
else
    echo "Backup failed"
    exit 1
fi
