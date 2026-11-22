#!/usr/bin/env bash

set -Eeuo pipefail

# ==========================================
# Configuration
# ==========================================

PORT="${CODE_SERVER_PORT:-8082}"
WORKSPACE="${KAGGLE_WORKING_DIR:-/workspaces}"

LOCAL_BIN="$HOME/.local/bin"
STATE_DIR="${CODE_SERVER_STATE_DIR:-$HOME/.local/state/kaggle-code-server}"

CONFIG_FILE="$STATE_DIR/config.yaml"
PID_FILE="$STATE_DIR/code-server.pid"
LOG_FILE="./code-server.log"

HEALTH_URL="http://127.0.0.1:${PORT}/healthz"

FOREGROUND=false
SERVER_PID=""
STARTED_BY_THIS_RUN=false
STOP_REQUESTED=false

export PATH="$LOCAL_BIN:$PATH"

# ==========================================
# Utility functions
# ==========================================

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

find_code_server() {
    command -v code-server 2>/dev/null || {
        [[ -x "$LOCAL_BIN/code-server" ]] && echo "$LOCAL_BIN/code-server"
    }
}

check_dependencies() {
    for cmd in curl bash; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            echo "Missing dependency: $cmd"
            exit 1
        fi
    done
}

# ==========================================
# Installation
# ==========================================

install_code_server() {
    if find_code_server >/dev/null 2>&1; then
        log "code-server is already installed."
        return
    fi

    log "Installing code-server..."

    curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone

    export PATH="$LOCAL_BIN:$PATH"

    if ! find_code_server >/dev/null 2>&1; then
        echo "ERROR: code-server installation failed."
        exit 1
    fi

    log "code-server installed successfully."
}

# ==========================================
# Process management
# ==========================================

read_pid() {
    [[ -f "$PID_FILE" ]] || return 1

    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"

    [[ "$pid" =~ ^[0-9]+$ ]] || return 1

    echo "$pid"
}

process_command() {
    local pid="$1"

    [[ -r "/proc/$pid/cmdline" ]] || return 1

    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null
}

recorded_process_is_running() {
    local pid
    local command_line

    pid="$(read_pid)" || {
        rm -f "$PID_FILE"
        return 1
    }

    command_line="$(process_command "$pid")" || {
        rm -f "$PID_FILE"
        return 1
    }

    if [[ "$command_line" == *"--config $CONFIG_FILE"* ]]; then
        return 0
    fi

    rm -f "$PID_FILE"
    return 1
}

is_healthy() {
    curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1
}

wait_for_server() {
    local timeout="${1:-30}"
    local elapsed=0

    while (( elapsed < timeout )); do

        if [[ -n "$SERVER_PID" ]] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
            echo "ERROR: code-server exited during startup."
            return 1
        fi

        if is_healthy; then
            return 0
        fi

        sleep 1
        ((elapsed += 1))
    done

    echo "ERROR: code-server did not become ready."
    return 1
}

# ==========================================
# Configuration
# ==========================================

generate_config() {
    mkdir -p "$STATE_DIR"
    chmod 700 "$STATE_DIR"

    local password
    password="$(openssl rand -hex 24)"

    cat > "$CONFIG_FILE" <<EOF
bind-addr: 127.0.0.1:${PORT}
auth: password
password: ${password}
cert: false
EOF

    chmod 600 "$CONFIG_FILE"
}

print_connection_details() {
    local password

    password="$(sed -n 's/^password: //p' "$CONFIG_FILE" | head -n 1)"

    echo
    echo "======================================================"
    echo "             CODE-SERVER IS READY"
    echo "======================================================"
    echo "Local URL : http://127.0.0.1:${PORT}"
    echo "Workspace : $WORKSPACE"
    echo "Password  : $password"
    echo "Log file  : $LOG_FILE"
    echo "======================================================"
    echo
}

# ==========================================
# Start server
# ==========================================

start_code_server() {
    if is_healthy; then
        echo "ERROR: Something is already responding at $HEALTH_URL"
        echo "Stop the existing service before starting another one."
        return 1
    fi

    mkdir -p "$LOCAL_BIN" "$STATE_DIR" "$WORKSPACE"

    install_code_server
    generate_config

    local executable
    executable="$(find_code_server)"

    log "Starting code-server on port $PORT..."

    : > "$LOG_FILE"

    setsid "$executable" \
        --config "$CONFIG_FILE" \
        --disable-telemetry \
        "$WORKSPACE" \
        >> "$LOG_FILE" 2>&1 < /dev/null &

    SERVER_PID=$!
    STARTED_BY_THIS_RUN=true

    echo "$SERVER_PID" > "$PID_FILE"

    if ! wait_for_server 30; then
        stop_server
        return 1
    fi

    log "code-server started successfully."
}

# ==========================================
# Stop server
# ==========================================

stop_server() {
    if [[ -z "$SERVER_PID" ]]; then
        return
    fi

    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        rm -f "$PID_FILE"
        return
    fi

    log "Stopping code-server..."

    kill -TERM -- "-$SERVER_PID" 2>/dev/null || \
        kill -TERM "$SERVER_PID" 2>/dev/null || true

    for ((i = 0; i < 10; i++)); do
        if ! kill -0 "$SERVER_PID" 2>/dev/null; then
            break
        fi
        sleep 1
    done

    if kill -0 "$SERVER_PID" 2>/dev/null; then
        kill -KILL -- "-$SERVER_PID" 2>/dev/null || \
            kill -KILL "$SERVER_PID" 2>/dev/null || true
    fi

    rm -f "$PID_FILE" "$CONFIG_FILE"

    log "code-server stopped."
}

# ==========================================
# Foreground supervision
# ==========================================

handle_signal() {
    STOP_REQUESTED=true
}

supervise_services() {
    log "Foreground mode enabled."
    log "Press Ctrl+C to stop services started by this run."

    while true; do
        if [[ "$STOP_REQUESTED" == true ]]; then
            break
        fi

        if [[ -n "$SERVER_PID" ]]; then
            if ! kill -0 "$SERVER_PID" 2>/dev/null; then
                log "code-server stopped."
                break
            fi
        elif ! recorded_process_is_running; then
            log "code-server process is no longer running."
            break
        fi

        sleep 1
    done
}

# ==========================================
# Main
# ==========================================

main() {
    check_dependencies

    mkdir -p "$STATE_DIR" "$WORKSPACE"

    if recorded_process_is_running; then
        log "code-server is already running."
        SERVER_PID="$(read_pid)"

        if ! wait_for_server 10; then
            echo "ERROR: Existing process is not healthy."
            exit 1
        fi
    else
        start_code_server
    fi

    print_connection_details

    if [[ "$FOREGROUND" == true ]]; then
        trap handle_signal INT TERM

        supervise_services

        if [[ "$STARTED_BY_THIS_RUN" == true ]]; then
            stop_server
        fi
    fi
}

# ==========================================
# Arguments
# ==========================================

for arg in "$@"; do
    case "$arg" in
        --foreground)
            FOREGROUND=true
            ;;
        -h|--help)
            echo "Usage: bash install_coder_server.sh [--foreground]"
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg"
            exit 1
            ;;
    esac
done

main
