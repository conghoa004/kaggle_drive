#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="https://github.com/conghoa004/ws_bridge.git"

echo "=========================================="
echo "       ws_bridge Repository Cloner"
echo "=========================================="

# Check Git installation
if ! command -v git >/dev/null 2>&1; then
    echo "Error: Git is not installed."
    exit 1
fi

# Detect operating system
OS="$(uname -s)"

case "$OS" in
    Linux*)
        BRANCH="linux"
        ;;
    MINGW*|MSYS*|CYGWIN*)
        BRANCH="win"
        ;;
    *)
        echo "Error: Unsupported operating system: $OS"
        exit 1
        ;;
esac

TARGET_DIR="ws_bridge"

echo "Operating System : $OS"
echo "Branch           : $BRANCH"
echo "Repository       : $REPO_URL"
echo "Target Directory : $TARGET_DIR"
echo ""

# Check existing directory
if [[ -e "$TARGET_DIR" ]]; then
    echo "Error: Target already exists: $TARGET_DIR"
    exit 1
fi

# Clone selected branch
echo "[1/1] Cloning branch '$BRANCH'..."

git clone -b "$BRANCH" --single-branch "$REPO_URL" "$TARGET_DIR"

echo ""
echo "Clone completed successfully."
echo "Location: $TARGET_DIR"
echo "Branch: $BRANCH"