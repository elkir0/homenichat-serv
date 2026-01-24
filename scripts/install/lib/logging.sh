#!/bin/bash
# Fonctions de logging standardisées
# Usage: source colors.sh first, then source this file

# Log file (can be overridden)
LOG_FILE="${LOG_FILE:-/var/log/homenichat-install.log}"

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true

# Timestamp for logs
_timestamp() {
    date '+%Y-%m-%d %H:%M:%S'
}

# Log to both console and file
_log() {
    local level="$1"
    local message="$2"
    local timestamp=$(_timestamp)

    # Log to file (plain text)
    echo "[$timestamp] [$level] $message" >> "$LOG_FILE" 2>/dev/null || true
}

# Info message (blue)
log_info() {
    local message="$1"
    echo -e "${INFO} ${message}"
    _log "INFO" "$message"
}

# Success message (green with checkmark)
log_success() {
    local message="$1"
    echo -e "${CHECK} ${GREEN}${message}${NC}"
    _log "SUCCESS" "$message"
}

# Warning message (yellow)
log_warn() {
    local message="$1"
    echo -e "${WARN} ${YELLOW}${message}${NC}"
    _log "WARN" "$message"
}

# Error message (red with cross)
log_error() {
    local message="$1"
    echo -e "${CROSS} ${RED}${message}${NC}" >&2
    _log "ERROR" "$message"
}

# Step message (for installation steps)
log_step() {
    local step="$1"
    local message="$2"
    echo -e "\n${BOLD_BLUE}[$step]${NC} ${BOLD}${message}${NC}"
    _log "STEP" "[$step] $message"
}

# Debug message (only if DEBUG=1)
log_debug() {
    if [[ "${DEBUG:-0}" == "1" ]]; then
        local message="$1"
        echo -e "${PURPLE}[DEBUG]${NC} ${message}"
        _log "DEBUG" "$message"
    fi
}

# Command execution with logging
run_cmd() {
    local cmd="$1"
    local description="${2:-$cmd}"

    log_debug "Running: $cmd"

    if eval "$cmd" >> "$LOG_FILE" 2>&1; then
        log_debug "Command succeeded: $description"
        return 0
    else
        local exit_code=$?
        log_error "Command failed: $description (exit code: $exit_code)"
        return $exit_code
    fi
}

# Print a separator line
log_separator() {
    echo -e "${CYAN}────────────────────────────────────────────────────────────${NC}"
}

# Print header for a section
log_header() {
    local title="$1"
    echo ""
    log_separator
    echo -e "${BOLD_CYAN}  ${title}${NC}"
    log_separator
    _log "HEADER" "$title"
}
