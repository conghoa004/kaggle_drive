#!/usr/bin/env bash

set -Eeuo pipefail

# ==========================================
# Configuration
# ==========================================

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$SCRIPT_DIR/tmp"

LOCAL_BIN="$HOME/.local/bin"

CONFIG_FILE="$TMP_DIR/config.yaml"
PID_FILE="$TMP_DIR/code-server.pid"
INFO_FILE="$TMP_DIR/info.txt"

START_LOG="$TMP_DIR/start.log"
SERVER_LOG="$TMP_DIR/server.log"

# ==========================================
# Initialization
# ==========================================

mkdir -p "$TMP_DIR"

touch "$START_LOG" "$SERVER_LOG"

chmod 600 "$START_LOG" "$SERVER_LOG"

exec > >(tee -a "$START_LOG") 2>&1

export PATH="$LOCAL_BIN:$PATH"

# ==========================================
# Logging
# ==========================================

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

die() {
    log "ERROR: $*"
    exit 1
}

# ==========================================
# Read info
# ==========================================

get_info() {
    local key="$1"

    [[ -f "$INFO_FILE" ]] || return 1

    sed -n "s/^${key}=//p" "$INFO_FILE" | head -n 1
}

# ==========================================
# Dependencies
# ==========================================

command -v curl >/dev/null 2>&1 || \
    die "curl is required."

command -v python3 >/dev/null 2>&1 || \
    die "python3 is required."

[[ -f "$CONFIG_FILE" ]] || \
    die "Configuration not found. Run install.sh first."

CODE_SERVER_BIN="$(command -v code-server || true)"

[[ -n "$CODE_SERVER_BIN" ]] || \
    die "code-server is not installed. Run install.sh first."

# ==========================================
# Load configuration
# ==========================================

HOST="$(sed -n 's/^bind-addr: \([^:]*\):.*/\1/p' "$CONFIG_FILE" | head -n 1)"
PORT="$(sed -n 's/^bind-addr: [^:]*:\([0-9]*\)$/\1/p' "$CONFIG_FILE" | head -n 1)"

PASSWORD="$(sed -n 's/^password:[[:space:]]*//p' "$CONFIG_FILE" | head -n 1)"

WORKSPACE="${KAGGLE_WORKING_DIR:-$(get_info WORKSPACE || echo /kaggle/working)}"

[[ -n "$HOST" && -n "$PORT" && -n "$PASSWORD" ]] || \
    die "Invalid code-server configuration."

HEALTH_URL="http://${HOST}:${PORT}/healthz"

mkdir -p "$WORKSPACE"

# ==========================================
# Process management
# ==========================================

read_cmdline() {
    local pid="$1"

    [[ -r "/proc/$pid/cmdline" ]] || return 1

    tr '\0' ' ' < "/proc/$pid/cmdline"
}

is_healthy() {
    curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1
}

if is_healthy; then
    die "Something is already responding at $HEALTH_URL."
fi

if [[ -f "$PID_FILE" ]]; then

    OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    OLD_CMD=""

    if [[ "$OLD_PID" =~ ^[0-9]+$ ]]; then
        OLD_CMD="$(read_cmdline "$OLD_PID" 2>/dev/null || true)"
    fi

    if [[ "$OLD_CMD" == *"$CONFIG_FILE"* ]]; then
        die "code-server is already running with PID $OLD_PID."
    fi

    rm -f "$PID_FILE"
fi

# ==========================================
# Start server
# ==========================================

log "Starting code-server..."
log "Host      : $HOST"
log "Port      : $PORT"
log "Workspace : $WORKSPACE"

if command -v setsid >/dev/null 2>&1; then

    setsid "$CODE_SERVER_BIN" \
        --config "$CONFIG_FILE" \
        --disable-telemetry \
        "$WORKSPACE" >> "$SERVER_LOG" 2>&1 &

else

    "$CODE_SERVER_BIN" \
        --config "$CONFIG_FILE" \
        --disable-telemetry \
        "$WORKSPACE" >> "$SERVER_LOG" 2>&1 &

fi

PID=$!

echo "$PID" > "$PID_FILE"
chmod 600 "$PID_FILE"

# ==========================================
# Health check
# ==========================================

READY=0

for i in $(seq 1 30); do

    if is_healthy; then
        READY=1
        break
    fi

    if ! kill -0 "$PID" 2>/dev/null; then
        break
    fi

    sleep 1
done

if [[ "$READY" != "1" ]]; then

    log "Startup failed."

    if command -v setsid >/dev/null 2>&1; then
        kill -TERM -- "-$PID" 2>/dev/null || true
    else
        kill -TERM "$PID" 2>/dev/null || true
    fi

    rm -f "$PID_FILE"