/**
 * PushRelayService - Client for Homenichat Push Relay
 *
 * Sends push notifications via the centralized Homenichat relay server.
 * Configuration is automatic - no user setup required.
 */

const logger = require('../utils/logger');

// Hardcoded Homenichat Push Relay configuration
const PUSH_RELAY_URL = 'https://push.homenichat.com';
const PUSH_RELAY_API_KEY = 'hpr_330b321fc948475b5c5b87b57bc2e5204d765a5d0feb761f718302b3335848fd';

class PushRelayService {
  constructor() {
    this.relayUrl = PUSH_RELAY_URL;
    this.apiKey = PUSH_RELAY_API_KEY;
    this.initialized = false;
  }

  /**
   * Initialize the service (auto-configured)
   */
  initialize() {
    this.initialized = true;
    logger.info(`[PushRelay] Initialized with relay: ${this.relayUrl}`);
    return true;
  }

  /**
   * Check if relay is configured (always true)
   */
  isConfigured() {
    return true;
  }

  /**
   * Make API request to relay
   */
  async _request(endpoint, method = 'GET', body = null) {
    if (!this.initialized) {
      this.initialize();
    }

    const url = `${this.relayUrl}${endpoint}`;
    const options = {
      method,
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url, options);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      return data;
    } catch (error) {
      logger.error(`[PushRelay] Request failed: ${method} ${endpoint}`, error.message);
      throw error;
    }
  }

  /**
   * Register a device token
   */
  async registerDevice(userId, deviceId, platform, token) {
    try {
      const result = await this._request('/push/register', 'POST', {
        userId: String(userId),
        deviceId,
        platform,
        token,
      });

      logger.info(`[PushRelay] Device registered: user=${userId} device=${deviceId} platform=${platform}`);
      return result;
    } catch (error) {
      logger.error(`[PushRelay] Device registration failed:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Unregister a device
   */
  async unregisterDevice(userId, deviceId) {
    try {
      const result = await this._request('/push/unregister', 'POST', {
        userId: String(userId),
        deviceId,
      });

      logger.info(`[PushRelay] Device unregistered: user=${userId} device=${deviceId}`);
      return result;
    } catch (error) {
      logger.error(`[PushRelay] Device unregistration failed:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send push notification to a user
   */
  async sendToUser(userId, type, data, notification = null) {
    try {
      const payload = {
        userId: String(userId),
        type,
        data,
      };

      if (notification) {
        payload.notification = notification;
      }

      const result = await this._request('/push/send', 'POST', payload);

      logger.info(`[PushRelay] Push sent: user=${userId} type=${type} sent=${result.sent}`);
      return result;
    } catch (error) {
      logger.error(`[PushRelay] Push send failed:`, error.message);
      return { success: false, sent: 0, error: error.message };
    }
  }

  /**
   * Send incoming call notification
   */
  async sendIncomingCall(userId, callData) {
    return this.sendToUser(userId, 'incoming_call', {
      callId: callData.callId,
      callerName: callData.callerName || 'Unknown',
      callerNumber: callData.callerNumber || '',
      lineName: callData.lineName || '',
      extension: callData.extension || '',
    });
  }

  /**
   * Send new message notification
   */
  async sendNewMessage(userId, messageData) {
    return this.sendToUser(
      userId,
      'new_message',
      {
        chatId: messageData.chatId || '',
        messageId: messageData.messageId || '',
        senderName: messageData.senderName || '',
      },
      {
        title: messageData.senderName || 'New Message',
        body: messageData.preview || 'You have a new message',
      }
    );
  }

  /**
   * Send test notification
   */
  async sendTest(userId) {
    try {
      const result = await this._request(`/push/test/${userId}`, 'POST');
      logger.info(`[PushRelay] Test push sent: user=${userId}`);
      return result;
    } catch (error) {
      logger.error(`[PushRelay] Test push failed:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get registered devices
   */
  async getDevices() {
    try {
      return await this._request('/push/devices', 'GET');
    } catch (error) {
      return { error: error.message, devices: [] };
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      const response = await fetch(`${this.relayUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      configured: true,
      relayUrl: this.relayUrl,
    };
  }
}

// Singleton
module.exports = new PushRelayService();
