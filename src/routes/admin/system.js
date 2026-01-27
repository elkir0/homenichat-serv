/**
 * Admin System Routes
 * Handles system status
 */

const express = require('express');
const router = express.Router();
const logger = require('../../../utils/logger');

// Get InstallerService (lazy load)
const getInstallerService = () => {
    try {
        return require('../../services/InstallerService');
    } catch (e) {
        logger.warn('[Admin/System] InstallerService not available');
        return null;
    }
};

/**
 * GET /system/status
 * Get system status (installed components, detected modems)
 */
router.get('/status', async (req, res) => {
    try {
        const installerService = getInstallerService();

        if (!installerService) {
            // Return basic status if InstallerService not available
            const os = require('os');
            return res.json({
                available: false,
                hostname: os.hostname(),
                platform: os.platform(),
                arch: os.arch(),
                uptime: os.uptime(),
                memory: {
                    total: os.totalmem(),
                    free: os.freemem(),
                },
                load: os.loadavg(),
                message: 'InstallerService not available - basic status only',
            });
        }

        const status = await installerService.getSystemStatus();
        res.json(status);
    } catch (error) {
        logger.error('[Admin/System] Error getting system status:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /system/health
 * Simple health check
 */
router.get('/health', async (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
    });
});

/**
 * GET /system/info
 * Get detailed system information
 */
router.get('/info', async (req, res) => {
    try {
        const os = require('os');

        res.json({
            hostname: os.hostname(),
            platform: os.platform(),
            arch: os.arch(),
            release: os.release(),
            type: os.type(),
            uptime: os.uptime(),
            cpus: os.cpus().length,
            memory: {
                total: os.totalmem(),
                free: os.freemem(),
                used: os.totalmem() - os.freemem(),
            },
            load: os.loadavg(),
            network: Object.entries(os.networkInterfaces())
                .filter(([name]) => !name.startsWith('lo'))
                .map(([name, addrs]) => ({
                    name,
                    addresses: addrs.filter(a => a.family === 'IPv4').map(a => a.address),
                })),
            node: {
                version: process.version,
                pid: process.pid,
                uptime: process.uptime(),
            },
        });
    } catch (error) {
        logger.error('[Admin/System] Error getting system info:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
