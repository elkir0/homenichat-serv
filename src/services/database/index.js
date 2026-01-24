/**
 * Database Service - Central module
 *
 * Refactored from monolithic DatabaseService.js into repositories pattern.
 * Each repository handles one domain (users, chats, messages, etc.)
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('../../../utils/logger');

// Singleton database connection
let db = null;
let dbPath = null;

/**
 * Initialize database connection
 */
function initDatabase() {
    if (db) return db;

    const dataDir = process.env.DATA_DIR || path.join(__dirname, '../../../data');
    dbPath = process.env.DB_PATH || path.join(dataDir, 'homenichat.db');

    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Connect
    db = new Database(dbPath, {
        verbose: process.env.NODE_ENV === 'development' ? console.log : null
    });

    // Enable WAL mode for performance
    db.pragma('journal_mode = WAL');

    logger.info(`Database connected: ${dbPath}`);

    // Initialize schema
    initSchema();

    return db;
}

/**
 * Initialize database schema
 */
function initSchema() {
    // Users & Sessions
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT DEFAULT 'user',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login DATETIME
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `);

    // Chats
    db.exec(`
        CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            name TEXT,
            provider TEXT DEFAULT 'whatsapp',
            unread_count INTEGER DEFAULT 0,
            timestamp INTEGER,
            profile_picture TEXT,
            metadata JSON,
            local_phone_number TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Messages
    db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            chat_id TEXT NOT NULL,
            sender_id TEXT,
            from_me BOOLEAN DEFAULT 0,
            type TEXT,
            content TEXT,
            timestamp INTEGER,
            status TEXT DEFAULT 'received',
            media_url TEXT,
            raw_data JSON,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
        CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
        CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp ON messages(chat_id, timestamp DESC);
    `);

    // Contacts
    db.exec(`
        CREATE TABLE IF NOT EXISTS contacts (
            id TEXT PRIMARY KEY,
            name TEXT,
            notify TEXT,
            verified_name TEXT,
            img_url TEXT,
            status TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Settings (Key-Value)
    db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value JSON,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Call History
    db.exec(`
        CREATE TABLE IF NOT EXISTS call_history (
            id TEXT PRIMARY KEY,
            direction TEXT NOT NULL,
            caller_number TEXT NOT NULL,
            called_number TEXT NOT NULL,
            caller_name TEXT,
            start_time INTEGER NOT NULL,
            answer_time INTEGER,
            end_time INTEGER,
            duration INTEGER DEFAULT 0,
            answered_by_user_id INTEGER,
            answered_by_username TEXT,
            answered_by_extension TEXT,
            status TEXT NOT NULL,
            source TEXT DEFAULT 'pwa',
            pbx_call_id TEXT,
            seen BOOLEAN DEFAULT 0,
            notes TEXT,
            recording_url TEXT,
            line_name TEXT,
            device_name TEXT,
            raw_data JSON,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (answered_by_user_id) REFERENCES users(id)
        );

        CREATE INDEX IF NOT EXISTS idx_call_history_start_time ON call_history(start_time DESC);
        CREATE INDEX IF NOT EXISTS idx_call_history_status ON call_history(status);
        CREATE INDEX IF NOT EXISTS idx_call_history_pbx_call_id ON call_history(pbx_call_id);
    `);

    // VoIP Tokens (iOS APNs)
    db.exec(`
        CREATE TABLE IF NOT EXISTS voip_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token TEXT NOT NULL UNIQUE,
            platform TEXT DEFAULT 'ios',
            device_id TEXT,
            app_version TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_voip_tokens_user_id ON voip_tokens(user_id);
    `);

    // User VoIP Extensions
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_voip_extensions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL UNIQUE,
            extension TEXT NOT NULL UNIQUE,
            secret TEXT NOT NULL,
            display_name TEXT,
            context TEXT DEFAULT 'from-internal',
            transport TEXT DEFAULT 'wss',
            codecs TEXT DEFAULT 'g722,ulaw,alaw,opus',
            enabled BOOLEAN DEFAULT 1,
            webrtc_enabled BOOLEAN DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            synced_to_pbx BOOLEAN DEFAULT 0,
            pbx_sync_error TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_user_voip_extensions_extension ON user_voip_extensions(extension);
    `);

    // Device Tokens (FCM/APNs)
    db.exec(`
        CREATE TABLE IF NOT EXISTS device_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token TEXT NOT NULL UNIQUE,
            device_id TEXT,
            platform TEXT DEFAULT 'android',
            app_version TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_device_tokens_user_id ON device_tokens(user_id);
    `);

    // User-Modem Mappings
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_modem_mappings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            modem_id TEXT NOT NULL,
            modem_phone_number TEXT,
            permissions TEXT DEFAULT 'send,receive',
            notify_sms BOOLEAN DEFAULT 1,
            notify_calls BOOLEAN DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(user_id, modem_id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_modem_mappings_modem_id ON user_modem_mappings(modem_id);
    `);

    logger.info('Database schema initialized');
}

/**
 * Get database instance
 */
function getDb() {
    if (!db) initDatabase();
    return db;
}

/**
 * Close database connection
 */
function closeDatabase() {
    if (db) {
        db.close();
        db = null;
        logger.info('Database connection closed');
    }
}

// Initialize on first require
initDatabase();

// Export database and repositories
module.exports = {
    db: getDb(),
    getDb,
    closeDatabase,

    // Repositories (lazy loaded)
    get users() { return require('./UserRepository'); },
    get sessions() { return require('./SessionRepository'); },
    get settings() { return require('./SettingsRepository'); },
    get calls() { return require('./CallRepository'); },
    get devices() { return require('./DeviceRepository'); },
    get extensions() { return require('./ExtensionRepository'); },
    get modems() { return require('./ModemMappingRepository'); },
};
