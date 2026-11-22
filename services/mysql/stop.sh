#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: Run this script as root."
    exit 1
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

echo "Services stopped."
