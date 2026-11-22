#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
INFO_FILE="$SCRIPT_DIR/tmp/info.txt"

if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: Run this script as root."
    exit 1
fi

if ! command -v mysqladmin >/dev/null 2>&1 && ! command -v apache2ctl >/dev/null 2>&1; then
    if [[ -f "$INFO_FILE" ]]; then
        sed -i 's/^status:.*/status:uninstalled/' "$INFO_FILE"
    fi
    echo "MySQL and Apache are not installed."
    exit 0
fi

for cmd in mysqladmin service apache2ctl pgrep; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "ERROR: Required command not found: $cmd"
        exit 1
    fi
done

FAILED=false

if pgrep -x apache2 >/dev/null 2>&1; then
    echo "Stopping Apache..."
    apache2ctl -k stop >/dev/null 2>&1 || true
    if pgrep -x apache2 >/dev/null 2>&1; then
        service apache2 stop >/dev/null 2>&1 || true
    fi

    for ((attempt = 1; attempt <= 15; attempt += 1)); do
        if ! pgrep -x apache2 >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done

    if pgrep -x apache2 >/dev/null 2>&1; then
        echo "ERROR: Apache is still running."
        FAILED=true
    else
        echo "Apache: Stopped"
    fi
else
    echo "Apache: Already stopped"
fi

if mysqladmin ping --silent >/dev/null 2>&1; then
    echo "Stopping MySQL..."
    service mysql stop >/dev/null 2>&1 || true
fi

if mysqladmin ping --silent >/dev/null 2>&1; then
    mysqladmin --protocol=socket -uroot shutdown >/dev/null 2>&1 || true
fi

for ((attempt = 1; attempt <= 30; attempt += 1)); do
    if ! mysqladmin ping --silent >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

if mysqladmin ping --silent >/dev/null 2>&1; then
    echo "ERROR: MySQL is still running."
    FAILED=true
else
    echo "MySQL: Stopped"
fi

if [[ "$FAILED" == true ]]; then
    exit 1
fi

if [[ -f "$INFO_FILE" ]]; then
    sed -i 's/^status:.*/status:stopped/' "$INFO_FILE"
fi

echo "Services stopped."
