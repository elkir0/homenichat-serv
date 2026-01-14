/**
 * SmsProvider - Classe de base abstraite pour tous les providers SMS
 *
 * Cette classe définit l'interface commune que tous les providers SMS
 * doivent implémenter. Elle fournit également des méthodes utilitaires
 * partagées comme le formatage des numéros et la vérification de compliance.
 *
 * Providers supportés:
 * - Cloud: OVH, Twilio, Plivo, MessageBird, Vonage
 * - Protocol: SMPP, SIP MESSAGE
 * - Self-hosted: Gammu (modem USB), Kannel
 */

const EventEmitter = require('events');
const logger = require('../../../utils/logger');

class SmsProvider extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.id = config.id;
    this.type = config.type;
    this.enabled = config.enabled || false;
    this.status = 'disconnected';
    this.lastError = null;
    this.stats = {
      messagesSent: 0,
      messagesReceived: 0,
      messagesFailed: 0,
      lastActivity: null
    };
  }

  // ==================== Méthodes Abstraites ====================
  // Ces méthodes DOIVENT être implémentées par les classes enfants

  /**
   * Initialise le provider (connexion, authentification)
   * @returns {Promise<boolean>}
   */
  async initialize() {
    throw new Error('initialize() must be implemented by subclass');
  }

  /**
   * Envoie un SMS
   * @param {string} to - Numéro destinataire (format E.164)
   * @param {string} text - Contenu du message
   * @param {Object} options - Options supplémentaires
   * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
   */
  async sendMessage(to, text, options = {}) {
    throw new Error('sendMessage() must be implemented by subclass');
  }

  /**
   * Retourne l'état de connexion du provider
   * @returns {Promise<{status: string, details?: Object}>}
   */
  async getStatus() {
    throw new Error('getStatus() must be implemented by subclass');
  }

  /**
   * Déconnecte proprement le provider
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error('disconnect() must be implemented by subclass');
  }

  // ==================== Méthodes Optionnelles ====================
  // Ces méthodes peuvent être surchargées si le provider les supporte

  /**
   * Récupère le solde/crédits restants
   * @returns {Promise<{credits?: number, currency?: string}>}
   */
  async getBalance() {
    return { credits: null, currency: null };
  }

  /**
   * Récupère l'historique des messages envoyés
   * @param {Object} filters - Filtres (date, status, etc.)
   * @returns {Promise<Array>}
   */
  async getMessageHistory(filters = {}) {
    return [];
  }

  /**
   * Vérifie le statut de livraison d'un message
   * @param {string} messageId - ID du message
   * @returns {Promise<{status: string, deliveredAt?: Date}>}
   */
  async getDeliveryStatus(messageId) {
    return { status: 'unknown' };
  }

  /**
   * Gère un webhook entrant (réception SMS, DLR)
   * @param {Object} data - Données du webhook
   * @returns {Promise<Object>}
   */
  async handleWebhook(data) {
    logger.warn(`[${this.id}] Webhook not implemented`);
    return { acknowledged: true };
  }

  // ==================== Méthodes Utilitaires ====================

  /**
   * Retourne le nom du provider
   */
  getProviderName() {
    return this.type;
  }

  /**
   * Retourne l'ID unique du provider
   */
  getProviderId() {
    return this.id;
  }

  /**
   * Vérifie la compliance avant envoi (France, etc.)
   * @param {string} to - Numéro destinataire
   * @param {string} text - Contenu du message
   * @param {string} country - Code pays (FR, BE, etc.)
   * @returns {Promise<{allowed: boolean, reason?: string, modifiedText?: string}>}
   */
  async checkCompliance(to, text, country = 'FR') {
    try {
      const complianceService = require('../../../services/SmsComplianceService');
      return complianceService.check(to, text, country, this.config);
    } catch (error) {
      // Si le service n'existe pas encore, autoriser par défaut
      logger.warn(`[${this.id}] Compliance service not available, allowing message`);
      return { allowed: true };
    }
  }

  /**
   * Formate un numéro de téléphone au format E.164
   * @param {string} number - Numéro brut
   * @param {string} defaultCountry - Code pays par défaut
   * @returns {string} Numéro formaté
   */
  formatPhoneNumber(number, defaultCountry = 'FR') {
    if (!number) return number;

    // Nettoyer le numéro
    let cleaned = number.replace(/[\s\-\.\(\)]/g, '');

    // Déjà au format international
    if (cleaned.startsWith('+')) {
      return cleaned;
    }

    // Format français
    if (defaultCountry === 'FR') {
      if (cleaned.startsWith('0')) {
        return '+33' + cleaned.substring(1);
      }
      if (cleaned.startsWith('33')) {
        return '+' + cleaned;
      }
    }

    // Format belge
    if (defaultCountry === 'BE') {
      if (cleaned.startsWith('0')) {
        return '+32' + cleaned.substring(1);
      }
    }

    // Format suisse
    if (defaultCountry === 'CH') {
      if (cleaned.startsWith('0')) {
        return '+41' + cleaned.substring(1);
      }
    }

    // Par défaut, supposer français si commence par 06 ou 07
    if (/^0[67]\d{8}$/.test(cleaned)) {
      return '+33' + cleaned.substring(1);
    }

    return cleaned;
  }

  /**
   * Valide un numéro de téléphone
   * @param {string} number - Numéro à valider
   * @returns {boolean}
   */
  isValidPhoneNumber(number) {
    // Format E.164: + suivi de 7-15 chiffres
    return /^\+[1-9]\d{6,14}$/.test(number);
  }

  /**
   * Émet un événement avec contexte provider
   * @param {string} event - Nom de l'événement
   * @param {Object} data - Données de l'événement
   */
  emitEvent(event, data) {
    const enrichedData = {
      providerId: this.id,
      providerType: this.type,
      timestamp: Date.now(),
      ...data
    };

    this.emit(event, enrichedData);

    // Émettre aussi sur le bus d'événements global si disponible
    try {
      const eventService = require('../../../services/EventService');
      eventService.emit(`sms:${event}`, enrichedData);
    } catch (e) {
      // EventService optionnel
    }
  }

  /**
   * Met à jour le statut du provider
   * @param {string} status - Nouveau statut
   * @param {string} error - Message d'erreur optionnel
   */
  setStatus(status, error = null) {
    const oldStatus = this.status;
    this.status = status;
    this.lastError = error;

    if (oldStatus !== status) {
      this.emitEvent('status_changed', {
        oldStatus,
        newStatus: status,
        error
      });
    }
  }

  /**
   * Incrémente les statistiques
   * @param {string} stat - Nom de la stat (sent, received, failed)
   */
  incrementStat(stat) {
    if (stat === 'sent') this.stats.messagesSent++;
    else if (stat === 'received') this.stats.messagesReceived++;
    else if (stat === 'failed') this.stats.messagesFailed++;

    this.stats.lastActivity = Date.now();
  }

  /**
   * Retourne les statistiques du provider
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Retourne les capacités du provider
   */
  getCapabilities() {
    return {
      canSend: true,
      canReceive: false,
      supportsUnicode: true,
      supportsDeliveryReports: false,
      maxMessageLength: 160,
      supportsLongSms: true,
      supportsMms: false
    };
  }

  /**
   * Log avec contexte provider
   */
  log(level, message, data = {}) {
    const logMessage = `[SMS:${this.id}] ${message}`;
    if (level === 'error') logger.error(logMessage, data);
    else if (level === 'warn') logger.warn(logMessage, data);
    else if (level === 'debug') logger.debug(logMessage, data);
    else logger.info(logMessage, data);
  }
}

module.exports = SmsProvider;
