#!/usr/bin/env bash
set -Eeuo pipefail
: "${HOME:?HOME must be set}"

STATE_DIR="${HOME}/.local/state/kaggle-code-server"
LOCAL_BIN_DIR="${HOME}/.local/bin"
LOCAL_LIB_DIR="${HOME}/.local/lib"
CODE_SERVER_MARKER="${STATE_DIR}/code-server-install-dir"
CLOUDFLARED_MARKER="${STATE_DIR}/cloudflared-install-path"
WITH_CLOUDFLARED=false

info() { printf '%s\n' "$*"; }
error() { printf 'Error: %s\n' "$*" >&2; }

usage() {
    cat <<'EOF'
Usage: bash install.sh [install options] [start options]

Install options:
  --with-cloudflared       Install Cloudflare Tunnel support
  --help                   Show this help

Start options:
  --tunnel                 Install cloudflared and start a Quick Tunnel
  --tunnel-token TOKEN     Install cloudflared and start a Named Tunnel
  --port PORT              Set code-server port
  --workspace PATH         Set the workspace
  --foreground             Keep the script attached to code-server
  --install-extensions     Install recommended extensions before starting

Examples:
  bash install.sh
  bash install.sh --tunnel
  bash install.sh --tunnel-token YOUR_TOKEN
  bash install.sh --port 8080 --workspace /kaggle/working
EOF
}
find_code_server() {
    local candidate
    if command -v code-server >/dev/null 2>&1; then
        command -v code-server
        return 0
    fi
    candidate="${LOCAL_BIN_DIR}/code-server"
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
    if [[ -d "$LOCAL_LIB_DIR" ]]; then
        candidate="$(find "$LOCAL_LIB_DIR" -type f -path '*/bin/code-server' -executable -print 2>/dev/null | sort -V | tail -n 1 || true)"
        [[ -n "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
    fi
    return 1
}

install_code_server() {
    local binary real_binary install_dir
    if binary="$(find_code_server)"; then
        info "code-server is already available: $binary"
        return 0
    fi
    command -v curl >/dev/null 2>&1 || { error "curl is required."; return 1; }

    info "Installing standalone code-server..."
    curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone
    binary="$(find_code_server)" || { error "code-server installation failed."; return 1; }

    real_binary="$(readlink -f "$binary" 2>/dev/null || printf '%s' "$binary")"
    install_dir="${real_binary%/bin/code-server}"
    case "$install_dir" in
        "${LOCAL_LIB_DIR}"/code-server-*)
            mkdir -p "$STATE_DIR"
            printf '%s\n' "$install_dir" > "$CODE_SERVER_MARKER"
            ;;
    esac
    info "code-server is ready: $binary"
}

install_cloudflared() {
    local binary arch tmp
    binary="${LOCAL_BIN_DIR}/cloudflared"
    if command -v cloudflared >/dev/null 2>&1; then
        info "cloudflared is already available: $(command -v cloudflared)"
        return 0
    fi
    if [[ -x "$binary" ]]; then
        info "cloudflared is already available: $binary"
        return 0
    fi
    command -v curl >/dev/null 2>&1 || { error "curl is required."; return 1; }
    [[ "$(uname -s)" == Linux ]] || { error "cloudflared download requires Linux."; return 1; }
    case "$(uname -m)" in
        x86_64|amd64) arch=amd64 ;;
        aarch64|arm64) arch=arm64 ;;
        *) error "Unsupported architecture: $(uname -m)"; return 1 ;;
    esac

    mkdir -p "$LOCAL_BIN_DIR" "$STATE_DIR"
    tmp="${binary}.download"
    info "Downloading cloudflared..."
    if ! curl -fL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}" -o "$tmp"; then
        rm -f -- "$tmp"
        return 1
    fi
    chmod 755 "$tmp"
    mv -f -- "$tmp" "$binary"
    printf '%s\n' "$binary" > "$CLOUDFLARED_MARKER"
    info "cloudflared is ready: $binary"
}

main() {
    local script_dir
    local -a start_args=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --with-cloudflared)
                WITH_CLOUDFLARED=true
                shift
                ;;
            --tunnel)
                WITH_CLOUDFLARED=true
                start_args+=("$1")
                shift
                ;;
            --tunnel-token)
                [[ -n "${2:-}" ]] || { error "--tunnel-token requires a value."; return 2; }
                WITH_CLOUDFLARED=true
                start_args+=("$1" "$2")
                shift 2
                ;;
            --port|--workspace)
                [[ -n "${2:-}" ]] || { error "$1 requires a value."; return 2; }
                start_args+=("$1" "$2")
                shift 2
                ;;
            --foreground|--install-extensions)
                start_args+=("$1")
                shift
                ;;
            --help|-h)
                usage
                return 0
                ;;
            *)
                error "Unknown option: $1"
                usage >&2
                return 2
                ;;
        esac
    done

    [[ "$(uname -s)" == Linux ]] || { error "This installer requires Linux."; return 1; }
    mkdir -p "$STATE_DIR"
    install_code_server
    if [[ "$WITH_CLOUDFLARED" == true ]]; then
        install_cloudflared
    fi

    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    info "Installation complete; starting code-server..."
    bash "${script_dir}/start.sh" "${start_args[@]}"
}
main "$@"