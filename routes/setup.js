/**
 * Setup Routes - First-run setup wizard API
 *
 * These routes are only accessible when setup is not complete.
 * Once setup is marked complete, all routes return 403.
 *
 * Prefix: /api/setup
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const logger = require('winston');

// Services
const db = require('../services/DatabaseService');
const systemService = require('../services/SystemService');
const networkService = require('../services/NetworkService');
const InstallerService = require('../services/InstallerService');
const ModemService = require('../services/ModemService');
const homenichatCloudService = require('../services/HomenichatCloudService');

// Service instances
let installerService = null;
let modemService = null;

/**
 * Middleware: Block access if setup is already complete
 */
const requireSetupIncomplete = (req, res, next) => {
    if (db.isSetupComplete()) {
        return res.status(403).json({
            error: 'Setup already complete',
            message: 'The initial setup has already been completed. Access to setup routes is disabled.'
        });
    }
    next();
};

// Apply middleware to all routes
router.use(requireSetupIncomplete);

// =============================================================================
// STATUS
// =============================================================================

/**
 * GET /api/setup/status
 * Check if setup is needed and get current step
 */
router.get('/status', (req, res) => {
    try {
        const status = db.getAllSetupStatus();
        const isComplete = db.isSetupComplete();
        const currentStep = db.getCurrentSetupStep();
        const adminPasswordChanged = db.isAdminPasswordChanged();

        res.json({
            setupNeeded: !isComplete,
            setupComplete: isComplete,
            currentStep,
            adminPasswordChanged,
            steps: [
                { id: 0, name: 'welcome', label: 'Welcome', completed: true },
                { id: 1, name: 'admin-password', label: 'Admin Password', required: true, completed: adminPasswordChanged },
                { id: 2, name: 'system', label: 'System Settings', completed: status.system_configured === 'true' },
                { id: 3, name: 'network', label: 'Network', completed: status.network_configured === 'true' },
                { id: 4, name: 'modem', label: 'GSM Modem', completed: status.modem_configured === 'true' },
                { id: 5, name: 'cloud', label: 'Homenichat Cloud', completed: status.cloud_configured === 'true' },
                { id: 6, name: 'summary', label: 'Summary', completed: isComplete }
            ]
        });
    } catch (error) {
        logger.error('Setup status error:', error);
        res.status(500).json({ error: 'Failed to get setup status' });
    }
});

// =============================================================================
// STEP 1: ADMIN PASSWORD
// =============================================================================

/**
 * POST /api/setup/admin-password
 * Change admin password (required step)
 */
router.post('/admin-password', async (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;

        // Validate input
        if (!newPassword || !confirmPassword) {
            return res.status(400).json({ error: 'New password and confirmation are required' });
        }

        if (newPassword !== confirmPassword) {
            return res.status(400).json({ error: 'Passwords do not match' });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        // Check for common weak passwords
        const weakPasswords = ['password', '12345678', 'homenichat', 'admin123', 'password1'];
        if (weakPasswords.includes(newPassword.toLowerCase())) {
            return res.status(400).json({ error: 'Password is too weak. Please choose a stronger password.' });
        }

        // Get admin user
        const admin = db.getUserByUsername('admin');
        if (!admin) {
            return res.status(500).json({ error: 'Admin user not found' });
        }

        // If this is the first time (password is default), currentPassword should be 'Homenichat'
        const isDefaultPassword = bcrypt.compareSync('Homenichat', admin.password);

        if (!isDefaultPassword) {
            // Password was already changed, verify current password
            if (!currentPassword) {
                return res.status(400).json({ error: 'Current password is required' });
            }
            if (!bcrypt.compareSync(currentPassword, admin.password)) {
                return res.status(401).json({ error: 'Current password is incorrect' });
            }
        }

        // Hash and save new password
        const hashedPassword = bcrypt.hashSync(newPassword, 10);
        db.changePassword(admin.id, hashedPassword);

        // Mark password as changed
        db.markAdminPasswordChanged();
        db.setCurrentSetupStep(2);

        logger.info('Admin password changed during setup');

        res.json({
            success: true,
            message: 'Admin password updated successfully',
            nextStep: 2
        });
    } catch (error) {
        logger.error('Admin password change error:', error);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// =============================================================================
// STEP 2: SYSTEM SETTINGS
// =============================================================================

/**
 * GET /api/setup/system
 * Get current system settings (hostname, timezone)
 */
router.get('/system', (req, res) => {
    try {
        const hostname = systemService.getHostname();
        const timezone = systemService.getTimezone();
        const groupedTimezones = systemService.getGroupedTimezones();
        const systemInfo = systemService.getSystemInfo();

        // Get common timezones for quick selection
        const commonTimezones = [
            'Europe/Paris',
            'Europe/London',
            'America/New_York',
            'America/Los_Angeles',
            'America/Chicago',
            'America/Guadeloupe',
            'America/Martinique',
            'Asia/Tokyo',
            'Australia/Sydney',
            'UTC'
        ];

        res.json({
            hostname,
            timezone,
            currentTime: systemService.getTimeInTimezone(timezone),
            commonTimezones,
            groupedTimezones,
            isRoot: systemService.isRoot(),
            hasSystemd: systemService.hasSystemd(),
            systemInfo
        });
    } catch (error) {
        logger.error('System settings error:', error);
        res.status(500).json({ error: 'Failed to get system settings' });
    }
});

/**
 * POST /api/setup/system
 * Configure system settings (hostname, timezone)
 */
router.post('/system', async (req, res) => {
    try {
        const { hostname, timezone } = req.body;
        const results = { hostname: null, timezone: null };

        // Set hostname if provided and different
        if (hostname && hostname !== systemService.getHostname()) {
            results.hostname = await systemService.setHostname(hostname);
            if (!results.hostname.success) {
                return res.status(400).json({
                    error: 'Failed to set hostname',
                    details: results.hostname.error
                });
            }
        }

        // Set timezone if provided and different
        if (timezone && timezone !== systemService.getTimezone()) {
            results.timezone = await systemService.setTimezone(timezone);
            if (!results.timezone.success) {
                return res.status(400).json({
                    error: 'Failed to set timezone',
                    details: results.timezone.error
                });
            }
        }

        db.setSetupStatus('system_configured', 'true');
        db.setCurrentSetupStep(3);

        res.json({
            success: true,
            message: 'System settings updated',
            hostname: systemService.getHostname(),
            timezone: systemService.getTimezone(),
            nextStep: 3
        });
    } catch (error) {
        logger.error('System settings update error:', error);
        res.status(500).json({ error: 'Failed to update system settings' });
    }
});

/**
 * POST /api/setup/system/skip
 * Skip system settings step
 */
router.post('/system/skip', (req, res) => {
    db.setSetupStatus('system_configured', 'skipped');
    db.setCurrentSetupStep(3);
    res.json({ success: true, message: 'System settings skipped', nextStep: 3 });
});

/**
 * GET /api/setup/system/time-preview
 * Preview time in a specific timezone
 */
router.get('/system/time-preview', (req, res) => {
    const { timezone } = req.query;
    if (!timezone) {
        return res.status(400).json({ error: 'Timezone parameter required' });
    }
    res.json({
        timezone,
        currentTime: systemService.getTimeInTimezone(timezone)
    });
});

// =============================================================================
// STEP 3: NETWORK
// =============================================================================

/**
 * GET /api/setup/network
 * Get current network configuration
 */
router.get('/network', async (req, res) => {
    try {
        const summary = networkService.getNetworkSummary();
        const connectivity = await networkService.checkConnectivity();

        res.json({
            ...summary,
            connectivity
        });
    } catch (error) {
        logger.error('Network config error:', error);
        res.status(500).json({ error: 'Failed to get network configuration' });
    }
});

/**
 * POST /api/setup/network
 * Configure network (DHCP or static IP)
 */
router.post('/network', async (req, res) => {
    try {
        const { connectionName, method, ip, gateway, dns } = req.body;

        if (!connectionName) {
            return res.status(400).json({ error: 'Connection name is required' });
        }

        let result;

        if (method === 'dhcp') {
            result = await networkService.setDhcp(connectionName);
        } else if (method === 'static') {
            if (!ip || !gateway) {
                return res.status(400).json({ error: 'IP address and gateway are required for static configuration' });
            }
            result = await networkService.setStaticIp(connectionName, {
                ip,
                gateway,
                dns: dns || []
            });
        } else {
            return res.status(400).json({ error: 'Invalid method. Use "dhcp" or "static"' });
        }

        if (!result.success) {
            return res.status(400).json({
                error: 'Network configuration failed',
                details: result.error
            });
        }

        db.setSetupStatus('network_configured', 'true');
        db.setCurrentSetupStep(4);

        // Check connectivity after change
        const connectivity = await networkService.checkConnectivity();

        res.json({
            success: true,
            message: 'Network configured successfully',
            newIp: networkService.getPrimaryIpAddress(),
            connectivity,
            nextStep: 4
        });
    } catch (error) {
        logger.error('Network configuration error:', error);
        res.status(500).json({ error: 'Failed to configure network' });
    }
});

/**
 * POST /api/setup/network/skip
 * Skip network configuration step
 */
router.post('/network/skip', (req, res) => {
    db.setSetupStatus('network_configured', 'skipped');
    db.setCurrentSetupStep(4);
    res.json({ success: true, message: 'Network configuration skipped', nextStep: 4 });
});

/**
 * POST /api/setup/network/test
 * Test network connectivity
 */
router.post('/network/test', async (req, res) => {
    const { host } = req.body;
    const connectivity = await networkService.checkConnectivity(host || '8.8.8.8');
    res.json(connectivity);
});

// =============================================================================
// STEP 4: MODEM
// =============================================================================

/**
 * GET /api/setup/modem-scan
 * Detect connected GSM modems
 */
router.get('/modem-scan', async (req, res) => {
    try {
        // Initialize installer service if needed
        if (!installerService) {
            installerService = new InstallerService({ logger: console });
        }

        // Detect USB modems using InstallerService
        const detected = installerService.detectUsbModems();

        // Check for existing modem configuration
        const ModemService = require('../services/ModemService');
        const modemService = new ModemService({ modems: {}, logger: console });
        const existingConfig = modemService.getAllModemsConfig();

        res.json({
            detected,
            existing: existingConfig?.modems || {},
            hasModems: detected.length > 0 || Object.keys(existingConfig?.modems || {}).length > 0
        });
    } catch (error) {
        logger.error('Modem scan error:', error);
        res.status(500).json({ error: 'Failed to scan for modems', details: error.message });
    }
});

/**
 * POST /api/setup/modem-configure
 * Configure a detected modem
 */
router.post('/modem-configure', async (req, res) => {
    try {
        const { modemType, dataPort, audioPort, modemName, phoneNumber, pinCode, networkMode } = req.body;

        if (!modemType || !dataPort) {
            return res.status(400).json({ error: 'Modem type and data port are required' });
        }

        // Initialize modem service if needed
        if (!modemService) {
            modemService = new ModemService({ modems: {}, logger: console });
        }

        // Generate modem name if not provided
        const name = modemName || `hni-${modemType}`;
        const modemId = 'modem-1';

        // Determine audio port based on modem type if not provided
        let audio = audioPort;
        if (!audio) {
            // EC25: USB+1, SIM7600: USB+4
            const dataMatch = dataPort.match(/ttyUSB(\d+)/);
            if (dataMatch) {
                const dataNum = parseInt(dataMatch[1], 10);
                const offset = modemType === 'ec25' ? -1 : 2;
                audio = `/dev/ttyUSB${dataNum + offset}`;
            }
        }

        // Save modem config
        modemService.saveModemConfig(modemId, {
            modemType,
            modemName: name,
            dataPort,
            audioPort: audio,
            phoneNumber: phoneNumber || '',
            pinCode: pinCode || '',
            networkMode: networkMode || 'lte',
            autoDetect: false,
        });

        // Create modem config for applyQuectelConf
        const modemConfig = {
            id: modemId,
            type: modemType.toUpperCase(),
            name,
            dataPort,
            audioPort: audio,
            phoneNumber: phoneNumber || '',
        };

        // Generate and apply quectel.conf
        const result = await modemService.applyQuectelConf({
            modems: [modemConfig],
        });

        db.setSetupStatus('modem_configured', 'true');
        db.setCurrentSetupStep(5);

        res.json({
            success: true,
            message: 'Modem configured successfully',
            modem: { name, dataPort, audioPort: audio, modemType, phoneNumber, networkMode },
            nextStep: 5,
            ...result
        });
    } catch (error) {
        logger.error('Modem configuration error:', error);
        res.status(500).json({ error: 'Failed to configure modem', details: error.message });
    }
});

/**
 * POST /api/setup/modem/skip
 * Skip modem configuration step
 */
router.post('/modem/skip', (req, res) => {
    db.setSetupStatus('modem_configured', 'skipped');
    db.setCurrentSetupStep(5);
    res.json({ success: true, message: 'Modem configuration skipped', nextStep: 5 });
});

/**
 * POST /api/setup/modem-test
 * Test SMS capability of a modem
 */
router.post('/modem-test', async (req, res) => {
    try {
        const { modemName, phoneNumber, message } = req.body;

        if (!modemName || !phoneNumber) {
            return res.status(400).json({ error: 'Modem name and phone number are required' });
        }

        // Initialize modem service if needed
        if (!modemService) {
            modemService = new ModemService({ modems: {}, logger: console });
        }

        // Send test SMS
        const result = await modemService.sendTestSms(modemName, phoneNumber, message || 'Homenichat test SMS');

        res.json(result);
    } catch (error) {
        logger.error('Modem test error:', error);
        res.status(500).json({ error: 'Failed to test modem' });
    }
});

// =============================================================================
// STEP 5: HOMENICHAT CLOUD
// =============================================================================

/**
 * GET /api/setup/cloud/status
 * Get Homenichat Cloud connection status
 */
router.get('/cloud/status', async (req, res) => {
    try {
        const status = homenichatCloudService.getStatus();
        res.json(status);
    } catch (error) {
        logger.error('Cloud status error:', error);
        res.status(500).json({ error: 'Failed to get cloud status' });
    }
});

/**
 * POST /api/setup/cloud-login
 * Login to Homenichat Cloud
 */
router.post('/cloud-login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const result = await homenichatCloudService.login(email, password);

        if (!result.success) {
            return res.status(401).json({
                error: 'Login failed',
                details: result.error
            });
        }

        db.setSetupStatus('cloud_configured', 'true');
        db.setCurrentSetupStep(6);

        res.json({
            success: true,
            message: 'Logged in to Homenichat Cloud',
            user: result.user,
            services: result.services,
            nextStep: 6
        });
    } catch (error) {
        logger.error('Cloud login error:', error);
        res.status(500).json({ error: 'Failed to login to Homenichat Cloud' });
    }
});

/**
 * POST /api/setup/cloud-register
 * Register new Homenichat Cloud account
 */
router.post('/cloud-register', async (req, res) => {
    try {
        const { email, password, name } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const result = await homenichatCloudService.register(email, password, name);

        if (!result.success) {
            return res.status(400).json({
                error: 'Registration failed',
                details: result.error
            });
        }

        db.setSetupStatus('cloud_configured', 'true');
        db.setCurrentSetupStep(6);

        res.json({
            success: true,
            message: 'Homenichat Cloud account created and logged in',
            user: result.user,
            services: result.services,
            nextStep: 6
        });
    } catch (error) {
        logger.error('Cloud registration error:', error);
        res.status(500).json({ error: 'Failed to register with Homenichat Cloud' });
    }
});

/**
 * POST /api/setup/cloud-skip
 * Skip Homenichat Cloud setup
 */
router.post('/cloud-skip', (req, res) => {
    db.setSetupStatus('cloud_configured', 'skipped');
    db.setCurrentSetupStep(6);
    res.json({ success: true, message: 'Homenichat Cloud setup skipped', nextStep: 6 });
});

// =============================================================================
// STEP 6: COMPLETE SETUP
// =============================================================================

/**
 * GET /api/setup/summary
 * Get summary of all setup configurations
 */
router.get('/summary', async (req, res) => {
    try {
        const status = db.getAllSetupStatus();

        const summary = {
            adminPassword: {
                configured: db.isAdminPasswordChanged(),
                status: db.isAdminPasswordChanged() ? 'changed' : 'default'
            },
            system: {
                configured: status.system_configured === 'true',
                skipped: status.system_configured === 'skipped',
                hostname: systemService.getHostname(),
                timezone: systemService.getTimezone()
            },
            network: {
                configured: status.network_configured === 'true',
                skipped: status.network_configured === 'skipped',
                ip: networkService.getPrimaryIpAddress()
            },
            modem: {
                configured: status.modem_configured === 'true',
                skipped: status.modem_configured === 'skipped'
            },
            cloud: {
                configured: status.cloud_configured === 'true',
                skipped: status.cloud_configured === 'skipped',
                loggedIn: homenichatCloudService.isLoggedIn()
            }
        };

        // Add modem info if configured
        if (summary.modem.configured) {
            if (!modemService) {
                modemService = new ModemService({ modems: {}, logger: console });
            }
            const modemConfig = modemService.getAllModemsConfig();
            summary.modem.modems = Object.keys(modemConfig?.modems || {});
        }

        // Add cloud info if logged in
        if (summary.cloud.loggedIn) {
            const cloudStatus = homenichatCloudService.getStatus();
            summary.cloud.email = cloudStatus.email;
            summary.cloud.services = cloudStatus.services;
        }

        res.json(summary);
    } catch (error) {
        logger.error('Setup summary error:', error);
        res.status(500).json({ error: 'Failed to get setup summary' });
    }
});

/**
 * POST /api/setup/complete
 * Mark setup as complete
 * Also auto-creates VoIP extension for admin user for "out of the box" experience
 */
router.post('/complete', async (req, res) => {
    try {
        // Check that admin password was changed (required)
        if (!db.isAdminPasswordChanged()) {
            return res.status(400).json({
                error: 'Cannot complete setup',
                details: 'Admin password must be changed before completing setup'
            });
        }

        // Auto-create VoIP extension for admin user
        let voipExtension = null;
        try {
            const admin = db.getUserByUsername('admin');
            if (admin) {
                // Check if admin already has a VoIP extension
                const existingExt = db.getVoIPExtensionByUserId(admin.id);
                if (!existingExt) {
                    // Generate extension number and secret
                    const crypto = require('crypto');
                    const extension = db.getNextAvailableExtension(1000);
                    const secret = crypto.randomBytes(16).toString('hex');

                    // Create VoIP extension for admin
                    voipExtension = db.createVoIPExtension(admin.id, {
                        extension,
                        secret,
                        displayName: 'Admin',
                        context: 'from-internal',
                        transport: 'wss',
                        codecs: 'g722,ulaw,alaw,opus',
                        enabled: true,
                        webrtcEnabled: true
                    });

                    logger.info(`Auto-created VoIP extension ${extension} for admin user during setup`);
                } else {
                    voipExtension = existingExt;
                    logger.info(`Admin user already has VoIP extension ${existingExt.extension}`);
                }
            }
        } catch (voipError) {
            // Log but don't fail setup if VoIP extension creation fails
            logger.warn('Failed to auto-create VoIP extension for admin:', voipError.message);
        }

        db.markSetupComplete();

        logger.info('Initial setup completed successfully');

        res.json({
            success: true,
            message: 'Setup completed successfully! Redirecting to dashboard...',
            redirectTo: '/admin',
            voipExtension: voipExtension ? {
                extension: voipExtension.extension,
                created: true
            } : null
        });
    } catch (error) {
        logger.error('Setup completion error:', error);
        res.status(500).json({ error: 'Failed to complete setup' });
    }
});

// =============================================================================
// DEVELOPMENT/TESTING
// =============================================================================

/**
 * POST /api/setup/reset
 * Reset setup status (development only)
 */
router.post('/reset', (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({ error: 'Not allowed in production' });
    }

    db.resetSetupStatus();

    res.json({
        success: true,
        message: 'Setup status reset. Please refresh the page.'
    });
});

module.exports = router;
