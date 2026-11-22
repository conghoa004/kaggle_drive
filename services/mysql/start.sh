#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
APACHE_PORT=8081
MYSQL_SAFE_LOG=/var/log/mysql_safe.log
CREDENTIAL_FILE="$SCRIPT_DIR/tmp/phpmyadmin_credentials.txt"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: Run this script as root."
    exit 1
fi

for cmd in mysql mysqladmin service apache2ctl pgrep; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "ERROR: Required command not found: $cmd"
        echo "Run install.sh first."
        exit 1
    fi
done

if [[ ! -d /usr/share/phpmyadmin ]]; then
    echo "ERROR: phpMyAdmin is not installed."
    echo "Run install.sh first."
    exit 1
fi

if ! mysqladmin ping --silent >/dev/null 2>&1; then
    log "Starting MySQL..."
    mkdir -p /run/mysqld
    chown mysql:mysql /run/mysqld
    chmod 755 /run/mysqld
    service mysql start || true

    if ! mysqladmin ping --silent >/dev/null 2>&1; then
        if command -v mysqld_safe >/dev/null 2>&1; then
            nohup mysqld_safe --user=mysql > "$MYSQL_SAFE_LOG" 2>&1 < /dev/null &
        elif command -v mariadbd-safe >/dev/null 2>&1; then
            nohup mariadbd-safe --user=mysql > "$MYSQL_SAFE_LOG" 2>&1 < /dev/null &
        else
            echo "ERROR: No MySQL safe-start command was found."
            exit 1
        fi
    fi

    MYSQL_READY=false
    for ((attempt = 1; attempt <= 120; attempt += 1)); do
        if mysqladmin ping --silent >/dev/null 2>&1; then
            MYSQL_READY=true
            break
        fi
        sleep 1
    done

    if [[ "$MYSQL_READY" != true ]]; then
        echo "ERROR: MySQL did not become ready. Check $MYSQL_SAFE_LOG"
        exit 1
    fi
else
    log "MySQL is already running."
fi

log "Checking Apache configuration..."
apache2ctl configtest

if pgrep -x apache2 >/dev/null 2>&1; then
    apache2ctl -k graceful
else
    log "Starting Apache..."
    apache2ctl -k start
fi

APACHE_READY=false
for ((attempt = 1; attempt <= 15; attempt += 1)); do
    if pgrep -x apache2 >/dev/null 2>&1; then
        APACHE_READY=true
        break
    fi
    sleep 1
done

if [[ "$APACHE_READY" != true ]]; then
    echo "ERROR: Apache did not become ready."
    exit 1
fi

echo
echo "========================================="
echo "MYSQL AND PHPMYADMIN ARE READY"
echo "========================================="
echo "MySQL: Running"
echo "Apache: Running"
echo "MySQL host: localhost"
echo "MySQL port: 3306"
echo "phpMyAdmin: http://localhost:$APACHE_PORT/phpmyadmin"

if [[ -f "$CREDENTIAL_FILE" ]]; then
    echo
    echo "ADMINISTRATOR ACCOUNT"
    echo "-----------------------------------------"
    sed -n '/^Username:/p; /^Password:/p; /^Host:/p; /^Port:/p' "$CREDENTIAL_FILE"
    echo "Credentials file: $CREDENTIAL_FILE"
else
    echo
    echo "Administrator credentials file not found: $CREDENTIAL_FILE"
    echo "Run install.sh to create the admin account."
fi

echo
echo "MYSQL VERSION"
echo "-----------------------------------------"
mysql --version
echo "MySQL startup log: $MYSQL_SAFE_LOG"
