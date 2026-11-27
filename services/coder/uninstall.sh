#!/usr/bin/env bash
set -Eeuo pipefail
: "${HOME:?HOME must be set}"
[[ "$HOME" != "/" ]] || { printf 'Error: refusing to uninstall with HOME=/\n' >&2; exit 1; }

STATE_DIR="${HOME}/.local/state/kaggle-code-server"
LOCAL_BIN_DIR="${HOME}/.local/bin"
LOCAL_LIB_DIR="${HOME}/.local/lib"
LOCAL_SHARE_DIR="${HOME}/.local/share"
CODE_SERVER_LINK="${LOCAL_BIN_DIR}/code-server"
CLOUDFLARED_LOCAL_BIN="${LOCAL_BIN_DIR}/cloudflared"
CODE_SERVER_DATA_DIR="${LOCAL_SHARE_DIR}/code-server"
CODE_SERVER_MARKER="${STATE_DIR}/code-server-install-dir"
CLOUDFLARED_MARKER="${STATE_DIR}/cloudflared-install-path"
CREDENTIAL_PATH_FILE="${STATE_DIR}/credentials-path"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTO_YES=false

info() { printf '%s\n' "$*"; }
error() { printf 'Error: %s\n' "$*" >&2; }

usage() {
    cat <<'EOF'
Usage: bash uninstall.sh [--yes] [--help]

Asks before removing this user's standalone code-server, local cloudflared,
state, credentials, and code-server user data. Workspace files and logs are kept.
EOF
}

confirm_uninstall() {
    [[ "$AUTO_YES" == true ]] && return 0
    if [[ ! -t 0 ]]; then
        error "Use --yes to confirm uninstall without a terminal."
        return 2
    fi
    cat <<'EOF'
This will stop managed services and remove:
  - Standalone code-server versions under ~/.local/lib/code-server-*.
  - The user-local cloudflared binary at ~/.local/bin/cloudflared, if present.
  - code-server state, credentials, and user data under ~/.local/share/code-server.

Workspace files and workspace logs are preserved. System installations are not removed.
EOF
    local answer
    read -r -p "Continue? [y/N]: " answer || true
    case "$answer" in
        y|Y|yes|YES) return 0 ;;
        *) info "Uninstall cancelled."; return 1 ;;
    esac
}

remove_code_server() {
    local install_dir target recorded_dir
    recorded_dir=""
    if [[ -f "$CODE_SERVER_MARKER" ]]; then
        recorded_dir="$(cat "$CODE_SERVER_MARKER" 2>/dev/null || true)"
        if [[ -n "$recorded_dir" ]]; then
            if [[ "$(dirname "$recorded_dir")" != "$LOCAL_LIB_DIR" || "${recorded_dir##*/}" != code-server-* ]]; then
                error "Invalid code-server install marker; skipping the marked directory."
                recorded_dir=""
            fi
        fi
    fi

    if [[ -L "$CODE_SERVER_LINK" ]]; then
        target="$(readlink -f "$CODE_SERVER_LINK" 2>/dev/null || true)"
        case "$target" in
            "$LOCAL_LIB_DIR"/code-server-*/bin/code-server)
                rm -f -- "$CODE_SERVER_LINK"
                ;;
        esac
    fi

    if [[ -n "$recorded_dir" && -d "$recorded_dir" ]]; then
        rm -rf -- "$recorded_dir"
        info "Removed standalone code-server at $recorded_dir"
    fi

    # Also clean versions installed by the previous scripts, which had no marker.
    for install_dir in "$LOCAL_LIB_DIR"/code-server-*; do
        [[ -d "$install_dir" ]] || continue
        [[ "$install_dir" == "$recorded_dir" ]] && continue
        rm -rf -- "$install_dir"
        info "Removed standalone code-server at $install_dir"
    done
}

remove_cloudflared() {
    local recorded_path
    [[ -f "$CLOUDFLARED_LOCAL_BIN" ]] || return 0
    if [[ -f "$CLOUDFLARED_MARKER" ]]; then
        recorded_path="$(cat "$CLOUDFLARED_MARKER" 2>/dev/null || true)"
        [[ "$recorded_path" == "$CLOUDFLARED_LOCAL_BIN" ]] || {
            info "Leaving cloudflared because it is not recorded as this script's install."
            return 0
        }
    fi
    rm -f -- "$CLOUDFLARED_LOCAL_BIN"
    info "Removed user-local cloudflared."
}

main() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --yes|-y) AUTO_YES=true; shift ;;
            --help|-h) usage; return 0 ;;
            *) error "Unknown option: $1"; usage >&2; return 2 ;;
        esac
    done

    if confirm_uninstall; then
        :
    else
        local status=$?
        [[ "$status" == 1 ]] && return 0
        return "$status"
    fi

    bash "${SCRIPT_DIR}/stop.sh"
    remove_code_server
    remove_cloudflared
    if [[ -d "$CODE_SERVER_DATA_DIR" ]]; then
        rm -rf -- "$CODE_SERVER_DATA_DIR"
        info "Removed code-server user data."
    fi
    if [[ -f "$CREDENTIAL_PATH_FILE" ]]; then
        credential_path="$(cat "$CREDENTIAL_PATH_FILE" 2>/dev/null || true)"
        if [[ "$credential_path" == /* && "${credential_path##*/}" == login.txt && -f "$credential_path" ]]; then
            rm -f -- "$credential_path"
            info "Removed login file: $credential_path"
        fi
    fi
    if [[ -d "$STATE_DIR" ]]; then
        rm -rf -- "$STATE_DIR"
        info "Removed code-server state and credentials."
    fi
    info "Uninstall complete. Workspace files and workspace logs were preserved."
}
main "$@"
