/**
 * FCMPushService - Firebase Cloud Messaging Push Notifications
 *
 * This service handles sending push notifications to Android devices via FCM.
 * It requires a Firebase service account key to authenticate with FCM.
 *
 * Setup:
 * 1. Go to Firebase Console -> Project Settings -> Service Accounts
 * 2. Generate a new private key
 * 3. Save as firebase-service-account.json in the config directory
 */

const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

// FCM HTTP v1 API endpoint
const FCM_API_URL = 'https://fcm.googleapis.com/v1/projects/{project_id}/messages:send';

class FCMPushService {
  constructor() {
    this.initialized = false;
    this.projectId = null;
    this.accessToken = null;
    this.tokenExpiry = 0;
    this.serviceAccount = null;

    // Store FCM tokens for devices
    this.deviceTokens = new Map(); // userId -> Set of { token, deviceId, platform }
  }

  /**
   * Initialize the FCM service
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      // Load service account from config directory
      const configPaths = [
        path.join(process.cwd(), 'config', 'firebase-service-account.json'),
        path.join(process.cwd(), 'firebase-service-account.json'),
        path.join(process.env.DATA_DIR || '/var/lib/homenichat', 'firebase-service-account.json'),
      ];

      let serviceAccountPath = null;
      for (const p of configPaths) {
        if (fs.existsSync(p)) {
          serviceAccountPath = p;
          break;
        }
      }

      if (!serviceAccountPath) {
        logger.warn('[FCM] No firebase-service-account.json found. FCM push notifications disabled.');
        logger.warn('[FCM] To enable: download service account key from Firebase Console and save to config/firebase-service-account.json');
        return false;
      }

      this.serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
      this.projectId = this.serviceAccount.project_id;

      logger.info(`[FCM] Service initialized for project: ${this.projectId}`);
      this.initialized = true;
      return true;
    } catch (error) {
      logger.error('[FCM] Initialization error:', error.message);
      return false;
    }
  }

  /**
   * Get OAuth2 access token for FCM API
   */
  async getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiry - 60000) {
      return this.accessToken;
    }

    if (!this.serviceAccount) {
      return null;
    }

    try {
      // Create JWT for service account authentication
      const jwt = await this.createJWT();

      // Exchange JWT for access token
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: jwt,
        }),
      });

      if (!response.ok) {
        throw new Error(`Token exchange failed: ${response.status}`);
      }

      const data = await response.json();
      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + (data.expires_in * 1000);

      return this.accessToken;
    } catch (error) {
      logger.error('[FCM] Error getting access token:', error.message);
      return null;
    }
  }

  /**
   * Create JWT for service account authentication
   */
  async createJWT() {
    const header = {
      alg: 'RS256',
      typ: 'JWT',
    };

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: this.serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    };

    const crypto = require('crypto');

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signatureInput = `${encodedHeader}.${encodedPayload}`;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signatureInput);
    const signature = sign.sign(this.serviceAccount.private_key, 'base64url');

    return `${signatureInput}.${signature}`;
  }

  /**
   * Register a device FCM token
   */
  registerDevice(userId, token, deviceId, platform = 'android') {
    if (!this.deviceTokens.has(userId)) {
      this.deviceTokens.set(userId, new Set());
    }

    // Remove existing entry for this deviceId (if token changed)
    const userTokens = this.deviceTokens.get(userId);
    for (const entry of userTokens) {
      if (entry.deviceId === deviceId) {
        userTokens.delete(entry);
        break;
      }
    }

    userTokens.add({ token, deviceId, platform });
    logger.info(`[FCM] Device registered: userId=${userId} deviceId=${deviceId}`);
  }

  /**
   * Unregister a device
   */
  unregisterDevice(userId, deviceId) {
    const userTokens = this.deviceTokens.get(userId);
    if (!userTokens) return;

    for (const entry of userTokens) {
      if (entry.deviceId === deviceId) {
        userTokens.delete(entry);
        logger.info(`[FCM] Device unregistered: userId=${userId} deviceId=${deviceId}`);
        break;
      }
    }
  }

  /**
   * Get all registered tokens for a user
   */
  getUserTokens(userId) {
    const userTokens = this.deviceTokens.get(userId);
    if (!userTokens) return [];
    return Array.from(userTokens).map(entry => entry.token);
  }

  /**
   * Send push notification to a specific token
   */
  async sendToToken(token, notification, data = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.projectId) {
      logger.warn('[FCM] Cannot send - service not initialized');
      return false;
    }

    try {
      const accessToken = await this.getAccessToken();
      if (!accessToken) {
        throw new Error('Failed to get access token');
      }

      const message = {
        message: {
          token: token,
          notification: notification,
          data: this.stringifyData(data),
          android: {
            priority: 'high',
            notification: {
              channel_id: 'homenichat_messages',
              sound: 'default',
            },
          },
        },
      };

      const url = FCM_API_URL.replace('{project_id}', this.projectId);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`FCM send failed: ${response.status} - ${errorText}`);
      }

      logger.info(`[FCM] Notification sent successfully to token: ${token.substring(0, 20)}...`);
      return true;
    } catch (error) {
      logger.error('[FCM] Send error:', error.message);
      return false;
    }
  }

  /**
   * Send notification to all devices of a user
   */
  async sendToUser(userId, notification, data = {}) {
    const tokens = this.getUserTokens(userId);
    if (tokens.length === 0) {
      logger.debug(`[FCM] No devices registered for user ${userId}`);
      return 0;
    }

    let successCount = 0;
    for (const token of tokens) {
      if (await this.sendToToken(token, notification, data)) {
        successCount++;
      }
    }

    logger.info(`[FCM] Sent to ${successCount}/${tokens.length} devices for user ${userId}`);
    return successCount;
  }

  /**
   * Send notification to all registered devices
   */
  async sendToAll(notification, data = {}) {
    let totalSent = 0;

    for (const [userId, _tokens] of this.deviceTokens) {
      totalSent += await this.sendToUser(userId, notification, data);
    }

    return totalSent;
  }

  /**
   * Send new message notification
   */
  async sendMessageNotification(chatId, senderName, messagePreview, options = {}) {
    const notification = {
      title: senderName,
      body: messagePreview.length > 100 ? messagePreview.substring(0, 100) + '...' : messagePreview,
    };

    const data = {
      type: 'new_message',
      chatId: chatId,
      senderName: senderName,
      timestamp: Date.now().toString(),
      ...options,
    };

    // Send to all users (in a multi-user setup, you'd filter by permissions)
    return await this.sendToAll(notification, data);
  }

  /**
   * Send incoming call notification (high priority)
   */
  async sendIncomingCallNotification(callId, callerName, callerNumber, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.projectId) {
      return 0;
    }

    let totalSent = 0;

    // For calls, we use data-only messages so the app can show a full-screen UI
    for (const [userId, userTokens] of this.deviceTokens) {
      for (const { token } of userTokens) {
        try {
          const accessToken = await this.getAccessToken();
          if (!accessToken) continue;

          const message = {
            message: {
              token: token,
              data: this.stringifyData({
                type: 'incoming_call',
                callId: callId,
                callerName: callerName,
                callerNumber: callerNumber,
                timestamp: Date.now().toString(),
                ...options,
              }),
              android: {
                priority: 'high',
                ttl: '60s',
              },
            },
          };

          const url = FCM_API_URL.replace('{project_id}', this.projectId);
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(message),
          });

          if (response.ok) {
            totalSent++;
            logger.info(`[FCM] Incoming call notification sent to token: ${token.substring(0, 20)}...`);
          }
        } catch (error) {
          logger.error('[FCM] Error sending call notification:', error.message);
        }
      }
    }

    return totalSent;
  }

  /**
   * Stringify all data values (FCM requires string values)
   */
  stringifyData(data) {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = String(value);
    }
    return result;
  }

  /**
   * Get service status
   */
  getStatus() {
    let totalDevices = 0;
    for (const tokens of this.deviceTokens.values()) {
      totalDevices += tokens.size;
    }

    return {
      initialized: this.initialized,
      projectId: this.projectId,
      usersRegistered: this.deviceTokens.size,
      totalDevices: totalDevices,
    };
  }
}

// Singleton
module.exports = new FCMPushService();
