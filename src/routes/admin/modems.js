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

// =============================================================================
// SMS STATS
// =============================================================================

// Get database (lazy load)
const getDb = () => require('../../services/database');

/**
 * GET /modems/sms/stats
 * Get SMS statistics
 */
router.get('/sms/stats', async (req, res) => {
    try {
        const db = getDb();

        // Get SMS stats from database
        const stats = db.sms?.getStats?.() || {
            total: 0,
            sent: 0,
            received: 0,
            failed: 0,
            today: 0,
            thisWeek: 0,
            thisMonth: 0,
        };

        // Get per-modem stats
        const modemService = getModemService();
        const modemsConfig = modemService.getAllModemsConfig();
        const perModem = {};

        for (const modemId of Object.keys(modemsConfig)) {
            perModem[modemId] = db.sms?.getStatsByModem?.(modemId) || {
                sent: 0,
                received: 0,
                failed: 0,
            };
        }

        res.json({
            stats,
            perModem,
        });
    } catch (error) {
        logger.error('[Admin/Modems] Error getting SMS stats:', error);
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// USER-MODEM MAPPINGS (Push Notifications Routing)
// =============================================================================

/**
 * GET /modems/mappings
 * Get all user-modem mappings
 */
router.get('/mappings', async (req, res) => {
    try {
        const db = getDb();
        const mappings = db.modemMappings?.findAll?.() || [];
        res.json({ mappings });
    } catch (error) {
        logger.error('[Admin/Modems] Error getting modem mappings:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /modems/mappings/user/:userId
 * Get modem mappings for a specific user
 */
router.get('/mappings/user/:userId', [
    param('userId').isInt({ min: 1 }),
    handleValidationErrors,
], async (req, res) => {
    try {
        const db = getDb();
        const mappings = db.modemMappings?.findByUserId?.(parseInt(req.params.userId)) || [];
        res.json({ mappings });
    } catch (error) {
        logger.error('[Admin/Modems] Error getting user modem mappings:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /modems/mappings/modem/:modemId
 * Get users mapped to a specific modem
 */
router.get('/mappings/modem/:modemId', async (req, res) => {
    try {
        const db = getDb();
        const users = db.modemMappings?.findByModemId?.(req.params.modemId) || [];
        res.json({ users });
    } catch (error) {
        logger.error('[Admin/Modems] Error getting modem users:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/mappings
 * Create or update a user-modem mapping
 */
router.post('/mappings', [
    body('userId').isInt({ min: 1 }),
    body('modemId').notEmpty().isString(),
    body('modemPhoneNumber').optional().isString(),
    body('notifySms').optional().isBoolean(),
    body('notifyCalls').optional().isBoolean(),
    handleValidationErrors,
], async (req, res) => {
    try {
        const db = getDb();
        const { userId, modemId, modemPhoneNumber, notifySms, notifyCalls } = req.body;

        const mapping = db.modemMappings?.create?.(userId, modemId, {
            modemPhoneNumber,
            notifySms: notifySms !== false,
            notifyCalls: notifyCalls !== false,
        });

        res.json({ success: true, mapping });
    } catch (error) {
        logger.error('[Admin/Modems] Error creating modem mapping:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /modems/mappings/:userId/:modemId
 * Delete a user-modem mapping
 */
router.delete('/mappings/:userId/:modemId', [
    param('userId').isInt({ min: 1 }),
    param('modemId').notEmpty(),
    handleValidationErrors,
], async (req, res) => {
    try {
        const db = getDb();
        const { userId, modemId } = req.params;
        const deleted = db.modemMappings?.delete?.(parseInt(userId), modemId) || false;

        res.json({
            success: deleted,
            message: deleted ? 'Mapping deleted' : 'Mapping not found',
        });
    } catch (error) {
        logger.error('[Admin/Modems] Error deleting modem mapping:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/mappings/auto-map
 * Auto-map all users to a modem
 */
router.post('/mappings/auto-map', [
    body('modemId').notEmpty().isString(),
    body('modemPhoneNumber').optional().isString(),
    handleValidationErrors,
], async (req, res) => {
    try {
        const db = getDb();
        const { modemId, modemPhoneNumber } = req.body;
        const count = db.modemMappings?.autoMapAllUsers?.(modemId, modemPhoneNumber) || 0;

        res.json({
            success: true,
            message: `${count} users mapped to modem ${modemId}`,
        });
    } catch (error) {
        logger.error('[Admin/Modems] Error auto-mapping modem:', error);
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// DEVICE TOKENS (Push Notification Tokens)
// =============================================================================

/**
 * GET /modems/device-tokens
 * Get all registered device tokens
 */
router.get('/device-tokens', async (req, res) => {
    try {
        const db = getDb();
        const tokens = db.devices?.findAll?.() || [];

        // Mask tokens for security (show only last 8 chars)
        const masked = tokens.map(t => ({
            ...t,
            token: t.token ? `...${t.token.slice(-8)}` : null,
        }));

        res.json({ tokens: masked, count: tokens.length });
    } catch (error) {
        logger.error('[Admin/Modems] Error getting device tokens:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /modems/device-tokens/user/:userId
 * Get device tokens for a specific user
 */
router.get('/device-tokens/user/:userId', [
    param('userId').isInt({ min: 1 }),
    handleValidationErrors,
], async (req, res) => {
    try {
        const db = getDb();
        const tokens = db.devices?.findByUserId?.(parseInt(req.params.userId)) || [];

        const masked = tokens.map(t => ({
            ...t,
            token: t.token ? `...${t.token.slice(-8)}` : null,
        }));

        res.json({ tokens: masked });
    } catch (error) {
        logger.error('[Admin/Modems] Error getting user device tokens:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /modems/device-tokens/:token
 * Delete a device token
 */
router.delete('/device-tokens/:token', async (req, res) => {
    try {
        const db = getDb();
        let tokenToDelete = req.params.token;

        // If partial token provided, find full token
        if (tokenToDelete.length <= 20) {
            const allTokens = db.devices?.findAll?.() || [];
            const match = allTokens.find(t => t.token?.endsWith(tokenToDelete));
            if (match) {
                tokenToDelete = match.token;
            }
        }

        const deleted = db.devices?.delete?.(tokenToDelete) || false;
        res.json({
            success: deleted,
            message: deleted ? 'Token deleted' : 'Token not found',
        });
    } catch (error) {
        logger.error('[Admin/Modems] Error deleting device token:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/device-tokens/cleanup
 * Cleanup stale device tokens
 */
router.post('/device-tokens/cleanup', [
    body('daysInactive').optional().isInt({ min: 1, max: 365 }),
    handleValidationErrors,
], async (req, res) => {
    try {
        const db = getDb();
        const days = req.body.daysInactive || 30;
        const deleted = db.devices?.cleanupStale?.(days) || 0;
        res.json({
            success: true,
            deleted,
            message: `${deleted} stale tokens cleaned up`,
        });
    } catch (error) {
        logger.error('[Admin/Modems] Error cleaning up device tokens:', error);
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// VOLTE MANAGEMENT (EC25 Modems)
// =============================================================================

// Get VoLTE module (lazy load)
const getVoLTE = () => require('../../services/modem/volte');

/**
 * GET /modems/:id/volte/status
 * Get VoLTE status for a modem (IMS registration, network mode, audio mode)
 */
router.get('/:id/volte/status', async (req, res) => {
    try {
        const volte = getVoLTE();
        const { id } = req.params;
        const status = await volte.getVoLTEStatus(id);
        res.json(status);
    } catch (error) {
        logger.error('[Admin/Modems] Error getting VoLTE status:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/:id/volte/toggle
 * Toggle VoLTE mode on/off for a modem
 * Body: { enable: true/false }
 */
router.post('/:id/volte/toggle', [
    body('enable').isBoolean().withMessage('enable must be boolean'),
    handleValidationErrors,
], async (req, res) => {
    try {
        const volte = getVoLTE();
        const modemService = getModemService();
        const { id } = req.params;
        const { enable } = req.body;

        // Check if modem supports VoLTE
        const modemConfig = modemService.getModemConfig(id);
        const modemType = (modemConfig.modemType || 'sim7600').toLowerCase();
        const { MODEM_PROFILES } = require('../../services/modem/constants');
        const profile = MODEM_PROFILES[modemType];

        if (!profile?.supportsVoLTE) {
            return res.status(400).json({
                success: false,
                error: `Modem type ${modemType} does not support VoLTE. Only EC25 modems support VoLTE.`,
            });
        }

        // Toggle VoLTE
        const result = await volte.toggleVoLTE(id, enable);

        // If successful, update modem config and regenerate quectel.conf
        if (result.success) {
            modemService.saveModemConfig(id, { ...modemConfig, volteEnabled: enable });
            await modemService.applyQuectelConf();
        }

        res.json(result);
    } catch (error) {
        logger.error('[Admin/Modems] Error toggling VoLTE:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/:id/volte/enable
 * Enable VoLTE mode for a modem
 */
router.post('/:id/volte/enable', async (req, res) => {
    try {
        const volte = getVoLTE();
        const modemService = getModemService();
        const { id } = req.params;

        // Check if modem supports VoLTE
        const modemConfig = modemService.getModemConfig(id);
        const modemType = (modemConfig.modemType || 'sim7600').toLowerCase();
        const { MODEM_PROFILES } = require('../../services/modem/constants');
        const profile = MODEM_PROFILES[modemType];

        if (!profile?.supportsVoLTE) {
            return res.status(400).json({
                success: false,
                error: `Modem type ${modemType} does not support VoLTE. Only EC25 modems support VoLTE.`,
            });
        }

        // Enable VoLTE
        const result = await volte.enableVoLTE(id);

        // If successful, update modem config and regenerate quectel.conf
        if (result.success) {
            modemService.saveModemConfig(id, { ...modemConfig, volteEnabled: true });
            await modemService.applyQuectelConf();
        }

        res.json(result);
    } catch (error) {
        logger.error('[Admin/Modems] Error enabling VoLTE:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/:id/volte/disable
 * Disable VoLTE mode and switch to 3G mode
 */
router.post('/:id/volte/disable', async (req, res) => {
    try {
        const volte = getVoLTE();
        const modemService = getModemService();
        const { id } = req.params;

        // Disable VoLTE
        const result = await volte.disableVoLTE(id);

        // If successful, update modem config and regenerate quectel.conf
        if (result.success) {
            const modemConfig = modemService.getModemConfig(id);
            modemService.saveModemConfig(id, { ...modemConfig, volteEnabled: false });
            await modemService.applyQuectelConf();
        }

        res.json(result);
    } catch (error) {
        logger.error('[Admin/Modems] Error disabling VoLTE:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/:id/volte/initialize
 * Initialize VoLTE after Asterisk restart (re-sends AT commands)
 */
router.post('/:id/volte/initialize', async (req, res) => {
    try {
        const volte = getVoLTE();
        const modemService = getModemService();
        const { id } = req.params;

        // Get modem config to check if VoLTE should be enabled
        const modemConfig = modemService.getModemConfig(id);
        const volteEnabled = modemConfig.volteEnabled || false;

        const result = await volte.initializeVoLTE(id, volteEnabled);
        res.json(result);
    } catch (error) {
        logger.error('[Admin/Modems] Error initializing VoLTE:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /modems/volte/uac-device
 * Check if USB Audio Class (UAC) device is available for VoLTE
 */
router.get('/volte/uac-device', async (req, res) => {
    try {
        const volte = getVoLTE();
        const available = await volte.isUACDeviceAvailable();
        res.json({
            available,
            device: available ? 'plughw:CARD=Android,DEV=0' : null,
            message: available
                ? 'UAC device found - VoLTE audio ready'
                : 'UAC device not found - ensure AT+QAUDMOD=3 is set and modem is in VoLTE mode',
        });
    } catch (error) {
        logger.error('[Admin/Modems] Error checking UAC device:', error);
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// WATCHDOG SERVICE (Progressive Modem Recovery)
// =============================================================================

// Get watchdog module (lazy load)
const getWatchdog = () => require('../../services/modem/watchdog');

/**
 * GET /modems/watchdog/status
 * Get watchdog service status and modem states
 */
router.get('/watchdog/status', async (req, res) => {
    try {
        const { getWatchdog: getWatchdogInstance } = getWatchdog();
        const watchdog = getWatchdogInstance();
        res.json(watchdog.getStatus());
    } catch (error) {
        logger.error('[Admin/Modems] Error getting watchdog status:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/watchdog/start
 * Start the watchdog service
 */
router.post('/watchdog/start', async (req, res) => {
    try {
        const { startWatchdog } = getWatchdog();
        const config = req.body || {};
        const watchdog = startWatchdog(config);
        res.json({
            success: true,
            message: 'Watchdog started',
            status: watchdog.getStatus(),
        });
    } catch (error) {
        logger.error('[Admin/Modems] Error starting watchdog:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/watchdog/stop
 * Stop the watchdog service
 */
router.post('/watchdog/stop', async (req, res) => {
    try {
        const { stopWatchdog, getWatchdog: getWatchdogInstance } = getWatchdog();
        stopWatchdog();
        const watchdog = getWatchdogInstance();
        res.json({
            success: true,
            message: 'Watchdog stopped',
            status: watchdog.getStatus(),
        });
    } catch (error) {
        logger.error('[Admin/Modems] Error stopping watchdog:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /modems/watchdog/history
 * Get watchdog action history
 */
router.get('/watchdog/history', async (req, res) => {
    try {
        const { getWatchdog: getWatchdogInstance } = getWatchdog();
        const watchdog = getWatchdogInstance();
        const limit = parseInt(req.query.limit) || 50;
        res.json({
            history: watchdog.getHistory(limit),
        });
    } catch (error) {
        logger.error('[Admin/Modems] Error getting watchdog history:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/watchdog/reset/:modemId
 * Reset escalation level for a modem
 */
router.post('/watchdog/reset/:modemId', async (req, res) => {
    try {
        const { getWatchdog: getWatchdogInstance } = getWatchdog();
        const watchdog = getWatchdogInstance();
        const { modemId } = req.params;

        watchdog.resetEscalation(modemId);

        res.json({
            success: true,
            message: `Escalation reset for ${modemId}`,
            status: watchdog.getStatus(),
        });
    } catch (error) {
        logger.error('[Admin/Modems] Error resetting watchdog escalation:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/watchdog/force-action
 * Force a specific action level (for testing or manual intervention)
 * Body: { modemId: string, level: number (1-5) }
 *
 * Levels:
 * 1 = SOFT (AT diagnostic)
 * 2 = MEDIUM (modem reset)
 * 3 = HARD (reload chan_quectel)
 * 4 = CRITICAL (restart asterisk)
 * 5 = MAXIMUM (reboot host)
 */
router.post('/watchdog/force-action', [
    body('modemId').notEmpty().withMessage('modemId required'),
    body('level').isInt({ min: 1, max: 5 }).withMessage('level must be 1-5'),
    handleValidationErrors,
], async (req, res) => {
    try {
        const { getWatchdog: getWatchdogInstance, LEVEL_NAMES } = getWatchdog();
        const watchdog = getWatchdogInstance();
        const { modemId, level } = req.body;

        logger.warn(`[Admin/Modems] Forcing watchdog action: ${modemId} level ${level} (${LEVEL_NAMES[level]})`);

        const result = await watchdog.forceAction(modemId, level);

        res.json({
            success: result.success,
            modemId,
            level,
            levelName: LEVEL_NAMES[level],
            action: result,
        });
    } catch (error) {
        logger.error('[Admin/Modems] Error forcing watchdog action:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /modems/watchdog/cleanup-smsdb
 * Manually trigger smsdb cleanup
 */
router.post('/watchdog/cleanup-smsdb', async (req, res) => {
    try {
        const { getWatchdog: getWatchdogInstance } = getWatchdog();
        const watchdog = getWatchdogInstance();
        const result = await watchdog.cleanupSmsdb();
        res.json(result);
    } catch (error) {
        logger.error('[Admin/Modems] Error cleaning smsdb:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /modems/watchdog/logs
 * Get watchdog log file statistics and recent entries
 */
router.get('/watchdog/logs', async (req, res) => {
    try {
        const { getWatchdog: getWatchdogInstance } = getWatchdog();
        const watchdog = getWatchdogInstance();
        const limit = parseInt(req.query.limit) || 100;

        res.json({
            stats: watchdog.getLogStats(),
            entries: watchdog.getLogFileHistory(limit),
        });
    } catch (error) {
        logger.error('[Admin/Modems] Error getting watchdog logs:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /modems/watchdog/logs
 * Clear all watchdog log files
 */
router.delete('/watchdog/logs', async (req, res) => {
    try {
        const { getWatchdog: getWatchdogInstance } = getWatchdog();
        const watchdog = getWatchdogInstance();
        const result = watchdog.clearLogs();

        res.json({
            success: result.success,
            message: result.success ? 'Watchdog logs cleared' : result.error,
        });
    } catch (error) {
        logger.error('[Admin/Modems] Error clearing watchdog logs:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /modems/watchdog/config
 * Update watchdog configuration
 * Body: { enabled, checkIntervalMs, enableMaxReboot, thresholds, ... }
 */
router.put('/watchdog/config', async (req, res) => {
    try {
        const { getWatchdog: getWatchdogInstance, ESCALATION_LEVELS } = getWatchdog();
        const watchdog = getWatchdogInstance();
        const updates = req.body;

        // Update configuration
        if (updates.checkIntervalMs !== undefined) {
            watchdog.config.checkIntervalMs = updates.checkIntervalMs;
        }

        if (updates.enableMaxReboot !== undefined) {
            watchdog.config.enabledLevels[ESCALATION_LEVELS.MAXIMUM] = updates.enableMaxReboot;
        }

        if (updates.thresholds) {
            watchdog.config.thresholds = { ...watchdog.config.thresholds, ...updates.thresholds };
        }

        // Restart if interval changed and running
        if (updates.checkIntervalMs !== undefined && watchdog.running) {
            watchdog.stop();
            watchdog.start();
        }

        res.json({
            success: true,
            message: 'Watchdog configuration updated',
            config: {
                checkIntervalMs: watchdog.config.checkIntervalMs,
                maxRebootEnabled: watchdog.config.enabledLevels[ESCALATION_LEVELS.MAXIMUM],
                thresholds: watchdog.config.thresholds,
            },
        });
    } catch (error) {
        logger.error('[Admin/Modems] Error updating watchdog config:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
