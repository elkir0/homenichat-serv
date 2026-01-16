# API Reference - Homenichat

> Documentation complète des endpoints API pour PWA et Applications mobiles
> Version: 1.0.0 | Date: 2026-01-14

---

## Base URL

| Environnement | URL |
|---------------|-----|
| Développement | `http://localhost:3001/api` |
| Production (local) | `http://<IP_SERVEUR>:3001/api` |
| Production (HTTPS) | `https://<DOMAIN>/api` |

---

## Authentification

Tous les endpoints (sauf `/auth/login`) nécessitent un JWT token.

### Headers requis

```
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json
```

### POST /auth/login

Authentifie un utilisateur et retourne un JWT token.

**Request:**
```json
{
  "username": "admin",
  "password": "Homenichat"
}
```

**Response (200):**
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": 1,
    "username": "admin",
    "role": "admin"
  }
}
```

**Response (401):**
```json
{
  "success": false,
  "error": "Invalid credentials"
}
```

---

## Multi-Provider Support

Le backend supporte la connexion simultanée à plusieurs providers (Baileys ET Meta Cloud).

### Header X-Session-Id

Pour cibler un provider spécifique, utilisez le header `X-Session-Id`:

```
X-Session-Id: baileys
```

### GET /providers/status

Liste tous les providers et leur état.

**Response:**
```json
{
  "success": true,
  "activeProvider": "baileys",
  "activeProviders": ["baileys", "meta"],
  "providers": {
    "baileys": {
      "enabled": true,
      "active": true,
      "initialized": true
    },
    "meta": {
      "enabled": true,
      "active": true,
      "initialized": true
    }
  }
}
```

### POST /providers/activate/:provider

Active un provider (sans désactiver les autres).

### POST /providers/deactivate/:provider

Désactive un provider spécifique.

### POST /chats/:chatId/test-send/:provider

Envoie un message via un provider spécifique.

**Exemple:**
```
POST /api/chats/33612345678/test-send/meta
{ "text": "Test via Meta Cloud API" }
```

---

## WhatsApp - Connection

### GET /providers/status

Alias: `GET /whatsapp/status`

Retourne l'état de connexion WhatsApp.

**Response:**
```json
{
  "provider": "baileys",
  "state": "connected",
  "isConnected": true,
  "phoneNumber": "33612345678"
}
```

**States possibles:**
- `disconnected` - Non connecté
- `connecting` - En attente du scan QR
- `connected` - Connecté et opérationnel

### GET /whatsapp/qr

Retourne le QR code pour la connexion WhatsApp (Baileys uniquement).

**Response (si QR disponible):**
```json
{
  "qrCode": "data:image/png;base64,iVBORw0KGgo...",
  "state": "connecting"
}
```

**Response (si déjà connecté):**
```json
{
  "qrCode": null,
  "state": "connected",
  "message": "Already connected"
}
```

### POST /whatsapp/logout

Déconnecte WhatsApp et efface la session.

**Response:**
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

### GET /whatsapp/test

Teste la connexion WhatsApp.

**Response:**
```json
{
  "success": true,
  "message": "Connected to WhatsApp"
}
```

---

## Chats

### GET /chats

Liste tous les chats avec le dernier message.

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| limit | number | 50 | Nombre max de chats |
| offset | number | 0 | Pagination offset |

**Response:**
```json
{
  "chats": [
    {
      "id": "33612345678@s.whatsapp.net",
      "name": "Jean Dupont",
      "unreadCount": 3,
      "timestamp": 1705234567,
      "lastMessage": {
        "text": "Bonjour!",
        "fromMe": false
      },
      "profilePicture": "https://...",
      "source": "whatsapp"
    }
  ],
  "total": 42
}
```

**Types d'ID de chat:**
- `33612345678@s.whatsapp.net` - Chat individuel
- `120363041234567890@g.us` - Groupe WhatsApp
- `33612345678@lid` - Business/Linked ID

### GET /chats/:chatId

Récupère les informations d'un chat.

**Response:**
```json
{
  "id": "33612345678@s.whatsapp.net",
  "name": "Jean Dupont",
  "unreadCount": 0,
  "isGroup": false,
  "participants": null
}
```

### POST /chats/:chatId/read

Marque tous les messages d'un chat comme lus.

**Response:**
```json
{
  "success": true
}
```

---

## Messages

### GET /chats/:chatId/messages

Récupère les messages d'un chat.

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| limit | number | 50 | Nombre de messages |
| before | string | - | Cursor pour pagination (messageId) |

**Response:**
```json
{
  "messages": [
    {
      "id": "3EB0ABC123456789",
      "chatId": "33612345678@s.whatsapp.net",
      "from": "33612345678",
      "to": "33698765432",
      "fromMe": false,
      "timestamp": 1705234567,
      "type": "text",
      "text": "Bonjour!",
      "status": "received",
      "_provider": "baileys"
    }
  ],
  "hasMore": true,
  "cursor": "3EB0ABC123456788"
}
```

### POST /chats/:chatId/messages

Envoie un message texte.

**Request:**
```json
{
  "text": "Bonjour, comment allez-vous?"
}
```

**Response:**
```json
{
  "success": true,
  "messageId": "3EB0DEF987654321",
  "timestamp": 1705234890
}
```

### POST /chats/:chatId/messages/media

Envoie un message média (image, vidéo, audio, document).

**Request (multipart/form-data):**
```
file: <binary>
type: "image" | "video" | "audio" | "document"
caption: "Description optionnelle"
```

**OU Request (JSON avec URL):**
```json
{
  "type": "image",
  "url": "https://example.com/image.jpg",
  "caption": "Description optionnelle"
}
```

**Response:**
```json
{
  "success": true,
  "messageId": "3EB0GHI123456789",
  "timestamp": 1705234900
}
```

---

## Actions sur Messages

### POST /chats/:chatId/messages/:messageId/read

Marque un message spécifique comme lu.

**Exemple:**
```
POST /api/chats/33612345678@s.whatsapp.net/messages/3EB0ABC123/read
```

**Response:**
```json
{
  "success": true
}
```

### POST /chats/:chatId/messages/:messageId/reaction

Envoie une réaction emoji sur un message.

**Exemple:**
```
POST /api/chats/33612345678@s.whatsapp.net/messages/3EB0ABC123/reaction
```

**Request:**
```json
{
  "emoji": "👍"
}
```

**Pour supprimer une réaction:**
```json
{
  "emoji": ""
}
```

**Response:**
```json
{
  "success": true
}
```

---

## Contacts

### GET /contacts/check/:phoneNumber

Vérifie si un numéro est enregistré sur WhatsApp.

**Response (existe):**
```json
{
  "exists": true,
  "jid": "33612345678@s.whatsapp.net"
}
```

**Response (n'existe pas):**
```json
{
  "exists": false
}
```

---

## Présence (Typing Indicator)

### POST /chats/:chatId/presence

Envoie un indicateur de présence (typing).

**Request:**
```json
{
  "type": "typing"
}
```

**Pour arrêter:**
```json
{
  "type": "paused"
}
```

**Response:**
```json
{
  "success": true
}
```

---

## WebSocket Events

Connexion: `ws://<host>:3001` ou `wss://<host>/ws`

### Événements émis par le serveur

#### `message`

Nouveau message reçu ou envoyé.

```json
{
  "event": "message",
  "data": {
    "id": "3EB0ABC123456789",
    "chatId": "33612345678@s.whatsapp.net",
    "from": "33612345678",
    "to": "33698765432",
    "fromMe": false,
    "timestamp": 1705234567,
    "type": "text",
    "text": "Nouveau message!",
    "status": "received",
    "_provider": "baileys",
    "pushName": "Jean"
  }
}
```

#### `connection.update`

Changement d'état de connexion WhatsApp.

```json
{
  "event": "connection.update",
  "data": {
    "status": "connected",
    "phoneNumber": "33698765432"
  }
}
```

```json
{
  "event": "connection.update",
  "data": {
    "status": "connecting",
    "qrCode": "data:image/png;base64,..."
  }
}
```

#### `chats.updated`

Mise à jour des chats (après sync historique).

```json
{
  "event": "chats.updated",
  "data": {
    "count": 150,
    "source": "history_sync"
  }
}
```

---

## Codes d'erreur

| Code | Signification |
|------|---------------|
| 400 | Bad Request - Paramètres invalides |
| 401 | Unauthorized - Token manquant ou invalide |
| 403 | Forbidden - Permissions insuffisantes |
| 404 | Not Found - Ressource non trouvée |
| 409 | Conflict - Action impossible (ex: déjà connecté) |
| 500 | Internal Server Error |
| 503 | Service Unavailable - WhatsApp non connecté |

**Format d'erreur standard:**
```json
{
  "success": false,
  "error": "Description de l'erreur",
  "code": "ERROR_CODE"
}
```

---

## Types de données unifiés

### Message

```typescript
interface Message {
  id: string;              // ID unique du message
  chatId: string;          // ID du chat (JID)
  from: string;            // Numéro expéditeur (sans @...)
  to: string;              // Numéro destinataire
  fromMe: boolean;         // true si envoyé par nous
  timestamp: number;       // Unix timestamp (secondes)
  type: MessageType;       // Type de contenu
  text?: string;           // Contenu texte
  media?: MediaInfo;       // Info média si applicable
  status: MessageStatus;   // Statut du message
  _provider: 'baileys' | 'meta_cloud';
  _raw?: object;           // Données brutes (debug)
  pushName?: string;       // Nom affiché de l'expéditeur
}

type MessageType = 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'contact' | 'location';

type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'received' | 'failed';

interface MediaInfo {
  mimetype?: string;
  fileLength?: number;
  fileName?: string;
  caption?: string;
  hasMedia: boolean;
}
```

### Chat

```typescript
interface Chat {
  id: string;              // ID du chat (JID)
  name: string;            // Nom du chat
  unreadCount: number;     // Messages non lus
  timestamp: number;       // Dernier message timestamp
  lastMessage?: {
    text: string;
    fromMe: boolean;
  };
  profilePicture?: string; // URL photo de profil
  isGroup: boolean;        // true si groupe
  source: 'whatsapp' | 'sms' | 'voip';
}
```

### ConnectionState

```typescript
interface ConnectionState {
  provider: 'baileys' | 'meta_cloud';
  state: 'disconnected' | 'connecting' | 'connected';
  isConnected: boolean;
  phoneNumber?: string;    // Numéro connecté (si connected)
  qrCode?: string;         // Data URL du QR (si connecting)
}
```

---

## Exemples d'intégration

### JavaScript/TypeScript (PWA/React Native)

```typescript
class HomenichatAPI {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async login(username: string, password: string) {
    const res = await fetch(`${this.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (data.success) {
      this.token = data.token;
    }
    return data;
  }

  private async request(endpoint: string, options: RequestInit = {}) {
    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
        ...options.headers
      }
    });
    return res.json();
  }

  // Chats
  getChats(limit = 50) {
    return this.request(`/chats?limit=${limit}`);
  }

  getMessages(chatId: string, limit = 50) {
    return this.request(`/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}`);
  }

  sendMessage(chatId: string, text: string) {
    return this.request(`/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text })
    });
  }

  markAsRead(chatId: string) {
    return this.request(`/chats/${encodeURIComponent(chatId)}/read`, {
      method: 'POST'
    });
  }

  sendReaction(chatId: string, messageId: string, emoji: string) {
    return this.request(`/messages/${messageId}/reaction`, {
      method: 'POST',
      body: JSON.stringify({ chatId, emoji })
    });
  }

  // WhatsApp
  getWhatsAppStatus() {
    return this.request('/whatsapp/status');
  }

  getQRCode() {
    return this.request('/whatsapp/qr');
  }
}
```

### WebSocket connection

```typescript
class HomenichatWebSocket {
  private ws: WebSocket;
  private handlers: Map<string, Function[]> = new Map();

  constructor(url: string, token: string) {
    this.ws = new WebSocket(`${url}?token=${token}`);

    this.ws.onmessage = (event) => {
      const { event: eventName, data } = JSON.parse(event.data);
      const callbacks = this.handlers.get(eventName) || [];
      callbacks.forEach(cb => cb(data));
    };
  }

  on(event: string, callback: Function) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(callback);
  }
}

// Usage
const ws = new HomenichatWebSocket('ws://localhost:3001', token);

ws.on('message', (msg) => {
  console.log('New message:', msg);
  // Update UI
});

ws.on('connection.update', (state) => {
  console.log('WhatsApp state:', state.status);
});
```

---

*Document généré le 2026-01-14*
*API Version 1.0.0 - Homenichat*
