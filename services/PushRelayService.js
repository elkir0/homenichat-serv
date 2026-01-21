/**
 * PushRelayService - Client for Homenichat Push Relay
 *
 * Sends push notifications via the centralized Homenichat relay server.
 * Uses the API token from HomenichatCloudService for authentication.
 */

const logger = require('../utils/logger');

// Push Relay URL - Uses the unified relay.homenichat.com API
// which accepts Bearer tokens (hc_xxx) from Homenichat Cloud auth
const PUSH_RELAY_URL = 'https://relay.homenichat.com';

// Lazy load to avoid circular dependencies
let homenichatCloudService = null;

const getCloudService = () => {
  if (!homenichatCloudService) {
    homenichatCloudService = require('./HomenichatCloudService');
  }
  return homenichatCloudService;
};

class PushRelayService {
  constructor() {
    this.relayUrl = PUSH_RELAY_URL;
    this.initialized = false;
  }

  /**
   * Initialize the service
   */
  initialize() {
    this.initialized = true;
    logger.info(`[PushRelay] Initialized with relay: ${this.relayUrl}`);
    return true;
  }

  /**
   * Check if relay is configured (cloud service is logged in)
   */
  isConfigured() {
    const cloud = getCloudService();
    return cloud.isLoggedIn();
  }

  /**
   * Get API token from cloud service
   */
  getApiToken() {
    const cloud = getCloudService();
    return cloud.auth?.apiToken || null;
  }

  /**
   * Make API request to relay
   */
  async _request(endpoint, method = 'GET', body = null) {
    if (!this.initialized) {
      this.initialize();
    }

    const apiToken = this.getApiToken();
    if (!apiToken) {
      throw new Error('Not logged in to Homenichat Cloud');
    }

    const url = `${this.relayUrl}${endpoint}`;
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${apiToken}`,
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
   * Send push notification to current user's devices
   * Uses the logged-in user's ID automatically
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
   * Broadcast push notification to all devices registered with current user
   * This is the main method for server-to-app notifications
   */
  async broadcast(type, data, notification = null) {
    try {
      // Get user ID from cloud service
      const cloud = getCloudService();
      const userId = cloud.auth?.userId;

      if (!userId) {
        logger.warn('[PushRelay] Cannot broadcast: no user ID');
        return { success: false, sent: 0, error: 'Not logged in' };
      }

      const payload = {
        type,
        data,
      };

      if (notification) {
        payload.notification = notification;
      }

      // Send to all devices for this user
      const result = await this._request('/push/send', 'POST', {
        userId: String(userId),
        ...payload,
      });

      logger.info(`[PushRelay] Broadcast: type=${type} userId=${userId} sent=${result.sent || 0}`);
      return {
        success: true,
        sent: result.sent || 0,
        failed: result.failed || 0,
      };
    } catch (error) {
      logger.error(`[PushRelay] Broadcast failed:`, error.message);
      return { success: false, sent: 0, failed: 0, error: error.message };
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
   * Get registered devices for current user
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
      configured: this.isConfigured(),
      relayUrl: this.relayUrl,
      loggedIn: this.isConfigured(),
    };
  }
}

// Singleton
module.exports = new PushRelayService();
