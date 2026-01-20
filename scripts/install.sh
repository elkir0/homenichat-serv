#!/bin/bash
#
# Homenichat - Installation Script
# For Raspberry Pi 4/5 with Raspberry Pi OS 64-bit (Bookworm/Trixie)
#
# Usage: curl -fsSL https://raw.githubusercontent.com/elkir0/homenichat-serv/main/scripts/install.sh | sudo bash
#    or: sudo ./install.sh
#    or: sudo ./install.sh --auto  (non-interactive, accept defaults)
#    or: sudo ./install.sh --full  (install ALL components: Baileys, Asterisk, Modems)
#    or: sudo ./install.sh --full --verbose  (full install with detailed output)
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
HOMENICHAT_VERSION="1.0.0"
INSTALL_DIR="/opt/homenichat"
DATA_DIR="/var/lib/homenichat"
CONFIG_DIR="/etc/homenichat"
LOG_FILE="/var/log/homenichat-install.log"
REPO_URL="https://github.com/elkir0/homenichat-serv.git"

# Installation options
# Note: FreePBX is required for VoIP (standalone Asterisk not supported)
INSTALL_FREEPBX=false
INSTALL_BAILEYS=true
INSTALL_MODEMS=false

# Auto mode (non-interactive)
AUTO_MODE=false
FULL_MODE=false
VERBOSE_MODE=false

for arg in "$@"; do
    case "$arg" in
        --auto|-y|--yes)
            AUTO_MODE=true
            ;;
        --full|--all)
            AUTO_MODE=true
            FULL_MODE=true
            INSTALL_FREEPBX=true
            INSTALL_BAILEYS=true
            INSTALL_MODEMS=true
            ;;
        --verbose|-v)
            VERBOSE_MODE=true
            ;;
    esac
done

# ============================================================================
# Helper Functions
# ============================================================================

print_banner() {
    clear 2>/dev/null || true
    echo -e "${CYAN}"
    echo "  _   _                           _      _           _   "
    echo " | | | | ___  _ __ ___   ___ _ __ (_) ___| |__   __ _| |_ "
    echo " | |_| |/ _ \| '_ \` _ \ / _ \ '_ \| |/ __| '_ \ / _\` | __|"
    echo " |  _  | (_) | | | | | |  __/ | | | | (__| | | | (_| | |_ "
    echo " |_| |_|\___/|_| |_| |_|\___|_| |_|_|\___|_| |_|\__,_|\__|"
    echo -e "${NC}"
    echo -e "${BOLD}Self-Hosted Unified Communication Platform${NC}"
    echo -e "Version ${HOMENICHAT_VERSION}"
    if [ "$AUTO_MODE" = true ]; then
        echo -e "${YELLOW}[AUTO MODE - Non-interactive installation]${NC}"
    fi
    if [ "$VERBOSE_MODE" = true ]; then
        echo -e "${CYAN}[VERBOSE MODE - Detailed output enabled]${NC}"
    fi
    echo ""
    echo "=========================================================="
    echo ""
}

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

# Run command with optional verbose output
# Usage: run_cmd "description" command args...
run_cmd() {
    local desc="$1"
    shift
    if [ "$VERBOSE_MODE" = true ]; then
        echo -e "${CYAN}>>> $desc${NC}"
        echo -e "${CYAN}>>> Running: $*${NC}"
        "$@" 2>&1 | tee -a "$LOG_FILE"
        local status=${PIPESTATUS[0]}
        return $status
    else
        "$@" >> "$LOG_FILE" 2>&1
        return $?
    fi
}

# Run apt-get with verbose support
apt_install() {
    if [ "$VERBOSE_MODE" = true ]; then
        echo -e "${CYAN}>>> Installing packages: $*${NC}"
        apt-get install -y "$@" 2>&1 | tee -a "$LOG_FILE"
        return ${PIPESTATUS[0]}
    else
        apt-get install -y "$@" >> "$LOG_FILE" 2>&1
        return $?
    fi
}

confirm() {
    local prompt="$1"
    local default="${2:-n}"
    local response

    # In auto mode, use default
    if [ "$AUTO_MODE" = true ]; then
        if [ "$default" = "y" ]; then
            return 0
        else
            return 1
        fi
    fi

    if [ "$default" = "y" ]; then
        prompt="$prompt [Y/n]: "
    else
        prompt="$prompt [y/N]: "
    fi

    read -p "$prompt" response
    response=${response:-$default}

    case "$response" in
        [yY][eE][sS]|[yY]) return 0 ;;
        *) return 1 ;;
    esac
}

wait_key() {
    if [ "$AUTO_MODE" = true ]; then
        return
    fi
    echo ""
    read -p "Press Enter to continue..."
}

# ============================================================================
# System Checks
# ============================================================================

check_root() {
    if [ "$EUID" -ne 0 ]; then
        error "This script must be run as root"
        echo ""
        echo "Please run: sudo $0"
        exit 1
    fi
}

check_os() {
    info "Checking operating system..."

    if [ ! -f /etc/os-release ]; then
        fatal "Cannot detect operating system"
    fi

    . /etc/os-release

    if [[ "$ID" != "debian" && "$ID" != "raspbian" ]]; then
        warning "This script is designed for Raspberry Pi OS / Debian"
        if ! confirm "Continue anyway?"; then
            exit 1
        fi
    fi

    ARCH=$(uname -m)
    if [[ "$ARCH" != "aarch64" && "$ARCH" != "x86_64" ]]; then
        warning "Architecture $ARCH may not be fully supported"
    fi

    success "OS: $PRETTY_NAME ($ARCH)"
}

check_memory() {
    info "Checking system memory..."

    TOTAL_MEM=$(free -m | awk '/^Mem:/{print $2}')

    if [ "$TOTAL_MEM" -lt 1800 ]; then
        warning "System has ${TOTAL_MEM}MB RAM. Minimum recommended: 2GB"
        if ! confirm "Continue with limited memory?"; then
            exit 1
        fi
    else
        success "Memory: ${TOTAL_MEM}MB"
    fi
}

check_disk() {
    info "Checking disk space..."

    AVAILABLE=$(df -BG / | awk 'NR==2 {print $4}' | tr -d 'G')

    if [ "$AVAILABLE" -lt 8 ]; then
        warning "Only ${AVAILABLE}GB available. Minimum recommended: 10GB"
        if ! confirm "Continue with limited disk space?"; then
            exit 1
        fi
    else
        success "Disk space: ${AVAILABLE}GB available"
    fi
}

check_internet() {
    info "Checking internet connection..."

    if ! ping -c 1 -W 5 8.8.8.8 &> /dev/null; then
        fatal "No internet connection. Please check your network."
    fi

    success "Internet connection OK"
}

# ============================================================================
# Legal Disclaimers
# ============================================================================

show_disclaimers() {
    print_banner

    echo -e "${YELLOW}${BOLD}IMPORTANT LEGAL DISCLAIMERS${NC}"
    echo ""
    echo "Before proceeding, please read and accept the following:"
    echo ""
    echo "=========================================================="
    echo ""
    echo -e "${BOLD}1. WhatsApp / Baileys${NC}"
    echo ""
    echo "   This software can use Baileys, an UNOFFICIAL WhatsApp API."
    echo ""
    echo "   - Baileys is NOT affiliated with WhatsApp Inc. or Meta"
    echo "   - Using Baileys MAY VIOLATE WhatsApp's Terms of Service"
    echo "   - Your WhatsApp account MAY BE BANNED"
    echo "   - DO NOT use for spam, bulk messaging, or stalkerware"
    echo "   - Use only for personal, legitimate purposes"
    echo ""
    echo -e "${BOLD}2. FreePBX / Asterisk${NC}"
    echo ""
    echo "   FreePBX and Asterisk are trademarks of Sangoma Technologies."
    echo "   They will be downloaded from official sources if you choose"
    echo "   to install them. This project is NOT affiliated with Sangoma."
    echo ""
    echo -e "${BOLD}3. No Warranty${NC}"
    echo ""
    echo "   This software is provided AS IS, without any warranty."
    echo "   The developers are not liable for any damages or issues."
    echo ""
    echo "=========================================================="
    echo ""

    if [ "$AUTO_MODE" = true ]; then
        warning "Auto mode: Legal terms accepted automatically"
    elif ! confirm "Do you accept these terms and wish to continue?" "n"; then
        echo ""
        echo "Installation cancelled."
        exit 0
    fi

    echo ""
    success "Terms accepted"
}

# ============================================================================
# Installation Choices
# ============================================================================

choose_components() {
    print_banner

    # In full mode, skip interactive selection
    if [ "$FULL_MODE" = true ]; then
        echo -e "${BOLD}Full Installation Mode${NC}"
        echo ""
        echo "All components will be installed:"
        echo ""
        echo "  - Homenichat-Serv (core)    : YES"
        echo "  - Admin Web Interface       : YES"
        echo "  - Baileys (WhatsApp)        : YES"
        echo "  - Asterisk (VoIP)           : YES"
        echo "  - GSM Modem support         : YES"
        echo ""
        return
    fi

    echo -e "${BOLD}Component Selection${NC}"
    echo ""
    echo "Homenichat can be installed with different optional components."
    echo "You can always add more components later."
    echo ""
    echo "=========================================================="
    echo ""

    echo -e "${BOLD}1. WhatsApp Integration (Baileys)${NC}"
    echo "   Connect to WhatsApp via QR code, like WhatsApp Web."
    echo "   - Free, no business account needed"
    echo "   - May violate WhatsApp ToS (risk of ban)"
    echo ""
    if confirm "   Install Baileys WhatsApp support?" "y"; then
        INSTALL_BAILEYS=true
        success "   Baileys will be installed"
    else
        INSTALL_BAILEYS=false
        info "   Baileys will NOT be installed"
    fi
    echo ""

    echo -e "${BOLD}2. VoIP Integration (FreePBX)${NC}"
    echo "   Full PBX functionality with web management."
    echo "   - Make/receive phone calls via WebRTC or SIP"
    echo "   - Extensions, IVR, voicemail, call recording"
    echo "   - Web interface for PBX management"
    echo "   - Requires Debian 12 Bookworm AMD64"
    echo "   - Requires ~500MB extra RAM"
    echo ""
    if confirm "   Install FreePBX?" "n"; then
        INSTALL_FREEPBX=true
        success "   FreePBX will be installed"
    else
        INSTALL_FREEPBX=false
        info "   VoIP will NOT be installed"
    fi
    echo ""

    echo -e "${BOLD}3. GSM Modem Support (Gammu)${NC}"
    echo "   Send/receive SMS via USB GSM modems."
    echo "   - SIM7600, Quectel EC25, Huawei modems"
    echo "   - Requires USB modem hardware"
    echo ""
    if confirm "   Install GSM modem support?" "n"; then
        INSTALL_MODEMS=true
        success "   Modem support will be installed"
    else
        INSTALL_MODEMS=false
        info "   Modem support will NOT be installed"
    fi
    echo ""

    echo "=========================================================="
    echo ""
    echo -e "${BOLD}Installation Summary:${NC}"
    echo ""
    echo "  - Homenichat-Serv (core)    : YES"
    echo "  - Admin Web Interface       : YES"
    echo "  - Baileys (WhatsApp)        : $([ "$INSTALL_BAILEYS" = true ] && echo "YES" || echo "NO")"
    echo "  - Asterisk + FreePBX (VoIP) : $([ "$INSTALL_FREEPBX" = true ] && echo "YES" || echo "NO")"
    echo "  - GSM Modem support         : $([ "$INSTALL_MODEMS" = true ] && echo "YES" || echo "NO")"
    echo ""

    if ! confirm "Proceed with installation?" "y"; then
        echo ""
        echo "Installation cancelled."
        exit 0
    fi
}

# ============================================================================
# Installation Steps
# ============================================================================

install_dependencies() {
    info "Installing system dependencies..."

    run_cmd "Updating package lists" apt-get update

    # Fix locale warnings first
    apt_install locales
    sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen 2>/dev/null || true
    run_cmd "Generating locales" locale-gen || true
    export LANG=en_US.UTF-8
    export LC_ALL=en_US.UTF-8

    apt_install curl wget git build-essential python3 python3-pip sqlite3 nginx supervisor ufw

    success "System dependencies installed"
}

install_nodejs() {
    info "Installing Node.js 20 LTS..."

    if command -v node &> /dev/null; then
        NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_VERSION" -ge 20 ]; then
            success "Node.js $(node -v) already installed"
            return
        fi
    fi

    if [ "$VERBOSE_MODE" = true ]; then
        echo -e "${CYAN}>>> Adding NodeSource repository${NC}"
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>&1 | tee -a "$LOG_FILE"
    else
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >> "$LOG_FILE" 2>&1
    fi
    apt_install nodejs

    success "Node.js $(node -v) installed"
}

install_homenichat() {
    info "Installing Homenichat-Serv..."

    mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$CONFIG_DIR"
    mkdir -p "$DATA_DIR/sessions" "$DATA_DIR/media" "$DATA_DIR/sessions/baileys"

    # Clone repository
    if [ -d "$INSTALL_DIR/.git" ]; then
        info "Updating existing installation..."
        cd "$INSTALL_DIR"
        run_cmd "Git pull" git pull || warning "Could not update, continuing with existing version"
    else
        info "Cloning from $REPO_URL..."
        rm -rf "$INSTALL_DIR"
        run_cmd "Git clone" git clone "$REPO_URL" "$INSTALL_DIR" || {
            fatal "Could not clone repository. Please check your internet connection."
        }
    fi

    # Install npm dependencies (repo root is the server, no backend subfolder)
    cd "$INSTALL_DIR"
    info "Installing Node.js dependencies..."
    run_cmd "npm install (server)" npm install --omit=dev

    # Build admin interface
    if [ -d "$INSTALL_DIR/admin" ]; then
        info "Building admin interface..."
        cd "$INSTALL_DIR/admin"
        run_cmd "npm install (admin)" npm install
        if ! run_cmd "npm build (admin)" npm run build; then
            error "Admin interface build failed!"
            error "Running build again with visible output:"
            npm run build 2>&1 | tail -20
            error "Check TypeScript errors above. Build failed."
            exit 1
        fi
        # Verify build output exists
        if [ ! -d "$INSTALL_DIR/admin/dist" ]; then
            error "Admin interface build did not produce dist/ folder"
            exit 1
        fi
        cd "$INSTALL_DIR"
        success "Admin interface built successfully"
    fi

    # Create symlinks for data directories
    ln -sf "$DATA_DIR/sessions" "$INSTALL_DIR/sessions" 2>/dev/null || true
    ln -sf "$DATA_DIR" "$INSTALL_DIR/data" 2>/dev/null || true

    # Make scripts executable
    if [ -d "$INSTALL_DIR/scripts" ]; then
        chmod +x "$INSTALL_DIR/scripts/"*.sh 2>/dev/null || true
    fi

    chown -R root:root "$INSTALL_DIR"
    chmod -R 755 "$INSTALL_DIR"

    success "Homenichat-Serv installed"
}

install_baileys() {
    [ "$INSTALL_BAILEYS" != true ] && return

    info "Installing Baileys (WhatsApp)..."
    cd "$INSTALL_DIR"
    npm install @whiskeysockets/baileys >> "$LOG_FILE" 2>&1
    success "Baileys installed"
}

disable_modemmanager() {
    [ "$INSTALL_MODEMS" != true ] && return

    info "Disabling ModemManager (conflicts with chan_quectel)..."

    # ModemManager interferes with direct modem access
    # It grabs the serial ports and prevents chan_quectel from working
    systemctl stop ModemManager 2>/dev/null || true
    systemctl disable ModemManager 2>/dev/null || true
    systemctl mask ModemManager 2>/dev/null || true

    # Also blacklist qmi_wwan which can interfere
    cat > /etc/modprobe.d/blacklist-modem.conf << 'BLACKLIST'
# Blacklist modules that interfere with chan_quectel
# ModemManager and qmi_wwan grab the modem ports
blacklist qmi_wwan
blacklist cdc_wdm
BLACKLIST

    success "ModemManager disabled"
}

install_gammu() {
    [ "$INSTALL_MODEMS" != true ] && return

    info "Installing Gammu (GSM modem support)..."

    # Install gammu, socat (for direct modem AT commands), and dependencies
    apt-get install -y gammu gammu-smsd libgammu-dev \
        usb-modeswitch usb-modeswitch-data socat \
        >> "$LOG_FILE" 2>&1 || {
        warning "Some gammu packages may not be available"
    }

    # Add user to dialout group for serial port access
    usermod -a -G dialout root 2>/dev/null || true
    usermod -a -G dialout pi 2>/dev/null || true

    # Create default gammu config
    mkdir -p /etc/gammu
    cat > /etc/gammu/gammurc << 'GAMMU_CONF'
[gammu]
device = /dev/ttyUSB2
connection = at
synchronizetime = yes
logfile = /var/log/gammu.log
logformat = textalldate

[smsd]
service = files
inboxpath = /var/spool/gammu/inbox/
outboxpath = /var/spool/gammu/outbox/
sentsmspath = /var/spool/gammu/sent/
errorsmspath = /var/spool/gammu/error/
GAMMU_CONF

    # Create spool directories
    mkdir -p /var/spool/gammu/{inbox,outbox,sent,error}
    chmod -R 777 /var/spool/gammu

    success "Gammu installed"
}

install_upnp() {
    info "Installing UPnP support (miniupnpc)..."

    # Install miniupnpc
    apt_install miniupnpc || {
        warning "miniupnpc installation failed"
        return
    }

    # Create config directory
    mkdir -p /etc/homenichat

    # Create default config (UPnP disabled by default for security)
    cat > /etc/homenichat/upnp.conf << 'UPNP_CONF'
# Configuration UPnP Homenichat-serv
# UPnP est désactivé par défaut pour des raisons de sécurité.
# Activez-le uniquement via l'interface d'administration si nécessaire.

[general]
enabled=false
lease_duration=3600

# Optionnel: URL IGD directe pour VM où le multicast SSDP ne fonctionne pas
# Pour trouver l'URL: upnpc -l (depuis le host physique ou un PC sur le réseau)
# Exemple: igd_url=http://192.168.1.1:60000/abc123/gatedesc1.xml
# igd_url=

[ports]
# Port SIP alternatif (5160 au lieu de 5060/5061)
# Évite les conflits avec les box internet (Livebox, Freebox, etc.)
# qui utilisent souvent le port 5060 pour leur propre téléphonie
sip=5160
rtp_start=10000
rtp_end=10100
UPNP_CONF

    # Copy watchdog script
    if [ -f "$INSTALL_DIR/scripts/upnp-watchdog.sh" ]; then
        cp "$INSTALL_DIR/scripts/upnp-watchdog.sh" /usr/local/bin/upnp-watchdog.sh
        chmod +x /usr/local/bin/upnp-watchdog.sh
        info "UPnP watchdog script installed to /usr/local/bin/"
    else
        warning "UPnP watchdog script not found at $INSTALL_DIR/scripts/upnp-watchdog.sh"
    fi

    # Copy systemd files
    if [ -f "$INSTALL_DIR/config/systemd/upnp-watchdog.service" ]; then
        cp "$INSTALL_DIR/config/systemd/upnp-watchdog.service" /etc/systemd/system/
        cp "$INSTALL_DIR/config/systemd/upnp-watchdog.timer" /etc/systemd/system/
        systemctl daemon-reload
        info "UPnP systemd units installed"
    else
        warning "UPnP systemd files not found at $INSTALL_DIR/config/systemd/"
    fi

    # Note: Timer is NOT enabled by default - user must enable via admin UI
    # This is intentional for security reasons

    # Check if UPnP router is available
    if upnpc -s 2>/dev/null | grep -q "Found valid IGD"; then
        info "UPnP router detected on network"
    else
        info "No UPnP router detected (can be enabled later if available)"
    fi

    success "UPnP support installed (disabled by default)"
}

install_wireguard() {
    info "Installing WireGuard tools..."

    # WireGuard is built into Linux kernel 5.6+
    # We just need the tools
    apt_install wireguard-tools || {
        warning "WireGuard tools not available in repositories"
        warning "Tunnel Relay will work in TURN-only mode"
        return
    }

    # Verify wg command is available
    if command -v wg &>/dev/null; then
        success "WireGuard tools installed"
        info "WireGuard version: $(wg --version)"
    else
        warning "wg command not found after installation"
    fi

    # Enable IP forwarding (needed for VPN)
    if ! grep -q "net.ipv4.ip_forward=1" /etc/sysctl.conf 2>/dev/null; then
        echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
        sysctl -p 2>/dev/null || true
        info "IP forwarding enabled"
    fi

    # Note: WireGuard configuration will be created by TunnelRelayService
    # when the user enables and configures it from the admin UI
}

# ============================================================================
# Asterisk Installation from Source (for ARM64 / Raspberry Pi)
# ============================================================================

install_asterisk_source() {
    # Check if Asterisk is already installed
    if command -v asterisk &>/dev/null; then
        info "Asterisk already installed: $(asterisk -V 2>/dev/null || echo 'unknown version')"
        return 0
    fi

    info "Installing Asterisk from source (this takes 15-25 minutes on Raspberry Pi)..."

    # Asterisk version - use 22 LTS for stability
    local AST_VERSION="22.7.0"
    local AST_URL="https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-${AST_VERSION}.tar.gz"

    # Install build dependencies
    info "Installing Asterisk build dependencies..."
    apt_install build-essential wget curl git subversion \
        libncurses5-dev libssl-dev libxml2-dev libsqlite3-dev \
        uuid-dev libjansson-dev libedit-dev libsrtp2-dev \
        libspeex-dev libspeexdsp-dev libogg-dev libvorbis-dev \
        libopus-dev libcurl4-openssl-dev libpq-dev unixodbc-dev \
        libsystemd-dev pkg-config autoconf automake libtool \
        libspandsp-dev libiksemel-dev libgsm1-dev libcodec2-dev \
        sox || {
        error "Failed to install Asterisk build dependencies"
        return 1
    }

    cd /usr/src

    # Download Asterisk
    info "Downloading Asterisk ${AST_VERSION}..."
    if [ -d "asterisk-${AST_VERSION}" ]; then
        info "Asterisk source already exists, removing old version..."
        rm -rf "asterisk-${AST_VERSION}"
    fi

    wget -q --show-progress "${AST_URL}" -O "asterisk-${AST_VERSION}.tar.gz" || {
        error "Failed to download Asterisk"
        return 1
    }

    tar xzf "asterisk-${AST_VERSION}.tar.gz"
    rm -f "asterisk-${AST_VERSION}.tar.gz"
    cd "asterisk-${AST_VERSION}"

    # Install MP3 support (optional but useful)
    info "Installing MP3 source..."
    local MP3_OK=false
    if command -v svn &>/dev/null; then
        if contrib/scripts/get_mp3_source.sh >> "$LOG_FILE" 2>&1; then
            # Verify MP3 sources were actually downloaded
            if [ -d "addons/mp3" ] && [ -f "addons/mp3/mpg123.h" ]; then
                MP3_OK=true
                info "MP3 source installed successfully"
            fi
        fi
    else
        warn "Subversion (svn) not found, skipping MP3 support"
    fi

    # Configure Asterisk
    info "Configuring Asterisk (this takes a few minutes)..."
    ./configure --with-pjproject-bundled --with-jansson-bundled \
        >> "$LOG_FILE" 2>&1 || {
        error "Asterisk configure failed - check $LOG_FILE"
        return 1
    }

    # Select modules to build (menuselect with defaults)
    info "Selecting Asterisk modules..."
    make menuselect.makeopts >> "$LOG_FILE" 2>&1 || true

    # Enable useful modules
    menuselect/menuselect --enable chan_pjsip menuselect.makeopts 2>/dev/null || true
    menuselect/menuselect --enable res_pjsip menuselect.makeopts 2>/dev/null || true
    menuselect/menuselect --enable codec_opus menuselect.makeopts 2>/dev/null || true

    # Only enable format_mp3 if MP3 sources were successfully downloaded
    if [ "$MP3_OK" = true ]; then
        menuselect/menuselect --enable format_mp3 menuselect.makeopts 2>/dev/null || true
    else
        # Explicitly disable format_mp3 to prevent build failure
        warn "MP3 source not available, disabling format_mp3 module"
        menuselect/menuselect --disable format_mp3 menuselect.makeopts 2>/dev/null || true
    fi

    # Compile Asterisk
    info "Compiling Asterisk (this takes 10-20 minutes on Raspberry Pi)..."
    local CORES=$(nproc)
    make -j${CORES} >> "$LOG_FILE" 2>&1 || {
        error "Asterisk compilation failed - check $LOG_FILE"
        return 1
    }

    # Install Asterisk
    info "Installing Asterisk..."
    make install >> "$LOG_FILE" 2>&1 || {
        error "Asterisk installation failed"
        return 1
    }

    # Install development headers (needed for chan_quectel compilation)
    info "Installing Asterisk development headers..."
    make install-headers >> "$LOG_FILE" 2>&1 || {
        warning "Failed to install Asterisk headers (chan_quectel may not compile)"
    }

    # Install sample configs
    info "Installing Asterisk sample configuration..."
    make samples >> "$LOG_FILE" 2>&1 || true

    # Install init scripts
    make config >> "$LOG_FILE" 2>&1 || true

    # Install logrotate config
    make install-logrotate >> "$LOG_FILE" 2>&1 || true

    # Create asterisk user
    if ! id asterisk &>/dev/null; then
        info "Creating asterisk user..."
        useradd -r -d /var/lib/asterisk -s /sbin/nologin asterisk
    fi

    # Create required directories
    mkdir -p /var/lib/asterisk
    mkdir -p /var/log/asterisk
    mkdir -p /var/spool/asterisk
    mkdir -p /var/run/asterisk
    mkdir -p /etc/asterisk

    # Set ownership
    chown -R asterisk:asterisk /var/lib/asterisk
    chown -R asterisk:asterisk /var/log/asterisk
    chown -R asterisk:asterisk /var/spool/asterisk
    chown -R asterisk:asterisk /var/run/asterisk
    chown -R asterisk:asterisk /etc/asterisk

    # Add asterisk to audio and dialout groups
    usermod -aG audio,dialout asterisk 2>/dev/null || true

    # Create systemd service if not exists
    if [ ! -f /etc/systemd/system/asterisk.service ]; then
        info "Creating Asterisk systemd service..."
        cat > /etc/systemd/system/asterisk.service << 'ASTSERVICE'
[Unit]
Description=Asterisk PBX
After=network.target

[Service]
Type=simple
User=asterisk
Group=asterisk
ExecStart=/usr/sbin/asterisk -f -C /etc/asterisk/asterisk.conf
ExecReload=/usr/sbin/asterisk -rx 'core reload'
ExecStop=/usr/sbin/asterisk -rx 'core stop gracefully'
Restart=on-failure
RestartSec=5

# Security hardening
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
ASTSERVICE
        systemctl daemon-reload
    fi

    # Enable and start Asterisk
    systemctl enable asterisk >> "$LOG_FILE" 2>&1 || true
    systemctl start asterisk >> "$LOG_FILE" 2>&1 || true

    # Verify installation
    sleep 2
    if command -v asterisk &>/dev/null && systemctl is-active --quiet asterisk; then
        success "Asterisk $(asterisk -V 2>/dev/null) installed and running"
    else
        warning "Asterisk installed but may not be running - check: systemctl status asterisk"
    fi

    # Cleanup
    cd /usr/src
    rm -rf "asterisk-${AST_VERSION}"

    return 0
}

install_chan_quectel() {
    [ "$INSTALL_MODEMS" != true ] && return

    # chan_quectel requires Asterisk to be installed
    # (either via FreePBX on AMD64, or from source on ARM64)
    if ! command -v asterisk &>/dev/null; then
        warning "Asterisk not found - skipping chan_quectel installation"
        warning "GSM modems require Asterisk for VoIP functionality"
        warning "Enable FreePBX/VoIP option to install Asterisk"
        return
    fi

    info "Installing chan_quectel for Quectel/SIM7600 modems..."

    # Install ALL dependencies required for chan_quectel compilation
    info "Installing chan_quectel build dependencies..."
    apt_install cmake libasound2-dev libsqlite3-dev

    cd /usr/src

    # Install Asterisk development headers (FreePBX uses Asterisk 22)
    local HEADERS_INSTALLED=false

    info "Installing Asterisk 22 development headers..."

    # Update package list to ensure FreePBX repos are available
    run_cmd "Update package lists" apt-get update || true

    # Try multiple package names (varies by FreePBX version)
    if apt_install asterisk22-devel; then
        HEADERS_INSTALLED=true
        success "asterisk22-devel installed"
    elif apt_install asterisk-devel; then
        HEADERS_INSTALLED=true
        success "asterisk-devel installed"
    elif apt_install asterisk-dev; then
        HEADERS_INSTALLED=true
        success "asterisk-dev installed"
    else
        warning "Could not install Asterisk dev headers from packages"
    fi

    # Verify headers are available
    if [ -f /usr/include/asterisk.h ] || [ -f /usr/include/asterisk/asterisk.h ] || \
       [ -d /usr/include/asterisk ]; then
        HEADERS_INSTALLED=true
        info "Asterisk headers found in /usr/include"
    fi

    # On ARM64 with source-compiled Asterisk, headers might be in /usr/local/include
    if [ "$HEADERS_INSTALLED" != true ]; then
        if [ -d /usr/local/include/asterisk ]; then
            HEADERS_INSTALLED=true
            info "Asterisk headers found in /usr/local/include"
        fi
    fi

    # Last resort: check for source directory headers
    if [ "$HEADERS_INSTALLED" != true ]; then
        if [ -d /usr/src/asterisk-*/include/asterisk ]; then
            info "Asterisk headers found in source directory, creating symlink..."
            local AST_SRC=$(ls -d /usr/src/asterisk-* 2>/dev/null | head -1)
            if [ -d "$AST_SRC/include/asterisk" ]; then
                ln -sf "$AST_SRC/include/asterisk" /usr/include/asterisk 2>/dev/null || true
                HEADERS_INSTALLED=true
            fi
        fi
    fi

    if [ "$HEADERS_INSTALLED" != true ]; then
        warning "Asterisk headers not found - chan_quectel compilation will likely fail"
        warning "You may need to manually install: apt-get install asterisk22-devel"
    fi

    cd /usr/src

    # =========================================================================
    # CONFIGURATION SECTION - Always runs (even if compilation fails later)
    # =========================================================================

    # Add asterisk user to dialout group for serial port access
    info "Adding asterisk user to dialout group..."
    usermod -aG dialout asterisk 2>/dev/null || true

    # Create SMS database directories
    mkdir -p /var/lib/asterisk/smsdb
    chown asterisk:asterisk /var/lib/asterisk/smsdb 2>/dev/null || true

    # Detect modem type and count
    # SIM7600: vendor 1e0e, uses slin16=yes, data=ttyUSB2, audio=ttyUSB4
    # EC25: vendor 2c7c, uses slin16=no, data=ttyUSB2, audio=ttyUSB1
    local MODEM_TYPE="unknown"
    local SLIN16="no"
    local TXGAIN="-15"
    local MODEM_COUNT=0

    # Count SIM7600 modems
    SIM7600_COUNT=$(lsusb 2>/dev/null | grep -c "1e0e:9001" || echo "0")
    # Count EC25 modems
    EC25_COUNT=$(lsusb 2>/dev/null | grep -c "2c7c:" || echo "0")

    if [ "$SIM7600_COUNT" -gt 0 ]; then
        MODEM_TYPE="SIM7600"
        SLIN16="yes"
        TXGAIN="-18"
        MODEM_COUNT=$SIM7600_COUNT
        info "Detected $SIM7600_COUNT SIM7600 modem(s) - using 16kHz audio (slin16=yes)"
    elif [ "$EC25_COUNT" -gt 0 ]; then
        MODEM_TYPE="EC25"
        SLIN16="no"
        TXGAIN="-15"
        MODEM_COUNT=$EC25_COUNT
        info "Detected $EC25_COUNT EC25 modem(s) - using 8kHz audio (slin16=no)"
    else
        warning "No known modem detected - creating template config"
    fi

    # Create quectel config (based on VM500 production config)
    cat > /etc/asterisk/quectel.conf << QUECTEL_CONF
; Homenichat - chan_quectel configuration
; Generated for: ${MODEM_TYPE} modem(s)
; Based on VM500 production config

[general]
interval=15
smsdb=/var/lib/asterisk/smsdb
csmsttl=600

[defaults]
context=from-gsm
group=0
; Audio gains tuned for WebRTC ↔ GSM bridge (prevents TX saturation)
; rxgain: GSM network → Asterisk (speaker/incoming audio)
; txgain: Asterisk → GSM network (microphone/outgoing audio)
rxgain=-5
txgain=${TXGAIN}
autodeletesms=yes
resetquectel=yes
msg_storage=me
msg_direct=off
usecallingpres=yes
callingpres=allowed_passed_screen
; Audio format: SIM7600 requires 16kHz (slin16=yes), EC25 uses 8kHz (slin16=no)
slin16=${SLIN16}
; EC25 USB Audio Class (UAC) mode: set uac=ext and alsadev=hw:X per modem
; UAC provides better audio quality than TTY audio mode
QUECTEL_CONF

    # Auto-detect and configure modems based on ttyUSB ports
    if [ "$MODEM_TYPE" = "SIM7600" ]; then
        # SIM7600 uses: ttyUSB2 (AT), ttyUSB4 (audio) per modem
        # Multiple modems: 0-4, 5-9, etc.
        local MODEM_NUM=1
        for BASE in 0 5 10 15; do
            DATA_PORT="/dev/ttyUSB$((BASE + 2))"
            AUDIO_PORT="/dev/ttyUSB$((BASE + 4))"
            if [ -e "$DATA_PORT" ] && [ -e "$AUDIO_PORT" ]; then
                cat >> /etc/asterisk/quectel.conf << MODEM_CONF

[modem-${MODEM_NUM}]
data=${DATA_PORT}
audio=${AUDIO_PORT}
context=from-gsm
slin16=yes
txgain=-18
MODEM_CONF
                info "Configured modem-${MODEM_NUM}: data=$DATA_PORT, audio=$AUDIO_PORT"
                MODEM_NUM=$((MODEM_NUM + 1))
            fi
        done
    elif [ "$MODEM_TYPE" = "EC25" ]; then
        # EC25 modems support two audio modes:
        # 1. TTY audio: audio=/dev/ttyUSBx (legacy mode)
        # 2. USB Audio Class (UAC): uac=ext, alsadev=hw:X (better quality, recommended)
        #
        # USB Audio Class detection:
        # - Check if modem exposes ALSA sound card (arecord -l | grep -i quectel)
        # - If found, use UAC mode with alsadev parameter

        local MODEM_NUM=1
        local USE_UAC=false
        local UAC_DEVICES=()

        # Detect USB Audio Class devices from Quectel modems
        # Look for ALSA capture devices (modem presents as USB sound card)
        info "Checking for USB Audio Class (UAC) devices..."
        if command -v arecord &>/dev/null; then
            # arecord -l shows capture devices, look for Quectel/EC25
            # Format: "card X: Quectel ... device Y: ..."
            while IFS= read -r line; do
                if [[ "$line" =~ ^card\ ([0-9]+):.*[Qq]uectel|[Ee][Cc]25|USB\ Audio ]]; then
                    local CARD_NUM="${BASH_REMATCH[1]}"
                    UAC_DEVICES+=("hw:${CARD_NUM}")
                    USE_UAC=true
                    info "Found USB Audio device: hw:${CARD_NUM}"
                fi
            done < <(arecord -l 2>/dev/null | grep -iE "card [0-9]+:.*quectel|ec25|usb audio" || true)
        fi

        # Fallback: check /proc/asound/cards for Quectel devices
        if [ "$USE_UAC" = false ] && [ -f /proc/asound/cards ]; then
            while IFS= read -r line; do
                if [[ "$line" =~ ^[[:space:]]*([0-9]+)[[:space:]]+.*[Qq]uectel|[Ee][Cc]25 ]]; then
                    local CARD_NUM="${BASH_REMATCH[1]}"
                    UAC_DEVICES+=("hw:${CARD_NUM}")
                    USE_UAC=true
                    info "Found USB Audio device from /proc/asound: hw:${CARD_NUM}"
                fi
            done < <(grep -iE "quectel|ec25" /proc/asound/cards 2>/dev/null || true)
        fi

        if [ "$USE_UAC" = true ]; then
            info "EC25 USB Audio Class (UAC) mode enabled - better audio quality"

            # Configure modems with UAC
            for ALSA_DEV in "${UAC_DEVICES[@]}"; do
                # Find corresponding AT command port (ttyUSB2, ttyUSB7, etc.)
                # EC25 USB ports: ttyUSB0=DM, ttyUSB1=GPS, ttyUSB2=AT, ttyUSB3=PPP
                for BASE in 0 5 10 15; do
                    DATA_PORT="/dev/ttyUSB$((BASE + 2))"
                    if [ -e "$DATA_PORT" ]; then
                        cat >> /etc/asterisk/quectel.conf << MODEM_CONF

[modem-${MODEM_NUM}]
data=${DATA_PORT}
; USB Audio Class mode (better quality than TTY audio)
uac=ext
alsadev=${ALSA_DEV}
context=from-gsm
slin16=no
txgain=-15
MODEM_CONF
                        info "Configured modem-${MODEM_NUM}: data=$DATA_PORT, alsadev=$ALSA_DEV (UAC mode)"
                        MODEM_NUM=$((MODEM_NUM + 1))
                        break
                    fi
                done
            done
        else
            # Fallback to TTY audio mode
            info "EC25 TTY audio mode (legacy) - USB Audio Class not detected"
            for BASE in 0 5 10 15; do
                DATA_PORT="/dev/ttyUSB$((BASE + 2))"
                AUDIO_PORT="/dev/ttyUSB$((BASE + 1))"
                if [ -e "$DATA_PORT" ] && [ -e "$AUDIO_PORT" ]; then
                    cat >> /etc/asterisk/quectel.conf << MODEM_CONF

[modem-${MODEM_NUM}]
data=${DATA_PORT}
audio=${AUDIO_PORT}
context=from-gsm
slin16=no
txgain=-15
MODEM_CONF
                    info "Configured modem-${MODEM_NUM}: data=$DATA_PORT, audio=$AUDIO_PORT (TTY mode)"
                    MODEM_NUM=$((MODEM_NUM + 1))
                fi
            done
        fi
    else
        # No modem detected - add template with both TTY and UAC examples
        cat >> /etc/asterisk/quectel.conf << 'MODEM_TEMPLATE'

; No modems detected during installation
; Uncomment and configure when modem is connected:

; === SIM7600 Example (TTY audio) ===
;[modem-sim7600]
;data=/dev/ttyUSB2
;audio=/dev/ttyUSB4
;context=from-gsm
;slin16=yes
;txgain=-18

; === EC25 Example (TTY audio - legacy) ===
;[modem-ec25-tty]
;data=/dev/ttyUSB2
;audio=/dev/ttyUSB1
;context=from-gsm
;slin16=no
;txgain=-15

; === EC25 Example (USB Audio Class - recommended) ===
; Better audio quality, use 'arecord -l' to find hw:X device
;[modem-ec25-uac]
;data=/dev/ttyUSB2
;uac=ext
;alsadev=hw:3
;context=from-gsm
;slin16=no
;txgain=-15
MODEM_TEMPLATE
    fi

    info "Created /etc/asterisk/quectel.conf"

    # Create symlink for /usr/local/etc/asterisk compatibility
    mkdir -p /usr/local/etc/asterisk
    if [ ! -L /usr/local/etc/asterisk/quectel.conf ]; then
        ln -sf /etc/asterisk/quectel.conf /usr/local/etc/asterisk/quectel.conf
        info "Created symlink /usr/local/etc/asterisk/quectel.conf"
    fi

    # Create udev rules for consistent device naming AND permissions
    # MODE="0666" ensures asterisk (and any user) can access the ports
    cat > /etc/udev/rules.d/99-quectel.rules << 'UDEV_RULES'
# Quectel EC25/SIM7600 modems - permissions and symlinks
# MODE="0666" allows Asterisk to access ports without root
# GROUP="dialout" for serial port access

# Quectel EC25 modems (vendor 2c7c)
SUBSYSTEM=="tty", ATTRS{idVendor}=="2c7c", MODE="0666", GROUP="dialout"
SUBSYSTEM=="tty", ATTRS{idVendor}=="2c7c", ATTRS{bInterfaceNumber}=="02", SYMLINK+="quectel-at", MODE="0666"
SUBSYSTEM=="tty", ATTRS{idVendor}=="2c7c", ATTRS{bInterfaceNumber}=="04", SYMLINK+="quectel-audio", MODE="0666"

# SIMCom SIM7600 modems (vendor 1e0e)
SUBSYSTEM=="tty", ATTRS{idVendor}=="1e0e", MODE="0666", GROUP="dialout"
SUBSYSTEM=="tty", ATTRS{idVendor}=="1e0e", ATTRS{bInterfaceNumber}=="02", SYMLINK+="sim7600-at", MODE="0666"
SUBSYSTEM=="tty", ATTRS{idVendor}=="1e0e", ATTRS{bInterfaceNumber}=="04", SYMLINK+="sim7600-audio", MODE="0666"
UDEV_RULES

    udevadm control --reload-rules 2>/dev/null || true
    udevadm trigger 2>/dev/null || true

    # Set permissions on existing ttyUSB devices immediately
    chmod 666 /dev/ttyUSB* 2>/dev/null || true

    info "Udev rules installed with proper permissions"

    # =========================================================================
    # COMPILATION SECTION - May fail, but configuration is already done
    # =========================================================================

    # Clone chan_quectel (RoEdAl fork - the one that works)
    if [ -d "asterisk-chan-quectel" ]; then
        rm -rf asterisk-chan-quectel
    fi

    # Track if compilation succeeds
    local CHAN_QUECTEL_COMPILED=false

    info "Cloning chan_quectel (RoEdAl fork)..."
    if run_cmd "Cloning chan_quectel" git clone https://github.com/RoEdAl/asterisk-chan-quectel.git; then
        cd asterisk-chan-quectel

        # Use specific commit that works (from user's VM500 setup)
        run_cmd "Checkout commit 37b566f" git checkout 37b566f || {
            warning "Could not checkout known working commit, using latest"
        }

        info "Building chan_quectel with CMake (Release mode)..."
        mkdir -p build && cd build

        # Run cmake with error checking
        info "Running cmake..."
        if run_cmd "CMake configure" cmake -DCMAKE_BUILD_TYPE=Release ..; then
            # Run make with error checking
            info "Running make (this may take a few minutes)..."
            if run_cmd "Make build" make -j$(nproc); then
                # Install
                info "Installing chan_quectel module..."
                if run_cmd "Make install" make install; then
                    CHAN_QUECTEL_COMPILED=true
                    success "chan_quectel compiled and installed successfully"
                else
                    warning "make install failed"
                fi
            else
                error "make failed! Check $LOG_FILE for details"
                warning "chan_quectel compilation failed at make stage"
            fi
        else
            error "cmake failed! Check $LOG_FILE for details"
            echo "=== CMAKE ERROR ===" >> "$LOG_FILE"
            run_cmd "CMake retry" cmake -DCMAKE_BUILD_TYPE=Release .. || true
            warning "chan_quectel compilation failed at cmake stage"
        fi

        cd /usr/src
    else
        warning "Could not clone chan_quectel - check network connectivity"
    fi

    # Continue with module installation even if compilation failed
    # (user can manually compile later)

    # CMake installs to /usr/local/lib/*/asterisk/modules/ - copy to correct location
    ARCH=$(uname -m)
    if [ "$ARCH" = "aarch64" ]; then
        LIB_ARCH="aarch64-linux-gnu"
    elif [ "$ARCH" = "x86_64" ]; then
        LIB_ARCH="x86_64-linux-gnu"
    else
        LIB_ARCH="$ARCH-linux-gnu"
    fi

    # Find the compiled module
    CHAN_QUECTEL_SO="/usr/local/lib/${LIB_ARCH}/asterisk/modules/chan_quectel.so"

    # Copy to all possible Asterisk module locations
    # FreePBX uses /lib/x86_64-linux-gnu/asterisk/modules/
    # Standalone uses /usr/lib/asterisk/modules/
    if [ -f "$CHAN_QUECTEL_SO" ]; then
        # FreePBX location (Debian packages)
        mkdir -p "/lib/${LIB_ARCH}/asterisk/modules" 2>/dev/null || true
        cp "$CHAN_QUECTEL_SO" "/lib/${LIB_ARCH}/asterisk/modules/" 2>/dev/null || true

        # Standard location - copy the file
        mkdir -p /usr/lib/asterisk/modules 2>/dev/null || true
        cp "$CHAN_QUECTEL_SO" /usr/lib/asterisk/modules/ 2>/dev/null || true

        # Create symlinks for maximum compatibility (bug #12)
        # Homenichat may check different paths depending on setup
        if [ -f "/lib/${LIB_ARCH}/asterisk/modules/chan_quectel.so" ]; then
            # Symlink from /usr/lib to /lib location
            ln -sf "/lib/${LIB_ARCH}/asterisk/modules/chan_quectel.so" \
                   /usr/lib/asterisk/modules/chan_quectel.so 2>/dev/null || true
        fi

        info "chan_quectel.so copied to Asterisk module directories"
    else
        warning "chan_quectel.so not found at expected location"
    fi

    cd /usr/src

    # Ensure chan_quectel is loaded at startup
    # The load directive MUST be under [modules] section to work
    if [ -f /etc/asterisk/modules.conf ]; then
        if ! grep -q "chan_quectel.so" /etc/asterisk/modules.conf 2>/dev/null; then
            # Check if [modules] section exists
            if grep -q "^\[modules\]" /etc/asterisk/modules.conf 2>/dev/null; then
                # Insert load directive right after [modules] section
                sed -i '/^\[modules\]/a \; Homenichat - Load chan_quectel for GSM modems\nload => chan_quectel.so' /etc/asterisk/modules.conf
                info "Added chan_quectel.so to modules.conf [modules] section"
            else
                # No [modules] section - add it at the beginning of the file
                sed -i '1i [modules]\nautoload=yes\n\n; Homenichat - Load chan_quectel for GSM modems\nload => chan_quectel.so\n' /etc/asterisk/modules.conf
                info "Added [modules] section with chan_quectel.so to modules.conf"
            fi
        else
            info "chan_quectel.so already in modules.conf"
        fi
    else
        # Create modules.conf if it doesn't exist
        cat > /etc/asterisk/modules.conf << 'MODULES_CONF'
[modules]
autoload=yes

; Homenichat - Load chan_quectel for GSM modems
load => chan_quectel.so
MODULES_CONF
        info "Created modules.conf with chan_quectel"
    fi

    # Detect if running in LXC container
    local IN_LXC=false
    if [ -f /proc/1/environ ] && grep -qa "container=lxc" /proc/1/environ 2>/dev/null; then
        IN_LXC=true
    elif [ -d /proc/vz ] && [ ! -d /proc/bc ]; then
        IN_LXC=true
    elif grep -qa "lxc" /proc/1/cgroup 2>/dev/null; then
        IN_LXC=true
    fi

    # If in LXC container, show important message about host configuration
    if [ "$IN_LXC" = true ]; then
        echo ""
        warning "=== LXC CONTAINER DETECTED ==="
        echo ""
        echo -e "${YELLOW}For SIM7600 modems, you need to add udev rules on the Proxmox HOST:${NC}"
        echo ""
        echo "  On the Proxmox host, create this file:"
        echo -e "  ${CYAN}/etc/udev/rules.d/99-sim7600.rules${NC}"
        echo ""
        echo "  With this content:"
        echo -e '  ${CYAN}ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="1e0e", ATTR{idProduct}=="9001", RUN+="/bin/sh -c '\''echo 1e0e 9001 > /sys/bus/usb-serial/drivers/option1/new_id'\''"${NC}'
        echo ""
        echo "  Then reload udev on the host:"
        echo -e "  ${CYAN}udevadm control --reload-rules && udevadm trigger${NC}"
        echo ""
        echo "  This makes the SIM7600 recognized by the 'option' driver."
        echo ""
    fi

    # Add SMS handler context to extensions.conf
    if ! grep -q "sms-handler" /etc/asterisk/extensions.conf 2>/dev/null; then
        cat >> /etc/asterisk/extensions.conf << 'EXTENSIONS_SMS'

; ============================================
; HOMENICHAT - SMS Handler
; ============================================
[sms-handler]
exten => process,1,NoOp(=== SMS ENTRANT HOMENICHAT ===)
 same => n,Set(SMS_DEVICE=${JSON_DECODE(QUECTEL,name)})
 same => n,Set(SMS_FROM=${CALLERID(num)})
 same => n,Set(SMS_TEXT=${JSON_DECODE(SMS,msg)})
 same => n,NoOp(Device: ${SMS_DEVICE}, From: ${SMS_FROM}, Text: ${SMS_TEXT})
 same => n,GotoIf($["${SMS_TEXT}" = ""]?empty)
 same => n,System(curl -s -X POST http://localhost:3001/api/internal/sms/incoming -H "Content-Type: application/json" -d '{"from":"${SMS_FROM}","text":"${SMS_TEXT}","device":"${SMS_DEVICE}"}')
 same => n,Hangup()
 same => n(empty),Hangup()

; ============================================
; HOMENICHAT - GSM Context
; ============================================
[from-gsm]
exten => _+X.,1,NoOp(=== APPEL ENTRANT GSM ===)
 same => n,Hangup()
exten => _X.,1,NoOp(=== APPEL ENTRANT GSM ===)
 same => n,Hangup()
exten => s,1,Hangup()
exten => sms,1,Goto(sms-handler,process,1)
exten => report,1,NoOp(=== SMS REPORT ===)
 same => n,Hangup()
EXTENSIONS_SMS
        info "Added SMS handler to extensions.conf"
    fi

    # Configure AMI (Asterisk Manager Interface) for Homenichat
    info "Configuring AMI for Homenichat..."
    # Use global variable so configure_env can include it in .env
    export AMI_PASSWORD=$(openssl rand -hex 12)

    # FreePBX manages manager.conf - use manager_custom.conf for custom users
    # This file is automatically included by FreePBX's manager.conf
    cat > /etc/asterisk/manager_custom.conf << MANAGER_CONF
; Homenichat AMI User - Auto-generated
; This file is included by FreePBX's manager.conf

[homenichat]
secret = ${AMI_PASSWORD}
read = system,call,log,verbose,command,agent,user,config,dtmf,reporting,cdr,dialplan,originate,message
write = system,call,log,verbose,command,agent,user,config,dtmf,reporting,cdr,dialplan,originate,message
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
writetimeout = 5000
MANAGER_CONF

    # AMI credentials will be added to .env by configure_env function
    # (stored in global AMI_PASSWORD variable)

    # Reload Asterisk manager to pick up new config
    asterisk -rx "manager reload" 2>/dev/null || true

    success "AMI configured for Homenichat (manager_custom.conf)"

    # Cleanup source directories
    cd /usr/src
    rm -rf asterisk-chan-quectel
    rm -rf asterisk-*/  # Clean up asterisk source now that headers are installed

    # Create modem initialization script (runs at boot to enter PIN)
    cat > /usr/local/bin/homenichat-modem-init << 'MODEM_INIT_SCRIPT'
#!/bin/bash
# Homenichat Modem Initialization Script
# Enters SIM PIN code at boot if configured

CONFIG_FILE="/var/lib/homenichat/modem-config.json"
LOG_FILE="/var/log/homenichat/modem-init.log"
MAX_RETRIES=30
RETRY_DELAY=2

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"
}

mkdir -p /var/log/homenichat

log "=== Modem initialization started ==="

# Read config
if [ ! -f "$CONFIG_FILE" ]; then
    log "Config file not found, exiting"
    exit 0
fi

PIN_CODE=$(grep -oP '"pinCode"\s*:\s*"\K[^"]+' "$CONFIG_FILE" 2>/dev/null)
DATA_PORT=$(grep -oP '"dataPort"\s*:\s*"\K[^"]+' "$CONFIG_FILE" 2>/dev/null)

if [ -z "$PIN_CODE" ]; then
    log "No PIN configured, exiting"
    exit 0
fi

if [ -z "$DATA_PORT" ]; then
    DATA_PORT="/dev/ttyUSB2"
fi

log "Using port: $DATA_PORT"

# Wait for modem port to appear
RETRY=0
while [ ! -e "$DATA_PORT" ] && [ $RETRY -lt $MAX_RETRIES ]; do
    log "Waiting for modem port... ($RETRY/$MAX_RETRIES)"
    sleep $RETRY_DELAY
    RETRY=$((RETRY + 1))
done

if [ ! -e "$DATA_PORT" ]; then
    log "ERROR: Modem port $DATA_PORT not found after $MAX_RETRIES retries"
    exit 1
fi

# Check if PIN is needed
log "Checking SIM PIN status..."
PIN_STATUS=$(echo -e "AT+CPIN?\r" | timeout 5 socat - "$DATA_PORT",raw,echo=0,b115200,crnl 2>/dev/null)

if echo "$PIN_STATUS" | grep -q "SIM PIN"; then
    log "Entering PIN code..."
    RESULT=$(echo -e "AT+CPIN=\"$PIN_CODE\"\r" | timeout 5 socat - "$DATA_PORT",raw,echo=0,b115200,crnl 2>/dev/null)

    if echo "$RESULT" | grep -q "OK"; then
        log "PIN accepted successfully"
        sleep 3
    else
        log "ERROR: PIN entry failed: $RESULT"
        exit 1
    fi
elif echo "$PIN_STATUS" | grep -q "PUK"; then
    log "ERROR: SIM is PUK locked!"
    exit 1
elif echo "$PIN_STATUS" | grep -q "READY"; then
    log "SIM already unlocked"
else
    log "Unknown PIN status: $PIN_STATUS"
fi

# Configure audio mode (EC25: PCM mode instead of USB audio)
MODEM_TYPE=$(grep -oP '"modemType"\s*:\s*"\K[^"]+' "$CONFIG_FILE" 2>/dev/null)
if [ "$MODEM_TYPE" = "ec25" ]; then
    log "Configuring EC25 audio mode to PCM..."
    echo -e "AT+QAUDMOD=2\r" | timeout 3 socat - "$DATA_PORT",raw,echo=0,b115200,crnl 2>/dev/null
    echo -e "AT+CPCMFRM=0\r" | timeout 3 socat - "$DATA_PORT",raw,echo=0,b115200,crnl 2>/dev/null
    log "Audio configured for PCM mode"
fi

log "Modem initialization complete"
exit 0
MODEM_INIT_SCRIPT

    chmod +x /usr/local/bin/homenichat-modem-init

    # Create systemd service for modem init
    cat > /etc/systemd/system/homenichat-modem-init.service << 'MODEM_SERVICE'
[Unit]
Description=Homenichat Modem Initialization (PIN entry)
After=network.target
Before=asterisk.service
Wants=systemd-udev-settle.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/homenichat-modem-init
RemainAfterExit=yes
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
MODEM_SERVICE

    systemctl daemon-reload
    systemctl enable homenichat-modem-init.service >> "$LOG_FILE" 2>&1 || true

    # Reload Asterisk modules to load chan_quectel immediately
    if systemctl is-active --quiet asterisk 2>/dev/null; then
        info "Reloading Asterisk modules..."
        asterisk -rx "module load chan_quectel.so" >> "$LOG_FILE" 2>&1 || true
        # Verify module loaded
        if asterisk -rx "module show like quectel" 2>/dev/null | grep -q "chan_quectel"; then
            info "chan_quectel module loaded successfully"
        else
            warning "chan_quectel module may not have loaded - will load on next Asterisk restart"
        fi
    fi

    success "chan_quectel installed"
}

configure_asterisk_audio() {
    # Only run if FreePBX was requested (includes ARM64 with Asterisk-only)
    [ "$INSTALL_FREEPBX" != true ] && return

    # Check if Asterisk is actually installed
    if ! command -v asterisk &>/dev/null; then
        warning "Asterisk not found - skipping audio configuration"
        return
    fi

    # Check if /etc/asterisk directory exists
    if [ ! -d /etc/asterisk ]; then
        warning "/etc/asterisk directory not found - skipping audio configuration"
        return
    fi

    info "Configuring Asterisk audio for WebRTC ↔ GSM bridge..."

    # Copy optimized Homenichat Asterisk configs
    if [ -f "$INSTALL_DIR/config/asterisk/extensions_homenichat.conf" ]; then
        cp "$INSTALL_DIR/config/asterisk/extensions_homenichat.conf" /etc/asterisk/
        info "Installed extensions_homenichat.conf (with VOLUME(TX)=-20)"
    fi

    if [ -f "$INSTALL_DIR/config/asterisk/pjsip_homenichat.conf" ]; then
        cp "$INSTALL_DIR/config/asterisk/pjsip_homenichat.conf" /etc/asterisk/
        info "Installed pjsip_homenichat.conf (g722,ulaw,alaw,opus codecs)"
    fi

    # NOTE: quectel.conf is auto-generated in install_chan_quectel() with modem detection
    # Do NOT overwrite it here - the auto-detected config includes actual modem devices
    # The static config/asterisk/quectel.conf is just a reference template
    if [ "$INSTALL_MODEMS" = true ]; then
        info "quectel.conf already configured by install_chan_quectel (modem auto-detection)"
    fi

    # Include Homenichat configs via *_custom.conf files
    # FreePBX manages extensions.conf and pjsip.conf directly - we use custom files
    # which FreePBX automatically includes

    # Extensions dialplan - use extensions_custom.conf
    info "Configuring extensions_custom.conf for FreePBX..."
    cat > /etc/asterisk/extensions_custom.conf << 'EXTENSIONS_CUSTOM'
; Homenichat Custom Dialplan for FreePBX
; This file is automatically included by FreePBX
; DO NOT EDIT extensions.conf directly - FreePBX regenerates it!

#include extensions_homenichat.conf
EXTENSIONS_CUSTOM
    info "Created extensions_custom.conf with homenichat include"

    # PJSIP config - use pjsip_custom.conf
    info "Configuring pjsip_custom.conf for FreePBX..."
    if [ ! -f /etc/asterisk/pjsip_custom.conf ]; then
        cat > /etc/asterisk/pjsip_custom.conf << 'PJSIP_CUSTOM'
; Homenichat Custom PJSIP Configuration for FreePBX
; This file is automatically included by FreePBX
; DO NOT EDIT pjsip.conf directly - FreePBX regenerates it!

; Include Homenichat PJSIP transport and template definitions
#include pjsip_homenichat.conf

; ============================================
; HOMENICHAT DYNAMIC EXTENSIONS
; Extensions created via Homenichat API will be added below
; ============================================

PJSIP_CUSTOM
        info "Created pjsip_custom.conf"
    else
        # Ensure homenichat include exists
        if ! grep -q "pjsip_homenichat.conf" /etc/asterisk/pjsip_custom.conf 2>/dev/null; then
            echo "" >> /etc/asterisk/pjsip_custom.conf
            echo "; Include Homenichat PJSIP config" >> /etc/asterisk/pjsip_custom.conf
            echo "#include pjsip_homenichat.conf" >> /etc/asterisk/pjsip_custom.conf
            info "Added pjsip_homenichat.conf include to existing pjsip_custom.conf"
        fi
    fi

    # Install audio initialization script for SIM7600 modems
    if [ "$INSTALL_MODEMS" = true ] && [ -f "$INSTALL_DIR/scripts/init-quectel-audio.sh" ]; then
        cp "$INSTALL_DIR/scripts/init-quectel-audio.sh" /usr/local/bin/
        chmod +x /usr/local/bin/init-quectel-audio.sh
        info "Installed init-quectel-audio.sh"

        # Create systemd service to run audio init after Asterisk starts
        cat > /etc/systemd/system/homenichat-audio-init.service << 'AUDIO_SERVICE'
[Unit]
Description=Homenichat Quectel Audio Initialization
After=asterisk.service
Requires=asterisk.service

[Service]
Type=oneshot
ExecStartPre=/bin/sleep 5
ExecStart=/usr/local/bin/init-quectel-audio.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
AUDIO_SERVICE

        systemctl daemon-reload
        systemctl enable homenichat-audio-init.service >> "$LOG_FILE" 2>&1 || true
        info "Enabled homenichat-audio-init.service"
    fi

    success "Asterisk audio configuration complete"
}

install_freepbx() {
    [ "$INSTALL_FREEPBX" != true ] && return

    info "Checking FreePBX compatibility..."

    # Get system info
    . /etc/os-release 2>/dev/null || true
    ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m)

    # FreePBX Sangoma installer requirements:
    # - Debian 12 (bookworm) only
    # - AMD64 architecture only (no ARM support)

    local CAN_INSTALL_SANGOMA=false

    if [[ "$VERSION_CODENAME" == "bookworm" && "$ARCH" == "amd64" ]]; then
        CAN_INSTALL_SANGOMA=true
    fi

    if [ "$CAN_INSTALL_SANGOMA" != true ]; then
        warning "FreePBX Sangoma installer cannot be used on this system"
        echo ""
        echo "Requirements: Debian 12 (bookworm) + AMD64 architecture"
        echo "Detected:     $PRETTY_NAME ($ARCH)"
        echo ""

        if [[ "$ARCH" == "arm64" || "$ARCH" == "aarch64" ]]; then
            # ARM64: Install Asterisk from source first
            info "ARM64 detected - Installing Asterisk from source..."
            install_asterisk_source || {
                error "Failed to install Asterisk from source"
                return 1
            }

            success "Asterisk installed successfully on ARM64"

            # Install chan_quectel for GSM modem support
            if [ "$INSTALL_MODEMS" = true ]; then
                info "Installing chan_quectel for ARM64..."
                install_chan_quectel || warning "chan_quectel installation failed"
            fi

            # In AUTO/FULL mode, automatically run FreePBX ARM installer
            if [ "$AUTO_MODE" = true ] || [ "$FULL_MODE" = true ]; then
                info "AUTO MODE: Running FreePBX ARM installer..."
                if [ -f "/opt/homenichat/scripts/install-freepbx-arm.sh" ]; then
                    # Run with auto-confirm (pipe yes)
                    yes | /opt/homenichat/scripts/install-freepbx-arm.sh >> "$LOG_FILE" 2>&1 || {
                        warning "FreePBX ARM installation had issues (check $LOG_FILE)"
                        warning "You can retry manually: sudo /opt/homenichat/scripts/install-freepbx-arm.sh"
                    }
                else
                    warning "FreePBX ARM installer script not found at /opt/homenichat/scripts/install-freepbx-arm.sh"
                fi
            else
                # Interactive mode: show options
                echo ""
                echo -e "${BOLD}Asterisk is now installed. Options for FreePBX:${NC}"
                echo ""
                echo "  1. ${BOLD}Run FreePBX ARM installer${NC} (recommended for full GUI)"
                echo "     ${CYAN}sudo /opt/homenichat/scripts/install-freepbx-arm.sh${NC}"
                echo ""
                echo "  2. ${BOLD}Use external FreePBX${NC}"
                echo "     Connect to an existing FreePBX server via AMI."
                echo "     Configure in /etc/homenichat/providers.yaml"
                echo ""
                echo "  3. ${BOLD}Use Asterisk directly (current setup)${NC}"
                echo "     Asterisk is installed and running. Configure SIP"
                echo "     trunks and extensions via /etc/asterisk/ config files."
                echo ""
            fi
        else
            echo "Options:"
            echo "  1. Use an external FreePBX server"
            echo "  2. Install on a Debian 12 AMD64 system"
            echo ""
        fi

        info "Skipping FreePBX Sangoma installer (not compatible with this system)"

        # Create example external FreePBX config
        mkdir -p "$CONFIG_DIR"
        cat >> "$CONFIG_DIR/providers.yaml" << 'FREEPBX_EXAMPLE'

# External FreePBX connection (uncomment and configure)
# voip:
#   - id: freepbx_external
#     type: freepbx
#     enabled: false
#     config:
#       host: "your-freepbx-host"
#       ami_port: 5038
#       ami_user: "homenichat"
#       ami_secret: "your-ami-secret"
#       webrtc_ws: "wss://your-domain/ws"
FREEPBX_EXAMPLE
        return 0
    fi

    # AMD64 + Bookworm: Use Sangoma installer
    info "Installing FreePBX (this may take 20-40 minutes)..."
    info "FreePBX will be downloaded from official Sangoma sources."
    warning "This will install Apache, MariaDB, PHP and many other packages."

    cd /tmp

    # Download FreePBX installer
    info "Downloading FreePBX installer from Sangoma..."
    wget -q https://github.com/FreePBX/sng_freepbx_debian_install/raw/master/sng_freepbx_debian_install.sh \
        -O freepbx_install.sh >> "$LOG_FILE" 2>&1 || {
        error "Could not download FreePBX installer"
        return 1
    }

    chmod +x freepbx_install.sh

    # Patch: If npm is already installed (via nodesource), remove it from Sangoma's package list
    # to avoid conflicts with Debian's npm package
    if command -v npm &> /dev/null; then
        info "npm already installed ($(npm --version)), patching FreePBX installer to avoid conflicts..."
        # Remove 'npm' from the package installation list in the script
        sed -i 's/\bnpm\b//g' freepbx_install.sh
        # Also remove nodejs if already installed to avoid conflicts
        if command -v node &> /dev/null; then
            sed -i 's/\bnodejs\b//g' freepbx_install.sh
        fi
    fi

    info "Running FreePBX installer (this takes 20-30 minutes)..."
    # Run with yes to auto-accept prompts
    # --skipversion bypasses the GitHub version check that blocks installation
    yes | ./freepbx_install.sh --skipversion >> "$LOG_FILE" 2>&1 || {
        warning "FreePBX installation had some issues - check log"
    }

    rm -f freepbx_install.sh

    # Fix Apache/Nginx port conflict: Move Apache to port 8080
    # Nginx uses ports 80 + 443 for Homenichat, Apache/FreePBX uses 8080 only
    if [ -f /etc/apache2/ports.conf ]; then
        info "Reconfiguring Apache to use port 8080 only (Nginx uses 80/443)..."

        # Move HTTP from 80 to 8080
        sed -i 's/Listen 80$/Listen 8080/' /etc/apache2/ports.conf
        sed -i 's/<VirtualHost \*:80>/<VirtualHost *:8080>/g' /etc/apache2/sites-available/*.conf 2>/dev/null || true

        # Disable Apache SSL - nginx will handle HTTPS on port 443
        # This prevents Apache from capturing port 443 with default-ssl.conf
        a2dissite default-ssl 2>/dev/null || true
        sed -i 's/Listen 443/#Listen 443/' /etc/apache2/ports.conf

        # Restart Apache to apply changes
        systemctl restart apache2 >> "$LOG_FILE" 2>&1 || true
        success "Apache reconfigured to port 8080 (SSL disabled, nginx handles 443)"
    fi

    # Verify
    if [ -d "/var/www/html/admin" ]; then
        success "FreePBX installed"

        # Configure FreePBX API for Homenichat integration
        configure_freepbx_api
    else
        warning "FreePBX may not be fully installed"
    fi
}

# ============================================================================
# FreePBX API Configuration (Option B)
# ============================================================================
# This enables Homenichat to create extensions/trunks that are visible
# in the FreePBX GUI for unified management.

configure_freepbx_api() {
    info "Configuring FreePBX API for Homenichat integration..."

    # Check if fwconsole is available
    if ! command -v fwconsole &> /dev/null; then
        warning "fwconsole not found, skipping API configuration"
        return
    fi

    # Wait for FreePBX to be ready
    sleep 5

    # Install API module if not present
    if ! fwconsole ma list 2>/dev/null | grep -q "^api"; then
        info "Installing FreePBX API module..."
        fwconsole ma downloadinstall api >> "$LOG_FILE" 2>&1 || {
            warning "Could not install API module - may need manual installation"
        }
    fi

    # Generate a random API secret
    local API_SECRET=$(openssl rand -hex 16)

    # Try to create an API application for Homenichat
    # Note: fwconsole api createApp may not be available in all versions
    info "Creating Homenichat API application..."
    fwconsole api createApp homenichat \
        --client-secret="$API_SECRET" \
        --scopes="read:extension,write:extension,read:trunk,write:trunk" \
        >> "$LOG_FILE" 2>&1 || {
        warning "Could not create API application via fwconsole"
        # Will fall back to PHP method in FreePBXApiService
    }

    # Save API credentials to environment
    if [ -f "$INSTALL_DIR/.env" ]; then
        # Remove old FreePBX API vars if present
        sed -i '/^FREEPBX_/d' "$INSTALL_DIR/.env"

        # Add new ones
        cat >> "$INSTALL_DIR/.env" << EOF

# FreePBX API Configuration (Option B - Full Integration)
# Extensions and trunks will be visible in FreePBX GUI
FREEPBX_URL=http://localhost
FREEPBX_CLIENT_ID=homenichat
FREEPBX_CLIENT_SECRET=$API_SECRET
FREEPBX_ADMIN_USER=admin
# FREEPBX_ADMIN_PASS= # Set this if OAuth doesn't work
EOF
    fi

    # Reload FreePBX to apply changes
    fwconsole reload >> "$LOG_FILE" 2>&1 || true

    success "FreePBX API configured for Homenichat"
    echo ""
    echo "  FreePBX API credentials saved to $INSTALL_DIR/.env"
    echo "  Extensions/trunks created by Homenichat will be visible in FreePBX GUI"
    echo ""
}

# ============================================================================
# Configuration
# ============================================================================

configure_nginx() {
    info "Configuring Nginx..."

    cat > /etc/nginx/sites-available/homenichat << 'NGINX_CONF'
server {
    listen 80;
    server_name _;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    # Redirect root to admin interface
    location = / {
        return 301 /admin;
    }

    # Redirect known frontend routes to /admin/
    # These are the React SPA routes handled by the admin interface
    location ~ ^/(modems|sms|whatsapp|voip|providers|dashboard|settings|users|security|parametres|utilisateurs)(/.*)?$ {
        return 301 /admin$request_uri;
    }

    # Admin interface (served directly from built files)
    location ^~ /admin {
        alias /opt/homenichat/admin/dist;
        index index.html;
        try_files $uri $uri/ /admin/index.html;
    }

    # API routes
    location /api/ {
        proxy_pass http://127.0.0.1:3001/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket (Homenichat)
    location /ws {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # WebSocket (Asterisk WebRTC) - proxied through nginx for SSL termination
    # External clients use wss://domain/wss instead of direct :8089
    location /wss {
        proxy_pass http://127.0.0.1:8088/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }

    # PWA frontend (optional - if installed in /opt/homenichat/public)
    location /pwa {
        alias /opt/homenichat/public;
        index index.html;
        try_files $uri $uri/ /pwa/index.html;
    }
}
NGINX_CONF

    ln -sf /etc/nginx/sites-available/homenichat /etc/nginx/sites-enabled/
    rm -f /etc/nginx/sites-enabled/default
    nginx -t >> "$LOG_FILE" 2>&1 || warning "Nginx config test failed, check syntax"
    systemctl reload nginx || systemctl restart nginx

    success "Nginx configured"
}

configure_supervisor() {
    info "Configuring Supervisor..."

    mkdir -p /var/log/homenichat

    cat > /etc/supervisor/conf.d/homenichat.conf << SUPERVISOR_CONF
[program:homenichat]
command=/usr/bin/node /opt/homenichat/server.js
directory=/opt/homenichat
user=root
autostart=true
autorestart=true
stopasgroup=true
killasgroup=true
stderr_logfile=/var/log/homenichat/error.log
stdout_logfile=/var/log/homenichat/output.log
environment=NODE_ENV="production",PORT="3001",DATA_DIR="$DATA_DIR"
SUPERVISOR_CONF

    # Restart supervisor to pick up new config
    systemctl restart supervisor >> "$LOG_FILE" 2>&1 || {
        warning "Could not restart supervisor, trying reread/update"
        supervisorctl reread >> "$LOG_FILE" 2>&1 || true
        supervisorctl update >> "$LOG_FILE" 2>&1 || true
    }

    success "Supervisor configured"
}

configure_firewall() {
    info "Configuring firewall..."

    ufw --force reset >> "$LOG_FILE" 2>&1
    ufw default deny incoming >> "$LOG_FILE" 2>&1
    ufw default allow outgoing >> "$LOG_FILE" 2>&1
    ufw allow ssh >> "$LOG_FILE" 2>&1
    ufw allow 80/tcp >> "$LOG_FILE" 2>&1
    ufw allow 443/tcp >> "$LOG_FILE" 2>&1

    if [ "$INSTALL_FREEPBX" = true ]; then
        ufw allow 5060/udp >> "$LOG_FILE" 2>&1
        ufw allow 5061/tcp >> "$LOG_FILE" 2>&1
        ufw allow 10000:20000/udp >> "$LOG_FILE" 2>&1
    fi

    ufw --force enable >> "$LOG_FILE" 2>&1

    success "Firewall configured"
}

configure_env() {
    info "Creating environment configuration..."

    mkdir -p "$CONFIG_DIR"

    # Generate secrets
    JWT_SECRET_VAL=$(openssl rand -hex 32)
    SESSION_SECRET_VAL=$(openssl rand -hex 32)

    cat > "$CONFIG_DIR/.env" << ENV_FILE
NODE_ENV=production
PORT=3001
DATA_DIR=$DATA_DIR
INSTANCE_NAME=homenichat
DB_PATH=$DATA_DIR/homenichat.db
JWT_SECRET=$JWT_SECRET_VAL
SESSION_SECRET=$SESSION_SECRET_VAL
ENV_FILE

    # Add AMI configuration if Asterisk was installed
    if [ "$INSTALL_FREEPBX" = true ] && [ -n "$AMI_PASSWORD" ]; then
        cat >> "$CONFIG_DIR/.env" << AMI_ENV

# AMI Configuration (auto-generated)
AMI_HOST=127.0.0.1
AMI_PORT=5038
AMI_USERNAME=homenichat
AMI_PASSWORD=${AMI_PASSWORD}
AMI_ENV
        info "AMI credentials added to .env"
    fi

    chmod 600 "$CONFIG_DIR/.env"

    # Link to install dir
    ln -sf "$CONFIG_DIR/.env" "$INSTALL_DIR/.env"

    success "Environment configured"
}

start_services() {
    info "Starting services..."

    systemctl enable nginx >> "$LOG_FILE" 2>&1
    systemctl start nginx >> "$LOG_FILE" 2>&1
    systemctl enable supervisor >> "$LOG_FILE" 2>&1
    systemctl start supervisor >> "$LOG_FILE" 2>&1

    sleep 2
    supervisorctl start homenichat >> "$LOG_FILE" 2>&1 || true
    sleep 3

    if supervisorctl status homenichat 2>/dev/null | grep -q RUNNING; then
        success "Homenichat service started"
    else
        warning "Service may not have started. Check: supervisorctl status homenichat"
    fi

    # Restart Asterisk to ensure all config changes and modules are loaded
    if [ "$INSTALL_FREEPBX" = true ] && systemctl is-enabled asterisk 2>/dev/null; then
        info "Restarting Asterisk to apply all configurations..."
        systemctl restart asterisk >> "$LOG_FILE" 2>&1 || true
        sleep 3

        # Verify Asterisk is running
        if systemctl is-active --quiet asterisk 2>/dev/null; then
            success "Asterisk restarted successfully"

            # Verify chan_quectel loaded (if modems installed)
            if [ "$INSTALL_MODEMS" = true ]; then
                # First ensure modules.conf has the load directive (might have been overwritten by FreePBX)
                if [ -f /etc/asterisk/modules.conf ]; then
                    if ! grep -q "chan_quectel.so" /etc/asterisk/modules.conf 2>/dev/null; then
                        info "Adding chan_quectel.so to modules.conf..."
                        if grep -q "^\[modules\]" /etc/asterisk/modules.conf 2>/dev/null; then
                            sed -i '/^\[modules\]/a load => chan_quectel.so' /etc/asterisk/modules.conf
                        else
                            echo -e "[modules]\nload => chan_quectel.so" >> /etc/asterisk/modules.conf
                        fi
                    fi
                fi

                # Try to load the module
                if asterisk -rx "module show like quectel" 2>/dev/null | grep -q "chan_quectel"; then
                    success "chan_quectel module loaded"
                else
                    info "Loading chan_quectel module..."
                    asterisk -rx "module load chan_quectel.so" >> "$LOG_FILE" 2>&1 || true
                    sleep 1
                    if asterisk -rx "module show like quectel" 2>/dev/null | grep -q "chan_quectel"; then
                        success "chan_quectel module loaded successfully"
                    else
                        warning "chan_quectel module failed to load - check /var/log/asterisk/messages"
                    fi
                fi

                # Verify at least one modem is configured
                if grep -q "^\[modem-" /etc/asterisk/quectel.conf 2>/dev/null; then
                    MODEM_COUNT=$(grep -c "^\[modem-" /etc/asterisk/quectel.conf 2>/dev/null || echo "0")
                    success "$MODEM_COUNT modem(s) configured in quectel.conf"
                else
                    warning "No modems configured in quectel.conf - add via admin interface or manually"
                fi
            fi
        else
            warning "Asterisk may not have started. Check: systemctl status asterisk"
        fi
    fi
}

configure_firewall() {
    info "Configuring firewall..."

    # Check if ufw is installed and active
    if command -v ufw &>/dev/null; then
        # Open required ports
        ufw allow 22/tcp comment 'SSH' >> "$LOG_FILE" 2>&1 || true
        ufw allow 80/tcp comment 'HTTP' >> "$LOG_FILE" 2>&1 || true
        ufw allow 443/tcp comment 'HTTPS' >> "$LOG_FILE" 2>&1 || true
        ufw allow 3001/tcp comment 'Homenichat API' >> "$LOG_FILE" 2>&1 || true

        if [ "$INSTALL_FREEPBX" = true ]; then
            ufw allow 5060/udp comment 'SIP' >> "$LOG_FILE" 2>&1 || true
            ufw allow 5061/tcp comment 'SIP TLS' >> "$LOG_FILE" 2>&1 || true
            ufw allow 5038/tcp comment 'Asterisk AMI' >> "$LOG_FILE" 2>&1 || true
            ufw allow 10000:20000/udp comment 'RTP Media' >> "$LOG_FILE" 2>&1 || true
        fi

        if [ "$INSTALL_FREEPBX" = true ]; then
            ufw allow 8080/tcp comment 'FreePBX' >> "$LOG_FILE" 2>&1 || true
        fi

        success "Firewall configured"
    else
        info "UFW not installed, skipping firewall configuration"
    fi
}

# ============================================================================
# Completion
# ============================================================================

show_completion() {
    IP_ADDR=$(hostname -I | awk '{print $1}')

    print_banner

    echo -e "${GREEN}${BOLD}Installation Complete!${NC}"
    echo ""
    echo "=========================================================="
    echo ""
    echo -e "${BOLD}Access Homenichat:${NC}"
    echo ""
    echo "  Web Interface:  http://${IP_ADDR}/"
    echo "  Admin Panel:    http://${IP_ADDR}/admin"
    echo ""
    echo -e "${BOLD}Default Admin Credentials:${NC}"
    echo ""
    echo "  Username: admin"
    echo "  Password: Homenichat"
    echo ""
    echo -e "${YELLOW}  Please change the password after first login!${NC}"
    echo ""

    if [ "$INSTALL_FREEPBX" = true ]; then
        # Verify FreePBX is actually installed
        if command -v fwconsole &>/dev/null; then
            echo -e "${BOLD}FreePBX:${NC}"
            echo "  FreePBX Admin:  http://${IP_ADDR}:8080"
            echo ""
        else
            echo -e "${YELLOW}FreePBX:${NC}"
            echo "  FreePBX was selected but not fully installed."
            if [ "$(uname -m)" = "aarch64" ]; then
                echo "  Run: sudo /opt/homenichat/scripts/install-freepbx-arm.sh"
            fi
            echo ""
        fi
    fi

    echo "=========================================================="
    echo ""
    echo -e "${BOLD}Useful Commands:${NC}"
    echo ""
    echo "  View logs:      sudo tail -f /var/log/homenichat/output.log"
    echo "  Restart:        sudo supervisorctl restart homenichat"
    echo "  Status:         sudo supervisorctl status homenichat"
    echo "  Edit config:    sudo nano $CONFIG_DIR/.env"
    echo ""
    echo "=========================================================="
    echo ""
    echo "Installation log: $LOG_FILE"
    echo ""
    echo -e "${GREEN}Thank you for installing Homenichat!${NC}"
    echo ""
}

# ============================================================================
# Main
# ============================================================================

main() {
    mkdir -p "$(dirname "$LOG_FILE")"
    echo "Homenichat Installation - $(date)" > "$LOG_FILE"

    check_root
    show_disclaimers

    print_banner
    echo -e "${BOLD}System Checks${NC}"
    echo ""
    check_os
    check_memory
    check_disk
    check_internet
    wait_key

    choose_components

    print_banner
    echo -e "${BOLD}Installing Homenichat...${NC}"
    echo ""
    echo "This may take 10-30 minutes depending on your choices."
    echo ""

    install_dependencies
    install_nodejs
    install_homenichat
    install_baileys
    disable_modemmanager
    install_gammu
    install_upnp
    install_wireguard
    install_freepbx
    install_chan_quectel
    configure_asterisk_audio

    print_banner
    echo -e "${BOLD}Configuring Homenichat...${NC}"
    echo ""

    configure_env
    configure_nginx
    configure_supervisor
    configure_firewall
    start_services

    show_completion
}

main "$@"
