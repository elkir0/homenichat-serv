#!/bin/bash
# Installation de Node.js 20 LTS
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/colors.sh"
source "$SCRIPT_DIR/lib/logging.sh"
source "$SCRIPT_DIR/lib/utils.sh"

NODE_VERSION="20"

log_header "Node.js Installation"

require_root

# Check if already installed with correct version
if command_exists node; then
    CURRENT_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [[ "$CURRENT_VERSION" -ge "$NODE_VERSION" ]]; then
        log_success "Node.js v$(node -v | cut -dv -f2) already installed (>= $NODE_VERSION required)"
        log_info "npm version: $(npm -v)"
        exit 0
    else
        log_warn "Node.js v$CURRENT_VERSION found, but v$NODE_VERSION+ required"
    fi
fi

log_info "Installing Node.js $NODE_VERSION LTS..."

# Detect package manager
if command_exists apt-get; then
    log_info "Using apt package manager"

    # Install prerequisites
    install_packages ca-certificates curl gnupg

    # Add NodeSource repository
    log_info "Adding NodeSource repository..."
    mkdir -p /etc/apt/keyrings

    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg

    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_VERSION}.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list

    # Update and install
    apt-get update >> "$LOG_FILE" 2>&1
    install_package nodejs

elif command_exists dnf; then
    log_info "Using dnf package manager"
    curl -fsSL https://rpm.nodesource.com/setup_${NODE_VERSION}.x | bash -
    dnf install -y nodejs >> "$LOG_FILE" 2>&1

elif command_exists yum; then
    log_info "Using yum package manager"
    curl -fsSL https://rpm.nodesource.com/setup_${NODE_VERSION}.x | bash -
    yum install -y nodejs >> "$LOG_FILE" 2>&1

else
    log_error "No supported package manager found (apt, dnf, yum)"
    exit 1
fi

# Verify installation
if ! command_exists node; then
    log_error "Node.js installation failed - 'node' command not found"
    exit 1
fi

if ! command_exists npm; then
    log_error "npm installation failed - 'npm' command not found"
    exit 1
fi

INSTALLED_NODE=$(node -v)
INSTALLED_NPM=$(npm -v)

log_success "Node.js ${INSTALLED_NODE} installed successfully"
log_success "npm v${INSTALLED_NPM} installed successfully"

# Configure npm for global packages (avoid sudo for npm install -g)
log_info "Configuring npm for global packages..."
npm config set prefix '/usr/local' 2>/dev/null || true

log_success "Node.js installation complete"
