/**
 * Admin Dashboard Routes
 * Statistics and overview endpoints
 */

const express = require('express');
const router = express.Router();
const logger = require('../../../utils/logger');

// Get database (lazy load)
const getDb = () => require('../../services/database');

/**
 * GET /dashboard
 * Get dashboard statistics
 */
router.get('/', async (req, res) => {
    try {
        const db = getDb();

        const stats = {
            users: {
                total: db.users.findAll().length,
            },
            calls: db.calls.getStats(),
            system: {
                uptime: process.uptime(),
                memory: process.memoryUsage(),
            },
        };

        res.json(stats);
    } catch (error) {
        logger.error('[Admin/Dashboard] Error getting stats:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
