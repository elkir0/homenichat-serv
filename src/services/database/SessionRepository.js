/**
 * Session Repository
 * Handles user session management
 */

const getDb = () => require('./index').db;

const SessionRepository = {
    /**
     * Create a new session
     */
    create(userId, token, expiresAt) {
        return getDb().prepare(
            'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
        ).run(token, userId, expiresAt.toISOString());
    },

    /**
     * Get session by token
     */
    findByToken(token) {
        return getDb().prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    },

    /**
     * Delete session
     */
    delete(token) {
        return getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
    },

    /**
     * Delete all sessions for a user
     */
    deleteAllForUser(userId) {
        return getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    },

    /**
     * Cleanup expired sessions
     */
    cleanupExpired() {
        return getDb().prepare(
            "DELETE FROM sessions WHERE expires_at < datetime('now')"
        ).run();
    },
};

module.exports = SessionRepository;
