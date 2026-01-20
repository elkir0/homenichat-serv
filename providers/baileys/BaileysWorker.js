/**
 * BaileysWorker - Child process that hosts the actual Baileys connection
 *
 * This file runs in a separate Node.js process (forked from main).
 * It manages the real BaileysProvider instance and communicates
 * with the main process via IPC.
 *
 * Responsibilities:
 * - Create and manage BaileysProvider instance
 * - Handle IPC messages from main process
 * - Forward events back to main process
 * - Handle graceful shutdown
 */

const { MESSAGE_TYPES, METHODS } = require('./ipc-protocol');

// We need to require the actual BaileysProvider class
// Note: We use resetInstance to ensure fresh state in worker
let BaileysProviderFactory;
let provider = null;
let isShuttingDown = false;
let isInitialized = false;

// Simple console logger for worker (winston may not work well in forked process)
const workerLog = {
  info: (...args) => console.log('[BaileysWorker]', ...args),
  warn: (...args) => console.warn('[BaileysWorker]', ...args),
  error: (...args) => console.error('[BaileysWorker]', ...args),
  debug: (...args) => process.env.DEBUG && console.log('[BaileysWorker:DEBUG]', ...args),
};

/**
 * Initialize the provider with given config
 */
async function handleInit(config) {
  workerLog.info('Initializing with config...');

  try {
    // Lazy load the provider factory to avoid loading Baileys at worker startup
    if (!BaileysProviderFactory) {
      BaileysProviderFactory = require('./BaileysProvider');
    }

    // Reset singleton if it exists (fresh start)
    if (BaileysProviderFactory.resetInstance) {
      BaileysProviderFactory.resetInstance();
    }

    // Create new provider instance
    provider = BaileysProviderFactory(config || {});

    // Set up event forwarding to main process
    provider.setEventHandler((event, data) => {
      if (process.send) {
        process.send({
          type: MESSAGE_TYPES.EVENT,
          event,
          data: { ...data, provider: 'baileys' }
        });
      }
    });

    isInitialized = true;
    workerLog.info('Provider created, event handler attached');
  } catch (error) {
    workerLog.error('Failed to initialize provider:', error.message);
    throw error;
  }
}

/**
 * Handle method calls from main process
 */
async function handleMethodCall(method, args) {
  if (!provider) {
    throw new Error('Provider not initialized. Call INIT first.');
  }

  if (!METHODS.includes(method)) {
    throw new Error(`Unknown method: ${method}`);
  }

  const fn = provider[method];
  if (typeof fn !== 'function') {
    throw new Error(`Method '${method}' is not a function on provider`);
  }

  workerLog.debug(`Calling method: ${method}`);
  return await fn.apply(provider, args || []);
}

/**
 * Handle graceful shutdown
 */
async function handleShutdown() {
  if (isShuttingDown) {
    workerLog.warn('Already shutting down, ignoring duplicate shutdown request');
    return;
  }

  isShuttingDown = true;
  workerLog.info('Graceful shutdown initiated...');

  if (provider) {
    try {
      // Clear session without deleting data (preserve auth for next start)
      if (typeof provider.clearSession === 'function') {
        await provider.clearSession(false);
      }
      workerLog.info('Session cleared successfully');
    } catch (error) {
      workerLog.error('Error during shutdown:', error.message);
    }
  }

  workerLog.info('Shutdown complete, exiting...');
}

/**
 * Main message handler for IPC
 */
process.on('message', async (message) => {
  if (!message || !message.type) {
    workerLog.warn('Received invalid message:', message);
    return;
  }

  const { type, id, method, args, config } = message;

  try {
    switch (type) {
      case MESSAGE_TYPES.INIT:
        await handleInit(config);
        if (process.send) {
          process.send({ type: MESSAGE_TYPES.READY });
        }
        break;

      case MESSAGE_TYPES.CALL:
        const result = await handleMethodCall(method, args);
        if (process.send) {
          process.send({ type: MESSAGE_TYPES.RESPONSE, id, result });
        }
        break;

      case MESSAGE_TYPES.SHUTDOWN:
        await handleShutdown();
        process.exit(0);
        break;

      default:
        workerLog.warn(`Unknown message type: ${type}`);
    }
  } catch (error) {
    workerLog.error(`Error handling ${type}:`, error.message);
    if (process.send) {
      process.send({
        type: MESSAGE_TYPES.ERROR,
        id,
        error: {
          message: error.message,
          stack: error.stack,
          code: error.code
        }
      });
    }
  }
});

/**
 * Handle uncaught exceptions - report to main and exit
 */
process.on('uncaughtException', (error) => {
  workerLog.error('Uncaught exception:', error);

  if (process.send) {
    process.send({
      type: MESSAGE_TYPES.CRASHED,
      error: {
        message: error.message,
        stack: error.stack,
        code: error.code
      }
    });
  }

  // Give time for the message to be sent before exiting
  setTimeout(() => process.exit(1), 100);
});

/**
 * Handle unhandled promise rejections
 */
process.on('unhandledRejection', (reason, promise) => {
  workerLog.error('Unhandled rejection at:', promise, 'reason:', reason);
  // Don't exit on unhandled rejections, just log
});

/**
 * Handle disconnect from parent process
 */
process.on('disconnect', () => {
  workerLog.warn('Disconnected from parent process, shutting down...');
  handleShutdown().then(() => process.exit(0));
});

/**
 * Handle SIGTERM signal
 */
process.on('SIGTERM', async () => {
  workerLog.info('Received SIGTERM signal');
  await handleShutdown();
  process.exit(0);
});

/**
 * Handle SIGINT signal (Ctrl+C)
 */
process.on('SIGINT', async () => {
  workerLog.info('Received SIGINT signal');
  await handleShutdown();
  process.exit(0);
});

// Announce worker startup
workerLog.info(`Worker process started, PID: ${process.pid}`);
workerLog.info('Waiting for INIT message from parent...');
