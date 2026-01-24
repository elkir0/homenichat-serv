/**
 * Audio Configuration Module
 * Handles modem audio settings for voice calls
 */

const logger = require('../../../utils/logger');
const { asteriskCommand, sendAtCommand, sleep } = require('./utils');
const { MODEM_PROFILES } = require('./constants');

/**
 * Configure audio for a specific modem type
 * @param {string} modemId - Modem ID
 * @param {string} modemType - Modem type (sim7600, ec25)
 * @returns {Promise<Object>} Results of AT commands
 */
async function configureAudioForType(modemId, modemType = 'sim7600') {
    const profile = MODEM_PROFILES[modemType] || MODEM_PROFILES.sim7600;
    const results = [];

    logger.info(`[Audio] Configuring audio for ${modemId} (type: ${modemType})`);

    for (const cmd of profile.audioCommands) {
        try {
            const result = await sendAtCommand(modemId, cmd);
            results.push({ command: cmd, result, success: !result.includes('ERROR') });
            await sleep(200);
        } catch (error) {
            results.push({ command: cmd, error: error.message, success: false });
        }
    }

    logger.info(`[Audio] Configuration complete for ${modemId}: ${results.filter(r => r.success).length}/${results.length} commands succeeded`);
    return { modemId, modemType, results };
}

/**
 * Configure basic audio settings
 * @param {string} modemId - Modem ID
 * @returns {Promise<Object>} Results
 */
async function configureAudio(modemId) {
    const commands = [
        'AT+CPCMFRM=1',     // 16kHz PCM format
        'AT+CMICGAIN=0',    // Mic gain
        'AT+COUTGAIN=5',    // Output gain
        'AT+CTXVOL=0x2000', // TX volume
    ];

    const results = [];

    for (const cmd of commands) {
        try {
            const result = await sendAtCommand(modemId, cmd);
            results.push({ command: cmd, result });
        } catch (error) {
            results.push({ command: cmd, error: error.message });
        }
    }

    return { modemId, results };
}

/**
 * Set RX gain (speaker volume)
 * @param {string} modemId - Modem ID
 * @param {number} gain - Gain value (-10 to 10)
 * @returns {Promise<string>} Result
 */
async function setRxGain(modemId, gain) {
    return asteriskCommand(`quectel rxgain ${modemId} ${gain}`);
}

/**
 * Set TX gain (microphone volume)
 * @param {string} modemId - Modem ID
 * @param {number} gain - Gain value (-10 to 10)
 * @returns {Promise<string>} Result
 */
async function setTxGain(modemId, gain) {
    return asteriskCommand(`quectel txgain ${modemId} ${gain}`);
}

/**
 * Get current audio settings
 * @param {string} modemId - Modem ID
 * @returns {Promise<Object>} Audio settings
 */
async function getAudioSettings(modemId) {
    const settings = {
        rxgain: null,
        txgain: null,
    };

    try {
        const state = await asteriskCommand(`quectel show device state ${modemId}`);

        // Parse rxgain and txgain from output
        const rxMatch = state.match(/RX\s*Gain[:\s]+(-?\d+)/i);
        const txMatch = state.match(/TX\s*Gain[:\s]+(-?\d+)/i);

        if (rxMatch) settings.rxgain = parseInt(rxMatch[1]);
        if (txMatch) settings.txgain = parseInt(txMatch[1]);
    } catch (error) {
        logger.warn(`[Audio] Failed to get audio settings for ${modemId}:`, error.message);
    }

    return settings;
}

module.exports = {
    configureAudio,
    configureAudioForType,
    setRxGain,
    setTxGain,
    getAudioSettings,
};
