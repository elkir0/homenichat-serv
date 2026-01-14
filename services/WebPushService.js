const webpush = require('web-push');
const logger = require('../utils/logger');
const db = require('./DatabaseService');

// Clés VAPID pour Web Push
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BLn2An3uQ5NyEbgPEvR5nsLlLz2mCi5dyhUVx3iMBXUixzb_Bqf7PTknxYZtHubyPDsFaxO6ZlbpA6K0E4TOcZw';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '_KEiC6l_ztAgCXrSEhwXDmujjPOEIIRIIsJhSPzDwCc';
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:admin@shathony.fr';

class WebPushService {
    constructor() {
        this.subscriptions = new Map(); // userId -> [subscriptions]
        this.initialized = false;
    }

    /**
     * Initialise le service
     */
    init() {
        if (this.initialized) return;

        // Configurer web-push
        webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

        // Créer la table si elle n'existe pas
        db.exec(`
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                endpoint TEXT UNIQUE NOT NULL,
                keys_p256dh TEXT NOT NULL,
                keys_auth TEXT NOT NULL,
                user_agent TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_used DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Charger les subscriptions existantes
        this.loadSubscriptions();

        this.initialized = true;
        logger.info('WebPushService initialized');
    }

    /**
     * Charge les subscriptions depuis la DB
     */
    loadSubscriptions() {
        try {
            const rows = db.prepare('SELECT * FROM push_subscriptions').all();
            for (const row of rows) {
                const userId = row.user_id;
                if (!this.subscriptions.has(userId)) {
                    this.subscriptions.set(userId, []);
                }
                this.subscriptions.get(userId).push({
                    endpoint: row.endpoint,
                    keys: {
                        p256dh: row.keys_p256dh,
                        auth: row.keys_auth
                    }
                });
            }
            logger.info(`Loaded ${rows.length} push subscriptions`);
        } catch (error) {
            logger.error('Failed to load push subscriptions:', error);
        }
    }

    /**
     * Retourne la clé publique VAPID
     */
    getPublicKey() {
        return VAPID_PUBLIC_KEY;
    }

    /**
     * Enregistre une nouvelle subscription
     */
    subscribe(userId, subscription, userAgent = null) {
        try {
            // Sauvegarder en DB
            const stmt = db.prepare(`
                INSERT OR REPLACE INTO push_subscriptions
                (user_id, endpoint, keys_p256dh, keys_auth, user_agent)
                VALUES (?, ?, ?, ?, ?)
            `);

            stmt.run(
                userId,
                subscription.endpoint,
                subscription.keys.p256dh,
                subscription.keys.auth,
                userAgent
            );

            // Mettre à jour le cache
            if (!this.subscriptions.has(userId)) {
                this.subscriptions.set(userId, []);
            }

            // Éviter les doublons dans le cache
            const existing = this.subscriptions.get(userId);
            const idx = existing.findIndex(s => s.endpoint === subscription.endpoint);
            if (idx >= 0) {
                existing[idx] = subscription;
            } else {
                existing.push(subscription);
            }

            logger.info(`Push subscription added for user ${userId}`);
            return { success: true };

        } catch (error) {
            logger.error('Failed to save push subscription:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Supprime une subscription
     */
    unsubscribe(endpoint) {
        try {
            db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);

            // Retirer du cache
            for (const [userId, subs] of this.subscriptions) {
                const idx = subs.findIndex(s => s.endpoint === endpoint);
                if (idx >= 0) {
                    subs.splice(idx, 1);
                    break;
                }
            }

            logger.info('Push subscription removed');
            return { success: true };

        } catch (error) {
            logger.error('Failed to remove push subscription:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Envoie une notification push à tous les appareils d'un utilisateur
     */
    async sendToUser(userId, payload) {
        const userSubs = this.subscriptions.get(userId) || [];

        if (userSubs.length === 0) {
            return { sent: 0, failed: 0 };
        }

        const payloadString = JSON.stringify(payload);
        let sent = 0;
        let failed = 0;

        for (const subscription of userSubs) {
            try {
                await webpush.sendNotification(subscription, payloadString);
                sent++;

                // Mettre à jour last_used
                db.prepare('UPDATE push_subscriptions SET last_used = CURRENT_TIMESTAMP WHERE endpoint = ?')
                    .run(subscription.endpoint);

            } catch (error) {
                failed++;
                logger.warn(`Push notification failed: ${error.message}`);

                // Si subscription invalide (410 Gone), la supprimer
                if (error.statusCode === 410 || error.statusCode === 404) {
                    this.unsubscribe(subscription.endpoint);
                }
            }
        }

        return { sent, failed };
    }

    /**
     * Envoie une notification à tous les utilisateurs
     */
    async broadcast(payload) {
        let totalSent = 0;
        let totalFailed = 0;

        for (const userId of this.subscriptions.keys()) {
            const result = await this.sendToUser(userId, payload);
            totalSent += result.sent;
            totalFailed += result.failed;
        }

        logger.info(`Push broadcast: ${totalSent} sent, ${totalFailed} failed`);
        return { sent: totalSent, failed: totalFailed };
    }

    /**
     * Envoie une notification de nouveau message
     */
    async notifyNewMessage(chatName, messageContent, chatId, isFromMe = false) {
        // Ne pas notifier nos propres messages
        if (isFromMe) return;

        const payload = {
            title: chatName || 'Nouveau message',
            body: messageContent?.substring(0, 100) || 'Nouveau message reçu',
            icon: '/logo-192.png',
            badge: '/logo-192.png',
            tag: `chat-${chatId}`,
            data: {
                chatId: chatId,
                url: `/?chat=${chatId}`
            },
            actions: [
                { action: 'open', title: 'Ouvrir' },
                { action: 'close', title: 'Fermer' }
            ]
        };

        return await this.broadcast(payload);
    }

    /**
     * Envoie une notification d'appel entrant (haute priorité)
     */
    async notifyIncomingCall(callData) {
        const callerDisplay = callData.callerName || callData.callerNumber || 'Numéro inconnu';
        const lineInfo = callData.lineName ? ` (${callData.lineName})` : '';

        const payload = {
            title: '📞 Appel entrant',
            body: `${callerDisplay}${lineInfo}`,
            icon: '/logo-192.png',
            badge: '/logo-192.png',
            tag: `incoming-call-${callData.callId}`,
            requireInteraction: true, // Ne pas disparaître automatiquement
            renotify: true, // Toujours notifier même si même tag
            vibrate: [200, 100, 200, 100, 200, 100, 200], // Pattern vibration longue
            data: {
                type: 'incoming_call',
                callId: callData.callId,
                callerNumber: callData.callerNumber,
                callerName: callData.callerName,
                lineName: callData.lineName,
                extension: callData.extension,
                timestamp: callData.startTime,
                url: `/?incoming=${callData.callId}`
            },
            actions: [
                { action: 'answer', title: '✅ Répondre' },
                { action: 'reject', title: '❌ Refuser' }
            ]
        };

        logger.info(`[WebPush] Sending incoming call notification: ${callerDisplay}`);
        return await this.broadcast(payload);
    }

    /**
     * Envoie une notification de fin d'appel (pour arrêter la sonnerie)
     */
    async notifyCallEnded(callId, status) {
        const payload = {
            title: status === 'answered' ? 'Appel en cours' : 'Appel manqué',
            body: status === 'answered' ? 'L\'appel a été pris' : 'L\'appel n\'a pas été répondu',
            icon: '/logo-192.png',
            tag: `incoming-call-${callId}`, // Même tag pour remplacer la notification
            silent: true, // Pas de son
            data: {
                type: 'call_ended',
                callId: callId,
                status: status
            }
        };

        return await this.broadcast(payload);
    }
}

// Singleton
module.exports = new WebPushService();
