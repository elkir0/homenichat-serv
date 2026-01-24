#!/bin/bash
#
# Homenichat-Serv Installation Script
# Modular installer - runs individual components as needed
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/elkir0/homenichat-serv/refactor/scripts/install/install.sh | sudo bash
#   curl -fsSL ... | sudo bash -s -- --full
#   curl -fsSL ... | sudo bash -s -- --minimal
#   curl -fsSL ... | sudo bash -s -- nodejs homenichat
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# If running from curl pipe, download scripts first
if [[ ! -f "$SCRIPT_DIR/lib/colors.sh" ]]; then
    echo "Downloading Homenichat installer..."
    TEMP_DIR=$(mktemp -d)
    cd "$TEMP_DIR"

    # Download installer files
    REPO_URL="https://raw.githubusercontent.com/elkir0/homenichat-serv/refactor/scripts/install"

    mkdir -p lib
    curl -fsSL "$REPO_URL/lib/colors.sh" -o lib/colors.sh
    curl -fsSL "$REPO_URL/lib/logging.sh" -o lib/logging.sh
    curl -fsSL "$REPO_URL/lib/utils.sh" -o lib/utils.sh
    curl -fsSL "$REPO_URL/00-detect-system.sh" -o 00-detect-system.sh
    curl -fsSL "$REPO_URL/01-install-nodejs.sh" -o 01-install-nodejs.sh
    curl -fsSL "$REPO_URL/02-install-homenichat.sh" -o 02-install-homenichat.sh
    curl -fsSL "$REPO_URL/03-install-asterisk.sh" -o 03-install-asterisk.sh
    curl -fsSL "$REPO_URL/04-install-chan-quectel.sh" -o 04-install-chan-quectel.sh
    curl -fsSL "$REPO_URL/05-configure-asterisk.sh" -o 05-configure-asterisk.sh
    curl -fsSL "$REPO_URL/06-install-gammu.sh" -o 06-install-gammu.sh
    curl -fsSL "$REPO_URL/07-setup-services.sh" -o 07-setup-services.sh

    chmod +x *.sh lib/*.sh

    SCRIPT_DIR="$TEMP_DIR"
    cd "$SCRIPT_DIR"
fi

source "$SCRIPT_DIR/lib/colors.sh"
source "$SCRIPT_DIR/lib/logging.sh"
source "$SCRIPT_DIR/lib/utils.sh"

# Banner
echo ""
echo -e "${BOLD_CYAN}"
echo "  _   _                            _      _           _   "
echo " | | | | ___  _ __ ___   ___ _ __ (_) ___| |__   __ _| |_ "
echo " | |_| |/ _ \| '_ \` _ \ / _ \ '_ \| |/ __| '_ \ / _\` | __|"
echo " |  _  | (_) | | | | | |  __/ | | | | (__| | | | (_| | |_ "
echo " |_| |_|\___/|_| |_| |_|\___|_| |_|_|\___|_| |_|\__,_|\__|"
echo -e "${NC}"
echo -e "${BOLD}Unified Communications Server - Self-Hosted${NC}"
echo ""

# Parse arguments
COMPONENTS=()
INTERACTIVE=true

while [[ $# -gt 0 ]]; do
    case $1 in
        --full)
            COMPONENTS=(nodejs homenichat asterisk chan-quectel configure-asterisk gammu services)
            INTERACTIVE=false
            ;;
        --minimal)
            COMPONENTS=(nodejs homenichat services)
            INTERACTIVE=false
            ;;
        --voip)
            COMPONENTS=(nodejs homenichat asterisk chan-quectel configure-asterisk services)
            INTERACTIVE=false
            ;;
        --sms)
            COMPONENTS=(nodejs homenichat gammu services)
            INTERACTIVE=false
            ;;
        --auto)
            # Auto-detect what's needed
            INTERACTIVE=false
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS] [COMPONENTS...]"
            echo ""
            echo "Options:"
            echo "  --full      Install all components (VoIP + SMS)"
            echo "  --minimal   Install only Homenichat (no VoIP/SMS)"
            echo "  --voip      Install Homenichat + Asterisk + chan_quectel"
            echo "  --sms       Install Homenichat + Gammu (SMS only)"
            echo "  --auto      Auto-detect and install what's needed"
            echo "  --help      Show this help"
            echo ""
            echo "Components:"
            echo "  nodejs         Node.js 20 LTS"
            echo "  homenichat     Homenichat-Serv application"
            echo "  asterisk       Asterisk PBX (from source)"
            echo "  chan-quectel   GSM modem bridge for Asterisk"
            echo "  configure-asterisk  Configure Asterisk for Homenichat"
            echo "  gammu          SMS via USB modem"
            echo "  services       systemd services"
            echo ""
            echo "Examples:"
            echo "  $0 --full                  # Full installation"
            echo "  $0 nodejs homenichat       # Only Node.js and Homenichat"
            echo "  $0 --voip                  # VoIP support without Gammu"
            exit 0
            ;;
        -*)
            log_error "Unknown option: $1"
            exit 1
            ;;
        *)
            COMPONENTS+=("$1")
            INTERACTIVE=false
            ;;
    esac
    shift
done

# Check root
require_root

# Run system detection
log_info "Detecting system..."
source "$SCRIPT_DIR/00-detect-system.sh"

# Interactive mode - ask what to install
if [[ "$INTERACTIVE" == "true" && ${#COMPONENTS[@]} -eq 0 ]]; then
    echo ""
    log_info "What would you like to install?"
    echo ""
    echo "  1) Full installation (VoIP + SMS + WhatsApp)"
    echo "  2) VoIP only (Asterisk + GSM modem)"
    echo "  3) SMS only (Gammu + GSM modem)"
    echo "  4) Minimal (WhatsApp only, no hardware)"
    echo "  5) Custom (choose components)"
    echo ""
    read -rp "Select option [1-5]: " choice

    case $choice in
        1)
            COMPONENTS=(nodejs homenichat asterisk chan-quectel configure-asterisk gammu services)
            ;;
        2)
            COMPONENTS=(nodejs homenichat asterisk chan-quectel configure-asterisk services)
            ;;
        3)
            COMPONENTS=(nodejs homenichat gammu services)
            ;;
        4)
            COMPONENTS=(nodejs homenichat services)
            ;;
        5)
            echo ""
            echo "Select components to install (space-separated):"
            echo "  Available: nodejs homenichat asterisk chan-quectel configure-asterisk gammu services"
            read -rp "> " -a COMPONENTS
            ;;
        *)
            log_error "Invalid option"
            exit 1
            ;;
    esac
fi

# Default if still empty
if [[ ${#COMPONENTS[@]} -eq 0 ]]; then
    COMPONENTS=(nodejs homenichat services)
fi

# Show what will be installed
log_header "Installation Plan"
log_info "Components to install:"
for component in "${COMPONENTS[@]}"; do
    echo -e "  ${ARROW} $component"
done
echo ""

if [[ "$INTERACTIVE" == "true" ]]; then
    if ! confirm "Proceed with installation?"; then
        log_info "Installation cancelled"
        exit 0
    fi
fi

# Track start time
START_TIME=$(date +%s)

# Run installation scripts
for component in "${COMPONENTS[@]}"; do
    case $component in
        nodejs)
            bash "$SCRIPT_DIR/01-install-nodejs.sh"
            ;;
        homenichat)
            bash "$SCRIPT_DIR/02-install-homenichat.sh"
            ;;
        asterisk)
            bash "$SCRIPT_DIR/03-install-asterisk.sh"
            ;;
        chan-quectel)
            bash "$SCRIPT_DIR/04-install-chan-quectel.sh"
            ;;
        configure-asterisk)
            bash "$SCRIPT_DIR/05-configure-asterisk.sh"
            ;;
        gammu)
            bash "$SCRIPT_DIR/06-install-gammu.sh"
            ;;
        services)
            bash "$SCRIPT_DIR/07-setup-services.sh"
            ;;
        *)
            log_warn "Unknown component: $component (skipping)"
            ;;
    esac
done

# Calculate duration
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))
MINUTES=$((DURATION / 60))
SECONDS=$((DURATION % 60))

log_separator
log_success "Installation completed in ${MINUTES}m ${SECONDS}s"
echo ""
log_info "Next steps:"
echo "  1. Access admin panel: http://$(get_ip):3001/admin"
echo "  2. Change the default password"
echo "  3. Configure your providers (WhatsApp, SMS, VoIP)"
echo ""
log_info "Documentation: https://github.com/elkir0/homenichat-serv"
echo ""
