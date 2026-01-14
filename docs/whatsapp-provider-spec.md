# WhatsApp Provider Unified Interface - Spécifications

> Document de référence pour l'implémentation de l'interface abstraite WhatsAppProvider
> Version 1.0 - Janvier 2026

---

## Table des matières

1. [Objectif](#objectif)
2. [Exigences Meta Cloud API 2025-2026](#exigences-meta-cloud-api-2025-2026)
3. [Comparaison Baileys vs Meta Cloud](#comparaison-baileys-vs-meta-cloud)
4. [Interface Unifiée](#interface-unifiée)
5. [Mapping des Endpoints](#mapping-des-endpoints)
6. [Structures de Données](#structures-de-données)
7. [Plan d'Implémentation](#plan-dimplémentation)

---

## Objectif

Créer une interface `WhatsAppProvider` abstraite permettant à l'application mobile d'utiliser **indifféremment** Baileys ou Meta Cloud API sans aucune modification côté client.

```
┌─────────────────────────────────────────┐
│            APP MOBILE                    │
│    (ne connaît PAS l'implémentation)     │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│     INTERFACE WhatsAppProvider           │
│     (contrat API unifié)                 │
└─────────────────┬───────────────────────┘
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
┌───────────────┐   ┌───────────────┐
│ BaileysProvider│   │MetaCloudProvider│
│  (undercover) │   │   (officiel)   │
└───────────────┘   └───────────────┘
```

---

## Exigences Meta Cloud API 2025-2026

### Changements majeurs (Sources: [Wati](https://www.wati.io/en/blog/whatsapp-business-api/whatsapp-api-access/), [Chatarmin](https://chatarmin.com/en/blog/whatsapp-cloudapi))

| Date | Changement |
|------|------------|
| **Oct 2025** | Fin du support On-Premises API → Cloud API obligatoire |
| **Juil 2025** | Nouveau modèle de tarification par message (pas par conversation) |
| **Juil 2025** | Templates utilitaires gratuits dans fenêtre 24h |
| **Oct 2025** | Limites de messaging au niveau portfolio (pas par numéro) |
| **2026** | Compliance renforcée, opt-in obligatoire |

### Prérequis Meta Cloud API

| Exigence | Description |
|----------|-------------|
| **Facebook Business Manager** | Compte vérifié obligatoire |
| **Numéro de téléphone** | Dédié, vérifié par Meta |
| **Display Name** | Approuvé par Meta |
| **Templates** | Pré-approuvés pour messages initiés par l'entreprise |
| **Webhook HTTPS** | Endpoint public avec certificat SSL valide |
| **Access Token** | Token d'accès permanent (System User) |

### Limites de messaging

| Tier | Limite (conversations/24h) |
|------|---------------------------|
| Non vérifié | 250 |
| Vérifié (tier 1) | 1,000 |
| Tier 2 | 10,000 |
| Tier 3 | 100,000 |
| Illimité | Sur demande |

### Types de messages et tarification (2025-2026)

| Type | Initiation | Tarification |
|------|------------|--------------|
| **Service** | Client initie | Gratuit (réponse dans 24h) |
| **Utility** | Entreprise initie | Par message (gratuit si dans fenêtre 24h) |
| **Marketing** | Entreprise initie | Par message |
| **Authentication** | Entreprise initie | Par message |

---

## Comparaison Baileys vs Meta Cloud

### Authentification

| Aspect | Baileys | Meta Cloud API |
|--------|---------|----------------|
| **Méthode** | QR Code (WhatsApp Web) | Access Token OAuth |
| **Session** | Fichiers locaux (creds.json) | Token permanent |
| **Expiration** | Peut être révoquée par WA | Token ne expire pas |
| **Multi-device** | Non (1 session) | Oui (API indépendante) |

### Envoi de messages

| Aspect | Baileys | Meta Cloud API |
|--------|---------|----------------|
| **Endpoint** | `sock.sendMessage(jid, content)` | `POST /v17.0/{phone_id}/messages` |
| **Format destinataire** | `590691234567@s.whatsapp.net` | `590691234567` (numéro seul) |
| **Templates** | Non requis | Requis hors fenêtre 24h |
| **Rate limiting** | Aucun officiel | Tiers Meta |

### Réception de messages

| Aspect | Baileys | Meta Cloud API |
|--------|---------|----------------|
| **Méthode** | Event `messages.upsert` | Webhook POST |
| **Temps réel** | Socket WebSocket | HTTP callback |
| **Historique** | Sync complet possible | Non disponible |

### Fonctionnalités

| Fonctionnalité | Baileys | Meta Cloud |
|----------------|---------|------------|
| Envoyer texte | ✅ | ✅ |
| Envoyer image | ✅ | ✅ |
| Envoyer vidéo | ✅ | ✅ |
| Envoyer audio | ✅ | ✅ |
| Envoyer document | ✅ | ✅ |
| Envoyer localisation | ✅ | ✅ |
| Envoyer contact | ✅ | ✅ |
| Messages interactifs | ❌ | ✅ (boutons, listes) |
| Templates | ❌ | ✅ (obligatoire) |
| Réactions | ✅ | ✅ |
| Statut lu/livré | ✅ | ✅ |
| Historique complet | ✅ | ❌ |
| Groupes | ✅ | ✅ (limité) |
| Appels | ❌ | ❌ |

---

## Interface Unifiée

### Endpoints API Homenichat (à exposer)

Ces endpoints doivent fonctionner **identiquement** quelle que soit l'implémentation backend.

```
# Connexion
GET    /api/whatsapp/status              → État de connexion
GET    /api/whatsapp/qr                  → QR code (Baileys) ou URL auth (Meta)
POST   /api/whatsapp/connect             → Initier connexion
POST   /api/whatsapp/disconnect          → Déconnecter

# Messages
POST   /api/whatsapp/send                → Envoyer un message
GET    /api/whatsapp/messages/:chatId    → Récupérer messages d'un chat

# Chats
GET    /api/whatsapp/chats               → Liste des conversations
GET    /api/whatsapp/chats/:chatId       → Détails d'une conversation

# Contacts
GET    /api/whatsapp/contacts            → Liste des contacts
POST   /api/whatsapp/check-number        → Vérifier si numéro sur WhatsApp

# Webhooks (Meta Cloud uniquement, interne)
POST   /api/whatsapp/webhook             → Réception webhook Meta
GET    /api/whatsapp/webhook             → Vérification webhook Meta
```

### Interface TypeScript/JavaScript

```javascript
/**
 * Interface abstraite WhatsAppProvider
 * Toutes les implémentations (Baileys, MetaCloud) doivent respecter ce contrat
 */
class WhatsAppProvider {

  // ==================== CONNEXION ====================

  /**
   * Initialise le provider avec la configuration
   * @returns {Promise<void>}
   */
  async initialize(config) {}

  /**
   * Retourne l'état de connexion
   * @returns {Promise<ConnectionState>}
   */
  async getConnectionState() {}
  // ConnectionState: { status: 'disconnected'|'connecting'|'connected', qrCode?: string, phoneNumber?: string }

  /**
   * Retourne le QR code pour l'authentification (Baileys)
   * ou l'URL d'autorisation (Meta Cloud)
   * @returns {Promise<AuthMethod>}
   */
  async getAuthMethod() {}
  // AuthMethod: { type: 'qr'|'oauth', data: string }

  /**
   * Déconnecte et nettoie la session
   * @returns {Promise<void>}
   */
  async disconnect() {}

  // ==================== MESSAGES ====================

  /**
   * Envoie un message texte
   * @param {string} to - Numéro destinataire (format international sans +)
   * @param {string} text - Contenu du message
   * @param {SendOptions} options - Options (replyTo, etc.)
   * @returns {Promise<SendResult>}
   */
  async sendText(to, text, options = {}) {}
  // SendResult: { success: boolean, messageId: string, timestamp: number }

  /**
   * Envoie un média (image, vidéo, audio, document)
   * @param {string} to - Numéro destinataire
   * @param {MediaPayload} media - Données du média
   * @param {SendOptions} options - Options
   * @returns {Promise<SendResult>}
   */
  async sendMedia(to, media, options = {}) {}
  // MediaPayload: { type: 'image'|'video'|'audio'|'document', url?: string, buffer?: Buffer, caption?: string, filename?: string }

  /**
   * Envoie une localisation
   * @param {string} to - Numéro destinataire
   * @param {LocationPayload} location - Coordonnées
   * @returns {Promise<SendResult>}
   */
  async sendLocation(to, location, options = {}) {}
  // LocationPayload: { latitude: number, longitude: number, name?: string, address?: string }

  /**
   * Envoie un contact
   * @param {string} to - Numéro destinataire
   * @param {ContactPayload} contact - Données du contact
   * @returns {Promise<SendResult>}
   */
  async sendContact(to, contact, options = {}) {}
  // ContactPayload: { name: string, phone: string }

  /**
   * Récupère les messages d'un chat
   * @param {string} chatId - ID du chat
   * @param {number} limit - Nombre max de messages
   * @param {string} before - Pagination (messageId)
   * @returns {Promise<Message[]>}
   */
  async getMessages(chatId, limit = 50, before = null) {}

  // ==================== CHATS ====================

  /**
   * Récupère la liste des conversations
   * @returns {Promise<Chat[]>}
   */
  async getChats() {}

  /**
   * Récupère les détails d'un chat
   * @param {string} chatId - ID du chat
   * @returns {Promise<Chat>}
   */
  async getChat(chatId) {}

  /**
   * Marque un chat comme lu
   * @param {string} chatId - ID du chat
   * @returns {Promise<void>}
   */
  async markAsRead(chatId) {}

  // ==================== CONTACTS ====================

  /**
   * Vérifie si un numéro est sur WhatsApp
   * @param {string} phoneNumber - Numéro à vérifier
   * @returns {Promise<CheckResult>}
   */
  async checkNumber(phoneNumber) {}
  // CheckResult: { exists: boolean, jid?: string }

  // ==================== ÉVÉNEMENTS ====================

  /**
   * Définit le handler d'événements
   * @param {EventHandler} handler - Callback pour les événements
   */
  setEventHandler(handler) {}

  // Événements émis:
  // - 'message.received' → Message (nouveau message entrant)
  // - 'message.sent' → Message (message envoyé confirmé)
  // - 'message.status' → { messageId, status: 'sent'|'delivered'|'read' }
  // - 'connection.update' → ConnectionState
  // - 'chat.updated' → Chat
}
```

---

## Structures de Données

### Message (format unifié)

```javascript
{
  id: string,                    // ID unique du message
  chatId: string,                // ID du chat (format normalisé)
  from: string,                  // Expéditeur (numéro)
  to: string,                    // Destinataire (numéro)
  fromMe: boolean,               // Envoyé par nous
  timestamp: number,             // Unix timestamp (secondes)
  type: 'text' | 'image' | 'video' | 'audio' | 'document' | 'location' | 'contact',

  // Contenu selon le type
  text?: string,                 // Pour type='text'
  media?: {                      // Pour types média
    url: string,
    mimeType: string,
    caption?: string,
    filename?: string,           // Pour documents
  },
  location?: {                   // Pour type='location'
    latitude: number,
    longitude: number,
    name?: string,
    address?: string,
  },
  contact?: {                    // Pour type='contact'
    name: string,
    phone: string,
  },

  // Métadonnées
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed',
  replyTo?: string,              // ID du message auquel on répond

  // Infos provider (interne, pas exposé à l'app)
  _provider: 'baileys' | 'meta-cloud',
  _raw?: object,                 // Données brutes du provider
}
```

### Chat (format unifié)

```javascript
{
  id: string,                    // ID unique (numéro normalisé ou group ID)
  type: 'private' | 'group',
  name: string,                  // Nom du contact ou du groupe
  phone?: string,                // Numéro (pour private)
  profilePicture?: string,       // URL de la photo
  lastMessage?: Message,         // Dernier message
  lastMessageTime: number,       // Timestamp du dernier message
  unreadCount: number,           // Messages non lus

  // Métadonnées groupe
  participants?: string[],       // Pour les groupes
  admins?: string[],             // Admins du groupe

  _provider: 'baileys' | 'meta-cloud',
}
```

### ConnectionState

```javascript
{
  status: 'disconnected' | 'connecting' | 'connected',
  qrCode?: string,               // Data URL du QR (Baileys)
  oauthUrl?: string,             // URL OAuth (Meta Cloud)
  phoneNumber?: string,          // Numéro connecté
  displayName?: string,          // Nom affiché
  error?: string,                // Message d'erreur si applicable
}
```

---

## Mapping des Endpoints

### Envoi de message texte

| Aspect | Baileys | Meta Cloud API |
|--------|---------|----------------|
| **Méthode** | `sock.sendMessage(jid, { text })` | `POST /v17.0/{phone_id}/messages` |
| **Destinataire** | `590691234567@s.whatsapp.net` | `"to": "590691234567"` |
| **Corps** | `{ text: "Hello" }` | `{ "type": "text", "text": { "body": "Hello" } }` |

#### Baileys
```javascript
await sock.sendMessage('590691234567@s.whatsapp.net', {
  text: 'Hello World'
});
```

#### Meta Cloud
```javascript
await axios.post(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
  messaging_product: 'whatsapp',
  recipient_type: 'individual',
  to: '590691234567',
  type: 'text',
  text: { body: 'Hello World' }
}, {
  headers: { Authorization: `Bearer ${accessToken}` }
});
```

### Envoi de média (image)

#### Baileys
```javascript
await sock.sendMessage('590691234567@s.whatsapp.net', {
  image: { url: 'https://example.com/image.jpg' },
  caption: 'Check this out!'
});
```

#### Meta Cloud
```javascript
await axios.post(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
  messaging_product: 'whatsapp',
  to: '590691234567',
  type: 'image',
  image: {
    link: 'https://example.com/image.jpg',
    caption: 'Check this out!'
  }
});
```

### Réception de messages

#### Baileys (Event)
```javascript
sock.ev.on('messages.upsert', ({ messages }) => {
  for (const msg of messages) {
    const normalized = {
      id: msg.key.id,
      chatId: msg.key.remoteJid,
      from: msg.key.participant || msg.key.remoteJid,
      fromMe: msg.key.fromMe,
      timestamp: msg.messageTimestamp,
      type: getMessageType(msg.message),
      text: msg.message?.conversation || msg.message?.extendedTextMessage?.text,
      // ...
    };
    emit('message.received', normalized);
  }
});
```

#### Meta Cloud (Webhook)
```javascript
app.post('/webhook', (req, res) => {
  const { entry } = req.body;
  for (const e of entry) {
    for (const change of e.changes) {
      if (change.value.messages) {
        for (const msg of change.value.messages) {
          const normalized = {
            id: msg.id,
            chatId: msg.from,
            from: msg.from,
            fromMe: false,
            timestamp: parseInt(msg.timestamp),
            type: msg.type,
            text: msg.text?.body,
            // ...
          };
          emit('message.received', normalized);
        }
      }
    }
  }
  res.sendStatus(200);
});
```

---

## Plan d'Implémentation

### Phase 1: Refactoring BaileysProvider (existant)

| Tâche | Priorité | Complexité |
|-------|----------|------------|
| Vérifier que BaileysProvider implémente l'interface | Haute | Faible |
| Normaliser les formats de données | Haute | Moyenne |
| Ajouter les méthodes manquantes | Moyenne | Faible |
| Tests unitaires | Moyenne | Moyenne |

### Phase 2: MetaCloudProvider (nouveau)

| Tâche | Priorité | Complexité |
|-------|----------|------------|
| Créer `/providers/meta/MetaCloudProvider.js` | Haute | Moyenne |
| Implémenter authentification OAuth | Haute | Moyenne |
| Implémenter envoi de messages | Haute | Faible |
| Implémenter webhook réception | Haute | Moyenne |
| Implémenter templates (obligatoire hors 24h) | Haute | Moyenne |
| Gestion des médias (upload/download) | Moyenne | Moyenne |
| Tests unitaires | Moyenne | Moyenne |

### Phase 3: ProviderManager (unification)

| Tâche | Priorité | Complexité |
|-------|----------|------------|
| Factory pattern pour instanciation | Haute | Faible |
| Configuration YAML pour choix provider | Haute | Faible |
| Switch dynamique entre providers | Moyenne | Moyenne |
| Fallback automatique (optionnel) | Basse | Haute |

### Phase 4: API Routes (unification)

| Tâche | Priorité | Complexité |
|-------|----------|------------|
| Refactorer `/api/whatsapp/*` pour utiliser interface | Haute | Faible |
| Endpoint `/api/whatsapp/webhook` pour Meta | Haute | Faible |
| Documentation OpenAPI/Swagger | Basse | Moyenne |

---

## Fichiers à créer/modifier

### Nouveaux fichiers

```
/providers/
├── base/
│   └── WhatsAppProvider.js      # Interface abstraite (MODIFIER)
├── baileys/
│   └── BaileysProvider.js       # Existant (VÉRIFIER conformité)
└── meta/
    ├── MetaCloudProvider.js     # NOUVEAU
    ├── MetaWebhookHandler.js    # NOUVEAU
    └── MetaTemplateService.js   # NOUVEAU (gestion templates)

/routes/
└── whatsapp.js                  # Routes unifiées (NOUVEAU ou REFACTOR)

/docs/
└── whatsapp-provider-spec.md    # CE FICHIER
```

### Configuration

```yaml
# config/providers.yaml
whatsapp:
  active: baileys  # ou 'meta-cloud'

  baileys:
    enabled: true
    sessionPath: ./sessions/baileys

  meta-cloud:
    enabled: false
    phoneNumberId: "YOUR_PHONE_NUMBER_ID"
    accessToken: "YOUR_ACCESS_TOKEN"
    webhookVerifyToken: "YOUR_VERIFY_TOKEN"
    businessAccountId: "YOUR_BUSINESS_ACCOUNT_ID"
```

---

## Sources

- [Wati - WhatsApp API Access 2026](https://www.wati.io/en/blog/whatsapp-business-api/whatsapp-api-access/)
- [Chatarmin - WhatsApp Cloud API Setup](https://chatarmin.com/en/blog/whatsapp-cloudapi)
- [YCloud - Webhook Examples](https://docs.ycloud.com/reference/whatsapp-inbound-message-webhook-examples)
- [EngageLab - WhatsApp API Pricing](https://www.engagelab.com/blog/whatsapp-api-pricing)
- [GMCS - WhatsApp API Compliance 2026](https://gmcsco.com/your-simple-guide-to-whatsapp-api-compliance-2026/)

---

*Document créé le 14 janvier 2026*
*Projet Homenichat - Interface WhatsAppProvider Unifiée*
