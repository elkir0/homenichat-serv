# Homenichat-Serv v2 - Architecture Refactorée

**Branche**: `refactor`
**Date**: 2026-01-24
**Objectifs**: Scripts modulaires, sans FreePBX, architecture propre

---

## 1. Principes Directeurs

### Ce qu'on ENLÈVE

| Composant | Raison |
|-----------|--------|
| **FreePBX** | Trop lourd, installation complexe (~500 lignes de script), dépendance PHP/Apache |
| **install.sh monolithique** (2317 lignes) | Impossible à maintenir, tests difficiles |
| **FreePBXAmiService.js** (1770 lignes) | Remplacé par Asterisk pur + API REST simple |
| **Dépendances inutiles** | Sangoma repos, PHP, Apache, MariaDB |

### Ce qu'on GARDE

| Composant | Raison |
|-----------|--------|
| **Asterisk** (compilé depuis source) | VoIP/PBX léger, pas d'interface web lourde |
| **chan_quectel** | Bridge modem-Asterisk essentiel |
| **Baileys** | WhatsApp gratuit, fonctionne bien |
| **Node.js 20** | Runtime stable |
| **SQLite** | DB simple, pas de serveur |

### Nouvelles Approches

| Ancien | Nouveau |
|--------|---------|
| 1 script de 2317 lignes | 10-15 scripts de 50-200 lignes chacun |
| FreePBX GUI | Dialplan Asterisk + API REST homenichat |
| AMI pour tout | AMI minimal + ARI pour le reste |
| Configuration dispersée | `/etc/homenichat/` centralisé |

---

## 2. Nouvelle Structure de Fichiers

```
homenichat-serv/
├── server.js                     # Entry point (~200 lignes max)
│
├── src/                          # NOUVEAU - Code source organisé
│   ├── app.js                    # Express app setup
│   ├── websocket.js              # WebSocket server
│   │
│   ├── config/                   # Configuration loaders
│   │   ├── index.js              # Config central
│   │   ├── providers.js          # Charge providers.yaml
│   │   └── environment.js        # Variables d'environnement
│   │
│   ├── routes/                   # Routes API (déplacées depuis /)
│   │   ├── index.js              # Router principal
│   │   ├── auth.js               # Authentication
│   │   ├── chats.js              # Chats/messages
│   │   ├── sms.js                # SMS API
│   │   ├── voip.js               # VoIP API
│   │   ├── whatsapp.js           # WhatsApp API
│   │   ├── media.js              # Upload/download
│   │   └── admin/                # Routes admin séparées
│   │       ├── index.js
│   │       ├── users.js
│   │       ├── modems.js
│   │       ├── providers.js
│   │       └── settings.js
│   │
│   ├── services/                 # Business logic
│   │   ├── database/             # REFACTORÉ - Repositories pattern
│   │   │   ├── index.js          # Pool + exports
│   │   │   ├── UserRepository.js
│   │   │   ├── ChatRepository.js
│   │   │   ├── MessageRepository.js
│   │   │   └── DeviceTokenRepository.js
│   │   │
│   │   ├── modem/                # REFACTORÉ - ModemService splitté
│   │   │   ├── index.js          # Export principal
│   │   │   ├── ModemManager.js   # Orchestration
│   │   │   ├── ModemDetector.js  # Détection USB
│   │   │   ├── AtCommandService.js
│   │   │   ├── SmsQueueService.js
│   │   │   └── QuectelConfigService.js
│   │   │
│   │   ├── asterisk/             # NOUVEAU - Remplace FreePBX
│   │   │   ├── index.js
│   │   │   ├── AmiClient.js      # Connexion AMI simple
│   │   │   ├── AriClient.js      # Asterisk REST Interface
│   │   │   ├── DialplanGenerator.js
│   │   │   └── ExtensionManager.js
│   │   │
│   │   ├── push/                 # REFACTORÉ - Push unifié
│   │   │   ├── index.js
│   │   │   ├── PushManager.js
│   │   │   ├── ApnsService.js
│   │   │   ├── FcmService.js
│   │   │   └── WebPushService.js
│   │   │
│   │   └── providers/            # Provider orchestration
│   │       └── ProviderManager.js
│   │
│   ├── providers/                # Implémentations providers
│   │   ├── base/
│   │   │   ├── BaseProvider.js
│   │   │   ├── SmsProvider.js
│   │   │   ├── WhatsAppProvider.js
│   │   │   └── VoipProvider.js
│   │   │
│   │   ├── sms/
│   │   │   ├── GammuProvider.js
│   │   │   ├── TwilioProvider.js
│   │   │   ├── OvhProvider.js
│   │   │   └── ModemProvider.js   # Direct chan_quectel
│   │   │
│   │   ├── whatsapp/
│   │   │   ├── BaileysProvider.js
│   │   │   └── MetaCloudProvider.js
│   │   │
│   │   └── voip/
│   │       └── AsteriskProvider.js  # Remplace FreePBXProvider
│   │
│   ├── middleware/
│   │   ├── auth.js
│   │   ├── rateLimit.js
│   │   └── security.js
│   │
│   └── utils/
│       ├── logger.js
│       ├── validators.js
│       └── helpers.js
│
├── scripts/                      # REFACTORÉ - Scripts modulaires
│   ├── install/                  # Scripts d'installation
│   │   ├── install.sh            # Orchestrateur (~100 lignes)
│   │   ├── 00-detect-system.sh   # Détection OS/arch
│   │   ├── 01-install-nodejs.sh  # Node.js 20
│   │   ├── 02-install-homenichat.sh
│   │   ├── 03-install-asterisk.sh  # Asterisk depuis source
│   │   ├── 04-install-chan-quectel.sh
│   │   ├── 05-configure-asterisk.sh
│   │   ├── 06-install-gammu.sh
│   │   ├── 07-setup-services.sh  # systemd
│   │   └── lib/                  # Fonctions communes
│   │       ├── colors.sh
│   │       ├── logging.sh
│   │       └── utils.sh
│   │
│   ├── modem/                    # Scripts modem
│   │   ├── detect-modem.sh
│   │   ├── init-ec25.sh
│   │   ├── init-sim7600.sh
│   │   └── configure-quectel.sh
│   │
│   └── maintenance/              # Scripts maintenance
│       ├── backup.sh
│       ├── update.sh
│       └── health-check.sh
│
├── config/                       # Templates de configuration
│   ├── providers.yaml            # Config providers
│   ├── asterisk/                 # Templates Asterisk
│   │   ├── pjsip.conf.template
│   │   ├── extensions.conf.template
│   │   ├── quectel.conf.template
│   │   └── http.conf.template
│   └── systemd/                  # Templates systemd
│       ├── homenichat.service
│       └── modem-init.service
│
├── admin/                        # UI Admin React (inchangé)
│
├── test/                         # NOUVEAU - Tests
│   ├── unit/
│   ├── integration/
│   └── e2e/
│
└── docs/                         # Documentation
    ├── ARCHITECTURE-REFACTOR.md  # CE FICHIER
    ├── API.md
    └── INSTALLATION.md
```

---

## 3. Scripts d'Installation Modulaires

### Philosophie

| Principe | Application |
|----------|-------------|
| **Un script = une tâche** | `01-install-nodejs.sh` ne fait QUE installer Node.js |
| **Idempotent** | Peut être relancé sans casser l'existant |
| **Testable** | Chaque script peut être testé isolément |
| **Verbose** | Logs clairs, codes de retour explicites |
| **<200 lignes** | Si plus long, diviser |

### Orchestrateur Principal

```bash
# scripts/install/install.sh (~100 lignes)

#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/colors.sh"
source "$SCRIPT_DIR/lib/logging.sh"

# Parse arguments
COMPONENTS=()
while [[ $# -gt 0 ]]; do
    case $1 in
        --full) COMPONENTS=(nodejs homenichat asterisk chan-quectel gammu services) ;;
        --minimal) COMPONENTS=(nodejs homenichat) ;;
        --voip) COMPONENTS=(nodejs homenichat asterisk chan-quectel services) ;;
        *) COMPONENTS+=("$1") ;;
    esac
    shift
done

# Exécuter les scripts sélectionnés
for component in "${COMPONENTS[@]}"; do
    log_info "Installing $component..."
    case $component in
        nodejs) "$SCRIPT_DIR/01-install-nodejs.sh" ;;
        homenichat) "$SCRIPT_DIR/02-install-homenichat.sh" ;;
        asterisk) "$SCRIPT_DIR/03-install-asterisk.sh" ;;
        chan-quectel) "$SCRIPT_DIR/04-install-chan-quectel.sh" ;;
        gammu) "$SCRIPT_DIR/06-install-gammu.sh" ;;
        services) "$SCRIPT_DIR/07-setup-services.sh" ;;
    esac
done

log_success "Installation complete!"
```

### Exemple de Script Modulaire

```bash
# scripts/install/01-install-nodejs.sh (~60 lignes)

#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/colors.sh"
source "$SCRIPT_DIR/lib/logging.sh"

NODE_VERSION="20"

# Check if already installed
if command -v node &>/dev/null; then
    CURRENT=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [[ "$CURRENT" -ge "$NODE_VERSION" ]]; then
        log_success "Node.js $CURRENT already installed"
        exit 0
    fi
fi

log_info "Installing Node.js $NODE_VERSION..."

# Detect package manager
if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y nodejs
elif command -v dnf &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_${NODE_VERSION}.x | bash -
    dnf install -y nodejs
else
    log_error "Unsupported package manager"
    exit 1
fi

# Verify installation
node -v || { log_error "Node.js installation failed"; exit 1; }
npm -v || { log_error "npm installation failed"; exit 1; }

log_success "Node.js $(node -v) installed successfully"
```

---

## 4. Asterisk Sans FreePBX

### Pourquoi Pas FreePBX ?

| Problème FreePBX | Solution |
|------------------|----------|
| Installation complexe (PHP, Apache, MariaDB) | Asterisk pur + dialplan statique |
| 500+ lignes de script d'installation | 100 lignes pour Asterisk seul |
| Interface web lourde | API REST Homenichat |
| Configuration via GUI | Fichiers `.conf` + hot-reload |
| Dépendance Sangoma repos | Compilation depuis source |

### Architecture Asterisk Simplifiée

```
┌─────────────────────────────────────────────────────────────────┐
│                        HOMENICHAT-SERV                           │
│                                                                   │
│  ┌─────────────────┐     ┌─────────────────┐                    │
│  │  AmiClient.js   │     │  AriClient.js   │                    │
│  │  (événements)   │     │  (contrôle)     │                    │
│  └────────┬────────┘     └────────┬────────┘                    │
└───────────┼───────────────────────┼─────────────────────────────┘
            │                       │
            │ TCP 5038              │ HTTP 8088
            │                       │
┌───────────▼───────────────────────▼─────────────────────────────┐
│                          ASTERISK                                │
│                                                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ extensions  │  │   pjsip     │  │ chan_quectel│              │
│  │  .conf      │  │   .conf     │  │   .conf     │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│                                                                   │
│  Contextes:                                                       │
│  - from-internal (appels sortants)                               │
│  - from-gsm (appels entrants modem)                              │
│  - from-webrtc (appels WebRTC)                                   │
└─────────────────────────────────────────────────────────────────┘
```

### Dialplan Minimal

```ini
; /etc/asterisk/extensions.conf

[general]
static=yes
writeprotect=no

[globals]
; Variables globales

[from-internal]
; Appels sortants via modem GSM
exten => _0XXXXXXXXX,1,NoOp(Outgoing call to ${EXTEN})
 same => n,Dial(Quectel/quectel-1/${EXTEN},60)
 same => n,Hangup()

; Appels internationaux
exten => _00.,1,NoOp(International call to ${EXTEN})
 same => n,Dial(Quectel/quectel-1/${EXTEN},60)
 same => n,Hangup()

[from-gsm]
; Appels entrants du modem
exten => s,1,NoOp(Incoming GSM call from ${CALLERID(num)})
 same => n,Set(CALLERID(name)=${CALLERID(num)})
 same => n,Dial(PJSIP/2001&PJSIP/2002,30)
 same => n,VoiceMail(100@default)
 same => n,Hangup()

[from-webrtc]
; Appels depuis app WebRTC
exten => _X.,1,NoOp(WebRTC call to ${EXTEN})
 same => n,Goto(from-internal,${EXTEN},1)
```

### Configuration PJSIP Minimale

```ini
; /etc/asterisk/pjsip.conf

[transport-wss]
type=transport
protocol=wss
bind=0.0.0.0:8089
cert_file=/etc/homenichat/ssl/cert.pem
priv_key_file=/etc/homenichat/ssl/key.pem

[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5060

; Extension WebRTC
[2001]
type=endpoint
context=from-webrtc
disallow=all
allow=opus
allow=ulaw
webrtc=yes
auth=2001-auth
aors=2001

[2001-auth]
type=auth
auth_type=userpass
username=2001
password=${EXTENSION_2001_PASSWORD}

[2001]
type=aor
max_contacts=5
```

---

## 5. Services Refactorisés

### DatabaseService → Repositories

```javascript
// src/services/database/index.js
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(process.env.DB_PATH || '/var/lib/homenichat/homenichat.db');

// Exports
module.exports = {
  db,
  UserRepository: require('./UserRepository')(db),
  ChatRepository: require('./ChatRepository')(db),
  MessageRepository: require('./MessageRepository')(db),
  DeviceTokenRepository: require('./DeviceTokenRepository')(db),
};
```

```javascript
// src/services/database/UserRepository.js (~100 lignes)
module.exports = (db) => ({
  findById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },

  findByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  },

  create({ username, password, role = 'user' }) {
    const stmt = db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)');
    const result = stmt.run(username, password, role);
    return this.findById(result.lastInsertRowid);
  },

  updatePassword(id, password) {
    return db.prepare('UPDATE users SET password = ? WHERE id = ?').run(password, id);
  },

  delete(id) {
    return db.prepare('DELETE FROM users WHERE id = ?').run(id);
  },

  list({ limit = 50, offset = 0 } = {}) {
    return db.prepare('SELECT * FROM users LIMIT ? OFFSET ?').all(limit, offset);
  },
});
```

### ModemService → Modules

```javascript
// src/services/modem/index.js
module.exports = {
  ModemManager: require('./ModemManager'),
  ModemDetector: require('./ModemDetector'),
  AtCommandService: require('./AtCommandService'),
  SmsQueueService: require('./SmsQueueService'),
  QuectelConfigService: require('./QuectelConfigService'),
};
```

```javascript
// src/services/modem/ModemDetector.js (~150 lignes)
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

class ModemDetector {
  static KNOWN_MODEMS = {
    '1e0e:9001': { type: 'sim7600', name: 'SIM7600', audioOffset: 4 },
    '2c7c:0125': { type: 'ec25', name: 'EC25', audioOffset: 1 },
  };

  async detectModems() {
    const { stdout } = await execAsync('lsusb');
    const modems = [];

    for (const [usbId, info] of Object.entries(ModemDetector.KNOWN_MODEMS)) {
      if (stdout.includes(usbId)) {
        const ports = await this.findPorts(info.type);
        modems.push({ ...info, usbId, ...ports });
      }
    }

    return modems;
  }

  async findPorts(modemType) {
    const { stdout } = await execAsync('ls /dev/ttyUSB* 2>/dev/null || true');
    const ports = stdout.trim().split('\n').filter(Boolean);

    if (ports.length === 0) return { dataPort: null, audioPort: null };

    // SIM7600: data=USB2, audio=USB4
    // EC25: data=USB2, audio=USB1
    const baseIndex = ports.findIndex(p => p.includes('ttyUSB'));
    const audioOffset = ModemDetector.KNOWN_MODEMS[modemType]?.audioOffset || 1;

    return {
      dataPort: ports[baseIndex + 2] || ports[0],
      audioPort: ports[baseIndex + audioOffset] || ports[1],
    };
  }
}

module.exports = ModemDetector;
```

### AsteriskProvider (remplace FreePBXProvider)

```javascript
// src/providers/voip/AsteriskProvider.js (~300 lignes)
const { EventEmitter } = require('events');
const AmiClient = require('../../services/asterisk/AmiClient');

class AsteriskProvider extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.ami = new AmiClient({
      host: config.ami_host || 'localhost',
      port: config.ami_port || 5038,
      username: config.ami_user || 'homenichat',
      secret: config.ami_secret,
    });
  }

  async connect() {
    await this.ami.connect();
    this.ami.on('event', this.handleEvent.bind(this));
    return true;
  }

  async originate({ from, to, callerName }) {
    return this.ami.action('Originate', {
      Channel: `PJSIP/${from}`,
      Exten: to,
      Context: 'from-internal',
      Priority: 1,
      CallerID: `"${callerName}" <${from}>`,
    });
  }

  async getChannels() {
    const response = await this.ami.action('CoreShowChannels');
    return response.events?.filter(e => e.Event === 'CoreShowChannel') || [];
  }

  async hangup(channel) {
    return this.ami.action('Hangup', { Channel: channel });
  }

  handleEvent(event) {
    switch (event.Event) {
      case 'Newchannel':
        this.emit('call:start', event);
        break;
      case 'Hangup':
        this.emit('call:end', event);
        break;
      case 'DialBegin':
        this.emit('call:ringing', event);
        break;
      case 'DialEnd':
        this.emit('call:answered', event);
        break;
    }
  }
}

module.exports = AsteriskProvider;
```

---

## 6. Migration Progressive

### Phase 1: Structure (Semaine 1)

```bash
# Créer la nouvelle structure
mkdir -p src/{config,routes/admin,services/{database,modem,asterisk,push},providers/{base,sms,whatsapp,voip},middleware,utils}
mkdir -p scripts/install/lib scripts/modem scripts/maintenance
mkdir -p config/{asterisk,systemd}
mkdir -p test/{unit,integration,e2e}
```

### Phase 2: Scripts (Semaine 1-2)

1. Extraire les fonctions de `install.sh` vers `lib/`
2. Créer les scripts modulaires `01-` à `07-`
3. Tester chaque script isolément
4. Créer le nouvel orchestrateur

### Phase 3: Services (Semaine 2-3)

1. Migrer DatabaseService → Repositories
2. Migrer ModemService → modules modem/
3. Créer AsteriskProvider (remplace FreePBX)
4. Migrer PushService → modules push/

### Phase 4: Routes (Semaine 3)

1. Déplacer routes vers src/routes/
2. Splitter admin.js → admin/*.js
3. Migrer vers la nouvelle structure de services

### Phase 5: Validation (Semaine 4)

1. Tests d'intégration complets
2. Documentation mise à jour
3. Migration guide pour utilisateurs existants

---

## 7. Comparaison Avant/Après

| Métrique | Avant | Après |
|----------|-------|-------|
| install.sh | 2317 lignes | ~100 lignes (orchestrateur) |
| Scripts installation | 1 fichier | 10-15 fichiers modulaires |
| FreePBX | Oui (lourd) | Non (Asterisk pur) |
| Dépendances système | PHP, Apache, MariaDB | Aucune |
| DatabaseService | 1201 lignes | 5-6 repositories de ~100-150 lignes |
| ModemService | 1812 lignes | 5-6 modules de ~150-250 lignes |
| server.js | 1132 lignes | ~200 lignes |
| Temps installation | ~30-45 min | ~15-20 min |

---

## 8. Prochaines Étapes

1. **Valider cette architecture** avec l'utilisateur
2. **Créer la structure de dossiers**
3. **Migrer les scripts** en priorité (le plus bloquant)
4. **Migrer les services** progressivement
5. **Tester sur CT999** (environnement de test Proxmox)

---

*Document créé le 2026-01-24 - Branche `refactor`*
