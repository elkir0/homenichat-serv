/**
 * Extension Repository
 * Handles VoIP extensions for users (WebRTC/SIP accounts)
 */

const logger = require('../../../utils/logger');

const getDb = () => require('./index').db;

const ExtensionRepository = {
    /**
     * Create a VoIP extension for a user
     */
    create(userId, data) {
        const {
            extension,
            secret,
            displayName,
            context = 'from-internal',
            transport = 'wss',
            codecs = 'g722,ulaw,alaw,opus',
            enabled = true,
            webrtcEnabled = true,
        } = data;

        const stmt = getDb().prepare(`
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
            webrtcEnabled,
        };
    },

    /**
     * Find extension by user ID
     */
    findByUserId(userId) {
        const row = getDb().prepare('SELECT * FROM user_voip_extensions WHERE user_id = ?').get(userId);
        return row ? this._formatRow(row) : null;
    },

    /**
     * Find extension by number
     */
    findByNumber(extension) {
        const row = getDb().prepare('SELECT * FROM user_voip_extensions WHERE extension = ?').get(extension);
        return row ? this._formatRow(row) : null;
    },

    /**
     * Get all extensions
     */
    findAll() {
        const rows = getDb().prepare(`
            SELECT e.*, u.username
            FROM user_voip_extensions e
            JOIN users u ON e.user_id = u.id
            ORDER BY e.extension ASC
        `).all();
        return rows.map(row => ({ ...this._formatRow(row), username: row.username }));
    },

    /**
     * Update extension
     */
    update(userId, updates) {
        const fields = [];
        const values = [];

        const fieldMap = {
            displayName: 'display_name',
            secret: 'secret',
            context: 'context',
            transport: 'transport',
            codecs: 'codecs',
            pbxSyncError: 'pbx_sync_error',
        };

        for (const [key, column] of Object.entries(fieldMap)) {
            if (updates[key] !== undefined) {
                fields.push(`${column} = ?`);
                values.push(updates[key]);
            }
        }

        // Boolean fields
        for (const key of ['enabled', 'webrtcEnabled', 'syncedToPbx']) {
            if (updates[key] !== undefined) {
                const column = key === 'syncedToPbx' ? 'synced_to_pbx' :
                    key === 'webrtcEnabled' ? 'webrtc_enabled' : key;
                fields.push(`${column} = ?`);
                values.push(updates[key] ? 1 : 0);
            }
        }

        if (fields.length === 0) return null;

        fields.push('updated_at = CURRENT_TIMESTAMP');
        values.push(userId);

        const sql = `UPDATE user_voip_extensions SET ${fields.join(', ')} WHERE user_id = ?`;
        getDb().prepare(sql).run(...values);

        return this.findByUserId(userId);
    },

    /**
     * Delete extension
     */
    delete(userId) {
        const existing = this.findByUserId(userId);
        if (!existing) return false;

        getDb().prepare('DELETE FROM user_voip_extensions WHERE user_id = ?').run(userId);
        logger.info(`VoIP extension ${existing.extension} deleted for user ${userId}`);
        return true;
    },

    /**
     * Get next available extension number
     */
    getNextAvailable(startFrom = 2000) {
        const row = getDb().prepare(`
            SELECT MAX(CAST(extension AS INTEGER)) as max_ext
            FROM user_voip_extensions
            WHERE extension GLOB '[0-9]*'
        `).get();

        const maxExt = row?.max_ext || (startFrom - 1);
        return String(Math.max(maxExt + 1, startFrom));
    },

    /**
     * Check if extension is available
     */
    isAvailable(extension) {
        const row = getDb().prepare('SELECT id FROM user_voip_extensions WHERE extension = ?').get(extension);
        return !row;
    },

    /**
     * Get extensions pending PBX sync
     */
    findPendingSync() {
        const rows = getDb().prepare(`
            SELECT e.*, u.username
            FROM user_voip_extensions e
            JOIN users u ON e.user_id = u.id
            WHERE e.synced_to_pbx = 0 AND e.enabled = 1
        `).all();
        return rows.map(row => ({ ...this._formatRow(row), username: row.username }));
    },

    /**
     * Format database row
     */
    _formatRow(row) {
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
            updatedAt: row.updated_at,
        };
    },
};

module.exports = ExtensionRepository;
