/**
 * Modem Constants and Profiles
 */

const path = require('path');

// Configuration paths
const CONFIG_DIR = process.env.DATA_DIR || '/var/lib/homenichat';
const MODEM_CONFIG_FILE = path.join(CONFIG_DIR, 'modem-config.json');
const QUECTEL_CONF_PATH = '/etc/asterisk/quectel.conf';

// Limits
const MAX_MODEMS = 5;
const MAX_PIN_ATTEMPTS = 2;

// Voice modes
const VOICE_MODES = {
    '3g': 'tty',     // TTY serial audio (traditional 3G mode)
    'volte': 'uac',  // USB Audio Class (VoLTE mode)
};

// VoLTE configuration for EC25
const VOLTE_CONFIG = {
    // AT commands to activate VoLTE mode (MUST be sent in this order)
    activationCommands: [
        'AT+QCFG="nwscanmode",3',           // Force LTE only (prevent CSFB to 3G)
        'AT+QCFG="ims",1',                   // Enable IMS
        'AT+QMBNCFG="Select","ROW_Generic_3GPP"', // Generic MBN profile
        'AT+CGDCONT=2,"IPV4V6","ims"',       // IMS APN
        'AT+QAUDMOD=3',                      // USB Audio mode (CRITICAL!)
        'AT+QPCMV=1,2',                      // Voice over UAC (CRITICAL!)
    ],
    // AT commands to deactivate VoLTE and return to 3G mode
    deactivationCommands: [
        'AT+QCFG="nwscanmode",0',           // Auto network mode (allow 3G)
        'AT+QAUDMOD=0',                      // Handset mode
        'AT+QPCMV=1,0',                      // Voice over TTY
    ],
    // Verification commands
    verifyCommands: {
        imsStatus: 'AT+QCFG="ims"',          // Should return 1,1 when VoLTE active
        networkMode: 'AT+COPS?',             // Should contain ",7" for LTE
        audioMode: 'AT+QAUDMOD?',            // Should return 3 for UAC
        pcmMode: 'AT+QPCMV?',                // Should return 1,2 for UAC
    },
    // ALSA device for UAC (USB Audio Class)
    alsaDevice: 'plughw:CARD=Android,DEV=0',
    // Audio gains for VoLTE (typically needs higher gains)
    rxgain: 10,
    txgain: 10,
};

// Modem profiles by type
const MODEM_PROFILES = {
    ec25: {
        name: 'Quectel EC25',
        slin16: false,  // 8kHz audio
        msg_storage: 'me',
        disableSMS: false,
        supportsVoLTE: true,  // EC25 supports VoLTE!
        // 3G mode (TTY) audio commands
        audioCommands: [
            'AT+QAUDMOD=0',     // Handset mode
            'AT+QPCMV=1,0',     // Voice over TTY
            'AT+CLVL=3',        // Volume speaker
        ],
        // VoLTE mode (UAC) audio commands
        volteCommands: VOLTE_CONFIG.activationCommands,
        portOffset: {
            data: 2,  // ttyUSB2 for EC25
            audio: 1, // ttyUSB1 for EC25 (TTY mode only)
        },
        // Fork required for VoLTE
        volteFork: 'IchthysMaranatha',
    },
    sim7600: {
        name: 'Simcom SIM7600',
        slin16: true,   // 16kHz audio
        msg_storage: 'me',
        disableSMS: false,
        supportsVoLTE: false,  // SIM7600 uses different VoLTE method
        audioCommands: [
            'AT+CPCMFRM=1',     // 16kHz PCM format
            'AT+CMICGAIN=0',
            'AT+COUTGAIN=5',
            'AT+CTXVOL=0x2000',
        ],
        portOffset: {
            data: 3,  // ttyUSB3 for SIM7600
            audio: 2, // ttyUSB2 for SIM7600
        },
        volteFork: 'RoEdAl',  // Different fork for SIM7600
    },
};

// USB Vendor IDs for auto-detection
const USB_VENDOR_IDS = {
    sim7600: '1e0e',  // Simcom
    ec25: '2c7c',     // Quectel
};

module.exports = {
    CONFIG_DIR,
    MODEM_CONFIG_FILE,
    QUECTEL_CONF_PATH,
    MAX_MODEMS,
    MAX_PIN_ATTEMPTS,
    MODEM_PROFILES,
    USB_VENDOR_IDS,
    VOICE_MODES,
    VOLTE_CONFIG,
};
