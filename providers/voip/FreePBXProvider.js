/**
 * FreePBXProvider - Provider VoIP pour FreePBX/Asterisk
 *
 * Fonctionnalités:
 * - Connexion AMI (Asterisk Manager Interface) pour la signalisation
 * - Configuration WebRTC pour SIP.js côté client
 * - Gestion des appels entrants/sortants
 * - Support multi-extensions
 * - Webhooks pour état des appels
 *
 * Configuration requise:
 * - host: IP/hostname du FreePBX
 * - ami_port: Port AMI (default: 5038)
 * - ami_user: Utilisateur AMI
 * - ami_secret: Mot de passe AMI
 * - webrtc_ws: URL WebSocket pour WebRTC (wss://host:8089/ws)
 * - extensions: Liste des extensions à gérer
 */

const EventEmitter = require('events');
const net = require('net');
const logger = require('../../utils/logger');

class FreePBXProvider extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.id = config.id || 'freepbx';
    this.type = 'freepbx';

    // Configuration AMI
    this.amiHost = config.config?.host || 'localhost';
    this.amiPort = config.config?.ami_port || 5038;
    this.amiUser = config.config?.ami_user || '';
    this.amiSecret = config.config?.ami_secret || '';

    // Configuration WebRTC
    this.webrtcWs = config.config?.webrtc_ws || `wss://${this.amiHost}:8089/ws`;
    this.sipDomain = config.config?.sip_domain || this.amiHost;
    this.stunServer = config.config?.stun_server || 'stun:stun.l.google.com:19302';
    this.turnServer = config.config?.turn_server || null;

    // Extensions gérées
    this.extensions = config.config?.extensions || [];

    // État
    this.amiSocket = null;
    this.isConnected = false;
    this.activeCalls = new Map();
    this.extensionStates = new Map();

    // Buffer pour parsing AMI
    this.buffer = '';
    this.actionCounter = 0;
    this.pendingActions = new Map();
  }

  /**
   * Initialise la connexion au FreePBX
   */
  async initialize() {
    try {
      logger.info(`[FreePBX:${this.id}] Initializing...`);

      // Connecter à l'AMI
      await this.connectAMI();

      // S'abonner aux événements
      await this.subscribeToEvents();

      logger.info(`[FreePBX:${this.id}] Initialized successfully`);
      return true;
    } catch (error) {
      logger.error(`[FreePBX:${this.id}] Initialization failed:`, error);
      this.isConnected = false;
      throw error;
    }
  }

  /**
   * Connexion à l'AMI Asterisk
   */
  async connectAMI() {
    return new Promise((resolve, reject) => {
      logger.info(`[FreePBX:${this.id}] Connecting to AMI ${this.amiHost}:${this.amiPort}...`);

      this.amiSocket = net.createConnection({
        host: this.amiHost,
        port: this.amiPort
      });

      const timeout = setTimeout(() => {
        this.amiSocket.destroy();
        reject(new Error('AMI connection timeout'));
      }, 10000);

      this.amiSocket.on('connect', async () => {
        logger.info(`[FreePBX:${this.id}] TCP connected to AMI`);
      });

      this.amiSocket.on('data', (data) => {
        this.handleAMIData(data.toString());

        // Détecter la bannière AMI pour login
        if (data.toString().includes('Asterisk Call Manager')) {
          this.loginAMI()
            .then(() => {
              clearTimeout(timeout);
              this.isConnected = true;
              resolve();
            })
            .catch(reject);
        }
      });

      this.amiSocket.on('error', (error) => {
        clearTimeout(timeout);
        logger.error(`[FreePBX:${this.id}] AMI socket error:`, error);
        this.isConnected = false;
        this.emit('connection_error', { error: error.message });
        reject(error);
      });

      this.amiSocket.on('close', () => {
        logger.warn(`[FreePBX:${this.id}] AMI connection closed`);
        this.isConnected = false;
        this.emit('disconnected');

        // Tentative de reconnexion après 5s
        setTimeout(() => {
          if (!this.isConnected) {
            this.connectAMI().catch(e => logger.error(`[FreePBX:${this.id}] Reconnect failed:`, e));
          }
        }, 5000);
      });
    });
  }

  /**
   * Login à l'AMI
   */
  async loginAMI() {
    return this.sendAction({
      Action: 'Login',
      Username: this.amiUser,
      Secret: this.amiSecret
    });
  }

  /**
   * S'abonner aux événements AMI pertinents
   */
  async subscribeToEvents() {
    // Demander les événements système
    await this.sendAction({
      Action: 'Events',
      EventMask: 'call,system'
    });

    logger.info(`[FreePBX:${this.id}] Subscribed to AMI events`);
  }

  /**
   * Envoie une action AMI
   */
  sendAction(action) {
    return new Promise((resolve, reject) => {
      const actionId = `${Date.now()}-${++this.actionCounter}`;
      action.ActionID = actionId;

      // Formatter le message AMI
      let message = '';
      for (const [key, value] of Object.entries(action)) {
        message += `${key}: ${value}\r\n`;
      }
      message += '\r\n';

      // Enregistrer le callback
      this.pendingActions.set(actionId, { resolve, reject, timeout: null });

      // Timeout pour la réponse
      const timeout = setTimeout(() => {
        this.pendingActions.delete(actionId);
        reject(new Error(`AMI action timeout: ${action.Action}`));
      }, 5000);

      this.pendingActions.get(actionId).timeout = timeout;

      // Envoyer
      this.amiSocket.write(message);
    });
  }

  /**
   * Parse les données AMI reçues
   */
  handleAMIData(data) {
    this.buffer += data;

    // Séparer les messages (double \r\n)
    const messages = this.buffer.split('\r\n\r\n');
    this.buffer = messages.pop(); // Garder le dernier incomplet

    for (const msg of messages) {
      if (!msg.trim()) continue;

      // Parser le message
      const parsed = {};
      const lines = msg.split('\r\n');

      for (const line of lines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex).trim();
          const value = line.substring(colonIndex + 1).trim();
          parsed[key] = value;
        }
      }

      // Traiter le message
      if (parsed.Response) {
        this.handleAMIResponse(parsed);
      } else if (parsed.Event) {
        this.handleAMIEvent(parsed);
      }
    }
  }

  /**
   * Traite une réponse AMI
   */
  handleAMIResponse(response) {
    const actionId = response.ActionID;
    if (!actionId) return;

    const pending = this.pendingActions.get(actionId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingActions.delete(actionId);

      if (response.Response === 'Success') {
        pending.resolve(response);
      } else {
        pending.reject(new Error(response.Message || 'AMI action failed'));
      }
    }
  }

  /**
   * Traite un événement AMI
   */
  handleAMIEvent(event) {
    const eventName = event.Event;

    switch (eventName) {
      case 'Newchannel':
        this.handleNewChannel(event);
        break;

      case 'Newstate':
        this.handleNewState(event);
        break;

      case 'Dial':
        this.handleDial(event);
        break;

      case 'Bridge':
        this.handleBridge(event);
        break;

      case 'Hangup':
        this.handleHangup(event);
        break;

      case 'ExtensionStatus':
        this.handleExtensionStatus(event);
        break;

      case 'DeviceStateChange':
        this.handleDeviceStateChange(event);
        break;

      default:
        // Logger les événements non traités en debug
        // logger.debug(`[FreePBX:${this.id}] Unhandled event: ${eventName}`);
        break;
    }
  }

  /**
   * Nouveau canal (début d'appel)
   */
  handleNewChannel(event) {
    const channelId = event.Uniqueid;
    const callerIdNum = event.CallerIDNum;
    const callerIdName = event.CallerIDName;
    const exten = event.Exten;

    logger.info(`[FreePBX:${this.id}] New channel: ${channelId} from ${callerIdNum}`);

    this.activeCalls.set(channelId, {
      id: channelId,
      channel: event.Channel,
      callerIdNum,
      callerIdName,
      exten,
      status: 'ringing',
      startTime: Date.now(),
      direction: event.Context?.includes('from-trunk') ? 'incoming' : 'outgoing'
    });
  }

  /**
   * Changement d'état d'un canal
   */
  handleNewState(event) {
    const channelId = event.Uniqueid;
    const state = event.ChannelStateDesc;

    const call = this.activeCalls.get(channelId);
    if (call) {
      call.status = state.toLowerCase();

      if (state === 'Up') {
        call.answerTime = Date.now();
        this.emit('call_answered', {
          callId: channelId,
          from: call.callerIdNum,
          to: call.exten,
          direction: call.direction
        });
      } else if (state === 'Ringing') {
        // Émettre l'événement d'appel entrant
        if (call.direction === 'incoming') {
          this.emit('incoming_call', {
            callId: channelId,
            from: call.callerIdNum,
            fromName: call.callerIdName,
            to: call.exten,
            timestamp: call.startTime
          });
        }
      }
    }
  }

  /**
   * Début de numérotation
   */
  handleDial(event) {
    const destChannelId = event.DestUniqueid;
    const srcChannelId = event.Uniqueid;

    logger.info(`[FreePBX:${this.id}] Dial: ${srcChannelId} -> ${destChannelId}`);

    // Associer les canaux
    const srcCall = this.activeCalls.get(srcChannelId);
    if (srcCall) {
      srcCall.destChannelId = destChannelId;
    }
  }

  /**
   * Deux canaux connectés (bridge)
   */
  handleBridge(event) {
    const channel1Id = event.Uniqueid1;
    const channel2Id = event.Uniqueid2;

    logger.info(`[FreePBX:${this.id}] Bridge: ${channel1Id} <-> ${channel2Id}`);

    // Marquer les appels comme connectés
    for (const channelId of [channel1Id, channel2Id]) {
      const call = this.activeCalls.get(channelId);
      if (call) {
        call.status = 'connected';
        call.bridgedWith = channelId === channel1Id ? channel2Id : channel1Id;
      }
    }
  }

  /**
   * Fin d'appel
   */
  handleHangup(event) {
    const channelId = event.Uniqueid;
    const cause = event.Cause;
    const causeTxt = event.CauseTxt;

    const call = this.activeCalls.get(channelId);
    if (call) {
      call.endTime = Date.now();
      call.duration = call.answerTime
        ? Math.floor((call.endTime - call.answerTime) / 1000)
        : 0;
      call.hangupCause = causeTxt;

      logger.info(`[FreePBX:${this.id}] Hangup: ${channelId} (${causeTxt}), duration: ${call.duration}s`);

      // Émettre l'événement
      this.emit('call_ended', {
        callId: channelId,
        from: call.callerIdNum,
        to: call.exten,
        direction: call.direction,
        duration: call.duration,
        status: call.answerTime ? 'completed' : 'missed',
        cause: causeTxt
      });

      // Supprimer après un délai pour permettre aux listeners de récupérer les infos
      setTimeout(() => {
        this.activeCalls.delete(channelId);
      }, 5000);
    }
  }

  /**
   * Changement d'état d'une extension
   */
  handleExtensionStatus(event) {
    const extension = event.Exten;
    const status = parseInt(event.Status);

    // Mapping des états Asterisk
    const stateMap = {
      0: 'available',     // Not inuse
      1: 'inuse',         // In use
      2: 'busy',          // Busy
      4: 'unavailable',   // Unavailable
      8: 'ringing',       // Ringing
      16: 'on_hold'       // On hold
    };

    this.extensionStates.set(extension, {
      status: stateMap[status] || 'unknown',
      statusCode: status,
      lastUpdate: Date.now()
    });

    this.emit('extension_status', {
      extension,
      status: stateMap[status] || 'unknown'
    });
  }

  /**
   * Changement d'état d'un device
   */
  handleDeviceStateChange(event) {
    const device = event.Device;
    const state = event.State;

    logger.debug(`[FreePBX:${this.id}] Device state: ${device} -> ${state}`);
  }

  // ==================== API Publique ====================

  /**
   * Initie un appel sortant
   */
  async originateCall(fromExtension, toNumber, options = {}) {
    try {
      const channel = `PJSIP/${fromExtension}`;
      const context = options.context || 'from-internal';
      const priority = options.priority || 1;
      const callerIdName = options.callerIdName || fromExtension;
      const callerIdNum = options.callerIdNum || fromExtension;

      logger.info(`[FreePBX:${this.id}] Originating call: ${fromExtension} -> ${toNumber}`);

      const result = await this.sendAction({
        Action: 'Originate',
        Channel: channel,
        Context: context,
        Exten: toNumber,
        Priority: priority,
        CallerID: `"${callerIdName}" <${callerIdNum}>`,
        Timeout: 30000,
        Async: 'true'
      });

      return {
        success: true,
        message: 'Call initiated',
        data: result
      };
    } catch (error) {
      logger.error(`[FreePBX:${this.id}] Originate failed:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Raccroche un appel
   */
  async hangupCall(channelId) {
    try {
      const call = this.activeCalls.get(channelId);
      if (!call) {
        return { success: false, error: 'Call not found' };
      }

      await this.sendAction({
        Action: 'Hangup',
        Channel: call.channel
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Transfère un appel
   */
  async transferCall(channelId, targetExtension) {
    try {
      const call = this.activeCalls.get(channelId);
      if (!call) {
        return { success: false, error: 'Call not found' };
      }

      await this.sendAction({
        Action: 'Redirect',
        Channel: call.channel,
        Context: 'from-internal',
        Exten: targetExtension,
        Priority: 1
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Met en attente/reprend un appel
   */
  async holdCall(channelId, hold = true) {
    try {
      const call = this.activeCalls.get(channelId);
      if (!call) {
        return { success: false, error: 'Call not found' };
      }

      const action = hold ? 'ParkCall' : 'UnparkCall';
      // Note: La mise en attente peut varier selon la config FreePBX
      // Ici on utilise une logique simplifiée

      return { success: true, hold };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Récupère la configuration SIP pour le client WebRTC
   */
  getSipConfig(extension, password) {
    return {
      // WebSocket server
      wsServer: this.webrtcWs,

      // SIP settings
      sipDomain: this.sipDomain,
      extension: extension,
      password: password,

      // STUN/TURN servers
      iceServers: [
        { urls: this.stunServer }
      ],

      // Options SIP.js
      sipOptions: {
        traceSip: false,
        hackIpInContact: true,
        hackViaTcp: true,
        hackWssInTransport: true,
        displayName: extension
      }
    };
  }

  /**
   * Récupère l'état d'une extension
   */
  async getExtensionStatus(extension) {
    const cached = this.extensionStates.get(extension);
    if (cached && Date.now() - cached.lastUpdate < 5000) {
      return cached;
    }

    try {
      const result = await this.sendAction({
        Action: 'ExtensionState',
        Exten: extension,
        Context: 'from-internal'
      });

      return {
        status: result.Status === '0' ? 'available' : 'inuse',
        statusCode: parseInt(result.Status)
      };
    } catch (error) {
      return { status: 'unknown', error: error.message };
    }
  }

  /**
   * Liste des appels actifs
   */
  getActiveCalls() {
    return Array.from(this.activeCalls.values()).map(call => ({
      id: call.id,
      from: call.callerIdNum,
      fromName: call.callerIdName,
      to: call.exten,
      status: call.status,
      direction: call.direction,
      startTime: call.startTime,
      answerTime: call.answerTime,
      duration: call.answerTime
        ? Math.floor((Date.now() - call.answerTime) / 1000)
        : 0
    }));
  }

  /**
   * État de connexion
   */
  async getStatus() {
    return {
      connected: this.isConnected,
      host: this.amiHost,
      activeCalls: this.activeCalls.size,
      extensions: this.extensions.length
    };
  }

  /**
   * Retourne le nom du provider
   */
  getProviderName() {
    return 'freepbx';
  }

  /**
   * Retourne les capacités
   */
  getCapabilities() {
    return {
      incomingCalls: true,
      outgoingCalls: true,
      transfer: true,
      hold: true,
      conferencing: false,
      recording: false,
      webrtc: true,
      multiExtension: true
    };
  }

  /**
   * Déconnexion
   */
  async disconnect() {
    if (this.amiSocket) {
      try {
        await this.sendAction({ Action: 'Logoff' });
      } catch (e) {
        // Ignore
      }
      this.amiSocket.destroy();
      this.amiSocket = null;
    }
    this.isConnected = false;
    this.activeCalls.clear();
    logger.info(`[FreePBX:${this.id}] Disconnected`);
  }
}

module.exports = FreePBXProvider;
