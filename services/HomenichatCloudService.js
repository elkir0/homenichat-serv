/**
 * HomenichatCloudService - Unified Homenichat Cloud Integration
 *
 * Single service that manages BOTH Push Notifications AND Tunnel Relay
 * with ONE email/password login.
 *
 * Features:
 * - Unified authentication (email/password → API token)
 * - Push notifications via Homenichat Push Relay
 * - WireGuard tunnel + TURN credentials via Homenichat Tunnel Relay
 * - Zero-config: just login with email/password
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const crypto = require('crypto');
const EventEmitter = require('events');
const logger = require('../utils/logger');

// Homenichat Cloud endpoints
const CLOUD_API_URL = 'https://relay.homenichat.com';
const PUSH_RELAY_URL = 'https://push.homenichat.com';

class HomenichatCloudService extends EventEmitter {
  constructor(options = {}) {
    super();

    this.dataDir = options.dataDir || process.env.DATA_DIR || '/var/lib/homenichat';
    this.configPath = options.configPath || path.join(this.dataDir, 'homenichat-cloud.json');

    // Authentication state
    this.auth = {
      email: null,
      apiToken: null,
      userId: null,
      loggedIn: false,
    };

    // Services state
    this.services = {
      push: { enabled: false, url: PUSH_RELAY_URL },
      tunnel: { enabled: false, url: CLOUD_API_URL },
    };

    // Tunnel state (from TunnelRelayService)
    this.tunnel = {
      configured: false,
      connected: false,
      registered: false,
      publicKey: null,
      privateKey: null,
      registration: null,
      turnCredentials: null,
      lastError: null,
      lastRefresh: null,
      lastHeartbeat: null,
    };

    // Configuration
    this.config = {
      hostname: '',
      clientId: '',
      autoConnect: true,
      refreshInterval: 12 * 60 * 60 * 1000, // 12 hours
    };

    // Timers
    this.refreshTimer = null;
    this.healthCheckTimer = null;
    this.heartbeatTimer = null;
    this.heartbeatInterval = 60000;

    // WireGuard interface
    this.wgInterface = 'wg-relay';
  }

  /**
   * Initialize the service
   */
  async initialize() {
    try {
      await this.loadConfig();

      if (this.auth.loggedIn && this.auth.apiToken) {
        logger.info('[HomenichatCloud] Resuming session...');

        // Verify token is still valid
        const valid = await this.verifyToken();
        if (valid) {
          if (this.services.tunnel.enabled && this.config.autoConnect) {
            await this.connectTunnel();
          }
        } else {
          logger.warn('[HomenichatCloud] Saved token invalid, please re-login');
          this.auth.loggedIn = false;
          this.saveConfig();
        }
      }

      logger.info('[HomenichatCloud] Initialized', {
        loggedIn: this.auth.loggedIn,
        email: this.auth.email,
      });

    } catch (error) {
      logger.error('[HomenichatCloud] Initialization failed:', error.message);
    }
  }

  /**
   * Load saved configuration
   */
  async loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));

        if (data.auth) {
          Object.assign(this.auth, data.auth);
        }
        if (data.services) {
          Object.assign(this.services, data.services);
        }
        if (data.tunnel) {
          Object.assign(this.tunnel, data.tunnel);
        }
        if (data.config) {
          Object.assign(this.config, data.config);
        }
      }

      // Generate client ID if not set
      if (!this.config.clientId) {
        this.config.clientId = this.getMachineId();
      }

      // Set hostname if not set
      if (!this.config.hostname) {
        this.config.hostname = require('os').hostname();
      }

    } catch (error) {
      logger.error('[HomenichatCloud] Failed to load config:', error.message);
    }
  }

  /**
   * Save configuration
   */
  saveConfig() {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.configPath, JSON.stringify({
        auth: {
          email: this.auth.email,
          apiToken: this.auth.apiToken,
          userId: this.auth.userId,
          loggedIn: this.auth.loggedIn,
        },
        services: this.services,
        tunnel: {
          configured: this.tunnel.configured,
          registered: this.tunnel.registered,
          publicKey: this.tunnel.publicKey,
          registration: this.tunnel.registration,
          turnCredentials: this.tunnel.turnCredentials,
          lastRefresh: this.tunnel.lastRefresh,
          lastHeartbeat: this.tunnel.lastHeartbeat,
        },
        config: this.config,
      }, null, 2));

    } catch (error) {
      logger.error('[HomenichatCloud] Failed to save config:', error.message);
    }
  }

  /**
   * Get machine ID
   */
  getMachineId() {
    try {
      if (fs.existsSync('/etc/machine-id')) {
        return fs.readFileSync('/etc/machine-id', 'utf8').trim();
      }
    } catch {}
    return crypto.randomUUID();
  }

  // ==========================================
  // AUTHENTICATION
  // ==========================================

  /**
   * Register a new account
   */
  async register(email, password, name = null) {
    try {
      const response = await this.apiRequest('POST', '/api/auth/register', {
        email,
        password,
        name,
      });

      if (!response.success) {
        throw new Error(response.error || 'Registration failed');
      }

      this.auth.email = email;
      this.auth.apiToken = response.apiToken;
      this.auth.userId = response.user.id;
      this.auth.loggedIn = true;

      this.services.push.enabled = response.services?.push?.enabled || true;
      this.services.tunnel.enabled = response.services?.tunnel?.enabled || true;

      this.saveConfig();
      this.emit('registered', { email, userId: this.auth.userId });

      logger.info('[HomenichatCloud] Registered successfully', { email });

      // Auto-connect if enabled
      if (this.services.tunnel.enabled && this.config.autoConnect) {
        await this.connectTunnel();
      }

      return {
        success: true,
        user: response.user,
        services: this.services,
      };

    } catch (error) {
      logger.error('[HomenichatCloud] Registration failed:', error.message);
      throw error;
    }
  }

  /**
   * Login with email/password
   */
  async login(email, password) {
    try {
      logger.info('[HomenichatCloud] Attempting login', { email, passwordLength: password?.length });
      const response = await this.apiRequest('POST', '/api/auth/login', {
        email,
        password,
      });
      logger.info('[HomenichatCloud] Login response', { success: response.success, error: response.error });

      if (!response.success) {
        throw new Error(response.error || 'Login failed');
      }

      this.auth.email = email;
      this.auth.apiToken = response.apiToken;
      this.auth.userId = response.user.id;
      this.auth.loggedIn = true;

      this.services.push.enabled = response.services?.push?.enabled || true;
      this.services.tunnel.enabled = response.services?.tunnel?.enabled || true;

      this.saveConfig();
      this.emit('login', { email, userId: this.auth.userId });

      logger.info('[HomenichatCloud] Login successful', { email });

      // Auto-connect if enabled
      if (this.services.tunnel.enabled && this.config.autoConnect) {
        await this.connectTunnel();
      }

      return {
        success: true,
        user: response.user,
        services: this.services,
      };

    } catch (error) {
      logger.error('[HomenichatCloud] Login failed:', error.message);
      throw error;
    }
  }

  /**
   * Logout
   */
  async logout() {
    await this.disconnectTunnel();

    this.auth = {
      email: null,
      apiToken: null,
      userId: null,
      loggedIn: false,
    };

    this.tunnel.registered = false;
    this.tunnel.connected = false;
    this.tunnel.registration = null;

    this.saveConfig();
    this.emit('logout');

    logger.info('[HomenichatCloud] Logged out');
  }

  /**
   * Verify current token is valid
   */
  async verifyToken() {
    if (!this.auth.apiToken) {
      return false;
    }

    try {
      const response = await this.apiRequest('POST', '/api/auth/validate-token', {
        token: this.auth.apiToken,
      });

      return response.success && response.valid;
    } catch {
      return false;
    }
  }

  /**
   * Check if logged in
   */
  isLoggedIn() {
    return this.auth.loggedIn && !!this.auth.apiToken;
  }

  // ==========================================
  // TUNNEL RELAY (WireGuard + TURN)
  // ==========================================

  /**
   * Ensure WireGuard keys exist
   */
  async ensureKeys() {
    const keysDir = path.join(this.dataDir, 'wireguard-keys');
    const privateKeyPath = path.join(keysDir, 'relay_private.key');
    const publicKeyPath = path.join(keysDir, 'relay_public.key');

    try {
      if (!fs.existsSync(keysDir)) {
        fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
      }

      if (!fs.existsSync(privateKeyPath)) {
        const privateKey = execSync('wg genkey').toString().trim();
        const publicKey = execSync(`echo "${privateKey}" | wg pubkey`).toString().trim();

        fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
        fs.writeFileSync(publicKeyPath, publicKey, { mode: 0o644 });

        logger.info('[HomenichatCloud] Generated new WireGuard keys');
      }

      this.tunnel.privateKey = fs.readFileSync(privateKeyPath, 'utf8').trim();
      this.tunnel.publicKey = fs.readFileSync(publicKeyPath, 'utf8').trim();

    } catch (error) {
      logger.error('[HomenichatCloud] Failed to ensure keys:', error.message);
      throw error;
    }
  }

  /**
   * Check if WireGuard is available
   */
  isWireGuardAvailable() {
    try {
      execSync('which wg', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Register with tunnel relay
   */
  async registerTunnel() {
    if (!this.isLoggedIn()) {
      throw new Error('Not logged in');
    }

    if (!this.tunnel.publicKey) {
      await this.ensureKeys();
    }

    logger.info('[HomenichatCloud] Registering with tunnel relay...');

    // Use API token as license key (unified auth)
    const response = await this.apiRequest('POST', '/api/register', {
      licenseKey: this.auth.apiToken,
      clientId: this.config.clientId,
      publicKey: this.tunnel.publicKey,
      hostname: this.config.hostname,
    });

    if (!response.success) {
      throw new Error(response.error || 'Registration failed');
    }

    this.tunnel.registration = response.config;
    this.tunnel.turnCredentials = response.config.turn;
    this.tunnel.registered = true;
    this.tunnel.configured = true;
    this.tunnel.lastRefresh = Date.now();

    this.saveConfig();
    this.emit('tunnel-registered', this.tunnel.registration);

    logger.info('[HomenichatCloud] Tunnel registered', {
      subdomain: response.config.subdomain,
      publicUrl: response.config.publicUrl,
    });

    return response;
  }

  /**
   * Connect WireGuard tunnel
   */
  async connectTunnel() {
    if (!this.isLoggedIn()) {
      throw new Error('Not logged in');
    }

    if (!this.services.tunnel.enabled) {
      logger.warn('[HomenichatCloud] Tunnel service not enabled for this account');
      return;
    }

    // Check WireGuard availability
    if (!this.isWireGuardAvailable()) {
      logger.warn('[HomenichatCloud] WireGuard not installed, skipping tunnel setup');
      // Still register for TURN credentials
      await this.registerTunnel();
      return;
    }

    // Register if not already
    if (!this.tunnel.registered || !this.tunnel.registration) {
      await this.registerTunnel();
    }

    // Create WireGuard config
    await this.createWireGuardConfig();

    // Bring up interface
    try {
      execSync(`wg-quick down ${this.wgInterface} 2>/dev/null || true`, { stdio: 'pipe' });
      execSync(`wg-quick up ${this.wgInterface}`, { stdio: 'pipe' });

      this.tunnel.connected = true;
      this.emit('tunnel-connected');

      logger.info('[HomenichatCloud] WireGuard tunnel connected');

    } catch (error) {
      logger.error('[HomenichatCloud] Failed to connect tunnel:', error.message);
      this.tunnel.lastError = error.message;
      throw error;
    }

    this.startRefreshTimer();
    this.startHealthCheck();
    this.startHeartbeat();
  }

  /**
   * Disconnect WireGuard tunnel
   */
  async disconnectTunnel() {
    this.stopRefreshTimer();
    this.stopHealthCheck();
    this.stopHeartbeat();

    if (this.isWireGuardAvailable()) {
      try {
        execSync(`wg-quick down ${this.wgInterface}`, { stdio: 'pipe' });
      } catch {}
    }

    this.tunnel.connected = false;
    this.emit('tunnel-disconnected');

    logger.info('[HomenichatCloud] Tunnel disconnected');
  }

  /**
   * Create WireGuard configuration file
   */
  async createWireGuardConfig() {
    const wg = this.tunnel.registration.wireguard;

    const config = `# Homenichat Cloud - WireGuard Client Config
# Auto-generated by HomenichatCloudService

[Interface]
PrivateKey = ${this.tunnel.privateKey}
Address = ${wg.clientIP}/32

[Peer]
PublicKey = ${wg.serverPublicKey}
Endpoint = ${wg.serverEndpoint}
AllowedIPs = ${wg.allowedIPs}
PersistentKeepalive = ${wg.persistentKeepalive || 25}
`;

    const configPath = `/etc/wireguard/${this.wgInterface}.conf`;
    fs.writeFileSync(configPath, config, { mode: 0o600 });

    return configPath;
  }

  // ==========================================
  // TURN CREDENTIALS
  // ==========================================

  /**
   * Refresh TURN credentials
   */
  async refreshTurnCredentials() {
    if (!this.isLoggedIn()) {
      throw new Error('Not logged in');
    }

    const response = await this.apiRequest('POST', '/api/turn-credentials', {
      clientId: this.config.clientId,
    });

    if (!response.success) {
      throw new Error(response.error || 'Failed to refresh credentials');
    }

    this.tunnel.turnCredentials = response.turn;
    this.tunnel.lastRefresh = Date.now();

    this.saveConfig();
    this.emit('credentials-refreshed', response.turn);

    logger.info('[HomenichatCloud] TURN credentials refreshed');

    return response.turn;
  }

  /**
   * Get current TURN credentials
   */
  async getTurnCredentials() {
    if (!this.tunnel.turnCredentials) {
      if (this.isLoggedIn() && this.tunnel.registered) {
        return this.refreshTurnCredentials();
      }
      return null;
    }

    // Check expiry
    const expiresAt = new Date(this.tunnel.turnCredentials.expiresAt);
    const now = new Date();
    const hoursUntilExpiry = (expiresAt - now) / (1000 * 60 * 60);

    if (hoursUntilExpiry < 1) {
      return this.refreshTurnCredentials();
    }

    return this.tunnel.turnCredentials;
  }

  /**
   * Get ICE servers for WebRTC
   */
  async getIceServers() {
    const servers = [
      {
        urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
      },
    ];

    const turn = await this.getTurnCredentials();
    if (turn) {
      servers.push({
        urls: turn.urls,
        username: turn.username,
        credential: turn.credential,
      });
    }

    return servers;
  }

  // ==========================================
  // PUSH NOTIFICATIONS
  // ==========================================

  /**
   * Register a device for push notifications
   */
  async registerDevice(userId, deviceId, platform, token) {
    if (!this.isLoggedIn()) {
      throw new Error('Not logged in');
    }

    if (!this.services.push.enabled) {
      return { success: false, error: 'Push service not enabled' };
    }

    try {
      const result = await this.pushRequest('POST', '/push/register', {
        userId: String(userId),
        deviceId,
        platform,
        token,
      });

      logger.info('[HomenichatCloud] Device registered for push', { userId, deviceId, platform });
      return result;
    } catch (error) {
      logger.error('[HomenichatCloud] Device registration failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Unregister a device
   */
  async unregisterDevice(userId, deviceId) {
    if (!this.isLoggedIn()) {
      throw new Error('Not logged in');
    }

    try {
      const result = await this.pushRequest('POST', '/push/unregister', {
        userId: String(userId),
        deviceId,
      });

      logger.info('[HomenichatCloud] Device unregistered', { userId, deviceId });
      return result;
    } catch (error) {
      logger.error('[HomenichatCloud] Device unregistration failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send push notification to a user
   */
  async sendPush(userId, type, data, notification = null) {
    if (!this.isLoggedIn()) {
      throw new Error('Not logged in');
    }

    if (!this.services.push.enabled) {
      return { success: false, sent: 0, error: 'Push service not enabled' };
    }

    try {
      const payload = {
        userId: String(userId),
        type,
        data,
      };

      if (notification) {
        payload.notification = notification;
      }

      const result = await this.pushRequest('POST', '/push/send', payload);

      logger.info('[HomenichatCloud] Push sent', { userId, type, sent: result.sent });
      return result;
    } catch (error) {
      logger.error('[HomenichatCloud] Push send failed:', error.message);
      return { success: false, sent: 0, error: error.message };
    }
  }

  /**
   * Send incoming call notification
   */
  async sendIncomingCall(userId, callData) {
    return this.sendPush(userId, 'incoming_call', {
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
    return this.sendPush(
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

  // ==========================================
  // TIMERS
  // ==========================================

  startRefreshTimer() {
    this.stopRefreshTimer();
    this.refreshTimer = setInterval(async () => {
      try {
        await this.refreshTurnCredentials();
      } catch (error) {
        logger.error('[HomenichatCloud] Credential refresh failed:', error.message);
      }
    }, this.config.refreshInterval);
  }

  stopRefreshTimer() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  startHealthCheck() {
    this.stopHealthCheck();
    this.healthCheckTimer = setInterval(async () => {
      await this.checkHealth();
    }, 60000);
  }

  stopHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.sendHeartbeat().catch(() => {});
    this.heartbeatTimer = setInterval(async () => {
      await this.sendHeartbeat();
    }, this.heartbeatInterval);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async sendHeartbeat() {
    if (!this.tunnel.registered || !this.isLoggedIn()) {
      return;
    }

    try {
      const memoryUsage = process.memoryUsage();

      await this.apiRequest('POST', '/api/heartbeat', {
        clientId: this.config.clientId,
        timestamp: Date.now(),
        uptime: Math.floor(process.uptime()),
        memory: {
          heapUsed: memoryUsage.heapUsed,
          heapTotal: memoryUsage.heapTotal,
          rss: memoryUsage.rss,
        },
        wireguard: {
          connected: this.tunnel.connected,
          interface: this.wgInterface,
        },
        version: process.env.npm_package_version || '1.0.0',
      });

      this.tunnel.lastHeartbeat = Date.now();
    } catch (error) {
      // Silently fail - heartbeat is non-critical
    }
  }

  async checkHealth() {
    if (!this.tunnel.connected || !this.isWireGuardAvailable()) {
      return;
    }

    try {
      const output = execSync(`wg show ${this.wgInterface}`).toString();
      const handshakeMatch = output.match(/latest handshake: (.+)/);

      if (handshakeMatch) {
        const handshakeTime = handshakeMatch[1];
        if (handshakeTime.includes('minute') || handshakeTime.includes('second')) {
          return; // Recent handshake, all good
        }
      }

      logger.warn('[HomenichatCloud] No recent handshake, attempting reconnect...');
      await this.reconnectTunnel();

    } catch (error) {
      logger.error('[HomenichatCloud] Health check failed:', error.message);
      this.tunnel.connected = false;
      this.tunnel.lastError = error.message;
      setTimeout(() => this.reconnectTunnel(), 5000);
    }
  }

  async reconnectTunnel() {
    try {
      await this.disconnectTunnel();
      await this.connectTunnel();
    } catch (error) {
      logger.error('[HomenichatCloud] Reconnect failed:', error.message);
    }
  }

  // ==========================================
  // API HELPERS
  // ==========================================

  /**
   * Make API request to tunnel relay
   */
  async apiRequest(method, endpoint, body = null) {
    return this._request(CLOUD_API_URL, method, endpoint, body);
  }

  /**
   * Make API request to push relay
   */
  async pushRequest(method, endpoint, body = null) {
    return this._request(PUSH_RELAY_URL, method, endpoint, body, true);
  }

  /**
   * Generic HTTP request
   */
  async _request(baseUrl, method, endpoint, body = null, usePushAuth = false) {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint, baseUrl);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'homenichat-serv/1.0',
      };

      // Add auth header if logged in
      if (this.auth.apiToken) {
        if (usePushAuth) {
          headers['X-API-Key'] = this.auth.apiToken;
        } else {
          headers['Authorization'] = `Bearer ${this.auth.apiToken}`;
        }
      }

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
        timeout: 30000,
      };

      const req = httpModule.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json);
            } else {
              reject(new Error(json.error || `HTTP ${res.statusCode}`));
            }
          } catch {
            reject(new Error(`Invalid JSON response: ${data.substring(0, 100)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  // ==========================================
  // STATUS
  // ==========================================

  /**
   * Get full service status
   */
  async getStatus() {
    const status = {
      loggedIn: this.auth.loggedIn,
      email: this.auth.email,
      userId: this.auth.userId,

      services: {
        push: {
          enabled: this.services.push.enabled,
          url: this.services.push.url,
        },
        tunnel: {
          enabled: this.services.tunnel.enabled,
          url: this.services.tunnel.url,
          configured: this.tunnel.configured,
          registered: this.tunnel.registered,
          connected: this.tunnel.connected,
          wireguardAvailable: this.isWireGuardAvailable(),
        },
      },

      clientId: this.config.clientId,
      hostname: this.config.hostname,
      publicKey: this.tunnel.publicKey,
      lastError: this.tunnel.lastError,
      lastRefresh: this.tunnel.lastRefresh,
      lastHeartbeat: this.tunnel.lastHeartbeat,
    };

    if (this.tunnel.registration) {
      status.subdomain = this.tunnel.registration.subdomain;
      status.publicUrl = this.tunnel.registration.publicUrl;
      status.wireguard = {
        clientIP: this.tunnel.registration.wireguard?.clientIP,
        serverEndpoint: this.tunnel.registration.wireguard?.serverEndpoint,
      };
    }

    if (this.tunnel.turnCredentials) {
      status.turn = {
        urls: this.tunnel.turnCredentials.urls,
        expiresAt: this.tunnel.turnCredentials.expiresAt,
      };
    }

    // Get WireGuard interface status
    if (this.tunnel.connected && this.isWireGuardAvailable()) {
      try {
        const output = execSync(`wg show ${this.wgInterface}`).toString();
        const handshakeMatch = output.match(/latest handshake: (.+)/);
        const transferMatch = output.match(/transfer: ([\d.]+\s+\w+) received, ([\d.]+\s+\w+) sent/);

        status.tunnelStats = {
          interface: this.wgInterface,
          lastHandshake: handshakeMatch ? handshakeMatch[1] : null,
          bytesReceived: transferMatch ? transferMatch[1] : '0',
          bytesSent: transferMatch ? transferMatch[2] : '0',
        };
      } catch {}
    }

    return status;
  }

  /**
   * Test connection to relay server
   */
  async testConnection() {
    try {
      const response = await this._request(CLOUD_API_URL, 'GET', '/health', null, false);
      return { success: true, relay: response };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Configure the service (hostname only)
   */
  async configure(newConfig) {
    if (newConfig.hostname !== undefined) {
      this.config.hostname = newConfig.hostname;
    }
    if (newConfig.autoConnect !== undefined) {
      this.config.autoConnect = newConfig.autoConnect;
    }

    this.saveConfig();
    this.emit('configured', this.config);

    return this.getStatus();
  }
}

// Export singleton
module.exports = new HomenichatCloudService();
