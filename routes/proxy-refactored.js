const express = require('express');
const router = express.Router();
const providerManager = require('../services/ProviderManager');
const logger = require('winston');

/**
 * Route proxy refactorisée pour utiliser le ProviderManager
 * Au lieu d'appels directs à Evolution API, utilise l'abstraction multi-provider
 */

// POST /api/evolution/message/sendText/:instance
router.post('/message/sendText/:instance', async (req, res) => {
  try {
    const { number, text, ...options } = req.body;
    
    const result = await providerManager.sendTextMessage(number, text, options);
    
    if (result.success) {
      res.json({
        key: { id: result.messageId },
        message: { conversation: text },
        messageTimestamp: Date.now() / 1000,
        status: 'SENT'
      });
    } else {
      res.status(400).json({
        error: result.error || 'Failed to send message'
      });
    }
  } catch (error) {
    logger.error('Error sending text message:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/evolution/message/sendMedia/:instance
router.post('/message/sendMedia/:instance', async (req, res) => {
  try {
    const { number, media, mediatype, caption, ...options } = req.body;
    
    const result = await providerManager.sendMediaMessage(number, {
      type: mediatype,
      url: media,
      caption: caption
    }, options);
    
    if (result.success) {
      res.json({
        key: { id: result.messageId },
        message: { [mediatype + 'Message']: { caption } },
        messageTimestamp: Date.now() / 1000,
        status: 'SENT'
      });
    } else {
      res.status(400).json({
        error: result.error || 'Failed to send media'
      });
    }
  } catch (error) {
    logger.error('Error sending media message:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/evolution/message/sendDocument/:instance
router.post('/message/sendDocument/:instance', async (req, res) => {
  try {
    const { number, media, fileName, caption, ...options } = req.body;
    
    const result = await providerManager.sendDocument(number, {
      url: media,
      filename: fileName,
      caption: caption
    }, options);
    
    if (result.success) {
      res.json({
        key: { id: result.messageId },
        message: { documentMessage: { fileName, caption } },
        messageTimestamp: Date.now() / 1000,
        status: 'SENT'
      });
    } else {
      res.status(400).json({
        error: result.error || 'Failed to send document'
      });
    }
  } catch (error) {
    logger.error('Error sending document:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/evolution/message/sendReaction/:instance
router.post('/message/sendReaction/:instance', async (req, res) => {
  try {
    const { messageId, reaction } = req.body;
    
    const result = await providerManager.sendReaction(messageId, reaction);
    
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(400).json({
        error: 'Failed to send reaction'
      });
    }
  } catch (error) {
    logger.error('Error sending reaction:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/evolution/chat/findChats/:instance
router.post('/chat/findChats/:instance', async (req, res) => {
  try {
    const chats = await providerManager.getChats(req.body);
    res.json(chats);
  } catch (error) {
    logger.error('Error getting chats:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/evolution/chat/findMessages/:instance
router.post('/chat/findMessages/:instance', async (req, res) => {
  try {
    const { where, limit = 50, ...options } = req.body;
    const chatId = where?.remoteJid;
    
    if (!chatId) {
      return res.status(400).json({
        error: 'chatId (remoteJid) is required'
      });
    }
    
    const messages = await providerManager.getMessages(chatId, limit, options);
    res.json(messages);
  } catch (error) {
    logger.error('Error getting messages:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/evolution/instance/connectionState/:instance
router.get('/instance/connectionState/:instance', async (req, res) => {
  try {
    const state = await providerManager.getConnectionState();
    res.json(state);
  } catch (error) {
    logger.error('Error getting connection state:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/evolution/instance/qrcode/:instance
router.get('/instance/qrcode/:instance', async (req, res) => {
  try {
    const qrData = await providerManager.getQRCode();
    res.json(qrData);
  } catch (error) {
    logger.error('Error getting QR code:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/evolution/chat/findContacts/:instance
router.get('/chat/findContacts/:instance', async (req, res) => {
  try {
    const contacts = await providerManager.getContacts();
    res.json(contacts);
  } catch (error) {
    logger.error('Error getting contacts:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/evolution/chat/markMessageAsRead/:instance
router.post('/chat/markMessageAsRead/:instance', async (req, res) => {
  try {
    const { messageId } = req.body;
    
    const result = await providerManager.markMessageAsRead(messageId);
    
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(400).json({
        error: 'Failed to mark message as read'
      });
    }
  } catch (error) {
    logger.error('Error marking message as read:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/evolution/chat/markChatAsRead/:instance
router.post('/chat/markChatAsRead/:instance', async (req, res) => {
  try {
    const { chatId } = req.body;
    
    const result = await providerManager.markChatAsRead(chatId);
    
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(400).json({
        error: 'Failed to mark chat as read'
      });
    }
  } catch (error) {
    logger.error('Error marking chat as read:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/evolution/chat/archiveChat/:instance
router.post('/chat/archiveChat/:instance', async (req, res) => {
  try {
    const { chatId } = req.body;
    
    const result = await providerManager.archiveChat(chatId, true);
    
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(400).json({
        error: 'Failed to archive chat'
      });
    }
  } catch (error) {
    logger.error('Error archiving chat:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// POST /api/evolution/chat/unarchiveChat/:instance
router.post('/chat/unarchiveChat/:instance', async (req, res) => {
  try {
    const { chatId } = req.body;
    
    const result = await providerManager.archiveChat(chatId, false);
    
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(400).json({
        error: 'Failed to unarchive chat'
      });
    }
  } catch (error) {
    logger.error('Error unarchiving chat:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/evolution/chat/checkNumber/:instance
router.get('/chat/checkNumber/:instance', async (req, res) => {
  try {
    const { number } = req.query;
    
    if (!number) {
      return res.status(400).json({
        error: 'Number is required'
      });
    }
    
    const result = await providerManager.checkNumberExists(number);
    res.json(result);
  } catch (error) {
    logger.error('Error checking number:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// GET /api/evolution/chat/getProfilePicture/:instance
router.get('/chat/getProfilePicture/:instance', async (req, res) => {
  try {
    const { number } = req.query;
    
    if (!number) {
      return res.status(400).json({
        error: 'Number is required'
      });
    }
    
    const result = await providerManager.getProfilePicture(number);
    res.json(result);
  } catch (error) {
    logger.error('Error getting profile picture:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// DELETE /api/evolution/instance/logout/:instance
router.delete('/instance/logout/:instance', async (req, res) => {
  try {
    const result = await providerManager.logout();
    
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(400).json({
        error: 'Failed to logout'
      });
    }
  } catch (error) {
    logger.error('Error during logout:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

module.exports = router;