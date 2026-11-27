#!/usr/bin/env bash
set -Eeuo pipefail
: "${HOME:?HOME must be set}"

STATE_DIR="${HOME}/.local/state/kaggle-code-server"
CODE_SERVER_PID_FILE="${STATE_DIR}/code-server.pid"
CLOUDFLARED_PID_FILE="${STATE_DIR}/cloudflared.pid"

info() { printf '%s\n' "$*"; }

stop_process() {
    local name="$1" pid_file="$2" pid command_line
    if [[ ! -f "$pid_file" ]]; then info "$name: no PID file."; return 0; fi
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ ! "$pid" =~ ^[0-9]+$ ]] || (( pid <= 1 )); then
        info "$name: removing invalid PID file."
        rm -f -- "$pid_file"
        return 0
    fi
    command_line="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    if [[ -z "$command_line" ]]; then
        info "$name: already stopped; removing stale PID file."
        rm -f -- "$pid_file"
        return 0
    fi
    if [[ "$command_line" != *"$name"* ]]; then
        info "$name: PID $pid belongs to another process; leaving it untouched."
        rm -f -- "$pid_file"
        return 0
    fi

    info "Stopping $name (PID $pid)..."
    kill -TERM "$pid" 2>/dev/null || true
    for _ in {1..15}; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
        info "$name did not exit after SIGTERM; sending SIGKILL."
        kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f -- "$pid_file"
    info "$name: stopped."
}

main() {
    stop_process cloudflared "$CLOUDFLARED_PID_FILE"
    stop_process code-server "$CODE_SERVER_PID_FILE"
    info "Managed services are stopped; configuration, credentials, and workspace logs were kept."
}
main "$@"
