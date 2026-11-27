#!/usr/bin/env bash
set -Eeuo pipefail
: "${HOME:?HOME must be set}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${HOME}/.local/state/kaggle-code-server"
LOCAL_BIN_DIR="${HOME}/.local/bin"
LOCAL_LIB_DIR="${HOME}/.local/lib"
CONFIG_FILE="${STATE_DIR}/config.yaml"
CODE_SERVER_PID_FILE="${STATE_DIR}/code-server.pid"
CLOUDFLARED_PID_FILE="${STATE_DIR}/cloudflared.pid"
CREDENTIAL_FILE="${STATE_DIR}/login.txt"

PORT="${CODE_SERVER_PORT:-8001}"
WORKSPACE="${WORKSPACE_DIR:-${KAGGLE_WORKING_DIR:-/workspaces}}"
TUNNEL_ENABLED=false
TUNNEL_TOKEN=""
FOREGROUND=false
INSTALL_EXTENSIONS=false
TUNNEL_URL="Disabled"
CODE_SERVER_BIN=""
CLOUDFLARED_BIN=""

info() { printf '%s\n' "$*"; }
error() { printf 'Error: %s\n' "$*" >&2; }

usage() {
    cat <<'EOF'
Usage: bash start.sh [options]
  --tunnel                  Start a Cloudflare Quick Tunnel
  --tunnel-token TOKEN      Start a Cloudflare Named Tunnel
  --port PORT              Set the code-server port (default: 8001)
  --workspace PATH         Set the workspace (default: /workspaces)
  --foreground             Keep this script attached to code-server
  --install-extensions     Install recommended extensions
  --help                   Show this help

Examples:
  bash start.sh
  bash start.sh --tunnel
  bash start.sh --tunnel-token YOUR_TOKEN
EOF
}

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --tunnel) TUNNEL_ENABLED=true; shift ;;
            --tunnel-token)
                [[ -n "${2:-}" ]] || { error "--tunnel-token requires a value."; return 2; }
                TUNNEL_ENABLED=true; TUNNEL_TOKEN="$2"; shift 2 ;;
            --port)
                [[ -n "${2:-}" ]] || { error "--port requires a value."; return 2; }
                PORT="$2"; shift 2 ;;
            --workspace)
                [[ -n "${2:-}" ]] || { error "--workspace requires a path."; return 2; }
                WORKSPACE="$2"; shift 2 ;;
            --foreground) FOREGROUND=true; shift ;;
            --install-extensions) INSTALL_EXTENSIONS=true; shift ;;
            --help|-h) usage; exit 0 ;;
            *) error "Unknown option: $1"; usage >&2; return 2 ;;
        esac
    done
    [[ "$PORT" =~ ^[0-9]{1,5}$ ]] || { error "Invalid port: $PORT"; return 2; }
    PORT=$((10#$PORT))
    (( PORT >= 1 && PORT <= 65535 )) || { error "Port must be between 1 and 65535."; return 2; }
    [[ -n "$WORKSPACE" ]] || { error "Workspace path cannot be empty."; return 2; }
}

find_code_server() {
    local candidate
    if command -v code-server >/dev/null 2>&1; then
        CODE_SERVER_BIN="$(command -v code-server)"
        return 0
    fi
    candidate="${LOCAL_BIN_DIR}/code-server"
    if [[ -x "$candidate" ]]; then CODE_SERVER_BIN="$candidate"; return 0; fi
    if [[ -d "$LOCAL_LIB_DIR" ]]; then
        candidate="$(find "$LOCAL_LIB_DIR" -type f -path '*/bin/code-server' -executable -print 2>/dev/null | sort -V | tail -n 1 || true)"
        if [[ -n "$candidate" ]]; then CODE_SERVER_BIN="$candidate"; return 0; fi
    fi
    return 1
}

generate_password() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
    elif command -v python3 >/dev/null 2>&1; then
        python3 -c 'import secrets; print(secrets.token_hex(32))'
    else
        error "Install openssl or python3 to generate a password."
        return 1
    fi
}

write_config_and_credentials() {
    local password
    mkdir -p "$STATE_DIR"
    if [[ -f "$CONFIG_FILE" ]]; then
        password="$(sed -n 's/^password:[[:space:]]*//p' "$CONFIG_FILE" | head -n 1)"
    else
        password=""
    fi
    [[ -n "$password" ]] || password="$(generate_password)"
    cat > "$CONFIG_FILE" <<EOF
bind-addr: 127.0.0.1:${PORT}
auth: password
password: ${password}
cert: false
EOF
    chmod 600 "$CONFIG_FILE"
    cat > "$CREDENTIAL_FILE" <<EOF
Code Server Login
=================

Local URL: http://127.0.0.1:${PORT}
Username: Not required
Password: ${password}

Workspace: ${WORKSPACE}
Port: ${PORT}
Cloudflare Tunnel: ${TUNNEL_URL}
EOF
    chmod 600 "$CREDENTIAL_FILE"
}

install_extensions() {
    local extension
    local extensions=(ms-python.python ms-toolsai.jupyter dbaeumer.vscode-eslint esbenp.prettier-vscode bmewburn.vscode-intelephense-client mtxr.sqltools ms-azuretools.vscode-docker eamodio.gitlens)
    for extension in "${extensions[@]}"; do
        info "Installing extension: $extension"
        "$CODE_SERVER_BIN" --install-extension "$extension" --force || info "Could not install $extension; continuing."
    done
}

start_code_server() {
    info "Starting code-server..."
    nohup "$CODE_SERVER_BIN" --config "$CONFIG_FILE" --disable-telemetry "$WORKSPACE" >> "$CODE_SERVER_LOG" 2>&1 < /dev/null &
    local pid=$!
    printf '%s\n' "$pid" > "$CODE_SERVER_PID_FILE"
    sleep 2
    if ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$CODE_SERVER_PID_FILE"
        error "code-server failed to start. See $CODE_SERVER_LOG"
        return 1
    fi
    info "code-server started (PID $pid)."
}

start_quick_tunnel() {
    : > "$CLOUDFLARED_LOG"
    info "Starting Cloudflare Quick Tunnel..."
    nohup "$CLOUDFLARED_BIN" tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate >> "$CLOUDFLARED_LOG" 2>&1 < /dev/null &
    local pid=$!
    printf '%s\n' "$pid" > "$CLOUDFLARED_PID_FILE"
    for _ in {1..30}; do
        TUNNEL_URL="$(grep -oE 'https://[[:alnum:].-]+\.trycloudflare\.com' "$CLOUDFLARED_LOG" 2>/dev/null | tail -n 1 || true)"
        [[ -n "$TUNNEL_URL" ]] && break
        if ! kill -0 "$pid" 2>/dev/null; then error "cloudflared stopped. See $CLOUDFLARED_LOG"; return 1; fi
        sleep 1
    done
    [[ -n "$TUNNEL_URL" ]] || { error "Could not detect the tunnel URL. See $CLOUDFLARED_LOG"; return 1; }
    info "Public URL: $TUNNEL_URL"
}

start_named_tunnel() {
    : > "$CLOUDFLARED_LOG"
    info "Starting Cloudflare Named Tunnel..."
    nohup "$CLOUDFLARED_BIN" tunnel run --token "$TUNNEL_TOKEN" --no-autoupdate >> "$CLOUDFLARED_LOG" 2>&1 < /dev/null &
    local pid=$!
    printf '%s\n' "$pid" > "$CLOUDFLARED_PID_FILE"
    sleep 2
    if ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$CLOUDFLARED_PID_FILE"
        error "Named Tunnel failed to start. See $CLOUDFLARED_LOG"
        return 1
    fi
    TUNNEL_URL="Named Tunnel is running; use the hostname configured in Cloudflare."
}

cleanup() { bash "${SCRIPT_DIR}/stop.sh" >/dev/null 2>&1 || true; }

main() {
    parse_arguments "$@"
    find_code_server || { error "code-server is missing. Run bash install.sh first."; return 1; }
    if [[ "$TUNNEL_ENABLED" == true ]]; then
        if command -v cloudflared >/dev/null 2>&1; then
            CLOUDFLARED_BIN="$(command -v cloudflared)"
        elif [[ -x "${LOCAL_BIN_DIR}/cloudflared" ]]; then
            CLOUDFLARED_BIN="${LOCAL_BIN_DIR}/cloudflared"
        else
            error "cloudflared is missing. Run bash install.sh --with-cloudflared."
            return 1
        fi
    fi

    mkdir -p "$WORKSPACE"
    WORKSPACE="$(cd "$WORKSPACE" && pwd)"
    LOG_DIR="${WORKSPACE}/log"
    CODE_SERVER_LOG="${LOG_DIR}/code-server.log"
    CLOUDFLARED_LOG="${LOG_DIR}/cloudflared.log"
    mkdir -p "$LOG_DIR" "$STATE_DIR"

    write_config_and_credentials
    [[ "$INSTALL_EXTENSIONS" == false ]] || install_extensions
    bash "${SCRIPT_DIR}/stop.sh"
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    start_code_server
    if [[ "$TUNNEL_ENABLED" == true ]]; then
        if [[ -n "$TUNNEL_TOKEN" ]]; then start_named_tunnel; else start_quick_tunnel; fi
    fi
    write_config_and_credentials

    printf '\nServices started\nLocal URL: http://127.0.0.1:%s\nWorkspace: %s\nCode-server log: %s\n' "$PORT" "$WORKSPACE" "$CODE_SERVER_LOG"
    if [[ "$TUNNEL_ENABLED" == true ]]; then
        printf 'Cloudflare Tunnel: %s\nCloudflared log: %s\n' "$TUNNEL_URL" "$CLOUDFLARED_LOG"
    fi
    printf 'Login file: %s\n' "$CREDENTIAL_FILE"

    if [[ "$FOREGROUND" == true ]]; then
        info "Foreground mode: press Ctrl+C to stop."
        local pid
        pid="$(cat "$CODE_SERVER_PID_FILE")"
        wait "$pid" || true
    else
        trap - EXIT INT TERM
    fi
}

LOG_DIR=""
CODE_SERVER_LOG=""
CLOUDFLARED_LOG=""
main "$@"