#!/usr/bin/env bash

set -Eeuo pipefail

# ==========================================
# Configuration
# ==========================================

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$SCRIPT_DIR/tmp"

LOCAL_BIN="$HOME/.local/bin"

PORT="${CODE_SERVER_PORT:-8082}"
HOST="127.0.0.1"
WORKSPACE="${KAGGLE_WORKING_DIR:-/kaggle/working}"

CONFIG_FILE="$TMP_DIR/config.yaml"
PID_FILE="$TMP_DIR/code-server.pid"
INFO_FILE="$TMP_DIR/info.txt"

INSTALL_LOG="$TMP_DIR/install.log"
SERVER_LOG="$TMP_DIR/server.log"

# ==========================================
# Initialization
# ==========================================

mkdir -p "$TMP_DIR" "$LOCAL_BIN"

touch "$INSTALL_LOG"
chmod 600 "$INSTALL_LOG"

exec > >(tee -a "$INSTALL_LOG") 2>&1

export PATH="$LOCAL_BIN:$PATH"

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
# Environment checks
# ==========================================

if [[ "$(uname -s)" != "Linux" ]] || [[ ! -d /proc ]]; then
    die "This script requires a Linux environment."
fi

for dependency in bash curl python3; do
    command -v "$dependency" >/dev/null 2>&1 || \
        die "Missing dependency: $dependency"
done

[[ "$PORT" =~ ^[0-9]{1,5}$ ]] && (( PORT > 0 && PORT <= 65535 )) || \
    die "Invalid CODE_SERVER_PORT: $PORT"

mkdir -p "$WORKSPACE"

# ==========================================
# Check installation
# ==========================================

if command -v code-server >/dev/null 2>&1; then
    CODE_SERVER_BIN="$(command -v code-server)"
    log "code-server is already installed."
else
    log "Installing code-server..."

    curl -fsSL https://code-server.dev/install.sh | \
        sh -s -- --method=standalone

    export PATH="$LOCAL_BIN:$PATH"

    CODE_SERVER_BIN="$(command -v code-server || true)"

    [[ -n "$CODE_SERVER_BIN" ]] || \
        die "code-server installation failed."
fi

# ==========================================
# Generate configuration
# ==========================================

if [[ ! -f "$CONFIG_FILE" ]]; then

    PASSWORD="$(python3 -c \
        'import secrets; print(secrets.token_urlsafe(24))')"

    cat > "$CONFIG_FILE" <<EOF
bind-addr: ${HOST}:${PORT}
auth: password
password: ${PASSWORD}
cert: false
EOF

    chmod 600 "$CONFIG_FILE"

    log "Configuration created."

else
    PASSWORD="$(sed -n \
        's/^password:[[:space:]]*//p' "$CONFIG_FILE" | head -n 1)"

    [[ -n "$PASSWORD" ]] || \
        die "Existing configuration has no password."

    log "Existing configuration preserved."
fi

# ==========================================
# Save service information
# ==========================================

INSTALLED_AT="$(date '+%Y-%m-%d %H:%M:%S')"

cat > "$INFO_FILE" <<EOF
name:Code Server
description:Browser-based VS Code environment
status:installed
host:${HOST}
port:${PORT}
url:http://${HOST}:${PORT}
workspace:${WORKSPACE}
auth:password
password:${PASSWORD}
pid:
config_file:${CONFIG_FILE}
log_file:${SERVER_LOG}
installed_at:${INSTALLED_AT}
started_at:
EOF

chmod 600 "$INFO_FILE"

# ==========================================
# Complete
# ==========================================

log "=========================================="
log "code-server installation completed."
log "=========================================="
log "Executable : $CODE_SERVER_BIN"
log "Config     : $CONFIG_FILE"
log "Info       : $INFO_FILE"
log "Log        : $INSTALL_LOG"