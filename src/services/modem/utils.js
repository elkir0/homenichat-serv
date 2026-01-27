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

/**
 * Send AT command directly to modem via serial port and get response
 * Uses socat for direct serial communication (bypasses Asterisk queueing)
 * @param {string} port - Serial port (e.g., '/dev/ttyUSB2')
 * @param {string} command - AT command
 * @param {number} timeout - Timeout in seconds (default 3)
 * @returns {Promise<string>} AT response
 */
async function sendAtDirect(port, command, timeout = 3) {
    try {
        // Use socat to send command and read response
        // The crnl option ensures proper line endings for AT commands
        const cmd = `echo '${command}' | timeout ${timeout} socat - ${port},crnl 2>/dev/null`;
        const result = await runCommand(cmd, (timeout + 1) * 1000);
        return result;
    } catch (error) {
        logger.warn(`[ModemUtils] Direct AT command failed: ${command}`, error.message);
        return '';
    }
}

/**
 * Get modem data port from modem config or Asterisk
 * @param {string} modemId - Modem ID
 * @returns {Promise<string|null>} Data port path or null
 */
async function getModemDataPort(modemId) {
    try {
        // Try to get from Asterisk device info
        const deviceInfo = await asteriskCommand(`quectel show device state ${modemId}`);
        const dataMatch = deviceInfo.match(/Data\s*:\s*(\S+)/i);
        if (dataMatch) {
            return dataMatch[1];
        }

        // Fallback: try common ports
        const fs = require('fs');
        const commonPorts = ['/dev/ttyUSB2', '/dev/ttyUSB3', '/dev/ttyUSB0'];
        for (const port of commonPorts) {
            if (fs.existsSync(port)) {
                return port;
            }
        }

        return null;
    } catch (error) {
        logger.warn(`[ModemUtils] Failed to get data port for ${modemId}:`, error.message);
        return null;
    }
}

module.exports = {
    runCommand,
    runCommandSync,
    asteriskCommand,
    sendAtCommand,
    parseAtResponse,
    sleep,
    sendAtDirect,
    getModemDataPort,
};
