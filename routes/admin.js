/**
 * Admin Routes - API d'administration Homenichat-serv
 *
 * Toutes les routes sont protégées par authentification admin.
 * Préfixe: /api/admin
 */

const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');

// Services (seront injectés)
let securityService = null;
let providerManager = null;
let sessionManager = null;
let configService = null;
let db = null;
let modemService = null;

// Import ModemService
const ModemService = require('../services/ModemService');

// Import TunnelService
const TunnelService = require('../services/TunnelService');
let tunnelService = null;

/**
 * Initialise les routes avec les services nécessaires
 */
function initAdminRoutes(services) {
  securityService = services.securityService;
  providerManager = services.providerManager;
  sessionManager = services.sessionManager;
  configService = services.configService;
  db = services.db;

  // Initialize ModemService
  modemService = new ModemService({
    modems: services.modemConfig || {},
    logger: console,
  });

  // Initialize TunnelService
  tunnelService = new TunnelService({
    port: services.port || 3001,
    dataDir: services.dataDir || '/var/lib/homenichat',
  });

  return router;
}

// Middleware de validation
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  }
  next();
};

// =============================================================================
// DASHBOARD
// =============================================================================

/**
 * GET /api/admin/dashboard
 * Statistiques globales du serveur
 */
router.get('/dashboard', async (req, res) => {
  try {
    const stats = {
      timestamp: Date.now(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),

      // Stats providers
      providers: {
        whatsapp: [],
        sms: [],
        voip: [],
      },

      // Stats sécurité
      security: await securityService?.getSecurityStats() || null,

      // Stats messages (dernières 24h)
      messages: {
        sent: 0,
        received: 0,
        failed: 0,
      },

      // Sessions WhatsApp
      whatsappSessions: [],
    };

    // Récupérer les stats des providers
    if (providerManager) {
      const configs = providerManager.getConfigs?.() || [];
      for (const config of configs) {
        const status = await providerManager.getProviderStatus?.(config.id) || { connected: false };
        const providerInfo = {
          id: config.id,
          name: config.name || config.type,
          type: config.type,
          enabled: config.enabled,
          connected: status.connected,
          lastCheck: status.lastCheck,
        };

        if (config.category === 'whatsapp') {
          stats.providers.whatsapp.push(providerInfo);
        } else if (config.category === 'sms') {
          stats.providers.sms.push(providerInfo);
        } else if (config.category === 'voip') {
          stats.providers.voip.push(providerInfo);
        }
      }
    }

    // Récupérer les sessions WhatsApp
    // Inclure d'abord le provider Baileys par défaut
    if (providerManager) {
      const baileysProvider = providerManager.providers?.get('baileys');
      if (baileysProvider) {
        const connState = await baileysProvider.getConnectionState?.() || {};
        const phoneNumber = baileysProvider.sock?.user?.id?.split('@')[0]?.split(':')[0] || null;
        stats.whatsappSessions.push({
          id: 'baileys',
          name: 'WhatsApp (Baileys)',
          status: connState.isConnected ? 'connected' : (connState.qrCode ? 'qr_pending' : 'disconnected'),
          phoneNumber: phoneNumber,
          isDefault: true,
        });
      }
    }
    // Ajouter les sessions additionnelles du SessionManager
    if (sessionManager) {
      const managedSessions = await sessionManager.listSessions?.() || [];
      stats.whatsappSessions = stats.whatsappSessions.concat(managedSessions.filter(s => s.id !== 'baileys'));
    }

    // Stats messages depuis la DB
    if (db) {
      const last24h = Date.now() - (24 * 60 * 60 * 1000);
      try {
        stats.messages.sent = db.prepare(
          "SELECT COUNT(*) as count FROM messages WHERE timestamp > ? AND from_me = 1"
        ).get(last24h)?.count || 0;

        stats.messages.received = db.prepare(
          "SELECT COUNT(*) as count FROM messages WHERE timestamp > ? AND from_me = 0"
        ).get(last24h)?.count || 0;

        stats.messages.failed = db.prepare(
          "SELECT COUNT(*) as count FROM messages WHERE timestamp > ? AND status = 'failed'"
        ).get(last24h)?.count || 0;
      } catch (e) {
        // Tables might not exist yet
      }
    }

    res.json(stats);

  } catch (error) {
    console.error('[Admin] Dashboard error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// PROVIDERS MANAGEMENT
// =============================================================================

/**
 * GET /api/admin/providers
 * Liste tous les providers configurés
 */
router.get('/providers', async (req, res) => {
  try {
    const providers = [];

    if (providerManager) {
      const configs = providerManager.getConfigs?.() || [];

      for (const config of configs) {
        const status = await providerManager.getProviderStatus?.(config.id) || { connected: false };
        providers.push({
          ...config,
          // Ne pas exposer les secrets
          config: maskSecrets(config.config),
          status,
        });
      }
    }

    res.json({ providers });

  } catch (error) {
    console.error('[Admin] List providers error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/providers
 * Ajouter un nouveau provider
 */
router.post('/providers', [
  body('type').notEmpty().withMessage('Type is required'),
  body('category').isIn(['sms', 'whatsapp', 'voip']).withMessage('Invalid category'),
  body('config').isObject().withMessage('Config must be an object'),
], validate, async (req, res) => {
  try {
    const { type, category, name, config, enabled = true } = req.body;
    const id = `${type}_${Date.now()}`;

    const providerConfig = {
      id,
      type,
      category,
      name: name || type,
      mode: config.serverUrl ? 'server' : 'direct',
      enabled,
      configured: true,
      config,
    };

    if (providerManager) {
      await providerManager.saveProviderConfig?.(providerConfig);

      if (enabled) {
        try {
          await providerManager.initializeProvider?.(providerConfig);
        } catch (initError) {
          // Log but don't fail - config is saved
          console.warn('[Admin] Provider init warning:', initError.message);
        }
      }
    }

    await securityService?.logAction(req.user.id, 'provider_created', {
      category: 'admin',
      resource: `provider:${id}`,
      providerType: type,
      username: req.user.username,
    }, req);

    res.status(201).json({
      success: true,
      provider: { ...providerConfig, config: maskSecrets(config) },
    });

  } catch (error) {
    console.error('[Admin] Create provider error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/admin/providers/:id
 * Modifier un provider existant
 */
router.put('/providers/:id', [
  param('id').notEmpty(),
  body('config').optional().isObject(),
], validate, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    if (!providerManager) {
      return res.status(503).json({ error: 'Provider manager not available' });
    }

    const existing = providerManager.getConfig?.(id);
    if (!existing) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    const updatedConfig = {
      ...existing,
      ...updates,
      id, // Prevent ID change
      config: updates.config ? { ...existing.config, ...updates.config } : existing.config,
    };

    await providerManager.saveProviderConfig?.(updatedConfig);

    // Réinitialiser si nécessaire
    if (updates.enabled !== undefined || updates.config) {
      try {
        await providerManager.disconnectProvider?.(id);
        if (updatedConfig.enabled) {
          await providerManager.initializeProvider?.(updatedConfig);
        }
      } catch (reinitError) {
        console.warn('[Admin] Provider reinit warning:', reinitError.message);
      }
    }

    await securityService?.logAction(req.user.id, 'provider_updated', {
      category: 'admin',
      resource: `provider:${id}`,
      username: req.user.username,
    }, req);

    res.json({
      success: true,
      provider: { ...updatedConfig, config: maskSecrets(updatedConfig.config) },
    });

  } catch (error) {
    console.error('[Admin] Update provider error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/admin/providers/:id
 * Supprimer un provider
 */
router.delete('/providers/:id', [
  param('id').notEmpty(),
], validate, async (req, res) => {
  try {
    const { id } = req.params;

    if (!providerManager) {
      return res.status(503).json({ error: 'Provider manager not available' });
    }

    await providerManager.disconnectProvider?.(id);
    await providerManager.removeProviderConfig?.(id);

    await securityService?.logAction(req.user.id, 'provider_deleted', {
      category: 'admin',
      resource: `provider:${id}`,
      username: req.user.username,
    }, req);

    res.json({ success: true });

  } catch (error) {
    console.error('[Admin] Delete provider error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/providers/:id/test
 * Tester la connexion d'un provider
 */
router.post('/providers/:id/test', [
  param('id').notEmpty(),
], validate, async (req, res) => {
  try {
    const { id } = req.params;

    if (!providerManager) {
      return res.status(503).json({ error: 'Provider manager not available' });
    }

    const config = providerManager.getConfig?.(id);
    if (!config) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    // Tenter l'initialisation
    try {
      await providerManager.initializeProvider?.(config);
      const status = await providerManager.getProviderStatus?.(id);

      res.json({
        success: true,
        connected: status?.connected || false,
        message: status?.connected ? 'Connection successful' : 'Connection failed',
      });
    } catch (testError) {
      res.json({
        success: false,
        connected: false,
        message: testError.message,
      });
    }

  } catch (error) {
    console.error('[Admin] Test provider error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// WHATSAPP / BAILEYS SESSIONS
// =============================================================================

/**
 * GET /api/admin/whatsapp/sessions
 * Liste les sessions WhatsApp
 */
router.get('/whatsapp/sessions', async (req, res) => {
  try {
    let sessions = [];

    // Inclure le provider Baileys par défaut s'il existe
    if (providerManager) {
      const baileysProvider = providerManager.providers?.get('baileys');
      if (baileysProvider) {
        const connState = await baileysProvider.getConnectionState?.() || {};
        const phoneNumber = baileysProvider.sock?.user?.id?.split('@')[0]?.split(':')[0] || null;
        sessions.push({
          id: 'baileys',
          name: 'WhatsApp (Baileys)',
          status: connState.isConnected ? 'connected' : (connState.qrCode ? 'qr_pending' : 'disconnected'),
          phoneNumber: phoneNumber,
          isDefault: true,
          createdAt: null,
        });
      }
    }

    // Ajouter les sessions du SessionManager si disponible
    if (sessionManager) {
      const managedSessions = await sessionManager.listSessions?.() || [];
      sessions = sessions.concat(managedSessions.filter(s => s.id !== 'baileys'));
    }

    res.json({ sessions });

  } catch (error) {
    console.error('[Admin] List WhatsApp sessions error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/whatsapp/sessions
 * Créer une nouvelle session WhatsApp (Baileys)
 * NOTE: Pour éviter les conflits, on utilise le provider baileys par défaut
 */
router.post('/whatsapp/sessions', [
  body('name').optional().isString(),
], validate, async (req, res) => {
  try {
    // Vérifier si le provider Baileys par défaut existe déjà
    if (providerManager) {
      const baileysProvider = providerManager.providers?.get('baileys');
      if (baileysProvider) {
        const health = await baileysProvider.getHealth?.() || {};

        // Si déjà connecté, retourner l'info existante
        if (health.isConnected) {
          return res.status(200).json({
            success: true,
            sessionId: 'baileys',
            message: 'Session already connected',
            alreadyExists: true,
          });
        }

        // Si pas connecté, réinitialiser pour obtenir un nouveau QR
        if (!baileysProvider.qrCode) {
          await baileysProvider.initialize();
        }

        return res.status(200).json({
          success: true,
          sessionId: 'baileys',
          message: 'Use /api/admin/whatsapp/qr/baileys to get QR code.',
          alreadyExists: true,
        });
      }
    }

    // Fallback: créer via SessionManager si pas de provider par défaut
    const { name } = req.body;
    const sessionId = `baileys_${Date.now()}`;

    if (!sessionManager) {
      return res.status(503).json({ error: 'Session manager not available' });
    }

    await sessionManager.createSession?.(sessionId, {
      providerType: 'baileys',
      name: name || `WhatsApp ${new Date().toLocaleDateString()}`,
    });

    await securityService?.logAction(req.user.id, 'whatsapp_session_created', {
      category: 'admin',
      resource: `session:${sessionId}`,
      username: req.user.username,
    }, req);

    res.status(201).json({
      success: true,
      sessionId,
      message: 'Session created. Use /api/admin/whatsapp/qr/:id to get QR code.',
    });

  } catch (error) {
    console.error('[Admin] Create WhatsApp session error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/whatsapp/qr/:id
 * Obtenir le QR code pour une session Baileys
 */
router.get('/whatsapp/qr/:id', [
  param('id').notEmpty(),
], validate, async (req, res) => {
  try {
    const { id } = req.params;

    if (!providerManager) {
      return res.status(503).json({ error: 'Provider manager not available' });
    }

    // Chercher le provider Baileys
    const qrCode = await providerManager.getQrCode?.(id);

    if (qrCode) {
      res.json({ qr: qrCode, status: 'qr_pending' });
    } else {
      res.json({ qr: null, status: 'waiting', message: 'No QR code available. Session may already be connected.' });
    }

  } catch (error) {
    console.error('[Admin] Get QR code error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/admin/whatsapp/sessions/:id
 * Déconnecter et supprimer une session WhatsApp
 */
router.delete('/whatsapp/sessions/:id', [
  param('id').notEmpty(),
], validate, async (req, res) => {
  try {
    const { id } = req.params;

    if (sessionManager) {
      await sessionManager.removeSession?.(id);
    }

    await securityService?.logAction(req.user.id, 'whatsapp_session_deleted', {
      category: 'admin',
      resource: `session:${id}`,
      username: req.user.username,
    }, req);

    res.json({ success: true });

  } catch (error) {
    console.error('[Admin] Delete WhatsApp session error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// MODEMS - GSM Modem Management via chan_quectel/Asterisk
// =============================================================================

/**
 * GET /api/admin/modems
 * Liste les modems détectés (format compatible avec SmsPage)
 */
router.get('/modems', async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const modemIds = await modemService.listModems();
    const modems = [];
    const modemConfig = modemService.getModemConfig();

    for (const id of modemIds) {
      const status = await modemService.collectModemStatus(id);

      // Transformer en format compatible avec SmsPage
      modems.push({
        id: status.id,
        device: status.name || status.id,
        type: status.model || modemConfig.modemType?.toUpperCase() || 'GSM',
        status: status.state === 'Free' ? 'connected' :
                status.needsPin ? 'error' :
                status.state?.toLowerCase().includes('not') ? 'disconnected' : 'connected',
        signal: status.rssiPercent || 0,
        operator: status.operator || 'Unknown',
        phone: status.number || modemConfig.phoneNumber || '',
        // Données étendues
        technology: status.technology,
        imei: status.imei,
        registered: status.registered,
        voice: status.voice,
        sms: status.sms,
        smsEnabled: modemConfig.sms?.enabled !== false,
      });
    }

    res.json({ modems });

  } catch (error) {
    console.error('[Admin] List modems error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/sms/stats
 * Statistiques SMS détaillées
 */
router.get('/sms/stats', async (req, res) => {
  try {
    const stats = {
      total: { sent: 0, received: 0, failed: 0, pending: 0 },
      today: { sent: 0, received: 0 },
      week: { sent: 0, received: 0 },
      storage: { count: 0, sizeKb: 0 },
      lastActivity: null,
    };

    if (db) {
      const now = Date.now();
      const todayStart = now - (24 * 60 * 60 * 1000);
      const weekStart = now - (7 * 24 * 60 * 60 * 1000);

      try {
        // Stats totales - FILTRÉES PAR PROVIDER SMS
        stats.total.sent = db.prepare(
          "SELECT COUNT(*) as count FROM messages m JOIN chats c ON m.chat_id = c.id WHERE c.provider = 'sms' AND m.from_me = 1"
        ).get()?.count || 0;

        stats.total.received = db.prepare(
          "SELECT COUNT(*) as count FROM messages m JOIN chats c ON m.chat_id = c.id WHERE c.provider = 'sms' AND m.from_me = 0"
        ).get()?.count || 0;

        stats.total.failed = db.prepare(
          "SELECT COUNT(*) as count FROM messages m JOIN chats c ON m.chat_id = c.id WHERE c.provider = 'sms' AND m.status = 'failed'"
        ).get()?.count || 0;

        stats.total.pending = db.prepare(
          "SELECT COUNT(*) as count FROM messages m JOIN chats c ON m.chat_id = c.id WHERE c.provider = 'sms' AND m.status = 'pending'"
        ).get()?.count || 0;

        // Stats aujourd'hui
        stats.today.sent = db.prepare(
          "SELECT COUNT(*) as count FROM messages m JOIN chats c ON m.chat_id = c.id WHERE c.provider = 'sms' AND m.timestamp > ? AND m.from_me = 1"
        ).get(todayStart)?.count || 0;

        stats.today.received = db.prepare(
          "SELECT COUNT(*) as count FROM messages m JOIN chats c ON m.chat_id = c.id WHERE c.provider = 'sms' AND m.timestamp > ? AND m.from_me = 0"
        ).get(todayStart)?.count || 0;

        // Stats semaine
        stats.week.sent = db.prepare(
          "SELECT COUNT(*) as count FROM messages m JOIN chats c ON m.chat_id = c.id WHERE c.provider = 'sms' AND m.timestamp > ? AND m.from_me = 1"
        ).get(weekStart)?.count || 0;

        stats.week.received = db.prepare(
          "SELECT COUNT(*) as count FROM messages m JOIN chats c ON m.chat_id = c.id WHERE c.provider = 'sms' AND m.timestamp > ? AND m.from_me = 0"
        ).get(weekStart)?.count || 0;

        // Stockage SMS uniquement
        stats.storage.count = db.prepare(
          "SELECT COUNT(*) as count FROM messages m JOIN chats c ON m.chat_id = c.id WHERE c.provider = 'sms'"
        ).get()?.count || 0;

        // Dernière activité SMS
        const lastMsg = db.prepare(
          "SELECT MAX(m.timestamp) as ts FROM messages m JOIN chats c ON m.chat_id = c.id WHERE c.provider = 'sms'"
        ).get();
        stats.lastActivity = lastMsg?.ts ? new Date(lastMsg.ts).toISOString() : null;

      } catch (e) {
        console.warn('[Admin] SMS stats DB error:', e.message);
      }
    }

    // Ajouter config modem SMS si disponible
    if (modemService) {
      const config = modemService.getModemConfig();
      stats.config = {
        enabled: config.sms?.enabled !== false,
        storage: config.sms?.storage || 'sqlite',
        autoDelete: config.sms?.autoDelete !== false,
      };
    }

    res.json(stats);

  } catch (error) {
    console.error('[Admin] SMS stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/modems/full-status
 * État complet de tous les modems, services, système
 */
router.get('/modems/full-status', async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const data = await modemService.collectAll();
    res.json(data);

  } catch (error) {
    console.error('[Admin] Full modem status error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/modems/watchdog-logs
 * Logs du watchdog
 */
router.get('/modems/watchdog-logs', [
  query('lines').optional().isInt({ min: 1, max: 200 }).toInt(),
], validate, async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const { lines = 30 } = req.query;
    const logs = await modemService.collectWatchdogLogs(lines);
    res.json(logs);

  } catch (error) {
    console.error('[Admin] Watchdog logs error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/modems/scan
 * Scanner les ports USB pour détecter les modems
 */
router.post('/modems/scan', async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const modems = await modemService.listModems();
    const results = [];

    for (const id of modems) {
      const status = await modemService.collectModemStatus(id);
      results.push(status);
    }

    await securityService?.logAction(req.user.id, 'modems_scanned', {
      category: 'admin',
      modemCount: results.length,
      username: req.user.username,
    }, req);

    res.json({ modems: results });

  } catch (error) {
    console.error('[Admin] Scan modems error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/modems/:id/status
 * État d'un modem spécifique
 */
router.get('/modems/:id/status', [
  param('id').notEmpty(),
], validate, async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const { id } = req.params;
    const status = await modemService.collectModemStatus(id);
    const stats = await modemService.collectModemStats(id);

    res.json({ status, stats });

  } catch (error) {
    console.error('[Admin] Get modem status error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/modems/:id/restart
 * Redémarrer un modem
 */
router.post('/modems/:id/restart', [
  param('id').notEmpty(),
], validate, async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const { id } = req.params;
    const result = await modemService.restartModem(id);

    await securityService?.logAction(req.user.id, 'modem_restarted', {
      category: 'admin',
      resource: `modem:${id}`,
      username: req.user.username,
    }, req);

    res.json(result);

  } catch (error) {
    console.error('[Admin] Restart modem error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/modems/:id/at-command
 * Envoyer une commande AT
 */
router.post('/modems/:id/at-command', [
  param('id').notEmpty(),
  body('command').notEmpty().matches(/^AT/i).withMessage('Command must start with AT'),
], validate, async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const { id } = req.params;
    const { command } = req.body;
    const result = await modemService.sendAtCommand(id, command);

    await securityService?.logAction(req.user.id, 'at_command_sent', {
      category: 'admin',
      resource: `modem:${id}`,
      command,
      username: req.user.username,
    }, req);

    res.json(result);

  } catch (error) {
    console.error('[Admin] AT command error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/modems/:id/sms
 * Envoyer un SMS via un modem
 */
router.post('/modems/:id/sms', [
  param('id').notEmpty(),
  body('to').matches(/^\+?[0-9]{6,15}$/).withMessage('Invalid phone number'),
  body('message').notEmpty().isLength({ max: 500 }).withMessage('Message required (max 500 chars)'),
], validate, async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const { id } = req.params;
    const { to, message } = req.body;
    const result = await modemService.sendSms(id, to, message);

    await securityService?.logAction(req.user.id, 'sms_sent_via_modem', {
      category: 'admin',
      resource: `modem:${id}`,
      to,
      username: req.user.username,
    }, req);

    res.json(result);

  } catch (error) {
    console.error('[Admin] Send SMS via modem error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/modems/:id/configure-audio
 * Configure l'audio 16kHz pour un modem
 */
router.post('/modems/:id/configure-audio', [
  param('id').notEmpty(),
], validate, async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const { id } = req.params;
    const result = await modemService.configureAudio(id);

    await securityService?.logAction(req.user.id, 'modem_audio_configured', {
      category: 'admin',
      resource: `modem:${id}`,
      username: req.user.username,
    }, req);

    res.json(result);

  } catch (error) {
    console.error('[Admin] Configure audio error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/modems/restart-asterisk
 * Redémarrer Asterisk
 */
router.post('/modems/restart-asterisk', async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const result = await modemService.restartAsterisk();

    await securityService?.logAction(req.user.id, 'asterisk_restarted', {
      category: 'admin',
      username: req.user.username,
    }, req);

    res.json(result);

  } catch (error) {
    console.error('[Admin] Restart Asterisk error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/modems/restart-services
 * Redémarrer tous les services modem
 */
router.post('/modems/restart-services', async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const result = await modemService.restartAllServices();

    await securityService?.logAction(req.user.id, 'modem_services_restarted', {
      category: 'admin',
      username: req.user.username,
    }, req);

    res.json(result);

  } catch (error) {
    console.error('[Admin] Restart services error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// MODEMS CONFIGURATION - EC25/SIM7600, PIN, Ports
// =============================================================================

/**
 * GET /api/admin/modems/config
 * Récupère la configuration modem actuelle
 */
router.get('/modems/config', async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const config = modemService.getModemConfig();
    const profiles = modemService.getModemProfiles();

    // Ne pas exposer le PIN complet
    if (config.pinCode) {
      config.pinConfigured = true;
      config.pinCode = '****';
    } else {
      config.pinConfigured = false;
    }

    res.json({ config, profiles });

  } catch (error) {
    console.error('[Admin] Get modem config error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/admin/modems/config
 * Met à jour la configuration modem
 */
router.put('/modems/config', [
  body('modemType').optional().isIn(['ec25', 'sim7600']),
  body('modemName').optional().matches(/^[a-z0-9-]+$/i).withMessage('Invalid modem name'),
  body('phoneNumber').optional().matches(/^\+?[0-9]{0,15}$/),
  body('dataPort').optional().matches(/^\/dev\/ttyUSB\d+$/),
  body('audioPort').optional().matches(/^\/dev\/ttyUSB\d+$/),
  body('autoDetect').optional().isBoolean(),
  // SMS Configuration
  body('sms.enabled').optional().isBoolean(),
  body('sms.storage').optional().isIn(['sqlite', 'modem', 'sim']),
  body('sms.autoDelete').optional().isBoolean(),
  body('sms.deliveryReports').optional().isBoolean(),
  body('sms.serviceCenter').optional().matches(/^\+?[0-9]{0,15}$/),
  body('sms.encoding').optional().isIn(['auto', 'gsm7', 'ucs2']),
], validate, async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const updates = req.body;

    // Sauvegarder la config
    modemService.saveModemConfig(updates);

    await securityService?.logAction(req.user.id, 'modem_config_updated', {
      category: 'admin',
      modemType: updates.modemType,
      username: req.user.username,
    }, req);

    res.json({ success: true, config: modemService.getModemConfig() });

  } catch (error) {
    console.error('[Admin] Update modem config error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/modems/profiles
 * Liste les profils de modem disponibles
 */
router.get('/modems/profiles', async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const profiles = modemService.getModemProfiles();
    res.json({ profiles });

  } catch (error) {
    console.error('[Admin] Get modem profiles error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/modems/detect
 * Détecte automatiquement les ports USB et type de modem
 */
router.post('/modems/detect', async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const detected = await modemService.detectUsbPorts();

    await securityService?.logAction(req.user.id, 'modem_detection', {
      category: 'admin',
      portsFound: detected.ports?.length || 0,
      modemType: detected.modemType,
      username: req.user.username,
    }, req);

    res.json(detected);

  } catch (error) {
    console.error('[Admin] Modem detection error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/modems/sim-status
 * Vérifie l'état du PIN SIM
 */
router.get('/modems/sim-status', async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const modemId = req.query.modemId || null;
    const status = await modemService.checkSimPin(modemId);

    res.json(status);

  } catch (error) {
    console.error('[Admin] SIM status error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/modems/pin-status
 * Récupère le statut des tentatives PIN
 */
router.get('/modems/pin-status', async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const modemId = req.query.modemId || null;
    const simStatus = await modemService.checkSimPin(modemId);
    const attemptsStatus = modemService.getPinAttemptsRemaining();

    res.json({
      ...simStatus,
      ...attemptsStatus,
    });

  } catch (error) {
    console.error('[Admin] PIN status error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/modems/enter-pin
 * Entre le code PIN SIM
 */
router.post('/modems/enter-pin', [
  body('pin').matches(/^\d{4,8}$/).withMessage('PIN must be 4-8 digits'),
  body('pinConfirm').matches(/^\d{4,8}$/).withMessage('PIN confirmation required'),
  body('modemId').optional().isString(),
], validate, async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const { pin, pinConfirm, modemId } = req.body;

    // Vérifier que les deux PIN correspondent
    if (pin !== pinConfirm) {
      return res.status(400).json({
        error: 'Les codes PIN ne correspondent pas. Veuillez réessayer.',
        success: false,
      });
    }

    // Vérifier le statut des tentatives
    const attemptsStatus = modemService.getPinAttemptsRemaining();
    if (attemptsStatus.isLocked) {
      return res.status(403).json({
        error: 'Trop de tentatives échouées. Contactez l\'administrateur pour réinitialiser.',
        success: false,
        ...attemptsStatus,
      });
    }

    const result = await modemService.enterSimPin(pin, modemId);

    await securityService?.logAction(req.user.id, 'sim_pin_entered', {
      category: 'admin',
      success: result.success,
      username: req.user.username,
    }, req);

    res.json({
      ...result,
      ...modemService.getPinAttemptsRemaining(),
    });

  } catch (error) {
    console.error('[Admin] Enter PIN error:', error);
    res.status(400).json({
      error: error.message,
      success: false,
      ...modemService.getPinAttemptsRemaining(),
    });
  }
});

/**
 * POST /api/admin/modems/reset-pin-attempts
 * Réinitialise le compteur de tentatives PIN (admin seulement)
 */
router.post('/modems/reset-pin-attempts', async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const result = modemService.resetPinAttempts();

    await securityService?.logAction(req.user.id, 'pin_attempts_reset', {
      category: 'admin',
      username: req.user.username,
    }, req);

    res.json(result);

  } catch (error) {
    console.error('[Admin] Reset PIN attempts error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/modems/quectel-conf
 * Récupère le contenu actuel de quectel.conf
 */
router.get('/modems/quectel-conf', async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const content = modemService.readQuectelConf();
    const preview = modemService.generateQuectelConf();

    res.json({
      current: content,
      preview: preview,
    });

  } catch (error) {
    console.error('[Admin] Get quectel.conf error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/modems/apply-config
 * Applique la configuration (génère quectel.conf et recharge Asterisk)
 */
router.post('/modems/apply-config', [
  body('modemType').optional().isIn(['ec25', 'sim7600']),
  body('modemName').optional().matches(/^[a-z0-9-]+$/i),
  body('phoneNumber').optional().matches(/^\+?[0-9]{0,15}$/),
  body('dataPort').optional().matches(/^\/dev\/ttyUSB\d+$/),
  body('audioPort').optional().matches(/^\/dev\/ttyUSB\d+$/),
], validate, async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const config = req.body;
    const result = await modemService.applyQuectelConf(config);

    await securityService?.logAction(req.user.id, 'modem_config_applied', {
      category: 'admin',
      modemType: config.modemType || modemService.getModemConfig().modemType,
      username: req.user.username,
    }, req);

    res.json(result);

  } catch (error) {
    console.error('[Admin] Apply config error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/modems/initialize
 * Initialise le modem (PIN + audio config)
 */
router.post('/modems/initialize', [
  body('modemId').optional().isString(),
], validate, async (req, res) => {
  try {
    if (!modemService) {
      return res.status(503).json({ error: 'Modem service not available' });
    }

    const { modemId } = req.body;
    const result = await modemService.initializeModem(modemId);

    await securityService?.logAction(req.user.id, 'modem_initialized', {
      category: 'admin',
      modemId,
      success: result.success,
      username: req.user.username,
    }, req);

    res.json(result);

  } catch (error) {
    console.error('[Admin] Initialize modem error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// MODEM SIP TRUNKS - Auto-configuration chan_quectel -> FreePBX
// =============================================================================

/**
 * GET /api/admin/modems/:modemId/trunk
 * Récupérer le statut du trunk SIP pour un modem
 */
router.get('/modems/:modemId/trunk', async (req, res) => {
  try {
    const amiService = require('../services/FreePBXAmiService');
    const { modemId } = req.params;

    if (!amiService.connected || !amiService.authenticated) {
      return res.json({
        exists: false,
        error: 'FreePBX non connecté',
        canCreate: false,
      });
    }

    const status = await amiService.getModemTrunkStatus(modemId);
    res.json({
      ...status,
      canCreate: true,
    });

  } catch (error) {
    console.error('[Admin] Get modem trunk status error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/modems/:modemId/trunk
 * Créer un trunk SIP FreePBX pour un modem GSM
 */
router.post('/modems/:modemId/trunk', [
  param('modemId').notEmpty(),
  body('phoneNumber').optional().matches(/^\+?[0-9]{6,15}$/),
  body('modemName').optional().isString().isLength({ max: 20 }),
  body('context').optional().isString().isLength({ max: 30 }),
  body('maxChannels').optional().isInt({ min: 1, max: 4 }),
  body('callerIdMode').optional().isIn(['keep', 'trunk', 'none']),
], validate, async (req, res) => {
  try {
    const amiService = require('../services/FreePBXAmiService');
    const { modemId } = req.params;

    if (!amiService.connected || !amiService.authenticated) {
      return res.status(503).json({
        error: 'FreePBX non connecté',
        suggestion: 'Vérifiez la configuration AMI dans les variables d\'environnement',
      });
    }

    // Get modem config for defaults
    let modemConfig = {};
    if (modemService) {
      try {
        const fullStatus = await modemService.getFullStatus();
        if (fullStatus?.modems?.[modemId]) {
          modemConfig = fullStatus.modems[modemId].status || {};
        }
      } catch (e) {
        // Use provided values
      }
    }

    // Build trunk config with defaults
    const trunkConfig = {
      modemId,
      modemName: req.body.modemName || modemConfig.name || modemId,
      phoneNumber: req.body.phoneNumber || modemConfig.number || '',
      context: req.body.context || 'from-gsm',
      maxChannels: req.body.maxChannels || 1,
      callerIdMode: req.body.callerIdMode || 'keep',
    };

    const result = await amiService.createModemTrunk(trunkConfig);

    if (result.success) {
      await securityService?.logAction(req.user.id, 'modem_trunk_created', {
        category: 'admin',
        modemId,
        trunkName: result.trunkName,
        phoneNumber: trunkConfig.phoneNumber,
        username: req.user.username,
      }, req);
    }

    res.json({
      ...result,
      config: trunkConfig,
    });

  } catch (error) {
    console.error('[Admin] Create modem trunk error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/admin/modems/:modemId/trunk
 * Supprimer le trunk SIP d'un modem
 */
router.delete('/modems/:modemId/trunk', [
  param('modemId').notEmpty(),
], validate, async (req, res) => {
  try {
    const amiService = require('../services/FreePBXAmiService');
    const { modemId } = req.params;

    if (!amiService.connected || !amiService.authenticated) {
      return res.status(503).json({ error: 'FreePBX non connecté' });
    }

    const result = await amiService.deleteModemTrunk(modemId);

    if (result.success) {
      await securityService?.logAction(req.user.id, 'modem_trunk_deleted', {
        category: 'admin',
        modemId,
        username: req.user.username,
      }, req);
    }

    res.json(result);

  } catch (error) {
    console.error('[Admin] Delete modem trunk error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/modems/trunk-defaults
 * Récupérer les valeurs par défaut pour la création de trunk
 */
router.get('/modems/trunk-defaults', async (req, res) => {
  try {
    const amiService = require('../services/FreePBXAmiService');

    res.json({
      defaults: {
        context: 'from-gsm',
        maxChannels: 1,
        callerIdMode: 'keep',
        dialPrefix: '',
      },
      options: {
        contexts: [
          { value: 'from-gsm', label: 'GSM Entrant (from-gsm)', description: 'Contexte standard pour appels GSM' },
          { value: 'from-internal', label: 'Interne (from-internal)', description: 'Comme une extension interne' },
          { value: 'from-trunk', label: 'Trunk externe (from-trunk)', description: 'Comme un trunk SIP externe' },
        ],
        callerIdModes: [
          { value: 'keep', label: 'Conserver', description: 'Garder le CallerID original' },
          { value: 'trunk', label: 'Trunk', description: 'Utiliser le numéro du modem' },
          { value: 'none', label: 'Aucun', description: 'Ne pas envoyer de CallerID' },
        ],
      },
      pbxConnected: amiService.connected && amiService.authenticated,
    });

  } catch (error) {
    console.error('[Admin] Get trunk defaults error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// VOIP / FREEPBX
// =============================================================================

/**
 * GET /api/admin/voip/trunks
 * Liste les trunks VoIP configurés
 */
router.get('/voip/trunks', async (req, res) => {
  try {
    const trunks = [];

    if (providerManager) {
      const configs = providerManager.getConfigs?.() || [];
      for (const config of configs) {
        if (config.category === 'voip') {
          const status = await providerManager.getProviderStatus?.(config.id) || {};
          trunks.push({
            id: config.id,
            name: config.name,
            type: config.type,
            enabled: config.enabled,
            connected: status.connected,
          });
        }
      }
    }

    res.json({ trunks });

  } catch (error) {
    console.error('[Admin] List VoIP trunks error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/voip/extensions
 * Liste les extensions VoIP des utilisateurs
 */
router.get('/voip/extensions', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const extensions = db.getAllVoIPExtensions();

    // Get FreePBX AMI status for each extension
    const amiService = require('../services/FreePBXAmiService');
    for (const ext of extensions) {
      if (amiService.connected && amiService.authenticated) {
        try {
          const status = await amiService.getPjsipExtensionStatus(ext.extension);
          ext.pbxStatus = status;
        } catch (e) {
          ext.pbxStatus = { error: e.message };
        }
      }
    }

    res.json({ extensions });

  } catch (error) {
    console.error('[Admin] List extensions error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/voip/extensions
 * Créer une extension VoIP pour un utilisateur
 */
router.post('/voip/extensions', [
  body('userId').isInt().withMessage('User ID is required'),
  body('extension').optional().matches(/^\d{3,6}$/).withMessage('Extension must be 3-6 digits'),
  body('displayName').optional().isString().isLength({ max: 50 }),
  body('createOnPbx').optional().isBoolean(),
], validate, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { userId, extension, displayName, createOnPbx = true } = req.body;

    // Vérifier que l'utilisateur existe
    const user = db.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Vérifier que l'utilisateur n'a pas déjà une extension
    const existing = db.getVoIPExtensionByUserId(userId);
    if (existing) {
      return res.status(409).json({
        error: 'User already has a VoIP extension',
        extension: existing.extension,
      });
    }

    // Déterminer le numéro d'extension
    const extNumber = extension || db.getNextAvailableExtension(1000);

    // Vérifier que l'extension n'est pas déjà utilisée
    if (!db.isExtensionAvailable(extNumber)) {
      return res.status(409).json({ error: `Extension ${extNumber} already exists` });
    }

    // Générer un secret aléatoire sécurisé
    const crypto = require('crypto');
    const secret = crypto.randomBytes(16).toString('hex');

    // Créer l'extension dans la DB
    const extData = db.createVoIPExtension(userId, {
      extension: extNumber,
      secret,
      displayName: displayName || user.username,
      webrtcEnabled: true,
    });

    // Créer sur FreePBX si demandé
    let pbxResult = null;
    if (createOnPbx) {
      const amiService = require('../services/FreePBXAmiService');
      if (amiService.connected && amiService.authenticated) {
        pbxResult = await amiService.createPjsipExtension({
          extension: extNumber,
          secret,
          displayName: displayName || user.username,
        });

        // Mettre à jour le statut de sync
        db.updateVoIPExtension(userId, {
          syncedToPbx: pbxResult.success,
          pbxSyncError: pbxResult.success ? null : pbxResult.message,
        });
      } else {
        pbxResult = { success: false, message: 'FreePBX non connecté' };
        db.updateVoIPExtension(userId, {
          syncedToPbx: false,
          pbxSyncError: 'FreePBX non connecté',
        });
      }
    }

    await securityService?.logAction(req.user.id, 'voip_extension_created', {
      category: 'admin',
      resource: `extension:${extNumber}`,
      targetUserId: userId,
      username: req.user.username,
    }, req);

    res.status(201).json({
      success: true,
      extension: {
        ...extData,
        secret, // Retourner le secret une seule fois à la création
      },
      pbxSync: pbxResult,
    });

  } catch (error) {
    console.error('[Admin] Create VoIP extension error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/voip/extensions/:userId
 * Récupérer l'extension VoIP d'un utilisateur
 */
router.get('/voip/extensions/:userId', [
  param('userId').isInt(),
], validate, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { userId } = req.params;
    const extension = db.getVoIPExtensionByUserId(parseInt(userId));

    if (!extension) {
      return res.status(404).json({ error: 'No VoIP extension for this user' });
    }

    // Ne pas exposer le secret
    const { secret, ...safeExtension } = extension;
    safeExtension.hasSecret = !!secret;

    res.json({ extension: safeExtension });

  } catch (error) {
    console.error('[Admin] Get VoIP extension error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/admin/voip/extensions/:userId
 * Modifier une extension VoIP
 */
router.put('/voip/extensions/:userId', [
  param('userId').isInt(),
  body('displayName').optional().isString().isLength({ max: 50 }),
  body('enabled').optional().isBoolean(),
  body('regenerateSecret').optional().isBoolean(),
], validate, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { userId } = req.params;
    const { displayName, enabled, regenerateSecret } = req.body;

    const existing = db.getVoIPExtensionByUserId(parseInt(userId));
    if (!existing) {
      return res.status(404).json({ error: 'No VoIP extension for this user' });
    }

    const updates = {};
    let newSecret = null;

    if (displayName !== undefined) {
      updates.displayName = displayName;
    }
    if (enabled !== undefined) {
      updates.enabled = enabled;
    }
    if (regenerateSecret) {
      const crypto = require('crypto');
      newSecret = crypto.randomBytes(16).toString('hex');
      updates.secret = newSecret;
    }

    const updated = db.updateVoIPExtension(parseInt(userId), updates);

    // Sync changes to PBX if secret changed
    if (newSecret) {
      const amiService = require('../services/FreePBXAmiService');
      if (amiService.connected && amiService.authenticated) {
        const pbxResult = await amiService.updatePjsipExtensionSecret(existing.extension, newSecret);
        db.updateVoIPExtension(parseInt(userId), {
          syncedToPbx: pbxResult.success,
          pbxSyncError: pbxResult.success ? null : pbxResult.message,
        });
      }
    }

    await securityService?.logAction(req.user.id, 'voip_extension_updated', {
      category: 'admin',
      resource: `extension:${existing.extension}`,
      targetUserId: userId,
      username: req.user.username,
    }, req);

    res.json({
      success: true,
      extension: updated,
      newSecret, // Only included if regenerated
    });

  } catch (error) {
    console.error('[Admin] Update VoIP extension error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/admin/voip/extensions/:userId
 * Supprimer une extension VoIP
 */
router.delete('/voip/extensions/:userId', [
  param('userId').isInt(),
], validate, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { userId } = req.params;
    const existing = db.getVoIPExtensionByUserId(parseInt(userId));

    if (!existing) {
      return res.status(404).json({ error: 'No VoIP extension for this user' });
    }

    // Supprimer de FreePBX
    const amiService = require('../services/FreePBXAmiService');
    let pbxResult = null;
    if (amiService.connected && amiService.authenticated) {
      pbxResult = await amiService.deletePjsipExtension(existing.extension);
    }

    // Supprimer de la DB locale
    db.deleteVoIPExtension(parseInt(userId));

    await securityService?.logAction(req.user.id, 'voip_extension_deleted', {
      category: 'admin',
      resource: `extension:${existing.extension}`,
      targetUserId: userId,
      username: req.user.username,
    }, req);

    res.json({
      success: true,
      message: `Extension ${existing.extension} supprimée`,
      pbxSync: pbxResult,
    });

  } catch (error) {
    console.error('[Admin] Delete VoIP extension error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/voip/extensions/:userId/sync
 * Synchroniser une extension avec FreePBX
 */
router.post('/voip/extensions/:userId/sync', [
  param('userId').isInt(),
], validate, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { userId } = req.params;
    const extension = db.getVoIPExtensionByUserId(parseInt(userId));

    if (!extension) {
      return res.status(404).json({ error: 'No VoIP extension for this user' });
    }

    const amiService = require('../services/FreePBXAmiService');
    if (!amiService.connected || !amiService.authenticated) {
      return res.status(503).json({ error: 'FreePBX non connecté' });
    }

    const user = db.getUserById(parseInt(userId));

    // Recréer l'extension sur FreePBX
    const pbxResult = await amiService.createPjsipExtension({
      extension: extension.extension,
      secret: extension.secret,
      displayName: extension.displayName || user?.username,
    });

    db.updateVoIPExtension(parseInt(userId), {
      syncedToPbx: pbxResult.success,
      pbxSyncError: pbxResult.success ? null : pbxResult.message,
    });

    res.json({
      success: pbxResult.success,
      message: pbxResult.message,
    });

  } catch (error) {
    console.error('[Admin] Sync VoIP extension error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/voip/next-extension
 * Récupérer le prochain numéro d'extension disponible
 */
router.get('/voip/next-extension', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const nextExtension = db.getNextAvailableExtension(1000);
    res.json({ nextExtension });

  } catch (error) {
    console.error('[Admin] Get next extension error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/voip/ami-status
 * État de la connexion AMI FreePBX
 */
router.get('/voip/ami-status', async (req, res) => {
  try {
    const amiService = require('../services/FreePBXAmiService');
    const status = amiService.getStatus();

    res.json({
      ...status,
      canCreateExtensions: status.connected && status.authenticated,
    });

  } catch (error) {
    console.error('[Admin] AMI status error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/voip/test-call
 * Effectuer un appel test
 */
router.post('/voip/test-call', [
  body('from').notEmpty(),
  body('to').matches(/^\+?[0-9]{3,15}$/),
], validate, async (req, res) => {
  try {
    const { from, to } = req.body;

    // TODO: Implémenter via FreePBX AMI
    res.json({
      success: false,
      message: 'Test call not yet implemented',
    });

  } catch (error) {
    console.error('[Admin] Test call error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// USERS MANAGEMENT
// =============================================================================

/**
 * GET /api/admin/users
 * Liste les utilisateurs avec leurs extensions VoIP
 */
router.get('/users', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const users = db.prepare(`
      SELECT id, username, role, created_at, last_login
      FROM users
      ORDER BY created_at DESC
    `).all();

    // Ajouter info 2FA et VoIP extension
    for (const user of users) {
      user.has2FA = await securityService?.has2FAEnabled(user.id) || false;

      // Get VoIP extension info
      const voipExt = db.getVoIPExtensionByUserId(user.id);
      if (voipExt) {
        user.voipExtension = {
          extension: voipExt.extension,
          enabled: voipExt.enabled,
          webrtcEnabled: voipExt.webrtcEnabled,
          syncedToPbx: voipExt.syncedToPbx,
        };
      } else {
        user.voipExtension = null;
      }
    }

    res.json({ users });

  } catch (error) {
    console.error('[Admin] List users error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/users
 * Créer un utilisateur avec option d'extension VoIP
 */
router.post('/users', [
  body('username').isLength({ min: 3, max: 50 }).matches(/^[a-zA-Z0-9_]+$/),
  body('password').isLength({ min: 8 }),
  body('role').isIn(['admin', 'user']),
  body('createVoipExtension').optional().isBoolean(),
  body('voipExtension').optional().matches(/^\d{3,6}$/),
], validate, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { username, password, role, createVoipExtension, voipExtension } = req.body;

    // Vérifier que l'username n'existe pas
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    // Vérifier l'extension VoIP si spécifiée
    if (voipExtension && !db.isExtensionAvailable(voipExtension)) {
      return res.status(409).json({ error: `Extension ${voipExtension} already exists` });
    }

    // Hasher le mot de passe
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = db.prepare(`
      INSERT INTO users (username, password, role)
      VALUES (?, ?, ?)
    `).run(username, hashedPassword, role);

    const userId = result.lastInsertRowid;

    // Créer l'extension VoIP si demandé
    let voipResult = null;
    if (createVoipExtension) {
      const crypto = require('crypto');
      const extNumber = voipExtension || db.getNextAvailableExtension(1000);
      const secret = crypto.randomBytes(16).toString('hex');

      try {
        const extData = db.createVoIPExtension(userId, {
          extension: extNumber,
          secret,
          displayName: username,
          webrtcEnabled: true,
        });

        voipResult = {
          success: true,
          extension: extNumber,
          secret, // Retourner le secret une seule fois
        };

        // Sync to FreePBX
        const amiService = require('../services/FreePBXAmiService');
        if (amiService.connected && amiService.authenticated) {
          const pbxResult = await amiService.createPjsipExtension({
            extension: extNumber,
            secret,
            displayName: username,
          });

          db.updateVoIPExtension(userId, {
            syncedToPbx: pbxResult.success,
            pbxSyncError: pbxResult.success ? null : pbxResult.message,
          });

          voipResult.pbxSync = pbxResult;
        } else {
          voipResult.pbxSync = { success: false, message: 'FreePBX non connecté - sync manuel requis' };
        }
      } catch (voipError) {
        voipResult = {
          success: false,
          error: voipError.message,
        };
      }
    }

    await securityService?.logAction(req.user.id, 'user_created', {
      category: 'admin',
      resource: `user:${userId}`,
      targetUsername: username,
      voipExtensionCreated: !!voipResult?.success,
      username: req.user.username,
    }, req);

    res.status(201).json({
      success: true,
      user: {
        id: userId,
        username,
        role,
      },
      voip: voipResult,
    });

  } catch (error) {
    console.error('[Admin] Create user error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/admin/users/:id
 * Modifier un utilisateur
 */
router.put('/users/:id', [
  param('id').isInt(),
  body('password').optional().isLength({ min: 8 }),
  body('role').optional().isIn(['admin', 'user']),
], validate, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { id } = req.params;
    const { password, role } = req.body;

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updates = [];
    const params = [];

    if (password) {
      updates.push('password = ?');
      params.push(await bcrypt.hash(password, 10));
    }

    if (role) {
      updates.push('role = ?');
      params.push(role);
    }

    if (updates.length > 0) {
      params.push(id);
      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    await securityService?.logAction(req.user.id, 'user_updated', {
      category: 'admin',
      resource: `user:${id}`,
      targetUsername: user.username,
      username: req.user.username,
    }, req);

    res.json({ success: true });

  } catch (error) {
    console.error('[Admin] Update user error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/admin/users/:id
 * Supprimer un utilisateur et son extension VoIP
 */
router.delete('/users/:id', [
  param('id').isInt(),
], validate, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { id } = req.params;
    const userId = parseInt(id);

    // Empêcher la suppression de soi-même
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Supprimer l'extension VoIP si elle existe
    const voipExt = db.getVoIPExtensionByUserId(userId);
    let voipDeleteResult = null;
    if (voipExt) {
      const amiService = require('../services/FreePBXAmiService');
      if (amiService.connected && amiService.authenticated) {
        voipDeleteResult = await amiService.deletePjsipExtension(voipExt.extension);
      }
      // La suppression en cascade via FOREIGN KEY supprimera aussi l'entrée dans user_voip_extensions
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(id);

    await securityService?.logAction(req.user.id, 'user_deleted', {
      category: 'admin',
      resource: `user:${id}`,
      targetUsername: user.username,
      voipExtensionDeleted: voipExt?.extension,
      username: req.user.username,
    }, req);

    res.json({
      success: true,
      voipExtensionDeleted: voipExt ? {
        extension: voipExt.extension,
        pbxResult: voipDeleteResult,
      } : null,
    });

  } catch (error) {
    console.error('[Admin] Delete user error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// SECURITY MANAGEMENT
// =============================================================================

/**
 * GET /api/admin/audit-log
 * Journal d'audit
 */
router.get('/audit-log', [
  query('limit').optional().isInt({ min: 1, max: 500 }).toInt(),
  query('offset').optional().isInt({ min: 0 }).toInt(),
  query('action').optional().isString(),
  query('category').optional().isString(),
  query('userId').optional().isInt().toInt(),
], validate, async (req, res) => {
  try {
    const { limit = 100, offset = 0, action, category, userId } = req.query;

    const logs = await securityService?.getAuditLogs({
      limit,
      offset,
      action,
      category,
      userId,
    }) || [];

    res.json({ logs, limit, offset });

  } catch (error) {
    console.error('[Admin] Get audit log error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/active-sessions
 * Sessions actives
 */
router.get('/active-sessions', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const sessions = db.prepare(`
      SELECT s.id, s.user_id, u.username, s.ip_address, s.user_agent, s.created_at, s.last_activity
      FROM active_sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.expires_at > ?
      ORDER BY s.last_activity DESC
    `).all(Date.now());

    res.json({ sessions });

  } catch (error) {
    console.error('[Admin] Get active sessions error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/admin/active-sessions/:id
 * Révoquer une session
 */
router.delete('/active-sessions/:id', [
  param('id').notEmpty(),
], validate, async (req, res) => {
  try {
    const { id } = req.params;

    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    db.prepare('DELETE FROM active_sessions WHERE id = ?').run(id);

    await securityService?.logAction(req.user.id, 'session_revoked_by_admin', {
      category: 'security',
      resource: `session:${id}`,
      username: req.user.username,
    }, req);

    res.json({ success: true });

  } catch (error) {
    console.error('[Admin] Revoke session error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/api-tokens
 * Liste tous les tokens API
 */
router.get('/api-tokens', async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const tokens = db.prepare(`
      SELECT t.id, t.user_id, u.username, t.name, t.permissions, t.last_used_at, t.expires_at, t.created_at, t.revoked
      FROM api_tokens t
      JOIN users u ON t.user_id = u.id
      ORDER BY t.created_at DESC
    `).all();

    res.json({
      tokens: tokens.map(t => ({
        ...t,
        permissions: JSON.parse(t.permissions || '[]'),
      })),
    });

  } catch (error) {
    console.error('[Admin] Get API tokens error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/admin/api-tokens/:id
 * Révoquer un token API
 */
router.delete('/api-tokens/:id', [
  param('id').notEmpty(),
], validate, async (req, res) => {
  try {
    const { id } = req.params;

    await securityService?.revokeToken(id, req.user.id);

    res.json({ success: true });

  } catch (error) {
    console.error('[Admin] Revoke API token error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * GET /api/admin/config
 * Configuration actuelle (masquée)
 */
router.get('/config', async (req, res) => {
  try {
    const config = configService?.getConfig?.() || {};

    // Masquer les secrets
    const maskedConfig = maskSecretsDeep(config);

    res.json({ config: maskedConfig });

  } catch (error) {
    console.error('[Admin] Get config error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/admin/config
 * Mettre à jour la configuration
 */
router.put('/config', [
  body('config').isObject(),
], validate, async (req, res) => {
  try {
    const { config } = req.body;

    if (configService?.updateConfig) {
      await configService.updateConfig(config);
    }

    await securityService?.logAction(req.user.id, 'config_updated', {
      category: 'admin',
      username: req.user.username,
    }, req);

    res.json({ success: true });

  } catch (error) {
    console.error('[Admin] Update config error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/config/reload
 * Recharger la configuration
 */
router.post('/config/reload', async (req, res) => {
  try {
    if (configService?.reload) {
      await configService.reload();
    }

    await securityService?.logAction(req.user.id, 'config_reloaded', {
      category: 'admin',
      username: req.user.username,
    }, req);

    res.json({ success: true, message: 'Configuration reloaded' });

  } catch (error) {
    console.error('[Admin] Reload config error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// LOGS (temps réel via WebSocket, fallback HTTP)
// =============================================================================

/**
 * GET /api/admin/logs
 * Derniers logs système
 */
router.get('/logs', [
  query('limit').optional().isInt({ min: 1, max: 1000 }).toInt(),
  query('level').optional().isIn(['error', 'warn', 'info', 'debug']),
], validate, async (req, res) => {
  try {
    const { limit = 100, level } = req.query;

    // TODO: Implémenter la récupération des logs
    // Pour l'instant, retourner un placeholder
    res.json({
      logs: [],
      message: 'Log viewing will be available via WebSocket for real-time updates',
    });

  } catch (error) {
    console.error('[Admin] Get logs error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// TUNNEL (tunnl.gg)
// =============================================================================

/**
 * GET /api/admin/tunnel/status
 * Récupère l'état du tunnel
 */
router.get('/tunnel/status', async (req, res) => {
  try {
    if (!tunnelService) {
      return res.json({
        available: false,
        error: 'Tunnel service not initialized',
      });
    }

    const status = tunnelService.getStatus();
    const sshAvailable = await TunnelService.checkSshAvailable();

    res.json({
      available: sshAvailable,
      ...status,
    });
  } catch (error) {
    console.error('[Admin] Tunnel status error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/tunnel/start
 * Démarre le tunnel
 */
router.post('/tunnel/start', async (req, res) => {
  try {
    if (!tunnelService) {
      return res.status(500).json({ error: 'Tunnel service not initialized' });
    }

    const sshAvailable = await TunnelService.checkSshAvailable();
    if (!sshAvailable) {
      return res.status(400).json({
        error: 'SSH n\'est pas disponible sur ce système. Installez OpenSSH pour utiliser le tunnel.',
      });
    }

    // Log action
    if (securityService && req.user) {
      await securityService.logAction(req.user.id, 'tunnel_start', {
        category: 'system',
        username: req.user.username,
      }, req);
    }

    const result = await tunnelService.start();
    res.json(result);
  } catch (error) {
    console.error('[Admin] Tunnel start error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/tunnel/stop
 * Arrête le tunnel
 */
router.post('/tunnel/stop', async (req, res) => {
  try {
    if (!tunnelService) {
      return res.status(500).json({ error: 'Tunnel service not initialized' });
    }

    // Log action
    if (securityService && req.user) {
      await securityService.logAction(req.user.id, 'tunnel_stop', {
        category: 'system',
        username: req.user.username,
      }, req);
    }

    const result = tunnelService.stop();
    res.json(result);
  } catch (error) {
    console.error('[Admin] Tunnel stop error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/tunnel/toggle
 * Bascule l'état du tunnel
 */
router.post('/tunnel/toggle', async (req, res) => {
  try {
    if (!tunnelService) {
      return res.status(500).json({ error: 'Tunnel service not initialized' });
    }

    const sshAvailable = await TunnelService.checkSshAvailable();
    if (!sshAvailable && !tunnelService.enabled) {
      return res.status(400).json({
        error: 'SSH n\'est pas disponible sur ce système. Installez OpenSSH pour utiliser le tunnel.',
      });
    }

    // Log action
    if (securityService && req.user) {
      await securityService.logAction(req.user.id, 'tunnel_toggle', {
        category: 'system',
        username: req.user.username,
        action: tunnelService.enabled ? 'disable' : 'enable',
      }, req);
    }

    const result = await tunnelService.toggle();
    res.json({
      ...result,
      ...tunnelService.getStatus(),
    });
  } catch (error) {
    console.error('[Admin] Tunnel toggle error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Masque les valeurs secrètes d'un objet
 */
function maskSecrets(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const secretKeys = ['password', 'secret', 'token', 'authToken', 'apiKey', 'apiSecret', 'consumerKey', 'ami_secret'];
  const result = { ...obj };

  for (const key of Object.keys(result)) {
    if (secretKeys.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
      result[key] = result[key] ? '********' : null;
    }
  }

  return result;
}

/**
 * Masque les secrets de façon récursive
 */
function maskSecretsDeep(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(maskSecretsDeep);

  const secretKeys = ['password', 'secret', 'token', 'authToken', 'apiKey', 'apiSecret', 'consumerKey', 'ami_secret', 'key'];
  const result = {};

  for (const [key, value] of Object.entries(obj)) {
    if (secretKeys.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
      result[key] = value ? '********' : null;
    } else if (typeof value === 'object') {
      result[key] = maskSecretsDeep(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

module.exports = { router, initAdminRoutes };
