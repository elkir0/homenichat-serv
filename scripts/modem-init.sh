#!/bin/bash
# modem-init.sh
# Unified modem initialization script for EC25 and SIM7600
#
# Detects modem type and applies appropriate audio settings.
# Should be called after Asterisk starts (via systemd service).
#
# Modem detection:
# - EC25:    USB ID 2c7c:* (Quectel)
# - SIM7600: USB ID 1e0e:* (Simcom)

set -e

ASTERISK_CMD="asterisk -rx"
LOG_PREFIX="[modem-init]"

log() {
    echo "$LOG_PREFIX $1"
    logger -t modem-init "$1"
}

# Wait for Asterisk to be ready
wait_for_asterisk() {
    local max_wait=30
    local waited=0

    while ! $ASTERISK_CMD "core show version" &>/dev/null; do
        if [ $waited -ge $max_wait ]; then
            log "ERROR: Asterisk not ready after ${max_wait}s"
            exit 1
        fi
        sleep 1
        waited=$((waited + 1))
    done
    log "Asterisk is ready"
}

# Detect modem type from USB
detect_modem_type() {
    if lsusb 2>/dev/null | grep -q "2c7c:"; then
        echo "ec25"
    elif lsusb 2>/dev/null | grep -q "1e0e:"; then
        echo "sim7600"
    else
        echo "unknown"
    fi
}

# Initialize EC25 modem (IchthysMaranatha fork)
init_ec25() {
    local modem=$1
    log "Initializing EC25 modem: $modem"

    # Echo Cancellation Enhanced
    log "  Enabling Echo Cancellation (AT+QEEC=1,1,1024)..."
    $ASTERISK_CMD "quectel cmd $modem AT+QEEC=1,1,1024" 2>/dev/null || true
    sleep 0.5

    # Side Tone Detection
    log "  Enabling Side Tone Detection (AT+QSIDET=1)..."
    $ASTERISK_CMD "quectel cmd $modem AT+QSIDET=1" 2>/dev/null || true
    sleep 0.5

    # PCM Audio Mode (serial, not USB audio class)
    log "  Setting PCM Audio Mode (AT+QAUDMOD=0)..."
    $ASTERISK_CMD "quectel cmd $modem AT+QAUDMOD=0" 2>/dev/null || true
    sleep 0.3

    log "  EC25 $modem initialized"
}

# Initialize SIM7600 modem (RoEdAl fork)
init_sim7600() {
    local modem=$1
    log "Initializing SIM7600 modem: $modem"

    # Set PCM format to 16kHz (required for slin16=yes)
    log "  Setting PCM format to 16kHz (AT+CPCMFRM=1)..."
    $ASTERISK_CMD "quectel cmd $modem AT+CPCMFRM=1" 2>/dev/null || true
    sleep 0.5

    # Set microphone gain to minimum to prevent TX saturation
    log "  Setting mic gain to minimum (AT+CMICGAIN=0)..."
    $ASTERISK_CMD "quectel cmd $modem AT+CMICGAIN=0" 2>/dev/null || true
    sleep 0.3

    # Set output gain
    log "  Setting output gain (AT+COUTGAIN=5)..."
    $ASTERISK_CMD "quectel cmd $modem AT+COUTGAIN=5" 2>/dev/null || true
    sleep 0.3

    log "  SIM7600 $modem initialized"
}

# Main
main() {
    log "=== Modem Audio Initialization ==="

    # Wait for Asterisk
    wait_for_asterisk

    # Check if chan_quectel is loaded
    if ! $ASTERISK_CMD "quectel show devices" &>/dev/null; then
        log "chan_quectel not loaded, trying to load..."
        $ASTERISK_CMD "module load chan_quectel.so" 2>/dev/null || true
        sleep 2
    fi

    # Detect modem type
    MODEM_TYPE=$(detect_modem_type)
    log "Detected modem type: $MODEM_TYPE"

    # Get list of connected modems
    MODEMS=$($ASTERISK_CMD "quectel show devices" 2>/dev/null | grep -E "^\s*(modem-|quectel)" | awk '{print $1}' | head -5)

    if [ -z "$MODEMS" ]; then
        log "No modems found in chan_quectel"
        exit 0
    fi

    # Initialize each modem
    for MODEM in $MODEMS; do
        case $MODEM_TYPE in
            ec25)
                init_ec25 "$MODEM"
                ;;
            sim7600)
                init_sim7600 "$MODEM"
                ;;
            *)
                log "Unknown modem type, trying EC25 settings..."
                init_ec25 "$MODEM"
                ;;
        esac
    done

    log "=== Modem initialization complete ==="
}

main "$@"
