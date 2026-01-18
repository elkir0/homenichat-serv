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

function getSmsRoutingService() {
  if (!smsRoutingService) {
    smsRoutingService = require('../services/SmsRoutingService');
  }
  return smsRoutingService;
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

    const smsRouting = getSmsRoutingService();
    const result = await smsRouting.sendMessage(to, message, {
      from,
      providerId: req.body.providerId // Optional: allow explicit provider
    });

    res.json({
      success: result.success,
      messageId: result.messageId,
      error: result.error
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
