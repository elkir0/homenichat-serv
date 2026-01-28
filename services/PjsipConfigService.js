/**
 * PjsipConfigService - Manages PJSIP extensions via config files
 *
 * This service writes PJSIP extension configurations directly to config files.
 * Used for standalone Asterisk installations (without FreePBX).
 *
 * IMPORTANT: AOR section name MUST match the SIP username/extension number!
 * See docs/WEBRTC-VOIP-CONFIG.md for the full explanation.
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const logger = require('../utils/logger');

const PJSIP_DYNAMIC_CONF = '/etc/asterisk/pjsip_extensions_dynamic.conf';
const PJSIP_BACKUP_DIR = '/etc/asterisk/backup';

class PjsipConfigService {
  constructor() {
    this.extensions = new Map();
    this.loaded = false;
  }

  /**
   * Load existing extensions from config file
   */
  async load() {
    try {
      if (!fs.existsSync(PJSIP_DYNAMIC_CONF)) {
        logger.info('[PjsipConfig] No dynamic config file found, starting fresh');
        this.extensions = new Map();
        this.loaded = true;
        return;
      }

      const content = fs.readFileSync(PJSIP_DYNAMIC_CONF, 'utf8');
      this.parseConfig(content);
      this.loaded = true;
      logger.info(`[PjsipConfig] Loaded ${this.extensions.size} extensions from config`);
    } catch (error) {
      logger.error('[PjsipConfig] Error loading config:', error.message);
      this.extensions = new Map();
      this.loaded = true;
    }
  }

  /**
   * Parse PJSIP config content and extract extensions WITH passwords
   */
  parseConfig(content) {
    const lines = content.split('\n');
    let currentSection = null;
    let currentData = {};

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith(';')) continue;

      // Section header
      const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        // Save previous section data
        if (currentSection && currentData.type) {
          // Extract extension number from section name
          let ext = currentSection.replace('-auth', '');

          if (!this.extensions.has(ext)) {
            this.extensions.set(ext, { extension: ext });
          }

          // Merge data based on section type
          const extData = this.extensions.get(ext);
          if (currentData.type === 'auth' && currentData.password) {
            extData.password = currentData.password;
          }
          if (currentData.type === 'endpoint') {
            if (currentData.callerid) extData.displayName = currentData.callerid.replace(/^"([^"]+)".*/, '$1');
            if (currentData.context) extData.context = currentData.context;
            if (currentData.allow) extData.codecs = currentData.allow.split(',');
          }
        }

        currentSection = sectionMatch[1];
        currentData = {};
        continue;
      }

      // Key=value
      const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1].trim();
        const value = kvMatch[2].trim();
        currentData[key] = value;
      }
    }

    // Don't forget the last section
    if (currentSection && currentData.type) {
      let ext = currentSection.replace('-auth', '');
      if (!this.extensions.has(ext)) {
        this.extensions.set(ext, { extension: ext });
      }
      const extData = this.extensions.get(ext);
      if (currentData.type === 'auth' && currentData.password) {
        extData.password = currentData.password;
      }
    }
  }

  /**
   * Get or create extension - returns existing password if extension exists
   *
   * @param {object} config - Extension configuration
   * @returns {Promise<{success: boolean, password: string, created: boolean}>}
   */
  async getOrCreateExtension(config) {
    const { extension, password, displayName, context, codecs } = config;

    if (!extension) {
      return { success: false, message: 'Extension is required' };
    }

    // Ensure config is loaded
    if (!this.loaded) {
      await this.load();
    }

    // Check if extension already exists with a password
    const existing = this.extensions.get(extension);
    if (existing && existing.password) {
      logger.info(`[PjsipConfig] Extension ${extension} already exists, returning existing password`);
      return {
        success: true,
        password: existing.password,
        created: false,
        displayName: existing.displayName
      };
    }

    // Extension doesn't exist or has no password - create/update it
    if (!password) {
      return { success: false, message: 'Password is required for new extension' };
    }

    const result = await this.createExtension({
      extension,
      password,
      displayName,
      context,
      codecs
    });

    if (result.success) {
      return { success: true, password, created: true };
    }
    return result;
  }

  /**
   * Create or update a PJSIP extension
   *
   * CRITICAL: The AOR section MUST have the same name as the extension!
   *
   * @param {object} config - Extension configuration
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async createExtension(config) {
    const {
      extension,
      password,
      displayName,
      context = 'from-internal',
      codecs = ['g722', 'ulaw', 'alaw'],
    } = config;

    if (!extension || !password) {
      return { success: false, message: 'Extension and password are required' };
    }

    // Validate extension format
    if (!/^\d{3,5}$/.test(extension)) {
      return { success: false, message: 'Extension must be 3-5 digits' };
    }

    try {
      // Store extension data
      this.extensions.set(extension, {
        extension,
        password,
        displayName: displayName || `Homenichat ${extension}`,
        context,
        codecs: Array.isArray(codecs) ? codecs : codecs.split(','),
        createdAt: Date.now(),
      });

      // Write to config file
      await this.saveConfig();

      // Reload PJSIP
      await this.reloadPjsip();

      logger.info(`[PjsipConfig] Extension ${extension} created/updated`);
      return { success: true, message: `Extension ${extension} configured` };

    } catch (error) {
      logger.error(`[PjsipConfig] Error creating extension ${extension}:`, error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Delete a PJSIP extension
   */
  async deleteExtension(extension) {
    if (!this.extensions.has(extension)) {
      return { success: false, message: `Extension ${extension} not found` };
    }

    try {
      this.extensions.delete(extension);
      await this.saveConfig();
      await this.reloadPjsip();

      logger.info(`[PjsipConfig] Extension ${extension} deleted`);
      return { success: true, message: `Extension ${extension} deleted` };

    } catch (error) {
      logger.error(`[PjsipConfig] Error deleting extension ${extension}:`, error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get extension configuration
   */
  getExtension(extension) {
    return this.extensions.get(extension) || null;
  }

  /**
   * List all configured extensions
   */
  listExtensions() {
    return Array.from(this.extensions.values()).map(ext => ({
      extension: ext.extension,
      displayName: ext.displayName,
      context: ext.context,
      createdAt: ext.createdAt,
    }));
  }

  /**
   * Save all extensions to config file
   */
  async saveConfig() {
    const lines = [
      '; Homenichat PJSIP Dynamic Extensions',
      '; Auto-generated by PjsipConfigService',
      '; DO NOT EDIT MANUALLY - changes will be overwritten',
      ';',
      '; IMPORTANT: AOR section name MUST match extension number!',
      '; See docs/WEBRTC-VOIP-CONFIG.md for details.',
      ';',
      `; Generated: ${new Date().toISOString()}`,
      '',
    ];

    for (const [ext, config] of this.extensions) {
      const codecsStr = config.codecs ? config.codecs.join(',') : 'g722,ulaw,alaw';
      const callerid = config.displayName
        ? `"${config.displayName}" <${ext}>`
        : ext;

      lines.push(
        `; === Extension ${ext} ===`,
        `[${ext}]`,
        `type=endpoint`,
        `context=${config.context || 'from-internal'}`,
        `disallow=all`,
        `allow=${codecsStr}`,
        `transport=transport-ws`,
        `webrtc=yes`,
        `auth=${ext}-auth`,
        `aors=${ext}`,
        `direct_media=no`,
        `dtmf_mode=rfc4733`,
        `identify_by=username`,
        `callerid=${callerid}`,
        '',
      );

      lines.push(
        `[${ext}-auth]`,
        `type=auth`,
        `auth_type=userpass`,
        `username=${ext}`,
        `password=${config.password}`,
        '',
      );

      lines.push(
        `[${ext}]`,
        `type=aor`,
        `max_contacts=5`,
        `remove_existing=yes`,
        '',
      );
    }

    if (!fs.existsSync(PJSIP_BACKUP_DIR)) {
      fs.mkdirSync(PJSIP_BACKUP_DIR, { recursive: true });
    }

    if (fs.existsSync(PJSIP_DYNAMIC_CONF)) {
      const backupPath = path.join(
        PJSIP_BACKUP_DIR,
        `pjsip_extensions_dynamic_${Date.now()}.conf`
      );
      fs.copyFileSync(PJSIP_DYNAMIC_CONF, backupPath);
    }

    fs.writeFileSync(PJSIP_DYNAMIC_CONF, lines.join('\n'), 'utf8');

    try {
      fs.chmodSync(PJSIP_DYNAMIC_CONF, 0o644);
      exec(`chown asterisk:asterisk ${PJSIP_DYNAMIC_CONF}`, () => {});
    } catch (e) {}

    logger.info(`[PjsipConfig] Config saved with ${this.extensions.size} extensions`);
  }

  /**
   * Reload PJSIP module in Asterisk
   */
  async reloadPjsip() {
    return new Promise((resolve) => {
      exec('asterisk -rx "module reload res_pjsip.so"', (error, stdout, stderr) => {
        if (error) {
          logger.warn(`[PjsipConfig] PJSIP reload warning: ${error.message}`);
        } else {
          logger.info('[PjsipConfig] PJSIP reloaded');
        }
        resolve({ success: !error });
      });
    });
  }

  /**
   * Check if Asterisk is available
   */
  async checkAsterisk() {
    return new Promise((resolve) => {
      exec('asterisk -rx "pjsip show endpoints" 2>/dev/null', (error, stdout) => {
        if (error) {
          resolve({ available: false, error: error.message });
        } else {
          const endpointCount = (stdout.match(/Endpoint:/g) || []).length;
          resolve({ available: true, endpoints: endpointCount });
        }
      });
    });
  }

  /**
   * Get extension registration status
   */
  async getExtensionStatus(extension) {
    return new Promise((resolve) => {
      exec(`asterisk -rx "pjsip show endpoint ${extension}" 2>/dev/null`, (error, stdout) => {
        if (error || !stdout.includes('Endpoint:')) {
          resolve({ extension, exists: false, registered: false });
          return;
        }

        const hasContacts = stdout.includes('Contact:') && !stdout.includes('Contact:  <none>');
        const deviceState = stdout.match(/DeviceState\s*:\s*(\S+)/)?.[1] || 'Unknown';

        resolve({
          extension,
          exists: true,
          registered: hasContacts,
          deviceState,
        });
      });
    });
  }
}

const pjsipConfigService = new PjsipConfigService();
module.exports = pjsipConfigService;
