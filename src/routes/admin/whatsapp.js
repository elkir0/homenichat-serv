/**
 * Admin WhatsApp Routes
 * Handles WhatsApp session management (Baileys)
 */

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const logger = require('../../../utils/logger');

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

// Get ProviderManager (lazy load)
const getProviderManager = () => {
    try {
        return require('../../services/ProviderManager');
    } catch (e) {
        return null;
    }
};

/**
 * GET /whatsapp/sessions
 * List all WhatsApp sessions (Baileys)
 */
router.get('/sessions', async (req, res) => {
    try {
        const providerManager = getProviderManager();
        if (!providerManager) {
            return res.json({ sessions: [], message: 'ProviderManager not available' });
        }

        const sessions = [];
        const providers = providerManager.getProvidersByType('whatsapp');

        for (const [name, provider] of Object.entries(providers)) {
            if (provider.type === 'baileys') {
                sessions.push({
                    id: name,
                    type: 'baileys',
                    connected: provider.isConnected?.() || false,
                    phone: provider.getPhoneNumber?.() || null,
                    status: provider.getStatus?.() || 'unknown',
                });
            }
        }

        res.json({ sessions });
    } catch (error) {
        logger.error('[Admin/WhatsApp] Error listing sessions:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /whatsapp/sessions
 * Create a new WhatsApp session
 */
router.post('/sessions', [
    body('name').notEmpty().withMessage('Session name required'),
    body('type').optional().isIn(['baileys', 'meta']).withMessage('Invalid type'),
    handleValidationErrors,
], async (req, res) => {
    try {
        const providerManager = getProviderManager();
        if (!providerManager) {
            return res.status(503).json({ error: 'ProviderManager not available' });
        }

        const { name, type = 'baileys' } = req.body;

        // Check if session already exists
        const existing = providerManager.getProvider(name);
        if (existing) {
            return res.status(400).json({ error: `Session '${name}' already exists` });
        }

        // Create new Baileys provider
        if (type === 'baileys') {
            const BaileysProvider = require('../../services/providers/BaileysProvider');
            const provider = new BaileysProvider({ name });
            await providerManager.addProvider(name, provider);

            // Start connection (will generate QR code)
            await provider.connect();

            res.json({
                success: true,
                session: {
                    id: name,
                    type: 'baileys',
                    status: 'connecting',
                    message: 'Session created. Scan QR code to connect.',
                },
            });
        } else {
            res.status(400).json({ error: 'Only Baileys sessions can be created from UI' });
        }
    } catch (error) {
        logger.error('[Admin/WhatsApp] Error creating session:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /whatsapp/qr/:id
 * Get QR code for a WhatsApp session
 */
router.get('/qr/:id', [
    param('id').notEmpty().withMessage('Session ID required'),
    handleValidationErrors,
], async (req, res) => {
    try {
        const providerManager = getProviderManager();
        if (!providerManager) {
            return res.status(503).json({ error: 'ProviderManager not available' });
        }

        const { id } = req.params;
        const provider = providerManager.getProvider(id);

        if (!provider) {
            return res.status(404).json({ error: `Session '${id}' not found` });
        }

        if (provider.type !== 'baileys') {
            return res.status(400).json({ error: 'QR code only available for Baileys sessions' });
        }

        const qrCode = provider.getQRCode?.();
        const status = provider.getStatus?.() || 'unknown';

        if (!qrCode) {
            return res.json({
                qr: null,
                status,
                message: status === 'connected' ? 'Already connected' : 'QR code not available yet',
            });
        }

        res.json({
            qr: qrCode,
            status,
        });
    } catch (error) {
        logger.error('[Admin/WhatsApp] Error getting QR code:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /whatsapp/sessions/:id
 * Delete a WhatsApp session
 */
router.delete('/sessions/:id', [
    param('id').notEmpty().withMessage('Session ID required'),
    handleValidationErrors,
], async (req, res) => {
    try {
        const providerManager = getProviderManager();
        if (!providerManager) {
            return res.status(503).json({ error: 'ProviderManager not available' });
        }

        const { id } = req.params;
        const provider = providerManager.getProvider(id);

        if (!provider) {
            return res.status(404).json({ error: `Session '${id}' not found` });
        }

        // Disconnect and remove
        await provider.disconnect?.();
        await providerManager.removeProvider(id);

        res.json({
            success: true,
            message: `Session '${id}' deleted`,
        });
    } catch (error) {
        logger.error('[Admin/WhatsApp] Error deleting session:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /whatsapp/sessions/:id/disconnect
 * Disconnect a WhatsApp session
 */
router.post('/sessions/:id/disconnect', [
    param('id').notEmpty().withMessage('Session ID required'),
    handleValidationErrors,
], async (req, res) => {
    try {
        const providerManager = getProviderManager();
        if (!providerManager) {
            return res.status(503).json({ error: 'ProviderManager not available' });
        }

        const { id } = req.params;
        const provider = providerManager.getProvider(id);

        if (!provider) {
            return res.status(404).json({ error: `Session '${id}' not found` });
        }

        await provider.disconnect?.();

        res.json({
            success: true,
            message: `Session '${id}' disconnected`,
        });
    } catch (error) {
        logger.error('[Admin/WhatsApp] Error disconnecting session:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /whatsapp/sessions/:id/reconnect
 * Reconnect a WhatsApp session
 */
router.post('/sessions/:id/reconnect', [
    param('id').notEmpty().withMessage('Session ID required'),
    handleValidationErrors,
], async (req, res) => {
    try {
        const providerManager = getProviderManager();
        if (!providerManager) {
            return res.status(503).json({ error: 'ProviderManager not available' });
        }

        const { id } = req.params;
        const provider = providerManager.getProvider(id);

        if (!provider) {
            return res.status(404).json({ error: `Session '${id}' not found` });
        }

        await provider.connect?.();

        res.json({
            success: true,
            message: `Session '${id}' reconnecting`,
        });
    } catch (error) {
        logger.error('[Admin/WhatsApp] Error reconnecting session:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
