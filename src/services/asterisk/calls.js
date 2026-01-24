/**
 * Call Tracking Module
 * Tracks calls via AMI events and manages call history
 */

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../../utils/logger');
const { DISPOSITION_MAP } = require('./constants');

/**
 * Call Tracker Class
 * Listens to AMI events and tracks call state
 */
class CallTracker extends EventEmitter {
    constructor() {
        super();

        // Track active calls by channel
        this.activeCalls = new Map();
        // Track call bridges (linked channels)
        this.callBridges = new Map();
        // Track ringing calls (for notifications)
        this.ringingCalls = new Map();
    }

    /**
     * Attach to AMI connection
     */
    attachToAmi(amiConnection) {
        amiConnection.on('event:Newchannel', (e) => this.handleNewChannel(e));
        amiConnection.on('event:DialBegin', (e) => this.handleDialBegin(e));
        amiConnection.on('event:DialEnd', (e) => this.handleDialEnd(e));
        amiConnection.on('event:Bridge', (e) => this.handleBridge(e));
        amiConnection.on('event:Hangup', (e) => this.handleHangup(e));
        amiConnection.on('event:Cdr', (e) => this.handleCdr(e));
        amiConnection.on('event:Newstate', (e) => this.handleNewstate(e));

        logger.info('[CallTracker] Attached to AMI');
    }

    /**
     * Handle new channel event
     */
    handleNewChannel(event) {
        const channel = event.Channel;
        const uniqueId = event.Uniqueid;
        const callerIdNum = event.CallerIDNum || '';
        const callerIdName = event.CallerIDName || '';
        const context = event.Context || '';
        const exten = event.Exten || '';

        // Skip internal channels
        if (channel.includes('Local/')) return;

        const callData = {
            id: uuidv4(),
            uniqueId,
            channel,
            callerIdNum,
            callerIdName,
            context,
            exten,
            direction: this.determineDirection(context, callerIdNum, channel),
            startTime: Date.now(),
            status: 'initiated',
        };

        // Detect trunk/modem
        const trunkName = this.extractTrunkName(channel);
        if (trunkName) {
            callData.trunk = trunkName;
            callData.lineName = this.extractLineName(trunkName);
        }

        this.activeCalls.set(uniqueId, callData);
        this.emit('newCall', callData);

        logger.debug(`[CallTracker] New channel: ${channel} (${callData.direction})`);
    }

    /**
     * Handle dial begin event
     */
    handleDialBegin(event) {
        const destUniqueId = event.DestUniqueid;
        const destChannel = event.DestChannel;
        const dialstring = event.Dialstring || '';

        // Check if this is ringing an extension
        const extensionMatch = destChannel.match(/PJSIP\/(\d{4})/);
        if (extensionMatch) {
            const extension = extensionMatch[1];
            const uniqueId = event.Uniqueid;

            // Find the original call
            const callData = this.activeCalls.get(uniqueId);
            if (callData && callData.direction === 'incoming') {
                // Track ringing
                if (!this.ringingCalls.has(uniqueId)) {
                    this.ringingCalls.set(uniqueId, {
                        callData,
                        extensionsRinging: new Set(),
                        notifiedAt: Date.now(),
                    });
                }

                const ringing = this.ringingCalls.get(uniqueId);
                ringing.extensionsRinging.add(extension);

                this.emit('ringing', {
                    callId: callData.id,
                    uniqueId,
                    extension,
                    callerIdNum: callData.callerIdNum,
                    callerIdName: callData.callerIdName,
                    lineName: callData.lineName,
                });

                logger.info(`[CallTracker] Ringing extension ${extension} for call from ${callData.callerIdNum}`);
            }
        }
    }

    /**
     * Handle dial end event
     */
    handleDialEnd(event) {
        const uniqueId = event.Uniqueid;
        const dialStatus = event.DialStatus;

        if (dialStatus === 'ANSWER') {
            const ringing = this.ringingCalls.get(uniqueId);
            if (ringing) {
                this.ringingCalls.delete(uniqueId);
                this.emit('answered', {
                    callId: ringing.callData.id,
                    uniqueId,
                });
            }
        }
    }

    /**
     * Handle bridge event (call answered)
     */
    handleBridge(event) {
        const uniqueId1 = event.Uniqueid1;
        const uniqueId2 = event.Uniqueid2;

        // Update call status
        const call1 = this.activeCalls.get(uniqueId1);
        const call2 = this.activeCalls.get(uniqueId2);

        if (call1) {
            call1.status = 'answered';
            call1.answerTime = Date.now();
            call1.linkedChannel = event.Channel2;
        }

        if (call2) {
            call2.status = 'answered';
            call2.answerTime = Date.now();
            call2.linkedChannel = event.Channel1;
        }

        // Clear ringing
        this.ringingCalls.delete(uniqueId1);
        this.ringingCalls.delete(uniqueId2);

        // Store bridge
        this.callBridges.set(uniqueId1, uniqueId2);
        this.callBridges.set(uniqueId2, uniqueId1);

        this.emit('bridged', {
            uniqueId1,
            uniqueId2,
            callData: call1 || call2,
        });

        logger.debug(`[CallTracker] Bridge: ${uniqueId1} <-> ${uniqueId2}`);
    }

    /**
     * Handle hangup event
     */
    handleHangup(event) {
        const uniqueId = event.Uniqueid;
        const cause = event.Cause;
        const causeTxt = event.CauseTxt || '';

        const callData = this.activeCalls.get(uniqueId);
        if (!callData) return;

        callData.endTime = Date.now();
        callData.duration = Math.round((callData.endTime - callData.startTime) / 1000);
        callData.hangupCause = cause;
        callData.hangupCauseTxt = causeTxt;

        // Determine final status
        if (callData.status === 'answered') {
            // Keep answered status
        } else if (cause === '16' || cause === '17') {
            callData.status = 'missed';
        } else {
            callData.status = 'failed';
        }

        // Clear ringing if applicable
        const ringing = this.ringingCalls.get(uniqueId);
        if (ringing) {
            this.ringingCalls.delete(uniqueId);
            callData.status = 'missed';
        }

        // Clean up
        this.activeCalls.delete(uniqueId);
        const bridgedId = this.callBridges.get(uniqueId);
        if (bridgedId) {
            this.callBridges.delete(uniqueId);
            this.callBridges.delete(bridgedId);
        }

        this.emit('hangup', callData);

        logger.debug(`[CallTracker] Hangup: ${uniqueId} (${callData.status})`);
    }

    /**
     * Handle CDR event
     */
    handleCdr(event) {
        const cdrData = {
            id: uuidv4(),
            uniqueId: event.UniqueID,
            src: event.Source,
            dst: event.Destination,
            dcontext: event.DestinationContext,
            channel: event.Channel,
            dstchannel: event.DestinationChannel,
            lastapp: event.LastApplication,
            lastdata: event.LastData,
            startTime: this.parseAmiTime(event.StartTime),
            answerTime: event.AnswerTime ? this.parseAmiTime(event.AnswerTime) : null,
            endTime: this.parseAmiTime(event.EndTime),
            duration: parseInt(event.Duration) || 0,
            billsec: parseInt(event.BillableSeconds) || 0,
            disposition: event.Disposition,
            amaflags: event.AMAFlags,
        };

        // Determine direction from CDR
        cdrData.direction = this.determineDirectionFromCdr(event);
        cdrData.status = this.mapDisposition(cdrData.disposition);

        // Extract trunk info
        const trunkName = this.extractTrunkName(event.Channel) ||
                         this.extractTrunkName(event.DestinationChannel);
        if (trunkName) {
            cdrData.trunk = trunkName;
            cdrData.lineName = this.extractLineName(trunkName);
        }

        this.emit('cdr', cdrData);
    }

    /**
     * Handle new state event
     */
    handleNewstate(event) {
        const uniqueId = event.Uniqueid;
        const state = event.ChannelState;
        const stateDesc = event.ChannelStateDesc;

        const callData = this.activeCalls.get(uniqueId);
        if (callData) {
            callData.channelState = state;
            callData.channelStateDesc = stateDesc;
        }
    }

    /**
     * Determine call direction
     */
    determineDirection(context, callerIdNum, channel) {
        // From GSM modem = incoming
        if (context === 'from-gsm' || context.includes('from-trunk')) {
            return 'incoming';
        }

        // Quectel channel = could be incoming or outgoing
        if (channel.includes('Quectel/')) {
            // If context is internal/outbound, it's outgoing
            if (context === 'internal' || context.includes('outbound')) {
                return 'outgoing';
            }
            return 'incoming';
        }

        // Internal PJSIP calls
        if (channel.includes('PJSIP/')) {
            return 'outgoing';
        }

        return 'internal';
    }

    /**
     * Determine direction from CDR
     */
    determineDirectionFromCdr(event) {
        const channel = event.Channel || '';
        const dstChannel = event.DestinationChannel || '';
        const context = event.DestinationContext || '';

        // Incoming from GSM
        if (channel.includes('Quectel/') && dstChannel.includes('PJSIP/')) {
            return 'incoming';
        }

        // Outgoing to GSM
        if (channel.includes('PJSIP/') && dstChannel.includes('Quectel/')) {
            return 'outgoing';
        }

        // Internal
        if (channel.includes('PJSIP/') && dstChannel.includes('PJSIP/')) {
            return 'internal';
        }

        return 'unknown';
    }

    /**
     * Extract trunk name from channel
     */
    extractTrunkName(channel) {
        if (!channel) return null;

        // Quectel format: Quectel/modem-1-xxxx
        const quectelMatch = channel.match(/Quectel\/([^-]+(?:-[^-]+)?)/);
        if (quectelMatch) {
            return quectelMatch[1];
        }

        // PJSIP trunk format
        const pjsipMatch = channel.match(/PJSIP\/([^-@]+)/);
        if (pjsipMatch && !pjsipMatch[1].match(/^\d{4}$/)) {
            return pjsipMatch[1];
        }

        return null;
    }

    /**
     * Extract line name from trunk
     */
    extractLineName(trunkName) {
        if (!trunkName) return null;

        // Map common trunk names to friendly names
        const nameMap = {
            'modem-1': 'GSM Line 1',
            'modem-2': 'GSM Line 2',
            'quectel-chiro': 'Chiro',
            'quectel-osteo': 'Osteo',
        };

        return nameMap[trunkName] || trunkName;
    }

    /**
     * Map AMI disposition to status
     */
    mapDisposition(disposition) {
        return DISPOSITION_MAP[disposition] || 'unknown';
    }

    /**
     * Parse AMI timestamp
     */
    parseAmiTime(timeStr) {
        if (!timeStr) return null;
        const date = new Date(timeStr);
        return isNaN(date.getTime()) ? null : Math.floor(date.getTime() / 1000);
    }

    /**
     * Get current ringing calls
     */
    getRingingCalls() {
        const calls = [];
        for (const [uniqueId, data] of this.ringingCalls) {
            calls.push({
                callId: data.callData.id,
                uniqueId,
                callerIdNum: data.callData.callerIdNum,
                callerIdName: data.callData.callerIdName,
                lineName: data.callData.lineName,
                extensionsRinging: Array.from(data.extensionsRinging),
                ringingDuration: Math.round((Date.now() - data.notifiedAt) / 1000),
            });
        }
        return calls;
    }

    /**
     * Get active calls count
     */
    getActiveCallsCount() {
        return this.activeCalls.size;
    }

    /**
     * Get call by ID
     */
    getCallById(callId) {
        for (const [, call] of this.activeCalls) {
            if (call.id === callId) return call;
        }
        return null;
    }

    /**
     * Get call by unique ID
     */
    getCallByUniqueId(uniqueId) {
        return this.activeCalls.get(uniqueId);
    }
}

module.exports = {
    CallTracker,
};
