/**
 * Asterisk Service Constants
 */

// AMI Configuration
const AMI_DEFAULT_HOST = '127.0.0.1';
const AMI_DEFAULT_PORT = 5038;
const AMI_DEFAULT_USERNAME = 'homenichat';
const AMI_RECONNECT_DELAY = 5000;
const AMI_MAX_RECONNECT_ATTEMPTS = 10;

// PJSIP Configuration paths
const PJSIP_CONF_PATH = '/etc/asterisk/pjsip.conf';
const PJSIP_CUSTOM_CONF = '/etc/asterisk/pjsip_custom.conf';
const PJSIP_ENDPOINTS_CONF = '/etc/asterisk/pjsip_endpoints.conf';

// Extensions/Dialplan paths
const EXTENSIONS_CONF_PATH = '/etc/asterisk/extensions.conf';
const EXTENSIONS_CUSTOM_CONF = '/etc/asterisk/extensions_custom.conf';

// Quectel Configuration
const QUECTEL_CONF_PATH = '/etc/asterisk/quectel.conf';

// Context names
const CONTEXT_INTERNAL = 'internal';
const CONTEXT_FROM_GSM = 'from-gsm';
const CONTEXT_FROM_WEBRTC = 'from-webrtc';
const CONTEXT_OUTBOUND_GSM = 'outbound-gsm';

// WebRTC transport settings
const WEBRTC_TRANSPORT_NAME = 'transport-wss';
const WEBRTC_DEFAULT_CODECS = ['g722', 'ulaw', 'alaw'];

// Extension number range
const EXTENSION_MIN = 2000;
const EXTENSION_MAX = 2999;

// Call disposition mapping
const DISPOSITION_MAP = {
    'ANSWERED': 'answered',
    'NO ANSWER': 'missed',
    'BUSY': 'busy',
    'FAILED': 'failed',
    'CONGESTION': 'failed',
};

module.exports = {
    AMI_DEFAULT_HOST,
    AMI_DEFAULT_PORT,
    AMI_DEFAULT_USERNAME,
    AMI_RECONNECT_DELAY,
    AMI_MAX_RECONNECT_ATTEMPTS,
    PJSIP_CONF_PATH,
    PJSIP_CUSTOM_CONF,
    PJSIP_ENDPOINTS_CONF,
    EXTENSIONS_CONF_PATH,
    EXTENSIONS_CUSTOM_CONF,
    QUECTEL_CONF_PATH,
    CONTEXT_INTERNAL,
    CONTEXT_FROM_GSM,
    CONTEXT_FROM_WEBRTC,
    CONTEXT_OUTBOUND_GSM,
    WEBRTC_TRANSPORT_NAME,
    WEBRTC_DEFAULT_CODECS,
    EXTENSION_MIN,
    EXTENSION_MAX,
    DISPOSITION_MAP,
};
