#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
STATE_DIR="${CODE_SERVER_STATE_DIR:-$HOME/.local/state/kaggle-code-server}"
CONFIG_FILE="$STATE_DIR/config.yaml"
PID_FILE="$STATE_DIR/code-server.pid"
CREDENTIAL_FILE="$SCRIPT_DIR/tmp/credentials.txt"

if [[ ! -f "$PID_FILE" ]]; then
    echo "code-server is not running (PID file not found)."
    exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"

if [[ ! "$PID" =~ ^[0-9]+$ ]]; then
    echo "Removing invalid code-server PID file."
    rm -f "$PID_FILE"
    exit 0
fi

process_is_running() {
    local pid="$1"
    local process_stat rest state

    kill -0 "$pid" 2>/dev/null || return 1
    [[ -r "/proc/$pid/stat" ]] || return 0

    IFS= read -r process_stat < "/proc/$pid/stat" || return 1
    rest="${process_stat##*) }"
    state="${rest%% *}"
    [[ "$state" != "Z" && "$state" != "X" ]]
}

if ! process_is_running "$PID"; then
    echo "code-server is already stopped; removing stale PID file."
    rm -f "$PID_FILE"
    exit 0
fi

if [[ ! -r "/proc/$PID/cmdline" ]]; then
    echo "ERROR: Cannot verify process $PID; leaving it untouched."
    exit 1
fi

COMMAND_LINE="$(tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true)"

if [[ "$COMMAND_LINE" != *"--config $CONFIG_FILE"* ]]; then
    echo "ERROR: PID $PID does not look like this code-server instance; leaving it untouched."
    exit 1
fi

echo "Stopping code-server..."
kill -TERM -- "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true

for ((i = 0; i < 10; i++)); do
    if ! process_is_running "$PID"; then
        break
    fi
    sleep 1
done

if process_is_running "$PID"; then
    echo "code-server did not stop in time; sending SIGKILL..."
    kill -KILL -- "-$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true
fi

for ((i = 0; i < 5; i++)); do
    if ! process_is_running "$PID"; then
        break
    fi
    sleep 1
done

if process_is_running "$PID"; then
    echo "ERROR: code-server process $PID is still running."
    exit 1
fi

rm -f "$PID_FILE"
echo "code-server stopped. Login credentials were preserved at: $CREDENTIAL_FILE"
