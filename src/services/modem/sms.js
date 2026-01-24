/**
 * SMS Module
 * Handles sending SMS via Asterisk chan_quectel or direct AT commands
 */

const logger = require('../../../utils/logger');
const { runCommand, asteriskCommand } = require('./utils');

/**
 * Send SMS via Asterisk chan_quectel
 * @param {string} modemId - Modem ID
 * @param {string} to - Destination phone number
 * @param {string} message - Message content
 * @returns {Promise<Object>} Result object
 */
async function sendSmsViaAsterisk(modemId, to, message) {
    const safeMessage = message.replace(/"/g, '\\"').replace(/'/g, "\\'");
    const result = await asteriskCommand(`quectel sms ${modemId} ${to} "${safeMessage}"`);

    if (result && result.includes('queued')) {
        logger.info(`[SMS] Queued via Asterisk ${modemId} to ${to}`);
        return { success: true, modem: modemId, to, method: 'asterisk', result };
    }

    if (result && (result.includes('not found') || result.includes('error'))) {
        throw new Error(result);
    }

    logger.info(`[SMS] Sent via Asterisk ${modemId} to ${to}`);
    return { success: true, modem: modemId, to, method: 'asterisk', result };
}

/**
 * Send SMS via direct AT commands (fallback)
 * @param {string} dataPort - Serial port path
 * @param {string} to - Destination phone number
 * @param {string} message - Message content
 * @returns {Promise<Object>} Result object
 */
async function sendSmsViaDirect(dataPort, to, message) {
    const pythonScript = `
import serial
import time
import sys

port = "${dataPort}"
phone = "${to}"
message = """${message.replace(/"/g, '\\"')}"""

try:
    ser = serial.Serial(port, 115200, timeout=5)
    time.sleep(0.3)
    ser.flushInput()
    ser.write(b"AT+CMGF=1\\r\\n")
    time.sleep(0.5)
    r = ser.read(100).decode(errors="ignore")
    if "OK" not in r:
        print("ERROR: CMGF failed")
        sys.exit(1)
    cmd = 'AT+CMGS="' + phone + '"\\r\\n'
    ser.write(cmd.encode())
    time.sleep(2)
    ser.write((message + chr(26)).encode())
    time.sleep(15)
    r = ser.read(500).decode(errors="ignore")
    ser.close()
    if "+CMGS" in r or "OK" in r:
        print("OK")
        sys.exit(0)
    else:
        print("ERROR: " + r.replace("\\n", " "))
        sys.exit(1)
except Exception as e:
    print("ERROR: " + str(e))
    sys.exit(1)
`;
    const result = await runCommand(`python3 -c '${pythonScript.replace(/'/g, "'\"'\"'")}'`, 30000);

    if (result && result.includes('OK')) {
        logger.info(`[SMS] Sent directly via ${dataPort} to ${to}`);
        return { success: true, to, method: 'direct-at', dataPort };
    }

    throw new Error(result || 'Unknown error');
}

/**
 * Send SMS with automatic fallback
 * @param {string} modemId - Modem ID
 * @param {string} to - Destination phone number
 * @param {string} message - Message content
 * @param {string} dataPort - Fallback serial port (optional)
 * @returns {Promise<Object>} Result object
 */
async function sendSms(modemId, to, message, dataPort = '/dev/ttyUSB2') {
    if (!to || !message) {
        throw new Error('Missing "to" or "message"');
    }

    // Try Asterisk first
    try {
        return await sendSmsViaAsterisk(modemId, to, message);
    } catch (asteriskError) {
        logger.warn(`[SMS] Asterisk failed, trying direct AT: ${asteriskError.message}`);

        // Fallback to direct AT
        try {
            return await sendSmsViaDirect(dataPort, to, message);
        } catch (directError) {
            logger.error(`[SMS] All methods failed for ${to}`);
            throw new Error(`SMS failed: Asterisk (${asteriskError.message}), Direct (${directError.message})`);
        }
    }
}

module.exports = {
    sendSms,
    sendSmsViaAsterisk,
    sendSmsViaDirect,
};
