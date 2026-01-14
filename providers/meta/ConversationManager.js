const logger = require('winston');

/**
 * Gestionnaire des conversations WhatsApp
 * Gère la fenêtre de 24h et les types de conversations
 */
class ConversationManager {
  constructor() {
    // Stockage des sessions de conversation
    this.sessions = new Map();
    
    // Types de conversations
    this.conversationTypes = {
      SERVICE: 'service',          // Initiée par le client (UIC)
      MARKETING: 'marketing',      // Template marketing (BIC)
      UTILITY: 'utility',          // Template utilitaire (BIC)
      AUTHENTICATION: 'authentication' // Template auth (BIC)
    };
    
    // Durée de la fenêtre de conversation (24 heures)
    this.windowDuration = 24 * 60 * 60 * 1000;
    
    // Statistiques
    this.stats = {
      activeConversations: 0,
      expiredConversations: 0,
      templatesSent: 0,
      freeformMessages: 0
    };
  }

  /**
   * Met à jour ou crée une session de conversation
   * @param {string} phoneNumber - Le numéro de téléphone
   * @param {string} type - Le type de conversation
   * @param {boolean} isIncoming - Si c'est un message entrant
   */
  updateSession(phoneNumber, type = 'service', isIncoming = false) {
    const now = Date.now();
    const existingSession = this.sessions.get(phoneNumber);
    
    if (!existingSession || this.isSessionExpired(existingSession)) {
      // Nouvelle session
      const newSession = {
        phoneNumber,
        type: isIncoming ? this.conversationTypes.SERVICE : type,
        startTime: now,
        lastActivity: now,
        messageCount: 1,
        isActive: true,
        initiatedBy: isIncoming ? 'customer' : 'business'
      };
      
      this.sessions.set(phoneNumber, newSession);
      this.stats.activeConversations++;
      
      logger.info(`Nouvelle conversation ${type} démarrée avec ${phoneNumber}`);
    } else {
      // Mise à jour de la session existante
      existingSession.lastActivity = now;
      existingSession.messageCount++;
      
      // Si c'est un message client, on passe en conversation de service
      if (isIncoming && existingSession.type !== this.conversationTypes.SERVICE) {
        existingSession.type = this.conversationTypes.SERVICE;
        existingSession.initiatedBy = 'customer';
      }
    }
    
    // Nettoyer les anciennes sessions
    this.cleanupExpiredSessions();
  }

  /**
   * Vérifie si on peut envoyer un message en texte libre
   * @param {string} phoneNumber - Le numéro de téléphone
   * @returns {boolean} - True si dans la fenêtre de 24h
   */
  canSendFreeform(phoneNumber) {
    const session = this.sessions.get(phoneNumber);
    
    if (!session) {
      return false;
    }
    
    // Vérifier si la session est expirée
    if (this.isSessionExpired(session)) {
      session.isActive = false;
      return false;
    }
    
    // On peut envoyer des messages libres dans la fenêtre de 24h
    return true;
  }

  /**
   * Vérifie si une session est expirée
   * @param {Object} session - La session à vérifier
   * @returns {boolean} - True si expirée
   */
  isSessionExpired(session) {
    const now = Date.now();
    const timeSinceLastActivity = now - session.lastActivity;
    
    return timeSinceLastActivity > this.windowDuration;
  }

  /**
   * Obtient le temps restant dans la fenêtre de conversation
   * @param {string} phoneNumber - Le numéro de téléphone
   * @returns {number} - Temps restant en millisecondes
   */
  getRemainingTime(phoneNumber) {
    const session = this.sessions.get(phoneNumber);
    
    if (!session || this.isSessionExpired(session)) {
      return 0;
    }
    
    const elapsed = Date.now() - session.lastActivity;
    return Math.max(0, this.windowDuration - elapsed);
  }

  /**
   * Obtient le type de message à envoyer
   * @param {string} phoneNumber - Le numéro de téléphone
   * @returns {Object} - Type de message et template requis
   */
  getMessageStrategy(phoneNumber) {
    const canSendFreeform = this.canSendFreeform(phoneNumber);
    
    if (canSendFreeform) {
      this.stats.freeformMessages++;
      return {
        type: 'text',
        requiresTemplate: false,
        reason: 'Dans la fenêtre de 24h'
      };
    } else {
      this.stats.templatesSent++;
      return {
        type: 'template',
        requiresTemplate: true,
        reason: 'Hors de la fenêtre de 24h - template requis'
      };
    }
  }

  /**
   * Enregistre l'envoi d'un template
   * @param {string} phoneNumber - Le numéro de téléphone
   * @param {string} templateName - Le nom du template
   * @param {string} category - La catégorie du template
   */
  recordTemplateSent(phoneNumber, templateName, category) {
    const conversationType = this.mapCategoryToType(category);
    this.updateSession(phoneNumber, conversationType, false);
    
    logger.info(`Template ${templateName} (${category}) envoyé à ${phoneNumber}`);
  }

  /**
   * Mappe une catégorie de template à un type de conversation
   * @param {string} category - La catégorie du template
   * @returns {string} - Le type de conversation
   */
  mapCategoryToType(category) {
    const mapping = {
      'MARKETING': this.conversationTypes.MARKETING,
      'UTILITY': this.conversationTypes.UTILITY,
      'AUTHENTICATION': this.conversationTypes.AUTHENTICATION
    };
    
    return mapping[category] || this.conversationTypes.UTILITY;
  }

  /**
   * Nettoie les sessions expirées
   */
  cleanupExpiredSessions() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [phoneNumber, session] of this.sessions) {
      if (this.isSessionExpired(session)) {
        this.sessions.delete(phoneNumber);
        cleaned++;
        this.stats.expiredConversations++;
        this.stats.activeConversations--;
      }
    }
    
    if (cleaned > 0) {
      logger.info(`${cleaned} sessions expirées nettoyées`);
    }
  }

  /**
   * Obtient les informations d'une session
   * @param {string} phoneNumber - Le numéro de téléphone
   * @returns {Object|null} - Les informations de la session
   */
  getSessionInfo(phoneNumber) {
    const session = this.sessions.get(phoneNumber);
    
    if (!session) {
      return null;
    }
    
    const remainingTime = this.getRemainingTime(phoneNumber);
    const isExpired = this.isSessionExpired(session);
    
    return {
      ...session,
      isExpired,
      remainingTime,
      remainingHours: Math.ceil(remainingTime / (60 * 60 * 1000)),
      canSendFreeform: !isExpired
    };
  }

  /**
   * Obtient les statistiques globales
   * @returns {Object} - Les statistiques
   */
  getStats() {
    // Recalculer les conversations actives
    this.stats.activeConversations = 0;
    for (const [_, session] of this.sessions) {
      if (!this.isSessionExpired(session)) {
        this.stats.activeConversations++;
      }
    }
    
    return {
      ...this.stats,
      totalSessions: this.sessions.size
    };
  }

  /**
   * Exporte les sessions actives (pour la persistence)
   * @returns {Array} - Les sessions actives
   */
  exportSessions() {
    const activeSessions = [];
    
    for (const [phoneNumber, session] of this.sessions) {
      if (!this.isSessionExpired(session)) {
        activeSessions.push(session);
      }
    }
    
    return activeSessions;
  }

  /**
   * Importe des sessions (pour la restoration)
   * @param {Array} sessions - Les sessions à importer
   */
  importSessions(sessions) {
    for (const session of sessions) {
      if (!this.isSessionExpired(session)) {
        this.sessions.set(session.phoneNumber, session);
      }
    }
    
    logger.info(`${sessions.length} sessions importées`);
  }
}

module.exports = ConversationManager;