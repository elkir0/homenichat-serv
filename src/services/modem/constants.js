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

// Modem profiles by type
const MODEM_PROFILES = {
    ec25: {
        name: 'Quectel EC25',
        slin16: false,  // 8kHz audio
        msg_storage: 'me',
        disableSMS: false,
        audioCommands: [
            'AT+QAUDMOD=2',     // Mode PCM (pas USB audio)
            'AT+CPCMFRM=0',     // 8kHz PCM format
            'AT+CLVL=3',        // Volume speaker
        ],
        portOffset: {
            data: 2,  // ttyUSB2 for EC25
            audio: 1, // ttyUSB1 for EC25
        },
    },
    sim7600: {
        name: 'Simcom SIM7600',
        slin16: true,   // 16kHz audio
        msg_storage: 'me',
        disableSMS: false,
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
};
