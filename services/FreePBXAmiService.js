/**
 * FreePBX AMI Service - Real-time call tracking
 *
 * Connects to Asterisk Manager Interface (AMI) to track ALL calls
 * (incoming, outgoing, internal) across all extensions and trunks.
 *
 * Events tracked:
 * - Newchannel: Call initiated
 * - Bridge: Call answered (two channels connected)
 * - Hangup: Call ended
 * - DialBegin/DialEnd: Outgoing call progress
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const db = require('./DatabaseService');
const pushService = require('./PushService');

// FreePBX configuration file paths
// These are *_custom.conf files that FreePBX includes automatically
const PJSIP_CUSTOM_CONF = '/etc/asterisk/pjsip_custom.conf';
const EXTENSIONS_CUSTOM_CONF = '/etc/asterisk/extensions_custom.conf';

class FreePBXAmiService extends EventEmitter {
  constructor() {
    super();

    // Support both naming conventions for AMI credentials
    this.config = {
      host: process.env.AMI_HOST || '127.0.0.1',
      port: parseInt(process.env.AMI_PORT) || 5038,
      username: process.env.AMI_USER || process.env.AMI_USERNAME || 'homenichat',
      password: process.env.AMI_SECRET || process.env.AMI_PASSWORD || ''
    };

    this.socket = null;
    this.connected = false;
    this.authenticated = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000; // 5 seconds

    // Track active calls by channel
    this.activeCalls = new Map();
    // Track call bridges (linked channels)
    this.callBridges = new Map();
    // Track ringing calls (for incoming call notifications)
    // Key: uniqueId, Value: { callData, notifiedAt, extensionsRinging: Set }
    this.ringingCalls = new Map();

    // Buffer for incoming data
    this.dataBuffer = '';
  }

  /**
   * Start the AMI connection
   */
  start() {
    if (!this.config.host || !this.config.username) {
      logger.warn('[AMI] Configuration missing, AMI service disabled');
      return;
    }

    logger.info(`[AMI] Connecting to FreePBX at ${this.config.host}:${this.config.port}`);
    this.connect();
  }

  /**
   * Connect to AMI
   */
  connect() {
    this.socket = new net.Socket();

    this.socket.on('connect', () => {
      logger.info('[AMI] Connected to FreePBX AMI');
      this.connected = true;
      this.reconnectAttempts = 0;
    });

    this.socket.on('data', (data) => {
      this.handleData(data.toString());
    });

    this.socket.on('close', () => {
      logger.warn('[AMI] Connection closed');
      this.connected = false;
      this.authenticated = false;
      this.scheduleReconnect();
    });

    this.socket.on('error', (err) => {
      logger.error('[AMI] Socket error:', err.message);
      this.connected = false;
      this.authenticated = false;
    });

    this.socket.connect(this.config.port, this.config.host);
  }

  /**
   * Schedule reconnection
   */
  scheduleReconnect() {
    if (this.reconnectTimer) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('[AMI] Max reconnect attempts reached, giving up');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 6);

    logger.info(`[AMI] Reconnecting in ${delay/1000}s (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Handle incoming data from AMI
   */
  handleData(data) {
    this.dataBuffer += data;

    // Handle AMI banner (single line with just \r\n, not \r\n\r\n)
    if (this.dataBuffer.startsWith('Asterisk Call Manager')) {
      const bannerEnd = this.dataBuffer.indexOf('\r\n');
      if (bannerEnd > 0) {
        const banner = this.dataBuffer.substring(0, bannerEnd);
        this.dataBuffer = this.dataBuffer.substring(bannerEnd + 2);
        this.parseEvent(banner);
      }
      return;
    }

    // AMI events are separated by double newlines
    const events = this.dataBuffer.split('\r\n\r\n');

    // Keep the last incomplete event in buffer
    this.dataBuffer = events.pop() || '';

    for (const eventStr of events) {
      if (eventStr.trim()) {
        this.parseEvent(eventStr);
      }
    }
  }

  /**
   * Parse an AMI event
   */
  parseEvent(eventStr) {
    const lines = eventStr.split('\r\n');
    const event = {};

    // Check for AMI banner first (format: "Asterisk Call Manager/X.X.X")
    if (eventStr.startsWith('Asterisk Call Manager')) {
      logger.info('[AMI] Received banner, sending login...');
      this.login();
      return;
    }

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim();
        event[key] = value;
      }
    }

    // Handle different event types
    if (event['Response'] === 'Success' && !this.authenticated) {
      this.authenticated = true;
      logger.info('[AMI] Authentication successful');
      this.emit('authenticated');
    } else if (event['Response'] === 'Error') {
      logger.error('[AMI] Error:', event['Message']);
    } else if (event['Event']) {
      this.handleAmiEvent(event);
    }
  }

  /**
   * Send login command
   */
  login() {
    this.sendAction({
      Action: 'Login',
      Username: this.config.username,
      Secret: this.config.password,
      Events: 'call,cdr'
    });
  }

  /**
   * Send an action to AMI
   */
  sendAction(action) {
    if (!this.socket || !this.connected) return;

    let message = '';
    for (const [key, value] of Object.entries(action)) {
      message += `${key}: ${value}\r\n`;
    }
    message += '\r\n';

    this.socket.write(message);
  }

  /**
   * Handle AMI events
   */
  handleAmiEvent(event) {
    const eventType = event['Event'];

    switch (eventType) {
      case 'Newchannel':
        this.handleNewChannel(event);
        break;

      case 'DialBegin':
        this.handleDialBegin(event);
        break;

      case 'DialEnd':
        this.handleDialEnd(event);
        break;

      case 'Bridge':
      case 'BridgeEnter':
        this.handleBridge(event);
        break;

      case 'Hangup':
        this.handleHangup(event);
        break;

      case 'Cdr':
        // CDR event contains complete call record
        this.handleCdr(event);
        break;

      default:
        // Log other events for debugging
        if (process.env.AMI_DEBUG === 'true') {
          logger.debug(`[AMI] Event: ${eventType}`, event);
        }
    }
  }

  /**
   * Handle new channel (call initiated)
   */
  handleNewChannel(event) {
    const channel = event['Channel'];
    const callerIdNum = event['CallerIDNum'];
    const callerIdName = event['CallerIDName'];
    const exten = event['Exten'];
    const context = event['Context'];
    const uniqueId = event['Uniqueid'];

    // Try to get real caller ID from various fields (GSM gateways may use different fields)
    const connectedLineNum = event['ConnectedLineNum'];
    const dnid = event['DNID'];
    const rdnis = event['RDNIS'];

    // Debug: log all fields to find real caller ID
    if (process.env.AMI_DEBUG === 'true') {
      logger.info(`[AMI] DEBUG Newchannel ALL FIELDS: ${JSON.stringify(event)}`);
    }

    // Determine if caller is internal (extension) or external
    const isInternalCaller = callerIdNum && callerIdNum.length <= 4 && /^\d+$/.test(callerIdNum);
    const isExternalCaller = callerIdNum && callerIdNum.length >= 6;

    // Skip Local channels (dialplan internal)
    if (channel && channel.startsWith('Local/')) {
      logger.debug(`[AMI] Skipping Local channel: ${channel}`);
      return;
    }

    // For trunk channels: only keep if it's an incoming call (external caller)
    if (this.isTrunkChannel(channel)) {
      if (isInternalCaller) {
        // Outgoing call via trunk - skip the trunk leg (we track the extension leg)
        logger.debug(`[AMI] Skipping outbound trunk channel: ${channel}`);
        return;
      }
      // Incoming call - extract trunk name for line identification
      logger.info(`[AMI] Incoming call via trunk: ${channel} from ${callerIdNum}`);
    }

    // Skip invalid extensions (like 's', empty, or special codes) - but not for incoming
    if (!isExternalCaller && (!exten || exten === 's' || exten.startsWith('_') || exten.length < 3)) {
      logger.debug(`[AMI] Skipping invalid extension: ${exten}`);
      return;
    }

    // Extract trunk/line name from channel (e.g., PJSIP/GSM-Chiro-xxx -> GSM-Chiro)
    const trunkName = this.extractTrunkName(channel);

    // Store channel info
    this.activeCalls.set(channel, {
      uniqueId,
      channel,
      callerIdNum,
      callerIdName,
      exten,
      context,
      trunkName,
      startTime: Date.now(),
      direction: this.determineDirection(context, callerIdNum),
      status: 'ringing'
    });

    logger.info(`[AMI] New channel: ${channel} from ${callerIdNum} to ${exten} (trunk: ${trunkName || 'none'})`);

    // EARLY PUSH DETECTION: For Quectel/GSM modem incoming calls, send push immediately
    // This wakes up the iOS app BEFORE the dialplan tries to dial the extension
    if (channel && channel.startsWith('Quectel/') && isExternalCaller && context === 'from-gsm') {
      logger.info(`[AMI] 🚨 EARLY PUSH: Incoming Quectel call from ${callerIdNum}`);

      // Format caller number
      let formattedNumber = callerIdNum;
      if (formattedNumber && formattedNumber.startsWith('+590')) {
        formattedNumber = '0' + formattedNumber.substring(4);
      }

      const earlyCallData = {
        callId: uniqueId,
        callerNumber: formattedNumber || 'Inconnu',
        callerName: callerIdName || null,
        lineName: this.extractLineName(trunkName) || this.extractLineName(channel),
        extension: '1001', // Default extension for incoming calls
        channel: channel,
        startTime: Date.now(),
        direction: 'incoming',
        status: 'ringing',
        earlyPush: true // Flag to indicate this is an early push
      };

      // Emit the incoming call event immediately
      this.emit('incomingCall', earlyCallData);

      // Broadcast via PushService to wake up the app
      const pushService = require('./PushService');
      pushService.broadcast(pushService.eventTypes?.INCOMING_CALL || 'incoming_call', earlyCallData);

      logger.info(`[AMI] 🚨 EARLY PUSH SENT for ${formattedNumber} -> waking up mobile apps`);
    }
  }

  /**
   * Extract trunk name from channel (e.g., PJSIP/GSM-Chiro-0000001f -> GSM-Chiro)
   */
  extractTrunkName(channel) {
    if (!channel) return null;
    // Match patterns like PJSIP/GSM-Chiro-xxx or SIP/trunk-name-xxx
    const match = channel.match(/^(?:PJSIP|SIP|DAHDI)\/([^-]+-[^-]+|[^-]+)-/i);
    if (match) {
      return match[1];
    }
    return null;
  }

  /**
   * Extract clean line name (Chiro/Osteo) from any string
   */
  extractLineName(rawName) {
    if (!rawName) return null;
    const lower = rawName.toLowerCase();
    if (lower.includes('chiro')) {
      return 'Chiro';
    } else if (lower.includes('osteo')) {
      return 'Osteo';
    }
    return null;
  }

  /**
   * Check if channel is a trunk/gateway/local (should be filtered)
   */
  isTrunkChannel(channel) {
    if (!channel) return true;
    const trunkPatterns = [
      'GSM', 'trunk', 'gateway', 'Trunk', 'Gateway', 'DAHDI',
      'Local/', 'gsm-', 'sip-trunk', 'Chiro'
    ];
    return trunkPatterns.some(pattern => channel.includes(pattern));
  }

  /**
   * Check if a number is a trunk/gateway identifier (not a real number)
   */
  isTrunkNumber(number) {
    if (!number) return true;
    const trunkPatterns = ['gsm', 'gateway', 'trunk', 'unknown', 'Chiro'];
    const lowerNum = number.toLowerCase();
    return trunkPatterns.some(pattern => lowerNum.includes(pattern));
  }

  /**
   * Handle dial begin (outgoing call or incoming call ringing on extension)
   */
  handleDialBegin(event) {
    const channel = event['Channel'];
    const destChannel = event['DestChannel'];
    const dialString = event['DialString'];
    const uniqueId = event['Uniqueid'] || event['UniqueID'];
    const linkedId = event['Linkedid'];

    const callInfo = this.activeCalls.get(channel);
    if (callInfo) {
      callInfo.destChannel = destChannel;
      callInfo.dialString = dialString;
    }

    // Check if this is an incoming call ringing on an extension
    // DestChannel like PJSIP/1001-xxx indicates extension 1001 is ringing
    if (destChannel && destChannel.match(/^PJSIP\/\d{3,4}-/)) {
      const extensionMatch = destChannel.match(/^PJSIP\/(\d{3,4})-/);
      if (extensionMatch) {
        const extension = extensionMatch[1];

        // Check if this is from an incoming trunk call
        if (callInfo && callInfo.direction === 'incoming') {
          this.handleIncomingRing(linkedId || uniqueId, extension, callInfo, event);
        } else if (channel.includes('GSM') || channel.includes('Chiro') || channel.includes('Osteo')) {
          // Direct trunk to extension - this is an incoming call
          const callerNum = event['CallerIDNum'] || callInfo?.callerIdNum;
          const callerName = event['CallerIDName'] || callInfo?.callerIdName;

          const incomingCallInfo = {
            uniqueId: linkedId || uniqueId,
            callerIdNum: callerNum,
            callerIdName: callerName,
            direction: 'incoming',
            trunkName: this.extractTrunkName(channel)
          };

          this.handleIncomingRing(linkedId || uniqueId, extension, incomingCallInfo, event);
        }
      }
    }
  }

  /**
   * Handle incoming call ringing on an extension
   * This emits an event that can trigger push notifications
   */
  handleIncomingRing(callId, extension, callInfo, rawEvent) {
    // Check if we already notified for this call
    let ringingCall = this.ringingCalls.get(callId);

    // Get the channel from the raw event (needed for Redirect)
    const channel = rawEvent['Channel'] || rawEvent['DestChannel'];

    if (!ringingCall) {
      // First time seeing this call ring
      const callerNumber = callInfo.callerIdNum || 'Inconnu';
      const callerName = callInfo.callerIdName || null;
      const lineName = this.extractLineName(callerName) || this.extractLineName(callInfo.trunkName);

      // Format caller number
      let formattedNumber = callerNumber;
      if (formattedNumber.startsWith('+590')) {
        formattedNumber = '0' + formattedNumber.substring(4);
      }

      const callData = {
        callId: callId,
        callerNumber: formattedNumber,
        callerName: this.isTrunkNumber(callerName) ? null : callerName,
        lineName: lineName,
        extension: extension,
        channel: channel, // Store channel for Redirect
        startTime: Date.now(),
        direction: 'incoming',
        status: 'ringing'
      };

      ringingCall = {
        callData,
        channel: channel,
        notifiedAt: Date.now(),
        extensionsRinging: new Set([extension])
      };

      this.ringingCalls.set(callId, ringingCall);

      // Emit the incoming call event
      logger.info(`[AMI] 📞 INCOMING CALL: ${formattedNumber} -> ext ${extension} [${lineName || 'direct'}] (channel: ${channel})`);
      this.emit('incomingCall', callData);

      // Broadcast via PushService
      pushService.broadcast(pushService.eventTypes.INCOMING_CALL || 'incoming_call', callData);

    } else {
      // Already notified, but maybe ringing on additional extension
      if (!ringingCall.extensionsRinging.has(extension)) {
        ringingCall.extensionsRinging.add(extension);
        logger.info(`[AMI] 📞 Call ${callId} also ringing on ext ${extension}`);
      }
      // Update channel if we have a better one
      if (channel && !ringingCall.channel) {
        ringingCall.channel = channel;
        ringingCall.callData.channel = channel;
      }
    }
  }

  /**
   * Handle when a ringing call is answered or ends
   */
  handleRingingCallEnd(callId, reason) {
    const ringingCall = this.ringingCalls.get(callId);
    if (ringingCall) {
      logger.info(`[AMI] 📞 Ringing call ${callId} ended: ${reason}`);

      // Emit call ended event
      this.emit('callEnded', {
        ...ringingCall.callData,
        status: reason, // 'answered' or 'missed' or 'rejected'
        endTime: Date.now()
      });

      // Broadcast call ended
      pushService.broadcast('call_ended', {
        callId: callId,
        status: reason
      });

      this.ringingCalls.delete(callId);
    }
  }

  /**
   * Answer an incoming call by redirecting it to a specific extension
   * This uses AMI Redirect to move the ringing channel to the target extension
   *
   * @param {string} callId - The call ID from ringingCalls
   * @param {string} targetExtension - The extension to redirect to (e.g., '200' for WebRTC)
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async answerCall(callId, targetExtension) {
    const ringingCall = this.ringingCalls.get(callId);

    if (!ringingCall) {
      logger.warn(`[AMI] answerCall: Call ${callId} not found in ringing calls`);
      return { success: false, message: 'Appel non trouvé ou déjà terminé' };
    }

    if (!this.connected || !this.authenticated) {
      logger.error('[AMI] answerCall: Not connected to AMI');
      return { success: false, message: 'Non connecté au PBX' };
    }

    // Find the channel to redirect
    // We need to find the trunk/incoming channel, not the extension channel
    let channelToRedirect = null;

    // Search in activeCalls for the trunk channel associated with this call
    for (const [channel, callInfo] of this.activeCalls) {
      if (callInfo.uniqueId === callId ||
          channel.includes('GSM') ||
          channel.includes('Chiro') ||
          channel.includes('Osteo')) {
        // This is likely the incoming trunk channel
        if (callInfo.status === 'ringing' || !callInfo.answerTime) {
          channelToRedirect = channel;
          break;
        }
      }
    }

    // Fallback to the channel stored in ringingCall
    if (!channelToRedirect && ringingCall.channel) {
      channelToRedirect = ringingCall.channel;
    }

    if (!channelToRedirect) {
      logger.error(`[AMI] answerCall: No channel found for call ${callId}`);
      return { success: false, message: 'Canal d\'appel non trouvé' };
    }

    logger.info(`[AMI] 📞 Redirecting call ${callId} from ${channelToRedirect} to extension ${targetExtension}`);

    // Send Redirect action to AMI
    // This will move the incoming call to the target extension
    return new Promise((resolve) => {
      const actionId = `redirect_${Date.now()}`;

      // Set up a timeout for the response
      const timeout = setTimeout(() => {
        logger.warn(`[AMI] answerCall: Timeout waiting for redirect response`);
        resolve({ success: false, message: 'Timeout en attente de réponse' });
      }, 5000);

      // Listen for the response
      const responseHandler = (data) => {
        if (data.includes(actionId)) {
          clearTimeout(timeout);
          if (data.includes('Success')) {
            logger.info(`[AMI] 📞 Call ${callId} successfully redirected to ${targetExtension}`);
            resolve({ success: true, message: 'Appel redirigé' });
          } else {
            logger.error(`[AMI] answerCall: Redirect failed - ${data}`);
            resolve({ success: false, message: 'Échec de la redirection' });
          }
        }
      };

      // Temporarily listen for data
      this.socket.once('data', (buffer) => responseHandler(buffer.toString()));

      // Send the Redirect action
      this.sendAction({
        Action: 'Redirect',
        ActionID: actionId,
        Channel: channelToRedirect,
        Exten: targetExtension,
        Context: 'from-internal',
        Priority: '1'
      });
    });
  }

  /**
   * Reject an incoming call by hanging up the channel
   *
   * @param {string} callId - The call ID from ringingCalls
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async rejectCall(callId) {
    const ringingCall = this.ringingCalls.get(callId);

    if (!ringingCall) {
      logger.warn(`[AMI] rejectCall: Call ${callId} not found in ringing calls`);
      return { success: false, message: 'Appel non trouvé ou déjà terminé' };
    }

    if (!this.connected || !this.authenticated) {
      logger.error('[AMI] rejectCall: Not connected to AMI');
      return { success: false, message: 'Non connecté au PBX' };
    }

    // Find all channels associated with this call and hang them up
    const channelsToHangup = [];

    for (const [channel, callInfo] of this.activeCalls) {
      if (callInfo.uniqueId === callId) {
        channelsToHangup.push(channel);
      }
    }

    // Add the channel from ringingCall if not already included
    if (ringingCall.channel && !channelsToHangup.includes(ringingCall.channel)) {
      channelsToHangup.push(ringingCall.channel);
    }

    if (channelsToHangup.length === 0) {
      logger.warn(`[AMI] rejectCall: No channels found for call ${callId}`);
      return { success: false, message: 'Aucun canal trouvé' };
    }

    logger.info(`[AMI] 📞 Rejecting call ${callId} - hanging up ${channelsToHangup.length} channel(s)`);

    // Hang up all associated channels
    for (const channel of channelsToHangup) {
      this.sendAction({
        Action: 'Hangup',
        Channel: channel,
        Cause: '21' // Call rejected
      });
    }

    // Mark call as rejected
    this.handleRingingCallEnd(callId, 'rejected');

    return { success: true, message: 'Appel rejeté' };
  }

  /**
   * Get list of currently ringing calls
   */
  getRingingCalls() {
    const calls = [];
    for (const [callId, ringingCall] of this.ringingCalls) {
      calls.push({
        ...ringingCall.callData,
        extensionsRinging: Array.from(ringingCall.extensionsRinging)
      });
    }
    return calls;
  }

  /**
   * Handle dial end
   */
  handleDialEnd(event) {
    const channel = event['Channel'];
    const dialStatus = event['DialStatus'];
    const uniqueId = event['Uniqueid'] || event['UniqueID'];
    const linkedId = event['Linkedid'];

    const callInfo = this.activeCalls.get(channel);
    if (callInfo) {
      callInfo.dialStatus = dialStatus;

      if (dialStatus === 'ANSWER') {
        callInfo.answerTime = Date.now();
        callInfo.status = 'answered';
        // Stop ringing notification
        this.handleRingingCallEnd(linkedId || uniqueId, 'answered');
      } else if (['BUSY', 'NOANSWER', 'CANCEL', 'CONGESTION'].includes(dialStatus)) {
        callInfo.status = dialStatus.toLowerCase();
        // Stop ringing notification with appropriate status
        const status = dialStatus === 'NOANSWER' ? 'missed' : dialStatus.toLowerCase();
        this.handleRingingCallEnd(linkedId || uniqueId, status);
      }
    }
  }

  /**
   * Handle bridge (call connected)
   */
  handleBridge(event) {
    const channel1 = event['Channel1'] || event['Channel'];
    const channel2 = event['Channel2'];
    const bridgeId = event['BridgeUniqueid'] || event['Uniqueid'];
    const linkedId = event['Linkedid'];

    // Link the two channels
    this.callBridges.set(bridgeId, { channel1, channel2 });

    // Update both channels as answered
    for (const channel of [channel1, channel2]) {
      if (channel) {
        const callInfo = this.activeCalls.get(channel);
        if (callInfo && !callInfo.answerTime) {
          callInfo.answerTime = Date.now();
          callInfo.status = 'answered';
        }
      }
    }

    // Stop ringing notification - call was answered
    this.handleRingingCallEnd(linkedId || bridgeId, 'answered');

    logger.info(`[AMI] Bridge: ${channel1} <-> ${channel2}`);
  }

  /**
   * Handle hangup (call ended)
   * Note: We don't save to DB here - we let the CDR event handle it
   * because CDR has complete and accurate information
   */
  handleHangup(event) {
    const channel = event['Channel'];
    const cause = event['Cause'];
    const causeTxt = event['Cause-txt'];
    const uniqueId = event['Uniqueid'] || event['UniqueID'];
    const linkedId = event['Linkedid'];

    const callInfo = this.activeCalls.get(channel);
    if (!callInfo) return;

    callInfo.endTime = Date.now();
    callInfo.hangupCause = cause;
    callInfo.hangupCauseTxt = causeTxt;

    // Determine final status
    if (callInfo.status === 'answered') {
      callInfo.status = 'answered';
    } else if (cause === '16' || cause === '17') {
      // Normal clearing or user busy
      callInfo.status = callInfo.answerTime ? 'answered' : 'missed';
    } else {
      callInfo.status = 'failed';
    }

    // Stop ringing notification if call was still ringing
    const finalStatus = callInfo.answerTime ? 'answered' : 'missed';
    this.handleRingingCallEnd(linkedId || uniqueId, finalStatus);

    // Don't save here - let CDR event handle it with complete info
    // The CDR event fires shortly after Hangup with accurate source/destination

    // Cleanup
    this.activeCalls.delete(channel);

    logger.info(`[AMI] Hangup: ${channel} - ${causeTxt} (${cause}) - waiting for CDR`);
  }

  /**
   * Handle CDR event (complete call record)
   */
  handleCdr(event) {
    // Debug: log all CDR fields to find real caller ID
    if (process.env.AMI_DEBUG === 'true') {
      logger.info(`[AMI] DEBUG CDR ALL FIELDS: ${JSON.stringify(event)}`);
    }

    let source = event['Source'] || event['CallerID'];
    const destination = event['Destination'];
    const channel = event['Channel'] || '';
    const dcontext = event['DestinationContext'] || '';
    const did = event['did'] || event['DNID'] || null; // DID that was called
    const cnam = event['cnam'] || '';

    // Detect gateway calls (for direction detection)
    const isGatewayCall = cnam.toLowerCase().includes('quectel') ||
      source.toLowerCase().includes('gateway') ||
      channel.includes('GSM');

    // Clean up source - only mask if it literally says "gateway" or is empty
    if (!source || source.toLowerCase() === 'gsm-gateway' || source === '<unknown>') {
      source = did || 'Numéro masqué';
    }
    // Format phone number nicely (remove +590 prefix for local display)
    if (source && source.startsWith('+590')) {
      source = '0' + source.substring(4);
    }

    // Determine call direction based on context
    const isIncomingCall = dcontext.includes('ext-group') || dcontext.includes('from-did') || isGatewayCall;
    const isOutgoingCall = dcontext.includes('outbound') || dcontext.includes('from-internal');

    // For outgoing calls: skip if it's just the trunk leg (we track extension leg)
    if (!isIncomingCall && this.isTrunkNumber(destination)) {
      logger.debug(`[AMI] Skipping CDR outbound trunk: ${source} -> ${destination}`);
      return;
    }

    // Skip invalid destinations (but not for incoming calls)
    if (!isIncomingCall && (!destination || destination === 's' || destination.length < 3)) {
      logger.debug(`[AMI] Skipping CDR invalid destination: ${destination}`);
      return;
    }

    // Extract line name (Chiro/Osteo) from cnam or channel
    const trunkName = this.extractTrunkName(channel);
    let lineName = this.extractLineName(cnam) || this.extractLineName(trunkName);

    // Format DID for display
    const didDisplay = did ? did.replace(/^\+590/, '0') : null;

    const callData = {
      id: `pbx_${event['UniqueID'] || Date.now()}`,
      direction: isIncomingCall ? 'incoming' : 'outgoing',
      callerNumber: source,
      calledNumber: isIncomingCall ? didDisplay || destination : destination,
      callerName: isGatewayCall ? null : (event['CallerIDName'] || null),
      lineName: lineName,
      startTime: this.parseAmiTime(event['StartTime']),
      answerTime: event['AnswerTime'] ? this.parseAmiTime(event['AnswerTime']) : null,
      endTime: this.parseAmiTime(event['EndTime']),
      duration: parseInt(event['Duration']) || 0,
      billableSeconds: parseInt(event['BillableSeconds']) || 0,
      status: this.mapDisposition(event['Disposition']),
      source: 'freepbx',
      pbxCallId: event['UniqueID'],
      rawData: event
    };

    logger.info(`[AMI] CDR Processing: ${source} -> ${destination} [${lineName || 'direct'}] (${callData.direction}, ${callData.status})`);
    this.saveCallToHistoryFromCdr(callData);
  }

  /**
   * Determine call direction
   */
  determineDirection(context, callerIdNum) {
    // Incoming calls typically come from 'from-trunk' or 'from-pstn'
    if (context && (context.includes('trunk') || context.includes('pstn') || context.includes('did'))) {
      return 'incoming';
    }
    // Internal extensions start with short numbers
    if (callerIdNum && callerIdNum.length <= 4) {
      return 'outgoing';
    }
    return 'unknown';
  }

  /**
   * Determine direction from CDR
   */
  determineDirectionFromCdr(event) {
    const dcontext = event['DestinationContext'] || '';
    const source = event['Source'] || '';

    if (dcontext.includes('outbound') || dcontext.includes('from-internal')) {
      return 'outgoing';
    }
    if (source.length > 6) {
      return 'incoming';
    }
    return 'outgoing';
  }

  /**
   * Map AMI disposition to our status
   */
  mapDisposition(disposition) {
    const map = {
      'ANSWERED': 'answered',
      'NO ANSWER': 'missed',
      'BUSY': 'busy',
      'FAILED': 'failed',
      'CONGESTION': 'failed'
    };
    return map[disposition] || 'unknown';
  }

  /**
   * Parse AMI time format
   */
  parseAmiTime(timeStr) {
    if (!timeStr) return null;
    const date = new Date(timeStr);
    return Math.floor(date.getTime() / 1000);
  }

  /**
   * Save call to history database
   */
  saveCallToHistory(callInfo) {
    try {
      // Extract clean line name (Chiro/Osteo) from trunk name or caller ID name
      let lineName = this.extractLineName(callInfo.trunkName) ||
                     this.extractLineName(callInfo.callerIdName);

      const callData = {
        id: `pbx_${callInfo.uniqueId}`,
        direction: callInfo.direction,
        callerNumber: callInfo.callerIdNum || 'unknown',
        calledNumber: callInfo.exten || callInfo.dialString || 'unknown',
        callerName: callInfo.callerIdName || null,
        lineName: lineName,
        startTime: Math.floor(callInfo.startTime / 1000),
        answerTime: callInfo.answerTime ? Math.floor(callInfo.answerTime / 1000) : null,
        endTime: callInfo.endTime ? Math.floor(callInfo.endTime / 1000) : null,
        duration: callInfo.answerTime && callInfo.endTime
          ? Math.floor((callInfo.endTime - callInfo.answerTime) / 1000)
          : 0,
        status: callInfo.status === 'answered' ? 'answered' : 'missed',
        source: 'freepbx',
        pbxCallId: callInfo.uniqueId
      };

      // Check if call already exists
      const existing = db.getCallByPbxId(callData.pbxCallId);
      if (existing) {
        logger.debug(`[AMI] Call ${callData.pbxCallId} already exists, skipping`);
        return;
      }

      db.createCall(callData);
      logger.info(`[AMI] Call saved: ${callData.callerNumber} -> ${callData.calledNumber} (${callData.status}) [${lineName || 'direct'}]`);

      // Broadcast to connected clients
      if (callData.status === 'missed') {
        pushService.broadcast(pushService.eventTypes.MISSED_CALL, callData);
      }
      pushService.broadcast(pushService.eventTypes.CALL_HISTORY_UPDATE, { reason: 'pbx_call' });

    } catch (error) {
      logger.error('[AMI] Error saving call:', error);
    }
  }

  /**
   * Save call from CDR event
   */
  saveCallToHistoryFromCdr(callData) {
    try {
      // Check if call already exists
      const existing = db.getCallByPbxId(callData.pbxCallId);
      if (existing) {
        logger.debug(`[AMI] CDR Call ${callData.pbxCallId} already exists, skipping`);
        return;
      }

      db.createCall(callData);
      logger.info(`[AMI] CDR Call saved: ${callData.callerNumber} -> ${callData.calledNumber} (${callData.status})`);

      // Broadcast to connected clients
      if (callData.status === 'missed') {
        pushService.broadcast(pushService.eventTypes.MISSED_CALL, callData);
      }
      pushService.broadcast(pushService.eventTypes.CALL_HISTORY_UPDATE, { reason: 'pbx_cdr' });

    } catch (error) {
      logger.error('[AMI] Error saving CDR call:', error);
    }
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      connected: this.connected,
      authenticated: this.authenticated,
      host: this.config.host,
      activeCalls: this.activeCalls.size
    };
  }

  // =====================================================
  // PJSIP Extension Management for WebRTC Users
  // =====================================================

  /**
   * Create a PJSIP extension for WebRTC
   * Uses FreePBX API first (visible in GUI), falls back to config file
   *
   * @param {object} extensionData - Extension configuration
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async createPjsipExtension(extensionData) {
    const {
      extension,
      secret,
      displayName,
      context = 'from-internal',
      transport = 'transport-wss',
      codecs = 'g722,ulaw,alaw,opus',
      useApiOnly = false  // Force API-only (no config file fallback)
    } = extensionData;

    // Try FreePBX API first (extensions visible in FreePBX GUI)
    try {
      const freepbxApi = require('./FreePBXApiService');

      if (await freepbxApi.isAvailable()) {
        logger.info(`[AMI] Trying FreePBX API for extension ${extension}...`);

        const apiResult = await freepbxApi.createExtension({
          extension,
          secret,
          displayName,
          webrtc: true,
          context
        });

        if (apiResult.success) {
          logger.info(`[AMI] Extension ${extension} created via FreePBX API (visible in GUI)`);
          return {
            success: true,
            message: `Extension ${extension} créée (visible dans FreePBX)`,
            extension,
            secret,
            visibleInFreePBX: true
          };
        }

        // API failed but extension might already exist
        if (apiResult.message && apiResult.message.includes('existe')) {
          return { success: false, message: apiResult.message };
        }

        logger.warn(`[AMI] FreePBX API failed: ${apiResult.message}, trying config file...`);
      }
    } catch (apiError) {
      logger.warn(`[AMI] FreePBX API not available: ${apiError.message}`);
    }

    // If API-only mode requested, don't fall back
    if (useApiOnly) {
      return { success: false, message: 'FreePBX API non disponible' };
    }

    // Fallback: Write to config file (Option A)
    return await this.createPjsipExtensionViaConfigFile(extensionData);
  }

  /**
   * Create extension via config file (fallback method)
   * Extension works but is NOT visible in FreePBX GUI
   */
  async createPjsipExtensionViaConfigFile(extensionData) {
    const {
      extension,
      secret,
      displayName,
      context = 'from-internal',
      transport = 'transport-wss',
      codecs = 'g722,ulaw,alaw,opus'
    } = extensionData;

    try {
      // Check if extension already exists in config file
      if (this.extensionExistsInConfig(extension)) {
        logger.warn(`[AMI] Extension ${extension} already exists in pjsip_custom.conf`);
        return { success: false, message: `Extension ${extension} existe déjà` };
      }

      // Generate PJSIP configuration block for this extension
      const configBlock = `
; ============================================
; Extension ${extension} - Created by Homenichat
; Created: ${new Date().toISOString()}
; NOTE: Not visible in FreePBX GUI (config file method)
; ============================================
[${extension}]
type=endpoint
context=${context}
auth=auth_${extension}
aors=${extension}
callerid="${displayName || 'Homenichat'}" <${extension}>
webrtc=yes
dtls_auto_generate_cert=yes
direct_media=no
ice_support=yes
media_encryption=dtls
media_use_received_transport=yes
rtcp_mux=yes
disallow=all
allow=${codecs}
transport=${transport}

[auth_${extension}]
type=auth
auth_type=userpass
username=${extension}
password=${secret}

[${extension}]
type=aor
max_contacts=5
remove_existing=yes
qualify_frequency=30
; END Extension ${extension}
`;

      // Append to pjsip_custom.conf
      fs.appendFileSync(PJSIP_CUSTOM_CONF, configBlock);
      logger.info(`[AMI] Extension ${extension} added to ${PJSIP_CUSTOM_CONF}`);

      // Reload PJSIP module to apply changes
      if (this.connected && this.authenticated) {
        await this.reloadPjsip();
      } else {
        logger.warn('[AMI] Not connected - extension created but PJSIP not reloaded');
      }

      logger.info(`[AMI] PJSIP extension ${extension} created via config file`);
      return {
        success: true,
        message: `Extension ${extension} créée (config file)`,
        extension,
        secret,
        visibleInFreePBX: false
      };

    } catch (error) {
      logger.error(`[AMI] Error creating PJSIP extension ${extension}:`, error);
      return { success: false, message: error.message };
    }
  }

  /**
   * Check if an extension already exists in pjsip_custom.conf
   */
  extensionExistsInConfig(extension) {
    try {
      if (!fs.existsSync(PJSIP_CUSTOM_CONF)) {
        return false;
      }
      const content = fs.readFileSync(PJSIP_CUSTOM_CONF, 'utf8');
      // Look for the extension section header
      const pattern = new RegExp(`^\\[${extension}\\]$`, 'm');
      return pattern.test(content);
    } catch (error) {
      logger.error(`[AMI] Error checking extension in config:`, error);
      return false;
    }
  }

  /**
   * Delete a PJSIP extension
   * Tries FreePBX API first, then falls back to config file
   *
   * @param {string} extension - Extension number to delete
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async deletePjsipExtension(extension) {
    // Try FreePBX API first
    try {
      const freepbxApi = require('./FreePBXApiService');

      if (await freepbxApi.isAvailable()) {
        const exists = await freepbxApi.extensionExists(extension);

        if (exists) {
          const apiResult = await freepbxApi.deleteExtension(extension);
          if (apiResult.success) {
            logger.info(`[AMI] Extension ${extension} deleted via FreePBX API`);
            return { success: true, message: `Extension ${extension} supprimée de FreePBX` };
          }
        }
      }
    } catch (apiError) {
      logger.warn(`[AMI] FreePBX API delete failed: ${apiError.message}`);
    }

    // Also try to remove from config file (in case it exists there)
    return await this.deletePjsipExtensionFromConfigFile(extension);
  }

  /**
   * Delete extension from config file
   */
  async deletePjsipExtensionFromConfigFile(extension) {
    try {
      // Check if extension exists in config file
      if (!this.extensionExistsInConfig(extension)) {
        logger.warn(`[AMI] Extension ${extension} not found in pjsip_custom.conf`);
        return { success: false, message: `Extension ${extension} introuvable` };
      }

      // Read the config file
      if (!fs.existsSync(PJSIP_CUSTOM_CONF)) {
        return { success: false, message: 'Fichier pjsip_custom.conf introuvable' };
      }

      let content = fs.readFileSync(PJSIP_CUSTOM_CONF, 'utf8');

      // Remove the extension block (from header comment to END comment)
      const blockPattern = new RegExp(
        `\\n?; =+\\n; Extension ${extension} - Created by Homenichat[\\s\\S]*?; END Extension ${extension}\\n?`,
        'g'
      );

      const newContent = content.replace(blockPattern, '\n');

      // Also remove any standalone sections for this extension
      const sectionPatterns = [
        new RegExp(`\\n\\[${extension}\\]\\ntype=endpoint[\\s\\S]*?(?=\\n\\[|$)`, 'g'),
        new RegExp(`\\n\\[auth_${extension}\\]\\ntype=auth[\\s\\S]*?(?=\\n\\[|$)`, 'g'),
        new RegExp(`\\n\\[${extension}\\]\\ntype=aor[\\s\\S]*?(?=\\n\\[|$)`, 'g'),
      ];

      let finalContent = newContent;
      for (const pattern of sectionPatterns) {
        finalContent = finalContent.replace(pattern, '\n');
      }

      // Clean up multiple consecutive newlines
      finalContent = finalContent.replace(/\n{3,}/g, '\n\n');

      // Write the updated config
      fs.writeFileSync(PJSIP_CUSTOM_CONF, finalContent);
      logger.info(`[AMI] Extension ${extension} removed from ${PJSIP_CUSTOM_CONF}`);

      // Reload PJSIP module to apply changes
      if (this.connected && this.authenticated) {
        await this.reloadPjsip();
      } else {
        logger.warn('[AMI] Not connected - extension deleted but PJSIP not reloaded');
      }

      logger.info(`[AMI] PJSIP extension ${extension} deleted from config file`);
      return { success: true, message: `Extension ${extension} supprimée` };

    } catch (error) {
      logger.error(`[AMI] Error deleting PJSIP extension ${extension}:`, error);
      return { success: false, message: error.message };
    }
  }

  /**
   * Update PJSIP extension secret/password
   * Tries FreePBX API first, then falls back to config file
   *
   * @param {string} extension - Extension number
   * @param {string} newSecret - New password
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async updatePjsipExtensionSecret(extension, newSecret) {
    // Try FreePBX API first
    try {
      const freepbxApi = require('./FreePBXApiService');

      if (await freepbxApi.isAvailable()) {
        const exists = await freepbxApi.extensionExists(extension);

        if (exists) {
          const apiResult = await freepbxApi.updateExtensionSecret(extension, newSecret);
          if (apiResult.success) {
            logger.info(`[AMI] Extension ${extension} password updated via FreePBX API`);
            return { success: true, message: `Mot de passe mis à jour pour ${extension}` };
          }
        }
      }
    } catch (apiError) {
      logger.warn(`[AMI] FreePBX API update failed: ${apiError.message}`);
    }

    // Fallback: update in config file
    return await this.updatePjsipExtensionSecretInConfigFile(extension, newSecret);
  }

  /**
   * Update extension secret in config file (fallback)
   */
  async updatePjsipExtensionSecretInConfigFile(extension, newSecret) {
    try {
      // Check if extension exists in config file
      if (!this.extensionExistsInConfig(extension)) {
        return { success: false, message: `Extension ${extension} introuvable` };
      }

      // Read the config file
      if (!fs.existsSync(PJSIP_CUSTOM_CONF)) {
        return { success: false, message: 'Fichier pjsip_custom.conf introuvable' };
      }

      let content = fs.readFileSync(PJSIP_CUSTOM_CONF, 'utf8');

      // Find and replace the password line in the auth section
      const authSectionPattern = new RegExp(
        `(\\[auth_${extension}\\][\\s\\S]*?password=)[^\\n]+`,
        'g'
      );

      if (!authSectionPattern.test(content)) {
        return { success: false, message: `Section auth pour ${extension} introuvable` };
      }

      // Reset the pattern (test() advances lastIndex)
      authSectionPattern.lastIndex = 0;

      const newContent = content.replace(authSectionPattern, `$1${newSecret}`);

      // Write the updated config
      fs.writeFileSync(PJSIP_CUSTOM_CONF, newContent);
      logger.info(`[AMI] Password updated for extension ${extension} in ${PJSIP_CUSTOM_CONF}`);

      // Reload PJSIP module to apply changes
      if (this.connected && this.authenticated) {
        await this.reloadPjsip();
      } else {
        logger.warn('[AMI] Not connected - password updated but PJSIP not reloaded');
      }

      logger.info(`[AMI] PJSIP extension ${extension} password updated in config file`);
      return { success: true, message: `Mot de passe mis à jour pour ${extension}` };

    } catch (error) {
      logger.error(`[AMI] Error updating PJSIP extension ${extension}:`, error);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get PJSIP extension status (registration info)
   *
   * @param {string} extension - Extension number
   * @returns {Promise<object>}
   */
  async getPjsipExtensionStatus(extension) {
    if (!this.connected || !this.authenticated) {
      return { registered: false, error: 'Non connecté au PBX' };
    }

    return new Promise((resolve) => {
      const actionId = `pjsip_status_${Date.now()}`;
      let responseData = '';

      const timeout = setTimeout(() => {
        resolve({ registered: false, extension });
      }, 5000);

      const handler = (data) => {
        responseData += data.toString();
        if (responseData.includes('EndpointDetail') && responseData.includes(actionId)) {
          clearTimeout(timeout);

          const isRegistered = responseData.includes('DeviceState: In use') ||
                              responseData.includes('DeviceState: Not in use') ||
                              responseData.includes('Contacts:');

          resolve({
            extension,
            registered: isRegistered,
            deviceState: this.extractValue(responseData, 'DeviceState'),
            contacts: this.extractValue(responseData, 'Contacts')
          });
        }
      };

      this.socket.on('data', handler);

      setTimeout(() => {
        this.socket.removeListener('data', handler);
      }, 6000);

      this.sendAction({
        Action: 'PJSIPShowEndpoint',
        ActionID: actionId,
        Endpoint: extension
      });
    });
  }

  /**
   * Send DBput command to Asterisk
   */
  sendDbPut(family, key, value) {
    return new Promise((resolve, reject) => {
      const actionId = `dbput_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for DBput response'));
      }, 5000);

      const handler = (data) => {
        const str = data.toString();
        if (str.includes(actionId)) {
          clearTimeout(timeout);
          this.socket.removeListener('data', handler);

          if (str.includes('Success')) {
            resolve({ success: true });
          } else {
            reject(new Error(`DBput failed: ${str}`));
          }
        }
      };

      this.socket.on('data', handler);

      this.sendAction({
        Action: 'DBPut',
        ActionID: actionId,
        Family: family,
        Key: key,
        Val: value
      });
    });
  }

  /**
   * Send DBDelTree command to Asterisk (delete family tree)
   */
  sendDbDelTree(family) {
    return new Promise((resolve, reject) => {
      const actionId = `dbdel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const timeout = setTimeout(() => {
        // Not critical if delete times out - family may not exist
        resolve({ success: true, message: 'Timeout - family may not exist' });
      }, 5000);

      const handler = (data) => {
        const str = data.toString();
        if (str.includes(actionId)) {
          clearTimeout(timeout);
          this.socket.removeListener('data', handler);
          resolve({ success: true });
        }
      };

      this.socket.on('data', handler);

      this.sendAction({
        Action: 'DBDelTree',
        ActionID: actionId,
        Family: family
      });
    });
  }

  /**
   * Reload PJSIP module
   */
  reloadPjsip() {
    return new Promise((resolve, reject) => {
      const actionId = `reload_${Date.now()}`;

      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for PJSIP reload'));
      }, 10000);

      const handler = (data) => {
        const str = data.toString();
        if (str.includes(actionId)) {
          clearTimeout(timeout);
          this.socket.removeListener('data', handler);

          if (str.includes('Success')) {
            resolve({ success: true });
          } else {
            reject(new Error(`PJSIP reload failed: ${str}`));
          }
        }
      };

      this.socket.on('data', handler);

      this.sendAction({
        Action: 'Command',
        ActionID: actionId,
        Command: 'pjsip reload'
      });
    });
  }

  /**
   * Extract value from AMI response
   */
  extractValue(response, key) {
    const regex = new RegExp(`${key}:\\s*(.+?)\\r?\\n`, 'i');
    const match = response.match(regex);
    return match ? match[1].trim() : null;
  }

  // =====================================================
  // GSM Modem Trunk Configuration (chan_quectel)
  // =====================================================
  //
  // With FreePBX API (Option B), trunks are created via FreePBX Core
  // and are visible in the FreePBX GUI for unified management.
  //
  // Fallback: dialplan-only routing via extensions_homenichat.conf

  /**
   * Configure a GSM modem trunk
   * Uses FreePBX API first (visible in GUI), falls back to dialplan-only
   *
   * @param {object} modemData - Modem configuration
   * @returns {Promise<{success: boolean, message: string, dialString: string}>}
   */
  async createModemTrunk(modemData) {
    const {
      modemId,         // chan_quectel device name (e.g., 'modem-1')
      modemName,       // Display name for the trunk
      phoneNumber,     // Phone number associated with the modem
    } = modemData;

    const trunkName = `GSM-${modemId}`.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    const dialString = `Quectel/${modemId}/$OUTNUM$`;

    try {
      logger.info(`[AMI] Configuring GSM modem ${modemId} (${modemName || 'unnamed'})`);

      // Try FreePBX API first (trunk visible in FreePBX GUI)
      let trunkCreatedViaApi = false;
      try {
        const freepbxApi = require('./FreePBXApiService');

        if (await freepbxApi.isAvailable()) {
          logger.info(`[AMI] Trying FreePBX API for trunk ${trunkName}...`);

          const apiResult = await freepbxApi.createTrunk({
            modemId,
            modemName: modemName || modemId,
            phoneNumber: phoneNumber || ''
          });

          if (apiResult.success) {
            logger.info(`[AMI] Trunk ${trunkName} created via FreePBX API (visible in GUI)`);
            trunkCreatedViaApi = true;
          } else {
            logger.warn(`[AMI] FreePBX API trunk creation failed: ${apiResult.message}`);
          }
        }
      } catch (apiError) {
        logger.warn(`[AMI] FreePBX API not available for trunk: ${apiError.message}`);
      }

      // Auto-create WebRTC extension if requested
      let webrtcExtension = null;
      if (modemData.createWebRtcExtension !== false) {
        try {
          const extensionNumber = modemData.webrtcExtension || '200';
          const extensionSecret = modemData.webrtcSecret || this.generateSecret();

          const extResult = await this.createPjsipExtension({
            extension: extensionNumber,
            secret: extensionSecret,
            displayName: `WebRTC ${modemName || modemId}`,
            context: 'from-internal',
            transport: 'transport-wss',
            codecs: 'g722,ulaw,alaw,opus'
          });

          if (extResult.success) {
            webrtcExtension = {
              extension: extensionNumber,
              secret: extensionSecret,
              created: true,
              visibleInFreePBX: extResult.visibleInFreePBX || false
            };
            logger.info(`[AMI] WebRTC extension ${extensionNumber} created for modem ${modemId}`);
          } else if (extResult.message && extResult.message.includes('existe')) {
            webrtcExtension = {
              extension: extensionNumber,
              created: false,
              message: 'Extension existe déjà'
            };
          }
        } catch (extError) {
          logger.warn(`[AMI] Could not create WebRTC extension: ${extError.message}`);
        }
      }

      logger.info(`[AMI] GSM modem ${modemId} configured. Dial string: ${dialString}`);

      return {
        success: true,
        message: trunkCreatedViaApi
          ? `Trunk ${trunkName} créé (visible dans FreePBX)`
          : `Modem ${modemName || modemId} configuré (routage via dialplan)`,
        trunkName,
        dialString,
        phoneNumber: phoneNumber || null,
        webrtcExtension,
        visibleInFreePBX: trunkCreatedViaApi,
        note: trunkCreatedViaApi
          ? 'Trunk visible dans FreePBX → Connectivity → Trunks'
          : 'Routage via extensions_homenichat.conf'
      };

    } catch (error) {
      logger.error(`[AMI] Error configuring modem ${modemId}:`, error);
      return { success: false, message: error.message };
    }
  }

  /**
   * Generate a random secret for SIP authentication
   */
  generateSecret(length = 16) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * Delete a modem trunk configuration
   * With FreePBX, there's nothing in AstDB to delete.
   * Optionally deletes the associated WebRTC extension.
   *
   * @param {string} modemId - Modem identifier
   * @param {string} webrtcExtension - Optional extension to delete
   */
  async deleteModemTrunk(modemId, webrtcExtension = null) {
    const trunkName = `GSM-${modemId}`.toUpperCase().replace(/[^A-Z0-9-]/g, '');

    try {
      // With FreePBX, trunk routing is handled by dialplan
      // There's nothing in AstDB to delete

      // If a WebRTC extension was associated, delete it
      if (webrtcExtension) {
        const extResult = await this.deletePjsipExtension(webrtcExtension);
        if (extResult.success) {
          logger.info(`[AMI] WebRTC extension ${webrtcExtension} deleted for modem ${modemId}`);
        }
      }

      logger.info(`[AMI] GSM modem ${modemId} configuration removed`);
      return {
        success: true,
        message: `Configuration du modem ${modemId} supprimée`,
        note: 'Le dialplan extensions_homenichat.conf peut encore contenir des routes pour ce modem.'
      };

    } catch (error) {
      logger.error(`[AMI] Error deleting modem configuration:`, error);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get modem trunk status
   * With FreePBX, checks if the modem is available via chan_quectel
   */
  async getModemTrunkStatus(modemId) {
    const trunkName = `GSM-${modemId}`.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    const dialString = `Quectel/${modemId}/$OUTNUM$`;

    if (!this.connected || !this.authenticated) {
      return {
        modemId,
        trunkName,
        dialString,
        connected: false,
        error: 'Non connecté au PBX'
      };
    }

    // Try to get modem status via quectel show devices command
    return new Promise((resolve) => {
      const actionId = `modem_status_${Date.now()}`;
      let responseData = '';

      const timeout = setTimeout(() => {
        resolve({
          modemId,
          trunkName,
          dialString,
          connected: true,
          modemStatus: 'unknown',
          note: 'Utilisez "asterisk -rx quectel show devices" pour vérifier l\'état du modem'
        });
      }, 5000);

      const handler = (data) => {
        responseData += data.toString();
        if (responseData.includes(actionId) && responseData.includes('--END COMMAND--')) {
          clearTimeout(timeout);
          this.socket.removeListener('data', handler);

          // Parse quectel show devices output
          const modemFound = responseData.toLowerCase().includes(modemId.toLowerCase());
          const isFree = responseData.includes('Free') || responseData.includes('GSM');

          resolve({
            modemId,
            trunkName,
            dialString,
            connected: true,
            modemStatus: modemFound ? (isFree ? 'available' : 'busy') : 'not_found',
            rawOutput: responseData.substring(0, 500) // First 500 chars for debug
          });
        }
      };

      this.socket.on('data', handler);

      setTimeout(() => {
        this.socket.removeListener('data', handler);
      }, 6000);

      this.sendAction({
        Action: 'Command',
        ActionID: actionId,
        Command: 'quectel show devices'
      });
    });
  }

  /**
   * Send a CLI command to Asterisk
   */
  sendCommand(command) {
    return new Promise((resolve, reject) => {
      const actionId = `cmd_${Date.now()}`;

      const timeout = setTimeout(() => {
        resolve({ success: true, message: 'Command sent' });
      }, 5000);

      const handler = (data) => {
        const str = data.toString();
        if (str.includes(actionId)) {
          clearTimeout(timeout);
          this.socket.removeListener('data', handler);
          resolve({ success: true });
        }
      };

      this.socket.on('data', handler);

      this.sendAction({
        Action: 'Command',
        ActionID: actionId,
        Command: command,
      });
    });
  }

  /**
   * Stop the service
   */
  stop() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.socket) {
      this.socket.destroy();
    }
    this.connected = false;
    this.authenticated = false;
  }
}

// Singleton
module.exports = new FreePBXAmiService();
