/**
 * CDR API Routes - /api/cdr/v1/*
 * API REST pour accéder aux CDR (Call Detail Records) Asterisk/FreePBX
 *
 * Compatible avec l'app mobile Homenichat
 */

const express = require('express');
const router = express.Router();
const { query, param, validationResult } = require('express-validator');
const asteriskCDRService = require('../services/AsteriskCDRService');
const logger = require('../utils/logger');

// =============================================================================
// Middleware
// =============================================================================

/**
 * Vérifier l'authentification Bearer Token
 * Accepte soit le token JWT standard, soit un token API CDR dédié
 */
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Invalid authorization format. Use: Bearer <token>' });
  }

  const token = authHeader.substring(7);

  // Vérifier si c'est un token API CDR (format: cdr_sk_live_xxx ou cdr_sk_test_xxx)
  if (token.startsWith('cdr_sk_')) {
    const configuredToken = process.env.CDR_API_TOKEN;
    if (!configuredToken) {
      logger.warn('[CDR] No CDR_API_TOKEN configured, rejecting API token');
      return res.status(401).json({ error: 'API token authentication not configured' });
    }
    if (token !== configuredToken) {
      return res.status(401).json({ error: 'Invalid API token' });
    }
    req.authType = 'api_token';
    return next();
  }

  // Sinon, utiliser l'auth JWT standard
  try {
    const jwt = require('jsonwebtoken');
    const db = require('../services/DatabaseService');

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'lekip-chat-secret-key-change-this-in-production');

    // Vérifier que la session existe
    const session = db.getSession(token);
    if (!session) {
      return res.status(401).json({ error: 'Session expired or invalid' });
    }

    // Récupérer l'utilisateur
    const user = db.getUserById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = user;
    req.authType = 'jwt';
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

/**
 * Validation des erreurs
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// =============================================================================
// Health Check (sans auth)
// =============================================================================

/**
 * GET /api/cdr/health
 * Health check - vérifie la connexion à la base Asterisk
 */
router.get('/health', async (req, res) => {
  try {
    const status = await asteriskCDRService.getStatus();

    res.json({
      status: status.connected ? 'healthy' : 'degraded',
      service: 'cdr-api',
      version: '1.0.0',
      database: status.connected ? 'connected' : 'disconnected',
      host: status.host || null,
      totalRecords: status.totalRecords || 0,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({
      status: 'error',
      service: 'cdr-api',
      version: '1.0.0',
      database: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// =============================================================================
// CDR API v1 Routes
// =============================================================================

/**
 * GET /api/cdr/v1/calls
 * Lister les appels avec filtres et pagination
 */
router.get('/v1/calls',
  verifyToken,
  [
    query('limit').optional().isInt({ min: 1, max: 500 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
    query('direction').optional().isIn(['inbound', 'outbound', 'internal', 'all']),
    query('disposition').optional().isIn(['ANSWERED', 'NO ANSWER', 'BUSY', 'FAILED']),
    query('src').optional().isString().trim(),
    query('dst').optional().isString().trim(),
    query('did').optional().isString().trim(),
    query('date_from').optional().isISO8601().toDate(),
    query('date_to').optional().isISO8601().toDate(),
    query('search').optional().isString().trim(),
    query('extensions').optional().isString().trim() // Comma-separated list
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const {
        limit = 50,
        offset = 0,
        direction,
        disposition,
        src,
        dst,
        did,
        date_from,
        date_to,
        search,
        extensions
      } = req.query;

      // Parse extensions si fourni (format: "2001,2002,2003")
      let extensionsList = null;
      if (extensions) {
        extensionsList = extensions.split(',').map(e => e.trim()).filter(e => e);
      }

      const result = await asteriskCDRService.listCalls({
        limit,
        offset,
        direction,
        disposition,
        src,
        dst,
        did,
        dateFrom: date_from ? date_from.toISOString().split('T')[0] : null,
        dateTo: date_to ? date_to.toISOString().split('T')[0] : null,
        search,
        extensions: extensionsList
      });

      res.json(result);
    } catch (error) {
      logger.error(`[CDR] Error listing calls: ${error.message}`);

      if (error.message === 'AsteriskCDR not configured') {
        return res.status(503).json({
          error: 'CDR service not configured',
          detail: 'Asterisk CDR database connection not configured. Check CDR_* environment variables.'
        });
      }

      res.status(500).json({ error: 'Internal server error', detail: error.message });
    }
  }
);

/**
 * GET /api/cdr/v1/calls/:callId
 * Récupérer les détails d'un appel
 */
router.get('/v1/calls/:callId',
  verifyToken,
  [
    param('callId').isString().notEmpty()
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { callId } = req.params;
      const call = await asteriskCDRService.getCall(callId);

      if (!call) {
        return res.status(404).json({ error: 'Call not found' });
      }

      res.json(call);
    } catch (error) {
      logger.error(`[CDR] Error getting call: ${error.message}`);
      res.status(500).json({ error: 'Internal server error', detail: error.message });
    }
  }
);

/**
 * GET /api/cdr/v1/stats
 * Statistiques d'appels
 */
router.get('/v1/stats',
  verifyToken,
  [
    query('period').optional().isIn(['today', 'yesterday', 'week', 'month', 'year', 'all']),
    query('date_from').optional().isISO8601().toDate(),
    query('date_to').optional().isISO8601().toDate()
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { period = 'today', date_from, date_to } = req.query;

      const result = await asteriskCDRService.getStats({
        period,
        dateFrom: date_from ? date_from.toISOString().split('T')[0] : null,
        dateTo: date_to ? date_to.toISOString().split('T')[0] : null
      });

      res.json(result);
    } catch (error) {
      logger.error(`[CDR] Error getting stats: ${error.message}`);
      res.status(500).json({ error: 'Internal server error', detail: error.message });
    }
  }
);

/**
 * GET /api/cdr/v1/extensions
 * Lister les extensions actives
 */
router.get('/v1/extensions',
  verifyToken,
  async (req, res) => {
    try {
      const extensions = await asteriskCDRService.listExtensions();
      res.json({ extensions });
    } catch (error) {
      logger.error(`[CDR] Error listing extensions: ${error.message}`);
      res.status(500).json({ error: 'Internal server error', detail: error.message });
    }
  }
);

/**
 * GET /api/cdr/v1/recordings/:callId
 * Récupérer les infos d'enregistrement d'un appel
 */
router.get('/v1/recordings/:callId',
  verifyToken,
  [
    param('callId').isString().notEmpty()
  ],
  handleValidationErrors,
  async (req, res) => {
    try {
      const { callId } = req.params;
      const recording = await asteriskCDRService.getRecordingInfo(callId);

      if (!recording) {
        return res.status(404).json({
          error: 'Recording not found or call has no recording'
        });
      }

      res.json(recording);
    } catch (error) {
      logger.error(`[CDR] Error getting recording: ${error.message}`);
      res.status(500).json({ error: 'Internal server error', detail: error.message });
    }
  }
);

// =============================================================================
// Configuration (Admin only)
// =============================================================================

/**
 * POST /api/cdr/configure
 * Configurer la connexion à la base Asterisk CDR
 * Admin only
 */
router.post('/configure',
  verifyToken,
  async (req, res) => {
    // Vérifier que l'utilisateur est admin (si auth JWT)
    if (req.authType === 'jwt' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    try {
      const { host, port, user, password, database } = req.body;

      const result = await asteriskCDRService.configure({
        host,
        port,
        user,
        password,
        database
      });

      if (result.success) {
        const status = await asteriskCDRService.getStatus();
        res.json({
          success: true,
          message: 'CDR database configured successfully',
          status
        });
      } else {
        res.status(400).json({
          success: false,
          error: result.error
        });
      }
    } catch (error) {
      logger.error(`[CDR] Error configuring: ${error.message}`);
      res.status(500).json({ error: 'Internal server error', detail: error.message });
    }
  }
);

/**
 * GET /api/cdr/status
 * Statut de la connexion CDR
 */
router.get('/status',
  verifyToken,
  async (req, res) => {
    try {
      const status = await asteriskCDRService.getStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

module.exports = router;
