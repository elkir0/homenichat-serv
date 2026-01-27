/**
 * VoLTE Initialization Service
 *
 * Handles automatic VoLTE initialization after server/Asterisk restart.
 *
 * IMPORTANT: VoLTE AT commands (AT+QAUDMOD=3, AT+QPCMV=1,2) do NOT persist
 * after modem reboot! This service ensures VoLTE mode is re-enabled for
 * modems configured with volteEnabled=true.
 */

const logger = require('../../../utils/logger');
const { getVoLTEStatus, enableVoLTE, initializeVoLTE } = require('./volte');
const { asteriskCommand, sleep } = require('./utils');

// Initialization state
let initializationStarted = false;
let initializationComplete = false;

/**
 * Wait for Asterisk and modems to be ready
 * @param {string[]} modemIds - Array of modem IDs to wait for
 * @param {number} maxWaitMs - Maximum wait time in milliseconds
 * @returns {Promise<Object>} - Object with ready modems
 */
async function waitForModemsReady(modemIds, maxWaitMs = 60000) {
    const startTime = Date.now();
    const readyModems = {};

    logger.info(`[VoLTE-Init] Waiting for ${modemIds.length} modem(s) to be ready...`);

    while (Date.now() - startTime < maxWaitMs) {
        try {
            const output = await asteriskCommand('quectel show devices');

            for (const modemId of modemIds) {
                if (!readyModems[modemId]) {
                    // Check if modem is in device list and is Free (not in call)
                    if (output.includes(modemId) && output.includes('Free')) {
                        readyModems[modemId] = true;
                        logger.info(`[VoLTE-Init] Modem ${modemId} is ready`);
                    }
                }
            }

            // Check if all modems are ready
            if (Object.keys(readyModems).length === modemIds.length) {
                logger.info('[VoLTE-Init] All modems are ready');
                return { success: true, readyModems };
            }
        } catch (error) {
            // Asterisk might not be ready yet
            logger.debug(`[VoLTE-Init] Waiting for Asterisk: ${error.message}`);
        }

        await sleep(2000);
    }

    const notReady = modemIds.filter(id => !readyModems[id]);
    logger.warn(`[VoLTE-Init] Timeout waiting for modems: ${notReady.join(', ')}`);

    return {
        success: Object.keys(readyModems).length > 0,
        readyModems,
        timedOut: notReady,
    };
}

/**
 * Initialize VoLTE for all configured modems
 * This should be called at server startup
 *
 * @param {Object} modemsConfig - Modems configuration object
 * @returns {Promise<Object>} - Initialization results
 */
async function initializeAllVoLTE(modemsConfig = {}) {
    if (initializationStarted) {
        logger.warn('[VoLTE-Init] Initialization already in progress or completed');
        return { success: false, error: 'Already initialized' };
    }

    initializationStarted = true;
    const results = {
        success: true,
        initialized: [],
        skipped: [],
        failed: [],
    };

    try {
        const modems = modemsConfig.modems || modemsConfig || {};
        const modemIds = Object.keys(modems);

        if (modemIds.length === 0) {
            logger.info('[VoLTE-Init] No modems configured');
            initializationComplete = true;
            return { success: true, message: 'No modems configured' };
        }

        // Find modems with VoLTE enabled
        const volteModems = modemIds.filter(id => modems[id]?.volteEnabled === true);

        if (volteModems.length === 0) {
            logger.info('[VoLTE-Init] No modems have VoLTE enabled');
            initializationComplete = true;
            results.skipped = modemIds;
            return results;
        }

        logger.info(`[VoLTE-Init] Found ${volteModems.length} modem(s) with VoLTE enabled: ${volteModems.join(', ')}`);

        // Wait for modems to be ready
        const readyResult = await waitForModemsReady(volteModems);

        if (!readyResult.success) {
            logger.error('[VoLTE-Init] No modems became ready');
            results.success = false;
            results.failed = volteModems;
            return results;
        }

        // Additional stabilization delay (modem needs time after becoming "Free")
        await sleep(5000);

        // Initialize VoLTE for each ready modem
        for (const modemId of volteModems) {
            if (!readyResult.readyModems[modemId]) {
                logger.warn(`[VoLTE-Init] Skipping ${modemId} - not ready`);
                results.failed.push(modemId);
                continue;
            }

            try {
                logger.info(`[VoLTE-Init] Initializing VoLTE for ${modemId}...`);

                // Check current VoLTE status
                const status = await getVoLTEStatus(modemId);

                if (status.volteEnabled) {
                    logger.info(`[VoLTE-Init] ${modemId} already in VoLTE mode`);
                    results.initialized.push({ modemId, alreadyEnabled: true, status });
                    continue;
                }

                // Re-enable VoLTE (send AT commands)
                const enableResult = await enableVoLTE(modemId);

                if (enableResult.success) {
                    logger.info(`[VoLTE-Init] ${modemId} VoLTE enabled successfully`);
                    results.initialized.push({ modemId, ...enableResult });
                } else {
                    logger.error(`[VoLTE-Init] ${modemId} VoLTE enable failed: ${enableResult.error}`);
                    results.failed.push({ modemId, error: enableResult.error });
                }

                // Small delay between modems
                await sleep(2000);

            } catch (error) {
                logger.error(`[VoLTE-Init] Error initializing ${modemId}:`, error.message);
                results.failed.push({ modemId, error: error.message });
            }
        }

        // Mark non-VoLTE modems as skipped
        const nonVolteModems = modemIds.filter(id => !modems[id]?.volteEnabled);
        results.skipped = nonVolteModems;

        results.success = results.failed.length === 0;
        initializationComplete = true;

        logger.info(`[VoLTE-Init] Initialization complete: ${results.initialized.length} initialized, ${results.skipped.length} skipped, ${results.failed.length} failed`);

    } catch (error) {
        logger.error('[VoLTE-Init] Initialization error:', error.message);
        results.success = false;
        results.error = error.message;
    }

    return results;
}

/**
 * Get initialization status
 */
function getInitializationStatus() {
    return {
        started: initializationStarted,
        complete: initializationComplete,
    };
}

/**
 * Reset initialization state (for testing or manual re-init)
 */
function resetInitialization() {
    initializationStarted = false;
    initializationComplete = false;
    logger.info('[VoLTE-Init] Initialization state reset');
}

/**
 * Schedule VoLTE initialization to run after a delay
 * Useful for startup to give Asterisk time to fully initialize
 *
 * @param {Object} modemsConfig - Modems configuration
 * @param {number} delayMs - Delay before starting initialization
 * @returns {Promise<Object>} - Initialization results
 */
async function scheduleVoLTEInit(modemsConfig, delayMs = 10000) {
    logger.info(`[VoLTE-Init] Scheduled initialization in ${delayMs / 1000} seconds`);

    await sleep(delayMs);
    return initializeAllVoLTE(modemsConfig);
}

/**
 * Start VoLTE initialization in background (non-blocking)
 * Returns immediately, initialization happens asynchronously
 *
 * @param {Object} modemsConfig - Modems configuration
 * @param {number} delayMs - Delay before starting
 */
function startVoLTEInitBackground(modemsConfig, delayMs = 10000) {
    logger.info('[VoLTE-Init] Starting background initialization');

    // Run in background, don't await
    scheduleVoLTEInit(modemsConfig, delayMs)
        .then(result => {
            if (result.success) {
                logger.info('[VoLTE-Init] Background initialization completed successfully');
            } else {
                logger.warn('[VoLTE-Init] Background initialization completed with errors');
            }
        })
        .catch(error => {
            logger.error('[VoLTE-Init] Background initialization failed:', error.message);
        });
}

module.exports = {
    initializeAllVoLTE,
    waitForModemsReady,
    getInitializationStatus,
    resetInitialization,
    scheduleVoLTEInit,
    startVoLTEInitBackground,
};
