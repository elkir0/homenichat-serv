/**
 * Admin Tunnel Relay Routes
 * Handles WireGuard + TURN tunneling service
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

// Get TunnelRelayService (lazy load)
const getTunnelRelayService = () => {
    try {
        return require('../../services/TunnelRelayService');
    } catch (e) {
        logger.warn('[Admin/TunnelRelay] TunnelRelayService not available');
        return null;
    }
};

/**
 * GET /tunnel-relay/status
 * Get Tunnel Relay status
 */
router.get('/status', async (req, res) => {
    try {
        const tunnelRelayService = getTunnelRelayService();

        if (!tunnelRelayService) {
            return res.json({
                available: false,
                configured: false,
                connected: false,
                message: 'TunnelRelayService not available',
            });
        }

        const status = await tunnelRelayService.getStatus();
        res.json(status);
    } catch (error) {
        logger.error('[Admin/TunnelRelay] Error getting status:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /tunnel-relay/configure
 * Configure Tunnel Relay service
 */
router.post('/configure', [
    body('relayUrl').optional().isURL(),
    body('licenseKey').optional().isString(),
    body('hostname').optional().isString(),
    body('autoConnect').optional().isBoolean(),
    handleValidationErrors,
], async (req, res) => {
    try {
        const tunnelRelayService = getTunnelRelayService();

        if (!tunnelRelayService) {
            return res.status(503).json({ error: 'TunnelRelayService not available' });
        }

        const { relayUrl, licenseKey, hostname, autoConnect } = req.body;

        const result = await tunnelRelayService.configure({
            relayUrl,
            licenseKey,
            hostname,
            autoConnect,
        });

        res.json({
            success: true,
            ...result,
        });
    } catch (error) {
        logger.error('[Admin/TunnelRelay] Error configuring:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /tunnel-relay/connect
 * Connect to tunnel relay
 */
router.post('/connect', async (req, res) => {
    try {
        const tunnelRelayService = getTunnelRelayService();

        if (!tunnelRelayService) {
            return res.status(503).json({ error: 'TunnelRelayService not available' });
        }

        if (!tunnelRelayService.isConfigured()) {
            return res.status(400).json({ error: 'Tunnel Relay not configured' });
        }

        await tunnelRelayService.connect();
        const status = await tunnelRelayService.getStatus();

        res.json({
            success: true,
            message: 'Connected to Tunnel Relay',
            status,
        });
    } catch (error) {
        logger.error('[Admin/TunnelRelay] Error connecting:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /tunnel-relay/disconnect
 * Disconnect from tunnel relay
 */
router.post('/disconnect', async (req, res) => {
    try {
        const tunnelRelayService = getTunnelRelayService();

        if (!tunnelRelayService) {
            return res.status(503).json({ error: 'TunnelRelayService not available' });
        }

        await tunnelRelayService.disconnect();
        const status = await tunnelRelayService.getStatus();

        res.json({
            success: true,
            message: 'Disconnected from Tunnel Relay',
            status,
        });
    } catch (error) {
        logger.error('[Admin/TunnelRelay] Error disconnecting:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /tunnel-relay/test
 * Test tunnel relay connection
 */
router.post('/test', async (req, res) => {
    try {
        const tunnelRelayService = getTunnelRelayService();

        if (!tunnelRelayService) {
            return res.status(503).json({ error: 'TunnelRelayService not available' });
        }

        const result = await tunnelRelayService.testConnection();

        res.json(result);
    } catch (error) {
        logger.error('[Admin/TunnelRelay] Error testing:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /tunnel-relay/credentials
 * Get TURN credentials
 */
router.get('/credentials', async (req, res) => {
    try {
        const tunnelRelayService = getTunnelRelayService();

        if (!tunnelRelayService) {
            return res.status(503).json({ error: 'TunnelRelayService not available' });
        }

        if (!tunnelRelayService.isConfigured()) {
            return res.status(400).json({ error: 'Tunnel Relay not configured' });
        }

        const turn = await tunnelRelayService.getTurnCredentials();
        const iceServers = await tunnelRelayService.getIceServers();

        res.json({
            turn,
            iceServers,
        });
    } catch (error) {
        logger.error('[Admin/TunnelRelay] Error getting credentials:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /tunnel-relay/refresh-credentials
 * Force refresh TURN credentials
 */
router.post('/refresh-credentials', async (req, res) => {
    try {
        const tunnelRelayService = getTunnelRelayService();

        if (!tunnelRelayService) {
            return res.status(503).json({ error: 'TunnelRelayService not available' });
        }

        if (!tunnelRelayService.isConfigured()) {
            return res.status(400).json({ error: 'Tunnel Relay not configured' });
        }

        const turn = await tunnelRelayService.refreshTurnCredentials();

        res.json({
            success: true,
            turn,
        });
    } catch (error) {
        logger.error('[Admin/TunnelRelay] Error refreshing credentials:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
