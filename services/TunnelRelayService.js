/**
 * TunnelRelayService - WireGuard + TURN Relay Integration
 *
 * Connects homenichat-serv to the Homenichat Relay infrastructure
 * for zero-config VoIP and remote access.
 * Configuration is automatic - no user setup required.
 *
 * Features:
 * - Auto-registration with relay server
 * - Dynamic WireGuard tunnel management
 * - TURN credentials refresh for WebRTC
 * - Public URL generation via wildcard subdomain
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');
const EventEmitter = require('events');

// Hardcoded Homenichat Relay configuration
const RELAY_URL = 'https://relay.homenichat.com';

class TunnelRelayService extends EventEmitter {
  constructor(options = {}) {
    super();

    this.dataDir = options.dataDir || process.env.DATA_DIR || '/var/lib/homenichat';
    this.configPath = options.configPath || path.join(this.dataDir, 'tunnel-relay.json');

    // Configuration (auto-enabled with hardcoded URL)
    this.config = {
      enabled: true,
      relayUrl: RELAY_URL,
      clientId: '',
      hostname: '',
      autoConnect: true,
      refreshInterval: 12 * 60 * 60 * 1000, // 12 hours
    };

    // State
    this.state = {
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

    // Timers
    this.refreshTimer = null;
    this.healthCheckTimer = null;
    this.heartbeatTimer = null;

    // Intervals
    this.heartbeatInterval = 60000; // 60 seconds

    // WireGuard interface
    this.wgInterface = 'wg-relay';
  }

  /**
   * Initialize the service
   */
  async initialize() {
    try {
      await this.loadConfig();

      if (this.config.enabled && this.config.relayUrl) {
        // Generate keys if needed
        await this.ensureKeys();

        if (this.config.autoConnect) {
          await this.connect();
        }
      }

      console.log('[TunnelRelayService] Initialized', {
        enabled: this.config.enabled,
        configured: this.isConfigured()
      });

    } catch (error) {
      console.error('[TunnelRelayService] Initialization failed:', error.message);
      this.state.lastError = error.message;
    }
  }

  /**
   * Load saved state from file (registration, credentials)
   */
  async loadConfig() {
    try {
      // Load saved state from file (but keep hardcoded config)
      if (fs.existsSync(this.configPath)) {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        // Only restore state, not config (config is hardcoded)
        if (data.state) {
          Object.assign(this.state, data.state);
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

      // Always configured with hardcoded URL
      this.state.configured = true;

    } catch (error) {
      console.error('[TunnelRelayService] Failed to load state:', error.message);
    }
  }

  /**
   * Save configuration to file
   */
  saveConfig() {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.configPath, JSON.stringify({
        config: this.config,
        state: {
          configured: this.state.configured,
          registered: this.state.registered,
          publicKey: this.state.publicKey,
          registration: this.state.registration,
          turnCredentials: this.state.turnCredentials,
          lastRefresh: this.state.lastRefresh,
          lastHeartbeat: this.state.lastHeartbeat,
        }
      }, null, 2));

    } catch (error) {
      console.error('[TunnelRelayService] Failed to save config:', error.message);
    }
  }

  /**
   * Get machine ID for unique client identification
   */
  getMachineId() {
    try {
      if (fs.existsSync('/etc/machine-id')) {
        return fs.readFileSync('/etc/machine-id', 'utf8').trim();
      }
    } catch {}

    // Generate random ID
    return crypto.randomUUID();
  }

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
        // Generate new key pair
        const privateKey = execSync('wg genkey').toString().trim();
        const publicKey = execSync(`echo "${privateKey}" | wg pubkey`).toString().trim();

        fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
        fs.writeFileSync(publicKeyPath, publicKey, { mode: 0o644 });

        console.log('[TunnelRelayService] Generated new WireGuard keys');
      }

      this.state.privateKey = fs.readFileSync(privateKeyPath, 'utf8').trim();
      this.state.publicKey = fs.readFileSync(publicKeyPath, 'utf8').trim();

    } catch (error) {
      console.error('[TunnelRelayService] Failed to ensure keys:', error.message);
      throw error;
    }
  }

  /**
   * Check if service is configured
   */
  isConfigured() {
    return this.state.configured && !!this.config.relayUrl;
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
   * Make API request to relay server
   */
  async apiRequest(method, endpoint, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint, this.config.relayUrl);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'homenichat-serv/1.0'
        },
        timeout: 30000,
      };

      const req = httpModule.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
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

  /**
   * Register with relay server
   */
  async register() {
    if (!this.isConfigured()) {
      throw new Error('Service not configured');
    }

    if (!this.state.publicKey) {
      await this.ensureKeys();
    }

    console.log('[TunnelRelayService] Registering with relay...');

    const response = await this.apiRequest('POST', '/api/register', {
      clientId: this.config.clientId,
      publicKey: this.state.publicKey,
      hostname: this.config.hostname
    });

    if (!response.success) {
      throw new Error(response.error || 'Registration failed');
    }

    this.state.registration = response.config;
    this.state.turnCredentials = response.config.turn;
    this.state.registered = true;
    this.state.lastRefresh = Date.now();

    this.saveConfig();
    this.emit('registered', this.state.registration);

    console.log('[TunnelRelayService] Registered successfully', {
      subdomain: response.config.subdomain,
      publicUrl: response.config.publicUrl
    });

    return response;
  }

  /**
   * Connect to WireGuard tunnel
   */
  async connect() {
    if (!this.isConfigured()) {
      throw new Error('Service not configured');
    }

    // Check WireGuard availability
    if (!this.isWireGuardAvailable()) {
      console.warn('[TunnelRelayService] WireGuard not installed, skipping tunnel setup');
      // Still register for TURN credentials
      await this.register();
      return;
    }

    // Register if not already
    if (!this.state.registered || !this.state.registration) {
      await this.register();
    }

    // Create WireGuard config
    await this.createWireGuardConfig();

    // Bring up interface
    try {
      execSync(`wg-quick down ${this.wgInterface} 2>/dev/null || true`, { stdio: 'pipe' });
      execSync(`wg-quick up ${this.wgInterface}`, { stdio: 'pipe' });

      this.state.connected = true;
      this.emit('connected');

      console.log('[TunnelRelayService] WireGuard tunnel connected');

    } catch (error) {
      console.error('[TunnelRelayService] Failed to connect tunnel:', error.message);
      this.state.lastError = error.message;
      throw error;
    }

    // Start refresh timer
    this.startRefreshTimer();

    // Start health check
    this.startHealthCheck();

    // Start heartbeat to relay server
    this.startHeartbeat();
  }

  /**
   * Disconnect from WireGuard tunnel
   */
  async disconnect() {
    this.stopRefreshTimer();
    this.stopHealthCheck();
    this.stopHeartbeat();

    if (this.isWireGuardAvailable()) {
      try {
        execSync(`wg-quick down ${this.wgInterface}`, { stdio: 'pipe' });
      } catch {}
    }

    this.state.connected = false;
    this.emit('disconnected');

    console.log('[TunnelRelayService] Disconnected');
  }

  /**
   * Create WireGuard configuration file
   */
  async createWireGuardConfig() {
    const wg = this.state.registration.wireguard;

    const config = `# Homenichat Relay - WireGuard Client Config
# Auto-generated by TunnelRelayService

[Interface]
PrivateKey = ${this.state.privateKey}
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

  /**
   * Refresh TURN credentials
   */
  async refreshTurnCredentials() {
    if (!this.isConfigured()) {
      throw new Error('Service not configured');
    }

    const response = await this.apiRequest('POST', '/api/turn-credentials', {
      clientId: this.config.clientId
    });

    if (!response.success) {
      throw new Error(response.error || 'Failed to refresh credentials');
    }

    this.state.turnCredentials = response.turn;
    this.state.lastRefresh = Date.now();

    this.saveConfig();
    this.emit('credentials-refreshed', response.turn);

    console.log('[TunnelRelayService] TURN credentials refreshed');

    return response.turn;
  }

  /**
   * Get current TURN credentials
   */
  async getTurnCredentials() {
    if (!this.state.turnCredentials) {
      if (this.isConfigured()) {
        return this.refreshTurnCredentials();
      }
      return null;
    }

    // Check expiry
    const expiresAt = new Date(this.state.turnCredentials.expiresAt);
    const now = new Date();
    const hoursUntilExpiry = (expiresAt - now) / (1000 * 60 * 60);

    if (hoursUntilExpiry < 1) {
      return this.refreshTurnCredentials();
    }

    return this.state.turnCredentials;
  }

  /**
   * Get ICE servers configuration for WebRTC
   */
  async getIceServers() {
    const servers = [
      {
        urls: [
          'stun:stun.l.google.com:19302',
          'stun:stun1.l.google.com:19302'
        ]
      }
    ];

    const turn = await this.getTurnCredentials();
    if (turn) {
      servers.push({
        urls: turn.urls,
        username: turn.username,
        credential: turn.credential
      });
    }

    return servers;
  }

  /**
   * Start refresh timer
   */
  startRefreshTimer() {
    this.stopRefreshTimer();

    this.refreshTimer = setInterval(async () => {
      try {
        await this.refreshTurnCredentials();
      } catch (error) {
        console.error('[TunnelRelayService] Credential refresh failed:', error.message);
        this.state.lastError = error.message;
      }
    }, this.config.refreshInterval);
  }

  /**
   * Stop refresh timer
   */
  stopRefreshTimer() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Start heartbeat timer (sends system stats to relay server)
   */
  startHeartbeat() {
    this.stopHeartbeat();

    // Send immediately
    this.sendHeartbeat().catch(() => {});

    this.heartbeatTimer = setInterval(async () => {
      await this.sendHeartbeat();
    }, this.heartbeatInterval);

    console.log('[TunnelRelayService] Heartbeat started (interval: 60s)');
  }

  /**
   * Stop heartbeat timer
   */
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Send heartbeat with system stats to relay server
   */
  async sendHeartbeat() {
    if (!this.state.registered || !this.isConfigured()) {
      return;
    }

    try {
      const memoryUsage = process.memoryUsage();
      const lastHandshake = await this.getLastHandshake();

      const stats = {
        clientId: this.config.clientId,
        timestamp: Date.now(),
        uptime: Math.floor(process.uptime()),
        memory: {
          heapUsed: memoryUsage.heapUsed,
          heapTotal: memoryUsage.heapTotal,
          rss: memoryUsage.rss,
        },
        wireguard: {
          connected: this.state.connected,
          interface: this.wgInterface,
          lastHandshake: lastHandshake,
        },
        version: process.env.npm_package_version || '1.0.0',
      };

      await this.apiRequest('POST', '/api/heartbeat', stats);
      this.state.lastHeartbeat = Date.now();

    } catch (error) {
      // Silently fail - heartbeat is non-critical
      console.debug('[TunnelRelayService] Heartbeat failed:', error.message);
    }
  }

  /**
   * Get last WireGuard handshake time
   */
  async getLastHandshake() {
    if (!this.state.connected || !this.isWireGuardAvailable()) {
      return null;
    }

    try {
      const output = execSync(`wg show ${this.wgInterface}`).toString();
      const match = output.match(/latest handshake: (.+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Start health check timer
   */
  startHealthCheck() {
    this.stopHealthCheck();

    this.healthCheckTimer = setInterval(async () => {
      await this.checkHealth();
    }, 60000); // Every minute
  }

  /**
   * Stop health check timer
   */
  stopHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Check tunnel health
   */
  async checkHealth() {
    if (!this.state.connected || !this.isWireGuardAvailable()) {
      return;
    }

    try {
      const output = execSync(`wg show ${this.wgInterface}`).toString();

      // Check for recent handshake
      const handshakeMatch = output.match(/latest handshake: (.+)/);
      if (handshakeMatch) {
        const handshakeTime = handshakeMatch[1];
        // Parse relative time like "5 seconds ago"
        if (handshakeTime.includes('minute') || handshakeTime.includes('second')) {
          return; // Recent handshake, all good
        }
      }

      // No recent handshake, may need reconnect
      console.warn('[TunnelRelayService] No recent handshake, attempting reconnect...');
      await this.reconnect();

    } catch (error) {
      console.error('[TunnelRelayService] Health check failed:', error.message);
      this.state.connected = false;
      this.state.lastError = error.message;

      // Try to reconnect
      setTimeout(() => this.reconnect(), 5000);
    }
  }

  /**
   * Reconnect tunnel
   */
  async reconnect() {
    try {
      await this.disconnect();
      await this.connect();
    } catch (error) {
      console.error('[TunnelRelayService] Reconnect failed:', error.message);
    }
  }

  /**
   * Get connection status
   */
  async getStatus() {
    const status = {
      enabled: this.config.enabled,
      configured: this.isConfigured(),
      registered: this.state.registered,
      connected: this.state.connected,
      wireguardAvailable: this.isWireGuardAvailable(),
      relayUrl: this.config.relayUrl,
      clientId: this.config.clientId,
      hostname: this.config.hostname,
      publicKey: this.state.publicKey,
      lastError: this.state.lastError,
      lastRefresh: this.state.lastRefresh,
      lastHeartbeat: this.state.lastHeartbeat,
    };

    if (this.state.registration) {
      status.subdomain = this.state.registration.subdomain;
      status.publicUrl = this.state.registration.publicUrl;
      status.wireguard = {
        clientIP: this.state.registration.wireguard?.clientIP,
        serverEndpoint: this.state.registration.wireguard?.serverEndpoint,
      };
    }

    if (this.state.turnCredentials) {
      status.turn = {
        urls: this.state.turnCredentials.urls,
        expiresAt: this.state.turnCredentials.expiresAt,
      };
    }

    // Get WireGuard interface status
    if (this.state.connected && this.isWireGuardAvailable()) {
      try {
        const output = execSync(`wg show ${this.wgInterface}`).toString();

        const handshakeMatch = output.match(/latest handshake: (.+)/);
        const transferMatch = output.match(/transfer: ([\d.]+\s+\w+) received, ([\d.]+\s+\w+) sent/);

        status.tunnel = {
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
   * Configure the service
   */
  async configure(newConfig) {
    const wasEnabled = this.config.enabled;
    const wasConnected = this.state.connected;

    // Update config
    if (newConfig.relayUrl !== undefined) {
      this.config.relayUrl = newConfig.relayUrl;
    }
    if (newConfig.enabled !== undefined) {
      this.config.enabled = newConfig.enabled;
    }
    if (newConfig.hostname !== undefined) {
      this.config.hostname = newConfig.hostname;
    }
    if (newConfig.autoConnect !== undefined) {
      this.config.autoConnect = newConfig.autoConnect;
    }

    this.state.configured = !!(this.config.enabled && this.config.relayUrl);

    // Handle enable/disable
    if (this.config.enabled && !wasEnabled) {
      // Just enabled
      await this.ensureKeys();
      if (this.config.autoConnect) {
        await this.connect();
      }
    } else if (!this.config.enabled && wasConnected) {
      // Just disabled
      await this.disconnect();
    }

    this.saveConfig();
    this.emit('configured', this.config);

    return this.getStatus();
  }

  /**
   * Test connection to relay server
   */
  async testConnection() {
    if (!this.config.relayUrl) {
      return { success: false, error: 'Relay URL not configured' };
    }

    try {
      const response = await this.apiRequest('GET', '/health');
      return {
        success: true,
        relay: response
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}

// Export singleton
module.exports = new TunnelRelayService();
