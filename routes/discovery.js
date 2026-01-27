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
    // Build base URL from request
    const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${protocol}://${host}`;

    const result = {
      server: {
        name: 'Homenichat-serv',
        version: '1.0.0',
        timestamp: Date.now(),
        baseUrl, // Include server URL for auto-config
        capabilities: {
          whatsapp: true,
          sms: true,
          voip: true,
          modems: true,
          webrtc: true,
          cdr: true, // CDR API capability
        },
      },
      whatsapp: [],
      sms: [],
      voip: [],
      modems: [],
      cdr: null, // CDR configuration for mobile app
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
    // Modems provide both SMS and VoIP (GSM calls) capabilities
    try {
      const ModemService = require('../services/ModemService');
      const modemService = new ModemService({});
      const modemIds = await modemService.listModems();

      for (const modemId of modemIds) {
        const modemStatus = await modemService.collectModemStatus(modemId);
        const isConnected = modemStatus.state === 'Free';

        // Add to modems array
        result.modems.push({
          id: modemId,
          name: modemStatus.name || modemId,
          number: modemStatus.number,
          status: isConnected ? 'connected' : modemStatus.state,
          signal: modemStatus.rssiPercent,
          operator: modemStatus.operator,
        });

        // Add modem as SMS provider for 1-click config
        result.sms.push({
          id: `modem-sms-${modemId}`,
          name: `SMS via ${modemStatus.name || modemId}`,
          type: 'gsm_modem',
          status: isConnected ? 'connected' : 'disconnected',
          phone: modemStatus.number,
          modemId: modemId,
        });

        // Add modem as VoIP provider for 1-click config (GSM calls)
        result.voip.push({
          id: `modem-voip-${modemId}`,
          name: `Appels via ${modemStatus.name || modemId}`,
          type: 'gsm_trunk',
          status: isConnected ? 'connected' : 'disconnected',
          phone: modemStatus.number,
          modemId: modemId,
          dialString: `Quectel/${modemId}/$OUTNUM$`,
          extensions: [],
        });
      }
    } catch (e) {
      // ModemService not available or no modems - skip
    }

    // Get CDR API configuration (for 1-click setup)
    try {
      const asteriskCDRService = require('../services/AsteriskCDRService');
      const cdrStatus = await asteriskCDRService.getStatus();

      if (cdrStatus.connected) {
        // CDR is configured and connected
        // The mobile app will use the same JWT token for authentication
        // or can use CDR_API_TOKEN if configured
        result.cdr = {
          enabled: true,
          apiUrl: `${baseUrl}/api/cdr`, // Same server, /api/cdr endpoint
          // Don't expose the token here - the app should use the same JWT
          // or the user can configure CDR_API_TOKEN manually
          useJwtAuth: true, // Indicates to use the same JWT token
          status: 'connected',
          host: cdrStatus.host,
          totalRecords: cdrStatus.totalRecords || 0,
        };

        // If user has specific extensions configured, include them
        if (req.user && req.user.id && db) {
          const userVoip = db.getSetting(`user_${req.user.id}_voip`);
          if (userVoip && userVoip.extension) {
            result.cdr.extensions = [userVoip.extension];
          }
        }
      } else {
        result.cdr = {
          enabled: false,
          status: 'not_configured',
        };
      }
    } catch (e) {
      // CDR service not available
      result.cdr = {
        enabled: false,
        status: 'not_available',
      };
    }

    // VoIP credentials for 1-click setup
    if (req.user && req.user.id && db) {
      // PRIORITY 1: Check user_voip_extensions table (correct source, synced with Asterisk)
      const userVoipExt = db.getVoIPExtensionByUserId(req.user.id);

      // Fallback: Check old settings table (deprecated, may have stale data)
      let userVoipSettings = db.getSetting(`user_${req.user.id}_voip`);

      // Global VoIP config from environment
      const globalConfig = {
        server: process.env.VOIP_WSS_URL || `wss://${host?.split(':')[0]}/wss`,
        domain: process.env.VOIP_DOMAIN || host?.split(':')[0] || 'localhost',
        extension: process.env.VOIP_EXTENSION || '',
        password: process.env.VOIP_PASSWORD || '',
      };

      // PRIORITY 0: Explicit env config (VOIP_EXTENSION + VOIP_PASSWORD both set)
      // This takes highest priority as it represents admin's explicit config for external VoIP
      if (globalConfig.extension && globalConfig.password) {
        result.voipCredentials = {
          server: globalConfig.server,
          domain: globalConfig.domain,
          extension: globalConfig.extension,
          password: globalConfig.password,
          displayName: req.user.username || 'Homenichat User',
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        };

        // Update CDR extensions
        if (result.cdr && result.cdr.enabled) {
          result.cdr.extensions = [globalConfig.extension];
        }
        console.log(`[Discovery] Using env config for user ${req.user.id}: ext ${globalConfig.extension} @ ${globalConfig.domain}`);
      }
      // PRIORITY 1: Use user_voip_extensions table (correct credentials matching local Asterisk)
      else if (userVoipExt && userVoipExt.enabled && userVoipExt.webrtcEnabled && userVoipExt.extension && userVoipExt.secret) {
        result.voipCredentials = {
          server: globalConfig.server,
          domain: globalConfig.domain,
          extension: userVoipExt.extension,
          password: userVoipExt.secret,
          displayName: userVoipExt.displayName || req.user.username || 'Homenichat User',
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        };

        // Update CDR extensions
        if (result.cdr && result.cdr.enabled) {
          result.cdr.extensions = [userVoipExt.extension];
        }
        console.log(`[Discovery] Using user_voip_extensions for user ${req.user.id}: ext ${userVoipExt.extension}`);
      }
      // PRIORITY 2: Fallback to settings table (deprecated) if user_voip_extensions is empty
      else if (userVoipSettings && userVoipSettings.enabled && userVoipSettings.extension && userVoipSettings.password) {
        result.voipCredentials = {
          server: userVoipSettings.wssUrl || globalConfig.server,
          domain: userVoipSettings.domain || globalConfig.domain,
          extension: userVoipSettings.extension,
          password: userVoipSettings.password,
          displayName: req.user.username || 'Homenichat User',
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        };

        // Update CDR extensions
        if (result.cdr && result.cdr.enabled) {
          result.cdr.extensions = [userVoipSettings.extension];
        }
        console.log(`[Discovery] Using settings table (deprecated) for user ${req.user.id}: ext ${userVoipSettings.extension}`);
      }
      // PRIORITY 3: Try to auto-create via AMI (FreePBX) or PjsipConfigService (standalone)
      else {
        let extensionCreated = false;
        // Use next available extension from 1000 range (matches Asterisk standard)
        const extensionNumber = globalConfig.extension || db.getNextAvailableExtension(1000).toString();
        let secret = Math.random().toString(36).substring(2, 18);

        // Try AMI first (FreePBX)
        try {
          const freepbxAmi = require('../services/FreePBXAmiService');
          if (freepbxAmi.connected && freepbxAmi.authenticated) {
            const extResult = await freepbxAmi.createPjsipExtension({
              extension: extensionNumber,
              secret: secret,
              displayName: req.user.username || `User ${req.user.id}`,
              context: 'from-internal',
              transport: 'transport-wss',
              codecs: 'g722,ulaw,alaw,opus'
            });

            if (extResult.success) {
              extensionCreated = true;
              console.log(`[Discovery] Auto-created VoIP extension ${extensionNumber} for user ${req.user.id} via AMI`);
            }
          }
        } catch (e) {
          console.log(`[Discovery] AMI not available: ${e.message}`);
        }

        // Fallback to PjsipConfigService (standalone Asterisk)
        if (!extensionCreated) {
          try {
            const pjsipConfig = require('../services/PjsipConfigService');
            if (!pjsipConfig.loaded) {
              await pjsipConfig.load();
            }

            const asteriskCheck = await pjsipConfig.checkAsterisk();
            if (asteriskCheck.available) {
              const extResult = await pjsipConfig.getOrCreateExtension({
                extension: extensionNumber,
                password: secret,
                displayName: req.user.username || `User ${req.user.id}`,
                context: 'from-internal',
                codecs: ['g722', 'ulaw', 'alaw', 'opus'],
              });

              if (extResult.success) {
                extensionCreated = true;
                // Use returned password (may be existing password if extension already exists)
                secret = extResult.password;
                console.log(`[Discovery] VoIP extension ${extensionNumber} ${extResult.created ? 'created' : 'reused'} for user ${req.user.id} via PjsipConfig`);
              }
            }
          } catch (e) {
            console.log(`[Discovery] PjsipConfig failed: ${e.message}`);
          }
        }

        if (extensionCreated) {
          // Save to user_voip_extensions table (correct source of truth)
          try {
            db.createVoIPExtension({
              userId: req.user.id,
              extension: extensionNumber,
              secret: secret,
              displayName: req.user.username || `User ${req.user.id}`,
              context: 'from-internal',
              transport: 'transport-wss',
              codecs: 'g722,ulaw,alaw,opus',
              enabled: true,
              webrtcEnabled: true
            });
            console.log(`[Discovery] Saved extension ${extensionNumber} to user_voip_extensions for user ${req.user.id}`);
          } catch (e) {
            console.log(`[Discovery] Failed to save to user_voip_extensions: ${e.message}`);
          }

          result.voipCredentials = {
            server: globalConfig.server,
            domain: globalConfig.domain,
            extension: extensionNumber,
            password: secret,
            displayName: req.user.username || 'Homenichat User',
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' }
            ]
          };

          // Update CDR extensions
          if (result.cdr && result.cdr.enabled) {
            result.cdr.extensions = [extensionNumber];
          }
        }

        // PRIORITY 4: Fallback to global config if extension creation failed
        if (!extensionCreated) {
          if (globalConfig.extension && globalConfig.password) {
            // Global config has complete credentials
            result.voipCredentials = {
              server: globalConfig.server,
              domain: globalConfig.domain,
              extension: globalConfig.extension,
              password: globalConfig.password,
              displayName: req.user.username || 'Homenichat User',
              iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
              ],
            };
          } else if (globalConfig.server) {
            // Server configured but needs manual setup
            result.voipCredentials = {
              server: globalConfig.server,
              domain: globalConfig.domain,
              extension: globalConfig.extension || '',
              needsSetup: !globalConfig.extension,
              needsPassword: globalConfig.extension && !globalConfig.password,
              displayName: req.user.username || 'Homenichat User',
            };
          }
        }
      }
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
        hasVoipCredentials: !!result.voipCredentials?.extension,
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
    const discovery = await getDiscoveryData(req);

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
async function getDiscoveryData(req) {
  // Build base URL from request if available
  let baseUrl = '';
  if (req) {
    const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    baseUrl = `${protocol}://${host}`;
  }

  const result = {
    server: {
      name: 'Homenichat-serv',
      version: '1.0.0',
      timestamp: Date.now(),
      baseUrl,
    },
    whatsapp: [],
    sms: [],
    voip: [],
    modems: [],
    cdr: null,
    voipCredentials: null, // For 1-click VoIP setup
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

  // CDR configuration
  try {
    const asteriskCDRService = require('../services/AsteriskCDRService');
    const cdrStatus = await asteriskCDRService.getStatus();

    if (cdrStatus.connected) {
      result.cdr = {
        enabled: true,
        apiUrl: `${baseUrl}/api/cdr`,
        useJwtAuth: true,
        status: 'connected',
        totalRecords: cdrStatus.totalRecords || 0,
      };
    }
  } catch (e) {
    // CDR not available
  }

  // VoIP credentials for 1-click setup
  if (req && req.user && db) {
    // PRIORITY 1: Check user_voip_extensions table (correct source, synced with Asterisk)
    const userVoipExt = db.getVoIPExtensionByUserId(req.user.id);

    // Fallback: Check old settings table (deprecated)
    const userVoipSettings = db.getSetting(`user_${req.user.id}_voip`);

    const globalConfig = {
      server: process.env.VOIP_WSS_URL || `wss://${process.env.VOIP_DOMAIN || req.headers.host?.split(':')[0] || 'localhost'}/wss`,
      domain: process.env.VOIP_DOMAIN || req.headers.host?.split(':')[0] || 'localhost',
      extension: process.env.VOIP_EXTENSION || '',
      password: process.env.VOIP_PASSWORD || '',
    };

    // PRIORITY 0: Explicit env config (VOIP_EXTENSION + VOIP_PASSWORD both set)
    // This takes highest priority as it represents admin's explicit config for external VoIP
    if (globalConfig.extension && globalConfig.password) {
      result.voipCredentials = {
        server: globalConfig.server,
        domain: globalConfig.domain,
        extension: globalConfig.extension,
        password: globalConfig.password,
        displayName: req.user.username || 'Homenichat User',
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      };

      if (result.cdr && result.cdr.enabled) {
        result.cdr.extensions = [globalConfig.extension];
      }
      console.log(`[Discovery] Using env config for user ${req.user.id}: ext ${globalConfig.extension} @ ${globalConfig.domain}`);
    }
    // PRIORITY 1: Use user_voip_extensions table (correct credentials matching local Asterisk)
    else if (userVoipExt && userVoipExt.enabled && userVoipExt.webrtcEnabled && userVoipExt.extension && userVoipExt.secret) {
      result.voipCredentials = {
        server: globalConfig.server,
        domain: globalConfig.domain,
        extension: userVoipExt.extension,
        password: userVoipExt.secret,
        displayName: userVoipExt.displayName || req.user.username || 'Homenichat User',
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      };

      if (result.cdr && result.cdr.enabled) {
        result.cdr.extensions = [userVoipExt.extension];
      }
    }
    // PRIORITY 2: Fallback to settings table (deprecated)
    else if (userVoipSettings && userVoipSettings.enabled && userVoipSettings.extension && userVoipSettings.password) {
      result.voipCredentials = {
        server: userVoipSettings.wssUrl || globalConfig.server,
        domain: userVoipSettings.domain || globalConfig.domain,
        extension: userVoipSettings.extension,
        password: userVoipSettings.password,
        displayName: req.user.username || 'Homenichat User',
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      };

      if (result.cdr && result.cdr.enabled) {
        result.cdr.extensions = [userVoipSettings.extension];
      }
    }
    // PRIORITY 3: Try AMI auto-creation or PjsipConfigService
    else {
      let extensionCreated = false;
      const extensionNumber = globalConfig.extension || db.getNextAvailableExtension(1000).toString();
      let secret = Math.random().toString(36).substring(2, 18);

      // Try AMI first (FreePBX)
      try {
        const freepbxAmi = require('../services/FreePBXAmiService');
        if (freepbxAmi.connected && freepbxAmi.authenticated) {
          const extResult = await freepbxAmi.createPjsipExtension({
            extension: extensionNumber,
            secret: secret,
            displayName: req.user.username || `User ${req.user.id}`,
            context: 'from-internal',
            transport: 'transport-wss',
            codecs: 'g722,ulaw,alaw,opus'
          });

          if (extResult.success) {
            extensionCreated = true;
          }
        }
      } catch (e) {
        // AMI not available
      }

      // Fallback to PjsipConfigService (standalone Asterisk)
      if (!extensionCreated) {
        try {
          const pjsipConfig = require('../services/PjsipConfigService');
          if (!pjsipConfig.loaded) {
            await pjsipConfig.load();
          }

          const asteriskCheck = await pjsipConfig.checkAsterisk();
          if (asteriskCheck.available) {
            const extResult = await pjsipConfig.getOrCreateExtension({
              extension: extensionNumber,
              password: secret,
              displayName: req.user.username || `User ${req.user.id}`,
              context: 'from-internal',
              codecs: ['g722', 'ulaw', 'alaw', 'opus'],
            });

            if (extResult.success) {
              extensionCreated = true;
              // Use returned password (may be existing password if extension already exists)
              secret = extResult.password;
            }
          }
        } catch (e) {
          // PjsipConfig not available
        }
      }

      if (extensionCreated) {
        // Save to user_voip_extensions table (correct source of truth)
        try {
          db.createVoIPExtension({
            userId: req.user.id,
            extension: extensionNumber,
            secret: secret,
            displayName: req.user.username || `User ${req.user.id}`,
            context: 'from-internal',
            transport: 'transport-wss',
            codecs: 'g722,ulaw,alaw,opus',
            enabled: true,
            webrtcEnabled: true
          });
        } catch (e) {
          // Ignore save errors
        }

        result.voipCredentials = {
          server: globalConfig.server,
          domain: globalConfig.domain,
          extension: extensionNumber,
          password: secret,
          displayName: req.user.username || 'Homenichat User',
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        };

        if (result.cdr && result.cdr.enabled) {
          result.cdr.extensions = [extensionNumber];
        }
      }

      // PRIORITY 3: Fallback to global config
      if (!extensionCreated && globalConfig.server) {
        result.voipCredentials = {
          server: globalConfig.server,
          domain: globalConfig.domain,
          extension: globalConfig.extension,
          password: globalConfig.password || '',
          needsSetup: !globalConfig.extension,
          needsPassword: globalConfig.extension && !globalConfig.password,
          displayName: req.user.username || 'Homenichat User',
        };
      }
    }
  }

  return result;
}

module.exports = { router, initDiscoveryRoutes };
