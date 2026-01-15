const fs = require('fs').promises;
const path = require('path');
const logger = require('winston');
const configService = require('./ConfigurationService');

/**
 * Gestionnaire des providers WhatsApp/SMS/VoIP
 * Singleton qui gère le chargement, la configuration et le basculement des providers
 *
 * v2.0: Support YAML configuration via ConfigurationService
 */
class ProviderManager {
  constructor() {
    if (ProviderManager.instance) {
      return ProviderManager.instance;
    }

    this.providers = new Map();
    this.activeProviders = new Set(); // Support multi-sessions
    this.config = null;
    this.configPath = path.join(__dirname, '../config/providers.json');
    this.useYamlConfig = true; // Utiliser le nouveau système YAML

    ProviderManager.instance = this;
  }

  /**
   * Initialise le manager avec la configuration
   */
  async initialize() {
    try {
      // Charger la configuration
      await this.loadConfig();

      // Charger tous les providers disponibles
      await this.loadProviders();

      // Activer le provider par défaut
      if (this.config.defaultProvider) {
        await this.setActiveProvider(this.config.defaultProvider);
      }

      logger.info('ProviderManager initialized successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize ProviderManager:', error);
      throw error;
    }
  }

  /**
   * Charge la configuration depuis le fichier (YAML ou JSON legacy)
   */
  async loadConfig() {
    try {
      if (this.useYamlConfig) {
        // Nouveau système YAML v2.0
        await configService.load();

        // Convertir au format legacy pour compatibilité
        this.config = configService.getLegacyFormat();

        // Activer le hot-reload
        configService.watch();
        configService.onChange(async (newConfig) => {
          logger.info('[ProviderManager] Configuration hot-reloaded');
          this.config = configService.getLegacyFormat();
          // Recharger les providers actifs si nécessaire
          await this.reloadEnabledProviders();
        });

        logger.info('[ProviderManager] YAML configuration loaded via ConfigurationService');
      } else {
        // Legacy JSON loading
        const configData = await fs.readFile(this.configPath, 'utf8');
        this.config = JSON.parse(configData);

        // Force update from env vars for sensitive/dynamic data
        if (process.env.PWA_API_TOKEN && this.config.providers['sms-bridge']) {
          this.config.providers['sms-bridge'].apiToken = process.env.PWA_API_TOKEN;
        }

        logger.info('Provider configuration loaded (legacy JSON)');
      }
    } catch (error) {
      // Si pas de config, créer une config par défaut
      logger.warn('No provider config found, creating default');
      this.config = {
        defaultProvider: 'baileys',
        providers: {
          baileys: {
            enabled: true,
            sessionName: process.env.BAILEYS_SESSION_NAME || 'lekipchat',
            webhookUrl: process.env.WEBHOOK_URL || ''
          },
          meta: {
            enabled: false,
            accessToken: process.env.META_ACCESS_TOKEN || '',
            phoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
            businessAccountId: process.env.META_BUSINESS_ACCOUNT_ID || '',
            webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || ''
          },
          'sms-bridge': {
            enabled: false, // Disabled by default - enable only if SMS trunk is configured
            apiUrl: process.env.SMS_BRIDGE_URL || 'https://192.168.1.155:8443',
            apiToken: process.env.PWA_API_TOKEN || '',
            syncIntervalMs: 5000,
            maxSyncIntervalMs: 60000 // Max 1 min between polls on error
          }
        }
      };
      await this.saveConfig();
    }
  }

  /**
   * Recharge les providers activés après un hot-reload
   */
  async reloadEnabledProviders() {
    for (const [name, provider] of this.providers) {
      const providerConfig = this.config.providers[name];
      if (providerConfig?.enabled && !this.activeProviders.has(name)) {
        // Provider nouvellement activé
        try {
          await provider.initialize(providerConfig);
          this.activeProviders.add(name);
          logger.info(`[ProviderManager] Provider '${name}' activated via hot-reload`);
        } catch (error) {
          logger.error(`[ProviderManager] Failed to activate '${name}':`, error);
        }
      } else if (!providerConfig?.enabled && this.activeProviders.has(name)) {
        // Provider désactivé
        try {
          if (typeof provider.disconnect === 'function') {
            await provider.disconnect();
          }
          this.activeProviders.delete(name);
          logger.info(`[ProviderManager] Provider '${name}' deactivated via hot-reload`);
        } catch (error) {
          logger.error(`[ProviderManager] Failed to deactivate '${name}':`, error);
        }
      }
    }
  }

  /**
   * Sauvegarde la configuration
   */
  async saveConfig() {
    try {
      if (this.useYamlConfig) {
        // Le YAML est géré par ConfigurationService
        // La config legacy est convertie automatiquement
        logger.info('[ProviderManager] Configuration saved via ConfigurationService');
        return;
      }

      // Legacy JSON save
      const configDir = path.dirname(this.configPath);
      await fs.mkdir(configDir, { recursive: true });

      await fs.writeFile(
        this.configPath,
        JSON.stringify(this.config, null, 2),
        'utf8'
      );
      logger.info('Provider configuration saved');
    } catch (error) {
      logger.error('Failed to save provider config:', error);
      throw error;
    }
  }

  /**
   * Retourne le ConfigurationService pour accès direct
   */
  getConfigService() {
    return configService;
  }

  /**
   * Helper pour attacher les événements
   */
  _attachProviderEvents(name, provider) {
    if (typeof provider.setEventHandler === 'function') {
      provider.setEventHandler((event, data) => {
        // Re-émettre l'événement globalement
        this.emit(event, { provider: name, ...data });
        // Re-émettre l'événement avec namespace
        this.emit(`${name}:${event}`, data);
      });
    }
  }

  /**
   * Charge tous les providers disponibles
   */
  async loadProviders() {
    const providerFiles = {
      baileys: '../providers/baileys/BaileysProvider.js',
      meta: '../providers/meta/MetaCloudProvider.js',
      'sms-bridge': '../providers/sms/SmsBridgeProvider.js'
    };

    for (const [name, filePath] of Object.entries(providerFiles)) {
      try {
        const ProviderClass = require(filePath);
        const provider = new ProviderClass(this.config.providers[name] || {});

        this._attachProviderEvents(name, provider);
        this.providers.set(name, provider);

        logger.info(`Provider '${name}' loaded`);

        if (this.config.providers[name]?.enabled) {
          await provider.initialize();
          this.activeProviders.add(name);
        }
      } catch (error) {
        logger.error(`Failed to load provider '${name}':`, error);
      }
    }
  }

  /**
   * Charge un seul provider
   * @param {string} providerName - Nom du provider à charger
   */
  async loadSingleProvider(providerName) {
    const providerFiles = {
      baileys: '../providers/baileys/BaileysProvider.js',
      meta: '../providers/meta/MetaCloudProvider.js',
      'sms-bridge': '../providers/sms/SmsBridgeProvider.js'
    };

    const filePath = providerFiles[providerName];
    if (!filePath) {
      throw new Error(`Unknown provider '${providerName}'`);
    }

    try {
      // Toujours vérifier si la config permet ce provider
      // if (this.config.providers[providerName]?.enabled) { // Supprimé pour permettre chargement dynamique
      const ProviderClass = require(filePath);
      const provider = new ProviderClass(this.config.providers[providerName]);

      this._attachProviderEvents(providerName, provider);
      this.providers.set(providerName, provider);

      logger.info(`Provider '${providerName}' loaded`);
      return provider;
      // }
    } catch (error) {
      logger.error(`Failed to load provider '${providerName}':`, error);
      throw error;
    }
  }

  /**
   * Définit le provider actif
   * @param {string} providerName - Nom du provider à activer
   */
  async setActiveProvider(providerName) {
    const provider = this.providers.get(providerName);

    if (!provider) {
      throw new Error(`Provider '${providerName}' not found or not enabled`);
    }

    // Déconnecter l'ancien provider si nécessaire
    if (this.activeProvider && this.activeProvider !== provider) {
      try {
        await this.activeProvider.logout();
      } catch (error) {
        logger.error('Error disconnecting previous provider:', error);
      }
    }

    // Initialiser le nouveau provider
    try {
      await provider.initialize(this.config.providers[providerName]);
      this.activeProvider = provider;
      this.activeProviders.add(providerName);

      // Ensure it is enabled in config
      if (!this.config.providers[providerName]) {
        this.config.providers[providerName] = {};
      }
      this.config.providers[providerName].enabled = true;

      this.config.defaultProvider = providerName;
      await this.saveConfig();

      logger.info(`Active provider set to '${providerName}'`);

      // Émettre un événement de changement
      this.emit('providerChanged', {
        previous: this.activeProvider?.getProviderName(),
        current: providerName
      });

      return true;
    } catch (error) {
      logger.error(`Failed to initialize provider '${providerName}':`, error);
      throw error;
    }
  }

  /**
   * Obtient le provider principal (premier actif ou par défaut)
   * @returns {WhatsAppProvider} Provider principal
   */
  getActiveProvider() {
    if (this.activeProviders.size === 0) {
      // Fallback: prendre le provider par défaut s'il existe
      const defaultProvider = this.config.defaultProvider;
      if (defaultProvider && this.providers.has(defaultProvider)) {
        return this.providers.get(defaultProvider);
      }
      throw new Error('No active provider set');
    }
    // Retourner le premier provider actif
    const firstActive = Array.from(this.activeProviders)[0];
    return this.providers.get(firstActive);
  }

  /**
   * Obtient tous les providers actifs
   * @returns {Map} Map des providers actifs
   */
  getActiveProviders() {
    const activeMap = new Map();
    for (const providerName of this.activeProviders) {
      if (this.providers.has(providerName)) {
        activeMap.set(providerName, this.providers.get(providerName));
      }
    }
    return activeMap;
  }

  /**
   * Obtient le QR code pour un provider Baileys
   * @param {string} providerId - ID du provider (ex: 'baileys')
   * @returns {string|null} QR code en base64 ou null
   */
  async getQrCode(providerId) {
    const provider = this.providers.get(providerId) || this.providers.get('baileys');
    if (provider && typeof provider.getQRCode === 'function') {
      return await provider.getQRCode();
    }
    return null;
  }

  /**
   * Obtient la liste des providers disponibles
   * @returns {Object} Liste des providers avec leur statut
   */
  getAvailableProviders() {
    const available = {};

    for (const [name, config] of Object.entries(this.config.providers)) {
      available[name] = {
        enabled: config.enabled,
        active: this.activeProviders.has(name),
        initialized: this.providers.has(name),
        capabilities: this.providers.get(name)?.getCapabilities() || null
      };
    }

    return available;
  }

  /**
   * Active un provider spécifique
   * @param {string} providerName Nom du provider
   */
  async activateProvider(providerName) {
    if (!this.providers.has(providerName)) {
      throw new Error(`Provider '${providerName}' not found`);
    }

    const provider = this.providers.get(providerName);

    if (!this.activeProviders.has(providerName)) {
      // Passer la configuration lors de l'initialisation
      const providerConfig = this.config.providers[providerName] || {};
      await provider.initialize(providerConfig);
      this.activeProviders.add(providerName);

      // Mettre à jour la config
      if (!this.config.providers[providerName]) {
        this.config.providers[providerName] = {};
      }
      this.config.providers[providerName].enabled = true;
      await this.saveConfig();

      logger.info(`Provider '${providerName}' activated`);
    }
  }

  /**
   * Désactive un provider spécifique
   * @param {string} providerName Nom du provider
   */
  async deactivateProvider(providerName) {
    if (this.activeProviders.has(providerName)) {
      const provider = this.providers.get(providerName);
      if (provider && typeof provider.disconnect === 'function') {
        await provider.disconnect();
      }
      this.activeProviders.delete(providerName);

      // Mettre à jour la config
      if (this.config.providers[providerName]) {
        this.config.providers[providerName].enabled = false;
        await this.saveConfig();
      }

      logger.info(`Provider '${providerName}' deactivated`);
    }
  }

  /**
   * Met à jour la configuration d'un provider
   * @param {string} providerName - Nom du provider
   * @param {Object} config - Nouvelle configuration
   */
  async updateProviderConfig(providerName, config) {
    if (!this.config.providers[providerName]) {
      throw new Error(`Provider '${providerName}' not found`);
    }

    const oldConfig = { ...this.config.providers[providerName] };

    this.config.providers[providerName] = {
      ...this.config.providers[providerName],
      ...config
    };

    await this.saveConfig();

    // Gérer les changements d'état enabled
    const wasEnabled = oldConfig.enabled;
    const isEnabled = this.config.providers[providerName].enabled;

    if (wasEnabled && !isEnabled) {
      // Désactiver le provider
      if (this.providers.has(providerName)) {
        const provider = this.providers.get(providerName);
        try {
          if (provider.logout) await provider.logout();
        } catch (error) {
          logger.error(`Error during provider logout: ${error.message}`);
        }
        this.providers.delete(providerName);
        logger.info(`Provider '${providerName}' disabled and removed`);
      }

      // Si c'était le provider actif, basculer vers un autre
      if (this.activeProvider?.getProviderName() === providerName) {
        const availableProvider = Array.from(this.providers.keys())[0];
        if (availableProvider) {
          await this.setActiveProvider(availableProvider);
          logger.info(`Switched to provider '${availableProvider}' after disabling '${providerName}'`);
        } else {
          this.activeProvider = null;
          logger.warn('No active provider available after disabling');
        }
      }
    } else if (!wasEnabled && isEnabled) {
      // Activer le provider
      await this.loadSingleProvider(providerName);
    } else if (isEnabled && this.activeProvider?.getProviderName() === providerName) {
      // Provider toujours actif, le réinitialiser avec la nouvelle config
      await this.setActiveProvider(providerName);
    }

    return true;
  }

  /**
   * Teste la connexion d'un provider
   * @param {string} providerName - Nom du provider à tester
   */
  async testProviderConnection(providerName) {
    const provider = this.providers.get(providerName);

    if (!provider) {
      // Essayer de charger temporairement le provider pour le test
      const providerFiles = {
        meta: '../providers/meta/MetaCloudProvider.js'
      };

      if (!providerFiles[providerName]) {
        throw new Error(`Unknown provider '${providerName}'`);
      }

      try {
        const ProviderClass = require(providerFiles[providerName]);
        const tempProvider = new ProviderClass(this.config.providers[providerName]);
        await tempProvider.initialize(this.config.providers[providerName]);
        return await tempProvider.testConnection();
      } catch (error) {
        return {
          success: false,
          message: error.message
        };
      }
    }

    return await provider.testConnection();
  }

  /**
   * Méthodes proxy vers le provider actif
   */

  async sendTextMessage(...args) {
    return this.getActiveProvider().sendTextMessage(...args);
  }

  async sendMediaMessage(...args) {
    return this.getActiveProvider().sendMediaMessage(...args);
  }

  async sendDocument(...args) {
    return this.getActiveProvider().sendDocument(...args);
  }

  async getMessages(...args) {
    return this.getActiveProvider().getMessages(...args);
  }

  async getChats(...args) {
    return this.getActiveProvider().getChats(...args);
  }

  async getChatInfo(...args) {
    return this.getActiveProvider().getChatInfo(...args);
  }

  async getContacts(...args) {
    return this.getActiveProvider().getContacts(...args);
  }

  async getConnectionState(...args) {
    return this.getActiveProvider().getConnectionState(...args);
  }

  async checkNumberExists(...args) {
    return this.getActiveProvider().checkNumberExists(...args);
  }

  /**
   * Marque un chat comme lu
   * @param {string} chatId - ID du chat
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async markChatAsRead(chatId) {
    return this.getActiveProvider().markChatAsRead(chatId);
  }

  /**
   * Marque un message comme lu
   * @param {string} chatId - ID du chat
   * @param {string} messageId - ID du message
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async markMessageAsRead(chatId, messageId) {
    return this.getActiveProvider().markMessageAsRead(chatId, messageId);
  }

  /**
   * Envoie une réaction emoji
   * @param {string} chatId - ID du chat
   * @param {string} messageId - ID du message
   * @param {string} emoji - Emoji (vide pour supprimer)
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async sendReaction(chatId, messageId, emoji) {
    return this.getActiveProvider().sendReaction(chatId, messageId, emoji);
  }

  /**
   * Teste la connexion du provider actif
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async testConnection() {
    return this.getActiveProvider().testConnection();
  }

  /**
   * Récupère le QR code (Baileys) ou null (Meta)
   * @returns {Promise<string|null>}
   */
  async getQRCode() {
    return this.getActiveProvider().getQRCode();
  }

  /**
   * Déconnecte le provider actif
   * @returns {Promise<{success: boolean}>}
   */
  async logout() {
    return this.getActiveProvider().logout();
  }

  async handleWebhook(providerName, data) {
    let provider = this.providers.get(providerName);

    if (!provider) {
      // Vérifier si le provider est configuré mais pas chargé
      if (this.config.providers[providerName] && this.config.providers[providerName].enabled) {
        // Charger temporairement le provider pour traiter le webhook
        try {
          provider = await this.loadSingleProvider(providerName);
        } catch (error) {
          throw new Error(`Provider '${providerName}' not configured: ${error.message}`);
        }
      } else {
        throw new Error(`Meta provider not configured`);
      }
    }

    return await provider.handleWebhook(data);
  }

  // ==================== Événements ====================

  /**
   * Gestionnaires d'événements
   */
  eventHandlers = new Map();

  /**
   * S'abonne à un événement
   * @param {string} event - Nom de l'événement
   * @param {Function} handler - Gestionnaire
   */
  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(handler);
  }

  /**
   * Émet un événement
   * @param {string} event - Nom de l'événement
   * @param {Object} data - Données de l'événement
   */
  emit(event, data) {
    const handlers = this.eventHandlers.get(event) || [];
    handlers.forEach(handler => {
      try {
        handler(data);
      } catch (error) {
        logger.error(`Error in event handler for '${event}':`, error);
      }
    });
  }

  /**
   * Obtient l'état de santé du système
   */
  async getHealthStatus() {
    const status = {
      activeProvider: this.activeProvider?.getProviderName() || 'none',
      providers: {}
    };
    logger.info(`Health Check - ActiveProvider: ${status.activeProvider}, ActiveProviders Set: ${Array.from(this.activeProviders)}`);

    for (const [name, provider] of this.providers) {
      try {
        const connectionState = await provider.getConnectionState();
        status.providers[name] = {
          initialized: true,
          connected: connectionState.state === 'open' || connectionState.state === 'connected',
          state: connectionState.state
        };
      } catch (error) {
        status.providers[name] = {
          initialized: true,
          connected: false,
          error: error.message
        };
      }
    }

    return status;
  }
}

// Export singleton
module.exports = new ProviderManager();