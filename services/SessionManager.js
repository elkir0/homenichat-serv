const EventEmitter = require('events');
const logger = require('../utils/logger');
const path = require('path');
const fs = require('fs').promises;

/**
 * Gestionnaire des sessions multi-comptes WhatsApp
 * Permet de gérer plusieurs instances WhatsApp simultanément
 */
class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map(); // sessionId -> { provider, config, state }
    this.activeSessionId = null;
    this.configPath = path.join(__dirname, '../config/sessions.json');
    this.providerFiles = {
      baileys: '../providers/baileys/BaileysProvider.js',
      meta: '../providers/meta/MetaCloudProvider.js'
    };
  }

  /**
   * Initialise le gestionnaire de sessions
   */
  async initialize() {
    try {
      await this.loadSessionsConfig();
      await this.initializeSessions();
      logger.info('SessionManager initialized successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize SessionManager:', error);
      throw error;
    }
  }

  /**
   * Charge la configuration des sessions
   */
  async loadSessionsConfig() {
    try {
      const configData = await fs.readFile(this.configPath, 'utf8');
      this.config = JSON.parse(configData);
    } catch (error) {
      // Configuration par défaut si le fichier n'existe pas
      this.config = {
        sessions: {},
        activeSessionId: null
      };
      await this.saveConfig();
    }
  }

  /**
   * Sauvegarde la configuration
   */
  async saveConfig() {
    const configData = {
      sessions: {},
      activeSessionId: this.activeSessionId
    };

    // Sauvegarder uniquement les métadonnées des sessions
    for (const [sessionId, session] of this.sessions) {
      configData.sessions[sessionId] = {
        name: session.name,
        providerType: session.providerType,
        phoneNumber: session.phoneNumber,
        config: session.config,
        enabled: session.enabled,
        createdAt: session.createdAt
      };
    }

    await fs.writeFile(this.configPath, JSON.stringify(configData, null, 2), 'utf8');
  }

  /**
   * Initialise toutes les sessions configurées
   */
  async initializeSessions() {
    for (const [sessionId, sessionConfig] of Object.entries(this.config.sessions)) {
      if (sessionConfig.enabled) {
        try {
          await this.createSession(sessionId, sessionConfig);
        } catch (error) {
          logger.error(`Failed to initialize session ${sessionId}:`, error);
        }
      }
    }

    // Définir la session active
    if (this.config.activeSessionId && this.sessions.has(this.config.activeSessionId)) {
      this.activeSessionId = this.config.activeSessionId;
    } else if (this.sessions.size > 0) {
      // Prendre la première session disponible
      this.activeSessionId = Array.from(this.sessions.keys())[0];
    }
  }

  /**
   * Crée une nouvelle session
   */
  async createSession(sessionId, config) {
    const { providerType, name, phoneNumber, config: providerConfig, enabled = true } = config;

    if (!this.providerFiles[providerType]) {
      throw new Error(`Unknown provider type: ${providerType}`);
    }

    // Charger la classe du provider
    const ProviderClass = require(this.providerFiles[providerType]);
    
    // Créer une instance du provider avec une configuration spécifique à la session
    const provider = new ProviderClass({
      ...providerConfig,
      sessionId // Passer l'ID de session au provider
    });

    // Initialiser le provider
    await provider.initialize(providerConfig);

    // Stocker la session
    const session = {
      id: sessionId,
      name: name || `Session ${sessionId}`,
      phoneNumber,
      providerType,
      provider,
      config: providerConfig,
      enabled,
      state: 'initialized',
      createdAt: config.createdAt || new Date().toISOString(),
      lastActivity: new Date().toISOString()
    };

    this.sessions.set(sessionId, session);
    
    // Écouter les événements du provider
    this.setupProviderListeners(sessionId, provider);

    // Sauvegarder la configuration
    await this.saveConfig();

    logger.info(`Session ${sessionId} created successfully`);
    this.emit('sessionCreated', { sessionId, session });

    return session;
  }

  /**
   * Configure les écouteurs d'événements pour un provider
   */
  setupProviderListeners(sessionId, provider) {
    // Transmettre les événements du provider avec l'ID de session
    const events = ['message', 'messageStatus', 'connectionStateChanged', 'qr'];
    
    events.forEach(eventName => {
      if (provider.on) {
        provider.on(eventName, (data) => {
          this.emit(eventName, { sessionId, data });
        });
      }
    });
  }

  /**
   * Supprime une session
   */
  async deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Déconnecter le provider
    if (session.provider && session.provider.logout) {
      try {
        await session.provider.logout();
      } catch (error) {
        logger.error(`Error disconnecting session ${sessionId}:`, error);
      }
    }

    // Supprimer la session
    this.sessions.delete(sessionId);

    // Si c'était la session active, en sélectionner une autre
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.sessions.size > 0 ? 
        Array.from(this.sessions.keys())[0] : null;
    }

    await this.saveConfig();
    this.emit('sessionDeleted', { sessionId });

    logger.info(`Session ${sessionId} deleted`);
  }

  /**
   * Active une session
   */
  async setActiveSession(sessionId) {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} not found`);
    }

    this.activeSessionId = sessionId;
    await this.saveConfig();
    
    this.emit('activeSessionChanged', { sessionId });
    logger.info(`Active session changed to ${sessionId}`);
  }

  /**
   * Obtient la session active
   */
  getActiveSession() {
    if (!this.activeSessionId) {
      throw new Error('No active session');
    }

    const session = this.sessions.get(this.activeSessionId);
    if (!session) {
      throw new Error('Active session not found');
    }

    return session;
  }

  /**
   * Obtient toutes les sessions
   */
  getAllSessions() {
    const sessionsData = [];
    
    for (const [sessionId, session] of this.sessions) {
      sessionsData.push({
        id: sessionId,
        name: session.name,
        phoneNumber: session.phoneNumber,
        providerType: session.providerType,
        state: session.state,
        enabled: session.enabled,
        isActive: sessionId === this.activeSessionId,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity
      });
    }

    return sessionsData;
  }

  /**
   * Obtient une session spécifique
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * Met à jour la configuration d'une session
   */
  async updateSessionConfig(sessionId, updates) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Mettre à jour la configuration
    Object.assign(session, updates);
    
    // Si la configuration du provider a changé, le réinitialiser
    if (updates.config) {
      await session.provider.initialize(updates.config);
    }

    await this.saveConfig();
    this.emit('sessionUpdated', { sessionId, updates });

    return session;
  }

  /**
   * Bascule l'état enabled d'une session
   */
  async toggleSession(sessionId, enabled) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.enabled = enabled;

    if (!enabled && session.provider && session.provider.logout) {
      // Déconnecter si désactivé
      await session.provider.logout();
      session.state = 'disabled';
    } else if (enabled) {
      // Reconnecter si activé
      await session.provider.initialize(session.config);
      session.state = 'initialized';
    }

    await this.saveConfig();
    this.emit('sessionToggled', { sessionId, enabled });
  }

  /**
   * Obtient l'état de connexion d'une session
   */
  async getSessionConnectionState(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.provider) {
      return { state: 'disconnected' };
    }

    try {
      return await session.provider.getConnectionState();
    } catch (error) {
      return { state: 'error', error: error.message };
    }
  }

  /**
   * Méthodes proxy vers la session active
   */
  async sendTextMessage(to, text, options = {}) {
    const session = options.sessionId ? 
      this.getSession(options.sessionId) : 
      this.getActiveSession();
    
    session.lastActivity = new Date().toISOString();
    return session.provider.sendTextMessage(to, text, options);
  }

  async sendMediaMessage(to, media, options = {}) {
    const session = options.sessionId ? 
      this.getSession(options.sessionId) : 
      this.getActiveSession();
    
    session.lastActivity = new Date().toISOString();
    return session.provider.sendMediaMessage(to, media, options);
  }

  async getChats(options = {}) {
    const session = options.sessionId ? 
      this.getSession(options.sessionId) : 
      this.getActiveSession();
    
    return session.provider.getChats(options);
  }

  async getMessages(chatId, options = {}) {
    const session = options.sessionId ? 
      this.getSession(options.sessionId) : 
      this.getActiveSession();
    
    return session.provider.getMessages(chatId, options);
  }

  /**
   * Gère les webhooks en routant vers la bonne session
   */
  async handleWebhook(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found for webhook`);
    }

    session.lastActivity = new Date().toISOString();
    return session.provider.handleWebhook(data);
  }

  /**
   * Obtient les statistiques globales
   */
  getGlobalStats() {
    const stats = {
      totalSessions: this.sessions.size,
      activeSessions: 0,
      messageCount: 0,
      providerBreakdown: {}
    };

    for (const session of this.sessions.values()) {
      if (session.enabled && session.state === 'connected') {
        stats.activeSessions++;
      }

      if (!stats.providerBreakdown[session.providerType]) {
        stats.providerBreakdown[session.providerType] = 0;
      }
      stats.providerBreakdown[session.providerType]++;
    }

    return stats;
  }
}

// Export singleton
module.exports = new SessionManager();