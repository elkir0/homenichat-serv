/**
 * ConfigurationService - Gestion de configuration YAML avec hot-reload
 *
 * Fonctionnalités:
 * - Chargement configuration YAML
 * - Interpolation variables d'environnement ${VAR_NAME}
 * - Validation schema JSON
 * - Hot-reload sur modification fichier
 * - Migration automatique JSON -> YAML
 */

const yaml = require('js-yaml');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const chokidar = require('chokidar');
const Ajv = require('ajv');
const logger = require('winston');

class ConfigurationService {
  constructor() {
    this.config = null;
    this.configDir = path.join(__dirname, '../config');
    this.yamlPath = path.join(this.configDir, 'providers.yaml');
    this.jsonPath = path.join(this.configDir, 'providers.json');
    this.schemaPath = path.join(this.configDir, 'providers.schema.json');
    this.watcher = null;
    this.changeCallbacks = new Set();
    this.ajv = new Ajv({ allErrors: true, useDefaults: true });
    this.isLoaded = false;
  }

  /**
   * Charge la configuration (YAML prioritaire, fallback JSON)
   */
  async load() {
    try {
      // Vérifier si YAML existe
      if (fs.existsSync(this.yamlPath)) {
        await this.loadYaml();
      } else if (fs.existsSync(this.jsonPath)) {
        // Migration JSON -> YAML
        logger.info('[Config] Migrating JSON to YAML...');
        await this.migrateFromJson();
      } else {
        // Créer config par défaut
        logger.info('[Config] Creating default configuration...');
        await this.createDefaultConfig();
      }

      // Valider la configuration
      await this.validate();

      this.isLoaded = true;
      logger.info('[Config] Configuration loaded successfully');

      return this.config;
    } catch (error) {
      logger.error('[Config] Failed to load configuration:', error);
      throw error;
    }
  }

  /**
   * Charge le fichier YAML
   */
  async loadYaml() {
    const content = await fsPromises.readFile(this.yamlPath, 'utf8');
    const interpolated = this.interpolateEnv(content);
    this.config = yaml.load(interpolated);
    logger.info('[Config] YAML configuration loaded');
  }

  /**
   * Interpole les variables d'environnement ${VAR_NAME}
   */
  interpolateEnv(content) {
    return content.replace(/\$\{(\w+)(?::([^}]*))?\}/g, (match, key, defaultValue) => {
      const value = process.env[key];
      if (value !== undefined) {
        return value;
      }
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      logger.warn(`[Config] Environment variable ${key} not found`);
      return '';
    });
  }

  /**
   * Migre la configuration JSON existante vers YAML
   */
  async migrateFromJson() {
    const jsonContent = await fsPromises.readFile(this.jsonPath, 'utf8');
    const jsonConfig = JSON.parse(jsonContent);

    // Convertir au nouveau format YAML
    this.config = this.convertJsonToYamlFormat(jsonConfig);

    // Sauvegarder en YAML
    await this.save();

    // Renommer l'ancien fichier JSON
    const backupPath = this.jsonPath + '.backup';
    await fsPromises.rename(this.jsonPath, backupPath);
    logger.info(`[Config] JSON config backed up to ${backupPath}`);
  }

  /**
   * Convertit l'ancien format JSON au nouveau format YAML
   */
  convertJsonToYamlFormat(jsonConfig) {
    const yamlConfig = {
      version: '2.0',
      instance: {
        name: "Homenichat",
        timezone: 'Europe/Paris',
        language: 'fr'
      },
      providers: {
        whatsapp: [],
        sms: [],
        voip: []
      }
    };

    // Migrer providers WhatsApp
    if (jsonConfig.providers?.baileys) {
      yamlConfig.providers.whatsapp.push({
        id: 'baileys_main',
        type: 'baileys',
        enabled: jsonConfig.providers.baileys.enabled || false,
        config: {
          session_path: './sessions/baileys',
          session_name: jsonConfig.providers.baileys.sessionName || 'lekipchat',
          sync_history: true
        }
      });
    }

    if (jsonConfig.providers?.meta) {
      yamlConfig.providers.whatsapp.push({
        id: 'meta_cloud',
        type: 'meta_cloud',
        enabled: jsonConfig.providers.meta.enabled || false,
        config: {
          phone_number_id: jsonConfig.providers.meta.phoneNumberId || '${META_PHONE_NUMBER_ID}',
          access_token: jsonConfig.providers.meta.accessToken || '${META_ACCESS_TOKEN}',
          verify_token: jsonConfig.providers.meta.webhookVerifyToken || '${META_VERIFY_TOKEN}',
          webhook_path: '/webhooks/meta'
        }
      });
    }

    // Migrer SMS Bridge
    if (jsonConfig.providers?.['sms-bridge']) {
      yamlConfig.providers.sms.push({
        id: 'sms_bridge',
        type: 'sms_bridge',
        enabled: jsonConfig.providers['sms-bridge'].enabled || false,
        config: {
          api_url: jsonConfig.providers['sms-bridge'].apiUrl || '${SMS_BRIDGE_URL}',
          api_token: '${PWA_API_TOKEN}',
          sync_interval_ms: jsonConfig.providers['sms-bridge'].syncIntervalMs || 5000
        }
      });
    }

    // Ajouter section VoIP par défaut
    yamlConfig.providers.voip.push({
      id: 'freepbx_main',
      type: 'freepbx',
      enabled: false,
      config: {
        host: '${FREEPBX_HOST}',
        ami_port: 5038,
        ami_user: '${AMI_USER}',
        ami_secret: '${AMI_SECRET}',
        webrtc_ws: 'wss://${FREEPBX_HOST}:8089/ws'
      }
    });

    // Compliance France par défaut
    yamlConfig.compliance = {
      sms: {
        france: {
          enabled: true,
          stop_keywords: ['STOP', 'ARRET', 'DESABONNER'],
          time_restrictions: {
            start: '08:00',
            end: '22:00',
            timezone: 'Europe/Paris'
          }
        }
      }
    };

    return yamlConfig;
  }

  /**
   * Crée une configuration par défaut
   */
  async createDefaultConfig() {
    this.config = {
      version: '2.0',
      instance: {
        name: "Homenichat",
        timezone: 'Europe/Paris',
        language: 'fr'
      },
      providers: {
        whatsapp: [
          {
            id: 'baileys_main',
            type: 'baileys',
            enabled: true,
            config: {
              session_path: './sessions/baileys',
              session_name: 'lekipchat',
              sync_history: true
            }
          }
        ],
        sms: [
          {
            id: 'sms_bridge',
            type: 'sms_bridge',
            enabled: true,
            config: {
              api_url: '${SMS_BRIDGE_URL}',
              api_token: '${PWA_API_TOKEN}',
              sync_interval_ms: 5000
            }
          }
        ],
        voip: [
          {
            id: 'freepbx_main',
            type: 'freepbx',
            enabled: false,
            config: {
              host: '${FREEPBX_HOST}',
              ami_port: 5038,
              ami_user: '${AMI_USER}',
              ami_secret: '${AMI_SECRET}',
              webrtc_ws: 'wss://${FREEPBX_HOST}:8089/ws'
            }
          }
        ]
      },
      compliance: {
        sms: {
          france: {
            enabled: true,
            stop_keywords: ['STOP', 'ARRET', 'DESABONNER'],
            time_restrictions: {
              start: '08:00',
              end: '22:00',
              timezone: 'Europe/Paris'
            }
          }
        }
      }
    };

    await this.save();
  }

  /**
   * Valide la configuration contre le schema JSON
   */
  async validate() {
    if (!fs.existsSync(this.schemaPath)) {
      logger.warn('[Config] No schema file found, skipping validation');
      return true;
    }

    try {
      const schemaContent = await fsPromises.readFile(this.schemaPath, 'utf8');
      const schema = JSON.parse(schemaContent);
      const validate = this.ajv.compile(schema);
      const valid = validate(this.config);

      if (!valid) {
        const errors = validate.errors.map(e => `${e.instancePath} ${e.message}`).join(', ');
        throw new Error(`Configuration validation failed: ${errors}`);
      }

      logger.info('[Config] Configuration validated successfully');
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.warn('[Config] Schema file not found, skipping validation');
        return true;
      }
      throw error;
    }
  }

  /**
   * Sauvegarde la configuration en YAML
   */
  async save() {
    // S'assurer que le dossier config existe
    await fsPromises.mkdir(this.configDir, { recursive: true });

    const yamlContent = yaml.dump(this.config, {
      indent: 2,
      lineWidth: 120,
      noRefs: true
    });

    await fsPromises.writeFile(this.yamlPath, yamlContent, 'utf8');
    logger.info('[Config] Configuration saved to YAML');
  }

  /**
   * Active le hot-reload via file watcher
   */
  watch() {
    if (this.watcher) {
      return;
    }

    this.watcher = chokidar.watch(this.yamlPath, {
      persistent: true,
      ignoreInitial: true
    });

    this.watcher.on('change', async () => {
      logger.info('[Config] Configuration file changed, reloading...');
      try {
        await this.loadYaml();
        await this.validate();

        // Notifier tous les callbacks
        for (const callback of this.changeCallbacks) {
          try {
            await callback(this.config);
          } catch (error) {
            logger.error('[Config] Error in change callback:', error);
          }
        }

        logger.info('[Config] Configuration hot-reloaded successfully');
      } catch (error) {
        logger.error('[Config] Hot-reload failed:', error);
      }
    });

    logger.info('[Config] File watcher started');
  }

  /**
   * Enregistre un callback pour les changements de config
   */
  onChange(callback) {
    this.changeCallbacks.add(callback);
    return () => this.changeCallbacks.delete(callback);
  }

  /**
   * Arrête le file watcher
   */
  async stopWatching() {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      logger.info('[Config] File watcher stopped');
    }
  }

  // ==================== Getters ====================

  /**
   * Retourne toute la configuration
   */
  getConfig() {
    return this.config;
  }

  /**
   * Retourne la version de la config
   */
  getVersion() {
    return this.config?.version || '1.0';
  }

  /**
   * Retourne les infos d'instance
   */
  getInstance() {
    return this.config?.instance || {};
  }

  /**
   * Retourne tous les providers d'un type
   */
  getProviders(type) {
    return this.config?.providers?.[type] || [];
  }

  /**
   * Retourne tous les providers actifs d'un type
   */
  getEnabledProviders(type) {
    return this.getProviders(type).filter(p => p.enabled);
  }

  /**
   * Retourne un provider par son ID
   */
  getProvider(type, id) {
    return this.getProviders(type).find(p => p.id === id);
  }

  /**
   * Retourne un provider par son ID (tous types)
   */
  getProviderById(id) {
    for (const type of ['whatsapp', 'sms', 'voip']) {
      const provider = this.getProvider(type, id);
      if (provider) {
        return { ...provider, category: type };
      }
    }
    return null;
  }

  /**
   * Retourne les règles de compliance
   */
  getCompliance(type, country) {
    return this.config?.compliance?.[type]?.[country] || null;
  }

  // ==================== Setters ====================

  /**
   * Met à jour un provider
   */
  async updateProvider(type, id, updates) {
    const providers = this.config.providers[type];
    const index = providers.findIndex(p => p.id === id);

    if (index === -1) {
      throw new Error(`Provider ${id} not found in ${type}`);
    }

    // Merge updates
    providers[index] = {
      ...providers[index],
      ...updates,
      config: {
        ...providers[index].config,
        ...(updates.config || {})
      }
    };

    await this.save();
    return providers[index];
  }

  /**
   * Ajoute un nouveau provider
   */
  async addProvider(type, provider) {
    if (!this.config.providers[type]) {
      this.config.providers[type] = [];
    }

    // Vérifier que l'ID n'existe pas déjà
    if (this.config.providers[type].some(p => p.id === provider.id)) {
      throw new Error(`Provider with ID ${provider.id} already exists`);
    }

    this.config.providers[type].push(provider);
    await this.save();
    return provider;
  }

  /**
   * Supprime un provider
   */
  async removeProvider(type, id) {
    const providers = this.config.providers[type];
    const index = providers.findIndex(p => p.id === id);

    if (index === -1) {
      throw new Error(`Provider ${id} not found in ${type}`);
    }

    const removed = providers.splice(index, 1)[0];
    await this.save();
    return removed;
  }

  /**
   * Active/désactive un provider
   */
  async setProviderEnabled(type, id, enabled) {
    return this.updateProvider(type, id, { enabled });
  }

  // ==================== Legacy Compatibility ====================

  /**
   * Retourne la config au format legacy (pour compatibilité ProviderManager)
   */
  getLegacyFormat() {
    const legacy = {
      defaultProvider: null,
      providers: {}
    };

    // Convertir WhatsApp
    for (const provider of this.getProviders('whatsapp')) {
      const legacyName = provider.type === 'baileys' ? 'baileys' : 'meta';
      legacy.providers[legacyName] = {
        enabled: provider.enabled,
        ...this.convertToLegacyConfig(provider)
      };
      if (provider.enabled && !legacy.defaultProvider) {
        legacy.defaultProvider = legacyName;
      }
    }

    // Convertir SMS
    for (const provider of this.getProviders('sms')) {
      const legacyName = provider.type === 'sms_bridge' ? 'sms-bridge' : provider.id;
      legacy.providers[legacyName] = {
        enabled: provider.enabled,
        ...this.convertToLegacyConfig(provider)
      };
    }

    return legacy;
  }

  /**
   * Convertit la config provider au format legacy
   */
  convertToLegacyConfig(provider) {
    const config = { ...provider.config };

    // Convertir snake_case -> camelCase
    const result = {};
    for (const [key, value] of Object.entries(config)) {
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      result[camelKey] = value;
    }

    return result;
  }
}

// Export singleton
module.exports = new ConfigurationService();
