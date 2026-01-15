/**
 * TunnelService - Expose Homenichat-serv to the internet via tunnl.gg
 *
 * Uses SSH reverse tunneling to create a public URL without any
 * port forwarding or DNS configuration required.
 *
 * Features:
 * - Simple on/off toggle
 * - Auto-reconnect on disconnect
 * - URL extraction and persistence
 * - Status monitoring
 *
 * Usage: ssh -t -R 80:localhost:PORT proxy.tunnl.gg
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class TunnelService extends EventEmitter {
  constructor(config = {}) {
    super();

    this.port = config.port || 3001;
    this.enabled = false;
    this.process = null;
    this.url = null;
    this.status = 'disconnected'; // disconnected, connecting, connected, error
    this.lastError = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = config.maxReconnectAttempts || 5;
    this.reconnectDelay = config.reconnectDelay || 5000;
    this.reconnectTimer = null;

    // Persistence
    this.dataDir = config.dataDir || '/var/lib/homenichat';
    this.stateFile = path.join(this.dataDir, 'tunnel-state.json');

    // Stats
    this.connectedAt = null;
    this.totalConnections = 0;

    // Load saved state
    this.loadState();
  }

  /**
   * Load persisted state
   */
  loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        this.enabled = data.enabled || false;
        this.totalConnections = data.totalConnections || 0;

        // Auto-start if was enabled
        if (this.enabled) {
          console.log('[Tunnel] Auto-starting tunnel (was enabled)');
          this.start();
        }
      }
    } catch (error) {
      console.error('[Tunnel] Failed to load state:', error.message);
    }
  }

  /**
   * Save state to disk
   */
  saveState() {
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.stateFile, JSON.stringify({
        enabled: this.enabled,
        totalConnections: this.totalConnections,
        lastUrl: this.url,
      }));
    } catch (error) {
      console.error('[Tunnel] Failed to save state:', error.message);
    }
  }

  /**
   * Start the tunnel
   */
  async start() {
    if (this.process) {
      console.log('[Tunnel] Already running');
      return { success: true, url: this.url };
    }

    this.enabled = true;
    this.status = 'connecting';
    this.lastError = null;
    this.emit('status', this.getStatus());

    console.log(`[Tunnel] Starting tunnel for localhost:${this.port}...`);

    return new Promise((resolve) => {
      // Spawn SSH process
      // -t: pseudo-terminal (required for tunnl.gg)
      // -o StrictHostKeyChecking=no: auto-accept host key
      // -o ServerAliveInterval=30: keepalive every 30s
      // -o ServerAliveCountMax=3: disconnect after 3 missed keepalives
      this.process = spawn('ssh', [
        '-t',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-R', `80:localhost:${this.port}`,
        'proxy.tunnl.gg',
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let outputBuffer = '';
      let urlFound = false;

      // Handle stdout - looking for the URL
      this.process.stdout.on('data', (data) => {
        const output = data.toString();
        outputBuffer += output;
        console.log('[Tunnel] stdout:', output.trim());

        // Parse URL from output
        // Example: "Forwarding HTTP traffic from https://abc-def-ghi.tunnl.gg"
        // Or: "Your tunnel URL: https://abc-def-ghi.tunnl.gg"
        const urlMatch = output.match(/https?:\/\/[\w-]+\.tunnl\.gg/);
        if (urlMatch && !urlFound) {
          urlFound = true;
          this.url = urlMatch[0];
          this.status = 'connected';
          this.connectedAt = Date.now();
          this.totalConnections++;
          this.reconnectAttempts = 0;

          console.log(`[Tunnel] Connected! URL: ${this.url}`);
          this.saveState();
          this.emit('connected', { url: this.url });
          this.emit('status', this.getStatus());

          resolve({ success: true, url: this.url });
        }
      });

      // Handle stderr
      this.process.stderr.on('data', (data) => {
        const output = data.toString();
        console.log('[Tunnel] stderr:', output.trim());

        // Also check stderr for URL (some SSH implementations output there)
        const urlMatch = output.match(/https?:\/\/[\w-]+\.tunnl\.gg/);
        if (urlMatch && !urlFound) {
          urlFound = true;
          this.url = urlMatch[0];
          this.status = 'connected';
          this.connectedAt = Date.now();
          this.totalConnections++;
          this.reconnectAttempts = 0;

          console.log(`[Tunnel] Connected! URL: ${this.url}`);
          this.saveState();
          this.emit('connected', { url: this.url });
          this.emit('status', this.getStatus());

          resolve({ success: true, url: this.url });
        }
      });

      // Handle process exit
      this.process.on('close', (code) => {
        console.log(`[Tunnel] Process exited with code ${code}`);
        this.process = null;

        const wasConnected = this.status === 'connected';

        if (this.enabled) {
          // Unexpected disconnect - try to reconnect
          this.status = 'disconnected';
          this.emit('disconnected', { code });
          this.emit('status', this.getStatus());

          if (!urlFound) {
            this.lastError = `SSH connection failed (exit code: ${code})`;
            resolve({ success: false, error: this.lastError });
          }

          // Auto-reconnect if still enabled
          this.scheduleReconnect();
        } else {
          this.status = 'disconnected';
          this.url = null;
          this.emit('status', this.getStatus());
        }
      });

      // Handle errors
      this.process.on('error', (error) => {
        console.error('[Tunnel] Process error:', error.message);
        this.lastError = error.message;
        this.status = 'error';
        this.process = null;

        this.emit('error', { error: error.message });
        this.emit('status', this.getStatus());

        if (!urlFound) {
          resolve({ success: false, error: error.message });
        }

        // Try to reconnect
        if (this.enabled) {
          this.scheduleReconnect();
        }
      });

      // Timeout for initial connection
      setTimeout(() => {
        if (!urlFound && this.process) {
          console.log('[Tunnel] Connection timeout, waiting for URL...');
          // Don't kill, just resolve with pending status
          // The URL might come later
        }
      }, 10000);
    });
  }

  /**
   * Stop the tunnel
   */
  stop() {
    console.log('[Tunnel] Stopping tunnel...');

    this.enabled = false;
    this.url = null;

    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Kill the process
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }

    this.status = 'disconnected';
    this.saveState();
    this.emit('status', this.getStatus());

    console.log('[Tunnel] Tunnel stopped');
    return { success: true };
  }

  /**
   * Schedule a reconnection attempt
   */
  scheduleReconnect() {
    if (!this.enabled) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[Tunnel] Max reconnect attempts reached, giving up');
      this.status = 'error';
      this.lastError = 'Max reconnection attempts reached';
      this.emit('status', this.getStatus());
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`[Tunnel] Scheduling reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);

    this.reconnectTimer = setTimeout(() => {
      if (this.enabled && !this.process) {
        console.log(`[Tunnel] Reconnect attempt ${this.reconnectAttempts}...`);
        this.start();
      }
    }, delay);
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      enabled: this.enabled,
      status: this.status,
      url: this.url,
      connectedAt: this.connectedAt,
      uptime: this.connectedAt ? Date.now() - this.connectedAt : null,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
      totalConnections: this.totalConnections,
    };
  }

  /**
   * Toggle tunnel on/off
   */
  async toggle() {
    if (this.enabled) {
      return this.stop();
    } else {
      return this.start();
    }
  }

  /**
   * Check if SSH is available
   */
  static async checkSshAvailable() {
    return new Promise((resolve) => {
      const proc = spawn('which', ['ssh']);
      proc.on('close', (code) => {
        resolve(code === 0);
      });
      proc.on('error', () => {
        resolve(false);
      });
    });
  }
}

module.exports = TunnelService;
