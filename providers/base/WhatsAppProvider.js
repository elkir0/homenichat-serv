/**
 * WhatsApp Provider Interface Abstraite
 * 
 * Cette classe définit l'interface commune que tous les providers WhatsApp
 * doivent implémenter (Evolution API, Meta Cloud API, etc.)
 * 
 * @abstract
 * @class WhatsAppProvider
 */
class WhatsAppProvider {
  constructor(config = {}) {
    if (new.target === WhatsAppProvider) {
      throw new TypeError("Cannot construct WhatsAppProvider instances directly");
    }
    
    this.config = config;
    this.isInitialized = false;
    this.connectionState = 'disconnected';
  }

  // ==================== Configuration ====================

  /**
   * Initialise le provider avec la configuration
   * @param {Object} config - Configuration spécifique au provider
   * @returns {Promise<boolean>} - true si l'initialisation réussit
   * @abstract
   */
  async initialize(config) {
    throw new Error("Method 'initialize' must be implemented");
  }

  /**
   * Valide la configuration du provider
   * @returns {Promise<{valid: boolean, errors?: string[]}>}
   * @abstract
   */
  async validateConfig() {
    throw new Error("Method 'validateConfig' must be implemented");
  }

  /**
   * Teste la connexion avec l'API
   * @returns {Promise<{success: boolean, message: string}>}
   * @abstract
   */
  async testConnection() {
    throw new Error("Method 'testConnection' must be implemented");
  }

  // ==================== Messages ====================

  /**
   * Envoie un message texte
   * @param {string} to - Numéro destinataire (format international)
   * @param {string} text - Texte du message
   * @param {Object} options - Options supplémentaires
   * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
   * @abstract
   */
  async sendTextMessage(to, text, options = {}) {
    throw new Error("Method 'sendTextMessage' must be implemented");
  }

  /**
   * Envoie un message média (image, vidéo, audio)
   * @param {string} to - Numéro destinataire
   * @param {Object} media - {type: 'image'|'video'|'audio', url: string, caption?: string}
   * @param {Object} options - Options supplémentaires
   * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
   * @abstract
   */
  async sendMediaMessage(to, media, options = {}) {
    throw new Error("Method 'sendMediaMessage' must be implemented");
  }

  /**
   * Envoie un document
   * @param {string} to - Numéro destinataire
   * @param {Object} document - {url: string, filename: string, caption?: string}
   * @param {Object} options - Options supplémentaires
   * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
   * @abstract
   */
  async sendDocument(to, document, options = {}) {
    throw new Error("Method 'sendDocument' must be implemented");
  }

  /**
   * Récupère les messages d'une conversation
   * @param {string} chatId - ID de la conversation
   * @param {number} limit - Nombre de messages à récupérer
   * @param {Object} options - Options (before, after, etc.)
   * @returns {Promise<Array>} - Liste des messages normalisés
   * @abstract
   */
  async getMessages(chatId, limit = 50, options = {}) {
    throw new Error("Method 'getMessages' must be implemented");
  }

  /**
   * Marque un message comme lu
   * @param {string} messageId - ID du message
   * @returns {Promise<{success: boolean}>}
   * @abstract
   */
  async markMessageAsRead(messageId) {
    throw new Error("Method 'markMessageAsRead' must be implemented");
  }

  /**
   * Réagit à un message
   * @param {string} messageId - ID du message
   * @param {string} emoji - Emoji de réaction
   * @returns {Promise<{success: boolean}>}
   * @abstract
   */
  async sendReaction(messageId, emoji) {
    throw new Error("Method 'sendReaction' must be implemented");
  }

  // ==================== Chats ====================

  /**
   * Récupère la liste des conversations
   * @param {Object} options - Options de filtrage
   * @returns {Promise<Array>} - Liste des chats normalisés
   * @abstract
   */
  async getChats(options = {}) {
    throw new Error("Method 'getChats' must be implemented");
  }

  /**
   * Récupère les informations d'une conversation
   * @param {string} chatId - ID de la conversation
   * @returns {Promise<Object>} - Informations du chat normalisées
   * @abstract
   */
  async getChatInfo(chatId) {
    throw new Error("Method 'getChatInfo' must be implemented");
  }

  /**
   * Marque une conversation comme lue
   * @param {string} chatId - ID de la conversation
   * @returns {Promise<{success: boolean}>}
   * @abstract
   */
  async markChatAsRead(chatId) {
    throw new Error("Method 'markChatAsRead' must be implemented");
  }

  /**
   * Archive/Désarchive une conversation
   * @param {string} chatId - ID de la conversation
   * @param {boolean} archive - true pour archiver, false pour désarchiver
   * @returns {Promise<{success: boolean}>}
   * @abstract
   */
  async archiveChat(chatId, archive = true) {
    throw new Error("Method 'archiveChat' must be implemented");
  }

  // ==================== Contacts ====================

  /**
   * Récupère la liste des contacts
   * @returns {Promise<Array>} - Liste des contacts normalisés
   * @abstract
   */
  async getContacts() {
    throw new Error("Method 'getContacts' must be implemented");
  }

  /**
   * Récupère les informations d'un contact
   * @param {string} contactId - ID du contact
   * @returns {Promise<Object>} - Informations du contact normalisées
   * @abstract
   */
  async getContactInfo(contactId) {
    throw new Error("Method 'getContactInfo' must be implemented");
  }

  /**
   * Vérifie si un numéro existe sur WhatsApp
   * @param {string} phoneNumber - Numéro à vérifier
   * @returns {Promise<{exists: boolean, jid?: string}>}
   * @abstract
   */
  async checkNumberExists(phoneNumber) {
    throw new Error("Method 'checkNumberExists' must be implemented");
  }

  /**
   * Récupère la photo de profil d'un contact
   * @param {string} contactId - ID du contact
   * @returns {Promise<{url: string}>}
   * @abstract
   */
  async getProfilePicture(contactId) {
    throw new Error("Method 'getProfilePicture' must be implemented");
  }

  // ==================== État et Connexion ====================

  /**
   * Récupère l'état de connexion
   * @returns {Promise<{state: string, qrcode?: string}>}
   * @abstract
   */
  async getConnectionState() {
    throw new Error("Method 'getConnectionState' must be implemented");
  }

  /**
   * Récupère le QR code pour connexion (si applicable)
   * @returns {Promise<{qrcode: string}>}
   * @abstract
   */
  async getQRCode() {
    throw new Error("Method 'getQRCode' must be implemented");
  }

  /**
   * Déconnecte la session
   * @returns {Promise<{success: boolean}>}
   * @abstract
   */
  async logout() {
    throw new Error("Method 'logout' must be implemented");
  }

  // ==================== Webhooks ====================

  /**
   * Configure le webhook pour recevoir les événements
   * @param {string} url - URL du webhook
   * @param {Object} options - Options du webhook
   * @returns {Promise<{success: boolean}>}
   * @abstract
   */
  async setupWebhook(url, options = {}) {
    throw new Error("Method 'setupWebhook' must be implemented");
  }

  /**
   * Traite un événement webhook reçu
   * @param {Object} data - Données du webhook
   * @returns {Promise<Object>} - Événement normalisé
   * @abstract
   */
  async handleWebhook(data) {
    throw new Error("Method 'handleWebhook' must be implemented");
  }

  // ==================== Utilitaires ====================

  /**
   * Normalise un numéro de téléphone au format WhatsApp
   * @param {string} phoneNumber - Numéro à normaliser
   * @returns {string} - Numéro normalisé (ex: 33612345678@s.whatsapp.net)
   */
  normalizePhoneNumber(phoneNumber) {
    // Retirer tous les caractères non numériques
    let normalized = phoneNumber.replace(/\D/g, '');
    
    // Ajouter le préfixe pays si nécessaire
    if (!normalized.startsWith('33') && normalized.length === 9) {
      normalized = '33' + normalized;
    }
    
    // Format WhatsApp JID
    return `${normalized}@s.whatsapp.net`;
  }

  /**
   * Normalise un message au format commun
   * @param {Object} rawMessage - Message brut du provider
   * @returns {Object} - Message normalisé
   * @abstract
   */
  normalizeMessage(rawMessage) {
    throw new Error("Method 'normalizeMessage' must be implemented");
  }

  /**
   * Normalise une conversation au format commun
   * @param {Object} rawChat - Chat brut du provider
   * @returns {Object} - Chat normalisé
   * @abstract
   */
  normalizeChat(rawChat) {
    throw new Error("Method 'normalizeChat' must be implemented");
  }

  /**
   * Normalise un contact au format commun
   * @param {Object} rawContact - Contact brut du provider
   * @returns {Object} - Contact normalisé
   * @abstract
   */
  normalizeContact(rawContact) {
    throw new Error("Method 'normalizeContact' must be implemented");
  }

  // ==================== Événements ====================

  /**
   * Émet un événement
   * @param {string} event - Nom de l'événement
   * @param {Object} data - Données de l'événement
   * @protected
   */
  emit(event, data) {
    if (this.eventHandler) {
      this.eventHandler(event, data);
    }
  }

  /**
   * Définit le gestionnaire d'événements
   * @param {Function} handler - Fonction de gestion des événements
   */
  setEventHandler(handler) {
    this.eventHandler = handler;
  }

  // ==================== Helpers ====================

  /**
   * Obtient le nom du provider
   * @returns {string} - Nom du provider
   * @abstract
   */
  getProviderName() {
    throw new Error("Method 'getProviderName' must be implemented");
  }

  /**
   * Obtient les capacités du provider
   * @returns {Object} - Capacités supportées
   */
  getCapabilities() {
    return {
      sendText: true,
      sendMedia: true,
      sendDocument: true,
      sendLocation: false,
      sendContact: false,
      sendSticker: false,
      reactions: true,
      typing: true,
      presence: true,
      groups: true,
      broadcasts: false,
      calls: false,
      status: true
    };
  }

  /**
   * Obtient les limites du provider
   * @returns {Object} - Limites (rate limits, tailles, etc.)
   */
  getLimits() {
    return {
      messageLength: 4096,
      mediaSize: 16 * 1024 * 1024, // 16MB
      documentSize: 100 * 1024 * 1024, // 100MB
      rateLimit: {
        messages: 1000,
        window: 3600 // 1 heure
      }
    };
  }
}

// Formats normalisés pour l'interopérabilité

/**
 * Format normalisé d'un message
 * @typedef {Object} NormalizedMessage
 * @property {string} id - ID unique du message
 * @property {string} chatId - ID de la conversation
 * @property {string} from - Expéditeur
 * @property {string} to - Destinataire
 * @property {string} type - text|image|video|audio|document|location|contact|sticker
 * @property {string} content - Contenu texte du message
 * @property {Object} media - Informations média si applicable
 * @property {number} timestamp - Timestamp Unix
 * @property {boolean} fromMe - true si envoyé par nous
 * @property {string} status - pending|sent|delivered|read|failed
 * @property {Object} quotedMessage - Message cité si applicable
 * @property {Object} reactions - Réactions au message
 */

/**
 * Format normalisé d'une conversation
 * @typedef {Object} NormalizedChat
 * @property {string} id - ID unique de la conversation
 * @property {string} name - Nom du contact/groupe
 * @property {string} type - individual|group|broadcast
 * @property {string} avatar - URL de l'avatar
 * @property {Object} lastMessage - Dernier message
 * @property {number} unreadCount - Nombre de messages non lus
 * @property {number} timestamp - Timestamp du dernier message
 * @property {boolean} isArchived - Si archivé
 * @property {boolean} isMuted - Si en sourdine
 * @property {boolean} isPinned - Si épinglé
 */

/**
 * Format normalisé d'un contact
 * @typedef {Object} NormalizedContact
 * @property {string} id - ID unique (JID)
 * @property {string} name - Nom du contact
 * @property {string} phoneNumber - Numéro de téléphone
 * @property {string} avatar - URL de l'avatar
 * @property {string} status - Status/bio du contact
 * @property {boolean} isBlocked - Si bloqué
 * @property {boolean} isBusiness - Si compte business
 */

module.exports = WhatsAppProvider;