/**
 * Admin Install Routes
 * Handles installation wizard for Asterisk, chan_quectel, FreePBX
 */

const express = require('express');
const router = express.Router();
const logger = require('../../../utils/logger');

// Get InstallerService (lazy load)
const getInstallerService = () => {
    try {
        return require('../../services/InstallerService');
    } catch (e) {
        logger.warn('[Admin/Install] InstallerService not available');
        return null;
    }
};

/**
 * GET /install/status
 * Check if an installation is in progress
 */
router.get('/status', async (req, res) => {
    try {
        const installerService = getInstallerService();

        if (!installerService) {
            return res.status(503).json({ error: 'InstallerService not available' });
        }

        const status = installerService.getInstallationStatus();
        res.json(status);
    } catch (error) {
        logger.error('[Admin/Install] Error getting installation status:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET/POST /install/asterisk
 * Start Asterisk + chan_quectel installation (SSE stream)
 * Supports GET for EventSource and POST for programmatic requests
 */
const installAsteriskHandler = async (req, res) => {
    try {
        const installerService = getInstallerService();

        if (!installerService) {
            return res.status(503).json({ error: 'InstallerService not available' });
        }

        // Support both query params (GET/EventSource) and body (POST)
        const params = req.method === 'GET' ? req.query : req.body;

        const options = {
            installChanQuectel: params.installChanQuectel !== 'false' && params.installChanQuectel !== false,
            configureModems: params.configureModems !== 'false' && params.configureModems !== false,
            modemType: params.modemType || 'sim7600',
            installFreePBX: params.installFreePBX === 'true' || params.installFreePBX === true,
        };

        // Start installation with SSE
        await installerService.installAsterisk(options, res);
    } catch (error) {
        logger.error('[Admin/Install] Error installing Asterisk:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
};

router.get('/asterisk', installAsteriskHandler);
router.post('/asterisk', installAsteriskHandler);

/**
 * GET/POST /install/freepbx
 * Start FreePBX installation (SSE stream)
 */
const installFreepbxHandler = async (req, res) => {
    try {
        const installerService = getInstallerService();

        if (!installerService) {
            return res.status(503).json({ error: 'InstallerService not available' });
        }

        const options = req.method === 'GET' ? req.query : (req.body || {});

        // Start installation with SSE
        await installerService.installFreePBX(options, res);
    } catch (error) {
        logger.error('[Admin/Install] Error installing FreePBX:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
};

router.get('/freepbx', installFreepbxHandler);
router.post('/freepbx', installFreepbxHandler);

/**
 * POST /install/cancel
 * Cancel ongoing installation
 */
router.post('/cancel', async (req, res) => {
    try {
        const installerService = getInstallerService();

        if (!installerService) {
            return res.status(503).json({ error: 'InstallerService not available' });
        }

        const result = installerService.cancelInstallation();
        res.json(result);
    } catch (error) {
        logger.error('[Admin/Install] Error cancelling installation:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
