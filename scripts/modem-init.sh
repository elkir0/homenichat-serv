#!/bin/bash
# modem-init.sh
# Unified modem initialization script for EC25 and SIM7600
#
# ARCHITECTURE (two-phase init):
#
# Phase 1 (BEFORE Asterisk) - homenichat-modem-init.service:
#   Sends AT+QAUDMOD=3 + AT+QPCMV=1,2 via serial port.
#   AT+QAUDMOD=3 causes USB re-enumeration (modem disconnects/reconnects).
#   This MUST happen before Asterisk takes control of the modem.
#   → Embedded in install.sh as homenichat-modem-init script.
#
# Phase 2 (AFTER Asterisk) - homenichat-audio-init.service:
#   THIS SCRIPT. Verifies VoLTE settings are applied, sends only
#   non-disruptive AT commands (echo cancellation, LTE lock).
#   Does NOT send AT+QAUDMOD=3 (would crash chan_quectel via USB reset).
#
# Modem detection:
# - EC25:    USB ID 2c7c:* (Quectel) → IchthysMaranatha fork, UAC mode
# - SIM7600: USB ID 1e0e:* (Simcom)  → RoEdAl fork @ 37b566f, TTY mode

set -e

ASTERISK_CMD="asterisk -rx"
LOG_PREFIX="[modem-init]"

log() {
    echo "$LOG_PREFIX $1"
    logger -t modem-init "$1" 2>/dev/null || true
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

# Wait for modem to be in "Free" state in chan_quectel
wait_for_modem() {
    local max_wait=60
    local waited=0

    log "Waiting for modem to appear in chan_quectel..."
    while [ $waited -lt $max_wait ]; do
        if $ASTERISK_CMD "quectel show devices" 2>/dev/null | grep -qE "Free|Ring|Dial"; then
            log "Modem detected in chan_quectel"
            return 0
        fi
        sleep 2
        waited=$((waited + 2))
    done
    log "WARNING: No modem detected after ${max_wait}s"
    return 1
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

# Initialize EC25 modem (post-Asterisk, non-disruptive commands only)
# NOTE: AT+QAUDMOD=3 and AT+QPCMV=1,2 are sent BEFORE Asterisk
# by homenichat-modem-init service via serial port (see install.sh).
# Sending AT+QAUDMOD=3 here would cause USB re-enumeration and crash chan_quectel!
init_ec25() {
    local modem=$1
    log "Initializing EC25 modem (post-Asterisk): $modem"

    # Verify that VoLTE UAC was configured by pre-Asterisk init
    local voice_status=$($ASTERISK_CMD "quectel show device state $modem" 2>/dev/null | grep "Voice" | awk '{print $NF}')
    if [ "$voice_status" = "Yes" ]; then
        log "  ✓ Voice: Yes (VoLTE UAC active - set by pre-Asterisk init)"
    else
        log "  WARNING: Voice: $voice_status - VoLTE UAC may not be configured"
        log "  AT+QAUDMOD=3 must be sent via serial BEFORE Asterisk starts"
        log "  Attempting recovery via serial port..."
        # Try to fix by sending via serial port directly
        # This is a fallback - the proper way is via homenichat-modem-init service
        if [ -e /dev/ttyUSB2 ]; then
            log "  Stopping Asterisk for modem reconfiguration..."
            systemctl stop asterisk 2>/dev/null || true
            sleep 2
            stty -F /dev/ttyUSB2 115200 raw -echo 2>/dev/null || true
            echo -e "AT+QAUDMOD=3\r" > /dev/ttyUSB2 2>/dev/null || true
            sleep 5  # Wait for USB re-enumeration
            # Wait for ports to come back
            for i in $(seq 1 15); do
                [ -e /dev/ttyUSB2 ] && break
                sleep 2
            done
            sleep 1
            stty -F /dev/ttyUSB2 115200 raw -echo 2>/dev/null || true
            echo -e "AT+QPCMV=1,2\r" > /dev/ttyUSB2 2>/dev/null || true
            sleep 2
            log "  Restarting Asterisk..."
            systemctl start asterisk 2>/dev/null || true
            sleep 8
            wait_for_asterisk
            wait_for_modem || true
            log "  Recovery attempt completed"
        else
            log "  ERROR: /dev/ttyUSB2 not found, cannot recover"
        fi
    fi

    # Non-disruptive commands only (these don't cause USB reset)

    # Echo Cancellation Enhanced
    log "  Enabling Echo Cancellation (AT+QEEC=1,1,1024)..."
    $ASTERISK_CMD "quectel cmd $modem AT+QEEC=1,1,1024" 2>/dev/null || true
    sleep 0.5

    # Verify LTE lock (prevent 3G CSFB which breaks VoLTE)
    log "  Verifying LTE-only mode..."
    $ASTERISK_CMD "quectel cmd $modem AT+QCFG=\"nwscanmode\",3" 2>/dev/null || true
    sleep 0.5

    # Enable IMS if not already
    $ASTERISK_CMD "quectel cmd $modem AT+QCFG=\"ims\",1" 2>/dev/null || true
    sleep 0.3

    log "  EC25 $modem post-init complete"
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
    log "=== Modem Audio Initialization (Phase 2: post-Asterisk) ==="

    # Wait for Asterisk
    wait_for_asterisk

    # Check if chan_quectel is loaded
    if ! $ASTERISK_CMD "quectel show devices" &>/dev/null; then
        log "chan_quectel not loaded, trying to load..."
        $ASTERISK_CMD "module load chan_quectel.so" 2>/dev/null || true
        sleep 2
    fi

    # Wait for modem to be ready
    wait_for_modem || exit 0

    # Detect modem type
    MODEM_TYPE=$(detect_modem_type)
    log "Detected modem type: $MODEM_TYPE"

    # Get list of connected modems (any name: modem-X, hni-X, quectel-X, etc.)
    MODEMS=$($ASTERISK_CMD "quectel show devices" 2>/dev/null | grep -vE "^(ID|$)" | grep -E "^\s*[a-zA-Z]" | awk '{print $1}' | head -5)

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
                log "Unknown modem type ($MODEM_TYPE), trying EC25 settings..."
                init_ec25 "$MODEM"
                ;;
        esac
    done

    log "=== Modem initialization complete ==="
}

main "$@"
