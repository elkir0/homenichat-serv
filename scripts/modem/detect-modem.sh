#!/bin/bash
#
# Détection automatique des modems GSM
# Identifie le type de modem et configure automatiquement
#
set -euo pipefail

# Colors (inline for standalone usage)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'
CHECK="${GREEN}✓${NC}"
CROSS="${RED}✗${NC}"

echo -e "${BLUE}=== Modem Detection ===${NC}"
echo ""

# Known modems database
declare -A MODEMS=(
    ["1e0e:9001"]="SIM7600G-H|sim7600|4|16kHz"
    ["1e0e:9011"]="SIM7600E-H|sim7600|4|16kHz"
    ["2c7c:0125"]="EC25|ec25|1|8kHz"
    ["2c7c:0121"]="EC21|ec25|1|8kHz"
)

# Detect modems
echo "Scanning USB devices..."
FOUND_MODEMS=()

while IFS= read -r line; do
    for usb_id in "${!MODEMS[@]}"; do
        if echo "$line" | grep -q "${usb_id/:/ }"; then
            IFS='|' read -r name type audio_offset freq <<< "${MODEMS[$usb_id]}"
            FOUND_MODEMS+=("$usb_id|$name|$type|$audio_offset|$freq")
            echo -e "${CHECK} Found: ${GREEN}$name${NC} ($usb_id)"
        fi
    done
done < <(lsusb)

if [[ ${#FOUND_MODEMS[@]} -eq 0 ]]; then
    echo -e "${CROSS} No supported modems detected"
    echo ""
    echo "Supported modems:"
    for usb_id in "${!MODEMS[@]}"; do
        IFS='|' read -r name type audio_offset freq <<< "${MODEMS[$usb_id]}"
        echo "  - $name ($usb_id)"
    done
    exit 1
fi

echo ""

# Detect ports
echo "Detecting serial ports..."
PORTS=($(ls /dev/ttyUSB* 2>/dev/null || true))

if [[ ${#PORTS[@]} -eq 0 ]]; then
    echo -e "${CROSS} No ttyUSB ports found"
    echo ""
    echo "Make sure:"
    echo "  1. Modem is connected via USB"
    echo "  2. Using a powered USB hub (for Pi)"
    echo "  3. Driver is loaded: lsmod | grep option"
    exit 1
fi

echo -e "${CHECK} Found ${#PORTS[@]} serial ports: ${PORTS[*]}"
echo ""

# For each detected modem, configure
for modem_info in "${FOUND_MODEMS[@]}"; do
    IFS='|' read -r usb_id name type audio_offset freq <<< "$modem_info"

    echo -e "${BLUE}Configuring $name ($type)...${NC}"

    # Calculate ports
    # Usually: ttyUSB0 = debug, ttyUSB1 = NMEA, ttyUSB2 = AT, ttyUSB3 = PPP, ttyUSB4 = Audio (SIM7600)
    # For EC25: ttyUSB0 = DM, ttyUSB1 = Audio, ttyUSB2 = AT, ttyUSB3 = PPP

    DATA_PORT=""
    AUDIO_PORT=""

    # Find AT command port (usually ttyUSB2)
    for port in "${PORTS[@]}"; do
        # Quick check if port responds to AT
        if timeout 1 bash -c "echo -e 'AT\r' > $port && cat $port" 2>/dev/null | grep -q "OK"; then
            DATA_PORT="$port"
            break
        fi
    done

    # If AT detection failed, use default
    if [[ -z "$DATA_PORT" ]]; then
        DATA_PORT="/dev/ttyUSB2"
    fi

    # Calculate audio port based on modem type
    BASE_NUM=$(echo "$DATA_PORT" | grep -oP '\d+')
    AUDIO_NUM=$((BASE_NUM - 2 + audio_offset))
    AUDIO_PORT="/dev/ttyUSB$AUDIO_NUM"

    echo "  Data port:  $DATA_PORT"
    echo "  Audio port: $AUDIO_PORT"
    echo "  Sample rate: $freq"

    # Output configuration
    echo ""
    echo -e "${YELLOW}Asterisk quectel.conf entry:${NC}"
    echo ""
    echo "[quectel-$type]"
    echo "data = $DATA_PORT"
    echo "audio = $AUDIO_PORT"
    echo "context = from-gsm"
    echo "group = 0"

    if [[ "$type" == "sim7600" ]]; then
        echo "rxgain = 2"
        echo "txgain = 2"
        echo "slin16 = yes"
    else
        echo "rxgain = 3"
        echo "txgain = -5"
        echo "slin16 = no"
    fi

    echo ""

    # Ask to apply
    if [[ -t 0 ]]; then
        read -rp "Apply this configuration? [Y/n] " response
        if [[ -z "$response" || "$response" =~ ^[Yy] ]]; then
            CONF_FILE="/etc/asterisk/quectel.conf"

            if [[ -f "$CONF_FILE" ]]; then
                # Check if already configured
                if grep -q "\[quectel-$type\]" "$CONF_FILE"; then
                    echo "Configuration already exists in $CONF_FILE"
                    echo "Edit manually to update."
                else
                    # Append configuration
                    cat >> "$CONF_FILE" << EOF

[quectel-$type]
data = $DATA_PORT
audio = $AUDIO_PORT
context = from-gsm
group = 0
$(if [[ "$type" == "sim7600" ]]; then
    echo "rxgain = 2"
    echo "txgain = 2"
    echo "slin16 = yes"
else
    echo "rxgain = 3"
    echo "txgain = -5"
    echo "slin16 = no"
fi)
EOF
                    echo -e "${CHECK} Configuration added to $CONF_FILE"

                    # Reload Asterisk
                    if command -v asterisk &>/dev/null; then
                        echo "Reloading chan_quectel..."
                        asterisk -rx "module reload chan_quectel.so" 2>/dev/null || true
                        sleep 2
                        asterisk -rx "quectel show devices"
                    fi
                fi
            else
                echo -e "${CROSS} $CONF_FILE not found. Is Asterisk installed?"
            fi
        fi
    fi
done

echo ""
echo -e "${GREEN}Modem detection complete!${NC}"
