const EventEmitter = require('events');
const logger = require('../../utils/logger'); // Ensure this path is correct relative to file

class VoipProvider extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = config;
        this.activeCalls = new Map();
    }

    /**
     * Initialize the provider
     */
    async initialize(config) {
        if (config) {
            this.config = { ...this.config, ...config };
        }
        logger.info('VoIP Provider initialized');
    }

    /**
     * Handle incoming call webhook from Yeastar
     * Expected payload: { event: 'incoming', callId: '...', callerNumber: '...', calledNumber: '...' }
     */
    async handleIncomingCallWebhook(data) {
        if (!data) return null;

        const call = {
            id: data.callId || Date.now().toString(),
            from: data.callerNumber || data.caller || 'Unknown',
            to: data.calledNumber || data.callee,
            timestamp: Date.now(),
            status: 'ringing'
        };

        this.activeCalls.set(call.id, call);

        // Emit event for Push Notification service
        this.emit('incoming_call', call);

        logger.info(`📞 Initial incoming call: ${call.from} -> ${call.to}`);
        return call;
    }

    /**
     * Generate SIP configuration for the frontend
     * This is what the frontend requests via /api/config/voip
     */
    getSipConfig() {
        return {
            server: this.config.server,       // wss://...
            domain: this.config.domain,       // IP/Domain
            extension: this.config.extension,
            password: this.config.password    // Caution: sending password to client
        };
    }
}

module.exports = VoipProvider;
