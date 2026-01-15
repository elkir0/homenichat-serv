const WhatsAppProvider = require('../base/WhatsAppProvider');
const Baileys = require('@whiskeysockets/baileys');
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers } = Baileys;
const { Boom } = require('@hapi/boom');
const logger = require('../../utils/logger');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs').promises;
const pino = require('pino');
const chatStorage = require('../../services/ChatStorageServicePersistent');

/**
 * Provider Baileys Direct - Connexion WhatsApp Web native
 * Utilise la bibliothèque Baileys sans couche API intermédiaire
 */
class BaileysProvider extends WhatsAppProvider {
  constructor(config = {}) {
    super(config);
    this.sock = null;
    this.qrCode = null;
    this.connectionState = 'disconnected';
    this.authPath = path.join(__dirname, '../../sessions/baileys_debug');
    this.saveCreds = null;
    this.retryCount = 0;
    this.maxRetries = 5;
    this.msgRetryCounterCache = new Map();
    this.isInitializing = false;
    this._initLock = false; // Verrou synchrone pour éviter les appels concurrents
    this.reconnectTimer = null; // Timer de reconnexion à annuler si connexion réussit
    this.socketId = 0; // ID unique pour chaque socket créé
  }

  // loadState et saveState supprimés (plus de JSON)

  /**
   * Valide la configuration du provider
   * @returns {Promise<{valid: boolean, errors?: string[]}>}
   */
  async validateConfig() {
    // Baileys n'a pas de config externe à valider (QR auth)
    return { valid: true, errors: [] };
  }

  /**
   * Teste la connexion avec WhatsApp
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async testConnection() {
    const connected = this.sock && this.connectionState === 'connected';
    return {
      success: connected,
      message: connected ? 'Connected to WhatsApp' : 'Not connected - scan QR code'
    };
  }

  /**
   * Initialise le provider
   */
  async initialize() {
    // Verrou synchrone AVANT tout await
    if (this._initLock) {
      logger.info('Baileys provider locked, skipping duplicate initialize call.');
      return;
    }
    this._initLock = true;

    try {
      // Si déjà connecté ou en cours de connexion, ne rien faire
      if (this.sock && (this.connectionState === 'connected' || this.connectionState === 'connecting')) {
        logger.info(`Baileys provider already ${this.connectionState}, skipping initialization.`);
        return;
      }

      await this._doInitialize();
    } finally {
      // Libérer le verrou après un court délai pour éviter les appels trop rapides
      setTimeout(() => { this._initLock = false; }, 1000);
    }
  }

  /**
   * Implémentation réelle de l'initialisation (appelée une seule fois)
   */
  async _doInitialize() {
    try {
      logger.info('Initializing Baileys provider...');
      // Utiliser la version cachée ou en récupérer une nouvelle
      if (!BaileysProvider.cachedVersion) {
        const { version } = await fetchLatestBaileysVersion();
        BaileysProvider.cachedVersion = version;
      }
      const version = BaileysProvider.cachedVersion;
      logger.info(`Using WA v${version.join('.')}`);

      // Configuration de l'authentification multi-fichiers
      const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
      this.saveCreds = saveCreds;

      // Fonction de création du socket
      const socketFn = makeWASocket;

      // Nettoyer l'ancienne instance si elle existe
      if (this.sock) {
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('creds.update');
        this.sock.ev.removeAllListeners('messages.upsert');
        this.sock.end(undefined);
      }

      // Incrémenter l'ID du socket pour tracker les événements
      this.socketId++;
      const currentSocketId = this.socketId;
      logger.info(`Creating socket #${currentSocketId}`);

      this.sock = socketFn({
        version,
        logger: pino({ level: 'silent' }), // Réduire le bruit
        printQRInTerminal: false, // Nous gérons le QR code nous-mêmes
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger),
        },
        // Configuration pour éviter la détection anti-bot
        // Note: macOS Desktop permet un meilleur sync d'historique selon la doc Baileys
        browser: Browsers.macOS('Desktop'), // Desktop = meilleur history sync
        generateHighQualityLinkPreview: false, // Désactiver pour réduire les requêtes
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000, // Intervalle plus long pour moins de trafic
        emitOwnEvents: true,
        retryRequestDelayMs: 500, // Délai plus long
        syncFullHistory: true, // Activé pour télécharger l'historique complet
        markOnlineOnConnect: false, // Ne pas marquer en ligne immédiatement
        fireInitQueries: false, // Réduire les requêtes initiales
        msgRetryCounterCache: this.msgRetryCounterCache,
        getMessage: async (key) => {
          // Récupérer depuis la DB SQLite
          if (this.store) {
            const msg = await this.store.loadMessage(key.remoteJid, key.id);
            return msg?.message || undefined;
          }
          return undefined;
        },
      });

      // Stocker l'ID sur le socket pour le tracking
      this.sock._socketId = currentSocketId;

      // Gestionnaires d'événements
      this.setupEventHandlers(currentSocketId);

    } catch (error) {
      logger.error('Error starting socket:', error);
      throw error;
    }
  }

  setupEventHandlers(socketId) {
    // Écoute directe pour 'messages.upsert'
    this.sock.ev.on('messages.upsert', async (upsert) => {
      // Ignorer les événements des anciens sockets
      if (socketId !== this.socketId) {
        logger.info(`[Socket #${socketId}] Ignoring stale messages.upsert (current: #${this.socketId})`);
        return;
      }
      logger.info(`🔥 MESSAGES UPSERT: ${JSON.stringify(upsert, null, 2)}`);
      try {
        await this.handleMessagesUpsert(upsert);
      } catch (err) {
        logger.error(`Error handling messages.upsert: ${err.message}`);
      }
    });

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      logger.info(`[Socket #${socketId}] CONNECTION UPDATE: connection=${connection}, hasQR=${!!qr}, keys=${Object.keys(update).join(',')}`);

      // Ignorer les événements des anciens sockets (sauf pour 'close' qui doit toujours être logué)
      if (socketId !== this.socketId) {
        logger.info(`[Socket #${socketId}] Ignoring stale event (current: #${this.socketId})`);
        return;
      }

      if (lastDisconnect) {
        logger.info(`LAST DISCONNECT: ${JSON.stringify(lastDisconnect?.error?.output || lastDisconnect)}`);
      }

      if (qr) {
        this.qrCode = await QRCode.toDataURL(qr);
        this.connectionState = 'connecting';
        this.emit('connection.update', { status: 'connecting', qrCode: this.qrCode });
        logger.info('QR Code generated');
      }

      if (connection === 'close') {
        // FIX: Correctly extract statusCode from Boom error
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const shouldReconnect = !isLoggedOut;

        this.connectionState = 'disconnected';
        this.emit('connection.update', { status: 'disconnected' });

        logger.info(`Connection closed - StatusCode: ${statusCode}, LoggedOut: ${isLoggedOut}, Reconnecting: ${shouldReconnect}`);

        if (isLoggedOut) {
          // Session explicitement déconnectée par l'utilisateur - effacer
          logger.warn('Session explicitly logged out. Clearing session for fresh QR...');
          await this.clearSession();
          this.scheduleReconnect(3000);
        } else if (statusCode === 401) {
          // Erreur 401 (device_removed, conflict) - NE PAS effacer, réessayer avec la même session
          logger.warn(`401 error (${lastDisconnect?.error?.data?.attrs?.type || 'unknown'}). Retrying with same session in 10s...`);
          this.retryCount++;
          if (this.retryCount <= 3) {
            this.scheduleReconnect(10000);
          } else {
            logger.error('Too many 401 errors. Manual intervention required.');
            this.emit('connection.update', { status: 'failed', error: 'Too many auth failures' });
          }
        } else if (statusCode === 440) {
          // Erreur 440 (conflict) - Une autre instance est connectée
          // NE PAS reconnecter automatiquement pour éviter la boucle
          logger.warn('440 conflict error - another instance is connected. NOT reconnecting automatically.');
          this.emit('connection.update', { status: 'conflict', error: 'Another device is using this session' });
        } else if (shouldReconnect) {
          // Augmenter le délai pour éviter le spam de connexion
          this.retryCount++;
          if (this.retryCount <= this.maxRetries) {
            const delay = Math.min(5000 * this.retryCount, 30000); // Backoff exponentiel, max 30s
            logger.info(`Reconnecting in ${delay}ms... (attempt ${this.retryCount}/${this.maxRetries})`);
            this.scheduleReconnect(delay);
          } else {
            logger.error(`Max retries (${this.maxRetries}) reached. Stopping reconnection attempts.`);
            this.emit('connection.update', { status: 'failed', error: 'Max retries reached' });
          }
        }

        this.sock = null;
      } else if (connection === 'open') {
        this.connectionState = 'connected';
        this.retryCount = 0; // Reset retry counter on successful connection

        // CRITICAL: Annuler tout timer de reconnexion en attente
        if (this.reconnectTimer) {
          logger.info('Cancelling pending reconnection timer (connection succeeded)');
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }

        // Récupérer le numéro WhatsApp connecté (sans le device ID)
        const connectedUser = this.sock?.user;
        let phoneNumber = connectedUser?.id?.split('@')[0] || connectedUser?.id;
        // Enlever le device ID si présent (format: 590691272736:26)
        if (phoneNumber && phoneNumber.includes(':')) {
          phoneNumber = phoneNumber.split(':')[0];
        }
        logger.info(`📱 Connected as: ${phoneNumber}`);

        // Vérifier si le compte a changé et nettoyer les données si nécessaire
        const dataCleared = chatStorage.checkAndClearIfAccountChanged(phoneNumber);
        if (dataCleared) {
          logger.info('📱 Account changed - WhatsApp data cleared, ready for fresh history sync');
        }

        this.emit('connection.update', { status: 'connected', phoneNumber });
        logger.info('Opened connection to WA');

        // Récupérer les métadonnées des groupes sans nom (après un délai pour laisser le sync finir)
        setTimeout(() => this.fetchMissingGroupNames(), 5000);
      }
    });

    this.sock.ev.on('creds.update', this.saveCreds);

    // Setup History Sync et autres handlers
    this.setupHistorySyncHandlers(socketId);
  }

  /**
   * Programme une reconnexion avec un timer qui peut être annulé
   * @param {number} delay - Délai en ms avant reconnexion
   */
  scheduleReconnect(delay) {
    // Annuler tout timer précédent
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    logger.info(`Scheduling reconnection in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.initialize();
    }, delay);
  }

  setupHistorySyncHandlers(socketId) {
    // History Sync - utilise batch processing pour la performance
    this.sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
      // Ignorer les événements des anciens sockets
      if (socketId !== this.socketId) {
        logger.info(`[Socket #${socketId}] Ignoring stale history sync (current: #${this.socketId})`);
        return;
      }
      logger.info(`📜 HISTORY SYNC: ${chats.length} chats, ${contacts.length} contacts, ${messages.length} messages, isLatest=${isLatest}`);

      // IMPORTANT: Vérifier si le compte a changé AVANT de stocker les données
      // Ceci doit être fait ici car history sync arrive avant connection.open
      const connectedUser = this.sock?.user;
      let phoneNumber = connectedUser?.id?.split('@')[0] || connectedUser?.id;
      if (phoneNumber && phoneNumber.includes(':')) {
        phoneNumber = phoneNumber.split(':')[0];
      }
      if (phoneNumber) {
        const dataCleared = chatStorage.checkAndClearIfAccountChanged(phoneNumber);
        if (dataCleared) {
          logger.info('📱 Account change detected during history sync - old data cleared');
        }
      }

      // Traiter les métadonnées des chats (noms de groupes, etc.)
      if (chats.length > 0) {
        for (const chat of chats) {
          if (chat.id && chat.name) {
            try {
              chatStorage.updateChatName(chat.id, chat.name);
            } catch (err) {
              // Ignorer les erreurs individuelles
            }
          }
        }
        logger.info(`📜 Updated ${chats.length} chat names from history sync`);
      }

      if (messages.length === 0) {
        logger.info('No messages in this history batch.');
        return;
      }

      // Ajouter source: 'whatsapp' à tous les messages
      const messagesWithSource = messages.map(m => ({ ...m, source: 'whatsapp' }));

      // Utiliser batch processing pour la performance (SQLite transaction)
      const processedCount = chatStorage.processBatchMessages(messagesWithSource);
      logger.info(`📜 HISTORY SYNC DONE: ${processedCount}/${messages.length} messages stored.`);

      // Émettre un événement pour rafraîchir la liste des chats dans le frontend
      if (processedCount > 0) {
        this.emit('chats.updated', { count: processedCount, source: 'history_sync' });
      }
    });

    // Groups metadata - mise à jour des noms de groupes
    this.sock.ev.on('groups.upsert', async (groups) => {
      logger.info(`👥 GROUPS UPSERT: ${groups.length} groups`);
      for (const group of groups) {
        if (group.id && group.subject) {
          try {
            chatStorage.updateChatName(group.id, group.subject);
            logger.info(`👥 Updated group name: ${group.id} -> ${group.subject}`);
          } catch (err) {
            logger.error(`Error updating group name: ${err.message}`);
          }
        }
      }
    });

    // Groups update (name changes, etc.)
    this.sock.ev.on('groups.update', async (updates) => {
      for (const update of updates) {
        if (update.id && update.subject) {
          try {
            chatStorage.updateChatName(update.id, update.subject);
            logger.info(`👥 Group renamed: ${update.id} -> ${update.subject}`);
          } catch (err) {
            logger.error(`Error updating group name: ${err.message}`);
          }
        }
      }
    });

    // Contacts update - utile pour les @lid et autres contacts
    this.sock.ev.on('contacts.upsert', async (contacts) => {
      logger.info(`📇 CONTACTS UPSERT: ${contacts.length} contacts`);
      for (const contact of contacts) {
        const name = contact.notify || contact.verifiedName || contact.name;
        if (contact.id && name) {
          try {
            chatStorage.updateChatName(contact.id, name);
          } catch (err) {
            // Ignorer silencieusement
          }
        }
      }
    });
  }

  async handleMessagesUpsert({ messages, type }) {
    logger.info(`📥 handleMessagesUpsert called - type: ${type}, count: ${messages.length}`);

    for (const message of messages) {
      if (!message.message) {
        logger.info(`⏭️ Skipping message without content: ${message.key?.id}`);
        continue;
      }

      // Ignorer les status WhatsApp (stories) - pas besoin de stocker
      if (message.key.remoteJid === 'status@broadcast') {
        continue;
      }

      const msgToStore = {
        ...message,
        source: 'whatsapp'
      };

      const msgTypes = Object.keys(message.message || {});
      logger.info(`📨 MESSAGE UPSERT: chatId=${message.key.remoteJid} fromMe=${message.key.fromMe} types=${msgTypes.join(',')}`);

      try {
        await chatStorage.processIncomingMessage(msgToStore);
        logger.info(`✅ Message stored: ${message.key.id}`);
      } catch (err) {
        logger.error(`❌ Failed to store message ${message.key.id}:`, err);
      }
    }

    // Notification UI - émettre l'événement pour TOUS les nouveaux messages (pas seulement notify)
    for (const message of messages) {
      if (!message.message) continue;

      // Ignorer les status WhatsApp (stories) - pas besoin de notifier
      const chatId = message.key.remoteJid;
      if (chatId === 'status@broadcast') {
        logger.info(`⏭️ Skipping status broadcast message`);
        continue;
      }

      // Ignorer les messages système (protocolMessage, senderKeyDistributionMessage)
      // NOTE: messageContextInfo est présent dans TOUS les messages, ce n'est PAS un indicateur de message système
      const msgTypes = Object.keys(message.message || {});
      const realContentTypes = msgTypes.filter(t => t !== 'messageContextInfo');

      const isSystemMessage = realContentTypes.length === 1 && (
        realContentTypes[0] === 'protocolMessage' ||
        realContentTypes[0] === 'senderKeyDistributionMessage'
      );

      if (isSystemMessage) {
        logger.info(`⏭️ Skipping system message: ${realContentTypes[0]}`);
        continue;
      }

      // Émettre pour les messages entrants (pas fromMe) OU les messages sortants pour sync UI
      const normalizedMessage = await this.normalizeMessage(message);
      if (normalizedMessage) {
        normalizedMessage.chatId = message.key.remoteJid; // Ajouter chatId explicitement
        normalizedMessage.provider = 'baileys';

        logger.info(`🚀 EMITTING message event: id=${normalizedMessage.id} fromMe=${normalizedMessage.isFromMe} chatId=${normalizedMessage.chatId}`);
        this.emit('message', normalizedMessage);
      }
    }
  }

  // --- Getters ---

  async getChats() {
    // Récupérer depuis SQLite via ChatStorageService
    const chats = await chatStorage.getChats(); // Retourne déjà le format DB
    return chats.map(c => ({
      ...c,
      id: c.id,
      name: c.name,
      unreadCount: c.unread_count,
      timestamp: c.timestamp,
      profilePicture: c.profile_picture,
      source: c.provider
    }));
  }

  async getMessages(chatId, limit = 50) {
    // Récupérer depuis SQLite
    return await chatStorage.getMessages(1, chatId, limit);
  }

  async getContacts() {
    return []; // TODO: Implement contacts in DB
  }

  async getChatInfo(chatId) {
    const chat = await chatStorage.getChat(chatId);
    if (!chat) throw new Error('Chat not found');
    return {
      ...chat,
      name: chat.name,
      unreadCount: chat.unread_count
    };
  }

  /**
   * Normalise un message Baileys au format unifié
   * @param {object} message - Message brut Baileys
   * @returns {Promise<NormalizedMessage|null>}
   *
   * @typedef {object} NormalizedMessage
   * @property {string} id - ID unique du message
   * @property {string} chatId - ID du chat (JID WhatsApp)
   * @property {string} from - Numéro de l'expéditeur (sans @s.whatsapp.net)
   * @property {string} to - Numéro du destinataire (notre numéro connecté)
   * @property {boolean} fromMe - true si envoyé par nous
   * @property {number} timestamp - Timestamp Unix (secondes)
   * @property {string} type - Type de message: 'text', 'image', 'video', 'audio', 'document', 'sticker'
   * @property {string} [text] - Contenu textuel (si type=text ou caption)
   * @property {object} [media] - Données média (si type=image/video/audio/document)
   * @property {string} status - Statut: 'sent', 'delivered', 'read', 'received'
   * @property {string} _provider - Identifiant du provider ('baileys')
   * @property {object} _raw - Message brut original pour debug
   */
  async normalizeMessage(message) {
    try {
      const msgTypes = Object.keys(message.message || {});
      // Filtrer messageContextInfo qui est présent dans tous les messages
      const realTypes = msgTypes.filter(t => t !== 'messageContextInfo');
      const type = realTypes[0] || msgTypes[0];
      const content = message.message[type];

      let realType = type;
      if (type === 'ephemeralMessage' || type === 'viewOnceMessage') {
        const innerTypes = Object.keys(content.message || {});
        realType = innerTypes.filter(t => t !== 'messageContextInfo')[0] || innerTypes[0];
      }

      // Mapper les types Baileys vers les types unifiés
      const typeMap = {
        'conversation': 'text',
        'extendedTextMessage': 'text',
        'imageMessage': 'image',
        'videoMessage': 'video',
        'audioMessage': 'audio',
        'documentMessage': 'document',
        'stickerMessage': 'sticker',
        'contactMessage': 'contact',
        'locationMessage': 'location'
      };
      const unifiedType = typeMap[realType] || realType;

      // Extraire le numéro de l'expéditeur (sans @s.whatsapp.net)
      const senderJid = message.key.participant || message.key.remoteJid;
      const fromNumber = senderJid ? senderJid.split('@')[0].split(':')[0] : '';

      // Notre numéro connecté
      const connectedUser = this.sock?.user?.id;
      const toNumber = connectedUser ? connectedUser.split('@')[0].split(':')[0] : '';

      // Construire l'objet média si applicable
      let media = null;
      if (['image', 'video', 'audio', 'document', 'sticker'].includes(unifiedType)) {
        const mediaContent = message.message[realType] || content;
        media = {
          mimetype: mediaContent?.mimetype,
          fileLength: mediaContent?.fileLength,
          fileName: mediaContent?.fileName,
          caption: mediaContent?.caption,
          // Note: Pour télécharger le média, utiliser sock.downloadMediaMessage(message)
          hasMedia: true
        };
      }

      return {
        id: message.key.id,
        chatId: message.key.remoteJid,
        from: fromNumber,
        to: toNumber,
        fromMe: message.key.fromMe,
        timestamp: message.messageTimestamp || Math.floor(Date.now() / 1000),
        type: unifiedType,
        text: this.getMessageText(message) || undefined,
        media: media,
        status: message.key.fromMe ? 'sent' : 'received',
        _provider: 'baileys',
        _raw: message.message,
        // Champs bonus utiles (non dans la spec mais pratiques)
        pushName: message.pushName
      };
    } catch (error) {
      logger.error('Error normalizing message:', error);
      return null;
    }
  }

  getMessageText(message) {
    if (!message.message) return '';
    const msg = message.message;
    return msg.conversation ||
      msg.extendedTextMessage?.text ||
      msg.imageMessage?.caption ||
      msg.videoMessage?.caption ||
      '';
  }

  async getConnectionState() {
    return {
      state: this.connectionState,  // Pour ProviderManager.getHealthStatus
      status: this.connectionState, // Pour compatibilité
      qrCode: this.qrCode,
      isConnected: this.connectionState === 'connected' || this.connectionState === 'open'
    };
  }

  async getQRCode() {
    return this.qrCode;
  }

  async checkNumberExists(number) {
    if (!this.sock || this.connectionState !== 'connected') {
      logger.warn('Cannot check number: Baileys provider not connected');
      return { exists: false, error: 'not_connected' };
    }
    const jid = this.formatJid(number);
    try {
      const results = await this.sock.onWhatsApp(jid);
      const result = Array.isArray(results) ? results[0] : results;
      return {
        exists: !!result?.exists,
        jid: result?.jid || jid
      };
    } catch (error) {
      logger.error('Error checking number on WhatsApp:', error);
      return { exists: false };
    }
  }

  formatJid(number) {
    if (!number) return '';
    if (number.includes('@s.whatsapp.net') || number.includes('@g.us') || number.includes('@lid')) return number;
    return `${number.replace(/\D/g, '')}@s.whatsapp.net`;
  }

  async sendMediaMessage(to, media, options = {}) {
    if (!this.sock || this.connectionState !== 'connected') {
      throw new Error('Baileys provider not connected. Please scan QR code in Admin Panel.');
    }
    const jid = this.formatJid(to);

    let content = {};
    if (media.type === 'image') {
      content = { image: { url: media.url }, caption: media.caption };
    } else if (media.type === 'video') {
      content = { video: { url: media.url }, caption: media.caption };
    } else if (media.type === 'audio') {
      content = { audio: { url: media.url }, ptt: !!options.ptt };
    } else {
      content = { document: { url: media.url }, mimetype: media.mimetype, fileName: media.filename };
    }

    try {
      const sentMsg = await this.sock.sendMessage(jid, content);
      return {
        success: true,
        messageId: sentMsg.key.id,
        timestamp: sentMsg.messageTimestamp
      };
    } catch (error) {
      logger.error('Error sending media message:', error);
      throw error;
    }
  }

  getProviderName() {
    return 'baileys';
  }

  // Implementation de sendTextMessage du provider de base
  async sendTextMessage(to, text, options = {}) {
    if (!this.sock || this.connectionState !== 'connected') {
      throw new Error('Baileys provider not connected. Please scan QR code in Admin Panel.');
    }

    const jid = this.formatJid(to);

    try {
      const sentMsg = await this.sock.sendMessage(jid, {
        text: text
      });

      return {
        success: true,
        messageId: sentMsg.key.id,
        timestamp: sentMsg.messageTimestamp
      };
    } catch (error) {
      logger.error('Error sending text message via Baileys:', error);
      throw error;
    }
  }

  // Alias pour la compatibilité si la route appelle sendMessage directement
  async sendMessage(to, content, options = {}) {
    if (typeof content === 'string') {
      return this.sendTextMessage(to, content, options);
    }
    // Gérer d'autres types de contenu si nécessaire (image, etc)
    throw new Error('Unsupported message content type');
  }


  async sendPresenceUpdate(chatId, type) {
    if (!this.sock || this.connectionState !== 'connected') return;
    try {
      const jid = this.formatJid(chatId);
      await this.sock.sendPresenceUpdate(type === 'typing' ? 'composing' : 'paused', jid);
    } catch (error) {
      logger.warn(`Failed to send presence update: ${error.message}`);
    }
  }

  /**
   * Marque un chat comme lu (tous les messages non lus)
   * @param {string} chatId - ID du chat (JID WhatsApp)
   * @returns {Promise<{success: boolean, error?: string}>}
   *
   * @api POST /api/chats/:chatId/read
   * @example
   * // Request
   * POST /api/chats/33612345678@s.whatsapp.net/read
   *
   * // Response
   * { "success": true }
   */
  async markChatAsRead(chatId) {
    if (!this.sock || this.connectionState !== 'connected') {
      return { success: false, error: 'Not connected' };
    }

    try {
      const jid = this.formatJid(chatId);
      // Baileys readMessages marque tous les messages non lus d'un chat
      await this.sock.readMessages([{ remoteJid: jid, id: undefined }]);

      // Mettre à jour le compteur dans la DB locale
      chatStorage.markChatAsRead(chatId);

      logger.info(`✅ Chat marked as read: ${chatId}`);
      return { success: true };
    } catch (error) {
      logger.error(`Error marking chat as read: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Marque un message spécifique comme lu
   * @param {string} chatId - ID du chat contenant le message
   * @param {string} messageId - ID du message à marquer comme lu
   * @returns {Promise<{success: boolean, error?: string}>}
   *
   * @api POST /api/messages/:messageId/read
   * @example
   * // Request body
   * { "chatId": "33612345678@s.whatsapp.net" }
   *
   * // Response
   * { "success": true }
   */
  async markMessageAsRead(chatId, messageId) {
    if (!this.sock || this.connectionState !== 'connected') {
      return { success: false, error: 'Not connected' };
    }

    try {
      const jid = this.formatJid(chatId);
      await this.sock.readMessages([{ remoteJid: jid, id: messageId }]);

      logger.info(`✅ Message marked as read: ${messageId} in ${chatId}`);
      return { success: true };
    } catch (error) {
      logger.error(`Error marking message as read: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Envoie une réaction emoji à un message
   * @param {string} chatId - ID du chat contenant le message
   * @param {string} messageId - ID du message cible
   * @param {string} emoji - Emoji de réaction (ex: "👍", "❤️", "" pour supprimer)
   * @returns {Promise<{success: boolean, error?: string}>}
   *
   * @api POST /api/messages/:messageId/reaction
   * @example
   * // Request body
   * { "chatId": "33612345678@s.whatsapp.net", "emoji": "👍" }
   *
   * // Response
   * { "success": true }
   *
   * // Pour supprimer une réaction, envoyer emoji vide:
   * { "chatId": "33612345678@s.whatsapp.net", "emoji": "" }
   */
  async sendReaction(chatId, messageId, emoji) {
    if (!this.sock || this.connectionState !== 'connected') {
      return { success: false, error: 'Not connected' };
    }

    try {
      const jid = this.formatJid(chatId);
      await this.sock.sendMessage(jid, {
        react: {
          text: emoji,  // Emoji ou chaîne vide pour supprimer
          key: {
            remoteJid: jid,
            id: messageId
          }
        }
      });

      logger.info(`✅ Reaction sent: ${emoji || '(removed)'} on ${messageId}`);
      return { success: true };
    } catch (error) {
      logger.error(`Error sending reaction: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Récupère les noms des groupes qui n'ont pas encore de nom (affichent le JID)
   */
  async fetchMissingGroupNames() {
    if (!this.sock || this.connectionState !== 'connected') return;

    try {
      // Récupérer les groupes sans nom depuis la DB
      const chats = await chatStorage.getChats();
      const groupsWithoutNames = chats.filter(chat =>
        chat.id.endsWith('@g.us') &&
        (chat.name === chat.id || chat.name.includes('@g.us'))
      );

      if (groupsWithoutNames.length === 0) {
        logger.info('👥 All groups already have names');
        return;
      }

      logger.info(`👥 Fetching metadata for ${groupsWithoutNames.length} groups without names...`);

      for (const chat of groupsWithoutNames) {
        try {
          const metadata = await this.sock.groupMetadata(chat.id);
          if (metadata && metadata.subject) {
            chatStorage.updateChatName(chat.id, metadata.subject);
            logger.info(`👥 Fetched group name: ${chat.id} -> ${metadata.subject}`);
          }
          // Petit délai pour éviter le rate limiting
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (err) {
          logger.warn(`Failed to fetch metadata for ${chat.id}: ${err.message}`);
        }
      }

      logger.info('👥 Finished fetching missing group names');
    } catch (error) {
      logger.error('Error fetching missing group names:', error);
    }
  }

  /**
   * Efface la session Baileys pour permettre une nouvelle connexion QR
   * @param {boolean} clearData - Si true, efface aussi les données WhatsApp de la DB
   */
  async clearSession(clearData = false) {
    try {
      logger.info('Clearing Baileys session...');

      // S'assurer que le socket est fermé
      if (this.sock) {
        try {
          this.sock.ev.removeAllListeners();
          this.sock.end(undefined);
        } catch (e) {
          // Ignorer les erreurs de fermeture
        }
        this.sock = null;
      }

      // Effacer les fichiers de session
      const sessionDir = this.authPath;
      try {
        const files = await fs.readdir(sessionDir);
        for (const file of files) {
          await fs.unlink(path.join(sessionDir, file));
        }
        logger.info(`Cleared ${files.length} session files from ${sessionDir}`);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.error('Error clearing session files:', err);
        }
      }

      // Optionnel: effacer les données WhatsApp de la DB
      if (clearData) {
        logger.info('Also clearing WhatsApp data from database...');
        chatStorage.clearWhatsAppData();
      }

      // Annuler tout timer de reconnexion
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      // Reset state
      this.qrCode = null;
      this.connectionState = 'disconnected';
      this.retryCount = 0;
      this.isInitializing = false;

      logger.info('Session cleared successfully. Ready for new QR scan.');
    } catch (error) {
      logger.error('Error clearing session:', error);
    }
  }

  /**
   * Force une déconnexion et réinitialisation complète
   * Efface la session ET les données WhatsApp
   */
  async logout() {
    try {
      if (this.sock) {
        await this.sock.logout();
      }
    } catch (error) {
      logger.warn('Error during logout:', error.message);
    }
    // Logout explicite = effacer aussi les données WhatsApp
    await this.clearSession(true);
  }
}

// Singleton - une seule instance de BaileysProvider pour éviter les conflits
let instance = null;

module.exports = function(config) {
  if (!instance) {
    instance = new BaileysProvider(config);
  }
  return instance;
};

// Exposer la classe pour les tests ou cas spéciaux
module.exports.BaileysProvider = BaileysProvider;
module.exports.getInstance = () => instance;
module.exports.resetInstance = () => { instance = null; };