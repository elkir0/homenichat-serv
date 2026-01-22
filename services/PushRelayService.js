/**
 * PushRelayService - Client for Homenichat Push Relay
 *
 * Sends push notifications via the centralized Homenichat relay server.
 * Uses the API token from HomenichatCloudService for authentication.
 *
 * SECURITY MODEL:
 * ---------------
 * The relay server (relay.homenichat.com) enforces user isolation:
 *
 * 1. REGISTRATION: When registering a device token, the relay extracts
 *    the userId from the Bearer token (hc_xxx), NOT from the request body.
 *    This prevents spoofing - you can only register devices for your own account.
 *
 * 2. SENDING: When sending a push, the relay validates that the requested
 *    userId matches the token's userId. Any mismatch returns 403.
 *    This ensures servers can only send pushes to their own user's devices.
 *
 * 3. ISOLATION: Device tokens are stored per-user and only returned for
 *    the authenticated user. No cross-user token access is possible.
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
   *
   * @param {string} _userId - DEPRECATED: Kept for API compatibility but NOT sent to relay.
   *                           The relay extracts userId from the Bearer token for security.
   * @param {string} deviceId - Unique device identifier
   * @param {string} platform - 'android' or 'ios'
   * @param {string} token - FCM token (Android) or APNs token (iOS)
   */
  async registerDevice(_userId, deviceId, platform, token) {
    try {
      // Note: userId is NOT sent to relay - the relay extracts it from the Bearer token.
      // This prevents spoofing (you can only register devices for your own account).
      const result = await this._request('/push/register', 'POST', {
        deviceId,
        platform,
        token,
      });

      logger.info(`[PushRelay] Device registered: device=${deviceId} platform=${platform}`);
      return result;
    } catch (error) {
      logger.error(`[PushRelay] Device registration failed:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Unregister a device
   *
   * @param {string} _userId - DEPRECATED: Kept for API compatibility but NOT sent to relay.
   *                           The relay extracts userId from the Bearer token for security.
   * @param {string} deviceId - Device identifier to unregister
   */
  async unregisterDevice(_userId, deviceId) {
    try {
      // Note: userId is NOT sent to relay - the relay extracts it from the Bearer token.
      const result = await this._request('/push/unregister', 'POST', {
        deviceId,
      });

      logger.info(`[PushRelay] Device unregistered: device=${deviceId}`);
      return result;
    } catch (error) {
      logger.error(`[PushRelay] Device unregistration failed:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send push notification to a specific user's devices
   *
   * @param {string} userId - Target user ID (MUST match the Bearer token's userId)
   *                          The relay validates this to prevent cross-user sending.
   * @param {string} type - Notification type ('incoming_call', 'new_message', etc.)
   * @param {object} data - Notification payload data
   * @param {object} notification - Optional {title, body} for display notification
   *
   * Note: Unlike registration, userId IS sent here for explicit validation.
   * The relay will return 403 if userId doesn't match the token's user.
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
   *
   * This is the main method for server-to-app notifications.
   * It automatically uses the userId from the cloud service's authentication.
   *
   * The relay validates that this userId matches the Bearer token's userId,
   * ensuring the server can only broadcast to its own user's devices.
   */
  async broadcast(type, data, notification = null) {
    try {
      // Get user ID from cloud service (this is the Cloud userId, validated by relay)
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
