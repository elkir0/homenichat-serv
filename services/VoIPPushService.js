/**
 * VoIPPushService - Service d'envoi de notifications VoIP Push iOS (APNs)
 *
 * Ce service est ADDITIONNEL et n'affecte pas la PWA.
 * Il permet de réveiller l'app iOS quand elle est fermée.
 *
 * Prérequis pour production:
 * - Certificat APNs VoIP (.p8) depuis Apple Developer Portal
 * - Variables d'environnement: APN_KEY_PATH, APN_KEY_ID, APN_TEAM_ID, APN_BUNDLE_ID
 *
 * @module VoIPPushService
 */

const logger = require('winston');
const db = require('./DatabaseService');

class VoIPPushService {
    constructor() {
        if (VoIPPushService.instance) {
            return VoIPPushService.instance;
        }

        this.isConfigured = false;
        this.provider = null;

        // Vérifier si APNs est configuré
        this.config = {
            keyPath: process.env.APN_KEY_PATH,
            keyId: process.env.APN_KEY_ID,
            teamId: process.env.APN_TEAM_ID,
            bundleId: process.env.APN_BUNDLE_ID || 'fr.shathony.lekipchat',
            production: process.env.NODE_ENV === 'production'
        };

        this.initialize();
        VoIPPushService.instance = this;
    }

    /**
     * Initialise le provider APNs si configuré
     */
    initialize() {
        if (this.config.keyPath && this.config.keyId && this.config.teamId) {
            try {
                // Lazy load @parse/node-apn seulement si configuré
                const apn = require('@parse/node-apn');

                this.provider = new apn.Provider({
                    token: {
                        key: this.config.keyPath,
                        keyId: this.config.keyId,
                        teamId: this.config.teamId
                    },
                    production: this.config.production
                });

                this.isConfigured = true;
                logger.info('[VoIPPush] APNs provider initialized successfully');
            } catch (error) {
                logger.warn('[VoIPPush] APNs not configured or @parse/node-apn not installed:', error.message);
                this.isConfigured = false;
            }
        } else {
            logger.info('[VoIPPush] APNs not configured - VoIP push disabled (PWA continues to work normally)');
            this.isConfigured = false;
        }
    }

    /**
     * Enregistre un token VoIP pour un utilisateur
     * @param {number} userId - ID utilisateur
     * @param {string} token - Token APNs VoIP
     * @param {object} metadata - Infos device optionnelles
     */
    async registerToken(userId, token, metadata = {}) {
        try {
            const result = db.registerVoIPToken(userId, token, metadata);
            logger.info(`[VoIPPush] Token registered for user ${userId}`);
            return { success: true, ...result };
        } catch (error) {
            logger.error('[VoIPPush] Failed to register token:', error);
            throw error;
        }
    }

    /**
     * Désenregistre un token VoIP
     * @param {string} token - Token à supprimer
     */
    async unregisterToken(token) {
        try {
            const removed = db.unregisterVoIPToken(token);
            logger.info(`[VoIPPush] Token unregistered: ${removed}`);
            return { success: removed };
        } catch (error) {
            logger.error('[VoIPPush] Failed to unregister token:', error);
            throw error;
        }
    }

    /**
     * Envoie une notification VoIP push pour un appel entrant
     * Broadcast à tous les devices iOS enregistrés
     *
     * @param {object} callData - Données de l'appel
     * @param {string} callData.callId - ID unique de l'appel
     * @param {string} callData.callerNumber - Numéro appelant
     * @param {string} callData.callerName - Nom appelant (si connu)
     * @param {string} callData.lineName - Nom de la ligne (Chiro/Osteo)
     */
    async sendIncomingCallPush(callData) {
        const tokens = db.getAllVoIPTokens();

        if (tokens.length === 0) {
            logger.debug('[VoIPPush] No iOS devices registered for VoIP push');
            return { sent: 0, failed: 0 };
        }

        logger.info(`[VoIPPush] Sending incoming call push to ${tokens.length} iOS device(s)`);

        if (!this.isConfigured) {
            // Mode simulation (dev/test) - log ce qu'on enverrait
            logger.info('[VoIPPush] [SIMULATION] Would send to devices:', tokens.map(t => t.token.substring(0, 20) + '...'));
            logger.info('[VoIPPush] [SIMULATION] Payload:', JSON.stringify(callData));
            return { sent: 0, failed: 0, simulated: tokens.length };
        }

        // Production - envoi réel via APNs
        const results = { sent: 0, failed: 0, errors: [] };

        for (const tokenRecord of tokens) {
            try {
                const notification = this.createVoIPNotification(callData);
                const result = await this.provider.send(notification, tokenRecord.token);

                if (result.sent.length > 0) {
                    results.sent++;
                    db.touchVoIPToken(tokenRecord.token);
                } else {
                    results.failed++;
                    // Si token invalide, le supprimer
                    if (result.failed.length > 0) {
                        const failure = result.failed[0];
                        if (failure.response && failure.response.reason === 'BadDeviceToken') {
                            logger.warn(`[VoIPPush] Removing invalid token for user ${tokenRecord.user_id}`);
                            db.unregisterVoIPToken(tokenRecord.token);
                        }
                        results.errors.push({
                            token: tokenRecord.token.substring(0, 20) + '...',
                            reason: failure.response?.reason || 'Unknown'
                        });
                    }
                }
            } catch (error) {
                results.failed++;
                results.errors.push({
                    token: tokenRecord.token.substring(0, 20) + '...',
                    reason: error.message
                });
                logger.error(`[VoIPPush] Failed to send to device:`, error.message);
            }
        }

        logger.info(`[VoIPPush] Push complete: ${results.sent} sent, ${results.failed} failed`);
        return results;
    }

    /**
     * Crée une notification APNs VoIP
     * @param {object} callData - Données de l'appel
     * @returns {object} Notification APNs
     */
    createVoIPNotification(callData) {
        const apn = require('@parse/node-apn');

        const notification = new apn.Notification();

        // VoIP push utilise un topic spécifique
        notification.topic = `${this.config.bundleId}.voip`;

        // Payload pour réveiller l'app et afficher CallKit
        notification.payload = {
            callId: callData.callId || `call-${Date.now()}`,
            callerNumber: callData.callerNumber || callData.caller_number,
            callerName: callData.callerName || callData.caller_name || 'Inconnu',
            lineName: callData.lineName || callData.line_name || null,
            timestamp: Date.now(),
            // Flag pour indiquer que c'est un appel entrant
            type: 'incoming_call'
        };

        // VoIP push expire rapidement (30 secondes)
        notification.expiry = Math.floor(Date.now() / 1000) + 30;

        // Priorité haute pour VoIP
        notification.priority = 10;

        // Push type pour iOS 13+
        notification.pushType = 'voip';

        return notification;
    }

    /**
     * Envoie une notification de fin d'appel
     * @param {string} callId - ID de l'appel terminé
     * @param {string} status - Statut final (answered, missed, rejected)
     */
    async sendCallEndedPush(callId, status) {
        const tokens = db.getAllVoIPTokens();

        if (tokens.length === 0 || !this.isConfigured) {
            return { sent: 0, failed: 0 };
        }

        // Note: Les notifications de fin d'appel sont moins critiques
        // On peut utiliser une notification standard au lieu de VoIP
        logger.debug(`[VoIPPush] Call ended notification: ${callId} - ${status}`);

        return { sent: 0, failed: 0 };
    }

    /**
     * Retourne l'état de configuration du service
     */
    getStatus() {
        return {
            configured: this.isConfigured,
            bundleId: this.config.bundleId,
            production: this.config.production,
            registeredDevices: db.getAllVoIPTokens().length
        };
    }

    /**
     * Nettoie les tokens inactifs
     * @param {number} daysInactive - Jours d'inactivité
     */
    async cleanupStaleTokens(daysInactive = 30) {
        const removed = db.cleanupStaleVoIPTokens(daysInactive);
        return { removed };
    }

    /**
     * Ferme proprement le provider APNs
     */
    shutdown() {
        if (this.provider) {
            this.provider.shutdown();
            logger.info('[VoIPPush] APNs provider shut down');
        }
    }
}

// Singleton
module.exports = new VoIPPushService();
