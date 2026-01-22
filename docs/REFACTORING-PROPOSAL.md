# Homenichat-Serv - Proposition de Refactoring

**Date**: 2026-01-21
**Auteur**: Analyse automatisée
**Version**: 1.0

---

## Résumé Exécutif

L'analyse complète du codebase homenichat-serv (144 fichiers, ~37,000 lignes) révèle plusieurs "God Files" qui concentrent trop de responsabilités. Ce document propose une stratégie de refactoring progressive pour améliorer la maintenabilité.

### Statistiques Actuelles

| Catégorie | Fichiers | Lignes | Recommandation |
|-----------|----------|--------|----------------|
| Services | 28 | 16,107 | 150-300 lignes/fichier |
| Routes | 18 | 10,500+ | 100-200 lignes/fichier |
| Providers | 24 | 10,314 | 200-400 lignes/fichier |
| server.js | 1 | 1,132 | <300 lignes |

---

## Fichiers Critiques à Refactorer

### 🔴 Priorité Haute (Urgents)

#### 1. `services/ModemService.js` - 1,812 lignes, 175 méthodes

**Responsabilités mélangées** (6-7 domaines):
- Gestion des modems physiques (détection, configuration)
- Communication AT commands
- Envoi/réception SMS
- Gestion de la queue SMS
- État et statistiques des modems
- Détection des ports USB
- Configuration chan_quectel

**Proposition de découpage:**

```
services/modem/
├── index.js                    # Export principal
├── ModemManager.js             # Orchestration (200 lignes)
├── ModemDetector.js            # Détection USB/ports (250 lignes)
├── AtCommandService.js         # Communication AT (300 lignes)
├── SmsQueueService.js          # Queue d'envoi SMS (200 lignes)
├── ModemStateService.js        # État/stats modems (150 lignes)
├── QuectelConfigService.js     # Config chan_quectel (200 lignes)
└── modemConstants.js           # Constantes/types modems (100 lignes)
```

**Effort estimé**: 2-3 jours

---

#### 2. `services/FreePBXAmiService.js` - 1,770 lignes, 190 méthodes

**Responsabilités mélangées** (7-8 domaines):
- Connexion AMI
- Extensions management
- Trunk management
- Call origination
- CDR queries
- Event handling
- Channel monitoring
- Conference management

**Proposition de découpage:**

```
services/freepbx/
├── index.js                    # Export principal
├── AmiConnectionService.js     # Connexion/reconnexion (200 lignes)
├── ExtensionManager.js         # Gestion extensions (250 lignes)
├── TrunkManager.js             # Gestion trunks (200 lignes)
├── CallOriginationService.js   # Appels sortants (200 lignes)
├── CdrQueryService.js          # Historique appels (200 lignes)
├── AmiEventHandler.js          # Gestion événements (300 lignes)
├── ChannelMonitor.js           # Surveillance canaux (150 lignes)
└── amiConstants.js             # Constantes AMI (100 lignes)
```

**Effort estimé**: 2-3 jours

---

#### 3. `services/DatabaseService.js` - 1,201 lignes, 117 méthodes

**Responsabilités mélangées** (8-10 domaines):
- Users CRUD
- Messages CRUD
- Chats CRUD
- Sessions management
- Device tokens
- Settings
- Modem mappings
- Statistics
- Migrations
- Connection pool

**Proposition de découpage:**

```
services/database/
├── index.js                    # Export principal + pool
├── UserRepository.js           # CRUD users (150 lignes)
├── MessageRepository.js        # CRUD messages (200 lignes)
├── ChatRepository.js           # CRUD chats (150 lignes)
├── SessionRepository.js        # CRUD sessions (150 lignes)
├── DeviceTokenRepository.js    # Push tokens (100 lignes)
├── SettingsRepository.js       # Configuration (100 lignes)
├── MigrationService.js         # Migrations DB (150 lignes)
└── StatisticsRepository.js     # Stats/analytics (100 lignes)
```

**Effort estimé**: 2 jours

---

### 🟡 Priorité Moyenne

#### 4. `routes/admin.js` - 870 lignes, 100 routes

**Proposition de découpage:**

```
routes/admin/
├── index.js                    # Router principal + auth middleware
├── users.js                    # CRUD utilisateurs (100 lignes)
├── providers.js                # Config providers (120 lignes)
├── modems.js                   # Gestion modems (150 lignes)
├── voip.js                     # Config VoIP/extensions (100 lignes)
├── push.js                     # Push notifications (100 lignes)
├── cloud.js                    # Homenichat Cloud (120 lignes)
└── stats.js                    # Statistiques/dashboard (80 lignes)
```

**Effort estimé**: 1 jour

---

#### 5. `server.js` - 1,132 lignes

**Éléments à extraire** (59% du fichier):

```
config/
├── express.js                  # Config Express + middlewares (150 lignes)
├── websocket.js                # Setup WebSocket (100 lignes)
├── swagger.js                  # Documentation API (50 lignes)
└── gracefulShutdown.js         # Gestion arrêt propre (100 lignes)

# server.js résiduel: ~300 lignes (imports, init, start)
```

**Effort estimé**: 1 jour

---

### 🟢 Priorité Basse (Améliorations)

#### 6. Providers - Héritage Incohérent

**Problèmes identifiés:**
- `SmsBridgeProvider` étend `WhatsAppProvider` (ERREUR - devrait étendre `SmsProvider`)
- `GammuProvider`, `AtCommandProvider`, `Vm500SmsProvider` n'étendent pas `SmsProvider`
- `FreePBXProvider` étend `EventEmitter` au lieu de `VoipProvider`

**Proposition:**

```javascript
// Hiérarchie correcte
BaseProvider
├── SmsProvider
│   ├── TwilioProvider
│   ├── OvhProvider
│   ├── GammuProvider
│   ├── AtCommandProvider
│   ├── SmsBridgeProvider
│   └── Vm500SmsProvider
├── WhatsAppProvider
│   ├── BaileysProvider
│   └── MetaCloudProvider
└── VoipProvider
    └── FreePBXProvider
```

**Effort estimé**: 2 jours

---

## Plan d'Exécution Recommandé

### Phase 1: Fondations (Semaine 1)

| Jour | Tâche | Impact |
|------|-------|--------|
| 1-2 | Extraire DatabaseService → repositories | Réduit couplage |
| 3 | Extraire server.js → config/ | Lisibilité |
| 4 | Splitter routes/admin.js | Maintenance routes |

### Phase 2: Services Critiques (Semaine 2)

| Jour | Tâche | Impact |
|------|-------|--------|
| 1-3 | Refactorer ModemService | Maintenabilité modem |
| 4-5 | Refactorer FreePBXAmiService | Maintenabilité VoIP |

### Phase 3: Consolidation (Semaine 3)

| Jour | Tâche | Impact |
|------|-------|--------|
| 1-2 | Corriger hiérarchie Providers | Architecture propre |
| 3-4 | Tests + Documentation | Qualité |
| 5 | Code review + Merge | Validation |

---

## Métriques de Succès

| Métrique | Actuel | Cible |
|----------|--------|-------|
| Lignes max/fichier | 1,812 | <400 |
| Méthodes max/fichier | 190 | <30 |
| server.js lignes | 1,132 | <300 |
| Routes max/fichier | 100 | <20 |

---

## Risques et Mitigations

| Risque | Probabilité | Mitigation |
|--------|-------------|------------|
| Régression fonctionnelle | Moyenne | Tests unitaires AVANT refactoring |
| Perte de contexte | Faible | Commits atomiques, PR séparées |
| Temps sous-estimé | Moyenne | Buffer 20% par phase |

---

## Recommandations Immédiates

### Actions sans refactoring majeur

1. **Ajouter ESLint** avec règle `max-lines` (400) et `max-lines-per-function` (50)
2. **Documenter les fichiers critiques** avec JSDoc avant de toucher au code
3. **Écrire des tests** pour les fonctions critiques de ModemService et FreePBXAmiService
4. **Créer des types TypeScript** (ou JSDoc typedef) pour les structures de données

### Commande pour identifier les fichiers trop gros

```bash
find . -name "*.js" -exec wc -l {} + | sort -rn | head -20
```

---

## Conclusion

Le refactoring proposé réduira la dette technique accumulée et facilitera la maintenance future. L'approche progressive minimise les risques de régression tout en apportant des améliorations mesurables à chaque phase.

**Effort total estimé**: 15-20 jours-homme
**ROI attendu**: Réduction de 50% du temps de maintenance, onboarding développeur facilité

---

*Document généré suite à l'analyse automatisée du codebase homenichat-serv le 2026-01-21*
