#!/bin/bash
# Détection du système d'exploitation et de l'architecture
# Ce script doit être sourcé, pas exécuté directement
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/colors.sh"
source "$SCRIPT_DIR/lib/logging.sh"
source "$SCRIPT_DIR/lib/utils.sh"

log_header "System Detection"

# Detect system
detect_system

log_info "Operating System: ${BOLD}${OS_ID}${NC}"
log_info "Version: ${BOLD}${OS_VERSION}${NC} (${OS_CODENAME})"
log_info "Architecture: ${BOLD}${ARCH}${NC} (${ARCH_TYPE})"

# Validate supported systems
SUPPORTED=true

case "$OS_ID" in
    debian)
        if [[ "$OS_VERSION" != "12" && "$OS_VERSION" != "13" ]]; then
            log_warn "Debian $OS_VERSION is not officially tested. Recommended: Debian 12 (Bookworm)"
            SUPPORTED=false
        fi
        ;;
    ubuntu)
        if [[ ! "$OS_VERSION" =~ ^(22|24) ]]; then
            log_warn "Ubuntu $OS_VERSION is not officially tested. Recommended: Ubuntu 22.04 or 24.04"
            SUPPORTED=false
        fi
        ;;
    raspbian)
        log_info "Raspberry Pi OS detected (based on Debian)"
        ;;
    *)
        log_warn "OS '$OS_ID' is not officially supported. Proceed with caution."
        SUPPORTED=false
        ;;
esac

case "$ARCH_TYPE" in
    amd64|arm64)
        log_success "Architecture $ARCH_TYPE is fully supported"
        ;;
    armhf)
        log_warn "32-bit ARM is deprecated. Consider upgrading to 64-bit OS."
        ;;
    *)
        log_error "Architecture $ARCH_TYPE is not supported"
        exit 1
        ;;
esac

# Check minimum requirements
log_info "Checking system requirements..."

# RAM check (minimum 1GB, recommended 2GB)
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TOTAL_RAM_MB=$((TOTAL_RAM_KB / 1024))

if [[ $TOTAL_RAM_MB -lt 1024 ]]; then
    log_error "Insufficient RAM: ${TOTAL_RAM_MB}MB (minimum: 1024MB)"
    exit 1
elif [[ $TOTAL_RAM_MB -lt 2048 ]]; then
    log_warn "Low RAM: ${TOTAL_RAM_MB}MB (recommended: 2048MB)"
else
    log_success "RAM: ${TOTAL_RAM_MB}MB"
fi

# Disk space check (minimum 2GB free in /opt)
FREE_SPACE_KB=$(df /opt 2>/dev/null | tail -1 | awk '{print $4}' || df / | tail -1 | awk '{print $4}')
FREE_SPACE_MB=$((FREE_SPACE_KB / 1024))

if [[ $FREE_SPACE_MB -lt 2048 ]]; then
    log_error "Insufficient disk space: ${FREE_SPACE_MB}MB free (minimum: 2048MB)"
    exit 1
else
    log_success "Disk space: ${FREE_SPACE_MB}MB free"
fi

# Internet connectivity
if check_internet; then
    log_success "Internet connectivity: OK"
else
    log_error "No internet connectivity. Please check your network."
    exit 1
fi

# Export variables for other scripts
export OS_ID OS_VERSION OS_CODENAME ARCH ARCH_TYPE
export HOMENICHAT_INSTALL_DIR="${HOMENICHAT_INSTALL_DIR:-/opt/homenichat}"
export HOMENICHAT_DATA_DIR="${HOMENICHAT_DATA_DIR:-/var/lib/homenichat}"
export HOMENICHAT_CONFIG_DIR="${HOMENICHAT_CONFIG_DIR:-/etc/homenichat}"
export HOMENICHAT_LOG_DIR="${HOMENICHAT_LOG_DIR:-/var/log/homenichat}"

log_success "System detection complete"
