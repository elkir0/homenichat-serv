/**
 * User Repository
 * Handles all user-related database operations
 */

const bcrypt = require('bcryptjs');
const logger = require('../../../utils/logger');

// Get database from parent module
const getDb = () => require('./index').db;

const UserRepository = {
    /**
     * Find user by username
     */
    findByUsername(username) {
        return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
    },

    /**
     * Find user by ID
     */
    findById(id) {
        return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
    },

    /**
     * Create a new user
     */
    create(username, password, role = 'user') {
        const stmt = getDb().prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)');
        const info = stmt.run(username, password, role);
        return { id: info.lastInsertRowid, username, role };
    },

    /**
     * Get all users (without passwords)
     */
    findAll() {
        return getDb().prepare('SELECT id, username, role, created_at, last_login FROM users').all();
    },

    /**
     * Delete user
     */
    delete(id) {
        return getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
    },

    /**
     * Change password
     */
    changePassword(id, newPassword) {
        return getDb().prepare('UPDATE users SET password = ? WHERE id = ?').run(newPassword, id);
    },

    /**
     * Update user role
     */
    updateRole(id, role) {
        return getDb().prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    },

    /**
     * Update last login timestamp
     */
    updateLastLogin(id) {
        return getDb().prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    },

    /**
     * Ensure default admin exists
     */
    ensureDefaultAdmin() {
        try {
            const admin = this.findByUsername('admin');
            if (!admin) {
                logger.info('Creating default admin user...');
                const hashedPassword = bcrypt.hashSync(
                    process.env.ADMIN_DEFAULT_PASSWORD || 'Homenichat',
                    10
                );
                this.create('admin', hashedPassword, 'admin');
                logger.info('Default admin created: admin / Homenichat');
            }
        } catch (error) {
            logger.error('Failed to ensure default admin:', error);
        }
    },

    /**
     * Count users
     */
    count() {
        const row = getDb().prepare('SELECT COUNT(*) as count FROM users').get();
        return row?.count || 0;
    },
};

// Ensure default admin on first load
UserRepository.ensureDefaultAdmin();

module.exports = UserRepository;
