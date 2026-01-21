/**
 * Mobile Compatibility Routes
 *
 * Provides alias endpoints for mobile apps (iOS/Android) that expect
 * different endpoint paths than the v2 API.
 *
 * These routes act as adapters between the mobile app expectations
 * and the actual v2 API implementation.
 *
 * Mobile App Endpoints:
 * - POST /api/sms/send          -> /api/v2/sms/send
 * - GET  /api/voip/credentials  -> /api/config/voip (reformatted)
 * - POST /api/voip/call         -> /api/v2/voip/call
 * - POST /api/whatsapp/send     -> Baileys provider
 * - GET  /api/providers/status  -> /api/v2/providers/status (reformatted)
 */

const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const logger = require('../utils/logger');

// Lazy load services to avoid circular dependencies
let smsRoutingService = null;
let providerManager = null;
let freepbxProvider = null;
let modemService = null;

function getSmsRoutingService() {
  if (!smsRoutingService) {
    smsRoutingService = require('../services/SmsRoutingService');
  }
  return smsRoutingService;
}

function getModemService() {
  if (!modemService) {
    const ModemService = require('../services/ModemService');
    modemService = new ModemService();
  }
  return modemService;
}

function getProviderManager() {
  if (!providerManager) {
    providerManager = require('../services/ProviderManager');
  }
  return providerManager;
}

function getFreePBXProvider() {
  if (!freepbxProvider) {
    try {
      const configService = require('../services/ConfigurationService');
      const FreePBXProvider = require('../providers/voip/FreePBXProvider');
      const voipConfigs = configService.getEnabledProviders('voip');

      if (voipConfigs.length > 0) {
        freepbxProvider = new FreePBXProvider(voipConfigs[0]);
      }
    } catch (e) {
      // FreePBX not configured
    }
  }
  return freepbxProvider;
}

// ==================== SMS ====================

/**
 * POST /api/sms/send
 * Mobile app expects: { to, message, from }
 * v2 API expects: { to, text, providerId }
 *
 * Routing logic:
 * 1. If modem is available and configured, use ModemService
 * 2. Otherwise fall back to SmsRoutingService (cloud providers)
 */
router.post('/sms/send', verifyToken, async (req, res) => {
  try {
    const { to, message, from } = req.body;

    if (!to || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: to, message'
      });
    }

    logger.info(`[Mobile SMS] Sending to: ${to}, from: ${from || 'default'}`);

    // Try ModemService first (for GSM modems)
    const modemSvc = getModemService();
    const modemsConfig = modemSvc.getModemsConfig ? modemSvc.getModemsConfig() : modemSvc.modemsConfig;

    let actualFromNumber = from;
    let sendResult = null;
    let provider = null;
    let modemId = null;

    if (modemsConfig && modemsConfig.modems && Object.keys(modemsConfig.modems).length > 0) {
      // We have modems configured, try to send via modem
      const modemIds = Object.keys(modemsConfig.modems);
      let targetModem = modemIds[0]; // Default to first modem

      // If 'from' matches a modem's phone number, use that modem
      if (from) {
        for (const [mId, config] of Object.entries(modemsConfig.modems)) {
          if (config.phoneNumber && config.phoneNumber.replace(/\D/g, '') === from.replace(/\D/g, '')) {
            targetModem = mId;
            actualFromNumber = config.phoneNumber;
            break;
          }
        }
      }

      // Get the from number from modem config if not provided
      if (!actualFromNumber && modemsConfig.modems[targetModem]?.phoneNumber) {
        actualFromNumber = modemsConfig.modems[targetModem].phoneNumber;
      }

      logger.info(`[Mobile SMS] Using modem: ${targetModem}, from: ${actualFromNumber}`);

      try {
        sendResult = await modemSvc.sendSms(targetModem, to, message);
        provider = 'modem';
        modemId = targetModem;
      } catch (modemError) {
        logger.warn(`[Mobile SMS] Modem send failed: ${modemError.message}, trying cloud providers...`);
        // Fall through to SmsRoutingService
      }
    }

    // Fall back to SmsRoutingService (cloud providers) if modem failed
    if (!sendResult) {
      const smsRouting = getSmsRoutingService();
      sendResult = await smsRouting.sendMessage(to, message, {
        from,
        providerId: req.body.providerId
      });
      provider = sendResult.providerId || 'cloud';
    }

    // Store outgoing message in database
    if (sendResult && (sendResult.success !== false)) {
      try {
        const db = require('../services/DatabaseService');
        const timestamp = Date.now();
        const messageId = sendResult.messageId || `sms_${timestamp}_${Math.random().toString(36).substring(7)}`;

        // Normalize phone numbers for chatId (consistent format)
        const normalizedFrom = (actualFromNumber || from || '').replace(/[^0-9+]/g, '');
        const normalizedTo = to.replace(/[^0-9+]/g, '');

        // ChatId format: sms_+fromNumber_+toNumber (same as iOS app)
        const chatId = `sms_${normalizedFrom}_${normalizedTo}`;

        // Create/update chat
        const chatStmt = db.prepare(`
          INSERT INTO chats (id, name, provider, timestamp, local_phone_number)
          VALUES (?, ?, 'sms', ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            timestamp = excluded.timestamp
        `);
        chatStmt.run(chatId, normalizedTo, Math.floor(timestamp / 1000), normalizedFrom);

        // Store message
        const msgStmt = db.prepare(`
          INSERT INTO messages (id, chat_id, sender_id, from_me, type, content, timestamp, status)
          VALUES (?, ?, ?, 1, 'text', ?, ?, 'sent')
        `);
        msgStmt.run(messageId, chatId, normalizedFrom, message, Math.floor(timestamp / 1000));

        logger.info(`[Mobile SMS] Stored in DB: messageId=${messageId}, chatId=${chatId}`);

        return res.json({
          success: true,
          messageId: messageId,
          chatId: chatId,
          provider: provider,
          modemId: modemId
        });
      } catch (dbError) {
        logger.error('[Mobile SMS] DB storage failed:', dbError.message);
        // Still return success since SMS was sent
        return res.json({
          success: true,
          messageId: sendResult.messageId || `sms_${Date.now()}`,
          provider: provider,
          modemId: modemId,
          warning: 'Message sent but not stored in database'
        });
      }
    }

    res.json({
      success: sendResult?.success || false,
      messageId: sendResult?.messageId,
      error: sendResult?.error
    });
  } catch (error) {
    logger.error('[Mobile SMS] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== VoIP ====================

/**
 * POST /api/voip/my-credentials
 * Auto-generate or retrieve user VoIP credentials for 1-click setup
 * Creates PJSIP extension in Asterisk if not exists
 */
router.post('/voip/my-credentials', verifyToken, async (req, res) => {
  try {
    const db = require('../services/DatabaseService');
    const freepbxAmi = require('../services/FreePBXAmiService');

    if (!req.user || !req.user.id) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    const userId = req.user.id;
    const userKey = `user_${userId}_voip`;

    // Check if user already has VoIP config
    let userVoip = db.getSetting(userKey);

    // Get global config for defaults
    const globalConfig = {
      server: process.env.VOIP_WSS_URL || `wss://${process.env.VOIP_DOMAIN || 'localhost'}:8089/ws`,
      domain: process.env.VOIP_DOMAIN || 'localhost',
    };

    if (!userVoip || !userVoip.extension) {
      // Generate new extension for user
      // Use userId + 200 as base (e.g., user 1 = 201, user 2 = 202)
      const baseExtension = 200;
      const extensionNumber = String(baseExtension + parseInt(userId, 10) || 1);

      // Generate random secret
      const secret = freepbxAmi.generateSecret ? freepbxAmi.generateSecret(16) :
        Math.random().toString(36).substring(2, 18);

      // Create PJSIP extension in Asterisk if AMI connected
      let pjsipCreated = false;
      if (freepbxAmi.connected && freepbxAmi.authenticated) {
        try {
          const extResult = await freepbxAmi.createPjsipExtension({
            extension: extensionNumber,
            secret: secret,
            displayName: req.user.username || `User ${userId}`,
            context: 'from-internal',
            transport: 'transport-wss',
            codecs: 'g722,ulaw,alaw,opus'
          });
          pjsipCreated = extResult.success;
          if (!pjsipCreated) {
            logger.warn(`[VoIP] Could not create PJSIP extension: ${extResult.message}`);
          }
        } catch (e) {
          logger.warn(`[VoIP] PJSIP creation error: ${e.message}`);
        }
      }

      // Save to DB
      userVoip = {
        enabled: true,
        extension: extensionNumber,
        password: secret,
        wssUrl: globalConfig.server,
        domain: globalConfig.domain,
        pjsipCreated,
        createdAt: Date.now()
      };
      db.setSetting(userKey, userVoip);

      logger.info(`[VoIP] Created VoIP config for user ${userId}: ext ${extensionNumber}`);
    }

    // Format for mobile app
    res.json({
      success: true,
      sipConfig: {
        domain: userVoip.domain || globalConfig.domain,
        proxy: userVoip.wssUrl || globalConfig.server,
        extension: userVoip.extension,
        password: userVoip.password,
      },
      server: userVoip.wssUrl || globalConfig.server,
      domain: userVoip.domain || globalConfig.domain,
      extension: userVoip.extension,
      displayName: req.user.username || 'Homenichat User',
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ],
      isNew: !userVoip.createdAt || (Date.now() - userVoip.createdAt) < 5000
    });
  } catch (error) {
    logger.error('[VoIP] My credentials error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/voip/my-config
 * User self-service to set their VoIP credentials
 */
router.put('/voip/my-config', verifyToken, async (req, res) => {
  try {
    const db = require('../services/DatabaseService');
    const userId = req.user.id;
    const { extension, password, server, domain } = req.body;

    if (!extension) {
      return res.status(400).json({
        success: false,
        error: 'Extension is required'
      });
    }

    // Get global config for defaults
    const globalConfig = {
      server: process.env.VOIP_WSS_URL || '',
      domain: process.env.VOIP_DOMAIN || '',
    };

    // Save user VoIP config
    const voipConfig = {
      enabled: true,
      wssUrl: server || globalConfig.server,
      domain: domain || globalConfig.domain,
      extension: extension,
      password: password || '',
      displayName: req.user.username || '',
      updatedAt: Date.now()
    };

    db.setSetting(`user_${userId}_voip`, voipConfig);

    logger.info(`[VoIP] User ${userId} configured VoIP: ext ${extension}`);

    res.json({
      success: true,
      message: 'Configuration VoIP sauvegardée',
      sipConfig: {
        domain: voipConfig.domain,
        proxy: voipConfig.wssUrl,
        extension: voipConfig.extension,
        password: voipConfig.password,
      }
    });
  } catch (error) {
    logger.error('[VoIP] My config error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/voip/credentials
 * Mobile app expects: { sipConfig: { domain, proxy, extension, password } }
 */
router.get('/voip/credentials', verifyToken, async (req, res) => {
  try {
    const db = require('../services/DatabaseService');

    // Get global config from environment
    const globalConfig = {
      server: process.env.VOIP_WSS_URL || '',
      domain: process.env.VOIP_DOMAIN || '',
      extension: process.env.VOIP_EXTENSION || '',
      password: process.env.VOIP_PASSWORD || '',
    };

    // Check for user-specific config
    let config = globalConfig;
    if (req.user && req.user.id) {
      const userVoip = db.getSetting(`user_${req.user.id}_voip`);
      if (userVoip && userVoip.enabled && userVoip.extension) {
        config = {
          server: userVoip.wssUrl || globalConfig.server,
          domain: userVoip.domain || globalConfig.domain,
          extension: userVoip.extension,
          password: userVoip.password || '',
        };
      }
    }

    // Format for mobile app expectations
    res.json({
      success: true,
      sipConfig: {
        domain: config.domain,
        proxy: config.server, // WSS URL as proxy
        extension: config.extension,
        password: config.password,
      },
      // Also include raw config for flexibility
      server: config.server,
      domain: config.domain,
      extension: config.extension,
      displayName: req.user?.username || 'Homenichat User',
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });
  } catch (error) {
    logger.error('[Mobile VoIP] Credentials error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/voip/call
 * Mobile app expects: { to, from, callerName }
 * v2 API expects: { fromExtension, toNumber, callerIdName }
 */
router.post('/voip/call', verifyToken, async (req, res) => {
  try {
    const { to, from, callerName } = req.body;

    if (!to) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: to'
      });
    }

    const freepbx = getFreePBXProvider();

    if (!freepbx || !freepbx.isConnected) {
      return res.status(503).json({
        success: false,
        error: 'VoIP service not available'
      });
    }

    // Use user's extension if 'from' not provided
    let fromExtension = from;
    if (!fromExtension && req.user) {
      const db = require('../services/DatabaseService');
      const userVoip = db.getSetting(`user_${req.user.id}_voip`);
      fromExtension = userVoip?.extension || process.env.VOIP_EXTENSION;
    }

    const result = await freepbx.originateCall(fromExtension, to, {
      callerIdName: callerName
    });

    res.json({
      success: result.success,
      callId: result.callId,
      error: result.error
    });
  } catch (error) {
    logger.error('[Mobile VoIP] Call error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== WhatsApp ====================

/**
 * POST /api/whatsapp/send
 * Mobile app expects: { to, type, content, template, media, location }
 */
router.post('/whatsapp/send', verifyToken, async (req, res) => {
  try {
    const { to, type, content, template, media, location } = req.body;

    if (!to) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: to'
      });
    }

    const pm = getProviderManager();

    // Try Baileys provider first
    const baileysProvider = pm.providers?.get('baileys');
    if (baileysProvider) {
      const connState = await baileysProvider.getConnectionState?.() || {};

      if (connState.isConnected) {
        // Format phone number for WhatsApp
        let jid = to;
        if (!jid.includes('@')) {
          jid = jid.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        }

        let result;

        // Send based on message type
        if (type === 'text' || !type) {
          result = await baileysProvider.sendMessage(jid, { text: content });
        } else if (type === 'image' && media?.url) {
          result = await baileysProvider.sendMessage(jid, {
            image: { url: media.url },
            caption: media.caption || ''
          });
        } else if (type === 'document' && media?.url) {
          result = await baileysProvider.sendMessage(jid, {
            document: { url: media.url },
            fileName: media.filename || 'document',
            mimetype: media.mimetype || 'application/octet-stream'
          });
        } else if (type === 'location' && location) {
          result = await baileysProvider.sendMessage(jid, {
            location: {
              degreesLatitude: location.latitude,
              degreesLongitude: location.longitude,
              name: location.name
            }
          });
        } else {
          // Fallback to text
          result = await baileysProvider.sendMessage(jid, { text: content || '' });
        }

        return res.json({
          success: true,
          messageId: result?.key?.id || result?.messageId,
          provider: 'baileys'
        });
      }
    }

    // Try Meta provider as fallback
    const metaProvider = pm.providers?.get('meta');
    if (metaProvider) {
      const health = await metaProvider.getHealth?.() || {};

      if (health.isHealthy) {
        let result;

        if (type === 'template' && template) {
          result = await metaProvider.sendTemplate(to, template.name, template.language, template.components);
        } else {
          result = await metaProvider.sendTextMessage(to, content);
        }

        return res.json({
          success: true,
          messageId: result?.messages?.[0]?.id || result?.messageId,
          provider: 'meta'
        });
      }
    }

    // No provider available
    return res.status(503).json({
      success: false,
      error: 'No WhatsApp provider available or connected'
    });

  } catch (error) {
    logger.error('[Mobile WhatsApp] Send error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== Provider Status ====================

/**
 * GET /api/providers/status
 * Mobile app expects: { providers: [{ name, connected, type }] }
 */
router.get('/providers/status', verifyToken, async (req, res) => {
  try {
    const pm = getProviderManager();
    const providers = [];

    // WhatsApp - Baileys
    const baileysProvider = pm.providers?.get('baileys');
    if (baileysProvider) {
      const connState = await baileysProvider.getConnectionState?.() || {};
      providers.push({
        name: 'baileys',
        type: 'whatsapp',
        connected: connState.isConnected || false,
        phone: baileysProvider.sock?.user?.id?.split('@')[0]?.split(':')[0] || null
      });
    }

    // WhatsApp - Meta Cloud
    const metaProvider = pm.providers?.get('meta');
    if (metaProvider) {
      const health = await metaProvider.getHealth?.() || {};
      providers.push({
        name: 'meta',
        type: 'whatsapp',
        connected: health.isHealthy || false,
        phone: metaProvider.config?.phoneNumber || null
      });
    }

    // SMS providers
    try {
      const smsRouting = getSmsRoutingService();
      const smsStatus = smsRouting.getStatus();

      for (const [id, info] of Object.entries(smsStatus.providers || {})) {
        providers.push({
          name: id,
          type: 'sms',
          connected: info.available || false,
          phone: info.phoneNumber || null
        });
      }
    } catch (e) {
      // SMS routing not available
    }

    // VoIP
    const freepbx = getFreePBXProvider();
    if (freepbx) {
      providers.push({
        name: 'freepbx',
        type: 'voip',
        connected: freepbx.isConnected || false
      });
    }

    // Also check AMI status
    try {
      const freepbxAmi = require('../services/FreePBXAmiService');
      const amiStatus = freepbxAmi.getStatus();
      if (amiStatus.connected) {
        // Update or add VoIP status
        const existingVoip = providers.find(p => p.type === 'voip');
        if (existingVoip) {
          existingVoip.connected = true;
          existingVoip.amiConnected = true;
        } else {
          providers.push({
            name: 'asterisk',
            type: 'voip',
            connected: true,
            amiConnected: true
          });
        }
      }
    } catch (e) {
      // AMI not available
    }

    res.json({
      success: true,
      providers,
      timestamp: Date.now()
    });
  } catch (error) {
    logger.error('[Mobile Providers] Status error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      providers: []
    });
  }
});

// ==================== Additional VoIP Endpoints ====================

/**
 * POST /api/voip/originate
 * FreePbxVoipProvider expects: { channel, context, exten, priority, callerId, timeout }
 */
router.post('/voip/originate', verifyToken, async (req, res) => {
  try {
    const { channel, context, exten, priority, callerId, timeout, destination } = req.body;

    // Support both formats: full AMI format or simple destination
    const toNumber = destination || exten;

    if (!toNumber) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: destination or exten'
      });
    }

    const freepbx = getFreePBXProvider();

    if (!freepbx || !freepbx.isConnected) {
      // Try via AMI service directly
      try {
        const freepbxAmi = require('../services/FreePBXAmiService');
        if (freepbxAmi.isConnected) {
          // Get user's extension
          const db = require('../services/DatabaseService');
          let fromExtension = channel;
          if (!fromExtension && req.user) {
            const userVoip = db.getSetting(`user_${req.user.id}_voip`);
            fromExtension = userVoip?.extension || process.env.VOIP_EXTENSION;
          }

          const result = await freepbxAmi.originateCall(
            fromExtension,
            toNumber,
            { callerId: callerId, timeout: timeout || 30 }
          );

          return res.json({
            success: result.success,
            callId: result.callId,
            error: result.error
          });
        }
      } catch (e) {
        // AMI not available
      }

      return res.status(503).json({
        success: false,
        error: 'VoIP service not available'
      });
    }

    // Use FreePBXProvider
    const db = require('../services/DatabaseService');
    let fromExtension = channel;
    if (!fromExtension && req.user) {
      const userVoip = db.getSetting(`user_${req.user.id}_voip`);
      fromExtension = userVoip?.extension || process.env.VOIP_EXTENSION;
    }

    const result = await freepbx.originateCall(fromExtension, toNumber, {
      callerIdName: callerId,
      timeout: timeout || 30
    });

    res.json({
      success: result.success,
      callId: result.callId,
      error: result.error
    });
  } catch (error) {
    logger.error('[Mobile VoIP] Originate error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/voip/status
 * Returns VoIP service status
 */
router.get('/voip/status', verifyToken, async (req, res) => {
  try {
    const status = {
      connected: false,
      amiConnected: false,
      webrtcAvailable: false,
      extensions: []
    };

    // Check FreePBX provider
    const freepbx = getFreePBXProvider();
    if (freepbx) {
      status.connected = freepbx.isConnected || false;
      status.webrtcAvailable = true;
    }

    // Check AMI service
    try {
      const freepbxAmi = require('../services/FreePBXAmiService');
      const amiStatus = freepbxAmi.getStatus();
      status.amiConnected = amiStatus.connected || false;
      if (amiStatus.connected) {
        status.connected = true;
      }
    } catch (e) {
      // AMI not available
    }

    // Get user's extension if configured
    if (req.user) {
      const db = require('../services/DatabaseService');
      const userVoip = db.getSetting(`user_${req.user.id}_voip`);
      if (userVoip && userVoip.extension) {
        status.extensions.push(userVoip.extension);
        status.userExtension = userVoip.extension;
      }
    }

    res.json({
      success: true,
      ...status
    });
  } catch (error) {
    logger.error('[Mobile VoIP] Status error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/voip/answer
 * Answer an incoming call by redirecting it to the user's WebRTC extension
 * Called by ConnectionService when user taps Answer on native UI
 */
router.post('/voip/answer', verifyToken, async (req, res) => {
  try {
    const { callId, extension } = req.body;

    if (!callId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: callId'
      });
    }

    // Get user's extension if not provided
    let targetExtension = extension;
    if (!targetExtension && req.user) {
      const db = require('../services/DatabaseService');
      const userVoip = db.getSetting(`user_${req.user.id}_voip`);
      targetExtension = userVoip?.extension || process.env.VOIP_EXTENSION || '2001';
    }

    logger.info(`[VoIP Answer] Answering call ${callId} -> extension ${targetExtension}`);

    // Use AMI service to redirect the call to the user's extension
    try {
      const freepbxAmi = require('../services/FreePBXAmiService');

      if (!freepbxAmi.connected || !freepbxAmi.authenticated) {
        return res.status(503).json({
          success: false,
          error: 'PBX AMI not connected'
        });
      }

      const result = await freepbxAmi.answerCall(callId, targetExtension);

      return res.json({
        success: result.success,
        message: result.message,
        extension: targetExtension
      });
    } catch (amiError) {
      logger.error('[VoIP Answer] AMI error:', amiError);
      return res.status(500).json({
        success: false,
        error: amiError.message
      });
    }
  } catch (error) {
    logger.error('[VoIP Answer] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/voip/reject
 * Reject an incoming call (hang up the channel)
 * Called by ConnectionService when user taps Decline on native UI
 */
router.post('/voip/reject', verifyToken, async (req, res) => {
  try {
    const { callId } = req.body;

    if (!callId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: callId'
      });
    }

    logger.info(`[VoIP Reject] Rejecting call ${callId}`);

    // Use AMI service to hang up the call
    try {
      const freepbxAmi = require('../services/FreePBXAmiService');

      if (!freepbxAmi.connected || !freepbxAmi.authenticated) {
        return res.status(503).json({
          success: false,
          error: 'PBX AMI not connected'
        });
      }

      const result = await freepbxAmi.rejectCall(callId);

      return res.json({
        success: result.success,
        message: result.message
      });
    } catch (amiError) {
      logger.error('[VoIP Reject] AMI error:', amiError);
      return res.status(500).json({
        success: false,
        error: amiError.message
      });
    }
  } catch (error) {
    logger.error('[VoIP Reject] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/voip/ringing
 * Get list of currently ringing calls
 * Useful for app to sync state after wake
 */
router.get('/voip/ringing', verifyToken, async (req, res) => {
  try {
    const freepbxAmi = require('../services/FreePBXAmiService');

    if (!freepbxAmi.connected) {
      return res.json({
        success: true,
        calls: []
      });
    }

    const ringingCalls = freepbxAmi.getRingingCalls();

    res.json({
      success: true,
      calls: ringingCalls
    });
  } catch (error) {
    logger.error('[VoIP Ringing] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      calls: []
    });
  }
});

/**
 * POST /api/calls/originate
 * NativePhoneScreen expects: { destination }
 * Alias for /api/voip/originate
 */
router.post('/calls/originate', verifyToken, async (req, res) => {
  try {
    const { destination, to, from, callerName } = req.body;
    const toNumber = destination || to;

    if (!toNumber) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: destination'
      });
    }

    // Get user's extension
    const db = require('../services/DatabaseService');
    let fromExtension = from;
    if (!fromExtension && req.user) {
      const userVoip = db.getSetting(`user_${req.user.id}_voip`);
      fromExtension = userVoip?.extension || process.env.VOIP_EXTENSION;
    }

    // Try AMI service first
    try {
      const freepbxAmi = require('../services/FreePBXAmiService');
      if (freepbxAmi.isConnected) {
        const result = await freepbxAmi.originateCall(fromExtension, toNumber, {
          callerId: callerName || req.user?.username
        });

        return res.json({
          success: result.success,
          callId: result.callId,
          message: result.message,
          error: result.error
        });
      }
    } catch (e) {
      // AMI not available, try FreePBX provider
    }

    // Try FreePBX provider
    const freepbx = getFreePBXProvider();
    if (freepbx && freepbx.isConnected) {
      const result = await freepbx.originateCall(fromExtension, toNumber, {
        callerIdName: callerName || req.user?.username
      });

      return res.json({
        success: result.success,
        callId: result.callId,
        error: result.error
      });
    }

    return res.status(503).json({
      success: false,
      error: 'VoIP service not available'
    });
  } catch (error) {
    logger.error('[Mobile Calls] Originate error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
