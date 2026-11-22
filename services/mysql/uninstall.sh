#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
TMP_DIR="$SCRIPT_DIR/tmp"
CREDENTIAL_FILE="$TMP_DIR/phpmyadmin_credentials.txt"
INFO_FILE="$TMP_DIR/info.txt"
PURGE_DATA=false

for arg in "$@"; do
    case "$arg" in
        --purge-data)
            PURGE_DATA=true
            ;;
        -h|--help)
            echo "Usage: bash uninstall.sh [--purge-data]"
            echo "Default: remove packages and preserve MySQL data and credentials."
            echo "--purge-data: also delete /var/lib/mysql and the generated credentials file."
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg"
            echo "Use --help for usage."
            exit 1
            ;;
    esac
done

if [[ "$(id -u)" -ne 0 ]]; then
    echo "ERROR: Run this script as root."
    exit 1
fi

if [[ "$PURGE_DATA" == true ]]; then
    if [[ ! -t 0 ]]; then
        echo "ERROR: --purge-data requires an interactive terminal confirmation."
        exit 1
    fi
    echo "WARNING: This permanently deletes MySQL database files and generated credentials."
    read -r -p "Type DELETE to continue: " confirmation
    if [[ "$confirmation" != DELETE ]]; then
        echo "Cancelled."
        exit 1
    fi
fi

STOP_SCRIPT="$SCRIPT_DIR/stop.sh"

if [[ ! -f "$STOP_SCRIPT" ]]; then
    echo "ERROR: Stop script not found: $STOP_SCRIPT"
    exit 1
fi

echo "Stopping MySQL and Apache..."
bash "$STOP_SCRIPT"

if command -v a2disconf >/dev/null 2>&1; then
    a2disconf homepage-redirect >/dev/null 2>&1 || true
    a2disconf phpmyadmin >/dev/null 2>&1 || true
fi
rm -f /etc/apache2/conf-available/homepage-redirect.conf

APACHE_PORTS_CONF=/etc/apache2/ports.conf
APACHE_DEFAULT_SITE=/etc/apache2/sites-available/000-default.conf

if [[ -f "$APACHE_PORTS_CONF" ]] &&
    grep -Eq '^[[:space:]]*Listen[[:space:]]+8081([[:space:]]|$)' "$APACHE_PORTS_CONF" &&
    ! grep -Eq '^[[:space:]]*Listen[[:space:]]+80([[:space:]]|$)' "$APACHE_PORTS_CONF"; then
    sed -i -E 's/^[[:space:]]*Listen[[:space:]]+8081([[:space:]]|$)/Listen 80/' "$APACHE_PORTS_CONF"
fi

if [[ -f "$APACHE_DEFAULT_SITE" ]] &&
    grep -Fq '<VirtualHost *:8081>' "$APACHE_DEFAULT_SITE" &&
    ! grep -Fq '<VirtualHost *:80>' "$APACHE_DEFAULT_SITE"; then
    sed -i 's@<VirtualHost \*:8081>@<VirtualHost *:80>@' "$APACHE_DEFAULT_SITE"
fi

export DEBIAN_FRONTEND=noninteractive

echo "Removing MySQL, Apache, PHP, and phpMyAdmin packages..."
PHP_VERSIONED_PACKAGES=()
while IFS= read -r package; do
    if [[ "$package" =~ ^php[0-9]+\.[0-9]+(-.*)?$ ]] ||
        [[ "$package" =~ ^libapache2-mod-php[0-9]+\.[0-9]+$ ]]; then
        PHP_VERSIONED_PACKAGES+=("$package")
    fi
done < <(dpkg-query -W -f='${Package}\n' 2>/dev/null || true)

apt-get purge -y \
    phpmyadmin \
    mysql-server \
    apache2 \
    "${PHP_VERSIONED_PACKAGES[@]}" \
    php \
    php-cli \
    php-common \
    php-mysql \
    php-mbstring \
    php-xml \
    php-curl \
    php-zip \
    php-gd \
    php-intl \
    libapache2-mod-php

apt-get autoremove --purge -y

if [[ -d "$TMP_DIR" ]]; then
    find "$TMP_DIR" -maxdepth 1 -type f -name '*.log' -delete
fi

if [[ "$PURGE_DATA" == true ]]; then
    echo "Deleting MySQL database files and generated credentials..."
    rm -rf -- /var/lib/mysql /var/log/mysql
    rm -f -- /var/log/mysql_safe.log "$CREDENTIAL_FILE" "$INFO_FILE"
    echo "Database data and generated credentials removed."
else
    echo "MySQL data was preserved at /var/lib/mysql (if present)."
    echo "Generated credentials were preserved at $CREDENTIAL_FILE (if present)."
    echo "To remove both, rerun this script with --purge-data."
fi

if [[ "$PURGE_DATA" == true && -d "$TMP_DIR" ]]; then
    rmdir "$TMP_DIR" 2>/dev/null || true
fi

echo "MySQL, Apache, PHP, and phpMyAdmin packages have been removed."
