/**
 * Modem Configuration Management
 * Handles loading, saving, and migrating modem configurations
 */

const fs = require('fs');
const path = require('path');
const logger = require('../../../utils/logger');
const { MODEM_CONFIG_FILE, CONFIG_DIR, MAX_MODEMS } = require('./constants');
const { detectModemType } = require('./detection');

/**
 * Create default configuration for a modem
 */
function createDefaultConfig(modemId, index = 0) {
    const detectedType = detectModemType();

    // Calculate port offsets based on modem index
    // SIM7600: 5 ports per modem (data=+2, audio=+4)
    // EC25: 4 ports per modem (data=+2, audio=+1)
    const basePort = index * 5;
    const dataPortNum = basePort + 2;
    const audioPortNum = detectedType === 'ec25' ? basePort + 1 : basePort + 4;

    return {
        modemType: detectedType || 'sim7600',
        modemName: modemId,
        phoneNumber: '',
        pinCode: '',
        dataPort: `/dev/ttyUSB${dataPortNum}`,
        audioPort: `/dev/ttyUSB${audioPortNum}`,
        autoDetect: true,
        sms: {
            enabled: true,
            storage: 'sqlite',
            autoDelete: true,
            deliveryReports: false,
            serviceCenter: '',
            encoding: 'auto',
        },
    };
}

/**
 * Load multi-modem configuration from file
 * Automatically migrates old single-modem format
 */
function loadConfig() {
    try {
        if (!fs.existsSync(MODEM_CONFIG_FILE)) {
            logger.info('[ModemConfig] No config file found, using defaults');
            return { version: 2, modems: {}, global: { maxModems: MAX_MODEMS } };
        }

        const data = fs.readFileSync(MODEM_CONFIG_FILE, 'utf8');
        const config = JSON.parse(data);

        // Check if it's the new multi-modem format
        if (config.modems && typeof config.modems === 'object') {
            logger.info(`[ModemConfig] Loaded config with ${Object.keys(config.modems).length} modem(s)`);
            return config;
        }

        // Migrate old single-modem format
        logger.info('[ModemConfig] Migrating single-modem config to multi-modem format');
        const migratedConfig = {
            version: 2,
            modems: {
                'modem-1': {
                    ...config,
                    modemName: config.modemName || 'modem-1',
                },
            },
            global: { maxModems: MAX_MODEMS },
        };

        // Save migrated config
        saveConfig(migratedConfig);
        return migratedConfig;
    } catch (error) {
        logger.error('[ModemConfig] Error loading config:', error.message);
        return { version: 2, modems: {}, global: { maxModems: MAX_MODEMS } };
    }
}

/**
 * Save multi-modem configuration to file
 */
function saveConfig(config) {
    try {
        // Ensure directory exists
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }

        fs.writeFileSync(MODEM_CONFIG_FILE, JSON.stringify(config, null, 2));
        logger.info('[ModemConfig] Configuration saved');
        return true;
    } catch (error) {
        logger.error('[ModemConfig] Error saving config:', error.message);
        return false;
    }
}

/**
 * Get configuration for a specific modem
 */
function getModemConfig(modemsConfig, modemId = 'modem-1') {
    if (!modemsConfig?.modems) return createDefaultConfig(modemId, 0);

    const config = modemsConfig.modems[modemId];
    if (config) return config;

    // Return default if not found
    const index = parseInt(modemId.replace('modem-', ''), 10) - 1 || 0;
    return createDefaultConfig(modemId, index);
}

/**
 * Save configuration for a specific modem
 */
function saveModemConfig(modemsConfig, modemId, config) {
    if (!modemsConfig.modems) {
        modemsConfig.modems = {};
    }

    modemsConfig.modems[modemId] = {
        ...config,
        modemName: config.modemName || modemId,
    };

    return saveConfig(modemsConfig);
}

/**
 * Delete a modem configuration
 */
function deleteModemConfig(modemsConfig, modemId) {
    if (!modemsConfig?.modems?.[modemId]) {
        return false;
    }

    delete modemsConfig.modems[modemId];
    saveConfig(modemsConfig);
    logger.info(`[ModemConfig] Deleted modem config: ${modemId}`);
    return true;
}

/**
 * Get all modems configuration
 */
function getAllModemsConfig(modemsConfig) {
    return modemsConfig?.modems || {};
}

module.exports = {
    createDefaultConfig,
    loadConfig,
    saveConfig,
    getModemConfig,
    saveModemConfig,
    deleteModemConfig,
    getAllModemsConfig,
};
