#!/bin/bash
# Installation d'Asterisk depuis les sources (sans FreePBX)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/colors.sh"
source "$SCRIPT_DIR/lib/logging.sh"
source "$SCRIPT_DIR/lib/utils.sh"

# Configuration
ASTERISK_VERSION="${ASTERISK_VERSION:-22}"
BUILD_DIR="/usr/src/asterisk-build"

log_header "Asterisk Installation"

require_root

# Check if already installed
if command_exists asterisk; then
    CURRENT_VERSION=$(asterisk -V 2>/dev/null | grep -oP '\d+' | head -1 || echo "0")
    if [[ "$CURRENT_VERSION" -ge "${ASTERISK_VERSION%%.*}" ]]; then
        log_success "Asterisk $CURRENT_VERSION already installed"
        asterisk -V
        exit 0
    else
        log_warn "Asterisk $CURRENT_VERSION found, but $ASTERISK_VERSION+ preferred"
    fi
fi

log_info "Installing Asterisk $ASTERISK_VERSION from source..."
log_warn "This may take 15-30 minutes on Raspberry Pi"

# Install build dependencies
log_info "Installing build dependencies..."
update_apt_cache

DEPS=(
    build-essential
    git
    curl
    wget
    libncurses5-dev
    libssl-dev
    libxml2-dev
    libsqlite3-dev
    uuid-dev
    libjansson-dev
    libedit-dev
    libsrtp2-dev
    libspandsp-dev
    libcurl4-openssl-dev
    libvorbis-dev
    libspeex-dev
    libspeexdsp-dev
    libopus-dev
    libsndfile1-dev
    libgmime-3.0-dev
    libpq-dev
    unixodbc-dev
    freetds-dev
    libasound2-dev
    xmlstarlet
    sox
)

install_packages "${DEPS[@]}"

log_success "Build dependencies installed"

# Create build directory
ensure_dir "$BUILD_DIR"
cd "$BUILD_DIR"

# Download Asterisk if needed
TARBALL="asterisk-${ASTERISK_VERSION}-current.tar.gz"
if [[ ! -f "$TARBALL" ]]; then
    log_info "Downloading Asterisk $ASTERISK_VERSION..."
    download_file "https://downloads.asterisk.org/pub/telephony/asterisk/$TARBALL" "$TARBALL"
fi

# Extract
log_info "Extracting source code..."
tar -xzf "$TARBALL"
cd asterisk-${ASTERISK_VERSION}*/

# Install prerequisites (for codecs, etc.)
log_info "Installing Asterisk prerequisites..."
contrib/scripts/install_prereq install >> "$LOG_FILE" 2>&1 || true

# Configure
log_info "Configuring Asterisk..."
./configure \
    --with-jansson-bundled \
    --with-pjproject-bundled \
    >> "$LOG_FILE" 2>&1

# Select modules
log_info "Selecting modules..."
make menuselect.makeopts >> "$LOG_FILE" 2>&1

# Enable required modules
menuselect/menuselect \
    --enable chan_pjsip \
    --enable res_pjsip \
    --enable res_pjsip_authenticator_digest \
    --enable res_pjsip_endpoint_identifier_user \
    --enable res_pjsip_session \
    --enable res_http_websocket \
    --enable codec_opus \
    --enable codec_g729 \
    --enable CORE-SOUNDS-EN-WAV \
    --enable CORE-SOUNDS-EN-G722 \
    menuselect.makeopts >> "$LOG_FILE" 2>&1 || true

# Compile
log_info "Compiling Asterisk (this takes a while)..."
NPROC=$(nproc)
make -j"$NPROC" >> "$LOG_FILE" 2>&1

# Install
log_info "Installing Asterisk..."
make install >> "$LOG_FILE" 2>&1
make samples >> "$LOG_FILE" 2>&1
make config >> "$LOG_FILE" 2>&1

# Create asterisk user if doesn't exist
if ! id -u asterisk &>/dev/null; then
    log_info "Creating asterisk user..."
    useradd -r -s /bin/false asterisk
fi

# Set ownership
log_info "Setting permissions..."
chown -R asterisk:asterisk /var/lib/asterisk
chown -R asterisk:asterisk /var/spool/asterisk
chown -R asterisk:asterisk /var/log/asterisk
chown -R asterisk:asterisk /var/run/asterisk 2>/dev/null || true

# Configure asterisk.conf to run as asterisk user
if [[ -f /etc/asterisk/asterisk.conf ]]; then
    sed -i 's/^;runuser = asterisk/runuser = asterisk/' /etc/asterisk/asterisk.conf
    sed -i 's/^;rungroup = asterisk/rungroup = asterisk/' /etc/asterisk/asterisk.conf
fi

# Enable and start service
log_info "Enabling Asterisk service..."
systemctl enable asterisk >> "$LOG_FILE" 2>&1

# Start Asterisk
log_info "Starting Asterisk..."
systemctl start asterisk >> "$LOG_FILE" 2>&1

# Wait for startup
sleep 3

# Verify
if systemctl is-active --quiet asterisk; then
    log_success "Asterisk started successfully"
    asterisk -rx "core show version" 2>/dev/null || true
else
    log_error "Asterisk failed to start. Check logs: journalctl -u asterisk"
    exit 1
fi

# Cleanup build directory (optional, saves ~500MB)
if [[ "${CLEANUP_BUILD:-1}" == "1" ]]; then
    log_info "Cleaning up build files..."
    rm -rf "$BUILD_DIR"
fi

log_success "Asterisk $ASTERISK_VERSION installation complete"
