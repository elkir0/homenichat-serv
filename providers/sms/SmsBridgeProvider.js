const WhatsAppProvider = require('../base/WhatsAppProvider');
const axios = require('axios');
const logger = require('../../utils/logger');
const https = require('https');
const chatStorage = require('../../services/ChatStorageServicePersistent');

/**
 * Provider SMS Bridge - Connexion aux Trunks SIP via VM locale
 * Adapte l'API REST de la VM SMS (Python) à l'interface WhatsAppProvider
 */
class SmsBridgeProvider extends WhatsAppProvider {
    constructor(config = {}) {
        super(config);
        this.apiUrl = config.apiUrl || '';
        this.apiToken = config.apiToken || '';
        this.syncIntervalMs = config.syncIntervalMs || 5000;
        this.maxSyncIntervalMs = config.maxSyncIntervalMs || 60000; // Max 1 minute between polls on error

        this.connectionState = 'disconnected';
        this.pollingInterval = null;

        // Error tracking for exponential backoff
        this.consecutiveErrors = 0;
        this.lastErrorMessage = null;
        this.currentBackoffMs = this.syncIntervalMs;
        this.maxConsecutiveErrorLogs = 3; // Only log first N consecutive errors

        // Client Axios avec SSL auto-signé supporté
        this.client = axios.create({
            baseURL: this.apiUrl,
            timeout: 10000,
            headers: {
                'Authorization': `Bearer ${this.apiToken}`,
                'Content-Type': 'application/json'
            },
            httpsAgent: new https.Agent({
                rejectUnauthorized: false
            })
        });
    }

    getProviderName() {
        return 'sms-bridge';
    }

    async initialize() {
        try {
            logger.info('Initializing SMS Bridge provider...');
            await this.testConnection();

            this.connectionState = 'connected';
            this.emit('connection.update', { status: 'connected' });

            // Synchroniser l'historique complet au démarrage
            await this.syncFullHistory();

            // Démarrer le polling pour les nouveaux messages
            this.startPolling();

            return true;
        } catch (error) {
            logger.error('Failed to initialize SMS Bridge:', error.message);
            this.connectionState = 'disconnected';
            this.emit('connection.update', { status: 'disconnected', error: error.message });
            throw error;
        }
    }

    /**
     * Synchronise l'historique complet des SMS depuis l'API
     */
    async syncFullHistory() {
        try {
            logger.info('📥 Starting full SMS history sync...');

            const response = await this.client.get('/api/pwa/conversations');
            const conversations = response.data;

            let totalMessages = 0;
            let totalConversations = 0;

            for (const conv of conversations) {
                // Sauvegarder le chat
                const chatData = this.normalizeChat(conv);
                chatStorage.updateChat(chatData);
                totalConversations++;

                // Récupérer TOUS les messages de cette conversation
                // L'API peut avoir un paramètre limit ou all=true
                try {
                    const msgResponse = await this.client.get(`/api/pwa/conversations/${conv.id}`, {
                        params: { limit: 10000 } // Demander un grand nombre pour tout récupérer
                    });
                    const messages = msgResponse.data.messages || [];

                    let lastMessageContent = null;
                    let lastMessageTimestamp = 0;

                    for (const msg of messages) {
                        const messageData = this.normalizeMessage(msg, chatData.id);
                        chatStorage.storeMessage(messageData);
                        totalMessages++;

                        if (messageData.timestamp > lastMessageTimestamp) {
                            lastMessageTimestamp = messageData.timestamp;
                            lastMessageContent = messageData.content;
                        }
                    }

                    // Mettre à jour le lastMessage du chat
                    if (lastMessageContent) {
                        chatData.lastMessage = lastMessageContent;
                        chatData.timestamp = lastMessageTimestamp;
                        chatStorage.updateChat(chatData);
                    }

                } catch (msgError) {
                    logger.warn(`Failed to sync messages for conversation ${conv.id}:`, msgError.message);
                }
            }

            logger.info(`📥 SMS history sync complete: ${totalConversations} conversations, ${totalMessages} messages`);

        } catch (error) {
            logger.error('Failed to sync full SMS history:', error.message);
        }
    }

    async testConnection() {
        try {
            const response = await this.client.get('/health');
            if (response.status === 200) {
                logger.info('SMS Bridge connection test success');
                return { success: true, message: 'Connected to SMS Bridge' };
            }
            throw new Error(`Unexpected status code: ${response.status}`);
        } catch (error) {
            logger.error('SMS Bridge connection test failed:', error.message);
            throw error;
        }
    }

    // --- Polling (Sync DB) ---

    startPolling() {
        if (this.pollingInterval) clearInterval(this.pollingInterval);

        logger.info(`Starting SMS Bridge polling every ${this.syncIntervalMs}ms`);

        // Reset backoff state
        this.consecutiveErrors = 0;
        this.currentBackoffMs = this.syncIntervalMs;

        // Premier sync immédiat
        this.checkForNewMessages();

        // Use dynamic interval via setTimeout for backoff support
        this.scheduleNextPoll();
    }

    scheduleNextPoll() {
        if (this.pollingTimeout) clearTimeout(this.pollingTimeout);

        this.pollingTimeout = setTimeout(async () => {
            await this.checkForNewMessages();
            this.scheduleNextPoll();
        }, this.currentBackoffMs);
    }

    stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
        if (this.pollingTimeout) {
            clearTimeout(this.pollingTimeout);
            this.pollingTimeout = null;
        }
    }

    async checkForNewMessages() {
        try {
            // 1. Récupérer les conversations modifiées
            // L'API Bridge actuelle renvoie toutes les conversations triées par date
            const response = await this.client.get('/api/pwa/conversations');
            const conversations = response.data;

            for (const conv of conversations) {
                // Normaliser et sauvegarder le chat
                const chatData = this.normalizeChat(conv);
                chatStorage.updateChat(chatData);

                // 2. Vérifier si on a besoin de sync les messages
                // On pourrait optimiser en regardant le timestamp local vs distant
                // Pour l'instant on sync les 20 derniers messages à chaque poll (optimisable)
                await this.syncMessagesForChat(conv.id, chatData.id);
            }

            // Success: reset backoff
            if (this.consecutiveErrors > 0) {
                logger.info('SMS Bridge connection restored');
            }
            this.consecutiveErrors = 0;
            this.lastErrorMessage = null;
            this.currentBackoffMs = this.syncIntervalMs;

        } catch (error) {
            this.consecutiveErrors++;

            // Only log first few consecutive errors, then suppress
            const isSameError = this.lastErrorMessage === error.message;
            if (this.consecutiveErrors <= this.maxConsecutiveErrorLogs || !isSameError) {
                logger.warn(`SMS Polling Error (attempt ${this.consecutiveErrors}): ${error.message}`);
                if (this.consecutiveErrors === this.maxConsecutiveErrorLogs) {
                    logger.warn('SMS Bridge: Suppressing repeated error logs. Will notify when connection is restored.');
                }
            }
            this.lastErrorMessage = error.message;

            // Exponential backoff: double the interval on each error, up to max
            this.currentBackoffMs = Math.min(
                this.currentBackoffMs * 2,
                this.maxSyncIntervalMs
            );
        }
    }

    async syncMessagesForChat(apiChatId, localChatId) {
        try {
            const response = await this.client.get(`/api/pwa/conversations/${apiChatId}`);
            const messages = response.data.messages || [];

            let lastMessageContent = null;
            let lastMessageTimestamp = 0;

            for (const msg of messages) {
                const messageData = this.normalizeMessage(msg, localChatId);

                // Vérifier si le message existe déjà pour éviter le spam d'événements (fix clignotement)
                const alreadyExists = chatStorage.messageExists(messageData.id);

                chatStorage.storeMessage(messageData);

                // Suivre le dernier message pour mise à jour chat
                if (messageData.timestamp > lastMessageTimestamp) {
                    lastMessageTimestamp = messageData.timestamp;
                    lastMessageContent = messageData.content;
                }

                // Emettre seulement si c'est un NOUVEAU message (entrant ou sortant)
                if (!alreadyExists) {
                    this.emit('message', messageData);
                }
            }

            // Mettre à jour le dernier message du chat si trouvé
            if (lastMessageContent) {
                const chat = chatStorage.getChat(localChatId);
                if (chat) {
                    chat.lastMessage = lastMessageContent;
                    chat.timestamp = lastMessageTimestamp; // Sync timestamp aussi
                    chatStorage.updateChat(chat);
                }
            }

        } catch (error) {
            logger.warn(`Failed to sync messages for chat ${localChatId}:`, error.message);
        }
    }

    // --- Méthodes Métier (Lectures depuis DB) ---

    async getChats() {
        // Lecture locale (rapide)
        const chats = await chatStorage.getChats();
        // Filtrer uniquement les SMS
        return chats.filter(c => c.provider === 'sms').map(c => ({
            ...c,
            source: 'sms'
        }));
    }

    async getMessages(chatId, limit = 50) {
        // Lecture locale
        return await chatStorage.getMessages(1, chatId, limit);
    }

    async sendTextMessage(to, text, options = {}) {
        try {
            let cleanTo = to;
            // Retirer le suffixe WhatsApp si présent
            if (typeof cleanTo === 'string') {
                cleanTo = cleanTo.replace('@s.whatsapp.net', '').replace('@g.us', '');
            }

            // Si c'est un ID de chat interne (ex: sms_2), on doit récupérer le vrai numéro
            if (cleanTo.startsWith('sms_')) {
                const internalId = cleanTo.replace('sms_', '');
                logger.info(`Resolving SMS ID ${cleanTo} (${internalId}) to phone number...`);

                try {
                    // On récupère la liste des conversations pour trouver le numéro
                    // Idéalement on aurait un endpoint /api/pwa/conversations/:id/meta mais on utilise la liste pour l'instant
                    const response = await this.client.get('/api/pwa/conversations');
                    const conv = response.data.find(c => c.id == internalId);

                    if (conv) {
                        // Priorité au numéro explcite
                        const realNumber = conv.phone_number || conv.recipient_number || conv.contact_name; // Fallback name si c'est un numéro
                        if (realNumber && /^\+?\d+$/.test(realNumber)) {
                            cleanTo = realNumber;
                            logger.info(`Resolved ${to} to ${cleanTo}`);
                        } else {
                            logger.warn(`Found conversation ${internalId} but could not extract valid phone number: ${JSON.stringify(conv)}`);
                        }
                    } else {
                        logger.warn(`Conversation ${internalId} not found in bridge list`);
                    }
                } catch (resolveError) {
                    logger.error(`Failed to resolve SMS ID ${cleanTo}:`, resolveError);
                }
            }

            const payload = {
                to: cleanTo,
                content: text,
                line: options?.line || 'chiro'
            };

            const response = await this.client.post('/api/pwa/send', payload);

            if (response.data.success) {
                // Sauvegarder le message envoyé en DB locale tout de suite
                const messageId = `sms_msg_${response.data.message_id || Date.now()}`;
                // Utiliser l'ID de conversation renvoyé ou garder celui d'origine si on a envoyé à un numéro
                // Si on a envoyé à 'sms_2', on veut garder 'sms_2' comme chatId pour l'UI
                const conversationId = response.data.conversation_id ? `sms_${response.data.conversation_id}` : (to.startsWith('sms_') ? to : `sms_${cleanTo}`);

                const messageData = {
                    id: messageId,
                    chatId: conversationId,
                    from: 'me',
                    to: cleanTo,
                    content: text,
                    timestamp: Date.now() / 1000,
                    fromMe: true,
                    status: 'sent',
                    type: 'text'
                };

                chatStorage.storeMessage(messageData);

                // Émettre l'événement pour la mise à jour en temps réel (WebSocket)
                this.emit('message', messageData);

                return {
                    success: true,
                    messageId: messageId,
                    conversationId: conversationId
                };
            }
            throw new Error('API returned success: false');
        } catch (error) {
            logger.error('Error sending SMS:', error.message);
            return { success: false, error: error.message };
        }
    }

    // --- Normalisation ---

    normalizeChat(rawChat) {
        return {
            id: `sms_${rawChat.id}`,
            name: rawChat.contact_name || rawChat.phone_number,
            unreadCount: rawChat.unread_count,
            timestamp: new Date(rawChat.last_message_at).getTime() / 1000,
            profilePicture: null,
            provider: 'sms',
            lastMessage: 'SMS', // Placeholder
            // Essayer de récupérer le numéro local (trunk)
            // Priorité : trunk_number > line > local_number > recipient_number
            localPhoneNumber: rawChat.trunk_number
                ? `${rawChat.line ? rawChat.line + ' - ' : ''}${rawChat.trunk_number}`
                : (rawChat.line || rawChat.local_number || rawChat.recipient_number || null)
        };
    }

    async markChatAsRead(chatId) {
        try {
            // Extraire l'ID numérique de l'ID interne (ex: 'sms_123' -> 123)
            const numericId = chatId.replace('sms_', '');

            // Appel API pour marquer comme lu sur le serveur SMS
            try {
                await this.client.post(`/api/pwa/conversations/${numericId}/read`);
            } catch (apiError) {
                logger.warn(`API SMS Bridge read failed for ${chatId}:`, apiError.message);
                // On continue quand même pour la mise à jour locale
            }

            // Mise à jour locale
            const chat = chatStorage.getChat(chatId);
            if (chat) {
                chat.unreadCount = 0;
                chatStorage.updateChat(chat);

                // Notifier via WebSocket que c'est lu pour mettre à jour l'UI des autres clients
                const eventData = {
                    chatId: chatId,
                    unreadCount: 0
                };
            }

            return { success: true };
        } catch (error) {
            logger.warn(`Failed to mark chat ${chatId} as read:`, error.message);
            // On renvoie quand même success true pour ne pas bloquer l'UI
            return { success: true, warning: error.message };
        }
    }

    normalizeMessage(rawMsg, chatId) {
        const isFromMe = rawMsg.direction === 'outgoing';
        return {
            id: `sms_msg_${rawMsg.id}`,
            chatId: chatId,
            fromMe: isFromMe,
            content: rawMsg.content,
            timestamp: new Date(rawMsg.created_at).getTime() / 1000,
            type: 'text',
            status: this.mapStatus(rawMsg.status),
            mediaUrl: null
        };
    }

    mapStatus(smsStatus) {
        if (smsStatus === 'sent') return 'sent';
        if (smsStatus === 'delivered') return 'delivered';
        if (smsStatus === 'failed') return 'failed';
        return 'pending';
    }

    // --- Stubs ---
    async logout() {
        this.stopPolling();
        this.connectionState = 'disconnected';
        return { success: true };
    }

    async getConnectionState() {
        return { state: this.connectionState };
    }

    async getQRCode() { return null; }
    async checkNumberExists() { return { exists: true }; }
}

module.exports = SmsBridgeProvider;
