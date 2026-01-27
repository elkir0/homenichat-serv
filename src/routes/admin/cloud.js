/**
 * Admin Homenichat Cloud Routes
 * Unified Push + Tunnel with email/password authentication
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

// Get HomenichatCloudService (lazy load)
const getCloudService = () => {
    try {
        return require('../../services/HomenichatCloudService');
    } catch (e) {
        logger.warn('[Admin/Cloud] HomenichatCloudService not available');
        return null;
    }
};

/**
 * GET /homenichat-cloud/status
 * Get unified cloud service status
 */
router.get('/status', async (req, res) => {
    try {
        const cloudService = getCloudService();

        if (!cloudService) {
            return res.json({
                available: false,
                loggedIn: false,
                services: {
                    push: { enabled: false },
                    tunnel: { enabled: false },
                },
                message: 'HomenichatCloudService not available',
            });
        }

        const status = await cloudService.getStatus();
        res.json(status);
    } catch (error) {
        logger.error('[Admin/Cloud] Error getting status:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /homenichat-cloud/register
 * Register a new Homenichat Cloud account
 */
router.post('/register', [
    body('email').isEmail().normalizeEmail({ gmail_remove_dots: false }),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('name').optional().isString(),
    handleValidationErrors,
], async (req, res) => {
    try {
        const cloudService = getCloudService();

        if (!cloudService) {
            return res.status(503).json({ error: 'HomenichatCloudService not available' });
        }

        const { email, password, name } = req.body;

        const result = await cloudService.register(email, password, name);

        res.json({
            success: true,
            ...result,
        });
    } catch (error) {
        logger.error('[Admin/Cloud] Error registering:', error);
        res.status(400).json({ error: error.message });
    }
});

/**
 * POST /homenichat-cloud/login
 * Login to Homenichat Cloud
 */
router.post('/login', [
    body('email').isEmail().normalizeEmail({ gmail_remove_dots: false }),
    body('password').notEmpty(),
    handleValidationErrors,
], async (req, res) => {
    try {
        const cloudService = getCloudService();

        if (!cloudService) {
            return res.status(503).json({ error: 'HomenichatCloudService not available' });
        }

        const { email, password } = req.body;

        const result = await cloudService.login(email, password);

        res.json({
            success: true,
            ...result,
        });
    } catch (error) {
        logger.error('[Admin/Cloud] Error logging in:', error);
        // Use 400 instead of 401 to avoid triggering admin session redirect
        res.status(400).json({ error: error.message });
    }
});

/**
 * POST /homenichat-cloud/logout
 * Logout from Homenichat Cloud
 */
router.post('/logout', async (req, res) => {
    try {
        const cloudService = getCloudService();

        if (!cloudService) {
            return res.status(503).json({ error: 'HomenichatCloudService not available' });
        }

        await cloudService.logout();

        res.json({
            success: true,
            message: 'Logged out from Homenichat Cloud',
        });
    } catch (error) {
        logger.error('[Admin/Cloud] Error logging out:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /homenichat-cloud/connect
 * Connect to tunnel relay (must be logged in)
 */
router.post('/connect', async (req, res) => {
    try {
        const cloudService = getCloudService();

        if (!cloudService) {
            return res.status(503).json({ error: 'HomenichatCloudService not available' });
        }

        if (!cloudService.isLoggedIn()) {
            return res.status(400).json({ error: 'Not logged in to Homenichat Cloud' });
        }

        await cloudService.connectTunnel();
        const status = await cloudService.getStatus();

        res.json({
            success: true,
            message: 'Connected to Homenichat Cloud',
            status,
        });
    } catch (error) {
        logger.error('[Admin/Cloud] Error connecting:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /homenichat-cloud/disconnect
 * Disconnect from tunnel relay
 */
router.post('/disconnect', async (req, res) => {
    try {
        const cloudService = getCloudService();

        if (!cloudService) {
            return res.status(503).json({ error: 'HomenichatCloudService not available' });
        }

        await cloudService.disconnectTunnel();
        const status = await cloudService.getStatus();

        res.json({
            success: true,
            message: 'Disconnected from Homenichat Cloud',
            status,
        });
    } catch (error) {
        logger.error('[Admin/Cloud] Error disconnecting:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /homenichat-cloud/test
 * Test connection to relay server
 */
router.post('/test', async (req, res) => {
    try {
        const cloudService = getCloudService();

        if (!cloudService) {
            return res.status(503).json({ error: 'HomenichatCloudService not available' });
        }

        const result = await cloudService.testConnection();
        res.json(result);
    } catch (error) {
        logger.error('[Admin/Cloud] Error testing:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /homenichat-cloud/credentials
 * Get TURN credentials (must be logged in)
 */
router.get('/credentials', async (req, res) => {
    try {
        const cloudService = getCloudService();

        if (!cloudService) {
            return res.status(503).json({ error: 'HomenichatCloudService not available' });
        }

        if (!cloudService.isLoggedIn()) {
            return res.status(400).json({ error: 'Not logged in to Homenichat Cloud' });
        }

        const turn = await cloudService.getTurnCredentials();
        const iceServers = await cloudService.getIceServers();

        res.json({
            turn,
            iceServers,
        });
    } catch (error) {
        logger.error('[Admin/Cloud] Error getting credentials:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /homenichat-cloud/configure
 * Configure the service (hostname, autoConnect)
 */
router.post('/configure', async (req, res) => {
    try {
        const cloudService = getCloudService();

        if (!cloudService) {
            return res.status(503).json({ error: 'HomenichatCloudService not available' });
        }

        const { hostname, autoConnect } = req.body;

        const status = await cloudService.configure({ hostname, autoConnect });

        res.json({
            success: true,
            status,
        });
    } catch (error) {
        logger.error('[Admin/Cloud] Error configuring:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
