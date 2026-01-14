/**
 * OvhSmsProvider - Provider SMS OVH
 *
 * Utilise l'API OVH SMS (https://api.ovh.com/console/#/sms)
 * Documentation: https://docs.ovh.com/fr/sms/
 *
 * Configuration requise:
 * - endpoint: "ovh-eu" ou "ovh-ca"
 * - app_key: Clé d'application
 * - app_secret: Secret d'application
 * - consumer_key: Clé consommateur
 * - service_name: Nom du service SMS (ex: sms-xxx)
 * - sender: Expéditeur (numéro ou nom alpha)
 */

const SmsProvider = require('../base/SmsProvider');

class OvhSmsProvider extends SmsProvider {
  constructor(config) {
    super(config);
    this.client = null;
    this.serviceName = config.config?.service_name || '';
    this.sender = config.config?.sender || '';
  }

  async initialize() {
    try {
      this.log('info', 'Initializing OVH SMS provider...');

      // Charger le module OVH dynamiquement
      const ovh = require('ovh');

      this.client = ovh({
        endpoint: this.config.config?.endpoint || 'ovh-eu',
        appKey: this.config.config?.app_key,
        appSecret: this.config.config?.app_secret,
        consumerKey: this.config.config?.consumer_key
      });

      // Vérifier la connexion
      await this.testConnection();

      this.setStatus('connected');
      this.log('info', 'OVH SMS provider initialized successfully');

      return true;
    } catch (error) {
      this.setStatus('error', error.message);
      this.log('error', 'Failed to initialize OVH SMS provider', { error: error.message });
      throw error;
    }
  }

  async testConnection() {
    try {
      // Lister les services SMS pour vérifier l'accès
      const services = await this.client.requestPromised('GET', '/sms');

      if (!services.includes(this.serviceName)) {
        throw new Error(`Service ${this.serviceName} not found. Available: ${services.join(', ')}`);
      }

      this.log('info', `Connected to OVH SMS service: ${this.serviceName}`);
      return { success: true, services };
    } catch (error) {
      this.log('error', 'OVH connection test failed', { error: error.message });
      throw error;
    }
  }

  async sendMessage(to, text, options = {}) {
    if (!this.client) {
      throw new Error('OVH client not initialized');
    }

    try {
      // Formater le numéro
      const formattedTo = this.formatPhoneNumber(to, options.country || 'FR');

      if (!this.isValidPhoneNumber(formattedTo)) {
        throw new Error(`Invalid phone number: ${to}`);
      }

      // Vérifier la compliance France
      const compliance = await this.checkCompliance(formattedTo, text, 'FR');
      if (!compliance.allowed) {
        this.log('warn', `SMS blocked by compliance: ${compliance.reason}`);
        return {
          success: false,
          error: compliance.reason,
          blocked: true
        };
      }

      // Utiliser le texte modifié si nécessaire (ajout mention STOP)
      const finalText = compliance.modifiedText || text;

      // Préparer la requête OVH
      const payload = {
        message: finalText,
        receivers: [formattedTo],
        sender: options.sender || this.sender,
        noStopClause: false, // Toujours inclure la clause STOP pour la France
        priority: options.priority || 'high',
        validityPeriod: options.validityPeriod || 2880 // 48h par défaut
      };

      // Ajouter le tag si fourni
      if (options.tag) {
        payload.tag = options.tag;
      }

      this.log('info', `Sending SMS to ${formattedTo}`, { sender: payload.sender });

      // Envoyer via API OVH
      const result = await this.client.requestPromised(
        'POST',
        `/sms/${this.serviceName}/jobs`,
        payload
      );

      if (result.ids && result.ids.length > 0) {
        this.incrementStat('sent');
        this.emitEvent('message_sent', {
          messageId: result.ids[0],
          to: formattedTo,
          credits: result.totalCreditsRemoved
        });

        return {
          success: true,
          messageId: String(result.ids[0]),
          credits: result.totalCreditsRemoved,
          invalidReceivers: result.invalidReceivers || []
        };
      }

      throw new Error('No message ID returned from OVH');

    } catch (error) {
      this.incrementStat('failed');
      this.log('error', 'Failed to send SMS via OVH', { error: error.message, to });

      return {
        success: false,
        error: error.message
      };
    }
  }

  async getStatus() {
    try {
      if (!this.client) {
        return { status: 'disconnected', details: null };
      }

      const serviceInfo = await this.client.requestPromised(
        'GET',
        `/sms/${this.serviceName}`
      );

      return {
        status: 'connected',
        details: {
          service: this.serviceName,
          creditsLeft: serviceInfo.creditsLeft,
          creditsHoldByQuota: serviceInfo.creditsHoldByQuota,
          description: serviceInfo.description
        }
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  async getBalance() {
    try {
      const serviceInfo = await this.client.requestPromised(
        'GET',
        `/sms/${this.serviceName}`
      );

      return {
        credits: serviceInfo.creditsLeft,
        currency: 'credits',
        holdByQuota: serviceInfo.creditsHoldByQuota
      };
    } catch (error) {
      this.log('error', 'Failed to get OVH balance', { error: error.message });
      return { credits: null, currency: null };
    }
  }

  async getDeliveryStatus(messageId) {
    try {
      const job = await this.client.requestPromised(
        'GET',
        `/sms/${this.serviceName}/jobs/${messageId}`
      );

      // Mapping des statuts OVH
      const statusMap = {
        pending: 'pending',
        sent: 'sent',
        delivered: 'delivered',
        failed: 'failed',
        notDelivered: 'failed'
      };

      return {
        status: statusMap[job.deliveryReceipt] || 'unknown',
        sentAt: job.creationDatetime ? new Date(job.creationDatetime) : null,
        deliveredAt: job.deliveryReceipt === 'delivered' ? new Date() : null,
        credits: job.credits
      };
    } catch (error) {
      return { status: 'unknown', error: error.message };
    }
  }

  async getMessageHistory(filters = {}) {
    try {
      const params = {};

      if (filters.startDate) {
        params.creationDatetime = `${filters.startDate.toISOString()}`;
      }

      const jobIds = await this.client.requestPromised(
        'GET',
        `/sms/${this.serviceName}/outgoing`,
        params
      );

      // Limiter le nombre de requêtes
      const limit = filters.limit || 50;
      const limitedIds = jobIds.slice(0, limit);

      const messages = [];
      for (const id of limitedIds) {
        try {
          const msg = await this.client.requestPromised(
            'GET',
            `/sms/${this.serviceName}/outgoing/${id}`
          );
          messages.push({
            id: String(id),
            to: msg.receiver,
            text: msg.message,
            sentAt: new Date(msg.creationDatetime),
            status: msg.deliveryReceipt,
            credits: msg.credits
          });
        } catch (e) {
          // Skip messages we can't fetch
        }
      }

      return messages;
    } catch (error) {
      this.log('error', 'Failed to get message history', { error: error.message });
      return [];
    }
  }

  async handleWebhook(data) {
    this.log('info', 'Received OVH webhook', { data });

    // OVH envoie des DLR (Delivery Reports)
    if (data.id && data.deliveryReceipt) {
      this.emitEvent('delivery_report', {
        messageId: String(data.id),
        status: data.deliveryReceipt,
        receiver: data.receiver
      });
    }

    // OVH peut aussi envoyer des SMS entrants (si configuré)
    if (data.senderForResponse) {
      this.incrementStat('received');
      this.emitEvent('message_received', {
        from: data.senderForResponse,
        text: data.message,
        receivedAt: new Date()
      });
    }

    return { acknowledged: true };
  }

  async disconnect() {
    this.client = null;
    this.setStatus('disconnected');
    this.log('info', 'OVH SMS provider disconnected');
  }

  getCapabilities() {
    return {
      ...super.getCapabilities(),
      canReceive: true, // OVH supporte la réception
      supportsDeliveryReports: true,
      maxMessageLength: 160,
      supportsLongSms: true, // SMS concaténés
      supportsMms: false,
      supportsUnicode: true,
      maxRecipients: 500 // Par requête
    };
  }
}

module.exports = OvhSmsProvider;
