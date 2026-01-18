#!/bin/bash
# install-asterisk-codecs.sh
# Installs common audio codecs for Asterisk including Opus for WebRTC compatibility
#
# Supported codecs:
# - Opus (WebRTC default)
# - G.722 (HD audio)
# - G.729 (low bandwidth, may require license)
# - Speex (legacy)

set -e

echo "=== Installing Asterisk Audio Codecs ==="

# Detect architecture
ARCH=$(uname -m)
echo "Architecture: $ARCH"

# Detect Asterisk version
if command -v asterisk &> /dev/null; then
    AST_VERSION=$(asterisk -V | grep -oP 'Asterisk \K[0-9]+' | head -1)
    AST_FULL_VERSION=$(asterisk -V | grep -oP 'Asterisk \K[0-9.]+')
    echo "Asterisk version: $AST_FULL_VERSION (major: $AST_VERSION)"
else
    echo "ERROR: Asterisk is not installed"
    exit 1
fi

# Detect module directory
if [ -d "/usr/lib/asterisk/modules" ]; then
    MODULE_DIR="/usr/lib/asterisk/modules"
elif [ -d "/usr/lib64/asterisk/modules" ]; then
    MODULE_DIR="/usr/lib64/asterisk/modules"
else
    MODULE_DIR=$(asterisk -rx "core show settings" 2>/dev/null | grep "Module directory" | awk '{print $NF}')
fi
echo "Module directory: $MODULE_DIR"

# ============================================
# Method 1: Try Debian package (simplest)
# ============================================
install_debian_opus() {
    echo ""
    echo "=== Method 1: Debian asterisk-opus package ==="
    
    if apt-cache show asterisk-opus &>/dev/null; then
        echo "Installing asterisk-opus from Debian repos..."
        apt-get update -qq
        apt-get install -y asterisk-opus
        return 0
    else
        echo "asterisk-opus not available in repos"
        return 1
    fi
}

# ============================================
# Method 2: Digium/Sangoma binary codec
# ============================================
install_digium_opus() {
    echo ""
    echo "=== Method 2: Digium binary codec ==="
    
    if [ "$ARCH" != "x86_64" ]; then
        echo "Digium binary only available for x86_64, skipping..."
        return 1
    fi
    
    # Digium codec download URL pattern
    # https://downloads.digium.com/pub/telephony/codec_opus/
    DIGIUM_URL="https://downloads.digium.com/pub/telephony/codec_opus"
    
    # Try to find matching version
    CODEC_TAR="codec_opus-${AST_VERSION}.0_current-x86_64.tar.gz"
    DOWNLOAD_URL="${DIGIUM_URL}/asterisk-${AST_VERSION}.0/x86-64/${CODEC_TAR}"
    
    echo "Trying: $DOWNLOAD_URL"
    
    TEMP_DIR=$(mktemp -d)
    cd "$TEMP_DIR"
    
    if wget -q --spider "$DOWNLOAD_URL" 2>/dev/null; then
        wget -q "$DOWNLOAD_URL"
        tar -xzf "$CODEC_TAR"
        
        # Find and copy the .so files
        find . -name "codec_opus.so" -exec cp {} "$MODULE_DIR/" \;
        find . -name "format_ogg_opus.so" -exec cp {} "$MODULE_DIR/" \; 2>/dev/null || true
        
        # Copy XML documentation
        find . -name "*.xml" -exec cp {} /var/lib/asterisk/documentation/ \; 2>/dev/null || true
        
        cd /
        rm -rf "$TEMP_DIR"
        
        echo "Digium opus codec installed"
        return 0
    else
        echo "Digium codec not available for Asterisk $AST_VERSION"
        cd /
        rm -rf "$TEMP_DIR"
        return 1
    fi
}

# ============================================
# Method 3: Build from source (meetecho)
# ============================================
install_source_opus() {
    echo ""
    echo "=== Method 3: Build opus from source ==="
    
    # Install build dependencies
    apt-get update -qq
    apt-get install -y git build-essential libopus-dev pkg-config
    
    # Get Asterisk source headers if not present
    AST_INCLUDE="/usr/include/asterisk"
    if [ ! -d "$AST_INCLUDE" ]; then
        echo "Installing asterisk-dev headers..."
        apt-get install -y asterisk-dev 2>/dev/null || {
            echo "asterisk-dev not available, will try to build anyway"
        }
    fi
    
    TEMP_DIR=$(mktemp -d)
    cd "$TEMP_DIR"
    
    # Clone meetecho opus codec
    git clone --depth 1 https://github.com/meetecho/asterisk-opus.git
    cd asterisk-opus
    
    # Check if we can build
    if [ -f "codecs/codec_opus.c" ]; then
        # Try to compile
        echo "Compiling codec_opus..."
        
        # Create a simple Makefile if needed
        if [ ! -f "Makefile" ]; then
            cat > Makefile << 'MAKEFILE'
ASTERISK_INCLUDE ?= /usr/include
MODULES_DIR ?= /usr/lib/asterisk/modules

CFLAGS = -fPIC -DAST_MODULE_SELF_SYM=__internal_codec_opus_self \
         -I$(ASTERISK_INCLUDE) $(shell pkg-config --cflags opus)
LDFLAGS = -shared $(shell pkg-config --libs opus)

all: codec_opus.so

codec_opus.so: codecs/codec_opus.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)

install: codec_opus.so
	install -m 755 codec_opus.so $(MODULES_DIR)/

clean:
	rm -f codec_opus.so
MAKEFILE
        fi
        
        make ASTERISK_INCLUDE=/usr/include MODULES_DIR="$MODULE_DIR" 2>/dev/null || {
            echo "Build failed, trying alternative approach..."
            
            # Alternative: use asterisk source tree build
            if [ -d "/usr/src/asterisk" ]; then
                cp codecs/codec_opus.c /usr/src/asterisk/codecs/
                cd /usr/src/asterisk
                make codecs/codec_opus.so
                cp codecs/codec_opus.so "$MODULE_DIR/"
            else
                echo "Cannot build opus from source"
                cd /
                rm -rf "$TEMP_DIR"
                return 1
            fi
        }
        
        if [ -f "codec_opus.so" ]; then
            cp codec_opus.so "$MODULE_DIR/"
            echo "Opus codec built and installed"
        fi
    fi
    
    cd /
    rm -rf "$TEMP_DIR"
    return 0
}

# ============================================
# Install other common codecs
# ============================================
install_other_codecs() {
    echo ""
    echo "=== Installing other codecs ==="
    
    # G.722 is usually built-in, verify it's loaded
    if asterisk -rx "module show like g722" 2>/dev/null | grep -q "codec_g722"; then
        echo "✓ G.722 codec already loaded"
    else
        asterisk -rx "module load codec_g722.so" 2>/dev/null || true
    fi
    
    # Check for other useful codecs
    for codec in codec_a_mu codec_alaw codec_ulaw codec_gsm codec_g726 codec_ilbc codec_speex codec_resample; do
        if [ -f "$MODULE_DIR/${codec}.so" ]; then
            asterisk -rx "module load ${codec}.so" 2>/dev/null || true
        fi
    done
}

# ============================================
# Configure codecs.conf for Opus
# ============================================
configure_opus() {
    echo ""
    echo "=== Configuring Opus in codecs.conf ==="
    
    CODECS_CONF="/etc/asterisk/codecs.conf"
    
    if [ ! -f "$CODECS_CONF" ] || ! grep -q "\[opus\]" "$CODECS_CONF"; then
        cat >> "$CODECS_CONF" << 'EOF'

; Opus codec configuration for WebRTC
[opus]
type = opus
; Optimize for VoIP
application = voip
; Good quality at reasonable bandwidth
bitrate = 32000
; Enable forward error correction
fec = yes
; Variable bitrate for efficiency
cbr = no
; Medium complexity for ARM compatibility
complexity = 5
; Full bandwidth for quality
max_bandwidth = full
; Loss resistance
packet_loss = 10
EOF
        echo "Opus configuration added to codecs.conf"
    else
        echo "Opus already configured in codecs.conf"
    fi
}

# ============================================
# Main installation flow
# ============================================

# Try methods in order of preference
OPUS_INSTALLED=false

if install_debian_opus; then
    OPUS_INSTALLED=true
elif install_digium_opus; then
    OPUS_INSTALLED=true
elif install_source_opus; then
    OPUS_INSTALLED=true
fi

# Install other codecs
install_other_codecs

# Configure opus if installed
if [ "$OPUS_INSTALLED" = true ]; then
    configure_opus
fi

# Reload Asterisk modules
echo ""
echo "=== Reloading Asterisk ==="
asterisk -rx "module load codec_opus.so" 2>/dev/null || true
asterisk -rx "core reload" 2>/dev/null || true

# Verify installation
echo ""
echo "=== Verification ==="
echo "Loaded codecs:"
asterisk -rx "core show codecs audio" 2>/dev/null | head -20

echo ""
echo "Codec translation matrix (opus):"
asterisk -rx "core show translation paths opus" 2>/dev/null || \
asterisk -rx "core show translation" 2>/dev/null | grep -i opus || \
echo "Opus not in translation matrix (may need Asterisk restart)"

echo ""
if [ "$OPUS_INSTALLED" = true ]; then
    echo "=== Opus codec installation complete ==="
    echo "Restart Asterisk for full effect: systemctl restart asterisk"
else
    echo "=== WARNING: Opus codec could not be installed ==="
    echo "WebRTC will fall back to G.711 (ulaw/alaw)"
    echo "This is OK for local use but opus is preferred for internet calls"
fi
