#!/usr/bin/env bash
set -Eeuo pipefail

# ==========================================================
# Configuration
# ==========================================================

STATE_DIR="${HOME}/.local/state/kaggle-code-server"
CODE_SERVER_PID_FILE="${STATE_DIR}/code-server.pid"
CLOUDFLARED_PID_FILE="${STATE_DIR}/cloudflared.pid"

# ==========================================================
# Helpers
# ==========================================================

print_info() {
    printf '%s\n' "$1"
}

stop_process() {
    local service_name="$1"
    local pid_file="$2"

    if [[ ! -f "${pid_file}" ]]; then
        print_info "${service_name}: no PID file; nothing to stop."
        return 0
    fi

    local pid
    pid="$(cat "${pid_file}" 2>/dev/null || true)"

    if ! [[ "${pid}" =~ ^[0-9]+$ ]]; then
        print_info "${service_name}: invalid PID file; removing stale file."
        rm -f "${pid_file}"
        return 0
    fi

    if ! kill -0 "${pid}" 2>/dev/null; then
        print_info "${service_name}: process is not running; removing stale PID file."
        rm -f "${pid_file}"
        return 0
    fi

    print_info "Stopping ${service_name} (PID ${pid})..."
    kill -TERM "${pid}" 2>/dev/null || true

    local stopped=false
    for _ in $(seq 1 15); do
        if ! kill -0 "${pid}" 2>/dev/null; then
            stopped=true
            break
        fi
        sleep 1
    done

    if [[ "${stopped}" == false ]] && kill -0 "${pid}" 2>/dev/null; then
        print_info "${service_name} did not exit after SIGTERM; sending SIGKILL."
        kill -KILL "${pid}" 2>/dev/null || true
    fi

    rm -f "${pid_file}"
    print_info "${service_name}: stopped."
}

# ==========================================================
# Main
# ==========================================================

main() {
    stop_process "Cloudflare Tunnel" "${CLOUDFLARED_PID_FILE}"
    stop_process "code-server" "${CODE_SERVER_PID_FILE}"

    echo ""
    echo "Managed services have been stopped."
    echo "Configuration, credentials, logs, and workspace files were preserved."
}

main "$@"
