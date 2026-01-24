/**
 * Admin Settings Routes
 * Handles system configuration
 */

const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const logger = require('../../../utils/logger');

// Get database (lazy load)
const getDb = () => require('../../services/database');

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
 * GET /config
 * Get all settings
 */
router.get('/', async (req, res) => {
    try {
        const db = getDb();
        const settings = db.settings.getAll();
        res.json({ settings });
    } catch (error) {
        logger.error('[Admin/Settings] Error getting settings:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /config
 * Update settings
 */
router.put('/', async (req, res) => {
    try {
        const db = getDb();
        const updates = req.body;

        for (const [key, value] of Object.entries(updates)) {
            db.settings.set(key, value);
        }

        res.json({ success: true, updated: Object.keys(updates) });
    } catch (error) {
        logger.error('[Admin/Settings] Error updating settings:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /config/:key
 * Get a specific setting
 */
router.get('/:key', async (req, res) => {
    try {
        const db = getDb();
        const { key } = req.params;
        const value = db.settings.get(key);

        if (value === null) {
            return res.status(404).json({ error: 'Setting not found' });
        }

        res.json({ key, value });
    } catch (error) {
        logger.error('[Admin/Settings] Error getting setting:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /config/:key
 * Update a specific setting
 */
router.put('/:key', [
    body('value').exists().withMessage('value required'),
    handleValidationErrors,
], async (req, res) => {
    try {
        const db = getDb();
        const { key } = req.params;
        const { value } = req.body;

        db.settings.set(key, value);

        res.json({ success: true, key, value });
    } catch (error) {
        logger.error('[Admin/Settings] Error updating setting:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /config/:key
 * Delete a setting
 */
router.delete('/:key', async (req, res) => {
    try {
        const db = getDb();
        const { key } = req.params;

        db.settings.delete(key);

        res.json({ success: true, deleted: key });
    } catch (error) {
        logger.error('[Admin/Settings] Error deleting setting:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
