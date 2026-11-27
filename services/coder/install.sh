#!/usr/bin/env bash

set -Eeuo pipefail

# ==========================================================
# Configuration
# ==========================================================

PORT="${CODE_SERVER_PORT:-8001}"
WORKSPACE="${WORKSPACE_DIR:-${KAGGLE_WORKING_DIR:-/workspaces}}"

STATE_DIR="${HOME}/.local/state/kaggle-code-server"
CONFIG_FILE="${STATE_DIR}/config.yaml"

LOG_DIR="${WORKSPACE}/log"
CODE_SERVER_LOG="${LOG_DIR}/code-server.log"
CLOUDFLARED_LOG="${LOG_DIR}/cloudflared.log"

CODE_SERVER_PID_FILE="${STATE_DIR}/code-server.pid"
CLOUDFLARED_PID_FILE="${STATE_DIR}/cloudflared.pid"

CREDENTIAL_FILE="${PWD}/login.txt"

CODE_SERVER_BIN=""
CLOUDFLARED_BIN="${HOME}/.local/bin/cloudflared"

TUNNEL_ENABLED=false
TUNNEL_TOKEN=""
FOREGROUND=false
INSTALL_EXTENSIONS=false

TUNNEL_URL="Not enabled"

# ==========================================================
# Helper functions
# ==========================================================

print_error() {
    echo "Error: $1" >&2
}

print_info() {
    echo "$1"
}

show_help() {
    cat <<EOF
Usage:
  ./start.sh [options]

Options:
  --tunnel                  Start Cloudflare Quick Tunnel
  --tunnel-token TOKEN      Start Cloudflare Named Tunnel
  --port PORT               Set code-server port
  --workspace PATH          Set workspace directory
  --foreground              Run services in foreground
  --install-extensions      Install recommended extensions
  --help                    Show this help

Examples:
  ./start.sh
  ./start.sh --tunnel
  ./start.sh --tunnel-token YOUR_TOKEN
  ./start.sh --port 8080
  ./start.sh --tunnel --port 8080
  ./start.sh --foreground
EOF
}

cleanup() {
    if [[ -f "${CLOUDFLARED_PID_FILE}" ]]; then
        local pid
        pid="$(cat "${CLOUDFLARED_PID_FILE}" 2>/dev/null || true)"

        if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
            kill "${pid}" 2>/dev/null || true
        fi

        rm -f "${CLOUDFLARED_PID_FILE}"
    fi

    if [[ -f "${CODE_SERVER_PID_FILE}" ]]; then
        local pid
        pid="$(cat "${CODE_SERVER_PID_FILE}" 2>/dev/null || true)"

        if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
            kill "${pid}" 2>/dev/null || true
        fi

        rm -f "${CODE_SERVER_PID_FILE}"
    fi
}

check_command() {
    command -v "$1" >/dev/null 2>&1
}

check_dependencies() {
    local missing=()

    for cmd in curl tar grep sed; do
        if ! check_command "${cmd}"; then
            missing+=("${cmd}")
        fi
    done

    if [[ ${#missing[@]} -gt 0 ]]; then
        print_error "Missing required commands: ${missing[*]}"
        exit 1
    fi
}

generate_password() {
    if check_command openssl; then
        openssl rand -hex 32
    elif check_command python3; then
        python3 -c "import secrets; print(secrets.token_urlsafe(32))"
    else
        print_error "Neither openssl nor python3 is available."
        exit 1
    fi
}

# ==========================================================
# Installation
# ==========================================================

find_code_server() {
    if check_command code-server; then
        CODE_SERVER_BIN="$(command -v code-server)"
        return 0
    fi

    if [[ -x "${HOME}/.local/bin/code-server" ]]; then
        CODE_SERVER_BIN="${HOME}/.local/bin/code-server"
        return 0
    fi

    local found
    found="$(find "${HOME}/.local/lib" \
        -type f -path '*/bin/code-server' \
        -executable -print -quit 2>/dev/null || true)"

    if [[ -n "${found}" ]]; then
        CODE_SERVER_BIN="${found}"
        return 0
    fi

    return 1
}

install_code_server() {
    print_info "Checking code-server installation..."

    if find_code_server; then
        print_info "code-server is already installed."
        return 0
    fi

    print_info "Installing code-server..."

    curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone

    if ! find_code_server; then
        print_error "code-server installation failed."
        exit 1
    fi

    print_info "code-server installed successfully."
}

install_cloudflared() {
    print_info "Checking cloudflared installation..."

    if check_command cloudflared; then
        CLOUDFLARED_BIN="$(command -v cloudflared)"
        return 0
    fi

    if [[ -x "${CLOUDFLARED_BIN}" ]]; then
        return 0
    fi

    print_info "Installing cloudflared..."

    local arch
    arch="$(uname -m)"

    case "${arch}" in
        x86_64 | amd64)
            arch="amd64"
            ;;
        aarch64 | arm64)
            arch="arm64"
            ;;
        *)
            print_error "Unsupported architecture: ${arch}"
            exit 1
            ;;
    esac

    mkdir -p "$(dirname "${CLOUDFLARED_BIN}")"

    curl -fL \
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}" \
        -o "${CLOUDFLARED_BIN}"

    chmod +x "${CLOUDFLARED_BIN}"

    print_info "cloudflared installed successfully."
}

# ==========================================================
# Configuration
# ==========================================================

create_directories() {
    mkdir -p "${STATE_DIR}"
    mkdir -p "${LOG_DIR}"
    mkdir -p "${WORKSPACE}"
}

create_code_server_config() {
    local password

    password="$(generate_password)"

    cat > "${CONFIG_FILE}" <<EOF
bind-addr: 127.0.0.1:${PORT}
auth: password
password: ${password}
cert: false
EOF

    chmod 600 "${CONFIG_FILE}"

    cat > "${CREDENTIAL_FILE}" <<EOF
Code Server Login
=================

Local URL: http://127.0.0.1:${PORT}
Username: Not required
Password: ${password}

Workspace: ${WORKSPACE}
Port: ${PORT}

Cloudflare Tunnel: Disabled
EOF

    chmod 600 "${CREDENTIAL_FILE}"

    print_info "Login credentials saved to: ${CREDENTIAL_FILE}"
}

update_credential_file() {
    local password

    password="$(sed -n 's/^password: //p' "${CONFIG_FILE}")"

    cat > "${CREDENTIAL_FILE}" <<EOF
Code Server Login
=================

Local URL: http://127.0.0.1:${PORT}
Username: Not required
Password: ${password}

Workspace: ${WORKSPACE}
Port: ${PORT}

Cloudflare Tunnel: ${TUNNEL_URL}
EOF

    chmod 600 "${CREDENTIAL_FILE}"
}

# ==========================================================
# Workspace
# ==========================================================

setup_workspace() {
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    if [[ -d "${script_dir}/services" && ! -d "${WORKSPACE}/services" ]]; then
        print_info "Copying services directory to workspace..."
        cp -a "${script_dir}/services" "${WORKSPACE}/services"
    fi

    if [[ ! -e "/workspace" ]]; then
        ln -s "${WORKSPACE}" /workspace 2>/dev/null || true
    fi
}

# ==========================================================
# Extensions
# ==========================================================

install_extensions() {
    print_info "Installing recommended extensions..."

    local extensions=(
        ms-python.python
        ms-python.vscode-pylance
        dbaeumer.vscode-eslint
        esbenp.prettier-vscode
        bmewburn.vscode-intelephense-client
        mtxr.sqltools
        ms-azuretools.vscode-docker
        eamodio.gitlens
    )

    for extension in "${extensions[@]}"; do
        print_info "Installing ${extension}..."
        "${CODE_SERVER_BIN}" \
            --install-extension "${extension}" \
            --force || true
    done
}

# ==========================================================
# Process management
# ==========================================================

is_running() {
    local pid_file="$1"

    if [[ ! -f "${pid_file}" ]]; then
        return 1
    fi

    local pid
    pid="$(cat "${pid_file}" 2>/dev/null || true)"

    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
        return 0
    fi

    rm -f "${pid_file}"
    return 1
}

stop_existing_processes() {
    print_info "Checking existing processes..."

    for pid_file in "${CODE_SERVER_PID_FILE}" "${CLOUDFLARED_PID_FILE}"; do
        if is_running "${pid_file}"; then
            local pid
            pid="$(cat "${pid_file}")"

            print_info "Stopping existing process: ${pid}"
            kill "${pid}" 2>/dev/null || true
            rm -f "${pid_file}"
        fi
    done
}

start_code_server() {
    print_info "Starting code-server..."

    nohup "${CODE_SERVER_BIN}" \
        --config "${CONFIG_FILE}" \
        --disable-telemetry \
        "${WORKSPACE}" \
        >> "${CODE_SERVER_LOG}" 2>&1 < /dev/null &

    local pid=$!
    echo "${pid}" > "${CODE_SERVER_PID_FILE}"

    sleep 2

    if ! kill -0 "${pid}" 2>/dev/null; then
        print_error "code-server failed to start. Check ${CODE_SERVER_LOG}"
        exit 1
    fi

    print_info "code-server started."
    print_info "PID: ${pid}"
    print_info "Log: ${CODE_SERVER_LOG}"
}

# ==========================================================
# Cloudflare Tunnel
# ==========================================================

start_quick_tunnel() {
    print_info "Starting Cloudflare Quick Tunnel..."

    nohup "${CLOUDFLARED_BIN}" tunnel \
        --url "http://127.0.0.1:${PORT}" \
        --no-autoupdate \
        >> "${CLOUDFLARED_LOG}" 2>&1 < /dev/null &

    local pid=$!
    echo "${pid}" > "${CLOUDFLARED_PID_FILE}"

    print_info "Waiting for Quick Tunnel URL..."

    for _ in $(seq 1 30); do
        TUNNEL_URL="$(
            grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' \
                "${CLOUDFLARED_LOG}" 2>/dev/null |
                tail -n 1 || true
        )"

        if [[ -n "${TUNNEL_URL}" ]]; then
            break
        fi

        if ! kill -0 "${pid}" 2>/dev/null; then
            print_error "cloudflared stopped unexpectedly. Check ${CLOUDFLARED_LOG}"
            exit 1
        fi

        sleep 1
    done

    if [[ -z "${TUNNEL_URL}" ]]; then
        TUNNEL_URL="URL not detected. Check ${CLOUDFLARED_LOG}"
        print_error "Could not detect Quick Tunnel URL."
    else
        print_info "Quick Tunnel started."
        print_info "Public URL: ${TUNNEL_URL}"
    fi
}

start_named_tunnel() {
    print_info "Starting Cloudflare Named Tunnel..."

    nohup "${CLOUDFLARED_BIN}" tunnel run \
        --token "${TUNNEL_TOKEN}" \
        --no-autoupdate \
        >> "${CLOUDFLARED_LOG}" 2>&1 < /dev/null &

    local pid=$!
    echo "${pid}" > "${CLOUDFLARED_PID_FILE}"

    sleep 2

    if ! kill -0 "${pid}" 2>/dev/null; then
        print_error "Named Tunnel failed to start. Check ${CLOUDFLARED_LOG}"
        exit 1
    fi

    TUNNEL_URL="Named Tunnel is running. Use your configured hostname."

    print_info "Named Tunnel started."
    print_info "PID: ${pid}"
    print_info "Log: ${CLOUDFLARED_LOG}"
}

# ==========================================================
# Output
# ==========================================================

print_connection_details() {
    echo ""
    echo "========================================"
    echo "Services started"
    echo "========================================"
    echo ""
    echo "Code Server:"
    echo "  Local URL: http://127.0.0.1:${PORT}"
    echo "  Workspace: ${WORKSPACE}"
    echo "  Log: ${CODE_SERVER_LOG}"
    echo ""

    if [[ "${TUNNEL_ENABLED}" == true ]]; then
        echo "Cloudflare Tunnel:"
        echo "  URL: ${TUNNEL_URL}"
        echo "  Log: ${CLOUDFLARED_LOG}"
        echo ""
    else
        echo "Cloudflare Tunnel: Disabled"
        echo ""
    fi

    echo "Login credentials:"
    echo "  File: ${CREDENTIAL_FILE}"
    echo ""
    echo "========================================"
}

# ==========================================================
# Arguments
# ==========================================================

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --tunnel)
                TUNNEL_ENABLED=true
                shift
                ;;

            --tunnel-token)
                if [[ -z "${2:-}" ]]; then
                    print_error "Missing token after --tunnel-token."
                    exit 1
                fi

                TUNNEL_ENABLED=true
                TUNNEL_TOKEN="$2"
                shift 2
                ;;

            --port)
                if [[ -z "${2:-}" ]]; then
                    print_error "Missing port after --port."
                    exit 1
                fi

                PORT="$2"
                shift 2
                ;;

            --workspace)
                if [[ -z "${2:-}" ]]; then
                    print_error "Missing path after --workspace."
                    exit 1
                fi

                WORKSPACE="$2"
                shift 2
                ;;

            --foreground)
                FOREGROUND=true
                shift
                ;;

            --install-extensions)
                INSTALL_EXTENSIONS=true
                shift
                ;;

            --help | -h)
                show_help
                exit 0
                ;;

            *)
                print_error "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done

    if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
        print_error "Invalid port: ${PORT}"
        exit 1
    fi
}

# ==========================================================
# Main
# ==========================================================

main() {
    parse_arguments "$@"

    check_dependencies
    create_directories

    install_code_server

    if [[ "${TUNNEL_ENABLED}" == true ]]; then
        install_cloudflared
    fi

    stop_existing_processes

    create_code_server_config
    setup_workspace

    if [[ "${INSTALL_EXTENSIONS}" == true ]]; then
        install_extensions
    fi

    start_code_server

    if [[ "${TUNNEL_ENABLED}" == true ]]; then
        if [[ -n "${TUNNEL_TOKEN}" ]]; then
            start_named_tunnel
        else
            start_quick_tunnel
        fi
    fi

    update_credential_file
    print_connection_details

    if [[ "${FOREGROUND}" == true ]]; then
        trap cleanup EXIT INT TERM

        print_info "Running in foreground. Press Ctrl+C to stop."

        local code_server_pid
        code_server_pid="$(cat "${CODE_SERVER_PID_FILE}")"

        wait "${code_server_pid}" || true
    fi
}

main "$@"