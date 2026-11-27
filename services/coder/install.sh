#!/usr/bin/env bash
set -Eeuo pipefail

# ==========================================================
# Configuration
# ==========================================================

PORT="${CODE_SERVER_PORT:-8001}"

WORKSPACE="${WORKSPACE_DIR:-${KAGGLE_WORKING_DIR:-/workspaces}}"

LOCAL_BIN="${HOME}/.local/bin"

STATE_DIR="${CODE_SERVER_STATE_DIR:-${HOME}/.local/state/kaggle-code-server}"

CONFIG_FILE="${STATE_DIR}/config.yaml"
SERVER_PID_FILE="${STATE_DIR}/code-server.pid"
TUNNEL_PID_FILE="${STATE_DIR}/cloudflared.pid"

LOG_DIR="${WORKSPACE}/log"
SERVER_LOG="${LOG_DIR}/code-server.log"
TUNNEL_LOG="${LOG_DIR}/cloudflared.log"

CLOUDFLARED_AMD64_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
CLOUDFLARED_ARM64_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"

HEALTH_URL="http://127.0.0.1:${PORT}/healthz"

FOREGROUND=false
TUNNEL_ENABLED=false
TUNNEL_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-}"
INSTALL_EXTENSIONS="${INSTALL_EXTENSIONS:-false}"


# ==========================================================
# Prepare directories
# ==========================================================

mkdir -p \
    "${LOCAL_BIN}" \
    "${STATE_DIR}" \
    "${WORKSPACE}" \
    "${LOG_DIR}"

export PATH="${LOCAL_BIN}:${PATH}"


# ==========================================================
# Print usage
# ==========================================================

usage() {
    cat <<EOF

Usage:
  $0 [OPTIONS]

Options:
  --tunnel
      Start Cloudflare Quick Tunnel.

  --tunnel-token TOKEN
      Start Cloudflare Named Tunnel using TOKEN.

  --port PORT
      Set code-server port.
      Default: ${PORT}

  --workspace PATH
      Set workspace directory.
      Default: ${WORKSPACE}

  --foreground
      Keep this script running and supervise services.
      Press Ctrl+C to stop services started by this script.

  --install-extensions
      Run services/coder/install_extension.sh during startup.

  --help
      Show this help message.

Default:
  Start code-server only.
  Cloudflare Tunnel is NOT started unless --tunnel
  or --tunnel-token is specified.

Examples:
  $0

  $0 --tunnel

  $0 --port 8082

  $0 --workspace /workspaces

  $0 --tunnel --port 8082 --foreground

  $0 --tunnel-token YOUR_TUNNEL_TOKEN

EOF
}


# ==========================================================
# Cleanup
# ==========================================================

SERVER_PID=""
TUNNEL_PID=""

cleanup() {
    local exit_code=$?

    if [[ -n "${TUNNEL_PID}" ]] &&
       kill -0 "${TUNNEL_PID}" 2>/dev/null; then
        echo "Stopping Cloudflare Tunnel..."
        kill "${TUNNEL_PID}" 2>/dev/null || true
        wait "${TUNNEL_PID}" 2>/dev/null || true
    fi

    if [[ -n "${SERVER_PID}" ]] &&
       kill -0 "${SERVER_PID}" 2>/dev/null; then
        echo "Stopping code-server..."
        kill "${SERVER_PID}" 2>/dev/null || true
        wait "${SERVER_PID}" 2>/dev/null || true
    fi

    rm -f \
        "${SERVER_PID_FILE}" \
        "${TUNNEL_PID_FILE}"

    exit "${exit_code}"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM


# ==========================================================
# Find executable
# ==========================================================

find_executable() {
    local name="$1"

    if command -v "${name}" >/dev/null 2>&1; then
        command -v "${name}"
        return 0
    fi

    if [[ -x "${LOCAL_BIN}/${name}" ]]; then
        echo "${LOCAL_BIN}/${name}"
        return 0
    fi

    return 1
}


# ==========================================================
# Install code-server
# ==========================================================

install_code_server() {

    if find_executable code-server >/dev/null 2>&1; then
        return 0
    fi

    if ! command -v curl >/dev/null 2>&1; then
        echo "Error: curl is required to install code-server."
        exit 1
    fi

    if ! command -v bash >/dev/null 2>&1; then
        echo "Error: bash is required."
        exit 1
    fi

    echo "Installing code-server..."

    curl -fsSL \
        https://code-server.dev/install.sh \
        | sh -s -- --method=standalone

    export PATH="${LOCAL_BIN}:${PATH}"

    if ! find_executable code-server >/dev/null 2>&1; then
        echo "Error: code-server installation completed but executable was not found."
        exit 1
    fi
}


# ==========================================================
# Install cloudflared
# ==========================================================

install_cloudflared() {

    if find_executable cloudflared >/dev/null 2>&1; then
        return 0
    fi

    if ! command -v curl >/dev/null 2>&1; then
        echo "Error: curl is required to install cloudflared."
        exit 1
    fi

    local arch
    local download_url

    arch="$(uname -m)"

    case "${arch}" in

        x86_64|amd64)
            download_url="${CLOUDFLARED_AMD64_URL}"
            ;;

        aarch64|arm64)
            download_url="${CLOUDFLARED_ARM64_URL}"
            ;;

        *)
            echo "Error: Unsupported CPU architecture: ${arch}"
            exit 1
            ;;

    esac

    echo "Downloading cloudflared..."

    curl -fL \
        "${download_url}" \
        -o "${LOCAL_BIN}/cloudflared"

    chmod +x "${LOCAL_BIN}/cloudflared"

    if ! find_executable cloudflared >/dev/null 2>&1; then
        echo "Error: cloudflared installation failed."
        exit 1
    fi
}


# ==========================================================
# Copy services directory
# ==========================================================

copy_services_to_workspace() {

    local script_dir
    local source_services
    local destination_services

    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    source_services="${script_dir}/services"
    destination_services="${WORKSPACE}/services"

    if [[ ! -d "${source_services}" ]]; then
        return 0
    fi

    if [[ "$(realpath -m "${source_services}")" == \
          "$(realpath -m "${destination_services}")" ]]; then
        return 0
    fi

    echo "Copying services to ${destination_services}..."

    mkdir -p "${destination_services}"

    cp -a \
        "${source_services}/." \
        "${destination_services}/"

    echo "Services copied successfully."
}


# ==========================================================
# Workspace compatibility
# ==========================================================

ensure_workspace_compatibility() {

    if [[ ! -d /workspace ]] &&
       [[ "${WORKSPACE}" != "/workspace" ]]; then

        ln -s "${WORKSPACE}" /workspace 2>/dev/null || true
    fi
}


# ==========================================================
# Install VS Code extensions
# ==========================================================

run_install_extensions() {

    local script_dir
    local script_path=""

    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    local candidates=(
        "${WORKSPACE}/services/coder/install_extension.sh"
        "${script_dir}/services/coder/install_extension.sh"
        "${script_dir}/install_extension.sh"
    )

    for candidate in "${candidates[@]}"; do
        if [[ -f "${candidate}" ]]; then
            script_path="${candidate}"
            break
        fi
    done

    if [[ -z "${script_path}" ]]; then
        echo "Warning: Extension script not found."
        echo "Expected: services/coder/install_extension.sh"
        return 0
    fi

    echo "Installing extensions using ${script_path}..."

    if bash "${script_path}"; then
        echo "Extensions installed successfully."
    else
        echo "Warning: Extension installation failed."
    fi
}


# ==========================================================
# Check code-server health
# ==========================================================

is_healthy() {

    curl \
        -fsS \
        --max-time 2 \
        "${HEALTH_URL}" \
        >/dev/null 2>&1
}


# ==========================================================
# Wait for code-server
# ==========================================================

wait_for_code_server() {

    local timeout="${1:-30}"

    for ((i=1; i<=timeout; i++)); do

        if is_healthy; then
            return 0
        fi

        if [[ -n "${SERVER_PID}" ]] &&
           ! kill -0 "${SERVER_PID}" 2>/dev/null; then

            echo "Error: code-server exited during startup."
            return 1
        fi

        sleep 1
    done

    echo "Error: code-server did not become ready."
    echo "Health URL: ${HEALTH_URL}"

    return 1
}


# ==========================================================
# Start code-server
# ==========================================================

start_code_server() {

    if is_healthy; then
        echo "Error: Something is already responding at ${HEALTH_URL}."
        echo "Stop the existing service before starting another one."
        exit 1
    fi

    install_code_server

    ensure_workspace_compatibility
    copy_services_to_workspace

    mkdir -p "${STATE_DIR}" "${WORKSPACE}" "${LOG_DIR}"

    local password
    local code_server

    password="$(openssl rand -hex 32 2>/dev/null || \
        head -c 32 /dev/urandom | base64)"

    cat > "${CONFIG_FILE}" <<EOF
bind-addr: 127.0.0.1:${PORT}
auth: password
password: ${password}
cert: false
EOF

    chmod 600 "${CONFIG_FILE}"

    code_server="$(find_executable code-server)"

    echo "Starting code-server..."
    echo "Port: ${PORT}"
    echo "Workspace: ${WORKSPACE}"

    nohup "${code_server}" \
        --config "${CONFIG_FILE}" \
        --disable-telemetry \
        "${WORKSPACE}" \
        > "${SERVER_LOG}" 2>&1 &

    SERVER_PID=$!

    echo "${SERVER_PID}" > "${SERVER_PID_FILE}"

    if ! wait_for_code_server 30; then
        return 1
    fi

    echo "code-server is running."
}


# ==========================================================
# Read code-server password
# ==========================================================

read_code_server_password() {

    if [[ ! -f "${CONFIG_FILE}" ]]; then
        echo "Error: code-server config was not found:"
        echo "${CONFIG_FILE}"
        return 1
    fi

    grep -E '^password:' "${CONFIG_FILE}" \
        | sed 's/^password:[[:space:]]*//'
}


# ==========================================================
# Read Cloudflare Quick Tunnel URL
# ==========================================================

read_tunnel_url() {

    [[ -f "${TUNNEL_LOG}" ]] || return 1

    grep -oE \
        'https://[A-Za-z0-9-]+\.trycloudflare\.com' \
        "${TUNNEL_LOG}" \
        | head -n 1
}


# ==========================================================
# Wait for Quick Tunnel URL
# ==========================================================

wait_for_tunnel_url() {

    local timeout="${1:-60}"

    for ((i=1; i<=timeout; i++)); do

        local url
        url="$(read_tunnel_url || true)"

        if [[ -n "${url}" ]]; then
            echo "${url}"
            return 0
        fi

        if [[ -n "${TUNNEL_PID}" ]] &&
           ! kill -0 "${TUNNEL_PID}" 2>/dev/null; then

            echo "Error: cloudflared exited before publishing its URL."
            return 1
        fi

        sleep 1
    done

    echo "Error: Timed out waiting for Cloudflare Quick Tunnel URL."
    return 1
}


# ==========================================================
# Start Cloudflare Quick Tunnel
# ==========================================================

start_quick_tunnel() {

    install_cloudflared

    local cloudflared

    cloudflared="$(find_executable cloudflared)"

    echo "Starting Cloudflare Quick Tunnel..."

    nohup "${cloudflared}" tunnel \
        --url "http://127.0.0.1:${PORT}" \
        --no-autoupdate \
        > "${TUNNEL_LOG}" 2>&1 &

    TUNNEL_PID=$!

    echo "${TUNNEL_PID}" > "${TUNNEL_PID_FILE}"

    TUNNEL_URL="$(wait_for_tunnel_url 60)"

    echo "Cloudflare Quick Tunnel is running."
}


# ==========================================================
# Start Cloudflare Named Tunnel
# ==========================================================

start_named_tunnel() {

    install_cloudflared

    local cloudflared

    cloudflared="$(find_executable cloudflared)"

    echo "Starting Cloudflare Named Tunnel..."

    nohup "${cloudflared}" tunnel run \
        --token "${TUNNEL_TOKEN}" \
        --no-autoupdate \
        > "${TUNNEL_LOG}" 2>&1 &

    TUNNEL_PID=$!

    echo "${TUNNEL_PID}" > "${TUNNEL_PID_FILE}"

    sleep 3

    if ! kill -0 "${TUNNEL_PID}" 2>/dev/null; then
        echo "Error: Cloudflare Named Tunnel exited unexpectedly."

        if [[ -f "${TUNNEL_LOG}" ]]; then
            echo ""
            echo "Cloudflare log:"
            tail -n 30 "${TUNNEL_LOG}"
        fi

        return 1
    fi

    echo "Cloudflare Named Tunnel is running."
}


# ==========================================================
# Print connection information
# ==========================================================

print_connection_details() {

    local password

    password="$(read_code_server_password)"

    echo ""
    echo "======================================================"
    echo "CODE-SERVER IS READY"
    echo "======================================================"

    echo "Local URL:  http://127.0.0.1:${PORT}"
    echo "Workspace:  ${WORKSPACE}"
    echo "Password:   ${password}"

    if [[ "${TUNNEL_ENABLED}" == "true" ]]; then

        if [[ -n "${TUNNEL_TOKEN}" ]]; then

            echo "Tunnel:     Cloudflare Named Tunnel"

        else

            echo "Tunnel:     Cloudflare Quick Tunnel"
            echo "Public URL: ${TUNNEL_URL}"

        fi

    else

        echo "Tunnel:     Disabled"
        echo "Public URL: None"

    fi

    echo ""
    echo "Server log: ${SERVER_LOG}"

    if [[ "${TUNNEL_ENABLED}" == "true" ]]; then
        echo "Tunnel log: ${TUNNEL_LOG}"
    fi

    echo "======================================================"
}


# ==========================================================
# Supervise services
# ==========================================================

supervise_services() {

    echo ""
    echo "Foreground mode: press Ctrl+C to stop services."

    while true; do

        if [[ -n "${SERVER_PID}" ]] &&
           ! kill -0 "${SERVER_PID}" 2>/dev/null; then

            echo "code-server stopped."
            return 1
        fi

        if [[ "${TUNNEL_ENABLED}" == "true" ]] &&
           [[ -n "${TUNNEL_PID}" ]] &&
           ! kill -0 "${TUNNEL_PID}" 2>/dev/null; then

            echo "Cloudflare Tunnel stopped."
            return 1
        fi

        sleep 2
    done
}


# ==========================================================
# Parse arguments
# ==========================================================

while [[ $# -gt 0 ]]; do

    case "$1" in

        --tunnel)
            TUNNEL_ENABLED=true
            shift
            ;;

        --tunnel-token)

            if [[ $# -lt 2 ]]; then
                echo "Error: --tunnel-token requires a token."
                exit 1
            fi

            TUNNEL_TOKEN="$2"
            TUNNEL_ENABLED=true
            shift 2
            ;;

        --port)

            if [[ $# -lt 2 ]]; then
                echo "Error: --port requires a port number."
                exit 1
            fi

            PORT="$2"
            HEALTH_URL="http://127.0.0.1:${PORT}/healthz"

            shift 2
            ;;

        --workspace)

            if [[ $# -lt 2 ]]; then
                echo "Error: --workspace requires a path."
                exit 1
            fi

            WORKSPACE="$(realpath -m "$2")"

            LOG_DIR="${WORKSPACE}/log"
            SERVER_LOG="${LOG_DIR}/code-server.log"
            TUNNEL_LOG="${LOG_DIR}/cloudflared.log"

            mkdir -p "${WORKSPACE}" "${LOG_DIR}"

            shift 2
            ;;

        --foreground)
            FOREGROUND=true
            shift
            ;;

        --install-extensions|--install-extension|--extensions)
            INSTALL_EXTENSIONS=true
            shift
            ;;

        --help|-h)
            usage
            exit 0
            ;;

        *)
            echo "Error: Unknown argument: $1"
            echo ""
            usage
            exit 1
            ;;

    esac

done


# ==========================================================
# Recreate directories after argument parsing
# ==========================================================

mkdir -p \
    "${LOCAL_BIN}" \
    "${STATE_DIR}" \
    "${WORKSPACE}" \
    "${LOG_DIR}"


# ==========================================================
# Startup
# ==========================================================

echo ""
echo "======================================================"
echo "Starting services"
echo "======================================================"

echo "Workspace: ${WORKSPACE}"
echo "Port:      ${PORT}"
echo "Tunnel:    ${TUNNEL_ENABLED}"


# ----------------------------------------------------------
# Workspace preparation
# ----------------------------------------------------------

ensure_workspace_compatibility
copy_services_to_workspace


# ----------------------------------------------------------
# Start code-server
# ----------------------------------------------------------

if is_healthy; then

    echo "code-server is already running."

else

    start_code_server

fi


# ----------------------------------------------------------
# Install extensions
# ----------------------------------------------------------

if [[ "${INSTALL_EXTENSIONS}" == "true" ]]; then
    run_install_extensions
fi


# ----------------------------------------------------------
# Start Cloudflare only when explicitly requested
# ----------------------------------------------------------

if [[ "${TUNNEL_ENABLED}" == "true" ]]; then

    if [[ -n "${TUNNEL_TOKEN}" ]]; then
        start_named_tunnel
    else
        start_quick_tunnel
    fi

else

    echo "Cloudflare Tunnel is disabled."

fi


# ==========================================================
# Print information
# ==========================================================

print_connection_details


# ==========================================================
# Foreground mode
# ==========================================================

if [[ "${FOREGROUND}" == "true" ]]; then
    supervise_services
fi