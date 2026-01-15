/**
 * Discovery Routes - Auto-configuration endpoint for mobile apps
 *
 * Provides a single endpoint that returns all available trunks/providers
 * for 1-click configuration of the mobile app with Homenichat-serv.
 */

const express = require('express');
const router = express.Router();

// Services (will be injected)
let providerManager = null;
let securityService = null;
let db = null;

/**
 * Initialize routes with required services
 */
function initDiscoveryRoutes(services) {
  providerManager = services.providerManager;
  securityService = services.securityService;
  db = services.db;
  return router;
}

/**
 * GET /api/discovery
 *
 * Returns server information and all available providers/trunks.
 * This endpoint is used by the mobile app for 1-click configuration.
 *
 * Response format:
 * {
 *   server: { name, version, capabilities },
 *   whatsapp: [{ id, name, type, status, phone }],
 *   sms: [{ id, name, type, status, phone }],
 *   voip: [{ id, name, type, status, extensions }],
 *   modems: [{ id, name, number, status }]
 * }
 */
router.get('/', async (req, res) => {
  try {
    const result = {
      server: {
        name: 'Homenichat-serv',
        version: '1.0.0',
        timestamp: Date.now(),
        capabilities: {
          whatsapp: true,
          sms: true,
          voip: true,
          modems: true,
          webrtc: true,
        },
      },
      whatsapp: [],
      sms: [],
      voip: [],
      modems: [],
    };

    if (!providerManager) {
      return res.json(result);
    }

    // Get WhatsApp providers/sessions
    const baileysProvider = providerManager.providers?.get('baileys');
    if (baileysProvider) {
      const connState = await baileysProvider.getConnectionState?.() || {};
      const phoneNumber = baileysProvider.sock?.user?.id?.split('@')[0]?.split(':')[0] || null;

      result.whatsapp.push({
        id: 'baileys',
        name: 'WhatsApp (Baileys)',
        type: 'baileys',
        status: connState.isConnected ? 'connected' : 'disconnected',
        phone: phoneNumber,
        isDefault: true,
      });
    }

    // Get Meta Cloud API provider if configured
    const metaProvider = providerManager.providers?.get('meta');
    if (metaProvider) {
      const health = await metaProvider.getHealth?.() || {};
      result.whatsapp.push({
        id: 'meta',
        name: 'WhatsApp (Meta Cloud)',
        type: 'meta_cloud',
        status: health.isHealthy ? 'connected' : 'disconnected',
        phone: metaProvider.config?.phoneNumber || null,
      });
    }

    // Get SMS providers
    const configs = providerManager.getConfigs?.() || [];
    for (const config of configs) {
      if (config.category === 'sms' && config.enabled) {
        const status = await providerManager.getProviderStatus?.(config.id) || {};
        result.sms.push({
          id: config.id,
          name: config.name || config.type,
          type: config.type,
          status: status.connected ? 'connected' : 'disconnected',
          phone: config.config?.phoneNumber || config.config?.sender || null,
        });
      }

      // VoIP providers
      if (config.category === 'voip' && config.enabled) {
        const status = await providerManager.getProviderStatus?.(config.id) || {};
        result.voip.push({
          id: config.id,
          name: config.name || config.type,
          type: config.type,
          status: status.connected ? 'connected' : 'disconnected',
          extensions: config.config?.extensions || [],
        });
      }
    }

    // Get modems via ModemService (if available)
    try {
      const ModemService = require('../services/ModemService');
      const modemService = new ModemService({});
      const modemIds = await modemService.listModems();

      for (const modemId of modemIds) {
        const modemStatus = await modemService.collectModemStatus(modemId);
        result.modems.push({
          id: modemId,
          name: modemStatus.name || modemId,
          number: modemStatus.number,
          status: modemStatus.state === 'Free' ? 'connected' : modemStatus.state,
          signal: modemStatus.rssiPercent,
          operator: modemStatus.operator,
        });
      }
    } catch (e) {
      // ModemService not available or no modems - skip
    }

    // Log discovery access
    if (securityService && req.user) {
      await securityService.logAction(req.user.id, 'discovery_accessed', {
        category: 'api',
        username: req.user.username,
        whatsappCount: result.whatsapp.length,
        smsCount: result.sms.length,
        voipCount: result.voip.length,
        modemCount: result.modems.length,
      }, req);
    }

    res.json(result);

  } catch (error) {
    console.error('[Discovery] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/discovery/connect
 *
 * Validates connection and returns a session token for the app.
 * This is an alternative to the standard /api/auth/login for app-specific usage.
 */
router.post('/connect', async (req, res) => {
  try {
    const { deviceId, deviceName, platform } = req.body;

    // req.user is already set by auth middleware
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Log device connection
    if (securityService) {
      await securityService.logAction(req.user.id, 'app_connected', {
        category: 'auth',
        username: req.user.username,
        deviceId,
        deviceName,
        platform: platform || 'android',
      }, req);
    }

    // Return connection confirmation with discovery data
    const discovery = await getDiscoveryData();

    res.json({
      success: true,
      user: {
        id: req.user.id,
        username: req.user.username,
        role: req.user.role,
      },
      ...discovery,
    });

  } catch (error) {
    console.error('[Discovery] Connect error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/discovery/health
 *
 * Simple health check endpoint (no auth required)
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'Homenichat-serv',
    timestamp: Date.now(),
  });
});

/**
 * Helper function to get discovery data
 */
async function getDiscoveryData() {
  const result = {
    server: {
      name: 'Homenichat-serv',
      version: '1.0.0',
      timestamp: Date.now(),
    },
    whatsapp: [],
    sms: [],
    voip: [],
    modems: [],
  };

  if (!providerManager) return result;

  // WhatsApp
  const baileysProvider = providerManager.providers?.get('baileys');
  if (baileysProvider) {
    const connState = await baileysProvider.getConnectionState?.() || {};
    const phoneNumber = baileysProvider.sock?.user?.id?.split('@')[0]?.split(':')[0] || null;

    result.whatsapp.push({
      id: 'baileys',
      name: 'WhatsApp (Baileys)',
      type: 'baileys',
      status: connState.isConnected ? 'connected' : 'disconnected',
      phone: phoneNumber,
    });
  }

  return result;
}

module.exports = { router, initDiscoveryRoutes };
