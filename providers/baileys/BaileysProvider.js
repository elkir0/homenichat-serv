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
  }

  // loadState et saveState supprimés (plus de JSON)

  /**
   * Initialise le provider
   */
  async initialize() {
    // Éviter la double initialisation (Race condition fix)
    if (this.isInitializing || (this.sock && this.connectionState !== 'disconnected')) {
      logger.info('Baileys provider already initialized/initializing, skipping duplicate call.');
      return;
    }

    this.isInitializing = true;

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

      // Gestionnaires d'événements
      this.setupEventHandlers();

    } catch (error) {
      logger.error('Error starting socket:', error);
      throw error;
    } finally {
      this.isInitializing = false;
    }
  }

  setupEventHandlers() {
    // Écoute directe pour 'messages.upsert'
    this.sock.ev.on('messages.upsert', async (upsert) => {
      logger.info(`🔥 MESSAGES UPSERT: ${JSON.stringify(upsert, null, 2)}`);
      try {
        await this.handleMessagesUpsert(upsert);
      } catch (err) {
        logger.error(`Error handling messages.upsert: ${err.message}`);
      }
    });

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      logger.info(`CONNECTION UPDATE: ${JSON.stringify(update)}`);

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
          setTimeout(() => this.initialize(), 3000);
        } else if (statusCode === 401) {
          // Erreur 401 (device_removed, conflict) - NE PAS effacer, réessayer avec la même session
          logger.warn(`401 error (${lastDisconnect?.error?.data?.attrs?.type || 'unknown'}). Retrying with same session in 10s...`);
          this.retryCount++;
          if (this.retryCount <= 3) {
            setTimeout(() => this.initialize(), 10000); // Attendre 10s avant de réessayer
          } else {
            logger.error('Too many 401 errors. Manual intervention required.');
            this.emit('connection.update', { status: 'failed', error: 'Too many auth failures' });
          }
        } else if (shouldReconnect) {
          // Augmenter le délai pour éviter le spam de connexion
          this.retryCount++;
          if (this.retryCount <= this.maxRetries) {
            const delay = Math.min(5000 * this.retryCount, 30000); // Backoff exponentiel, max 30s
            logger.info(`Reconnecting in ${delay}ms... (attempt ${this.retryCount}/${this.maxRetries})`);
            setTimeout(() => this.initialize(), delay);
          } else {
            logger.error(`Max retries (${this.maxRetries}) reached. Stopping reconnection attempts.`);
            this.emit('connection.update', { status: 'failed', error: 'Max retries reached' });
          }
        }

        this.sock = null;
      } else if (connection === 'open') {
        this.connectionState = 'connected';
        this.retryCount = 0; // Reset retry counter on successful connection

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

    // History Sync - utilise batch processing pour la performance
    this.sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
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

  // Helpers existants
  async normalizeMessage(message) {
    try {
      const type = Object.keys(message.message || {})[0];
      const content = message.message[type];

      let realType = type;
      if (type === 'ephemeralMessage' || type === 'viewOnceMessage') {
        realType = Object.keys(content.message || {})[0];
      }

      return {
        id: message.key.id,
        from: message.key.remoteJid,
        sender: message.key.participant || message.key.remoteJid,
        isFromMe: message.key.fromMe,
        pushName: message.pushName,
        timestamp: message.messageTimestamp || Math.floor(Date.now() / 1000),
        type: realType,
        content: this.getMessageText(message),
        message: message.message,
        status: 'received'
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

module.exports = BaileysProvider;