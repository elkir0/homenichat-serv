/**
 * IPC Protocol for Baileys Worker Communication
 *
 * Defines the message format and types for communication between
 * the main process (BaileysProxy) and the child process (BaileysWorker).
 *
 * Message Format:
 * {
 *   type: string,       // Message type (see MESSAGE_TYPES)
 *   id: string,         // Unique request ID (for request/response correlation)
 *   method?: string,    // Method name for 'call' type
 *   args?: any[],       // Arguments for method call
 *   result?: any,       // Result for 'response' type
 *   error?: { message: string, stack?: string },  // Error for 'error' type
 *   event?: string,     // Event name for 'event' type
 *   data?: any          // Event data
 * }
 */

const MESSAGE_TYPES = {
  // Main -> Worker
  CALL: 'call',           // Method invocation request
  INIT: 'init',           // Initialize with config
  SHUTDOWN: 'shutdown',   // Graceful shutdown request

  // Worker -> Main
  RESPONSE: 'response',   // Method response (success)
  ERROR: 'error',         // Method response (error)
  EVENT: 'event',         // Emitted event from Baileys
  READY: 'ready',         // Worker initialization complete
  CRASHED: 'crashed',     // Worker detected fatal error
};

const EVENTS = {
  CONNECTION_UPDATE: 'connection.update',
  MESSAGE: 'message',
  MESSAGE_STATUS: 'message.status',
  PRESENCE_UPDATE: 'presence.update',
  CHATS_UPDATED: 'chats.updated',
};

// Methods exposed via IPC (mirrors WhatsAppProvider interface)
const METHODS = [
  // Initialization
  'initialize',
  'validateConfig',
  'testConnection',

  // Messages
  'sendTextMessage',
  'sendMediaMessage',
  'sendMessage',
  'sendReaction',
  'markChatAsRead',
  'markMessageAsRead',
  'downloadMessageMedia',

  // Chats
  'getChats',
  'getMessages',
  'getChatInfo',
  'getContacts',

  // Connection
  'getConnectionState',
  'getQRCode',
  'checkNumberExists',
  'sendPresenceUpdate',
  'fetchMissingGroupNames',

  // Session
  'clearSession',
  'logout',

  // Info
  'getProviderName',
  'getCapabilities',
];

// Default timeouts for different operation types
const TIMEOUTS = {
  DEFAULT: 30000,         // 30s for most operations
  INITIALIZE: 60000,      // 60s for initialization (QR scan, etc.)
  SEND_MESSAGE: 30000,    // 30s for sending messages
  DOWNLOAD_MEDIA: 60000,  // 60s for media downloads
  HISTORY_SYNC: 120000,   // 2min for history sync operations
};

module.exports = {
  MESSAGE_TYPES,
  EVENTS,
  METHODS,
  TIMEOUTS,
};
