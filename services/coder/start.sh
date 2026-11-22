#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
TMP_DIR="$SCRIPT_DIR/tmp"
PORT="${CODE_SERVER_PORT:-8082}"
WORKSPACE="${KAGGLE_WORKING_DIR:-/workspaces}"
LOCAL_BIN="$HOME/.local/bin"
STATE_DIR="${CODE_SERVER_STATE_DIR:-$HOME/.local/state/kaggle-code-server}"
CONFIG_FILE="$STATE_DIR/config.yaml"
PID_FILE="$STATE_DIR/code-server.pid"
CREDENTIAL_FILE="$TMP_DIR/credentials.txt"
INFO_FILE="$TMP_DIR/info.txt"
LOG_FILE="$TMP_DIR/code-server.log"

if [[ ! "$PORT" =~ ^[0-9]{1,5}$ ]] || (( PORT < 1 || PORT > 65535 )); then
    echo "ERROR: Invalid CODE_SERVER_PORT: $PORT" >&2
    exit 1
fi

CODE_SERVER_BIN="$(command -v code-server 2>/dev/null || true)"
if [[ -z "$CODE_SERVER_BIN" && -x "$LOCAL_BIN/code-server" ]]; then
    CODE_SERVER_BIN="$LOCAL_BIN/code-server"
fi
if [[ -z "$CODE_SERVER_BIN" ]]; then
    echo "ERROR: code-server is not installed. Run install.sh first." >&2
    exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
    echo "ERROR: openssl is required to create the service password." >&2
    exit 1
fi

mkdir -p "$TMP_DIR" "$STATE_DIR" "$WORKSPACE"
chmod 700 "$TMP_DIR" "$STATE_DIR"

PASSWORD=""
if [[ -f "$CONFIG_FILE" ]]; then
    PASSWORD="$(sed -n 's/^password: //p' "$CONFIG_FILE" | head -n 1)"
fi
if [[ -z "$PASSWORD" ]]; then
    PASSWORD="$(openssl rand -hex 24)"
fi

cat > "$CONFIG_FILE" <<EOF
bind-addr: 127.0.0.1:${PORT}
auth: password
password: ${PASSWORD}
cert: false
EOF
chmod 600 "$CONFIG_FILE"

cat > "$CREDENTIAL_FILE" <<EOF
URL: http://127.0.0.1:${PORT}
Workspace: ${WORKSPACE}
Password: ${PASSWORD}
EOF
chmod 600 "$CREDENTIAL_FILE"

cat > "$INFO_FILE" <<EOF
name:Code Server
description:Browser-based VS Code environment
url:http://127.0.0.1:${PORT}
host:127.0.0.1
port:${PORT}
workspace:${WORKSPACE}
password:${PASSWORD}
EOF
chmod 600 "$INFO_FILE"

if [[ -f "$PID_FILE" ]]; then
    OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ "$OLD_PID" =~ ^[0-9]+$ ]] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo "code-server is already running (PID $OLD_PID)."
        exit 0
    fi
    rm -f "$PID_FILE"
fi

nohup "$CODE_SERVER_BIN" --config "$CONFIG_FILE" "$WORKSPACE" >> "$LOG_FILE" 2>&1 </dev/null &
SERVER_PID=$!
printf '%s\n' "$SERVER_PID" > "$PID_FILE"
chmod 600 "$PID_FILE"

sleep 1
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "ERROR: code-server failed to start. Log: $LOG_FILE" >&2
    exit 1
fi

echo "code-server started on http://127.0.0.1:${PORT}"
echo "Workspace: $WORKSPACE"
echo "Login information: $CREDENTIAL_FILE"
