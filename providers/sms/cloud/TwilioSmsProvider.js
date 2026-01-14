/**
 * TwilioSmsProvider - Provider SMS Twilio
 *
 * Utilise l'API Twilio Programmable SMS
 * Documentation: https://www.twilio.com/docs/sms
 *
 * Configuration requise:
 * - account_sid: Account SID Twilio
 * - auth_token: Auth Token Twilio
 * - phone_number: Numéro Twilio (format E.164, ex: +33612345678)
 */

const SmsProvider = require('../base/SmsProvider');

class TwilioSmsProvider extends SmsProvider {
  constructor(config) {
    super(config);
    this.client = null;
    this.phoneNumber = config.config?.phone_number || '';
    this.accountSid = config.config?.account_sid || '';
  }

  async initialize() {
    try {
      this.log('info', 'Initializing Twilio SMS provider...');

      // Charger le module Twilio dynamiquement
      const twilio = require('twilio');

      this.client = twilio(
        this.config.config?.account_sid,
        this.config.config?.auth_token
      );

      // Vérifier la connexion
      await this.testConnection();

      this.setStatus('connected');
      this.log('info', 'Twilio SMS provider initialized successfully');

      return true;
    } catch (error) {
      this.setStatus('error', error.message);
      this.log('error', 'Failed to initialize Twilio SMS provider', { error: error.message });
      throw error;
    }
  }

  async testConnection() {
    try {
      // Vérifier le compte
      const account = await this.client.api.accounts(this.accountSid).fetch();

      if (account.status !== 'active') {
        throw new Error(`Account status is ${account.status}, not active`);
      }

      this.log('info', `Connected to Twilio account: ${account.friendlyName}`);
      return { success: true, accountName: account.friendlyName };
    } catch (error) {
      this.log('error', 'Twilio connection test failed', { error: error.message });
      throw error;
    }
  }

  async sendMessage(to, text, options = {}) {
    if (!this.client) {
      throw new Error('Twilio client not initialized');
    }

    try {
      // Formater le numéro
      const formattedTo = this.formatPhoneNumber(to, options.country || 'FR');

      if (!this.isValidPhoneNumber(formattedTo)) {
        throw new Error(`Invalid phone number: ${to}`);
      }

      // Vérifier la compliance France si numéro français
      if (formattedTo.startsWith('+33')) {
        const compliance = await this.checkCompliance(formattedTo, text, 'FR');
        if (!compliance.allowed) {
          this.log('warn', `SMS blocked by compliance: ${compliance.reason}`);
          return {
            success: false,
            error: compliance.reason,
            blocked: true
          };
        }
        text = compliance.modifiedText || text;
      }

      this.log('info', `Sending SMS to ${formattedTo}`, { from: this.phoneNumber });

      // Préparer le message
      const messageOptions = {
        body: text,
        from: options.from || this.phoneNumber,
        to: formattedTo
      };

      // Ajouter le callback URL si fourni
      if (options.statusCallback) {
        messageOptions.statusCallback = options.statusCallback;
      }

      // Ajouter le messaging service SID si fourni
      if (options.messagingServiceSid) {
        messageOptions.messagingServiceSid = options.messagingServiceSid;
        delete messageOptions.from; // Ne pas utiliser from avec messaging service
      }

      // Envoyer via Twilio
      const message = await this.client.messages.create(messageOptions);

      this.incrementStat('sent');
      this.emitEvent('message_sent', {
        messageId: message.sid,
        to: formattedTo,
        status: message.status
      });

      return {
        success: true,
        messageId: message.sid,
        status: message.status,
        segments: message.numSegments
      };

    } catch (error) {
      this.incrementStat('failed');
      this.log('error', 'Failed to send SMS via Twilio', {
        error: error.message,
        code: error.code,
        to
      });

      return {
        success: false,
        error: error.message,
        code: error.code
      };
    }
  }

  async getStatus() {
    try {
      if (!this.client) {
        return { status: 'disconnected', details: null };
      }

      const account = await this.client.api.accounts(this.accountSid).fetch();

      return {
        status: 'connected',
        details: {
          accountSid: this.accountSid,
          friendlyName: account.friendlyName,
          accountStatus: account.status,
          type: account.type
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
      const balance = await this.client.balance.fetch();

      return {
        credits: parseFloat(balance.balance),
        currency: balance.currency
      };
    } catch (error) {
      this.log('error', 'Failed to get Twilio balance', { error: error.message });
      return { credits: null, currency: null };
    }
  }

  async getDeliveryStatus(messageId) {
    try {
      const message = await this.client.messages(messageId).fetch();

      // Mapping des statuts Twilio
      const statusMap = {
        queued: 'pending',
        sending: 'sending',
        sent: 'sent',
        delivered: 'delivered',
        undelivered: 'failed',
        failed: 'failed'
      };

      return {
        status: statusMap[message.status] || 'unknown',
        sentAt: message.dateSent ? new Date(message.dateSent) : null,
        deliveredAt: message.status === 'delivered' ? new Date() : null,
        errorCode: message.errorCode,
        errorMessage: message.errorMessage
      };
    } catch (error) {
      return { status: 'unknown', error: error.message };
    }
  }

  async getMessageHistory(filters = {}) {
    try {
      const queryOptions = {
        from: this.phoneNumber,
        limit: filters.limit || 50
      };

      if (filters.startDate) {
        queryOptions.dateSentAfter = filters.startDate;
      }
      if (filters.endDate) {
        queryOptions.dateSentBefore = filters.endDate;
      }
      if (filters.to) {
        queryOptions.to = this.formatPhoneNumber(filters.to);
      }

      const messages = await this.client.messages.list(queryOptions);

      return messages.map(msg => ({
        id: msg.sid,
        to: msg.to,
        from: msg.from,
        text: msg.body,
        sentAt: msg.dateSent ? new Date(msg.dateSent) : null,
        status: msg.status,
        segments: msg.numSegments,
        errorCode: msg.errorCode
      }));
    } catch (error) {
      this.log('error', 'Failed to get message history', { error: error.message });
      return [];
    }
  }

  async handleWebhook(data) {
    this.log('info', 'Received Twilio webhook', { messageSid: data.MessageSid });

    // Webhook de statut (DLR)
    if (data.MessageStatus && data.MessageSid) {
      this.emitEvent('delivery_report', {
        messageId: data.MessageSid,
        status: data.MessageStatus,
        errorCode: data.ErrorCode,
        to: data.To
      });
    }

    // SMS entrant
    if (data.From && data.Body && !data.MessageStatus) {
      this.incrementStat('received');
      this.emitEvent('message_received', {
        from: data.From,
        to: data.To,
        text: data.Body,
        messageId: data.MessageSid,
        receivedAt: new Date()
      });

      // Twilio attend une réponse TwiML
      return {
        acknowledged: true,
        twiml: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
      };
    }

    return { acknowledged: true };
  }

  async disconnect() {
    this.client = null;
    this.setStatus('disconnected');
    this.log('info', 'Twilio SMS provider disconnected');
  }

  getCapabilities() {
    return {
      ...super.getCapabilities(),
      canReceive: true,
      supportsDeliveryReports: true,
      maxMessageLength: 1600, // SMS concaténés
      supportsLongSms: true,
      supportsMms: true, // Twilio supporte MMS
      supportsUnicode: true,
      maxRecipients: 1 // Un par requête, utiliser messaging service pour bulk
    };
  }
}

module.exports = TwilioSmsProvider;
