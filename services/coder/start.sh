#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$SCRIPT_DIR/tmp"

CONFIG_FILE="$TMP_DIR/config/config.yaml"
INFO_FILE="$TMP_DIR/info/server.info"
PID_FILE="$TMP_DIR/run/code-server.pid"
LOG_FILE="$TMP_DIR/logs/server.log"
START_LOG="$TMP_DIR/logs/start.log"

LOCAL_BIN="$HOME/.local/bin"
PORT="${CODE_SERVER_PORT:-8080}"
HOST="127.0.0.1"
WORKSPACE="${KAGGLE_WORKING_DIR:-/kaggle/working}"
HEALTH_URL="http://${HOST}:${PORT}/healthz"

mkdir -p "$TMP_DIR/logs" "$TMP_DIR/run" "$TMP_DIR/info"

touch "$START_LOG"
exec > >(tee -a "$START_LOG") 2>&1

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

die() {
    log "ERROR: $*"
    exit 1
}

export PATH="$LOCAL_BIN:$PATH"

[[ -x "$LOCAL_BIN/code-server" ]] || \
    command -v code-server >/dev/null || \
    die "code-server is not installed. Run install.sh first."

CODE_SERVER_BIN="$(command -v code-server)"

if [[ -f "$CONFIG_FILE" ]]; then
    PASSWORD="$(sed -n 's/^password:[[:space:]]*//p' "$CONFIG_FILE" | head -n 1)"
else
    PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
fi

cat > "$CONFIG_FILE" <<EOF
bind-addr: ${HOST}:${PORT}
auth: password
password: ${PASSWORD}
cert: false
EOF

chmod 600 "$CONFIG_FILE"

is_healthy() {
    curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1
}

read_cmdline() {
    local pid="$1"
    [[ -r "/proc/$pid/cmdline" ]] || return 1
    tr '\0' ' ' < "/proc/$pid/cmdline"
}

if is_healthy; then
    die "Port ${PORT} is already responding."
fi

if [[ -f "$PID_FILE" ]]; then
    OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    OLD_CMD=""

    if [[ "$OLD_PID" =~ ^[0-9]+$ ]]; then
        OLD_CMD="$(read_cmdline "$OLD_PID" 2>/dev/null || true)"
    fi

    if [[ "$OLD_CMD" == *"$CONFIG_FILE"* ]]; then
        die "code-server process already exists: PID $OLD_PID"
    fi

    rm -f "$PID_FILE"
fi

mkdir -p "$WORKSPACE"
touch "$LOG_FILE"

log "Starting code-server..."

if command -v setsid >/dev/null 2>&1; then
    setsid "$CODE_SERVER_BIN" \
        --config "$CONFIG_FILE" \
        --disable-telemetry \
        "$WORKSPACE" >> "$LOG_FILE" 2>&1 &
else
    "$CODE_SERVER_BIN" \
        --config "$CONFIG_FILE" \
        --disable-telemetry \
        "$WORKSPACE" >> "$LOG_FILE" 2>&1 &
fi

PID=$!
echo "$PID" > "$PID_FILE"

chmod 600 "$PID_FILE"

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
    kill -TERM "$PID" 2>/dev/null || true
    rm -f "$PID_FILE"
    die "code-server failed to start. Check $LOG_FILE"
fi

STARTED_AT="$(date '+%Y-%m-%d %H:%M:%S')"

cat > "$INFO_FILE" <<EOF
SERVICE=code-server
STATUS=running

HOST=${HOST}
PORT=${PORT}
URL=http://${HOST}:${PORT}

WORKSPACE=${WORKSPACE}

AUTH=password
PASSWORD=${PASSWORD}

PID=${PID}
CONFIG_FILE=${CONFIG_FILE}
LOG_FILE=${LOG_FILE}

STARTED_AT=${STARTED_AT}
EOF

chmod 600 "$INFO_FILE"

log "code-server started successfully."
log "URL: http://${HOST}:${PORT}"
log "PID: ${PID}"
log "Password: ${PASSWORD}"
log "Info: ${INFO_FILE}"