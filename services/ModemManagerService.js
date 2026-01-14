/**
 * ModemManagerService - Gestion des modems GSM
 *
 * Service central pour la gestion de plusieurs modems USB.
 * Fonctionnalités:
 * - Détection automatique des modems
 * - Load balancing pour envoi SMS
 * - Failover automatique
 * - Monitoring du signal et de l'état
 */

const EventEmitter = require('events');
const ModemDetector = require('../providers/sms/modem/ModemDetector');
const AtCommandProvider = require('../providers/sms/modem/AtCommandProvider');
const GammuModemProvider = require('../providers/sms/modem/GammuModemProvider');

class ModemManagerService extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      autoDetect: config.autoDetect !== false,
      useGammu: config.useGammu || false,
      watchInterval: config.watchInterval || 30000,
      modemsConfig: config.modems || [],
      ...config,
    };

    this.detector = new ModemDetector();
    this.modems = new Map();  // id -> { provider, config, status }
    this.roundRobinIndex = 0;
    this.isRunning = false;
  }

  /**
   * Démarre le service
   */
  async start() {
    if (this.isRunning) {
      return;
    }

    console.log('ModemManagerService: Starting...');

    // Configurer les événements du détecteur
    this.detector.on('modem_connected', (modem) => {
      console.log(`ModemManagerService: Modem connected - ${modem.device}`);
      this.handleModemConnected(modem);
    });

    this.detector.on('modem_disconnected', (modem) => {
      console.log(`ModemManagerService: Modem disconnected - ${modem.device}`);
      this.handleModemDisconnected(modem);
    });

    // Initialiser les modems configurés manuellement
    for (const modemConfig of this.config.modemsConfig) {
      if (modemConfig.enabled !== false) {
        await this.addModem(modemConfig);
      }
    }

    // Démarrer la détection automatique si activée
    if (this.config.autoDetect) {
      this.detector.startWatching(this.config.watchInterval);
    }

    this.isRunning = true;
    this.emit('started');
  }

  /**
   * Arrête le service
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    console.log('ModemManagerService: Stopping...');

    this.detector.stopWatching();

    // Fermer tous les modems
    for (const [id, modem] of this.modems) {
      try {
        await modem.provider.close();
      } catch (error) {
        console.error(`Error closing modem ${id}:`, error);
      }
    }

    this.modems.clear();
    this.isRunning = false;
    this.emit('stopped');
  }

  /**
   * Ajoute un modem manuellement
   */
  async addModem(config) {
    const id = config.id || `modem_${config.device.replace(/\//g, '_')}`;

    if (this.modems.has(id)) {
      console.log(`ModemManagerService: Modem ${id} already exists`);
      return this.modems.get(id);
    }

    try {
      // Créer le provider approprié
      const provider = config.useGammu || this.config.useGammu
        ? new GammuModemProvider(config)
        : new AtCommandProvider(config);

      // Configurer les événements
      provider.on('sms_received', (sms) => {
        this.emit('sms_received', { modemId: id, ...sms });
      });

      provider.on('error', (error) => {
        console.error(`Modem ${id} error:`, error);
        this.updateModemStatus(id, 'error', error.message);
      });

      provider.on('ready', (info) => {
        this.updateModemStatus(id, 'connected', null, info);
      });

      // Initialiser le provider
      await provider.initialize();

      const modemData = {
        id,
        provider,
        config,
        status: 'connected',
        info: provider.modemInfo || {},
        lastActivity: new Date(),
      };

      this.modems.set(id, modemData);
      this.emit('modem_added', modemData);

      console.log(`ModemManagerService: Modem ${id} added successfully`);
      return modemData;
    } catch (error) {
      console.error(`ModemManagerService: Failed to add modem ${id}:`, error);
      throw error;
    }
  }

  /**
   * Supprime un modem
   */
  async removeModem(id) {
    const modem = this.modems.get(id);
    if (!modem) {
      return;
    }

    try {
      await modem.provider.close();
    } catch (error) {
      console.error(`Error closing modem ${id}:`, error);
    }

    this.modems.delete(id);
    this.emit('modem_removed', { id });
  }

  /**
   * Gère la connexion d'un modem détecté automatiquement
   */
  async handleModemConnected(modem) {
    // Vérifier si c'est un port AT
    if (!modem.isAtPort) {
      return;
    }

    // Chercher une config correspondante
    const config = this.config.modemsConfig.find(
      c => c.device === modem.device || c.id === modem.id
    );

    if (config && config.enabled === false) {
      return;
    }

    try {
      await this.addModem({
        ...config,
        id: modem.id,
        device: modem.device,
        type: modem.type,
      });
    } catch (error) {
      console.error(`Failed to initialize detected modem:`, error);
    }
  }

  /**
   * Gère la déconnexion d'un modem
   */
  async handleModemDisconnected(modem) {
    await this.removeModem(modem.id);
  }

  /**
   * Met à jour le statut d'un modem
   */
  updateModemStatus(id, status, error = null, info = null) {
    const modem = this.modems.get(id);
    if (modem) {
      modem.status = status;
      modem.error = error;
      if (info) {
        modem.info = { ...modem.info, ...info };
      }
      this.emit('modem_status_changed', { id, status, error, info: modem.info });
    }
  }

  /**
   * Envoie un SMS via un modem disponible
   */
  async sendSms(to, message, options = {}) {
    const modemId = options.modemId;

    // Si un modem spécifique est demandé
    if (modemId) {
      const modem = this.modems.get(modemId);
      if (!modem || modem.status !== 'connected') {
        throw new Error(`Modem ${modemId} not available`);
      }

      return this.sendSmsViaModem(modem, to, message);
    }

    // Sinon, utiliser le load balancing
    const availableModems = this.getAvailableModems();
    if (availableModems.length === 0) {
      throw new Error('No modems available');
    }

    // Round-robin simple
    const modem = availableModems[this.roundRobinIndex % availableModems.length];
    this.roundRobinIndex++;

    try {
      return await this.sendSmsViaModem(modem, to, message);
    } catch (error) {
      // Failover: essayer les autres modems
      for (const altModem of availableModems) {
        if (altModem.id !== modem.id) {
          try {
            return await this.sendSmsViaModem(altModem, to, message);
          } catch (e) {
            continue;
          }
        }
      }

      throw error;
    }
  }

  /**
   * Envoie un SMS via un modem spécifique
   */
  async sendSmsViaModem(modem, to, message) {
    const result = await modem.provider.sendSms(to, message);

    modem.lastActivity = new Date();

    this.emit('sms_sent', {
      modemId: modem.id,
      to,
      message,
      result,
    });

    return {
      ...result,
      modemId: modem.id,
    };
  }

  /**
   * Récupère les modems disponibles
   */
  getAvailableModems() {
    return Array.from(this.modems.values())
      .filter(m => m.status === 'connected');
  }

  /**
   * Récupère le statut de tous les modems
   */
  getAllModemsStatus() {
    const status = [];

    for (const [id, modem] of this.modems) {
      status.push({
        id,
        device: modem.config.device,
        type: modem.config.type,
        status: modem.status,
        error: modem.error,
        info: modem.info,
        lastActivity: modem.lastActivity,
      });
    }

    return status;
  }

  /**
   * Récupère le statut d'un modem
   */
  async getModemStatus(modemId) {
    const modem = this.modems.get(modemId);
    if (!modem) {
      throw new Error(`Modem ${modemId} not found`);
    }

    try {
      const signal = await modem.provider.getSignalStrength();
      const network = await modem.provider.getNetworkInfo();

      return {
        id: modem.id,
        device: modem.config.device,
        status: modem.status,
        info: modem.info,
        signal,
        network,
        lastActivity: modem.lastActivity,
      };
    } catch (error) {
      return {
        id: modem.id,
        device: modem.config.device,
        status: modem.status,
        error: error.message,
        lastActivity: modem.lastActivity,
      };
    }
  }

  /**
   * Lit les SMS d'un modem
   */
  async readSms(modemId, status = 'ALL') {
    const modem = this.modems.get(modemId);
    if (!modem) {
      throw new Error(`Modem ${modemId} not found`);
    }

    if (modem.provider.readAllSms) {
      return modem.provider.readAllSms();
    } else {
      return modem.provider.readSms(status);
    }
  }

  /**
   * Supprime un SMS
   */
  async deleteSms(modemId, index) {
    const modem = this.modems.get(modemId);
    if (!modem) {
      throw new Error(`Modem ${modemId} not found`);
    }

    return modem.provider.deleteSms(index);
  }

  /**
   * Scan les ports pour détecter les modems
   */
  async scanModems() {
    return this.detector.detectModems();
  }

  /**
   * Retourne les modems détectés mais non initialisés
   */
  getDetectedModems() {
    const detected = this.detector.getDetectedModems();
    const initializedIds = new Set(this.modems.keys());

    return detected.filter(m => !initializedIds.has(m.id));
  }

  /**
   * Récupère un modem par son ID
   */
  getModem(modemId) {
    return this.modems.get(modemId);
  }
}

// Singleton
let instance = null;

function getModemManager(config = {}) {
  if (!instance) {
    instance = new ModemManagerService(config);
  }
  return instance;
}

module.exports = { ModemManagerService, getModemManager };
