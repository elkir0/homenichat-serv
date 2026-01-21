#!/bin/bash
#
# Homenichat - FreePBX ARM64 Installation Script
# For Raspberry Pi 4/5 with Debian 12 Bookworm (ARM64)
#
# Based on RasPBX project: https://github.com/playfultechnology/RasPBX
# Adapted for Homenichat integration
#
# Prerequisites: Asterisk must be installed first (run install.sh with VoIP option)
#
# Usage: sudo ./install-freepbx-arm.sh
#
# License: GPL v3
#

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

# Configuration
FREEPBX_VERSION="17.0"
LOG_FILE="/var/log/homenichat-freepbx-install.log"

# ============================================================================
# Helper Functions
# ============================================================================

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE" 2>/dev/null || true
}

info() {
    echo -e "${BLUE}[INFO]${NC} $1"
    log "INFO: $1"
}

success() {
    echo -e "${GREEN}[OK]${NC} $1"
    log "SUCCESS: $1"
}

warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
    log "WARNING: $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
    log "ERROR: $1"
}

fatal() {
    error "$1"
    echo ""
    echo -e "${RED}Installation failed. Check log: $LOG_FILE${NC}"
    exit 1
}

# ============================================================================
# Pre-flight Checks
# ============================================================================

check_root() {
    if [ "$EUID" -ne 0 ]; then
        fatal "This script must be run as root (sudo)"
    fi
}

check_architecture() {
    ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m)
    if [[ "$ARCH" != "arm64" && "$ARCH" != "aarch64" ]]; then
        warning "This script is designed for ARM64 (Raspberry Pi)"
        warning "Detected architecture: $ARCH"
        echo ""
        read -p "Continue anyway? [y/N]: " response
        if [[ ! "$response" =~ ^[Yy]$ ]]; then
            exit 0
        fi
    fi
}

check_asterisk() {
    if ! command -v asterisk &>/dev/null; then
        fatal "Asterisk is not installed. Please run install.sh first with VoIP option."
    fi

    AST_VERSION=$(asterisk -V 2>/dev/null || echo "unknown")
    success "Asterisk detected: $AST_VERSION"
}

check_os() {
    . /etc/os-release 2>/dev/null || true

    if [[ "$VERSION_CODENAME" != "bookworm" ]]; then
        warning "This script is optimized for Debian 12 (bookworm)"
        warning "Detected: $PRETTY_NAME"
    fi

    success "OS: $PRETTY_NAME"
}

# ============================================================================
# Installation Steps
# ============================================================================

install_dependencies() {
    info "Installing FreePBX dependencies..."

    apt-get update >> "$LOG_FILE" 2>&1

    # Core dependencies
    apt-get install -y \
        apache2 \
        mariadb-server mariadb-client \
        sox mpg123 lame \
        libicu-dev libical-dev \
        odbc-mariadb unixodbc unixodbc-dev \
        >> "$LOG_FILE" 2>&1

    success "Core dependencies installed"
}

install_php() {
    info "Installing PHP 8.2 and modules..."

    # PHP 8.2 for FreePBX 17
    apt-get install -y \
        php8.2 php8.2-cli php8.2-common \
        php8.2-curl php8.2-mysql php8.2-gd \
        php8.2-mbstring php8.2-xml php8.2-sqlite3 \
        php8.2-intl php8.2-ldap php8.2-bcmath \
        php-pear libapache2-mod-php8.2 \
        >> "$LOG_FILE" 2>&1 || {
        # Fallback to default PHP if 8.2 not available
        warning "PHP 8.2 not available, trying default PHP..."
        apt-get install -y \
            php php-cli php-common \
            php-curl php-mysql php-gd \
            php-mbstring php-xml php-sqlite3 \
            php-intl php-ldap php-bcmath \
            php-pear libapache2-mod-php \
            >> "$LOG_FILE" 2>&1
    }

    success "PHP installed: $(php -v 2>/dev/null | head -1)"
}

configure_mariadb() {
    info "Configuring MariaDB..."

    # Start MariaDB
    systemctl enable mariadb >> "$LOG_FILE" 2>&1
    systemctl start mariadb >> "$LOG_FILE" 2>&1

    # Create FreePBX database and user
    mysql -e "CREATE DATABASE IF NOT EXISTS asterisk;" >> "$LOG_FILE" 2>&1
    mysql -e "CREATE DATABASE IF NOT EXISTS asteriskcdrdb;" >> "$LOG_FILE" 2>&1
    mysql -e "CREATE USER IF NOT EXISTS 'freepbx'@'localhost' IDENTIFIED BY 'freepbx';" >> "$LOG_FILE" 2>&1
    mysql -e "GRANT ALL PRIVILEGES ON asterisk.* TO 'freepbx'@'localhost';" >> "$LOG_FILE" 2>&1
    mysql -e "GRANT ALL PRIVILEGES ON asteriskcdrdb.* TO 'freepbx'@'localhost';" >> "$LOG_FILE" 2>&1
    mysql -e "FLUSH PRIVILEGES;" >> "$LOG_FILE" 2>&1

    success "MariaDB configured"
}

configure_apache() {
    info "Configuring Apache..."

    # Enable required modules
    a2enmod rewrite >> "$LOG_FILE" 2>&1 || true
    a2enmod headers >> "$LOG_FILE" 2>&1 || true

    # BUG FIX 1: Remove default index.html files that block index.php
    # Apache's DirectoryIndex gives priority to index.html over index.php
    rm -f /var/www/html/index.html /var/www/html/index.nginx-debian.html 2>/dev/null || true
    info "Removed default index.html files"

    # BUG FIX 2: Run Apache as asterisk user (not www-data)
    # FreePBX needs to edit asterisk's crontab, which fails if running as www-data
    sed -i 's/APACHE_RUN_USER=www-data/APACHE_RUN_USER=asterisk/' /etc/apache2/envvars
    sed -i 's/APACHE_RUN_GROUP=www-data/APACHE_RUN_GROUP=asterisk/' /etc/apache2/envvars
    info "Apache configured to run as asterisk user"

    # FreePBX Apache config
    cat > /etc/apache2/sites-available/freepbx.conf << 'APACHE_CONF'
<VirtualHost *:8080>
    ServerAdmin webmaster@localhost
    DocumentRoot /var/www/html

    <Directory /var/www/html>
        AllowOverride All
        Require all granted
    </Directory>

    ErrorLog ${APACHE_LOG_DIR}/freepbx-error.log
    CustomLog ${APACHE_LOG_DIR}/freepbx-access.log combined
</VirtualHost>
APACHE_CONF

    # Change Apache port to 8080 only (avoid conflict with port 80)
    # Replace Listen 80 with Listen 8080
    sed -i 's/^Listen 80$/Listen 8080/' /etc/apache2/ports.conf

    # Also update SSL port if needed (443 -> 8443)
    sed -i 's/Listen 443$/Listen 8443/' /etc/apache2/ports.conf

    # Ensure 8080 is set (in case sed didn't match)
    if ! grep -q "Listen 8080" /etc/apache2/ports.conf; then
        echo "Listen 8080" >> /etc/apache2/ports.conf
    fi

    a2ensite freepbx.conf >> "$LOG_FILE" 2>&1 || true
    a2dissite 000-default.conf >> "$LOG_FILE" 2>&1 || true

    # Stop any process using port 80 before starting Apache
    systemctl enable apache2 >> "$LOG_FILE" 2>&1
    systemctl restart apache2 >> "$LOG_FILE" 2>&1 || {
        warning "Apache failed to start, checking port conflicts..."
        # Try stopping nginx if it's using port 80
        systemctl stop nginx >> "$LOG_FILE" 2>&1 || true
        systemctl restart apache2 >> "$LOG_FILE" 2>&1
    }

    success "Apache configured on port 8080"
}

configure_asterisk_user() {
    info "Configuring Asterisk user permissions..."

    # Create asterisk user if not exists
    id asterisk &>/dev/null || useradd -r -d /var/lib/asterisk -s /sbin/nologin asterisk

    # Add asterisk to required groups
    usermod -a -G audio,dialout asterisk 2>/dev/null || true

    # Set ownership
    chown -R asterisk:asterisk /var/lib/asterisk
    chown -R asterisk:asterisk /var/log/asterisk
    chown -R asterisk:asterisk /var/spool/asterisk
    chown -R asterisk:asterisk /var/run/asterisk 2>/dev/null || true
    chown -R asterisk:asterisk /etc/asterisk

    # Web directory permissions
    chown -R asterisk:asterisk /var/www/html

    success "Asterisk user configured"
}

install_freepbx() {
    info "Installing FreePBX ${FREEPBX_VERSION}..."

    cd /usr/src

    # Remove old installation if exists
    rm -rf freepbx 2>/dev/null || true

    # Clone FreePBX framework
    info "Cloning FreePBX framework..."
    git clone --branch release/${FREEPBX_VERSION} --depth 1 \
        https://github.com/FreePBX/framework.git freepbx >> "$LOG_FILE" 2>&1 || {
        # Try without specific branch
        warning "Could not clone release branch, trying main..."
        git clone --depth 1 https://github.com/FreePBX/framework.git freepbx >> "$LOG_FILE" 2>&1
    }

    cd freepbx

    # Start Asterisk if not running
    if ! pidof asterisk > /dev/null; then
        info "Starting Asterisk..."
        ./start_asterisk start >> "$LOG_FILE" 2>&1 || {
            asterisk >> "$LOG_FILE" 2>&1 || true
        }
        sleep 3
    fi

    # Run FreePBX installer
    info "Running FreePBX installer (this may take several minutes)..."
    ./install --no-interaction --dbuser=freepbx --dbpass=freepbx >> "$LOG_FILE" 2>&1 || {
        warning "FreePBX installer had issues, trying with defaults..."
        ./install --no-interaction >> "$LOG_FILE" 2>&1 || true
    }

    success "FreePBX framework installed"
}

install_freepbx_modules() {
    info "Installing FreePBX modules..."

    # Core modules
    fwconsole ma downloadinstall framework core >> "$LOG_FILE" 2>&1 || true
    fwconsole reload >> "$LOG_FILE" 2>&1 || true

    # Essential modules
    info "Installing essential modules..."
    fwconsole ma downloadinstall \
        cdr dashboard featurecodeadmin \
        infoservices music pm2 sipsettings voicemail \
        >> "$LOG_FILE" 2>&1 || true

    # Call handling modules
    info "Installing call handling modules..."
    fwconsole ma downloadinstall \
        announcement callforward callwaiting \
        donotdisturb findmefollow parking ringgroups \
        >> "$LOG_FILE" 2>&1 || true

    # Admin modules
    info "Installing admin modules..."
    fwconsole ma downloadinstall \
        asteriskinfo configedit logfiles \
        >> "$LOG_FILE" 2>&1 || true

    fwconsole reload >> "$LOG_FILE" 2>&1 || true

    success "FreePBX modules installed"
}

configure_freepbx() {
    info "Configuring FreePBX..."

    # Basic settings
    fwconsole setting HTTPBINDADDRESS 0.0.0.0 >> "$LOG_FILE" 2>&1 || true
    fwconsole setting HTTPTLSBINDADDRESS 0.0.0.0 >> "$LOG_FILE" 2>&1 || true
    fwconsole setting FREEPBX_SYSTEM_IDENT "Homenichat" >> "$LOG_FILE" 2>&1 || true
    fwconsole setting BROWSER_STATS 0 >> "$LOG_FILE" 2>&1 || true
    fwconsole setting AMPDISABLELOG 1 >> "$LOG_FILE" 2>&1 || true

    # Fix permissions for Apache/PHP (Apache runs as asterisk user now)
    info "Fixing permissions..."
    chmod 644 /etc/freepbx.conf 2>/dev/null || true
    chown asterisk:asterisk /etc/freepbx.conf 2>/dev/null || true
    chown -R asterisk:asterisk /var/lib/php/sessions 2>/dev/null || true
    chmod 1733 /var/lib/php/sessions 2>/dev/null || true
    chown -R asterisk:asterisk /var/www/html 2>/dev/null || true
    chmod -R 775 /var/www/html 2>/dev/null || true

    # BUG FIX 3: jQuery Cookie Compatibility Shim
    # FreePBX uses $.removeCookie() but ships with js-cookie 3.x which uses Cookies.remove()
    info "Installing jQuery cookie compatibility shim..."
    mkdir -p /var/www/html/admin/assets/js
    cat > /var/www/html/admin/assets/js/jquery.cookie.compat.js << 'COOKIE_SHIM'
(function($) {
    "use strict";
    if (typeof Cookies !== "undefined") {
        $.cookie = function(name, value, options) {
            if (value === undefined) return Cookies.get(name);
            if (value === null) { Cookies.remove(name, options); return; }
            Cookies.set(name, value, options);
        };
        $.removeCookie = function(name, options) {
            Cookies.remove(name, options);
            return true;
        };
    }
})(jQuery);
COOKIE_SHIM

    # Include shim in footer.php (before </body>)
    if [ -f /var/www/html/admin/views/footer.php ]; then
        if ! grep -q "jquery.cookie.compat.js" /var/www/html/admin/views/footer.php; then
            sed -i 's|</body>|<script src="/admin/assets/js/jquery.cookie.compat.js"></script>\n</body>|' /var/www/html/admin/views/footer.php
            info "jQuery cookie shim added to footer.php"
        fi
    fi

    # Set proper ownership after creating files
    chown -R asterisk:asterisk /var/www/html 2>/dev/null || true

    # Reload configuration
    fwconsole chown >> "$LOG_FILE" 2>&1 || true
    fwconsole reload >> "$LOG_FILE" 2>&1 || true

    # Restart services
    fwconsole restart >> "$LOG_FILE" 2>&1 || true
    systemctl restart apache2 >> "$LOG_FILE" 2>&1 || true

    success "FreePBX configured"
}

configure_firewall() {
    info "Configuring firewall for FreePBX..."

    if command -v ufw &>/dev/null; then
        ufw allow 8080/tcp comment 'FreePBX' >> "$LOG_FILE" 2>&1 || true
        ufw allow 5060/udp comment 'SIP' >> "$LOG_FILE" 2>&1 || true
        ufw allow 5061/tcp comment 'SIP TLS' >> "$LOG_FILE" 2>&1 || true
        ufw allow 5038/tcp comment 'Asterisk AMI' >> "$LOG_FILE" 2>&1 || true
        ufw allow 10000:20000/udp comment 'RTP Media' >> "$LOG_FILE" 2>&1 || true
        success "Firewall configured"
    else
        info "UFW not installed, skipping firewall"
    fi
}

# ============================================================================
# Completion
# ============================================================================

show_completion() {
    IP_ADDR=$(hostname -I | awk '{print $1}')

    echo ""
    echo -e "${GREEN}${BOLD}FreePBX Installation Complete!${NC}"
    echo ""
    echo "=========================================================="
    echo ""
    echo -e "${BOLD}Access FreePBX Admin:${NC}"
    echo ""
    echo "  URL: http://${IP_ADDR}:8080/admin"
    echo ""
    echo -e "${BOLD}First-time Setup:${NC}"
    echo ""
    echo "  1. Open the URL above in your browser"
    echo "  2. Create an admin account when prompted"
    echo "  3. Configure your SIP trunks and extensions"
    echo ""
    echo "=========================================================="
    echo ""
    echo -e "${BOLD}Homenichat Integration:${NC}"
    echo ""
    echo "  Configure AMI connection in /etc/homenichat/providers.yaml:"
    echo ""
    echo "  voip:"
    echo "    - id: freepbx_local"
    echo "      type: freepbx"
    echo "      config:"
    echo "        host: \"127.0.0.1\""
    echo "        ami_port: 5038"
    echo "        ami_user: \"homenichat\""
    echo "        ami_secret: \"your-secret\""
    echo ""
    echo "  Create AMI user in FreePBX: Settings > Asterisk Manager Users"
    echo ""
    echo "=========================================================="
    echo ""
    echo "Installation log: $LOG_FILE"
    echo ""
}

# ============================================================================
# Main
# ============================================================================

main() {
    echo ""
    echo -e "${CYAN}${BOLD}Homenichat - FreePBX ARM64 Installer${NC}"
    echo -e "For Raspberry Pi with Debian 12 Bookworm"
    echo ""
    echo "This script will install FreePBX ${FREEPBX_VERSION} on your system."
    echo "It requires Asterisk to be already installed."
    echo ""
    echo "Based on: https://github.com/playfultechnology/RasPBX"
    echo ""

    read -p "Continue with installation? [y/N]: " response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        echo "Installation cancelled."
        exit 0
    fi

    mkdir -p "$(dirname "$LOG_FILE")"
    echo "FreePBX ARM Installation - $(date)" > "$LOG_FILE"

    check_root
    check_architecture
    check_asterisk
    check_os

    echo ""
    info "Starting FreePBX installation..."
    echo ""

    install_dependencies
    install_php
    configure_mariadb
    configure_apache
    configure_asterisk_user
    install_freepbx
    install_freepbx_modules
    configure_freepbx
    configure_firewall

    show_completion
}

main "$@"
