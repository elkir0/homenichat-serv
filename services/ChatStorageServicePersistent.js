const db = require('./DatabaseService');
const logger = require('../utils/logger'); // Use shared logger

/**
 * Map Baileys numeric status to string status
 * Baileys: 0=ERROR, 1=PENDING, 2=SERVER_ACK, 3=DELIVERY_ACK, 4=READ, 5=PLAYED
 */
function mapMessageStatus(status) {
  if (typeof status === 'string') {
    // Already a string, return as-is if valid
    if (['sending', 'sent', 'delivered', 'read', 'played', 'received', 'failed'].includes(status)) {
      return status;
    }
  }
  // Convert numeric status to string
  const numStatus = parseInt(status, 10);
  switch (numStatus) {
    case 0: return 'failed';
    case 1: return 'sending';
    case 2: return 'sent';
    case 3: return 'delivered';
    case 4: return 'read';
    case 5: return 'read'; // PLAYED = read for voice messages
    default: return 'sent';
  }
}

/**
 * Service de stockage des conversations utilisant DatabaseService (SQLite)
 * Centralise la gestion des chats et messages pour tous les providers
 */
class ChatStorageServicePersistent {
  constructor() {
    this.messageCache = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Ajoute ou met à jour une conversation
   */
  updateChat(chatData) {
    try {
      const stmt = db.prepare(`
        INSERT INTO chats 
        (id, name, unread_count, timestamp, profile_picture, provider, local_phone_number)
        VALUES (@id, @name, @unreadCount, @timestamp, @profilePicture, @provider, @localPhoneNumber)
        ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        unread_count=excluded.unread_count,
        timestamp=excluded.timestamp,
        profile_picture=excluded.profile_picture,
        provider=excluded.provider,
        local_phone_number=excluded.local_phone_number
      `);

      stmt.run({
        id: chatData.id,
        name: chatData.name,
        unreadCount: chatData.unreadCount || 0,
        timestamp: chatData.timestamp,
        profilePicture: chatData.profilePicture,
        provider: chatData.provider || 'whatsapp',
        localPhoneNumber: chatData.localPhoneNumber || chatData.local_phone_number || null
      });
    } catch (error) {
      logger.error('Error updating chat:', error);
      throw error;
    }
  }

  /**
   * Récupère toutes les conversations
   */
  getChats() {
    try {
      return db.prepare('SELECT * FROM chats ORDER BY timestamp DESC').all();
    } catch (error) {
      logger.error('Error getting chats:', error);
      return [];
    }
  }

  /**
   * Récupère une conversation spécifique
   */
  getChat(chatId) {
    try {
      return db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    } catch (error) {
      logger.error('Error getting chat:', error);
      return null;
    }
  }

  /**
   * Met à jour le nom d'un chat (utile pour les groupes et contacts @lid)
   */
  updateChatName(chatId, name) {
    if (!chatId || !name) return;
    try {
      // Ne mettre à jour que si le nom actuel est le JID ou un ID numérique (pas un vrai nom)
      const chat = db.prepare('SELECT name FROM chats WHERE id = ?').get(chatId);
      if (chat) {
        const currentName = chat.name;
        const isJidOrNumeric = currentName === chatId ||
          currentName.includes('@') ||
          /^\d+$/.test(currentName);  // Nom purement numérique (ex: LID sans @)

        if (isJidOrNumeric) {
          db.prepare('UPDATE chats SET name = ? WHERE id = ?').run(name, chatId);
          logger.info(`Chat name updated: ${chatId} -> ${name}`);
        }
      }
    } catch (error) {
      logger.error('Error updating chat name:', error);
    }
  }

  /**
   * Vérifie si un message existe déjà
   */
  messageExists(messageId) {
    try {
      const result = db.prepare('SELECT 1 FROM messages WHERE id = ?').get(messageId);
      return !!result;
    } catch (error) {
      logger.error('Error checking message existence:', error);
      return false;
    }
  }

  /**
   * Stocke un message
   */
  storeMessage(messageData) {
    try {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO messages
        (id, chat_id, sender_id, from_me, type, content, timestamp, status, media_url, raw_data)
      VALUES(@id, @chatId, @senderId, @fromMe, @type, @content, @timestamp, @status, @mediaUrl, @rawData)
      `);

      stmt.run({
        id: messageData.id,
        chatId: messageData.chatId,
        senderId: messageData.userId || messageData.chatId, // Fallback
        fromMe: messageData.fromMe ? 1 : 0,
        type: messageData.type || 'text',
        content: messageData.content || messageData.text,
        timestamp: messageData.timestamp,
        status: mapMessageStatus(messageData.status) || 'received',
        mediaUrl: messageData.mediaUrl || null,
        rawData: JSON.stringify(messageData)
      });


      // Invalider le cache
      this.messageCache.delete(messageData.chatId);
    } catch (error) {
      logger.error('Error storing message:', error);
      throw error;
    }
  }

  /**
   * Traite un message entrant (Webhook) et met à jour la DB
   */
  async processIncomingMessage(messageData) {
    // Normalisation ID Chat
    const chatId = messageData.key?.remoteJid || messageData.chatId || messageData.from;
    if (!chatId) return null;

    // Normalisation Texte
    let messageText = '';
    // Format Meta (normalisé)
    if (messageData.content) {
      messageText = messageData.content;
      if (messageData.type === 'image' && !messageText) messageText = '📷 Photo';
      else if (messageData.type === 'video' && !messageText) messageText = '🎥 Vidéo';
      else if (messageData.type === 'audio') messageText = '🎵 Audio';
      else if (messageData.type === 'document') messageText = '📄 Document';
    }
    // Format Evolution / Baileys standard
    else if (messageData.message?.conversation) {
      messageText = messageData.message.conversation;
    } else if (messageData.message?.extendedTextMessage?.text) {
      messageText = messageData.message.extendedTextMessage.text;
    } else if (messageData.message?.imageMessage?.caption) {
      messageText = '📷 ' + messageData.message.imageMessage.caption;
    } else if (messageData.message?.imageMessage) {
      messageText = '📷 Photo';
    } else if (messageData.message?.videoMessage) {
      messageText = '🎥 Vidéo';
    } else if (messageData.message?.audioMessage) {
      messageText = '🎵 Audio';
    } else if (messageData.message?.documentMessage) {
      messageText = '📄 Document';
    }

    // Normalisation Timestamp
    const timestamp = messageData.timestamp
      ? (messageData.timestamp > 9999999999 ? messageData.timestamp / 1000 : messageData.timestamp)
      : (parseInt(messageData.messageTimestamp) || Date.now() / 1000);

    // Déterminer le nom du chat
    let chatName = messageData.pushName || messageData.contactName;
    if (!chatName) {
      // Fallback: nettoyer le JID pour afficher quelque chose de lisible
      chatName = chatId
        .replace('@s.whatsapp.net', '')
        .replace('@lid', '')
        .replace('@g.us', '');
    }

    // Données Chat
    const chatData = {
      id: chatId,
      name: chatName,
      timestamp: timestamp,
      unreadCount: 0,
      profilePicture: null,
      provider: messageData.source || 'whatsapp' // 'sms' ou 'whatsapp'
    };

    // Si on a un pushName et que le chat existe avec un nom "brut", mettre à jour
    if (messageData.pushName && !chatId.endsWith('@g.us')) {
      this.updateChatName(chatId, messageData.pushName);
    }

    // Données Message
    const messageToStore = {
      id: messageData.id || messageData.key?.id || `msg_${Date.now()} `,
      chatId: chatId,
      content: messageText,
      timestamp: timestamp,
      fromMe: messageData.fromMe || messageData.key?.fromMe || false,
      status: mapMessageStatus(messageData.status) || 'received',
      type: messageData.type || 'text',
      userId: messageData.participant || chatId, // Pour les groupes
      mediaUrl: messageData.media?.localUrl || messageData.mediaUrl || null
    };

    try {
      this.updateChat(chatData);
      this.storeMessage(messageToStore);
      return chatData;
    } catch (error) {
      logger.error('Error processing incoming message:', error);
      return null;
    }
  }

  /**
   * Met à jour l'URL média
   */
  updateMessageMediaUrl(messageId, mediaUrl) {
    try {
      db.prepare('UPDATE messages SET media_url = ? WHERE id = ?').run(mediaUrl, messageId);
      this.messageCache.clear();
    } catch (error) {
      logger.error('Error updating media URL:', error);
    }
  }

  /**
   * Met à jour le statut d'un message (sent, delivered, read)
   */
  updateMessageStatus(messageId, status) {
    try {
      db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, messageId);
      this.messageCache.clear();
    } catch (error) {
      logger.error('Error updating message status:', error);
    }
  }

  /**
   * Récupère les messages d'une conversation
   */
  async getMessages(userId, chatId, limit = 50) {
    // Note: userId ignoré car DB unifiée (ou filtrer si multi-utilisateurs plus tard)

    // Cache Check
    const cacheKey = chatId;
    const cached = this.messageCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < this.cacheTimeout)) {
      return cached.messages;
    }

    try {
      const rows = db.prepare(`
      SELECT * FROM messages 
        WHERE chat_id = ?
        ORDER BY timestamp DESC
      LIMIT ?
        `).all(chatId, limit);

      // Formatage pour le frontend
      const messages = rows.reverse().map(msg => ({
        id: msg.id,
        key: {
          id: msg.id,
          fromMe: msg.from_me === 1,
          remoteJid: chatId
        },
        message: {
          conversation: msg.content || '',
          messageTimestamp: msg.timestamp
        },
        messageTimestamp: msg.timestamp,
        pushName: '', // Pas stocké séparément parfois
        status: mapMessageStatus(msg.status),
        type: msg.type,
        media: msg.media_url ? { url: msg.media_url, localUrl: msg.media_url } : null
      }));

      this.messageCache.set(cacheKey, { messages, timestamp: Date.now() });
      return messages;

    } catch (error) {
      logger.error('Error getting messages:', error);
      return [];
    }
  }

  /**
   * Traite un batch de messages en une seule transaction (plus rapide pour l'historique)
   */
  processBatchMessages(messages) {
    const processOne = db.transaction((messageData) => {
      // Normalisation (même logique que processIncomingMessage)
      const chatId = messageData.key?.remoteJid || messageData.chatId || messageData.from;
      if (!chatId) return null;

      let messageText = '';
      if (messageData.content) {
        messageText = messageData.content;
      } else if (messageData.message?.conversation) {
        messageText = messageData.message.conversation;
      } else if (messageData.message?.extendedTextMessage?.text) {
        messageText = messageData.message.extendedTextMessage.text;
      } else if (messageData.message?.imageMessage?.caption) {
        messageText = '📷 ' + messageData.message.imageMessage.caption;
      } else if (messageData.message?.imageMessage) {
        messageText = '📷 Photo';
      } else if (messageData.message?.videoMessage) {
        messageText = '🎥 Vidéo';
      } else if (messageData.message?.audioMessage) {
        messageText = '🎵 Audio';
      } else if (messageData.message?.documentMessage) {
        messageText = '📄 Document';
      }

      const timestamp = messageData.timestamp
        ? (messageData.timestamp > 9999999999 ? messageData.timestamp / 1000 : messageData.timestamp)
        : (parseInt(messageData.messageTimestamp) || Date.now() / 1000);

      // Upsert chat
      db.prepare(`
        INSERT INTO chats (id, name, unread_count, timestamp, profile_picture, provider, local_phone_number)
        VALUES (@id, @name, @unreadCount, @timestamp, @profilePicture, @provider, @localPhoneNumber)
        ON CONFLICT(id) DO UPDATE SET
        name=COALESCE(excluded.name, chats.name),
        timestamp=MAX(excluded.timestamp, chats.timestamp),
        provider=excluded.provider
      `).run({
        id: chatId,
        name: messageData.pushName || messageData.contactName || chatId.replace('@s.whatsapp.net', ''),
        unreadCount: 0,
        timestamp: timestamp,
        profilePicture: null,
        provider: messageData.source || 'whatsapp',
        localPhoneNumber: null
      });

      // Upsert message
      db.prepare(`
        INSERT OR REPLACE INTO messages
        (id, chat_id, sender_id, from_me, type, content, timestamp, status, media_url, raw_data)
        VALUES(@id, @chatId, @senderId, @fromMe, @type, @content, @timestamp, @status, @mediaUrl, @rawData)
      `).run({
        id: messageData.id || messageData.key?.id || `msg_${Date.now()}`,
        chatId: chatId,
        senderId: messageData.participant || chatId,
        fromMe: (messageData.fromMe || messageData.key?.fromMe) ? 1 : 0,
        type: messageData.type || 'text',
        content: messageText,
        timestamp: timestamp,
        status: mapMessageStatus(messageData.status) || 'received',
        mediaUrl: messageData.media?.localUrl || messageData.mediaUrl || null,
        rawData: JSON.stringify(messageData)
      });

      return chatId;
    });

    // Wrap tout dans une grosse transaction pour la performance
    const processBatch = db.transaction((msgs) => {
      let count = 0;
      for (const msg of msgs) {
        if (!msg.message) continue;
        try {
          processOne(msg);
          count++;
        } catch (err) {
          logger.error('Error in batch message:', err.message);
        }
      }
      return count;
    });

    try {
      const count = processBatch(messages);
      // Clear cache après batch
      this.messageCache.clear();
      return count;
    } catch (error) {
      logger.error('Error processing batch messages:', error);
      return 0;
    }
  }

  /**
   * Nettoyage (Cron)
   */
  cleanOldChats() {
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
    try {
      db.prepare('DELETE FROM messages WHERE timestamp < ?').run(thirtyDaysAgo);
      db.prepare('DELETE FROM chats WHERE id NOT IN (SELECT DISTINCT chat_id FROM messages)').run();
      logger.info('Cleaned old chats');
    } catch (error) {
      logger.error('Error cleaning old chats:', error);
    }
  }

  // ===== Gestion du compte WhatsApp connecté =====

  /**
   * Récupère le numéro WhatsApp actuellement connecté (stocké en settings)
   */
  getConnectedWhatsAppNumber() {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'connected_whatsapp_number'").get();
      return row ? JSON.parse(row.value) : null;
    } catch (error) {
      logger.error('Error getting connected WhatsApp number:', error);
      return null;
    }
  }

  /**
   * Stocke le numéro WhatsApp connecté
   */
  setConnectedWhatsAppNumber(phoneNumber) {
    try {
      db.prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES ('connected_whatsapp_number', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
      `).run(JSON.stringify(phoneNumber));
      logger.info(`Connected WhatsApp number stored: ${phoneNumber}`);
    } catch (error) {
      logger.error('Error setting connected WhatsApp number:', error);
    }
  }

  /**
   * Efface toutes les données WhatsApp (garde les SMS)
   * À appeler lors d'un changement de compte ou reset
   */
  clearWhatsAppData() {
    try {
      logger.info('🗑️ Clearing all WhatsApp data...');

      // Compter avant suppression
      const msgCount = db.prepare("SELECT COUNT(*) as count FROM messages WHERE chat_id LIKE '%@s.whatsapp.net%' OR chat_id LIKE '%@g.us%' OR chat_id LIKE '%@lid%'").get();
      const chatCount = db.prepare("SELECT COUNT(*) as count FROM chats WHERE id LIKE '%@s.whatsapp.net%' OR id LIKE '%@g.us%' OR id LIKE '%@lid%' OR provider = 'whatsapp'").get();

      // Supprimer les messages WhatsApp
      db.prepare("DELETE FROM messages WHERE chat_id LIKE '%@s.whatsapp.net%' OR chat_id LIKE '%@g.us%' OR chat_id LIKE '%@lid%'").run();

      // Supprimer les chats WhatsApp
      db.prepare("DELETE FROM chats WHERE id LIKE '%@s.whatsapp.net%' OR id LIKE '%@g.us%' OR id LIKE '%@lid%' OR provider = 'whatsapp'").run();

      // Clear le numéro stocké
      db.prepare("DELETE FROM settings WHERE key = 'connected_whatsapp_number'").run();

      // Clear cache
      this.messageCache.clear();

      logger.info(`🗑️ WhatsApp data cleared: ${msgCount?.count || 0} messages, ${chatCount?.count || 0} chats deleted`);
      return { messagesDeleted: msgCount?.count || 0, chatsDeleted: chatCount?.count || 0 };
    } catch (error) {
      logger.error('Error clearing WhatsApp data:', error);
      throw error;
    }
  }

  /**
   * Vérifie si le numéro connecté a changé et nettoie si nécessaire
   * Retourne true si les données ont été nettoyées
   */
  checkAndClearIfAccountChanged(newPhoneNumber) {
    if (!newPhoneNumber) return false;

    const storedNumber = this.getConnectedWhatsAppNumber();

    if (storedNumber && storedNumber !== newPhoneNumber) {
      logger.warn(`⚠️ WhatsApp account changed: ${storedNumber} -> ${newPhoneNumber}`);
      logger.warn('🗑️ Clearing old WhatsApp data to avoid data mixing...');
      this.clearWhatsAppData();
      this.setConnectedWhatsAppNumber(newPhoneNumber);
      return true;
    }

    if (!storedNumber) {
      // Premier connexion, stocker le numéro
      this.setConnectedWhatsAppNumber(newPhoneNumber);
    }

    return false;
  }
}

module.exports = new ChatStorageServicePersistent();