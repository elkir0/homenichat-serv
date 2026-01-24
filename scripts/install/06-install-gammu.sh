#!/bin/bash
# Installation de Gammu pour SMS via modem USB
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/colors.sh"
source "$SCRIPT_DIR/lib/logging.sh"
source "$SCRIPT_DIR/lib/utils.sh"

log_header "Gammu Installation"

require_root

# Check if already installed
if command_exists gammu; then
    GAMMU_VERSION=$(gammu --version | head -1)
    log_success "Gammu already installed: $GAMMU_VERSION"
    exit 0
fi

log_info "Installing Gammu SMS daemon..."

# Install Gammu and related packages
install_packages gammu gammu-smsd libgammu-dev

log_success "Gammu installed successfully"

# Create default configuration directory
ensure_dir /etc/gammu

# Create default gammurc if not exists
if [[ ! -f /etc/gammurc ]]; then
    log_info "Creating default Gammu configuration..."

    cat > /etc/gammurc << 'EOF'
; Gammu configuration
; This file will be updated when a modem is detected

[gammu]
; Device path - will be configured by modem detection
;device = /dev/ttyUSB2
;connection = at

; Uncomment and configure when modem is detected
; For SIM7600: connection = at, device = /dev/ttyUSB2
; For EC25: connection = at, device = /dev/ttyUSB2
EOF

    log_success "Default configuration created at /etc/gammurc"
fi

# Create gammu-smsd configuration if not exists
if [[ ! -f /etc/gammu-smsdrc ]]; then
    log_info "Creating SMS daemon configuration..."

    cat > /etc/gammu-smsdrc << 'EOF'
; Gammu SMS Daemon configuration
; Used for background SMS sending/receiving

[gammu]
;device = /dev/ttyUSB2
;connection = at

[smsd]
service = files
logfile = /var/log/gammu-smsd.log
debuglevel = 0

; Incoming SMS directory
inboxpath = /var/spool/gammu/inbox/
; Outgoing SMS directory
outboxpath = /var/spool/gammu/outbox/
; Sent SMS directory
sentsmspath = /var/spool/gammu/sent/
; Error SMS directory
errorsmspath = /var/spool/gammu/error/

; Run script on incoming SMS
;runonreceive = /opt/homenichat/scripts/modem/on-sms-receive.sh
EOF

    log_success "SMS daemon configuration created at /etc/gammu-smsdrc"
fi

# Create spool directories
log_info "Creating SMS spool directories..."
ensure_dir /var/spool/gammu/inbox
ensure_dir /var/spool/gammu/outbox
ensure_dir /var/spool/gammu/sent
ensure_dir /var/spool/gammu/error

# Set permissions
chmod -R 755 /var/spool/gammu
chown -R root:root /var/spool/gammu

# Disable gammu-smsd autostart (we'll use Homenichat's own SMS handling)
log_info "Disabling gammu-smsd autostart..."
systemctl disable gammu-smsd 2>/dev/null || true
systemctl stop gammu-smsd 2>/dev/null || true

log_success "Gammu installation complete"
log_info "Note: Gammu is installed but gammu-smsd is disabled."
log_info "SMS handling is done by Homenichat's ModemService."
log_info "Run modem detection to configure: /opt/homenichat/scripts/modem/detect-modem.sh"
