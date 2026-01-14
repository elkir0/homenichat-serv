/**
 * SmsRoutingService - Routage intelligent des SMS multi-provider
 *
 * Fonctionnalités:
 * - Sélection automatique du provider optimal
 * - Fallback automatique en cas d'échec
 * - Routage basé sur préfixes (ex: +33 -> OVH, autres -> Twilio)
 * - Load balancing round-robin optionnel
 * - Statistiques et monitoring
 * - Health checks périodiques
 */

const EventEmitter = require('events');
const logger = require('winston');
const configService = require('./ConfigurationService');

class SmsRoutingService extends EventEmitter {
  constructor() {
    super();
    this.providers = new Map();       // id -> provider instance
    this.providerHealth = new Map();  // id -> { healthy: boolean, lastCheck: Date, failures: number }
    this.routingRules = [];           // Règles de routage par préfixe
    this.defaultProvider = null;
    this.fallbackChain = [];          // Ordre de fallback
    this.stats = {
      totalSent: 0,
      totalFailed: 0,
      byProvider: {},
      lastSentAt: null
    };
    this.healthCheckInterval = null;
  }

  /**
   * Initialise le service avec les providers configurés
   */
  async initialize() {
    try {
      logger.info('[SmsRouting] Initializing...');

      // Charger la configuration
      const smsProviders = configService.getEnabledProviders('sms');

      if (smsProviders.length === 0) {
        logger.warn('[SmsRouting] No SMS providers enabled');
        return false;
      }

      // Charger chaque provider
      for (const providerConfig of smsProviders) {
        await this.loadProvider(providerConfig);
      }

      // Configurer les règles de routage
      this.setupRoutingRules();

      // Démarrer les health checks
      this.startHealthChecks();

      logger.info(`[SmsRouting] Initialized with ${this.providers.size} providers`);
      return true;
    } catch (error) {
      logger.error('[SmsRouting] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Charge et initialise un provider SMS
   */
  async loadProvider(providerConfig) {
    const { id, type, config } = providerConfig;

    try {
      let ProviderClass;

      // Mapper le type au fichier
      switch (type) {
        case 'ovh':
          ProviderClass = require('../providers/sms/cloud/OvhSmsProvider');
          break;
        case 'twilio':
          ProviderClass = require('../providers/sms/cloud/TwilioSmsProvider');
          break;
        case 'sms_bridge':
          ProviderClass = require('../providers/sms/SmsBridgeProvider');
          break;
        case 'plivo':
          // À implémenter
          logger.warn(`[SmsRouting] Provider type '${type}' not yet implemented`);
          return;
        case 'messagebird':
          // À implémenter
          logger.warn(`[SmsRouting] Provider type '${type}' not yet implemented`);
          return;
        default:
          logger.error(`[SmsRouting] Unknown provider type: ${type}`);
          return;
      }

      const provider = new ProviderClass(providerConfig);
      await provider.initialize();

      this.providers.set(id, provider);
      this.providerHealth.set(id, {
        healthy: true,
        lastCheck: new Date(),
        failures: 0,
        consecutiveFailures: 0
      });

      // Initialiser les stats
      this.stats.byProvider[id] = {
        sent: 0,
        failed: 0,
        lastUsed: null
      };

      // Écouter les événements du provider
      provider.on('message_sent', (data) => this.onProviderMessageSent(id, data));
      provider.on('message_received', (data) => this.onProviderMessageReceived(id, data));
      provider.on('status_changed', (data) => this.onProviderStatusChanged(id, data));

      logger.info(`[SmsRouting] Provider '${id}' (${type}) loaded successfully`);

      // Définir le premier provider comme défaut
      if (!this.defaultProvider) {
        this.defaultProvider = id;
        this.fallbackChain.push(id);
      } else {
        this.fallbackChain.push(id);
      }

    } catch (error) {
      logger.error(`[SmsRouting] Failed to load provider '${id}':`, error);
      this.providerHealth.set(id, {
        healthy: false,
        lastCheck: new Date(),
        failures: 1,
        error: error.message
      });
    }
  }

  /**
   * Configure les règles de routage basées sur la configuration
   */
  setupRoutingRules() {
    // Règles par défaut (peuvent être personnalisées via config)
    this.routingRules = [
      // France -> OVH (si disponible)
      {
        pattern: /^\+33/,
        providerId: this.findProviderByType('ovh'),
        fallback: this.findProviderByType('twilio'),
        priority: 1
      },
      // International -> Twilio (meilleure couverture)
      {
        pattern: /^\+(?!33)/,
        providerId: this.findProviderByType('twilio'),
        fallback: this.findProviderByType('ovh'),
        priority: 2
      },
      // SMS Bridge pour les numéros locaux
      {
        pattern: /^sms_/,
        providerId: this.findProviderByType('sms_bridge'),
        fallback: null,
        priority: 0
      }
    ];

    // Charger les règles personnalisées depuis config si présentes
    const customRules = configService.getConfig()?.routing?.sms || [];
    for (const rule of customRules) {
      this.routingRules.push({
        pattern: new RegExp(rule.pattern),
        providerId: rule.provider,
        fallback: rule.fallback,
        priority: rule.priority || 10
      });
    }

    // Trier par priorité
    this.routingRules.sort((a, b) => a.priority - b.priority);

    logger.info(`[SmsRouting] ${this.routingRules.length} routing rules configured`);
  }

  /**
   * Trouve un provider par son type
   */
  findProviderByType(type) {
    for (const [id, provider] of this.providers) {
      if (provider.type === type || provider.getProviderName() === type) {
        return id;
      }
    }
    return null;
  }

  /**
   * Sélectionne le meilleur provider pour un numéro donné
   */
  selectProvider(phoneNumber) {
    // Appliquer les règles de routage
    for (const rule of this.routingRules) {
      if (rule.pattern.test(phoneNumber)) {
        const providerId = rule.providerId;

        // Vérifier si le provider est disponible et healthy
        if (providerId && this.isProviderHealthy(providerId)) {
          return providerId;
        }

        // Essayer le fallback
        if (rule.fallback && this.isProviderHealthy(rule.fallback)) {
          logger.info(`[SmsRouting] Using fallback provider for ${phoneNumber}`);
          return rule.fallback;
        }
      }
    }

    // Fallback: premier provider healthy
    for (const id of this.fallbackChain) {
      if (this.isProviderHealthy(id)) {
        return id;
      }
    }

    logger.error('[SmsRouting] No healthy provider available');
    return null;
  }

  /**
   * Vérifie si un provider est healthy
   */
  isProviderHealthy(providerId) {
    const health = this.providerHealth.get(providerId);
    return health && health.healthy && health.consecutiveFailures < 3;
  }

  /**
   * Envoie un SMS avec routage intelligent
   */
  async sendMessage(to, text, options = {}) {
    const startTime = Date.now();

    // Sélectionner le provider
    let providerId = options.providerId || this.selectProvider(to);

    if (!providerId) {
      this.stats.totalFailed++;
      return {
        success: false,
        error: 'No SMS provider available'
      };
    }

    // Tenter l'envoi avec fallback
    const attemptedProviders = [];
    let lastError = null;

    while (providerId && !attemptedProviders.includes(providerId)) {
      attemptedProviders.push(providerId);

      const provider = this.providers.get(providerId);
      if (!provider) {
        providerId = this.getNextFallback(providerId);
        continue;
      }

      try {
        logger.info(`[SmsRouting] Sending to ${to} via ${providerId}`);

        const result = await provider.sendMessage(to, text, options);

        if (result.success) {
          this.onSendSuccess(providerId, to, result);
          return {
            ...result,
            providerId,
            latency: Date.now() - startTime
          };
        }

        // Échec mais pas d'erreur critique -> essayer fallback
        lastError = result.error;
        this.onSendFailure(providerId, to, result.error);

      } catch (error) {
        lastError = error.message;
        this.onSendFailure(providerId, to, error.message);
      }

      // Passer au provider suivant
      providerId = this.getNextFallback(providerId);
    }

    // Tous les providers ont échoué
    this.stats.totalFailed++;
    return {
      success: false,
      error: lastError || 'All providers failed',
      attemptedProviders
    };
  }

  /**
   * Obtient le prochain provider dans la chaîne de fallback
   */
  getNextFallback(currentProviderId) {
    const currentIndex = this.fallbackChain.indexOf(currentProviderId);
    if (currentIndex >= 0 && currentIndex < this.fallbackChain.length - 1) {
      const next = this.fallbackChain[currentIndex + 1];
      if (this.isProviderHealthy(next)) {
        return next;
      }
    }
    return null;
  }

  /**
   * Callback lors d'un envoi réussi
   */
  onSendSuccess(providerId, to, result) {
    this.stats.totalSent++;
    this.stats.lastSentAt = new Date();
    this.stats.byProvider[providerId].sent++;
    this.stats.byProvider[providerId].lastUsed = new Date();

    // Reset des failures consécutifs
    const health = this.providerHealth.get(providerId);
    if (health) {
      health.consecutiveFailures = 0;
      health.healthy = true;
    }

    this.emit('message_sent', { providerId, to, result });
  }

  /**
   * Callback lors d'un échec d'envoi
   */
  onSendFailure(providerId, to, error) {
    this.stats.byProvider[providerId].failed++;

    const health = this.providerHealth.get(providerId);
    if (health) {
      health.failures++;
      health.consecutiveFailures++;
      health.lastError = error;

      // Marquer comme unhealthy après 3 échecs consécutifs
      if (health.consecutiveFailures >= 3) {
        health.healthy = false;
        logger.warn(`[SmsRouting] Provider '${providerId}' marked as unhealthy`);
        this.emit('provider_unhealthy', { providerId, error });
      }
    }

    this.emit('message_failed', { providerId, to, error });
  }

  /**
   * Événements des providers
   */
  onProviderMessageSent(providerId, data) {
    this.emit('provider_message_sent', { providerId, ...data });
  }

  onProviderMessageReceived(providerId, data) {
    this.emit('message_received', { providerId, ...data });
  }

  onProviderStatusChanged(providerId, data) {
    const health = this.providerHealth.get(providerId);
    if (health) {
      health.healthy = data.newStatus === 'connected';
    }
    this.emit('provider_status_changed', { providerId, ...data });
  }

  /**
   * Démarre les health checks périodiques
   */
  startHealthChecks() {
    // Health check toutes les 60 secondes
    this.healthCheckInterval = setInterval(async () => {
      await this.runHealthChecks();
    }, 60000);

    // Premier check immédiat
    this.runHealthChecks();
  }

  /**
   * Exécute les health checks sur tous les providers
   */
  async runHealthChecks() {
    for (const [id, provider] of this.providers) {
      try {
        const status = await provider.getStatus();
        const health = this.providerHealth.get(id);

        health.lastCheck = new Date();

        if (status.status === 'connected' || status.status === 'ok') {
          if (!health.healthy) {
            logger.info(`[SmsRouting] Provider '${id}' recovered`);
            this.emit('provider_recovered', { providerId: id });
          }
          health.healthy = true;
          health.consecutiveFailures = 0;
        } else {
          health.healthy = false;
          health.lastError = status.error || 'Health check failed';
        }
      } catch (error) {
        const health = this.providerHealth.get(id);
        health.healthy = false;
        health.lastError = error.message;
        health.lastCheck = new Date();
      }
    }
  }

  /**
   * Arrête les health checks
   */
  stopHealthChecks() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Retourne le statut de tous les providers
   */
  getStatus() {
    const providers = {};

    for (const [id, provider] of this.providers) {
      const health = this.providerHealth.get(id);
      providers[id] = {
        type: provider.getProviderName(),
        healthy: health?.healthy || false,
        lastCheck: health?.lastCheck || null,
        failures: health?.failures || 0,
        consecutiveFailures: health?.consecutiveFailures || 0,
        lastError: health?.lastError || null,
        stats: this.stats.byProvider[id] || {}
      };
    }

    return {
      defaultProvider: this.defaultProvider,
      fallbackChain: this.fallbackChain,
      providers,
      stats: {
        totalSent: this.stats.totalSent,
        totalFailed: this.stats.totalFailed,
        lastSentAt: this.stats.lastSentAt
      }
    };
  }

  /**
   * Récupère le solde de tous les providers
   */
  async getAllBalances() {
    const balances = {};

    for (const [id, provider] of this.providers) {
      try {
        if (typeof provider.getBalance === 'function') {
          balances[id] = await provider.getBalance();
        }
      } catch (error) {
        balances[id] = { error: error.message };
      }
    }

    return balances;
  }

  /**
   * Force l'utilisation d'un provider spécifique
   */
  setDefaultProvider(providerId) {
    if (this.providers.has(providerId)) {
      this.defaultProvider = providerId;
      logger.info(`[SmsRouting] Default provider set to '${providerId}'`);
    }
  }

  /**
   * Reconfigure la chaîne de fallback
   */
  setFallbackChain(chain) {
    this.fallbackChain = chain.filter(id => this.providers.has(id));
    logger.info(`[SmsRouting] Fallback chain updated: ${this.fallbackChain.join(' -> ')}`);
  }

  /**
   * Nettoyage
   */
  async shutdown() {
    this.stopHealthChecks();

    for (const [id, provider] of this.providers) {
      try {
        await provider.disconnect();
      } catch (error) {
        logger.warn(`[SmsRouting] Error disconnecting provider '${id}':`, error.message);
      }
    }

    this.providers.clear();
    logger.info('[SmsRouting] Service shut down');
  }
}

// Export singleton
module.exports = new SmsRoutingService();
