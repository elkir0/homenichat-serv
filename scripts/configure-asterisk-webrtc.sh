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
; IMPORTANT: AOR section name MUST match the endpoint/username!
; See docs/WEBRTC-VOIP-CONFIG.md for detailed configuration guide.

; =============================================================================
; TRANSPORTS
; =============================================================================
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

; =============================================================================
; DEFAULT EXTENSION: 1001 (Homenichat WebRTC)
; =============================================================================
; Each extension needs 3 sections:
; - endpoint: [XXXX] type=endpoint
; - auth: [XXXX-auth] type=auth
; - aor: [XXXX] type=aor (CRITICAL: SAME NAME as endpoint!)

[1001]
type=endpoint
context=from-internal
disallow=all
allow=opus
allow=ulaw
allow=alaw
transport=transport-ws
webrtc=yes
auth=1001-auth
aors=1001
direct_media=no
dtmf_mode=rfc4733
identify_by=username
callerid="Homenichat" <1001>

[1001-auth]
type=auth
auth_type=userpass
username=1001
password=homenichat1001

[1001]
type=aor
max_contacts=5
remove_existing=yes

; =============================================================================
; ADDITIONAL EXTENSIONS (uncomment and customize as needed)
; =============================================================================
; To add more extensions, copy the 3-section pattern above.
; Remember: AOR section name MUST match the extension number!

;[1002]
;type=endpoint
;context=from-internal
;disallow=all
;allow=opus,ulaw,alaw
;transport=transport-ws
;webrtc=yes
;auth=1002-auth
;aors=1002
;direct_media=no
;dtmf_mode=rfc4733
;identify_by=username

;[1002-auth]
;type=auth
;auth_type=userpass
;username=1002
;password=changeme

;[1002]
;type=aor
;max_contacts=5
;remove_existing=yes

; Include dynamically generated extensions (managed by Homenichat)
#tryinclude pjsip_extensions_dynamic.conf
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

# 5. Install additional codecs (opus, etc.)
echo "Installing audio codecs..."
SCRIPT_DIR="$(dirname "$0")"
if [ -f "$SCRIPT_DIR/install-asterisk-codecs.sh" ]; then
    bash "$SCRIPT_DIR/install-asterisk-codecs.sh" || echo "  Codec installation skipped (non-fatal)"
elif [ -f "$HOMENICHAT_DIR/scripts/install-asterisk-codecs.sh" ]; then
    bash "$HOMENICHAT_DIR/scripts/install-asterisk-codecs.sh" || echo "  Codec installation skipped (non-fatal)"
else
    echo "  Codec installation script not found, skipping"
fi

# 6. Reload Asterisk
echo "Reloading Asterisk configuration..."
asterisk -rx "module reload res_pjsip.so" 2>/dev/null || true
asterisk -rx "dialplan reload" 2>/dev/null || true
asterisk -rx "core reload" 2>/dev/null || true

# 7. Verify configuration
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

OPUS_STATUS=$(asterisk -rx "core show codecs audio" 2>/dev/null | grep -c "opus" || echo "0")
if [ "$OPUS_STATUS" -gt 0 ]; then
    echo "✓ Opus codec available"
else
    echo "⚠ Opus codec not available (will use G.711 fallback)"
fi

echo ""
echo "=== Asterisk WebRTC Configuration Complete ==="
echo "WebSocket endpoints:"
echo "  ws://$(hostname -I | awk '{print $1}'):8088/ws   (non-SSL)"
echo "  wss://$(hostname -I | awk '{print $1}'):8089/ws  (SSL)"
echo ""
echo "Supported codecs for WebRTC:"
asterisk -rx "core show codecs audio" 2>/dev/null | grep -E "opus|g722|ulaw|alaw" | head -5
