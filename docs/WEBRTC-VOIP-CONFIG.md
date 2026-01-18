# Rapport de Configuration WebRTC/VoIP - Homenichat-serv

## Résumé des Corrections Effectuées

Ce document détaille les problèmes rencontrés et les corrections apportées pour faire fonctionner la VoIP WebRTC sur Homenichat-serv.

---

## 1. PROBLÈME CRITIQUE: Nommage des AOR PJSIP

### Symptôme

```
WARNING: AOR '' not found for endpoint '1001'
SIP/2.0 404 Not Found
```

### Cause

Les sections AOR étaient nommées `[1001-aor]` alors que le REGISTER SIP utilise `To: <sip:1001@domain>`. PJSIP cherche un AOR correspondant au username du header To.

### ❌ Configuration incorrecte

```ini
[1001]
type=endpoint
aors=1001-aor    ; Référence à l'AOR

[1001-aor]       ; Nom ne correspond pas au username
type=aor
max_contacts=5
```

### ✅ Configuration correcte

```ini
[1001]
type=endpoint
aors=1001        ; Référence directe au username

[1001]           ; MÊME NOM que l'endpoint (type différent = OK)
type=aor
max_contacts=5
remove_existing=yes
```

### Règle à retenir

> **Le nom de la section AOR DOIT correspondre exactement au username SIP.**

---

## 2. Configuration PJSIP Complète pour WebRTC

### Fichier: `/etc/asterisk/pjsip_extensions.conf`

```ini
; === TRANSPORTS WebSocket ===
[transport-wss]
type=transport
protocol=wss
bind=0.0.0.0:8089

[transport-ws]
type=transport
protocol=ws
bind=0.0.0.0:8088

; === TEMPLATE pour Extensions WebRTC ===
; Pour chaque extension, créer 3 sections avec le MÊME nom base:
; - endpoint: [XXXX] type=endpoint
; - auth: [XXXX-auth] type=auth
; - aor: [XXXX] type=aor (MÊME NOM que endpoint!)

; === EXTENSION EXEMPLE (1001) ===
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
aors=1001                  ; DOIT correspondre au nom de l'AOR
direct_media=no
dtmf_mode=rfc4733
identify_by=username       ; Identification par username From header

[1001-auth]
type=auth
auth_type=userpass
username=1001              ; DOIT correspondre au nom de l'endpoint
password=<mot_de_passe>

[1001]                     ; MÊME NOM que l'endpoint
type=aor
max_contacts=5
remove_existing=yes
```

---

## 3. Configuration HTTP/WebSocket Asterisk

### Fichier: `/etc/asterisk/http.conf`

```ini
[general]
enabled=yes
bindaddr=0.0.0.0
bindport=8088
tlsenable=yes
tlsbindaddr=0.0.0.0:8089
tlscertfile=/etc/asterisk/keys/asterisk.pem
tlsprivatekey=/etc/asterisk/keys/asterisk.key
```

### Points importants:

- `bindaddr=0.0.0.0` pour écouter sur toutes les interfaces
- Port **8088** pour WS (non-chiffré, usage local/proxy)
- Port **8089** pour WSS (TLS, nécessite certificat valide)

---

## 4. Dialplan - Contexte from-internal

### Fichier: `/etc/asterisk/extensions.conf`

Ajouter le contexte pour les appels WebRTC:

```ini
[from-internal]
; Appels entre extensions internes
exten => _10XX,1,NoOp(Appel interne vers ${EXTEN})
 same => n,Dial(PJSIP/${EXTEN},30)
 same => n,Hangup()

; Test d'écho (600)
exten => 600,1,NoOp(Echo Test)
 same => n,Answer()
 same => n,Echo()
 same => n,Hangup()

; Test audio (601)
exten => 601,1,NoOp(Test Son)
 same => n,Answer()
 same => n,Playback(hello-world)
 same => n,Hangup()
```

---

## 5. Configuration Nginx pour Proxy WebSocket (Optionnel)

Si un reverse proxy nginx est utilisé pour exposer le WebSocket via HTTPS:

```nginx
location /wss {
    proxy_pass http://<IP_ASTERISK>:8088/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host <IP_ASTERISK>:8088;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Sec-WebSocket-Protocol sip;
    proxy_read_timeout 86400;
    proxy_send_timeout 86400;
    proxy_buffering off;
    proxy_cache off;
}
```

---

## 6. Checklist Création d'Extension WebRTC

Lors de la création d'une nouvelle extension WebRTC dans Homenichat-serv:

- [ ] Créer la section `[XXXX]` type=endpoint avec `aors=XXXX`
- [ ] Créer la section `[XXXX-auth]` type=auth avec `username=XXXX`
- [ ] Créer la section `[XXXX]` type=aor (**MÊME NOM que endpoint!**)
- [ ] Vérifier `identify_by=username` sur l'endpoint
- [ ] Vérifier `webrtc=yes` sur l'endpoint
- [ ] Vérifier que le contexte existe dans `extensions.conf`
- [ ] Recharger PJSIP: `asterisk -rx 'pjsip reload'`

---

## 7. Commandes de Diagnostic

```bash
# Vérifier les endpoints
asterisk -rx 'pjsip show endpoints'

# Vérifier les AORs
asterisk -rx 'pjsip show aors'

# Vérifier un endpoint spécifique
asterisk -rx 'pjsip show endpoint 1001'

# Vérifier le serveur HTTP
asterisk -rx 'http show status'

# Activer les logs PJSIP
asterisk -rx 'pjsip set logger on'

# Voir les logs en temps réel
tail -f /var/log/asterisk/full | grep -E 'REGISTER|1001|AOR|endpoint'
```

---

## 8. Erreurs Courantes et Solutions

| Erreur | Cause | Solution |
|--------|-------|----------|
| `AOR '' not found` | Nom AOR ≠ username | Renommer l'AOR pour correspondre au username |
| `404 Not Found` après auth | AOR manquante ou mal nommée | Vérifier la section AOR |
| WebSocket 1006 | Certificat SSL invalide | Utiliser WS ou certificat Let's Encrypt |
| WebSocket 1008 | Timeout, pas de réponse | Vérifier que les messages atteignent Asterisk |
| `401 Unauthorized` en boucle | Mauvais password | Vérifier mot de passe dans auth |

---

**Date**: 18 Janvier 2026
**Version Asterisk**: 20.17.0
**Testé avec**: SIP.js 0.21.x
