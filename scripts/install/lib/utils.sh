#!/bin/bash
# Fonctions utilitaires communes
# Usage: source colors.sh and logging.sh first, then source this file

# Detect OS and architecture
detect_system() {
    # OS
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        OS_ID="$ID"
        OS_VERSION="$VERSION_ID"
        OS_CODENAME="${VERSION_CODENAME:-unknown}"
    else
        OS_ID="unknown"
        OS_VERSION="unknown"
        OS_CODENAME="unknown"
    fi

    # Architecture
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64) ARCH_TYPE="amd64" ;;
        aarch64) ARCH_TYPE="arm64" ;;
        armv7l) ARCH_TYPE="armhf" ;;
        *) ARCH_TYPE="$ARCH" ;;
    esac

    # Export for other scripts
    export OS_ID OS_VERSION OS_CODENAME ARCH ARCH_TYPE
}

# Check if running as root
require_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "This script must be run as root (use sudo)"
        exit 1
    fi
}

# Check if a command exists
command_exists() {
    command -v "$1" &>/dev/null
}

# Check if a package is installed (Debian/Ubuntu)
package_installed() {
    dpkg -l "$1" 2>/dev/null | grep -q "^ii"
}

# Install package if not already installed
install_package() {
    local package="$1"
    if package_installed "$package"; then
        log_debug "Package $package already installed"
        return 0
    fi

    log_info "Installing $package..."
    if apt-get install -y "$package" >> "$LOG_FILE" 2>&1; then
        log_success "Installed $package"
        return 0
    else
        log_error "Failed to install $package"
        return 1
    fi
}

# Install multiple packages
install_packages() {
    local packages=("$@")

    log_info "Installing packages: ${packages[*]}"
    apt-get install -y "${packages[@]}" >> "$LOG_FILE" 2>&1
}

# Download file with retry
download_file() {
    local url="$1"
    local dest="$2"
    local retries="${3:-3}"

    for ((i=1; i<=retries; i++)); do
        if curl -fsSL "$url" -o "$dest"; then
            return 0
        fi
        log_warn "Download attempt $i/$retries failed, retrying..."
        sleep 2
    done

    log_error "Failed to download $url after $retries attempts"
    return 1
}

# Create directory if it doesn't exist
ensure_dir() {
    local dir="$1"
    local owner="${2:-}"

    if [[ ! -d "$dir" ]]; then
        mkdir -p "$dir"
        log_debug "Created directory: $dir"
    fi

    if [[ -n "$owner" ]]; then
        chown "$owner" "$dir"
    fi
}

# Backup a file before modifying
backup_file() {
    local file="$1"
    if [[ -f "$file" ]]; then
        local backup="${file}.bak.$(date +%Y%m%d%H%M%S)"
        cp "$file" "$backup"
        log_debug "Backed up $file to $backup"
    fi
}

# Check if a service is running
service_running() {
    local service="$1"
    systemctl is-active --quiet "$service"
}

# Enable and start a service
enable_service() {
    local service="$1"
    systemctl enable "$service" >> "$LOG_FILE" 2>&1
    systemctl start "$service" >> "$LOG_FILE" 2>&1
}

# Reload a service
reload_service() {
    local service="$1"
    systemctl reload "$service" >> "$LOG_FILE" 2>&1 || systemctl restart "$service" >> "$LOG_FILE" 2>&1
}

# Wait for a condition with timeout
wait_for() {
    local condition="$1"
    local timeout="${2:-30}"
    local interval="${3:-1}"

    local elapsed=0
    while ! eval "$condition"; do
        if [[ $elapsed -ge $timeout ]]; then
            return 1
        fi
        sleep "$interval"
        ((elapsed += interval))
    done
    return 0
}

# Generate a random string
random_string() {
    local length="${1:-32}"
    head -c 256 /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c "$length"
}

# Generate a random password with special chars
random_password() {
    local length="${1:-16}"
    head -c 256 /dev/urandom | tr -dc 'a-zA-Z0-9!@#$%^&*' | head -c "$length"
}

# Ask yes/no question (default yes)
confirm() {
    local message="$1"
    local default="${2:-y}"

    if [[ "$default" == "y" ]]; then
        read -rp "$message [Y/n] " response
        [[ -z "$response" || "$response" =~ ^[Yy] ]]
    else
        read -rp "$message [y/N] " response
        [[ "$response" =~ ^[Yy] ]]
    fi
}

# Get IP address
get_ip() {
    hostname -I | awk '{print $1}'
}

# Check internet connectivity
check_internet() {
    curl -s --connect-timeout 5 https://www.google.com > /dev/null 2>&1
}

# Update apt cache if older than 1 hour
update_apt_cache() {
    local cache_file="/var/cache/apt/pkgcache.bin"
    local max_age=3600  # 1 hour

    if [[ ! -f "$cache_file" ]] || [[ $(( $(date +%s) - $(stat -c %Y "$cache_file") )) -gt $max_age ]]; then
        log_info "Updating package cache..."
        apt-get update >> "$LOG_FILE" 2>&1
    else
        log_debug "Package cache is fresh, skipping update"
    fi
}
