/**
 * VoLTE Module
 * Handles VoLTE activation/deactivation for EC25 modems
 *
 * Key findings from testing (24/01/2026):
 * - VoLTE requires AT+QAUDMOD=3 (USB Audio mode) + AT+QPCMV=1,2 (Voice over UAC)
 * - These commands do NOT persist after modem reboot!
 * - Must use IchthysMaranatha fork of chan_quectel with quec_uac=1
 * - VoLTE proven working: voice + 4G data simultaneous (0% ping loss during call)
 */

const logger = require('../../../utils/logger');
const { MODEM_PROFILES, VOLTE_CONFIG, VOICE_MODES } = require('./constants');
const { asteriskCommand, sendAtCommand, sleep, sendAtDirect, getModemDataPort } = require('./utils');

// Cache for VoLTE status to avoid repeated unreliable serial reads
// Key: modemId, Value: { status, timestamp }
const volteStatusCache = new Map();
const CACHE_TTL_MS = 30000; // 30 seconds

/**
 * Get VoLTE status for a modem
 * Uses caching to avoid unreliable repeated serial reads
 * @param {string} modemId - Modem ID (e.g., 'modem-1')
 * @param {boolean} forceRefresh - Force refresh ignoring cache
 * @returns {Promise<Object>} VoLTE status
 */
async function getVoLTEStatus(modemId, forceRefresh = false) {
    // Check cache first (unless forced refresh)
    if (!forceRefresh) {
        const cached = volteStatusCache.get(modemId);
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
            logger.debug(`[VoLTE] Returning cached status for ${modemId} (age: ${Date.now() - cached.timestamp}ms)`);
            return { ...cached.status, cached: true };
        }
    }
    const status = {
        modemId,
        volteSupported: false,
        volteEnabled: false,
        imsRegistered: false,
        networkMode: null,
        audioMode: null,
        details: {},
    };

    try {
        // Get modem data port for direct AT commands
        const dataPort = await getModemDataPort(modemId);

        // Check if modem supports VoLTE (EC25) and get Voice capability from Asterisk
        const deviceInfo = await asteriskCommand(`quectel show device state ${modemId}`);
        if (deviceInfo.includes('EC25') || deviceInfo.includes('Quectel')) {
            status.volteSupported = true;
        }

        // Check Voice capability from Asterisk (most reliable indicator)
        const voiceMatch = deviceInfo.match(/Voice\s*:\s*(Yes|No)/i);
        if (voiceMatch) {
            status.details.voiceCapability = voiceMatch[1].toLowerCase() === 'yes';
        }

        if (dataPort) {
            // Use direct serial for accurate AT responses

            // Check IMS status: AT+QCFG="ims" -> should return 1,1 for active VoLTE
            const imsResult = await sendAtDirect(dataPort, 'AT+QCFG="ims"');
            const imsMatch = imsResult.match(/\+QCFG:\s*"ims",(\d),(\d)/);
            if (imsMatch) {
                status.details.imsEnabled = imsMatch[1] === '1';
                status.details.imsRegistered = imsMatch[2] === '1';
                status.imsRegistered = imsMatch[1] === '1' && imsMatch[2] === '1';
            }

            // Check network mode: AT+COPS? -> should contain ",7" for LTE
            const copsResult = await sendAtDirect(dataPort, 'AT+COPS?');
            const copsMatch = copsResult.match(/\+COPS:\s*\d,\d,"[^"]*",(\d+)/);
            if (copsMatch) {
                const rat = parseInt(copsMatch[1]);
                status.networkMode = rat === 7 ? 'LTE' : rat === 2 ? '3G' : rat === 0 ? '2G' : `Unknown(${rat})`;
                status.details.networkRat = rat;
            }

            // Check audio mode: AT+QAUDMOD? -> 0=handset, 3=USB Audio (UAC)
            const audmodResult = await sendAtDirect(dataPort, 'AT+QAUDMOD?');
            const audmodMatch = audmodResult.match(/\+QAUDMOD:\s*(\d)/);
            if (audmodMatch) {
                const mode = parseInt(audmodMatch[1]);
                status.audioMode = mode === 3 ? 'UAC' : mode === 0 ? 'Handset' : `Mode${mode}`;
                status.details.audioModeId = mode;
            }

            // Check PCM mode: AT+QPCMV? -> 1,0=TTY, 1,2=UAC
            const pcmvResult = await sendAtDirect(dataPort, 'AT+QPCMV?');
            const pcmvMatch = pcmvResult.match(/\+QPCMV:\s*(\d),(\d)/);
            if (pcmvMatch) {
                status.details.pcmEnabled = pcmvMatch[1] === '1';
                status.details.pcmMode = parseInt(pcmvMatch[2]);
            }
        }

        // Determine VoLTE MODE (configured) vs ACTIVE (currently connected)
        // volteEnabled = VoLTE MODE is CONFIGURED (regardless of network state)
        // volteActive = VoLTE is currently ACTIVE (requires network + IMS registered)

        // VoLTE is CONFIGURED if:
        // - IMS is enabled (AT+QCFG="ims" = 1,x) AND
        // - Audio mode is UAC (AT+QAUDMOD = 3)
        // This works even without network!
        if (status.details.imsEnabled === true) {
            status.volteEnabled = true; // VoLTE MODE is configured
        } else if (status.audioMode === 'UAC') {
            // Fallback: UAC audio mode strongly indicates VoLTE config
            status.volteEnabled = true;
        }

        // VoLTE is ACTIVE if configured AND actually working
        status.details.volteActive = false;
        if (status.volteEnabled && status.details.voiceCapability === true && status.networkMode === 'LTE') {
            status.details.volteActive = true;
            status.details.voiceMode = 'VoLTE';
        } else if (status.volteEnabled && status.imsRegistered) {
            status.details.volteActive = true;
            status.details.voiceMode = 'VoLTE';
        } else if (status.details.voiceCapability === true) {
            // Voice works but via circuit-switched (3G/2G)
            status.details.voiceMode = 'CS';
        } else {
            status.details.voiceMode = null; // No voice capability currently
        }

        logger.info(`[VoLTE] Status for ${modemId}: Configured=${status.volteEnabled}, Active=${status.details.volteActive}, Voice=${status.details.voiceCapability}, IMS=${status.details.imsEnabled}, Network=${status.networkMode}`);

    } catch (error) {
        logger.error(`[VoLTE] Error getting status for ${modemId}:`, error.message);
        status.error = error.message;
    }

    // Cache successful results (only if we got meaningful data)
    if (status.details.imsEnabled !== undefined || status.audioMode) {
        volteStatusCache.set(modemId, {
            status,
            timestamp: Date.now(),
        });
    }

    return status;
}

/**
 * Enable VoLTE mode on a modem
 * @param {string} modemId - Modem ID
 * @returns {Promise<Object>} Result with success status
 */
async function enableVoLTE(modemId) {
    logger.info(`[VoLTE] Enabling VoLTE for ${modemId}...`);

    const result = {
        success: false,
        modemId,
        commands: [],
        error: null,
    };

    try {
        // Send activation commands in order
        for (const cmd of VOLTE_CONFIG.activationCommands) {
            logger.info(`[VoLTE] Sending: ${cmd}`);
            const response = await asteriskCommand(`quectel cmd ${modemId} ${cmd}`);
            result.commands.push({ cmd, response: response.trim() });

            // Small delay between commands
            await sleep(500);
        }

        // Wait for IMS to register
        logger.info('[VoLTE] Waiting for IMS registration...');
        await sleep(3000);

        // Verify activation
        const status = await getVoLTEStatus(modemId);
        result.status = status;

        if (status.audioMode === 'UAC' && status.details.pcmMode === 2) {
            result.success = true;
            result.message = 'VoLTE mode enabled successfully';

            // IMS might take longer to register
            if (!status.imsRegistered) {
                result.warning = 'Audio mode activated, but IMS not yet registered. This may take a few minutes.';
            }
        } else {
            result.success = false;
            result.error = `VoLTE activation incomplete: AudioMode=${status.audioMode}, PCM=${status.details.pcmMode}`;
        }

    } catch (error) {
        logger.error(`[VoLTE] Error enabling VoLTE for ${modemId}:`, error.message);
        result.error = error.message;
    }

    return result;
}

/**
 * Disable VoLTE mode and return to 3G mode
 * @param {string} modemId - Modem ID
 * @returns {Promise<Object>} Result with success status
 */
async function disableVoLTE(modemId) {
    logger.info(`[VoLTE] Disabling VoLTE for ${modemId}, switching to 3G mode...`);

    const result = {
        success: false,
        modemId,
        commands: [],
        error: null,
    };

    try {
        // Send deactivation commands
        for (const cmd of VOLTE_CONFIG.deactivationCommands) {
            logger.info(`[VoLTE] Sending: ${cmd}`);
            const response = await asteriskCommand(`quectel cmd ${modemId} ${cmd}`);
            result.commands.push({ cmd, response: response.trim() });
            await sleep(500);
        }

        // Verify deactivation
        await sleep(2000);
        const status = await getVoLTEStatus(modemId);
        result.status = status;

        if (status.audioMode !== 'UAC') {
            result.success = true;
            result.message = '3G mode enabled, VoLTE disabled';
        } else {
            result.success = false;
            result.error = 'Failed to disable VoLTE mode';
        }

    } catch (error) {
        logger.error(`[VoLTE] Error disabling VoLTE for ${modemId}:`, error.message);
        result.error = error.message;
    }

    return result;
}

/**
 * Toggle VoLTE mode for a modem
 * @param {string} modemId - Modem ID
 * @param {boolean} enable - true to enable VoLTE, false to disable
 * @returns {Promise<Object>} Result
 */
async function toggleVoLTE(modemId, enable) {
    // Invalidate cache since we're changing the config
    volteStatusCache.delete(modemId);

    if (enable) {
        return enableVoLTE(modemId);
    } else {
        return disableVoLTE(modemId);
    }
}

/**
 * Initialize VoLTE for a modem after Asterisk restart
 * This should be called after modem is detected and ready
 * @param {string} modemId - Modem ID
 * @param {boolean} volteEnabled - Whether VoLTE should be enabled
 * @returns {Promise<Object>} Result
 */
async function initializeVoLTE(modemId, volteEnabled = false) {
    logger.info(`[VoLTE] Initializing modem ${modemId} with VoLTE=${volteEnabled}`);

    // Wait for modem to be ready
    let ready = false;
    let attempts = 0;
    const maxAttempts = 30; // 60 seconds max

    while (!ready && attempts < maxAttempts) {
        const devices = await asteriskCommand('quectel show devices');
        if (devices.includes(modemId) && devices.includes('Free')) {
            ready = true;
            logger.info(`[VoLTE] Modem ${modemId} is ready`);
        } else {
            await sleep(2000);
            attempts++;
        }
    }

    if (!ready) {
        return { success: false, error: 'Modem not ready after timeout' };
    }

    // Additional stabilization delay
    await sleep(3000);

    if (volteEnabled) {
        return enableVoLTE(modemId);
    } else {
        // Just verify current status
        const status = await getVoLTEStatus(modemId);
        return { success: true, status, mode: '3G' };
    }
}

/**
 * Check if ALSA device for UAC is available
 * @returns {Promise<boolean>} True if UAC device is available
 */
async function isUACDeviceAvailable() {
    try {
        const { runCommand } = require('./utils');
        const result = await runCommand('aplay -l 2>/dev/null | grep -i android');
        return result.includes('Android');
    } catch {
        return false;
    }
}

/**
 * Get recommended VoLTE configuration for quectel.conf
 * @param {Object} modemConfig - Modem configuration
 * @returns {Object} Quectel.conf parameters for VoLTE
 */
function getVoLTEQuectelConfig(modemConfig) {
    const type = (modemConfig.modemType || 'ec25').toLowerCase();
    const profile = MODEM_PROFILES[type];

    if (!profile || !profile.supportsVoLTE) {
        return null;
    }

    // VoLTE uses UAC (USB Audio Class) instead of TTY
    return {
        quec_uac: 1,
        alsadev: VOLTE_CONFIG.alsaDevice,
        rxgain: VOLTE_CONFIG.rxgain,
        txgain: VOLTE_CONFIG.txgain,
        // In VoLTE mode, we don't use the audio TTY port
        useAudioPort: false,
    };
}

module.exports = {
    getVoLTEStatus,
    enableVoLTE,
    disableVoLTE,
    toggleVoLTE,
    initializeVoLTE,
    isUACDeviceAvailable,
    getVoLTEQuectelConfig,
    VOLTE_CONFIG,
};
