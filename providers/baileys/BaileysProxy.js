/**
 * BaileysProxy - Main process proxy for the Baileys worker
 *
 * This class runs in the main process and implements the same interface
 * as BaileysProvider, but delegates all calls to a child process via IPC.
 *
 * Features:
 * - Worker lifecycle management (spawn, crash detection, auto-restart)
 * - Request/response correlation with timeouts
 * - Event forwarding from worker to ProviderManager
 * - Graceful shutdown support
 * - Fallback to direct in-process mode (use_worker: false)
 */

const { fork } = require('child_process');
const path = require('path');
const WhatsAppProvider = require('../base/WhatsAppProvider');
const { MESSAGE_TYPES, METHODS, TIMEOUTS } = require('./ipc-protocol');
const logger = require('../../utils/logger');

class BaileysProxy extends WhatsAppProvider {
  constructor(config = {}) {
    super(config);

    // Worker management
    this.worker = null;
    this.workerPath = path.join(__dirname, 'BaileysWorker.js');
    this.pendingCalls = new Map(); // id -> { resolve, reject, timeout }
    this.requestIdCounter = 0;

    // Restart management
    this.isShuttingDown = false;
    this.isRestarting = false;
    this.maxRestarts = 5;
    this.restartCount = 0;
    this.restartDelay = 3000; // Base delay in ms
    this.restartTimer = null;

    // Connection state (cached from worker events)
    this.connectionState = 'disconnected';
    this.qrCode = null;
    this.phoneNumber = null;

    // Configurable: use worker or direct in-process mode
    this.workerEnabled = config.use_worker !== false; // Default: true

    // Direct provider reference (when use_worker: false)
    this._directProvider = null;
  }

  /**
   * Initialize the proxy - spawn worker and initialize Baileys
   * @param {Object} config - Configuration to pass to Baileys
   */
  async initialize(config) {
    const effectiveConfig = config || this.config;

    // Check if worker mode is disabled
    if (!this.workerEnabled) {
      logger.info('[BaileysProxy] Worker mode disabled, using direct in-process provider');
      return this._initializeDirectMode(effectiveConfig);
    }

    return this._spawnAndInitializeWorker(effectiveConfig);
  }

  /**
   * Initialize in direct mode (no worker, same process)
   */
  async _initializeDirectMode(config) {
    const DirectProviderFactory = require('./BaileysProvider');

    // Reset singleton for fresh start
    if (DirectProviderFactory.resetInstance) {
      DirectProviderFactory.resetInstance();
    }

    this._directProvider = DirectProviderFactory(config);

    // Forward events from direct provider
    this._directProvider.setEventHandler((event, data) => {
      // Update cached state
      if (event === 'connection.update') {
        this.connectionState = data.status || data.state || this.connectionState;
        this.qrCode = data.qrCode || null;
        this.phoneNumber = data.phoneNumber || this.phoneNumber;
      }
      // Forward to ProviderManager
      this.emit(event, { ...data, provider: 'baileys' });
    });

    return this._directProvider.initialize(config);
  }

  /**
   * Spawn worker and send initialization message
   */
  async _spawnAndInitializeWorker(config) {
    return new Promise((resolve, reject) => {
      logger.info('[BaileysProxy] Spawning Baileys worker process...');

      try {
        this.worker = fork(this.workerPath, [], {
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          env: {
            ...process.env,
            BAILEYS_WORKER: 'true',
            // Preserve DEBUG env if set
            DEBUG: process.env.DEBUG
          }
        });

        // Forward worker stdout/stderr to main logger
        this.worker.stdout?.on('data', (data) => {
          const msg = data.toString().trim();
          if (msg) logger.info(`[Worker:stdout] ${msg}`);
        });

        this.worker.stderr?.on('data', (data) => {
          const msg = data.toString().trim();
          if (msg) logger.error(`[Worker:stderr] ${msg}`);
        });

        // Handle all worker messages
        this.worker.on('message', (message) => this._handleWorkerMessage(message));

        // Handle worker exit
        this.worker.on('exit', (code, signal) => {
          logger.warn(`[BaileysProxy] Worker exited with code ${code}, signal ${signal}`);
          this._handleWorkerExit(code, signal);
        });

        // Handle worker error
        this.worker.on('error', (error) => {
          logger.error('[BaileysProxy] Worker error:', error);
          reject(error);
        });

        // Set up initialization flow: INIT -> wait for READY -> call initialize()
        let initTimeout;

        const handleReady = () => {
          clearTimeout(initTimeout);
          logger.info('[BaileysProxy] Worker ready, calling initialize...');

          // Now call the actual initialize method on the provider
          this._call('initialize', [config], TIMEOUTS.INITIALIZE)
            .then(() => {
              this.restartCount = 0; // Reset restart count on successful init
              logger.info('[BaileysProxy] Worker initialized successfully');
              resolve(true);
            })
            .catch((err) => {
              logger.error('[BaileysProxy] Worker initialize failed:', err.message);
              reject(err);
            });
        };

        // One-time listener for READY message
        const originalHandler = this._handleWorkerMessage.bind(this);
        const readyHandler = (message) => {
          if (message.type === MESSAGE_TYPES.READY) {
            // Remove the temporary override
            this.worker.removeListener('message', readyHandler);
            this.worker.on('message', originalHandler);
            handleReady();
          } else {
            // Forward other messages to normal handler
            originalHandler(message);
          }
        };

        // Temporarily override message handler
        this.worker.removeAllListeners('message');
        this.worker.on('message', readyHandler);

        // Send INIT config to worker
        this.worker.send({ type: MESSAGE_TYPES.INIT, config });

        // Timeout for initialization
        initTimeout = setTimeout(() => {
          reject(new Error('Worker initialization timeout (60s)'));
          this.worker?.kill('SIGTERM');
        }, TIMEOUTS.INITIALIZE);

      } catch (error) {
        logger.error('[BaileysProxy] Failed to spawn worker:', error);
        reject(error);
      }
    });
  }

  /**
   * Handle messages received from worker
   */
  _handleWorkerMessage(message) {
    if (!message || !message.type) return;

    const { type, id, result, error, event, data } = message;

    switch (type) {
      case MESSAGE_TYPES.RESPONSE:
        this._resolvePendingCall(id, result);
        break;

      case MESSAGE_TYPES.ERROR:
        this._rejectPendingCall(id, new Error(error?.message || 'Unknown error'));
        break;

      case MESSAGE_TYPES.EVENT:
        // Update cached state from connection events
        if (event === 'connection.update') {
          this.connectionState = data.status || data.state || this.connectionState;
          this.qrCode = data.qrCode || null;
          this.phoneNumber = data.phoneNumber || this.phoneNumber;
        }
        // Forward event to ProviderManager
        this.emit(event, data);
        break;

      case MESSAGE_TYPES.CRASHED:
        logger.error('[BaileysProxy] Worker crashed:', error);
        // Worker will exit, exit handler will deal with restart
        break;

      case MESSAGE_TYPES.READY:
        // Handled in spawn flow, shouldn't reach here normally
        logger.debug('[BaileysProxy] Received READY message');
        break;

      default:
        logger.warn(`[BaileysProxy] Unknown message type: ${type}`);
    }
  }

  /**
   * Handle worker exit - auto-restart if appropriate
   */
  _handleWorkerExit(code, signal) {
    // Reject all pending calls
    for (const [id, pending] of this.pendingCalls) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Worker exited (code: ${code}, signal: ${signal})`));
    }
    this.pendingCalls.clear();

    // Update state
    this.connectionState = 'disconnected';
    this.qrCode = null;
    this.worker = null;

    // Emit disconnection event
    this.emit('connection.update', {
      status: 'disconnected',
      error: `Worker process exited (code: ${code})`,
      provider: 'baileys'
    });

    // Don't restart if we're shutting down
    if (this.isShuttingDown) {
      logger.info('[BaileysProxy] Shutdown in progress, not restarting worker');
      return;
    }

    // Auto-restart with exponential backoff
    if (this.restartCount < this.maxRestarts) {
      this.restartCount++;
      const delay = this.restartDelay * this.restartCount;

      logger.info(`[BaileysProxy] Scheduling restart in ${delay}ms (attempt ${this.restartCount}/${this.maxRestarts})`);

      this.restartTimer = setTimeout(() => {
        this._spawnAndInitializeWorker(this.config)
          .then(() => {
            logger.info('[BaileysProxy] Worker restarted successfully');
          })
          .catch((err) => {
            logger.error('[BaileysProxy] Worker restart failed:', err.message);
          });
      }, delay);
    } else {
      logger.error('[BaileysProxy] Max restarts reached, manual intervention required');
      this.emit('connection.update', {
        status: 'failed',
        error: 'Max restart attempts reached. Please restart the server.',
        provider: 'baileys'
      });
    }
  }

  /**
   * Make an IPC call to the worker
   * @param {string} method - Method name to call
   * @param {Array} args - Arguments to pass
   * @param {number} timeoutMs - Timeout in milliseconds
   */
  async _call(method, args = [], timeoutMs = TIMEOUTS.DEFAULT) {
    // Direct mode - no worker
    if (this._directProvider) {
      const fn = this._directProvider[method];
      if (typeof fn !== 'function') {
        throw new Error(`Method '${method}' not found on direct provider`);
      }
      return fn.apply(this._directProvider, args);
    }

    // Worker mode - send IPC message
    if (!this.worker) {
      throw new Error('Worker not running. Call initialize() first.');
    }

    const id = `${++this.requestIdCounter}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCalls.delete(id);
        reject(new Error(`Call to '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingCalls.set(id, { resolve, reject, timeout, method });

      try {
        this.worker.send({
          type: MESSAGE_TYPES.CALL,
          id,
          method,
          args
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingCalls.delete(id);
        reject(new Error(`Failed to send IPC message: ${error.message}`));
      }
    });
  }

  /**
   * Resolve a pending call
   */
  _resolvePendingCall(id, result) {
    const pending = this.pendingCalls.get(id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingCalls.delete(id);
      pending.resolve(result);
    }
  }

  /**
   * Reject a pending call
   */
  _rejectPendingCall(id, error) {
    const pending = this.pendingCalls.get(id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingCalls.delete(id);
      pending.reject(error);
    }
  }

  // =====================================================================
  // WhatsAppProvider Interface Implementation
  // All methods delegate to worker via _call()
  // =====================================================================

  async validateConfig() {
    return this._call('validateConfig', []);
  }

  async testConnection() {
    return this._call('testConnection', []);
  }

  async sendTextMessage(to, text, options = {}) {
    return this._call('sendTextMessage', [to, text, options], TIMEOUTS.SEND_MESSAGE);
  }

  async sendMediaMessage(to, media, options = {}) {
    return this._call('sendMediaMessage', [to, media, options], TIMEOUTS.SEND_MESSAGE);
  }

  async sendMessage(to, content, options = {}) {
    return this._call('sendMessage', [to, content, options], TIMEOUTS.SEND_MESSAGE);
  }

  async sendReaction(chatId, messageId, emoji) {
    return this._call('sendReaction', [chatId, messageId, emoji]);
  }

  async getChats(options = {}) {
    return this._call('getChats', [options]);
  }

  async getMessages(chatId, limit = 50, options = {}) {
    return this._call('getMessages', [chatId, limit, options]);
  }

  async getChatInfo(chatId) {
    return this._call('getChatInfo', [chatId]);
  }

  async getContacts() {
    return this._call('getContacts', []);
  }

  async markChatAsRead(chatId) {
    return this._call('markChatAsRead', [chatId]);
  }

  async markMessageAsRead(chatId, messageId) {
    return this._call('markMessageAsRead', [chatId, messageId]);
  }

  async downloadMessageMedia(messageId, chatId = null) {
    return this._call('downloadMessageMedia', [messageId, chatId], TIMEOUTS.DOWNLOAD_MEDIA);
  }

  async checkNumberExists(number) {
    return this._call('checkNumberExists', [number]);
  }

  async sendPresenceUpdate(chatId, type) {
    return this._call('sendPresenceUpdate', [chatId, type]);
  }

  async fetchMissingGroupNames() {
    return this._call('fetchMissingGroupNames', []);
  }

  /**
   * Get connection state - returns cached value for fast access
   */
  async getConnectionState() {
    if (this._directProvider) {
      return this._directProvider.getConnectionState();
    }

    // Return cached state (updated from events)
    return {
      state: this.connectionState,
      status: this.connectionState,
      qrCode: this.qrCode,
      phoneNumber: this.phoneNumber,
      isConnected: this.connectionState === 'connected'
    };
  }

  /**
   * Get QR code - returns cached value
   */
  async getQRCode() {
    return this.qrCode;
  }

  async clearSession(clearData = false) {
    return this._call('clearSession', [clearData]);
  }

  async logout() {
    return this._call('logout', []);
  }

  /**
   * Get provider name
   */
  getProviderName() {
    return 'baileys';
  }

  /**
   * Get provider capabilities
   */
  getCapabilities() {
    return {
      sendText: true,
      sendMedia: true,
      sendDocument: true,
      sendLocation: false,
      sendContact: false,
      sendSticker: true,
      reactions: true,
      typing: true,
      presence: true,
      groups: true,
      broadcasts: false,
      calls: false,
      status: true,
      historySync: true
    };
  }

  // =====================================================================
  // Lifecycle Methods
  // =====================================================================

  /**
   * Gracefully shutdown the worker
   */
  async shutdown() {
    this.isShuttingDown = true;

    // Cancel any pending restart
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Direct mode shutdown
    if (this._directProvider) {
      if (typeof this._directProvider.clearSession === 'function') {
        await this._directProvider.clearSession(false);
      }
      return;
    }

    // Worker mode shutdown
    if (!this.worker) {
      return;
    }

    return new Promise((resolve) => {
      // Force kill after timeout
      const killTimeout = setTimeout(() => {
        logger.warn('[BaileysProxy] Shutdown timeout, force killing worker');
        this.worker?.kill('SIGKILL');
        resolve();
      }, 5000);

      // Wait for clean exit
      this.worker.once('exit', () => {
        clearTimeout(killTimeout);
        resolve();
      });

      // Send shutdown command
      try {
        this.worker.send({ type: MESSAGE_TYPES.SHUTDOWN });
      } catch (error) {
        logger.warn('[BaileysProxy] Failed to send shutdown command:', error.message);
        this.worker.kill('SIGTERM');
      }
    });
  }

  /**
   * Force restart the worker (for manual recovery)
   */
  async restartWorker() {
    logger.info('[BaileysProxy] Manual restart requested');

    // Reset restart count for manual restart
    this.restartCount = 0;

    // Kill current worker if running
    if (this.worker) {
      this.isShuttingDown = true; // Prevent auto-restart
      this.worker.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1000));
      this.isShuttingDown = false;
    }

    // Spawn new worker
    return this._spawnAndInitializeWorker(this.config);
  }

  /**
   * Check if worker is running
   */
  isWorkerRunning() {
    return !!this.worker;
  }

  /**
   * Get worker status for monitoring
   */
  getWorkerStatus() {
    return {
      running: !!this.worker,
      pid: this.worker?.pid || null,
      restartCount: this.restartCount,
      maxRestarts: this.maxRestarts,
      connectionState: this.connectionState,
      workerMode: this.workerEnabled,
      directMode: !!this._directProvider
    };
  }
}

// =====================================================================
// Singleton Pattern (same as original BaileysProvider)
// =====================================================================

let instance = null;

module.exports = function(config) {
  if (!instance) {
    instance = new BaileysProxy(config);
  }
  return instance;
};

module.exports.BaileysProxy = BaileysProxy;
module.exports.getInstance = () => instance;
module.exports.resetInstance = () => { instance = null; };
