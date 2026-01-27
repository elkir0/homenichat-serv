/**
 * Admin Push Relay Routes
 * Handles Push Notification Relay configuration
 */

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
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

// Get PushRelayService (lazy load)
const getPushRelayService = () => {
    try {
        return require('../../services/PushRelayService');
    } catch (e) {
        logger.warn('[Admin/PushRelay] PushRelayService not available');
        return null;
    }
};

// Get database (lazy load)
const getDb = () => require('../../services/database');

/**
 * GET /push-relay/status
 * Get Push Relay status and configuration
 */
router.get('/status', async (req, res) => {
    try {
        const pushRelayService = getPushRelayService();

        if (!pushRelayService) {
            return res.json({
                available: false,
                configured: false,
                message: 'PushRelayService not available',
            });
        }

        const status = await pushRelayService.getStatus();
        res.json(status);
    } catch (error) {
        logger.error('[Admin/PushRelay] Error getting status:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /push-relay/config
 * Update Push Relay configuration
 */
router.put('/config', [
    body('relayUrl').notEmpty().isURL().withMessage('Valid relay URL required'),
    body('apiKey').notEmpty().withMessage('API key required'),
    handleValidationErrors,
], async (req, res) => {
    try {
        const pushRelayService = getPushRelayService();

        if (!pushRelayService) {
            return res.status(503).json({ error: 'PushRelayService not available' });
        }

        const { relayUrl, apiKey } = req.body;

        // Save configuration
        await pushRelayService.configure({ relayUrl, apiKey });

        // Test connection
        const testResult = await pushRelayService.testConnection();

        res.json({
            success: true,
            message: 'Push Relay configuration saved',
            configured: true,
            connectionTest: testResult,
        });
    } catch (error) {
        logger.error('[Admin/PushRelay] Error updating config:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /push-relay/config
 * Delete Push Relay configuration
 */
router.delete('/config', async (req, res) => {
    try {
        const pushRelayService = getPushRelayService();

        if (!pushRelayService) {
            return res.status(503).json({ error: 'PushRelayService not available' });
        }

        await pushRelayService.clearConfig();

        res.json({
            success: true,
            message: 'Push Relay configuration deleted',
        });
    } catch (error) {
        logger.error('[Admin/PushRelay] Error deleting config:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /push-relay/test
 * Test Push Relay connection
 */
router.post('/test', async (req, res) => {
    try {
        const pushRelayService = getPushRelayService();

        if (!pushRelayService) {
            return res.status(503).json({ error: 'PushRelayService not available' });
        }

        if (!pushRelayService.isConfigured()) {
            return res.status(400).json({ error: 'Push Relay not configured' });
        }

        const result = await pushRelayService.testConnection();

        res.json({
            success: result.success,
            ...result,
        });
    } catch (error) {
        logger.error('[Admin/PushRelay] Error testing connection:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /push-relay/devices
 * Get registered devices (via relay)
 */
router.get('/devices', async (req, res) => {
    try {
        const db = getDb();
        const tokens = db.devices.findAll();

        // Mask tokens for security
        const masked = tokens.map(t => ({
            ...t,
            token: t.token ? `...${t.token.slice(-8)}` : null,
        }));

        res.json({
            devices: masked,
            count: tokens.length,
        });
    } catch (error) {
        logger.error('[Admin/PushRelay] Error getting devices:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /push-relay/send-test
 * Send a test push notification
 */
router.post('/send-test', [
    body('userId').isInt({ min: 1 }).withMessage('Valid user ID required'),
    handleValidationErrors,
], async (req, res) => {
    try {
        const pushRelayService = getPushRelayService();

        if (!pushRelayService) {
            return res.status(503).json({ error: 'PushRelayService not available' });
        }

        if (!pushRelayService.isConfigured()) {
            return res.status(400).json({ error: 'Push Relay not configured' });
        }

        const { userId } = req.body;

        const result = await pushRelayService.sendNotification(userId, {
            type: 'test',
            title: 'Homenichat Test',
            body: 'Push notification test successful!',
            data: { test: true, timestamp: Date.now() },
        });

        res.json({
            success: true,
            ...result,
        });
    } catch (error) {
        logger.error('[Admin/PushRelay] Error sending test notification:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
