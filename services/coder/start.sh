#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
TMP_DIR="$SCRIPT_DIR/tmp"
LOCAL_BIN="$HOME/.local/bin"
CONFIG_FILE="$TMP_DIR/config.yaml"
PID_FILE="$TMP_DIR/code-server.pid"
INFO_FILE="$TMP_DIR/info.txt"
START_LOG="$TMP_DIR/start.log"
SERVER_LOG="$TMP_DIR/server.log"

mkdir -p "$TMP_DIR"
touch "$START_LOG" "$SERVER_LOG"
chmod 600 "$START_LOG" "$SERVER_LOG"
exec > >(tee -a "$START_LOG") 2>&1
export PATH="$LOCAL_BIN:$PATH"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

die() {
    log "ERROR: $*"
    exit 1
}

get_info() {
    local key="$1"
    [[ -f "$INFO_FILE" ]] || return 1
    sed -n "s/^${key}:[[:space:]]*//p" "$INFO_FILE" | head -n 1
}

write_info() {
    local status="$1"
    local pid="$2"
    local started_at="$3"
    local password="$4"
    local installed_at

    installed_at="$(get_info installed_at || true)"
    [[ -n "$installed_at" ]] || installed_at="$(date '+%Y-%m-%d %H:%M:%S')"

    cat > "$INFO_FILE" <<EOF
name:Code Server
description:Browser-based VS Code environment
status:${status}
host:${HOST}
port:${PORT}
url:http://${HOST}:${PORT}
workspace:${WORKSPACE}
auth:password
password:${password}
pid:${pid}
config_file:${CONFIG_FILE}
log_file:${SERVER_LOG}
installed_at:${installed_at}
started_at:${started_at}
EOF
    chmod 600 "$INFO_FILE"
}

if [[ "$(uname -s)" != "Linux" || ! -d /proc ]]; then
    die "This script requires Linux."
fi
for dependency in curl sed head tr tee seq nohup; do
    command -v "$dependency" >/dev/null 2>&1 || die "Missing dependency: $dependency"
done
[[ -f "$CONFIG_FILE" ]] || die "Configuration not found. Run install.sh first."

CODE_SERVER_BIN="$(command -v code-server 2>/dev/null || true)"
if [[ -z "$CODE_SERVER_BIN" && -x "$LOCAL_BIN/code-server" ]]; then
    CODE_SERVER_BIN="$LOCAL_BIN/code-server"
fi
[[ -n "$CODE_SERVER_BIN" ]] || die "code-server is not installed. Run install.sh first."

BIND_ADDR="$(sed -n 's/^bind-addr:[[:space:]]*//p' "$CONFIG_FILE" | head -n 1)"
HOST="${BIND_ADDR%:*}"
PORT="${BIND_ADDR##*:}"
PASSWORD="$(sed -n 's/^password:[[:space:]]*//p' "$CONFIG_FILE" | head -n 1)"
WORKSPACE="$(printenv KAGGLE_WORKING_DIR || true)"
if [[ -z "$WORKSPACE" ]]; then
    WORKSPACE="$(get_info workspace || true)"
fi
if [[ -z "$WORKSPACE" ]]; then
    WORKSPACE="/kaggle/working"
fi

[[ -n "$HOST" && -n "$PORT" && -n "$PASSWORD" ]] || die "Invalid code-server configuration."
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] && (( PORT > 0 && PORT <= 65535 )) || die "Invalid code-server port: $PORT"
HEALTH_URL="http://$HOST:$PORT/healthz"
mkdir -p "$WORKSPACE"

read_cmdline() {
    local pid="$1"
    [[ -r "/proc/$pid/cmdline" ]] || return 1
    tr '\0' ' ' < "/proc/$pid/cmdline"
}

is_healthy() {
    curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1
}

if [[ -f "$PID_FILE" ]]; then
    OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    OLD_CMD=""
    if [[ "$OLD_PID" =~ ^[0-9]+$ ]] && kill -0 "$OLD_PID" 2>/dev/null; then
        OLD_CMD="$(read_cmdline "$OLD_PID" 2>/dev/null || true)"
        if [[ "$OLD_CMD" == *"$CONFIG_FILE"* ]]; then
            if is_healthy; then
                OLD_STARTED_AT="$(get_info started_at || true)"
                [[ -n "$OLD_STARTED_AT" ]] || OLD_STARTED_AT="$(date '+%Y-%m-%d %H:%M:%S')"
                write_info running "$OLD_PID" "$OLD_STARTED_AT" "$PASSWORD"
                log "code-server is already running with PID $OLD_PID."
                exit 0
            fi
            die "code-server has PID $OLD_PID but is not healthy."
        fi
    fi
    rm -f "$PID_FILE"
fi

if is_healthy; then
    die "Another process is responding at $HEALTH_URL."
fi

log "Starting code-server at $HEALTH_URL"
nohup "$CODE_SERVER_BIN" --config "$CONFIG_FILE" --disable-telemetry "$WORKSPACE" >> "$SERVER_LOG" 2>&1 </dev/null &
PID=$!
printf '%s\n' "$PID" > "$PID_FILE"
chmod 600 "$PID_FILE"
write_info starting "$PID" "$(date '+%Y-%m-%d %H:%M:%S')" "$PASSWORD"

READY=0
for _ in $(seq 1 30); do
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
    log "Startup failed; see $SERVER_LOG."
    kill -TERM "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
    rm -f "$PID_FILE"
    write_info installed "" "" "$PASSWORD"
    exit 1
fi

write_info running "$PID" "$(date '+%Y-%m-%d %H:%M:%S')" "$PASSWORD"
log "code-server started with PID $PID."
log "Workspace: $WORKSPACE"
