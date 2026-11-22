#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$SCRIPT_DIR/tmp"

LOCAL_BIN="$HOME/.local/bin"
CONFIG_DIR="$TMP_DIR/config"
INFO_DIR="$TMP_DIR/info"
LOG_DIR="$TMP_DIR/logs"
RUN_DIR="$TMP_DIR/run"

CONFIG_FILE="$CONFIG_DIR/config.yaml"
INFO_FILE="$INFO_DIR/server.info"
LOG_FILE="$LOG_DIR/install.log"

PORT="${CODE_SERVER_PORT:-8080}"
HOST="127.0.0.1"
WORKSPACE="${KAGGLE_WORKING_DIR:-/kaggle/working}"

mkdir -p "$LOCAL_BIN" "$CONFIG_DIR" "$INFO_DIR" "$LOG_DIR" "$RUN_DIR"
touch "$LOG_FILE"
chmod 600 "$LOG_FILE"

exec > >(tee -a "$LOG_FILE") 2>&1

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

die() {
    log "ERROR: $*"
    exit 1
}

log "Starting code-server installation..."

command -v bash >/dev/null || die "bash is required."
command -v curl >/dev/null || die "curl is required."
command -v python3 >/dev/null || die "python3 is required."

export PATH="$LOCAL_BIN:$PATH"

if ! command -v code-server >/dev/null 2>&1; then
    log "Installing code-server..."

    curl -fsSL https://code-server.dev/install.sh | \
        sh -s -- --method=standalone
fi

CODE_SERVER_BIN="$(command -v code-server || true)"

[[ -n "$CODE_SERVER_BIN" ]] || die "code-server installation failed."

mkdir -p "$WORKSPACE"

if [[ ! -f "$CONFIG_FILE" ]]; then
    PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"

    cat > "$CONFIG_FILE" <<EOF
bind-addr: ${HOST}:${PORT}
auth: password
password: ${PASSWORD}
cert: false
EOF

    chmod 600 "$CONFIG_FILE"
fi

PASSWORD="$(sed -n 's/^password:[[:space:]]*//p' "$CONFIG_FILE" | head -n 1)"

cat > "$INFO_FILE" <<EOF
SERVICE=code-server
STATUS=installed

HOST=${HOST}
PORT=${PORT}
URL=http://${HOST}:${PORT}

WORKSPACE=${WORKSPACE}

AUTH=password
PASSWORD=${PASSWORD}

PID=
CONFIG_FILE=${CONFIG_FILE}
LOG_FILE=${LOG_DIR}/server.log

STARTED_AT=
INSTALLED_AT=$(date '+%Y-%m-%d %H:%M:%S')
EOF

chmod 600 "$INFO_FILE"

log "code-server installation completed."
log "Executable: $CODE_SERVER_BIN"
log "Configuration: $CONFIG_FILE"
log "Information: $INFO_FILE"