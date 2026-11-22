#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$SCRIPT_DIR/tmp"

PID_FILE="$TMP_DIR/run/code-server.pid"
INFO_FILE="$TMP_DIR/info/server.info"
CONFIG_FILE="$TMP_DIR/config/config.yaml"
LOG_FILE="$TMP_DIR/logs/stop.log"

mkdir -p "$TMP_DIR/logs"
touch "$LOG_FILE"

exec > >(tee -a "$LOG_FILE") 2>&1

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

if [[ ! -f "$PID_FILE" ]]; then
    log "code-server is not running."
    exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"

if [[ ! "$PID" =~ ^[0-9]+$ ]]; then
    log "Invalid PID file."
    rm -f "$PID_FILE"
    exit 0
fi

if [[ ! -r "/proc/$PID/cmdline" ]]; then
    log "Process no longer exists."
else
    CMDLINE="$(tr '\0' ' ' < "/proc/$PID/cmdline")"

    if [[ "$CMDLINE" != *"$CONFIG_FILE"* ]]; then
        log "PID does not belong to this code-server instance."
        rm -f "$PID_FILE"
        exit 1
    fi

    log "Stopping code-server PID $PID..."

    kill -TERM -- "-$PID" 2>/dev/null || \
        kill -TERM "$PID" 2>/dev/null || true

    STOPPED=0

    for i in $(seq 1 10); do
        if ! kill -0 "$PID" 2>/dev/null; then
            STOPPED=1
            break
        fi
        sleep 1
    done

    if [[ "$STOPPED" != "1" ]]; then
        log "Force stopping code-server..."
        kill -KILL -- "-$PID" 2>/dev/null || \
            kill -KILL "$PID" 2>/dev/null || true
    fi
fi

rm -f "$PID_FILE"

if [[ -f "$INFO_FILE" ]]; then
    sed -i \
        -e 's/^STATUS=.*/STATUS=stopped/' \
        -e 's/^PID=.*/PID=/' \
        "$INFO_FILE"
fi

log "code-server stopped."
log "Configuration and password have been preserved."