#!/usr/bin/env bash
set -Eeuo pipefail

# ==========================================================
# Configuration
# ==========================================================

STATE_DIR="${HOME}/.local/state/kaggle-code-server"
LOCAL_BIN_DIR="${HOME}/.local/bin"
LOCAL_LIB_DIR="${HOME}/.local/lib"
LOCAL_SHARE_DIR="${HOME}/.local/share"

CODE_SERVER_LINK="${LOCAL_BIN_DIR}/code-server"
CLOUDFLARED_LOCAL_BIN="${LOCAL_BIN_DIR}/cloudflared"
CODE_SERVER_DATA_DIR="${LOCAL_SHARE_DIR}/code-server"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STOP_SCRIPT="${SCRIPT_DIR}/stop.sh"

# ==========================================================
# Helpers
# ==========================================================

print_info() {
    printf '%s\n' "$1"
}

print_error() {
    printf 'Error: %s\n' "$1" >&2
}

confirm_uninstall() {
    if [[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]]; then
        return 0
    fi

    echo "This will:"
    echo "  - Stop code-server and the managed Cloudflare Tunnel."
    echo "  - Remove the standalone code-server installation under ~/.local."
    echo "  - Remove the user-local cloudflared binary under ~/.local/bin."
    echo "  - Remove code-server state, configuration, and its data directory."
    echo "  - Remove the login.txt file recorded by start.sh."
    echo ""
    echo "Workspace files and workspace logs will be preserved."
    echo "System-wide installations will not be removed."
    echo ""

    local answer
    read -r -p "Continue? [y/N]: " answer
    case "${answer}" in
        y|Y|yes|YES) ;;
        *)
            print_info "Uninstall cancelled."
            exit 0
            ;;
    esac
}

stop_services() {
    if [[ -x "${STOP_SCRIPT}" ]]; then
        bash "${STOP_SCRIPT}"
        return
    fi

    print_info "stop.sh not found; stopping processes using saved PID files."

    local pid_file pid
    for pid_file in \
        "${STATE_DIR}/cloudflared.pid" \
        "${STATE_DIR}/code-server.pid"; do

        [[ -f "${pid_file}" ]] || continue
        pid="$(cat "${pid_file}" 2>/dev/null || true)"

        if [[ "${pid}" =~ ^[0-9]+$ ]] && kill -0 "${pid}" 2>/dev/null; then
            kill -TERM "${pid}" 2>/dev/null || true
            for _ in $(seq 1 10); do
                kill -0 "${pid}" 2>/dev/null || break
                sleep 1
            done
            kill -KILL "${pid}" 2>/dev/null || true
        fi
        rm -f "${pid_file}"
    done
}

remove_standalone_code_server() {
    print_info "Removing standalone code-server installation..."

    # Only remove the user-local symlink if it points into ~/.local/lib/code-server-*.
    if [[ -L "${CODE_SERVER_LINK}" ]]; then
        local target
        target="$(readlink -f "${CODE_SERVER_LINK}" 2>/dev/null || true)"
        case "${target}" in
            "${LOCAL_LIB_DIR}"/code-server-*)
                rm -f "${CODE_SERVER_LINK}"