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

/**
 * Initialise les routes avec les services nécessaires
 */
function initAdminRoutes(services) {
  securityService = services.securityService;
  providerManager = services.providerManager;
  sessionManager = services.sessionManager;
  configService = services.configService;
  db = services.db;
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
    if (sessionManager) {
      stats.whatsappSessions = await sessionManager.listSessions?.() || [];
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
        const health = await baileysProvider.getHealth?.() || {};
        sessions.push({
          id: 'baileys',
          name: 'WhatsApp (Baileys)',
          status: health.isConnected ? 'connected' : (baileysProvider.qrCode ? 'qr_pending' : 'disconnected'),
          phoneNumber: health.phoneNumber || null,
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
// MODEMS (pour future implémentation)
// =============================================================================

/**
 * GET /api/admin/modems
 * Liste les modems détectés
 */
router.get('/modems', async (req, res) => {
  try {
    // TODO: Implémenter ModemManagerService
    const modems = [];

    res.json({ modems, message: 'Modem management coming soon' });

  } catch (error) {
    console.error('[Admin] List modems error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/modems/scan
 * Scanner les ports USB pour détecter les modems
 */
router.post('/modems/scan', async (req, res) => {
  try {
    // TODO: Implémenter la détection
    res.json({ modems: [], message: 'Scan not yet implemented' });

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
    const { id } = req.params;

    // TODO: Implémenter
    res.json({
      id,
      connected: false,
      signalStrength: null,
      operator: null,
      message: 'Status not yet implemented',
    });

  } catch (error) {
    console.error('[Admin] Get modem status error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/modems/:id/sms
 * Envoyer un SMS test via un modem
 */
router.post('/modems/:id/sms', [
  param('id').notEmpty(),
  body('to').matches(/^\+?[0-9]{10,15}$/),
  body('message').notEmpty().isLength({ max: 160 }),
], validate, async (req, res) => {
  try {
    const { id } = req.params;
    const { to, message } = req.body;

    // TODO: Implémenter
    res.json({
      success: false,
      message: 'SMS via modem not yet implemented',
    });

  } catch (error) {
    console.error('[Admin] Send SMS via modem error:', error);
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
 * Liste les extensions (si FreePBX connecté)
 */
router.get('/voip/extensions', async (req, res) => {
  try {
    // TODO: Récupérer depuis FreePBX via AMI
    res.json({
      extensions: [],
      message: 'Extension listing requires FreePBX AMI connection',
    });

  } catch (error) {
    console.error('[Admin] List extensions error:', error);
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
 * Liste les utilisateurs
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

    // Ajouter info 2FA
    for (const user of users) {
      user.has2FA = await securityService?.has2FAEnabled(user.id) || false;
    }

    res.json({ users });

  } catch (error) {
    console.error('[Admin] List users error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/users
 * Créer un utilisateur
 */
router.post('/users', [
  body('username').isLength({ min: 3, max: 50 }).matches(/^[a-zA-Z0-9_]+$/),
  body('password').isLength({ min: 8 }),
  body('role').isIn(['admin', 'user']),
], validate, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { username, password, role } = req.body;

    // Vérifier que l'username n'existe pas
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    // Hasher le mot de passe
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = db.prepare(`
      INSERT INTO users (username, password, role)
      VALUES (?, ?, ?)
    `).run(username, hashedPassword, role);

    await securityService?.logAction(req.user.id, 'user_created', {
      category: 'admin',
      resource: `user:${result.lastInsertRowid}`,
      targetUsername: username,
      username: req.user.username,
    }, req);

    res.status(201).json({
      success: true,
      user: {
        id: result.lastInsertRowid,
        username,
        role,
      },
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
 * Supprimer un utilisateur
 */
router.delete('/users/:id', [
  param('id').isInt(),
], validate, async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const { id } = req.params;

    // Empêcher la suppression de soi-même
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(id);

    await securityService?.logAction(req.user.id, 'user_deleted', {
      category: 'admin',
      resource: `user:${id}`,
      targetUsername: user.username,
      username: req.user.username,
    }, req);

    res.json({ success: true });

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
