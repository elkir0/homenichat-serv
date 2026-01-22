const express = require('express');
const router = express.Router();
const webPushService = require('../services/WebPushService');
const voipPushService = require('../services/VoIPPushService');
const fcmPushService = require('../services/FCMPushService');
const pushRelayService = require('../services/PushRelayService');
const homenichatCloudService = require('../services/HomenichatCloudService');
const { verifyToken } = require('../middleware/auth');

// Initialize push relay on module load
pushRelayService.initialize();

// Helper to check if we should use Homenichat Cloud for push
function useCloudPush() {
  return homenichatCloudService.isLoggedIn() && homenichatCloudService.services.push.enabled;
}

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
//
// SECURITY MODEL:
// When using Homenichat Cloud or Push Relay, the relay server extracts
// the userId from the Bearer token (hc_xxx), NOT from the request body.
// This prevents spoofing - devices can only be registered for the
// authenticated user's account.
//
// The req.user.id passed below is for API compatibility and local fallback,
// but is ignored by Cloud/Relay services which use token-based identification.
//

/**
 * POST /api/notifications/fcm-token
 * Enregistre un token FCM pour l'utilisateur (Android app)
 * Uses Homenichat Cloud if logged in, Push Relay if configured, or local FCM
 */
router.post('/fcm-token', verifyToken, async (req, res) => {
    console.log('[FCM] Token registration request from user:', req.user?.id, req.user?.username);
    try {
        const { token, platform, deviceId } = req.body;

        if (!token) {
            return res.status(400).json({ error: 'Token required' });
        }

        const actualDeviceId = deviceId || `device-${Date.now()}`;
        const actualPlatform = platform || 'android';

        // Use Homenichat Cloud if logged in (preferred)
        // Note: userId parameter is kept for API compatibility but ignored by relay
        if (useCloudPush()) {
            const result = await homenichatCloudService.registerDevice(
                req.user.id,  // Deprecated: relay uses token-based userId
                actualDeviceId,
                actualPlatform,
                token
            );
            return res.json({
                success: true,
                message: 'FCM token registered via Homenichat Cloud',
                cloud: true
            });
        }

        // Fallback to legacy Push Relay if configured
        // Note: userId parameter is kept for API compatibility but ignored by relay
        if (pushRelayService.isConfigured()) {
            const result = await pushRelayService.registerDevice(
                req.user.id,  // Deprecated: relay uses token-based userId
                actualDeviceId,
                actualPlatform,
                token
            );
            return res.json({
                success: true,
                message: 'FCM token registered via relay',
                relay: true
            });
        }

        // Fallback to local FCM service (deprecated, uses local storage)
        fcmPushService.registerDevice(
            req.user.id,  // Used for local Map storage
            token,
            actualDeviceId,
            actualPlatform
        );

        res.json({
            success: true,
            message: 'FCM token registered locally'
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

        // Use Homenichat Cloud if logged in (preferred)
        // Note: userId parameter is kept for API compatibility but ignored by relay
        if (useCloudPush()) {
            await homenichatCloudService.unregisterDevice(req.user.id, deviceId);  // userId ignored
            return res.json({ success: true, message: 'FCM token unregistered via Homenichat Cloud' });
        }

        // Fallback to legacy Push Relay if configured
        // Note: userId parameter is kept for API compatibility but ignored by relay
        if (pushRelayService.isConfigured()) {
            await pushRelayService.unregisterDevice(req.user.id, deviceId);  // userId ignored
            return res.json({ success: true, message: 'FCM token unregistered via relay' });
        }

        // Fallback to local FCM service (deprecated, uses local storage)
        fcmPushService.unregisterDevice(req.user.id, deviceId);  // Used for local Map
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
router.get('/fcm-status', verifyToken, async (req, res) => {
    try {
        // Check Homenichat Cloud first (preferred)
        if (useCloudPush()) {
            const cloudStatus = await homenichatCloudService.getStatus();
            return res.json({
                mode: 'cloud',
                loggedIn: cloudStatus.loggedIn,
                email: cloudStatus.email,
                pushEnabled: cloudStatus.services?.push?.enabled,
                tunnelEnabled: cloudStatus.services?.tunnel?.enabled,
                publicUrl: cloudStatus.publicUrl
            });
        }

        // Fallback to legacy Push Relay
        if (pushRelayService.isConfigured()) {
            const relayStatus = pushRelayService.getStatus();
            const stats = await pushRelayService.getStats();
            return res.json({
                mode: 'relay',
                ...relayStatus,
                stats
            });
        }

        // Fallback to local FCM status
        const status = fcmPushService.getStatus();
        res.json({
            mode: 'local',
            ...status
        });
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
        // Use Homenichat Cloud if logged in (preferred)
        if (useCloudPush()) {
            const result = await homenichatCloudService.sendPush(req.user.id, 'test', {
                timestamp: Date.now().toString()
            }, {
                title: 'Test Homenichat Cloud',
                body: 'Les notifications via Homenichat Cloud fonctionnent !'
            });
            return res.json({
                success: result.success,
                devicesSent: result.sent || 0,
                mode: 'cloud'
            });
        }

        // Fallback to legacy Push Relay if configured
        if (pushRelayService.isConfigured()) {
            const result = await pushRelayService.sendTest(req.user.id);
            return res.json({
                success: result.success,
                devicesSent: result.sent || 0,
                mode: 'relay'
            });
        }

        // Fallback to local FCM
        const result = await fcmPushService.sendToUser(req.user.id, {
            title: 'Test Homenichat',
            body: 'Les notifications FCM fonctionnent !'
        }, {
            type: 'test',
            timestamp: Date.now().toString()
        });

        res.json({
            success: true,
            devicesSent: result,
            mode: 'local'
        });

    } catch (error) {
        console.error('[FCM] Test push error:', error);
        res.status(500).json({ error: 'Failed to send test FCM push' });
    }
});

module.exports = router;
