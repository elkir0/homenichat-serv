/**
 * Modem Utilities
 * Common functions used across modem modules
 */

const { exec, execSync } = require('child_process');
const logger = require('../../../utils/logger');

/**
 * Run a shell command with timeout
 * @param {string} cmd - Command to run
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<string>} Command output
 */
function runCommand(cmd, timeout = 10000) {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout }, (error, stdout, stderr) => {
            if (error) {
                if (error.killed) {
                    resolve(`Error: Command timed out after ${timeout}ms`);
                } else {
                    resolve(`Error: ${error.message}`);
                }
                return;
            }
            resolve(stdout.trim());
        });
    });
}

/**
 * Run a shell command synchronously
 * @param {string} cmd - Command to run
 * @param {number} timeout - Timeout in milliseconds
 * @returns {string} Command output
 */
function runCommandSync(cmd, timeout = 10000) {
    try {
        return execSync(cmd, { encoding: 'utf8', timeout }).trim();
    } catch (error) {
        logger.warn(`[ModemUtils] Command failed: ${cmd}`, error.message);
        return '';
    }
}

/**
 * Execute an Asterisk CLI command
 * @param {string} command - Asterisk command
 * @returns {Promise<string>} Command output
 */
async function asteriskCommand(command) {
    return runCommand(`asterisk -rx "${command}" 2>&1`);
}

/**
 * Send AT command via Asterisk chan_quectel
 * @param {string} modemId - Modem ID in Asterisk
 * @param {string} command - AT command
 * @returns {Promise<string>} Command response
 */
async function sendAtCommand(modemId, command) {
    // Escape quotes in AT command
    const escapedCmd = command.replace(/"/g, '\\"');
    return asteriskCommand(`quectel cmd ${modemId} ${escapedCmd}`);
}

/**
 * Parse AT command response
 * @param {string} response - Raw AT response
 * @returns {Object} Parsed response with status and data
 */
function parseAtResponse(response) {
    const result = {
        ok: false,
        error: null,
        data: response,
    };

    if (response.includes('OK')) {
        result.ok = true;
    } else if (response.includes('ERROR')) {
        result.ok = false;
        result.error = response;
    }

    return result;
}

/**
 * Wait for a specified duration
 * @param {number} ms - Milliseconds to wait
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    runCommand,
    runCommandSync,
    asteriskCommand,
    sendAtCommand,
    parseAtResponse,
    sleep,
};
