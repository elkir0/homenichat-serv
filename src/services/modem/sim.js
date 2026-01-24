/**
 * SIM Card Module
 * Handles PIN entry, IMSI detection, and SIM card management
 */

const fs = require('fs');
const { exec } = require('child_process');
const logger = require('../../../utils/logger');
const { runCommand, asteriskCommand, sleep } = require('./utils');
const { MAX_PIN_ATTEMPTS } = require('./constants');

// PIN attempt tracking (in-memory, per-modem)
const pinAttempts = {};
const pinLocked = {};

/**
 * Send AT command directly to serial port
 * @param {string} port - Serial port path
 * @param {string} command - AT command
 * @param {number} timeoutMs - Timeout in ms
 * @returns {Promise<string>} Response
 */
function sendDirectAtCommand(port, command, timeoutMs = 5000) {
    return new Promise((resolve) => {
        const script = `
            (
                echo -e '${command}\\r'
                sleep 1
            ) | timeout ${Math.floor(timeoutMs / 1000)} socat -t2 - ${port},raw,echo=0,b115200,crnl 2>/dev/null
        `;

        exec(script.trim(), { timeout: timeoutMs + 2000 }, (error, stdout) => {
            const cleaned = (stdout || '').replace(/[\x00-\x09\x0B\x0C\x0E-\x1F]/g, '').trim();

            if (cleaned) {
                resolve(cleaned);
            } else if (error) {
                resolve(`Error: ${error.message}`);
            } else {
                resolve('');
            }
        });
    });
}

/**
 * Parse SIM PIN status response
 * @param {string} result - AT+CPIN? response
 * @returns {Object} Status object
 */
function parseSimPinStatus(result) {
    if (result.includes('READY')) {
        return { status: 'ready', message: 'SIM unlocked', needsPin: false };
    }
    if (result.includes('SIM PIN')) {
        return { status: 'pin_required', message: 'PIN required', needsPin: true };
    }
    if (result.includes('SIM PUK')) {
        return { status: 'puk_required', message: 'PUK required (SIM blocked)', needsPin: false };
    }
    if (result.includes('ERROR') || result.includes('NO SIM')) {
        return { status: 'no_sim', message: 'No SIM card detected', needsPin: false };
    }
    return { status: 'unknown', message: result, needsPin: false };
}

/**
 * Check SIM PIN status
 * @param {string} modemId - Modem ID
 * @param {string} dataPort - Serial port path
 * @returns {Promise<Object>} PIN status
 */
async function checkSimPin(modemId, dataPort) {
    try {
        // Try via Asterisk first
        if (modemId) {
            const result = await asteriskCommand(`quectel cmd ${modemId} AT+CPIN?`);
            if (result && !result.includes('Error') && !result.includes('not found') &&
                (result.includes('READY') || result.includes('PIN') || result.includes('PUK'))) {
                logger.info(`[SIM] PIN check via Asterisk for ${modemId}: ${result}`);
                return parseSimPinStatus(result);
            }
        }

        // Fallback to direct port access
        if (!dataPort || !fs.existsSync(dataPort)) {
            return { status: 'no_modem', message: 'No modem detected', needsPin: false };
        }

        const result = await sendDirectAtCommand(dataPort, 'AT+CPIN?', 5000);

        // Port busy by Asterisk = modem initialized = PIN OK
        if (result.includes('Error: Command failed')) {
            return { status: 'ready', message: 'Modem initialized (PIN already entered)', needsPin: false };
        }

        logger.info(`[SIM] Direct PIN check: ${result}`);
        return parseSimPinStatus(result);
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}

/**
 * Get remaining PIN attempts
 * @param {string} modemId - Modem ID
 * @returns {Object} Attempts info
 */
function getPinAttemptsRemaining(modemId = 'modem-1') {
    const attempts = pinAttempts[modemId] || 0;
    const locked = pinLocked[modemId] || false;
    return {
        modemId,
        attemptsUsed: attempts,
        attemptsRemaining: MAX_PIN_ATTEMPTS - attempts,
        isLocked: locked,
        maxAttempts: MAX_PIN_ATTEMPTS,
    };
}

/**
 * Reset PIN attempts counter
 * @param {string} modemId - Modem ID (null for all)
 * @returns {Object} Result
 */
function resetPinAttempts(modemId = null) {
    if (modemId) {
        pinAttempts[modemId] = 0;
        pinLocked[modemId] = false;
        logger.info(`[SIM] PIN attempts reset for ${modemId}`);
    } else {
        Object.keys(pinAttempts).forEach(id => {
            pinAttempts[id] = 0;
            pinLocked[id] = false;
        });
        logger.info('[SIM] PIN attempts reset for all modems');
    }
    return { success: true, message: 'PIN attempts counter reset' };
}

/**
 * Enter SIM PIN code
 * @param {string} pin - PIN code
 * @param {string} modemId - Modem ID
 * @param {string} dataPort - Serial port path
 * @param {Function} onSuccess - Callback on success (for reloading Asterisk)
 * @returns {Promise<Object>} Result
 */
async function enterSimPin(pin, modemId = 'modem-1', dataPort = '/dev/ttyUSB2', onSuccess = null) {
    // Check if locked
    if (pinLocked[modemId]) {
        throw new Error('Too many failed attempts. Reset the counter or use PUK code.');
    }

    if (!pin || !/^\d{4,8}$/.test(pin)) {
        throw new Error('Invalid PIN (must be 4-8 digits)');
    }

    if (!fs.existsSync(dataPort)) {
        throw new Error(`Modem port not found: ${dataPort}`);
    }

    logger.info(`[SIM] Entering PIN for ${modemId} via ${dataPort}`);

    // Check current state
    const preCheck = await sendDirectAtCommand(dataPort, 'AT+CPIN?', 5000);
    logger.info(`[SIM] Pre-PIN check for ${modemId}: ${preCheck}`);

    // Already unlocked
    if (preCheck.includes('READY')) {
        logger.info(`[SIM] SIM already unlocked for ${modemId}`);
        pinAttempts[modemId] = 0;
        return { success: true, message: 'SIM card is already unlocked.', pinSaved: true };
    }

    // Check if PIN is actually needed
    if (!preCheck.includes('SIM PIN') && preCheck.includes('ERROR')) {
        throw new Error(`Modem error: ${preCheck}`);
    }

    // Send PIN command
    const result = await sendDirectAtCommand(dataPort, `AT+CPIN="${pin}"`, 7000);
    logger.info(`[SIM] PIN command result for ${modemId}: ${result}`);

    // Wait for modem to process
    await sleep(2000);

    // Check new state
    const postCheck = await sendDirectAtCommand(dataPort, 'AT+CPIN?', 5000);
    logger.info(`[SIM] Post-PIN check for ${modemId}: ${postCheck}`);

    // Analyze results
    const isSuccess = postCheck.includes('READY') ||
                      (result.includes('OK') && !result.includes('ERROR'));
    const isError = result.includes('CME ERROR') ||
                    result.includes('incorrect') ||
                    (postCheck.includes('SIM PIN') && !postCheck.includes('READY'));

    if (isSuccess) {
        pinAttempts[modemId] = 0;
        logger.info(`[SIM] PIN accepted for ${modemId}`);

        // Trigger callback (reload Asterisk)
        if (onSuccess) {
            setTimeout(onSuccess, 2000);
        }

        return { success: true, message: 'PIN accepted! SIM unlocked. Modem restarting...', pinSaved: true };
    }

    if (isError) {
        pinAttempts[modemId] = (pinAttempts[modemId] || 0) + 1;

        if (pinAttempts[modemId] >= MAX_PIN_ATTEMPTS) {
            pinLocked[modemId] = true;
            logger.error(`[SIM] PIN attempts exhausted for ${modemId}`);
            throw new Error(`Incorrect PIN. WARNING: Limit of ${MAX_PIN_ATTEMPTS} attempts reached. Further attempts blocked. Contact administrator.`);
        }

        const remaining = MAX_PIN_ATTEMPTS - pinAttempts[modemId];
        throw new Error(`Incorrect PIN. ${remaining} attempt(s) remaining.`);
    }

    // Ambiguous result
    if (postCheck.includes('READY')) {
        pinAttempts[modemId] = 0;
        return { success: true, message: 'PIN accepted! SIM unlocked.', pinSaved: true };
    }

    return {
        success: false,
        message: 'Uncertain result. Check modem status.',
        details: { result, postCheck },
    };
}

/**
 * Get IMSI from modem
 * @param {string} modemId - Modem ID (for Asterisk)
 * @param {string} dataPort - Fallback serial port
 * @returns {Promise<string|null>} IMSI or null
 */
async function getModemImsi(modemId, dataPort = '/dev/ttyUSB2') {
    try {
        // Try via Asterisk first
        if (modemId) {
            const result = await asteriskCommand(`quectel cmd ${modemId} AT+CIMI`);
            const match = result.match(/\d{15}/);
            if (match) {
                logger.info(`[SIM] IMSI via Asterisk for ${modemId}: ${match[0]}`);
                return match[0];
            }
        }

        // Fallback to direct access
        if (fs.existsSync(dataPort)) {
            const result = await sendDirectAtCommand(dataPort, 'AT+CIMI', 5000);
            const match = result.match(/\d{15}/);
            if (match) {
                logger.info(`[SIM] IMSI via direct for ${dataPort}: ${match[0]}`);
                return match[0];
            }
        }

        return null;
    } catch (error) {
        logger.warn(`[SIM] Failed to get IMSI: ${error.message}`);
        return null;
    }
}

module.exports = {
    checkSimPin,
    parseSimPinStatus,
    getPinAttemptsRemaining,
    resetPinAttempts,
    enterSimPin,
    getModemImsi,
    sendDirectAtCommand,
};
