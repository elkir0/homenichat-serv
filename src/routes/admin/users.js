/**
 * Admin User Routes
 * Handles user management
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const logger = require('../../../utils/logger');

// Get database (lazy load)
const getDb = () => require('../../services/database');

/**
 * Validation error handler
 */
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }
    next();
};

/**
 * GET /users
 * List all users
 */
router.get('/', async (req, res) => {
    try {
        const db = getDb();
        const users = db.users.findAll();

        // Add extension info to each user
        const usersWithExtensions = users.map(user => {
            const extension = db.extensions.findByUserId(user.id);
            return {
                ...user,
                voipExtension: extension?.extension || null,
            };
        });

        res.json({ users: usersWithExtensions });
    } catch (error) {
        logger.error('[Admin/Users] Error listing users:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /users
 * Create a new user
 */
router.post('/', [
    body('username').isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    handleValidationErrors,
], async (req, res) => {
    try {
        const db = getDb();
        const { username, password, role = 'user' } = req.body;

        // Check if username exists
        const existing = db.users.findByUsername(username);
        if (existing) {
            return res.status(400).json({ error: 'Username already exists' });
        }

        // Hash password
        const hashedPassword = bcrypt.hashSync(password, 10);

        // Create user
        const user = db.users.create(username, hashedPassword, role);

        res.json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
            },
        });
    } catch (error) {
        logger.error('[Admin/Users] Error creating user:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /users/:id
 * Update a user
 */
router.put('/:id', async (req, res) => {
    try {
        const db = getDb();
        const { id } = req.params;
        const { password, role } = req.body;

        const user = db.users.findById(parseInt(id));
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (password) {
            const hashedPassword = bcrypt.hashSync(password, 10);
            db.users.changePassword(parseInt(id), hashedPassword);
        }

        if (role) {
            db.users.updateRole(parseInt(id), role);
        }

        res.json({ success: true });
    } catch (error) {
        logger.error('[Admin/Users] Error updating user:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /users/:id
 * Delete a user
 */
router.delete('/:id', async (req, res) => {
    try {
        const db = getDb();
        const { id } = req.params;
        const userId = parseInt(id);

        const user = db.users.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Prevent deleting the last admin
        if (user.role === 'admin') {
            const admins = db.users.findAll().filter(u => u.role === 'admin');
            if (admins.length <= 1) {
                return res.status(400).json({ error: 'Cannot delete the last admin user' });
            }
        }

        // Delete user (cascade will delete extensions, sessions, etc.)
        db.users.delete(userId);

        res.json({ success: true });
    } catch (error) {
        logger.error('[Admin/Users] Error deleting user:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
