#!/bin/bash
# configure-asterisk-webrtc.sh
# Configures Asterisk for WebRTC support (SIP.js, mobile apps)
#
# This script:
# 1. Creates SSL certificates for WSS
# 2. Configures HTTP/WebSocket server
# 3. Configures PJSIP with WebRTC transport
# 4. Sets up basic dialplan for WebRTC calls

set -e

ASTERISK_CONFIG="/etc/asterisk"
HOMENICHAT_DIR="${HOMENICHAT_DIR:-/opt/homenichat}"

echo "=== Configuring Asterisk for WebRTC ==="

# Check if Asterisk is installed
if ! command -v asterisk &> /dev/null; then
    echo "ERROR: Asterisk is not installed"
    exit 1
fi

# 1. Create SSL certificates
echo "Creating SSL certificates..."
mkdir -p "$ASTERISK_CONFIG/keys"
if [ ! -f "$ASTERISK_CONFIG/keys/asterisk.pem" ]; then
    # Get server IP for certificate CN
    SERVER_IP=$(hostname -I | awk '{print $1}')
    openssl req -new -x509 -days 365 -nodes \
        -out "$ASTERISK_CONFIG/keys/asterisk.pem" \
        -keyout "$ASTERISK_CONFIG/keys/asterisk.key" \
        -subj "/CN=${SERVER_IP}/O=Homenichat/C=FR" 2>/dev/null
    chmod 600 "$ASTERISK_CONFIG/keys/"*
    echo "  SSL certificate created for $SERVER_IP"
else
    echo "  SSL certificate already exists"
fi

# 2. Configure HTTP server
echo "Configuring HTTP/WebSocket server..."
cat > "$ASTERISK_CONFIG/http.conf" << 'EOF'
[general]
servername=Asterisk
enabled=yes
bindaddr=0.0.0.0
bindport=8088
tlsenable=yes
tlsbindaddr=0.0.0.0:8089
tlscertfile=/etc/asterisk/keys/asterisk.pem
tlsprivatekey=/etc/asterisk/keys/asterisk.key
EOF
echo "  http.conf configured"

# 3. Configure PJSIP WebRTC transport
echo "Configuring PJSIP WebRTC transport..."
if [ -f "$HOMENICHAT_DIR/config/asterisk/pjsip_homenichat.conf" ]; then
    cp "$HOMENICHAT_DIR/config/asterisk/pjsip_homenichat.conf" "$ASTERISK_CONFIG/"
else
    cat > "$ASTERISK_CONFIG/pjsip_homenichat.conf" << 'EOF'
; Homenichat PJSIP WebRTC Configuration

[transport-wss]
type=transport
protocol=wss
bind=0.0.0.0:8089
cert_file=/etc/asterisk/keys/asterisk.pem
priv_key_file=/etc/asterisk/keys/asterisk.key
method=tlsv1_2

[transport-ws]
type=transport
protocol=ws
bind=0.0.0.0:8088

; Template for WebRTC extensions
; NOTE: Using G.711 (ulaw/alaw) instead of opus for better compatibility
; with GSM modems (chan_quectel). Opus requires additional codec modules.
[webrtc-endpoint](!)
type=endpoint
context=from-internal
disallow=all
allow=ulaw
allow=alaw
allow=g722
transport=transport-ws
webrtc=yes
dtls_auto_generate_cert=yes
ice_support=yes
media_encryption=dtls
media_use_received_transport=yes
rtcp_mux=yes
direct_media=no
EOF
fi

# Add include to pjsip.conf if not present
if ! grep -q "pjsip_homenichat.conf" "$ASTERISK_CONFIG/pjsip.conf" 2>/dev/null; then
    echo "" >> "$ASTERISK_CONFIG/pjsip.conf"
    echo "; Homenichat WebRTC config" >> "$ASTERISK_CONFIG/pjsip.conf"
    echo "#include pjsip_homenichat.conf" >> "$ASTERISK_CONFIG/pjsip.conf"
fi
echo "  pjsip_homenichat.conf configured"

# 4. Configure dialplan
echo "Configuring dialplan..."
if [ -f "$HOMENICHAT_DIR/config/asterisk/extensions_homenichat.conf" ]; then
    cp "$HOMENICHAT_DIR/config/asterisk/extensions_homenichat.conf" "$ASTERISK_CONFIG/"
else
    cat > "$ASTERISK_CONFIG/extensions_homenichat.conf" << 'EOF'
; Homenichat Custom Dialplan

[from-internal]
exten => _1XXX,1,NoOp(Internal call to ${EXTEN})
 same => n,Dial(PJSIP/${EXTEN},30)
 same => n,Hangup()

exten => _06XXXXXXXX,1,NoOp(Outbound mobile to ${EXTEN})
 same => n,Dial(Quectel/modem-1/${EXTEN},120,g)
 same => n,Hangup()

exten => _07XXXXXXXX,1,NoOp(Outbound mobile to ${EXTEN})
 same => n,Dial(Quectel/modem-1/${EXTEN},120,g)
 same => n,Hangup()

exten => 600,1,NoOp(Echo test)
 same => n,Answer()
 same => n,Echo()
 same => n,Hangup()

exten => i,1,NoOp(Invalid extension)
 same => n,Playback(invalid)
 same => n,Hangup()

[from-gsm]
exten => s,1,NoOp(Incoming GSM call)
 same => n,Dial(PJSIP/1000,30)
 same => n,Hangup()
EOF
fi

# Add include to extensions.conf if not present
if ! grep -q "extensions_homenichat.conf" "$ASTERISK_CONFIG/extensions.conf" 2>/dev/null; then
    echo "" >> "$ASTERISK_CONFIG/extensions.conf"
    echo "; Homenichat dialplan" >> "$ASTERISK_CONFIG/extensions.conf"
    echo "#include extensions_homenichat.conf" >> "$ASTERISK_CONFIG/extensions.conf"
fi
echo "  extensions_homenichat.conf configured"

# 5. Reload Asterisk
echo "Reloading Asterisk configuration..."
asterisk -rx "module reload res_pjsip.so" 2>/dev/null || true
asterisk -rx "dialplan reload" 2>/dev/null || true
asterisk -rx "core reload" 2>/dev/null || true

# 6. Verify configuration
echo ""
echo "=== Verification ==="
HTTP_STATUS=$(asterisk -rx "http show status" 2>/dev/null | grep -c "Server Enabled" || echo "0")
if [ "$HTTP_STATUS" -gt 0 ]; then
    echo "✓ HTTP server enabled"
    asterisk -rx "http show status" 2>/dev/null | grep -E "Enabled|Bound"
else
    echo "✗ HTTP server not enabled"
fi

PJSIP_STATUS=$(asterisk -rx "pjsip show transports" 2>/dev/null | grep -c "transport-ws" || echo "0")
if [ "$PJSIP_STATUS" -gt 0 ]; then
    echo "✓ WebSocket transport configured"
else
    echo "✗ WebSocket transport not found"
fi

echo ""
echo "=== Asterisk WebRTC Configuration Complete ==="
echo "WebSocket endpoints:"
echo "  ws://$(hostname -I | awk '{print $1}'):8088/ws   (non-SSL)"
echo "  wss://$(hostname -I | awk '{print $1}'):8089/ws  (SSL)"
