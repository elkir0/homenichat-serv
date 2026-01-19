#!/bin/bash
#
# UPnP Watchdog pour Homenichat-serv
# Vérifie et maintient les port mappings UPnP pour VoIP/WebRTC
#
# Usage:
#   upnp-watchdog.sh check   - Vérifie et restaure les mappings
#   upnp-watchdog.sh start   - Active UPnP et ajoute les mappings
#   upnp-watchdog.sh stop    - Désactive UPnP et supprime les mappings
#   upnp-watchdog.sh status  - Affiche le statut actuel
#
# Version: 1.0
# Homenichat-serv

set -euo pipefail

# === CONFIGURATION ===
CONFIG_FILE="${UPNP_CONFIG_FILE:-/etc/homenichat/upnp.conf}"
LOG_FILE="${UPNP_LOG_FILE:-/var/log/homenichat/upnp-watchdog.log}"
LEASE_DURATION="${UPNP_LEASE_DURATION:-3600}"  # 1 heure
LOCAL_IP="${UPNP_LOCAL_IP:-$(hostname -I 2>/dev/null | awk '{print $1}')}"

# IGD URL directe (optionnel - pour VM où multicast ne fonctionne pas)
# Peut être configuré via /etc/homenichat/upnp.conf: igd_url=http://...
IGD_URL=""

# Ports à mapper
SIP_TLS_PORT=5061
RTP_START=10000
RTP_END=10100

# === FONCTIONS ===

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    echo "$msg"
    # Créer le répertoire de log si nécessaire
    mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
    echo "$msg" >> "$LOG_FILE" 2>/dev/null || true
}

check_upnpc() {
    if ! command -v upnpc &> /dev/null; then
        log "ERREUR: miniupnpc n'est pas installé. Installez avec: apt install miniupnpc"
        exit 1
    fi
}

load_config() {
    if [[ -f "$CONFIG_FILE" ]]; then
        # Load IGD URL if configured (for VM where multicast doesn't work)
        local url
        url=$(grep -E "^igd_url=" "$CONFIG_FILE" 2>/dev/null | cut -d= -f2- | tr -d ' ')
        if [[ -n "$url" ]]; then
            IGD_URL="$url"
            log "Using direct IGD URL: $IGD_URL"
        fi
    fi
}

check_upnp_enabled() {
    if [[ -f "$CONFIG_FILE" ]]; then
        local enabled
        enabled=$(grep -E "^enabled=" "$CONFIG_FILE" 2>/dev/null | cut -d= -f2 | tr -d ' ')
        if [[ "$enabled" == "true" ]]; then
            return 0
        fi
    fi
    return 1
}

set_upnp_enabled() {
    local value=$1
    mkdir -p "$(dirname "$CONFIG_FILE")" 2>/dev/null || true

    if [[ -f "$CONFIG_FILE" ]]; then
        if grep -q "^enabled=" "$CONFIG_FILE" 2>/dev/null; then
            sed -i "s/^enabled=.*/enabled=$value/" "$CONFIG_FILE"
        else
            echo "enabled=$value" >> "$CONFIG_FILE"
        fi
    else
        cat > "$CONFIG_FILE" << EOF
# Configuration UPnP Homenichat-serv
# Généré automatiquement

[general]
enabled=$value
lease_duration=$LEASE_DURATION

[ports]
sip_tls=$SIP_TLS_PORT
rtp_start=$RTP_START
rtp_end=$RTP_END
EOF
    fi
}

# Build upnpc command with optional IGD URL
upnpc_cmd() {
    if [[ -n "$IGD_URL" ]]; then
        echo "upnpc -u $IGD_URL"
    else
        echo "upnpc"
    fi
}

get_external_ip() {
    $(upnpc_cmd) -s 2>/dev/null | grep -i "ExternalIPAddress" | awk -F'=' '{print $2}' | tr -d ' ' || echo ""
}

get_router_info() {
    $(upnpc_cmd) -s 2>/dev/null | grep -i "desc:" | head -1 | sed 's/.*desc: //' || echo "Unknown"
}

check_upnp_available() {
    if $(upnpc_cmd) -s 2>/dev/null | grep -q "Found valid IGD"; then
        return 0
    else
        return 1
    fi
}

check_port_mapping() {
    local port=$1
    local protocol=$2
    $(upnpc_cmd) -l 2>/dev/null | grep -qE "${port}.*->.*${LOCAL_IP}:${port}.*${protocol}" 2>/dev/null
}

add_port_mapping() {
    local port=$1
    local protocol=$2
    local description=$3

    if check_port_mapping "$port" "$protocol"; then
        return 0  # Already mapped
    fi

    log "Ajout mapping: ${port}/${protocol} -> ${LOCAL_IP}:${port}"
    if $(upnpc_cmd) -e "$description" -a "$LOCAL_IP" "$port" "$port" "$protocol" "$LEASE_DURATION" 2>/dev/null; then
        return 0
    else
        log "ERREUR: Échec mapping ${port}/${protocol}"
        return 1
    fi
}

remove_port_mapping() {
    local port=$1
    local protocol=$2

    if check_port_mapping "$port" "$protocol"; then
        log "Suppression mapping: ${port}/${protocol}"
        $(upnpc_cmd) -d "$port" "$protocol" 2>/dev/null || true
    fi
}

add_all_mappings() {
    local errors=0

    log "Ajout des mappings UPnP pour ${LOCAL_IP}..."

    # SIP TLS
    if ! add_port_mapping "$SIP_TLS_PORT" "TCP" "Homenichat SIP TLS"; then
        ((errors++)) || true
    fi

    # RTP ports (batch for performance)
    local rtp_errors=0
    for port in $(seq $RTP_START $RTP_END); do
        if ! add_port_mapping "$port" "UDP" "Homenichat RTP"; then
            ((rtp_errors++)) || true
        fi
    done

    if [[ $rtp_errors -gt 0 ]]; then
        log "ATTENTION: ${rtp_errors} ports RTP n'ont pas pu être mappés"
        ((errors++)) || true
    fi

    return $errors
}

remove_all_mappings() {
    log "Suppression de tous les mappings UPnP..."

    # SIP TLS
    remove_port_mapping "$SIP_TLS_PORT" "TCP"

    # RTP ports
    for port in $(seq $RTP_START $RTP_END); do
        remove_port_mapping "$port" "UDP"
    done

    log "Mappings supprimés"
}

count_rtp_mappings() {
    local count=0
    for port in $(seq $RTP_START $RTP_END); do
        if check_port_mapping "$port" "UDP"; then
            ((count++)) || true
        fi
    done
    echo $count
}

status_json() {
    local enabled="false"
    local external_ip=""
    local router=""
    local sip_ok="false"
    local rtp_count=0
    local error=""

    if check_upnp_enabled; then
        enabled="true"
    fi

    if check_upnp_available; then
        external_ip=$(get_external_ip)
        router=$(get_router_info)

        if check_port_mapping "$SIP_TLS_PORT" "TCP"; then
            sip_ok="true"
        fi

        rtp_count=$(count_rtp_mappings)
    else
        error="Routeur UPnP non disponible ou UPnP désactivé sur le routeur"
    fi

    cat << EOF
{
  "enabled": $enabled,
  "available": $(check_upnp_available && echo "true" || echo "false"),
  "externalIp": "$external_ip",
  "router": "$router",
  "localIp": "$LOCAL_IP",
  "mappings": {
    "sipTls": $sip_ok,
    "rtpCount": $rtp_count,
    "rtpTotal": $((RTP_END - RTP_START + 1))
  },
  "error": $([ -n "$error" ] && echo "\"$error\"" || echo "null")
}
EOF
}

status_report() {
    echo "=== Statut UPnP Homenichat ==="
    echo ""

    if ! check_upnp_available; then
        echo "Routeur UPnP: NON DISPONIBLE"
        echo "Vérifiez que UPnP est activé sur votre routeur."
        return 1
    fi

    local external_ip=$(get_external_ip)
    local router=$(get_router_info)

    echo "Routeur: $router"
    echo "IP Locale: $LOCAL_IP"
    echo "IP Externe: ${external_ip:-Non disponible}"
    echo ""
    echo "Configuration: $(check_upnp_enabled && echo "ACTIVÉ" || echo "DÉSACTIVÉ")"
    echo ""
    echo "Ports mappés:"

    if check_port_mapping "$SIP_TLS_PORT" "TCP"; then
        echo "  • ${SIP_TLS_PORT}/TCP (SIP TLS): ✅ OK"
    else
        echo "  • ${SIP_TLS_PORT}/TCP (SIP TLS): ❌ Non mappé"
    fi

    local rtp_count=$(count_rtp_mappings)
    local rtp_total=$((RTP_END - RTP_START + 1))

    if [[ $rtp_count -eq $rtp_total ]]; then
        echo "  • ${RTP_START}-${RTP_END}/UDP (RTP): ✅ OK (${rtp_count}/${rtp_total})"
    elif [[ $rtp_count -gt 0 ]]; then
        echo "  • ${RTP_START}-${RTP_END}/UDP (RTP): ⚠️ Partiel (${rtp_count}/${rtp_total})"
    else
        echo "  • ${RTP_START}-${RTP_END}/UDP (RTP): ❌ Non mappé"
    fi
}

# === MAIN ===

check_upnpc
load_config

case "${1:-check}" in
    check)
        if ! check_upnp_enabled; then
            log "UPnP désactivé dans la configuration"
            exit 0
        fi

        if ! check_upnp_available; then
            log "ERREUR: Routeur UPnP non disponible"
            exit 1
        fi

        log "Vérification des mappings UPnP..."
        if add_all_mappings; then
            log "Tous les mappings OK"
        else
            log "ATTENTION: Certains mappings ont échoué"
            exit 1
        fi
        ;;

    start)
        log "Activation UPnP..."

        if ! check_upnp_available; then
            log "ERREUR: Routeur UPnP non disponible"
            exit 1
        fi

        set_upnp_enabled "true"

        if add_all_mappings; then
            log "UPnP activé avec succès"
            log "IP Externe: $(get_external_ip)"
        else
            log "UPnP activé avec des erreurs"
            exit 1
        fi
        ;;

    stop)
        log "Désactivation UPnP..."
        set_upnp_enabled "false"
        remove_all_mappings
        log "UPnP désactivé"
        ;;

    status)
        status_report
        ;;

    status-json)
        status_json
        ;;

    *)
        echo "Usage: $0 {check|start|stop|status|status-json}"
        echo ""
        echo "Commands:"
        echo "  check       - Vérifie et restaure les mappings (pour le timer)"
        echo "  start       - Active UPnP et ajoute tous les mappings"
        echo "  stop        - Désactive UPnP et supprime tous les mappings"
        echo "  status      - Affiche le statut (format texte)"
        echo "  status-json - Affiche le statut (format JSON)"
        exit 1
        ;;
esac
