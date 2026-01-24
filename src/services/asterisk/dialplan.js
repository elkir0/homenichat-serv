/**
 * Dialplan Configuration Module
 * Manages Asterisk dialplan (extensions.conf)
 */

const fs = require('fs');
const logger = require('../../../utils/logger');
const {
    EXTENSIONS_CUSTOM_CONF,
    CONTEXT_INTERNAL,
    CONTEXT_FROM_GSM,
    CONTEXT_FROM_WEBRTC,
    CONTEXT_OUTBOUND_GSM,
} = require('./constants');

/**
 * Read current extensions configuration
 */
function readConfig() {
    try {
        if (fs.existsSync(EXTENSIONS_CUSTOM_CONF)) {
            return fs.readFileSync(EXTENSIONS_CUSTOM_CONF, 'utf8');
        }
    } catch (error) {
        logger.error('[Dialplan] Error reading config:', error.message);
    }
    return '';
}

/**
 * Write extensions configuration
 */
function writeConfig(content) {
    try {
        if (fs.existsSync(EXTENSIONS_CUSTOM_CONF)) {
            fs.copyFileSync(EXTENSIONS_CUSTOM_CONF, `${EXTENSIONS_CUSTOM_CONF}.bak`);
        }
        fs.writeFileSync(EXTENSIONS_CUSTOM_CONF, content);
        logger.info('[Dialplan] Config written');
        return true;
    } catch (error) {
        logger.error('[Dialplan] Error writing config:', error.message);
        return false;
    }
}

/**
 * Generate basic dialplan for Homenichat
 * Includes contexts for internal calls, GSM, and WebRTC
 */
function generateBasicDialplan(options = {}) {
    const {
        extensions = [],
        modems = [],
        ringTimeout = 30,
        recordCalls = false,
    } = options;

    let config = `; Homenichat Dialplan
; Generated: ${new Date().toISOString()}
; DO NOT EDIT MANUALLY - Use Homenichat admin interface

`;

    // Internal context - calls between extensions
    config += `[${CONTEXT_INTERNAL}]
; Internal extension dialing (2XXX)
exten => _2XXX,1,NoOp(Internal call to \${EXTEN})
 same => n,Dial(PJSIP/\${EXTEN},${ringTimeout})
 same => n,VoiceMail(\${EXTEN}@default,u)
 same => n,Hangup()

`;

    // Add outbound GSM dialing if modems configured
    if (modems.length > 0) {
        config += `; Outbound GSM calls (use first available modem)
`;
        for (let i = 0; i < modems.length; i++) {
            const modem = modems[i];
            const modemId = modem.id || modem.modemName || `modem-${i + 1}`;
            config += `; Outbound via ${modemId}
exten => _0XXXXXXXXX,${i + 1},Dial(Quectel/${modemId}/\${EXTEN},${ringTimeout},tT)
exten => _+X.,${i + 1},Dial(Quectel/${modemId}/\${EXTEN},${ringTimeout},tT)
`;
        }
        config += `exten => _0XXXXXXXXX,n,Hangup()
exten => _+X.,n,Hangup()

`;
    }

    // WebRTC context
    config += `[${CONTEXT_FROM_WEBRTC}]
include => ${CONTEXT_INTERNAL}

`;

    // GSM incoming context
    config += `[${CONTEXT_FROM_GSM}]
; Incoming GSM calls - ring all extensions
exten => s,1,NoOp(Incoming GSM call from \${CALLERID(num)})
 same => n,Set(CALLERID(name)=GSM:\${CALLERID(num)})
`;

    // Ring all extensions on incoming GSM call
    if (extensions.length > 0) {
        const dialTargets = extensions.map(e => `PJSIP/${e}`).join('&');
        config += ` same => n,Dial(${dialTargets},${ringTimeout},tT)
`;
    } else {
        config += ` same => n,NoOp(No extensions configured)
`;
    }

    config += ` same => n,VoiceMail(2000@default,u)
 same => n,Hangup()

; DID routing (if callerID is the phone number)
exten => _X.,1,Goto(s,1)

`;

    // Outbound GSM context
    config += `[${CONTEXT_OUTBOUND_GSM}]
; Outbound calls via GSM modem
`;
    if (modems.length > 0) {
        const modemId = modems[0].id || modems[0].modemName || 'modem-1';
        config += `exten => _X.,1,Dial(Quectel/${modemId}/\${EXTEN},${ringTimeout},tT)
 same => n,Hangup()
`;
    } else {
        config += `exten => _X.,1,NoOp(No GSM modems configured)
 same => n,Hangup()
`;
    }

    return config;
}

/**
 * Update dialplan with current extensions and modems
 */
function updateDialplan(options, amiConnection = null) {
    const content = generateBasicDialplan(options);

    if (!writeConfig(content)) {
        throw new Error('Failed to write dialplan configuration');
    }

    // Reload dialplan via AMI
    if (amiConnection?.authenticated) {
        amiConnection.sendCommand('dialplan reload').catch(err => {
            logger.warn('[Dialplan] Failed to reload:', err.message);
        });
    }

    return { updated: true };
}

/**
 * Add extension to ring group
 */
function addExtensionToRingGroup(extension, context = CONTEXT_FROM_GSM) {
    const currentConfig = readConfig();

    // This is a simplified implementation
    // In production, you'd want more sophisticated dialplan management
    logger.info(`[Dialplan] Adding ${extension} to ${context} ring group`);

    return { added: true, extension, context };
}

/**
 * Get dialplan status
 */
async function getDialplanStatus(amiConnection) {
    if (!amiConnection?.authenticated) {
        return { loaded: false, message: 'AMI not connected' };
    }

    try {
        const output = await amiConnection.sendCommand('dialplan show');
        const contextCount = (output.match(/\[.*\]/g) || []).length;
        return {
            loaded: true,
            contexts: contextCount,
            hasInternal: output.includes(CONTEXT_INTERNAL),
            hasFromGsm: output.includes(CONTEXT_FROM_GSM),
        };
    } catch (error) {
        return { loaded: false, error: error.message };
    }
}

module.exports = {
    readConfig,
    writeConfig,
    generateBasicDialplan,
    updateDialplan,
    addExtensionToRingGroup,
    getDialplanStatus,
    CONTEXT_INTERNAL,
    CONTEXT_FROM_GSM,
    CONTEXT_FROM_WEBRTC,
    CONTEXT_OUTBOUND_GSM,
};
