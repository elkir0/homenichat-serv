/**
 * Admin Provider Routes
 * Handles provider management (SMS, WhatsApp)
 */

const express = require('express');
const router = express.Router();
const logger = require('../../../utils/logger');

/**
 * GET /providers
 * List all providers
 */
router.get('/', async (req, res) => {
    try {
        // TODO: Implement provider listing
        res.json({ providers: [] });
    } catch (error) {
        logger.error('[Admin/Providers] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /providers/status
 * Get provider status
 */
router.get('/status', async (req, res) => {
    try {
        res.json({ status: 'operational' });
    } catch (error) {
        logger.error('[Admin/Providers] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// WhatsApp session routes (alias)
router.get('/sessions', async (req, res) => {
    res.json({ sessions: [] });
});

module.exports = router;
