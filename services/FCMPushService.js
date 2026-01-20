/**
 * FCMPushService - Firebase Cloud Messaging Push Service (DEPRECATED)
 *
 * This service is deprecated. Homenichat now uses PushRelayService
 * (push.homenichat.com) for all push notifications.
 *
 * This stub file exists only for backward compatibility.
 * All methods return disabled/no-op responses.
 */

const logger = require('../utils/logger');

class FCMPushService {
  constructor() {
    this.initialized = false;
    this.projectId = null; // No Firebase project configured
    this.devices = new Map(); // userId -> [{token, deviceId, platform}]
  }

  /**
   * Initialize the service (always returns false - deprecated)
   */
  async initialize() {
    logger.info('[FCMPushService] Deprecated - use PushRelayService instead');
    return false;
  }

  /**
   * Check if service is configured (always false)
   */
  isConfigured() {
    return false;
  }

  /**
   * Register a device token (no-op, but stores locally for compatibility)
   */
  registerDevice(userId, token, deviceId, platform) {
    logger.info(`[FCMPushService] registerDevice called (deprecated) - user=${userId}`);
    // Store locally but won't actually send pushes
    if (!this.devices.has(userId)) {
      this.devices.set(userId, []);
    }
    const userDevices = this.devices.get(userId);
    const existing = userDevices.findIndex(d => d.deviceId === deviceId);
    if (existing >= 0) {
      userDevices[existing] = { token, deviceId, platform };
    } else {
      userDevices.push({ token, deviceId, platform });
    }
    return { success: true, message: 'Stored locally (FCM deprecated)' };
  }

  /**
   * Unregister a device (no-op)
   */
  unregisterDevice(userId, deviceId) {
    logger.info(`[FCMPushService] unregisterDevice called (deprecated) - user=${userId}`);
    if (this.devices.has(userId)) {
      const userDevices = this.devices.get(userId);
      const index = userDevices.findIndex(d => d.deviceId === deviceId);
      if (index >= 0) {
        userDevices.splice(index, 1);
      }
    }
    return { success: true };
  }

  /**
   * Send push notification to user (no-op)
   */
  async sendToUser(userId, notification, data) {
    logger.warn('[FCMPushService] sendToUser called (deprecated) - use PushRelayService');
    return 0; // Returns number of devices sent to (0 since deprecated)
  }

  /**
   * Send incoming call notification (no-op)
   */
  async sendIncomingCallNotification(callId, callerName, callerNumber, options) {
    logger.warn('[FCMPushService] sendIncomingCallNotification called (deprecated) - use PushRelayService');
    return 0;
  }

  /**
   * Send message notification (no-op)
   */
  async sendMessageNotification(chatId, senderName, messagePreview, data) {
    logger.warn('[FCMPushService] sendMessageNotification called (deprecated) - use PushRelayService');
    return 0;
  }

  /**
   * Send push notification (no-op)
   */
  async sendToDevice(token, payload) {
    logger.warn('[FCMPushService] Deprecated - use PushRelayService.sendToUser()');
    return { success: false, error: 'FCMPushService is deprecated' };
  }

  /**
   * Send to multiple devices (no-op)
   */
  async sendToDevices(tokens, payload) {
    logger.warn('[FCMPushService] Deprecated - use PushRelayService.sendToUser()');
    return { success: false, sent: 0, error: 'FCMPushService is deprecated' };
  }

  /**
   * Subscribe to topic (no-op)
   */
  async subscribeToTopic(token, topic) {
    return { success: false, error: 'FCMPushService is deprecated' };
  }

  /**
   * Unsubscribe from topic (no-op)
   */
  async unsubscribeFromTopic(token, topic) {
    return { success: false, error: 'FCMPushService is deprecated' };
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      configured: false,
      deprecated: true,
      message: 'Use PushRelayService instead',
    };
  }
}

// Singleton
module.exports = new FCMPushService();
