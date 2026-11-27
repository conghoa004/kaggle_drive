#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="https://github.com/conghoa004/ws_bridge.git"
TARGET_DIR="ws_bridge"

FILES=(
    "config.client.toml"
    "config.server.toml"
    "wsb.txt"
)

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

echo "Operating System : $OS"
echo "Branch           : $BRANCH"
echo "Repository       : $REPO_URL"
echo "Target Directory : $TARGET_DIR"
echo ""

# Check existing directory
if [[ -e "$TARGET_DIR" ]]; then
    echo "Error: Target directory already exists: $TARGET_DIR"
    exit 1
fi

# Clone selected branch
echo "[1/3] Cloning branch '$BRANCH'..."

git clone -b "$BRANCH" --single-branch "$REPO_URL" "$TARGET_DIR"

# Verify required files
echo "[2/3] Checking required files..."

for FILE in "${FILES[@]}"; do
    if [[ ! -f "$TARGET_DIR/$FILE" ]]; then
        echo "Error: Required file not found: $FILE"
        echo "The cloned directory has been preserved: $TARGET_DIR"
        exit 1
    fi
done

# Copy selected files to current directory
echo "Copying files..."

for FILE in "${FILES[@]}"; do
    cp -f -- "$TARGET_DIR/$FILE" .
    echo "Copied: $FILE"
done

# Remove cloned directory
echo "[3/3] Removing temporary repository directory..."

rm -rf -- "$TARGET_DIR"

echo ""
echo "=========================================="
echo "       Operation Completed Successfully"
echo "=========================================="
echo "Destination: $(pwd)"
echo ""
echo "Files copied:"

for FILE in "${FILES[@]}"; do
    echo " - $FILE"
done

echo ""
echo "Temporary repository directory removed."
