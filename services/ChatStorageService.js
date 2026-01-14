const logger = require('winston');

/**
 * Service de stockage local des conversations pour les providers qui n'ont pas d'API de listing
 * (comme Meta WhatsApp Cloud API)
 */
class ChatStorageService {
  constructor() {
    // Stockage en mémoire des conversations
    // Structure: Map<userId, Map<chatId, chatData>>
    this.userChats = new Map();
    
    // Index des derniers messages par utilisateur pour tri
    // Structure: Map<userId, Array<{chatId, timestamp}>>
    this.chatIndex = new Map();
    
    // Stockage des messages par chat
    // Structure: Map<userId_chatId, {chatData, messages: []}>
    this.chats = new Map();
  }

  /**
   * Ajoute ou met à jour une conversation pour un utilisateur
   * @param {number} userId - ID de l'utilisateur
   * @param {Object} chatData - Données de la conversation
   */
  updateChat(userId, chatData) {
    if (!this.userChats.has(userId)) {
      this.userChats.set(userId, new Map());
      this.chatIndex.set(userId, []);
    }
    
    const userChats = this.userChats.get(userId);
    const chatId = chatData.id || chatData.remoteJid;
    
    // Mettre à jour les données du chat
    const existingChat = userChats.get(chatId) || {};
    const updatedChat = {
      ...existingChat,
      ...chatData,
      id: chatId,
      lastUpdate: Date.now()
    };
    
    userChats.set(chatId, updatedChat);
    
    // Mettre à jour l'index pour le tri
    this.updateChatIndex(userId, chatId, chatData.timestamp || Date.now());
    
    logger.info(`Chat updated for user ${userId}: ${chatId}`);
  }

  /**
   * Met à jour l'index des conversations pour le tri
   * @param {number} userId - ID de l'utilisateur
   * @param {string} chatId - ID de la conversation
   * @param {number} timestamp - Timestamp du dernier message
   */
  updateChatIndex(userId, chatId, timestamp) {
    const index = this.chatIndex.get(userId) || [];
    
    // Retirer l'ancienne entrée si elle existe
    const newIndex = index.filter(item => item.chatId !== chatId);
    
    // Ajouter la nouvelle entrée
    newIndex.push({ chatId, timestamp });
    
    // Trier par timestamp décroissant
    newIndex.sort((a, b) => b.timestamp - a.timestamp);
    
    // Limiter à 100 conversations maximum par utilisateur
    if (newIndex.length > 100) {
      newIndex.length = 100;
    }
    
    this.chatIndex.set(userId, newIndex);
  }

  /**
   * Récupère toutes les conversations d'un utilisateur
   * @param {number} userId - ID de l'utilisateur
   * @returns {Array} Liste des conversations triées
   */
  getChats(userId) {
    const userChats = this.userChats.get(userId);
    if (!userChats) {
      return [];
    }
    
    const index = this.chatIndex.get(userId) || [];
    const chats = [];
    
    // Récupérer les chats dans l'ordre de l'index
    for (const { chatId } of index) {
      const chat = userChats.get(chatId);
      if (chat) {
        chats.push(chat);
      }
    }
    
    return chats;
  }

  /**
   * Récupère une conversation spécifique
   * @param {number} userId - ID de l'utilisateur
   * @param {string} chatId - ID de la conversation
   * @returns {Object|null} Données de la conversation
   */
  getChat(userId, chatId) {
    const userChats = this.userChats.get(userId);
    if (!userChats) {
      return null;
    }
    
    return userChats.get(chatId) || null;
  }

  /**
   * Traite un message entrant et met à jour la conversation
   * @param {Object} messageData - Données du message webhook
   * @returns {Object} Chat mis à jour
   */
  processIncomingMessage(messageData) {
    // Gérer les formats Evolution (key.remoteJid) et Meta (chatId/from)
    const chatId = messageData.key?.remoteJid || messageData.chatId || messageData.from;
    if (!chatId) {
      logger.warn('Message sans identifiant de chat ignoré');
      return null;
    }
    
    // Extraire les informations du message
    let messageText = '';
    
    // Format Meta (normalisé)
    if (messageData.content) {
      messageText = messageData.content;
      if (messageData.type === 'image' && !messageText) {
        messageText = '📷 Photo';
      } else if (messageData.type === 'video' && !messageText) {
        messageText = '🎥 Vidéo';
      } else if (messageData.type === 'audio') {
        messageText = '🎵 Audio';
      } else if (messageData.type === 'document') {
        messageText = '📄 Document';
      }
    }
    // Format Evolution
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
    
    // Timestamp: Meta envoie en millisecondes, Evolution en secondes
    const timestamp = messageData.timestamp 
      ? (messageData.timestamp > 9999999999 ? messageData.timestamp / 1000 : messageData.timestamp)
      : (parseInt(messageData.messageTimestamp) || Date.now() / 1000);
    
    // Créer ou mettre à jour le chat
    const chatData = {
      id: chatId,
      remoteJid: chatId,
      name: messageData.pushName || messageData.contactName || chatId.replace('@s.whatsapp.net', '').replace('@g.us', ''),
      lastMessage: messageText,
      timestamp: timestamp,
      unreadCount: 0, // Géré côté client
      profilePicture: null,
      isTyping: false
    };
    
    // Créer le message à stocker
    const messageToStore = {
      id: messageData.id || `msg_${Date.now()}`,
      chatId: chatId,
      content: messageText,
      text: messageText,
      timestamp: timestamp,
      fromMe: messageData.fromMe || false,
      status: messageData.status || 'received',
      type: messageData.type || 'text',
      contactName: messageData.contactName || messageData.pushName || '',
      pushName: messageData.pushName || ''
    };
    
    logger.info(`Processing message for chat ${chatId}: "${messageText}"`);
    
    // Pour l'instant, on utilise userId 1 (admin) par défaut
    // TODO: Implémenter la gestion multi-utilisateurs
    const userId = 1;
    this.updateChat(userId, chatData);
    
    // Stocker le message
    const chatKey = `${userId}_${chatId}`;
    if (!this.chats.has(chatKey)) {
      this.chats.set(chatKey, {
        ...chatData,
        messages: []
      });
    }
    
    const chat = this.chats.get(chatKey);
    if (!chat.messages) {
      chat.messages = [];
    }
    chat.messages.push(messageToStore);
    
    // Limiter à 1000 messages par chat
    if (chat.messages.length > 1000) {
      chat.messages = chat.messages.slice(-1000);
    }
    
    return chatData;
  }

  /**
   * Nettoie les anciennes conversations (plus de 30 jours)
   */
  cleanOldChats() {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    
    for (const [userId, userChats] of this.userChats) {
      for (const [chatId, chat] of userChats) {
        if (chat.lastUpdate < thirtyDaysAgo) {
          userChats.delete(chatId);
          
          // Mettre à jour l'index
          const index = this.chatIndex.get(userId) || [];
          const newIndex = index.filter(item => item.chatId !== chatId);
          this.chatIndex.set(userId, newIndex);
        }
      }
    }
    
    logger.info('Anciennes conversations nettoyées');
  }
  
  /**
   * Récupère les messages d'une conversation
   * @param {number} userId - ID de l'utilisateur
   * @param {string} chatId - ID du chat
   * @param {number} limit - Nombre maximum de messages
   * @returns {Array} Messages du chat
   */
  getMessages(userId, chatId, limit = 50) {
    const chat = this.chats.get(`${userId}_${chatId}`);
    if (!chat || !chat.messages) {
      return [];
    }
    
    // Retourner les derniers messages selon la limite
    const messages = chat.messages.slice(-limit);
    
    // Convertir au format attendu par le frontend
    return messages.map(msg => ({
      id: msg.id,
      key: {
        id: msg.id,
        fromMe: msg.fromMe || false,
        remoteJid: chatId
      },
      message: {
        conversation: msg.content || msg.text || '',
        messageTimestamp: msg.timestamp
      },
      messageTimestamp: msg.timestamp,
      pushName: msg.contactName || msg.pushName || '',
      status: msg.status || 'received',
      type: msg.type || 'text'
    }));
  }
}

// Singleton
module.exports = new ChatStorageService();