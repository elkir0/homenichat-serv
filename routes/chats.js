const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const providerManager = require('../services/ProviderManager');
const sessionManager = require('../services/SessionManager');
const logger = require('winston');
const chatStorage = require('../services/ChatStorageServicePersistent');
const webSocketManager = require('../services/WebSocketManager');

// Toutes les routes nécessitent une authentification
router.use(verifyToken);

// Helper pour obtenir le provider selon la session
function getProviderForRequest(req) {
  const sessionId = req.headers['x-session-id'];

  if (sessionId) {
    // Utiliser le provider de la session spécifiée
    const session = sessionManager.getSession(sessionId);
    if (session && session.provider) {
      return session.provider;
    }
  }

  // Fallback sur le provider par défaut
  return providerManager.getActiveProvider();
}

/**
 * POST /api/chats/:chatId/typing
 * Gère l'indicateur de frappe
 */
router.post('/:chatId/typing', async (req, res) => {
  try {
    const { chatId } = req.params;
    const { isTyping } = req.body;
    const activeProvider = getProviderForRequest(req);

    if (!activeProvider) {
      return res.status(503).json({
        success: false,
        error: 'No active provider'
      });
    }

    if (activeProvider.sendPresenceUpdate) {
      await activeProvider.sendPresenceUpdate(chatId, isTyping ? 'composing' : 'paused');
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error sending typing indicator:', error);
    // On ne renvoie pas 500 pour ça, c'est mineur
    res.json({ success: false, error: error.message });
  }
});

/**
 * GET /api/chats
 * Récupère la liste des conversations
 */
router.get('/', async (req, res) => {
  try {
    // Utiliser le provider selon la session
    const activeProvider = getProviderForRequest(req);

    if (!activeProvider) {
      return res.status(503).json({
        success: false,
        error: 'No active provider'
      });
    }

    const chats = await activeProvider.getChats();

    res.json({
      success: true,
      chats: chats
    });
  } catch (error) {
    logger.error('Error getting chats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/chats/:chatId
 * Récupère les informations d'une conversation
 */
router.get('/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;
    const activeProvider = getProviderForRequest(req);

    if (!activeProvider) {
      return res.status(503).json({
        success: false,
        error: 'No active provider'
      });
    }

    const chatInfo = await activeProvider.getChatInfo(chatId);

    res.json({
      success: true,
      chat: chatInfo
    });
  } catch (error) {
    logger.error('Error getting chat info:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/chats/:chatId/messages
 * Récupère les messages d'une conversation
 */
router.get('/:chatId/messages', async (req, res) => {
  try {
    const { chatId } = req.params;
    const { limit = 50, before, after } = req.query;
    const activeProvider = getProviderForRequest(req);

    if (!activeProvider) {
      return res.status(503).json({
        success: false,
        error: 'No active provider'
      });
    }

    const messages = await activeProvider.getMessages(chatId, limit, { before, after });

    res.json({
      success: true,
      messages: messages
    });
  } catch (error) {
    logger.error('Error getting messages:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/chats/:chatId/messages
 * Envoie un message dans une conversation
 */
router.post('/:chatId/messages', async (req, res) => {
  try {
    const { chatId } = req.params;
    const { text, media, options, provider } = req.body;
    let activeProvider = getProviderForRequest(req);

    if (provider) {
      const specificProvider = providerManager.providers.get(provider);
      if (specificProvider) {
        activeProvider = specificProvider;
      }
    }

    if (!activeProvider) {
      return res.status(503).json({
        success: false,
        error: 'No active provider'
      });
    }

    let result;
    if (media) {
      result = await activeProvider.sendMediaMessage(chatId, media, options);

      // Sauvegarder le message envoyé dans la DB
      if (result.success && result.messageId) {
        // Utiliser le timestamp retourné par le provider, sinon Date.now()
        const messageTimestamp = result.timestamp || Math.floor(Date.now() / 1000);

        const messageToStore = {
          id: result.messageId,
          chatId: chatId,
          content: media.caption || '',
          text: media.caption || '',
          timestamp: messageTimestamp,
          fromMe: true,
          status: 'sent',
          type: media.type || 'image',
          userId: req.userId || 1,
          mediaUrl: media.url || media.localUrl || null
        };

        await chatStorage.storeMessage(messageToStore);

        // Broadcaster le message via WebSocket
        // L'ID local du média est dans l'URL retournée par l'upload
        const localMediaId = media.url ? media.url.split('/').pop() : null;

        const messageForWebSocket = {
          key: {
            id: result.messageId,
            fromMe: true,
            remoteJid: chatId
          },
          message: {
            imageMessage: media.type === 'image' ? {
              caption: media.caption,
              localMediaId: localMediaId
            } : undefined,
            audioMessage: media.type === 'audio' ? {
              url: media.url || `/api/media/${localMediaId}`,
              ptt: true,
              mediaId: media.mediaId || media.id,
              localMediaId: localMediaId
            } : undefined
          },
          messageTimestamp: messageTimestamp,
          status: 'sent',
          type: media.type,
          media: {
            type: media.type,
            localUrl: media.url || `/api/media/${localMediaId}`,
            localMediaId: localMediaId
          },
          content: media.caption || ''
        };

        logger.info(`Broadcasting audio message to chat ${chatId}`, {
          messageId: result.messageId,
          mediaType: media.type,
          hasMediaId: !!media.mediaId,
          hasUrl: !!media.url
        });

        webSocketManager.broadcastToChat(chatId, {
          type: 'new_message',
          data: messageForWebSocket
        });
      }
    } else if (text) {
      result = await activeProvider.sendTextMessage(chatId, text, options);

      // Le MetaCloudProvider envoie déjà le message via pushService
      // Donc on n'a pas besoin de broadcaster ici pour éviter les doublons
      // Garder cette logique uniquement pour les providers qui n'envoient pas de push
      if (result.success && result.messageId && activeProvider.constructor.name !== 'MetaCloudProvider') {
        // Utiliser le timestamp retourné par le provider, sinon Date.now()
        const messageTimestamp = result.timestamp || Math.floor(Date.now() / 1000);

        const textMessageForWebSocket = {
          key: {
            id: result.messageId,
            fromMe: true,
            remoteJid: chatId
          },
          message: {
            conversation: text
          },
          messageTimestamp: messageTimestamp,
          status: 'sent'
        };

        webSocketManager.broadcastToChat(chatId, {
          type: 'new_message',
          data: textMessageForWebSocket
        });
      }
    } else {
      return res.status(400).json({
        success: false,
        error: 'No text or media provided'
      });
    }

    res.json(result);
  } catch (error) {
    logger.error('Error sending message:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/chats/:chatId/test-send/:provider
 * Route de test pour envoyer un message via un provider spécifique
 */
router.post('/:chatId/test-send/:provider', async (req, res) => {
  try {
    const { chatId, provider: providerName } = req.params;
    const { text, media, options } = req.body;

    // Obtenir le provider spécifique
    const activeProviders = providerManager.getActiveProviders();
    const provider = activeProviders.get(providerName);

    if (!provider) {
      return res.status(404).json({
        success: false,
        error: `Provider '${providerName}' not found or not active`
      });
    }

    let result;
    if (text) {
      result = await provider.sendTextMessage(chatId, text, options);
    } else if (media) {
      result = await provider.sendMediaMessage(chatId, media, options);
    } else {
      return res.status(400).json({
        success: false,
        error: 'No text or media provided'
      });
    }

    res.json({
      success: result.success,
      messageId: result.messageId,
      provider: providerName,
      error: result.error
    });
  } catch (error) {
    logger.error('Error in test send:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/chats/:chatId/read
 * POST /api/chats/:chatId/read
 * Marque une conversation comme lue
 */
router.put('/:chatId/read', async (req, res) => {
  try {
    const { chatId } = req.params;
    const activeProvider = getProviderForRequest(req);

    if (!activeProvider) {
      return res.status(503).json({
        success: false,
        error: 'No active provider'
      });
    }

    const result = await activeProvider.markChatAsRead(chatId);

    res.json(result);
  } catch (error) {
    logger.error('Error marking chat as read:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Alias POST pour compatibilité avec l'API documentée
router.post('/:chatId/read', async (req, res) => {
  try {
    const { chatId } = req.params;
    const activeProvider = getProviderForRequest(req);

    if (!activeProvider) {
      return res.status(503).json({
        success: false,
        error: 'No active provider'
      });
    }

    const result = await activeProvider.markChatAsRead(chatId);
    res.json(result);
  } catch (error) {
    logger.error('Error marking chat as read:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/chats/:chatId/messages/:messageId/read
 * Marque un message spécifique comme lu
 *
 * @api POST /api/chats/:chatId/messages/:messageId/read
 * @returns {Object} { success: boolean, error?: string }
 */
router.post('/:chatId/messages/:messageId/read', async (req, res) => {
  try {
    const { chatId, messageId } = req.params;
    const activeProvider = getProviderForRequest(req);

    if (!activeProvider) {
      return res.status(503).json({
        success: false,
        error: 'No active provider'
      });
    }

    const result = await activeProvider.markMessageAsRead(chatId, messageId);
    res.json(result);
  } catch (error) {
    logger.error('Error marking message as read:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/chats/:chatId/messages/:messageId/reaction
 * Envoie une réaction emoji sur un message
 *
 * @api POST /api/chats/:chatId/messages/:messageId/reaction
 * @body { emoji: string } - Emoji de réaction (chaîne vide pour supprimer)
 * @returns {Object} { success: boolean, error?: string }
 *
 * @example
 * // Ajouter une réaction
 * POST /api/chats/33612345678@s.whatsapp.net/messages/ABC123/reaction
 * { "emoji": "👍" }
 *
 * // Supprimer une réaction
 * { "emoji": "" }
 */
router.post('/:chatId/messages/:messageId/reaction', async (req, res) => {
  try {
    const { chatId, messageId } = req.params;
    const { emoji } = req.body;
    const activeProvider = getProviderForRequest(req);

    if (!activeProvider) {
      return res.status(503).json({
        success: false,
        error: 'No active provider'
      });
    }

    if (emoji === undefined) {
      return res.status(400).json({
        success: false,
        error: 'emoji is required (use empty string to remove reaction)'
      });
    }

    const result = await activeProvider.sendReaction(chatId, messageId, emoji);
    res.json(result);
  } catch (error) {
    logger.error('Error sending reaction:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;