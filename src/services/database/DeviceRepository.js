/**
 * Device Repository
 * Handles device tokens for push notifications (FCM, APNs, VoIP)
 */

const logger = require('../../../utils/logger');

const getDb = () => require('./index').db;

const DeviceRepository = {
    // =====================================================
    // Device Tokens (FCM/APNs for push notifications)
    // =====================================================

    /**
     * Register or update a device token
     */
    registerToken(userId, token, deviceId, platform = 'android', metadata = {}) {
        const stmt = getDb().prepare(`
            INSERT INTO device_tokens (user_id, token, device_id, platform, app_version, last_used_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(token) DO UPDATE SET
                user_id = excluded.user_id,
                device_id = excluded.device_id,
                platform = excluded.platform,
                app_version = excluded.app_version,
                last_used_at = CURRENT_TIMESTAMP
        `);
        stmt.run(userId, token, deviceId || null, platform, metadata.appVersion || null);
        logger.info(`Device token registered for user ${userId} (${platform})`);
        return { userId, token, deviceId, platform };
    },

    /**
     * Get all tokens for a user
     */
    findByUserId(userId) {
        return getDb().prepare('SELECT * FROM device_tokens WHERE user_id = ?').all(userId);
    },

    /**
     * Get all tokens
     */
    findAll() {
        return getDb().prepare('SELECT * FROM device_tokens').all();
    },

    /**
     * Get tokens by platform
     */
    findByPlatform(platform) {
        return getDb().prepare('SELECT * FROM device_tokens WHERE platform = ?').all(platform);
    },

    /**
     * Unregister a token
     */
    unregisterToken(token) {
        const result = getDb().prepare('DELETE FROM device_tokens WHERE token = ?').run(token);
        return result.changes > 0;
    },

    /**
     * Unregister all tokens for a user
     */
    unregisterAllForUser(userId) {
        const result = getDb().prepare('DELETE FROM device_tokens WHERE user_id = ?').run(userId);
        return result.changes;
    },

    /**
     * Update last used timestamp
     */
    touch(token) {
        return getDb().prepare(
            'UPDATE device_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token = ?'
        ).run(token);
    },

    /**
     * Cleanup stale tokens
     */
    cleanupStale(daysInactive = 30) {
        const result = getDb().prepare(`
            DELETE FROM device_tokens
            WHERE last_used_at < datetime('now', '-' || ? || ' days')
        `).run(daysInactive);
        if (result.changes > 0) {
            logger.info(`Cleaned up ${result.changes} stale device tokens`);
        }
        return result.changes;
    },

    // =====================================================
    // VoIP Tokens (iOS APNs VoIP Push)
    // =====================================================

    /**
     * Register a VoIP token
     */
    registerVoipToken(userId, token, metadata = {}) {
        const stmt = getDb().prepare(`
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
    },

    /**
     * Get VoIP tokens for a user
     */
    findVoipByUserId(userId) {
        return getDb().prepare('SELECT * FROM voip_tokens WHERE user_id = ?').all(userId);
    },

    /**
     * Get all VoIP tokens
     */
    findAllVoip() {
        return getDb().prepare('SELECT * FROM voip_tokens').all();
    },

    /**
     * Unregister a VoIP token
     */
    unregisterVoipToken(token) {
        const result = getDb().prepare('DELETE FROM voip_tokens WHERE token = ?').run(token);
        return result.changes > 0;
    },

    /**
     * Unregister all VoIP tokens for a user
     */
    unregisterAllVoipForUser(userId) {
        const result = getDb().prepare('DELETE FROM voip_tokens WHERE user_id = ?').run(userId);
        return result.changes;
    },

    /**
     * Touch VoIP token
     */
    touchVoip(token) {
        return getDb().prepare(
            'UPDATE voip_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE token = ?'
        ).run(token);
    },

    /**
     * Cleanup stale VoIP tokens
     */
    cleanupStaleVoip(daysInactive = 30) {
        const result = getDb().prepare(`
            DELETE FROM voip_tokens
            WHERE last_used_at < datetime('now', '-' || ? || ' days')
        `).run(daysInactive);
        if (result.changes > 0) {
            logger.info(`Cleaned up ${result.changes} stale VoIP tokens`);
        }
        return result.changes;
    },
};

module.exports = DeviceRepository;
