#!/bin/bash
# configure-gsm-audio.sh
# Configures optimal audio settings for SIM7600/EC25 GSM modems
#
# This script applies AT commands to prevent TX (uplink/microphone) saturation
# which is a common issue with SIM7600 modems.
#
# Run after Asterisk starts and modems are registered.

set -e

echo "=== Configuring GSM Modem Audio Settings ==="

# Wait for Asterisk to be ready
wait_for_asterisk() {
    local max_wait=30
    local count=0
    while ! asterisk -rx "core show version" &>/dev/null; do
        sleep 1
        count=$((count + 1))
        if [ $count -ge $max_wait ]; then
            echo "ERROR: Asterisk not responding after ${max_wait}s"
            exit 1
        fi
    done
}

# Get list of quectel devices
get_modems() {
    asterisk -rx "quectel show devices" 2>/dev/null | \
        grep -E "^[a-zA-Z]" | \
        grep -v "^ID" | \
        awk '{print $1}'
}

# Configure audio for a single modem
configure_modem_audio() {
    local modem="$1"
    echo "Configuring audio for $modem..."

    # Check if modem is connected
    local state=$(asterisk -rx "quectel show device state $modem" 2>/dev/null | grep "State" | awk '{print $2}')
    if [ "$state" != "Free" ] && [ "$state" != "Ring" ] && [ "$state" != "Incoming" ]; then
        echo "  Warning: $modem state is '$state', skipping"
        return 1
    fi

    # Apply AT commands for SIM7600 audio optimization
    # These prevent TX (microphone) saturation

    # 1. Set audio sample rate to 16kHz (required for slin16=yes)
    asterisk -rx "quectel cmd $modem AT+CPCMFRM=1" &>/dev/null || true

    # 2. Set microphone gain to minimum (0 = lowest, 7 = highest)
    asterisk -rx "quectel cmd $modem AT+CMICGAIN=0" &>/dev/null || true

    # 3. Set TX volume to reduced level (0x0200 = low, 0x2000 = medium)
    # Lower value = less saturation
    asterisk -rx "quectel cmd $modem AT+CTXVOL=0x0200" &>/dev/null || true

    # 4. Set speaker/RX gain to maximum for good incoming audio
    asterisk -rx "quectel cmd $modem AT+COUTGAIN=5" &>/dev/null || true

    echo "  Audio configured for $modem"
    return 0
}

# Main
echo "Waiting for Asterisk..."
wait_for_asterisk

echo "Finding GSM modems..."
MODEMS=$(get_modems)

if [ -z "$MODEMS" ]; then
    echo "No modems found. Make sure chan_quectel is loaded and modems are connected."
    exit 0
fi

echo "Found modems: $MODEMS"
echo ""

# Configure each modem
for modem in $MODEMS; do
    configure_modem_audio "$modem" || true
done

echo ""
echo "=== Audio Configuration Complete ==="
echo ""
echo "Current modem status:"
asterisk -rx "quectel show devices" 2>/dev/null

echo ""
echo "Note: If audio is still saturated, try:"
echo "  1. Lower txgain in quectel.conf (e.g., txgain=-18 or -20)"
echo "  2. Use AT+CTXVOL=0x0100 for even lower TX volume"
echo "  3. Check if the softphone/WebRTC client has input gain settings"
