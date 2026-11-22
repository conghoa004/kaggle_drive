#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$SCRIPT_DIR/tmp"

LOCAL_BIN="$HOME/.local/bin"
INFO_FILE="$TMP_DIR/info/server.info"
CONFIG_FILE="$TMP_DIR/config/config.yaml"
PID_FILE="$TMP_DIR/run/code-server.pid"
LOG_FILE="$TMP_DIR/logs/uninstall.log"

mkdir -p "$TMP_DIR/logs"
touch "$LOG_FILE"

exec > >(tee -a "$LOG_FILE") 2>&1

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

log "Starting code-server uninstall..."

# Stop the service first.
if [[ -f "$PID_FILE" ]]; then
    bash "$SCRIPT_DIR/stop.sh"
fi

# Remove executable and its dedicated standalone package.
if [[ -L "$LOCAL_BIN/code-server" ]]; then
    TARGET="$(readlink -f "$LOCAL_BIN/code-server" || true)"

    rm -f "$LOCAL_BIN/code-server"

    if [[ "$TARGET" == "$HOME/.local/lib/code-server/"* ]]; then
        PACKAGE_DIR="$(dirname "$(dirname "$TARGET")")"

        case "$PACKAGE_DIR" in
            "$HOME"/.local/lib/code-server/*)
                rm -rf -- "$PACKAGE_DIR"
                ;;
        esac
    fi

    log "Removed code-server executable."
elif [[ -f "$LOCAL_BIN/code-server" ]]; then
    rm -f "$LOCAL_BIN/code-server"
    log "Removed local executable."
fi

# Remove configuration and runtime state.
rm -f "$CONFIG_FILE"
rm -f "$PID_FILE"

# Preserve logs and info for auditing.
if [[ -f "$INFO_FILE" ]]; then
    sed -i \
        -e 's/^STATUS=.*/STATUS=uninstalled/' \
        -e 's/^PASSWORD=.*/PASSWORD=/' \
        -e 's/^PID=.*/PID=/' \
        "$INFO_FILE"
fi

log "code-server has been uninstalled."
log "Logs and service information have been preserved."
log "Data directory: $TMP_DIR"