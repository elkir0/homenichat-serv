const logger = require('winston');
const os = require('os');

/**
 * Service de monitoring pour WhatsApp Cloud API
 * Collecte et expose des métriques pour le suivi des performances
 */
class MonitoringService {
  constructor() {
    // Métriques globales
    this.metrics = {
      // Messages
      messages: {
        sent: {
          total: 0,
          success: 0,
          failed: 0,
          byType: {
            text: 0,
            image: 0,
            video: 0,
            audio: 0,
            document: 0,
            template: 0,
            interactive: 0
          }
        },
        received: {
          total: 0,
          byType: {}
        },
        statuses: {
          sent: 0,
          delivered: 0,
          read: 0,
          failed: 0
        }
      },
      
      // API
      api: {
        requests: {
          total: 0,
          success: 0,
          failed: 0,
          byEndpoint: {}
        },
        rateLimits: {
          hit: 0,
          throttled: 0,
          queued: 0
        },
        latency: {
          samples: [],
          p50: 0,
          p95: 0,
          p99: 0
        }
      },
      
      // Webhooks
      webhooks: {
        received: 0,
        processed: 0,
        failed: 0,
        byType: {}
      },
      
      // Conversations
      conversations: {
        active: 0,
        expired: 0,
        byType: {
          service: 0,
          marketing: 0,
          utility: 0,
          authentication: 0
        }
      },
      
      // Erreurs
      errors: {
        total: 0,
        byCode: {},
        byType: {}
      },
      
      // Système
      system: {
        uptime: 0,
        memory: {},
        cpu: {}
      }
    };
    
    // Historique pour les graphiques (dernières 24h)
    this.history = {
      hourly: new Array(24).fill(null).map(() => ({
        timestamp: 0,
        messages: { sent: 0, received: 0 },
        errors: 0,
        apiCalls: 0
      }))
    };
    
    // Alertes
    this.alerts = [];
    this.alertThresholds = {
      errorRate: 0.05, // 5% d'erreurs
      apiLatency: 5000, // 5 secondes
      queueSize: 1000, // 1000 messages en queue
      memoryUsage: 0.9 // 90% de mémoire
    };
    
    // Démarrer la collecte périodique
    this.startCollecting();
  }

  /**
   * Démarre la collecte périodique des métriques
   */
  startCollecting() {
    // Mise à jour toutes les minutes
    this.collectorInterval = setInterval(() => {
      this.updateSystemMetrics();
      this.rotateHistory();
      this.checkAlerts();
    }, 60000);
    
    // Nettoyage des échantillons de latence toutes les 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupLatencySamples();
    }, 300000);
  }

  /**
   * Arrête la collecte
   */
  stopCollecting() {
    if (this.collectorInterval) {
      clearInterval(this.collectorInterval);
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  /**
   * Enregistre l'envoi d'un message
   * @param {string} type - Type de message
   * @param {boolean} success - Succès ou échec
   */
  recordMessageSent(type, success) {
    this.metrics.messages.sent.total++;
    
    if (success) {
      this.metrics.messages.sent.success++;
    } else {
      this.metrics.messages.sent.failed++;
    }
    
    if (this.metrics.messages.sent.byType[type] !== undefined) {
      this.metrics.messages.sent.byType[type]++;
    }
    
    // Mettre à jour l'historique
    const currentHour = new Date().getHours();
    this.history.hourly[currentHour].messages.sent++;
  }

  /**
   * Enregistre la réception d'un message
   * @param {string} type - Type de message
   */
  recordMessageReceived(type) {
    this.metrics.messages.received.total++;
    
    if (!this.metrics.messages.received.byType[type]) {
      this.metrics.messages.received.byType[type] = 0;
    }
    this.metrics.messages.received.byType[type]++;
    
    // Mettre à jour l'historique
    const currentHour = new Date().getHours();
    this.history.hourly[currentHour].messages.received++;
  }

  /**
   * Enregistre un changement de statut de message
   * @param {string} status - Statut (sent, delivered, read, failed)
   */
  recordMessageStatus(status) {
    if (this.metrics.messages.statuses[status] !== undefined) {
      this.metrics.messages.statuses[status]++;
    }
  }

  /**
   * Enregistre un appel API
   * @param {string} endpoint - Endpoint appelé
   * @param {boolean} success - Succès ou échec
   * @param {number} latency - Latence en ms
   */
  recordApiCall(endpoint, success, latency) {
    this.metrics.api.requests.total++;
    
    if (success) {
      this.metrics.api.requests.success++;
    } else {
      this.metrics.api.requests.failed++;
    }
    
    if (!this.metrics.api.requests.byEndpoint[endpoint]) {
      this.metrics.api.requests.byEndpoint[endpoint] = { total: 0, success: 0, failed: 0 };
    }
    
    this.metrics.api.requests.byEndpoint[endpoint].total++;
    if (success) {
      this.metrics.api.requests.byEndpoint[endpoint].success++;
    } else {
      this.metrics.api.requests.byEndpoint[endpoint].failed++;
    }
    
    // Enregistrer la latence
    if (latency) {
      this.metrics.api.latency.samples.push({
        timestamp: Date.now(),
        value: latency
      });
      this.updateLatencyPercentiles();
    }
    
    // Mettre à jour l'historique
    const currentHour = new Date().getHours();
    this.history.hourly[currentHour].apiCalls++;
  }

  /**
   * Enregistre une limite de débit atteinte
   * @param {string} type - Type de limite (hit, throttled, queued)
   */
  recordRateLimit(type) {
    if (this.metrics.api.rateLimits[type] !== undefined) {
      this.metrics.api.rateLimits[type]++;
    }
  }

  /**
   * Enregistre un webhook reçu
   * @param {string} type - Type de webhook
   * @param {boolean} success - Traité avec succès ou non
   */
  recordWebhook(type, success) {
    this.metrics.webhooks.received++;
    
    if (success) {
      this.metrics.webhooks.processed++;
    } else {
      this.metrics.webhooks.failed++;
    }
    
    if (!this.metrics.webhooks.byType[type]) {
      this.metrics.webhooks.byType[type] = 0;
    }
    this.metrics.webhooks.byType[type]++;
  }

  /**
   * Enregistre une conversation
   * @param {string} type - Type de conversation
   * @param {boolean} active - Active ou expirée
   */
  recordConversation(type, active) {
    if (active) {
      this.metrics.conversations.active++;
    } else {
      this.metrics.conversations.expired++;
    }
    
    if (this.metrics.conversations.byType[type] !== undefined) {
      this.metrics.conversations.byType[type]++;
    }
  }

  /**
   * Enregistre une erreur
   * @param {Error} error - Erreur
   * @param {Object} context - Contexte de l'erreur
   */
  recordError(error, context = {}) {
    this.metrics.errors.total++;
    
    // Par code d'erreur
    const errorCode = error.code || error.response?.data?.error?.code || 'unknown';
    if (!this.metrics.errors.byCode[errorCode]) {
      this.metrics.errors.byCode[errorCode] = 0;
    }
    this.metrics.errors.byCode[errorCode]++;
    
    // Par type
    const errorType = context.type || 'general';
    if (!this.metrics.errors.byType[errorType]) {
      this.metrics.errors.byType[errorType] = 0;
    }
    this.metrics.errors.byType[errorType]++;
    
    // Mettre à jour l'historique
    const currentHour = new Date().getHours();
    this.history.hourly[currentHour].errors++;
    
    // Logger l'erreur
    logger.error('Monitored error:', {
      code: errorCode,
      type: errorType,
      message: error.message,
      context
    });
  }

  /**
   * Met à jour les métriques système
   */
  updateSystemMetrics() {
    // Uptime
    this.metrics.system.uptime = process.uptime();
    
    // Mémoire
    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    
    this.metrics.system.memory = {
      process: {
        rss: memUsage.rss,
        heapTotal: memUsage.heapTotal,
        heapUsed: memUsage.heapUsed,
        external: memUsage.external
      },
      system: {
        total: totalMem,
        free: freeMem,
        used: totalMem - freeMem,
        percentage: ((totalMem - freeMem) / totalMem) * 100
      }
    };
    
    // CPU
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });
    
    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    const usage = 100 - ~~(100 * idle / total);
    
    this.metrics.system.cpu = {
      cores: cpus.length,
      usage: usage,
      loadAverage: os.loadavg()
    };
  }

  /**
   * Met à jour les percentiles de latence
   */
  updateLatencyPercentiles() {
    const samples = this.metrics.api.latency.samples
      .map(s => s.value)
      .sort((a, b) => a - b);
    
    if (samples.length === 0) return;
    
    const p50Index = Math.floor(samples.length * 0.5);
    const p95Index = Math.floor(samples.length * 0.95);
    const p99Index = Math.floor(samples.length * 0.99);
    
    this.metrics.api.latency.p50 = samples[p50Index] || 0;
    this.metrics.api.latency.p95 = samples[p95Index] || 0;
    this.metrics.api.latency.p99 = samples[p99Index] || 0;
  }

  /**
   * Nettoie les anciens échantillons de latence
   */
  cleanupLatencySamples() {
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    
    this.metrics.api.latency.samples = this.metrics.api.latency.samples
      .filter(sample => sample.timestamp > fiveMinutesAgo);
    
    this.updateLatencyPercentiles();
  }

  /**
   * Fait tourner l'historique
   */
  rotateHistory() {
    const currentHour = new Date().getHours();
    
    // Réinitialiser l'heure actuelle
    this.history.hourly[currentHour] = {
      timestamp: Date.now(),
      messages: { sent: 0, received: 0 },
      errors: 0,
      apiCalls: 0
    };
  }

  /**
   * Vérifie les seuils d'alerte
   */
  checkAlerts() {
    const newAlerts = [];
    
    // Taux d'erreur
    const errorRate = this.metrics.api.requests.total > 0
      ? this.metrics.api.requests.failed / this.metrics.api.requests.total
      : 0;
    
    if (errorRate > this.alertThresholds.errorRate) {
      newAlerts.push({
        type: 'error_rate',
        severity: 'high',
        message: `Taux d'erreur élevé: ${(errorRate * 100).toFixed(2)}%`,
        timestamp: Date.now()
      });
    }
    
    // Latence API
    if (this.metrics.api.latency.p95 > this.alertThresholds.apiLatency) {
      newAlerts.push({
        type: 'api_latency',
        severity: 'medium',
        message: `Latence API élevée: P95 = ${this.metrics.api.latency.p95}ms`,
        timestamp: Date.now()
      });
    }
    
    // Utilisation mémoire
    const memoryUsage = this.metrics.system.memory.system.percentage / 100;
    if (memoryUsage > this.alertThresholds.memoryUsage) {
      newAlerts.push({
        type: 'memory_usage',
        severity: 'high',
        message: `Utilisation mémoire élevée: ${(memoryUsage * 100).toFixed(2)}%`,
        timestamp: Date.now()
      });
    }
    
    // Ajouter les nouvelles alertes
    this.alerts = [...this.alerts, ...newAlerts].slice(-100); // Garder les 100 dernières
    
    // Logger les alertes critiques
    newAlerts.forEach(alert => {
      if (alert.severity === 'high') {
        logger.error(`ALERTE: ${alert.message}`);
      } else {
        logger.warn(`Alerte: ${alert.message}`);
      }
    });
  }

  /**
   * Obtient toutes les métriques
   * @returns {Object} Métriques complètes
   */
  getMetrics() {
    return {
      metrics: this.metrics,
      history: this.history,
      alerts: this.alerts.slice(-20), // Dernières 20 alertes
      timestamp: Date.now()
    };
  }

  /**
   * Obtient un résumé des métriques
   * @returns {Object} Résumé
   */
  getSummary() {
    const successRate = this.metrics.api.requests.total > 0
      ? (this.metrics.api.requests.success / this.metrics.api.requests.total) * 100
      : 100;
    
    return {
      messages: {
        sentToday: this.metrics.messages.sent.total,
        receivedToday: this.metrics.messages.received.total,
        deliveryRate: this.metrics.messages.sent.total > 0
          ? (this.metrics.messages.statuses.delivered / this.metrics.messages.sent.total) * 100
          : 0
      },
      api: {
        successRate: successRate.toFixed(2),
        latencyP50: this.metrics.api.latency.p50,
        rateLimitHits: this.metrics.api.rateLimits.hit
      },
      system: {
        uptime: this.formatUptime(this.metrics.system.uptime),
        memoryUsage: this.metrics.system.memory.system.percentage?.toFixed(2) || 0,
        cpuUsage: this.metrics.system.cpu.usage || 0
      },
      activeAlerts: this.alerts.filter(a => a.severity === 'high').length
    };
  }

  /**
   * Formate le temps de fonctionnement
   * @param {number} seconds - Secondes
   * @returns {string} Temps formaté
   */
  formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    return `${days}j ${hours}h ${minutes}m`;
  }

  /**
   * Réinitialise les métriques
   */
  reset() {
    // Réinitialiser seulement certaines métriques, pas les compteurs système
    this.metrics.messages = {
      sent: { total: 0, success: 0, failed: 0, byType: {} },
      received: { total: 0, byType: {} },
      statuses: { sent: 0, delivered: 0, read: 0, failed: 0 }
    };
    
    this.metrics.api.requests = {
      total: 0, success: 0, failed: 0, byEndpoint: {}
    };
    
    this.metrics.errors = {
      total: 0, byCode: {}, byType: {}
    };
    
    logger.info('Métriques réinitialisées');
  }
}

module.exports = MonitoringService;