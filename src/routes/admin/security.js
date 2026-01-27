/**
 * Admin Security Routes
 * Handles audit logs, active sessions, and API tokens
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { body, param, query, validationResult } = require('express-validator');
const logger = require('../../../utils/logger');

/**
 * Validation error handler
 */
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }
    next();
};

// Get database (lazy load)
const getDb = () => require('../../services/database');

// Get SecurityService (lazy load)
const getSecurityService = () => {
    try {
        return require('../../services/SecurityService');
    } catch (e) {
        logger.warn('[Admin/Security] SecurityService not available');
        return null;
    }
};

// =============================================================================
// AUDIT LOG
// =============================================================================

/**
 * GET /audit-log
 * Get audit log entries
 */
router.get('/audit-log', [
    query('limit').optional().isInt({ min: 1, max: 1000 }),
    query('offset').optional().isInt({ min: 0 }),
    query('category').optional().isIn(['auth', 'admin', 'system', 'api']),
    query('userId').optional().isInt({ min: 1 }),
    query('action').optional().isString(),
    handleValidationErrors,
], async (req, res) => {
    try {
        const securityService = getSecurityService();

        if (!securityService) {
            return res.json({
                entries: [],
                total: 0,
                message: 'SecurityService not available',
            });
        }

        const options = {
            limit: parseInt(req.query.limit) || 100,
            offset: parseInt(req.query.offset) || 0,
            category: req.query.category,
            userId: req.query.userId ? parseInt(req.query.userId) : undefined,
            action: req.query.action,
        };

        const result = await securityService.getAuditLog(options);
        res.json(result);
    } catch (error) {
        logger.error('[Admin/Security] Error getting audit log:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /audit-log
 * Clear audit log (admin only, with confirmation)
 */
router.delete('/audit-log', [
    body('confirm').equals('DELETE_ALL_LOGS').withMessage('Confirmation required'),
    handleValidationErrors,
], async (req, res) => {
    try {
        const securityService = getSecurityService();

        if (!securityService) {
            return res.status(503).json({ error: 'SecurityService not available' });
        }

        const deleted = await securityService.clearAuditLog();

        // Log the action itself
        if (req.user) {
            await securityService.logAction(req.user.id, 'audit_log_cleared', {
                category: 'system',
                username: req.user.username,
                deletedCount: deleted,
            }, req);
        }

        res.json({
            success: true,
            deleted,
            message: `${deleted} audit log entries deleted`,
        });
    } catch (error) {
        logger.error('[Admin/Security] Error clearing audit log:', error);
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// ACTIVE SESSIONS
// =============================================================================

/**
 * GET /active-sessions
 * Get all active user sessions
 */
router.get('/active-sessions', async (req, res) => {
    try {
        const db = getDb();
        const sessions = db.sessions.findAll();

        // Add user info and mask tokens
        const sessionsWithInfo = sessions.map(s => ({
            id: s.id,
            userId: s.user_id,
            username: s.username,
            token: s.token ? `...${s.token.slice(-8)}` : null,
            createdAt: s.created_at,
            expiresAt: s.expires_at,
            lastActivity: s.last_activity,
            ipAddress: s.ip_address,
            userAgent: s.user_agent,
        }));

        res.json({
            sessions: sessionsWithInfo,
            count: sessions.length,
        });
    } catch (error) {
        logger.error('[Admin/Security] Error getting active sessions:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /active-sessions/:id
 * Terminate a specific session
 */
router.delete('/active-sessions/:id', [
    param('id').isInt({ min: 1 }),
    handleValidationErrors,
], async (req, res) => {
    try {
        const db = getDb();
        const { id } = req.params;

        const session = db.sessions.findById(parseInt(id));
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        // Prevent deleting own session
        if (req.user && session.user_id === req.user.id) {
            return res.status(400).json({ error: 'Cannot terminate your own session' });
        }

        db.sessions.delete(session.token);

        // Log action
        const securityService = getSecurityService();
        if (securityService && req.user) {
            await securityService.logAction(req.user.id, 'session_terminated', {
                category: 'admin',
                username: req.user.username,
                targetUserId: session.user_id,
                sessionId: id,
            }, req);
        }

        res.json({
            success: true,
            message: 'Session terminated',
        });
    } catch (error) {
        logger.error('[Admin/Security] Error terminating session:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /active-sessions/user/:userId
 * Terminate all sessions for a user
 */
router.delete('/active-sessions/user/:userId', [
    param('userId').isInt({ min: 1 }),
    handleValidationErrors,
], async (req, res) => {
    try {
        const db = getDb();
        const { userId } = req.params;

        // Prevent deleting own sessions
        if (req.user && parseInt(userId) === req.user.id) {
            return res.status(400).json({ error: 'Cannot terminate your own sessions' });
        }

        const deleted = db.sessions.deleteAllForUser(parseInt(userId));

        // Log action
        const securityService = getSecurityService();
        if (securityService && req.user) {
            await securityService.logAction(req.user.id, 'all_sessions_terminated', {
                category: 'admin',
                username: req.user.username,
                targetUserId: parseInt(userId),
                deletedCount: deleted,
            }, req);
        }

        res.json({
            success: true,
            deleted,
            message: `${deleted} sessions terminated`,
        });
    } catch (error) {
        logger.error('[Admin/Security] Error terminating user sessions:', error);
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// API TOKENS
// =============================================================================

/**
 * GET /api-tokens
 * Get all API tokens
 */
router.get('/api-tokens', async (req, res) => {
    try {
        const db = getDb();

        // Check if api_tokens table exists
        let tokens = [];
        try {
            tokens = db.apiTokens?.findAll() || [];
        } catch (e) {
            // Table might not exist
            logger.warn('[Admin/Security] API tokens table not available');
        }

        // Mask tokens
        const masked = tokens.map(t => ({
            id: t.id,
            name: t.name,
            token: t.token ? `${t.token.slice(0, 8)}...${t.token.slice(-4)}` : null,
            userId: t.user_id,
            scopes: t.scopes,
            createdAt: t.created_at,
            lastUsed: t.last_used,
            expiresAt: t.expires_at,
        }));

        res.json({
            tokens: masked,
            count: tokens.length,
        });
    } catch (error) {
        logger.error('[Admin/Security] Error getting API tokens:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api-tokens
 * Create a new API token
 */
router.post('/api-tokens', [
    body('name').notEmpty().withMessage('Token name required'),
    body('scopes').optional().isArray(),
    body('expiresIn').optional().isInt({ min: 1 }),
    handleValidationErrors,
], async (req, res) => {
    try {
        const db = getDb();
        const { name, scopes = ['read'], expiresIn } = req.body;

        // Generate secure token
        const token = `hni_${crypto.randomBytes(32).toString('hex')}`;

        // Calculate expiry
        let expiresAt = null;
        if (expiresIn) {
            expiresAt = new Date(Date.now() + expiresIn * 24 * 60 * 60 * 1000).toISOString();
        }

        // Save token
        const created = db.apiTokens?.create({
            name,
            token,
            userId: req.user?.id,
            scopes: JSON.stringify(scopes),
            expiresAt,
        });

        if (!created) {
            return res.status(503).json({ error: 'API tokens not supported' });
        }

        // Log action
        const securityService = getSecurityService();
        if (securityService && req.user) {
            await securityService.logAction(req.user.id, 'api_token_created', {
                category: 'admin',
                username: req.user.username,
                tokenName: name,
            }, req);
        }

        res.json({
            success: true,
            token: {
                id: created.id,
                name,
                token, // Only shown once!
                scopes,
                expiresAt,
            },
            message: 'Save this token securely - it will not be shown again',
        });
    } catch (error) {
        logger.error('[Admin/Security] Error creating API token:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api-tokens/:id
 * Revoke an API token
 */
router.delete('/api-tokens/:id', [
    param('id').isInt({ min: 1 }),
    handleValidationErrors,
], async (req, res) => {
    try {
        const db = getDb();
        const { id } = req.params;

        const token = db.apiTokens?.findById(parseInt(id));
        if (!token) {
            return res.status(404).json({ error: 'API token not found' });
        }

        db.apiTokens?.delete(parseInt(id));

        // Log action
        const securityService = getSecurityService();
        if (securityService && req.user) {
            await securityService.logAction(req.user.id, 'api_token_revoked', {
                category: 'admin',
                username: req.user.username,
                tokenName: token.name,
                tokenId: id,
            }, req);
        }

        res.json({
            success: true,
            message: 'API token revoked',
        });
    } catch (error) {
        logger.error('[Admin/Security] Error revoking API token:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
