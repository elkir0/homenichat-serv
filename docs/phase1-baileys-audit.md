# Phase 1 - Audit de conformité BaileysProvider

> Document de suivi pour la mise en conformité du BaileysProvider avec l'interface unifiée
> Date: 2026-01-14

---

## Résumé

| Catégorie | Interface Base | BaileysProvider | Conformité |
|-----------|----------------|-----------------|------------|
| Configuration | 3 méthodes | 1 implémentée | 33% |
| Messages | 6 méthodes | 4 implémentées | 67% |
| Chats | 4 méthodes | 2 implémentées | 50% |
| Contacts | 4 méthodes | 2 implémentées | 50% |
| Connexion | 3 méthodes | 3 implémentées | 100% |
| Webhooks | 2 méthodes | 0 implémentées | 0% (N/A pour Baileys) |
| Utilitaires | 5 méthodes | 3 implémentées | 60% |

---

## Audit détaillé

### Configuration

| Méthode | Interface | BaileysProvider | Action |
|---------|-----------|-----------------|--------|
| `initialize(config)` | ✅ | ✅ Implémenté | OK |
| `validateConfig()` | ✅ | ❌ Non implémenté | À AJOUTER (retourner `{valid: true}` par défaut) |
| `testConnection()` | ✅ | ❌ Non implémenté | À AJOUTER (vérifier `sock && connectionState`) |

### Messages

| Méthode | Interface | BaileysProvider | Action |
|---------|-----------|-----------------|--------|
| `sendTextMessage(to, text, options)` | ✅ | ✅ Implémenté | OK |
| `sendMediaMessage(to, media, options)` | ✅ | ✅ Implémenté | OK |
| `sendDocument(to, document, options)` | ✅ | ⚠️ Via sendMediaMessage | À SÉPARER pour clarté |
| `getMessages(chatId, limit, options)` | ✅ | ✅ Implémenté | OK |
| `markMessageAsRead(messageId)` | ✅ | ❌ Non implémenté | À AJOUTER |
| `sendReaction(messageId, emoji)` | ✅ | ❌ Non implémenté | À AJOUTER |

### Chats

| Méthode | Interface | BaileysProvider | Action |
|---------|-----------|-----------------|--------|
| `getChats(options)` | ✅ | ✅ Implémenté | OK |
| `getChatInfo(chatId)` | ✅ | ✅ Implémenté | OK |
| `markChatAsRead(chatId)` | ✅ | ❌ Non implémenté | À AJOUTER |
| `archiveChat(chatId, archive)` | ✅ | ❌ Non implémenté | OPTIONNEL (basse priorité) |

### Contacts

| Méthode | Interface | BaileysProvider | Action |
|---------|-----------|-----------------|--------|
| `getContacts()` | ✅ | ⚠️ Retourne `[]` (TODO) | OPTIONNEL |
| `getContactInfo(contactId)` | ✅ | ❌ Non implémenté | OPTIONNEL |
| `checkNumberExists(phoneNumber)` | ✅ | ✅ Implémenté | OK |
| `getProfilePicture(contactId)` | ✅ | ❌ Non implémenté | OPTIONNEL |

### Connexion

| Méthode | Interface | BaileysProvider | Action |
|---------|-----------|-----------------|--------|
| `getConnectionState()` | ✅ | ✅ Implémenté | OK |
| `getQRCode()` | ✅ | ✅ Implémenté | OK |
| `logout()` | ✅ | ✅ Implémenté | OK |

### Webhooks (N/A pour Baileys - events internes)

| Méthode | Interface | BaileysProvider | Action |
|---------|-----------|-----------------|--------|
| `setupWebhook(url, options)` | ✅ | N/A | IGNORER (events Baileys) |
| `handleWebhook(data)` | ✅ | N/A | IGNORER (events Baileys) |

### Utilitaires

| Méthode | Interface | BaileysProvider | Action |
|---------|-----------|-----------------|--------|
| `normalizePhoneNumber(phone)` | ✅ Classe base | `formatJid()` existe | RENOMMER pour cohérence |
| `normalizeMessage(rawMessage)` | ✅ | ✅ Implémenté | VÉRIFIER format retour |
| `normalizeChat(rawChat)` | ✅ | ❌ Non implémenté | À AJOUTER |
| `normalizeContact(rawContact)` | ✅ | ❌ Non implémenté | OPTIONNEL |
| `getProviderName()` | ✅ | ✅ Implémenté | OK |
| `getCapabilities()` | ✅ Classe base | Non override | OPTIONNEL |
| `getLimits()` | ✅ Classe base | Non override | OPTIONNEL |

---

## Actions prioritaires (Phase 1)

### HAUTE priorité (bloquant pour interface unifiée)

1. **`validateConfig()`** - Ajouter méthode simple
2. **`testConnection()`** - Ajouter méthode simple
3. **`markMessageAsRead(messageId)`** - Important pour UX
4. **`markChatAsRead(chatId)`** - Important pour UX
5. **`normalizeMessage()`** - Vérifier format de retour conforme à spec

### MOYENNE priorité

6. **`sendReaction(messageId, emoji)`** - Feature WhatsApp standard
7. **`sendDocument()`** - Séparer de sendMediaMessage
8. **`normalizeChat()`** - Pour cohérence

### BASSE priorité (optionnel)

9. `getContacts()` - Implémentation réelle
10. `getContactInfo()` - Info contact
11. `getProfilePicture()` - Photo profil
12. `archiveChat()` - Archive
13. `getCapabilities()` - Override spécifique Baileys
14. `getLimits()` - Override spécifique Baileys

---

## Vérification format normalizeMessage()

### Format actuel (BaileysProvider ligne 401-427)

```javascript
{
  id: message.key.id,
  from: message.key.remoteJid,           // ⚠️ chatId dans spec
  sender: message.key.participant || ..., // ✅ OK
  isFromMe: message.key.fromMe,          // ⚠️ fromMe dans spec
  pushName: message.pushName,            // ❌ Pas dans spec
  timestamp: message.messageTimestamp,   // ✅ OK
  type: realType,                        // ✅ OK
  content: this.getMessageText(message), // ⚠️ text dans spec
  message: message.message,              // ⚠️ _raw dans spec
  status: 'received'                     // ✅ OK
}
```

### Format attendu (spec)

```javascript
{
  id: string,
  chatId: string,        // ← from → chatId
  from: string,          // ← sender → from (numéro)
  to: string,            // ← MANQUANT
  fromMe: boolean,       // ← isFromMe → fromMe
  timestamp: number,
  type: 'text' | 'image' | ...,
  text?: string,         // ← content → text
  media?: {...},
  status: string,
  _provider: 'baileys',
  _raw?: object
}
```

### Mapping à faire

| Actuel | Spec | Action |
|--------|------|--------|
| `from` | `chatId` | Renommer |
| `sender` | `from` | Renommer |
| - | `to` | Ajouter (numéro connecté) |
| `isFromMe` | `fromMe` | Renommer |
| `content` | `text` | Renommer |
| `message` | `_raw` | Renommer |
| - | `_provider` | Ajouter `'baileys'` |
| `pushName` | - | Garder (utile) ou déplacer dans `_raw` |

---

## Plan d'implémentation Phase 1

### Étape 1.1 - Méthodes simples (5 min)

```javascript
// validateConfig() - ligne ~50
async validateConfig() {
  return { valid: true, errors: [] };
}

// testConnection() - ligne ~50
async testConnection() {
  const connected = this.sock && this.connectionState === 'connected';
  return {
    success: connected,
    message: connected ? 'Connected to WhatsApp' : 'Not connected'
  };
}
```

### Étape 1.2 - markMessageAsRead / markChatAsRead (10 min)

```javascript
// markMessageAsRead(messageId) - utilise sock.readMessages
async markMessageAsRead(messageId) {
  // Nécessite de retrouver le chatId du message
  // Peut être complexe - voir implémentation
}

// markChatAsRead(chatId) - utilise sock.readMessages
async markChatAsRead(chatId) {
  if (!this.sock || this.connectionState !== 'connected') {
    return { success: false };
  }
  try {
    await this.sock.readMessages([{ remoteJid: chatId, id: 'latest' }]);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
```

### Étape 1.3 - sendReaction (5 min)

```javascript
async sendReaction(messageId, emoji, chatId) {
  if (!this.sock || this.connectionState !== 'connected') {
    throw new Error('Not connected');
  }
  await this.sock.sendMessage(chatId, {
    react: { text: emoji, key: { id: messageId, remoteJid: chatId } }
  });
  return { success: true };
}
```

### Étape 1.4 - Normalisation format message (15 min)

Modifier `normalizeMessage()` pour retourner le format spec.

### Étape 1.5 - Tests manuels (10 min)

Vérifier que tout fonctionne via l'admin panel.

---

## Checklist finale Phase 1

- [x] `validateConfig()` ajouté ✅
- [x] `testConnection()` ajouté ✅
- [x] `markMessageAsRead()` ajouté ✅
- [x] `markChatAsRead()` ajouté ✅
- [x] `sendReaction()` ajouté ✅
- [x] `normalizeMessage()` format corrigé ✅
- [x] Documentation API créée (`/docs/api-reference.md`) ✅
- [ ] Tests manuels passés
- [x] Document mis à jour ✅

---

## Résumé des modifications (2026-01-14)

### Méthodes ajoutées au BaileysProvider

1. **`validateConfig()`** - Ligne ~36
   - Retourne `{ valid: true, errors: [] }`

2. **`testConnection()`** - Ligne ~45
   - Vérifie `sock && connectionState === 'connected'`

3. **`markChatAsRead(chatId)`** - Ligne ~577
   - Utilise `sock.readMessages()` avec `id: undefined`
   - Met à jour le compteur local via `chatStorage`

4. **`markMessageAsRead(chatId, messageId)`** - Ligne ~600
   - Utilise `sock.readMessages()` avec l'ID spécifique

5. **`sendReaction(chatId, messageId, emoji)`** - Ligne ~622
   - Utilise `sock.sendMessage()` avec `react: { text: emoji, key: {...} }`
   - Emoji vide pour supprimer la réaction

### Format normalizeMessage() corrigé

| Ancien champ | Nouveau champ | Description |
|--------------|---------------|-------------|
| `from` | `chatId` | ID du chat (JID) |
| `sender` | `from` | Numéro expéditeur (sans @) |
| - | `to` | Numéro destinataire |
| `isFromMe` | `fromMe` | Boolean |
| `content` | `text` | Contenu texte |
| `message` | `_raw` | Message brut |
| - | `_provider` | `'baileys'` |
| - | `media` | Objet MediaInfo si applicable |

---

*Document créé le 2026-01-14*
*Mis à jour le 2026-01-14 - Phase 1.4 complétée*
*Phase 1 - Audit BaileysProvider*
