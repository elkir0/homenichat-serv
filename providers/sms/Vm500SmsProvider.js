/**
 * Vm500SmsProvider - Connexion à une infrastructure SMS externe
 *
 * Ce provider permet de se connecter à un service sms-bridge externe
 * qui gère les modems chan_quectel.
 *
 * Ce provider agit uniquement comme client de l'API sms-bridge.
 * Configuration requise: host, port, apiKey
 */

const EventEmitter = require('events');
const https = require('https');
const http = require('http');

class Vm500SmsProvider extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      host: config.host || '',
      port: config.port || 8443,
      protocol: config.protocol || 'https',
      apiKey: config.apiKey || process.env.VM500_API_KEY,
      timeout: config.timeout || 30000,
      rejectUnauthorized: config.rejectUnauthorized !== true, // Accepter certificats auto-signés
      defaultModem: config.defaultModem || null, // 'quectel-chiro' ou 'quectel-osteo'
    };

    this.isReady = false;
    this.lastStatus = null;
    this.statusCheckInterval = null;
  }

  /**
   * Initialise le provider
   */
  async initialize() {
    try {
      // Vérifier la connexion à l'API
      const status = await this.getStatus();

      if (status) {
        this.isReady = true;
        this.lastStatus = status;
        this.emit('ready', status);

        // Démarrer le monitoring du statut
        this.startStatusMonitoring();

        return status;
      }

      throw new Error('Unable to connect to VM500 sms-bridge');
    } catch (error) {
      throw new Error(`VM500 connection failed: ${error.message}`);
    }
  }

  /**
   * Effectue une requête HTTP vers l'API sms-bridge
   */
  async request(method, path, data = null) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.config.host,
        port: this.config.port,
        path,
        method,
        timeout: this.config.timeout,
        headers: {
          'Content-Type': 'application/json',
        },
        rejectUnauthorized: this.config.rejectUnauthorized,
      };

      // Ajouter l'API key si configurée
      if (this.config.apiKey) {
        options.headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }

      const protocol = this.config.protocol === 'https' ? https : http;

      const req = protocol.request(options, (res) => {
        let body = '';

        res.on('data', (chunk) => {
          body += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);

            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
            }
          } catch (e) {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(body);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${body}`));
            }
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (data) {
        req.write(JSON.stringify(data));
      }

      req.end();
    });
  }

  /**
   * Récupère le statut de l'API
   */
  async getStatus() {
    try {
      const status = await this.request('GET', '/api/status');
      this.lastStatus = status;
      return status;
    } catch (error) {
      console.error('VM500 status check failed:', error);
      return null;
    }
  }

  /**
   * Envoie un SMS
   */
  async sendSms(to, message, options = {}) {
    if (!this.isReady) {
      throw new Error('Provider not ready');
    }

    const modem = options.modem || this.config.defaultModem;

    const data = {
      to: this.normalizePhoneNumber(to),
      message,
    };

    if (modem) {
      data.modem = modem;
    }

    try {
      const result = await this.request('POST', '/api/sms/send', data);

      this.emit('sms_sent', {
        to,
        message,
        modem: result.modem,
        result,
      });

      return {
        success: true,
        messageId: result.messageId || result.id,
        modem: result.modem,
      };
    } catch (error) {
      throw new Error(`SMS sending failed: ${error.message}`);
    }
  }

  /**
   * Récupère les SMS reçus
   */
  async getInbox(options = {}) {
    if (!this.isReady) {
      throw new Error('Provider not ready');
    }

    const params = new URLSearchParams();
    if (options.limit) params.append('limit', options.limit);
    if (options.offset) params.append('offset', options.offset);
    if (options.since) params.append('since', options.since);
    if (options.modem) params.append('modem', options.modem);

    const path = `/api/sms/inbox${params.toString() ? '?' + params.toString() : ''}`;

    return this.request('GET', path);
  }

  /**
   * Récupère les modems disponibles
   */
  async getModems() {
    if (!this.isReady) {
      throw new Error('Provider not ready');
    }

    try {
      return await this.request('GET', '/api/modems');
    } catch (error) {
      // Fallback si l'endpoint n'existe pas
      const status = await this.getStatus();
      return status?.modems || [];
    }
  }

  /**
   * Récupère le statut d'un modem spécifique
   */
  async getModemStatus(modemName) {
    if (!this.isReady) {
      throw new Error('Provider not ready');
    }

    return this.request('GET', `/api/modems/${modemName}/status`);
  }

  /**
   * Normalise un numéro de téléphone
   */
  normalizePhoneNumber(number) {
    let normalized = number.replace(/[\s\-\(\)\.]/g, '');

    if (!normalized.startsWith('+')) {
      if (normalized.startsWith('00')) {
        normalized = '+' + normalized.substring(2);
      } else if (normalized.startsWith('0')) {
        // Numéro local français, ajouter +33
        normalized = '+33' + normalized.substring(1);
      }
    }

    return normalized;
  }

  /**
   * Démarre le monitoring du statut
   */
  startStatusMonitoring(intervalMs = 30000) {
    if (this.statusCheckInterval) {
      return;
    }

    this.statusCheckInterval = setInterval(async () => {
      const status = await this.getStatus();

      if (!status && this.isReady) {
        this.isReady = false;
        this.emit('disconnected');
      } else if (status && !this.isReady) {
        this.isReady = true;
        this.emit('reconnected', status);
      }
    }, intervalMs);
  }

  /**
   * Arrête le monitoring
   */
  stopStatusMonitoring() {
    if (this.statusCheckInterval) {
      clearInterval(this.statusCheckInterval);
      this.statusCheckInterval = null;
    }
  }

  /**
   * Configure le webhook pour les SMS entrants
   */
  async configureWebhook(webhookUrl) {
    return this.request('POST', '/api/webhooks', {
      url: webhookUrl,
      events: ['sms_received'],
    });
  }

  /**
   * Retourne le statut du provider
   */
  getProviderStatus() {
    return {
      isReady: this.isReady,
      host: this.config.host,
      port: this.config.port,
      lastStatus: this.lastStatus,
    };
  }

  /**
   * Ferme le provider
   */
  async close() {
    this.stopStatusMonitoring();
    this.isReady = false;
    this.emit('closed');
  }
}

module.exports = Vm500SmsProvider;
