#!/bin/bash
#
# install-voip-progress.sh
# Installation d'Asterisk + chan_quectel avec progression pour l'interface web
#
# Format des marqueurs:
#   [PROGRESS:percent:step] message
#   [ERROR] message
#   [WARNING] message
#   [SUCCESS] message
#

set -e

# =============================================================================
# CONFIGURATION
# =============================================================================

MODEM_TYPE="sim7600"
INSTALL_CHAN_QUECTEL=true
CONFIGURE_MODEMS=false
ASTERISK_VERSION="20.5.2"
CHAN_QUECTEL_REPO="https://github.com/RoEdAl/asterisk-chan-quectel.git"
CHAN_QUECTEL_COMMIT="37b566f"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --modem-type=*)
      MODEM_TYPE="${1#*=}"
      shift
      ;;
    --with-chan-quectel)
      INSTALL_CHAN_QUECTEL=true
      shift
      ;;
    --configure-modems)
      CONFIGURE_MODEMS=true
      shift
      ;;
    *)
      shift
      ;;
  esac
done

# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

progress() {
    local percent=$1
    local step=$2
    local message=$3
    echo "[PROGRESS:${percent}:${step}] ${message}"
}

log_error() {
    echo "[ERROR] $1" >&2
}

log_warning() {
    echo "[WARNING] $1"
}

log_success() {
    echo "[SUCCESS] $1"
}

check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "Ce script doit être exécuté en tant que root"
        exit 1
    fi
}

get_cpu_cores() {
    nproc 2>/dev/null || echo 2
}

# =============================================================================
# ÉTAPE 1: VÉRIFICATIONS (0-5%)
# =============================================================================

progress 0 "checks" "Vérification des prérequis..."

check_root

# Vérifier la distribution
if [ -f /etc/os-release ]; then
    . /etc/os-release
    DISTRO="$ID"
    VERSION="$VERSION_ID"
else
    log_error "Distribution non reconnue"
    exit 1
fi

progress 2 "checks" "Distribution: $DISTRO $VERSION"

# Vérifier l'architecture
ARCH=$(uname -m)
progress 3 "checks" "Architecture: $ARCH"

# Vérifier si Asterisk est déjà installé
if command -v asterisk &> /dev/null; then
    EXISTING_VERSION=$(asterisk -V 2>/dev/null | grep -oP 'Asterisk \K[\d.]+' || echo "unknown")
    log_warning "Asterisk $EXISTING_VERSION est déjà installé"
    # On continue quand même pour mettre à jour/reconfigurer
fi

progress 5 "checks" "Vérifications terminées"

# =============================================================================
# ÉTAPE 2: DÉPENDANCES (5-15%)
# =============================================================================

progress 5 "dependencies" "Installation des dépendances système..."

export DEBIAN_FRONTEND=noninteractive

apt-get update -qq

progress 7 "dependencies" "Mise à jour des paquets..."

# Dépendances de compilation
DEPS=(
    build-essential
    git
    wget
    curl
    libncurses5-dev
    libssl-dev
    libxml2-dev
    libsqlite3-dev
    uuid-dev
    libjansson-dev
    libedit-dev
    pkg-config
    automake
    autoconf
    libtool
    cmake
    # Audio
    libasound2-dev
    libspeex-dev
    libspeexdsp-dev
    libopus-dev
    # Pour chan_quectel
    alsa-utils
)

progress 8 "dependencies" "Installation de ${#DEPS[@]} paquets..."

apt-get install -y -qq "${DEPS[@]}" 2>&1 | while read line; do
    echo "  $line"
done

progress 15 "dependencies" "Dépendances installées"
log_success "Dépendances système installées"

# =============================================================================
# ÉTAPE 3: TÉLÉCHARGEMENT ASTERISK (15-25%)
# =============================================================================

progress 15 "download" "Téléchargement d'Asterisk ${ASTERISK_VERSION}..."

cd /usr/src

# Nettoyer les anciennes sources
rm -rf asterisk-${ASTERISK_VERSION}* 2>/dev/null || true

progress 17 "download" "Téléchargement depuis downloads.asterisk.org..."

wget -q --show-progress "https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-${ASTERISK_VERSION}.tar.gz" \
    -O asterisk-${ASTERISK_VERSION}.tar.gz 2>&1 | while read line; do
    echo "  $line"
done

progress 22 "download" "Extraction des sources..."

tar xzf asterisk-${ASTERISK_VERSION}.tar.gz

cd asterisk-${ASTERISK_VERSION}

progress 25 "download" "Sources Asterisk prêtes"
log_success "Asterisk ${ASTERISK_VERSION} téléchargé"

# =============================================================================
# ÉTAPE 4: COMPILATION ASTERISK (25-60%)
# =============================================================================

progress 25 "compile" "Configuration d'Asterisk..."

# Installer les prérequis Asterisk
./contrib/scripts/install_prereq install 2>&1 | tail -5

progress 28 "compile" "Exécution de ./configure..."

./configure --with-jansson-bundled 2>&1 | tail -10

progress 32 "compile" "Sélection des modules (menuselect)..."

# Activer les modules nécessaires
make menuselect.makeopts 2>&1 | tail -5

# Activer les codecs et modules importants
menuselect/menuselect --enable codec_opus menuselect.makeopts 2>/dev/null || true
menuselect/menuselect --enable codec_speex menuselect.makeopts 2>/dev/null || true
menuselect/menuselect --enable res_srtp menuselect.makeopts 2>/dev/null || true
menuselect/menuselect --enable res_pjsip menuselect.makeopts 2>/dev/null || true

progress 35 "compile" "Compilation d'Asterisk (cela peut prendre 10-20 minutes)..."

CPU_CORES=$(get_cpu_cores)
echo "  Utilisation de $CPU_CORES cœurs CPU"

# Compilation avec progression
make -j${CPU_CORES} 2>&1 | while read line; do
    # Afficher uniquement les lignes importantes
    if [[ "$line" == *"CC"* ]] || [[ "$line" == *"LD"* ]] || [[ "$line" == *"AR"* ]]; then
        echo "  $line"
    fi
done

progress 55 "compile" "Compilation terminée, installation..."

make install 2>&1 | tail -10

progress 58 "compile" "Installation des fichiers de configuration..."

make samples 2>&1 | tail -5
make config 2>&1 | tail -5

progress 60 "compile" "Asterisk compilé et installé"
log_success "Asterisk ${ASTERISK_VERSION} installé avec succès"

# =============================================================================
# ÉTAPE 5: CHAN_QUECTEL (60-80%)
# =============================================================================

if [ "$INSTALL_CHAN_QUECTEL" = true ]; then
    progress 60 "chan_quectel" "Installation de chan_quectel..."

    cd /usr/src

    # Nettoyer
    rm -rf asterisk-chan-quectel 2>/dev/null || true

    progress 62 "chan_quectel" "Clonage du dépôt RoEdAl/asterisk-chan-quectel..."

    git clone "$CHAN_QUECTEL_REPO" asterisk-chan-quectel 2>&1 | tail -5

    cd asterisk-chan-quectel

    progress 65 "chan_quectel" "Checkout du commit $CHAN_QUECTEL_COMMIT (version stable)..."

    git checkout "$CHAN_QUECTEL_COMMIT" 2>&1 | tail -3

    progress 68 "chan_quectel" "Configuration CMake..."

    mkdir -p build && cd build
    cmake .. 2>&1 | tail -10

    progress 72 "chan_quectel" "Compilation de chan_quectel..."

    make -j${CPU_CORES} 2>&1 | while read line; do
        if [[ "$line" == *"Building"* ]] || [[ "$line" == *"Linking"* ]]; then
            echo "  $line"
        fi
    done

    progress 75 "chan_quectel" "Installation du module..."

    make install 2>&1 | tail -5

    # Vérifier que le module est bien installé
    if [ -f /usr/lib/asterisk/modules/chan_quectel.so ]; then
        log_success "chan_quectel installé dans /usr/lib/asterisk/modules/"
    else
        log_warning "chan_quectel.so non trouvé à l'emplacement attendu"
    fi

    progress 78 "chan_quectel" "Création de la configuration quectel.conf..."

    # Créer la configuration de base
    cat > /etc/asterisk/quectel.conf << 'QUECTEL_CONF'
[general]
interval=15
timeout=30

; Configuration pour modem SIM7600/EC25
; Sera complétée par l'interface web
[defaults]
context=from-gsm
group=0
rxgain=0
txgain=0
autodeletesms=yes
resetquectel=no
u2diag=-1
usecallingpres=yes
callingpres=allowed_passed_screen
disablesms=no
language=fr
smsaspdu=yes
mindtmfgap=45
mindtmfduration=80
mindtmfinterval=200

; Les modems seront configurés via l'interface web
QUECTEL_CONF

    progress 80 "chan_quectel" "chan_quectel installé"
    log_success "chan_quectel configuré"
fi

# =============================================================================
# ÉTAPE 6: CONFIGURATION (80-90%)
# =============================================================================

progress 80 "config" "Configuration d'Asterisk..."

# Créer l'utilisateur asterisk si nécessaire
if ! id -u asterisk &>/dev/null; then
    useradd -r -d /var/lib/asterisk -s /bin/false asterisk 2>/dev/null || true
fi

progress 82 "config" "Permissions sur les fichiers..."

# Permissions
chown -R asterisk:asterisk /var/lib/asterisk
chown -R asterisk:asterisk /var/log/asterisk
chown -R asterisk:asterisk /var/spool/asterisk
chown -R asterisk:asterisk /var/run/asterisk 2>/dev/null || true
chown -R asterisk:asterisk /etc/asterisk

progress 85 "config" "Configuration du service systemd..."

# Créer le service systemd si non existant
if [ ! -f /etc/systemd/system/asterisk.service ]; then
    cat > /etc/systemd/system/asterisk.service << 'SYSTEMD_CONF'
[Unit]
Description=Asterisk PBX
After=network.target

[Service]
Type=simple
User=asterisk
Group=asterisk
ExecStart=/usr/sbin/asterisk -f -C /etc/asterisk/asterisk.conf
ExecReload=/usr/sbin/asterisk -rx 'core reload'
ExecStop=/usr/sbin/asterisk -rx 'core stop now'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SYSTEMD_CONF
fi

systemctl daemon-reload
systemctl enable asterisk 2>/dev/null || true

progress 88 "config" "Démarrage d'Asterisk..."

systemctl start asterisk 2>&1 || {
    log_warning "Asterisk n'a pas pu démarrer automatiquement"
}

# Attendre un peu
sleep 3

# Vérifier si Asterisk tourne
if pgrep -x asterisk > /dev/null; then
    log_success "Asterisk démarré"
else
    log_warning "Asterisk ne semble pas tourner, vérifiez les logs"
fi

progress 90 "config" "Configuration terminée"

# =============================================================================
# ÉTAPE 7: TESTS ET FINALISATION (90-100%)
# =============================================================================

progress 90 "tests" "Tests de validation..."

# Tester la commande asterisk
if asterisk -rx "core show version" &>/dev/null; then
    VERSION_INSTALLED=$(asterisk -rx "core show version" | head -1)
    log_success "Asterisk répond: $VERSION_INSTALLED"
else
    log_warning "Asterisk ne répond pas aux commandes CLI"
fi

progress 93 "tests" "Vérification des modules..."

# Vérifier chan_quectel si installé
if [ "$INSTALL_CHAN_QUECTEL" = true ]; then
    if asterisk -rx "module show like quectel" 2>/dev/null | grep -q "chan_quectel"; then
        log_success "Module chan_quectel chargé"
    else
        # Essayer de le charger
        asterisk -rx "module load chan_quectel.so" 2>/dev/null || true
        sleep 1
        if asterisk -rx "module show like quectel" 2>/dev/null | grep -q "chan_quectel"; then
            log_success "Module chan_quectel chargé manuellement"
        else
            log_warning "chan_quectel non chargé - configuration manuelle requise"
        fi
    fi
fi

progress 96 "tests" "Vérification des ports USB..."

# Lister les modems détectés
USB_PORTS=$(ls /dev/ttyUSB* 2>/dev/null | wc -l)
if [ "$USB_PORTS" -gt 0 ]; then
    echo "  $USB_PORTS ports USB détectés"
    ls /dev/ttyUSB* 2>/dev/null | while read port; do
        echo "    - $port"
    done
else
    log_warning "Aucun port USB détecté - connectez vos modems"
fi

progress 98 "tests" "Nettoyage..."

# Nettoyer les fichiers temporaires
rm -f /usr/src/asterisk-${ASTERISK_VERSION}.tar.gz

progress 100 "done" "Installation terminée!"

echo ""
log_success "========================================"
log_success "  INSTALLATION TERMINÉE AVEC SUCCÈS"
log_success "========================================"
echo ""
echo "Asterisk version: ${ASTERISK_VERSION}"
if [ "$INSTALL_CHAN_QUECTEL" = true ]; then
    echo "chan_quectel: installé"
fi
echo ""
echo "Prochaines étapes:"
echo "  1. Configurez vos modems dans l'interface web"
echo "  2. Redémarrez Asterisk: systemctl restart asterisk"
echo "  3. Vérifiez avec: asterisk -rx 'quectel show devices'"
echo ""
