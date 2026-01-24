/**
 * Admin VoIP Routes
 * Handles VoIP extensions and Asterisk management
 */

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const logger = require('../../../utils/logger');

// Get services (lazy load)
const getDb = () => require('../../services/database');
const getAsterisk = () => {
    const { getAsteriskService } = require('../../services/asterisk');
    return getAsteriskService();
};

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

/**
 * GET /voip/extensions
 * List all VoIP extensions
 */
router.get('/extensions', async (req, res) => {
    try {
        const db = getDb();
        const extensions = db.extensions.findAll();
        res.json({ extensions });
    } catch (error) {
        logger.error('[Admin/VoIP] Error listing extensions:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /voip/extensions
 * Create a new extension for a user
 */
router.post('/extensions', [
    body('userId').isInt().withMessage('userId must be an integer'),
    handleValidationErrors,
], async (req, res) => {
    try {
        const db = getDb();
        const asterisk = getAsterisk();
        const { userId, displayName } = req.body;

        // Check user exists
        const user = db.users.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Check if user already has an extension
        const existing = db.extensions.findByUserId(userId);
        if (existing) {
            return res.status(400).json({ error: 'User already has an extension' });
        }

        // Get next available extension
        const extension = asterisk.getNextAvailableExtension();
        const secret = asterisk.generateSecret();

        // Create in Asterisk
        await asterisk.createExtension({
            extension,
            secret,
            displayName: displayName || user.username,
        });

        // Save to database
        const created = db.extensions.create(userId, {
            extension,
            secret,
            displayName: displayName || user.username,
        });

        res.json({
            success: true,
            extension: created,
        });
    } catch (error) {
        logger.error('[Admin/VoIP] Error creating extension:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /voip/extensions/:userId
 * Get extension for a user
 */
router.get('/extensions/:userId', async (req, res) => {
    try {
        const db = getDb();
        const { userId } = req.params;
        const extension = db.extensions.findByUserId(parseInt(userId));

        if (!extension) {
            return res.status(404).json({ error: 'Extension not found' });
        }

        res.json({ extension });
    } catch (error) {
        logger.error('[Admin/VoIP] Error getting extension:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /voip/extensions/:userId
 * Delete extension for a user
 */
router.delete('/extensions/:userId', async (req, res) => {
    try {
        const db = getDb();
        const asterisk = getAsterisk();
        const { userId } = req.params;

        const extension = db.extensions.findByUserId(parseInt(userId));
        if (!extension) {
            return res.status(404).json({ error: 'Extension not found' });
        }

        // Delete from Asterisk
        await asterisk.deleteExtension(extension.extension);

        // Delete from database
        db.extensions.delete(parseInt(userId));

        res.json({ success: true, deleted: extension.extension });
    } catch (error) {
        logger.error('[Admin/VoIP] Error deleting extension:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /voip/next-extension
 * Get next available extension number
 */
router.get('/next-extension', async (req, res) => {
    try {
        const asterisk = getAsterisk();
        const next = asterisk.getNextAvailableExtension();
        res.json({ extension: next });
    } catch (error) {
        logger.error('[Admin/VoIP] Error getting next extension:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /voip/ami-status
 * Get AMI connection status
 */
router.get('/ami-status', async (req, res) => {
    try {
        const asterisk = getAsterisk();
        const status = asterisk.getStatus();
        res.json(status);
    } catch (error) {
        logger.error('[Admin/VoIP] Error getting AMI status:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /voip/trunks
 * List VoIP trunks
 */
router.get('/trunks', async (req, res) => {
    try {
        // TODO: Implement trunk listing
        res.json({ trunks: [] });
    } catch (error) {
        logger.error('[Admin/VoIP] Error listing trunks:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
