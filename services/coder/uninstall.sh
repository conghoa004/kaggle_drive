#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
TMP_DIR="$SCRIPT_DIR/tmp"
LOCAL_BIN="$HOME/.local/bin"
LOCAL_LIB="$HOME/.local/lib"
STATE_DIR="${CODE_SERVER_STATE_DIR:-$HOME/.local/state/kaggle-code-server}"
USER_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/code-server"
PURGE_USER_DATA=false

usage() {
    cat <<EOF
Usage: bash uninstall.sh [--purge-user-data]

Uninstalls the user-local code-server installation and removes its login files.
Workspace and code-server settings/extensions are kept by default.

  --purge-user-data  Also delete code-server settings and extensions after confirmation.
  -h, --help         Show this help.
EOF
}

for arg in "$@"; do
    case "$arg" in
        --purge-user-data)
            PURGE_USER_DATA=true
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if [[ "$PURGE_USER_DATA" == true ]]; then
    if [[ ! -t 0 ]]; then
        echo "ERROR: --purge-user-data requires an interactive confirmation." >&2
        exit 1
    fi

    if [[ "$USER_DATA_DIR" != /* || "${USER_DATA_DIR##*/}" != "code-server" || "$USER_DATA_DIR" == "/code-server" ]]; then
        echo "ERROR: Refusing to remove unexpected user-data path: $USER_DATA_DIR" >&2
        exit 1
    fi

    echo "This will permanently delete code-server settings and extensions at:"
    echo "  $USER_DATA_DIR"
    read -r -p 'Type DELETE to confirm: ' confirmation

    if [[ "$confirmation" != "DELETE" ]]; then
        echo "Cancelled."
        exit 1
    fi
fi

echo "Stopping code-server if it is running..."
bash "$SCRIPT_DIR/stop.sh"

if [[ -e "$LOCAL_BIN/code-server" || -L "$LOCAL_BIN/code-server" ]]; then
    rm -f "$LOCAL_BIN/code-server"
fi

if [[ -d "$LOCAL_LIB" ]]; then
    find "$LOCAL_LIB" -mindepth 1 -maxdepth 1 -type d -name 'code-server-*' -exec rm -rf -- {} +
fi

rm -f \
    "$STATE_DIR/config.yaml" \
    "$STATE_DIR/code-server.pid" \
    "$TMP_DIR/credentials.txt" \
    "$TMP_DIR/info.txt"

if [[ -d "$TMP_DIR" ]]; then
    find "$TMP_DIR" -maxdepth 1 -type f -name '*.log' -delete
fi

if [[ -d "$TMP_DIR" ]]; then
    rmdir "$TMP_DIR" 2>/dev/null || true
fi

if [[ -d "$STATE_DIR" ]]; then
    rmdir "$STATE_DIR" 2>/dev/null || true
fi

if [[ "$PURGE_USER_DATA" == true && -e "$USER_DATA_DIR" ]]; then
    rm -rf -- "$USER_DATA_DIR"
fi

echo "User-local code-server installation removed."
if [[ "$PURGE_USER_DATA" == true ]]; then
    echo "Workspace preserved. Settings and extensions removed."
else
    echo "Workspace, settings, and extensions preserved."
fi
