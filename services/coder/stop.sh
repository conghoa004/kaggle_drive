#!/usr/bin/env bash

set -Eeuo pipefail

# ==========================================
# Configuration
# ==========================================

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$SCRIPT_DIR/tmp"

CONFIG_FILE="$TMP_DIR/config.yaml"
PID_FILE="$TMP_DIR/code-server.pid"
INFO_FILE="$TMP_DIR/info.txt"

STOP_LOG="$TMP_DIR/stop.log"

# ==========================================
# Initialization
# ==========================================

mkdir -p "$TMP_DIR"
touch "$STOP_LOG"
chmod 600 "$STOP_LOG"

exec > >(tee -a "$STOP_LOG") 2>&1

# ==========================================
# Logging
# ==========================================

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

# ==========================================
# Process management
# ==========================================

if [[ ! -f "$PID_FILE" ]]; then
    log "code-server is not running."
    exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"

if [[ ! "$PID" =~ ^[0-9]+$ ]]; then
    log "Invalid PID file."
    rm -f "$PID_FILE"
    exit 1
fi

if [[ ! -r "/proc/$PID/cmdline" ]]; then

    log "Process no longer exists."

else

    CMDLINE="$(tr '\0' ' ' < "/proc/$PID/cmdline")"

    if [[ "$CMDLINE" != *"$CONFIG_FILE"* ]]; then
        log "PID does not belong to this code-server instance."
        exit 1
    fi

    log "Stopping code-server PID $PID..."

    # Prefer stopping the dedicated process group.
    if kill -0 -- "-$PID" 2>/dev/null; then
        kill -TERM -- "-$PID"
    else
        kill -TERM "$PID"
    fi

    STOPPED=0

    for i in $(seq 1 10); do

        if ! kill -0 "$PID" 2>/dev/null; then
            STOPPED=1
            break
        fi

        sleep 1
    done

    if [[ "$STOPPED" != "1" ]]; then

        log "Graceful shutdown timed out."

        if kill -0 -- "-$PID" 2>/dev/null; then
            kill -KILL -- "-$PID" 2>/dev/null || true
        else
            kill -KILL "$PID" 2>/dev/null || true
        fi

    fi

fi

# ==========================================
# Update state
# ==========================================

rm -f "$PID_FILE"

if [[ -f "$INFO_FILE" ]]; then

    sed -i \
        -e 's/^STATUS=.*/STATUS=stopped/' \
        -e 's/^PID=.*/PID=/' \
        "$INFO_FILE"

fi

log "=========================================="
log "code-server stopped."
log "=========================================="

log "Configuration preserved."
log "Password preserved."
log "Info preserved."