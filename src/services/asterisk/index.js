/**
 * Asterisk Service
 * Manages Asterisk for VoIP functionality
 *
 * Replaces FreePBXAmiService with pure Asterisk integration
 * No FreePBX dependency - uses direct config files and AMI
 */

const EventEmitter = require('events');
const logger = require('../../../utils/logger');

// Import modules
const { AmiConnection } = require('./ami');
const { CallTracker } = require('./calls');
const pjsip = require('./pjsip');
const dialplan = require('./dialplan');
const constants = require('./constants');

/**
 * Asterisk Service Class
 * Provides unified interface to all Asterisk functionality
 */
class AsteriskService extends EventEmitter {
    constructor(config = {}) {
        super();

        this.config = config;
        this.ami = new AmiConnection(config.ami);
        this.callTracker = new CallTracker();

        // Wire up call tracker events
        this.callTracker.on('newCall', (data) => this.emit('newCall', data));
        this.callTracker.on('ringing', (data) => this.emit('ringing', data));
        this.callTracker.on('answered', (data) => this.emit('answered', data));
        this.callTracker.on('bridged', (data) => this.emit('bridged', data));
        this.callTracker.on('hangup', (data) => this.emit('hangup', data));
        this.callTracker.on('cdr', (data) => this.emit('cdr', data));
    }

    /**
     * Start the Asterisk service
     */
    start() {
        // Start AMI connection
        const started = this.ami.start();

        if (started) {
            // Attach call tracker when authenticated
            this.ami.on('authenticated', () => {
                this.callTracker.attachToAmi(this.ami);
                this.emit('connected');
            });

            this.ami.on('close', () => {
                this.emit('disconnected');
            });
        }

        logger.info('[AsteriskService] Started');
        return started;
    }

    /**
     * Stop the service
     */
    stop() {
        this.ami.stop();
        logger.info('[AsteriskService] Stopped');
    }

    // =====================================================
    // AMI Methods
    // =====================================================

    /**
     * Get AMI connection status
     */
    getStatus() {
        return {
            ami: this.ami.getStatus(),
            activeCalls: this.callTracker.getActiveCallsCount(),
            ringingCalls: this.callTracker.getRingingCalls().length,
        };
    }

    /**
     * Send AMI action
     */
    async sendAction(action) {
        return this.ami.sendAction(action);
    }

    /**
     * Send CLI command
     */
    async sendCommand(command) {
        return this.ami.sendCommand(command);
    }

    /**
     * Reload Asterisk module
     */
    async reloadModule(module) {
        return this.ami.reloadModule(module);
    }

    // =====================================================
    // PJSIP Extension Methods
    // =====================================================

    /**
     * Create a new PJSIP extension
     */
    async createExtension(data) {
        return pjsip.createExtension(data, this.ami);
    }

    /**
     * Delete a PJSIP extension
     */
    async deleteExtension(extension) {
        return pjsip.deleteExtension(extension, this.ami);
    }

    /**
     * Update extension secret
     */
    async updateExtensionSecret(extension, newSecret) {
        return pjsip.updateExtensionSecret(extension, newSecret, this.ami);
    }

    /**
     * Get extension status
     */
    async getExtensionStatus(extension) {
        return pjsip.getExtensionStatus(extension, this.ami);
    }

    /**
     * List all extensions
     */
    listExtensions() {
        return pjsip.listExtensions();
    }

    /**
     * Get next available extension number
     */
    getNextAvailableExtension() {
        return pjsip.getNextAvailableExtension();
    }

    /**
     * Check if extension exists
     */
    extensionExists(extension) {
        return pjsip.extensionExists(extension);
    }

    /**
     * Generate random secret
     */
    generateSecret(length) {
        return pjsip.generateSecret(length);
    }

    // =====================================================
    // Dialplan Methods
    // =====================================================

    /**
     * Update dialplan with extensions and modems
     */
    updateDialplan(options) {
        return dialplan.updateDialplan(options, this.ami);
    }

    /**
     * Generate basic dialplan
     */
    generateDialplan(options) {
        return dialplan.generateBasicDialplan(options);
    }

    /**
     * Get dialplan status
     */
    async getDialplanStatus() {
        return dialplan.getDialplanStatus(this.ami);
    }

    // =====================================================
    // Call Management Methods
    // =====================================================

    /**
     * Get ringing calls
     */
    getRingingCalls() {
        return this.callTracker.getRingingCalls();
    }

    /**
     * Get active calls count
     */
    getActiveCallsCount() {
        return this.callTracker.getActiveCallsCount();
    }

    /**
     * Get call by ID
     */
    getCallById(callId) {
        return this.callTracker.getCallById(callId);
    }

    /**
     * Answer a ringing call
     * Redirects the call to a specific extension
     */
    async answerCall(callId, targetExtension) {
        const ringingCalls = this.callTracker.getRingingCalls();
        const call = ringingCalls.find(c => c.callId === callId);

        if (!call) {
            throw new Error('Call not found or no longer ringing');
        }

        // Use AMI Redirect to send the call to the target extension
        await this.ami.sendAction({
            action: 'Redirect',
            Channel: call.channel,
            Context: 'internal',
            Exten: targetExtension,
            Priority: '1',
        });

        logger.info(`[AsteriskService] Answered call ${callId} to extension ${targetExtension}`);
        return { answered: true, callId, extension: targetExtension };
    }

    /**
     * Reject a ringing call
     */
    async rejectCall(callId) {
        const ringingCalls = this.callTracker.getRingingCalls();
        const call = ringingCalls.find(c => c.callId === callId);

        if (!call) {
            throw new Error('Call not found or no longer ringing');
        }

        // Use AMI Hangup to reject the call
        await this.ami.sendAction({
            action: 'Hangup',
            Channel: call.channel,
            Cause: '21', // Call rejected
        });

        logger.info(`[AsteriskService] Rejected call ${callId}`);
        return { rejected: true, callId };
    }

    /**
     * Originate a call
     */
    async originateCall(options) {
        const {
            extension,
            destination,
            callerId,
            context = 'internal',
            priority = '1',
            timeout = 30000,
        } = options;

        await this.ami.sendAction({
            action: 'Originate',
            Channel: `PJSIP/${extension}`,
            Context: context,
            Exten: destination,
            Priority: priority,
            CallerID: callerId || extension,
            Timeout: timeout,
            Async: 'true',
        });

        logger.info(`[AsteriskService] Originated call from ${extension} to ${destination}`);
        return { originated: true, extension, destination };
    }

    /**
     * Hangup a call
     */
    async hangupCall(channel) {
        await this.ami.sendAction({
            action: 'Hangup',
            Channel: channel,
        });

        return { hungup: true, channel };
    }

    // =====================================================
    // Modem/Trunk Methods
    // =====================================================

    /**
     * Create a GSM modem trunk configuration
     */
    async createModemTrunk(modemData) {
        const { modemId, modemName, context = 'from-gsm' } = modemData;

        // Modem configuration is handled by chan_quectel
        // This just updates the dialplan to route calls
        const extensions = this.listExtensions().map(e => e.extension);

        return this.updateDialplan({
            extensions,
            modems: [{ id: modemId, modemName }],
        });
    }

    /**
     * Get modem trunk status
     */
    async getModemTrunkStatus(modemId) {
        try {
            const output = await this.sendCommand(`quectel show device state ${modemId}`);
            return {
                modemId,
                connected: output.includes('State: Free') || output.includes('State: Ring'),
                raw: output,
            };
        } catch (error) {
            return { modemId, connected: false, error: error.message };
        }
    }
}

// Singleton instance
let instance = null;

/**
 * Get singleton AsteriskService instance
 */
function getAsteriskService(config = {}) {
    if (!instance) {
        instance = new AsteriskService(config);
    }
    return instance;
}

module.exports = {
    AsteriskService,
    getAsteriskService,

    // Re-export modules
    ami: require('./ami'),
    calls: require('./calls'),
    pjsip,
    dialplan,
    constants,
};
