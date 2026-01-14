const logger = require('../utils/logger');

/**
 * Service centralisé pour envoyer des événements push aux clients
 * Remplace tous les polling et refresh périodiques
 */
class PushService {
  constructor() {
    this.clients = new Map();
    this.eventTypes = {
      // Messages
      NEW_MESSAGE: 'new_message',
      MESSAGE_UPDATE: 'message_update',
      MESSAGE_STATUS: 'message_status',
      MESSAGE_DELETED: 'message_deleted',
      
      // Chats
      CHAT_CREATED: 'chat_created',
      CHAT_UPDATED: 'chat_updated',
      CHAT_DELETED: 'chat_deleted',
      CHATS_LIST_UPDATE: 'chats_list_update',
      
      // Statut et connexion
      CONNECTION_UPDATE: 'connection_update',
      TYPING_STATUS: 'typing_status',
      PRESENCE_UPDATE: 'presence_update',
      
      // Notifications
      NOTIFICATION: 'notification',
      ERROR: 'error',

      // Appels téléphoniques
      INCOMING_CALL: 'incoming_call',
      CALL_CREATED: 'call_created',
      CALL_ANSWERED: 'call_answered',
      CALL_ENDED: 'call_ended',
      MISSED_CALL: 'missed_call',
      CALL_HISTORY_UPDATE: 'call_history_update'
    };
  }

  /**
   * Enregistre un client WebSocket
   */
  registerClient(clientId, ws) {
    this.clients.set(clientId, ws);
    logger.info(`Client ${clientId} enregistré pour les push events`);
  }

  /**
   * Désenregistre un client
   */
  unregisterClient(clientId) {
    this.clients.delete(clientId);
    logger.info(`Client ${clientId} désenregistré`);
  }

  /**
   * Envoie un événement à tous les clients authentifiés
   */
  broadcast(eventType, data) {
    const message = {
      type: eventType,
      data: data,
      timestamp: Date.now()
    };

    let sentCount = 0;
    this.clients.forEach((client, clientId) => {
      if (this.isClientReady(client)) {
        try {
          client.send(JSON.stringify(message));
          sentCount++;
        } catch (error) {
          logger.error(`Erreur envoi à ${clientId}:`, error);
          this.unregisterClient(clientId);
        }
      }
    });

    logger.info(`Event ${eventType} envoyé à ${sentCount} clients`);
    return sentCount;
  }

  /**
   * Envoie un événement à un client spécifique
   */
  pushToClient(clientId, eventType, data) {
    const client = this.clients.get(clientId);
    if (!client || !this.isClientReady(client)) {
      return false;
    }

    const message = {
      type: eventType,
      data: data,
      timestamp: Date.now()
    };

    try {
      client.send(JSON.stringify(message));
      return true;
    } catch (error) {
      logger.error(`Erreur envoi à ${clientId}:`, error);
      this.unregisterClient(clientId);
      return false;
    }
  }

  /**
   * Envoie un événement aux clients d'un utilisateur spécifique
   */
  pushToUser(userId, eventType, data) {
    let sentCount = 0;
    this.clients.forEach((client, clientId) => {
      if (client.userId === userId && this.isClientReady(client)) {
        if (this.pushToClient(clientId, eventType, data)) {
          sentCount++;
        }
      }
    });
    return sentCount;
  }

  /**
   * Envoie un événement aux clients abonnés à un chat
   */
  pushToChat(chatId, eventType, data) {
    let sentCount = 0;
    this.clients.forEach((client, clientId) => {
      if (client.subscribedChats?.includes(chatId) && this.isClientReady(client)) {
        if (this.pushToClient(clientId, eventType, data)) {
          sentCount++;
        }
      }
    });
    return sentCount;
  }

  /**
   * Vérifie si un client est prêt à recevoir des messages
   */
  isClientReady(client) {
    return client.readyState === 1 && client.isAuthenticated;
  }

  /**
   * Push un nouveau message
   */
  pushNewMessage(messageData) {
    // Enrichir avec des métadonnées
    const enrichedData = {
      ...messageData,
      receivedAt: Date.now()
    };

    logger.info(`📤 pushNewMessage: id=${messageData.id} chatId=${messageData.chatId} fromMe=${messageData.isFromMe}`);

    // Broadcast à tous les clients
    const sentCount = this.broadcast(this.eventTypes.NEW_MESSAGE, enrichedData);
    logger.info(`📤 NEW_MESSAGE broadcast à ${sentCount} clients`);

    // Aussi mettre à jour la liste des chats
    this.pushChatsUpdate();
  }

  /**
   * Push une mise à jour de la liste des chats
   */
  async pushChatsUpdate() {
    try {
      // Récupérer la liste mise à jour des chats
      const chatStorage = require('./ChatStorageServicePersistent');
      const chats = await chatStorage.getChats(1); // User 1 par défaut

      this.broadcast(this.eventTypes.CHATS_LIST_UPDATE, {
        chats: chats,
        reason: 'new_message'
      });
    } catch (error) {
      logger.error('Erreur push chats update:', error);
    }
  }

  /**
   * Push un statut de frappe
   */
  pushTypingStatus(chatId, userId, isTyping) {
    this.pushToChat(chatId, this.eventTypes.TYPING_STATUS, {
      chatId,
      userId,
      isTyping,
      timestamp: Date.now()
    });
  }

  /**
   * Push une mise à jour de connexion
   */
  pushConnectionUpdate(provider, statusData) {
    // statusData peut être { status: 'connected', ... } ou juste un string
    const stateValue = typeof statusData === 'string'
      ? statusData
      : (statusData.status || statusData.state || 'unknown');

    this.broadcast(this.eventTypes.CONNECTION_UPDATE, {
      provider,
      status: {
        state: stateValue,
        qrCode: statusData?.qrCode || null
      },
      timestamp: Date.now()
    });
  }

  /**
   * Push une notification
   */
  pushNotification(type, message, options = {}) {
    this.broadcast(this.eventTypes.NOTIFICATION, {
      type,
      message,
      ...options,
      timestamp: Date.now()
    });
  }

  /**
   * Obtenir les statistiques
   */
  getStats() {
    let authenticated = 0;
    let total = this.clients.size;

    this.clients.forEach(client => {
      if (client.isAuthenticated) authenticated++;
    });

    return {
      total,
      authenticated,
      ready: authenticated
    };
  }
}

// Singleton
module.exports = new PushService();