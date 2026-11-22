#!/usr/bin/env bash

set -Eeuo pipefail

# ==========================================
# Configuration
# ==========================================

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$SCRIPT_DIR/tmp"

LOCAL_BIN="$HOME/.local/bin"

CONFIG_FILE="$TMP_DIR/config.yaml"
PID_FILE="$TMP_DIR/code-server.pid"
INFO_FILE="$TMP_DIR/info.txt"

UNINSTALL_LOG="$TMP_DIR/uninstall.log"

# ==========================================
# Initialization
# ==========================================

mkdir -p "$TMP_DIR"

touch "$UNINSTALL_LOG"
chmod 600 "$UNINSTALL_LOG"

exec > >(tee -a "$UNINSTALL_LOG") 2>&1

# ==========================================
# Logging
# ==========================================

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

die() {
    log "ERROR: $*"
    exit 1
}

# ==========================================
# Stop service
# ==========================================

log "Starting code-server uninstall..."

log "Stopping code-server if it is running..."
bash "$SCRIPT_DIR/stop.sh" || \
    die "Could not safely stop code-server."

# ==========================================
# Remove standalone installation
# ==========================================

CODE_SERVER_LINK="$LOCAL_BIN/code-server"

if [[ -L "$CODE_SERVER_LINK" ]]; then

    TARGET="$(readlink -f "$CODE_SERVER_LINK" || true)"

    rm -f "$CODE_SERVER_LINK"

    if [[ "$TARGET" == "$HOME"/.local/lib/code-server-*/bin/code-server ]]; then

        PACKAGE_DIR="$(dirname "$(dirname "$TARGET")")"

        log "Removing standalone package: $PACKAGE_DIR"

        rm -rf -- "$PACKAGE_DIR"

    fi

    log "Executable link removed."

elif [[ -f "$CODE_SERVER_LINK" ]]; then

    log "Removing local executable."
    rm -f "$CODE_SERVER_LINK"

else

    log "No local standalone executable found."

fi

# ==========================================
# Remove configuration and runtime files
# ==========================================

rm -f "$CONFIG_FILE"
rm -f "$PID_FILE"

log "Configuration removed."
log "PID file removed."

# ==========================================
# Update information
# ==========================================

if [[ -f "$INFO_FILE" ]]; then

    sed -i \
        -e 's/^status:.*/status:uninstalled/' \
        -e 's/^password:.*/password:' \
        -e 's/^pid:.*/pid:' \
        "$INFO_FILE"

fi

# ==========================================
# Complete
# ==========================================

log "=========================================="
log "code-server uninstall completed."
log "=========================================="

log "Executable : Removed (if locally installed)"
log "Config     : Removed"
log "Password   : Cleared"
log "PID        : Removed"
log "Logs       : Preserved"
log "Info       : Preserved"

log "Data directory: $TMP_DIR"