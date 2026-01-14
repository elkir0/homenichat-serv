const logger = require('winston');

/**
 * Gestionnaire des limites de débit pour WhatsApp Cloud API
 * Gère les limites par seconde, par paire et par heure
 */
class RateLimitManager {
  constructor() {
    // Limites par défaut (peuvent être augmentées par Meta)
    this.messagesPerSecond = 80;
    this.maxMessagesPerSecond = 1000; // Maximum après upgrade
    
    // Tracking des messages par paire (6 secondes entre chaque message)
    this.pairLimits = new Map();
    
    // Tracking des appels API par heure
    this.apiCallsPerHour = 0;
    this.resetTime = Date.now() + 3600000; // 1 heure
    
    // Queue pour les messages en attente
    this.messageQueue = new Map();
    
    // Compteurs pour le monitoring
    this.metrics = {
      totalMessages: 0,
      throttledMessages: 0,
      queuedMessages: 0
    };
  }

  /**
   * Vérifie si un message peut être envoyé maintenant
   * @param {string} phoneNumber - Le numéro de téléphone destinataire
   * @returns {Promise<boolean>} - True si le message peut être envoyé
   */
  async checkRateLimit(phoneNumber) {
    const now = Date.now();
    
    // Reset du compteur horaire si nécessaire
    if (now > this.resetTime) {
      this.apiCallsPerHour = 0;
      this.resetTime = now + 3600000;
      logger.info('Compteur API horaire réinitialisé');
    }

    // Vérifier la limite API horaire (5000/h pour les comptes actifs)
    if (this.apiCallsPerHour >= 5000) {
      const waitTime = this.resetTime - now;
      throw new Error(`Limite API dépassée. Réessayez dans ${Math.ceil(waitTime / 60000)} minutes`);
    }

    // Vérifier la limite par paire (6 secondes minimum)
    if (phoneNumber && this.pairLimits.has(phoneNumber)) {
      const lastSent = this.pairLimits.get(phoneNumber);
      const timeSince = now - lastSent;
      
      if (timeSince < 6000) {
        const waitTime = 6000 - timeSince;
        this.metrics.throttledMessages++;
        throw new Error(`Limite par paire atteinte. Attendez ${waitTime}ms avant le prochain message à ${phoneNumber}`);
      }
    }

    return true;
  }

  /**
   * Enregistre l'envoi d'un message
   * @param {string} phoneNumber - Le numéro de téléphone destinataire
   */
  recordMessage(phoneNumber) {
    const now = Date.now();
    
    // Enregistrer le timestamp pour la limite par paire
    if (phoneNumber) {
      this.pairLimits.set(phoneNumber, now);
    }
    
    // Incrémenter les compteurs
    this.apiCallsPerHour++;
    this.metrics.totalMessages++;
    
    // Nettoyer les anciennes entrées (plus de 10 minutes)
    this.cleanupOldEntries();
  }

  /**
   * Ajoute un message à la queue s'il ne peut pas être envoyé immédiatement
   * @param {string} phoneNumber - Le numéro de téléphone
   * @param {Object} message - Le message à envoyer
   * @param {Function} callback - Callback à exécuter quand le message peut être envoyé
   */
  queueMessage(phoneNumber, message, callback) {
    const queueKey = phoneNumber || 'broadcast';
    
    if (!this.messageQueue.has(queueKey)) {
      this.messageQueue.set(queueKey, []);
    }
    
    this.messageQueue.get(queueKey).push({ message, callback, timestamp: Date.now() });
    this.metrics.queuedMessages++;
    
    // Planifier le traitement de la queue
    this.scheduleQueueProcessing(phoneNumber);
  }

  /**
   * Planifie le traitement de la queue pour un numéro
   * @param {string} phoneNumber - Le numéro de téléphone
   */
  scheduleQueueProcessing(phoneNumber) {
    const lastSent = this.pairLimits.get(phoneNumber);
    if (!lastSent) {
      // Peut envoyer immédiatement
      this.processQueue(phoneNumber);
      return;
    }
    
    const timeSince = Date.now() - lastSent;
    const waitTime = Math.max(0, 6000 - timeSince);
    
    setTimeout(() => {
      this.processQueue(phoneNumber);
    }, waitTime);
  }

  /**
   * Traite la queue de messages pour un numéro
   * @param {string} phoneNumber - Le numéro de téléphone
   */
  async processQueue(phoneNumber) {
    const queueKey = phoneNumber || 'broadcast';
    const queue = this.messageQueue.get(queueKey);
    
    if (!queue || queue.length === 0) {
      return;
    }
    
    const item = queue.shift();
    if (item) {
      try {
        await this.checkRateLimit(phoneNumber);
        await item.callback();
        this.recordMessage(phoneNumber);
        
        // Traiter le prochain message après 6 secondes
        if (queue.length > 0) {
          setTimeout(() => {
            this.processQueue(phoneNumber);
          }, 6100); // 6.1 secondes pour être sûr
        }
      } catch (error) {
        logger.error('Erreur lors du traitement de la queue:', error);
        // Remettre le message dans la queue
        queue.unshift(item);
      }
    }
    
    // Supprimer la queue si elle est vide
    if (queue.length === 0) {
      this.messageQueue.delete(queueKey);
    }
  }

  /**
   * Nettoie les anciennes entrées pour libérer la mémoire
   */
  cleanupOldEntries() {
    const now = Date.now();
    const tenMinutesAgo = now - 600000;
    
    // Nettoyer les limites par paire
    for (const [phoneNumber, timestamp] of this.pairLimits) {
      if (timestamp < tenMinutesAgo) {
        this.pairLimits.delete(phoneNumber);
      }
    }
    
    // Nettoyer les messages en queue trop anciens
    for (const [key, queue] of this.messageQueue) {
      const filtered = queue.filter(item => item.timestamp > tenMinutesAgo);
      if (filtered.length === 0) {
        this.messageQueue.delete(key);
      } else {
        this.messageQueue.set(key, filtered);
      }
    }
  }

  /**
   * Obtient les statistiques actuelles
   * @returns {Object} - Les statistiques de rate limiting
   */
  getStats() {
    return {
      currentHourAPICalls: this.apiCallsPerHour,
      resetIn: Math.ceil((this.resetTime - Date.now()) / 60000) + ' minutes',
      activePairs: this.pairLimits.size,
      queuedMessages: Array.from(this.messageQueue.values()).reduce((sum, queue) => sum + queue.length, 0),
      metrics: this.metrics
    };
  }

  /**
   * Vérifie si on approche des limites
   * @returns {Object} - Alertes sur les limites
   */
  getWarnings() {
    const warnings = [];
    
    // Alerte si on approche de la limite horaire
    if (this.apiCallsPerHour > 4500) {
      warnings.push({
        type: 'API_LIMIT',
        message: `Approche de la limite API: ${this.apiCallsPerHour}/5000 appels cette heure`
      });
    }
    
    // Alerte si beaucoup de messages en queue
    const totalQueued = Array.from(this.messageQueue.values()).reduce((sum, queue) => sum + queue.length, 0);
    if (totalQueued > 100) {
      warnings.push({
        type: 'QUEUE_SIZE',
        message: `${totalQueued} messages en attente dans la queue`
      });
    }
    
    return warnings;
  }
}

module.exports = RateLimitManager;