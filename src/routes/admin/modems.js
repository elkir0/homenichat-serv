/**
 * Admin Modem Routes
 * Handles modem management, configuration, and status
 */

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const logger = require('../../../utils/logger');

// Get ModemService (lazy load to avoid circular dependencies)
const getModemService = () => {
    const { getModemService } = require('../../services/modem');
    return getModemService();
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
 * GET /modems
 * Get all modem status and configuration
 */
router.get('/', async (req, res) => {
    try {
        const modemService = getModemService();
        const status = await modemService.collectAll();
        res.json(status);
    } catch (error) {
        logger.error('[Admin/Modems] Error getting status:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /modems/full-status
 * Get comprehensive modem status
 */
router.get('/full-status', async (req, res) => {
    try {
        const modemService = getModemService();
        const status = await modemService.collectAll();
        res.json(status);
    } catch (error) {
        logger.error('[Admin/Modems] Error getting full status:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /modems/config
 * Get modem configuration
 */
router.get('/config', async (req, res) => {
    try {
        const modemService = getModemService();
        const config = modemService.getAllModemsConfig();
        res.json({ modems: config });
    } catch (error) {
        logger.error('[Admin/Modems] Error getting config:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /modems/config
 * Update modem configuration
 */
router.put('/config', [
    body('modemId').notEmpty().withMessage('modemId required'),
    handleValidationErrors,
], async (req, res) => {
    try {
        const modemService = getModemService();
        const { modemId, ...config } = req.body;
        modemService.saveModemConfig(modemId, config);
        res.json({ success: true, message: 'Configuration saved' });
    } catch (error) {
        logger.error('[Admin/Modems] Error saving config:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /modems/config/:modemId
 * Delete modem configuration
 */
router.delete('/config/:modemId', async (req, res) => {
    try {
        const modemService = getModemService();
        const { modemId } = req.params;
        const deleted = modemService.deleteModemConfig(modemId);
        res.json({ success: deleted, message: deleted ? 'Deleted' : 'Not found' });
    } catch (error) {
        logger.error('[Admin/Modems] Error deleting config:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /modems/profiles
 * Get available modem profiles (EC25, SIM7600)
 */
router.get('/profiles', async (req, res) => {
    try {
        const modemService = getModemService();
        const profiles = modemService.getModemProfiles();
        res.json({ profiles });
    } catch (error) {
        logger.error('[Admin/Modems] Error getting profiles:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/detect
 * Detect connected USB modems
 */
router.post('/detect', async (req, res) => {
    try {
        const modemService = getModemService();
        const detected = await modemService.detectUsbPorts();
        res.json(detected);
    } catch (error) {
        logger.error('[Admin/Modems] Error detecting modems:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/add
 * Add a new modem
 */
router.post('/add', [
    body('modemType').isIn(['sim7600', 'ec25']).withMessage('Invalid modem type'),
    body('dataPort').notEmpty().withMessage('dataPort required'),
    handleValidationErrors,
], async (req, res) => {
    try {
        const modemService = getModemService();
        const { modemType, dataPort, audioPort, modemName, phoneNumber } = req.body;

        // Calculate audio port if not provided
        const calculatedAudioPort = audioPort || modemService.calculateAudioPort(dataPort, modemType);

        // Generate modem ID
        const existingModems = Object.keys(modemService.getAllModemsConfig());
        const nextIndex = existingModems.length + 1;
        const modemId = modemName || `modem-${nextIndex}`;

        // Save configuration
        modemService.saveModemConfig(modemId, {
            modemType,
            modemName: modemId,
            dataPort,
            audioPort: calculatedAudioPort,
            phoneNumber: phoneNumber || '',
        });

        // Apply to Asterisk
        await modemService.applyQuectelConf();

        res.json({
            success: true,
            message: `Modem ${modemId} added successfully`,
            modemId,
        });
    } catch (error) {
        logger.error('[Admin/Modems] Error adding modem:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /modems/:id/status
 * Get status for a specific modem
 */
router.get('/:id/status', async (req, res) => {
    try {
        const modemService = getModemService();
        const { id } = req.params;
        const status = await modemService.collectModemStatus(id);
        res.json(status);
    } catch (error) {
        logger.error('[Admin/Modems] Error getting modem status:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/:id/restart
 * Restart a modem
 */
router.post('/:id/restart', async (req, res) => {
    try {
        const modemService = getModemService();
        const { id } = req.params;
        const result = await modemService.restartModem(id);
        res.json({ success: true, result });
    } catch (error) {
        logger.error('[Admin/Modems] Error restarting modem:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/:id/at-command
 * Send AT command to a modem
 */
router.post('/:id/at-command', [
    body('command').notEmpty().withMessage('command required'),
    handleValidationErrors,
], async (req, res) => {
    try {
        const modemService = getModemService();
        const { id } = req.params;
        const { command } = req.body;
        const result = await modemService.sendAtCommand(id, command);
        res.json({ success: true, result });
    } catch (error) {
        logger.error('[Admin/Modems] Error sending AT command:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/:id/sms
 * Send SMS via a modem
 */
router.post('/:id/sms', [
    body('to').notEmpty().withMessage('to required'),
    body('message').notEmpty().withMessage('message required'),
    handleValidationErrors,
], async (req, res) => {
    try {
        const modemService = getModemService();
        const { id } = req.params;
        const { to, message } = req.body;
        const result = await modemService.sendSms(id, to, message);
        res.json(result);
    } catch (error) {
        logger.error('[Admin/Modems] Error sending SMS:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/:id/configure-audio
 * Configure audio for a modem
 */
router.post('/:id/configure-audio', async (req, res) => {
    try {
        const modemService = getModemService();
        const { id } = req.params;
        const result = await modemService.configureAudioForType(id);
        res.json({ success: true, result });
    } catch (error) {
        logger.error('[Admin/Modems] Error configuring audio:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /modems/sim-status
 * Get SIM card status for all modems
 */
router.get('/sim-status', async (req, res) => {
    try {
        const modemService = getModemService();
        const modemsConfig = modemService.getAllModemsConfig();
        const statuses = [];

        for (const modemId of Object.keys(modemsConfig)) {
            const pinStatus = await modemService.checkSimPin(modemId);
            statuses.push({ modemId, ...pinStatus });
        }

        res.json({ modems: statuses });
    } catch (error) {
        logger.error('[Admin/Modems] Error getting SIM status:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /modems/pin-status
 * Get PIN attempts status
 */
router.get('/pin-status', async (req, res) => {
    try {
        const modemService = getModemService();
        const modemsConfig = modemService.getAllModemsConfig();
        const statuses = [];

        for (const modemId of Object.keys(modemsConfig)) {
            statuses.push(modemService.getPinAttemptsRemaining(modemId));
        }

        res.json({ modems: statuses });
    } catch (error) {
        logger.error('[Admin/Modems] Error getting PIN status:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/enter-pin
 * Enter SIM PIN
 */
router.post('/enter-pin', [
    body('pin').matches(/^\d{4,8}$/).withMessage('PIN must be 4-8 digits'),
    handleValidationErrors,
], async (req, res) => {
    try {
        const modemService = getModemService();
        const { pin, modemId = 'modem-1' } = req.body;
        const result = await modemService.enterSimPin(pin, modemId);
        res.json(result);
    } catch (error) {
        logger.error('[Admin/Modems] Error entering PIN:', error);
        res.status(400).json({ error: error.message });
    }
});

/**
 * POST /modems/reset-pin-attempts
 * Reset PIN attempts counter
 */
router.post('/reset-pin-attempts', async (req, res) => {
    try {
        const modemService = getModemService();
        const { modemId } = req.body;
        const result = modemService.resetPinAttempts(modemId || null);
        res.json(result);
    } catch (error) {
        logger.error('[Admin/Modems] Error resetting PIN attempts:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /modems/quectel-conf
 * Get current quectel.conf content
 */
router.get('/quectel-conf', async (req, res) => {
    try {
        const modemService = getModemService();
        const content = modemService.readQuectelConf();
        res.json({ content });
    } catch (error) {
        logger.error('[Admin/Modems] Error reading quectel.conf:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/apply-config
 * Apply quectel.conf and reload Asterisk
 */
router.post('/apply-config', async (req, res) => {
    try {
        const modemService = getModemService();
        const result = await modemService.applyQuectelConf(req.body || {});
        res.json({ success: result.success, ...result });
    } catch (error) {
        logger.error('[Admin/Modems] Error applying config:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/initialize
 * Initialize modem (auto-detect and configure)
 */
router.post('/initialize', async (req, res) => {
    try {
        const modemService = getModemService();
        const { modemId } = req.body;
        const result = await modemService.initializeModem(modemId);
        res.json(result);
    } catch (error) {
        logger.error('[Admin/Modems] Error initializing modem:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/restart-asterisk
 * Restart Asterisk service
 */
router.post('/restart-asterisk', async (req, res) => {
    try {
        const modemService = getModemService();
        await modemService.restartAsterisk();
        res.json({ success: true, message: 'Asterisk restarting...' });
    } catch (error) {
        logger.error('[Admin/Modems] Error restarting Asterisk:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/restart-services
 * Restart all services
 */
router.post('/restart-services', async (req, res) => {
    try {
        const modemService = getModemService();
        await modemService.restartAllServices();
        res.json({ success: true, message: 'Services restarting...' });
    } catch (error) {
        logger.error('[Admin/Modems] Error restarting services:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
