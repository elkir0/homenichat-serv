/**
 * Modem Mapping Repository
 * Handles user-modem mappings for SMS/Call notifications
 */

const logger = require('../../../utils/logger');

const getDb = () => require('./index').db;

const ModemMappingRepository = {
    /**
     * Create or update a user-modem mapping
     */
    create(userId, modemId, options = {}) {
        const {
            modemPhoneNumber = null,
            permissions = 'send,receive',
            notifySms = true,
            notifyCalls = true,
        } = options;

        const stmt = getDb().prepare(`
            INSERT INTO user_modem_mappings (user_id, modem_id, modem_phone_number, permissions, notify_sms, notify_calls)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, modem_id) DO UPDATE SET
                modem_phone_number = excluded.modem_phone_number,
                permissions = excluded.permissions,
                notify_sms = excluded.notify_sms,
                notify_calls = excluded.notify_calls
        `);
        stmt.run(userId, modemId, modemPhoneNumber, permissions, notifySms ? 1 : 0, notifyCalls ? 1 : 0);
        logger.info(`User ${userId} mapped to modem ${modemId}`);
        return { userId, modemId, modemPhoneNumber, permissions, notifySms, notifyCalls };
    },

    /**
     * Get all modems a user can access
     */
    findByUserId(userId) {
        const rows = getDb().prepare('SELECT * FROM user_modem_mappings WHERE user_id = ?').all(userId);
        return rows.map(row => this._formatRow(row));
    },

    /**
     * Get all users who can access a modem
     */
    findByModemId(modemId) {
        const rows = getDb().prepare(`
            SELECT u.id, u.username, m.*
            FROM user_modem_mappings m
            JOIN users u ON m.user_id = u.id
            WHERE m.modem_id = ?
        `).all(modemId);
        return rows.map(r => ({
            id: r.id,
            username: r.username,
            ...this._formatRow(r),
        }));
    },

    /**
     * Get users for SMS notifications on a modem
     */
    findUsersForSmsNotifications(modemId) {
        return getDb().prepare(`
            SELECT u.id, u.username
            FROM user_modem_mappings m
            JOIN users u ON m.user_id = u.id
            WHERE m.modem_id = ? AND m.notify_sms = 1
        `).all(modemId);
    },

    /**
     * Get users for call notifications on a modem
     */
    findUsersForCallNotifications(modemId) {
        return getDb().prepare(`
            SELECT u.id, u.username
            FROM user_modem_mappings m
            JOIN users u ON m.user_id = u.id
            WHERE m.modem_id = ? AND m.notify_calls = 1
        `).all(modemId);
    },

    /**
     * Check if user has access to a modem
     */
    hasAccess(userId, modemId) {
        const row = getDb().prepare(
            'SELECT id FROM user_modem_mappings WHERE user_id = ? AND modem_id = ?'
        ).get(userId, modemId);
        return !!row;
    },

    /**
     * Delete a mapping
     */
    delete(userId, modemId) {
        const result = getDb().prepare(
            'DELETE FROM user_modem_mappings WHERE user_id = ? AND modem_id = ?'
        ).run(userId, modemId);
        return result.changes > 0;
    },

    /**
     * Delete all mappings for a user
     */
    deleteAllForUser(userId) {
        const result = getDb().prepare('DELETE FROM user_modem_mappings WHERE user_id = ?').run(userId);
        return result.changes;
    },

    /**
     * Get all mappings (admin view)
     */
    findAll() {
        const rows = getDb().prepare(`
            SELECT m.*, u.username
            FROM user_modem_mappings m
            JOIN users u ON m.user_id = u.id
            ORDER BY u.username, m.modem_id
        `).all();
        return rows.map(r => ({
            username: r.username,
            ...this._formatRow(r),
        }));
    },

    /**
     * Auto-map all users to a modem
     */
    autoMapAllUsers(modemId, modemPhoneNumber = null) {
        const users = require('./UserRepository').findAll();
        const results = [];

        for (const user of users) {
            const mapping = this.create(user.id, modemId, {
                modemPhoneNumber,
                permissions: 'send,receive',
                notifySms: true,
                notifyCalls: true,
            });
            results.push(mapping);
        }

        logger.info(`Auto-mapped ${results.length} users to modem ${modemId}`);
        return results;
    },

    /**
     * Format database row
     */
    _formatRow(row) {
        return {
            id: row.id,
            userId: row.user_id,
            modemId: row.modem_id,
            modemPhoneNumber: row.modem_phone_number,
            permissions: row.permissions,
            notifySms: !!row.notify_sms,
            notifyCalls: !!row.notify_calls,
            createdAt: row.created_at,
        };
    },
};

module.exports = ModemMappingRepository;
