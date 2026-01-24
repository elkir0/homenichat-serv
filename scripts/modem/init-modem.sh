#!/bin/bash
#
# Initialisation du modem GSM après démarrage Asterisk
# Configure les paramètres audio et autres optimisations
#
set -euo pipefail

# Colors
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info() { echo -e "[INFO] $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

log_info "Initializing GSM modem..."

# Wait for Asterisk to be ready
MAX_WAIT=30
WAITED=0
while ! asterisk -rx "core show version" &>/dev/null; do
    if [[ $WAITED -ge $MAX_WAIT ]]; then
        log_error "Asterisk not responding after ${MAX_WAIT}s"
        exit 1
    fi
    sleep 1
    ((WAITED++))
done

log_success "Asterisk is running"

# Wait for modem to be detected
sleep 3

# Get list of modems
MODEMS=$(asterisk -rx "quectel show devices" 2>/dev/null | grep -E "^\w+-" | awk '{print $1}' || true)

if [[ -z "$MODEMS" ]]; then
    log_warn "No modems detected by chan_quectel"
    log_info "Check /etc/asterisk/quectel.conf configuration"
    exit 0
fi

# Initialize each modem
for modem in $MODEMS; do
    log_info "Initializing modem: $modem"

    # Detect modem type from name
    if echo "$modem" | grep -qi "sim7600"; then
        MODEM_TYPE="sim7600"
    elif echo "$modem" | grep -qi "ec25"; then
        MODEM_TYPE="ec25"
    else
        # Try to detect from AT response
        IMEI=$(asterisk -rx "quectel cmd $modem AT+GSN" 2>/dev/null | grep -oP '\d{15}' || true)
        if [[ -n "$IMEI" ]]; then
            # Check manufacturer
            MFR=$(asterisk -rx "quectel cmd $modem AT+CGMI" 2>/dev/null || true)
            if echo "$MFR" | grep -qi "simcom"; then
                MODEM_TYPE="sim7600"
            else
                MODEM_TYPE="ec25"
            fi
        else
            MODEM_TYPE="unknown"
        fi
    fi

    log_info "Detected type: $MODEM_TYPE"

    case "$MODEM_TYPE" in
        sim7600)
            log_info "Applying SIM7600 audio settings..."

            # Set 16kHz audio
            asterisk -rx "quectel cmd $modem AT+CPCMFRM=1" 2>/dev/null || true

            # Enable noise reduction
            asterisk -rx "quectel cmd $modem AT+CNMR=1" 2>/dev/null || true

            # Set audio mode to PCM
            asterisk -rx "quectel cmd $modem AT+CPCMREG=1" 2>/dev/null || true

            log_success "SIM7600 initialized"
            ;;

        ec25)
            log_info "Applying EC25 audio settings..."

            # Echo cancellation
            asterisk -rx "quectel cmd $modem AT+QEEC=1,1,1024" 2>/dev/null || true

            # Side tone detection
            asterisk -rx "quectel cmd $modem AT+QSIDET=1" 2>/dev/null || true

            # Audio mode PCM
            asterisk -rx "quectel cmd $modem AT+QAUDMOD=0" 2>/dev/null || true

            log_success "EC25 initialized"
            ;;

        *)
            log_warn "Unknown modem type, applying generic settings"
            ;;
    esac

    # Common settings for all modems

    # Enable caller ID
    asterisk -rx "quectel cmd $modem AT+CLIP=1" 2>/dev/null || true

    # Set SMS text mode
    asterisk -rx "quectel cmd $modem AT+CMGF=1" 2>/dev/null || true

    # Enable SMS notifications
    asterisk -rx "quectel cmd $modem AT+CNMI=2,1,0,0,0" 2>/dev/null || true

    # Check signal
    SIGNAL=$(asterisk -rx "quectel cmd $modem AT+CSQ" 2>/dev/null | grep -oP '\+CSQ: \K\d+' || echo "0")
    if [[ "$SIGNAL" -gt 0 && "$SIGNAL" -lt 32 ]]; then
        # Convert to percentage (0-31 maps to 0-100%)
        SIGNAL_PCT=$((SIGNAL * 100 / 31))
        log_success "Signal strength: ${SIGNAL_PCT}% ($SIGNAL/31)"
    else
        log_warn "No signal or unknown signal level"
    fi

    # Check network registration
    REG=$(asterisk -rx "quectel cmd $modem AT+CREG?" 2>/dev/null | grep -oP '\+CREG: \d+,\K\d+' || echo "0")
    case "$REG" in
        1) log_success "Network: Registered (home)" ;;
        5) log_success "Network: Registered (roaming)" ;;
        2) log_warn "Network: Searching..." ;;
        *) log_warn "Network: Not registered" ;;
    esac

    echo ""
done

# Show final status
log_info "Current modem status:"
asterisk -rx "quectel show devices" 2>/dev/null || true

log_success "Modem initialization complete"
