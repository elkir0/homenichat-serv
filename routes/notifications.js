const express = require('express');
const router = express.Router();
const webPushService = require('../services/WebPushService');
const voipPushService = require('../services/VoIPPushService');
const fcmPushService = require('../services/FCMPushService');
const { verifyToken } = require('../middleware/auth');

/**
 * GET /api/notifications/vapid-public-key
 * Retourne la clé publique VAPID pour le frontend
 */
router.get('/vapid-public-key', (req, res) => {
    res.json({ publicKey: webPushService.getPublicKey() });
});

/**
 * POST /api/notifications/subscribe
 * Enregistre une subscription push pour l'utilisateur authentifié
 */
router.post('/subscribe', verifyToken, (req, res) => {
    console.log('📱 Push subscribe request from user:', req.user?.id, req.user?.username);
    try {
        const { subscription, deviceInfo } = req.body;
        console.log('📱 Subscription endpoint:', subscription?.endpoint?.substring(0, 50) + '...');

        if (!subscription || !subscription.endpoint || !subscription.keys) {
            console.log('📱 Invalid subscription data received');
            return res.status(400).json({ error: 'Invalid subscription data' });
        }

        const result = webPushService.subscribe(
            req.user.id,
            subscription,
            deviceInfo?.userAgent
        );

        if (result.success) {
            res.json({ success: true, message: 'Subscription saved' });
        } else {
            res.status(500).json({ error: result.error });
        }

    } catch (error) {
        console.error('Subscribe error:', error);
        res.status(500).json({ error: 'Failed to save subscription' });
    }
});

/**
 * POST /api/notifications/unsubscribe
 * Supprime une subscription
 */
router.post('/unsubscribe', verifyToken, (req, res) => {
    try {
        const { endpoint } = req.body;

        if (!endpoint) {
            return res.status(400).json({ error: 'Endpoint required' });
        }

        const result = webPushService.unsubscribe(endpoint);
        res.json(result);

    } catch (error) {
        console.error('Unsubscribe error:', error);
        res.status(500).json({ error: 'Failed to unsubscribe' });
    }
});

/**
 * POST /api/notifications/test
 * Envoie une notification de test à l'utilisateur
 */
router.post('/test', verifyToken, async (req, res) => {
    try {
        const result = await webPushService.sendToUser(req.user.id, {
            title: "Test L'ekip-Chat",
            body: 'Les notifications push fonctionnent !',
            icon: '/logo-192.png',
            badge: '/logo-192.png'
        });

        res.json({
            success: true,
            sent: result.sent,
            failed: result.failed
        });

    } catch (error) {
        console.error('Test notification error:', error);
        res.status(500).json({ error: 'Failed to send test notification' });
    }
});

// =====================================================
// VoIP Push (iOS APNs) - ADDITIVE endpoints
// These do NOT affect existing PWA push functionality
// =====================================================

/**
 * POST /api/notifications/voip-token
 * Enregistre un token VoIP APNs pour l'utilisateur (iOS app)
 */
router.post('/voip-token', verifyToken, async (req, res) => {
    console.log('📱 [VoIP] Token registration request from user:', req.user?.id, req.user?.username);
    try {
        const { token, platform, deviceId, appVersion } = req.body;

        if (!token) {
            return res.status(400).json({ error: 'Token required' });
        }

        const result = await voipPushService.registerToken(req.user.id, token, {
            platform: platform || 'ios',
            deviceId,
            appVersion
        });

        res.json({
            success: true,
            message: 'VoIP token registered',
            ...result
        });

    } catch (error) {
        console.error('[VoIP] Token registration error:', error);
        res.status(500).json({ error: 'Failed to register VoIP token' });
    }
});

/**
 * DELETE /api/notifications/voip-token
 * Supprime un token VoIP (déconnexion iOS app)
 */
router.delete('/voip-token', verifyToken, async (req, res) => {
    try {
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({ error: 'Token required' });
        }

        const result = await voipPushService.unregisterToken(token);
        res.json(result);

    } catch (error) {
        console.error('[VoIP] Token unregistration error:', error);
        res.status(500).json({ error: 'Failed to unregister VoIP token' });
    }
});

/**
 * GET /api/notifications/voip-status
 * Retourne l'état du service VoIP Push
 */
router.get('/voip-status', verifyToken, (req, res) => {
    try {
        const status = voipPushService.getStatus();
        res.json(status);
    } catch (error) {
        console.error('[VoIP] Status error:', error);
        res.status(500).json({ error: 'Failed to get VoIP status' });
    }
});

/**
 * POST /api/notifications/voip-test
 * Test d'envoi VoIP push (dev/admin only)
 */
router.post('/voip-test', verifyToken, async (req, res) => {
    try {
        // Simuler un appel entrant pour test
        const testCallData = {
            callId: `test-${Date.now()}`,
            callerNumber: '0596 00 00 00',
            callerName: 'Test VoIP Push',
            lineName: 'Test'
        };

        const result = await voipPushService.sendIncomingCallPush(testCallData);

        res.json({
            success: true,
            testCallData,
            result
        });

    } catch (error) {
        console.error('[VoIP] Test push error:', error);
        res.status(500).json({ error: 'Failed to send test VoIP push' });
    }
});

// =====================================================
// FCM Push (Android Firebase Cloud Messaging)
// =====================================================

/**
 * POST /api/notifications/fcm-token
 * Enregistre un token FCM pour l'utilisateur (Android app)
 */
router.post('/fcm-token', verifyToken, async (req, res) => {
    console.log('[FCM] Token registration request from user:', req.user?.id, req.user?.username);
    try {
        const { token, platform, deviceId } = req.body;

        if (!token) {
            return res.status(400).json({ error: 'Token required' });
        }

        fcmPushService.registerDevice(
            req.user.id,
            token,
            deviceId || `device-${Date.now()}`,
            platform || 'android'
        );

        res.json({
            success: true,
            message: 'FCM token registered'
        });

    } catch (error) {
        console.error('[FCM] Token registration error:', error);
        res.status(500).json({ error: 'Failed to register FCM token' });
    }
});

/**
 * DELETE /api/notifications/fcm-token
 * Supprime un token FCM (deconnexion Android app)
 */
router.delete('/fcm-token', verifyToken, async (req, res) => {
    try {
        const { deviceId } = req.body;

        if (!deviceId) {
            return res.status(400).json({ error: 'Device ID required' });
        }

        fcmPushService.unregisterDevice(req.user.id, deviceId);
        res.json({ success: true, message: 'FCM token unregistered' });

    } catch (error) {
        console.error('[FCM] Token unregistration error:', error);
        res.status(500).json({ error: 'Failed to unregister FCM token' });
    }
});

/**
 * GET /api/notifications/fcm-status
 * Retourne l'etat du service FCM Push
 */
router.get('/fcm-status', verifyToken, (req, res) => {
    try {
        const status = fcmPushService.getStatus();
        res.json(status);
    } catch (error) {
        console.error('[FCM] Status error:', error);
        res.status(500).json({ error: 'Failed to get FCM status' });
    }
});

/**
 * POST /api/notifications/fcm-test
 * Test d'envoi FCM push
 */
router.post('/fcm-test', verifyToken, async (req, res) => {
    try {
        const result = await fcmPushService.sendToUser(req.user.id, {
            title: 'Test Homenichat',
            body: 'Les notifications FCM fonctionnent !'
        }, {
            type: 'test',
            timestamp: Date.now().toString()
        });

        res.json({
            success: true,
            devicesSent: result
        });

    } catch (error) {
        console.error('[FCM] Test push error:', error);
        res.status(500).json({ error: 'Failed to send test FCM push' });
    }
});

module.exports = router;
