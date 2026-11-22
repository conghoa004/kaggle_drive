#!/bin/bash

set -Eeuo pipefail

BASE_DIR="/kaggle/working/kaggle_drive/services/mysql"
TMP_DIR="$BASE_DIR/tmp"

LOG_FILE="$TMP_DIR/mysql_phpmyadmin_install.log"
CREDENTIAL_FILE="$TMP_DIR/phpmyadmin_credentials.txt"

APACHE_PORT="8081"

# Create required directories before initializing logging
mkdir -p "$TMP_DIR"

# Restrict file permissions
umask 077

# Initialize logging
touch "$LOG_FILE"
chmod 600 "$LOG_FILE"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "========================================="
echo "MySQL and phpMyAdmin Installation"
echo "========================================="

# Check root privileges
if [ "$(id -u)" -ne 0 ]; then
    echo "Error: Please run this script as root."
    exit 1
fi

# Check operating system
if [ ! -f /etc/os-release ]; then
    echo "Error: Cannot detect operating system."
    exit 1
fi

. /etc/os-release

if [[ "${ID:-}" != "ubuntu" && "${ID:-}" != "debian" ]]; then
    echo "Error: Ubuntu and Debian are supported only."
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive

# Check required commands
for cmd in apt-get tee; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: Required command not found: $cmd"
        exit 1
    fi
done

echo "[1/9] Updating package lists..."

apt-get update -y

echo "[2/9] Configuring phpMyAdmin..."

if ! command -v debconf-set-selections >/dev/null 2>&1; then
    apt-get install -y debconf-utils
fi

echo "phpmyadmin phpmyadmin/dbconfig-install boolean false" \
    | debconf-set-selections

echo "phpmyadmin phpmyadmin/reconfigure-webserver multiselect apache2" \
    | debconf-set-selections

echo "[3/9] Installing Apache..."

apt-get install -y apache2

echo "[4/9] Installing MySQL Server..."

apt-get install -y mysql-server

echo "[5/9] Installing PHP and extensions..."

apt-get install -y \
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

echo "[6/9] Installing phpMyAdmin..."

apt-get install -y phpmyadmin

echo "[7/9] Configuring Apache and phpMyAdmin..."

# Detect PHP version
PHP_VERSION=$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;')

echo "Detected PHP version: $PHP_VERSION"

# Enable Apache modules
a2enmod rewrite

if [ -f "/etc/apache2/mods-available/php${PHP_VERSION}.load" ]; then
    a2enmod "php${PHP_VERSION}"
else
    echo "Error: PHP Apache module not found."
    exit 1
fi

# Configure phpMyAdmin
if [ -f /etc/apache2/conf-available/phpmyadmin.conf ]; then
    a2enconf phpmyadmin

elif [ -f /etc/phpmyadmin/apache.conf ]; then
    ln -sf /etc/phpmyadmin/apache.conf \
        /etc/apache2/conf-available/phpmyadmin.conf

    a2enconf phpmyadmin

else
    echo "Error: phpMyAdmin Apache configuration not found."
    exit 1
fi

# Configure homepage redirect
cat > /etc/apache2/conf-available/homepage-redirect.conf <<'EOF'
RedirectRelative On
RedirectMatch 302 ^/$ /phpmyadmin/
EOF

a2enconf homepage-redirect

# Move Apache's HTTP listener and default site to the selected port.
APACHE_PORTS_CONF="/etc/apache2/ports.conf"
APACHE_DEFAULT_SITE="/etc/apache2/sites-available/000-default.conf"

if [ ! -f "$APACHE_PORTS_CONF" ] || [ ! -f "$APACHE_DEFAULT_SITE" ]; then
    echo "Error: Apache port or default-site configuration was not found."
    exit 1
fi

if grep -Eq "^[[:space:]]*Listen[[:space:]]+${APACHE_PORT}([[:space:]]|$)" "$APACHE_PORTS_CONF"; then
    sed -i -E 's/^[[:space:]]*Listen[[:space:]]+80([[:space:]]|$)//' "$APACHE_PORTS_CONF"
elif grep -Eq '^[[:space:]]*Listen[[:space:]]+80([[:space:]]|$)' "$APACHE_PORTS_CONF"; then
    sed -i -E "s/^[[:space:]]*Listen[[:space:]]+80([[:space:]]|$)/Listen ${APACHE_PORT}/" "$APACHE_PORTS_CONF"
else
    echo "Error: Could not find an Apache Listen 80 directive."
    exit 1
fi

if grep -Fq "<VirtualHost *:${APACHE_PORT}>" "$APACHE_DEFAULT_SITE"; then
    if grep -Fq '<VirtualHost *:80>' "$APACHE_DEFAULT_SITE"; then
        echo "Error: Default Apache site has duplicate HTTP virtual hosts."
        exit 1
    fi
elif grep -Fq '<VirtualHost *:80>' "$APACHE_DEFAULT_SITE"; then
    sed -i "s@<VirtualHost \*:80>@<VirtualHost *:${APACHE_PORT}>@" "$APACHE_DEFAULT_SITE"
else
    echo "Error: Could not find the default Apache virtual host on port 80."
    exit 1
fi

# Verify phpMyAdmin directory
if [ ! -d /usr/share/phpmyadmin ]; then
    echo "Error: phpMyAdmin directory not found."
    exit 1
fi

echo "[8/9] Starting MySQL and creating database user..."

# Prepare runtime directories
mkdir -p /run/mysqld
chown mysql:mysql /run/mysqld
chmod 755 /run/mysqld

# Start MySQL using service
if ! service mysql start; then
    echo "Warning: Service startup failed."
fi

# Fallback to mysqld_safe
if ! mysqladmin ping --silent >/dev/null 2>&1; then

    echo "Trying mysqld_safe..."

    if command -v mysqld_safe >/dev/null 2>&1; then
        mysqld_safe --user=mysql \
            > /var/log/mysql_safe.log 2>&1 &

    elif command -v mariadbd-safe >/dev/null 2>&1; then
        mariadbd-safe \
            > /var/log/mysql_safe.log 2>&1 &

    else
        echo "Error: MySQL startup executable not found."
        exit 1
    fi
fi

# Wait for MySQL
MYSQL_READY=false

for i in $(seq 1 60); do
    if mysqladmin ping --silent >/dev/null 2>&1; then
        MYSQL_READY=true
        break
    fi

    sleep 2
done

if [ "$MYSQL_READY" != "true" ]; then
    echo "Error: MySQL failed to start."
    echo "Check /var/log/mysql_safe.log"
    exit 1
fi

echo "MySQL is running."

# Generate database administrator credentials
DB_USER="root"
DB_PASSWORD=$(openssl rand -hex 20)

# Create or update MySQL administrator account
mysql --protocol=socket -uroot <<SQL
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost'
IDENTIFIED BY '${DB_PASSWORD}';

ALTER USER '${DB_USER}'@'localhost'
IDENTIFIED BY '${DB_PASSWORD}';

GRANT ALL PRIVILEGES ON *.* TO '${DB_USER}'@'localhost'
WITH GRANT OPTION;

FLUSH PRIVILEGES;
SQL

# Save credentials securely
cat > "$CREDENTIAL_FILE" <<EOF
MySQL Administration Credentials
================================

Username: ${DB_USER}
Password: ${DB_PASSWORD}

Host: localhost
Port: 3306

phpMyAdmin URL: http://localhost:${APACHE_PORT}/phpmyadmin
EOF

chmod 600 "$CREDENTIAL_FILE"

echo "MySQL administrator account created."

echo "[9/9] Starting Apache..."

# Validate Apache configuration
apache2ctl configtest

# Start or reload Apache
if pgrep -x apache2 >/dev/null 2>&1; then
    apache2ctl -k graceful
else
    apache2ctl -k start
fi

# Verify Apache
if ! pgrep -x apache2 >/dev/null 2>&1; then
    echo "Error: Apache failed to start."
    exit 1
fi

# Verify phpMyAdmin configuration
if ! apache2ctl -S >/dev/null 2>&1; then
    echo "Error: Apache configuration verification failed."
    exit 1
fi

echo ""
echo "========================================="
echo "INSTALLATION COMPLETED SUCCESSFULLY"
echo "========================================="

echo ""
echo "SERVICE STATUS"
echo "-----------------------------------------"

if mysqladmin ping --silent >/dev/null 2>&1; then
    echo "MySQL: Running"
else
    echo "MySQL: Stopped"
fi

if pgrep -x apache2 >/dev/null 2>&1; then
    echo "Apache: Running"
else
    echo "Apache: Stopped"
fi

echo ""
echo "ACCESS URLS"
echo "-----------------------------------------"
echo "Homepage: http://localhost:${APACHE_PORT}"
echo "phpMyAdmin: http://localhost:${APACHE_PORT}/phpmyadmin"

echo ""
echo "DATABASE INFORMATION"
echo "-----------------------------------------"
echo "MySQL Version: $(mysql --version)"
echo "PHP Version: $(php --version | head -n 1)"
echo "Apache Version: $(apache2 -v | head -n 1)"

echo ""
echo "ADMINISTRATOR ACCOUNT"
echo "-----------------------------------------"
echo "Username: ${DB_USER}"
echo "Password: Saved in ${CREDENTIAL_FILE}"

echo ""
echo "LOG FILE"
echo "-----------------------------------------"
echo "$LOG_FILE"

echo ""
echo "========================================="
echo "All installation tasks completed."
echo "========================================="
