#!/bin/bash
#
# Homenichat - Installation Script
# For Raspberry Pi 4/5 with Raspberry Pi OS 64-bit (Bookworm/Trixie)
#
# Usage: curl -fsSL https://raw.githubusercontent.com/elkir0/homenichat-serv/main/scripts/install.sh | sudo bash
#    or: sudo ./install.sh
#    or: sudo ./install.sh --auto  (non-interactive, accept defaults)
#    or: sudo ./install.sh --full  (install ALL components: Baileys, Asterisk, Modems)
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
INSTALL_ASTERISK=false
INSTALL_FREEPBX=false
INSTALL_BAILEYS=true
INSTALL_MODEMS=false

# Auto mode (non-interactive)
AUTO_MODE=false
FULL_MODE=false

for arg in "$@"; do
    case "$arg" in
        --auto|-y|--yes)
            AUTO_MODE=true
            ;;
        --full|--all)
            AUTO_MODE=true
            FULL_MODE=true
            INSTALL_ASTERISK=true
            INSTALL_FREEPBX=true
            INSTALL_BAILEYS=true
            INSTALL_MODEMS=true
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

    echo -e "${BOLD}2. VoIP Integration (Asterisk + FreePBX)${NC}"
    echo "   Full PBX functionality with web management."
    echo "   - Make/receive phone calls"
    echo "   - Extensions, IVR, voicemail"
    echo "   - Requires more resources (~500MB extra RAM)"
    echo ""
    if confirm "   Install Asterisk + FreePBX?" "n"; then
        INSTALL_ASTERISK=true
        INSTALL_FREEPBX=true
        success "   Asterisk + FreePBX will be installed"
    else
        INSTALL_ASTERISK=false
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

    apt-get update >> "$LOG_FILE" 2>&1

    # Fix locale warnings first
    apt-get install -y locales >> "$LOG_FILE" 2>&1
    sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen 2>/dev/null || true
    locale-gen >> "$LOG_FILE" 2>&1 || true
    export LANG=en_US.UTF-8
    export LC_ALL=en_US.UTF-8

    apt-get install -y \
        curl wget git build-essential python3 python3-pip \
        sqlite3 nginx supervisor ufw \
        >> "$LOG_FILE" 2>&1

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

    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >> "$LOG_FILE" 2>&1
    apt-get install -y nodejs >> "$LOG_FILE" 2>&1

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
        git pull >> "$LOG_FILE" 2>&1 || warning "Could not update, continuing with existing version"
    else
        info "Cloning from $REPO_URL..."
        rm -rf "$INSTALL_DIR"
        git clone "$REPO_URL" "$INSTALL_DIR" >> "$LOG_FILE" 2>&1 || {
            fatal "Could not clone repository. Please check your internet connection."
        }
    fi

    # Install npm dependencies (repo root is the server, no backend subfolder)
    cd "$INSTALL_DIR"
    info "Installing Node.js dependencies..."
    npm install --omit=dev >> "$LOG_FILE" 2>&1

    # Build admin interface
    if [ -d "$INSTALL_DIR/admin" ]; then
        info "Building admin interface..."
        cd "$INSTALL_DIR/admin"
        npm install >> "$LOG_FILE" 2>&1
        npm run build >> "$LOG_FILE" 2>&1
        cd "$INSTALL_DIR"
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

install_asterisk() {
    [ "$INSTALL_ASTERISK" != true ] && return

    info "Installing Asterisk..."

    # Try to install from repos first (may not be available in Bookworm/Trixie)
    # Use apt-get install with || to handle failure gracefully
    if apt-get install -y asterisk asterisk-modules asterisk-config >> "$LOG_FILE" 2>&1; then
        info "Asterisk installed from repositories"
    else
        info "Asterisk not in repos, building from source (this takes 15-30 minutes)..."
        install_asterisk_from_source
    fi

    # Enable and start
    systemctl enable asterisk >> "$LOG_FILE" 2>&1 || true
    systemctl start asterisk >> "$LOG_FILE" 2>&1 || true

    # Verify installation
    if command -v asterisk &>/dev/null; then
        success "Asterisk $(asterisk -V 2>/dev/null || echo 'installed')"
    else
        warning "Asterisk installation may have issues"
    fi
}

install_asterisk_from_source() {
    info "Installing build dependencies..."

    # Install linux headers if available (may not exist on all systems)
    apt-get install -y linux-headers-$(uname -r) >> "$LOG_FILE" 2>&1 || {
        warning "linux-headers not available for kernel $(uname -r), continuing without"
    }

    # Core build dependencies
    apt-get install -y build-essential wget libssl-dev libncurses5-dev \
        libnewt-dev libxml2-dev libsqlite3-dev \
        uuid-dev libjansson-dev libedit-dev libsrtp2-dev \
        subversion libspandsp-dev libresample1-dev \
        >> "$LOG_FILE" 2>&1

    cd /usr/src
    ASTERISK_VERSION="20-current"

    info "Downloading Asterisk ${ASTERISK_VERSION}..."
    wget -q "http://downloads.asterisk.org/pub/telephony/asterisk/asterisk-${ASTERISK_VERSION}.tar.gz" \
        -O asterisk.tar.gz >> "$LOG_FILE" 2>&1 || {
        # Try certified version if current fails
        wget -q "http://downloads.asterisk.org/pub/telephony/certified-asterisk/asterisk-certified-20.7-current.tar.gz" \
            -O asterisk.tar.gz >> "$LOG_FILE" 2>&1
    }

    tar xzf asterisk.tar.gz
    cd asterisk-*/

    info "Configuring Asterisk..."
    contrib/scripts/get_mp3_source.sh >> "$LOG_FILE" 2>&1 || true
    ./configure --with-jansson-bundled >> "$LOG_FILE" 2>&1

    info "Building Asterisk (this takes 10-20 minutes on Pi)..."
    make menuselect.makeopts >> "$LOG_FILE" 2>&1
    make -j$(nproc) >> "$LOG_FILE" 2>&1
    make install >> "$LOG_FILE" 2>&1
    make samples >> "$LOG_FILE" 2>&1
    make config >> "$LOG_FILE" 2>&1

    # Create asterisk user
    useradd -r -d /var/lib/asterisk -s /sbin/nologin asterisk 2>/dev/null || true
    chown -R asterisk:asterisk /var/lib/asterisk /var/spool/asterisk /var/log/asterisk /var/run/asterisk 2>/dev/null || true

    cd /usr/src
    # Don't clean up asterisk source yet - chan_quectel needs headers
    # Cleanup happens in install_chan_quectel after headers are installed
    rm -f asterisk.tar.gz
}

install_chan_quectel() {
    [ "$INSTALL_MODEMS" != true ] && return
    [ "$INSTALL_ASTERISK" != true ] && return

    info "Installing chan_quectel for Quectel/SIM7600 modems..."

    # Install dependencies (cmake is required - RoEdAl fork uses CMake, not autoconf)
    apt-get install -y cmake libasound2-dev >> "$LOG_FILE" 2>&1

    cd /usr/src

    # Install Asterisk headers if built from source
    ASTERISK_SRC=$(find /usr/src -maxdepth 1 -type d -name "asterisk-*" 2>/dev/null | head -1)
    if [ -n "$ASTERISK_SRC" ] && [ -d "$ASTERISK_SRC" ]; then
        info "Installing Asterisk development headers..."
        cd "$ASTERISK_SRC"
        make install-headers >> "$LOG_FILE" 2>&1 || true
    fi

    cd /usr/src

    # Clone chan_quectel (RoEdAl fork - the one that works)
    if [ -d "asterisk-chan-quectel" ]; then
        rm -rf asterisk-chan-quectel
    fi

    info "Cloning chan_quectel (RoEdAl fork)..."
    git clone https://github.com/RoEdAl/asterisk-chan-quectel.git >> "$LOG_FILE" 2>&1 || {
        warning "Could not clone chan_quectel"
        return 1
    }

    cd asterisk-chan-quectel

    # Use specific commit that works (from user's VM500 setup)
    git checkout 37b566f >> "$LOG_FILE" 2>&1 || {
        warning "Could not checkout known working commit, using latest"
    }

    info "Building chan_quectel with CMake (Release mode)..."
    mkdir -p build && cd build
    cmake -DCMAKE_BUILD_TYPE=Release .. >> "$LOG_FILE" 2>&1
    make >> "$LOG_FILE" 2>&1
    make install >> "$LOG_FILE" 2>&1

    # CMake installs to /usr/local/lib/*/asterisk/modules/ - copy to standard location
    ARCH=$(uname -m)
    if [ "$ARCH" = "aarch64" ]; then
        LIB_ARCH="aarch64-linux-gnu"
    elif [ "$ARCH" = "x86_64" ]; then
        LIB_ARCH="x86_64-linux-gnu"
    else
        LIB_ARCH="$ARCH-linux-gnu"
    fi

    if [ -f "/usr/local/lib/${LIB_ARCH}/asterisk/modules/chan_quectel.so" ]; then
        cp /usr/local/lib/${LIB_ARCH}/asterisk/modules/chan_quectel.so /usr/lib/asterisk/modules/ 2>/dev/null || true
    fi

    cd /usr/src

    # Create SMS database directories
    mkdir -p /var/lib/asterisk/smsdb
    chown asterisk:asterisk /var/lib/asterisk/smsdb 2>/dev/null || true

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

    # Detect modem type for proper configuration
    # SIM7600: vendor 1e0e, uses slin16=yes, data=ttyUSB2, audio=ttyUSB4
    # EC25: vendor 2c7c, uses slin16=no, data=ttyUSB2, audio=ttyUSB1
    local MODEM_TYPE="unknown"
    local SLIN16="no"
    local DATA_PORT="/dev/ttyUSB2"
    local AUDIO_PORT="/dev/ttyUSB1"

    if lsusb 2>/dev/null | grep -q "1e0e:9001"; then
        MODEM_TYPE="SIM7600"
        SLIN16="yes"
        DATA_PORT="/dev/ttyUSB2"
        AUDIO_PORT="/dev/ttyUSB4"
        info "Detected SIM7600 modem - using 16kHz audio (slin16=yes)"
    elif lsusb 2>/dev/null | grep -q "2c7c:"; then
        MODEM_TYPE="EC25"
        SLIN16="no"
        DATA_PORT="/dev/ttyUSB2"
        AUDIO_PORT="/dev/ttyUSB1"
        info "Detected Quectel EC25 modem - using 8kHz audio (slin16=no)"
    else
        warning "No known modem detected - using default EC25 configuration"
    fi

    # Create quectel config (based on VM500 production config)
    cat > /etc/asterisk/quectel.conf << QUECTEL_CONF
; Homenichat - chan_quectel configuration
; Generated for: ${MODEM_TYPE} modem
; Based on VM500 production config

[general]
interval=15
smsdb=/var/lib/asterisk/smsdb
csmsttl=600

[defaults]
context=from-gsm
group=0
; Audio gains tuned for production (VM500 tested values)
; rxgain: GSM network → Asterisk (speaker/incoming audio)
; txgain: Asterisk → GSM network (microphone/outgoing audio)
rxgain=-5
txgain=-15
autodeletesms=yes
resetquectel=yes
msg_storage=me
msg_direct=off
usecallingpres=yes
callingpres=allowed_passed_screen
; Audio format: SIM7600 requires 16kHz (slin16=yes), EC25 uses 8kHz (slin16=no)
slin16=${SLIN16}

; Auto-configured modem (Homenichat installation)
; Detected modem type: ${MODEM_TYPE}
; Modem will be auto-detected and configured by Homenichat admin UI
; Or you can manually configure below

[hni-modem]
data=${DATA_PORT}
audio=${AUDIO_PORT}
; imsi will be auto-detected
QUECTEL_CONF

    # Create symlink for /usr/local/etc/asterisk compatibility
    mkdir -p /usr/local/etc/asterisk
    if [ ! -L /usr/local/etc/asterisk/quectel.conf ]; then
        ln -sf /etc/asterisk/quectel.conf /usr/local/etc/asterisk/quectel.conf
        info "Created symlink /usr/local/etc/asterisk/quectel.conf -> /etc/asterisk/quectel.conf"
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

    # Create udev rules for consistent device naming
    cat > /etc/udev/rules.d/99-quectel.rules << 'UDEV_RULES'
# Quectel EC25/SIM7600 modems - create consistent symlinks
# AT command port (interface 2)
SUBSYSTEM=="tty", ATTRS{idVendor}=="2c7c", ATTRS{bInterfaceNumber}=="02", SYMLINK+="quectel-at"
# Audio port (interface 4)
SUBSYSTEM=="tty", ATTRS{idVendor}=="2c7c", ATTRS{bInterfaceNumber}=="04", SYMLINK+="quectel-audio"

# SIMCom SIM7600
SUBSYSTEM=="tty", ATTRS{idVendor}=="1e0e", ATTRS{bInterfaceNumber}=="02", SYMLINK+="sim7600-at"
SUBSYSTEM=="tty", ATTRS{idVendor}=="1e0e", ATTRS{bInterfaceNumber}=="04", SYMLINK+="sim7600-audio"
UDEV_RULES

    udevadm control --reload-rules 2>/dev/null || true
    udevadm trigger 2>/dev/null || true

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
    AMI_PASSWORD=$(openssl rand -hex 12)

    cat > /etc/asterisk/manager.conf << MANAGER_CONF
[general]
enabled = yes
port = 5038
bindaddr = 127.0.0.1

[homenichat]
secret = ${AMI_PASSWORD}
read = all
write = all
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
MANAGER_CONF

    # Add AMI credentials to .env
    if [ -f "$INSTALL_DIR/.env" ]; then
        # Remove old AMI config if exists
        sed -i '/^AMI_/d' "$INSTALL_DIR/.env"
    fi

    cat >> "$INSTALL_DIR/.env" << AMI_ENV

# AMI Configuration (auto-generated)
AMI_HOST=127.0.0.1
AMI_PORT=5038
AMI_USERNAME=homenichat
AMI_PASSWORD=${AMI_PASSWORD}
AMI_ENV

    # Reload Asterisk manager
    asterisk -rx "manager reload" 2>/dev/null || true

    success "AMI configured for Homenichat"

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
            echo -e "${BOLD}Options for Raspberry Pi / ARM64:${NC}"
            echo ""
            echo "  1. ${BOLD}Run our FreePBX ARM installer${NC} (recommended)"
            echo "     After this installation completes, run:"
            echo "     ${CYAN}sudo /opt/homenichat/scripts/install-freepbx-arm.sh${NC}"
            echo ""
            echo "  2. ${BOLD}Use external FreePBX${NC}"
            echo "     Connect to an existing FreePBX server via AMI."
            echo "     Configure in /etc/homenichat/providers.yaml"
            echo ""
            echo "  3. ${BOLD}Use Asterisk directly${NC}"
            echo "     Asterisk is installed. Configure SIP trunks"
            echo "     and extensions via config files."
            echo ""
        else
            echo "Options:"
            echo "  1. Use an external FreePBX server"
            echo "  2. Install on a Debian 12 AMD64 system"
            echo ""
        fi

        warning "Skipping FreePBX installation"

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
    yes | ./freepbx_install.sh >> "$LOG_FILE" 2>&1 || {
        warning "FreePBX installation had some issues - check log"
    }

    rm -f freepbx_install.sh

    # Verify
    if [ -d "/var/www/html/admin" ]; then
        success "FreePBX installed"
    else
        warning "FreePBX may not be fully installed"
    fi
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

    # WebSocket
    location /ws {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
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
    if [ "$INSTALL_ASTERISK" = true ] && systemctl is-enabled asterisk 2>/dev/null; then
        info "Restarting Asterisk to apply all configurations..."
        systemctl restart asterisk >> "$LOG_FILE" 2>&1 || true
        sleep 3

        # Verify Asterisk is running
        if systemctl is-active --quiet asterisk 2>/dev/null; then
            success "Asterisk restarted successfully"

            # Verify chan_quectel loaded (if modems installed)
            if [ "$INSTALL_MODEMS" = true ]; then
                if asterisk -rx "module show like quectel" 2>/dev/null | grep -q "chan_quectel"; then
                    success "chan_quectel module loaded"
                else
                    warning "chan_quectel module not loaded - check /etc/asterisk/modules.conf"
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

        if [ "$INSTALL_ASTERISK" = true ]; then
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
        echo -e "${BOLD}FreePBX:${NC}"
        echo "  FreePBX Admin:  http://${IP_ADDR}:8080"
        echo ""
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
    install_asterisk
    install_chan_quectel
    install_freepbx

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
