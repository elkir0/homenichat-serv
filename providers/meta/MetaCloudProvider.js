const WhatsAppProvider = require('../base/WhatsAppProvider');
const axios = require('axios');
const logger = require('winston');
const crypto = require('crypto');
const FormData = require('form-data');
const fs = require('fs').promises;
const path = require('path');
const chatStorage = require('../../services/ChatStorageServicePersistent');
const ErrorHandler = require('./ErrorHandler');
const RateLimitManager = require('./RateLimitManager');
const ConversationManager = require('./ConversationManager');
const MediaManager = require('./MediaManager');
const TemplateManager = require('./TemplateManager');
const MonitoringService = require('./MonitoringService');

/**
 * Provider pour WhatsApp Cloud API (Meta)
 * Implémente l'interface WhatsAppProvider pour l'API officielle Meta
 * 
 * Documentation: https://developers.facebook.com/docs/whatsapp/cloud-api
 * 
 * @class MetaCloudProvider
 * @extends WhatsAppProvider
 */
class MetaCloudProvider extends WhatsAppProvider {
  constructor(config = {}) {
    super(config);
    
    this.name = 'meta';
    this.config = config; // Store config from constructor
    this.apiVersion = config.apiVersion || 'v18.0';
    this.baseURL = `https://graph.facebook.com/${this.apiVersion}`;
    this.apiClient = null;
    this.templates = new Map(); // Cache des templates
    
    // Initialiser les gestionnaires
    this.errorHandler = new ErrorHandler();
    this.rateLimitManager = new RateLimitManager();
    this.conversationManager = new ConversationManager();
    this.mediaManager = new MediaManager(config);
    this.templateManager = new TemplateManager(config);
    this.monitoringService = new MonitoringService();
    
    // Statistiques
    this.stats = {
      messagesSent: 0,
      messagesReceived: 0,
      errors: 0,
      templatesUsed: 0
    };
  }

  // ==================== Configuration ====================

  /**
   * Initialise le provider avec la configuration
   * @param {Object} config - Configuration Meta Cloud API
   * @returns {Promise<boolean>}
   */
  async initialize(config) {
    try {
      // Merge with existing config if provided, otherwise keep existing
      if (config) {
        this.config = { ...this.config, ...config };
      }
      
      // Valider la configuration
      const validation = await this.validateConfig();
      if (!validation.valid) {
        throw new Error(`Invalid configuration: ${validation.errors.join(', ')}`);
      }

      // Créer le client axios
      this.apiClient = axios.create({
        baseURL: this.baseURL,
        headers: {
          'Authorization': `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      // Intercepteur pour logging et gestion d'erreurs
      this.apiClient.interceptors.response.use(
        response => response,
        error => {
          logger.error('Meta Cloud API Error:', {
            url: error.config?.url,
            method: error.config?.method,
            status: error.response?.status,
            data: error.response?.data
          });

          // Gérer les erreurs spécifiques Meta
          if (error.response?.data?.error) {
            const metaError = error.response.data.error;
            
            // Rate limiting
            if (metaError.code === 80007 || metaError.code === 4) {
              error.isRateLimit = true;
              error.retryAfter = this.extractRetryAfter(error.response.headers);
            }
            
            // Token expiré
            if (metaError.code === 190) {
              error.isTokenExpired = true;
            }
          }

          return Promise.reject(error);
        }
      );

      // Charger les templates disponibles
      await this.templateManager.loadTemplates();

      this.isInitialized = true;
      logger.info('MetaCloudProvider initialized successfully');
      
      return true;
    } catch (error) {
      logger.error('Failed to initialize MetaCloudProvider:', error);
      throw error;
    }
  }

  /**
   * Valide la configuration du provider
   * @returns {Promise<{valid: boolean, errors?: string[]}>}
   */
  async validateConfig() {
    const errors = [];

    if (!this.config) {
      errors.push('Configuration is required');
      return { valid: false, errors };
    }

    if (!this.config.accessToken) {
      errors.push('Access Token is required');
    }
    
    if (!this.config.phoneNumberId) {
      errors.push('Phone Number ID is required');
    }
    
    if (!this.config.businessAccountId) {
      errors.push('Business Account ID is required');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Teste la connexion avec l'API
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async testConnection() {
    try {
      // Vérifier si le client API est initialisé
      if (!this.apiClient) {
        return {
          success: false,
          message: 'API client not initialized. Please check configuration.'
        };
      }

      // Vérifier le phone number
      const response = await this.apiClient.get(`/${this.config.phoneNumberId}`);
      
      const phoneData = response.data;
      
      return {
        success: true,
        message: `Connected to Meta Cloud API. Phone: ${phoneData.display_phone_number}, Status: ${phoneData.quality_rating}`
      };
    } catch (error) {
      let message = error.response?.data?.error?.message || error.message;
      
      // Messages d'erreur plus clairs
      if (error.response?.status === 401) {
        message = 'Access token expired or invalid. Please update your token.';
      } else if (error.response?.data?.error?.code === 190) {
        message = 'Access token expired. Please generate a new token from Facebook Developer Console.';
      }
      
      return {
        success: false,
        message: message
      };
    }
  }

  // ==================== Messages ====================

  /**
   * Envoie un message texte
   * Note: Meta requiert l'utilisation de templates pour les messages initiaux
   * @param {string} to - Numéro destinataire
   * @param {string} text - Texte du message
   * @param {Object} options - Options supplémentaires
   * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
   */
  async sendTextMessage(to, text, options = {}) {
    try {
      logger.info(`Sending text message to ${to}: "${text}"`);
      
      // Vérifier les limites de débit
      await this.rateLimitManager.checkRateLimit(to);
      
      // Vérifier la fenêtre de conversation
      const strategy = this.conversationManager.getMessageStrategy(to);
      logger.info(`Conversation strategy for ${to}:`, strategy);
      
      // TEMPORAIRE: Forcer la mise à jour de la session pour permettre l'envoi
      // TODO: Implémenter la persistance des sessions
      this.conversationManager.updateSession(to, 'service', false);
      
      // Désactivé temporairement pour les tests
      /*
      if (strategy.requiresTemplate) {
        logger.info(`Message hors fenêtre 24h pour ${to}, template requis`);
        return {
          success: false,
          error: {
            code: 131051,
            message: strategy.reason,
            requiresTemplate: true
          }
        };
      }
      */
      
      const phoneNumber = this.extractPhoneNumber(to);
      
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phoneNumber,
        type: 'text',
        text: {
          preview_url: options.preview_url !== false, // Active par défaut
          body: text
        }
      };

      // Si c'est une réponse, ajouter le context
      if (options.replyTo) {
        payload.context = {
          message_id: options.replyTo
        };
      }

      const result = await this.errorHandler.handleWithRetry(async () => {
        const response = await this.apiClient.post(`/${this.config.phoneNumberId}/messages`, payload);
        return response.data;
      });

      // Enregistrer l'envoi
      this.rateLimitManager.recordMessage(to);
      this.conversationManager.updateSession(to, 'service', false);
      this.stats.messagesSent++;
      this.monitoringService.recordMessageSent('text', true);
      
      // Stocker le message envoyé localement avec le format correct
      const sentMessage = {
        id: result.messages[0].id,
        chatId: to,
        from: this.config.phoneNumberId,
        to: to,
        type: 'text',
        content: text,
        media: null,
        timestamp: Date.now(),
        fromMe: true, // IMPORTANT: Marquer explicitement comme envoyé par nous
        status: 'sent',
        pushName: 'Moi',
        // Format Evolution pour compatibilité
        key: {
          remoteJid: to,
          fromMe: true,
          id: result.messages[0].id
        },
        message: {
          extendedTextMessage: {
            text: text
          }
        },
        messageTimestamp: Math.floor(Date.now() / 1000)
      };
      
      await chatStorage.processIncomingMessage(sentMessage);
      logger.info(`Message envoyé stocké localement: ${result.messages[0].id}`);
      
      // Envoyer un push pour notifier les clients
      const pushService = require('../../services/PushService');
      pushService.pushNewMessage(sentMessage);

      return {
        success: true,
        messageId: result.messages[0].id,
        provider: 'meta'
      };
    } catch (error) {
      logger.error('Failed to send text message:', error);
      this.stats.errors++;
      this.monitoringService.recordMessageSent('text', false);
      this.monitoringService.recordError(error, { type: 'send_text_message' });
      
      const errorInfo = this.errorHandler.formatError(error);
      
      return {
        success: false,
        error: error.message,
        provider: 'meta'
      };
    }
  }

  /**
   * Envoie un message avec template
   * @param {string} to - Numéro destinataire
   * @param {string} templateName - Nom du template
   * @param {Object} parameters - Paramètres du template
   * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
   */
  async sendTemplateMessage(to, templateName, parameters, language = 'fr') {
    try {
      // Valider les paramètres
      const validation = this.templateManager.validateParameters(templateName, parameters, language);
      if (!validation.valid) {
        return {
          success: false,
          error: `Paramètres invalides: ${validation.errors.join(', ')}`
        };
      }
      
      const phoneNumber = this.extractPhoneNumber(to);
      
      // Construire le payload avec le TemplateManager
      const payload = this.templateManager.buildMessagePayload(phoneNumber, templateName, parameters, language);

      const result = await this.errorHandler.handleWithRetry(async () => {
        const response = await this.apiClient.post(`/${this.config.phoneNumberId}/messages`, payload);
        return response.data;
      });

      // Enregistrer l'envoi
      this.rateLimitManager.recordMessage(to);
      this.conversationManager.recordTemplateSent(to, templateName, payload.template.category || 'MARKETING');
      this.stats.templatesUsed++;
      this.monitoringService.recordMessageSent('template', true);

      return {
        success: true,
        messageId: result.messages[0].id
      };
    } catch (error) {
      logger.error('Failed to send template message:', error);
      this.stats.errors++;
      this.monitoringService.recordMessageSent('template', false);
      this.monitoringService.recordError(error, { type: 'send_template_message' });
      
      return {
        success: false,
        error: this.errorHandler.formatError(error)
      };
    }
  }

  /**
   * Envoie un message média
   * @param {string} to - Numéro destinataire
   * @param {Object} media - {type: 'image'|'video'|'audio'|'document', id?: string, url?: string, buffer?: Buffer, caption?: string, fileName?: string, mimeType?: string}
   * @param {Object} options - Options supplémentaires
   * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
   */
  async sendMediaMessage(to, media, options = {}) {
    try {
      const phoneNumber = this.extractPhoneNumber(to);
      
      // D'abord uploader le média si nécessaire
      let mediaId = media.id || media.metaMediaId; // Support des deux noms de propriété
      
      if (!mediaId) {
        // Si l'URL est une URL locale de notre API, on a déjà uploadé le fichier
        if (media.url && media.url.startsWith('/api/media/')) {
          logger.error('Media URL points to local API but no Meta media ID provided:', media);
          return {
            success: false,
            error: 'Media must be uploaded to Meta first. Missing metaMediaId.'
          };
        }
        
        let uploadResult;
        
        if (media.buffer) {
          // Upload depuis un buffer
          uploadResult = await this.uploadMedia(media.buffer, {
            fileName: media.fileName,
            mimeType: media.mimeType
          });
        } else if (media.url && (media.url.startsWith('http://') || media.url.startsWith('https://'))) {
          // Upload depuis une URL externe seulement
          uploadResult = await this.uploadMedia(media.url, {
            fileName: media.fileName,
            mimeType: media.mimeType
          });
        } else {
          return {
            success: false,
            error: 'No valid media data provided (need buffer, external URL, or Meta media ID)'
          };
        }
        
        if (!uploadResult.success) {
          return uploadResult;
        }
        mediaId = uploadResult.mediaId;
      }
      
      logger.info(`Sending media message with Meta media ID: ${mediaId}`);

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phoneNumber,
        type: media.type
      };

      // Construire le payload selon le type
      switch (media.type) {
        case 'image':
          payload.image = {
            id: mediaId,
            caption: media.caption
          };
          break;
        case 'video':
          payload.video = {
            id: mediaId,
            caption: media.caption
          };
          break;
        case 'audio':
          payload.audio = {
            id: mediaId
          };
          break;
        case 'document':
          payload.document = {
            id: mediaId,
            caption: media.caption,
            filename: media.fileName
          };
          break;
        default:
          return {
            success: false,
            error: `Unsupported media type: ${media.type}`
          };
      }

      // Si c'est une réponse
      if (options.replyTo) {
        payload.context = {
          message_id: options.replyTo
        };
      }

      const response = await this.apiClient.post(`/${this.config.phoneNumberId}/messages`, payload);

      return {
        success: true,
        messageId: response.data.messages[0].id
      };
    } catch (error) {
      logger.error('Failed to send media message:', error);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  /**
   * Envoie un document
   * @param {string} to - Numéro destinataire
   * @param {Object} document - {url: string, filename: string, caption?: string}
   * @param {Object} options - Options supplémentaires
   * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
   */
  async sendDocument(to, document, options = {}) {
    try {
      const phoneNumber = this.extractPhoneNumber(to);
      
      // Uploader le document
      let documentId = document.id;
      if (!documentId && document.url) {
        const uploadResult = await this.uploadMedia(document.url, 'document');
        if (!uploadResult.success) {
          return uploadResult;
        }
        documentId = uploadResult.mediaId;
      }

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phoneNumber,
        type: 'document',
        document: {
          id: documentId,
          filename: document.filename,
          caption: document.caption
        }
      };

      // Si c'est une réponse
      if (options.replyTo) {
        payload.context = {
          message_id: options.replyTo
        };
      }

      const response = await this.apiClient.post(`/${this.config.phoneNumberId}/messages`, payload);

      return {
        success: true,
        messageId: response.data.messages[0].id
      };
    } catch (error) {
      logger.error('Failed to send document:', error);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  /**
   * Envoie un message avec boutons
   * @param {string} to - Numéro destinataire
   * @param {Object} buttonMessage - Configuration du message avec boutons
   * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
   */
  async sendButtonMessage(to, buttonMessage) {
    try {
      // Vérifier les limites de débit
      await this.rateLimitManager.checkRateLimit(to);
      
      const phoneNumber = this.extractPhoneNumber(to);
      
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phoneNumber,
        type: 'interactive',
        interactive: {
          type: 'button',
          header: buttonMessage.header ? {
            type: buttonMessage.header.type || 'text',
            text: buttonMessage.header.text
          } : undefined,
          body: {
            text: buttonMessage.body
          },
          footer: buttonMessage.footer ? {
            text: buttonMessage.footer
          } : undefined,
          action: {
            buttons: buttonMessage.buttons.slice(0, 3).map((button, index) => ({
              type: 'reply',
              reply: {
                id: button.id || `button_${index}`,
                title: button.title.substring(0, 20) // Max 20 caractères
              }
            }))
          }
        }
      };

      const result = await this.errorHandler.handleWithRetry(async () => {
        const response = await this.apiClient.post(`/${this.config.phoneNumberId}/messages`, payload);
        return response.data;
      });

      this.rateLimitManager.recordMessage(to);
      this.stats.messagesSent++;

      return {
        success: true,
        messageId: result.messages[0].id
      };
    } catch (error) {
      logger.error('Failed to send button message:', error);
      this.stats.errors++;
      return {
        success: false,
        error: this.errorHandler.formatError(error)
      };
    }
  }

  /**
   * Envoie un message avec liste
   * @param {string} to - Numéro destinataire
   * @param {Object} listMessage - Configuration du message avec liste
   * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
   */
  async sendListMessage(to, listMessage) {
    try {
      // Vérifier les limites de débit
      await this.rateLimitManager.checkRateLimit(to);
      
      const phoneNumber = this.extractPhoneNumber(to);
      
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phoneNumber,
        type: 'interactive',
        interactive: {
          type: 'list',
          header: listMessage.header ? {
            type: 'text',
            text: listMessage.header
          } : undefined,
          body: {
            text: listMessage.body
          },
          footer: listMessage.footer ? {
            text: listMessage.footer
          } : undefined,
          action: {
            button: listMessage.buttonText || 'Voir options',
            sections: listMessage.sections.map(section => ({
              title: section.title,
              rows: section.rows.slice(0, 10).map(row => ({
                id: row.id,
                title: row.title.substring(0, 24), // Max 24 caractères
                description: row.description ? row.description.substring(0, 72) : undefined // Max 72 caractères
              }))
            }))
          }
        }
      };

      const result = await this.errorHandler.handleWithRetry(async () => {
        const response = await this.apiClient.post(`/${this.config.phoneNumberId}/messages`, payload);
        return response.data;
      });

      this.rateLimitManager.recordMessage(to);
      this.stats.messagesSent++;

      return {
        success: true,
        messageId: result.messages[0].id
      };
    } catch (error) {
      logger.error('Failed to send list message:', error);
      this.stats.errors++;
      return {
        success: false,
        error: this.errorHandler.formatError(error)
      };
    }
  }

  /**
   * Envoie un message de localisation
   * @param {string} to - Numéro destinataire
   * @param {Object} location - {latitude, longitude, name?, address?}
   * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
   */
  async sendLocationMessage(to, location) {
    try {
      // Vérifier les limites de débit
      await this.rateLimitManager.checkRateLimit(to);
      
      const phoneNumber = this.extractPhoneNumber(to);
      
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phoneNumber,
        type: 'location',
        location: {
          latitude: location.latitude,
          longitude: location.longitude,
          name: location.name,
          address: location.address
        }
      };

      const result = await this.errorHandler.handleWithRetry(async () => {
        const response = await this.apiClient.post(`/${this.config.phoneNumberId}/messages`, payload);
        return response.data;
      });

      this.rateLimitManager.recordMessage(to);
      this.stats.messagesSent++;

      return {
        success: true,
        messageId: result.messages[0].id
      };
    } catch (error) {
      logger.error('Failed to send location message:', error);
      this.stats.errors++;
      return {
        success: false,
        error: this.errorHandler.formatError(error)
      };
    }
  }

  /**
   * Upload un média vers Meta
   * @param {Buffer|string} mediaData - Buffer du média ou chemin local
   * @param {Object} options - Options {fileName, mimeType}
   * @returns {Promise<{success: boolean, mediaId?: string, error?: string}>}
   */
  async uploadMedia(mediaData, options = {}) {
    try {
      let fileBuffer;
      let mimeType = options.mimeType;
      let fileName = options.fileName || 'media';
      
      // Gérer différents types d'entrée
      if (Buffer.isBuffer(mediaData)) {
        fileBuffer = mediaData;
      } else if (typeof mediaData === 'string') {
        if (mediaData.startsWith('http')) {
          // URL externe
          const response = await axios.get(mediaData, { responseType: 'arraybuffer' });
          fileBuffer = Buffer.from(response.data);
          mimeType = mimeType || response.headers['content-type'];
        } else {
          // Fichier local
          const fs = require('fs').promises;
          fileBuffer = await fs.readFile(mediaData);
          mimeType = mimeType || this.getMimeType(mediaData);
        }
      } else {
        throw new Error('Invalid media data type');
      }

      // Créer le FormData
      const formData = new FormData();
      formData.append('messaging_product', 'whatsapp');
      formData.append('file', fileBuffer, {
        contentType: mimeType,
        filename: fileName
      });

      // Upload vers Meta
      const response = await axios.post(
        `${this.baseURL}/${this.config.phoneNumberId}/media`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            'Authorization': `Bearer ${this.config.accessToken}`
          }
        }
      );

      return {
        success: true,
        mediaId: response.data.id
      };
    } catch (error) {
      logger.error('Failed to upload media:', error);
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  /**
   * Récupère l'URL d'un média depuis Meta
   * @param {string} mediaId - ID du média
   * @returns {Promise<{url: string, mimeType: string, fileSize: number}>}
   */
  async getMediaUrl(mediaId) {
    try {
      logger.info(`Getting media URL for ID: ${mediaId}`);
      
      const response = await this.apiClient.get(`/${mediaId}`, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'curl/7.64.1'
        }
      });
      
      // Log détaillé pour debug
      logger.debug('Meta API response:', {
        status: response.status,
        headers: response.headers,
        dataType: typeof response.data,
        dataKeys: typeof response.data === 'object' ? Object.keys(response.data) : null
      });
      
      // Traitement unifié des différents formats de réponse
      return this.normalizeMediaResponse(response.data);
      
    } catch (error) {
      // Gérer spécifiquement l'erreur de token expiré
      if (error.response?.data?.error?.code === 190) {
        logger.error('Meta access token expired:', error.response.data.error);
        throw new Error('Meta access token expired. Please renew the token.');
      }
      
      logger.error('Failed to get media URL:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Normalise la réponse média de Meta dans un format standard
   * @param {any} data - Données de réponse de l'API
   * @returns {{url: string, mimeType: string, fileSize: number|null}}
   */
  normalizeMediaResponse(data) {
    // Si c'est une string directe (URL)
    if (typeof data === 'string') {
      logger.debug('Media response is direct URL string');
      return {
        url: data.trim(),
        mimeType: 'application/octet-stream',
        fileSize: null
      };
    }
    
    // Si c'est un Buffer ou objet Buffer-like
    if (data instanceof Buffer || (typeof data === 'object' && data.type === 'Buffer')) {
      logger.debug('Media response is Buffer, converting to string');
      const urlString = Buffer.from(data.data || data).toString('utf8').trim();
      // Nettoyer l'URL des guillemets éventuels
      const cleanUrl = urlString.replace(/^["']|["']$/g, '');
      return {
        url: cleanUrl,
        mimeType: 'application/octet-stream',
        fileSize: null
      };
    }
    
    // Si c'est le format standard de l'API Meta
    if (typeof data === 'object' && data.url) {
      logger.debug('Media response is standard Meta format');
      return {
        url: data.url,
        mimeType: data.mime_type || 'application/octet-stream',
        fileSize: data.file_size || null
      };
    }
    
    // Format non reconnu
    logger.error('Unsupported media response format:', {
      type: typeof data,
      keys: typeof data === 'object' ? Object.keys(data) : null,
      sample: JSON.stringify(data).substring(0, 200)
    });
    
    throw new Error(`Unsupported media response format: ${typeof data}`);
  }

  /**
   * Télécharge un média depuis Meta
   * @param {string} mediaUrl - URL du média
   * @returns {Promise<{buffer: Buffer, mimeType: string, fileName: string}>}
   */
  async downloadMedia(mediaUrl) {
    try {
      const response = await axios.get(mediaUrl, {
        responseType: 'arraybuffer',
        headers: {
          'Authorization': `Bearer ${this.config.accessToken}`
        }
      });
      
      // Extraire le nom du fichier depuis les headers si disponible
      let fileName = 'media';
      const contentDisposition = response.headers['content-disposition'];
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="?([^"]+)"?/);
        if (match) {
          fileName = match[1];
        }
      }
      
      return {
        buffer: Buffer.from(response.data),
        mimeType: response.headers['content-type'],
        fileName: fileName
      };
    } catch (error) {
      logger.error('Failed to download media:', error);
      throw error;
    }
  }

  /**
   * Récupère les messages (non supporté directement par Meta)
   * Meta utilise les webhooks pour recevoir les messages
   * @param {string} chatId - ID de la conversation
   * @param {number} limit - Nombre de messages
   * @param {Object} options - Options
   * @returns {Promise<Array>}
   */
  async getMessages(chatId, limit = 50, options = {}) {
    // Meta Cloud API ne supporte pas la récupération directe des messages
    // On utilise le stockage local
    try {
      // TODO: Supporter multi-utilisateurs
      const userId = 1; // Admin par défaut
      const messages = await chatStorage.getMessages(userId, chatId, limit);
      return messages || [];
    } catch (error) {
      logger.error('Failed to get messages from storage:', error);
      return [];
    }
  }

  /**
   * Marque un message comme lu
   * @param {string} messageId - ID du message
   * @returns {Promise<{success: boolean}>}
   */
  async markMessageAsRead(messageId) {
    try {
      await this.apiClient.post(`/${this.config.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId
      });

      return { success: true };
    } catch (error) {
      logger.error('Failed to mark message as read:', error);
      return { success: false };
    }
  }

  /**
   * Réagit à un message
   * @param {string} messageId - ID du message
   * @param {string} emoji - Emoji de réaction
   * @returns {Promise<{success: boolean}>}
   */
  async sendReaction(messageId, emoji) {
    try {
      await this.apiClient.post(`/${this.config.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        type: 'reaction',
        reaction: {
          message_id: messageId,
          emoji: emoji
        }
      });

      return { success: true };
    } catch (error) {
      logger.error('Failed to send reaction:', error);
      return { success: false };
    }
  }

  // ==================== Chats ====================

  /**
   * Récupère la liste des conversations (non supporté par Meta)
   * @param {Object} options - Options de filtrage
   * @returns {Promise<Array>}
   */
  async getChats(options = {}) {
    // Utiliser le stockage local pour Meta API
    // TODO: Implémenter la gestion multi-utilisateurs
    const userId = 1; // Admin par défaut
    return await chatStorage.getChats(userId);
  }

  /**
   * Récupère les informations d'une conversation (non supporté)
   * @param {string} chatId - ID de la conversation
   * @returns {Promise<Object>}
   */
  async getChatInfo(chatId) {
    logger.warn('getChatInfo not supported by Meta Cloud API');
    return null;
  }

  /**
   * Marque une conversation comme lue (utilise markMessageAsRead)
   * @param {string} chatId - ID de la conversation
   * @returns {Promise<{success: boolean}>}
   */
  async markChatAsRead(chatId) {
    // Meta Cloud API marque automatiquement les messages comme lus quand on les récupère
    // On simule le succès pour éviter les erreurs dans le frontend
    logger.info(`Chat ${chatId} marked as read (simulated for Meta API)`);
    return { success: true };
  }

  /**
   * Archive/Désarchive une conversation (non supporté)
   * @param {string} chatId - ID de la conversation
   * @param {boolean} archive - true pour archiver
   * @returns {Promise<{success: boolean}>}
   */
  async archiveChat(chatId, archive = true) {
    logger.warn('archiveChat not supported by Meta Cloud API');
    return { success: false };
  }

  // ==================== Contacts ====================

  /**
   * Récupère la liste des contacts (non supporté directement)
   * @returns {Promise<Array>}
   */
  async getContacts() {
    logger.warn('getContacts not supported by Meta Cloud API - use local storage');
    return [];
  }

  /**
   * Récupère les informations d'un contact
   * @param {string} contactId - ID du contact
   * @returns {Promise<Object>}
   */
  async getContactInfo(contactId) {
    try {
      const phoneNumber = this.extractPhoneNumber(contactId);
      
      // Meta peut récupérer le profil business
      const response = await this.apiClient.get(`/${this.config.phoneNumberId}/business_profile`);
      
      if (response.data) {
        return this.normalizeContact({
          id: contactId,
          business_profile: response.data
        });
      }
      
      return null;
    } catch (error) {
      logger.error('Failed to get contact info:', error);
      return null;
    }
  }

  /**
   * Vérifie si un numéro existe sur WhatsApp (non supporté directement)
   * @param {string} phoneNumber - Numéro à vérifier
   * @returns {Promise<{exists: boolean, jid?: string}>}
   */
  async checkNumberExists(phoneNumber) {
    logger.warn('checkNumberExists not directly supported by Meta Cloud API');
    // On peut essayer d'envoyer un message pour vérifier
    return { exists: true, jid: this.normalizePhoneNumber(phoneNumber) };
  }

  /**
   * Récupère la photo de profil d'un contact (non supporté)
   * @param {string} contactId - ID du contact
   * @returns {Promise<{url: string}>}
   */
  async getProfilePicture(contactId) {
    logger.warn('getProfilePicture not supported by Meta Cloud API');
    return { url: '' };
  }

  // ==================== État et Connexion ====================

  /**
   * Récupère l'état de connexion
   * @returns {Promise<{state: string, qrcode?: string}>}
   */
  async getConnectionState() {
    try {
      // Vérifier si le client API est initialisé
      if (!this.apiClient) {
        logger.warn('Meta API client not initialized');
        return { state: 'disconnected', error: 'API client not initialized' };
      }

      // Vérifier le statut du phone number
      const response = await this.apiClient.get(`/${this.config.phoneNumberId}`);
      
      // Meta API retourne verified_name et platform_type
      if (response.data && (response.data.verified_name || response.data.platform_type === 'CLOUD_API')) {
        this.connectionState = 'connected';
        return { state: 'connected' };
      } else {
        return { state: 'disconnected' };
      }
    } catch (error) {
      logger.error('Failed to get connection state:', error);
      
      // Analyser le type d'erreur
      if (error.isTokenExpired) {
        return { state: 'disconnected', error: 'Access token expired' };
      } else if (error.response?.status === 401) {
        return { state: 'disconnected', error: 'Authentication failed' };
      }
      
      return { state: 'disconnected', error: error.message };
    }
  }

  /**
   * Récupère le QR code (non applicable pour Meta)
   * @returns {Promise<{qrcode: string}>}
   */
  async getQRCode() {
    return { qrcode: '' };
  }

  /**
   * Déconnecte la session (non applicable)
   * @returns {Promise<{success: boolean}>}
   */
  async logout() {
    logger.info('Logout not applicable for Meta Cloud API');
    this.connectionState = 'disconnected';
    return { success: true };
  }

  // ==================== Webhooks ====================

  /**
   * Configure le webhook pour recevoir les événements
   * @param {string} url - URL du webhook
   * @param {Object} options - Options du webhook
   * @returns {Promise<{success: boolean}>}
   */
  async setupWebhook(url, options = {}) {
    try {
      // Meta nécessite une configuration manuelle via le dashboard
      logger.info('Meta webhooks must be configured in the Facebook App Dashboard');
      logger.info(`Webhook URL to configure: ${url}`);
      logger.info(`Verify Token: ${this.config.webhookVerifyToken}`);
      
      return { success: true };
    } catch (error) {
      logger.error('Failed to setup webhook:', error);
      return { success: false };
    }
  }

  /**
   * Vérifie le webhook Meta (pour la validation)
   * @param {Object} query - Query params de la requête
   * @returns {boolean|string}
   */
  verifyWebhook(query) {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode === 'subscribe' && token === this.config.webhookVerifyToken) {
      logger.info('Meta webhook verified successfully');
      return challenge;
    } else {
      logger.error('Meta webhook verification failed');
      return false;
    }
  }

  /**
   * Traite un événement webhook reçu
   * @param {Object} data - Données du webhook
   * @returns {Promise<Object>}
   */
  async handleWebhook(data) {
    try {
      // Structure Meta webhook
      if (!data.entry || !Array.isArray(data.entry)) {
        return {
          type: 'unknown',
          data: data
        };
      }

      const events = [];
      
      for (const entry of data.entry) {
        if (entry.changes) {
          for (const change of entry.changes) {
            if (change.field === 'messages') {
              const value = change.value;
              
              // Nouveaux messages
              if (value.messages) {
                for (const message of value.messages) {
                  logger.info('Meta webhook message structure:', JSON.stringify(message));
                  const normalizedMessage = this.normalizeMessage(message, value.metadata);
                  
                  // Ajouter le nom du contact si disponible
                  if (value.contacts && value.contacts.length > 0) {
                    const contact = value.contacts.find(c => c.wa_id === message.from);
                    if (contact) {
                      normalizedMessage.contactName = contact.profile?.name || '';
                      normalizedMessage.pushName = contact.profile?.name || '';
                    }
                  }
                  
                  events.push({
                    type: 'message',
                    data: normalizedMessage
                  });
                  
                  // Enregistrer la réception
                  this.stats.messagesReceived++;
                  this.monitoringService.recordMessageReceived(message.type || 'text');
                  this.conversationManager.updateSession(message.from, 'service', true);
                }
              }
              
              // Statuts de messages
              if (value.statuses) {
                for (const status of value.statuses) {
                  events.push({
                    type: 'message_status',
                    data: {
                      messageId: status.id,
                      status: status.status,
                      timestamp: status.timestamp * 1000,
                      recipient: status.recipient_id
                    }
                  });
                  
                  // Enregistrer le statut
                  this.monitoringService.recordMessageStatus(status.status);
                }
              }
            }
          }
        }
      }

      // Si plusieurs événements, retourner le premier (les autres seront traités en boucle)
      return events.length > 0 ? events[0] : { type: 'unknown', data: data };
    } catch (error) {
      logger.error('Failed to handle webhook:', error);
      return {
        type: 'error',
        error: error.message
      };
    }
  }

  // ==================== Templates ====================

  /**
   * Obtient la liste des templates
   * @returns {Array}
   */
  getTemplates() {
    return this.templateManager.getTemplates();
  }

  /**
   * Construit les composants du template
   * @param {Object} parameters - Paramètres du template
   * @returns {Array}
   */
  buildTemplateComponents(parameters) {
    const components = [];
    
    // Header parameters
    if (parameters.header) {
      components.push({
        type: 'header',
        parameters: Array.isArray(parameters.header) 
          ? parameters.header 
          : [{ type: 'text', text: parameters.header }]
      });
    }
    
    // Body parameters
    if (parameters.body) {
      components.push({
        type: 'body',
        parameters: Array.isArray(parameters.body)
          ? parameters.body
          : [{ type: 'text', text: parameters.body }]
      });
    }
    
    // Button parameters
    if (parameters.buttons) {
      parameters.buttons.forEach((button, index) => {
        components.push({
          type: 'button',
          sub_type: button.type || 'quick_reply',
          index: index,
          parameters: [{ type: 'payload', payload: button.payload || button.text }]
        });
      });
    }
    
    return components;
  }

  // ==================== Normalisation ====================

  /**
   * Normalise un message au format commun
   * @param {Object} rawMessage - Message brut de Meta
   * @param {Object} metadata - Métadonnées du webhook
   * @returns {Object}
   */
  normalizeMessage(rawMessage, metadata = {}) {
    // Extraire les informations de base
    const from = rawMessage.from;
    const id = rawMessage.id;
    const timestamp = rawMessage.timestamp || Date.now() / 1000;
    
    // Déterminer si c'est un message envoyé par nous
    // Dans Meta API, les messages envoyés par l'API ne remontent pas par webhook
    // donc tous les messages webhook sont fromMe: false SAUF si explicitement marqués
    const fromMe = rawMessage.fromMe || false;
    
    // Déterminer le type de message
    let type = rawMessage.type || 'text';
    let content = '';
    let media = null;

    switch (rawMessage.type) {
      case 'text':
        content = rawMessage.text.body;
        break;
        
      case 'image':
        content = rawMessage.image.caption || '';
        media = {
          id: rawMessage.image.id,
          mime_type: rawMessage.image.mime_type,
          sha256: rawMessage.image.sha256
        };
        
        // Télécharger et stocker le média automatiquement
        if (rawMessage.image.id) {
          const mediaStorage = require('../../services/MediaStorageService');
          const chatStorage = require('../../services/ChatStorageServicePersistent');
          // Toujours télécharger les médias pour une expérience complète
          mediaStorage.downloadFromMeta(rawMessage.image.id, this, {
            chatId: from,
            messageId: id
          })
            .then(storedMedia => {
              logger.info(`Image automatiquement stockée: ${storedMedia.id}`);
              // Ajouter l'ID local au média
              media.localMediaId = storedMedia.id;
              media.localUrl = storedMedia.url;
              media.url = storedMedia.url;
              
              // Mettre à jour le message dans la DB avec l'URL du média
              // Attendre un peu pour s'assurer que le message est bien enregistré
              setTimeout(() => {
                chatStorage.updateMessageMediaUrl(id, storedMedia.url)
                  .then(() => {
                    logger.info(`Media URL updated for message ${id}`);
                  })
                  .catch(err => {
                    logger.error('Erreur mise à jour media_url:', err);
                  });
              }, 2000);
            })
            .catch(err => {
              logger.error('Erreur stockage automatique image:', err);
              // En cas d'erreur, au moins garder la référence Meta
              media.downloadError = true;
              media.errorMessage = err.message;
            });
        }
        break;
        
      case 'video':
        content = rawMessage.video.caption || '';
        media = {
          id: rawMessage.video.id,
          mime_type: rawMessage.video.mime_type,
          sha256: rawMessage.video.sha256
        };
        break;
        
      case 'audio':
        media = {
          id: rawMessage.audio.id,
          mime_type: rawMessage.audio.mime_type,
          voice: rawMessage.audio.voice || false
        };
        
        // Télécharger automatiquement l'audio de manière asynchrone
        if (rawMessage.audio.id) {
          // Lancer le téléchargement en arrière-plan
          (async () => {
            try {
              const mediaStorage = require('../../services/MediaStorageService');
              const chatStorage = require('../../services/ChatStorageServicePersistent');
              
              const storedMedia = await mediaStorage.downloadFromMeta(rawMessage.audio.id, this, {
                chatId: from,
                messageId: id
              });
              
              logger.info(`Audio automatiquement stocké: ${storedMedia.id}`);
              
              // Mettre à jour le message dans la DB avec l'URL du média
              await chatStorage.updateMessageMediaUrl(id, storedMedia.url);
              logger.info(`Audio URL updated for message ${id}`);
              
              // Re-broadcaster le message avec l'URL mise à jour
              const updatedMessage = {
                id: id,
                chatId: from,
                from: from,
                to: to,
                type: 'audio',
                content: content,
                media: {
                  id: rawMessage.audio.id,
                  mime_type: rawMessage.audio.mime_type,
                  voice: rawMessage.audio.voice || false,
                  localMediaId: storedMedia.id,
                  localUrl: storedMedia.url,
                  url: storedMedia.url
                },
                timestamp: timestamp,
                fromMe: false,
                pushName: pushName,
                status: 'received'
              };
              
              // Envoyer la mise à jour via PushService
              const pushService = require('../../services/PushService');
              pushService.pushNewMessage(updatedMessage);
              logger.info('Audio message re-broadcast with local URL');
            } catch (err) {
              logger.error('Erreur téléchargement/stockage audio:', err);
            }
          })();
        }
        break;
        
      case 'document':
        content = rawMessage.document.filename || '';
        media = {
          id: rawMessage.document.id,
          mime_type: rawMessage.document.mime_type,
          filename: rawMessage.document.filename,
          sha256: rawMessage.document.sha256
        };
        break;
        
      case 'location':
        type = 'location';
        content = `${rawMessage.location.latitude},${rawMessage.location.longitude}`;
        media = rawMessage.location;
        break;
        
      case 'contacts':
        type = 'contact';
        content = rawMessage.contacts[0]?.name?.formatted_name || '';
        media = rawMessage.contacts;
        break;
        
      case 'interactive':
        if (rawMessage.interactive.type === 'button_reply') {
          content = rawMessage.interactive.button_reply.title;
        } else if (rawMessage.interactive.type === 'list_reply') {
          content = rawMessage.interactive.list_reply.title;
        }
        break;
    }

    // Récupérer l'URL du média si nécessaire
    if (media && media.id && !media.url) {
      // L'URL doit être récupérée séparément avec l'API
      this.getMediaUrl(media.id).then(url => {
        media.url = url;
      }).catch(err => {
        logger.error('Failed to get media URL:', err);
      });
    }

    return {
      id: rawMessage.id,
      chatId: rawMessage.from,
      from: rawMessage.from,
      to: metadata.phone_number_id || this.config.phoneNumberId,
      type: type,
      content: content,
      media: media,
      timestamp: parseInt(rawMessage.timestamp) * 1000,
      fromMe: fromMe, // Utiliser la valeur déterminée
      status: fromMe ? 'sent' : 'received',
      quotedMessage: rawMessage.context,
      reactions: rawMessage.reaction ? [rawMessage.reaction] : []
    };
  }


  /**
   * Normalise une conversation au format commun
   * @param {Object} rawChat - Chat brut
   * @returns {Object}
   */
  normalizeChat(rawChat) {
    // Meta ne fournit pas directement les chats, on doit les construire
    return {
      id: rawChat.id,
      name: rawChat.profile?.name || rawChat.id,
      type: 'individual',
      avatar: '',
      lastMessage: null,
      unreadCount: 0,
      timestamp: Date.now(),
      isArchived: false,
      isMuted: false,
      isPinned: false
    };
  }

  /**
   * Normalise un contact au format commun
   * @param {Object} rawContact - Contact brut
   * @returns {Object}
   */
  normalizeContact(rawContact) {
    return {
      id: rawContact.id,
      name: rawContact.profile?.name || rawContact.business_profile?.name || '',
      phoneNumber: this.extractPhoneNumber(rawContact.id),
      avatar: '',
      status: rawContact.business_profile?.about || '',
      isBlocked: false,
      isBusiness: !!rawContact.business_profile
    };
  }

  // ==================== Helpers ====================

  /**
   * Extrait le numéro de téléphone d'un JID ou string
   * @param {string} input - Input à normaliser
   * @returns {string}
   */
  extractPhoneNumber(input) {
    if (!input) return '';
    
    // Retirer @s.whatsapp.net, @c.us ou @g.us si présent
    let number = input.replace('@s.whatsapp.net', '').replace('@c.us', '').replace('@g.us', '');
    
    // Retirer tous les caractères non numériques
    number = number.replace(/\D/g, '');
    
    return number;
  }

  /**
   * Obtient le type MIME d'un fichier
   * @param {string} filename - Nom du fichier
   * @returns {string}
   */
  getMimeType(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const mimeTypes = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'mp4': 'video/mp4',
      'mp3': 'audio/mpeg',
      'ogg': 'audio/ogg',
      'pdf': 'application/pdf',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * Obtient l'extension d'un type MIME
   * @param {string} mimeType - Type MIME
   * @returns {string}
   */
  getExtension(mimeType) {
    const extensions = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'video/mp4': 'mp4',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'application/pdf': 'pdf'
    };
    return extensions[mimeType] || 'bin';
  }

  /**
   * Extrait le retry-after des headers
   * @param {Object} headers - Headers de la réponse
   * @returns {number}
   */
  extractRetryAfter(headers) {
    const retryAfter = headers['retry-after'] || headers['x-business-use-case-usage'];
    if (retryAfter) {
      try {
        const usage = JSON.parse(retryAfter);
        // Trouver le temps d'attente maximal
        let maxWait = 0;
        Object.values(usage).forEach(limit => {
          if (limit.estimated_time_to_regain_access) {
            maxWait = Math.max(maxWait, limit.estimated_time_to_regain_access);
          }
        });
        return maxWait;
      } catch (e) {
        return parseInt(retryAfter) || 60;
      }
    }
    return 60; // Par défaut 60 secondes
  }

  /**
   * Obtient le nom du provider
   * @returns {string}
   */
  getProviderName() {
    return 'meta';
  }

  /**
   * Obtient les capacités du provider
   * @returns {Object}
   */
  getCapabilities() {
    return {
      sendText: true,
      sendMedia: true,
      sendDocument: true,
      sendLocation: true,
      sendContact: true,
      sendSticker: true,
      reactions: true,
      typing: false, // Meta ne supporte pas les indicateurs de frappe
      presence: false, // Meta ne supporte pas la présence
      groups: true,
      broadcasts: true,
      calls: false,
      status: true,
      templates: true, // Meta requiert des templates
      interactive: true // Boutons et listes
    };
  }

  /**
   * Obtient les limites du provider
   * @returns {Object}
   */
  getLimits() {
    return {
      messageLength: 4096,
      mediaSize: 100 * 1024 * 1024, // 100MB
      documentSize: 100 * 1024 * 1024, // 100MB
      rateLimit: {
        messages: 1000, // Par défaut, varie selon le tier
        window: 3600, // 1 heure
        business: {
          tier1: { messages: 1000, window: 3600 },
          tier2: { messages: 10000, window: 3600 },
          tier3: { messages: 100000, window: 3600 },
          tier4: { messages: 'unlimited', window: 3600 }
        }
      },
      templates: {
        maxPerAccount: 250,
        maxVariables: 50
      }
    };
  }
}

module.exports = MetaCloudProvider;