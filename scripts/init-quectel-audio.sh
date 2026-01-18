#!/bin/bash
# init-quectel-audio.sh
# Initializes audio parameters for SIM7600/Quectel modems
#
# This script should be executed after Asterisk starts to configure
# optimal audio settings for WebRTC ↔ GSM bridging.
#
# AT Commands explanation:
# - AT+CPCMFRM=1  : Set PCM format to 16kHz (required for SIM7600 slin16)
# - AT+CMICGAIN=0 : Set microphone gain to minimum (prevents TX saturation)
# - AT+COUTGAIN=5 : Set output gain to maximum (5) for RX clarity
# - AT+CTXVOL=0x2000 : Set TX volume to ~12% (prevents saturation)

ASTERISK_CMD="asterisk -rx"

# Check if Asterisk is running
if ! $ASTERISK_CMD "core show version" &>/dev/null; then
    echo "ERROR: Asterisk is not running"
    exit 1
fi

# Check if chan_quectel is loaded
if ! $ASTERISK_CMD "quectel show devices" &>/dev/null; then
    echo "ERROR: chan_quectel module not loaded"
    exit 1
fi

# Get list of connected modems
MODEMS=$($ASTERISK_CMD "quectel show devices" 2>/dev/null | grep -E "^\s*modem-" | awk '{print $1}')

if [ -z "$MODEMS" ]; then
    echo "WARNING: No modems found"
    exit 0
fi

echo "=== Initializing Quectel/SIM7600 Audio Settings ==="

for MODEM in $MODEMS; do
    echo ""
    echo "Configuring $MODEM..."

    # Set PCM format to 16kHz (required for SIM7600 with slin16=yes)
    echo "  Setting PCM format to 16kHz (AT+CPCMFRM=1)..."
    $ASTERISK_CMD "quectel cmd $MODEM AT+CPCMFRM=1" 2>/dev/null
    sleep 0.3

    # Set microphone gain to minimum (0) to prevent TX saturation
    echo "  Setting mic gain to minimum (AT+CMICGAIN=0)..."
    $ASTERISK_CMD "quectel cmd $MODEM AT+CMICGAIN=0" 2>/dev/null
    sleep 0.3

    # Set output gain to maximum (5) for RX clarity
    echo "  Setting output gain to maximum (AT+COUTGAIN=5)..."
    $ASTERISK_CMD "quectel cmd $MODEM AT+COUTGAIN=5" 2>/dev/null
    sleep 0.3

    # Set TX volume to ~12% (0x2000 out of 0xFFFF)
    echo "  Setting TX volume to 12% (AT+CTXVOL=0x2000)..."
    $ASTERISK_CMD "quectel cmd $MODEM AT+CTXVOL=0x2000" 2>/dev/null
    sleep 0.3

    echo "  $MODEM configured successfully"
done

echo ""
echo "=== Audio initialization complete ==="
echo ""
echo "Recommended quectel.conf settings for each modem:"
echo "  slin16=yes     ; Required for SIM7600"
echo "  txgain=-18     ; TX attenuation (-18 to -30)"
echo "  rxgain=-5      ; RX volume"
