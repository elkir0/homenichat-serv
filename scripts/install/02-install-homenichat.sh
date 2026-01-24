#!/bin/bash
# Installation de Homenichat-Serv
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/colors.sh"
source "$SCRIPT_DIR/lib/logging.sh"
source "$SCRIPT_DIR/lib/utils.sh"

# Configuration
REPO_URL="${HOMENICHAT_REPO_URL:-https://github.com/elkir0/homenichat-serv.git}"
BRANCH="${HOMENICHAT_BRANCH:-main}"
INSTALL_DIR="${HOMENICHAT_INSTALL_DIR:-/opt/homenichat}"
DATA_DIR="${HOMENICHAT_DATA_DIR:-/var/lib/homenichat}"
CONFIG_DIR="${HOMENICHAT_CONFIG_DIR:-/etc/homenichat}"
LOG_DIR="${HOMENICHAT_LOG_DIR:-/var/log/homenichat}"

log_header "Homenichat-Serv Installation"

require_root

# Create directories
log_info "Creating directories..."
ensure_dir "$INSTALL_DIR"
ensure_dir "$DATA_DIR"
ensure_dir "$CONFIG_DIR"
ensure_dir "$LOG_DIR"
ensure_dir "$DATA_DIR/sessions"
ensure_dir "$DATA_DIR/media"

# Install git if needed
install_package git

# Clone or update repository
if [[ -d "$INSTALL_DIR/.git" ]]; then
    log_info "Updating existing installation..."
    cd "$INSTALL_DIR"

    # Stash any local changes
    git stash >> "$LOG_FILE" 2>&1 || true

    # Pull latest
    git fetch origin >> "$LOG_FILE" 2>&1
    git checkout "$BRANCH" >> "$LOG_FILE" 2>&1
    git pull origin "$BRANCH" >> "$LOG_FILE" 2>&1

    log_success "Repository updated to latest $BRANCH"
else
    log_info "Cloning Homenichat-Serv from $REPO_URL..."

    # Remove directory if it exists but is not a git repo
    [[ -d "$INSTALL_DIR" ]] && rm -rf "$INSTALL_DIR"

    git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR" >> "$LOG_FILE" 2>&1

    log_success "Repository cloned successfully"
fi

cd "$INSTALL_DIR"

# Install Node.js dependencies
log_info "Installing Node.js dependencies..."
npm ci --production >> "$LOG_FILE" 2>&1 || npm install --production >> "$LOG_FILE" 2>&1

log_success "Dependencies installed"

# Build admin UI if exists
if [[ -d "$INSTALL_DIR/admin" && -f "$INSTALL_DIR/admin/package.json" ]]; then
    log_info "Building admin UI..."
    cd "$INSTALL_DIR/admin"

    npm ci >> "$LOG_FILE" 2>&1 || npm install >> "$LOG_FILE" 2>&1
    npm run build >> "$LOG_FILE" 2>&1

    log_success "Admin UI built"
    cd "$INSTALL_DIR"
fi

# Create default configuration if not exists
if [[ ! -f "$CONFIG_DIR/.env" ]]; then
    log_info "Creating default configuration..."

    JWT_SECRET=$(random_string 64)
    SESSION_SECRET=$(random_string 64)
    ADMIN_PASSWORD=$(random_password 12)

    cat > "$CONFIG_DIR/.env" << EOF
# Homenichat-Serv Configuration
# Generated on $(date)

NODE_ENV=production
PORT=3001

# Data directories
DATA_DIR=$DATA_DIR
DB_PATH=$DATA_DIR/homenichat.db

# Security
JWT_SECRET=$JWT_SECRET
SESSION_SECRET=$SESSION_SECRET

# Default admin password (change after first login!)
ADMIN_DEFAULT_PASSWORD=$ADMIN_PASSWORD

# Logging
LOG_LEVEL=info
LOG_DIR=$LOG_DIR
EOF

    chmod 600 "$CONFIG_DIR/.env"
    log_success "Configuration created at $CONFIG_DIR/.env"
    log_warn "Default admin password: $ADMIN_PASSWORD (change after first login!)"
else
    log_info "Configuration already exists at $CONFIG_DIR/.env"
fi

# Create symlink for .env if not exists
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
    ln -sf "$CONFIG_DIR/.env" "$INSTALL_DIR/.env"
fi

# Copy providers.yaml if not exists
if [[ ! -f "$CONFIG_DIR/providers.yaml" && -f "$INSTALL_DIR/config/providers.yaml" ]]; then
    cp "$INSTALL_DIR/config/providers.yaml" "$CONFIG_DIR/providers.yaml"
    log_info "Copied default providers.yaml to $CONFIG_DIR/"
fi

# Set permissions
log_info "Setting permissions..."
chown -R root:root "$INSTALL_DIR"
chmod -R 755 "$INSTALL_DIR"
chown -R root:root "$DATA_DIR"
chmod -R 755 "$DATA_DIR"
chmod 700 "$DATA_DIR/sessions"

log_success "Homenichat-Serv installation complete"
log_info "Install directory: $INSTALL_DIR"
log_info "Data directory: $DATA_DIR"
log_info "Config directory: $CONFIG_DIR"
