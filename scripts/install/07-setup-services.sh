#!/bin/bash
# Configuration des services systemd pour Homenichat
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/colors.sh"
source "$SCRIPT_DIR/lib/logging.sh"
source "$SCRIPT_DIR/lib/utils.sh"

INSTALL_DIR="${HOMENICHAT_INSTALL_DIR:-/opt/homenichat}"
CONFIG_DIR="${HOMENICHAT_CONFIG_DIR:-/etc/homenichat}"
LOG_DIR="${HOMENICHAT_LOG_DIR:-/var/log/homenichat}"

log_header "Service Configuration"

require_root

# Create homenichat systemd service
log_info "Creating Homenichat systemd service..."

cat > /etc/systemd/system/homenichat.service << EOF
[Unit]
Description=Homenichat Unified Communications Server
Documentation=https://github.com/elkir0/homenichat-serv
After=network.target asterisk.service
Wants=asterisk.service

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$CONFIG_DIR/.env
ExecStart=/usr/bin/node $INSTALL_DIR/server.js
Restart=always
RestartSec=10
StandardOutput=append:$LOG_DIR/output.log
StandardError=append:$LOG_DIR/error.log

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$LOG_DIR /var/lib/homenichat
PrivateTmp=true

# Resource limits
LimitNOFILE=65535
MemoryMax=1G

[Install]
WantedBy=multi-user.target
EOF

log_success "Created homenichat.service"

# Create modem initialization service
log_info "Creating modem initialization service..."

cat > /etc/systemd/system/homenichat-modem.service << EOF
[Unit]
Description=Homenichat Modem Initialization
After=asterisk.service homenichat.service
Wants=asterisk.service

[Service]
Type=oneshot
ExecStart=$INSTALL_DIR/scripts/modem/init-modem.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

log_success "Created homenichat-modem.service"

# Create log rotation
log_info "Configuring log rotation..."

cat > /etc/logrotate.d/homenichat << EOF
$LOG_DIR/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 root root
    sharedscripts
    postrotate
        systemctl reload homenichat >/dev/null 2>&1 || true
    endscript
}
EOF

log_success "Log rotation configured"

# Create log directory
ensure_dir "$LOG_DIR"
touch "$LOG_DIR/output.log"
touch "$LOG_DIR/error.log"
chmod 640 "$LOG_DIR"/*.log

# Reload systemd
log_info "Reloading systemd..."
systemctl daemon-reload

# Enable services
log_info "Enabling services..."
systemctl enable homenichat >> "$LOG_FILE" 2>&1

# Start Homenichat
log_info "Starting Homenichat..."
if systemctl start homenichat; then
    sleep 3
    if systemctl is-active --quiet homenichat; then
        log_success "Homenichat started successfully"
    else
        log_error "Homenichat failed to start. Check logs:"
        log_error "  journalctl -u homenichat -f"
        log_error "  tail -f $LOG_DIR/error.log"
        exit 1
    fi
else
    log_error "Failed to start Homenichat"
    exit 1
fi

# Show status
log_info "Service status:"
echo ""
systemctl status homenichat --no-pager | head -15

# Show access info
log_separator
log_success "Installation complete!"
echo ""
log_info "Access Homenichat:"
IP=$(get_ip)
log_info "  Admin UI: http://$IP:3001/admin"
log_info "  API: http://$IP:3001/api"
echo ""
log_info "Default credentials:"
log_info "  Username: admin"
if [[ -f "$CONFIG_DIR/.env" ]]; then
    ADMIN_PASS=$(grep ADMIN_DEFAULT_PASSWORD "$CONFIG_DIR/.env" | cut -d= -f2)
    log_info "  Password: $ADMIN_PASS"
fi
echo ""
log_info "Useful commands:"
log_info "  sudo systemctl status homenichat    # Check status"
log_info "  sudo journalctl -u homenichat -f    # View logs"
log_info "  sudo systemctl restart homenichat   # Restart"
echo ""
log_warn "Change the default password after first login!"
