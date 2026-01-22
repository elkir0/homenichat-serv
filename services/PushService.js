const logger = require('../utils/logger');

// Lazy load services to avoid circular dependencies
let fcmPushService = null;
let pushRelayService = null;

const getFCMService = () => {
  if (!fcmPushService) {
    fcmPushService = require('./FCMPushService');
  }
  return fcmPushService;
};

const getPushRelayService = () => {
  if (!pushRelayService) {
    pushRelayService = require('./PushRelayService');
    pushRelayService.initialize();
  }
  return pushRelayService;
};

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
      CALL_CANCELLED: 'call_cancelled',  // Appelant raccroche avant réponse
      CALL_ANSWERED_ELSEWHERE: 'call_answered_elsewhere',  // Répondu sur un autre appareil
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

    logger.info(`Event ${eventType} envoyé à ${sentCount} clients WebSocket`);

    // For incoming calls, also send FCM push to wake up mobile apps
    if (eventType === this.eventTypes.INCOMING_CALL) {
      this.sendIncomingCallFCM(data);
    }

    // For call cancellation/end, send FCM push to dismiss CallKit on mobile apps
    if (eventType === this.eventTypes.CALL_CANCELLED ||
        eventType === this.eventTypes.CALL_ANSWERED_ELSEWHERE) {
      const callId = data.callId || data.uniqueId || data.linkedId;
      const reason = data.reason || data.status || 'cancel';
      if (callId) {
        this.sendCallCancelledFCM(callId, reason);
      }
    }

    return sentCount;
  }

  /**
   * Send FCM push notification for incoming call
   * This wakes up mobile apps even when they are killed
   * Uses Push Relay if configured, otherwise falls back to local FCM
   */
  async sendIncomingCallFCM(callData) {
    try {
      const callId = callData.callId || `call-${Date.now()}`;
      const callerNumber = callData.callerNumber || callData.callerIdNum || '';
      // IMPORTANT: Use callerNumber as fallback for display name, NOT 'Appel entrant'
      // This ensures the phone number is shown when callerName is null (filtered trunk name)
      const callerName = callData.callerName || callerNumber || callData.callerIdName || 'Appel entrant';
      const lineName = callData.lineName || '';
      const extension = callData.extension || '';

      logger.info(`[Push] 📱 Sending incoming call push: ${callerName} (${callerNumber})`);

      // Try Push Relay first (preferred method)
      const relay = getPushRelayService();
      if (relay.isConfigured()) {
        // Send to all users (broadcast) since we don't know which user is the target
        // In a multi-user setup, you'd filter by extension/user mapping
        const result = await relay.broadcast('incoming_call', {
          callId,
          callerName,
          callerNumber,
          lineName,
          extension
        });

        if (result.sent > 0) {
          logger.info(`[Push] 📱 Incoming call sent via relay to ${result.sent} devices`);
        }
        return result.sent || 0;
      }

      // Fallback to local FCM
      const fcm = getFCMService();

      if (!fcm.initialized) {
        await fcm.initialize();
      }

      if (!fcm.projectId) {
        logger.debug('[Push] FCM not configured, skipping incoming call push');
        return 0;
      }

      const sentCount = await fcm.sendIncomingCallNotification(
        callId,
        callerName,
        callerNumber,
        { lineName, extension }
      );

      if (sentCount > 0) {
        logger.info(`[Push] 📱 FCM incoming call sent to ${sentCount} devices`);
      }

      return sentCount;
    } catch (error) {
      logger.error('[Push] FCM incoming call error:', error.message);
      return 0;
    }
  }

  /**
   * Send FCM push notification to cancel/end a call
   * This dismisses the CallKit/incoming call UI on mobile apps
   * Used when:
   * - Caller hangs up before answer (cancel)
   * - Call times out (missed/noanswer)
   * - Another device answers (answered_elsewhere)
   *
   * @param {string} callId - The call ID to cancel
   * @param {string} reason - One of: 'cancel', 'missed', 'answered', 'answered_elsewhere', 'busy', 'rejected'
   */
  async sendCallCancelledFCM(callId, reason = 'cancel') {
    try {
      logger.info(`[Push] 📵 Sending call cancelled push: callId=${callId}, reason=${reason}`);

      // Determine the push type based on reason
      let pushType = 'cancel';
      if (reason === 'answered_elsewhere') {
        pushType = 'answered_elsewhere';
      } else if (reason === 'missed' || reason === 'noanswer') {
        pushType = 'cancel'; // Treat missed as cancel for UI purposes
      } else if (reason === 'busy' || reason === 'congestion') {
        pushType = 'cancel';
      }

      const pushData = {
        callId,
        type: pushType,
        reason,
        timestamp: Date.now()
      };

      // Try Push Relay first (preferred method)
      const relay = getPushRelayService();
      if (relay.isConfigured()) {
        const result = await relay.broadcast('call_cancelled', pushData);

        if (result.sent > 0) {
          logger.info(`[Push] 📵 Call cancelled sent via relay to ${result.sent} devices`);
        }
        return result.sent || 0;
      }

      // Fallback to local FCM - send silent data message
      const fcm = getFCMService();

      if (!fcm.initialized) {
        await fcm.initialize();
      }

      if (!fcm.projectId) {
        logger.debug('[Push] FCM not configured, skipping call cancelled push');
        return 0;
      }

      // Send to all registered devices
      const sentCount = await fcm.sendDataMessage({
        type: 'call_cancelled',
        callId,
        reason: pushType
      });

      if (sentCount > 0) {
        logger.info(`[Push] 📵 FCM call cancelled sent to ${sentCount} devices`);
      }

      return sentCount;
    } catch (error) {
      logger.error('[Push] FCM call cancelled error:', error.message);
      return 0;
    }
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

    // Broadcast à tous les clients WebSocket
    const sentCount = this.broadcast(this.eventTypes.NEW_MESSAGE, enrichedData);
    logger.info(`📤 NEW_MESSAGE broadcast à ${sentCount} clients`);

    // Aussi mettre à jour la liste des chats
    this.pushChatsUpdate();

    // Send FCM push notification for incoming messages (not from us)
    if (!messageData.isFromMe && !messageData.fromMe) {
      this.sendFCMNotification(messageData);
    }
  }

  /**
   * Send FCM push notification for a new message
   * Uses Push Relay if configured, otherwise falls back to local FCM
   */
  async sendFCMNotification(messageData) {
    try {
      // Get sender name
      const senderName = messageData.pushName ||
                         messageData.senderName ||
                         messageData.name ||
                         this.formatPhoneNumber(messageData.chatId);

      // Get message preview
      const messagePreview = messageData.content ||
                             messageData.body ||
                             messageData.text ||
                             'Nouveau message';

      // Try Push Relay first
      const relay = getPushRelayService();
      if (relay.isConfigured()) {
        const result = await relay.broadcast(
          'new_message',
          {
            chatId: messageData.chatId,
            messageId: messageData.id,
            senderName,
            provider: messageData.provider || 'unknown'
          },
          {
            title: senderName,
            body: messagePreview.length > 100 ? messagePreview.substring(0, 100) + '...' : messagePreview
          }
        );

        if (result.sent > 0) {
          logger.info(`📱 Push notification sent via relay to ${result.sent} devices`);
        }
        return;
      }

      // Fallback to local FCM
      const fcm = getFCMService();

      const sentCount = await fcm.sendMessageNotification(
        messageData.chatId,
        senderName,
        messagePreview,
        {
          messageId: messageData.id,
          provider: messageData.provider || 'unknown'
        }
      );

      if (sentCount > 0) {
        logger.info(`📱 FCM notification sent to ${sentCount} devices`);
      }
    } catch (error) {
      logger.error('FCM notification error:', error.message);
    }
  }

  /**
   * Format phone number for display
   */
  formatPhoneNumber(jid) {
    if (!jid) return 'Inconnu';
    const number = jid.split('@')[0];
    if (number.length >= 10) {
      return '+' + number;
    }
    return number;
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
   * Push un indicateur de frappe (typing)
   */
  pushTypingIndicator(chatId, participantJid, isTyping) {
    this.broadcast(this.eventTypes.TYPING_STATUS, {
      chatId,
      participantJid,
      isTyping,
      timestamp: Date.now()
    });
  }

  /**
   * Push une mise à jour de statut de message (sent, delivered, read)
   */
  pushMessageStatus(chatId, messageId, status) {
    this.broadcast(this.eventTypes.MESSAGE_STATUS, {
      chatId,
      messageId,
      status,
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