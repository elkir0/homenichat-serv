/**
 * Routes API v2 pour les providers multi-catégories
 *
 * Endpoints:
 * GET  /api/v2/providers/discover - Découverte des providers disponibles
 * GET  /api/v2/providers/status   - État de tous les providers
 * GET  /api/v2/providers/:category/:id - Détail d'un provider
 * PUT  /api/v2/providers/:category/:id - Mise à jour d'un provider
 * POST /api/v2/providers/:category/:id/enable - Active un provider
 * POST /api/v2/providers/:category/:id/disable - Désactive un provider
 * POST /api/v2/providers/:category/:id/test - Test de connexion
 *
 * SMS Routing:
 * POST /api/v2/sms/send - Envoi SMS via routing intelligent
 * GET  /api/v2/sms/routing/status - État du routage SMS
 * GET  /api/v2/sms/balance - Solde de tous les providers SMS
 *
 * VoIP:
 * GET  /api/v2/voip/config/:extension - Config SIP pour WebRTC
 * GET  /api/v2/voip/calls - Liste des appels actifs
 * POST /api/v2/voip/call - Initier un appel
 */

const express = require('express');
const router = express.Router();
const logger = require('winston');
const { verifyToken, requireAdmin } = require('../middleware/auth');
const configService = require('../services/ConfigurationService');

// Lazy load des services pour éviter les dépendances circulaires
let smsRoutingService = null;
let freepbxProvider = null;

function getSmsRoutingService() {
  if (!smsRoutingService) {
    smsRoutingService = require('../services/SmsRoutingService');
  }
  return smsRoutingService;
}

// Authentification requise pour toutes les routes
router.use(verifyToken);

// ==================== Provider Discovery ====================

/**
 * GET /api/v2/providers/discover
 * Découverte de tous les providers configurés (pour l'app mobile)
 */
router.get('/discover', async (req, res) => {
  try {
    const config = configService.getConfig();

    const discovery = {
      version: config.version,
      instance: config.instance,
      providers: {
        whatsapp: [],
        sms: [],
        voip: []
      }
    };

    // WhatsApp providers
    for (const provider of configService.getProviders('whatsapp')) {
      discovery.providers.whatsapp.push({
        id: provider.id,
        type: provider.type,
        enabled: provider.enabled,
        name: getProviderDisplayName(provider.type),
        capabilities: getProviderCapabilities(provider.type)
      });
    }

    // SMS providers
    for (const provider of configService.getProviders('sms')) {
      discovery.providers.sms.push({
        id: provider.id,
        type: provider.type,
        enabled: provider.enabled,
        name: getProviderDisplayName(provider.type),
        capabilities: getProviderCapabilities(provider.type)
      });
    }

    // VoIP providers
    for (const provider of configService.getProviders('voip')) {
      discovery.providers.voip.push({
        id: provider.id,
        type: provider.type,
        enabled: provider.enabled,
        name: getProviderDisplayName(provider.type),
        capabilities: getProviderCapabilities(provider.type)
      });
    }

    res.json({
      success: true,
      discovery
    });
  } catch (error) {
    logger.error('[API v2] Discovery error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v2/providers/status
 * État de santé de tous les providers
 */
router.get('/status', async (req, res) => {
  try {
    const status = {
      whatsapp: [],
      sms: [],
      voip: []
    };

    // Status WhatsApp (via ProviderManager existant)
    try {
      const providerManager = require('../services/ProviderManager');
      const health = await providerManager.getHealthStatus();
      status.whatsapp = Object.entries(health.providers).map(([name, info]) => ({
        id: name,
        ...info
      }));
    } catch (e) {
      logger.warn('[API v2] WhatsApp status unavailable:', e.message);
    }

    // Status SMS (via SmsRoutingService)
    try {
      const smsRouting = getSmsRoutingService();
      const smsStatus = smsRouting.getStatus();
      status.sms = Object.entries(smsStatus.providers).map(([id, info]) => ({
        id,
        ...info
      }));
    } catch (e) {
      logger.warn('[API v2] SMS status unavailable:', e.message);
    }

    // Status VoIP
    try {
      if (freepbxProvider) {
        const voipStatus = await freepbxProvider.getStatus();
        status.voip.push({
          id: 'freepbx_main',
          ...voipStatus
        });
      }
    } catch (e) {
      logger.warn('[API v2] VoIP status unavailable:', e.message);
    }

    res.json({
      success: true,
      status
    });
  } catch (error) {
    logger.error('[API v2] Status error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v2/providers/:category/:id
 * Détail d'un provider spécifique
 */
router.get('/:category/:id', requireAdmin, async (req, res) => {
  try {
    const { category, id } = req.params;
    const provider = configService.getProvider(category, id);

    if (!provider) {
      return res.status(404).json({
        success: false,
        error: `Provider ${id} not found in ${category}`
      });
    }

    // Masquer les secrets
    const sanitized = sanitizeProviderConfig(provider);

    res.json({
      success: true,
      provider: sanitized
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/v2/providers/:category/:id
 * Mise à jour d'un provider
 */
router.put('/:category/:id', requireAdmin, async (req, res) => {
  try {
    const { category, id } = req.params;
    const updates = req.body;

    // Restaurer les secrets masqués
    const current = configService.getProvider(category, id);
    if (current && updates.config) {
      for (const key of ['password', 'secret', 'token', 'api_key', 'auth_token', 'ami_secret']) {
        if (updates.config[key] === '***' && current.config?.[key]) {
          updates.config[key] = current.config[key];
        }
      }
    }

    const updated = await configService.updateProvider(category, id, updates);

    res.json({
      success: true,
      provider: sanitizeProviderConfig(updated)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/v2/providers/:category/:id/enable
 */
router.post('/:category/:id/enable', requireAdmin, async (req, res) => {
  try {
    const { category, id } = req.params;
    await configService.setProviderEnabled(category, id, true);

    res.json({
      success: true,
      message: `Provider ${id} enabled`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/v2/providers/:category/:id/disable
 */
router.post('/:category/:id/disable', requireAdmin, async (req, res) => {
  try {
    const { category, id } = req.params;
    await configService.setProviderEnabled(category, id, false);

    res.json({
      success: true,
      message: `Provider ${id} disabled`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== SMS Routing ====================

/**
 * POST /api/v2/sms/send
 * Envoi SMS via routage intelligent
 */
router.post('/sms/send', async (req, res) => {
  try {
    const { to, text, providerId } = req.body;

    if (!to || !text) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: to, text'
      });
    }

    const smsRouting = getSmsRoutingService();
    const result = await smsRouting.sendMessage(to, text, { providerId });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v2/sms/routing/status
 * État du routage SMS
 */
router.get('/sms/routing/status', async (req, res) => {
  try {
    const smsRouting = getSmsRoutingService();
    const status = smsRouting.getStatus();

    res.json({
      success: true,
      ...status
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v2/sms/balance
 * Solde de tous les providers SMS
 */
router.get('/sms/balance', requireAdmin, async (req, res) => {
  try {
    const smsRouting = getSmsRoutingService();
    const balances = await smsRouting.getAllBalances();

    res.json({
      success: true,
      balances
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== VoIP ====================

/**
 * GET /api/v2/voip/config/:extension
 * Configuration SIP pour WebRTC client
 */
router.get('/voip/config/:extension', async (req, res) => {
  try {
    const { extension } = req.params;
    const { password } = req.query;

    // Charger le provider FreePBX si pas déjà fait
    if (!freepbxProvider) {
      const FreePBXProvider = require('../providers/voip/FreePBXProvider');
      const voipConfigs = configService.getEnabledProviders('voip');

      if (voipConfigs.length > 0) {
        freepbxProvider = new FreePBXProvider(voipConfigs[0]);
        // Ne pas initialiser ici, juste récupérer la config
      }
    }

    if (!freepbxProvider) {
      return res.status(404).json({
        success: false,
        error: 'No VoIP provider configured'
      });
    }

    const sipConfig = freepbxProvider.getSipConfig(extension, password || '');

    res.json({
      success: true,
      config: sipConfig
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v2/voip/calls
 * Liste des appels actifs
 */
router.get('/voip/calls', async (req, res) => {
  try {
    if (!freepbxProvider) {
      return res.json({
        success: true,
        calls: []
      });
    }

    const calls = freepbxProvider.getActiveCalls();

    res.json({
      success: true,
      calls
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/v2/voip/call
 * Initier un appel sortant
 */
router.post('/voip/call', async (req, res) => {
  try {
    const { fromExtension, toNumber, callerIdName } = req.body;

    if (!fromExtension || !toNumber) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: fromExtension, toNumber'
      });
    }

    if (!freepbxProvider || !freepbxProvider.isConnected) {
      return res.status(503).json({
        success: false,
        error: 'VoIP service not available'
      });
    }

    const result = await freepbxProvider.originateCall(fromExtension, toNumber, {
      callerIdName
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== Helpers ====================

function getProviderDisplayName(type) {
  const names = {
    baileys: 'WhatsApp (Baileys)',
    meta_cloud: 'WhatsApp Business Cloud',
    sms_bridge: 'SMS Bridge Local',
    ovh: 'OVH SMS',
    twilio: 'Twilio SMS',
    plivo: 'Plivo SMS',
    messagebird: 'MessageBird',
    freepbx: 'FreePBX/Asterisk',
    yeastar: 'Yeastar PBX'
  };
  return names[type] || type;
}

function getProviderCapabilities(type) {
  const capabilities = {
    baileys: {
      sendText: true,
      sendMedia: true,
      receive: true,
      groups: true,
      qrAuth: true
    },
    meta_cloud: {
      sendText: true,
      sendMedia: true,
      receive: true,
      templates: true,
      webhook: true
    },
    sms_bridge: {
      sendText: true,
      receive: true,
      multiLine: true
    },
    ovh: {
      sendText: true,
      receive: true,
      deliveryReports: true,
      balance: true
    },
    twilio: {
      sendText: true,
      receive: true,
      mms: true,
      deliveryReports: true,
      balance: true
    },
    freepbx: {
      incomingCalls: true,
      outgoingCalls: true,
      webrtc: true,
      transfer: true,
      hold: true
    }
  };
  return capabilities[type] || {};
}

function sanitizeProviderConfig(provider) {
  const sanitized = JSON.parse(JSON.stringify(provider));

  // Masquer les champs sensibles
  if (sanitized.config) {
    const sensitiveFields = [
      'password', 'secret', 'token', 'api_key', 'auth_token',
      'ami_secret', 'app_secret', 'consumer_key', 'access_token'
    ];

    for (const field of sensitiveFields) {
      if (sanitized.config[field]) {
        sanitized.config[field] = '***';
      }
    }
  }

  return sanitized;
}

module.exports = router;
