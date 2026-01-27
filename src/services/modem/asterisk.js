/**
 * Asterisk Integration Module
 * Handles chan_quectel configuration and Asterisk commands
 *
 * VoLTE Support (EC25):
 * - When volteEnabled=true, uses UAC (USB Audio Class) instead of TTY
 * - Requires quec_uac=1 and alsadev parameter in quectel.conf
 * - Must use IchthysMaranatha fork of chan_quectel
 */

const fs = require('fs');
const logger = require('../../../utils/logger');
const { QUECTEL_CONF_PATH, MODEM_PROFILES, VOLTE_CONFIG } = require('./constants');
const { runCommand, asteriskCommand, sleep } = require('./utils');
const { detectUsbPorts, calculateAudioPort } = require('./detection');

/**
 * List modems registered in Asterisk
 * @returns {Promise<Object[]>} Array of modem objects
 */
async function listModems() {
    try {
        const output = await asteriskCommand('quectel show devices');
        const modems = [];

        if (!output || output.includes('No modems')) {
            return modems;
        }

        // Parse output: each modem line has format like:
        // modem-1    sim7600   GSM    +33612345678    192.168.1.x
        for (const line of output.split('\n')) {
            if (line.includes('/dev/tty') || line.match(/^\s*[a-zA-Z0-9_-]+\s+/)) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 1) {
                    modems.push({
                        id: parts[0],
                        raw: line.trim(),
                    });
                }
            }
        }

        return modems;
    } catch (error) {
        logger.error('[AsteriskIntegration] Failed to list modems:', error.message);
        return [];
    }
}

/**
 * Get detailed status for a modem
 * @param {string} modemId - Modem ID
 * @returns {Promise<Object>} Modem status
 */
async function getModemStatus(modemId) {
    try {
        const output = await asteriskCommand(`quectel show device state ${modemId}`);

        const status = {
            modemId,
            connected: false,
            signal: 0,
            operator: null,
            imsi: null,
            phoneNumber: null,
            raw: output,
        };

        if (output.includes('State: Free') || output.includes('Connected')) {
            status.connected = true;
        }

        // Parse signal strength
        const signalMatch = output.match(/RSSI[:\s]+(\d+)/i);
        if (signalMatch) {
            status.signal = parseInt(signalMatch[1]);
        }

        // Parse operator
        const operatorMatch = output.match(/Provider[:\s]+(.+)/i);
        if (operatorMatch) {
            status.operator = operatorMatch[1].trim();
        }

        // Parse IMSI
        const imsiMatch = output.match(/IMSI[:\s]+(\d+)/i);
        if (imsiMatch) {
            status.imsi = imsiMatch[1];
        }

        return status;
    } catch (error) {
        logger.error(`[AsteriskIntegration] Failed to get modem status for ${modemId}:`, error.message);
        return { modemId, connected: false, error: error.message };
    }
}

/**
 * Generate quectel.conf content
 * @param {Object} config - Configuration with modems array
 * @param {Object} modemsConfig - Multi-modem configuration
 * @returns {string} Configuration file content
 */
function generateQuectelConf(config = {}, modemsConfig = {}) {
    const smsConfig = config.sms || {};
    const msgStorage = smsConfig.storage === 'sim' ? 'sm' : 'me';
    const autoDeleteSms = smsConfig.autoDelete !== false ? 'yes' : 'no';

    let confContent = `; Homenichat - Configuration chan_quectel
; Generated automatically - ${new Date().toISOString()}
; VoLTE support: quec_uac=1 for EC25 modems in VoLTE mode

[general]
interval=15
smsdb=/var/lib/asterisk/smsdb
csmsttl=600

[defaults]
context=from-gsm
group=0
rxgain=-5
txgain=-15
autodeletesms=${autoDeleteSms}
resetquectel=yes
msg_storage=${msgStorage}
msg_direct=off
usecallingpres=yes
callingpres=allowed_passed_screen
`;

    // Generate modem sections
    const modemsToGen = config.modems || Object.entries(modemsConfig).map(([id, cfg]) => ({
        id,
        name: cfg.modemName || id,
        type: cfg.modemType,
        dataPort: cfg.dataPort,
        audioPort: cfg.audioPort,
        phoneNumber: cfg.phoneNumber,
        imsi: cfg.imsi,
        volteEnabled: cfg.volteEnabled || false,  // VoLTE mode flag
    }));

    for (const modem of modemsToGen) {
        const type = (modem.type || 'sim7600').toLowerCase();
        const profile = MODEM_PROFILES[type] || MODEM_PROFILES.sim7600;
        const dataPort = modem.dataPort || '/dev/ttyUSB2';
        const modemName = modem.name || modem.id || 'hni-modem';

        // Check if VoLTE mode is enabled and supported
        const volteEnabled = modem.volteEnabled && profile.supportsVoLTE;

        if (volteEnabled) {
            // VoLTE mode: Use USB Audio Class (UAC) instead of TTY
            logger.info(`[AsteriskIntegration] Generating VoLTE config for ${modemName}`);
            confContent += `
; ${modemName} - VoLTE Mode (USB Audio Class)
; Requires: AT+QAUDMOD=3 and AT+QPCMV=1,2 sent to modem
[${modemName}]
data=${dataPort}
quec_uac=1                              ; Enable USB Audio Class (VoLTE)
alsadev=${VOLTE_CONFIG.alsaDevice}      ; ALSA device for UAC
context=from-gsm
rxgain=${VOLTE_CONFIG.rxgain}           ; Higher gain for VoLTE
txgain=${VOLTE_CONFIG.txgain}
${modem.imsi ? `imsi=${modem.imsi}` : '; imsi auto-detected'}
${modem.phoneNumber ? `exten=+${modem.phoneNumber.replace(/^\+/, '')}` : ''}
`;
        } else {
            // Standard 3G mode: Use TTY serial audio
            const audioPort = modem.audioPort || calculateAudioPort(dataPort, type);
            confContent += `
; ${modemName} - 3G Mode (TTY Serial Audio)
[${modemName}]
data=${dataPort}
audio=${audioPort}
slin16=${profile.slin16 ? 'yes' : 'no'}
${modem.imsi ? `imsi=${modem.imsi}` : '; imsi auto-detected'}
${modem.phoneNumber ? `exten=+${modem.phoneNumber.replace(/^\+/, '')}` : ''}
`;
        }
    }

    return confContent;
}

/**
 * Load or reload chan_quectel module
 * @returns {Promise<string>} Result message
 */
async function loadOrReloadChanQuectel() {
    const moduleStatus = await asteriskCommand('module show like quectel');

    if (moduleStatus.includes('0 modules loaded') || !moduleStatus.includes('chan_quectel')) {
        logger.info('[AsteriskIntegration] chan_quectel not loaded, loading...');
        const result = await asteriskCommand('module load chan_quectel.so');
        logger.info(`[AsteriskIntegration] Module loaded: ${result}`);
        return result;
    } else {
        logger.info('[AsteriskIntegration] chan_quectel loaded, reloading...');
        const result = await asteriskCommand('module reload chan_quectel');
        logger.info(`[AsteriskIntegration] Module reloaded: ${result}`);
        return result;
    }
}

/**
 * Apply quectel.conf configuration
 * @param {Object} config - Configuration
 * @param {Object} modemsConfig - Multi-modem configuration
 * @returns {Promise<Object>} Result with success and modems detected
 */
async function applyQuectelConf(config = {}, modemsConfig = {}) {
    try {
        // Auto-detect if no modems provided
        if (!config.modems || config.modems.length === 0) {
            const detected = await detectUsbPorts();
            if (detected.modems && detected.modems.length > 0) {
                logger.info(`[AsteriskIntegration] Auto-detected ${detected.modems.length} modem(s)`);
                config.modems = detected.modems;
            }
        }

        // Create smsdb directory
        await runCommand('mkdir -p /var/lib/asterisk/smsdb && chown asterisk:asterisk /var/lib/asterisk/smsdb 2>/dev/null || true');

        // Generate and write config
        const confContent = generateQuectelConf(config, modemsConfig);
        fs.writeFileSync(QUECTEL_CONF_PATH, confContent);
        logger.info('[AsteriskIntegration] quectel.conf written');

        // Load/reload module
        await loadOrReloadChanQuectel();

        // Wait for modems to be detected
        const modemNames = config.modems?.map(m => m.name || m.id) || ['hni-modem'];
        let attempts = 0;
        const maxAttempts = 10;

        logger.info(`[AsteriskIntegration] Waiting for modem(s): ${modemNames.join(', ')}`);

        while (attempts < maxAttempts) {
            await sleep(500);
            const modems = await listModems();
            const foundAll = modemNames.every(name =>
                modems.some(m => m.id === name || m.raw?.includes(name))
            );

            if (foundAll) {
                logger.info('[AsteriskIntegration] All modems detected');
                return { success: true, modems };
            }
            attempts++;
        }

        logger.warn('[AsteriskIntegration] Not all modems detected within timeout');
        return { success: true, partial: true, modems: await listModems() };
    } catch (error) {
        logger.error('[AsteriskIntegration] Failed to apply quectel.conf:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Read current quectel.conf
 * @returns {string|null} File content or null
 */
function readQuectelConf() {
    try {
        if (fs.existsSync(QUECTEL_CONF_PATH)) {
            return fs.readFileSync(QUECTEL_CONF_PATH, 'utf8');
        }
        return null;
    } catch (error) {
        logger.error('[AsteriskIntegration] Failed to read quectel.conf:', error.message);
        return null;
    }
}

/**
 * Restart Asterisk service
 * @returns {Promise<string>} Result
 */
async function restartAsterisk() {
    logger.info('[AsteriskIntegration] Restarting Asterisk...');
    return runCommand('systemctl restart asterisk');
}

/**
 * Restart a specific modem in Asterisk
 * @param {string} modemId - Modem ID
 * @returns {Promise<string>} Result
 */
async function restartModem(modemId) {
    logger.info(`[AsteriskIntegration] Restarting modem: ${modemId}`);
    return asteriskCommand(`quectel reset ${modemId}`);
}

module.exports = {
    listModems,
    getModemStatus,
    generateQuectelConf,
    loadOrReloadChanQuectel,
    applyQuectelConf,
    readQuectelConf,
    restartAsterisk,
    restartModem,
};
