const logger = require('winston');

/**
 * Gestionnaire d'erreurs pour WhatsApp Cloud API
 * Gère les retries et les erreurs spécifiques à l'API
 */
class ErrorHandler {
  constructor() {
    // Erreurs qui peuvent être retryées
    this.retryableErrors = new Set([
      4,      // Rate limit API
      130429, // Limite débit atteinte
      131048, // Re-engagement message
      131056  // Limite paire (6s)
    ]);
    
    // Erreurs permanentes qui ne doivent pas être retryées
    this.permanentErrors = new Set([
      131049, // Limite fréquence (24h)
      130472, // User has blocked the business
      132016, // Business account is restricted
      368     // Violation politique
    ]);
    
    // Descriptions des erreurs pour un meilleur debugging
    this.errorDescriptions = {
      4: 'Rate limit API atteint',
      100: 'Paramètre invalide',
      130429: 'Limite de débit atteinte',
      131026: 'Message non livrable - numéro invalide',
      131047: 'Ré-engagement requis - utilisez un template',
      131049: 'Limite de fréquence - attendez 24h',
      131051: 'Type de message non supporté hors de la fenêtre 24h',
      131056: 'Limite par paire atteinte - attendez 6 secondes',
      190: 'Token expiré',
      368: 'Violation des politiques WhatsApp'
    };
  }

  /**
   * Exécute une opération avec retry automatique
   * @param {Function} operation - L'opération à exécuter
   * @param {number} maxRetries - Nombre maximum de tentatives
   * @returns {Promise<any>} - Le résultat de l'opération
   */
  async handleWithRetry(operation, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const errorCode = this.getErrorCode(error);
        const errorMessage = this.getErrorMessage(error);
        
        logger.error(`Tentative ${attempt + 1} échouée:`, {
          code: errorCode,
          message: errorMessage,
          description: this.errorDescriptions[errorCode]
        });
        
        // Erreurs non-retry
        if (this.permanentErrors.has(errorCode)) {
          throw new Error(`Erreur permanente ${errorCode}: ${this.errorDescriptions[errorCode] || errorMessage}`);
        }
        
        // Dernière tentative
        if (attempt === maxRetries) {
          throw error;
        }
        
        // Si l'erreur n'est pas retryable, on arrête
        if (errorCode && !this.retryableErrors.has(errorCode)) {
          throw error;
        }
        
        // Calculer le délai avec backoff exponentiel
        const delay = this.getRetryDelay(errorCode, attempt);
        logger.info(`Retry dans ${delay}ms...`);
        
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Extrait le code d'erreur de la réponse
   * @param {Error} error - L'erreur reçue
   * @returns {number|null} - Le code d'erreur ou null
   */
  getErrorCode(error) {
    return error.response?.data?.error?.code || null;
  }

  /**
   * Extrait le message d'erreur
   * @param {Error} error - L'erreur reçue
   * @returns {string} - Le message d'erreur
   */
  getErrorMessage(error) {
    return error.response?.data?.error?.message || error.message || 'Erreur inconnue';
  }

  /**
   * Calcule le délai de retry basé sur le type d'erreur
   * @param {number} errorCode - Le code d'erreur
   * @param {number} attempt - Le numéro de tentative
   * @returns {number} - Le délai en millisecondes
   */
  getRetryDelay(errorCode, attempt) {
    const baseDelays = {
      4: 1000,       // Rate limit API
      130429: 2000,  // Débit max
      131056: 6000,  // Limite paire (6 secondes minimum)
      131048: 1000   // Re-engagement
    };
    
    const baseDelay = baseDelays[errorCode] || 1000;
    
    // Backoff exponentiel avec un maximum de 30 secondes
    return Math.min(baseDelay * Math.pow(2, attempt), 30000);
  }

  /**
   * Vérifie si une erreur nécessite un template
   * @param {Error} error - L'erreur reçue
   * @returns {boolean} - True si un template est requis
   */
  requiresTemplate(error) {
    const errorCode = this.getErrorCode(error);
    return errorCode === 131047 || errorCode === 131051;
  }

  /**
   * Vérifie si l'erreur est due à un rate limit
   * @param {Error} error - L'erreur reçue
   * @returns {boolean} - True si c'est un rate limit
   */
  isRateLimitError(error) {
    const errorCode = this.getErrorCode(error);
    return errorCode === 4 || errorCode === 130429 || errorCode === 131056;
  }

  /**
   * Formate une erreur pour l'affichage
   * @param {Error} error - L'erreur à formater
   * @returns {Object} - L'erreur formatée
   */
  formatError(error) {
    const code = this.getErrorCode(error);
    const message = this.getErrorMessage(error);
    
    return {
      code: code,
      message: message,
      description: this.errorDescriptions[code] || 'Erreur inconnue',
      retryable: this.retryableErrors.has(code),
      requiresTemplate: this.requiresTemplate(error),
      isRateLimit: this.isRateLimitError(error)
    };
  }
}

module.exports = ErrorHandler;