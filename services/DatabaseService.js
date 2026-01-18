const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs-extra');
const logger = require('winston');
const bcrypt = require('bcryptjs');

class DatabaseService {
    constructor() {
        if (DatabaseService.instance) {
            return DatabaseService.instance;
        }

        const dataDir = process.env.DATA_DIR || path.join(__dirname, '../data');
        this.dbPath = path.join(dataDir, 'lekip-chat.db');

        this.db = null;
        this.ensureDataDirectory();
        this.connect();
        this.initSchema();
        this.ensureDefaultAdmin();

        DatabaseService.instance = this;
    }

    ensureDataDirectory() {
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    connect() {
        try {
            this.db = new Database(this.dbPath, {
                verbose: process.env.NODE_ENV === 'development' ? console.log : null
            });
            // Activer WAL mode pour la performance
            this.db.pragma('journal_mode = WAL');
            logger.info(`Connected to SQLite database at ${this.dbPath}`);
        } catch (error) {
            logger.error('Failed to connect to database:', error);
            throw error;
        }
    }

    initSchema() {
        try {
            // Tables Utilisateurs & Sessions
            this.db.exec(`
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

            // Tables CHATS (WhatsApp & SMS)
            this.db.exec(`
        CREATE TABLE IF NOT EXISTS chats (
          id TEXT PRIMARY KEY, -- remoteJid
          name TEXT,
          provider TEXT DEFAULT 'whatsapp', -- 'whatsapp' | 'sms'
          unread_count INTEGER DEFAULT 0,
          timestamp INTEGER, -- Unix timestamp (baileys style)
          profile_picture TEXT,
          metadata JSON, -- Pour stocker le raw chat object si besoin
          local_phone_number TEXT, -- Le numéro local qui reçoit/envoie
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

            // Migration: Ajouter local_phone_number si absent (pour les DB existantes)
            try {
                this.db.exec("ALTER TABLE chats ADD COLUMN local_phone_number TEXT");
            } catch (e) {
                // La colonne existe probablement déjà, on ignore
            }

            // Tables MESSAGES
            this.db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY, -- message key.id
          chat_id TEXT NOT NULL,
          sender_id TEXT,
          from_me BOOLEAN DEFAULT 0,
          type TEXT, -- 'text', 'image', 'audio', etc.
          content TEXT, -- Texte ou caption
          timestamp INTEGER,
          status TEXT DEFAULT 'received', -- 'sent', 'delivered', 'read'
          media_url TEXT,
          raw_data JSON, -- Le message objet complet pour compatibilité Baileys
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
        CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
        CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp ON messages(chat_id, timestamp DESC);
      `);

            // Tables CONTACTS
            this.db.exec(`
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

            // Table SETTINGS (Key-Value pour la config)
            this.db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value JSON,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

            // Table CALL_HISTORY (Historique d'appels partagé)
            this.db.exec(`
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
          raw_data JSON,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

          FOREIGN KEY (answered_by_user_id) REFERENCES users(id)
        );

        CREATE INDEX IF NOT EXISTS idx_call_history_start_time ON call_history(start_time DESC);
        CREATE INDEX IF NOT EXISTS idx_call_history_status ON call_history(status);
        CREATE INDEX IF NOT EXISTS idx_call_history_answered_by ON call_history(answered_by_user_id);
        CREATE INDEX IF NOT EXISTS idx_call_history_pbx_call_id ON call_history(pbx_call_id);
      `);

            // Run migrations for existing databases
            this.runMigrations();

            logger.info('Database schema initialized');
        } catch (error) {
            logger.error('Failed to initialize schema:', error);
            throw error;
        }
    }

    /**
     * Run database migrations for existing tables
     */
    runMigrations() {
        // Add line_name column to call_history if not exists
        try {
            const columns = this.db.prepare("PRAGMA table_info(call_history)").all();
            const hasLineName = columns.some(col => col.name === 'line_name');
            if (!hasLineName) {
                this.db.exec("ALTER TABLE call_history ADD COLUMN line_name TEXT");
                logger.info('Migration: Added line_name column to call_history');
            }
        } catch (err) {
            logger.debug('Migration line_name skipped:', err.message);
        }

        // Migration: Add voip_tokens table for iOS VoIP Push (APNs)
        // This is ADDITIVE - does not affect existing PWA functionality
        try {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS voip_tokens (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    token TEXT NOT NULL,
                    platform TEXT DEFAULT 'ios',
                    device_id TEXT,
                    app_version TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    UNIQUE(token)
                );
                CREATE INDEX IF NOT EXISTS idx_voip_tokens_user_id ON voip_tokens(user_id);
                CREATE INDEX IF NOT EXISTS idx_voip_tokens_token ON voip_tokens(token);
            `);
            logger.info('Migration: voip_tokens table ready');
        } catch (err) {
            logger.debug('Migration voip_tokens skipped:', err.message);
        }

        // Migration: Add user_voip_extensions table for WebRTC/SIP extensions per user
        try {
            this.db.exec(`
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
                CREATE INDEX IF NOT EXISTS idx_user_voip_extensions_user_id ON user_voip_extensions(user_id);
                CREATE INDEX IF NOT EXISTS idx_user_voip_extensions_extension ON user_voip_extensions(extension);
            `);
            logger.info('Migration: user_voip_extensions table ready');
        } catch (err) {
            logger.debug('Migration user_voip_extensions skipped:', err.message);
        }
    }

    // --- Generic Helpers ---

    prepare(sql) {
        return this.db.prepare(sql);
    }

    transaction(fn) {
        return this.db.transaction(fn);
    }

    exec(sql) {
        return this.db.exec(sql);
    }

    ensureDefaultAdmin() {
        try {
            const admin = this.getUserByUsername('admin');
            if (!admin) {
                logger.info('No admin user found. Creating default admin...');
                const hashedPassword = bcrypt.hashSync('Homenichat', 10);
                this.createUser('admin', hashedPassword, 'admin');
                logger.info('Default admin created: admin / Homenichat');
            }
        } catch (error) {
            logger.error('Failed to ensure default admin:', error);
        }
    }

    // --- Users ---
    getUserByUsername(username) {
        return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    }

    getUserById(id) {
        return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    }

    createUser(username, password, role = 'user') {
        const stmt = this.db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)');
        const info = stmt.run(username, password, role);
        return { id: info.lastInsertRowid, username, role };
    }

    getAllUsers() {
        return this.db.prepare('SELECT id, username, role, created_at, last_login FROM users').all();
    }

    deleteUser(id) {
        this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }

    changePassword(id, newPassword) {
        this.db.prepare('UPDATE users SET password = ? WHERE id = ?').run(newPassword, id);
    }

    updateUserRole(id, role) {
        this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    }

    updateLastLogin(id) {
        this.db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    }

    // --- Sessions ---
    createSession(userId, token, expiresAt) {
        this.db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
            .run(token, userId, expiresAt.toISOString());
    }

    getSession(token) {
        return this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    }

    deleteSession(token) {
        this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    }

    // --- Settings (Key-Value) ---
    getSetting(key) {
        const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        if (!row) return null;
        try {
            return JSON.parse(row.value);
        } catch (e) {
            return row.value;
        }
    }

    setSetting(key, value) {
        const jsonValue = typeof value === 'string' ? value : JSON.stringify(value);
        this.db.prepare(`
            INSERT INTO settings (key, value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `).run(key, jsonValue);
    }

    deleteSetting(key) {
        this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    }

    // --- Call History ---

    /**
     * Enregistrer un nouvel appel
     */
    createCall(call) {
        const stmt = this.db.prepare(`
            INSERT INTO call_history (
                id, direction, caller_number, called_number, caller_name,
                start_time, answer_time, end_time, duration,
                answered_by_user_id, answered_by_username, answered_by_extension,
                status, source, pbx_call_id, seen, notes, recording_url, line_name, raw_data
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            call.id,
            call.direction,
            call.callerNumber,
            call.calledNumber,
            call.callerName || null,
            call.startTime,
            call.answerTime || null,
            call.endTime || null,
            call.duration || 0,
            call.answeredByUserId || null,
            call.answeredByUsername || null,
            call.answeredByExtension || null,
            call.status,
            call.source || 'pwa',
            call.pbxCallId || null,
            call.seen ? 1 : 0,
            call.notes || null,
            call.recordingUrl || null,
            call.lineName || null,
            call.rawData ? JSON.stringify(call.rawData) : null
        );
        return call;
    }

    /**
     * Mettre à jour un appel existant
     */
    updateCall(id, updates) {
        const fields = [];
        const values = [];

        if (updates.answerTime !== undefined) {
            fields.push('answer_time = ?');
            values.push(updates.answerTime);
        }
        if (updates.endTime !== undefined) {
            fields.push('end_time = ?');
            values.push(updates.endTime);
        }
        if (updates.duration !== undefined) {
            fields.push('duration = ?');
            values.push(updates.duration);
        }
        if (updates.answeredByUserId !== undefined) {
            fields.push('answered_by_user_id = ?');
            values.push(updates.answeredByUserId);
        }
        if (updates.answeredByUsername !== undefined) {
            fields.push('answered_by_username = ?');
            values.push(updates.answeredByUsername);
        }
        if (updates.answeredByExtension !== undefined) {
            fields.push('answered_by_extension = ?');
            values.push(updates.answeredByExtension);
        }
        if (updates.status !== undefined) {
            fields.push('status = ?');
            values.push(updates.status);
        }
        if (updates.seen !== undefined) {
            fields.push('seen = ?');
            values.push(updates.seen ? 1 : 0);
        }
        if (updates.notes !== undefined) {
            fields.push('notes = ?');
            values.push(updates.notes);
        }
        if (updates.recordingUrl !== undefined) {
            fields.push('recording_url = ?');
            values.push(updates.recordingUrl);
        }

        if (fields.length === 0) return null;

        values.push(id);
        const sql = `UPDATE call_history SET ${fields.join(', ')} WHERE id = ?`;
        this.db.prepare(sql).run(...values);
        return this.getCallById(id);
    }

    /**
     * Récupérer un appel par ID
     */
    getCallById(id) {
        const row = this.db.prepare('SELECT * FROM call_history WHERE id = ?').get(id);
        return row ? this._formatCallRow(row) : null;
    }

    /**
     * Récupérer un appel par pbx_call_id (pour dédoublonnage)
     */
    getCallByPbxId(pbxCallId) {
        const row = this.db.prepare('SELECT * FROM call_history WHERE pbx_call_id = ?').get(pbxCallId);
        return row ? this._formatCallRow(row) : null;
    }

    /**
     * Récupérer l'historique des appels (paginé)
     */
    getCallHistory({ limit = 50, offset = 0, status = null, direction = null, before = null, after = null } = {}) {
        let sql = 'SELECT * FROM call_history WHERE 1=1';
        const params = [];

        if (status) {
            sql += ' AND status = ?';
            params.push(status);
        }
        if (direction) {
            sql += ' AND direction = ?';
            params.push(direction);
        }
        if (before) {
            sql += ' AND start_time < ?';
            params.push(before);
        }
        if (after) {
            sql += ' AND start_time > ?';
            params.push(after);
        }

        sql += ' ORDER BY start_time DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const rows = this.db.prepare(sql).all(...params);
        return rows.map(row => this._formatCallRow(row));
    }

    /**
     * Compter les appels manqués non vus
     */
    getMissedCallsCount() {
        const row = this.db.prepare(
            "SELECT COUNT(*) as count FROM call_history WHERE status = 'missed' AND seen = 0"
        ).get();
        return row ? row.count : 0;
    }

    /**
     * Marquer tous les appels manqués comme vus
     */
    markAllMissedCallsAsSeen() {
        this.db.prepare("UPDATE call_history SET seen = 1 WHERE status = 'missed' AND seen = 0").run();
    }

    /**
     * Statistiques d'appels (pour dashboard admin)
     */
    getCallStats({ days = 30 } = {}) {
        const since = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);

        const stats = this.db.prepare(`
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status = 'answered' THEN 1 ELSE 0 END) as answered,
                SUM(CASE WHEN status = 'missed' THEN 1 ELSE 0 END) as missed,
                SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) as incoming,
                SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) as outgoing,
                AVG(CASE WHEN duration > 0 THEN duration ELSE NULL END) as avg_duration,
                SUM(duration) as total_duration
            FROM call_history
            WHERE start_time > ?
        `).get(since);

        return {
            total: stats.total || 0,
            answered: stats.answered || 0,
            missed: stats.missed || 0,
            incoming: stats.incoming || 0,
            outgoing: stats.outgoing || 0,
            avgDuration: Math.round(stats.avg_duration || 0),
            totalDuration: stats.total_duration || 0
        };
    }

    /**
     * Purger les appels de plus de 90 jours
     */
    purgeOldCalls(daysToKeep = 90) {
        const cutoff = Math.floor(Date.now() / 1000) - (daysToKeep * 24 * 60 * 60);
        const result = this.db.prepare('DELETE FROM call_history WHERE start_time < ?').run(cutoff);
        return result.changes;
    }

    /**
     * Formater une ligne de BDD en objet JS
     */
    _formatCallRow(row) {
        return {
            id: row.id,
            direction: row.direction,
            callerNumber: row.caller_number,
            calledNumber: row.called_number,
            callerName: row.caller_name,
            lineName: row.line_name,
            startTime: row.start_time,
            answerTime: row.answer_time,
            endTime: row.end_time,
            duration: row.duration,
            answeredByUserId: row.answered_by_user_id,
            answeredByUsername: row.answered_by_username,
            answeredByExtension: row.answered_by_extension,
            status: row.status,
            source: row.source,
            pbxCallId: row.pbx_call_id,
            seen: !!row.seen,
            notes: row.notes,
            recordingUrl: row.recording_url,
            rawData: row.raw_data ? JSON.parse(row.raw_data) : null,
            createdAt: row.created_at
        };
    }

    // =====================================================
    // VoIP Tokens (iOS APNs Push) - ADDITIVE for iOS app
    // Does NOT affect existing PWA functionality
    // =====================================================

    /**
     * Register or update a VoIP token for a user
     * @param {number} userId - User ID
     * @param {string} token - APNs VoIP token
     * @param {object} metadata - Optional device info
     */
    registerVoIPToken(userId, token, metadata = {}) {
        const stmt = this.db.prepare(`
            INSERT INTO voip_tokens (user_id, token, platform, device_id, app_version, last_used_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(token) DO UPDATE SET
                user_id = excluded.user_id,
                platform = excluded.platform,
                device_id = excluded.device_id,
                app_version = excluded.app_version,
                last_used_at = CURRENT_TIMESTAMP
        `);
        stmt.run(
            userId,
            token,
            metadata.platform || 'ios',
            metadata.deviceId || null,
            metadata.appVersion || null
        );
        logger.info(`VoIP token registered for user ${userId}`);
        return { userId, token, platform: metadata.platform || 'ios' };
    }

    /**
     * Get all VoIP tokens for a user
     * @param {number} userId - User ID
     */
    getVoIPTokensByUserId(userId) {
        return this.db.prepare('SELECT * FROM voip_tokens WHERE user_id = ?').all(userId);
    }

    /**
     * Get all VoIP tokens (for broadcasting to all iOS devices)
     */
    getAllVoIPTokens() {
        return this.db.prepare('SELECT * FROM voip_tokens').all();
    }

    /**
     * Unregister a VoIP token
     * @param {string} token - APNs VoIP token to remove
     */
    unregisterVoIPToken(token) {
        const result = this.db.prepare('DELETE FROM voip_tokens WHERE token = ?').run(token);
        return result.changes > 0;
    }

    /**
     * Unregister all VoIP tokens for a user (on logout)
     * @param {number} userId - User ID
     */
    unregisterAllVoIPTokensForUser(userId) {
        const result = this.db.prepare('DELETE FROM voip_tokens WHERE user_id = ?').run(userId);
        return result.changes;
    }

    /**
     * Update last_used_at timestamp for a token
     * @param {string} token - APNs VoIP token
     */
    touchVoIPToken(token) {
        this.db.prepare('UPDATE voip_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token = ?').run(token);
    }

    /**
     * Cleanup stale VoIP tokens (not used in 30 days)
     * @param {number} daysInactive - Days of inactivity before cleanup
     */
    cleanupStaleVoIPTokens(daysInactive = 30) {
        const result = this.db.prepare(`
            DELETE FROM voip_tokens
            WHERE last_used_at < datetime('now', '-' || ? || ' days')
        `).run(daysInactive);
        if (result.changes > 0) {
            logger.info(`Cleaned up ${result.changes} stale VoIP tokens`);
        }
        return result.changes;
    }

    // =====================================================
    // User VoIP Extensions - WebRTC/SIP accounts per user
    // =====================================================

    /**
     * Create a VoIP extension for a user
     * @param {number} userId - User ID
     * @param {object} extensionData - Extension configuration
     */
    createVoIPExtension(userId, extensionData) {
        const {
            extension,
            secret,
            displayName,
            context = 'from-internal',
            transport = 'wss',
            // Codec priority for GSM modem compatibility
            codecs = 'g722,ulaw,alaw,opus',
            enabled = true,
            webrtcEnabled = true
        } = extensionData;

        const stmt = this.db.prepare(`
            INSERT INTO user_voip_extensions
            (user_id, extension, secret, display_name, context, transport, codecs, enabled, webrtc_enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const info = stmt.run(
            userId,
            extension,
            secret,
            displayName || null,
            context,
            transport,
            codecs,
            enabled ? 1 : 0,
            webrtcEnabled ? 1 : 0
        );

        logger.info(`VoIP extension ${extension} created for user ${userId}`);
        return {
            id: info.lastInsertRowid,
            userId,
            extension,
            displayName,
            context,
            transport,
            codecs,
            enabled,
            webrtcEnabled
        };
    }

    /**
     * Get VoIP extension by user ID
     * @param {number} userId - User ID
     */
    getVoIPExtensionByUserId(userId) {
        const row = this.db.prepare('SELECT * FROM user_voip_extensions WHERE user_id = ?').get(userId);
        return row ? this._formatVoIPExtensionRow(row) : null;
    }

    /**
     * Get VoIP extension by extension number
     * @param {string} extension - Extension number
     */
    getVoIPExtensionByNumber(extension) {
        const row = this.db.prepare('SELECT * FROM user_voip_extensions WHERE extension = ?').get(extension);
        return row ? this._formatVoIPExtensionRow(row) : null;
    }

    /**
     * Get all VoIP extensions
     */
    getAllVoIPExtensions() {
        const rows = this.db.prepare(`
            SELECT e.*, u.username
            FROM user_voip_extensions e
            JOIN users u ON e.user_id = u.id
            ORDER BY e.extension ASC
        `).all();
        return rows.map(row => ({
            ...this._formatVoIPExtensionRow(row),
            username: row.username
        }));
    }

    /**
     * Update VoIP extension
     * @param {number} userId - User ID
     * @param {object} updates - Fields to update
     */
    updateVoIPExtension(userId, updates) {
        const fields = [];
        const values = [];

        if (updates.displayName !== undefined) {
            fields.push('display_name = ?');
            values.push(updates.displayName);
        }
        if (updates.secret !== undefined) {
            fields.push('secret = ?');
            values.push(updates.secret);
        }
        if (updates.context !== undefined) {
            fields.push('context = ?');
            values.push(updates.context);
        }
        if (updates.transport !== undefined) {
            fields.push('transport = ?');
            values.push(updates.transport);
        }
        if (updates.codecs !== undefined) {
            fields.push('codecs = ?');
            values.push(updates.codecs);
        }
        if (updates.enabled !== undefined) {
            fields.push('enabled = ?');
            values.push(updates.enabled ? 1 : 0);
        }
        if (updates.webrtcEnabled !== undefined) {
            fields.push('webrtc_enabled = ?');
            values.push(updates.webrtcEnabled ? 1 : 0);
        }
        if (updates.syncedToPbx !== undefined) {
            fields.push('synced_to_pbx = ?');
            values.push(updates.syncedToPbx ? 1 : 0);
        }
        if (updates.pbxSyncError !== undefined) {
            fields.push('pbx_sync_error = ?');
            values.push(updates.pbxSyncError);
        }

        if (fields.length === 0) return null;

        fields.push('updated_at = CURRENT_TIMESTAMP');
        values.push(userId);

        const sql = `UPDATE user_voip_extensions SET ${fields.join(', ')} WHERE user_id = ?`;
        this.db.prepare(sql).run(...values);

        return this.getVoIPExtensionByUserId(userId);
    }

    /**
     * Delete VoIP extension for a user
     * @param {number} userId - User ID
     */
    deleteVoIPExtension(userId) {
        const existing = this.getVoIPExtensionByUserId(userId);
        if (!existing) return false;

        this.db.prepare('DELETE FROM user_voip_extensions WHERE user_id = ?').run(userId);
        logger.info(`VoIP extension ${existing.extension} deleted for user ${userId}`);
        return true;
    }

    /**
     * Get next available extension number
     * @param {number} startFrom - Starting extension number (default 1000)
     */
    getNextAvailableExtension(startFrom = 1000) {
        const row = this.db.prepare(`
            SELECT MAX(CAST(extension AS INTEGER)) as max_ext
            FROM user_voip_extensions
            WHERE extension GLOB '[0-9]*'
        `).get();

        const maxExt = row?.max_ext || (startFrom - 1);
        return String(Math.max(maxExt + 1, startFrom));
    }

    /**
     * Check if extension is available
     * @param {string} extension - Extension number to check
     */
    isExtensionAvailable(extension) {
        const row = this.db.prepare('SELECT id FROM user_voip_extensions WHERE extension = ?').get(extension);
        return !row;
    }

    /**
     * Get extensions pending sync to PBX
     */
    getExtensionsPendingSync() {
        const rows = this.db.prepare(`
            SELECT e.*, u.username
            FROM user_voip_extensions e
            JOIN users u ON e.user_id = u.id
            WHERE e.synced_to_pbx = 0 AND e.enabled = 1
        `).all();
        return rows.map(row => ({
            ...this._formatVoIPExtensionRow(row),
            username: row.username
        }));
    }

    /**
     * Format VoIP extension row from DB
     */
    _formatVoIPExtensionRow(row) {
        return {
            id: row.id,
            userId: row.user_id,
            extension: row.extension,
            secret: row.secret,
            displayName: row.display_name,
            context: row.context,
            transport: row.transport,
            codecs: row.codecs,
            enabled: !!row.enabled,
            webrtcEnabled: !!row.webrtc_enabled,
            syncedToPbx: !!row.synced_to_pbx,
            pbxSyncError: row.pbx_sync_error,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }
}

module.exports = new DatabaseService();
