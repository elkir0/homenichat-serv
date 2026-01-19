/**
 * PushRelayService - Client for Homenichat Push Relay
 *
 * Sends push notifications via the centralized relay server
 * instead of directly to FCM/APNs.
 *
 * Configuration can come from:
 * 1. Config file: DATA_DIR/push-relay.json (priority)
 * 2. Environment variables: PUSH_RELAY_URL, PUSH_RELAY_API_KEY (fallback)
 */

const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

class PushRelayService {
  constructor() {
    this.relayUrl = null;
    this.apiKey = null;
    this.initialized = false;
  }

  /**
   * Load configuration from file or environment
   */
  loadConfig() {
    // Try to load from config file first
    const dataDir = process.env.DATA_DIR || '/var/lib/homenichat';
    const configPath = path.join(dataDir, 'push-relay.json');

    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.relayUrl && config.apiKey) {
          this.relayUrl = config.relayUrl;
          this.apiKey = config.apiKey;
          logger.info('[PushRelay] Config loaded from file');
          return true;
        }
      } catch (e) {
        logger.warn('[PushRelay] Failed to load config file:', e.message);
      }
    }

    // Fallback to environment variables
    this.relayUrl = process.env.PUSH_RELAY_URL || null;
    this.apiKey = process.env.PUSH_RELAY_API_KEY || null;

    return !!(this.relayUrl && this.apiKey);
  }

  /**
   * Initialize the service
   */
  initialize() {
    // Load config if not already set
    if (!this.relayUrl || !this.apiKey) {
      this.loadConfig();
    }

    if (!this.relayUrl || !this.apiKey) {
      logger.warn('[PushRelay] PUSH_RELAY_URL or PUSH_RELAY_API_KEY not configured');
      logger.warn('[PushRelay] Push notifications via relay will be disabled');
      return false;
    }

    // Remove trailing slash if present
    this.relayUrl = this.relayUrl.replace(/\/$/, '');
    this.initialized = true;
    logger.info(`[PushRelay] Initialized with relay: ${this.relayUrl}`);
    return true;
  }

  /**
   * Check if relay is configured
   */
  isConfigured() {
    return this.initialized;
  }

  /**
   * Make API request to relay
   */
  async _request(endpoint, method = 'GET', body = null) {
    if (!this.initialized) {
      throw new Error('Push relay not initialized');
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
   * Broadcast to all devices
   */
  async broadcast(type, data, notification = null) {
    try {
      const payload = { type, data };
      if (notification) {
        payload.notification = notification;
      }

      const result = await this._request('/push/send/all', 'POST', payload);
      logger.info(`[PushRelay] Broadcast sent: type=${type} sent=${result.sent}`);
      return result;
    } catch (error) {
      logger.error(`[PushRelay] Broadcast failed:`, error.message);
      return { success: false, sent: 0, error: error.message };
    }
  }

  /**
   * Get stats from relay
   */
  async getStats() {
    try {
      return await this._request('/push/stats', 'GET');
    } catch (error) {
      return { error: error.message };
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
      configured: this.initialized,
      relayUrl: this.relayUrl || null,
    };
  }
}

// Singleton
module.exports = new PushRelayService();
